import { EventEmitter } from "node:events";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import {
  WireOutbound,
  WireInbound,
  WireEventMessage,
  WireRequestMessage,
  isWireEvent,
  isWireRequest,
  isWirePromptResult,
} from "./wire.js";
import { CONFIG } from "./config.js";
import { updateLastActive } from "./db.js";

export interface PendingRequest {
  wireRequestId: string;
  type: "ApprovalRequest" | "QuestionRequest" | "ToolCallRequest";
  resolve: (value: string) => void;
  timeout: NodeJS.Timeout;
}

export interface PromptResult {
  status: "finished" | "cancelled" | "max_steps_reached";
}

export class KimiSession extends EventEmitter {
  threadId: string;
  sessionId: string;
  workDir: string;
  yolo: boolean;

  proc: ChildProcess | null = null;
  state: "dormant" | "active" | "busy" = "dormant";
  pendingRequests = new Map<string, PendingRequest>();
  messageQueue: Array<{ text: string; context?: unknown }> = [];
  idleTimer: NodeJS.Timeout | null = null;

  private pendingPromptResolve: ((value: PromptResult) => void) | null = null;
  private pendingPromptReject: ((err: Error) => void) | null = null;
  private initializing = false;
  private initWaiters: Array<() => void> = [];
  pendingQuestion: { wireRequestId: string } | null = null;

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
    if (this.state !== "dormant") return;
    if (this.initializing) {
      return new Promise((resolve) => this.initWaiters.push(resolve));
    }
    this.initializing = true;
    try {
      await this.spawnProcess();
    } finally {
      this.initializing = false;
      const waiters = this.initWaiters;
      this.initWaiters = [];
      waiters.forEach((r) => r());
    }
  }

  private spawnProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      mkdirSync(this.workDir, { recursive: true });
      const args = ["--wire", "--session", this.sessionId, "-w", this.workDir];
      if (this.yolo) args.push("--yolo");
      if (existsSync("/app/data/mcp.json")) {
        args.push("--mcp-config-file", "/app/data/mcp.json");
      }
      this.log("Spawning kimi", args.join(" "));
      this.proc = spawn("kimi", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!this.proc.stdout || !this.proc.stdin || !this.proc.stderr) {
        return reject(new Error("Failed to open stdio"));
      }

      this.proc.on("error", (err) => {
        this.log("Process error:", err);
        this.emit("crashed", err);
        this.teardown();
      });

      this.proc.on("exit", (code, signal) => {
        this.log("Process exited", code, signal);
        if (this.state !== "dormant") {
          this.emit("crashed", new Error(`Exited ${code ?? signal}`));
          this.teardown();
        }
      });

      this.proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.log("stderr:", text);
      });

      const rl = createInterface({ input: this.proc.stdout });
      rl.on("line", (line) => {
        this.log("stdout line:", line.slice(0, 200));
        this.handleLine(line);
      });

      const init: WireOutbound = {
        jsonrpc: "2.0",
        method: "initialize",
        id: randomUUID(),
        params: {
          protocol_version: "1.9",
          client: { name: "kimi-discord-bridge", version: "1.0.0" },
          capabilities: { supports_question: true },
        },
      };

      const onInit = (msg: WireInbound) => {
        if ("id" in msg && msg.id === init.id) {
          if ("result" in msg) {
            this.state = "active";
            this.emit("stateChange", this.state);
            resolve();
          } else if ("error" in msg && msg.error) {
            const errMsg =
              typeof msg.error === "object" && "message" in msg.error
                ? String(msg.error.message)
                : String(msg.error);
            const errCode =
              typeof msg.error === "object" && "code" in msg.error
                ? Number(msg.error.code)
                : undefined;
            const e = new Error(errMsg) as Error & { code?: number };
            e.code = errCode;
            reject(e);
          } else {
            return false;
          }
          return true;
        }
        return false;
      };

      let resolved = false;
      const handler = (msg: WireInbound) => {
        if (resolved) return;
        if (onInit(msg)) {
          resolved = true;
          this.off("wire", handler);
        }
      };
      this.on("wire", handler);

      // Timeout initialization
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.off("wire", handler);
          this.log("Initialize timeout reached, tearing down");
          this.teardown();
          reject(new Error("Initialize timeout"));
        }
      }, 15000);
      this.log("Sending initialize", init.id);

      this.write(init);
    });
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as WireInbound;
      this.emit("wire", msg);
      this.processMessage(msg);
    } catch (e) {
      this.log("Wire JSON parse error:", e);
    }
  }

  private processMessage(msg: WireInbound) {
    if ("error" in msg && msg.error) {
      this.state = "active";
      this.emit("stateChange", this.state);
      this.resetIdleTimer();
      const errMsg = typeof msg.error === "object" && "message" in msg.error ? String(msg.error.message) : String(msg.error);
      const errCode = typeof msg.error === "object" && "code" in msg.error ? Number(msg.error.code) : undefined;
      if (this.pendingPromptReject) {
        const e = new Error(errMsg);
        (e as Error & { code?: number }).code = errCode;
        this.pendingPromptReject(e);
        this.pendingPromptResolve = null;
        this.pendingPromptReject = null;
      }
      this.dequeue();
      return;
    }

    if (isWirePromptResult(msg)) {
      this.state = "active";
      this.emit("stateChange", this.state);
      this.resetIdleTimer();
      updateLastActive(this.threadId, Date.now());
      if (this.pendingPromptResolve) {
        this.pendingPromptResolve(msg.result);
        this.pendingPromptResolve = null;
        this.pendingPromptReject = null;
      }
      this.dequeue();
      return;
    }

    if (isWireEvent(msg)) {
      this.emit("event", msg);
      if (msg.params.type === "TurnEnd") {
        // Will be handled by prompt result arrival; idle timer reset there.
      }
      return;
    }

    if (isWireRequest(msg)) {
      const wireRequestId = msg.id;
      const type = msg.params.type;
      if (type === "QuestionRequest") {
        const p = msg.params.payload as { suggestions?: string[] };
        if (!p.suggestions || p.suggestions.length === 0) {
          this.pendingQuestion = { wireRequestId };
        }
      }
      this.emit("request", { wireRequestId, type, payload: msg.params.payload } as {
        wireRequestId: string;
        type: "ApprovalRequest" | "QuestionRequest" | "ToolCallRequest";
        payload: unknown;
      });
      return;
    }
  }

  private write(msg: WireOutbound) {
    if (!this.proc?.stdin) {
      this.log("Write failed: no stdin available");
      return;
    }
    const line = JSON.stringify(msg);
    this.log("Writing to stdin:", line.slice(0, 200));
    this.proc.stdin.write(line + "\n");
  }

  async sendPrompt(text: string, context?: unknown): Promise<PromptResult> {
    await this.ensureProcess();
    if (this.state === "busy") {
      this.messageQueue.push({ text, context });
      return new Promise(() => {}); // Will never resolve; queued instead
    }
    this.state = "busy";
    this.emit("stateChange", this.state);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const req: WireOutbound = {
      jsonrpc: "2.0",
      method: "prompt",
      id: randomUUID(),
      params: { user_input: text },
    };

    return new Promise((resolve, reject) => {
      this.pendingPromptResolve = resolve;
      this.pendingPromptReject = reject;
      this.write(req);
    });
  }

  sendSteer(text: string): void {
    if (this.state !== "busy") return;
    const req: WireOutbound = {
      jsonrpc: "2.0",
      method: "steer",
      id: randomUUID(),
      params: { user_input: text },
    };
    this.write(req);
  }

  resolveRequest(wireRequestId: string, response: string): void {
    const pending = this.pendingRequests.get(wireRequestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(wireRequestId);
    if (this.pendingQuestion?.wireRequestId === wireRequestId) {
      this.pendingQuestion = null;
    }

    // Use the original wireRequestId as the JSON-RPC response id
    // per standard JSON-RPC semantics; request_id inside result is kept for compatibility
    const msg: WireOutbound = {
      jsonrpc: "2.0",
      id: wireRequestId,
      result: { request_id: wireRequestId, response },
    };
    this.write(msg);
    pending.resolve(response);
  }

  registerPendingRequest(
    wireRequestId: string,
    type: "ApprovalRequest" | "QuestionRequest" | "ToolCallRequest",
    timeoutMs = 120000
  ): Promise<string> {
    return new Promise((resolve) => {
      if (this.pendingRequests.has(wireRequestId)) {
        clearTimeout(this.pendingRequests.get(wireRequestId)!.timeout);
      }
      const timeout = setTimeout(() => {
        resolve("__timeout__");
      }, timeoutMs);
      this.pendingRequests.set(wireRequestId, { wireRequestId, type, resolve, timeout });
    });
  }

  cancel(): Promise<void> {
    if (this.state !== "busy") return Promise.resolve();
    const req: WireOutbound = {
      jsonrpc: "2.0",
      method: "cancel",
      id: randomUUID(),
    };
    this.write(req);
    return Promise.resolve();
  }

  resolveQuestion(text: string): boolean {
    if (!this.pendingQuestion) return false;
    this.resolveRequest(this.pendingQuestion.wireRequestId, text);
    return true;
  }

  teardown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const p of this.pendingRequests.values()) {
      clearTimeout(p.timeout);
      p.resolve("__teardown__");
    }
    this.pendingRequests.clear();
    this.pendingQuestion = null;
    this.messageQueue = [];
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      }, 5000);
    }
    this.proc = null;
    this.state = "dormant";
    this.emit("stateChange", this.state);
    if (this.pendingPromptReject) {
      this.pendingPromptReject(new Error("Session torn down"));
      this.pendingPromptResolve = null;
      this.pendingPromptReject = null;
    }
  }

  destroy(): void {
    this.teardown();
    this.emit("destroy");
    this.removeAllListeners();
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log("Idle timeout reached, tearing down");
      this.teardown();
      this.emit("dormant");
    }, CONFIG.sessionIdleTimeoutMs);
  }

  private dequeue() {
    if (this.messageQueue.length === 0) return;
    const next = this.messageQueue.shift();
    if (next) {
      this.emit("dequeue", next);
    }
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

  all(): KimiSession[] {
    return Array.from(this.map.values());
  }
}

export const SessionManager = new SessionManagerClass();
