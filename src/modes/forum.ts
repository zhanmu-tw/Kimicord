import { Message, ThreadChannel } from "discord.js";
import { ChannelConfig, CONFIG } from "../config.js";
import { SessionManager } from "../session.js";
import { insertSession } from "../db.js";
import { randomUUID } from "node:crypto";
import { runTurn } from "../turn.js";
import { buildErrorEmbed } from "../errors.js";

export async function handleNewPost(thread: ThreadChannel, config: ChannelConfig) {
  // ThreadCreate can fire before the starter message is fetchable; retry
  // with a short backoff before giving up.
  let msg: Message | null = null;
  for (let attempt = 0; attempt < 3 && !msg; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    msg = await thread.fetchStarterMessage().catch(() => null);
  }
  if (!msg) {
    await thread
      .send("⚠️ Couldn't load this post's starter message, so no Kimi session was started. Try sending your prompt as a message in this thread.")
      .catch(() => {});
    return;
  }

  if (!CONFIG.allowedUserIds.has(msg.author.id)) {
    await thread.send("❌ You are not permitted to start kimi sessions.");
    return;
  }

  if (config.trigger === "mention" && !msg.mentions.has(msg.client.user?.id ?? "")) {
    return; // silently ignore
  }

  const promptText = stripMentions(msg.content, msg.client.user?.id);
  const sessionId = randomUUID();

  insertSession({
    thread_id: thread.id,
    session_id: sessionId,
    channel_id: config.channelId,
    mode: "forum",
    trigger: config.trigger,
    work_dir: CONFIG.kimiWorkDir,
    created_at: Date.now(),
    last_active: Date.now(),
  });

  const session = SessionManager.getOrCreate(thread.id, sessionId, CONFIG.kimiWorkDir, CONFIG.kimiYolo);
  ensureDequeueHandler(session, thread);

  runTurn(session, thread, promptText || "(no text)", msg).catch(async (e) => {
    console.error(e);
    await thread.send({ embeds: [buildErrorEmbed(e)] });
  });
}

export async function handleReply(message: Message) {
  if (!message.channel.isThread() || !CONFIG.allowedUserIds.has(message.author.id)) {
    await message.react("❌").catch(() => {});
    return;
  }

  const session = SessionManager.get(message.channelId);
  if (!session) return;

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

