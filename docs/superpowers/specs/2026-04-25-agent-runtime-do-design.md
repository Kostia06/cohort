# Agent Runtime Durable Object — Design

**Date:** 2026-04-25
**Status:** Approved (design)
**Project:** Cohort (health app)

## Context

Cohort is a Cloudflare-stack health app. A user chats with an agent that combines training, nutrition, sleep, and recovery guidance, backed by per-user health data (HealthKit-derived readiness, ACWR), a research RAG pipeline, and a regional grocery search.

This spec defines the **agent runtime** — the per-user execution surface that:
- Receives user chat messages and streams responses back.
- Generates a daily plan at 5am local time without a connected client.
- Calls tools (D1 queries, grocery search, research search, plan/meal/workout writes) and surfaces meaningful tool work to the user.
- Enforces safety guardrails appropriate for a non-medical health app.

This spec does **not** cover: HealthKit sync (separate spec), the grocery search Worker (its own spec already drafted), the research ingestion pipeline (its own spec already drafted), the readiness scoring algorithm (its own spec already drafted), the Flutter client architecture, or deployment/CI.

## Decisions resolved during design

1. **Interaction model:** Hybrid — unified chat *and* daily auto-generated plans (5am local).
2. **Specialist orchestration:** Single Claude call (Opus 4.7) with all tools. No multi-agent specialists. Domain expertise in the system prompt.
3. **DO sharding:** One DO per user (`id = userId`). Cron alarms wake the same DO at 5am local for batch.
4. **Streaming protocol:** POST + Server-Sent Events. Cancellation = client closes the SSE connection. Push notifications (e.g., "tomorrow's plan is ready") use APNs, not the runtime.
5. **State location:** D1 is the source of truth for everything (profile, chat, plans, readiness, logs). DO holds only in-memory transient state for the in-flight turn (abort signal, partial response).
6. **Tool execution:** Hybrid. Cheap reads/writes (`get_profile`, `log_meal`) run inline against D1 in the DO. Heavy operations (`search_groceries`, `search_research`) call out via service bindings to dedicated Workers.
7. **Safety:** Two-tier. Deterministic preflight on user messages (medication / diagnosis / clinical-question wall, returns canned redirect). Post-stream LLM review (Haiku 4.5) appends a corrigendum if needed.
8. **Chat context:** Last 20 messages of conversational history + structured user state (current plan, today's readiness, last 7d compliance, allergies, dislikes, dietary pattern) injected per turn. Long-term facts are structured fields that the orchestrator updates via tools, never relied on through chat memory.
9. **Tool surfacing:** Each tool declares `surface: 'visible' | 'hidden'`. Visible tools emit SSE events (`tool_call_start` / `tool_call_result`); hidden ones are silent.

## Architecture

```
┌──────────────── FLUTTER CLIENT ─────────────────┐
│  POST /v1/chat/{thread_id}    JWT + Idem-Key    │
│  ◀── SSE stream of typed events                 │
└──────────────────────────────────────────────────┘
                        │
┌─────────────────── EDGE ────────────────────────┐
│  api Worker:  verifyJwt → stub.fetch(req)       │
└──────────────────────────────────────────────────┘
                        │
┌──────────────── PER-USER DO ────────────────────┐
│  UserAgentDO  (id = userId)                     │
│   ├ POST /chat, POST /cancel, GET /health       │
│   ├ alarm() — 5am-local batch turn              │
│   ├ in-memory: AbortController, current turn id │
│   └ delegates ─▶ AgentRuntime (library)         │
│                  ├ buildContext()               │
│                  ├ preflightSafety()            │
│                  ├ runOrchestrator()            │
│                  │   └ executeTool()            │
│                  ├ postReview()                 │
│                  └ persistTurn()                │
└──────────────────────────────────────────────────┘
                        │
┌──────────────── BACKING SERVICES ───────────────┐
│  D1 (canonical)        │  Vectorize  │  R2      │
│  AI Gateway → Anthropic                         │
│  service-bound Workers: grocery, research       │
└──────────────────────────────────────────────────┘
```

### Invariants

1. **Single writer per user.** All writes to a user's chat / plan / log rows in D1 go through that user's `UserAgentDO`. No other code path writes to user-scoped rows. This is the source of consistency without app-level locking.
2. **DO holds no durable state.** All persistence is D1 / R2 / Vectorize. DO crash mid-turn = current turn is lost; D1 has the previous state intact.
3. **Tool calls have stable identity.** `(turn_id, call_index)` is recorded in D1. Idempotent writes (`log_meal`, `propose_workout`) check this before inserting.
4. **The runtime library is environment-free.** Takes bindings as a parameter. Unit-testable with fakes.
5. **Interactive and batch share the same code path.** Batch is a turn with `actor: 'system'` and `stream: null`. The runtime branches on actor in only three places: which system prompt is selected, whether preflight safety runs, and how much chat history `buildContext` loads (20 messages for user turns, 5 for system turns).

## Components

### `UserAgentDO` (Durable Object class)

```ts
class UserAgentDO {
  state: DurableObjectState;
  env: Env;
  currentTurn: { abortController: AbortController; turnId: string } | null;

  fetch(req: Request): Promise<Response>;
  alarm(): Promise<void>;
  scheduleNextAlarm(): Promise<void>;
}
```

Routes:
- `POST /chat` — start a new turn, return SSE stream.
- `POST /cancel` — abort the current turn (alternative to closing the SSE).
- `GET /health` — returns alarm status, last turn timestamp, in-flight flag.

The DO's responsibilities are intentionally narrow: HTTP routing, abort lifecycle, alarm scheduling. All real work delegates to the runtime library.

### `AgentRuntime` (library)

```ts
interface RuntimeDeps {
  db: D1Database;
  ai: AIGatewayClient;
  vectorize: VectorizeIndex;
  bindings: { groceryWorker: Fetcher; researchWorker: Fetcher };
  tools: ToolRegistry;
  clock: () => number;
}

interface TurnInput {
  userId: string;
  threadId: string;
  actor: 'user' | 'system';
  message?: string;
  systemHint?: string;
  stream: SseWriter | null;
  signal: AbortSignal;
  idempotencyKey?: string;
}

async function runTurn(input: TurnInput, deps: RuntimeDeps): Promise<TurnResult>;
```

Phases inside `runTurn`:
1. `buildContext` — load profile, last 20 messages, today's readiness, this week's plan, last 7d logs from D1. Assemble structured state object + chat-history array.
2. `preflightSafety` — only when `actor === 'user'`. Deterministic regex/keyword check. If blocked, emit canned response + persist + return early.
3. Insert `chat_turn` row with `status='streaming'`, emit `turn_started` SSE event.
4. `runOrchestrator` — call Anthropic via AI Gateway with streaming + tools. Loop on `tool_use` stop reasons: dispatch tool, persist `chat_tool_call` row, surface result events for visible tools, feed result back to model.
5. `postReview` — Haiku 4.5 call on the assembled assistant text. If flagged, emit `corrigendum` SSE event.
6. `persistTurn` — finalize `chat_turn` row (`status='complete'|'error'|'cancelled'`, text, cost, ended_at).

### Tool registry

```ts
interface ToolDef<I, O> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  surface: 'visible' | 'hidden';
  idempotent: boolean;
  handler: (input: I, ctx: ToolCtx) => Promise<O>;
}

interface ToolCtx {
  userId: string;
  threadId: string;
  turnId: string;
  toolCallIndex: number;
  deps: RuntimeDeps;
  emit: (event: SseEvent) => void;
  signal: AbortSignal;
}
```

Tools live one per file in `src/tools/`. The registry is assembled at boot.

| Tool | surface | idempotent | execution |
|---|---|---|---|
| `get_user_profile` | hidden | yes | inline D1 |
| `get_readiness` | hidden | yes | inline D1 |
| `get_recent_meals` | hidden | yes | inline D1 |
| `note_dislike` | hidden | yes | inline D1 (upsert) |
| `log_meal` | visible | yes | inline D1 |
| `propose_workout` | visible | yes | inline D1 |
| `search_groceries` | visible | yes | service binding |
| `search_research` | visible | yes | service binding |
| `compute_acwr` | visible | yes | inline D1 + computation |

Tools are added by writing one file and registering it. No other code change required.

### Safety module

```ts
function preflightSafety(text: string): {
  allow: boolean;
  reason?: string;
  cannedResponse?: string;
};

async function postReview(
  assembled: string,
  ai: AIGatewayClient
): Promise<{ ok: boolean; corrigendum?: string }>;
```

**Preflight** is deterministic. Loads `dangerous_topics.json` at boot — list of regex patterns and keyword sets covering: medication-name detection ("should I take X mg of Y"), diagnosis questions ("do I have"), drug-interaction questions, and self-harm / eating-disorder triggers. ~2ms per call. Returns a canned redirect when blocked (e.g., "That's a medication question — please ask your pharmacist. I can help with [allowed scope].").

**Post-review** is one Haiku 4.5 call with a tight system prompt: "Given this assistant response, identify any of the following issues: specific medication advice, calorie targets below 1200 for adults without context, drug-interaction claims, diagnostic claims. If any, return a one-paragraph corrigendum to append. Otherwise return `{ok: true}`." Adds ~500ms to turn completion; only runs after the user has already seen the streamed response.

### D1 schema (runtime-relevant tables)

```sql
CREATE TABLE chat_threads (
  thread_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE chat_turns (
  turn_id    TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  status     TEXT NOT NULL,
  text       TEXT,
  user_text  TEXT,
  cost_usd   REAL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  error      TEXT
);

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

CREATE UNIQUE INDEX uq_idem
  ON chat_tool_calls(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Other tables referenced by tools (`users`, `meals`, `workouts`, `plans`, `readiness_daily`, etc.) are out of scope for this spec but follow the same conventions.

### SSE event protocol

```
event: turn_started      data: {turn_id, ordinal}
event: text_delta        data: {chunk}
event: tool_call_start   data: {call_index, tool, input}      ← visible only
event: tool_call_result  data: {call_index, summary}          ← visible only
event: corrigendum       data: {text}
event: turn_complete     data: {turn_id, full_text, cost_usd}
event: error             data: {message, retryable}
```

`tool_call_result` carries a *summary*, not the raw tool output, to keep SSE light. The full `output_json` is in D1 for replay.

## Data flow

### Interactive turn

1. Client `POST /v1/chat/{thread_id}` with JWT + `Idempotency-Key` + `{message}`.
2. api Worker verifies JWT, dispatches to `UserAgentDO` keyed by user_id.
3. DO: if a turn is already in flight, return 409 with the in-flight turn_id (client can re-attach via SSE replay endpoint). Otherwise create AbortController, allocate ULID `turn_id`, open SSE response.
4. Runtime executes phases (buildContext, preflight, orchestrator loop, postReview, persistTurn). Events stream as they happen.
5. SSE closes after `turn_complete` (or `error`).

### Cancellation

- Client closes SSE connection.
- Cloudflare DO observes the response stream close → request signal fires → `currentTurn.abortController.abort()`.
- Orchestrator's Anthropic stream terminates. Outer loop exits on the abort.
- `persistTurn` runs in `finally`: marks turn `status='cancelled'`, persists assembled text so far.
- Already-completed tool side effects (e.g., a `log_meal` that wrote to D1 before abort) are NOT rolled back. The user sees them and can delete via separate UI action.

### Batch turn (5am local)

1. DO `alarm()` fires.
2. Build context with no chat history (or just last 5 messages for color); use a "daily plan" system prompt.
3. Run the same `runTurn` with `actor='system'`, `stream=null`, idempotency key = `daily-plan:${userId}:${date}`.
4. Orchestrator produces structured output via tool calls (`propose_workout`, `propose_meals`).
5. Persist a `chat_turn` row (actor='system', text='Plan generated for {date}.').
6. Enqueue APN.
7. `scheduleNextAlarm()` — compute next 5am in user's TZ, set alarm.

If the alarm errors, retry once after 30 minutes (capped at 3 attempts/day) before surfacing to admin.

### Idempotency

- **Turn-level:** `Idempotency-Key` header dedupes within 24h. On repeat, the DO replays SSE events from D1 (text + tool_call summaries) without calling Anthropic again.
- **Tool-level:** write tools accept an idempotency key in their input. The runtime passes a deterministic key derived from `(turn_id, call_index)`. The unique index on `chat_tool_calls.idempotency_key` blocks duplicates; the handler does `INSERT ... ON CONFLICT DO NOTHING` and reads the existing row.

## Error handling and limits

| Failure | Handling |
|---|---|
| Anthropic 5xx / timeout | Retry once with 1s backoff. On second failure, emit `error` SSE, persist `status='error'`. |
| Stream interrupts mid-token | Persist assembled text with `status='error'`; client can resume with a new turn. |
| Tool transient error | Retry up to 2× with backoff. If still failing, return `{error: 'transient'}` to the model — it decides what to do. |
| Tool permanent error (bad input) | Return `{error: 'bad_input'}` to model. No retry. |
| persistTurn fails | Retry once. If still failing, leave `status='streaming'`; janitor cron sweeps stale rows hourly to `'error'`. |
| DO crash mid-turn | DO restarts cleanly. In-flight row stays `streaming` until janitor sweep. Client gets 502; can retry with same idempotency key. |
| Service binding failure | Tool returns `{error: 'service_unavailable'}`; model handles. |
| AI Gateway 429 | Reject `POST /chat` with 429 + Retry-After. Don't queue. |
| Slow/disconnected client | SSE write fails → abort the turn (same as cancellation). |
| Auth failure | 401 from api Worker before reaching DO. |
| Daily cost cap exceeded | Reject before orchestrator call. Emit single SSE message ("usage cap, resets midnight local"). |

### Cost / rate guards

- **Per-user daily cap:** `users.daily_cost_cap_cents` is the limit (default 150 = $1.50/day). Spent total is computed by summing `chat_turns.cost_usd` for the current local day. Per-day reset is implicit (the SUM is bounded by the date predicate, no nightly write needed).
- **Per-turn token cap:** `max_tokens=4000` orchestrator, `max_tokens=500` safety review.
- **Per-user concurrency:** one in-flight turn per user, enforced by the DO. Second request returns 409 with the in-flight turn_id.

### Observability

- Structured logs (`{level, event, turnId, userId, ...}`) via Cloudflare Logs.
- Per-turn telemetry row in D1: tokens in/out per stage, cost, duration, tool counts.
- Trace IDs: `turn_id` (ULID) propagates as `X-Turn-Id` header to bound Workers.
- AI Gateway provides provider-side metrics for free.
- Alarm health metric: missed batches (`last_alarm_at` > 26h ago) surfaced in admin dashboard.

### Out of scope for v1

- Multi-region failover beyond what CF gives us.
- Provider fallback (Claude → other).
- Background sync of unsent client messages (Flutter handles locally).
- App-level per-IP rate limiting (CF WAF is sufficient).

## Testing strategy

### Layer 1 — Runtime library unit tests

`AgentRuntime` is environment-free; tests inject `RuntimeDeps` fakes. A `scriptedStream` fake replays a pre-recorded sequence of Anthropic SSE events (text deltas, tool uses, stop reasons), making turn lifecycle assertions deterministic.

Coverage: every branch in the runtime — buildContext shape, preflight blocks, tool dispatch, post-review corrigendum, persistence writes, SSE event sequence, abort behavior. Fast (no network, no DO), runs in vitest.

### Layer 2 — Tool handler unit tests

One test file per tool. Real in-memory D1 (better-sqlite3 with the same schema) for D1-touching tools; stubbed `Fetcher` for service-binding tools. Idempotency tests assert second call is a no-op.

### Layer 3 — DO integration tests with Miniflare

Spin up the DO + a stub api Worker in `vitest-pool-workers`. Hit it with `fetch`, assert SSE event sequences. Anthropic stays mocked at this layer.

Critical scenarios:
- Two concurrent `POST /chat` → second gets 409.
- Cancel flow: open SSE, abort, assert `status='cancelled'` in D1.
- Idempotency replay: same key → SSE replay from D1, no Anthropic call.
- Alarm fires → batch turn runs, plan persisted, alarm re-armed.
- DO restart mid-turn → janitor sweeps to `error`.

### Layer 4 — Smoke tests against staging

Hit a deployed staging environment with real Anthropic, real D1, real bindings. Run on every PR + nightly. Connectivity checks only — no assertions on text content.

- "Hello" turn → text_delta within 3s, complete within 15s.
- Tool turn → at least one visible tool event, expected D1 write.
- Batch alarm → manual admin invocation → plan written.
- Safety preflight → "should I take 200mg of caffeine?" → canned response path.
- Cost cap → set cap=1c, send turn, assert cap-exceeded SSE.

### Layer 5 — Safety regression set

Growing fixture file `tests/safety/cases.json` mapping inputs to expected paths (`preflight_block`, `post_review_corrigendum`, `allow`). Run nightly + before release. Production incidents add fixtures.

### Explicitly not tested

- Anthropic's actual outputs. We test handling, not content.
- D1 internals.
- Bound-Worker internals (each has its own suite).

## Open questions / followups

- **JWT issuer / auth flow** is referenced but not designed in this spec. Captured in a separate auth spec.
- **Janitor cron implementation** — a separate scheduled Worker that sweeps `status='streaming'` rows older than 5 minutes to `status='error'`. One-screen of code; will write a small spec or just include in implementation.
- **Admin endpoints** (force re-run alarm, manual cost-cap adjust, re-run a turn) are required for v1 dogfood but not designed here. Drafted as an admin-tools spec.
- **APN delivery** for "plan ready" notifications — out of scope for this spec, will reuse a generic notify Worker.
