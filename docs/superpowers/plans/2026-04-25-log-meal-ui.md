# Quick Log Meal UI — Plan 14

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let the user log a meal from the Flutter UI without going through chat. Adds a "Log meal" button on the Today screen that opens a form (name + optional kcal / macros / notes) and POSTs to a new `/v1/meals` server endpoint. The Today screen's "Recent meals" card refreshes after.

**Out of scope:**
- Editing or deleting logged meals.
- Photos / barcodes / OCR.
- Meal templates / favorites.
- Per-ingredient breakdown.

---

## File Structure

```
src/api/
  worker.ts                              # MODIFY: add POST /v1/meals
  meals-create.ts                        # NEW: pure handler

mobile/
  lib/
    api/api_client.dart                  # MODIFY: add logMeal()
    screens/log_meal_screen.dart         # NEW
    screens/today_screen.dart            # MODIFY: "Log meal" button on Recent meals card

tests/
  unit/api/meals-create.test.ts          # NEW
  integration/meals-create.test.ts       # NEW
```

---

## Phase 1: Server

### Task 1: `handleMealCreate` + tests

**Files:**
- Create: `src/api/meals-create.ts`
- Create: `tests/unit/api/meals-create.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/unit/api/meals-create.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleMealCreate } from '../../../src/api/meals-create';
import { resetDb } from '../../fakes/seed';

const NOW = 1_730_000_000_000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`).run();
});

describe('handleMealCreate', () => {
  it('inserts a meal and returns the id', async () => {
    const r = await handleMealCreate({
      db: env.DB,
      userId: 'u1',
      now: NOW,
      input: { name: 'oatmeal', kcal: 380, protein_g: 14 }
    });
    expect(r.ok).toBe(true);
    expect(r.meal_id).toMatch(/^meal_u1_/);
    const row = await env.DB.prepare(`SELECT name, kcal, protein_g, source FROM meals WHERE meal_id = ?`).bind(r.meal_id).first();
    expect(row).toEqual({ name: 'oatmeal', kcal: 380, protein_g: 14, source: 'user' });
  });

  it('uses provided eaten_at when given', async () => {
    const r = await handleMealCreate({
      db: env.DB, userId: 'u1', now: NOW,
      input: { name: 'lunch', eaten_at: NOW - 3 * 60 * 60 * 1000 }
    });
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT eaten_at FROM meals WHERE meal_id = ?`).bind(r.meal_id).first<{ eaten_at: number }>();
    expect(row?.eaten_at).toBe(NOW - 3 * 60 * 60 * 1000);
  });

  it('rejects missing name with 400', async () => {
    const r = await handleMealCreate({ db: env.DB, userId: 'u1', now: NOW, input: { name: '' } as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/meals-create.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/meals-create.ts`**

```ts
import { ulid } from 'ulid';

export interface MealCreateInput {
  name: string;
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  notes?: string;
  eaten_at?: number;
}

export interface MealCreateRequest {
  db: D1Database;
  userId: string;
  now: number;
  input: MealCreateInput;
}

export interface MealCreateResult {
  ok: boolean;
  meal_id?: string;
  status?: number;
  reason?: string;
}

export async function handleMealCreate(req: MealCreateRequest): Promise<MealCreateResult> {
  const name = req.input?.name?.trim();
  if (!name) return { ok: false, status: 400, reason: 'missing name' };

  const mealId = `meal_${req.userId}_${ulid()}`;
  const eatenAt = req.input.eaten_at ?? req.now;

  await req.db.prepare(
    `INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, protein_g, carbs_g, fat_g, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')`
  ).bind(
    mealId,
    req.userId,
    eatenAt,
    name,
    req.input.kcal ?? null,
    req.input.protein_g ?? null,
    req.input.carbs_g ?? null,
    req.input.fat_g ?? null,
    req.input.notes ?? null
  ).run();

  return { ok: true, meal_id: mealId };
}
```

- [ ] **Step 4: Pass + commit**

```
pnpm test tests/unit/api/meals-create.test.ts -- --run    # 3 PASS
git add src/api/meals-create.ts tests/unit/api/meals-create.test.ts
git commit -m "Add handleMealCreate (POST /v1/meals body validation + insert)"
```

### Task 1 (continued): Wire route + integration test

- [ ] **Step 5: Add route to `src/api/worker.ts`**

```ts
import { handleMealCreate } from './meals-create';
```

```ts
if (req.method === 'POST' && url.pathname === '/v1/meals') {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const body = await req.json<any>();
  const r = await handleMealCreate({
    db: env.DB,
    userId,
    now: Date.now(),
    input: body
  });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json({ ok: true, meal_id: r.meal_id });
}
```

- [ ] **Step 6: Integration test `tests/integration/meals-create.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`).run();
});

describe('POST /v1/meals', () => {
  it('logs a meal', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'apple', kcal: 95 })
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { ok: boolean; meal_id: string };
    expect(data.ok).toBe(true);
    expect(data.meal_id).toMatch(/^meal_u1_/);
  });

  it('rejects missing name with 400', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/meals', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(resp.status).toBe(400);
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'apple' })
    });
    expect(resp.status).toBe(401);
  });
});
```

- [ ] **Step 7: Run + commit**

```
pnpm test -- --run     # ~140 (134 + 3 unit + 3 integration)
pnpm typecheck
git add src/api/worker.ts tests/integration/meals-create.test.ts
git commit -m "Wire POST /v1/meals route"
```

---

## Phase 2: Flutter

### Task 2: API client + LogMealScreen + Today wiring

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Create: `mobile/lib/screens/log_meal_screen.dart`
- Modify: `mobile/lib/screens/today_screen.dart`

- [ ] **Step 1: Add `logMeal` to `mobile/lib/api/api_client.dart`**

Inside the `ApiClient` class:

```dart
Future<String> logMeal({
  required String name,
  int? kcal,
  double? proteinG,
  double? carbsG,
  double? fatG,
  String? notes,
  DateTime? eatenAt,
}) async {
  final uri = Uri.parse('$baseUrl/v1/meals');
  final req = await _http.postUrl(uri);
  req.headers.set('Authorization', 'Bearer $jwt');
  req.headers.set('Content-Type', 'application/json');
  final body = <String, dynamic>{ 'name': name };
  if (kcal != null) body['kcal'] = kcal;
  if (proteinG != null) body['protein_g'] = proteinG;
  if (carbsG != null) body['carbs_g'] = carbsG;
  if (fatG != null) body['fat_g'] = fatG;
  if (notes != null && notes.isNotEmpty) body['notes'] = notes;
  if (eatenAt != null) body['eaten_at'] = eatenAt.millisecondsSinceEpoch;
  req.add(utf8.encode(jsonEncode(body)));
  final resp = await req.close();
  final respBody = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('logMeal ${resp.statusCode}: $respBody');
  }
  final data = jsonDecode(respBody) as Map<String, dynamic>;
  return data['meal_id'] as String;
}
```

- [ ] **Step 2: Write `mobile/lib/screens/log_meal_screen.dart`**

```dart
import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class LogMealScreen extends StatefulWidget {
  final SettingsController settings;
  const LogMealScreen({super.key, required this.settings});

  @override
  State<LogMealScreen> createState() => _LogMealScreenState();
}

class _LogMealScreenState extends State<LogMealScreen> {
  final _name = TextEditingController();
  final _kcal = TextEditingController();
  final _protein = TextEditingController();
  final _carbs = TextEditingController();
  final _fat = TextEditingController();
  final _notes = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _kcal.dispose();
    _protein.dispose();
    _carbs.dispose();
    _fat.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Meal name is required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.logMeal(
        name: name,
        kcal: int.tryParse(_kcal.text),
        proteinG: double.tryParse(_protein.text),
        carbsG: double.tryParse(_carbs.text),
        fatG: double.tryParse(_fat.text),
        notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
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
    return Scaffold(
      appBar: AppBar(title: const Text('Log meal')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Meal name'),
              textInputAction: TextInputAction.next,
              autofocus: true,
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: TextField(controller: _kcal, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'kcal'))),
              const SizedBox(width: 12),
              Expanded(child: TextField(controller: _protein, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'protein g'))),
            ]),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: TextField(controller: _carbs, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'carbs g'))),
              const SizedBox(width: 12),
              Expanded(child: TextField(controller: _fat, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'fat g'))),
            ]),
            const SizedBox(height: 12),
            TextField(
              controller: _notes,
              decoration: const InputDecoration(labelText: 'Notes (optional)'),
              minLines: 1,
              maxLines: 3,
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
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? 'Saving…' : 'Log meal'),
            ),
          ],
        ),
      ),
    );
  }
}
```

- [ ] **Step 3: Add the trigger in `mobile/lib/screens/today_screen.dart`**

Update `_mealsCard` to include a header row with a "+ Add" button. When tapped, push `LogMealScreen`; on success refresh.

Replace the existing `_mealsCard(List meals)` body with:

```dart
Widget _mealsCard(List meals) {
  return Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Recent meals (24h)', style: Theme.of(context).textTheme.titleMedium),
              const Spacer(),
              TextButton.icon(
                onPressed: () async {
                  final result = await Navigator.of(context).push<bool>(
                    MaterialPageRoute(
                      builder: (_) => LogMealScreen(settings: widget.settings),
                    ),
                  );
                  if (result == true) _controller.refresh();
                },
                icon: const Icon(Icons.add),
                label: const Text('Log'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          if (meals.isEmpty) const Text('No meals logged in the last 24 hours.'),
          ...meals.map((m) {
            final name = (m['name'] as String?) ?? '';
            final kcal = m['kcal'];
            return Padding(
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
          }),
        ],
      ),
    ),
  );
}
```

Add the import:
```dart
import 'log_meal_screen.dart';
```

- [ ] **Step 4: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/api/api_client.dart mobile/lib/screens/log_meal_screen.dart mobile/lib/screens/today_screen.dart
git commit -m "Add LogMealScreen + Today screen Add button"
```

---

## Phase 3: Final readiness

### Task 3: Verify + runbook

- [ ] **Step 1: Verify**

```
cd /Users/kostiailn/Projects/cohort
pnpm test -- --run    # ~140 (134 + 3 unit + 3 integration)
pnpm typecheck

cd mobile
flutter test           # 8 unchanged
flutter analyze        # clean
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 14: log meal UI

47. **Log a meal:**
    From the Today tab, tap "Log" in the top-right of the Recent meals card. Enter a name + optional kcal/macros/notes. Tap "Log meal". The screen pops, the meals list refreshes with the new entry.

48. **Validation:** submitting with empty name shows an inline error and does not POST.

49. **Source attribution:** server stamps `source='user'` on these rows. Compare to `source='agent'` for meals the agent logged via `log_meal` tool, and `source='manual'` (legacy default for `propose_workout`-derived meals if any).

## Plan 14 known limitations

- **No edit / delete from UI** — manual D1 only.
- **Macros are free-form** — no validation that kcal ≈ 4*P + 4*C + 9*F.
- **No favorites / templates / recent picks**.
- **eaten_at is always now** (no time picker yet).
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 14 log meal UI smoke checks"
```

---

## Self-review notes

- **Spec coverage:** server endpoint with auth + validation ✓, Flutter screen + Today wiring ✓, source='user' attribution ✓.
- **Scope:** 3 tasks. ~3 unit + 3 integration server tests. No new Flutter tests.
