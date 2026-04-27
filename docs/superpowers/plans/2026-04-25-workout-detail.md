# Workout Detail + Complete — Plan 13

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make today's planned workout actionable. Tap a workout in the Today list → open a detail screen → tap "Mark complete" → status flips from `planned` to `logged`. The Today list updates to reflect the change.

**Architecture:** One new server route (`PATCH /v1/workouts/:id`) + one new Flutter screen. Set logging (reps × weight per set) is deferred to a future plan.

**Out of scope:**
- Set logging (reps, weight, RPE per set).
- Cardio metrics (distance, splits).
- Editing the planned workout (kind, duration, RPE).
- Skip / reschedule actions beyond a simple "mark skipped".

---

## File Structure

```
src/api/
  worker.ts                              # MODIFY: add PATCH /v1/workouts/:id
  workouts-update.ts                     # NEW: pure handler

mobile/
  lib/
    api/api_client.dart                  # MODIFY: updateWorkoutStatus
    screens/workout_detail_screen.dart   # NEW
    screens/today_screen.dart            # MODIFY: tap handler

tests/
  unit/api/workouts-update.test.ts       # NEW
  integration/workouts-update.test.ts    # NEW
```

---

## Phase 1: Server

### Task 1: `handleWorkoutUpdate` + route

**Files:**
- Create: `src/api/workouts-update.ts`
- Modify: `src/api/worker.ts`
- Create: `tests/unit/api/workouts-update.test.ts`
- Create: `tests/integration/workouts-update.test.ts`

- [ ] **Step 1: Write failing unit test `tests/unit/api/workouts-update.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleWorkoutUpdate } from '../../../src/api/workouts-update';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u2','Other','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_other','u2','2026-04-25','strength','planned')`)
  ]);
});

describe('handleWorkoutUpdate', () => {
  it('updates status when the workout belongs to the user', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'w1', status: 'logged' });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT status FROM workouts WHERE workout_id='w1'`).first();
    expect(row).toEqual({ status: 'logged' });
  });

  it('returns 404 when the workout does not exist', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'nope', status: 'logged' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when the workout belongs to a different user', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'w_other', status: 'logged' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    const row = await env.DB.prepare(`SELECT status FROM workouts WHERE workout_id='w_other'`).first();
    expect(row).toEqual({ status: 'planned' });
  });

  it('rejects invalid status values', async () => {
    const r = await handleWorkoutUpdate({ db: env.DB, userId: 'u1', workoutId: 'w1', status: 'invalid' as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/workouts-update.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/workouts-update.ts`**

```ts
const ALLOWED_STATUSES = ['planned', 'logged', 'skipped'] as const;
type WorkoutStatus = typeof ALLOWED_STATUSES[number];

export interface WorkoutUpdateInput {
  db: D1Database;
  userId: string;
  workoutId: string;
  status: WorkoutStatus;
}

export interface WorkoutUpdateResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export async function handleWorkoutUpdate(input: WorkoutUpdateInput): Promise<WorkoutUpdateResult> {
  if (!ALLOWED_STATUSES.includes(input.status)) {
    return { ok: false, status: 400, reason: 'invalid status' };
  }

  const row = await input.db.prepare(
    `SELECT user_id FROM workouts WHERE workout_id = ?`
  ).bind(input.workoutId).first<{ user_id: string }>();

  if (!row) return { ok: false, status: 404, reason: 'not found' };
  if (row.user_id !== input.userId) return { ok: false, status: 403, reason: 'forbidden' };

  await input.db.prepare(
    `UPDATE workouts SET status = ? WHERE workout_id = ?`
  ).bind(input.status, input.workoutId).run();

  return { ok: true };
}
```

- [ ] **Step 4: Pass + commit**

```
git add src/api/workouts-update.ts tests/unit/api/workouts-update.test.ts
git commit -m "Add handleWorkoutUpdate (status change with ownership check)"
```

### Task 1 (continued): Wire route + integration test

- [ ] **Step 5: Add route to `src/api/worker.ts`**

Read the file. Add:

```ts
import { handleWorkoutUpdate } from './workouts-update';
```

Add the route alongside other `/v1/...` routes:

```ts
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
```

- [ ] **Step 6: Write `tests/integration/workouts-update.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`)
  ]);
});

describe('PATCH /v1/workouts/:id', () => {
  it('marks a planned workout as logged', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'logged' })
    });
    expect(resp.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status FROM workouts WHERE workout_id='w1'`).first();
    expect(row).toEqual({ status: 'logged' });
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/workouts/w1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'logged' })
    });
    expect(resp.status).toBe(401);
  });

  it('returns 404 for unknown workout', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/no-such', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'logged' })
    });
    expect(resp.status).toBe(404);
  });
});
```

- [ ] **Step 7: Run + commit**

```
pnpm test -- --run     # ~131 (127 + 4 unit + 3 integration)
pnpm typecheck
git add src/api/worker.ts tests/integration/workouts-update.test.ts
git commit -m "Wire PATCH /v1/workouts/:id route"
```

(Take whatever the actual count is.)

---

## Phase 2: Flutter

### Task 2: API client method + WorkoutDetailScreen + tap wiring

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Create: `mobile/lib/screens/workout_detail_screen.dart`
- Modify: `mobile/lib/screens/today_screen.dart`

- [ ] **Step 1: Add `updateWorkoutStatus` to `mobile/lib/api/api_client.dart`**

Inside the `ApiClient` class:

```dart
Future<void> updateWorkoutStatus({
  required String workoutId,
  required String status, // 'planned' | 'logged' | 'skipped'
}) async {
  final uri = Uri.parse('$baseUrl/v1/workouts/$workoutId');
  final req = await _http.patchUrl(uri);
  req.headers.set('Authorization', 'Bearer $jwt');
  req.headers.set('Content-Type', 'application/json');
  req.add(utf8.encode(jsonEncode({'status': status})));
  final resp = await req.close();
  final body = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('updateWorkout ${resp.statusCode}: $body');
  }
}
```

- [ ] **Step 2: Write `mobile/lib/screens/workout_detail_screen.dart`**

```dart
import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class WorkoutDetailScreen extends StatefulWidget {
  final SettingsController settings;
  final Map<String, dynamic> workout;
  const WorkoutDetailScreen({super.key, required this.settings, required this.workout});

  @override
  State<WorkoutDetailScreen> createState() => _WorkoutDetailScreenState();
}

class _WorkoutDetailScreenState extends State<WorkoutDetailScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _setStatus(String status) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.updateWorkoutStatus(
        workoutId: widget.workout['workout_id'] as String,
        status: status,
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      client.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.workout;
    final kind = (w['kind'] as String?) ?? '';
    final duration = w['duration_min'];
    final rpe = w['rpe'];
    final notes = w['notes'] as String?;
    final status = (w['status'] as String?) ?? 'planned';

    return Scaffold(
      appBar: AppBar(title: const Text('Workout')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.fitness_center),
                const SizedBox(width: 8),
                Text(kind, style: Theme.of(context).textTheme.headlineSmall),
              ],
            ),
            const SizedBox(height: 16),
            if (duration != null) Text('Duration: ${duration} min', style: Theme.of(context).textTheme.bodyLarge),
            if (rpe != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('RPE: $rpe', style: Theme.of(context).textTheme.bodyLarge)),
            const SizedBox(height: 8),
            _statusChip(status),
            if (notes != null && notes.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('Notes', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 4),
              Text(notes),
            ],
            const Spacer(),
            if (_error != null) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.onErrorContainer)),
              ),
              const SizedBox(height: 16),
            ],
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy || status == 'skipped' ? null : () => _setStatus('skipped'),
                    child: const Text('Skip'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy || status == 'logged' ? null : () => _setStatus('logged'),
                    child: Text(_busy ? 'Saving…' : 'Mark complete'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusChip(String status) {
    final color = switch (status) {
      'logged' => Colors.green,
      'planned' => Colors.blue,
      'skipped' => Colors.grey,
      _ => Colors.grey,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(status.toUpperCase(), style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 12)),
    );
  }
}
```

- [ ] **Step 3: Wire tap from `mobile/lib/screens/today_screen.dart`**

Find the workouts card (where each planned workout is rendered). Wrap each row with `InkWell` + `onTap` that pushes `WorkoutDetailScreen`. After return, refresh the today data.

In the `_workoutsCard(List workouts)` method, change each item from:
```dart
return Padding(
  padding: const EdgeInsets.only(top: 8),
  child: Row(...),
);
```

To:
```dart
return Padding(
  padding: const EdgeInsets.only(top: 8),
  child: InkWell(
    onTap: () async {
      final result = await Navigator.of(context).push<bool>(
        MaterialPageRoute(
          builder: (_) => WorkoutDetailScreen(
            settings: widget.settings,
            workout: w as Map<String, dynamic>,
          ),
        ),
      );
      if (result == true) _controller.refresh();
    },
    child: Row(...),
  ),
);
```

Add the import:
```dart
import 'workout_detail_screen.dart';
```

- [ ] **Step 4: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/api/api_client.dart mobile/lib/screens/workout_detail_screen.dart mobile/lib/screens/today_screen.dart
git commit -m "Add WorkoutDetailScreen with mark-complete + tap wiring"
```

---

## Phase 3: Final readiness

### Task 3: Verify + runbook

- [ ] **Step 1: Verify**

```
cd /Users/kostiailn/Projects/cohort
pnpm test -- --run    # ~131 (127 + 4 unit + 3 integration = 134, give or take)
pnpm typecheck

cd mobile
flutter test           # 8 unchanged
flutter analyze        # clean
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 13: workout detail + complete

43. **Tap a planned workout:**
    From the Today tab, tap the workout row. The Workout detail screen opens showing kind, duration, RPE, status chip.

44. **Mark complete:**
    Tap "Mark complete". The status flips to `logged` (server-side), the screen pops, and the Today list refreshes (the workout no longer appears under "Today's plan" since the query filters status='planned').

45. **Skip:**
    Tap "Skip" on the detail screen — status flips to `skipped`. Same pop + refresh.

46. **Cross-user 403 sanity check:** trying to PATCH another user's workout returns 403 (test covers this server-side).

## Plan 13 known limitations

- **No set logging** — only the workout-level status change. Reps × weight per set is its own future plan.
- **No undo from the UI** — once marked, only a manual D1 update reverts. (Server-side, you can PATCH back to 'planned' if needed.)
- **No timer / ongoing-workout state** — start time isn't tracked.
- **No visible "logged" workouts on Today** — the Today aggregation filters to status='planned'. Logged workouts only show up via D1 / chat queries.
```

- [ ] **Step 3: Commit**

```
cd /Users/kostiailn/Projects/cohort
git add docs/superpowers/runbooks/
git commit -m "Add Plan 13 workout detail smoke checks"
```

---

## Self-review notes

- **Spec coverage:** PATCH endpoint with ownership check ✓, Flutter detail screen ✓, status flip + return-refresh wired ✓.
- **Type consistency:** `WorkoutUpdateInput` and `WorkoutUpdateResult` defined; Flutter side uses `Map<String, dynamic>` for the workout payload (no codegen for v1).
- **Scope:** 3 tasks. ~4 unit + 3 integration server tests. No new Flutter tests.
