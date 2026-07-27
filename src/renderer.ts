import {
  ThreadChannel,
  ForumChannel,
  EmbedBuilder,
  Message,
  NewsChannel,
  TextChannel,
} from "discord.js";
import {
  WireEventMessage,
  ContentPartTextPayload,
  ContentPartThinkPayload,
  ToolCallPayload,
  ToolResultPayload,
  StepBeginPayload,
  StatusUpdatePayload,
  TurnEndPayload,
} from "./wire.js";
import { CONFIG } from "./config.js";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

type SendableChannel = ThreadChannel | TextChannel | NewsChannel | ForumChannel;

// Status embeds are reused across turns within the same channel/thread
// instead of posting a new status message per turn.
const statusMessages = new Map<string, Message>();

const STATUS_EDIT_MIN_INTERVAL_MS = 2000;

export class TurnRenderer {
  private textBuffer = "";
  private thinkBuffer = "";
  private lastEditAt = 0;
  private editTimer: NodeJS.Timeout | null = null;
  private discordMessage: Message | null = null;
  private extraMessages: Message[] = [];
  private toolMessages = new Map<string, Message>();
  private pendingToolCalls = new Map<
    string,
    { name: string; args: string; posted: boolean }
  >();
  private lastToolCallId: string | null = null;
  private statusMessage: Message | null = null;
  private lastStatusEditAt = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private pendingStatus: string | null = null;
  private stepCount = 0;
  private contextUsage = 0;
  private finished = false;
  lastExportPath: string | null = null;

  constructor(
    private channel: ThreadChannel | TextChannel,
    private sessionId: string,
    private mode: string,
    private trigger: string,
    private workDir: string,
    private yolo: boolean,
  ) {}

  async init(): Promise<void> {
    if (CONFIG.showStatusEmbed) {
      // Reuse the status message from a previous turn in this channel if there is one
      this.statusMessage = statusMessages.get(this.channel.id) ?? null;
      await this.updateStatus("🟡 Working");
    }
  }

  handleEvent(event: WireEventMessage) {
    switch (event.params.type) {
      case "ContentPart": {
        const p = event.params.payload as
          | ContentPartTextPayload
          | ContentPartThinkPayload;
        if (p.type === "text") {
          const textPart = (p as ContentPartTextPayload).text;
          const exportMatch = textPart.match(
            /exported\s+\d+\s+messages?\s+to\s+(\S+\.md)/i,
          );
          const exportPath = exportMatch?.[1];
          if (exportPath) {
            this.lastExportPath = exportPath;
          }
          this.textBuffer += textPart;
          this.scheduleEdit();
        } else if (p.type === "think" && CONFIG.showThinking) {
          this.thinkBuffer += (p as ContentPartThinkPayload).think;
        }
        break;
      }
      case "ToolCall": {
        const p = event.params.payload as ToolCallPayload;
        this.pendingToolCalls.set(p.id, {
          name: p.function.name,
          args: p.function.arguments ?? "",
          posted: false,
        });
        this.lastToolCallId = p.id;
        const initialArgs = p.function.arguments ?? "";
        if (initialArgs.trim().endsWith("}")) {
          this.flushToolCall(p.id).catch(console.error);
        }
        break;
      }
      case "ToolCallPart": {
        const p = event.params.payload as { arguments_part: string };
        if (this.lastToolCallId) {
          const buf = this.pendingToolCalls.get(this.lastToolCallId);
          if (buf) {
            buf.args += p.arguments_part;
            // Post once we have a complete-looking JSON object
            if (!buf.posted && buf.args.trim().endsWith("}")) {
              this.flushToolCall(this.lastToolCallId).catch(console.error);
            }
          }
        }
        break;
      }
      case "ToolResult": {
        const p = event.params.payload as ToolResultPayload;
        this.updateToolResult(p).catch(console.error);
        break;
      }
      case "StepBegin": {
        const p = event.params.payload as StepBeginPayload;
        this.stepCount = p.n;
        if (CONFIG.showStatusEmbed) {
          this.updateStatus("🟡 Working").catch(console.error);
        }
        break;
      }
      case "StatusUpdate": {
        const p = event.params.payload as StatusUpdatePayload;
        this.contextUsage = p.context_usage;
        if (CONFIG.showStatusEmbed) {
          this.updateStatus("🟡 Working").catch(console.error);
        }
        break;
      }
      case "TurnEnd": {
        this.finished = true;
        this.flushEdit().catch(console.error);
        if (CONFIG.showThinking) {
          this.postThinking().catch(console.error);
        }
        if (CONFIG.showStatusEmbed) {
          this.updateStatus("🟢 Ready").catch(console.error);
        }
        break;
      }
      // Silently ignore: TurnBegin, StepInterrupted, CompactionBegin, CompactionEnd,
      // SubagentEvent, ApprovalResponse, HookTriggered, HookResolved, PlanDisplay
    }
  }

  private scheduleEdit() {
    if (this.finished) return;
    if (this.editTimer) return;
    const now = Date.now();
    // Debounce the first message creation for 300ms so tokens can accumulate,
    // then throttle subsequent edits to once per second.
    const delay = this.discordMessage
      ? Math.max(0, 1000 - (now - this.lastEditAt))
      : 300;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.flushEdit().catch(console.error);
    }, delay);
  }

  private flushQueue: Promise<void> = Promise.resolve();

  private flushEdit(): Promise<void> {
    // The catch is part of the stored chain: a failed send/edit must not
    // poison the queue for every subsequent flush.
    this.flushQueue = this.flushQueue
      .then(async () => {
        if (this.editTimer) {
          clearTimeout(this.editTimer);
          this.editTimer = null;
        }
        if (!this.textBuffer) return;
        this.lastEditAt = Date.now();

        // Strip raw QuestionResponse JSON that Kimi echoes back after answers
        this.textBuffer = this.textBuffer
          .replace(/```(?:json)?\s*\n?\{\s*"answers"\s*:[\s\S]*?\}\s*\n?```/g, "")
          .replace(/\{\s*"answers"\s*:\s*\{[\s\S]*?\}\s*\}\s*/g, "")
          .trimStart();
        // Strip export confirmation text; the /export command uploads the file directly
        this.textBuffer = this.textBuffer
          .replace(
            /Exported\s+\d+\s+messages?\s+to\s+\S+\.md[\s\S]*?Note:[\s\S]*?The exported file may contain sensitive information\.[\s\S]*?Please be cautious when sharing it externally\./gi,
            "",
          )
          .trimStart();
        this.textBuffer = collapseBlankLinesOutsideFences(this.textBuffer).trimStart();
        if (!this.textBuffer) return;

        const chunks = splitMarkdown(this.textBuffer, 1900);

        // If the final response is huge, replace it with a file attachment
        if (this.finished && chunks.length > 3) {
          const filePath = this.writeTempOutput();
          if (filePath) {
            try {
              if (this.discordMessage) {
                try {
                  await this.discordMessage.delete();
                } catch {
                  // ignore
                }
              }
              for (const extra of this.extraMessages) {
                try {
                  await extra.delete();
                } catch {
                  // ignore
                }
              }
              this.discordMessage = await this.channel.send({
                content: "📄 Response is long, here's the file:",
                files: [filePath],
              });
              this.extraMessages = [];
              this.textBuffer = "";
              return;
            } finally {
              try {
                unlinkSync(filePath);
              } catch {
                // ignore
              }
            }
          }
          // Temp file unavailable — fall through to chunked messages
        }

        if (!this.discordMessage) {
          this.discordMessage = await this.channel.send(chunks[0]!);
          for (let i = 1; i < chunks.length; i++) {
            this.extraMessages.push(await this.channel.send(chunks[i]!));
          }
        } else {
          await this.discordMessage.edit(chunks[0]!);
          for (let i = 1; i < chunks.length; i++) {
            const extra = this.extraMessages[i - 1];
            if (extra) {
              await extra.edit(chunks[i]!);
            } else {
              this.extraMessages.push(await this.channel.send(chunks[i]!));
            }
          }
          // Delete any excess overflow messages if text shrank
          while (this.extraMessages.length > chunks.length - 1) {
            const extra = this.extraMessages.pop();
            try {
              await extra?.delete();
            } catch {
              // ignore
            }
          }
        }
      })
      .catch((e) => {
        console.error("flushEdit failed:", e);
      });
    return this.flushQueue;
  }

  private writeTempOutput(): string | null {
    try {
      const dir = pathJoin(tmpdir(), "kimicord");
      mkdirSync(dir, { recursive: true });
      const filePath = pathJoin(dir, `kimi-output-${Date.now()}.md`);
      writeFileSync(filePath, this.textBuffer);
      return filePath;
    } catch (e) {
      console.error("Failed to write temp output file:", e);
      return null;
    }
  }

  private async postThinking() {
    if (!this.thinkBuffer) return;
    let text = this.thinkBuffer.trim();
    if (text.length > 1800) {
      text = text.slice(0, 1800) + "…(truncated)";
    }
    // Nested || would prematurely close the spoiler
    text = text.replace(/\|\|/g, "‖");
    await this.channel.send(`||${text}||`);
  }

  private async flushToolCall(toolCallId: string) {
    const buf = this.pendingToolCalls.get(toolCallId);
    if (!buf || buf.posted) return;
    buf.posted = true;

    // Skip raw tool call text for tools that are better summarized by Kimi
    // in its natural response, or handled via interactive UI.
    if (buf.name === "AskUserQuestion" || buf.name === "ReadFile") return;

    let text = this.formatToolCallText(buf.name, buf.args.trim());
    const msg = await this.channel.send(text);
    this.toolMessages.set(toolCallId, msg);
  }

  private formatToolCallText(name: string, args: string): string {
    if (!args) return `⚙️ **${name}**: (no arguments)`;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      // fall back to raw preview
    }

    if (name === "Shell" && parsed?.command) {
      // A command containing ``` would break out of the fence
      const command = String(parsed.command).slice(0, 800).replace(/```/g, "'''");
      return `⚙️ **Shell**\n\`\`\`bash\n${command}\n\`\`\``;
    }

    if (name === "WriteFile" && parsed?.path) {
      return `⚙️ **WriteFile**: \`${String(parsed.path)}\``;
    }

    if (name === "StrReplaceFile" && parsed?.path) {
      return `⚙️ **StrReplaceFile**: \`${String(parsed.path)}\``;
    }

    if (name === "ReadFile" && parsed?.path) {
      return `⚙️ **ReadFile**: \`${String(parsed.path)}\``;
    }

    if (name === "Glob" && parsed?.pattern) {
      return `⚙️ **Glob**: \`${String(parsed.pattern)}\``;
    }

    // Generic fallback: code block for multi-line, inline for single-line
    const preview = args.replace(/`/g, "'").slice(0, 400);
    if (args.includes("\n")) {
      return `⚙️ **${name}**\n\`\`\`json\n${preview.replace(/```/g, "'''")}\n\`\`\``;
    }
    return `⚙️ **${name}**: \`${preview}\``;
  }

  private async updateToolResult(payload: ToolResultPayload) {
    const id = payload.tool_call_id ?? payload.id;
    if (!id) return;

    const buf = this.pendingToolCalls.get(id);

    // Skip rendering raw tool results that are better left for Kimi to summarize
    // in its natural ContentPart response, rather than dumping huge raw output.
    if (buf?.name === "AskUserQuestion" || buf?.name === "ReadFile") {
      this.pendingToolCalls.delete(id);
      return;
    }

    // SHOW_TOOL_OUTPUT=false hides command output from the thread (the "⚙️"
    // tool call line itself still shows what ran); failures still surface as a
    // one-liner so errors aren't silent.
    if (!CONFIG.showToolOutput) {
      if (buf && !buf.posted) {
        await this.flushToolCall(id);
      }
      this.pendingToolCalls.delete(id);
      if (payload.return_value?.is_error) {
        await this.channel.send("⚠️ Tool call failed (output hidden — set `SHOW_TOOL_OUTPUT=true` to see it)");
      }
      return;
    }

    const output = payload.return_value?.output ?? payload.result ?? "";

    if (buf && !buf.posted) {
      await this.flushToolCall(id);
    }

    const lines = output.split("\n");
    let resultText: string;
    if (lines.length <= 1) {
      // Single-line output may itself contain backticks
      resultText = "`" + output.slice(0, 900).replace(/`/g, "'") + "`";
    } else {
      let head = lines.slice(0, 3).join("\n").replace(/```/g, "'''");
      const more = lines.length - 3;
      const suffix = more > 0 ? `\n▾ ${more} more lines` : "";
      // Truncate the inner content, not the built string, so the closing
      // fence always survives
      const budget = 900 - suffix.length;
      if (head.length > budget) {
        head = head.slice(0, Math.max(0, budget - 1)) + "…";
      }
      resultText = "```\n" + head + suffix + "\n```";
    }
    await this.channel.send(resultText);
  }

  private buildStatusEmbed(status: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle("Kimi Session")
      .addFields(
        { name: "Session", value: this.sessionId.slice(0, 8), inline: true },
        { name: "Mode", value: this.mode, inline: true },
        { name: "Trigger", value: this.trigger, inline: true },
        { name: "Working dir", value: this.workDir, inline: false },
        { name: "YOLO", value: String(this.yolo), inline: true },
        { name: "Step", value: String(this.stepCount), inline: true },
        {
          name: "Context",
          value: `${(this.contextUsage * 100).toFixed(1)}%`,
          inline: true,
        },
        { name: "Status", value: status, inline: false },
      )
      .setColor(
        status.includes("Working")
          ? 0xf59e0b
          : status.includes("Ready")
            ? 0x22c55e
            : 0x6b7280,
      );
  }

  async updateStatus(status: string) {
    if (!CONFIG.showStatusEmbed) return;
    const now = Date.now();
    const elapsed = now - this.lastStatusEditAt;
    if (this.statusMessage && elapsed < STATUS_EDIT_MIN_INTERVAL_MS) {
      // Throttle rapid edits (StepBegin/StatusUpdate can fire constantly on
      // long turns); keep the latest status for a trailing update.
      this.pendingStatus = status;
      if (!this.statusTimer) {
        this.statusTimer = setTimeout(() => {
          this.statusTimer = null;
          const s = this.pendingStatus ?? "🟢 Ready";
          this.pendingStatus = null;
          this.updateStatusNow(s).catch(console.error);
        }, STATUS_EDIT_MIN_INTERVAL_MS - elapsed);
      }
      return;
    }
    await this.updateStatusNow(status);
  }

  private async updateStatusNow(status: string) {
    this.lastStatusEditAt = Date.now();
    const embed = this.buildStatusEmbed(status);
    if (!this.statusMessage) {
      this.statusMessage = await this.channel.send({ embeds: [embed] });
      statusMessages.set(this.channel.id, this.statusMessage);
      return;
    }
    try {
      await this.statusMessage.edit({ embeds: [embed] });
    } catch {
      // The old status message was deleted — post a fresh one
      this.statusMessage = await this.channel.send({ embeds: [embed] });
      statusMessages.set(this.channel.id, this.statusMessage);
    }
  }
}

function splitMarkdown(text: string, maxLen: number): string[] {
  const out: string[] = [];
  // Strip tables first (crude but effective for v1) — only on lines that
  // actually look like table rows, so pipes inside inline code survive.
  text = text.replace(/^\|.*\|$/gm, (m) => m.replace(/\|/g, " "));
  let inFence = false;
  let fenceTag = "```";
  while (text.length > maxLen) {
    let cut = text.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    let chunk = text.slice(0, cut);
    // Track code-fence state across the chunk so we never cut mid-fence
    for (const line of chunk.split("\n")) {
      const m = line.match(/^(```[^\s`]*)/);
      if (m) {
        if (inFence) {
          inFence = false;
        } else {
          inFence = true;
          fenceTag = m[1] ?? "```";
        }
      }
    }
    if (inFence) {
      // Close the fence in this chunk and re-open it in the next one
      chunk += "\n```";
      text = fenceTag + "\n" + text.slice(cut).trimStart();
    } else {
      text = text.slice(cut).trimStart();
    }
    out.push(chunk);
  }
  if (text) out.push(text);
  return out.length ? out : [""];
}

// Collapses runs of blank lines outside of code fences; blank lines inside
// fenced code blocks are preserved as-is.
function collapseBlankLinesOutsideFences(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line.trimStart())) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") continue;
    out.push(line);
  }
  return out.join("\n");
}
