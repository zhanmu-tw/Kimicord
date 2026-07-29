import { EventEmitter } from "node:events";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  WireRequestType,
  AcpOutboundMessage,
  AcpInboundMessage,
  AcpResultResponse,
  AcpErrorResponse,
  AcpServerRequest,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpConfigOption,
  AcpAvailableCommand,
  AcpPromptResult,
  AcpSessionUpdateParams,
  AcpSessionUpdate,
  AcpRequestPermissionParams,
  AcpPermissionOption,
  AcpToolCallInfo,
  AcpContentBlock,
  AcpPromptContentBlock,
  AcpMcpServer,
  JsonRpcError,
  ACP_ERROR_AUTH_REQUIRED,
  isAcpResponse,
  isAcpServerRequest,
  makeWireEvent,
  ApprovalRequestPayload,
  QuestionRequestPayload,
} from "./wire.js";
import { CONFIG } from "./config.js";
import { updateLastActive } from "./db.js";

export interface PendingRequest {
  wireRequestId: string;
  type: WireRequestType;
  resolve: (value: string) => void;
  timeout: NodeJS.Timeout;
}

export interface PromptResult {
  status: "finished" | "cancelled" | "max_steps_reached";
}

export interface QueueEntry {
  text: string;
  context?: unknown;
  extraBlocks?: AcpPromptContentBlock[];
  resolve?: (value: PromptResult) => void;
  reject?: (err: Error) => void;
}

const MAX_QUEUED_PROMPTS = 20;
const INIT_TIMEOUT_MS = 20000;
const SIGKILL_GRACE_MS = 5000;

// The bot's DB session ids are generated before the ACP session exists, and
// ACP assigns its own session id on session/new. Persist the mapping so
// session/resume works across bot restarts.
const ACP_SESSION_MAP_PATH = path.join(process.cwd(), "data", "acp-sessions.json");

let acpSessionMap: Map<string, string> | null = null;

function getAcpSessionMap(): Map<string, string> {
  if (!acpSessionMap) {
    acpSessionMap = new Map();
    try {
      if (existsSync(ACP_SESSION_MAP_PATH)) {
        const raw = JSON.parse(readFileSync(ACP_SESSION_MAP_PATH, "utf8")) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) acpSessionMap.set(k, v);
      }
    } catch {
      // Corrupt or unreadable map — start fresh; sessions fall back to session/new.
    }
  }
  return acpSessionMap;
}

function acpSessionMapSet(botSessionId: string, acpSessionId: string): void {
  getAcpSessionMap().set(botSessionId, acpSessionId);
  try {
    mkdirSync(path.dirname(ACP_SESSION_MAP_PATH), { recursive: true });
    writeFileSync(ACP_SESSION_MAP_PATH, JSON.stringify(Object.fromEntries(getAcpSessionMap()), null, 2));
  } catch (err) {
    console.warn("Failed to persist ACP session map:", err);
  }
}

function acpSessionMapDelete(botSessionId: string): void {
  if (!getAcpSessionMap().delete(botSessionId)) return;
  try {
    mkdirSync(path.dirname(ACP_SESSION_MAP_PATH), { recursive: true });
    writeFileSync(ACP_SESSION_MAP_PATH, JSON.stringify(Object.fromEntries(getAcpSessionMap()), null, 2));
  } catch (err) {
    console.warn("Failed to persist ACP session map:", err);
  }
}

/** Convert a Claude-style mcp.json ({ mcpServers: { name: def } }) into ACP mcpServers entries. */
function loadMcpServers(log: (...args: unknown[]) => void): AcpMcpServer[] {
  const p = CONFIG.mcpConfigPath;
  if (!p || !existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, unknown> };
    const servers: AcpMcpServer[] = [];
    for (const [name, defRaw] of Object.entries(raw.mcpServers ?? {})) {
      const def = defRaw as {
        command?: string;
        args?: string[];
        env?: Record<string, unknown>;
        type?: string;
        url?: string;
        headers?: Record<string, unknown>;
      };
      if (def.command) {
        servers.push({
          name,
          command: def.command,
          args: def.args ?? [],
          env: Object.entries(def.env ?? {}).map(([k, v]) => ({ name: k, value: String(v) })),
        });
      } else if (def.url) {
        servers.push({
          name,
          type: "http",
          url: def.url,
          headers: Object.entries(def.headers ?? {}).map(([k, v]) => ({ name: k, value: String(v) })),
        });
      } else {
        log(`MCP server "${name}" has neither command nor url — skipped`);
      }
    }
    return servers;
  } catch (err) {
    log(`Failed to parse MCP config ${p}:`, err);
    return [];
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function rpcErrorToError(err: JsonRpcError): Error & { code?: number } {
  const e = new Error(err.message) as Error & { code?: number };
  e.code = err.code;
  return e;
}

/** Extract human-readable output from a terminal tool_call_update. */
function extractToolOutput(info: AcpToolCallInfo): string {
  const parts: string[] = [];
  for (const c of info.content ?? []) {
    if (c.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") {
      parts.push(c.content.text);
    }
  }
  if (parts.length > 0) return parts.join("\n");
  if (info.rawOutput !== undefined) return safeJson(info.rawOutput);
  return "";
}

/** Array with a hard cap: items pushed beyond the cap are dropped via onOverflow. */
class BoundedQueue<T> extends Array<T> {
  constructor(
    private maxLength: number,
    private onOverflow: (item: T) => void
  ) {
    super();
  }

  override push(...items: T[]): number {
    for (const item of items) {
      if (this.length >= this.maxLength) {
        this.onOverflow(item);
        continue;
      }
      super.push(item);
    }
    return this.length;
  }
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PendingAcpPermission {
  rpcId: number | string;
  kind: "approval" | "question";
  options: AcpPermissionOption[];
}

export class KimiSession extends EventEmitter {
  threadId: string;
  sessionId: string;
  workDir: string;
  yolo: boolean;

  proc: ChildProcess | null = null;
  state: "dormant" | "active" | "busy" = "dormant";
  // Config options (model/thinking/mode) reported by session/new, refreshed by
  // config_option_update. Lives on the session object so it survives idle
  // respawns of the kimi process.
  configOptions: AcpConfigOption[] = [];
  // Slash commands and skills the session offers, from available_commands_update
  // (sent right after session/new). Surfaced via the /commands Discord command.
  availableCommands: AcpAvailableCommand[] = [];
  pendingRequests = new Map<string, PendingRequest>();
  idleTimer: NodeJS.Timeout | null = null;
  pendingQuestion: { wireRequestId: string } | null = null;

  questionAnswers = new Map<string, Map<string, string>>();
  questionOptions = new Map<string, Map<string, string[]>>();
  questionTexts = new Map<string, string[]>();
  questionRequestIds = new Map<string, string>();

  private onQueueOverflow = (entry: QueueEntry): void => {
    const msg = `Session queue is full (max ${MAX_QUEUED_PROMPTS}); message dropped. Wait for the current turn to finish.`;
    this.log(msg);
    entry.reject?.(new Error(msg));
    // Best-effort user notification through the normal Discord reply path.
    const ctx = entry.context as { reply?: (content: string) => Promise<unknown> } | undefined;
    ctx?.reply?.(`⚠️ ${msg}`).catch(() => {});
  };

  messageQueue: QueueEntry[] = new BoundedQueue<QueueEntry>(MAX_QUEUED_PROMPTS, this.onQueueOverflow);

  private nextRpcId = 1;
  private pendingRpc = new Map<number, PendingRpc>();
  private pendingAcpPermissions = new Map<string, PendingAcpPermission>();
  private acpSessionId: string | null = null;
  private mcpServers: AcpMcpServer[] = [];

  private pendingPrompt: { resolve: (value: PromptResult) => void; reject: (err: Error) => void } | null = null;
  private initializing = false;
  private initWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private tearingDown = false;
  private nonJsonLines = 0;

  // Turn state machine: exactly one prompt is in flight per session. After a
  // prompt finishes with a non-empty queue, the state stays "busy" and a
  // handoff slot is reserved for the dequeued turn, closing the dequeue →
  // runTurn race where a second sendPrompt could overwrite the pending
  // resolvers.
  private handoffPending = false;
  private handoffWaiter: QueueEntry | null = null;
  private currentTurnWaiter: QueueEntry | null = null;

  constructor(opts: {
    threadId: string;
    sessionId: string;
    workDir: string;
    yolo: boolean;
  }) {
    super();
    this.threadId = opts.threadId;
    this.sessionId = opts.sessionId;
    this.workDir = opts.workDir;
    this.yolo = opts.yolo;
  }

  private log(...args: unknown[]) {
    console.log(`[Session ${this.sessionId.slice(0, 8)}]`, ...args);
  }

  async ensureProcess(): Promise<void> {
    if (this.proc) return;
    if (this.initializing) {
      // Reject (not resolve) waiters if initialization fails.
      return new Promise((resolve, reject) => this.initWaiters.push({ resolve, reject }));
    }
    this.initializing = true;
    try {
      await this.spawnProcess();
      const waiters = this.initWaiters;
      this.initWaiters = [];
      waiters.forEach((w) => w.resolve());
    } catch (err) {
      const waiters = this.initWaiters;
      this.initWaiters = [];
      const e = err instanceof Error ? err : new Error(String(err));
      waiters.forEach((w) => w.reject(e));
      throw err;
    } finally {
      this.initializing = false;
    }
  }

  private async spawnProcess(): Promise<void> {
    mkdirSync(this.workDir, { recursive: true });
    this.mcpServers = loadMcpServers((...a) => this.log(...a));
    this.tearingDown = false;
    this.log("Spawning: kimi acp (cwd via session/new:", this.workDir + ")");
    const proc = spawn("kimi", ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    if (!proc.stdout || !proc.stdin || !proc.stderr) {
      this.proc = null;
      throw new Error("Failed to open stdio");
    }

    proc.on("error", (err) => this.handleProcessDeath(err));
    proc.on("exit", (code, signal) => {
      this.log("Process exited", code, signal);
      this.handleProcessDeath(new Error(`kimi acp exited (${code ?? signal ?? "unknown"})`));
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text) this.log("stderr:", text.slice(0, 500));
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    try {
      await this.handshake();
    } catch (err) {
      this.teardown();
      throw err;
    }
    this.state = "active";
    this.emit("stateChange", this.state);
    this.resetIdleTimer();
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("ACP initialize timeout"));
      }, INIT_TIMEOUT_MS);
      timer.unref();
      this.doHandshake().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
    });
  }

  private async doHandshake(): Promise<void> {
    const initResult = (await this.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "kimi-discord-bridge", version: "1.0.0" },
    })) as AcpInitializeResult;
    this.log(
      `ACP initialized: ${initResult.agentInfo?.name ?? "agent"} ${initResult.agentInfo?.version ?? "?"}`
    );

    // Resume the previous ACP session if we have one on record (no history
    // replay; session/load is intentionally not used on boot). Unknown or
    // expired sessions fall back to a fresh session/new.
    const knownAcpId = getAcpSessionMap().get(this.sessionId);
    let acpSessionId: string | null = null;
    if (knownAcpId) {
      try {
        const r = (await this.rpc("session/resume", {
          sessionId: knownAcpId,
          cwd: this.workDir,
          mcpServers: this.mcpServers,
        })) as AcpNewSessionResult;
        acpSessionId = r.sessionId ?? knownAcpId;
        if (r.configOptions) this.configOptions = r.configOptions;
      } catch (err) {
        if ((err as { code?: number }).code === ACP_ERROR_AUTH_REQUIRED) throw err;
        this.log("session/resume failed, starting a fresh session:", (err as Error).message);
      }
    }
    if (!acpSessionId) {
      const r = (await this.rpc("session/new", {
        cwd: this.workDir,
        mcpServers: this.mcpServers,
      })) as AcpNewSessionResult;
      acpSessionId = r.sessionId;
      if (r.configOptions) this.configOptions = r.configOptions;
      acpSessionMapSet(this.sessionId, acpSessionId);
    }
    this.acpSessionId = acpSessionId;

    if (this.yolo) {
      try {
        await this.rpc("session/set_config_option", {
          sessionId: acpSessionId,
          configId: "mode",
          value: "yolo",
        });
      } catch {
        try {
          await this.rpc("session/set_mode", { sessionId: acpSessionId, modeId: "yolo" });
        } catch (err) {
          this.log("Failed to enable yolo mode:", (err as Error).message);
        }
      }
    }
  }

  // ---- JSON-RPC plumbing ----

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error("kimi acp process is not running"));
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
      this.writeMessage({ jsonrpc: "2.0", id, method, params }, (err) => {
        if (err) {
          this.pendingRpc.delete(id);
          reject(err);
        }
      });
    });
  }

  private writeMessage(msg: AcpOutboundMessage, cb?: (err: Error | null) => void): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) {
      cb?.(new Error("kimi acp stdin is not writable"));
      return;
    }
    const line = JSON.stringify(msg);
    this.log("→", line.slice(0, 200));
    stdin.write(line + "\n", (err) => {
      if (err) this.log("stdin write failed:", err.message);
      cb?.(err ?? null);
    });
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let msg: AcpInboundMessage;
    try {
      msg = JSON.parse(line) as AcpInboundMessage;
    } catch {
      // kimi logs to stderr, so stdout noise should be rare — count and log
      // periodically instead of dropping silently.
      this.nonJsonLines++;
      if (this.nonJsonLines === 1 || this.nonJsonLines % 50 === 0) {
        this.log(`Non-JSON stdout line (#${this.nonJsonLines}):`, line.slice(0, 200));
      }
      return;
    }
    if (isAcpResponse(msg)) {
      this.handleResponse(msg);
    } else if (isAcpServerRequest(msg)) {
      this.handleServerRequest(msg);
    } else {
      this.handleNotification(msg);
    }
  }

  private handleResponse(msg: AcpResultResponse | AcpErrorResponse) {
    // Responses are matched strictly by JSON-RPC id.
    const pending = this.pendingRpc.get(Number(msg.id));
    if (!pending) {
      this.log("Response for unknown id:", msg.id);
      return;
    }
    this.pendingRpc.delete(Number(msg.id));
    if ("error" in msg) {
      pending.reject(rpcErrorToError(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(msg: { method: string; params?: unknown }) {
    if (msg.method !== "session/update") return;
    const params = msg.params as AcpSessionUpdateParams | undefined;
    if (!params || params.sessionId !== this.acpSessionId) return;
    this.translateSessionUpdate(params.update);
  }

  // ---- ACP → legacy wire event translation ----

  private emitWireEvent(type: string, payload: unknown) {
    this.emit("event", makeWireEvent(type, payload));
  }

  private translateSessionUpdate(update: AcpSessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as AcpContentBlock | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          this.emitWireEvent("ContentPart", { type: "text", text: content.text });
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as AcpContentBlock | undefined;
        if (typeof content?.text === "string") {
          this.emitWireEvent("ContentPart", { type: "think", think: content.text, encrypted: null });
        }
        break;
      }
      case "tool_call": {
        const info = update as unknown as AcpToolCallInfo;
        this.emitWireEvent("ToolCall", {
          type: "function",
          id: info.toolCallId,
          function: {
            name: info.title ?? "tool",
            arguments: info.rawInput !== undefined ? safeJson(info.rawInput) : "",
          },
        });
        break;
      }
      case "tool_call_update": {
        const info = update as unknown as AcpToolCallInfo;
        if (info.status === "completed" || info.status === "failed") {
          if (info.rawInput !== undefined) {
            // A fast-finishing call may jump straight to a terminal update
            // without ever announcing its arguments; surface them so the
            // renderer doesn't flush "(no arguments)".
            this.emitWireEvent("ToolCallPart", {
              tool_call_id: info.toolCallId,
              arguments_part: safeJson(info.rawInput),
            });
          }
          const output = extractToolOutput(info);
          this.emitWireEvent("ToolResult", {
            tool_call_id: info.toolCallId,
            result: output,
            return_value: { is_error: info.status === "failed", output },
          });
        } else if (info.rawInput !== undefined) {
          // Argument deltas for a call announced without full rawInput.
          this.emitWireEvent("ToolCallPart", { arguments_part: safeJson(info.rawInput) });
        }
        break;
      }
      case "config_option_update": {
        const opts = update.configOptions as AcpConfigOption[] | undefined;
        if (Array.isArray(opts)) this.configOptions = opts;
        break;
      }
      case "plan": {
        const raw = update.entries;
        if (!Array.isArray(raw)) break;
        // Tolerate missing/unknown fields — unknown statuses render as pending.
        const entries = raw.map((e) => {
          const entry = (e ?? {}) as { content?: unknown; status?: unknown; priority?: unknown };
          return {
            content: typeof entry.content === "string" ? entry.content : "",
            status: typeof entry.status === "string" ? entry.status : "pending",
            ...(typeof entry.priority === "string" ? { priority: entry.priority } : {}),
          };
        });
        this.emitWireEvent("PlanDisplay", { entries });
        break;
      }
      case "available_commands_update": {
        const raw = update.availableCommands;
        if (!Array.isArray(raw)) break;
        // Tolerate missing fields — render what kimi actually sent.
        this.availableCommands = raw.map((c) => {
          const cmd = (c ?? {}) as { name?: unknown; description?: unknown; input?: { hint?: unknown } };
          return {
            name: typeof cmd.name === "string" ? cmd.name : "?",
            ...(typeof cmd.description === "string" ? { description: cmd.description } : {}),
            ...(typeof cmd.input?.hint === "string" ? { input: { hint: cmd.input.hint } } : {}),
          };
        });
        break;
      }
      // user_message_chunk: nothing to surface to consumers.
      default:
        break;
    }
  }

  // ---- session/requestPermission → legacy request shapes ----

  private handleServerRequest(msg: AcpServerRequest) {
    // The ACP spec names this "session/requestPermission", but kimi-code
    // 0.29.2 emits the snake_case "session/request_permission". Accept both —
    // answering -32601 here makes kimi treat the request as user-rejected.
    if (msg.method !== "session/requestPermission" && msg.method !== "session/request_permission") {
      // Never leave the agent blocked on a request we don't understand.
      this.writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
      return;
    }

    const params = msg.params as AcpRequestPermissionParams;
    const toolCall = params.toolCall;
    const options = params.options ?? [];
    const wireRequestId = `acp-${String(msg.id)}`;

    if (toolCall.title === "AskUserQuestion") {
      const question =
        toolCall.content?.[0]?.content?.text ?? toolCall.title ?? "Question";
      const answerOptions = options.filter((o) => o.kind === "allow_once");
      this.pendingAcpPermissions.set(wireRequestId, { rpcId: msg.id, kind: "question", options });
      if (answerOptions.length === 0) {
        // Open-ended question. ACP cannot carry free text back, but keep the
        // legacy pendingQuestion semantics so a chat reply unblocks the agent.
        this.pendingQuestion = { wireRequestId };
      }
      // kimi degrades multi-question/multi-select to a single single-select
      // question over ACP — emit the existing single-select shape.
      const payload: QuestionRequestPayload = {
        id: wireRequestId,
        tool_call_id: toolCall.toolCallId,
        questions: [
          {
            question,
            options: answerOptions.map((o) => ({ label: o.name })),
            multi_select: false,
          },
        ],
      };
      this.emit("request", { wireRequestId, type: "QuestionRequest", payload });
      return;
    }

    this.pendingAcpPermissions.set(wireRequestId, { rpcId: msg.id, kind: "approval", options });
    const rawInput = toolCall.rawInput as Record<string, unknown> | undefined;
    const payload: ApprovalRequestPayload = {
      action: toolCall.title ?? "Unknown action",
      description: toolCall.kind,
      command: rawInput?.command ?? toolCall.rawInput,
      options: options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
    };
    this.emit("request", { wireRequestId, type: "ApprovalRequest", payload });
  }

  private respondPermission(rpcId: number | string, outcome: unknown) {
    this.writeMessage({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  /** Map a consumer's generic response to the ACP optionId stored for this request. */
  private pickOptionId(permission: PendingAcpPermission, response: string): string | null {
    const { options, kind } = permission;
    const byKind = (k: string) => options.find((o) => o.kind === k)?.optionId;
    const r = response.toLowerCase();
    if (kind === "question") {
      // A typed reply that matches an option label selects it; anything else
      // maps to Skip (reject_once) since free text cannot cross ACP.
      const match = options.find((o) => o.kind === "allow_once" && o.name === response);
      return match?.optionId ?? byKind("reject_once") ?? null;
    }
    if (r === "approve" || r === "allow") return byKind("allow_once") ?? null;
    if (r === "approve_always" || r === "allow_always" || r === "approve_for_session" || r === "always") {
      return byKind("allow_always") ?? byKind("allow_once") ?? null;
    }
    // "opt<N>" selects the option by index — approval buttons key on index
    // because optionIds may contain characters Discord customIds can't hold.
    if (r.startsWith("opt")) {
      const opt = options[Number(r.slice(3))];
      return opt?.optionId ?? null;
    }
    // "deny" and anything unexpected: reject once if possible.
    return byKind("reject_once") ?? null;
  }

  /** Respond cancelled to every pending permission request so kimi never blocks. */
  private cancelPendingPermissions() {
    for (const [, p] of this.pendingAcpPermissions) {
      this.respondPermission(p.rpcId, { outcome: "cancelled" });
    }
    this.pendingAcpPermissions.clear();
  }

  // ---- Public API (frozen contract) ----

  getConfigOption(id: string): AcpConfigOption | undefined {
    return this.configOptions.find((o) => o.id === id);
  }

  /** Change a kimi config option (model/thinking/mode). Does not start a turn. */
  async setConfigOption(configId: string, value: string): Promise<void> {
    await this.ensureProcess();
    if (!this.acpSessionId) {
      throw new Error("kimi acp session is not initialized");
    }
    const result = (await this.rpc("session/set_config_option", {
      sessionId: this.acpSessionId,
      configId,
      value,
    })) as { configOptions?: AcpConfigOption[] };
    if (Array.isArray(result?.configOptions)) this.configOptions = result.configOptions;
  }

  /**
   * Drop the ACP session: tear down the process (rejecting any queued or
   * pending work) and forget the persisted mapping, so the next prompt starts
   * a fresh session/new instead of session/resume. The bot session row and
   * SessionManager entry stay intact.
   */
  async resetContext(): Promise<void> {
    this.teardown();
    acpSessionMapDelete(this.sessionId);
  }

  async sendPrompt(text: string, context?: unknown, extraBlocks?: AcpPromptContentBlock[]): Promise<PromptResult> {
    if (this.state === "busy" && !this.handoffPending) {
      return this.enqueuePrompt(text, context, extraBlocks);
    }
    // Idle, or the dequeued turn claiming its reserved handoff slot.
    this.handoffPending = false;
    this.currentTurnWaiter = this.handoffWaiter;
    this.handoffWaiter = null;
    this.state = "busy";
    this.emit("stateChange", this.state);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    await this.ensureProcess();

    const acpSessionId = this.acpSessionId;
    if (!acpSessionId) {
      throw new Error("kimi acp session is not initialized");
    }

    // No ACP equivalent of StepBegin — synthesize one per prompt so the
    // status embed keeps working. StatusUpdate (context usage) has no ACP
    // equivalent either and is simply not emitted; consumers tolerate that.
    this.emitWireEvent("StepBegin", { n: 1 });

    const id = this.nextRpcId++;
    return new Promise<PromptResult>((resolve, reject) => {
      this.pendingPrompt = { resolve, reject };
      this.pendingRpc.set(id, {
        resolve: (result) => this.onPromptFinished(result as AcpPromptResult),
        reject: (err) => this.onPromptError(err),
      });
      this.writeMessage(
        {
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId: acpSessionId, prompt: [{ type: "text", text }, ...(extraBlocks ?? [])] },
        },
        (err) => {
          if (err) {
            // A failed stdin write must not strand the pending prompt.
            this.pendingRpc.delete(id);
            this.onPromptError(err);
          }
        }
      );
    });
  }

  private enqueuePrompt(text: string, context?: unknown, extraBlocks?: AcpPromptContentBlock[]): Promise<PromptResult> {
    // Queued while busy; the promise settles when the queued prompt eventually
    // runs (or rejects on teardown), instead of never settling.
    return new Promise<PromptResult>((resolve, reject) => {
      this.messageQueue.push({ text, context, extraBlocks, resolve, reject });
    });
  }

  sendSteer(_text: string): void {
    // ACP has no mid-turn steer method. Kept as a no-op for source
    // compatibility; busy-queueing in the mode handlers replaces it.
  }

  resolveRequest(wireRequestId: string, response: string): void {
    const pending = this.pendingRequests.get(wireRequestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(wireRequestId);
    }
    if (this.pendingQuestion?.wireRequestId === wireRequestId) {
      this.pendingQuestion = null;
    }

    const acp = this.pendingAcpPermissions.get(wireRequestId);
    if (acp) {
      this.pendingAcpPermissions.delete(wireRequestId);
      const optionId = this.pickOptionId(acp, response);
      if (optionId) {
        this.respondPermission(acp.rpcId, { outcome: "selected", optionId });
      } else {
        this.respondPermission(acp.rpcId, { outcome: "cancelled" });
      }
    }
    // Resolve the consumer-side waiter even when there is no ACP side (e.g.
    // /test commands with synthetic request ids).
    pending?.resolve(response);
  }

  resolveQuestionRequest(wireRequestId: string, _requestId: string, answers: Record<string, string>): void {
    const pending = this.pendingRequests.get(wireRequestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(wireRequestId);
    }
    if (this.pendingQuestion?.wireRequestId === wireRequestId) {
      this.pendingQuestion = null;
    }

    const acp = this.pendingAcpPermissions.get(wireRequestId);
    if (acp) {
      this.pendingAcpPermissions.delete(wireRequestId);
      const label = Object.values(answers).find((v) => v.length > 0);
      const optionId = label
        ? acp.options.find((o) => o.kind === "allow_once" && o.name === label)?.optionId ??
          acp.options.find((o) => o.kind === "reject_once")?.optionId ??
          null
        : acp.options.find((o) => o.kind === "reject_once")?.optionId ?? null;
      if (optionId) {
        this.respondPermission(acp.rpcId, { outcome: "selected", optionId });
      } else {
        this.respondPermission(acp.rpcId, { outcome: "cancelled" });
      }
    }
    pending?.resolve(JSON.stringify(answers));
  }

  registerPendingRequest(
    wireRequestId: string,
    type: WireRequestType,
    timeoutMs = 120000
  ): Promise<string> {
    return new Promise((resolve) => {
      const existing = this.pendingRequests.get(wireRequestId);
      if (existing) {
        // Duplicate registration: settle the old waiter instead of leaking it.
        clearTimeout(existing.timeout);
        existing.resolve("__superseded__");
      }
      const timeout = setTimeout(() => {
        // Delete on timeout so timed-out entries don't leak in the map.
        this.pendingRequests.delete(wireRequestId);
        resolve("__timeout__");
      }, timeoutMs);
      timeout.unref();
      this.pendingRequests.set(wireRequestId, { wireRequestId, type, resolve, timeout });
    });
  }

  cancel(): Promise<void> {
    if (this.state !== "busy" || !this.acpSessionId) return Promise.resolve();
    // session/cancel is a notification; the pending prompt resolves with
    // stopReason "cancelled".
    this.writeMessage({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: this.acpSessionId },
    });
    return Promise.resolve();
  }

  resolveQuestion(text: string): boolean {
    if (!this.pendingQuestion) return false;
    this.resolveRequest(this.pendingQuestion.wireRequestId, text);
    return true;
  }

  clearQuestionState(wireRequestId?: string): void {
    if (wireRequestId) {
      this.questionAnswers.delete(wireRequestId);
      this.questionOptions.delete(wireRequestId);
      this.questionTexts.delete(wireRequestId);
      this.questionRequestIds.delete(wireRequestId);
    } else {
      this.questionAnswers.clear();
      this.questionOptions.clear();
      this.questionTexts.clear();
      this.questionRequestIds.clear();
    }
  }

  /**
   * Called by runTurn when a dequeued turn failed before dispatching its
   * prompt, so the reserved handoff slot doesn't deadlock the session.
   */
  releaseHandoff(): void {
    if (!this.handoffPending) return;
    this.handoffPending = false;
    const waiter = this.handoffWaiter;
    this.handoffWaiter = null;
    waiter?.reject?.(new Error("Queued turn failed before it could be sent"));
    this.finishTurn();
  }

  teardown(): void {
    this.tearingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.failAll(new Error("Session torn down"));
    const proc = this.proc;
    this.proc = null;
    this.acpSessionId = null;
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      // proc.killed only means the signal was sent — keep a real ref, listen
      // for exit, and escalate to SIGKILL after a grace period.
      let exited = false;
      proc.once("exit", () => {
        exited = true;
      });
      const killTimer = setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
      killTimer.unref();
    }
    this.state = "dormant";
    this.emit("stateChange", this.state);
  }

  destroy(): void {
    this.teardown();
    this.emit("destroy");
    this.removeAllListeners();
  }

  // ---- Internals ----

  private onPromptFinished(result: AcpPromptResult | undefined) {
    const stopReason = result?.stopReason ?? "end_turn";
    // ACP collapses the legacy "max_steps_reached" into "end_turn" (and other
    // stop reasons); only an explicit cancel maps back to "cancelled".
    const status: PromptResult["status"] = stopReason === "cancelled" ? "cancelled" : "finished";
    this.emitWireEvent("TurnEnd", {});
    // Defensive: a permission request should never outlive its prompt.
    this.cancelPendingPermissions();
    updateLastActive(this.threadId, Date.now());
    const pending = this.pendingPrompt;
    this.pendingPrompt = null;
    const waiter = this.currentTurnWaiter;
    this.currentTurnWaiter = null;
    pending?.resolve({ status });
    waiter?.resolve?.({ status });
    this.finishTurn();
  }

  private onPromptError(err: Error) {
    this.cancelPendingPermissions();
    const pending = this.pendingPrompt;
    this.pendingPrompt = null;
    const waiter = this.currentTurnWaiter;
    this.currentTurnWaiter = null;
    pending?.reject(err);
    waiter?.reject?.(err);
    this.finishTurn();
  }

  private finishTurn() {
    if (this.tearingDown || !this.proc) {
      // No process to run a next turn on — reject queued waiters.
      this.drainQueue(new Error("Session is no longer running"));
      this.state = "dormant";
      this.emit("stateChange", this.state);
      return;
    }
    const next = this.messageQueue.shift();
    if (next) {
      // Reserve the busy slot across the dequeue → runTurn handoff.
      this.handoffPending = true;
      this.handoffWaiter = next;
      this.emit("dequeue", { text: next.text, context: next.context, extraBlocks: next.extraBlocks });
    } else {
      this.state = "active";
      this.emit("stateChange", this.state);
      this.resetIdleTimer();
    }
  }

  private drainQueue(err: Error) {
    let entry: QueueEntry | undefined;
    while ((entry = this.messageQueue.shift()) !== undefined) {
      entry.reject?.(err);
    }
  }

  private failAll(err: Error) {
    for (const [, p] of this.pendingRpc) {
      p.reject(err);
    }
    this.pendingRpc.clear();
    // Belt and braces: the prompt is normally settled through its pendingRpc
    // entry above; settle directly if it was registered without one.
    if (this.pendingPrompt) {
      const p = this.pendingPrompt;
      this.pendingPrompt = null;
      p.reject(err);
    }
    const cw = this.currentTurnWaiter;
    this.currentTurnWaiter = null;
    cw?.reject?.(err);
    const hw = this.handoffWaiter;
    this.handoffWaiter = null;
    this.handoffPending = false;
    hw?.reject?.(err);
    this.drainQueue(err);
    for (const p of this.pendingRequests.values()) {
      clearTimeout(p.timeout);
      p.resolve("__teardown__");
    }
    this.pendingRequests.clear();
    this.cancelPendingPermissions();
    this.pendingQuestion = null;
    this.clearQuestionState();
  }

  private handleProcessDeath(err: Error) {
    if (!this.proc) return; // already handled (e.g. teardown)
    this.log("Process death:", err.message);
    const wasTearingDown = this.tearingDown;
    // Null the proc first so finishTurn() (reached via the rejections below)
    // drains the queue instead of dispatching onto a dead process.
    this.proc = null;
    this.acpSessionId = null;
    if (!wasTearingDown) {
      this.emit("crashed", err);
    }
    this.failAll(err);
    this.state = "dormant";
    this.emit("stateChange", this.state);
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log("Idle timeout reached, tearing down");
      this.teardown();
      this.emit("dormant");
    }, CONFIG.sessionIdleTimeoutMs);
    this.idleTimer.unref();
  }
}

class SessionManagerClass {
  private map = new Map<string, KimiSession>();

  get(threadId: string): KimiSession | undefined {
    return this.map.get(threadId);
  }

  getOrCreate(
    threadId: string,
    sessionId: string,
    workDir: string,
    yolo: boolean
  ): KimiSession {
    let s = this.map.get(threadId);
    if (s && (s.sessionId !== sessionId || s.workDir !== workDir || s.yolo !== yolo)) {
      // Stale session: parameters changed, recreate instead of reusing.
      s.destroy();
      this.map.delete(threadId);
      s = undefined;
    }
    if (!s) {
      s = new KimiSession({ threadId, sessionId, workDir, yolo });
      this.map.set(threadId, s);
    }
    return s;
  }

  destroy(threadId: string): void {
    const s = this.map.get(threadId);
    if (s) {
      s.destroy();
      this.map.delete(threadId);
    }
  }

  destroyAll(): void {
    for (const s of this.map.values()) {
      s.destroy();
    }
    this.map.clear();
  }

  all(): KimiSession[] {
    return Array.from(this.map.values());
  }
}

export const SessionManager = new SessionManagerClass();
