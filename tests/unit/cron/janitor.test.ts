import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { runJanitor } from '../../../src/cron/janitor';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('runJanitor', () => {
  it('sweeps streaming rows older than 5 minutes to error', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('stale','th1',0,'user','streaming',?)`).bind(now - 6 * 60 * 1000),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('fresh','th1',1,'user','streaming',?)`).bind(now - 60 * 1000)
    ]);
    const r = await runJanitor(env.DB, now);
    expect(r.swept).toBe(1);
    const stale = await env.DB.prepare(`SELECT status, error FROM chat_turns WHERE turn_id='stale'`).first();
    expect(stale).toEqual({ status: 'error', error: 'janitor_sweep' });
    const fresh = await env.DB.prepare(`SELECT status FROM chat_turns WHERE turn_id='fresh'`).first();
    expect(fresh?.status).toBe('streaming');
  });

  it('does nothing when no rows are stale', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('fresh','th1',0,'user','streaming',?)`).bind(now - 60 * 1000).run();
    const r = await runJanitor(env.DB, now);
    expect(r.swept).toBe(0);
  });
});
