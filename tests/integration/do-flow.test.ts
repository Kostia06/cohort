import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('end-to-end POST /v1/chat/{thread_id}', () => {
  it('returns an SSE stream and persists the turn', async () => {
    const resp = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1', 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
      body: JSON.stringify({ message: 'hi' })
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('event: turn_started');
    expect(text).toContain('event: text_delta');
    expect(text).toContain('"chunk":"hello"');
    expect(text).toContain('event: turn_complete');

    // Allow the DO's waitUntil to flush.
    await new Promise((r) => setTimeout(r, 50));

    const row = await env.DB.prepare(`SELECT status, text FROM chat_turns WHERE thread_id='th1' ORDER BY ordinal DESC LIMIT 1`).first();
    expect(row?.status).toBe('complete');
    expect(row?.text).toBe('hello');
  });

  it('rejects requests without X-User-Id', async () => {
    const resp = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    });
    expect(resp.status).toBe(401);
  });
});
