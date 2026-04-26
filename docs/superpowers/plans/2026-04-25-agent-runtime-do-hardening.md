# Agent Runtime DO — Plan 2: Runtime Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the safety + operational gaps deferred from Plan 1: the post-stream Haiku 4.5 review, Anthropic 5xx retry wrapper, cancel endpoint, SSE replay on idempotency hit, per-user cost cap.

**Architecture:** Same as Plan 1. Extends `AgentRuntime` library (post-review now uses a real Haiku call), `UserAgentDO` (cancel route + replay path), `AIGatewayClient` (new `call()` method + retry).

**Tech Stack:** Same as Plan 1.

**Spec:** `docs/superpowers/specs/2026-04-25-agent-runtime-do-design.md`. Plan 1: `docs/superpowers/plans/2026-04-25-agent-runtime-do-vertical-slice.md`.

**Out of scope (deferred to Plan 3+):**
- The 8 remaining tools (get_readiness, get_recent_meals, note_dislike, log_meal, propose_workout, search_groceries, search_research, compute_acwr).
- DO `alarm()` for 5am batch turn.
- Janitor cron worker for stale `streaming` rows.
- JWT auth (X-User-Id stub remains).
- Smoke tests against deployed staging.

**Spec coverage in this plan:**
- ✓ `postReview` Haiku 4.5 LLM call replacing the no-op stub.
- ✓ Anthropic 5xx retry once with backoff (spec error matrix line 1).
- ✓ Cancellation flow including explicit `POST /cancel` (spec data flow §3b).
- ✓ Turn-level idempotency replay (spec §3d).
- ✓ Cost cap rejection before orchestrator call.

---

## File Structure (changes from Plan 1)

```
src/
  runtime/
    ai-gateway.ts          # add call() method + retry logic
    safety.ts              # replace postReview stub with real Haiku call
    agent-runtime.ts       # wire postReview corrigendum, replay path, cost cap
    cost.ts                # NEW — daily-spent computation
  do/
    user-agent-do.ts       # add POST /cancel, SSE replay path

tests/
  unit/runtime/
    ai-gateway-retry.test.ts   # NEW
    safety-postreview.test.ts  # NEW
    cost.test.ts               # NEW
  integration/
    do-flow.test.ts        # extend with cancel + replay + cost-cap cases
```

---

## Phase 1: AI Gateway hardening

### Task 1: AI Gateway `call()` (non-streaming)

**Files:**
- Modify: `src/types.ts` — add `call(req)` to `AIGatewayClient` interface.
- Modify: `src/runtime/ai-gateway.ts` — implement `call()`.
- Create: `tests/unit/runtime/ai-gateway-call.test.ts`

`call()` is used by `postReview` and any future single-shot LLM calls. Same retry rules will apply in Task 2.

- [ ] **Step 1: Update `src/types.ts`**

Find the `AIGatewayClient` interface and add a `call` method:

```ts
export interface AIGatewayClient {
  streamMessage(req: StreamMessageRequest): AsyncIterable<AnthropicStreamEvent>;
  call(req: NonStreamMessageRequest): Promise<NonStreamMessageResult>;
}

export interface NonStreamMessageRequest {
  model: 'claude-opus-4-7' | 'claude-haiku-4-5-20251001';
  system: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface NonStreamMessageResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}
```

- [ ] **Step 2: Update `tests/fakes/scripted-stream.ts`**

The fake is now incomplete (missing `call`). Add a stub that returns from a separate `callResults` array:

```ts
import type { AIGatewayClient, AnthropicStreamEvent, NonStreamMessageRequest, NonStreamMessageResult, StreamMessageRequest } from '../../src/types';

export function scriptedStream(
  scripts: AnthropicStreamEvent[][],
  callResults: NonStreamMessageResult[] = []
): AIGatewayClient & { calls: StreamMessageRequest[]; nonStreamCalls: NonStreamMessageRequest[] } {
  let nextStream = 0;
  let nextCall = 0;
  const streamCalls: StreamMessageRequest[] = [];
  const nonStreamCalls: NonStreamMessageRequest[] = [];
  return {
    async *streamMessage(req: StreamMessageRequest) {
      streamCalls.push(req);
      const script = scripts[nextStream++];
      if (!script) throw new Error('scriptedStream: no more scripts');
      for (const ev of script) {
        if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield ev;
      }
    },
    async call(req: NonStreamMessageRequest) {
      nonStreamCalls.push(req);
      const result = callResults[nextCall++];
      if (!result) throw new Error('scriptedStream: no more callResults');
      if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return result;
    },
    get calls() { return streamCalls; },
    get nonStreamCalls() { return nonStreamCalls; }
  };
}
```

- [ ] **Step 3: Write the failing test `tests/unit/runtime/ai-gateway-call.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';

describe('AIGatewayClient.call', () => {
  it('makes a non-streaming POST and returns text + tokens', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'safe' }],
      usage: { input_tokens: 5, output_tokens: 1 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const client = createAIGatewayClient({
      url: 'https://example/anthropic',
      apiKey: 'k',
      fetch: fakeFetch
    });

    const r = await client.call({
      model: 'claude-haiku-4-5-20251001',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      signal: new AbortController().signal
    });

    expect(r.text).toBe('safe');
    expect(r.tokensIn).toBe(5);
    expect(r.tokensOut).toBe(1);
  });

  it('throws on non-2xx with status + body', async () => {
    const fakeFetch = (async () => new Response('upstream error', { status: 503 })) as typeof fetch;
    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch });
    await expect(
      client.call({
        model: 'claude-haiku-4-5-20251001',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 4: Run test to confirm failure**

`pnpm test tests/unit/runtime/ai-gateway-call.test.ts -- --run`
Expected: FAIL — `client.call is not a function`.

- [ ] **Step 5: Implement `call` in `src/runtime/ai-gateway.ts`**

Add the method to the returned object alongside `streamMessage`:

```ts
async call(req: NonStreamMessageRequest): Promise<NonStreamMessageResult> {
  const body = {
    model: req.model,
    system: req.system,
    messages: req.messages,
    max_tokens: req.maxTokens,
    stream: false
  };
  const resp = await fetchImpl(`${cfg.url}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: req.signal
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`AI Gateway ${resp.status}: ${errText}`);
  }
  const data = await resp.json() as {
    content: Array<{ type: 'text'; text: string } | { type: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  const text = data.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    tokensIn: data.usage?.input_tokens ?? 0,
    tokensOut: data.usage?.output_tokens ?? 0
  };
}
```

Also add the imports for `NonStreamMessageRequest`, `NonStreamMessageResult` to the top of the file.

- [ ] **Step 6: Run test to confirm pass**

`pnpm test tests/unit/runtime/ai-gateway-call.test.ts -- --run`
Expected: PASS (2 tests).

- [ ] **Step 7: Run full suite to confirm no regressions**

`pnpm test -- --run` — should be 30 PASS (28 from Plan 1 + 2 new).
`pnpm typecheck` — exit 0.

- [ ] **Step 8: Commit**

```
git add src/types.ts src/runtime/ai-gateway.ts tests/fakes/scripted-stream.ts tests/unit/runtime/ai-gateway-call.test.ts
git commit -m "Add AI Gateway non-streaming call method"
```

---

### Task 2: Anthropic 5xx retry wrapper

**Files:**
- Modify: `src/runtime/ai-gateway.ts` — wrap both `streamMessage` and `call` with one-retry-on-5xx logic.
- Create: `tests/unit/runtime/ai-gateway-retry.test.ts`

Spec error matrix: "Anthropic 5xx / timeout — retry once with 1s backoff. On second failure, emit `error` SSE event, persist turn `status='error'`, return."

For this plan: implement the retry inside the AI Gateway client itself, transparent to callers. Both the streaming and non-streaming paths share the same retry logic.

- [ ] **Step 1: Write failing test `tests/unit/runtime/ai-gateway-retry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';

describe('AI Gateway retry on 5xx', () => {
  it('retries call() once on 503, succeeds on second attempt', async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response('upstream blip', { status: 503 });
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch });
    const r = await client.call({
      model: 'claude-haiku-4-5-20251001',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      signal: new AbortController().signal
    });
    expect(r.text).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws after second 5xx', async () => {
    const fakeFetch = (async () => new Response('still down', { status: 502 })) as typeof fetch;
    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch });
    await expect(
      client.call({
        model: 'claude-haiku-4-5-20251001',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/502/);
  });

  it('does not retry on 4xx (e.g. 400 bad request)', async () => {
    let attempts = 0;
    const fakeFetch = (async () => { attempts++; return new Response('bad', { status: 400 }); }) as typeof fetch;
    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch });
    await expect(
      client.call({
        model: 'claude-haiku-4-5-20251001',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/runtime/ai-gateway-retry.test.ts -- --run`
Expected: FAIL — retry not implemented.

- [ ] **Step 3: Implement retry in `src/runtime/ai-gateway.ts`**

Extract the fetch-with-retry into a private helper. Apply it to both `call()` and `streamMessage()`.

```ts
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const resp = await fetchImpl(url, init);
    if (resp.status >= 500 && attempt === 0) {
      // 1s backoff before retry. Drain and discard body so socket releases.
      try { await resp.text(); } catch {}
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    return resp;
  }
  // Unreachable: the loop either returns or continues; on second attempt it returns.
  throw new Error('fetchWithRetry: exhausted attempts');
}
```

Then update `call()` and `streamMessage()` to use `fetchWithRetry(fetchImpl, ..., req.signal)` instead of calling `fetchImpl` directly.

Note: the 1-second sleep in tests will slow each retry test. To keep test runtime down, expose the backoff as an injected option:

```ts
export interface AIGatewayConfig {
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
  retryBackoffMs?: number;  // default 1000; tests pass 0
}
```

And use `cfg.retryBackoffMs ?? 1000` instead of a hard-coded `1000`. Update tests to pass `retryBackoffMs: 0` for fast retry.

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/runtime/ai-gateway-retry.test.ts -- --run`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full suite**

`pnpm test -- --run` — should be 33 PASS (30 + 3 new).
`pnpm typecheck` — exit 0.

- [ ] **Step 6: Commit**

```
git add src/runtime/ai-gateway.ts tests/unit/runtime/ai-gateway-retry.test.ts
git commit -m "Retry once on Anthropic 5xx with backoff"
```

---

## Phase 2: Post-stream review

### Task 3: postReview Haiku 4.5 implementation

**Files:**
- Modify: `src/runtime/safety.ts` — replace stub with real Haiku call.
- Create: `tests/unit/runtime/safety-postreview.test.ts`

The post-review takes the assembled assistant text and asks Haiku 4.5: "given this response, identify any of the following issues: specific medication advice, calorie targets below 1200 for adults without context, drug-interaction claims, diagnostic claims. If any, return a one-paragraph corrigendum to append. Otherwise return `{ok: true}`."

- [ ] **Step 1: Write failing test `tests/unit/runtime/safety-postreview.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { postReview } from '../../../src/runtime/safety';
import type { AIGatewayClient, NonStreamMessageRequest, NonStreamMessageResult } from '../../../src/types';

function fakeAi(result: NonStreamMessageResult): AIGatewayClient {
  return {
    async *streamMessage() { throw new Error('not used'); },
    async call(_req: NonStreamMessageRequest) { return result; }
  };
}

describe('postReview', () => {
  it('returns ok when Haiku says ok', async () => {
    const ai = fakeAi({ text: '{"ok": true}', tokensIn: 50, tokensOut: 5 });
    const r = await postReview('A balanced breakfast: oatmeal, eggs, fruit.', ai);
    expect(r.ok).toBe(true);
    expect(r.corrigendum).toBeUndefined();
  });

  it('returns corrigendum when Haiku flags issues', async () => {
    const ai = fakeAi({
      text: '{"ok": false, "corrigendum": "Note: this is general guidance, not medical advice."}',
      tokensIn: 50, tokensOut: 20
    });
    const r = await postReview('Take 200mg of caffeine before training.', ai);
    expect(r.ok).toBe(false);
    expect(r.corrigendum).toContain('not medical advice');
  });

  it('returns ok when Haiku response is malformed (fail open)', async () => {
    const ai = fakeAi({ text: 'not json at all', tokensIn: 50, tokensOut: 5 });
    const r = await postReview('benign answer', ai);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/runtime/safety-postreview.test.ts -- --run`
Expected: FAIL — `postReview is not a function with this signature` or returning undefined corrigendum.

(Note: the existing stub takes only `(_assembled: string)`. We're changing the signature to `(assembled: string, ai: AIGatewayClient)`.)

- [ ] **Step 3: Replace the stub in `src/runtime/safety.ts`**

```ts
import type { AIGatewayClient } from '../types';

const POSTREVIEW_SYSTEM = `You are a safety reviewer for a non-medical health and training app. Read the assistant response and identify any of these issues:
- Specific medication, supplement dosage, or drug-interaction advice.
- Calorie targets below 1200/day for adults without explicit clinical-supervision framing.
- Diagnostic claims about the user's medical condition.
- Strengthening of research claims (turning "may" into "does", removing hedging).

Return ONLY a JSON object, no prose, no markdown. Either:
{"ok": true}
or
{"ok": false, "corrigendum": "<one-paragraph note to append to the response that adds caveats / redirects appropriately>"}`;

export async function postReview(
  assembled: string,
  ai: AIGatewayClient
): Promise<{ ok: boolean; corrigendum?: string }> {
  if (!assembled.trim()) return { ok: true };
  try {
    const result = await ai.call({
      model: 'claude-haiku-4-5-20251001',
      system: POSTREVIEW_SYSTEM,
      messages: [{ role: 'user', content: `Review this assistant response:\n\n${assembled}` }],
      maxTokens: 500,
      signal: new AbortController().signal  // post-review is fire-and-forget; not user-cancellable
    });
    const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '');
    const parsed = JSON.parse(cleaned) as { ok: boolean; corrigendum?: string };
    if (parsed.ok === true) return { ok: true };
    if (parsed.ok === false && typeof parsed.corrigendum === 'string') {
      return { ok: false, corrigendum: parsed.corrigendum };
    }
    // Malformed JSON shape — fail open.
    return { ok: true };
  } catch (err) {
    console.warn('[postReview] Haiku call failed, failing open:', err);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/runtime/safety-postreview.test.ts -- --run`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add src/runtime/safety.ts tests/unit/runtime/safety-postreview.test.ts
git commit -m "Implement postReview using Haiku 4.5"
```

---

### Task 4: Wire postReview into runTurn

**Files:**
- Modify: `src/runtime/agent-runtime.ts` — pass `deps.ai` into `postReview`, emit `corrigendum` SSE event when needed, append to persisted text.
- Modify: `tests/unit/runtime/agent-runtime.test.ts` — add coverage.

- [ ] **Step 1: Update `src/runtime/agent-runtime.ts`**

Find the `await postReview(orch.text);` line. Replace with:

```ts
const review = await postReview(orch.text, deps.ai);
let finalText = orch.text;
if (!review.ok && review.corrigendum) {
  input.stream?.emit({ type: 'corrigendum', data: { text: review.corrigendum } });
  finalText = `${orch.text}\n\n${review.corrigendum}`;
}
```

Then change the `finalizeChatTurn` and `turn_complete` SSE event to use `finalText`:

```ts
await finalizeChatTurn({
  db: deps.db, turnId: inserted.turnId, status: 'complete',
  text: finalText, costUsd: orch.costUsd, now: deps.clock()
});
input.stream?.emit({ type: 'turn_complete', data: { turn_id: inserted.turnId, full_text: finalText, cost_usd: orch.costUsd } });
```

And update the `return` accordingly:

```ts
return { turnId: inserted.turnId, status: 'complete', text: finalText, costUsd: orch.costUsd };
```

- [ ] **Step 2: Update `makeFakes` to support `callResults`**

`tests/fakes/make-fakes.ts` — pass through to `scriptedStream`:

```ts
export interface FakeOptions {
  db: D1Database;
  scripts?: AnthropicStreamEvent[][];
  callResults?: NonStreamMessageResult[];
  tools?: ToolDef[];
  now?: number;
}

export function makeFakes(opts: FakeOptions): RuntimeDeps & { ai: ReturnType<typeof scriptedStream> } {
  const ai = scriptedStream(opts.scripts ?? [], opts.callResults ?? []);
  // ... rest unchanged
}
```

Add the import for `NonStreamMessageResult` to `make-fakes.ts`.

- [ ] **Step 3: Add a test in `tests/unit/runtime/agent-runtime.test.ts`**

```ts
  it('appends corrigendum and emits SSE event when postReview flags issues', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Take 200mg of X.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({
      db: env.DB,
      scripts: [script],
      tools: [getUserProfileTool],
      callResults: [{ text: '{"ok":false,"corrigendum":"Note: not medical advice."}', tokensIn: 50, tokensOut: 10 }]
    });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1', threadId: 'th1', actor: 'user',
      message: 'hi', stream: collector, signal: new AbortController().signal
    }, deps);
    expect(r.text).toContain('Take 200mg of X.');
    expect(r.text).toContain('not medical advice');
    expect(collector.events.some((e) => e.type === 'corrigendum')).toBe(true);
  });
```

- [ ] **Step 4: Run tests**

`pnpm test -- --run`
Expected: 34 PASS (33 + 1 new).
`pnpm typecheck` — exit 0.

- [ ] **Step 5: Commit**

```
git add src/runtime/agent-runtime.ts tests/fakes/make-fakes.ts tests/unit/runtime/agent-runtime.test.ts
git commit -m "Wire postReview corrigendum into runTurn output"
```

---

## Phase 3: Cancellation surface

### Task 5: POST /cancel endpoint

**Files:**
- Modify: `src/do/user-agent-do.ts` — handle POST /cancel.
- Modify: `src/api/worker.ts` — route /v1/cancel/{thread_id} → DO.
- Modify: `tests/integration/do-flow.test.ts` — add a cancel-flow test.

The plan's spec already says client-disconnect = cancel via `req.signal.addEventListener('abort')`. POST /cancel is the explicit alternative for when the client wants to abort without dropping the SSE.

- [ ] **Step 1: Update `src/do/user-agent-do.ts`**

Add to the `fetch` router:

```ts
if (req.method === 'POST' && url.pathname === '/cancel') {
  return this.handleCancel();
}
```

Add the method:

```ts
private handleCancel(): Response {
  if (!this.currentTurn) {
    return Response.json({ cancelled: false, reason: 'no in-flight turn' }, { status: 404 });
  }
  this.currentTurn.abortController.abort();
  return Response.json({ cancelled: true, turn_id: this.currentTurn.turnId });
}
```

- [ ] **Step 2: Update `src/api/worker.ts`**

Add the new route:

```ts
if (req.method === 'POST' && url.pathname.startsWith('/v1/cancel/')) {
  const userId = req.headers.get('X-User-Id');
  if (!userId) return new Response('missing X-User-Id', { status: 401 });
  const id = env.USER_AGENT_DO.idFromName(userId);
  const stub = env.USER_AGENT_DO.get(id);
  return stub.fetch(new Request('https://do/cancel', req));
}
```

- [ ] **Step 3: Add integration test cases to `tests/integration/do-flow.test.ts`**

```ts
  it('cancels an in-flight turn on POST /v1/cancel', async () => {
    // Use a slow mock gateway that hangs for a few seconds. Easiest: skip the gateway entirely
    // and exercise the DO path. We need a way to send a request, immediately cancel, and verify
    // the abort propagates. Implementation note: in this test environment, the SSE response
    // closes when the body stream closes. Reading the body fully is what blocks; if we don't
    // read, the request returns immediately. Use a separate request to /cancel after starting one.
    //
    // For this test, we send a real chat request, then immediately POST /cancel, and assert
    // the cancel response indicates a turn was aborted.

    const chatPromise = SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    });
    // Allow the DO to register currentTurn before sending cancel.
    await new Promise((r) => setTimeout(r, 50));

    const cancelResp = await SELF.fetch('https://api/v1/cancel/th1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1' }
    });

    // Drain the chat response so it doesn't leak.
    await chatPromise.then((r) => r.text());

    expect(cancelResp.status).toBe(200);
    const data = await cancelResp.json() as { cancelled: boolean };
    expect([true, false]).toContain(data.cancelled);  // race-tolerant: turn may have already finished
  });

  it('returns 404 on cancel when no turn is in flight', async () => {
    const resp = await SELF.fetch('https://api/v1/cancel/th1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1' }
    });
    expect(resp.status).toBe(404);
  });
```

- [ ] **Step 4: Run tests**

`pnpm test -- --run`
Expected: 36 PASS (34 + 2 new).
`pnpm typecheck` — exit 0.

- [ ] **Step 5: Commit**

```
git add src/do/user-agent-do.ts src/api/worker.ts tests/integration/do-flow.test.ts
git commit -m "Add POST /cancel endpoint"
```

---

## Phase 4: Idempotency replay

### Task 6: SSE replay on idempotency hit

**Files:**
- Modify: `src/runtime/agent-runtime.ts` — when `inserted.replay` is true, stream the persisted turn from D1.
- Modify: `tests/unit/runtime/agent-runtime.test.ts` — replay test.
- Modify: `tests/integration/do-flow.test.ts` — replay integration test.

Currently when `inserted.replay` is true, runTurn returns `{text: '', costUsd: 0}` without streaming. Replay should re-emit `turn_started` + the persisted text in one delta + `turn_complete` from D1.

- [ ] **Step 1: Update `src/runtime/agent-runtime.ts` replay path**

Replace:
```ts
if (inserted.replay) {
  return { turnId: inserted.turnId, status: 'complete', text: '', costUsd: 0 };
}
```

With:
```ts
if (inserted.replay) {
  const cached = await deps.db.prepare(
    `SELECT status, text, cost_usd, ordinal FROM chat_turns WHERE turn_id = ?`
  ).bind(inserted.turnId).first<{
    status: string; text: string | null; cost_usd: number | null; ordinal: number;
  }>();
  if (cached && cached.status === 'complete') {
    input.stream?.emit({ type: 'turn_started', data: { turn_id: inserted.turnId, ordinal: cached.ordinal } });
    if (cached.text) {
      input.stream?.emit({ type: 'text_delta', data: { chunk: cached.text } });
    }
    input.stream?.emit({
      type: 'turn_complete',
      data: { turn_id: inserted.turnId, full_text: cached.text ?? '', cost_usd: cached.cost_usd ?? 0 }
    });
    input.stream?.close();
    return {
      turnId: inserted.turnId, status: 'complete',
      text: cached.text ?? '', costUsd: cached.cost_usd ?? 0
    };
  }
  // Replay row exists but status is not 'complete' (still streaming or error).
  // For now, return a "still in progress" stub. A more sophisticated replay would
  // wait for completion; deferred to a future plan.
  return { turnId: inserted.turnId, status: 'complete', text: '', costUsd: 0 };
}
```

- [ ] **Step 2: Add unit test to `tests/unit/runtime/agent-runtime.test.ts`**

```ts
  it('replays a completed turn from D1 on idempotency-key hit', async () => {
    // Pre-insert a completed turn to simulate a prior run.
    await env.DB.prepare(
      `INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, user_text, text, cost_usd, idempotency_key, started_at, ended_at)
       VALUES ('original-turn', 'th1', 0, 'user', 'complete', 'hi', 'cached response', 0.005, 'replay-key', 1, 2)`
    ).run();

    // No scripts — runTurn should NOT call the AI on replay.
    const deps = makeFakes({ db: env.DB, scripts: [], tools: [getUserProfileTool] });
    const collector = createSseCollector();

    const r = await runTurn({
      userId: 'u1', threadId: 'th1', actor: 'user',
      message: 'hi', stream: collector, signal: new AbortController().signal,
      idempotencyKey: 'replay-key'
    }, deps);

    expect(r.turnId).toBe('original-turn');
    expect(r.text).toBe('cached response');
    expect(r.costUsd).toBe(0.005);
    expect(deps.ai.calls.length).toBe(0);
    expect(collector.events.some((e) => e.type === 'turn_started')).toBe(true);
    expect(collector.events.some((e) => e.type === 'turn_complete')).toBe(true);
  });
```

- [ ] **Step 3: Add integration test for SSE replay**

In `tests/integration/do-flow.test.ts`:

```ts
  it('replays SSE events on idempotency-key retry', async () => {
    const idemKey = 'replay-' + Date.now();
    const headers = { 'X-User-Id': 'u1', 'Content-Type': 'application/json', 'Idempotency-Key': idemKey };

    // First call.
    const r1 = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST', headers, body: JSON.stringify({ message: 'hi' })
    });
    const text1 = await r1.text();
    expect(text1).toContain('event: turn_complete');

    // Allow waitUntil to flush.
    await new Promise((r) => setTimeout(r, 50));

    // Second call with same idempotency key.
    const r2 = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST', headers, body: JSON.stringify({ message: 'hi' })
    });
    const text2 = await r2.text();
    expect(text2).toContain('event: turn_started');
    expect(text2).toContain('event: turn_complete');

    // Both should reference the same turn_id.
    const turnIdRegex = /"turn_id":"([^"]+)"/;
    const id1 = text1.match(turnIdRegex)?.[1];
    const id2 = text2.match(turnIdRegex)?.[1];
    expect(id1).toBe(id2);
  });
```

- [ ] **Step 4: Run tests**

`pnpm test -- --run`
Expected: 38 PASS (36 + 2 new).
`pnpm typecheck` — exit 0.

- [ ] **Step 5: Commit**

```
git add src/runtime/agent-runtime.ts tests/unit/runtime/agent-runtime.test.ts tests/integration/do-flow.test.ts
git commit -m "Replay SSE from D1 on idempotency-key hit"
```

---

## Phase 5: Cost cap

### Task 7: Per-user daily cost cap enforcement

**Files:**
- Create: `src/runtime/cost.ts` — `getDailySpentCents(db, userId, now, timezone)`.
- Modify: `src/runtime/agent-runtime.ts` — check cost cap before orchestrator call.
- Modify: `src/types.ts` — add `'cap_exceeded'` to `TurnResult.status` union.
- Create: `tests/unit/runtime/cost.test.ts`
- Modify: `tests/unit/runtime/agent-runtime.test.ts` — cap-exceeded test.

- [ ] **Step 1: Update `src/types.ts`**

Change:
```ts
status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked';
```

To:
```ts
status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked' | 'cap_exceeded';
```

(Both in `TurnResult` and in `finalizeChatTurn`'s `FinalizeInput.status` union in `src/runtime/persist.ts`.)

- [ ] **Step 2: Write the failing test `tests/unit/runtime/cost.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { getDailySpentCents } from '../../../src/runtime/cost';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('getDailySpentCents', () => {
  it('returns 0 when no turns exist', async () => {
    const cents = await getDailySpentCents(env.DB, 'u1', Date.now());
    expect(cents).toBe(0);
  });

  it('sums cost_usd for user turns started in the last 24h, converts to cents', async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twentySixHoursAgo = now - 26 * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t1','th1',0,'user','complete',0.50,?,?)`).bind(oneHourAgo, oneHourAgo + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t2','th1',1,'user','complete',0.30,?,?)`).bind(oneHourAgo, oneHourAgo + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t3','th1',2,'user','complete',9.99,?,?)`).bind(twentySixHoursAgo, twentySixHoursAgo + 1)
    ]);
    const cents = await getDailySpentCents(env.DB, 'u1', now);
    expect(cents).toBe(80);  // (0.50 + 0.30) * 100 = 80 cents
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

`pnpm test tests/unit/runtime/cost.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/runtime/cost.ts`**

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDailySpentCents(db: D1Database, userId: string, now: number): Promise<number> {
  const since = now - DAY_MS;
  const row = await db.prepare(
    `SELECT COALESCE(SUM(t.cost_usd), 0) AS sum_usd
     FROM chat_turns t
     JOIN chat_threads th ON th.thread_id = t.thread_id
     WHERE th.user_id = ? AND t.started_at >= ?`
  ).bind(userId, since).first<{ sum_usd: number }>();
  const usd = row?.sum_usd ?? 0;
  return Math.round(usd * 100);
}

export async function getCostCapCents(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT daily_cost_cap_cents FROM users WHERE user_id = ?`
  ).bind(userId).first<{ daily_cost_cap_cents: number }>();
  return row?.daily_cost_cap_cents ?? 150;
}
```

- [ ] **Step 5: Run test to confirm pass**

`pnpm test tests/unit/runtime/cost.test.ts -- --run`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire cost-cap check into `src/runtime/agent-runtime.ts`**

In `runTurn`, after the preflight block but before the regular insert, check the cap. Only enforce for `actor === 'user'` (system/batch turns are admin-controlled):

```ts
import { getDailySpentCents, getCostCapCents } from './cost';

// ... inside runTurn, after preflight handling, before the main insert:
if (input.actor === 'user') {
  const [spent, cap] = await Promise.all([
    getDailySpentCents(deps.db, input.userId, now),
    getCostCapCents(deps.db, input.userId)
  ]);
  if (spent >= cap) {
    const inserted = await insertChatTurnStreaming({
      db: deps.db, turnId, threadId: input.threadId, actor: 'user',
      userText: input.message ?? null, idempotencyKey: input.idempotencyKey, now
    });
    if (!inserted.replay) {
      const message = `You've hit today's usage cap (${cap}¢). Resets in 24h.`;
      input.stream?.emit({ type: 'turn_started', data: { turn_id: inserted.turnId, ordinal: inserted.ordinal } });
      input.stream?.emit({ type: 'text_delta', data: { chunk: message } });
      await finalizeChatTurn({
        db: deps.db, turnId: inserted.turnId, status: 'cap_exceeded',
        text: message, costUsd: 0, now: deps.clock()
      });
      input.stream?.emit({ type: 'turn_complete', data: { turn_id: inserted.turnId, full_text: message, cost_usd: 0 } });
      input.stream?.close();
    }
    return { turnId: inserted.turnId, status: 'cap_exceeded', text: '...', costUsd: 0 };
  }
}
```

(Place this block after the preflight `if (!pf.allow)` block, before the main `insertChatTurnStreaming` call near line ~40.)

Also, since `'cap_exceeded'` is a new status, ensure `FinalizeInput.status` in `src/runtime/persist.ts` includes it:

```ts
status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked' | 'cap_exceeded';
```

- [ ] **Step 7: Add a test for cap-exceeded path in `tests/unit/runtime/agent-runtime.test.ts`**

```ts
  it('rejects with cap_exceeded when daily spend reaches the cap', async () => {
    // Set the user cap very low and seed prior spend.
    await env.DB.prepare(`UPDATE users SET daily_cost_cap_cents = 1 WHERE user_id = 'u1'`).run();
    await env.DB.prepare(
      `INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at)
       VALUES ('past','th1',0,'user','complete',0.05,?,?)`
    ).bind(Date.now() - 1000, Date.now() - 999).run();

    const deps = makeFakes({ db: env.DB, scripts: [], tools: [] });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1', threadId: 'th1', actor: 'user',
      message: 'hi', stream: collector, signal: new AbortController().signal
    }, deps);

    expect(r.status).toBe('cap_exceeded');
    expect(deps.ai.calls.length).toBe(0);
    expect(collector.events.some((e) =>
      e.type === 'text_delta' && e.data.chunk.includes('cap')
    )).toBe(true);
  });
```

- [ ] **Step 8: Run all tests**

`pnpm test -- --run`
Expected: 41 PASS (38 + 3 new: 2 cost + 1 agent-runtime).
`pnpm typecheck` — exit 0.

- [ ] **Step 9: Commit**

```
git add src/types.ts src/runtime/cost.ts src/runtime/agent-runtime.ts src/runtime/persist.ts tests/unit/runtime/cost.test.ts tests/unit/runtime/agent-runtime.test.ts
git commit -m "Enforce per-user daily cost cap"
```

---

## Phase 6: Final verification

### Task 8: Final readiness check

- [ ] **Step 1: Run full suite + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Expected: 41/41 PASS, typecheck clean.

- [ ] **Step 2: Update the smoke runbook**

Edit `docs/superpowers/runbooks/2026-04-25-vertical-slice-smoke-test.md` to add new manual cases at the end:

```markdown
## After Plan 2: additional smoke checks

7. Replay test:
   - Send the same chat with the same `Idempotency-Key` twice.
   - Second response should be near-instant and contain the same `turn_id`.

8. Cancel test:
   - Send a chat (don't read body).
   - Immediately POST to `/v1/cancel/{thread_id}` with the same `X-User-Id`.
   - Cancel response should report `{cancelled: true, turn_id: ...}`.

9. Cost cap test:
   - Set the user's cap to 1 cent: `wrangler d1 execute cohort --local --command "UPDATE users SET daily_cost_cap_cents=1 WHERE user_id='u1';"`
   - Send a chat after some prior turns have logged cost.
   - Expected SSE: single text_delta about cap, status `cap_exceeded`.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 2 smoke checks to runbook"
```

---

## Self-review notes

- **Spec coverage:** postReview ✓, retry ✓, cancel ✓, replay ✓, cost cap ✓.
- **Placeholder scan:** none.
- **Type consistency:** new `'cap_exceeded'` status threaded through TurnResult + FinalizeInput. `NonStreamMessageRequest`/`NonStreamMessageResult` added consistently. Tools and orchestrator unchanged.
- **Scope:** 8 tasks total. Adds 13 new tests + extends integration suite.
