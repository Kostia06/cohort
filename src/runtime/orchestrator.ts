import type {
  AnthropicMessage,
  AnthropicStreamEvent,
  AnthropicTool,
  RuntimeDeps,
  SseEvent,
  ToolDef,
  ToolCtx
} from '../types';
import { recordToolCall } from './persist';

const PRICE_PER_INPUT_TOKEN_USD = 15 / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN_USD = 75 / 1_000_000;

const MAX_TOOL_ROUNDS = 6;

export interface OrchestratorInput {
  deps: RuntimeDeps;
  userId: string;
  threadId: string;
  turnId: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  emit: (event: SseEvent) => void;
  signal: AbortSignal;
}

export interface OrchestratorResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

type TextBlock = { kind: 'text'; text: string };
type ToolBlock = { kind: 'tool_use'; id: string; name: string; jsonBuf: string };
type Block = TextBlock | ToolBlock;

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const tools: AnthropicTool[] = [...input.deps.tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const conv: AnthropicMessage[] = [...input.messages];
  let assembledText = '';
  let totalIn = 0;
  let totalOut = 0;
  let toolCallIndex = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = input.deps.ai.streamMessage({
      system: input.systemPrompt,
      messages: conv,
      tools,
      maxTokens: 4000,
      signal: input.signal
    });

    const blocks = new Map<number, Block>();
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';

    for await (const ev of stream) {
      if (input.signal.aborted) throw new DOMException('aborted', 'AbortError');
      handleEvent(ev, blocks, input.emit, (delta) => { assembledText += delta; });
      if (ev.type === 'message_start') totalIn += ev.usage.input_tokens;
      if (ev.type === 'message_delta') {
        stopReason = ev.stop_reason;
        totalOut += ev.usage.output_tokens;
      }
    }

    if (stopReason !== 'tool_use') break;

    const assistantContent: AnthropicMessage['content'] = [];
    const toolResults: AnthropicMessage['content'] = [];

    for (const [, block] of blocks) {
      if (block.kind === 'text') {
        if (block.text) assistantContent.push({ type: 'text', text: block.text });
      } else {
        const parsed = block.jsonBuf ? JSON.parse(block.jsonBuf) : {};
        assistantContent.push({ type: 'tool_use', id: block.id, name: block.name, input: parsed });

        const tool = input.deps.tools.get(block.name);
        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: 'unknown_tool' })
          });
          continue;
        }

        const idemKey = tool.idempotent ? `${input.turnId}:${toolCallIndex}` : undefined;

        if (tool.surface === 'visible') {
          input.emit({ type: 'tool_call_start', data: { call_index: toolCallIndex, tool: tool.name, input: parsed } });
        }

        const t0 = input.deps.clock();
        const out = await runToolSafely(tool, parsed, {
          userId: input.userId,
          threadId: input.threadId,
          turnId: input.turnId,
          toolCallIndex,
          deps: input.deps,
          emit: input.emit,
          signal: input.signal
        });
        const t1 = input.deps.clock();

        await recordToolCall({
          db: input.deps.db,
          turnId: input.turnId,
          callIndex: toolCallIndex,
          toolName: tool.name,
          input: parsed,
          output: out.value,
          idempotencyKey: idemKey,
          durationMs: t1 - t0,
          error: out.error
        });

        if (tool.surface === 'visible') {
          input.emit({ type: 'tool_call_result', data: { call_index: toolCallIndex, summary: summarize(out.value) } });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(out.value)
        });

        toolCallIndex++;
      }
    }

    conv.push({ role: 'assistant', content: assistantContent });
    conv.push({ role: 'user', content: toolResults });
  }

  const costUsd = totalIn * PRICE_PER_INPUT_TOKEN_USD + totalOut * PRICE_PER_OUTPUT_TOKEN_USD;
  return { text: assembledText, tokensIn: totalIn, tokensOut: totalOut, costUsd };
}

function handleEvent(
  ev: AnthropicStreamEvent,
  blocks: Map<number, Block>,
  emit: (e: SseEvent) => void,
  onTextDelta: (s: string) => void
): void {
  if (ev.type === 'content_block_start') {
    if (ev.block.type === 'text') {
      blocks.set(ev.index, { kind: 'text', text: '' });
    } else {
      blocks.set(ev.index, { kind: 'tool_use', id: ev.block.id, name: ev.block.name, jsonBuf: '' });
    }
    return;
  }

  if (ev.type === 'content_block_delta') {
    const b = blocks.get(ev.index);
    if (!b) return;
    if (b.kind === 'text' && ev.delta.type === 'text_delta') {
      b.text += ev.delta.text;
      emit({ type: 'text_delta', data: { chunk: ev.delta.text } });
      onTextDelta(ev.delta.text);
    } else if (b.kind === 'tool_use' && ev.delta.type === 'input_json_delta') {
      b.jsonBuf += ev.delta.partial_json;
    }
  }
}

async function runToolSafely(
  tool: ToolDef,
  input: unknown,
  ctx: ToolCtx
): Promise<{ value: unknown; error?: string }> {
  try {
    const value = await tool.handler(input, ctx);
    return { value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: { error: 'transient', message }, error: message };
  }
}

function summarize(out: unknown): string {
  if (typeof out !== 'object' || out === null) return String(out);
  const entries = Object.entries(out as Record<string, unknown>).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}
