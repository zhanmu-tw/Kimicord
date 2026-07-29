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
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { CONFIG, sanitizeWorkDir } from "./config.js";
import { tryMarkResolved } from "./approvals.js";
import { SessionManager } from "./session.js";
import * as channelMode from "./modes/channel.js";
import * as forumMode from "./modes/forum.js";
import { deleteSessionByThread, getSessionByThread, listAllSessions } from "./db.js";
import { buildErrorEmbed } from "./errors.js";


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
    new SlashCommandBuilder().setName("model").setDescription("Choose the kimi model").toJSON(),
    new SlashCommandBuilder().setName("effort").setDescription("Choose the thinking effort").toJSON(),
    new SlashCommandBuilder().setName("mode").setDescription("Choose the permission mode").toJSON(),
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
    try {
      // System messages (pins, boosts, joins) are authored by users but
      // carry no prompt content
      if (message.author.bot || message.system) return;
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
    } catch (e) {
      console.error("MessageCreate handler error:", e);
    }
  });

  client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
    try {
      const config = CONFIG.channels.get(thread.parentId ?? "");
      if (!config || config.discordMode !== "forum") return;
      await forumMode.handleNewPost(thread, config);
    } catch (e) {
      console.error("ThreadCreate handler error:", e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isButton()) {
      if (!CONFIG.allowedUserIds.has(interaction.user.id)) {
        await interaction.reply({ content: "You are not authorized to interact with this bot.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const customId = interaction.customId;
      const parts = customId.split(":");
      if (parts.length < 4) return;
      const [type, wireRequestId, threadId, ...rest] = parts;
      if (!type || !wireRequestId || !threadId) return;

      const session = SessionManager.get(threadId);
      if (!session) {
        await interaction.reply({ content: "Session not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      if (type === "approve") {
        const value = rest[0];
        if (!value) return;
        if (!tryMarkResolved(wireRequestId)) {
          await interaction.reply({ content: "This request was already handled.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
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
          if (allAnswered && tryMarkResolved(wireRequestId)) {
            const record: Record<string, string> = {};
            for (const [k, v] of answersMap) {
              const text = texts?.[Number(k.slice(1))];
              if (text === undefined) {
                console.error(`Missing question text for ${wireRequestId}:${k}; using placeholder`);
              }
              record[text ?? "question"] = v;
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
      if (!CONFIG.allowedUserIds.has(interaction.user.id)) {
        await interaction.reply({ content: "You are not authorized to interact with this bot.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const customId = interaction.customId;
      if (customId.startsWith("config:")) {
        // config:<threadId>:<configId> — pick a model/thinking/mode value.
        const [, threadId, configId] = customId.split(":");
        const selected = interaction.values[0];
        const session = threadId ? SessionManager.get(threadId) : undefined;
        if (!session || !configId || !selected) {
          await interaction.reply({ content: "Session not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
        try {
          await session.setConfigOption(configId, selected);
          const option = session.getConfigOption(configId);
          const displayName = option?.name ?? configId;
          const choiceName = option?.options.find((c) => c.value === selected)?.name ?? selected;
          await interaction.update({ content: `✅ ${displayName} set to **${choiceName}**`, components: [] }).catch(() => {});
          const thread = interaction.channel;
          if (thread?.isSendable()) {
            await thread.send(`⚙️ <@${interaction.user.id}> changed ${displayName} to **${choiceName}**`).catch(() => {});
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.update({ content: `❌ Sorry, I couldn't change that setting: ${msg}`, components: [] }).catch(() => {});
        }
        return;
      }
      const parts = customId.split(":");
      if (parts.length < 4) return;
      const [type, wireRequestId, threadId, ...rest] = parts;
      if (!type || !wireRequestId || !threadId) return;
      if (type !== "multiselect") return;

      const session = SessionManager.get(threadId);
      if (!session) {
        await interaction.reply({ content: "Session not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      const qKey = rest.join(":");
      // Select menu values are option indices; map them back to labels
      const optionsMap = session.questionOptions.get(wireRequestId);
      const labels = optionsMap?.get(qKey) ?? [];
      const answerValue = interaction.values.map((v) => labels[Number(v)] ?? v).join(", ");

      const answersMap = session.questionAnswers.get(wireRequestId);
      const texts = session.questionTexts.get(wireRequestId);
      const requestId = session.questionRequestIds.get(wireRequestId) ?? wireRequestId;
      if (answersMap) {
        answersMap.set(qKey, answerValue);
        const allAnswered = Array.from(answersMap.values()).every((v) => v.length > 0);
        if (allAnswered && tryMarkResolved(wireRequestId)) {
          const record: Record<string, string> = {};
          for (const [k, v] of answersMap) {
            const text = texts?.[Number(k.slice(1))];
            if (text === undefined) {
              console.error(`Missing question text for ${wireRequestId}:${k}; using placeholder`);
            }
            record[text ?? "question"] = v;
          }
          session.resolveQuestionRequest(wireRequestId, requestId, record);
          session.clearQuestionState(wireRequestId);
        }
      }

      await interaction.update({ content: `Selected: ${answerValue}`, components: [] }).catch(() => {});
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!CONFIG.allowedUserIds.has(interaction.user.id)) {
      await interaction.reply({ content: "You are not authorized to use this bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    const { commandName, channel, user } = interaction;

    if (commandName === "new") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      // Session spawn + dynamic imports can exceed the 3s interaction window
      await interaction.deferReply();
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
        session.on("dequeue", async (item: { text: string; context?: unknown; extraBlocks?: import("./wire.js").AcpPromptContentBlock[] }) => {
          runTurn(session, thread, item.text, undefined, item.extraBlocks).catch(async (e) => {
            await thread.send({ embeds: [buildErrorEmbed(e)] });
          });
        });
      }
      await interaction.editReply("🟡 New session started.");
      if (prompt) {
        runTurn(session, thread, prompt).catch(async (e) => {
          await thread.send({ embeds: [buildErrorEmbed(e)] });
        });
      }
      return;
    }

    if (commandName === "interrupt") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No active session here.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (session.state !== "busy") {
        await interaction.reply({ content: "Session is not currently busy.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply();
      await session.cancel();
      await interaction.editReply("⏹️ Turn interrupted.");
      return;
    }

    if (commandName === "stop") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No active session here.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply();
      await session.cancel();
      SessionManager.destroy(thread.id);
      deleteSessionByThread(thread.id);
      await interaction.editReply("🛑 Session stopped.");
      return;
    }

    if (commandName === "status") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session in this thread.", flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === "workdir") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
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
        await interaction.reply({ content: `Working directory set to \`${sanitized}\` for this thread.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.reply({ content: `❌ Invalid path: ${msg}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (commandName === "sessions") {
      if (!CONFIG.allowedUserIds.has(user.id)) {
        await interaction.reply({ content: "Admin only.", flags: MessageFlags.Ephemeral });
        return;
      }
      const rows = listAllSessions();
      const lines = rows.map((r) => {
        const s = SessionManager.get(r.thread_id);
        return `- \`${r.session_id.slice(0, 8)}\` | ${r.mode} | ${s?.state ?? "dormant"} | <#${r.thread_id}>`;
      });
      // Truncate at a line boundary so we never cut a mention in half
      let content = "No sessions.";
      if (lines.length) {
        const shown: string[] = [];
        let len = 0;
        for (const line of lines) {
          if (len + line.length + 1 > 1900) break;
          shown.push(line);
          len += line.length + 1;
        }
        const hidden = lines.length - shown.length;
        content = shown.join("\n") + (hidden > 0 ? `\n…and ${hidden} more` : "");
      }
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === "export") {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session in this thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: "➡️ Exporting context…", flags: MessageFlags.Ephemeral });
      const { runTurn } = await import("./turn.js");
      // The ACP layer does not intercept "/export" (unknown command), so ask the
      // model to write the export itself. The reply phrasing "Exported N
      // messages to <path>.md" is what TurnRenderer.lastExportPath parses.
      const exportPrompt =
        "Export this conversation so far to a markdown file named " +
        `kimi-export-${new Date().toISOString().replace(/[:.]/g, "-")}.md ` +
        "in the current working directory, including all user and assistant messages. " +
        "When done, reply with exactly: Exported N messages to <absolute file path>";
      const renderer = await runTurn(session, thread, exportPrompt);
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
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session in this thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const testType = interaction.options.getString("type", true);
      // Posting the test components does a dynamic import + channel sends
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

      await interaction.editReply({ content: `🧪 Test ${testType} sent.` });
      return;
    }

    const configCommands: Record<string, { configId: string; placeholder: string }> = {
      model: { configId: "model", placeholder: "Choose a model..." },
      effort: { configId: "thinking", placeholder: "Choose a thinking effort..." },
      mode: { configId: "mode", placeholder: "Choose a permission mode..." },
    };
    const configCmd = configCommands[commandName];
    if (configCmd) {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session here yet — send a message first.", flags: MessageFlags.Ephemeral });
        return;
      }
      const { configId, placeholder } = configCmd;
      const option = session.getConfigOption(configId);
      if (!option || option.options.length === 0) {
        await interaction.reply({ content: "This session doesn't expose that setting.", flags: MessageFlags.Ephemeral });
        return;
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`config:${thread.id}:${configId}`)
        .setPlaceholder(placeholder)
        .addOptions(
          option.options.slice(0, 25).map((choice) => ({
            label: choice.name.slice(0, 100),
            value: choice.value.slice(0, 100),
            description: choice.description ? choice.description.slice(0, 100) : undefined,
            default: choice.value === option.currentValue,
          }))
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
      const current = option.options.find((c) => c.value === option.currentValue);
      await interaction.reply({
        content: `⚙️ **${option.name}** — current: **${current?.name ?? option.currentValue ?? "?"}**`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const proxyCommands = ["compact", "clear", "yolo", "plan", "add-dir", "init"];
    if (proxyCommands.includes(commandName)) {
      if (!channel || !(channel instanceof ThreadChannel)) {
        await interaction.reply({ content: "This command only works inside a thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const thread = channel as ThreadChannel;
      const session = SessionManager.get(thread.id);
      if (!session) {
        await interaction.reply({ content: "No session in this thread.", flags: MessageFlags.Ephemeral });
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
          await interaction.reply({ content: `❌ Invalid path: ${msg}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      await interaction.reply({ content: `➡️ Sending \`${prompt}\` to kimi…`, flags: MessageFlags.Ephemeral });
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



