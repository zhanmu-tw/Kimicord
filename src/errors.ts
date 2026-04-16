import { EmbedBuilder } from "discord.js";

export function safeErrorReply(err: unknown): string {
  console.error("Unhandled error:", err);
  return "An internal error occurred. Please check the server logs for details.";
}

export function buildErrorEmbed(err: unknown) {
  return new EmbedBuilder()
    .setTitle("❌ Session Error")
    .setDescription(safeErrorReply(err))
    .setColor(0xdc2626);
}
