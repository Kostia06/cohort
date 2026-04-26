import type { Env } from '../types';
export { UserAgentDO } from '../do/user-agent-do';

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
    return new Response('not found', { status: 404 });
  }
};
