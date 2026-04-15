import {
  Client,
  Events,
  Message,
  ThreadChannel,
  Interaction,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { CONFIG } from "./config.js";
import { SessionManager } from "./session.js";
import * as channelMode from "./modes/channel.js";
import * as forumMode from "./modes/forum.js";
import { deleteSessionByThread, getSessionByThread, listAllSessions } from "./db.js";

const rest = new REST({ version: "10" }).setToken(CONFIG.discordToken);

export async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Force-start a new kimi session in this thread")
      .addStringOption((opt) =>
        opt.setName("prompt").setDescription("Optional starting prompt").setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder().setName("stop").setDescription("Cancel the current turn and kill the session").toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("Show session info").toJSON(),
    new SlashCommandBuilder()
      .setName("workdir")
      .setDescription("Set working directory for the next session in this thread")
      .addStringOption((opt) => opt.setName("path").setDescription("Directory path").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder().setName("sessions").setDescription("List all sessions — admin only").toJSON(),
    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Compact the kimi context")
      .addStringOption((opt) => opt.setName("focus").setDescription("Optional focus, e.g. keep db discussions").setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName("clear").setDescription("Clear the kimi context").toJSON(),
    new SlashCommandBuilder().setName("yolo").setDescription("Toggle YOLO mode in kimi").toJSON(),
    new SlashCommandBuilder()
      .setName("plan")
      .setDescription("Toggle or view plan mode in kimi")
      .addStringOption((opt) =>
        opt.setName("mode").setDescription("on, off, view, or clear").setRequired(false)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("add-dir")
      .setDescription("Add a directory to the kimi workspace")
      .addStringOption((opt) => opt.setName("path").setDescription("Directory path").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder().setName("export").setDescription("Export current kimi context to a markdown file").toJSON(),
    new SlashCommandBuilder().setName("init").setDescription("Generate AGENTS.md via kimi").toJSON(),
  ];

  const route = CONFIG.guildId
    ? Routes.applicationGuildCommands(CONFIG.discordAppId, CONFIG.guildId)
    : Routes.applicationCommands(CONFIG.discordAppId);
  await rest.put(route, { body: commands });
  console.log(CONFIG.guildId ? "Guild slash commands registered" : "Slash commands registered");
}

export function attachBotHandlers(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (message.guildId && !client.guilds.cache.has(message.guildId)) return;

    // Determine effective channel id
    const channelId = message.channel.isThread() ? message.channel.parentId ?? message.channelId : message.channelId;
    const config = CONFIG.channels.get(channelId);
    if (!config) return;

    // Guild filter: ignore other guilds if we only care about configured channels
    if (!message.guildId) return;

    if (config.discordMode === "channel") {
      if (!message.channel.isThread()) {
        if (config.trigger === "any" || message.mentions.has(client.user?.id ?? "")) {
          await channelMode.handleTrigger(message, config);
        }
      } else {
        if (SessionManager.get(message.channelId)) {
          await channelMode.handleThreadReply(message);
        }
      }
    } else if (config.discordMode === "forum") {
      if (message.channel.isThread() && SessionManager.get(message.channelId)) {
        await forumMode.handleReply(message);
      }
    }
  });

  client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
    const config = CONFIG.channels.get(thread.parentId ?? "");
    if (!config || config.discordMode !== "forum") return;
    await forumMode.handleNewPost(thread, config);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;
    const parts = customId.split(":");
    if (parts.length !== 4) return;
    const [type, wireRequestId, threadId, value] = parts;

    const session = SessionManager.get(threadId);
    if (!session) {
      await interaction.update({ content: "Session not found.", components: [] }).catch(() => {});
      return;
    }

    let response = value;
    if (type === "answer") {
      const { questionSuggestions } = await import("./approvals.js");
      const suggestions = questionSuggestions.get(wireRequestId);
      const idx = Number(value);
      if (suggestions && !Number.isNaN(idx) && suggestions[idx]) {
        response = suggestions[idx];
      }
      questionSuggestions.delete(wireRequestId);
    }

    session.resolveRequest(wireRequestId, response);
    await interaction.update({ content: `Selected: ${response}`, components: [] }).catch(() => {});
  });

  client.on(Events.ThreadDelete, async (thread: ThreadChannel) => {
    if (SessionManager.get(thread.id)) {
      SessionManager.destroy(thread.id);
      deleteSessionByThread(thread.id);
    }
  });

  client.on(Events.ThreadUpdate, async (_oldThread, newThread: ThreadChannel) => {
    if (newThread.archived && SessionManager.get(newThread.id)) {
      SessionManager.destroy(newThread.id);
      deleteSessionByThread(newThread.id);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, channel, user } = interaction;

    if (commandName === "new") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", ephemeral: true });
        return;
      }
      const thread = channel as ThreadChannel;
      const existing = SessionManager.get(thread.id);
      if (existing) {
        existing.destroy();
        deleteSessionByThread(thread.id);
      }
      const prompt = interaction.options.getString("prompt") ?? "";
      const configEntry = CONFIG.channels.get(thread.parentId ?? "");
      const mode = configEntry?.discordMode ?? "channel";
      const trigger = configEntry?.trigger ?? "mention";
      const { randomUUID } = await import("node:crypto");
      const sessionId = randomUUID();
      const { insertSession } = await import("./db.js");
      insertSession({
        thread_id: thread.id,
        session_id: sessionId,
        channel_id: thread.parentId ?? thread.id,
        mode: mode as "channel" | "forum",
        trigger: trigger as "mention" | "any",
        work_dir: CONFIG.kimiWorkDir,
        created_at: Date.now(),
        last_active: Date.now(),
      });
      const { runTurn } = await import("./turn.js");
      const session = SessionManager.getOrCreate(thread.id, sessionId, CONFIG.kimiWorkDir, CONFIG.kimiYolo);
      if (session.listenerCount("dequeue") === 0) {
        session.on("dequeue", async (item: { text: string; context?: unknown }) => {
          runTurn(session, thread, item.text).catch(async (e) => {
            await thread.send({ embeds: [buildErrorEmbed(e)] });
          });
        });
      }
      await interaction.reply("🟡 New session started.");
      if (prompt) {
        runTurn(session, thread, prompt).catch(async (e) => {
          await thread.send({ embeds: [buildErrorEmbed(e)] });
        });
      }
      return;
    }

    if (commandName === "stop") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", ephemeral: true });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No active session here.", ephemeral: true });
        return;
      }
      await session.cancel();
      session.teardown();
      await interaction.reply("🛑 Session stopped.");
      return;
    }

    if (commandName === "status") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", ephemeral: true });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session in this thread.", ephemeral: true });
        return;
      }
      const row = getSessionByThread(thread.id);
      const embed = new EmbedBuilder()
        .setTitle("Session Status")
        .addFields(
          { name: "Session", value: session.sessionId.slice(0, 8), inline: true },
          { name: "Mode", value: row?.mode ?? "?", inline: true },
          { name: "Trigger", value: row?.trigger ?? "?", inline: true },
          { name: "Work dir", value: row?.work_dir ?? CONFIG.kimiWorkDir, inline: false },
          { name: "State", value: session.state, inline: true }
        )
        .setColor(0x3b82f6);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (commandName === "workdir") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", ephemeral: true });
        return;
      }
      const path = interaction.options.getString("path", true);
      // For v1, we just store it in-memory on the session if one exists, or acknowledge it.
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (session) {
        session.workDir = path;
      }
      await interaction.reply({ content: `Working directory set to \`${path}\` for this thread.`, ephemeral: true });
      return;
    }

    if (commandName === "sessions") {
      if (!CONFIG.allowedUserIds.has(user.id)) {
        await interaction.reply({ content: "Admin only.", ephemeral: true });
        return;
      }
      const rows = listAllSessions();
      const lines = rows.map((r) => {
        const s = SessionManager.get(r.thread_id);
        return `- \`${r.session_id.slice(0, 8)}\` | ${r.mode} | ${s?.state ?? "dormant"} | <#${r.thread_id}>`;
      });
      const content = lines.length ? lines.join("\n").slice(0, 1900) : "No sessions.";
      await interaction.reply({ content, ephemeral: true });
      return;
    }

    const proxyCommands = ["compact", "clear", "yolo", "plan", "add-dir", "export", "init"];
    if (proxyCommands.includes(commandName)) {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", ephemeral: true });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session in this thread.", ephemeral: true });
        return;
      }
      let prompt = "/" + commandName;
      if (commandName === "compact") {
        const focus = interaction.options.getString("focus");
        if (focus) prompt += ` ${focus}`;
      }
      if (commandName === "plan") {
        const mode = interaction.options.getString("mode");
        if (mode) prompt += ` ${mode}`;
      }
      if (commandName === "add-dir") {
        const p = interaction.options.getString("path", true);
        prompt += ` ${p}`;
      }
      await interaction.reply({ content: `➡️ Sending \`${prompt}\` to kimi…`, ephemeral: true });
      const { runTurn } = await import("./turn.js");
      runTurn(session, thread, prompt).catch(async (e) => {
        await thread.send({ embeds: [buildErrorEmbed(e)] });
      });
      return;
    }
  });
}

function buildErrorEmbed(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return new EmbedBuilder().setTitle("❌ Session Error").setDescription(msg).setColor(0xdc2626);
}
