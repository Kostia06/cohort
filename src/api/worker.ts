import type { Env } from '../types';
import { runJanitor } from '../cron/janitor';
import { runBatchTrigger } from '../cron/batch-trigger';
export { UserAgentDO } from '../do/user-agent-do';

const JANITOR_CRON = '*/5 * * * *';
const BATCH_CRON = '0 * * * *';
const BATCH_TARGET_HOUR = 5;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname.startsWith('/v1/chat/')) {
      const userId = req.headers.get('X-User-Id');
      if (!userId) return new Response('missing X-User-Id', { status: 401 });
      const threadId = url.pathname.slice('/v1/chat/'.length);
      const id = env.USER_AGENT_DO.idFromName(userId);
      const stub = env.USER_AGENT_DO.get(id);
      const innerUrl = new URL(`https://do/chat/${threadId}`);
      return stub.fetch(new Request(innerUrl, req));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/cancel/')) {
      const userId = req.headers.get('X-User-Id');
      if (!userId) return new Response('missing X-User-Id', { status: 401 });
      const id = env.USER_AGENT_DO.idFromName(userId);
      const stub = env.USER_AGENT_DO.get(id);
      return stub.fetch(new Request('https://do/cancel', req));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/run-batch/')) {
      const headerUserId = req.headers.get('X-User-Id');
      if (!headerUserId) return new Response('missing X-User-Id', { status: 401 });
      const pathUserId = url.pathname.slice('/v1/run-batch/'.length);
      if (pathUserId !== headerUserId) return new Response('user_id mismatch', { status: 403 });
      const userId = headerUserId;
      const threadId = `batch-${new Date().toISOString().slice(0, 10)}`;
      await env.DB.prepare(
        `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES (?, ?, 'batch', ?) ON CONFLICT(thread_id) DO NOTHING`
      ).bind(threadId, userId, Date.now()).run();
      const id = env.USER_AGENT_DO.idFromName(userId);
      const stub = env.USER_AGENT_DO.get(id);
      return stub.fetch(new Request('https://do/run-batch', { method: 'POST' }));
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
