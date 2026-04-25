# Agent Runtime DO — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end vertical slice of the agent runtime: deployed Worker that accepts `POST /v1/chat/{thread_id}`, dispatches to a per-user `UserAgentDO`, runs one Anthropic Opus 4.7 turn with one tool (`get_user_profile`), streams typed SSE events back to the client, and persists the turn to D1. All unit and Miniflare integration tests green.

**Architecture:** Cloudflare Workers + Durable Objects. `UserAgentDO` (one per user) is a thin HTTP/SSE shell that delegates to an environment-free `AgentRuntime` library. Per the approved design, the runtime library is unit-testable with injected fakes; the DO holds only in-memory transient state for the in-flight turn.

**Tech Stack:** TypeScript (strict), Cloudflare Workers (compatibility flags `nodejs_compat`), Durable Objects, D1, AI Gateway → Anthropic, `vitest` + `@cloudflare/vitest-pool-workers`, `wrangler`.

**Spec:** `docs/superpowers/specs/2026-04-25-agent-runtime-do-design.md`

**Out of scope for this plan (deferred to follow-up plans):**
- Tools other than `get_user_profile` (8 remaining tools).
- `postReview` (Haiku safety review). Stubbed as no-op in this plan.
- `alarm()` and batch turn path. DO has the method as `Promise.resolve()` for now.
- Cancellation endpoint and SSE replay (idempotency).
- Cost cap enforcement.
- Janitor cron worker.
- Smoke tests against deployed staging.

**Spec coverage in this plan:**
- ✓ Architecture: `UserAgentDO` + `AgentRuntime` + tool registry, with `buildContext` → preflight → orchestrator → persist (post-review stubbed). All five runtime invariants.
- ✓ Components: `UserAgentDO` (POST /chat only), `AgentRuntime`, tool registry, `preflightSafety` (deterministic), D1 schema (full schema from spec), SSE event protocol (full).
- ✓ Data flow: interactive turn happy path. Cancellation deferred. Batch deferred. Idempotency deferred.
- ✓ Error handling: Anthropic 5xx + retry, persistTurn failure → log, slow client abort. Cost cap deferred. DO crash → janitor sweep deferred.
- ✓ Testing: Layer 1 (runtime unit), Layer 2 (one tool unit), Layer 3 (DO integration with Miniflare). Layers 4–5 deferred.

---

## File Structure

```
.gitignore
package.json
tsconfig.json
wrangler.toml
vitest.config.ts

src/
  types.ts                              # shared types (Env, RuntimeDeps, TurnInput, ToolDef, SseEvent)
  do/user-agent-do.ts                   # UserAgentDO class
  api/worker.ts                         # api Worker entrypoint (default export)
  runtime/
    agent-runtime.ts                    # runTurn() top-level
    build-context.ts                    # buildContext()
    orchestrator.ts                     # runOrchestrator()
    persist.ts                          # persistTurn() + insertChatTurnStreaming()
    safety.ts                           # preflightSafety() + postReview() stub
    sse.ts                              # SseWriter
    ai-gateway.ts                       # AIGatewayClient (streaming)
    tool-registry.ts                    # buildToolRegistry()
  tools/
    get-user-profile.ts                 # first tool
  safety-data/
    dangerous-topics.json               # preflight rules (seed list)
  db/
    migrations/0001_initial.sql         # full D1 schema

tests/
  fakes/
    make-fakes.ts                       # makeFakes() factory
    scripted-stream.ts                  # scriptedStream() — fake AIGatewayClient
    sse-collector.ts                    # in-memory SseWriter for assertions
  unit/
    runtime/
      sse.test.ts
      ai-gateway.test.ts
      build-context.test.ts
      safety.test.ts
      persist.test.ts
      orchestrator.test.ts
      agent-runtime.test.ts
    tools/
      get-user-profile.test.ts
  integration/
    do-flow.test.ts
```

Each file has one clear responsibility. The runtime modules each export one primary function plus its types. Tools are one file each, registered in `tool-registry.ts`.

---

## Phase 1: Foundation

### Task 1: Project bootstrap

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
.dev.vars.local
dist/
coverage/
*.log
.DS_Store
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "cohort",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:apply": "wrangler d1 execute cohort --local --file=src/db/migrations/0001_initial.sql"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.90.0"
  },
  "dependencies": {
    "ulid": "^2.3.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 4: Create `wrangler.toml`**

```toml
name = "cohort-api"
main = "src/api/worker.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "cohort"
database_id = "PLACEHOLDER_FILLED_BY_WRANGLER_D1_CREATE"

[[durable_objects.bindings]]
name = "USER_AGENT_DO"
class_name = "UserAgentDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserAgentDO"]

[vars]
AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/REPLACE_ACCT/REPLACE_GW/anthropic"
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          durableObjects: { USER_AGENT_DO: 'UserAgentDO' }
        }
      }
    }
  }
});
```

- [ ] **Step 6: Create stub source files so vitest-pool-workers can boot**

The test pool loads `main` from `wrangler.toml` at startup, and that worker must export the `UserAgentDO` class referenced by the DO binding. Stub them now; Task 14 fills in the real implementations.

Create `src/api/worker.ts`:
```ts
export { UserAgentDO } from '../do/user-agent-do';

export default {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
};
```

Create `src/do/user-agent-do.ts`:
```ts
export class UserAgentDO {
  state: DurableObjectState;
  env: unknown;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
  }

  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
```

- [ ] **Step 7: Install dependencies and verify typecheck**

Run:
```
pnpm install
pnpm typecheck
```
Expected: `pnpm install` completes; `pnpm typecheck` exits 0.

- [ ] **Step 8: Commit**

```
git add .gitignore package.json tsconfig.json wrangler.toml vitest.config.ts pnpm-lock.yaml src/api/worker.ts src/do/user-agent-do.ts
git commit -m "Bootstrap project"
```

---

### Task 2: D1 schema migration

**Files:**
- Create: `src/db/migrations/0001_initial.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- src/db/migrations/0001_initial.sql

CREATE TABLE users (
  user_id              TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  timezone             TEXT NOT NULL,
  age_years            INTEGER,
  dietary_pattern      TEXT,
  allergies_json       TEXT NOT NULL DEFAULT '[]',
  dislikes_json        TEXT NOT NULL DEFAULT '[]',
  daily_cost_cap_cents INTEGER NOT NULL DEFAULT 150,
  created_at           INTEGER NOT NULL
);

CREATE TABLE chat_threads (
  thread_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_threads_user ON chat_threads(user_id);

CREATE TABLE chat_turns (
  turn_id          TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  actor            TEXT NOT NULL,
  status           TEXT NOT NULL,
  text             TEXT,
  user_text        TEXT,
  cost_usd         REAL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  error            TEXT,
  idempotency_key  TEXT
);

CREATE INDEX idx_chat_turns_thread_ordinal ON chat_turns(thread_id, ordinal);
CREATE UNIQUE INDEX uq_chat_turns_idem
  ON chat_turns(thread_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE chat_tool_calls (
  turn_id          TEXT NOT NULL,
  call_index       INTEGER NOT NULL,
  tool_name        TEXT NOT NULL,
  input_json       TEXT NOT NULL,
  output_json      TEXT,
  idempotency_key  TEXT,
  duration_ms      INTEGER,
  error            TEXT,
  PRIMARY KEY (turn_id, call_index)
);

CREATE UNIQUE INDEX uq_chat_tool_calls_idem
  ON chat_tool_calls(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

- [ ] **Step 2: Apply the migration locally**

Run:
```
pnpm db:apply
```
Expected: wrangler reports the migration applied to the local D1. (If `wrangler d1 create cohort` hasn't been run yet, run it first; it will print a `database_id` to paste into `wrangler.toml`.)

- [ ] **Step 3: Verify schema**

Run:
```
wrangler d1 execute cohort --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```
Expected output includes: `chat_threads, chat_tool_calls, chat_turns, users`.

- [ ] **Step 4: Commit**

```
git add src/db/migrations/0001_initial.sql wrangler.toml
git commit -m "Add D1 initial schema"
```

---

### Task 3: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export interface Env {
  DB: D1Database;
  USER_AGENT_DO: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_URL: string;
}

export interface RuntimeDeps {
  db: D1Database;
  ai: AIGatewayClient;
  tools: ToolRegistry;
  clock: () => number;
}

export interface TurnInput {
  userId: string;
  threadId: string;
  actor: 'user' | 'system';
  message?: string;
  systemHint?: string;
  stream: SseWriter | null;
  signal: AbortSignal;
  idempotencyKey?: string;
}

export interface TurnResult {
  turnId: string;
  status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked';
  text: string;
  costUsd: number;
}

export type SseEvent =
  | { type: 'turn_started';     data: { turn_id: string; ordinal: number } }
  | { type: 'text_delta';       data: { chunk: string } }
  | { type: 'tool_call_start';  data: { call_index: number; tool: string; input: unknown } }
  | { type: 'tool_call_result'; data: { call_index: number; summary: string } }
  | { type: 'corrigendum';      data: { text: string } }
  | { type: 'turn_complete';    data: { turn_id: string; full_text: string; cost_usd: number } }
  | { type: 'error';            data: { message: string; retryable: boolean } };

export interface SseWriter {
  emit(event: SseEvent): void;
  close(): void;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  surface: 'visible' | 'hidden';
  idempotent: boolean;
  handler(input: I, ctx: ToolCtx): Promise<O>;
}

export interface ToolCtx {
  userId: string;
  threadId: string;
  turnId: string;
  toolCallIndex: number;
  deps: RuntimeDeps;
  emit(event: SseEvent): void;
  signal: AbortSignal;
}

export type ToolRegistry = ReadonlyMap<string, ToolDef>;

export interface AIGatewayClient {
  streamMessage(req: StreamMessageRequest): AsyncIterable<AnthropicStreamEvent>;
}

export interface StreamMessageRequest {
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicStreamEvent =
  | { type: 'message_start';        usage: { input_tokens: number } }
  | { type: 'content_block_start';  index: number; block: { type: 'text' } | { type: 'tool_use'; id: string; name: string } }
  | { type: 'content_block_delta';  index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop';   index: number }
  | { type: 'message_delta';        stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'; usage: { output_tokens: number } }
  | { type: 'message_stop' };
```

- [ ] **Step 2: Typecheck**

Run:
```
pnpm typecheck
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```
git add src/types.ts
git commit -m "Add shared runtime types"
```

---

## Phase 2: Test Infrastructure

### Task 4: Test fakes

**Files:**
- Create: `tests/fakes/sse-collector.ts`
- Create: `tests/fakes/scripted-stream.ts`
- Create: `tests/fakes/make-fakes.ts`
- Create: `tests/fakes/seed.ts`

- [ ] **Step 1: Write `tests/fakes/sse-collector.ts`**

```ts
import type { SseEvent, SseWriter } from '../../src/types';

export function createSseCollector(): SseWriter & { events: SseEvent[]; closed: boolean } {
  const events: SseEvent[] = [];
  let closed = false;
  return {
    emit(event) { events.push(event); },
    close() { closed = true; },
    get events() { return events; },
    get closed() { return closed; }
  } as any;
}
```

- [ ] **Step 2: Write `tests/fakes/scripted-stream.ts`**

```ts
import type { AIGatewayClient, AnthropicStreamEvent, StreamMessageRequest } from '../../src/types';

export function scriptedStream(scripts: AnthropicStreamEvent[][]): AIGatewayClient & { calls: StreamMessageRequest[] } {
  let nextCall = 0;
  const calls: StreamMessageRequest[] = [];
  return {
    async *streamMessage(req: StreamMessageRequest) {
      calls.push(req);
      const script = scripts[nextCall++];
      if (!script) throw new Error('scriptedStream: no more scripts');
      for (const ev of script) {
        if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield ev;
      }
    },
    get calls() { return calls; }
  } as any;
}
```

- [ ] **Step 3: Write `tests/fakes/make-fakes.ts`**

```ts
import type { AnthropicStreamEvent, RuntimeDeps, ToolDef, ToolRegistry } from '../../src/types';
import { scriptedStream } from './scripted-stream';

export interface FakeOptions {
  db: D1Database;
  scripts?: AnthropicStreamEvent[][];
  tools?: ToolDef[];
  now?: number;
}

export function makeFakes(opts: FakeOptions): RuntimeDeps & {
  ai: ReturnType<typeof scriptedStream>;
} {
  const ai = scriptedStream(opts.scripts ?? []);
  const tools: ToolRegistry = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const fixedNow = opts.now ?? 1_700_000_000_000;
  return {
    db: opts.db,
    ai,
    tools,
    clock: () => fixedNow
  };
}
```

- [ ] **Step 4: Write `tests/fakes/seed.ts`**

Miniflare provisions an empty D1 instance per test environment. We need to apply our schema before each test that touches D1. Hardcoding the schema string here (rather than reading the migration file) avoids Vite-import gymnastics inside the Workers runtime.

```ts
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id              TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  timezone             TEXT NOT NULL,
  age_years            INTEGER,
  dietary_pattern      TEXT,
  allergies_json       TEXT NOT NULL DEFAULT '[]',
  dislikes_json        TEXT NOT NULL DEFAULT '[]',
  daily_cost_cap_cents INTEGER NOT NULL DEFAULT 150,
  created_at           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id);
CREATE TABLE IF NOT EXISTS chat_turns (
  turn_id          TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  actor            TEXT NOT NULL,
  status           TEXT NOT NULL,
  text             TEXT,
  user_text        TEXT,
  cost_usd         REAL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  error            TEXT,
  idempotency_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_thread_ordinal ON chat_turns(thread_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_turns_idem ON chat_turns(thread_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS chat_tool_calls (
  turn_id          TEXT NOT NULL,
  call_index       INTEGER NOT NULL,
  tool_name        TEXT NOT NULL,
  input_json       TEXT NOT NULL,
  output_json      TEXT,
  idempotency_key  TEXT,
  duration_ms      INTEGER,
  error            TEXT,
  PRIMARY KEY (turn_id, call_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_tool_calls_idem ON chat_tool_calls(idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

export async function applySchema(db: D1Database): Promise<void> {
  await db.exec(SCHEMA.replace(/\n/g, ' '));
}

export async function resetDb(db: D1Database): Promise<void> {
  await applySchema(db);
  await db.exec('DELETE FROM chat_tool_calls; DELETE FROM chat_turns; DELETE FROM chat_threads; DELETE FROM users;');
}
```

(Note: D1's `exec` requires statements separated by semicolons on a single line — hence the `replace(/\n/g, ' ')`.)

- [ ] **Step 5: Typecheck**

Run:
```
pnpm typecheck
```
Expected: exits 0.

- [ ] **Step 6: Commit**

```
git add tests/fakes/
git commit -m "Add test fakes for runtime"
```

---

## Phase 3: Runtime Building Blocks

### Task 5: SSE writer

**Files:**
- Create: `src/runtime/sse.ts`
- Create: `tests/unit/runtime/sse.test.ts`

- [ ] **Step 1: Write the failing test `tests/unit/runtime/sse.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createSseStreamWriter } from '../../../src/runtime/sse';

describe('createSseStreamWriter', () => {
  it('emits events as SSE-framed chunks', async () => {
    const { writer, response } = createSseStreamWriter();
    writer.emit({ type: 'turn_started', data: { turn_id: 't1', ordinal: 0 } });
    writer.emit({ type: 'text_delta', data: { chunk: 'hi' } });
    writer.close();

    const text = await response.text();
    expect(text).toContain('event: turn_started');
    expect(text).toContain('data: {"turn_id":"t1","ordinal":0}');
    expect(text).toContain('event: text_delta');
    expect(text).toContain('data: {"chunk":"hi"}');
    expect(text.endsWith('\n\n')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/sse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runtime/sse.ts`**

```ts
import type { SseEvent, SseWriter } from '../types';

export function createSseStreamWriter(): { writer: SseWriter; response: Response } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sse: SseWriter = {
    emit(event: SseEvent) {
      const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      writer.write(encoder.encode(frame)).catch(() => {});
    },
    close() {
      writer.close().catch(() => {});
    }
  };

  const response = new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive'
    }
  });

  return { writer: sse, response };
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/runtime/sse.ts tests/unit/runtime/sse.test.ts
git commit -m "Add SSE stream writer"
```

---

### Task 6: AI Gateway client (streaming)

**Files:**
- Create: `src/runtime/ai-gateway.ts`
- Create: `tests/unit/runtime/ai-gateway.test.ts`

The production `AIGatewayClient` posts to AI Gateway with `stream: true` and parses Anthropic's SSE event stream. Tests use a stub `fetch` that returns a hand-crafted event stream.

- [ ] **Step 1: Write the failing test `tests/unit/runtime/ai-gateway.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(s));
      controller.close();
    }
  });
}

describe('createAIGatewayClient', () => {
  it('parses Anthropic SSE events into typed events', async () => {
    const sseBody = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      ''
    ].join('\n');

    const fakeFetch = async () =>
      new Response(streamFromString(sseBody), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const client = createAIGatewayClient({
      url: 'https://example/anthropic',
      apiKey: 'k',
      fetch: fakeFetch as typeof fetch
    });

    const events: any[] = [];
    for await (const ev of client.streamMessage({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal
    })) {
      events.push(ev);
    }

    expect(events[0].type).toBe('message_start');
    expect(events.find((e) => e.type === 'content_block_delta').delta.text).toBe('hi');
    expect(events.find((e) => e.type === 'message_delta').stop_reason).toBe('end_turn');
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/ai-gateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runtime/ai-gateway.ts`**

```ts
import type { AIGatewayClient, AnthropicStreamEvent, StreamMessageRequest } from '../types';

export interface AIGatewayConfig {
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const MODEL = 'claude-opus-4-7';

export function createAIGatewayClient(cfg: AIGatewayConfig): AIGatewayClient {
  const fetchImpl = cfg.fetch ?? fetch;

  return {
    async *streamMessage(req: StreamMessageRequest): AsyncIterable<AnthropicStreamEvent> {
      const body = {
        model: MODEL,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        max_tokens: req.maxTokens,
        stream: true
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
      if (!resp.ok || !resp.body) {
        const errText = resp.body ? await resp.text() : '';
        throw new Error(`AI Gateway ${resp.status}: ${errText}`);
      }
      yield* parseAnthropicSse(resp.body);
    }
  };
}

async function* parseAnthropicSse(body: ReadableStream<Uint8Array>): AsyncIterable<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      const parsed = JSON.parse(json);
      yield normalizeEvent(parsed);
    }
  }
}

function normalizeEvent(raw: any): AnthropicStreamEvent {
  if (raw.type === 'message_start') {
    return { type: 'message_start', usage: { input_tokens: raw.message?.usage?.input_tokens ?? 0 } };
  }
  if (raw.type === 'content_block_start') {
    const block = raw.content_block;
    return { type: 'content_block_start', index: raw.index, block };
  }
  if (raw.type === 'content_block_delta') {
    return { type: 'content_block_delta', index: raw.index, delta: raw.delta };
  }
  if (raw.type === 'content_block_stop') {
    return { type: 'content_block_stop', index: raw.index };
  }
  if (raw.type === 'message_delta') {
    return {
      type: 'message_delta',
      stop_reason: raw.delta?.stop_reason ?? 'end_turn',
      usage: { output_tokens: raw.usage?.output_tokens ?? 0 }
    };
  }
  if (raw.type === 'message_stop') {
    return { type: 'message_stop' };
  }
  throw new Error(`unknown anthropic event: ${raw.type}`);
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/ai-gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/runtime/ai-gateway.ts tests/unit/runtime/ai-gateway.test.ts
git commit -m "Add AI Gateway streaming client"
```

---

### Task 7: buildContext

**Files:**
- Create: `src/runtime/build-context.ts`
- Create: `tests/unit/runtime/build-context.test.ts`

`buildContext` reads the user's profile and the last 20 (user) or 5 (system) messages of conversational history, returning a structured context object the orchestrator passes to Claude.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/runtime/build-context.test.ts
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
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/build-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runtime/build-context.ts`**

```ts
export interface BuildContextInput {
  db: D1Database;
  userId: string;
  threadId: string;
  actor: 'user' | 'system';
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  timezone: string;
  age_years: number | null;
  dietary_pattern: string | null;
  allergies: string[];
  dislikes: string[];
}

export interface RecentMessage {
  ordinal: number;
  actor: 'user' | 'assistant' | 'system';
  user_text: string | null;
  text: string | null;
}

export interface RuntimeContext {
  profile: UserProfile;
  recentMessages: RecentMessage[];
}

export async function buildContext(input: BuildContextInput): Promise<RuntimeContext> {
  const profileRow = await input.db.prepare(
    `SELECT user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json
     FROM users WHERE user_id = ?`
  ).bind(input.userId).first<{
    user_id: string;
    display_name: string;
    timezone: string;
    age_years: number | null;
    dietary_pattern: string | null;
    allergies_json: string;
    dislikes_json: string;
  }>();

  if (!profileRow) throw new Error(`user not found: ${input.userId}`);

  const profile: UserProfile = {
    user_id: profileRow.user_id,
    display_name: profileRow.display_name,
    timezone: profileRow.timezone,
    age_years: profileRow.age_years,
    dietary_pattern: profileRow.dietary_pattern,
    allergies: JSON.parse(profileRow.allergies_json) as string[],
    dislikes: JSON.parse(profileRow.dislikes_json) as string[]
  };

  const limit = input.actor === 'user' ? 20 : 5;
  const rows = await input.db.prepare(
    `SELECT ordinal, actor, user_text, text
     FROM chat_turns
     WHERE thread_id = ? AND status = 'complete'
     ORDER BY ordinal DESC
     LIMIT ?`
  ).bind(input.threadId, limit).all<RecentMessage>();

  const recentMessages = (rows.results ?? []).reverse();
  return { profile, recentMessages };
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/build-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add src/runtime/build-context.ts tests/unit/runtime/build-context.test.ts
git commit -m "Add buildContext"
```

---

### Task 8: preflightSafety + dangerous-topics.json

**Files:**
- Create: `src/safety-data/dangerous-topics.json`
- Create: `src/runtime/safety.ts`
- Create: `tests/unit/runtime/safety.test.ts`

- [ ] **Step 1: Write `src/safety-data/dangerous-topics.json` (seed list)**

```json
{
  "patterns": [
    {
      "id": "medication_dosage",
      "regex": "(?i)(should i|can i|is it ok to)\\s+take\\s+\\d+\\s*(mg|mcg|g|ml)",
      "redirect": "That's a medication dosing question — please ask your pharmacist or prescribing physician. I can help with training, nutrition, sleep, and recovery questions instead."
    },
    {
      "id": "drug_interaction",
      "regex": "(?i)\\b(interact|interaction)\\b.*\\b(with|and)\\b.*(medication|drug|pill)",
      "redirect": "Drug interaction questions need a pharmacist or your doctor. I can help with training, nutrition, sleep, and recovery questions."
    },
    {
      "id": "self_diagnosis",
      "regex": "(?i)(do i have|am i (suffering from|developing))\\s+(diabetes|cancer|adhd|depression|anxiety|hypertension|thyroid|deficiency)",
      "redirect": "I can't help with diagnosis. Please talk to a clinician. I can help with training, nutrition, sleep, and recovery questions."
    },
    {
      "id": "low_calorie_floor",
      "regex": "(?i)(should i (cut|drop) to|target|hit)\\s+(?<kcal>\\d{3,4})\\s*(kcal|cal|calories)",
      "kcalMaxFloor": 1200,
      "redirect": "Sustained intakes below 1200 kcal aren't appropriate without a registered dietitian's supervision. Want to talk about a sustainable cut instead?"
    }
  ]
}
```

- [ ] **Step 2: Write the failing test `tests/unit/runtime/safety.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { preflightSafety } from '../../../src/runtime/safety';

describe('preflightSafety', () => {
  it('allows benign messages', () => {
    expect(preflightSafety('what should I eat for breakfast?').allow).toBe(true);
  });

  it('blocks medication dosing questions', () => {
    const r = preflightSafety('Should I take 200mg of caffeine?');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('medication_dosage');
    expect(r.cannedResponse).toContain('pharmacist');
  });

  it('blocks self-diagnosis questions', () => {
    const r = preflightSafety('Do I have iron deficiency?');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('self_diagnosis');
  });

  it('blocks low-calorie target questions below the floor', () => {
    const r = preflightSafety('Should I cut to 1100 kcal?');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('low_calorie_floor');
  });

  it('allows above-floor calorie targets', () => {
    expect(preflightSafety('Should I target 1800 kcal?').allow).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/safety.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/runtime/safety.ts`**

```ts
import dangerousTopics from '../safety-data/dangerous-topics.json' with { type: 'json' };

export interface PreflightResult {
  allow: boolean;
  reason?: string;
  cannedResponse?: string;
}

interface RawPattern {
  id: string;
  regex: string;
  redirect: string;
  kcalMaxFloor?: number;
}

const COMPILED = (dangerousTopics.patterns as RawPattern[]).map((p) => ({
  ...p,
  compiled: new RegExp(p.regex)
}));

export function preflightSafety(text: string): PreflightResult {
  for (const p of COMPILED) {
    const m = p.compiled.exec(text);
    if (!m) continue;
    if (p.kcalMaxFloor !== undefined) {
      const kcal = Number(m.groups?.kcal ?? 0);
      if (kcal >= p.kcalMaxFloor) continue;
    }
    return { allow: false, reason: p.id, cannedResponse: p.redirect };
  }
  return { allow: true };
}

// Stub for vertical slice — full implementation in Plan 2.
export async function postReview(_assembled: string): Promise<{ ok: true }> {
  return { ok: true };
}
```

- [ ] **Step 5: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/safety.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```
git add src/safety-data/dangerous-topics.json src/runtime/safety.ts tests/unit/runtime/safety.test.ts
git commit -m "Add preflight safety with seed dangerous-topics rules"
```

---

### Task 9: persistTurn

**Files:**
- Create: `src/runtime/persist.ts`
- Create: `tests/unit/runtime/persist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/runtime/persist.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { insertChatTurnStreaming, finalizeChatTurn, recordToolCall } from '../../../src/runtime/persist';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1', 'a', 'UTC', '[]', '[]', 150, 1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1', 'u1', 'main', 1)`)
  ]);
});

describe('insertChatTurnStreaming', () => {
  it('inserts a streaming row with allocated ordinal', async () => {
    const r = await insertChatTurnStreaming({
      db: env.DB,
      turnId: 't1',
      threadId: 'th1',
      actor: 'user',
      userText: 'hi',
      idempotencyKey: 'k1',
      now: 1000
    });
    expect(r.ordinal).toBe(0);
    const row = await env.DB.prepare(`SELECT status, ordinal FROM chat_turns WHERE turn_id='t1'`).first();
    expect(row).toEqual({ status: 'streaming', ordinal: 0 });
  });

  it('allocates ordinal as max(ordinal)+1 within thread', async () => {
    await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('t0','th1',7,'user','complete',1)`).run();
    const r = await insertChatTurnStreaming({
      db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', now: 1
    });
    expect(r.ordinal).toBe(8);
  });

  it('returns existing turnId on idempotency-key replay', async () => {
    const r1 = await insertChatTurnStreaming({ db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', idempotencyKey: 'k1', now: 1 });
    const r2 = await insertChatTurnStreaming({ db: env.DB, turnId: 't2', threadId: 'th1', actor: 'user', userText: 'hi', idempotencyKey: 'k1', now: 2 });
    expect(r2.turnId).toBe(r1.turnId);
    expect(r2.replay).toBe(true);
  });
});

describe('finalizeChatTurn', () => {
  it('updates status, text, cost, ended_at', async () => {
    await insertChatTurnStreaming({ db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', now: 1 });
    await finalizeChatTurn({ db: env.DB, turnId: 't1', status: 'complete', text: 'world', costUsd: 0.012, now: 5 });
    const row = await env.DB.prepare(`SELECT status, text, cost_usd, ended_at FROM chat_turns WHERE turn_id='t1'`).first();
    expect(row).toEqual({ status: 'complete', text: 'world', cost_usd: 0.012, ended_at: 5 });
  });
});

describe('recordToolCall', () => {
  it('records a tool call row', async () => {
    await insertChatTurnStreaming({ db: env.DB, turnId: 't1', threadId: 'th1', actor: 'user', userText: 'hi', now: 1 });
    await recordToolCall({
      db: env.DB, turnId: 't1', callIndex: 0, toolName: 'get_user_profile',
      input: { user_id: 'u1' }, output: { ok: true }, idempotencyKey: 'idem1', durationMs: 12
    });
    const row = await env.DB.prepare(`SELECT tool_name, input_json, output_json, idempotency_key FROM chat_tool_calls WHERE turn_id='t1' AND call_index=0`).first();
    expect(row?.tool_name).toBe('get_user_profile');
    expect(JSON.parse(row?.input_json as string)).toEqual({ user_id: 'u1' });
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/persist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runtime/persist.ts`**

```ts
export interface InsertStreamingInput {
  db: D1Database;
  turnId: string;
  threadId: string;
  actor: 'user' | 'system' | 'assistant';
  userText: string | null;
  idempotencyKey?: string;
  now: number;
}

export interface InsertStreamingResult {
  turnId: string;
  ordinal: number;
  replay: boolean;
}

export async function insertChatTurnStreaming(input: InsertStreamingInput): Promise<InsertStreamingResult> {
  if (input.idempotencyKey) {
    const existing = await input.db.prepare(
      `SELECT turn_id, ordinal FROM chat_turns WHERE thread_id = ? AND idempotency_key = ?`
    ).bind(input.threadId, input.idempotencyKey).first<{ turn_id: string; ordinal: number }>();
    if (existing) {
      return { turnId: existing.turn_id, ordinal: existing.ordinal, replay: true };
    }
  }

  const next = await input.db.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM chat_turns WHERE thread_id = ?`
  ).bind(input.threadId).first<{ ordinal: number }>();
  const ordinal = next?.ordinal ?? 0;

  await input.db.prepare(
    `INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, user_text, idempotency_key, started_at)
     VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?)`
  ).bind(input.turnId, input.threadId, ordinal, input.actor, input.userText, input.idempotencyKey ?? null, input.now).run();

  return { turnId: input.turnId, ordinal, replay: false };
}

export interface FinalizeInput {
  db: D1Database;
  turnId: string;
  status: 'complete' | 'error' | 'cancelled' | 'preflight_blocked';
  text: string;
  costUsd: number;
  error?: string;
  now: number;
}

export async function finalizeChatTurn(input: FinalizeInput): Promise<void> {
  await input.db.prepare(
    `UPDATE chat_turns
     SET status = ?, text = ?, cost_usd = ?, ended_at = ?, error = ?
     WHERE turn_id = ?`
  ).bind(input.status, input.text, input.costUsd, input.now, input.error ?? null, input.turnId).run();
}

export interface ToolCallInput {
  db: D1Database;
  turnId: string;
  callIndex: number;
  toolName: string;
  input: unknown;
  output: unknown;
  idempotencyKey?: string;
  durationMs: number;
  error?: string;
}

export async function recordToolCall(input: ToolCallInput): Promise<void> {
  await input.db.prepare(
    `INSERT INTO chat_tool_calls (turn_id, call_index, tool_name, input_json, output_json, idempotency_key, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.turnId,
    input.callIndex,
    input.toolName,
    JSON.stringify(input.input),
    JSON.stringify(input.output),
    input.idempotencyKey ?? null,
    input.durationMs,
    input.error ?? null
  ).run();
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/persist.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```
git add src/runtime/persist.ts tests/unit/runtime/persist.test.ts
git commit -m "Add chat-turn persistence helpers"
```

---

## Phase 4: Tool Registry + First Tool

### Task 10: Tool registry assembly

**Files:**
- Create: `src/runtime/tool-registry.ts`

The registry is a `Map<string, ToolDef>` assembled from individual tool modules. We'll register one tool in this plan; later plans will add more.

- [ ] **Step 1: Write `src/runtime/tool-registry.ts`**

```ts
import type { ToolDef, ToolRegistry } from '../types';
import { getUserProfileTool } from '../tools/get-user-profile';

export function buildToolRegistry(): ToolRegistry {
  const tools: ToolDef[] = [
    getUserProfileTool
  ];
  return new Map(tools.map((t) => [t.name, t]));
}
```

(Note: this file imports `get-user-profile.ts` which doesn't exist yet — Task 11 creates it. Typecheck will fail until then; that's intentional.)

- [ ] **Step 2: Commit (defer typecheck until Task 11)**

```
git add src/runtime/tool-registry.ts
git commit -m "Add tool registry assembler"
```

---

### Task 11: get_user_profile tool

**Files:**
- Create: `src/tools/get-user-profile.ts`
- Create: `tests/unit/tools/get-user-profile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tools/get-user-profile.test.ts
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
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/tools/get-user-profile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/get-user-profile.ts`**

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Output {
  display_name: string;
  timezone: string;
  age_years: number | null;
  dietary_pattern: string | null;
  allergies: string[];
  dislikes: string[];
}

export const getUserProfileTool: ToolDef<Record<string, never>, Output> = {
  name: 'get_user_profile',
  description: 'Return the current user\'s profile (display name, timezone, age, dietary pattern, allergies, dislikes).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  surface: 'hidden',
  idempotent: true,
  async handler(_input, ctx: ToolCtx): Promise<Output> {
    const row = await ctx.deps.db.prepare(
      `SELECT display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json
       FROM users WHERE user_id = ?`
    ).bind(ctx.userId).first<{
      display_name: string;
      timezone: string;
      age_years: number | null;
      dietary_pattern: string | null;
      allergies_json: string;
      dislikes_json: string;
    }>();
    if (!row) throw new Error(`user not found: ${ctx.userId}`);
    return {
      display_name: row.display_name,
      timezone: row.timezone,
      age_years: row.age_years,
      dietary_pattern: row.dietary_pattern,
      allergies: JSON.parse(row.allergies_json) as string[],
      dislikes: JSON.parse(row.dislikes_json) as string[]
    };
  }
};
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/tools/get-user-profile.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```
git add src/tools/get-user-profile.ts tests/unit/tools/get-user-profile.test.ts
git commit -m "Add get_user_profile tool"
```

---

## Phase 5: Orchestrator + runTurn

### Task 12: Orchestrator (tool loop)

**Files:**
- Create: `src/runtime/orchestrator.ts`
- Create: `tests/unit/runtime/orchestrator.test.ts`

The orchestrator runs the Anthropic streaming loop, dispatches tools, and emits SSE events.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/runtime/orchestrator.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { runOrchestrator } from '../../../src/runtime/orchestrator';
import { getUserProfileTool } from '../../../src/tools/get-user-profile';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';
import type { AnthropicStreamEvent } from '../../../src/types';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]', 150, 1)`
  ).run();
});

describe('runOrchestrator', () => {
  it('streams text deltas and emits text_delta SSE events', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script], tools: [getUserProfileTool] });
    const collector = createSseCollector();
    const r = await runOrchestrator({
      deps, userId: 'u1', threadId: 'th1', turnId: 't1',
      systemPrompt: 'You are a coach.',
      messages: [{ role: 'user', content: 'hi' }],
      emit: collector.emit,
      signal: new AbortController().signal
    });
    expect(r.text).toBe('Hello world');
    expect(r.tokensIn).toBe(10);
    expect(r.tokensOut).toBe(5);
    expect(collector.events.filter((e) => e.type === 'text_delta').length).toBe(2);
  });

  it('dispatches a tool call and emits visible-tool events when tool surface is visible', async () => {
    // get_user_profile is hidden — use a custom visible tool to exercise SSE emission.
    const visibleTool = {
      ...getUserProfileTool,
      name: 'echo',
      surface: 'visible' as const,
      handler: async () => ({ ok: true })
    };
    const script1: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'tool_use', id: 'tu1', name: 'echo' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'tool_use', usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    ];
    const script2: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 5 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script1, script2], tools: [visibleTool] });
    const collector = createSseCollector();
    await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('t1','th1',0,'user','streaming',1)`).run();
    const r = await runOrchestrator({
      deps, userId: 'u1', threadId: 'th1', turnId: 't1',
      systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
      emit: collector.emit,
      signal: new AbortController().signal
    });
    expect(r.text).toBe('done');
    expect(collector.events.some((e) => e.type === 'tool_call_start')).toBe(true);
    expect(collector.events.some((e) => e.type === 'tool_call_result')).toBe(true);
    const toolRows = await env.DB.prepare(`SELECT tool_name FROM chat_tool_calls WHERE turn_id='t1'`).all();
    expect(toolRows.results).toEqual([{ tool_name: 'echo' }]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runtime/orchestrator.ts`**

```ts
import type {
  AnthropicMessage, AnthropicStreamEvent, AnthropicTool,
  RuntimeDeps, SseEvent, ToolDef
} from '../types';
import { recordToolCall } from './persist';

const PRICE_PER_INPUT_TOKEN_USD = 15 / 1_000_000;     // claude-opus-4-7
const PRICE_PER_OUTPUT_TOKEN_USD = 75 / 1_000_000;

const MAX_TOOL_ROUNDS = 6;

export interface OrchestratorInput {
  deps: RuntimeDeps;
  userId: string;
  threadId: string;
  turnId: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  emit: (event: SseEvent) => void;
  signal: AbortSignal;
}

export interface OrchestratorResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const tools: AnthropicTool[] = [...input.deps.tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const conv: AnthropicMessage[] = [...input.messages];
  let assembledText = '';
  let totalIn = 0;
  let totalOut = 0;
  let toolCallIndex = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = input.deps.ai.streamMessage({
      system: input.systemPrompt,
      messages: conv,
      tools,
      maxTokens: 4000,
      signal: input.signal
    });

    const blocks = new Map<number, { kind: 'text'; text: string } | { kind: 'tool_use'; id: string; name: string; jsonBuf: string }>();
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';

    for await (const ev of stream) {
      if (input.signal.aborted) throw new DOMException('aborted', 'AbortError');
      handleEvent(ev, blocks, input.emit, (delta) => { assembledText += delta; });
      if (ev.type === 'message_start') totalIn += ev.usage.input_tokens;
      if (ev.type === 'message_delta') {
        stopReason = ev.stop_reason;
        totalOut += ev.usage.output_tokens;
      }
    }

    if (stopReason === 'end_turn') break;
    if (stopReason === 'max_tokens') break;
    if (stopReason !== 'tool_use') break;

    const assistantBlocks: AnthropicMessage['content'] = [];
    const toolResults: AnthropicMessage['content'] = [];

    for (const [, block] of blocks) {
      if (block.kind === 'text') {
        if (block.text) assistantBlocks.push({ type: 'text', text: block.text });
      } else {
        const parsed = block.jsonBuf ? JSON.parse(block.jsonBuf) : {};
        assistantBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: parsed });

        const tool = input.deps.tools.get(block.name);
        if (!tool) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'unknown_tool' }) });
          continue;
        }
        const idemKey = tool.idempotent ? `${input.turnId}:${toolCallIndex}` : undefined;
        if (tool.surface === 'visible') {
          input.emit({ type: 'tool_call_start', data: { call_index: toolCallIndex, tool: tool.name, input: parsed } });
        }
        const t0 = input.deps.clock();
        const out = await runToolSafely(tool, parsed, {
          userId: input.userId,
          threadId: input.threadId,
          turnId: input.turnId,
          toolCallIndex,
          deps: input.deps,
          emit: input.emit,
          signal: input.signal
        });
        const t1 = input.deps.clock();
        await recordToolCall({
          db: input.deps.db,
          turnId: input.turnId,
          callIndex: toolCallIndex,
          toolName: tool.name,
          input: parsed,
          output: out.value,
          idempotencyKey: idemKey,
          durationMs: t1 - t0,
          error: out.error
        });
        if (tool.surface === 'visible') {
          input.emit({ type: 'tool_call_result', data: { call_index: toolCallIndex, summary: summarize(out.value) } });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out.value) });
        toolCallIndex++;
      }
    }

    conv.push({ role: 'assistant', content: assistantBlocks });
    conv.push({ role: 'user', content: toolResults });
  }

  const costUsd = totalIn * PRICE_PER_INPUT_TOKEN_USD + totalOut * PRICE_PER_OUTPUT_TOKEN_USD;
  return { text: assembledText, tokensIn: totalIn, tokensOut: totalOut, costUsd };
}

function handleEvent(
  ev: AnthropicStreamEvent,
  blocks: Map<number, any>,
  emit: (e: SseEvent) => void,
  onTextDelta: (s: string) => void
): void {
  if (ev.type === 'content_block_start') {
    if (ev.block.type === 'text') {
      blocks.set(ev.index, { kind: 'text', text: '' });
    } else {
      blocks.set(ev.index, { kind: 'tool_use', id: ev.block.id, name: ev.block.name, jsonBuf: '' });
    }
    return;
  }
  if (ev.type === 'content_block_delta') {
    const b = blocks.get(ev.index);
    if (!b) return;
    if (b.kind === 'text' && ev.delta.type === 'text_delta') {
      b.text += ev.delta.text;
      emit({ type: 'text_delta', data: { chunk: ev.delta.text } });
      onTextDelta(ev.delta.text);
    } else if (b.kind === 'tool_use' && ev.delta.type === 'input_json_delta') {
      b.jsonBuf += ev.delta.partial_json;
    }
    return;
  }
}

async function runToolSafely(
  tool: ToolDef,
  input: unknown,
  ctx: any
): Promise<{ value: unknown; error?: string }> {
  try {
    const value = await tool.handler(input, ctx);
    return { value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: { error: 'transient', message }, error: message };
  }
}

function summarize(out: unknown): string {
  if (typeof out !== 'object' || out === null) return String(out);
  const entries = Object.entries(out as Record<string, unknown>).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/orchestrator.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add src/runtime/orchestrator.ts tests/unit/runtime/orchestrator.test.ts
git commit -m "Add orchestrator with tool-use loop"
```

---

### Task 13: runTurn integration

**Files:**
- Create: `src/runtime/agent-runtime.ts`
- Create: `tests/unit/runtime/agent-runtime.test.ts`

`runTurn` wires together buildContext → preflight → insert streaming row → orchestrator → finalize.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/runtime/agent-runtime.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { runTurn } from '../../../src/runtime/agent-runtime';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { getUserProfileTool } from '../../../src/tools/get-user-profile';
import { resetDb } from '../../fakes/seed';
import type { AnthropicStreamEvent } from '../../../src/types';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('runTurn', () => {
  it('runs a happy-path user turn end to end', async () => {
    const script: AnthropicStreamEvent[] = [
      { type: 'message_start', usage: { input_tokens: 10 } },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello!' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ];
    const deps = makeFakes({ db: env.DB, scripts: [script], tools: [getUserProfileTool] });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1',
      threadId: 'th1',
      actor: 'user',
      message: 'hi',
      stream: collector,
      signal: new AbortController().signal
    }, deps);
    expect(r.status).toBe('complete');
    expect(r.text).toBe('Hello!');
    expect(collector.events[0]?.type).toBe('turn_started');
    expect(collector.events.at(-1)?.type).toBe('turn_complete');
    const row = await env.DB.prepare(`SELECT status, text FROM chat_turns WHERE turn_id=?`).bind(r.turnId).first();
    expect(row).toEqual({ status: 'complete', text: 'Hello!' });
  });

  it('blocks via preflight and persists with status preflight_blocked', async () => {
    const deps = makeFakes({ db: env.DB, scripts: [], tools: [] });
    const collector = createSseCollector();
    const r = await runTurn({
      userId: 'u1',
      threadId: 'th1',
      actor: 'user',
      message: 'Should I take 200mg of caffeine?',
      stream: collector,
      signal: new AbortController().signal
    }, deps);
    expect(r.status).toBe('preflight_blocked');
    expect(r.text).toContain('pharmacist');
    expect(deps.ai.calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm test tests/unit/runtime/agent-runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runtime/agent-runtime.ts`**

```ts
import { ulid } from 'ulid';
import type { RuntimeDeps, TurnInput, TurnResult } from '../types';
import { buildContext } from './build-context';
import { runOrchestrator } from './orchestrator';
import { finalizeChatTurn, insertChatTurnStreaming } from './persist';
import { preflightSafety, postReview } from './safety';

const SYSTEM_PROMPT_USER = `You are Cohort, a health and training coach. You have tools to read the user's profile, recent meals, readiness, and to log things on their behalf. Stay within scope: training, nutrition, sleep, recovery. Never give specific medication, diagnosis, or drug-interaction advice. Preserve hedging in research; never strengthen claims.`;
const SYSTEM_PROMPT_BATCH = `You are Cohort generating tomorrow's plan. Read the user's current state via tools, then propose a session and meals using propose_workout / propose_meals.`;

export async function runTurn(input: TurnInput, deps: RuntimeDeps): Promise<TurnResult> {
  const turnId = ulid();
  const now = deps.clock();

  if (input.actor === 'user') {
    const pf = preflightSafety(input.message ?? '');
    if (!pf.allow) {
      const inserted = await insertChatTurnStreaming({
        db: deps.db, turnId, threadId: input.threadId, actor: 'user',
        userText: input.message ?? null, idempotencyKey: input.idempotencyKey, now
      });
      if (!inserted.replay) {
        input.stream?.emit({ type: 'turn_started', data: { turn_id: inserted.turnId, ordinal: inserted.ordinal } });
        input.stream?.emit({ type: 'text_delta', data: { chunk: pf.cannedResponse ?? '' } });
        await finalizeChatTurn({
          db: deps.db, turnId: inserted.turnId, status: 'preflight_blocked',
          text: pf.cannedResponse ?? '', costUsd: 0, now: deps.clock()
        });
        input.stream?.emit({ type: 'turn_complete', data: { turn_id: inserted.turnId, full_text: pf.cannedResponse ?? '', cost_usd: 0 } });
        input.stream?.close();
      }
      return { turnId: inserted.turnId, status: 'preflight_blocked', text: pf.cannedResponse ?? '', costUsd: 0 };
    }
  }

  const inserted = await insertChatTurnStreaming({
    db: deps.db, turnId, threadId: input.threadId, actor: input.actor,
    userText: input.actor === 'user' ? (input.message ?? null) : null,
    idempotencyKey: input.idempotencyKey, now
  });
  if (inserted.replay) {
    return { turnId: inserted.turnId, status: 'complete', text: '', costUsd: 0 };
  }

  input.stream?.emit({ type: 'turn_started', data: { turn_id: inserted.turnId, ordinal: inserted.ordinal } });

  try {
    const context = await buildContext({
      db: deps.db, userId: input.userId, threadId: input.threadId, actor: input.actor
    });

    const messages = [
      ...buildHistoryMessages(context.recentMessages),
      ...(input.actor === 'user'
        ? [{ role: 'user' as const, content: input.message ?? '' }]
        : [{ role: 'user' as const, content: input.systemHint ?? 'Generate the requested plan.' }])
    ];

    const systemPrompt = `${input.actor === 'user' ? SYSTEM_PROMPT_USER : SYSTEM_PROMPT_BATCH}\n\nUser profile:\n${JSON.stringify(context.profile, null, 2)}`;

    const orch = await runOrchestrator({
      deps,
      userId: input.userId,
      threadId: input.threadId,
      turnId: inserted.turnId,
      systemPrompt,
      messages,
      emit: (e) => input.stream?.emit(e),
      signal: input.signal
    });

    await postReview(orch.text);  // stub returns ok in this plan

    await finalizeChatTurn({
      db: deps.db, turnId: inserted.turnId, status: 'complete',
      text: orch.text, costUsd: orch.costUsd, now: deps.clock()
    });
    input.stream?.emit({ type: 'turn_complete', data: { turn_id: inserted.turnId, full_text: orch.text, cost_usd: orch.costUsd } });
    input.stream?.close();
    return { turnId: inserted.turnId, status: 'complete', text: orch.text, costUsd: orch.costUsd };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    const status = isAbort ? 'cancelled' : 'error';
    await finalizeChatTurn({
      db: deps.db, turnId: inserted.turnId, status, text: '', costUsd: 0, error: message, now: deps.clock()
    });
    input.stream?.emit({ type: 'error', data: { message, retryable: !isAbort } });
    input.stream?.close();
    return { turnId: inserted.turnId, status, text: '', costUsd: 0 };
  }
}

function buildHistoryMessages(recent: Array<{ actor: 'user' | 'assistant' | 'system'; user_text: string | null; text: string | null }>) {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of recent) {
    if (m.actor === 'user' && m.user_text) out.push({ role: 'user', content: m.user_text });
    else if (m.actor === 'assistant' && m.text) out.push({ role: 'assistant', content: m.text });
  }
  return out;
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm test tests/unit/runtime/agent-runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add src/runtime/agent-runtime.ts tests/unit/runtime/agent-runtime.test.ts
git commit -m "Add runTurn integrating context, preflight, orchestrator, persist"
```

---

## Phase 6: HTTP Surface

### Task 14: UserAgentDO + api Worker entrypoint

**Files:**
- Create: `src/do/user-agent-do.ts`
- Create: `src/api/worker.ts`

The DO exposes `POST /chat`; the api Worker is the entrypoint that resolves the user's DO and forwards the request. Auth is stubbed for the vertical slice (reads `X-User-Id` header — replaced with JWT in a later plan).

- [ ] **Step 1: Write `src/do/user-agent-do.ts`**

```ts
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
    const turnHandle = { abortController: ac, turnId: '' };
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
        { userId, threadId, actor: 'user', message: body.message, stream: writer, signal: ac.signal, idempotencyKey },
        deps
      )
        .then((r) => { turnHandle.turnId = r.turnId; })
        .catch(() => { /* runTurn already emitted error event + finalized */ })
        .finally(() => { if (this.currentTurn === turnHandle) this.currentTurn = null; })
    );

    return response;
  }
}
```

- [ ] **Step 2: Write `src/api/worker.ts`**

```ts
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
    return new Response('not found', { status: 404 });
  }
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```
git add src/do/user-agent-do.ts src/api/worker.ts
git commit -m "Add UserAgentDO and api Worker entrypoint"
```

---

### Task 15: Miniflare integration test (DO end-to-end)

**Files:**
- Create: `tests/integration/do-flow.test.ts`

This test boots the api Worker + DO + D1 in Miniflare, sends a real `POST /v1/chat/{thread_id}`, and asserts the SSE stream contents. Anthropic is mocked by overriding the `ANTHROPIC_API_KEY` and pointing the gateway URL at a fake fetch — but a cleaner approach is to inject a mock `fetch` via the Miniflare service. For this slice we use a simpler integration mode: stub the AI Gateway URL with a Miniflare-bound mock Worker that returns a canned SSE response.

- [ ] **Step 1: Create the mock gateway Worker `tests/integration/mock-gateway.ts`**

```ts
const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  ''
].join('\n');

export default {
  async fetch(): Promise<Response> {
    return new Response(SSE_BODY, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }
};
```

- [ ] **Step 2: Update `vitest.config.ts` to bind the mock gateway**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          durableObjects: { USER_AGENT_DO: 'UserAgentDO' },
          serviceBindings: {
            MOCK_GATEWAY: 'mock-gateway'
          },
          workers: [{
            name: 'mock-gateway',
            modules: true,
            scriptPath: 'tests/integration/mock-gateway.ts'
          }],
          bindings: {
            ANTHROPIC_API_KEY: 'test-key',
            AI_GATEWAY_URL: 'https://mock-gateway/v1/anthropic'
          }
        }
      }
    }
  }
});
```

(Note: in this slice we substitute `AI_GATEWAY_URL` so production fetch hits the mock service binding via `https://mock-gateway/...`. The worker pool wires that domain to `MOCK_GATEWAY`.)

- [ ] **Step 3: Write the integration test `tests/integration/do-flow.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('end-to-end POST /v1/chat/{thread_id}', () => {
  it('returns an SSE stream and persists the turn', async () => {
    const resp = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1', 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
      body: JSON.stringify({ message: 'hi' })
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('event: turn_started');
    expect(text).toContain('event: text_delta');
    expect(text).toContain('"chunk":"hello"');
    expect(text).toContain('event: turn_complete');

    // Allow the DO's waitUntil to flush.
    await new Promise((r) => setTimeout(r, 50));

    const row = await env.DB.prepare(`SELECT status, text FROM chat_turns WHERE thread_id='th1' ORDER BY ordinal DESC LIMIT 1`).first();
    expect(row?.status).toBe('complete');
    expect(row?.text).toBe('hello');
  });

  it('rejects requests without X-User-Id', async () => {
    const resp = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    });
    expect(resp.status).toBe(401);
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: ALL tests pass (unit + integration).

- [ ] **Step 5: Commit**

```
git add tests/integration/ vitest.config.ts
git commit -m "Add Miniflare integration test for DO chat flow"
```

---

## Phase 7: Final verification

### Task 16: Smoke check via wrangler dev

**Files:** none (smoke check only)

- [ ] **Step 1: Apply schema to local D1 and seed a test user**

Run:
```
pnpm db:apply
wrangler d1 execute cohort --local --command "INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at) VALUES ('u1','Alex','UTC','[]','[]',150,strftime('%s','now')*1000); INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',strftime('%s','now')*1000);"
```
Expected: rows inserted.

- [ ] **Step 2: Set local secrets**

Create `.dev.vars`:
```
ANTHROPIC_API_KEY=sk-ant-...your-key...
```

- [ ] **Step 3: Run wrangler dev**

Run: `pnpm dev`
Expected: wrangler starts on `http://localhost:8787`.

- [ ] **Step 4: Curl the chat endpoint**

```
curl -N -X POST http://localhost:8787/v1/chat/th1 \
  -H "X-User-Id: u1" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"message":"what should I have for breakfast?"}'
```
Expected: SSE stream of `event: turn_started`, `event: text_delta` (multiple), `event: turn_complete`. Final response is reasonable text from Opus 4.7.

- [ ] **Step 5: Verify D1**

```
wrangler d1 execute cohort --local --command "SELECT turn_id, status, substr(text,1,80) AS text FROM chat_turns ORDER BY started_at DESC LIMIT 1;"
```
Expected: one row with `status='complete'` and a non-empty text snippet.

- [ ] **Step 6: Final typecheck and full test run**

Run:
```
pnpm typecheck
pnpm test
```
Expected: both exit 0.

- [ ] **Step 7: Commit final state (if any tweaks were made during smoke testing)**

```
git status --short
# if there are changes:
git add -A
git commit -m "Smoke fixes from wrangler dev"
```

---

## What this slice produces

After Task 16:
- A deployed-shape Cloudflare Worker (`pnpm dev`) that accepts `POST /v1/chat/{thread_id}` and returns a real Anthropic-streamed SSE response.
- A `UserAgentDO` per user, with the right shard key.
- A unit-tested runtime library (`src/runtime/*`) that runs context → preflight → orchestrator → persist with full code coverage in the happy path and in preflight-block path.
- One working tool (`get_user_profile`) with its own unit tests.
- A Miniflare integration test exercising the full HTTP → DO → D1 path.
- A migration applied to local D1.

## What's deferred to follow-up plans

| Item | Plan |
|---|---|
| Tools: `get_readiness`, `get_recent_meals`, `note_dislike`, `log_meal`, `propose_workout`, `search_groceries`, `search_research`, `compute_acwr` | 2 |
| `postReview` (Haiku safety review LLM call) | 2 |
| Cancellation endpoint (`POST /cancel`) and SSE replay on idempotency hit | 2 |
| Per-user cost cap enforcement | 2 |
| `alarm()` and `scheduleNextAlarm()` (5am batch path) | 3 |
| Janitor cron worker (sweep stale `streaming` rows) | 3 |
| Smoke tests against deployed staging | 3 |
| Auth (JWT verification, replacing `X-User-Id`) | separate auth spec |

---

## Self-review notes

- **Spec coverage:** every section in scope (Architecture, Components, Data flow happy path, Error handling minimum, Testing layers 1–3) is exercised by at least one task.
- **Placeholder scan:** no TBDs. All "deferred" items are explicit and linked to follow-up plans.
- **Type consistency:** `RuntimeDeps`, `ToolDef`, `SseEvent`, `TurnInput`, `TurnResult`, `AnthropicStreamEvent` are defined in Task 3 and used consistently in Tasks 4–14. Function names match: `buildContext`, `preflightSafety`, `postReview`, `insertChatTurnStreaming`, `finalizeChatTurn`, `recordToolCall`, `runOrchestrator`, `runTurn`, `buildToolRegistry`, `getUserProfileTool`.
- **Scope:** vertical slice = 16 tasks, ~3-5 hours of focused work. Each task produces working software at the commit boundary.
