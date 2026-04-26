export interface InsertStreamingInput {
  db: D1Database;
  turnId: string;
  threadId: string;
  actor: 'user' | 'system' | 'assistant';
  userText: string | null;
  idempotencyKey?: string;
  now: number;
}

export interface InsertStreamingResult {
  turnId: string;
  ordinal: number;
  replay: boolean;
}

export async function insertChatTurnStreaming(input: InsertStreamingInput): Promise<InsertStreamingResult> {
  if (input.idempotencyKey) {
    const existing = await input.db.prepare(
      `SELECT turn_id, ordinal FROM chat_turns WHERE thread_id = ? AND idempotency_key = ?`
    ).bind(input.threadId, input.idempotencyKey).first<{ turn_id: string; ordinal: number }>();
    if (existing) {
      return { turnId: existing.turn_id, ordinal: existing.ordinal, replay: true };
    }
  }

  const next = await input.db.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM chat_turns WHERE thread_id = ?`
  ).bind(input.threadId).first<{ ordinal: number }>();
  const ordinal = next?.ordinal ?? 0;

  await input.db.prepare(
    `INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, user_text, idempotency_key, started_at)
     VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?)`
  ).bind(input.turnId, input.threadId, ordinal, input.actor, input.userText, input.idempotencyKey ?? null, input.now).run();

  return { turnId: input.turnId, ordinal, replay: false };
}

export interface FinalizeInput {
  db: D1Database;
  turnId: string;
  status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked';
  text: string;
  costUsd: number;
  error?: string;
  now: number;
}

export async function finalizeChatTurn(input: FinalizeInput): Promise<void> {
  const result = await input.db.prepare(
    `UPDATE chat_turns
     SET status = ?, text = ?, cost_usd = ?, ended_at = ?, error = ?
     WHERE turn_id = ?`
  ).bind(input.status, input.text, input.costUsd, input.now, input.error ?? null, input.turnId).run();
  if (result.meta.changes === 0) {
    throw new Error(`finalizeChatTurn: no row for turn_id=${input.turnId}`);
  }
}

export interface ToolCallInput {
  db: D1Database;
  turnId: string;
  callIndex: number;
  toolName: string;
  input: unknown;
  output: unknown;
  idempotencyKey?: string;
  durationMs: number;
  error?: string;
}

export async function recordToolCall(input: ToolCallInput): Promise<void> {
  await input.db.prepare(
    `INSERT INTO chat_tool_calls (turn_id, call_index, tool_name, input_json, output_json, idempotency_key, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.turnId,
    input.callIndex,
    input.toolName,
    safeSerialize(input.input),
    safeSerialize(input.output),
    input.idempotencyKey ?? null,
    input.durationMs,
    input.error ?? null
  ).run();
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}
