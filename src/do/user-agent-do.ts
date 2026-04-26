import { ulid } from 'ulid';
import type { Env } from '../types';
import { createSseStreamWriter } from '../runtime/sse';
import { createAIGatewayClient } from '../runtime/ai-gateway';
import { runTurn } from '../runtime/agent-runtime';
import { buildToolRegistry } from '../runtime/tool-registry';

interface ChatRequestBody { message: string }

export class UserAgentDO {
  state: DurableObjectState;
  env: Env;
  currentTurn: { abortController: AbortController; turnId: string } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname.startsWith('/chat/')) {
      return this.handleChat(req, url);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ inFlight: this.currentTurn !== null });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // Batch path is implemented in a follow-up plan.
  }

  private async handleChat(req: Request, url: URL): Promise<Response> {
    if (this.currentTurn) {
      return Response.json({ error: 'turn_in_flight', turn_id: this.currentTurn.turnId }, { status: 409 });
    }
    const userId = req.headers.get('X-User-Id');
    if (!userId) return new Response('missing X-User-Id', { status: 401 });
    const threadId = url.pathname.slice('/chat/'.length);
    const body = await req.json<ChatRequestBody>();
    if (!body?.message) return new Response('missing message', { status: 400 });

    const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined;
    const ac = new AbortController();
    const turnId = ulid();
    const turnHandle = { abortController: ac, turnId };
    this.currentTurn = turnHandle;
    req.signal.addEventListener('abort', () => ac.abort(), { once: true });

    const { writer, response } = createSseStreamWriter();
    const ai = createAIGatewayClient({
      url: this.env.AI_GATEWAY_URL,
      apiKey: this.env.ANTHROPIC_API_KEY
    });
    const deps = {
      db: this.env.DB,
      ai,
      tools: buildToolRegistry(),
      clock: () => Date.now()
    };

    this.state.waitUntil(
      runTurn(
        { userId, threadId, actor: 'user', message: body.message, stream: writer, signal: ac.signal, idempotencyKey, turnId },
        deps
      )
        .then((_r) => { /* turnId already set on handle */ })
        .catch(() => { /* runTurn already emitted error event + finalized */ })
        .finally(() => { if (this.currentTurn === turnHandle) this.currentTurn = null; })
    );

    return response;
  }
}
