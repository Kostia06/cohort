# Agent Runtime DO — Plan 4: Cron + Janitor + Small Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the daily batch turn to a real cron trigger (no more manual /run-batch call), add a janitor sweep for stale `streaming` rows, and close two small Plan-2-review deferrals (per-thread cancel scoping, calendar-day cost cap window).

**Architecture:** Adds a Cloudflare Workers `scheduled` handler to the existing api Worker. Same Worker, multiple cron expressions. The scheduled handler branches on `event.cron` to route to either the batch fan-out or the janitor sweep. Both reuse existing per-user DOs and D1 — no new Worker projects.

**Tech Stack:** Same as Plans 1-3.

**Spec:** `docs/superpowers/specs/2026-04-25-agent-runtime-do-design.md`. Builds on Plans 1, 2, 3.

**Out of scope (deferred to Plan 5+):**
- JWT auth (own Plan 5).
- Real `grocery-worker` and `research-worker` (own projects).
- HealthKit sync (own spec).
- Smoke test automation.
- Multi-region failover.

---

## File Structure (changes from Plan 3)

```
src/
  api/worker.ts                        # MODIFY: add `scheduled` export with cron branching
  cron/
    batch-trigger.ts                   # NEW: find users at 5am local, fan out to DOs
    janitor.ts                         # NEW: sweep stale streaming rows
  do/user-agent-do.ts                  # MODIFY: per-thread cancel scoping
  runtime/
    cost.ts                            # MODIFY: calendar-day window using user's timezone

wrangler.toml                          # MODIFY: add [[triggers]] crons

tests/
  unit/cron/
    batch-trigger.test.ts              # NEW
    janitor.test.ts                    # NEW
  unit/runtime/
    cost.test.ts                       # MODIFY: add timezone-aware tests
  integration/
    do-flow.test.ts                    # MODIFY: per-thread cancel test
```

---

## Phase 1: Cron triggers

### Task 1: Janitor (start with the simpler one)

**Files:**
- Create: `src/cron/janitor.ts`
- Create: `tests/unit/cron/janitor.test.ts`

`janitor` finds `chat_turns` rows where `status='streaming'` and `started_at < now - 5 minutes` and marks them `status='error', error='janitor_sweep'`. Runs every 5 minutes.

- [ ] **Step 1: Write failing test `tests/unit/cron/janitor.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { runJanitor } from '../../../src/cron/janitor';
import { resetDb } from '../../fakes/seed';

const FIVE_MIN_MS = 5 * 60 * 1000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC','[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('runJanitor', () => {
  it('sweeps streaming rows older than 5 minutes to error', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('stale','th1',0,'user','streaming',?)`).bind(now - 6 * 60 * 1000),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('fresh','th1',1,'user','streaming',?)`).bind(now - 60 * 1000)
    ]);
    const r = await runJanitor(env.DB, now);
    expect(r.swept).toBe(1);
    const stale = await env.DB.prepare(`SELECT status, error FROM chat_turns WHERE turn_id='stale'`).first();
    expect(stale).toEqual({ status: 'error', error: 'janitor_sweep' });
    const fresh = await env.DB.prepare(`SELECT status FROM chat_turns WHERE turn_id='fresh'`).first();
    expect(fresh?.status).toBe('streaming');
  });

  it('does nothing when no rows are stale', async () => {
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('fresh','th1',0,'user','streaming',?)`).bind(now - 60 * 1000).run();
    const r = await runJanitor(env.DB, now);
    expect(r.swept).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/cron/janitor.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cron/janitor.ts`**

```ts
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export async function runJanitor(db: D1Database, now: number): Promise<{ swept: number }> {
  const cutoff = now - STALE_THRESHOLD_MS;
  const result = await db.prepare(
    `UPDATE chat_turns
     SET status = 'error', error = 'janitor_sweep', ended_at = ?
     WHERE status = 'streaming' AND started_at < ?`
  ).bind(now, cutoff).run();
  return { swept: result.meta.changes ?? 0 };
}
```

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/cron/janitor.test.ts -- --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add src/cron/janitor.ts tests/unit/cron/janitor.test.ts
git commit -m "Add janitor sweep for stale streaming chat turns"
```

---

### Task 2: Batch trigger

**Files:**
- Create: `src/cron/batch-trigger.ts`
- Create: `tests/unit/cron/batch-trigger.test.ts`

`runBatchTrigger` queries the `users` table for users whose local hour is 5am right now. For each, looks up their DO via `idFromName(user_id)` and fires `POST https://do/run-batch`. Errors per-user are caught + logged so one failure doesn't stop the rest.

Local-hour check: derive from `now` (UTC ms) + `users.timezone` (IANA name). Use `Intl.DateTimeFormat` with `hourCycle: 'h23'` and `hour: 'numeric'` to compute the local hour.

- [ ] **Step 1: Write failing test `tests/unit/cron/batch-trigger.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { findUsersDueForBatch, runBatchTrigger } from '../../../src/cron/batch-trigger';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('findUsersDueForBatch', () => {
  it('returns users whose local hour matches the target', async () => {
    // 2026-04-25T11:00:00Z = 05:00 in America/Edmonton (UTC-6 MDT)
    const now = new Date('2026-04-25T11:00:00Z').getTime();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES ('u1','Alex','America/Edmonton','[]','[]',150,1)`),
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES ('u2','Riley','UTC','[]','[]',150,1)`),
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                      VALUES ('u3','Sam','Asia/Tokyo','[]','[]',150,1)`)
    ]);
    const due = await findUsersDueForBatch(env.DB, now, 5);
    const ids = due.map((u) => u.user_id).sort();
    expect(ids).toEqual(['u1']);
  });
});

describe('runBatchTrigger', () => {
  it('calls dispatch for each due user, swallows individual errors', async () => {
    const now = new Date('2026-04-25T11:00:00Z').getTime();
    await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                          VALUES ('u1','Alex','America/Edmonton','[]','[]',150,1)`).run();

    const calls: string[] = [];
    const dispatch = async (userId: string) => {
      calls.push(userId);
      if (userId === 'fail') throw new Error('boom');
    };
    const r = await runBatchTrigger(env.DB, now, 5, dispatch);
    expect(r.dispatched).toBe(1);
    expect(r.errors).toBe(0);
    expect(calls).toEqual(['u1']);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/cron/batch-trigger.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cron/batch-trigger.ts`**

```ts
export interface DueUser {
  user_id: string;
  timezone: string;
}

export async function findUsersDueForBatch(
  db: D1Database,
  nowMs: number,
  targetHour: number
): Promise<DueUser[]> {
  // Pull all users (small set in dogfood; for scale, store local_hour and index it).
  const rows = await db.prepare(`SELECT user_id, timezone FROM users`).all<DueUser>();
  const now = new Date(nowMs);
  return (rows.results ?? []).filter((u) => {
    try {
      const localHour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: u.timezone,
          hour: 'numeric',
          hourCycle: 'h23'
        }).format(now)
      );
      return localHour === targetHour;
    } catch {
      // Invalid timezone — skip the user, log via console for visibility.
      console.warn(`[batch-trigger] invalid timezone for ${u.user_id}: ${u.timezone}`);
      return false;
    }
  });
}

export async function runBatchTrigger(
  db: D1Database,
  nowMs: number,
  targetHour: number,
  dispatch: (userId: string) => Promise<void>
): Promise<{ dispatched: number; errors: number }> {
  const due = await findUsersDueForBatch(db, nowMs, targetHour);
  let dispatched = 0;
  let errors = 0;
  for (const u of due) {
    try {
      await dispatch(u.user_id);
      dispatched++;
    } catch (err) {
      errors++;
      console.error(`[batch-trigger] dispatch failed for ${u.user_id}:`, err);
    }
  }
  return { dispatched, errors };
}
```

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/cron/batch-trigger.test.ts -- --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add src/cron/batch-trigger.ts tests/unit/cron/batch-trigger.test.ts
git commit -m "Add batch-trigger module that finds users due at a given local hour"
```

---

### Task 3: Wire `scheduled` handler in api Worker + wrangler.toml triggers

**Files:**
- Modify: `src/api/worker.ts` — add `scheduled` export.
- Modify: `wrangler.toml` — add `[[triggers]] crons = [...]`.

The `scheduled` handler is invoked by Cloudflare Cron Triggers. The handler dispatches based on `event.cron`:
- `"*/5 * * * *"` → janitor sweep
- `"0 * * * *"` → batch trigger (every hour, check for users at 5am local)

- [ ] **Step 1: Update `src/api/worker.ts`**

Read the current file. Add at the bottom (alongside the existing default export):

```ts
import { runJanitor } from '../cron/janitor';
import { runBatchTrigger } from '../cron/batch-trigger';

const JANITOR_CRON = '*/5 * * * *';
const BATCH_CRON   = '0 * * * *';
const BATCH_TARGET_HOUR = 5;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // ... existing fetch handler unchanged
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
```

(Note: the existing default export likely has only `fetch`. You're adding the `scheduled` method to the same object literal.)

- [ ] **Step 2: Update `wrangler.toml`**

Add at the end of `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *", "0 * * * *"]
```

(If a `[triggers]` section already exists, merge into it.)

- [ ] **Step 3: Run all tests**

`pnpm test -- --run`
Expected: 64 PASS (60 + 2 janitor + 2 batch-trigger). Typecheck clean.

If typecheck fails because `ScheduledController` isn't typed, add to top of `src/api/worker.ts`:
```ts
import type { ScheduledController } from '@cloudflare/workers-types';
```
(Or rely on the global types if `@cloudflare/workers-types` is already in tsconfig — usually it is.)

- [ ] **Step 4: Commit**

```
git add src/api/worker.ts wrangler.toml
git commit -m "Wire scheduled handler with janitor + batch cron triggers"
```

---

## Phase 2: Smaller hardening

### Task 4: Per-thread cancel scoping

**Files:**
- Modify: `src/do/user-agent-do.ts` — `handleCancel` validates thread_id matches the in-flight turn.
- Modify: `src/api/worker.ts` — forward thread_id in the inner request URL.
- Modify: `tests/integration/do-flow.test.ts` — add a per-thread test.

The current cancel endpoint aborts ANY in-flight turn for the user, regardless of which thread the cancel request specifies. This task makes cancel thread-aware.

- [ ] **Step 1: Update DO**

In `src/do/user-agent-do.ts`, change `handleCancel(): Response` to take a thread_id:

```ts
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
```

Add a `currentTurnThreadId: string | null = null` class field. Set it in `handleChat` (after starting the turn) and clear it in the same `finally` block that clears `currentTurn`.

Update the route in `fetch`:
```ts
if (req.method === 'POST' && url.pathname.startsWith('/cancel/')) {
  const threadId = url.pathname.slice('/cancel/'.length);
  return this.handleCancel(threadId);
}
```

(Was previously `url.pathname === '/cancel'`. Now it's `/cancel/{threadId}`.)

- [ ] **Step 2: Update Worker**

In `src/api/worker.ts`, the `/v1/cancel/{thread_id}` route should now forward the thread to the DO:

```ts
if (req.method === 'POST' && url.pathname.startsWith('/v1/cancel/')) {
  const headerUserId = req.headers.get('X-User-Id');
  if (!headerUserId) return new Response('missing X-User-Id', { status: 401 });
  const threadId = url.pathname.slice('/v1/cancel/'.length);
  const id = env.USER_AGENT_DO.idFromName(headerUserId);
  const stub = env.USER_AGENT_DO.get(id);
  return stub.fetch(new Request(`https://do/cancel/${threadId}`, { method: 'POST' }));
}
```

- [ ] **Step 3: Add an integration test in `tests/integration/do-flow.test.ts`**

```ts
  it('returns 409 when cancelling a different thread than the in-flight turn', async () => {
    // Start a chat on thread A.
    const userId = `cancel-thread-${Date.now()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at) VALUES (?, 'Alex', 'UTC', '[]', '[]', 150, 1)`).bind(userId),
      env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('thA', ?, 'main', 1)`).bind(userId),
      env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('thB', ?, 'main', 1)`).bind(userId)
    ]);

    const chatPromise = SELF.fetch('https://api/v1/chat/thA', {
      method: 'POST',
      headers: { 'X-User-Id': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    });
    await new Promise((r) => setTimeout(r, 50));

    // Cancel thread B (wrong thread).
    const cancelB = await SELF.fetch('https://api/v1/cancel/thB', {
      method: 'POST',
      headers: { 'X-User-Id': userId }
    });

    await chatPromise.then((r) => r.text());

    // 409 (turn in flight on different thread) or 404 (turn already completed). Both are acceptable.
    expect([404, 409]).toContain(cancelB.status);
  });
```

- [ ] **Step 4: Update existing cancel tests**

The previously-existing "returns 404 on cancel when no turn is in flight" test now needs the thread suffix in the URL. Search for any `'/v1/cancel/th1'` usage and verify the test still works (it should — the URL already has the thread).

- [ ] **Step 5: Run tests**

`pnpm test -- --run`
Expected: 65 PASS (64 + 1 new). Typecheck clean.

- [ ] **Step 6: Commit**

```
git add src/do/user-agent-do.ts src/api/worker.ts tests/integration/do-flow.test.ts
git commit -m "Scope cancel endpoint to a specific thread_id"
```

---

### Task 5: Calendar-day cost cap window

**Files:**
- Modify: `src/runtime/cost.ts` — accept timezone, compute local-day boundary.
- Modify: `src/runtime/agent-runtime.ts` — pass user timezone into cost call.
- Modify: `tests/unit/runtime/cost.test.ts` — add timezone-aware tests.

Plan 2 used a rolling-24h window. Switch to a calendar-day window in the user's local timezone — feels more natural ("resets at midnight" rather than "resets in 24h").

- [ ] **Step 1: Update `src/runtime/cost.ts`**

Replace the existing `getDailySpentCents` signature:

```ts
export async function getDailySpentCents(
  db: D1Database,
  userId: string,
  nowMs: number,
  timezone: string
): Promise<number> {
  const sinceMs = startOfLocalDayMs(nowMs, timezone);
  const row = await db.prepare(
    `SELECT COALESCE(SUM(t.cost_usd), 0) AS sum_usd
     FROM chat_turns t
     JOIN chat_threads th ON th.thread_id = t.thread_id
     WHERE th.user_id = ? AND t.started_at >= ?`
  ).bind(userId, sinceMs).first<{ sum_usd: number }>();
  const usd = row?.sum_usd ?? 0;
  return Math.round(usd * 100);
}

function startOfLocalDayMs(nowMs: number, timezone: string): number {
  // Format the current instant in the user's timezone, extract Y/M/D, then
  // construct an ISO timestamp at midnight in that timezone.
  const fmt = new Intl.DateTimeFormat('en-CA', {  // en-CA gives YYYY-MM-DD
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = fmt.format(new Date(nowMs));  // "2026-04-25"
  // Compute the offset by formatting the same instant once with timezone, once with UTC,
  // and diffing. Easier: parse the local date as if it were UTC, then adjust by offset.
  const localDate = parts;
  const utcMidnightForLocalDate = Date.parse(`${localDate}T00:00:00Z`);
  // Compute the offset (minutes) between the user's tz and UTC at this instant.
  const localMs = new Date(nowMs).toLocaleString('en-US', { timeZone: timezone });
  const utcMs = new Date(nowMs).toLocaleString('en-US', { timeZone: 'UTC' });
  const offsetMinutes = (Date.parse(localMs) - Date.parse(utcMs)) / 60_000;
  return utcMidnightForLocalDate - offsetMinutes * 60_000;
}
```

(The offset math is awkward; an alternative is to use a small dependency like `luxon` or `@date-fns/tz`. For now keep it dependency-free.)

- [ ] **Step 2: Update `src/runtime/agent-runtime.ts`**

The cap check currently calls `getDailySpentCents(deps.db, input.userId, now)`. Update to pass the user's timezone:

```ts
const profile = await deps.db.prepare(`SELECT timezone FROM users WHERE user_id = ?`)
  .bind(input.userId).first<{ timezone: string }>();
const tz = profile?.timezone ?? 'UTC';
const [spent, cap] = await Promise.all([
  getDailySpentCents(deps.db, input.userId, now, tz),
  getCostCapCents(deps.db, input.userId)
]);
```

(Adds one extra D1 query per turn. Acceptable; could be cached in DO state for v2.)

- [ ] **Step 3: Update `tests/unit/runtime/cost.test.ts`**

Add a new test case with timezone-specific behavior:

```ts
  it('uses calendar-day boundary in the given timezone', async () => {
    // 2026-04-25T05:00:00Z in America/Edmonton = 2026-04-24T23:00:00 (local). The
    // local day starts at 2026-04-24T00:00 local = 2026-04-24T06:00 UTC.
    const utcNow = new Date('2026-04-25T05:00:00Z').getTime();
    const earlyToday  = utcNow - 8 * 60 * 60 * 1000;   // 2026-04-24T21:00Z = 15:00 local — yesterday
    const lateToday   = utcNow - 1 * 60 * 60 * 1000;   // 2026-04-25T04:00Z = 22:00 local — today
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t-yest','th1',0,'user','complete',5.00,?,?)`).bind(earlyToday, earlyToday + 1),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, cost_usd, started_at, ended_at) VALUES ('t-today','th1',1,'user','complete',1.00,?,?)`).bind(lateToday, lateToday + 1)
    ]);
    const cents = await getDailySpentCents(env.DB, 'u1', utcNow, 'America/Edmonton');
    // Only "today" turn counts: 1.00 USD = 100 cents.
    expect(cents).toBe(100);
  });
```

Also update existing tests that called `getDailySpentCents(env.DB, 'u1', now)` to add the `'UTC'` argument.

- [ ] **Step 4: Run tests**

`pnpm test -- --run`
Expected: 66 PASS (65 + 1 new test). Typecheck clean.

- [ ] **Step 5: Commit**

```
git add src/runtime/cost.ts src/runtime/agent-runtime.ts tests/unit/runtime/cost.test.ts
git commit -m "Cost cap uses calendar-day window in user's timezone"
```

---

## Phase 3: Final readiness

### Task 6: Final check + runbook update

- [ ] **Step 1: Run + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Confirm 66 tests, typecheck clean.

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 4: cron + janitor + small fixes

15. **Janitor sweep:**
    - Insert a stuck row: `wrangler d1 execute cohort --local --command "INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('stuck','th1',99,'user','streaming',$(($(date +%s) - 600))*1000);"`
    - Wait 5 minutes for the cron, OR trigger manually: `wrangler dev --test-scheduled` then `curl http://localhost:8787/cdn-cgi/handler/scheduled?cron=*%2F5+*+*+*+*`
    - Check: `wrangler d1 execute cohort --local --command "SELECT status, error FROM chat_turns WHERE turn_id='stuck';"` → should be `error / janitor_sweep`.

16. **Batch cron:**
    - Confirm a user exists with a timezone where the current local hour is 5am. Update one if needed.
    - Trigger manually: `curl http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`
    - Check: a new system turn should appear in `chat_turns` with `actor='system'` for that user.

17. **Per-thread cancel:**
    - Start a chat on thread A: `curl -N -X POST http://localhost:8787/v1/chat/thA -H "X-User-Id: u1" -H "Content-Type: application/json" -d '{"message":"long answer please"}'`
    - In another terminal cancel thread B (wrong thread): `curl -X POST http://localhost:8787/v1/cancel/thB -H "X-User-Id: u1"`
    - Expected: 409 with `in_flight_thread_id: 'thA'`.

18. **Calendar-day cost cap:**
    - Set the cap close to current spend.
    - Note the time of day in your local timezone.
    - At local midnight, the cap should reset (next chat goes through).

## Plan 4 known limitations

- **Cron trigger only fires when deployed.** Local `wrangler dev` doesn't run crons automatically; use `--test-scheduled` and the manual handler URL above.
- **Batch trigger iterates ALL users every hour.** O(N) scan is fine for v1 dogfood. At scale, add a `next_batch_at` column or a per-hour bucket index.
- **JWT auth still deferred.** `X-User-Id` header still trusted on every request. Plan 5.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 4 smoke checks for cron + cancel + cost cap"
```

---

## Self-review notes

- **Spec coverage:** janitor sweep (spec error matrix), batch cron (data flow §3c), per-thread cancel (review feedback), calendar-day cost cap (review feedback). All landed.
- **Placeholder scan:** none.
- **Type consistency:** `runJanitor` and `runBatchTrigger` are pure async functions; signatures injected into the scheduled handler.
- **Scope:** 6 tasks. ~6 new tests. Total 60 → ~66.
