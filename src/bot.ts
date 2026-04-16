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
import { CONFIG, sanitizeWorkDir } from "./config.js";
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
    new SlashCommandBuilder().setName("interrupt").setDescription("Interrupt the current turn without killing the session").toJSON(),
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
    new SlashCommandBuilder().setName("export").setDescription("Export current kimi context and upload it as a file").toJSON(),
    new SlashCommandBuilder().setName("init").setDescription("Generate AGENTS.md via kimi").toJSON(),
    new SlashCommandBuilder()
      .setName("test")
      .setDescription("Send a test request to the current session")
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("Type of test request")
          .setRequired(true)
          .addChoices(
            { name: "ApprovalRequest", value: "approval" },
            { name: "ToolCallRequest", value: "toolcall" },
            { name: "QuestionRequest (single)", value: "question" },
            { name: "QuestionRequest (multi)", value: "multiselect" }
          )
      )
      .toJSON(),
  ];

  const route = CONFIG.guildId
    ? Routes.applicationGuildCommands(CONFIG.discordAppId, CONFIG.guildId)
    : Routes.applicationCommands(CONFIG.discordAppId);
  await rest.put(route, { body: commands });

  // Clear global commands when using guild commands to prevent duplicates
  // after switching from global registration
  if (CONFIG.guildId) {
    try {
      await rest.put(Routes.applicationCommands(CONFIG.discordAppId), { body: [] });
      console.log("Cleared global slash commands");
    } catch (e) {
      console.log("Failed to clear global slash commands:", e);
    }
  }

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
    if (interaction.isButton()) {
      const customId = interaction.customId;
      const parts = customId.split(":");
      if (parts.length < 4) return;
      const [type, wireRequestId, threadId, ...rest] = parts;

      const session = SessionManager.get(threadId);
      if (!session) {
        await interaction.update({ content: "Session not found.", components: [] }).catch(() => {});
        return;
      }

      if (type === "approve") {
        const value = rest[0];
        session.resolveRequest(wireRequestId, value);
        await interaction.update({ content: `Selected: ${value}`, components: [] }).catch(() => {});
        return;
      }

      if (type === "answer") {
        const idx = Number(rest.pop());
        const qKey = rest.join(":");
        const optionsMap = session.questionOptions.get(wireRequestId);
        const labels = optionsMap?.get(qKey) ?? [];
        const answerValue = labels[idx] ?? "";

        const answersMap = session.questionAnswers.get(wireRequestId);
        const texts = session.questionTexts.get(wireRequestId);
        const requestId = session.questionRequestIds.get(wireRequestId) ?? wireRequestId;
        if (answersMap) {
          answersMap.set(qKey, answerValue);
          const allAnswered = Array.from(answersMap.values()).every((v) => v.length > 0);
          if (allAnswered) {
            const record: Record<string, string> = {};
            for (const [k, v] of answersMap) {
              const text = texts?.[Number(k.slice(1))] ?? k;
              record[text] = v;
            }
            session.resolveQuestionRequest(wireRequestId, requestId, record);
            session.clearQuestionState(wireRequestId);
          }
        }

        await interaction.update({ content: `Selected: ${answerValue}`, components: [] }).catch(() => {});
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      const parts = customId.split(":");
      if (parts.length < 4) return;
      const [type, wireRequestId, threadId, ...rest] = parts;
      if (type !== "multiselect") return;

      const session = SessionManager.get(threadId);
      if (!session) {
        await interaction.update({ content: "Session not found.", components: [] }).catch(() => {});
        return;
      }

      const qKey = rest.join(":");
      const selected = interaction.values; // string[]
      const answerValue = selected.join(", ");

      const answersMap = session.questionAnswers.get(wireRequestId);
      const texts = session.questionTexts.get(wireRequestId);
      const requestId = session.questionRequestIds.get(wireRequestId) ?? wireRequestId;
      if (answersMap) {
        answersMap.set(qKey, answerValue);
        const allAnswered = Array.from(answersMap.values()).every((v) => v.length > 0);
        if (allAnswered) {
          const record: Record<string, string> = {};
          for (const [k, v] of answersMap) {
            const text = texts?.[Number(k.slice(1))] ?? k;
            record[text] = v;
          }
          session.resolveQuestionRequest(wireRequestId, requestId, record);
          session.clearQuestionState(wireRequestId);
        }
      }

      await interaction.update({ content: `Selected: ${answerValue}`, components: [] }).catch(() => {});
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, channel, user } = interaction;

    if (commandName === "new") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", ephemeral: true });
        return;
      }
      const thread = channel as ThreadChannel;
      if (SessionManager.get(thread.id)) {
        SessionManager.destroy(thread.id);
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

    if (commandName === "interrupt") {
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
      if (session.state !== "busy") {
        await interaction.reply({ content: "Session is not currently busy.", ephemeral: true });
        return;
      }
      await session.cancel();
      await interaction.reply("⏹️ Turn interrupted.");
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
      SessionManager.destroy(thread.id);
      deleteSessionByThread(thread.id);
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
      const thread = channel as ThreadChannel;
      try {
        const sanitized = sanitizeWorkDir(path);
        const session = SessionManager.get(thread.id);
        if (session) {
          session.workDir = sanitized;
        }
        await interaction.reply({ content: `Working directory set to \`${sanitized}\` for this thread.`, ephemeral: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.reply({ content: `❌ Invalid path: ${msg}`, ephemeral: true });
      }
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

    if (commandName === "export") {
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
      await interaction.reply({ content: "➡️ Exporting context…", ephemeral: true });
      const { runTurn } = await import("./turn.js");
      const renderer = await runTurn(session, thread, "/export");
      const mdPath = renderer.lastExportPath;
      if (mdPath) {
        try {
          await thread.send({ content: "📄 Export complete:", files: [mdPath] });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await thread.send({ content: `✅ Export completed, but I couldn't attach the file: ${msg}` });
        }
      } else {
        await thread.send({ content: "✅ Export completed, but I couldn't find the file path in Kimi's response." });
      }
      return;
    }

    if (commandName === "test") {
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
      const testType = interaction.options.getString("type", true);
      const wireRequestId = `test-${Date.now()}`;
      const { postApproval, postToolCallRequest, postQuestion } = await import("./approvals.js");

      if (testType === "approval") {
        await postApproval(thread, session, wireRequestId, {
          action: "TestAction",
          description: "This is a test ApprovalRequest.",
        });
      } else if (testType === "toolcall") {
        await postToolCallRequest(thread, session, wireRequestId, {
          action: "TestToolCall",
          description: "This is a test ToolCallRequest.",
        });
      } else if (testType === "question") {
        await postQuestion(thread, session, wireRequestId, {
          id: wireRequestId,
          tool_call_id: "test-tool-call",
          questions: [
            {
              question: "Which color do you prefer?",
              header: "Color",
              options: [
                { label: "Red", description: "Warm and bold" },
                { label: "Blue", description: "Cool and calm" },
                { label: "Green", description: "Natural and fresh" },
              ],
              multi_select: false,
            },
          ],
        });
      } else if (testType === "multiselect") {
        await postQuestion(thread, session, wireRequestId, {
          id: wireRequestId,
          tool_call_id: "test-tool-call",
          questions: [
            {
              question: "Which features do you want?",
              header: "Features",
              options: [
                { label: "Dark mode", description: "Easy on the eyes" },
                { label: "Notifications", description: "Stay in the loop" },
                { label: "Auto-save", description: "Never lose work" },
              ],
              multi_select: true,
            },
          ],
        });
      }

      await interaction.reply({ content: `🧪 Test ${testType} sent.`, ephemeral: true });
      return;
    }

    const proxyCommands = ["compact", "clear", "yolo", "plan", "add-dir", "init"];
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
        try {
          const sanitized = sanitizeWorkDir(p);
          prompt += ` ${sanitized}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.reply({ content: `❌ Invalid path: ${msg}`, ephemeral: true });
          return;
        }
      }
      await interaction.reply({ content: `➡️ Sending \`${prompt}\` to kimi…`, ephemeral: true });
      const { runTurn } = await import("./turn.js");
      runTurn(session, thread, prompt).catch(async (e) => {
        await thread.send({ embeds: [buildErrorEmbed(e)] });
      });
      return;
    }
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
}

function buildErrorEmbed(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return new EmbedBuilder().setTitle("❌ Session Error").setDescription(msg).setColor(0xdc2626);
}

