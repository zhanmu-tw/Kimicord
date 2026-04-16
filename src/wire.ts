export interface WireInitializeRequest {
  jsonrpc: "2.0";
  method: "initialize";
  id: string;
  params: {
    protocol_version: string;
    client: { name: string; version: string };
    capabilities: { supports_question: boolean };
  };
}

export interface WirePromptRequest {
  jsonrpc: "2.0";
  method: "prompt";
  id: string;
  params: { user_input: string };
}

export interface WireSteerRequest {
  jsonrpc: "2.0";
  method: "steer";
  id: string;
  params: { user_input: string };
}

export interface WireCancelRequest {
  jsonrpc: "2.0";
  method: "cancel";
  id: string;
}

export interface WireResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    request_id: string;
    response?: string;
    answers?: Record<string, string>;
  };
}

export type WireOutbound =
  | WireInitializeRequest
  | WirePromptRequest
  | WireSteerRequest
  | WireCancelRequest
  | WireResponse;

export interface WirePromptResult {
  jsonrpc: "2.0";
  id: string;
  result: {
    status: "finished" | "cancelled" | "max_steps_reached";
  };
}

export interface WireEventMessage {
  jsonrpc: "2.0";
  method: "event";
  params: {
    type: string;
    payload: unknown;
  };
}

export interface WireRequestMessage {
  jsonrpc: "2.0";
  method: "request";
  id: string;
  params: {
    type: "ApprovalRequest" | "QuestionRequest" | "ToolCallRequest" | "HookRequest";
    payload: unknown;
  };
}

export type WireInbound = WirePromptResult | WireEventMessage | WireRequestMessage;

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
  // Real shape from kimi-cli v1.34.0
  type: "function";
  id: string;
  function: {
    name: string;
    arguments: string;
  };
  extras?: unknown;
}

export interface ToolCallPartPayload {
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

export function isWireEvent(msg: WireInbound): msg is WireEventMessage {
  return "method" in msg && msg.method === "event";
}

export function isWireRequest(msg: WireInbound): msg is WireRequestMessage {
  return "method" in msg && msg.method === "request";
}

export function isWirePromptResult(msg: WireInbound): msg is WirePromptResult {
  return "result" in msg && !("method" in msg);
}
