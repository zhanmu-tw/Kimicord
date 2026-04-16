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
  QuestionOption,
} from "./wire.js";
import { KimiSession } from "./session.js";

type SendableThread = ThreadChannel | TextChannel;

export const questionSuggestions = new Map<string, string[]>();

// wireRequestId -> questionText -> selected answer string
export const questionAnswers = new Map<string, Map<string, string>>();

// wireRequestId -> questionText -> option labels array
export const questionOptions = new Map<string, Map<string, string[]>>();

// wireRequestId -> [questionText0, questionText1, ...]
export const questionTexts = new Map<string, string[]>();

// wireRequestId -> QuestionRequest payload id (may differ from wireRequestId)
export const questionRequestIds = new Map<string, string>();

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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${wireRequestId}:${session.threadId}:approve`)
      .setLabel("✅ Allow")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`approve:${wireRequestId}:${session.threadId}:deny`)
      .setLabel("❌ Deny")
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });

  session.registerPendingRequest(wireRequestId, "ApprovalRequest", 120000).then((res) => {
    if (res === "__timeout__") {
      session.resolveRequest(wireRequestId, "deny");
      msg.edit({
        content: "Auto-denied — timed out.",
        components: disableComponents(row),
      }).catch(() => {});
    }
  });

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
    const qKey = `q${i}`;
    texts.push(q.question);
    answers.set(qKey, "");
    options.set(qKey, q.options.map((o) => o.label));
    const msg = q.multi_select
      ? await postMultiSelect(channel, session, wireRequestId, qKey, q)
      : await postSingleSelect(channel, session, wireRequestId, qKey, q);
    messages.push(msg);
  }

  questionAnswers.set(wireRequestId, answers);
  questionOptions.set(wireRequestId, options);
  questionTexts.set(wireRequestId, texts);
  questionRequestIds.set(wireRequestId, payload.id);

  session.registerPendingRequest(wireRequestId, "QuestionRequest", 300000).then((res) => {
    questionAnswers.delete(wireRequestId);
    questionOptions.delete(wireRequestId);
    questionTexts.delete(wireRequestId);
    questionRequestIds.delete(wireRequestId);
    if (res === "__timeout__") {
      const emptyAnswers: Record<string, string> = {};
      session.resolveQuestionRequest(wireRequestId, payload.id, emptyAnswers);
      for (const msg of messages) {
        msg.edit({ content: "Timed out.", components: [] }).catch(() => {});
      }
    }
  });

  return messages;
}

async function postSingleSelect(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  qKey: string,
  q: QuestionItem
): Promise<Message> {
  const embed = new EmbedBuilder()
    .setTitle(q.header ? `❓ ${q.header}` : "❓ Question")
    .setDescription(q.question)
    .setColor(0x3b82f6);

  const row = new ActionRowBuilder<ButtonBuilder>();
  q.options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`answer:${wireRequestId}:${session.threadId}:${qKey}:${i}`)
        .setLabel(truncate(opt.label, 80))
        .setStyle(ButtonStyle.Primary)
    );
  });

  return channel.send({ embeds: [embed], components: [row] });
}

async function postMultiSelect(
  channel: SendableThread,
  session: KimiSession,
  wireRequestId: string,
  qKey: string,
  q: QuestionItem
): Promise<Message> {
  const embed = new EmbedBuilder()
    .setTitle(q.header ? `☑️ ${q.header}` : "☑️ Multi-select")
    .setDescription(`${q.question}\n*Select one or more options from the dropdown.*`)
    .setColor(0x8b5cf6);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`multiselect:${wireRequestId}:${session.threadId}:${qKey}`)
    .setPlaceholder("Choose options...")
    .setMinValues(1)
    .setMaxValues(q.options.length)
    .addOptions(
      q.options.map((opt) => ({
        label: truncate(opt.label, 25),
        value: opt.label,
        description: opt.description ? truncate(opt.description, 50) : undefined,
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

function disableComponents(row: ActionRowBuilder<ButtonBuilder>): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = row.components.map((b) => ButtonBuilder.from(b).setDisabled(true));
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(disabled)];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
