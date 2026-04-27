import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { getDailySpentCents } from '../../../src/runtime/cost';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('getDailySpentCents', () => {
  it('returns 0 when no turns exist', async () => {
    const cents = await getDailySpentCents(env.DB, 'u1', Date.now());
    expect(cents).toBe(0);
  });

  it('sums cost_usd for user turns started in the last 24h, converts to cents', async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twentySixHoursAgo = now - 26 * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t1','th1',0,'user','complete',0.50,?,?)`).bind(oneHourAgo, oneHourAgo + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t2','th1',1,'user','complete',0.30,?,?)`).bind(oneHourAgo, oneHourAgo + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t3','th1',2,'user','complete',9.99,?,?)`).bind(twentySixHoursAgo, twentySixHoursAgo + 1)
    ]);
    const cents = await getDailySpentCents(env.DB, 'u1', now);
    expect(cents).toBe(80);
  });
});
