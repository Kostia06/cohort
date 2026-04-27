import type { Env } from '../types';
import { verifyJwt } from '../auth/jwt';
import { runJanitor } from '../cron/janitor';
import { runBatchTrigger } from '../cron/batch-trigger';
import { handleHealthKitSync } from './healthkit-sync';
import { handlePlansToday } from './plans-today';
import { handleWorkoutUpdate } from './workouts-update';
export { UserAgentDO } from '../do/user-agent-do';

const JANITOR_CRON = '*/5 * * * *';
const BATCH_CRON = '0 * * * *';
const BATCH_TARGET_HOUR = 5;

async function authenticateRequest(req: Request, env: Env): Promise<string | Response> {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response('missing or malformed Authorization', { status: 401 });
  }
  const token = auth.slice('Bearer '.length);
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims) return new Response('invalid or expired token', { status: 401 });
  return claims.sub;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname.startsWith('/v1/chat/')) {
      const auth = await authenticateRequest(req, env);
      if (auth instanceof Response) return auth;
      const userId = auth;
      const threadId = url.pathname.slice('/v1/chat/'.length);
      const id = env.USER_AGENT_DO.idFromName(userId);
      const stub = env.USER_AGENT_DO.get(id);
      const innerUrl = new URL(`https://do/chat/${threadId}`);
      const innerReq = new Request(innerUrl, req);
      innerReq.headers.set('X-Internal-User-Id', userId);
      return stub.fetch(innerReq);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/cancel/')) {
      const auth = await authenticateRequest(req, env);
      if (auth instanceof Response) return auth;
      const userId = auth;
      const threadId = url.pathname.slice('/v1/cancel/'.length);
      const id = env.USER_AGENT_DO.idFromName(userId);
      const stub = env.USER_AGENT_DO.get(id);
      return stub.fetch(new Request(`https://do/cancel/${threadId}`, { method: 'POST' }));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/run-batch/')) {
      const auth = await authenticateRequest(req, env);
      if (auth instanceof Response) return auth;
      const userId = auth;
      const pathUserId = url.pathname.slice('/v1/run-batch/'.length);
      if (pathUserId !== userId) return new Response('user_id mismatch', { status: 403 });
      const threadId = `batch-${new Date().toISOString().slice(0, 10)}`;
      await env.DB.prepare(
        `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES (?, ?, 'batch', ?) ON CONFLICT(thread_id) DO NOTHING`
      ).bind(threadId, userId, Date.now()).run();
      const id = env.USER_AGENT_DO.idFromName(userId);
      const stub = env.USER_AGENT_DO.get(id);
      return stub.fetch(new Request('https://do/run-batch', { method: 'POST' }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/plans/today') {
      const auth = await authenticateRequest(req, env);
      if (auth instanceof Response) return auth;
      const userId = auth;
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
      const result = await handlePlansToday({ userId, date, now: Date.now(), db: env.DB });
      return Response.json(result);
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/v1/workouts/')) {
      const auth = await authenticateRequest(req, env);
      if (auth instanceof Response) return auth;
      const userId = auth;
      const workoutId = url.pathname.slice('/v1/workouts/'.length);
      const body = await req.json<{ status: 'planned' | 'logged' | 'skipped' }>();
      if (!body?.status) return new Response('missing status', { status: 400 });
      const result = await handleWorkoutUpdate({ db: env.DB, userId, workoutId, status: body.status });
      if (!result.ok) {
        return Response.json({ error: result.reason ?? 'failed' }, { status: result.status ?? 500 });
      }
      return Response.json({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/v1/healthkit/sync') {
      const auth = await authenticateRequest(req, env);
      if (auth instanceof Response) return auth;
      const userId = auth;
      const sample = await req.json<{ date: string; hrv_sdnn_ms?: number; rhr_bpm?: number; sleep_minutes?: number; time_in_bed_minutes?: number; active_kcal?: number; steps?: number }>();
      if (!sample?.date) return new Response('missing date', { status: 400 });
      const deps = { db: env.DB, clock: () => Date.now() };
      const result = await handleHealthKitSync(userId, sample, deps);
      return Response.json(result);
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === JANITOR_CRON) {
      const r = await runJanitor(env.DB, Date.now());
      console.log(`[scheduled] janitor swept ${r.swept}`);
      return;
    }
    if (event.cron === BATCH_CRON) {
      const dispatch = async (userId: string): Promise<void> => {
        const id = env.USER_AGENT_DO.idFromName(userId);
        const stub = env.USER_AGENT_DO.get(id);
        const resp = await stub.fetch(new Request('https://do/run-batch', { method: 'POST' }));
        if (!resp.ok) {
          throw new Error(`DO returned ${resp.status}`);
        }
      };
      const r = await runBatchTrigger(env.DB, Date.now(), BATCH_TARGET_HOUR, dispatch);
      console.log(`[scheduled] batch dispatched=${r.dispatched} errors=${r.errors}`);
      return;
    }
    console.warn(`[scheduled] unknown cron: ${event.cron}`);
  }
};
