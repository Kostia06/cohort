# Workout Set Logging — Plan 16

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Granular set-level tracking on strength workouts. While a workout is in progress, the user can add sets with `exercise / reps / weight_kg / rpe`. The detail screen lists prior sets for that workout. Marking a workout complete works the same as Plan 13.

**Out of scope:**
- Cardio segments (distance, splits, HR zones).
- Exercise dictionary / autocomplete.
- Plate calculator.
- Progressive overload suggestions.
- Editing / deleting sets.

---

## File Structure

```
src/db/migrations/
  0006_workout_sets.sql                  # NEW

src/api/
  worker.ts                              # MODIFY: add POST /v1/workouts/:id/sets + GET /v1/workouts/:id
  workout-sets.ts                        # NEW: pure handlers (createSet + getWorkoutWithSets)

mobile/
  lib/
    api/api_client.dart                  # MODIFY: addWorkoutSet, fetchWorkout
    screens/workout_detail_screen.dart   # MODIFY: list sets + add-set form

tests/
  fakes/seed.ts                          # MODIFY: add workout_sets table
  unit/api/workout-sets.test.ts          # NEW
  integration/workout-sets.test.ts       # NEW
```

---

## Phase 1: Schema

### Task 1: Migration 0006 + seed update

**Files:**
- Create: `src/db/migrations/0006_workout_sets.sql`
- Modify: `tests/fakes/seed.ts`

- [ ] **Step 1: Create the migration**

```sql
-- src/db/migrations/0006_workout_sets.sql

CREATE TABLE workout_sets (
  set_id        TEXT PRIMARY KEY,
  workout_id    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  exercise      TEXT NOT NULL,
  reps          INTEGER,
  weight_kg     REAL,
  rpe           INTEGER,
  notes         TEXT,
  logged_at     INTEGER NOT NULL
);

CREATE INDEX idx_workout_sets_workout ON workout_sets(workout_id, ordinal);
```

- [ ] **Step 2: Apply locally**

```
wrangler d1 execute cohort --local --file=src/db/migrations/0006_workout_sets.sql
```

- [ ] **Step 3: Update `tests/fakes/seed.ts`**

Append to SCHEMA (with IF NOT EXISTS) and prepend the DELETE in resetDb:

```sql
CREATE TABLE IF NOT EXISTS workout_sets (
  set_id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  exercise TEXT NOT NULL,
  reps INTEGER,
  weight_kg REAL,
  rpe INTEGER,
  notes TEXT,
  logged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workout_sets_workout ON workout_sets(workout_id, ordinal);
```

`resetDb` DELETE chain — prepend `DELETE FROM workout_sets;` before `DELETE FROM workouts;`.

- [ ] **Step 4: Run all tests + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Expected: 146 PASS (no new tests yet).

- [ ] **Step 5: Commit**

```
git add src/db/migrations/0006_workout_sets.sql tests/fakes/seed.ts
git commit -m "Add migration 0006: workout_sets"
```

---

## Phase 2: Server handlers

### Task 2: `handleCreateSet` + `handleGetWorkout`

**Files:**
- Create: `src/api/workout-sets.ts`
- Create: `tests/unit/api/workout-sets.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/unit/api/workout-sets.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleCreateSet, handleGetWorkout } from '../../../src/api/workout-sets';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;

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

describe('handleCreateSet', () => {
  it('inserts a set with auto-incrementing ordinal', async () => {
    const r1 = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW, input: { exercise: 'squat', reps: 5, weight_kg: 100 } });
    expect(r1.ok).toBe(true);
    expect(r1.set_id).toMatch(/^set_/);
    const r2 = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW + 60_000, input: { exercise: 'squat', reps: 5, weight_kg: 100 } });
    expect(r2.ok).toBe(true);
    const rows = await env.DB.prepare(`SELECT ordinal FROM workout_sets WHERE workout_id = 'w1' ORDER BY ordinal`).all<{ ordinal: number }>();
    expect(rows.results?.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it('returns 404 for unknown workout', async () => {
    const r = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'nope', now: NOW, input: { exercise: 'squat' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when workout belongs to another user', async () => {
    const r = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w_other', now: NOW, input: { exercise: 'squat' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('rejects empty exercise with 400', async () => {
    const r = await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW, input: { exercise: '' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe('handleGetWorkout', () => {
  it('returns the workout with empty sets array initially', async () => {
    const r = await handleGetWorkout({ db: env.DB, userId: 'u1', workoutId: 'w1' });
    expect(r.ok).toBe(true);
    expect(r.workout!.workout_id).toBe('w1');
    expect(r.sets).toEqual([]);
  });

  it('returns sets in ordinal order', async () => {
    await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW, input: { exercise: 'squat', reps: 5, weight_kg: 100 } });
    await handleCreateSet({ db: env.DB, userId: 'u1', workoutId: 'w1', now: NOW + 1, input: { exercise: 'squat', reps: 5, weight_kg: 105 } });
    const r = await handleGetWorkout({ db: env.DB, userId: 'u1', workoutId: 'w1' });
    expect(r.sets!.length).toBe(2);
    expect(r.sets![0]!.ordinal).toBe(0);
    expect(r.sets![1]!.weight_kg).toBe(105);
  });

  it('returns 403 when accessing another user\'s workout', async () => {
    const r = await handleGetWorkout({ db: env.DB, userId: 'u1', workoutId: 'w_other' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/workout-sets.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/workout-sets.ts`**

```ts
import { ulid } from 'ulid';

export interface CreateSetInput {
  exercise: string;
  reps?: number;
  weight_kg?: number;
  rpe?: number;
  notes?: string;
}

export interface CreateSetRequest {
  db: D1Database;
  userId: string;
  workoutId: string;
  now: number;
  input: CreateSetInput;
}

export interface CreateSetResult {
  ok: boolean;
  set_id?: string;
  ordinal?: number;
  status?: number;
  reason?: string;
}

export async function handleCreateSet(req: CreateSetRequest): Promise<CreateSetResult> {
  const exercise = req.input?.exercise?.trim();
  if (!exercise) return { ok: false, status: 400, reason: 'missing exercise' };

  const owner = await req.db.prepare(
    `SELECT user_id FROM workouts WHERE workout_id = ?`
  ).bind(req.workoutId).first<{ user_id: string }>();
  if (!owner) return { ok: false, status: 404, reason: 'workout not found' };
  if (owner.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  const ordRow = await req.db.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ord FROM workout_sets WHERE workout_id = ?`
  ).bind(req.workoutId).first<{ next_ord: number }>();
  const ordinal = ordRow?.next_ord ?? 0;

  const setId = `set_${ulid()}`;
  await req.db.prepare(
    `INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, reps, weight_kg, rpe, notes, logged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    setId,
    req.workoutId,
    ordinal,
    exercise,
    req.input.reps ?? null,
    req.input.weight_kg ?? null,
    req.input.rpe ?? null,
    req.input.notes ?? null,
    req.now
  ).run();

  return { ok: true, set_id: setId, ordinal };
}

export interface GetWorkoutRequest {
  db: D1Database;
  userId: string;
  workoutId: string;
}

export interface WorkoutSet {
  set_id: string;
  workout_id: string;
  ordinal: number;
  exercise: string;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  notes: string | null;
  logged_at: number;
}

export interface GetWorkoutResult {
  ok: boolean;
  workout?: {
    workout_id: string;
    user_id: string;
    date: string;
    kind: string;
    duration_min: number | null;
    rpe: number | null;
    status: string;
    notes: string | null;
  };
  sets?: WorkoutSet[];
  status?: number;
  reason?: string;
}

export async function handleGetWorkout(req: GetWorkoutRequest): Promise<GetWorkoutResult> {
  const w = await req.db.prepare(
    `SELECT workout_id, user_id, date, kind, duration_min, rpe, status, notes
     FROM workouts WHERE workout_id = ?`
  ).bind(req.workoutId).first<{
    workout_id: string; user_id: string; date: string; kind: string;
    duration_min: number | null; rpe: number | null; status: string; notes: string | null;
  }>();
  if (!w) return { ok: false, status: 404, reason: 'workout not found' };
  if (w.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  const setRows = await req.db.prepare(
    `SELECT set_id, workout_id, ordinal, exercise, reps, weight_kg, rpe, notes, logged_at
     FROM workout_sets WHERE workout_id = ? ORDER BY ordinal`
  ).bind(req.workoutId).all<WorkoutSet>();

  return { ok: true, workout: w, sets: setRows.results ?? [] };
}
```

- [ ] **Step 4: Pass + commit**

```
pnpm test tests/unit/api/workout-sets.test.ts -- --run    # 7 PASS
git add src/api/workout-sets.ts tests/unit/api/workout-sets.test.ts
git commit -m "Add handleCreateSet + handleGetWorkout"
```

### Task 2 (continued): Routes + integration tests

- [ ] **Step 5: Add routes to `src/api/worker.ts`**

```ts
import { handleCreateSet, handleGetWorkout } from './workout-sets';
```

```ts
if (req.method === 'GET' && url.pathname.startsWith('/v1/workouts/')) {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const workoutId = url.pathname.slice('/v1/workouts/'.length);
  const r = await handleGetWorkout({ db: env.DB, userId, workoutId });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json({ workout: r.workout, sets: r.sets });
}

if (req.method === 'POST' && url.pathname.startsWith('/v1/workouts/') && url.pathname.endsWith('/sets')) {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const path = url.pathname.slice('/v1/workouts/'.length);
  const workoutId = path.replace(/\/sets$/, '');
  const body = await req.json<any>();
  const r = await handleCreateSet({ db: env.DB, userId, workoutId, now: Date.now(), input: body });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json({ ok: true, set_id: r.set_id, ordinal: r.ordinal });
}
```

(Order matters — the `/sets` POST must be checked before any catch-all on `/v1/workouts/`. Since the existing PATCH is `if method === 'PATCH'` and these are GET/POST, order isn't an issue, but keep them grouped.)

- [ ] **Step 6: Integration test `tests/integration/workout-sets.test.ts`**

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

describe('GET /v1/workouts/:id', () => {
  it('returns workout with empty sets', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { workout: any; sets: any[] };
    expect(data.workout.workout_id).toBe('w1');
    expect(data.sets).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/workouts/w1');
    expect(resp.status).toBe(401);
  });
});

describe('POST /v1/workouts/:id/sets', () => {
  it('creates a set', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1/sets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ exercise: 'squat', reps: 5, weight_kg: 100, rpe: 7 })
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { ok: boolean; set_id: string; ordinal: number };
    expect(data.ok).toBe(true);
    expect(data.ordinal).toBe(0);
  });

  it('returns 400 for missing exercise', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workouts/w1/sets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(resp.status).toBe(400);
  });
});
```

- [ ] **Step 7: Commit**

```
pnpm test -- --run     # ~152 (146 + 7 unit + 4 integration ≈ 157)
pnpm typecheck
git add src/api/worker.ts tests/integration/workout-sets.test.ts
git commit -m "Wire GET /v1/workouts/:id and POST /v1/workouts/:id/sets routes"
```

---

## Phase 3: Flutter

### Task 3: API client + WorkoutDetailScreen integration

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Modify: `mobile/lib/screens/workout_detail_screen.dart`

The detail screen now:
1. Fetches the full workout + sets on open via `fetchWorkout`.
2. Shows the sets list below the workout meta.
3. Has an "Add set" form at the bottom.

- [ ] **Step 1: Add to `mobile/lib/api/api_client.dart`**

```dart
Future<Map<String, dynamic>> fetchWorkout(String workoutId) async {
  final uri = Uri.parse('$baseUrl/v1/workouts/$workoutId');
  final req = await _http.getUrl(uri);
  req.headers.set('Authorization', 'Bearer $jwt');
  final resp = await req.close();
  final body = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('fetchWorkout ${resp.statusCode}: $body');
  }
  return jsonDecode(body) as Map<String, dynamic>;
}

Future<void> addWorkoutSet({
  required String workoutId,
  required String exercise,
  int? reps,
  double? weightKg,
  int? rpe,
  String? notes,
}) async {
  final uri = Uri.parse('$baseUrl/v1/workouts/$workoutId/sets');
  final r = await _http.postUrl(uri);
  r.headers.set('Authorization', 'Bearer $jwt');
  r.headers.set('Content-Type', 'application/json');
  final body = <String, dynamic>{ 'exercise': exercise };
  if (reps != null) body['reps'] = reps;
  if (weightKg != null) body['weight_kg'] = weightKg;
  if (rpe != null) body['rpe'] = rpe;
  if (notes != null && notes.isNotEmpty) body['notes'] = notes;
  r.add(utf8.encode(jsonEncode(body)));
  final resp = await r.close();
  final respBody = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('addSet ${resp.statusCode}: $respBody');
  }
}
```

- [ ] **Step 2: Replace `mobile/lib/screens/workout_detail_screen.dart`**

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
  Map<String, dynamic>? _workout;
  List<Map<String, dynamic>> _sets = [];
  bool _busy = false;
  String? _error;

  final _exercise = TextEditingController();
  final _reps = TextEditingController();
  final _weight = TextEditingController();
  final _rpe = TextEditingController();

  @override
  void initState() {
    super.initState();
    _workout = Map<String, dynamic>.from(widget.workout);
    _refresh();
  }

  @override
  void dispose() {
    _exercise.dispose();
    _reps.dispose();
    _weight.dispose();
    _rpe.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final id = (_workout?['workout_id'] as String?) ?? '';
    if (id.isEmpty) return;
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      final data = await client.fetchWorkout(id);
      setState(() {
        _workout = data['workout'] as Map<String, dynamic>;
        _sets = ((data['sets'] as List?) ?? const []).cast<Map<String, dynamic>>();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      client.close();
    }
  }

  Future<void> _setStatus(String status) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.updateWorkoutStatus(workoutId: widget.workout['workout_id'] as String, status: status);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      client.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addSet() async {
    final ex = _exercise.text.trim();
    if (ex.isEmpty) {
      setState(() => _error = 'Exercise is required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.addWorkoutSet(
        workoutId: widget.workout['workout_id'] as String,
        exercise: ex,
        reps: int.tryParse(_reps.text),
        weightKg: double.tryParse(_weight.text),
        rpe: int.tryParse(_rpe.text),
      );
      _reps.clear();
      _weight.clear();
      _rpe.clear();
      // Keep _exercise so chained sets are quick.
      await _refresh();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      client.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = _workout ?? widget.workout;
    final kind = (w['kind'] as String?) ?? '';
    final duration = w['duration_min'];
    final rpePlanned = w['rpe'];
    final status = (w['status'] as String?) ?? 'planned';

    return Scaffold(
      appBar: AppBar(title: const Text('Workout')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(children: [
            const Icon(Icons.fitness_center),
            const SizedBox(width: 8),
            Text(kind, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(width: 12),
            _statusChip(status),
          ]),
          const SizedBox(height: 8),
          if (duration != null) Text('Planned: ${duration} min'),
          if (rpePlanned != null) Text('Planned RPE: $rpePlanned'),
          const SizedBox(height: 24),
          Text('Sets', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_sets.isEmpty) const Text('No sets logged yet.')
          else ..._sets.map(_setRow),
          const Divider(height: 32),
          Text('Add set', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          TextField(controller: _exercise, decoration: const InputDecoration(labelText: 'Exercise')),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: TextField(controller: _reps, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Reps'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _weight, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Weight (kg)'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _rpe, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'RPE'))),
          ]),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            icon: const Icon(Icons.add),
            label: Text(_busy ? 'Saving…' : 'Add set'),
            onPressed: _busy ? null : _addSet,
          ),
          const SizedBox(height: 24),
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
          Row(children: [
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
                child: const Text('Mark complete'),
              ),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _setRow(Map<String, dynamic> s) {
    final exercise = (s['exercise'] as String?) ?? '';
    final reps = s['reps'];
    final weight = s['weight_kg'];
    final rpe = s['rpe'];
    final ord = (s['ordinal'] as int?) ?? 0;
    final parts = <String>[];
    if (reps != null) parts.add('${reps} reps');
    if (weight != null) parts.add('${weight} kg');
    if (rpe != null) parts.add('RPE $rpe');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(width: 28, child: Text('#${ord + 1}', style: Theme.of(context).textTheme.labelSmall)),
          Expanded(child: Text(exercise, style: Theme.of(context).textTheme.bodyMedium)),
          if (parts.isNotEmpty) Text(parts.join(' · '), style: Theme.of(context).textTheme.bodySmall),
        ],
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

- [ ] **Step 3: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/api/api_client.dart mobile/lib/screens/workout_detail_screen.dart
git commit -m "Add set list + add-set form to WorkoutDetailScreen"
```

---

## Phase 4: Final readiness

### Task 4: Verify + runbook

- [ ] **Step 1: Verify**

```
cd /Users/kostiailn/Projects/cohort
pnpm test -- --run
pnpm typecheck
cd mobile
flutter test
flutter analyze
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 16: workout set logging

54. **Open a planned workout from Today.**
    The detail screen now fetches the workout + any prior sets via `GET /v1/workouts/:id`.

55. **Add a set:**
    Type "squat" + 5 reps + 100 kg + RPE 7. Tap "Add set". The set list grows by one. The exercise field stays filled to make logging multiple sets of the same lift fast.

56. **Mark complete:** flow unchanged — flips status to 'logged', pops, refreshes.

57. **Cross-user 403:** other-user's workout returns 403 on both GET and POST /sets.

## Plan 16 known limitations

- **No edit / delete sets** from UI — manual D1 only.
- **No exercise dictionary** — free-form text.
- **No timer / rest tracking.**
- **No per-set RPE charts** — sparkline / progressive overload is a future plan.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 16 workout sets smoke checks"
```

---

## Self-review notes

- **Spec coverage:** schema ✓, two server handlers (create + get) ✓, Flutter detail integration ✓.
- **Scope:** 4 tasks. ~7 unit + 4 integration server tests. No new Flutter tests (the existing widget test will still run; could add one for the form but defer).
