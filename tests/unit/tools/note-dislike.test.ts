import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { noteDislikeTool } from '../../../src/tools/note-dislike';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','["cilantro"]',150,1)`
  ).run();
});

describe('noteDislikeTool', () => {
  it('appends a new dislike to the array', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await noteDislikeTool.handler({ food: 'fish' }, ctx);
    expect(r.dislikes).toEqual(['cilantro', 'fish']);
    const row = await env.DB.prepare(`SELECT dislikes_json FROM users WHERE user_id = 'u1'`).first<{dislikes_json: string}>();
    expect(JSON.parse(row!.dislikes_json)).toEqual(['cilantro', 'fish']);
  });

  it('is idempotent on repeated dislike', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    await noteDislikeTool.handler({ food: 'cilantro' }, ctx);
    const r = await noteDislikeTool.handler({ food: 'cilantro' }, ctx);
    expect(r.dislikes).toEqual(['cilantro']);
  });
});
