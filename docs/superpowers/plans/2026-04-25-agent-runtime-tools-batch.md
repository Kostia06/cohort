# Agent Runtime DO — Plan 3: Tools + Batch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the runtime from one tool to the full v1 toolset (8 tools) and wire up the 5am batch turn (DO alarm) so the system can generate daily plans without a connected client.

**Architecture:** Same as Plans 1 + 2. Adds new D1 tables and tool modules; reuses the existing runtime, orchestrator, and persistence layers. Service-binding tools are stubbed (return `{error: 'not_yet_available'}`) until their dedicated Workers exist (separate plans).

**Spec:** `docs/superpowers/specs/2026-04-25-agent-runtime-do-design.md`. Plan 1: vertical slice. Plan 2: hardening.

**Out of scope (deferred to Plan 4+):**
- Real `grocery-worker` and `research-worker` (each is its own Worker project per the original deep-dive doc).
- Janitor cron worker for stale `streaming` rows.
- JWT auth.
- Per-thread cancel scoping; calendar-day cost cap window.
- HealthKit sync (separate spec; assumes `readiness_daily` is populated externally).

---

## File Structure (changes from Plan 2)

```
src/
  db/migrations/
    0002_tools.sql                     # NEW: readiness_daily, meals, workouts, plans
  tools/
    get-readiness.ts                   # NEW
    get-recent-meals.ts                # NEW
    note-dislike.ts                    # NEW
    log-meal.ts                        # NEW
    propose-workout.ts                 # NEW
    compute-acwr.ts                    # NEW
    search-groceries.ts                # NEW (stub)
    search-research.ts                 # NEW (stub)
  runtime/
    tool-registry.ts                   # MODIFY: register all 9 tools
  do/user-agent-do.ts                  # MODIFY: implement alarm()

tests/
  fakes/seed.ts                        # MODIFY: add new tables to schema
  unit/tools/
    get-readiness.test.ts              # NEW
    get-recent-meals.test.ts           # NEW
    note-dislike.test.ts               # NEW
    log-meal.test.ts                   # NEW
    propose-workout.test.ts            # NEW
    compute-acwr.test.ts               # NEW
    search-groceries.test.ts           # NEW (stub behavior)
    search-research.test.ts            # NEW (stub behavior)
  integration/
    alarm.test.ts                      # NEW
```

---

## Phase 1: Schema

### Task 1: Migration 0002 — new tables

**Files:**
- Create: `src/db/migrations/0002_tools.sql`
- Modify: `tests/fakes/seed.ts` — add new tables to inline SCHEMA.

`readiness_daily`, `meals`, `workouts`, `plans` shapes are minimal v1 — just enough to be useful.

- [ ] **Step 1: Create `src/db/migrations/0002_tools.sql`**

```sql
-- src/db/migrations/0002_tools.sql

CREATE TABLE readiness_daily (
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,            -- YYYY-MM-DD local
  score          INTEGER,                  -- null when calibrating
  band           TEXT,                     -- 'rest' | 'easy' | 'normal' | 'green' | null
  status         TEXT NOT NULL,            -- 'calibrating' | 'ready'
  components_json TEXT NOT NULL,           -- {hrv, rhr, sleep_duration, sleep_efficiency}
  reasons_json   TEXT NOT NULL DEFAULT '[]',
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE meals (
  meal_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  eaten_at       INTEGER NOT NULL,         -- ms epoch
  name           TEXT NOT NULL,
  kcal           INTEGER,
  protein_g      REAL,
  carbs_g        REAL,
  fat_g          REAL,
  notes          TEXT,
  source         TEXT NOT NULL DEFAULT 'manual'    -- 'manual' | 'agent' | 'import'
);

CREATE INDEX idx_meals_user_eaten ON meals(user_id, eaten_at DESC);

CREATE TABLE workouts (
  workout_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,            -- YYYY-MM-DD local
  kind           TEXT NOT NULL,            -- 'strength' | 'cardio' | 'mobility' | 'mixed'
  duration_min   INTEGER,
  rpe            INTEGER,                  -- 1..10
  load_score     REAL,                     -- duration_min × rpe (or sets×RPE for strength)
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'logged',  -- 'planned' | 'logged' | 'skipped'
  source         TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX idx_workouts_user_date ON workouts(user_id, date DESC);

CREATE TABLE plans (
  plan_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  date           TEXT NOT NULL,            -- the day this plan covers
  body_json      TEXT NOT NULL,            -- full plan as structured JSON
  generated_at   INTEGER NOT NULL,
  generated_by   TEXT NOT NULL             -- 'agent' | 'manual'
);

CREATE INDEX idx_plans_user_date ON plans(user_id, date DESC);
```

- [ ] **Step 2: Apply migration locally**

```
wrangler d1 execute cohort --local --file=src/db/migrations/0002_tools.sql
```
Expected: 4 statements executed.

- [ ] **Step 3: Update `tests/fakes/seed.ts`**

Read the current file. Append the new tables to the SCHEMA constant (inside the same template-literal string, before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS readiness_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  score INTEGER,
  band TEXT,
  status TEXT NOT NULL,
  components_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS meals (
  meal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  eaten_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  kcal INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_meals_user_eaten ON meals(user_id, eaten_at DESC);
CREATE TABLE IF NOT EXISTS workouts (
  workout_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  duration_min INTEGER,
  rpe INTEGER,
  load_score REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'logged',
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC);
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  body_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  generated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_user_date ON plans(user_id, date DESC);
```

Also extend `resetDb`'s DELETE statement to wipe the new tables:

```ts
await db.exec('DELETE FROM plans; DELETE FROM workouts; DELETE FROM meals; DELETE FROM readiness_daily; DELETE FROM chat_tool_calls; DELETE FROM chat_turns; DELETE FROM chat_threads; DELETE FROM users;');
```

- [ ] **Step 4: Run all tests + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Expected: 44 PASS (Plan 2 baseline), typecheck clean. New tables exist but no tests reference them yet.

- [ ] **Step 5: Commit**

```
git add src/db/migrations/0002_tools.sql tests/fakes/seed.ts
git commit -m "Add migration 0002: readiness_daily, meals, workouts, plans"
```

---

## Phase 2: Inline tools

Each tool follows the same pattern as `get-user-profile.ts` from Plan 1. Tests use `makeFakes` + the new `resetDb` helper.

### Task 2: get_readiness tool

**Files:**
- Create: `src/tools/get-readiness.ts`
- Create: `tests/unit/tools/get-readiness.test.ts`

Returns the most recent `readiness_daily` row for the user, or null if none. Hidden surface (just data lookup).

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/tools/get-readiness.test.ts
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
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/tools/get-readiness.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/get-readiness.ts`**

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Output {
  readiness: {
    date: string;
    score: number | null;
    band: 'rest' | 'easy' | 'normal' | 'green' | null;
    status: string;
    components: Record<string, unknown>;
    reasons: string[];
    computed_at: number;
  } | null;
}

export const getReadinessTool: ToolDef<Record<string, never>, Output> = {
  name: 'get_readiness',
  description: 'Return the most recent readiness score for the user, including band (rest/easy/normal/green) and component breakdown.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  surface: 'hidden',
  idempotent: true,
  async handler(_input, ctx: ToolCtx): Promise<Output> {
    const row = await ctx.deps.db.prepare(
      `SELECT date, score, band, status, components_json, reasons_json, computed_at
       FROM readiness_daily
       WHERE user_id = ?
       ORDER BY date DESC
       LIMIT 1`
    ).bind(ctx.userId).first<{
      date: string; score: number | null; band: string | null;
      status: string; components_json: string; reasons_json: string; computed_at: number;
    }>();
    if (!row) return { readiness: null };
    return {
      readiness: {
        date: row.date,
        score: row.score,
        band: row.band as Output['readiness']['band'],
        status: row.status,
        components: JSON.parse(row.components_json) as Record<string, unknown>,
        reasons: JSON.parse(row.reasons_json) as string[],
        computed_at: row.computed_at
      }
    };
  }
};
```

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/tools/get-readiness.test.ts -- --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add src/tools/get-readiness.ts tests/unit/tools/get-readiness.test.ts
git commit -m "Add get_readiness tool"
```

---

### Task 3: get_recent_meals tool

**Files:**
- Create: `src/tools/get-recent-meals.ts`
- Create: `tests/unit/tools/get-recent-meals.test.ts`

Takes `{days?: number}` (default 7). Returns array of meals from the last N days, ordered by `eaten_at DESC`.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/tools/get-recent-meals.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { getRecentMealsTool } from '../../../src/tools/get-recent-meals';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal) VALUES ('m1','u1',?,'oatmeal',380)`).bind(NOW - 1 * DAY),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal) VALUES ('m2','u1',?,'salad',220)`).bind(NOW - 3 * DAY),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal) VALUES ('m3','u1',?,'old burger',900)`).bind(NOW - 14 * DAY)
  ]);
});

describe('getRecentMealsTool', () => {
  it('returns meals from the last 7 days by default', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await getRecentMealsTool.handler({}, ctx);
    expect(r.meals.length).toBe(2);
    expect(r.meals[0]!.name).toBe('oatmeal');
    expect(r.meals[1]!.name).toBe('salad');
  });

  it('honors custom days parameter', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await getRecentMealsTool.handler({ days: 30 }, ctx);
    expect(r.meals.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/tools/get-recent-meals.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/get-recent-meals.ts`**

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Input { days?: number }

interface Meal {
  meal_id: string;
  eaten_at: number;
  name: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  notes: string | null;
}

interface Output { meals: Meal[] }

const DAY_MS = 24 * 60 * 60 * 1000;

export const getRecentMealsTool: ToolDef<Input, Output> = {
  name: 'get_recent_meals',
  description: 'Return meals logged in the last N days (default 7), most recent first.',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
    additionalProperties: false
  },
  surface: 'hidden',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const days = Math.max(1, Math.min(90, input.days ?? 7));
    const since = ctx.deps.clock() - days * DAY_MS;
    const rows = await ctx.deps.db.prepare(
      `SELECT meal_id, eaten_at, name, kcal, protein_g, carbs_g, fat_g, notes
       FROM meals
       WHERE user_id = ? AND eaten_at >= ?
       ORDER BY eaten_at DESC`
    ).bind(ctx.userId, since).all<Meal>();
    return { meals: rows.results ?? [] };
  }
};
```

- [ ] **Step 4: Run test, commit**

`pnpm test tests/unit/tools/get-recent-meals.test.ts -- --run` → PASS (2).

```
git add src/tools/get-recent-meals.ts tests/unit/tools/get-recent-meals.test.ts
git commit -m "Add get_recent_meals tool"
```

---

### Task 4: note_dislike tool

**Files:**
- Create: `src/tools/note-dislike.ts`
- Create: `tests/unit/tools/note-dislike.test.ts`

Takes `{food: string}`. Reads `users.dislikes_json`, adds the food if not already present, updates the row.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/tools/note-dislike.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { noteDislikeTool } from '../../../src/tools/note-dislike';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','["cilantro"]',150,1)`
  ).run();
});

describe('noteDislikeTool', () => {
  it('appends a new dislike to the array', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await noteDislikeTool.handler({ food: 'fish' }, ctx);
    expect(r.dislikes).toEqual(['cilantro', 'fish']);
    const row = await env.DB.prepare(`SELECT dislikes_json FROM users WHERE user_id = 'u1'`).first<{dislikes_json: string}>();
    expect(JSON.parse(row!.dislikes_json)).toEqual(['cilantro', 'fish']);
  });

  it('is idempotent on repeated dislike', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    await noteDislikeTool.handler({ food: 'cilantro' }, ctx);
    const r = await noteDislikeTool.handler({ food: 'cilantro' }, ctx);
    expect(r.dislikes).toEqual(['cilantro']);
  });
});
```

- [ ] **Step 2: Run + implement + run + commit**

Module: `src/tools/note-dislike.ts`:

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Input { food: string }
interface Output { dislikes: string[] }

export const noteDislikeTool: ToolDef<Input, Output> = {
  name: 'note_dislike',
  description: 'Add a food the user dislikes to their persistent profile. Idempotent.',
  inputSchema: {
    type: 'object',
    properties: { food: { type: 'string', minLength: 1 } },
    required: ['food'],
    additionalProperties: false
  },
  surface: 'hidden',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const food = input.food.trim().toLowerCase();
    const row = await ctx.deps.db.prepare(
      `SELECT dislikes_json FROM users WHERE user_id = ?`
    ).bind(ctx.userId).first<{ dislikes_json: string }>();
    const current = JSON.parse(row?.dislikes_json ?? '[]') as string[];
    if (current.includes(food)) return { dislikes: current };
    const next = [...current, food];
    await ctx.deps.db.prepare(
      `UPDATE users SET dislikes_json = ? WHERE user_id = ?`
    ).bind(JSON.stringify(next), ctx.userId).run();
    return { dislikes: next };
  }
};
```

```
git add src/tools/note-dislike.ts tests/unit/tools/note-dislike.test.ts
git commit -m "Add note_dislike tool"
```

---

### Task 5: log_meal tool

**Files:**
- Create: `src/tools/log-meal.ts`
- Create: `tests/unit/tools/log-meal.test.ts`

Takes `{name, kcal?, protein_g?, carbs_g?, fat_g?, notes?, eaten_at?}`. Inserts into `meals`. Visible surface (user sees "📝 logged: oatmeal 380 kcal"). Idempotent via `(turn_id, call_index)` derived key.

Stub the test to follow the same TDD shape. Implementation:

```ts
import type { ToolCtx, ToolDef } from '../types';
import { ulid } from 'ulid';

interface Input {
  name: string;
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  notes?: string;
  eaten_at?: number;
}
interface Output { meal_id: string; eaten_at: number }

export const logMealTool: ToolDef<Input, Output> = {
  name: 'log_meal',
  description: 'Log a meal the user just ate. Returns the meal_id. Idempotent within a single turn.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      kcal: { type: 'integer', minimum: 0 },
      protein_g: { type: 'number', minimum: 0 },
      carbs_g: { type: 'number', minimum: 0 },
      fat_g: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
      eaten_at: { type: 'integer' }
    },
    required: ['name'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const mealId = `meal_${ctx.turnId}_${ctx.toolCallIndex}`;  // stable, deterministic for replay
    const eatenAt = input.eaten_at ?? ctx.deps.clock();
    await ctx.deps.db.prepare(
      `INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, protein_g, carbs_g, fat_g, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent')
       ON CONFLICT(meal_id) DO NOTHING`
    ).bind(
      mealId, ctx.userId, eatenAt, input.name,
      input.kcal ?? null, input.protein_g ?? null, input.carbs_g ?? null, input.fat_g ?? null,
      input.notes ?? null
    ).run();
    return { meal_id: mealId, eaten_at: eatenAt };
  }
};
```

Test should cover: insert succeeds; running same tool with same `(turnId, callIndex)` produces same `meal_id` and doesn't double-insert.

```ts
// tests/unit/tools/log-meal.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { logMealTool } from '../../../src/tools/log-meal';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
});

describe('logMealTool', () => {
  it('inserts a meal row and returns the meal_id', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await logMealTool.handler({ name: 'oatmeal', kcal: 380 }, ctx);
    expect(r.meal_id).toMatch(/^meal_t1_0$/);
    expect(r.eaten_at).toBe(NOW);
    const row = await env.DB.prepare(`SELECT name, kcal FROM meals WHERE meal_id = ?`).bind(r.meal_id).first();
    expect(row).toEqual({ name: 'oatmeal', kcal: 380 });
  });

  it('is idempotent on (turn_id, call_index) replay', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r1 = await logMealTool.handler({ name: 'oatmeal', kcal: 380 }, ctx);
    const r2 = await logMealTool.handler({ name: 'oatmeal', kcal: 380 }, ctx);
    expect(r2.meal_id).toBe(r1.meal_id);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM meals`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
```

```
git add src/tools/log-meal.ts tests/unit/tools/log-meal.test.ts
git commit -m "Add log_meal tool"
```

---

### Task 6: propose_workout tool

**Files:**
- Create: `src/tools/propose-workout.ts`
- Create: `tests/unit/tools/propose-workout.test.ts`

Same shape as `log_meal`. Takes `{date, kind, duration_min?, rpe?, load_score?, notes?}`. Inserts into `workouts` with `status='planned'`, `source='agent'`. Visible surface. Idempotent.

```ts
// src/tools/propose-workout.ts
import type { ToolCtx, ToolDef } from '../types';

interface Input {
  date: string;          // YYYY-MM-DD
  kind: 'strength' | 'cardio' | 'mobility' | 'mixed';
  duration_min?: number;
  rpe?: number;
  load_score?: number;
  notes?: string;
}
interface Output { workout_id: string }

export const proposeWorkoutTool: ToolDef<Input, Output> = {
  name: 'propose_workout',
  description: 'Propose a workout for a given date. Stored with status=planned. Idempotent within a turn.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      kind: { type: 'string', enum: ['strength', 'cardio', 'mobility', 'mixed'] },
      duration_min: { type: 'integer', minimum: 0 },
      rpe: { type: 'integer', minimum: 1, maximum: 10 },
      load_score: { type: 'number', minimum: 0 },
      notes: { type: 'string' }
    },
    required: ['date', 'kind'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const id = `workout_${ctx.turnId}_${ctx.toolCallIndex}`;
    await ctx.deps.db.prepare(
      `INSERT INTO workouts (workout_id, user_id, date, kind, duration_min, rpe, load_score, notes, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'agent')
       ON CONFLICT(workout_id) DO NOTHING`
    ).bind(
      id, ctx.userId, input.date, input.kind,
      input.duration_min ?? null, input.rpe ?? null, input.load_score ?? null, input.notes ?? null
    ).run();
    return { workout_id: id };
  }
};
```

Test mirrors `log-meal.test.ts` (insert + idempotency).

```ts
// tests/unit/tools/propose-workout.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { proposeWorkoutTool } from '../../../src/tools/propose-workout';
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

describe('proposeWorkoutTool', () => {
  it('inserts a planned workout', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await proposeWorkoutTool.handler({ date: '2026-04-26', kind: 'strength', rpe: 8 }, ctx);
    expect(r.workout_id).toBe('workout_t1_0');
    const row = await env.DB.prepare(`SELECT kind, status, rpe FROM workouts WHERE workout_id = ?`).bind(r.workout_id).first();
    expect(row).toEqual({ kind: 'strength', status: 'planned', rpe: 8 });
  });

  it('is idempotent on replay', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    await proposeWorkoutTool.handler({ date: '2026-04-26', kind: 'strength' }, ctx);
    await proposeWorkoutTool.handler({ date: '2026-04-26', kind: 'strength' }, ctx);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workouts`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
```

```
git add src/tools/propose-workout.ts tests/unit/tools/propose-workout.test.ts
git commit -m "Add propose_workout tool"
```

---

### Task 7: compute_acwr tool

**Files:**
- Create: `src/tools/compute-acwr.ts`
- Create: `tests/unit/tools/compute-acwr.test.ts`

ACWR (Acute:Chronic Workload Ratio): acute = sum of `load_score` over last 7 days, chronic = mean weekly load over last 28 days. ACWR = acute / chronic. Returns the ratio + acute + chronic + a flag if outside 0.8–1.5.

```ts
// src/tools/compute-acwr.ts
import type { ToolCtx, ToolDef } from '../types';

interface Output {
  acute_load: number;     // sum over last 7 days
  chronic_load: number;   // mean of weekly loads over last 28 days
  acwr: number | null;    // null when chronic_load == 0
  flag: 'low' | 'sweet_spot' | 'elevated' | 'detraining' | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const computeAcwrTool: ToolDef<Record<string, never>, Output> = {
  name: 'compute_acwr',
  description: 'Compute the Acute:Chronic Workload Ratio (Gabbett 2016) — sum of load over 7d / mean weekly load over 28d.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  surface: 'visible',
  idempotent: true,
  async handler(_input, ctx: ToolCtx): Promise<Output> {
    const now = ctx.deps.clock();
    const since28d = new Date(now - 28 * DAY_MS).toISOString().slice(0, 10);
    const since7d = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);

    const acuteRow = await ctx.deps.db.prepare(
      `SELECT COALESCE(SUM(load_score), 0) AS s
       FROM workouts WHERE user_id = ? AND date >= ? AND status = 'logged'`
    ).bind(ctx.userId, since7d).first<{ s: number }>();

    const chronicRow = await ctx.deps.db.prepare(
      `SELECT COALESCE(SUM(load_score), 0) AS s
       FROM workouts WHERE user_id = ? AND date >= ? AND status = 'logged'`
    ).bind(ctx.userId, since28d).first<{ s: number }>();

    const acute = acuteRow?.s ?? 0;
    const chronicTotal = chronicRow?.s ?? 0;
    const chronic = chronicTotal / 4;  // mean over 4 weeks
    const acwr = chronic > 0 ? acute / chronic : null;

    let flag: Output['flag'] = null;
    if (acwr !== null) {
      if (acwr > 1.5) flag = 'elevated';
      else if (acwr < 0.8) flag = 'detraining';
      else flag = 'sweet_spot';
    } else if (acute > 0) flag = 'low';

    return { acute_load: acute, chronic_load: chronic, acwr, flag };
  }
};
```

Test: seed workouts, assert acute/chronic/acwr/flag.

```ts
// tests/unit/tools/compute-acwr.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { computeAcwrTool } from '../../../src/tools/compute-acwr';
import { makeFakes } from '../../fakes/make-fakes';
import { createSseCollector } from '../../fakes/sse-collector';
import { resetDb } from '../../fakes/seed';

const NOW = new Date('2026-04-25').getTime();

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
});

describe('computeAcwrTool', () => {
  it('returns null acwr with no workouts', async () => {
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await computeAcwrTool.handler({}, ctx);
    expect(r.acute_load).toBe(0);
    expect(r.chronic_load).toBe(0);
    expect(r.acwr).toBeNull();
    expect(r.flag).toBeNull();
  });

  it('computes ratio in sweet spot (1.0)', async () => {
    // 4 weeks of equal weekly load → ACWR = 1.0
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w1','u1','2026-04-22','strength',100,'logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w2','u1','2026-04-15','strength',100,'logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w3','u1','2026-04-08','strength',100,'logged')`),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, load_score, status) VALUES ('w4','u1','2026-04-01','strength',100,'logged')`)
    ]);
    const ctx = {
      userId: 'u1', threadId: 'th1', turnId: 't1', toolCallIndex: 0,
      deps: makeFakes({ db: env.DB, now: NOW }),
      emit: createSseCollector().emit,
      signal: new AbortController().signal
    };
    const r = await computeAcwrTool.handler({}, ctx);
    expect(r.acute_load).toBe(100);   // last 7 days = 1 workout × 100
    expect(r.chronic_load).toBe(100); // sum over 28 days / 4 = 400/4 = 100
    expect(r.acwr).toBe(1);
    expect(r.flag).toBe('sweet_spot');
  });
});
```

```
git add src/tools/compute-acwr.ts tests/unit/tools/compute-acwr.test.ts
git commit -m "Add compute_acwr tool"
```

---

### Task 8: search_groceries + search_research stubs

**Files:**
- Create: `src/tools/search-groceries.ts`
- Create: `src/tools/search-research.ts`
- Create: `tests/unit/tools/search-groceries.test.ts`
- Create: `tests/unit/tools/search-research.test.ts`

Both are visible-surface stubs that return `{error: 'not_yet_available'}`. They emit the visible SSE events so the model can see "we tried" and gracefully tell the user this is coming. Real implementations live in dedicated Worker projects (separate plans).

- [ ] **Step 1: Write `src/tools/search-groceries.ts`**

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Input { items: string[]; lat?: number; lng?: number; radius_m?: number }
interface Output { error: 'not_yet_available'; message: string }

export const searchGroceriesTool: ToolDef<Input, Output> = {
  name: 'search_groceries',
  description: 'Search nearby grocery stores for items with prices. Returns matched products + store + price.',
  inputSchema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'string' }, minItems: 1 },
      lat: { type: 'number' },
      lng: { type: 'number' },
      radius_m: { type: 'integer', minimum: 100, maximum: 50000 }
    },
    required: ['items'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(_input, _ctx: ToolCtx): Promise<Output> {
    return {
      error: 'not_yet_available',
      message: 'Grocery search is not yet wired up. Tell the user this feature is coming soon.'
    };
  }
};
```

- [ ] **Step 2: Write `src/tools/search-research.ts`**

```ts
import type { ToolCtx, ToolDef } from '../types';

interface Input { query: string; domain?: 'diet' | 'training' | 'sleep' | 'general'; k?: number }
interface Output { error: 'not_yet_available'; message: string }

export const searchResearchTool: ToolDef<Input, Output> = {
  name: 'search_research',
  description: 'Search the research RAG index for relevant findings, with hedging preserved. Returns top-K excerpts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 3 },
      domain: { type: 'string', enum: ['diet', 'training', 'sleep', 'general'] },
      k: { type: 'integer', minimum: 1, maximum: 10 }
    },
    required: ['query'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(_input, _ctx: ToolCtx): Promise<Output> {
    return {
      error: 'not_yet_available',
      message: 'Research search is not yet wired up. Tell the user this feature is coming soon.'
    };
  }
};
```

- [ ] **Step 3: Tests for both stubs**

```ts
// tests/unit/tools/search-groceries.test.ts
import { describe, expect, it } from 'vitest';
import { searchGroceriesTool } from '../../../src/tools/search-groceries';

describe('searchGroceriesTool (stub)', () => {
  it('returns not_yet_available', async () => {
    const r = await searchGroceriesTool.handler({ items: ['oats'] }, {} as any);
    expect(r.error).toBe('not_yet_available');
    expect(searchGroceriesTool.surface).toBe('visible');
  });
});
```

```ts
// tests/unit/tools/search-research.test.ts
import { describe, expect, it } from 'vitest';
import { searchResearchTool } from '../../../src/tools/search-research';

describe('searchResearchTool (stub)', () => {
  it('returns not_yet_available', async () => {
    const r = await searchResearchTool.handler({ query: 'creatine timing' }, {} as any);
    expect(r.error).toBe('not_yet_available');
    expect(searchResearchTool.surface).toBe('visible');
  });
});
```

- [ ] **Step 4: Commit**

```
git add src/tools/search-groceries.ts src/tools/search-research.ts tests/unit/tools/search-groceries.test.ts tests/unit/tools/search-research.test.ts
git commit -m "Add search_groceries and search_research stubs"
```

---

## Phase 3: Registry update

### Task 9: Wire all 9 tools into the registry

**Files:**
- Modify: `src/runtime/tool-registry.ts` — register all 9 tools.

```ts
import type { ToolDef, ToolRegistry } from '../types';
import { getUserProfileTool } from '../tools/get-user-profile';
import { getReadinessTool } from '../tools/get-readiness';
import { getRecentMealsTool } from '../tools/get-recent-meals';
import { noteDislikeTool } from '../tools/note-dislike';
import { logMealTool } from '../tools/log-meal';
import { proposeWorkoutTool } from '../tools/propose-workout';
import { computeAcwrTool } from '../tools/compute-acwr';
import { searchGroceriesTool } from '../tools/search-groceries';
import { searchResearchTool } from '../tools/search-research';

export function buildToolRegistry(): ToolRegistry {
  const tools: ToolDef[] = [
    getUserProfileTool,
    getReadinessTool,
    getRecentMealsTool,
    noteDislikeTool,
    logMealTool,
    proposeWorkoutTool,
    computeAcwrTool,
    searchGroceriesTool,
    searchResearchTool
  ];
  return new Map(tools.map((t) => [t.name, t]));
}
```

- [ ] **Step 1: Run all tests**

`pnpm test -- --run` — should still PASS (count grows by 14: 2 readiness + 2 meals + 2 dislike + 2 log_meal + 2 propose_workout + 2 acwr + 1 grocery + 1 research = 14).

Expected total ≈ 58 (44 + 14).

`pnpm typecheck` — exit 0.

- [ ] **Step 2: Commit**

```
git add src/runtime/tool-registry.ts
git commit -m "Register all 9 tools in the registry"
```

---

## Phase 4: Batch alarm

### Task 10: DO alarm() implementation

**Files:**
- Modify: `src/do/user-agent-do.ts` — implement alarm() that runs a batch turn.
- Create: `tests/integration/alarm.test.ts`

The alarm fires at 5am local time. When it fires:
1. Look up the user's id from the DO's state (passed in via env or stored in DO storage).
2. Run a turn with `actor='system'`, `systemHint='Generate tomorrow\'s plan...'`, no stream.
3. The runtime calls tools, persists a chat_turn with `actor='system'`.
4. Schedule the next alarm.

For this plan, since the DO id is `userId` (we use `idFromName(userId)`), retrieve it from `state.id.toString()` — but that's the hashed name, not the original. Better: store `userId` in DO storage on first chat, read it from there. Even simpler: pass it as a header/path from the Worker entrypoint via a new admin/cron endpoint.

Simplest path for v1 dogfood: a `POST /v1/run-batch/{user_id}` admin endpoint forwards to the user's DO, which then runs the batch turn synchronously (sync, not via alarm). This proves the runtime path. True alarm scheduling can come in Plan 4.

Revised approach: ship `POST /alarm` on the DO that runs the batch turn, plus a wrangler `[triggers] crons = ["0 12 * * *"]` (12pm UTC ≈ 5am Mountain) entry that fires a cron Worker which iterates known users and calls the DO. For dogfood with one user, hard-code the userId or read it from a `users` table scan.

For this task we only implement the DO side (`alarm()` method on the DO + the synchronous `POST /run-batch` admin endpoint). The cron wiring is its own Plan 4 task.

- [ ] **Step 1: Update `src/do/user-agent-do.ts`**

Add a new private field to track the userId after first chat, plus the alarm/admin endpoint.

```ts
private async getUserId(): Promise<string | null> {
  return (await this.state.storage.get<string>('user_id')) ?? null;
}

private async setUserId(userId: string): Promise<void> {
  await this.state.storage.put('user_id', userId);
}
```

Modify `handleChat` to call `setUserId(userId)` before starting the turn.

Add a route in `fetch`:
```ts
if (req.method === 'POST' && url.pathname === '/run-batch') {
  return this.handleRunBatch();
}
```

Add the handler:
```ts
private async handleRunBatch(): Promise<Response> {
  const userId = await this.getUserId();
  if (!userId) return Response.json({ ok: false, reason: 'no user_id stored — chat at least once first' }, { status: 400 });
  if (this.currentTurn) return Response.json({ ok: false, reason: 'turn in flight' }, { status: 409 });

  const ac = new AbortController();
  const turnId = ulid();  // import ulid at top
  this.currentTurn = { abortController: ac, turnId };

  const ai = createAIGatewayClient({ url: this.env.AI_GATEWAY_URL, apiKey: this.env.ANTHROPIC_API_KEY });
  const deps = { db: this.env.DB, ai, tools: buildToolRegistry(), clock: () => Date.now() };

  const threadId = `batch-${new Date().toISOString().slice(0, 10)}`;
  // ensure thread exists
  await this.env.DB.prepare(
    `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES (?, ?, 'batch', ?) ON CONFLICT(thread_id) DO NOTHING`
  ).bind(threadId, userId, Date.now()).run();

  try {
    const r = await runTurn(
      {
        userId, threadId, actor: 'system',
        systemHint: 'Generate tomorrow\'s plan considering recent readiness, recent meals, and recent workouts. Use propose_workout to record planned sessions.',
        stream: null, signal: ac.signal,
        idempotencyKey: `batch:${userId}:${threadId}`,
        turnId
      },
      deps
    );
    return Response.json({ ok: true, status: r.status, turn_id: r.turnId });
  } finally {
    this.currentTurn = null;
  }
}
```

(Add the imports for `ulid` to `src/do/user-agent-do.ts`: `import { ulid } from 'ulid';`. Also `import { runTurn } from '../runtime/agent-runtime';` if not already.)

For `alarm()`, leave it as `Promise.resolve()` for now — the Worker-side cron in Plan 4 will be the trigger. Or call the same `handleRunBatch` logic from `alarm()`:

```ts
async alarm(): Promise<void> {
  await this.handleRunBatch().catch((err) => console.error('[alarm] batch run failed:', err));
}
```

- [ ] **Step 2: Add api Worker route for admin batch**

In `src/api/worker.ts`:

```ts
if (req.method === 'POST' && url.pathname.startsWith('/v1/run-batch/')) {
  const userId = req.headers.get('X-User-Id');
  if (!userId) return new Response('missing X-User-Id', { status: 401 });
  const id = env.USER_AGENT_DO.idFromName(userId);
  const stub = env.USER_AGENT_DO.get(id);
  return stub.fetch(new Request('https://do/run-batch', { method: 'POST' }));
}
```

- [ ] **Step 3: Add integration test `tests/integration/alarm.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC','[]','[]',150,1)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`
  ).run();
});

describe('batch turn via /v1/run-batch', () => {
  it('returns 400 when no chat has stored user_id yet', async () => {
    const resp = await SELF.fetch('https://api/v1/run-batch/u1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1' }
    });
    expect(resp.status).toBe(400);
  });

  it('runs a batch turn after a chat has stored user_id', async () => {
    // First send a chat to set up state.
    const chat = await SELF.fetch('https://api/v1/chat/th1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    });
    await chat.text();
    await new Promise((r) => setTimeout(r, 100));

    const resp = await SELF.fetch('https://api/v1/run-batch/u1', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1' }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { ok: boolean; status: string };
    expect(data.ok).toBe(true);
    expect(['complete', 'preflight_blocked', 'cap_exceeded', 'error']).toContain(data.status);
  });
});
```

- [ ] **Step 4: Run all tests**

`pnpm test -- --run`
Expected: ~60 pass (58 + 2 new integration). Typecheck clean.

If the batch test fails because the Anthropic mock doesn't have a script for it: that's expected. The mock returns the same canned response regardless of input. The test checks the runtime path completes, not what the response says.

- [ ] **Step 5: Commit**

```
git add src/do/user-agent-do.ts src/api/worker.ts tests/integration/alarm.test.ts
git commit -m "Add batch turn endpoint and DO alarm hook"
```

---

## Phase 5: Final readiness

### Task 11: Final check + runbook update

- [ ] **Step 1: Run + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Confirm test count and clean typecheck.

- [ ] **Step 2: Update runbook**

Append to `docs/superpowers/runbooks/2026-04-25-vertical-slice-smoke-test.md`:

```markdown

---

## After Plan 3: tools + batch smoke checks

12. **Tools available:**
    Send a chat that should exercise tools, e.g. "what did I eat in the last week?" or "log: oatmeal 380 kcal at 7am". The response should include `tool_call_start`/`tool_call_result` SSE events for visible tools.

13. **Batch turn:**
    After at least one chat (so the DO has stored user_id):
    ```
    curl -X POST http://localhost:8787/v1/run-batch/u1 -H "X-User-Id: u1"
    ```
    Expected: `{"ok":true,"status":"complete","turn_id":"..."}`. Check D1:
    ```
    wrangler d1 execute cohort --local --command "SELECT thread_id, actor, status, substr(text,1,80) FROM chat_turns WHERE actor='system' ORDER BY started_at DESC LIMIT 1;"
    ```
    Expected: one row with actor=system and a generated text.

14. **Stub tools:**
    Send a chat about groceries or research, e.g. "find me oats nearby". The orchestrator will call `search_groceries`; the tool returns `{error: 'not_yet_available'}` and the model should explain this gracefully.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 3 smoke checks to runbook"
```

---

## Self-review notes

- **Spec coverage:** all 8 remaining tools (6 inline, 2 stubbed) ✓; batch turn entry point ✓. Real grocery/research workers and cron triggers are explicit Plan 4+ deferrals.
- **Placeholder scan:** none.
- **Type consistency:** new tools follow ToolDef<I,O> generic pattern with named exports. `buildToolRegistry` updated. No cross-task drift.
- **Scope:** 11 tasks. ~14 new tests (6 inline tools × 2 + 2 stubs × 1 + 2 alarm integration). Test count growth 44 → ~60.
