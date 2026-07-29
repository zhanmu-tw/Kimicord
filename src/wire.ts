// ---------------------------------------------------------------------------
// Frozen event/request payload shapes consumed by renderer.ts, turn.ts,
// approvals.ts and bot.ts. These intentionally keep the legacy "wire" names —
// session.ts translates ACP (Agent Client Protocol) traffic from `kimi acp`
// into these shapes so consumers stay unchanged.
// ---------------------------------------------------------------------------

export interface WireEventMessage {
  jsonrpc: "2.0";
  method: "event";
  params: {
    type: string;
    payload: unknown;
  };
}

export type WireRequestType = "ApprovalRequest" | "QuestionRequest" | "ToolCallRequest";

export interface ContentPartTextPayload {
  type: "text";
  text: string;
}

export interface ContentPartThinkPayload {
  type: "think";
  think: string;
  encrypted: boolean | null;
}

export interface ToolCallPayload {
  // Legacy shape (from kimi-cli wire mode) that the renderer consumes.
  type: "function";
  id: string;
  function: {
    name: string;
    arguments: string;
  };
  extras?: unknown;
}

export interface ToolCallPartPayload {
  /** Set when the part targets a known call (e.g. rawInput from a terminal ACP update). */
  tool_call_id?: string;
  arguments_part: string;
}

export interface ToolResultPayload {
  tool_call_id?: string;
  id?: string;
  result?: string;
  elapsed_seconds?: number;
  return_value?: {
    is_error: boolean;
    output: string;
  };
}

export interface StepBeginPayload {
  n: number;
}

export interface TurnBeginPayload {
  user_input: string;
}

export interface TurnEndPayload {
  // empty
}

export interface PlanDisplayPayload {
  entries: { content: string; status: string; priority?: string }[];
}

export interface StatusUpdatePayload {
  context_usage: number;
  context_tokens: number;
  max_context_tokens: number;
  token_usage?: {
    input_other?: number;
    output?: number;
    input_cache_read?: number;
    input_cache_creation?: number;
  };
  message_id?: string;
  plan_mode?: boolean;
  mcp_status?: unknown;
}

export interface ApprovalRequestPayload {
  action: string;
  description?: string;
  command?: unknown;
  options?: { id: string; label: string; kind?: string }[];
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multi_select?: boolean;
}

export interface QuestionRequestPayload {
  id: string;
  tool_call_id: string;
  questions: QuestionItem[];
}

export function makeWireEvent(type: string, payload: unknown): WireEventMessage {
  return { jsonrpc: "2.0", method: "event", params: { type, payload } };
}

// ---------------------------------------------------------------------------
// ACP (Agent Client Protocol) — `kimi acp`, JSON-RPC 2.0 as NDJSON over stdio.
// Hand-rolled client types; only the subset of the protocol the bridge uses.
// ---------------------------------------------------------------------------

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** kimi reports missing authentication as a server error with this code. */
export const ACP_ERROR_AUTH_REQUIRED = -32000;

export interface AcpRequestMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface AcpNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface AcpResultResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface AcpErrorResponse {
  jsonrpc: "2.0";
  id: number | string;
  error: JsonRpcError;
}

/** Agent → client request (expects a response), e.g. session/requestPermission. */
export interface AcpServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export type AcpInboundMessage =
  | AcpResultResponse
  | AcpErrorResponse
  | AcpServerRequest
  | AcpNotificationMessage;

export type AcpOutboundMessage =
  | AcpRequestMessage
  | AcpNotificationMessage
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string; error: JsonRpcError };

export function isAcpResponse(msg: AcpInboundMessage): msg is AcpResultResponse | AcpErrorResponse {
  return "id" in msg && !("method" in msg);
}

export function isAcpServerRequest(msg: AcpInboundMessage): msg is AcpServerRequest {
  return "method" in msg && "id" in msg;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: { loadSession?: boolean };
  authMethods?: unknown[];
  agentInfo?: { name?: string; version?: string };
}

export interface AcpConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
}

/** A select-type setting the agent exposes (e.g. model, thinking, mode). */
export interface AcpConfigOption {
  type: string;
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: AcpConfigOptionChoice[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptResult {
  stopReason?: string;
}

export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Content blocks accepted in a session/prompt payload (subset of ACP). */
export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface AcpToolCallContent {
  type: string;
  content?: AcpContentBlock;
  [key: string]: unknown;
}

/** Fields of tool_call / tool_call_update session updates (and requestPermission's toolCall). */
export interface AcpToolCallInfo {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: AcpToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
  [key: string]: unknown;
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: string; // "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallInfo;
  options: AcpPermissionOption[];
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { name: string; type: "http"; url: string; headers: Array<{ name: string; value: string }> };
