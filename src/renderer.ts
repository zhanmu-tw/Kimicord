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

type SendableChannel = ThreadChannel | TextChannel | NewsChannel | ForumChannel;

export class TurnRenderer {
  private textBuffer = "";
  private thinkBuffer = "";
  private lastEditAt = 0;
  private editTimer: NodeJS.Timeout | null = null;
  private discordMessage: Message | null = null;
  private toolMessages = new Map<string, Message>();
  private pendingToolCalls = new Map<string, { name: string; args: string; posted: boolean }>();
  private lastToolCallId: string | null = null;
  private statusMessage: Message | null = null;
  private stepCount = 0;
  private contextUsage = 0;
  private finished = false;

  constructor(
    private channel: ThreadChannel | TextChannel,
    private sessionId: string,
    private mode: string,
    private trigger: string,
    private workDir: string,
    private yolo: boolean
  ) {}

  async init(): Promise<void> {
    if (CONFIG.showStatusEmbed) {
      const embed = this.buildStatusEmbed("🟡 Working");
      this.statusMessage = await this.channel.send({ embeds: [embed] });
    }
  }

  handleEvent(event: WireEventMessage) {
    switch (event.params.type) {
      case "ContentPart": {
        const p = event.params.payload as ContentPartTextPayload | ContentPartThinkPayload;
        if (p.type === "text") {
          this.textBuffer += (p as ContentPartTextPayload).text;
          this.scheduleEdit();
        } else if (p.type === "think" && CONFIG.showThinking) {
          this.thinkBuffer += (p as ContentPartThinkPayload).think;
        }
        break;
      }
      case "ToolCall": {
        const p = event.params.payload as ToolCallPayload;
        this.pendingToolCalls.set(p.id, { name: p.function.name, args: p.function.arguments ?? "", posted: false });
        this.lastToolCallId = p.id;
        if (p.function.arguments) {
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
    const now = Date.now();
    if (now - this.lastEditAt >= 1000) {
      this.flushEdit().catch(console.error);
    } else if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        this.flushEdit().catch(console.error);
      }, 1000 - (now - this.lastEditAt));
    }
  }

  private async flushEdit() {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (!this.textBuffer) return;
    this.lastEditAt = Date.now();

    const chunks = splitMarkdown(this.textBuffer, 1900);
    if (!this.discordMessage) {
      this.discordMessage = await this.channel.send(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await this.channel.send(chunks[i]);
      }
    } else {
      await this.discordMessage.edit(chunks[0]);
      // Note: we don't try to edit extra split messages; simplicity trade-off.
      // For a v1 this is acceptable.
    }
  }

  private async postThinking() {
    if (!this.thinkBuffer) return;
    let text = this.thinkBuffer.trim();
    if (text.length > 1800) {
      text = text.slice(0, 1800) + "…(truncated)";
    }
    await this.channel.send(`||${text}||`);
  }

  private async flushToolCall(toolCallId: string) {
    const buf = this.pendingToolCalls.get(toolCallId);
    if (!buf || buf.posted) return;
    buf.posted = true;
    const argsPreview = buf.args.trim() || "(no arguments)";
    const text = `⚙️ **${buf.name}**: \`${argsPreview.replace(/`/g, "'").slice(0, 400)}\``;
    const msg = await this.channel.send(text);
    this.toolMessages.set(toolCallId, msg);
  }

  private async updateToolResult(payload: ToolResultPayload) {
    const id = payload.tool_call_id ?? payload.id;
    if (!id) return;

    const output = payload.return_value?.output ?? payload.result ?? "";

    const buf = this.pendingToolCalls.get(id);
    if (buf && !buf.posted) {
      await this.flushToolCall(id);
    }

    const lines = output.split("\n");
    let resultText: string;
    if (lines.length <= 1) {
      resultText = "\`" + output.slice(0, 900) + "\`";
    } else {
      const head = lines.slice(0, 3).join("\n");
      const more = lines.length - 3;
      resultText = "\`\`\`\n" + head + (more > 0 ? `\n▾ ${more} more lines` : "") + "\n\`\`\`";
      if (resultText.length > 900) {
        resultText = resultText.slice(0, 900) + "…";
      }
    }
    await this.channel.send(resultText);
  }

  private buildStatusEmbed(status: string): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle("🟡 Kimi Session")
      .addFields(
        { name: "Session", value: this.sessionId.slice(0, 8), inline: true },
        { name: "Mode", value: this.mode, inline: true },
        { name: "Trigger", value: this.trigger, inline: true },
        { name: "Working dir", value: this.workDir, inline: false },
        { name: "YOLO", value: String(this.yolo), inline: true },
        { name: "Step", value: String(this.stepCount), inline: true },
        { name: "Context", value: `${(this.contextUsage * 100).toFixed(1)}%`, inline: true },
        { name: "Status", value: status, inline: false }
      )
      .setColor(status.includes("Working") ? 0xf59e0b : status.includes("Ready") ? 0x22c55e : 0x6b7280);
  }

  async updateStatus(status: string) {
    if (!CONFIG.showStatusEmbed) return;
    if (!this.statusMessage) {
      this.statusMessage = await this.channel.send({ embeds: [this.buildStatusEmbed(status)] });
    } else {
      await this.statusMessage.edit({ embeds: [this.buildStatusEmbed(status)] });
    }
  }
}

function splitMarkdown(text: string, maxLen: number): string[] {
  const out: string[] = [];
  // Strip tables first (crude but effective for v1)
  text = text.replace(/\|[^\n]+\|/g, (m) => m.replace(/\|/g, " "));
  while (text.length > maxLen) {
    let cut = text.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    out.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  if (text) out.push(text);
  return out.length ? out : [""];
}
