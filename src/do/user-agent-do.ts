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
  private currentTurnThreadId: string | null = null;

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
    if (req.method === 'POST' && url.pathname.startsWith('/cancel/')) {
      const threadId = url.pathname.slice('/cancel/'.length);
      return this.handleCancel(threadId);
    }
    if (req.method === 'POST' && url.pathname === '/run-batch') {
      return this.handleRunBatch();
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    try {
      const resp = await this.handleRunBatch();
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.warn(`[alarm] batch returned non-OK: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error('[alarm] batch run failed:', err);
    }
  }

  private async getUserId(): Promise<string | null> {
    return (await this.state.storage.get<string>('user_id')) ?? null;
  }

  private async setUserId(userId: string): Promise<void> {
    await this.state.storage.put('user_id', userId);
  }

  private async handleRunBatch(): Promise<Response> {
    const userId = await this.getUserId();
    if (!userId) {
      return Response.json({ ok: false, reason: 'no user_id stored — chat at least once first' }, { status: 400 });
    }
    if (this.currentTurn) {
      return Response.json({ ok: false, reason: 'turn in flight' }, { status: 409 });
    }

    const ac = new AbortController();
    const turnId = ulid();
    const turnHandle = { abortController: ac, turnId };
    this.currentTurn = turnHandle;

    try {
      const ai = createAIGatewayClient({
        url: this.env.AI_GATEWAY_URL,
        apiKey: this.env.ANTHROPIC_API_KEY,
        fetch: this.env.MOCK_GATEWAY?.fetch?.bind(this.env.MOCK_GATEWAY)
      });
      const deps = {
        db: this.env.DB,
        ai,
        tools: buildToolRegistry(),
        clock: () => Date.now(),
        bindings: { research: this.env.RESEARCH, grocery: this.env.GROCERY }
      } as any;

      const threadId = `batch-${new Date().toISOString().slice(0, 10)}`;

      const r = await runTurn(
        {
          userId,
          threadId,
          actor: 'system',
          systemHint: 'Generate tomorrow\'s plan considering recent readiness, recent meals, and recent workouts. Use propose_workout to record planned sessions.',
          stream: null,
          signal: ac.signal,
          idempotencyKey: `batch:${userId}:${threadId}`,
          turnId
        },
        deps
      );
      return Response.json({ ok: true, status: r.status, turn_id: r.turnId });
    } finally {
      if (this.currentTurn === turnHandle) this.currentTurn = null;
    }
  }

  private handleCancel(threadId: string): Response {
    if (!this.currentTurn) {
      return Response.json({ cancelled: false, reason: 'no in-flight turn' }, { status: 404 });
    }
    if (this.currentTurnThreadId !== threadId) {
      return Response.json({
        cancelled: false,
        reason: 'in-flight turn is on a different thread',
        in_flight_thread_id: this.currentTurnThreadId
      }, { status: 409 });
    }
    this.currentTurn.abortController.abort();
    return Response.json({ cancelled: true, turn_id: this.currentTurn.turnId });
  }

  private async handleChat(req: Request, url: URL): Promise<Response> {
    if (this.currentTurn) {
      return Response.json({ error: 'turn_in_flight', turn_id: this.currentTurn.turnId }, { status: 409 });
    }
    const userId = req.headers.get('X-Internal-User-Id');
    if (!userId) return new Response('missing X-Internal-User-Id', { status: 401 });
    const threadId = url.pathname.slice('/chat/'.length);
    const body = await req.json<ChatRequestBody>();
    if (!body?.message) return new Response('missing message', { status: 400 });

    const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined;
    const ac = new AbortController();
    const turnId = ulid();
    const turnHandle = { abortController: ac, turnId };
    this.currentTurn = turnHandle;
    this.currentTurnThreadId = threadId;
    req.signal.addEventListener('abort', () => ac.abort(), { once: true });

    const { writer, response } = createSseStreamWriter();
    const ai = createAIGatewayClient({
      url: this.env.AI_GATEWAY_URL,
      apiKey: this.env.ANTHROPIC_API_KEY,
      fetch: this.env.MOCK_GATEWAY?.fetch.bind(this.env.MOCK_GATEWAY)
    });
    const deps = {
      db: this.env.DB,
      ai,
      tools: buildToolRegistry(),
      clock: () => Date.now(),
      bindings: { research: this.env.RESEARCH, grocery: this.env.GROCERY }
    } as any;

    await this.setUserId(userId);
    this.state.waitUntil(
      runTurn(
        { userId, threadId, actor: 'user', message: body.message, stream: writer, signal: ac.signal, idempotencyKey, turnId },
        deps
      )
        .then((_r) => { /* turnId already set on handle */ })
        .catch(() => { /* runTurn already emitted error event + finalized */ })
        .finally(() => {
          if (this.currentTurn === turnHandle) {
            this.currentTurn = null;
            this.currentTurnThreadId = null;
          }
        })
    );

    return response;
  }
}
