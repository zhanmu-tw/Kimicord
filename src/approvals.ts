import {
  ThreadChannel,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  ApprovalRequestPayload,
  QuestionRequestPayload,
  QuestionItem,
} from "./wire.js";
import { KimiSession } from "./session.js";

type SendableThread = ThreadChannel | TextChannel;

export const questionSuggestions = new Map<string, string[]>();

// Ids of requests that have already been resolved (by a user click or a
// timeout), so a late second resolution attempt becomes a no-op.
const resolvedRequests = new Set<string>();

/**
 * Marks a request as resolved. Returns true the first time a given
 * wireRequestId is marked, false for every subsequent call — callers should
 * treat false as "already handled" and not resolve again.
 */
export function tryMarkResolved(wireRequestId: string): boolean {
  if (resolvedRequests.has(wireRequestId)) return false;
  // Bound the set so it can't grow forever over long uptimes
  if (resolvedRequests.size > 5000) resolvedRequests.clear();
  resolvedRequests.add(wireRequestId);
  return true;
}

export async function postApproval(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  payload: ApprovalRequestPayload
): Promise<Message> {
  const action = payload.action ?? "Unknown action";
  const command = payload.command ? `\`\`\`\n${JSON.stringify(payload.command)}\n\`\`\`` : "";
  const desc = [`Action: ${action}`, payload.description ?? "", command].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🔐 Permission Request")
    .setDescription(desc.slice(0, 4000))
    .setColor(0xd97706);

  let rows: ActionRowBuilder<ButtonBuilder>[];
  if (payload.options && payload.options.length > 0) {
    // One button per ACP permission option, keyed by index ("opt<N>") —
    // optionIds may contain characters Discord customIds can't hold.
    const options = payload.options.slice(0, 25);
    rows = [];
    for (let i = 0; i < options.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      options.slice(i, i + 5).forEach((opt, j) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`approve:${wireRequestId}:${session.threadId}:opt${i + j}`)
            .setLabel(truncate(opt.label, 80))
            .setStyle(optionStyle(opt.kind))
        );
      });
      rows.push(row);
    }
  } else {
    rows = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve:${wireRequestId}:${session.threadId}:approve`)
          .setLabel("✅ Allow")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`approve:${wireRequestId}:${session.threadId}:deny`)
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger)
      ),
    ];
  }

  const msg = await channel.send({ embeds: [embed], components: rows });

  session.registerPendingRequest(wireRequestId, "ApprovalRequest", 120000).then((res) => {
    if (res === "__timeout__" && tryMarkResolved(wireRequestId)) {
      session.resolveRequest(wireRequestId, "deny");
      msg.edit({
        content: "Auto-denied — timed out.",
        components: disableComponents(rows),
      }).catch(() => {});
    }
  }).catch(console.error);

  return msg;
}

export async function postQuestion(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  payload: QuestionRequestPayload
): Promise<Message[]> {
  const messages: Message[] = [];
  const answers = new Map<string, string>();
  const options = new Map<string, string[]>();
  const texts: string[] = [];

  for (let i = 0; i < payload.questions.length; i++) {
    const q = payload.questions[i];
    if (!q) continue;
    const qKey = `q${i}`;
    texts.push(q.question);
    answers.set(qKey, "");
    options.set(qKey, q.options.map((o) => o.label));
    const msg = q.multi_select
      ? await postMultiSelect(channel, session, wireRequestId, qKey, q)
      : await postSingleSelect(channel, session, wireRequestId, qKey, q);
    messages.push(msg);
  }

  session.questionAnswers.set(wireRequestId, answers);
  session.questionOptions.set(wireRequestId, options);
  session.questionTexts.set(wireRequestId, texts);
  session.questionRequestIds.set(wireRequestId, payload.id);

  session.registerPendingRequest(wireRequestId, "QuestionRequest", 300000).then((res) => {
    session.clearQuestionState(wireRequestId);
    if (res === "__timeout__" && tryMarkResolved(wireRequestId)) {
      const emptyAnswers: Record<string, string> = {};
      session.resolveQuestionRequest(wireRequestId, payload.id, emptyAnswers);
      for (const msg of messages) {
        msg.edit({ content: "Timed out.", components: [] }).catch(() => {});
      }
    }
  }).catch(console.error);

  return messages;
}

const MAX_BUTTON_OPTIONS = 25;
const MAX_SELECT_OPTIONS = 25;

async function postSingleSelect(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  qKey: string,
  q: QuestionItem
): Promise<Message> {
  let description = truncate(q.question, 4096);
  if (q.options.length > MAX_BUTTON_OPTIONS) {
    description += `\n*(Too many options — showing the first ${MAX_BUTTON_OPTIONS}.)*`;
  }

  const embed = new EmbedBuilder()
    .setTitle(truncate(q.header ? `❓ ${q.header}` : "❓ Question", 256))
    .setDescription(description)
    .setColor(0x3b82f6);

  // Discord allows at most 5 buttons per action row
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const opts = q.options.slice(0, MAX_BUTTON_OPTIONS);
  for (let i = 0; i < opts.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    opts.slice(i, i + 5).forEach((opt, j) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`answer:${wireRequestId}:${session.threadId}:${qKey}:${i + j}`)
          .setLabel(truncate(opt.label, 80))
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  return channel.send({ embeds: [embed], components: rows });
}

async function postMultiSelect(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  qKey: string,
  q: QuestionItem
): Promise<Message> {
  let description = `${truncate(q.question, 4000)}\n*Select one or more options from the dropdown.*`;
  if (q.options.length > MAX_SELECT_OPTIONS) {
    description += `\n*(Too many options — showing the first ${MAX_SELECT_OPTIONS}.)*`;
  }

  const embed = new EmbedBuilder()
    .setTitle(truncate(q.header ? `☑️ ${q.header}` : "☑️ Multi-select", 256))
    .setDescription(description)
    .setColor(0x8b5cf6);

  // Use option indices as values: label values can exceed 100 chars or be
  // duplicated, both of which Discord rejects. The interaction handler maps
  // the indices back to labels via session.questionOptions.
  const opts = q.options.slice(0, MAX_SELECT_OPTIONS);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`multiselect:${wireRequestId}:${session.threadId}:${qKey}`)
    .setPlaceholder("Choose options...")
    .setMinValues(1)
    .setMaxValues(Math.max(1, opts.length))
    .addOptions(
      opts.map((opt, i) => ({
        label: truncate(opt.label, 100),
        value: String(i),
        description: opt.description ? truncate(opt.description, 100) : undefined,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  return channel.send({ embeds: [embed], components: [row] });
}

export async function postToolCallRequest(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  payload: unknown
): Promise<Message> {
  // Treat ToolCallRequest same as approval for now
  const p = payload as ApprovalRequestPayload;
  return postApproval(channel, session, wireRequestId, p);
}

function disableComponents(rows: ActionRowBuilder<ButtonBuilder>[]): ActionRowBuilder<ButtonBuilder>[] {
  return rows.map(
    (row) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
      )
  );
}

function optionStyle(kind: string | undefined): ButtonStyle {
  switch (kind) {
    case "allow_once":
      return ButtonStyle.Success;
    case "allow_always":
      return ButtonStyle.Primary;
    case "reject_once":
      return ButtonStyle.Danger;
    case "reject_always":
      return ButtonStyle.Secondary;
    default:
      return ButtonStyle.Primary;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
