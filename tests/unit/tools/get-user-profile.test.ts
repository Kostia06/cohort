import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { getUserProfileTool } from '../../../src/tools/get-user-profile';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1', 'Alex', 'UTC', 32, 'omnivore', '[]', '["fish"]', 150, 1)`
  ).run();
});

describe('getUserProfileTool', () => {
  it('returns the user profile in a structured shape', async () => {
    const deps = makeFakes({ db: env.DB });
    const collector = createSseCollector();
    const result = await getUserProfileTool.handler({}, {
      userId: 'u1',
      threadId: 'th1',
      turnId: 't1',
      toolCallIndex: 0,
      deps,
      emit: collector.emit,
      signal: new AbortController().signal
    });
    expect(result).toEqual({
      display_name: 'Alex',
      timezone: 'UTC',
      age_years: 32,
      dietary_pattern: 'omnivore',
      allergies: [],
      dislikes: ['fish']
    });
  });

  it('is hidden (emits no SSE events)', async () => {
    expect(getUserProfileTool.surface).toBe('hidden');
  });
});
