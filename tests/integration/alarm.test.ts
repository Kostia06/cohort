import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { resetDb } from '../fakes/seed';
import { mintTestJwt } from '../fakes/jwt-helper';

beforeAll(async () => {
  await resetDb(env.DB);
  // Seed the legacy u1 user that other tests may depend on.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
       VALUES ('alarm-u1','Alex','UTC','[]','[]',150,1)`
    ),
    env.DB.prepare(
      `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('alarm-th1','alarm-u1','main',1)`
    ),
  ]);
});

describe('batch turn via /v1/run-batch', () => {
  it('returns 400 when no chat has stored user_id yet', async () => {
    const userId = `batch-${Date.now()}-1`;
    await env.DB.prepare(
      `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
       VALUES (?, 'Alex', 'UTC', '[]', '[]', 150, 1)`
    ).bind(userId).run();

    const token = await mintTestJwt(userId);
    const resp = await SELF.fetch(`https://api/v1/run-batch/${userId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(400);
    const data = await resp.json() as { ok: boolean };
    expect(data.ok).toBe(false);
  });

  it('runs a batch turn after a chat has stored user_id', async () => {
    const userId = `batch-${Date.now()}-2`;
    const threadId = `th-${userId}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
         VALUES (?, 'Alex', 'UTC', '[]', '[]', 150, 1)`
      ).bind(userId),
      env.DB.prepare(
        `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES (?, ?, 'main', 1)`
      ).bind(threadId, userId)
    ]);

    // Send a chat to prime DO storage with user_id.
    const token = await mintTestJwt(userId);
    const chatText = await SELF.fetch(`https://api/v1/chat/${threadId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    }).then((r) => r.text());
    expect(chatText).toContain('turn_complete');

    // Allow DO waitUntil to fully flush.
    await new Promise((r) => setTimeout(r, 200));

    const resp = await SELF.fetch(`https://api/v1/run-batch/${userId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { ok: boolean; status: string };
    expect(data.ok).toBe(true);
    expect(['complete', 'preflight_blocked', 'cap_exceeded', 'error']).toContain(data.status);

    await new Promise((r) => setTimeout(r, 200));
  });
});
