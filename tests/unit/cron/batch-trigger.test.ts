import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { findUsersDueForBatch, runBatchTrigger } from '../../../src/cron/batch-trigger';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('findUsersDueForBatch', () => {
  it('returns users whose local hour matches the target', async () => {
    // 2026-04-25T11:00:00Z = 05:00 in America/Edmonton (UTC-6 MDT)
    const now = new Date('2026-04-25T11:00:00Z').getTime();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES ('u1','Alex','America/Edmonton','[]','[]',150,1)`),
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES ('u2','Riley','UTC','[]','[]',150,1)`),
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES ('u3','Sam','Asia/Tokyo','[]','[]',150,1)`)
    ]);
    const due = await findUsersDueForBatch(env.DB, now, 5);
    const ids = due.map((u) => u.user_id).sort();
    expect(ids).toEqual(['u1']);
  });
});

describe('runBatchTrigger', () => {
  it('calls dispatch for each due user, swallows individual errors', async () => {
    const now = new Date('2026-04-25T11:00:00Z').getTime();
    await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                          VALUES ('u1','Alex','America/Edmonton','[]','[]',150,1)`).run();

    const calls: string[] = [];
    const dispatch = async (userId: string) => {
      calls.push(userId);
      if (userId === 'fail') throw new Error('boom');
    };
    const r = await runBatchTrigger(env.DB, now, 5, dispatch);
    expect(r.dispatched).toBe(1);
    expect(r.errors).toBe(0);
    expect(calls).toEqual(['u1']);
  });
});
