export interface Env {
  DB: D1Database;
  USER_AGENT_DO: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_URL: string;
  /** Optional test service binding — when present, used as the fetch impl for AI gateway calls. */
  MOCK_GATEWAY?: { fetch: typeof fetch };
}

export interface RuntimeDeps {
  db: D1Database;
  ai: AIGatewayClient;
  tools: ToolRegistry;
  clock: () => number;
}

export interface TurnInput {
  userId: string;
  threadId: string;
  actor: 'user' | 'system';
  message?: string;
  systemHint?: string;
  stream: SseWriter | null;
  signal: AbortSignal;
  idempotencyKey?: string;
  turnId?: string;  // optional pre-allocated id; runTurn generates one if absent
}

export interface TurnResult {
  turnId: string;
  status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked' | 'cap_exceeded';
  text: string;
  costUsd: number;
}

export type SseEvent =
  | { type: 'turn_started';     data: { turn_id: string; ordinal: number } }
  | { type: 'text_delta';       data: { chunk: string } }
  | { type: 'tool_call_start';  data: { call_index: number; tool: string; input: unknown } }
  | { type: 'tool_call_result'; data: { call_index: number; summary: string } }
  | { type: 'corrigendum';      data: { text: string } }
  | { type: 'turn_complete';    data: { turn_id: string; full_text: string; cost_usd: number } }
  | { type: 'error';            data: { message: string; retryable: boolean } };

export interface SseWriter {
  emit(event: SseEvent): void;
  close(): void;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  surface: 'visible' | 'hidden';
  idempotent: boolean;
  handler(input: I, ctx: ToolCtx): Promise<O>;
}

export interface ToolCtx {
  userId: string;
  threadId: string;
  turnId: string;
  toolCallIndex: number;
  deps: RuntimeDeps;
  emit(event: SseEvent): void;
  signal: AbortSignal;
}

export type ToolRegistry = ReadonlyMap<string, ToolDef>;

export interface AIGatewayClient {
  streamMessage(req: StreamMessageRequest): AsyncIterable<AnthropicStreamEvent>;
  call(req: NonStreamMessageRequest): Promise<NonStreamMessageResult>;
}

export interface StreamMessageRequest {
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface NonStreamMessageRequest {
  model: 'claude-opus-4-7' | 'claude-haiku-4-5-20251001';
  system: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface NonStreamMessageResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicStreamEvent =
  | { type: 'message_start';        usage: { input_tokens: number } }
  | { type: 'content_block_start';  index: number; block: { type: 'text' } | { type: 'tool_use'; id: string; name: string } }
  | { type: 'content_block_delta';  index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop';   index: number }
  | { type: 'message_delta';        stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'; usage: { output_tokens: number } }
  | { type: 'message_stop' };
