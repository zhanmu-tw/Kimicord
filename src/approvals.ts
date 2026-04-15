import {
  ThreadChannel,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
} from "discord.js";
import { ApprovalRequestPayload, QuestionRequestPayload } from "./wire.js";
import { KimiSession } from "./session.js";

type SendableThread = ThreadChannel | TextChannel;

export const questionSuggestions = new Map<string, string[]>();

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
): Promise<Message> {
  const question = payload.question ?? "Question";
  const suggestions = payload.suggestions?.slice(0, 5) ?? [];

  if (suggestions.length === 0) {
    // No buttons; wait for next thread reply via steer
    return await channel.send(`❓ ${question}\n*Reply in this thread to answer.*`);
  }

  const embed = new EmbedBuilder().setTitle("❓ Question").setDescription(question).setColor(0x3b82f6);

  const row = new ActionRowBuilder<ButtonBuilder>();
  suggestions.forEach((s, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`answer:${wireRequestId}:${session.threadId}:${i}`)
        .setLabel(truncate(s, 80))
        .setStyle(ButtonStyle.Primary)
    );
  });

  questionSuggestions.set(wireRequestId, suggestions);

  const msg = await channel.send({ embeds: [embed], components: [row] });

  session.registerPendingRequest(wireRequestId, "QuestionRequest", 300000).then((res) => {
    questionSuggestions.delete(wireRequestId);
    if (res === "__timeout__") {
      session.resolveRequest(wireRequestId, "");
      questionSuggestions.delete(wireRequestId);
      msg.edit({ content: "Timed out.", components: disableComponents(row) }).catch(() => {});
    }
  });

  return msg;
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
