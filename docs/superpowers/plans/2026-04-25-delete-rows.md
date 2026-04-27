# Delete Rows (Sets + Meals) — Plan 18

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let the user undo a misclicked set or a wrongly-logged meal. Adds two delete endpoints (auth + ownership-checked) + swipe-to-delete in the Flutter UI.

**Out of scope:**
- Edit (only delete in this plan).
- Deleting workouts or readiness rows.
- Bulk delete.

---

## File Structure

```
src/api/
  worker.ts                              # MODIFY: add DELETE /v1/workout-sets/:id and DELETE /v1/meals/:id
  delete-handlers.ts                     # NEW: pure handlers

mobile/
  lib/
    api/api_client.dart                  # MODIFY: deleteSet, deleteMeal
    screens/workout_detail_screen.dart   # MODIFY: Dismissible per set
    screens/today_screen.dart            # MODIFY: Dismissible per meal

tests/
  unit/api/delete-handlers.test.ts       # NEW
  integration/delete-handlers.test.ts    # NEW
```

---

## Phase 1: Server

### Task 1: `handleDeleteSet` + `handleDeleteMeal` + tests

**Files:**
- Create: `src/api/delete-handlers.ts`
- Create: `tests/unit/api/delete-handlers.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/unit/api/delete-handlers.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleDeleteMeal, handleDeleteSet } from '../../../src/api/delete-handlers';
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
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w_other','u2','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, logged_at) VALUES ('s1','w1',0,'squat',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, logged_at) VALUES ('s_other','w_other',0,'bench',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m1','u1',?,'oats','user')`).bind(NOW),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m_other','u2',?,'lunch','user')`).bind(NOW)
  ]);
});

describe('handleDeleteSet', () => {
  it('deletes a set owned by the user', async () => {
    const r = await handleDeleteSet({ db: env.DB, userId: 'u1', setId: 's1' });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT 1 FROM workout_sets WHERE set_id='s1'`).first();
    expect(row).toBeNull();
  });

  it('returns 404 for unknown set', async () => {
    const r = await handleDeleteSet({ db: env.DB, userId: 'u1', setId: 'no-such' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when set belongs to another user', async () => {
    const r = await handleDeleteSet({ db: env.DB, userId: 'u1', setId: 's_other' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    const row = await env.DB.prepare(`SELECT 1 FROM workout_sets WHERE set_id='s_other'`).first();
    expect(row).not.toBeNull();
  });
});

describe('handleDeleteMeal', () => {
  it('deletes a meal owned by the user', async () => {
    const r = await handleDeleteMeal({ db: env.DB, userId: 'u1', mealId: 'm1' });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT 1 FROM meals WHERE meal_id='m1'`).first();
    expect(row).toBeNull();
  });

  it('returns 404 for unknown meal', async () => {
    const r = await handleDeleteMeal({ db: env.DB, userId: 'u1', mealId: 'no-such' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('returns 403 when meal belongs to another user', async () => {
    const r = await handleDeleteMeal({ db: env.DB, userId: 'u1', mealId: 'm_other' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    const row = await env.DB.prepare(`SELECT 1 FROM meals WHERE meal_id='m_other'`).first();
    expect(row).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/delete-handlers.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/delete-handlers.ts`**

```ts
export interface DeleteResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface DeleteSetRequest {
  db: D1Database;
  userId: string;
  setId: string;
}

export async function handleDeleteSet(req: DeleteSetRequest): Promise<DeleteResult> {
  // Resolve owner via the parent workout.
  const owner = await req.db.prepare(
    `SELECT w.user_id AS user_id
     FROM workout_sets s
     JOIN workouts w ON w.workout_id = s.workout_id
     WHERE s.set_id = ?`
  ).bind(req.setId).first<{ user_id: string }>();
  if (!owner) return { ok: false, status: 404, reason: 'set not found' };
  if (owner.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  await req.db.prepare(`DELETE FROM workout_sets WHERE set_id = ?`).bind(req.setId).run();
  return { ok: true };
}

export interface DeleteMealRequest {
  db: D1Database;
  userId: string;
  mealId: string;
}

export async function handleDeleteMeal(req: DeleteMealRequest): Promise<DeleteResult> {
  const owner = await req.db.prepare(
    `SELECT user_id FROM meals WHERE meal_id = ?`
  ).bind(req.mealId).first<{ user_id: string }>();
  if (!owner) return { ok: false, status: 404, reason: 'meal not found' };
  if (owner.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  await req.db.prepare(`DELETE FROM meals WHERE meal_id = ?`).bind(req.mealId).run();
  return { ok: true };
}
```

- [ ] **Step 4: Pass + commit**

```
pnpm test tests/unit/api/delete-handlers.test.ts -- --run    # 6 PASS
git add src/api/delete-handlers.ts tests/unit/api/delete-handlers.test.ts
git commit -m "Add handleDeleteSet + handleDeleteMeal"
```

### Task 1 (continued): Wire routes + integration test

- [ ] **Step 5: Add routes to `src/api/worker.ts`**

```ts
import { handleDeleteMeal, handleDeleteSet } from './delete-handlers';
```

```ts
if (req.method === 'DELETE' && url.pathname.startsWith('/v1/workout-sets/')) {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const setId = url.pathname.slice('/v1/workout-sets/'.length);
  const r = await handleDeleteSet({ db: env.DB, userId: auth, setId });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json({ ok: true });
}

if (req.method === 'DELETE' && url.pathname.startsWith('/v1/meals/')) {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const mealId = url.pathname.slice('/v1/meals/'.length);
  const r = await handleDeleteMeal({ db: env.DB, userId: auth, mealId });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Integration test `tests/integration/delete-handlers.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','planned')`),
    env.DB.prepare(`INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, logged_at) VALUES ('s1','w1',0,'squat',?)`).bind(NOW),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source) VALUES ('m1','u1',?,'oats','user')`).bind(NOW)
  ]);
});

describe('DELETE /v1/workout-sets/:id', () => {
  it('deletes the set', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/workout-sets/s1', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
  });

  it('returns 401 without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/workout-sets/s1', { method: 'DELETE' });
    expect(resp.status).toBe(401);
  });
});

describe('DELETE /v1/meals/:id', () => {
  it('deletes the meal', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals/m1', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
  });

  it('returns 404 for unknown meal', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals/no-such', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(404);
  });
});
```

- [ ] **Step 7: Commit**

```
pnpm test -- --run     # ~180 (170 + 6 unit + 4 integration)
pnpm typecheck
git add src/api/worker.ts tests/integration/delete-handlers.test.ts
git commit -m "Wire DELETE /v1/workout-sets/:id and DELETE /v1/meals/:id"
```

---

## Phase 2: Flutter

### Task 2: API + Dismissible UI

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Modify: `mobile/lib/screens/workout_detail_screen.dart`
- Modify: `mobile/lib/screens/today_screen.dart`

- [ ] **Step 1: Add to `mobile/lib/api/api_client.dart`**

```dart
Future<void> deleteSet(String setId) async {
  final uri = Uri.parse('$baseUrl/v1/workout-sets/$setId');
  final r = await _http.deleteUrl(uri);
  r.headers.set('Authorization', 'Bearer $jwt');
  final resp = await r.close();
  if (resp.statusCode != 200) {
    final body = await resp.transform(utf8.decoder).join();
    throw HttpException('deleteSet ${resp.statusCode}: $body');
  }
  await resp.drain();
}

Future<void> deleteMeal(String mealId) async {
  final uri = Uri.parse('$baseUrl/v1/meals/$mealId');
  final r = await _http.deleteUrl(uri);
  r.headers.set('Authorization', 'Bearer $jwt');
  final resp = await r.close();
  if (resp.statusCode != 200) {
    final body = await resp.transform(utf8.decoder).join();
    throw HttpException('deleteMeal ${resp.statusCode}: $body');
  }
  await resp.drain();
}
```

- [ ] **Step 2: Make sets Dismissible in `mobile/lib/screens/workout_detail_screen.dart`**

Find the `_setRow(Map<String, dynamic> s)` method. Wrap its returned widget in a `Dismissible` keyed by the set_id with a delete background:

```dart
Widget _setRow(Map<String, dynamic> s) {
  final setId = (s['set_id'] as String?) ?? '';
  // ... existing code building parts and the inner Row ...
  final inner = Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        SizedBox(width: 28, child: Text('#${ord + 1}', style: Theme.of(context).textTheme.labelSmall)),
        Expanded(child: Text(exercise, style: Theme.of(context).textTheme.bodyMedium)),
        if (parts.isNotEmpty) Text(parts.join(' · '), style: Theme.of(context).textTheme.bodySmall),
      ],
    ),
  );
  return Dismissible(
    key: ValueKey('set-$setId'),
    direction: DismissDirection.endToStart,
    background: Container(
      alignment: Alignment.centerRight,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      color: Theme.of(context).colorScheme.errorContainer,
      child: Icon(Icons.delete, color: Theme.of(context).colorScheme.onErrorContainer),
    ),
    confirmDismiss: (_) async {
      final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
      try {
        await client.deleteSet(setId);
        return true;
      } catch (e) {
        if (mounted) setState(() => _error = e.toString());
        return false;
      } finally {
        client.close();
      }
    },
    onDismissed: (_) => _refresh(),
    child: inner,
  );
}
```

- [ ] **Step 3: Make meals Dismissible in `mobile/lib/screens/today_screen.dart`**

Find `_mealsCard(List meals)`. Each meal is rendered as a `Padding > Row`. Wrap each row in a `Dismissible`:

```dart
...meals.map((m) {
  final mealId = (m['meal_id'] as String?) ?? '';
  final name = (m['name'] as String?) ?? '';
  final kcal = m['kcal'];
  final inner = Padding(
    padding: const EdgeInsets.only(top: 6),
    child: Row(
      children: [
        const Icon(Icons.restaurant, size: 18),
        const SizedBox(width: 8),
        Expanded(child: Text(name)),
        if (kcal != null) Text('${kcal} kcal', style: Theme.of(context).textTheme.bodySmall),
      ],
    ),
  );
  return Dismissible(
    key: ValueKey('meal-$mealId'),
    direction: DismissDirection.endToStart,
    background: Container(
      alignment: Alignment.centerRight,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      color: Theme.of(context).colorScheme.errorContainer,
      child: Icon(Icons.delete, color: Theme.of(context).colorScheme.onErrorContainer),
    ),
    confirmDismiss: (_) async {
      final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
      try {
        await client.deleteMeal(mealId);
        return true;
      } catch (e) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Delete failed: $e')));
        return false;
      } finally {
        client.close();
      }
    },
    onDismissed: (_) => _controller.refresh(),
    child: inner,
  );
}),
```

(`ApiClient` import is already present in today_screen.dart from prior plans? — verify and add if missing.)

- [ ] **Step 4: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/api/api_client.dart mobile/lib/screens/workout_detail_screen.dart mobile/lib/screens/today_screen.dart
git commit -m "Swipe-to-delete sets + meals"
```

---

## Phase 3: Final readiness

### Task 3: Verify + runbook

- [ ] **Step 1: Verify**

```
cd /Users/kostiailn/Projects/cohort
pnpm test -- --run     # ~180
pnpm typecheck
cd mobile
flutter test            # 9 unchanged
flutter analyze         # clean
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 18: delete rows

62. **Delete a set:**
    Workout detail → swipe a set row left to reveal the red delete background → release → row removed, server state updated.

63. **Delete a meal:**
    Today → Recent meals → swipe left on a meal row → row removed, kcal total updated on next refresh.

64. **403 protection:**
    Trying to DELETE another user's set or meal returns 403 (covered server-side; UI never has access to those ids).

## Plan 18 known limitations

- **No undo** — once swiped, gone. SnackBar undo is a future polish item.
- **No edit** — only delete in this plan.
- **No bulk delete.**
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 18 delete rows smoke checks"
```

---

## Self-review notes

- **Spec coverage:** delete endpoints with ownership (sets via JOIN through workouts) ✓, swipe UI ✓.
- **Scope:** 3 tasks. ~6 unit + 4 integration server tests. No new Flutter widget tests.
