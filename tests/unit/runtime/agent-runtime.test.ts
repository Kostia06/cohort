import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { runTurn } from '../../../src/runtime/agent-runtime';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { getUserProfileTool } from '../../../src/tools/get-user-profile';
import { resetDb } from '../../fakes/seed';
import type { AnthropicStreamEvent } from '../../../src/types';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('runTurn', () => {
  it('runs a happy-path user turn end to end', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello!' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script], tools: [getUserProfileTool], callResults: [{ text: '{"ok": true}', tokensIn: 10, tokensOut: 2 }] });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1',
      threadId: 'th1',
      actor: 'user',
      message: 'hi',
      stream: collector,
      signal: new AbortController().signal
    }, deps);
    expect(r.status).toBe('complete');
    expect(r.text).toBe('Hello!');
    expect(collector.events[0]?.type).toBe('turn_started');
    expect(collector.events.at(-1)?.type).toBe('turn_complete');
    const row = await env.DB.prepare(`SELECT status, text FROM chat_turns WHERE turn_id=?`).bind(r.turnId).first();
    expect(row).toEqual({ status: 'complete', text: 'Hello!' });
  });

  it('uses caller-supplied turnId when provided', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 1 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script], tools: [getUserProfileTool], callResults: [{ text: '{"ok": true}', tokensIn: 10, tokensOut: 2 }] });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1',
      threadId: 'th1',
      actor: 'user',
      message: 'hi',
      stream: collector,
      signal: new AbortController().signal,
      turnId: 'caller-supplied-id'
    }, deps);
    expect(r.turnId).toBe('caller-supplied-id');
  });

  it('appends corrigendum and emits SSE event when postReview flags issues', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Take 200mg of X.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({
      db: env.DB,
      scripts: [script],
      tools: [getUserProfileTool],
      callResults: [{ text: '{"ok":false,"corrigendum":"Note: not medical advice."}', tokensIn: 50, tokensOut: 10 }]
    });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1', threadId: 'th1', actor: 'user',
      message: 'hi', stream: collector, signal: new AbortController().signal
    }, deps);
    expect(r.text).toContain('Take 200mg of X.');
    expect(r.text).toContain('not medical advice');
    expect(collector.events.some((e) => e.type === 'corrigendum')).toBe(true);
  });

  it('replays a completed turn from D1 on idempotency-key hit', async () => {
    // Pre-insert a completed turn to simulate a prior run.
    await env.DB.prepare(
      `INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, user_text, text, cost_usd, idempotency_key, started_at, ended_at)
       VALUES ('original-turn', 'th1', 0, 'user', 'complete', 'hi', 'cached response', 0.005, 'replay-key', 1, 2)`
    ).run();

    // No scripts — runTurn should NOT call the AI on replay.
    const deps = makeFakes({ db: env.DB, scripts: [], tools: [getUserProfileTool] });
    const collector = createSseCollector();

    const r = await runTurn({
      userId: 'u1', threadId: 'th1', actor: 'user',
      message: 'hi', stream: collector, signal: new AbortController().signal,
      idempotencyKey: 'replay-key'
    }, deps);

    expect(r.turnId).toBe('original-turn');
    expect(r.text).toBe('cached response');
    expect(r.costUsd).toBe(0.005);
    expect(deps.ai.calls.length).toBe(0);
    expect(collector.events.some((e) => e.type === 'turn_started')).toBe(true);
    expect(collector.events.some((e) => e.type === 'turn_complete')).toBe(true);
  });

  it('blocks via preflight and persists with status preflight_blocked', async () => {
    const deps = makeFakes({ db: env.DB, scripts: [], tools: [] });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1',
      threadId: 'th1',
      actor: 'user',
      message: 'Should I take 200mg of caffeine?',
      stream: collector,
      signal: new AbortController().signal
    }, deps);
    expect(r.status).toBe('preflight_blocked');
    expect(r.text).toContain('pharmacist');
    expect(deps.ai.calls.length).toBe(0);
  });
});
