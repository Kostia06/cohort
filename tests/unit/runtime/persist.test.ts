import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { insertChatTurnStreaming, finalizeChatTurn, recordToolCall } from '../../../src/runtime/persist';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1', 'a', 'UTC', '[]', '[]', 150, 1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1', 'u1', 'main', 1)`)
  ]);
});

describe('insertChatTurnStreaming', () => {
  it('inserts a streaming row with allocated ordinal', async () => {
    const r = await insertChatTurnStreaming({
      db: env.DB,
      turnId: 't1',
      threadId: 'th1',
      actor: 'user',
      userText: 'hi',
      idempotencyKey: 'k1',
      now: 1000
    });
    expect(r.ordinal).toBe(0);
    const row = await env.DB.prepare(`SELECT status, ordinal FROM chat_turns WHERE turn_id='t1'`).first();
    expect(row).toEqual({ status: 'streaming', ordinal: 0 });
  });

  it('allocates ordinal as max(ordinal)+1 within thread', async () => {
    await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('t0','th1',7,'user','complete',1)`).run();
    const r = await insertChatTurnStreaming({
      db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', now: 1
    });
    expect(r.ordinal).toBe(8);
  });

  it('returns existing turnId on idempotency-key replay', async () => {
    const r1 = await insertChatTurnStreaming({ db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', idempotencyKey: 'k1', now: 1 });
    const r2 = await insertChatTurnStreaming({ db: env.DB, turnId: 't2', threadId: 'th1', actor: 'user', userText: 'hi', idempotencyKey: 'k1', now: 2 });
    expect(r2.turnId).toBe(r1.turnId);
    expect(r2.replay).toBe(true);
  });
});

describe('finalizeChatTurn', () => {
  it('updates status, text, cost, ended_at', async () => {
    await insertChatTurnStreaming({ db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', now: 1 });
    await finalizeChatTurn({ db: env.DB, turnId: 't1', status: 'complete', text: 'world', costUsd: 0.012, now: 5 });
    const row = await env.DB.prepare(`SELECT status, text, cost_usd, ended_at FROM chat_turns WHERE turn_id='t1'`).first();
    expect(row).toEqual({ status: 'complete', text: 'world', cost_usd: 0.012, ended_at: 5 });
  });
});

describe('recordToolCall', () => {
  it('records a tool call row', async () => {
    await insertChatTurnStreaming({ db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', now: 1 });
    await recordToolCall({
      db: env.DB, turnId: 't1', callIndex: 0, toolName: 'get_user_profile',
      input: { user_id: 'u1' }, output: { ok: true }, idempotencyKey: 'idem1', durationMs: 12
    });
    const row = await env.DB.prepare(`SELECT tool_name, input_json, output_json, idempotency_key FROM chat_tool_calls WHERE turn_id='t1' AND call_index=0`).first();
    expect(row?.tool_name).toBe('get_user_profile');
    expect(JSON.parse(row?.input_json as string)).toEqual({ user_id: 'u1' });
  });
});
