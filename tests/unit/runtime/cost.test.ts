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
    const cents = await getDailySpentCents(env.DB, 'u1', Date.now(), 'UTC');
    expect(cents).toBe(0);
  });

  it('sums cost_usd for user turns started in the current UTC calendar day, converts to cents', async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twentySixHoursAgo = now - 26 * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t1','th1',0,'user','complete',0.50,?,?)`).bind(oneHourAgo, oneHourAgo + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t2','th1',1,'user','complete',0.30,?,?)`).bind(oneHourAgo, oneHourAgo + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t3','th1',2,'user','complete',9.99,?,?)`).bind(twentySixHoursAgo, twentySixHoursAgo + 1)
    ]);
    const cents = await getDailySpentCents(env.DB, 'u1', now, 'UTC');
    expect(cents).toBe(80);
  });

  it('uses calendar-day boundary in the given timezone', async () => {
    // 2026-04-25T05:00:00Z in America/Edmonton (MDT = UTC-6) = 2026-04-24T23:00:00 local.
    // Local day (Apr 24) started at 2026-04-24T06:00:00Z (midnight MDT).
    // earlyToday (2026-04-24T21:00Z = 15:00 MDT Apr 24) is "today" in local tz.
    // Wait — at utcNow=05:00Z, local time is 23:00 on Apr 24.
    // Local day Apr 24 started at 2026-04-24T06:00Z.
    // earlyToday = utcNow - 8h = 2026-04-24T21:00Z = 15:00 MDT → still Apr 24 → "today"
    // We need a turn that is "yesterday" in local tz (i.e. before 2026-04-24T06:00Z).
    // Use utcNow - 24h = 2026-04-24T05:00Z = 2026-04-23T23:00 MDT → Apr 23 → "yesterday"
    const utcNow = new Date('2026-04-25T05:00:00Z').getTime();
    const yesterdayLocal = utcNow - 24 * 60 * 60 * 1000; // 2026-04-24T05:00Z = Apr 23 local (yesterday)
    const todayLocal     = utcNow - 1  * 60 * 60 * 1000; // 2026-04-25T04:00Z = Apr 24 local (today)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t-yest','th1',0,'user','complete',5.00,?,?)`).bind(yesterdayLocal, yesterdayLocal + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t-today','th1',1,'user','complete',1.00,?,?)`).bind(todayLocal, todayLocal + 1)
    ]);
    const cents = await getDailySpentCents(env.DB, 'u1', utcNow, 'America/Edmonton');
    expect(cents).toBe(100); // only "today" (Apr 24 local) turn counts
  });
});
