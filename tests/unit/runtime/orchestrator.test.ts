import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { runOrchestrator } from '../../../src/runtime/orchestrator';
import { getUserProfileTool } from '../../../src/tools/get-user-profile';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';
import type { AnthropicStreamEvent } from '../../../src/types';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]', 150, 1)`
  ).run();
});

describe('runOrchestrator', () => {
  it('streams text deltas and emits text_delta SSE events', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script], tools: [getUserProfileTool] });
    const collector = createSseCollector();
    const r = await runOrchestrator({
      deps, userId: 'u1', threadId: 'th1', turnId: 't1',
      systemPrompt: 'You are a coach.',
      messages: [{ role: 'user', content: 'hi' }],
      emit: collector.emit,
      signal: new AbortController().signal
    });
    expect(r.text).toBe('Hello world');
    expect(r.tokensIn).toBe(10);
    expect(r.tokensOut).toBe(5);
    expect(collector.events.filter((e) => e.type === 'text_delta').length).toBe(2);
  });

  it('dispatches a tool call and emits visible-tool events when tool surface is visible', async () => {
    // get_user_profile is hidden — use a custom visible tool to exercise SSE emission.
    const visibleTool = {
      ...getUserProfileTool,
      name: 'echo',
      surface: 'visible' as const,
      handler: async () => ({ ok: true })
    };
    const script1: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'tool_use', id: 'tu1', name: 'echo' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'tool_use', usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    ];
    const script2: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 5 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script1, script2], tools: [visibleTool] });
    const collector = createSseCollector();
    await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('t1','th1',0,'user','streaming',1)`).run();
    const r = await runOrchestrator({
      deps, userId: 'u1', threadId: 'th1', turnId: 't1',
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
      emit: collector.emit,
      signal: new AbortController().signal
    });
    expect(r.text).toBe('done');
    expect(collector.events.some((e) => e.type === 'tool_call_start')).toBe(true);
    expect(collector.events.some((e) => e.type === 'tool_call_result')).toBe(true);
    const toolRows = await env.DB.prepare(`SELECT tool_name FROM chat_tool_calls WHERE turn_id='t1'`).all();
    expect(toolRows.results).toEqual([{ tool_name: 'echo' }]);
  });
});
