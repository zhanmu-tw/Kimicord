import { ChannelType, Message, PermissionFlagsBits, ThreadAutoArchiveDuration, ThreadChannel } from "discord.js";
import { ChannelConfig, CONFIG } from "../config.js";
import { SessionManager } from "../session.js";
import { insertSession } from "../db.js";
import { randomUUID } from "node:crypto";
import { runTurn } from "../turn.js";
import { buildErrorEmbed } from "../errors.js";

export async function handleTrigger(message: Message, config: ChannelConfig) {
  if (!CONFIG.allowedUserIds.has(message.author.id)) {
    await message.react("❌").catch(() => {});
    return;
  }

  // Pre-flight: make sure we can create threads here before doing any work
  if (
    message.guild &&
    (message.channel.type === ChannelType.GuildText || message.channel.type === ChannelType.GuildAnnouncement)
  ) {
    const me = message.guild.members.me;
    const perms = me ? message.channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.CreatePublicThreads)) {
      await message
        .reply("❌ I don't have permission to create threads in this channel.")
        .catch(() => {});
      return;
    }
  }

  const promptText = stripMentions(message.content, message.client.user?.id);
  const threadName = `kimi — ${(promptText || "(no text)").slice(0, 40)}`;

  const thread = await message.startThread({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });

  const sessionId = randomUUID();
  insertSession({
    thread_id: thread.id,
    session_id: sessionId,
    channel_id: config.channelId,
    mode: "channel",
    trigger: config.trigger,
    work_dir: CONFIG.kimiWorkDir,
    created_at: Date.now(),
    last_active: Date.now(),
  });

  const session = SessionManager.getOrCreate(thread.id, sessionId, CONFIG.kimiWorkDir, CONFIG.kimiYolo);
  ensureDequeueHandler(session, thread);

  if (!promptText) {
    await thread
      .send("💡 Session ready — send a message in this thread to start a turn with Kimi.")
      .catch(() => {});
    return;
  }

  runTurn(session, thread, promptText, message).catch(async (e) => {
    console.error(e);
    await thread.send({ embeds: [buildErrorEmbed(e)] });
  });
}

export async function handleThreadReply(message: Message) {
  if (!message.channel.isThread() || !CONFIG.allowedUserIds.has(message.author.id)) {
    await message.react("❌").catch(() => {});
    return;
  }

  const session = SessionManager.get(message.channelId);
  if (!session) return;

  // Nothing to prompt with (e.g. attachment-only or otherwise empty messages)
  if (!message.content.trim()) return;

  if (session.resolveQuestion(message.content)) {
    return;
  }

  const thread = message.channel as ThreadChannel;
  ensureDequeueHandler(session, thread);

  if (session.state === "busy") {
    // Only react to the first queued message per busy period — reacting to
    // every queued message hits reaction rate limits when many lines are pasted.
    const firstQueued = session.messageQueue.length === 0;
    session.messageQueue.push({ text: message.content, context: message });
    if (firstQueued) {
      await message.react("⏳").catch(() => {});
    }
  } else {
    runTurn(session, thread, message.content, message).catch(async (e) => {
      console.error(e);
      await thread.send({ embeds: [buildErrorEmbed(e)] });
    });
  }
}

function ensureDequeueHandler(session: ReturnType<typeof SessionManager.getOrCreate>, thread: ThreadChannel) {
  if (!session || session.listenerCount("dequeue") > 0) return;
  session.on("dequeue", async (item: { text: string; context?: unknown }) => {
    const msg = item.context as Message | undefined;
    if (msg) {
      msg.reactions.cache.get("⏳")?.users.remove(msg.client.user!.id).catch(() => {});
    }
    runTurn(session, thread, item.text, msg).catch(async (e) => {
      console.error(e);
      await thread.send({ embeds: [buildErrorEmbed(e)] });
    });
  });
}

function stripMentions(content: string, botId?: string): string {
  if (!botId) return content.trim();
  const regex = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(regex, "").trim();
}

