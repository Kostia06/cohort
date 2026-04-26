import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { buildContext } from '../../../src/runtime/build-context';
import { resetDb } from '../../fakes/seed';

describe('buildContext', () => {
  beforeEach(async () => {
    await resetDb(env.DB);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        'u1', 'Alex', 'America/Edmonton', 32, 'omnivore', '[]', '["cilantro"]', 150, 1
      ),
      env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)`)
        .bind('th1', 'u1', 'main', 1)
    ]);
  });

  it('loads profile and returns it as structured context', async () => {
    const ctx = await buildContext({
      db: env.DB,
      userId: 'u1',
      threadId: 'th1',
      actor: 'user'
    });

    expect(ctx.profile.display_name).toBe('Alex');
    expect(ctx.profile.dislikes).toEqual(['cilantro']);
    expect(ctx.recentMessages).toEqual([]);
  });

  it('returns last 20 user-facing messages for actor=user, ordered ASC', async () => {
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, text, user_text, started_at, ended_at)
                            VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?)`)
        .bind(`t${i}`, 'th1', i, i % 2 === 0 ? 'user' : 'assistant', i % 2 === 0 ? null : `r${i}`, i % 2 === 0 ? `m${i}` : null, i, i + 1)
        .run();
    }
    const ctx = await buildContext({ db: env.DB, userId: 'u1', threadId: 'th1', actor: 'user' });
    expect(ctx.recentMessages.length).toBe(20);
    expect(ctx.recentMessages[0]!.ordinal).toBe(5);
    expect(ctx.recentMessages.at(-1)!.ordinal).toBe(24);
  });

  it('returns last 5 messages for actor=system', async () => {
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, text, user_text, started_at, ended_at)
                            VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?)`)
        .bind(`s${i}`, 'th1', i, i % 2 === 0 ? 'user' : 'assistant', i % 2 === 0 ? null : `r${i}`, i % 2 === 0 ? `m${i}` : null, i, i + 1)
        .run();
    }
    const ctx = await buildContext({ db: env.DB, userId: 'u1', threadId: 'th1', actor: 'system' });
    expect(ctx.recentMessages.length).toBe(5);
  });
});
