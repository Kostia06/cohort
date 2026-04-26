import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetDb } from '../fakes/seed';

const USER_ID = 'alarm-u1';
const THREAD_ID = 'alarm-th1';

beforeAll(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
       VALUES ('${USER_ID}','Alex','UTC','[]','[]',150,1)`
    ),
    env.DB.prepare(
      `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('${THREAD_ID}','${USER_ID}','main',1)`
    ),
  ]);
});

describe('batch turn via /v1/run-batch', () => {
  it('returns 400 before chat, then 200 after chat primes user_id', async () => {
    // Part 1: no chat yet — should return 400.
    const noUserResp = await SELF.fetch(`https://api/v1/run-batch/${USER_ID}`, {
      method: 'POST',
      headers: { 'X-User-Id': USER_ID }
    });
    expect(noUserResp.status).toBe(400);
    const noUserData = await noUserResp.json() as { ok: boolean };
    expect(noUserData.ok).toBe(false);

    // Part 2: send a chat to store user_id in DO — drain SSE fully.
    const chatText = await SELF.fetch(`https://api/v1/chat/${THREAD_ID}`, {
      method: 'POST',
      headers: { 'X-User-Id': USER_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    }).then((r) => r.text());
    expect(chatText).toContain('turn_complete');

    // Allow the DO's waitUntil to fully flush.
    await new Promise((r) => setTimeout(r, 200));

    // Part 3: run-batch should now succeed.
    const batchResp = await SELF.fetch(`https://api/v1/run-batch/${USER_ID}`, {
      method: 'POST',
      headers: { 'X-User-Id': USER_ID }
    });
    const batchData = await batchResp.json() as { ok: boolean; status: string };
    expect(batchResp.status).toBe(200);
    expect(batchData.ok).toBe(true);
    expect(['complete', 'preflight_blocked', 'cap_exceeded', 'error']).toContain(batchData.status);

    // Allow all async DO work to settle.
    await new Promise((r) => setTimeout(r, 200));
  });
});
