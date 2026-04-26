import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { getReadinessTool } from '../../../src/tools/get-readiness';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
});

describe('getReadinessTool', () => {
  it('returns null when no readiness rows exist', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await getReadinessTool.handler({}, ctx);
    expect(r).toEqual({ readiness: null });
  });

  it('returns the latest readiness row', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                      VALUES ('u1','2026-04-23',60,'normal','ready','{}','[]',1)`),
      env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                      VALUES ('u1','2026-04-24',75,'green','ready','{"hrv":80}','["good sleep"]',2)`)
    ]);
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await getReadinessTool.handler({}, ctx);
    expect(r.readiness?.date).toBe('2026-04-24');
    expect(r.readiness?.score).toBe(75);
    expect(r.readiness?.band).toBe('green');
    expect(r.readiness?.components).toEqual({ hrv: 80 });
  });
});
