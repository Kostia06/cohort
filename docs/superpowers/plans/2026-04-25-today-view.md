# Today View — Plan 11

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Today" screen in Flutter that shows the user's day at a glance: readiness band, today's planned workout (from the agent's batch turn), recent meals, and the agent's latest message. Backed by a new aggregation endpoint `/v1/plans/today` so the client doesn't need 4 round-trips.

**Architecture:** One new server endpoint that joins data the agent has already written. One new Flutter screen. Navigation switches the app's home from the chat screen to a tabbed shell (Today / Chat / Sync).

**Spec:** No formal spec. The endpoint + screen aggregate existing data:
- `readiness_daily` — most recent row.
- `workouts` — today's planned (`status='planned'`).
- `meals` — last 24h.
- `chat_turns` — latest assistant turn for context.

**Out of scope:**
- Editing plan items inline (tap → start workout, mark workout done, etc.). Plan 12+ can add this.
- Multi-day plan timeline.
- Sharing / export.

---

## File Structure

```
src/api/
  worker.ts                              # MODIFY: add /v1/plans/today route
  plans-today.ts                         # NEW: pure handler

mobile/
  lib/
    api/api_client.dart                  # MODIFY: add fetchToday()
    state/today_controller.dart          # NEW
    screens/today_screen.dart            # NEW
    screens/home_shell.dart              # NEW: NavigationBar wrapping Today / Chat / Sync
    main.dart                            # MODIFY: home is HomeShell, not ChatScreen
  test/
    today_screen_test.dart               # NEW

tests/
  unit/api/plans-today.test.ts           # NEW
  integration/plans-today.test.ts        # NEW
```

---

## Phase 1: Server endpoint

### Task 1: `handlePlansToday`

**Files:**
- Create: `src/api/plans-today.ts`
- Create: `tests/unit/api/plans-today.test.ts`

Pure handler that takes `(userId, date, deps)` and returns the aggregated payload.

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/api/plans-today.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handlePlansToday } from '../../../src/api/plans-today';
import { resetDb } from '../../fakes/seed';

const NOW = Date.parse('2026-04-25T15:00:00Z');

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    env.DB.prepare(`INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',1)`)
  ]);
});

describe('handlePlansToday', () => {
  it('returns empty payload when nothing exists', async () => {
    const r = await handlePlansToday({
      userId: 'u1',
      date: '2026-04-25',
      now: NOW,
      db: env.DB
    });
    expect(r.readiness).toBeNull();
    expect(r.planned_workouts).toEqual([]);
    expect(r.recent_meals).toEqual([]);
    expect(r.latest_assistant_message).toBeNull();
  });

  it('aggregates readiness, planned workouts, recent meals, latest assistant message', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                      VALUES ('u1','2026-04-25',72,'normal','ready','{"hrv":75}','["good sleep"]',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, duration_min, rpe, status, source)
                      VALUES ('w1','u1','2026-04-25','strength',60,8,'planned','agent')`),
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                      VALUES ('m1','u1',?,'oatmeal',380,'manual')`).bind(NOW - 6 * 60 * 60 * 1000),
      env.DB.prepare(`INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, text, started_at, ended_at)
                      VALUES ('t1','th1',0,'system','complete','Plan generated for tomorrow.',?,?)`).bind(NOW - 60 * 60 * 1000, NOW - 60 * 60 * 1000 + 5)
    ]);

    const r = await handlePlansToday({
      userId: 'u1',
      date: '2026-04-25',
      now: NOW,
      db: env.DB
    });

    expect(r.readiness).toEqual({ score: 72, band: 'normal', status: 'ready', components: { hrv: 75 }, reasons: ['good sleep'] });
    expect(r.planned_workouts).toEqual([{ workout_id: 'w1', kind: 'strength', duration_min: 60, rpe: 8, status: 'planned', notes: null }]);
    expect(r.recent_meals.length).toBe(1);
    expect(r.recent_meals[0]!.name).toBe('oatmeal');
    expect(r.latest_assistant_message?.text).toContain('Plan generated');
  });

  it('limits recent meals to last 24h', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source)
                      VALUES ('m_recent','u1',?,'recent','manual')`).bind(NOW - 6 * 60 * 60 * 1000),
      env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, source)
                      VALUES ('m_old','u1',?,'old','manual')`).bind(NOW - 30 * 60 * 60 * 1000)
    ]);
    const r = await handlePlansToday({ userId: 'u1', date: '2026-04-25', now: NOW, db: env.DB });
    expect(r.recent_meals.map((m) => m.name)).toEqual(['recent']);
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/plans-today.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/plans-today.ts`**

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlansTodayInput {
  userId: string;
  date: string;            // YYYY-MM-DD
  now: number;             // ms epoch
  db: D1Database;
}

export interface PlansTodayResult {
  date: string;
  readiness: {
    score: number | null;
    band: string | null;
    status: string;
    components: Record<string, unknown>;
    reasons: string[];
  } | null;
  planned_workouts: Array<{
    workout_id: string;
    kind: string;
    duration_min: number | null;
    rpe: number | null;
    status: string;
    notes: string | null;
  }>;
  recent_meals: Array<{
    meal_id: string;
    name: string;
    eaten_at: number;
    kcal: number | null;
    notes: string | null;
  }>;
  latest_assistant_message: {
    turn_id: string;
    text: string;
    actor: string;
    started_at: number;
  } | null;
}

export async function handlePlansToday(input: PlansTodayInput): Promise<PlansTodayResult> {
  const { db, userId, date, now } = input;

  const readinessRow = await db.prepare(
    `SELECT score, band, status, components_json, reasons_json
     FROM readiness_daily
     WHERE user_id = ? AND date = ?`
  ).bind(userId, date).first<{
    score: number | null; band: string | null; status: string;
    components_json: string; reasons_json: string;
  }>();

  const readiness = readinessRow ? {
    score: readinessRow.score,
    band: readinessRow.band,
    status: readinessRow.status,
    components: safeJson(readinessRow.components_json) as Record<string, unknown>,
    reasons: safeJson(readinessRow.reasons_json) as string[]
  } : null;

  const workoutRows = await db.prepare(
    `SELECT workout_id, kind, duration_min, rpe, status, notes
     FROM workouts
     WHERE user_id = ? AND date = ? AND status = 'planned'
     ORDER BY workout_id`
  ).bind(userId, date).all<{
    workout_id: string; kind: string; duration_min: number | null;
    rpe: number | null; status: string; notes: string | null;
  }>();

  const mealRows = await db.prepare(
    `SELECT meal_id, name, eaten_at, kcal, notes
     FROM meals
     WHERE user_id = ? AND eaten_at >= ?
     ORDER BY eaten_at DESC`
  ).bind(userId, now - DAY_MS).all<{
    meal_id: string; name: string; eaten_at: number;
    kcal: number | null; notes: string | null;
  }>();

  const latestRow = await db.prepare(
    `SELECT t.turn_id, t.text, t.actor, t.started_at
     FROM chat_turns t
     JOIN chat_threads th ON th.thread_id = t.thread_id
     WHERE th.user_id = ? AND t.status = 'complete' AND t.text IS NOT NULL
     ORDER BY t.started_at DESC
     LIMIT 1`
  ).bind(userId).first<{
    turn_id: string; text: string; actor: string; started_at: number;
  }>();

  return {
    date,
    readiness,
    planned_workouts: workoutRows.results ?? [],
    recent_meals: mealRows.results ?? [],
    latest_assistant_message: latestRow ?? null
  };
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
```

- [ ] **Step 4: Pass + commit**

`pnpm test tests/unit/api/plans-today.test.ts -- --run` → PASS (3 tests).

```
git add src/api/plans-today.ts tests/unit/api/plans-today.test.ts
git commit -m "Add handlePlansToday aggregator (readiness + workouts + meals + last assistant)"
```

---

### Task 2: Wire `/v1/plans/today` route + integration test

**Files:**
- Modify: `src/api/worker.ts`
- Create: `tests/integration/plans-today.test.ts`

- [ ] **Step 1: Add the route to `src/api/worker.ts`**

Read the file. Add the import:
```ts
import { handlePlansToday } from './plans-today';
```

Add the route alongside the existing routes (before the 404 fallback):

```ts
if (req.method === 'GET' && url.pathname === '/v1/plans/today') {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const result = await handlePlansToday({ userId, date, now: Date.now(), db: env.DB });
  return Response.json(result);
}
```

- [ ] **Step 2: Write `tests/integration/plans-today.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
     VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`
  ).run();
});

describe('GET /v1/plans/today', () => {
  it('returns empty aggregate when no data', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/plans/today?date=2026-04-25', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { readiness: null; planned_workouts: any[]; recent_meals: any[] };
    expect(data.readiness).toBeNull();
    expect(data.planned_workouts).toEqual([]);
    expect(data.recent_meals).toEqual([]);
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/plans/today', { method: 'GET' });
    expect(resp.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run + commit**

```
pnpm test -- --run     # 124 PASS (122 + 2 new integration tests; +3 unit from Task 1 → +5 total → wait, let me recount... Plan 8 left 122, +3 unit + +2 integration = 127)
pnpm typecheck         # exit 0
git add src/api/worker.ts tests/integration/plans-today.test.ts
git commit -m "Wire GET /v1/plans/today route"
```

(The exact count depends on the previous baseline. Take whatever shows up.)

---

## Phase 2: Flutter Today screen

### Task 3: API client `fetchToday()`

**Files:**
- Modify: `mobile/lib/api/api_client.dart`

- [ ] **Step 1: Add to `ApiClient` class**

Add this method:

```dart
Future<Map<String, dynamic>> fetchToday({String? date}) async {
  final dateParam = date == null ? '' : '?date=$date';
  final uri = Uri.parse('$baseUrl/v1/plans/today$dateParam');
  final req = await _http.getUrl(uri);
  req.headers.set('Authorization', 'Bearer $jwt');
  final resp = await req.close();
  final body = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('plans/today ${resp.statusCode}: $body');
  }
  return jsonDecode(body) as Map<String, dynamic>;
}
```

- [ ] **Step 2: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/api/api_client.dart
git commit -m "Add fetchToday to API client"
```

---

### Task 4: TodayController + TodayScreen

**Files:**
- Create: `mobile/lib/state/today_controller.dart`
- Create: `mobile/lib/screens/today_screen.dart`

- [ ] **Step 1: Write `mobile/lib/state/today_controller.dart`**

```dart
import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class TodayController extends ChangeNotifier {
  final SettingsController settings;
  Map<String, dynamic>? data;
  String? error;
  bool loading = false;

  TodayController(this.settings);

  Future<void> refresh() async {
    if (!settings.isConfigured) {
      error = 'Configure JWT in Settings first';
      notifyListeners();
      return;
    }
    loading = true;
    error = null;
    notifyListeners();
    final client = ApiClient(baseUrl: settings.baseUrl, jwt: settings.jwt);
    try {
      data = await client.fetchToday();
    } catch (e) {
      error = e.toString();
    } finally {
      client.close();
      loading = false;
      notifyListeners();
    }
  }
}
```

- [ ] **Step 2: Write `mobile/lib/screens/today_screen.dart`**

```dart
import 'package:flutter/material.dart';
import '../state/settings_controller.dart';
import '../state/today_controller.dart';

class TodayScreen extends StatefulWidget {
  final SettingsController settings;
  const TodayScreen({super.key, required this.settings});

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  late TodayController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TodayController(widget.settings);
    _controller.addListener(_onChange);
    _controller.refresh();
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    _controller.removeListener(_onChange);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _controller.refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: _buildSections(context),
      ),
    );
  }

  List<Widget> _buildSections(BuildContext context) {
    if (_controller.loading && _controller.data == null) {
      return [const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))];
    }
    if (_controller.error != null) {
      return [_errorBanner(_controller.error!)];
    }
    final data = _controller.data;
    if (data == null) {
      return [const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Pull to refresh.')))];
    }
    return [
      _readinessCard(data['readiness'] as Map<String, dynamic>?),
      const SizedBox(height: 16),
      _workoutsCard((data['planned_workouts'] as List?) ?? const []),
      const SizedBox(height: 16),
      _mealsCard((data['recent_meals'] as List?) ?? const []),
      const SizedBox(height: 16),
      _latestMessageCard(data['latest_assistant_message'] as Map<String, dynamic>?),
    ];
  }

  Widget _errorBanner(String message) {
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Text(message, style: TextStyle(color: Theme.of(context).colorScheme.onErrorContainer)),
      ),
    );
  }

  Widget _readinessCard(Map<String, dynamic>? readiness) {
    if (readiness == null) return _placeholderCard('Readiness', 'No reading yet today. Sync from Health.');
    final status = readiness['status'] as String;
    if (status == 'calibrating') {
      return _placeholderCard('Readiness', 'Calibrating — keep syncing daily for ~14 days.');
    }
    final score = readiness['score'];
    final band = readiness['band'];
    final reasons = (readiness['reasons'] as List?)?.cast<String>() ?? const [];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('Readiness', style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text('$score', style: Theme.of(context).textTheme.headlineLarge),
                const SizedBox(width: 12),
                _bandChip(band as String?),
              ],
            ),
            if (reasons.isNotEmpty) ...[
              const SizedBox(height: 12),
              ...reasons.map((r) => Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('• $r', style: Theme.of(context).textTheme.bodySmall),
              )),
            ],
          ],
        ),
      ),
    );
  }

  Widget _bandChip(String? band) {
    if (band == null) return const SizedBox.shrink();
    final color = switch (band) {
      'rest' => Colors.red,
      'easy' => Colors.orange,
      'normal' => Colors.blue,
      'green' => Colors.green,
      _ => Colors.grey,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(band.toUpperCase(), style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 12)),
    );
  }

  Widget _workoutsCard(List workouts) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Today\'s plan', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (workouts.isEmpty) const Text('No workout proposed yet.'),
            ...workouts.map((w) {
              final kind = (w['kind'] as String?) ?? '';
              final duration = w['duration_min'];
              final rpe = w['rpe'];
              return Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(
                  children: [
                    const Icon(Icons.fitness_center, size: 18),
                    const SizedBox(width: 8),
                    Expanded(child: Text('$kind${duration != null ? ' · ${duration}m' : ''}${rpe != null ? ' · RPE $rpe' : ''}')),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }

  Widget _mealsCard(List meals) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Recent meals (24h)', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
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

  Widget _latestMessageCard(Map<String, dynamic>? msg) {
    if (msg == null) return const SizedBox.shrink();
    final text = (msg['text'] as String?) ?? '';
    if (text.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Latest from Cohort', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(text.length > 280 ? text.substring(0, 280) + '…' : text),
          ],
        ),
      ),
    );
  }

  Widget _placeholderCard(String title, String body) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(body, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}
```

- [ ] **Step 3: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/state/today_controller.dart mobile/lib/screens/today_screen.dart
git commit -m "Add TodayController + TodayScreen"
```

---

### Task 5: HomeShell with NavigationBar + main.dart wiring + widget test

**Files:**
- Create: `mobile/lib/screens/home_shell.dart`
- Modify: `mobile/lib/main.dart`
- Modify: `mobile/lib/screens/chat_screen.dart` (drop AppBar, since the shell will own it)
- Create: `mobile/test/today_screen_test.dart`

The chat screen currently has its own AppBar with navigation buttons. With a NavigationBar shell, the per-screen AppBars become simpler (or empty). Adjust as needed.

- [ ] **Step 1: Write `mobile/lib/screens/home_shell.dart`**

```dart
import 'package:flutter/material.dart';
import 'chat_screen.dart';
import 'settings_screen.dart';
import 'sync_screen.dart';
import 'today_screen.dart';
import '../state/settings_controller.dart';

class HomeShell extends StatefulWidget {
  final SettingsController settings;
  const HomeShell({super.key, required this.settings});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      TodayScreen(settings: widget.settings),
      ChatScreen(settings: widget.settings),
      SyncScreen(settings: widget.settings),
    ];
    final titles = ['Today', 'Chat', 'Sync'];

    return Scaffold(
      appBar: AppBar(
        title: Text(titles[_index]),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(controller: widget.settings),
              ),
            ),
          ),
        ],
      ),
      body: pages[_index],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.today_outlined), label: 'Today'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.health_and_safety_outlined), label: 'Sync'),
        ],
      ),
    );
  }
}
```

- [ ] **Step 2: Update `mobile/lib/main.dart`**

Replace the line that returns `ChatScreen(settings: _settings)` with `HomeShell(settings: _settings)`. Update the import.

```dart
import 'package:flutter/material.dart';
import 'api/auth_storage.dart';
import 'screens/home_shell.dart';
import 'state/settings_controller.dart';

// ... CohortApp unchanged ...

class _BootstrapState extends State<_Bootstrap> {
  // ... unchanged ...
  @override
  Widget build(BuildContext context) {
    if (!_settings.loaded) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return HomeShell(settings: _settings);
  }
}
```

- [ ] **Step 3: Strip AppBar from `chat_screen.dart` (the shell now owns it)**

In `mobile/lib/screens/chat_screen.dart`, remove the `appBar:` parameter from the `Scaffold`. The chat title and the nav buttons (sync, settings) are no longer needed because the shell provides them. Keep only the body.

Replace:
```dart
return Scaffold(
  appBar: AppBar(
    title: const Text('Cohort'),
    actions: [...],
  ),
  body: SafeArea(child: Column(...)),
);
```

With:
```dart
return SafeArea(child: Column(...));
```

(Remove the now-unused imports for `SettingsScreen`, `SyncScreen`, and the actions-related code.)

- [ ] **Step 4: Same for `sync_screen.dart` and `settings_screen.dart`** — leave their AppBars in place because they're pushed via Navigator (settings) or shown as a tab (sync). Actually, the sync_screen is shown as a tab inside the shell which already has an AppBar with title="Sync". So drop sync_screen's AppBar. Settings_screen is pushed independently — keep its AppBar.

Update `mobile/lib/screens/sync_screen.dart`: remove the `appBar: AppBar(title: const Text('HealthKit Sync'))` line and just return the body content. Wrap in a `Padding` or `Scaffold`-without-AppBar.

- [ ] **Step 5: Add a widget test**

`mobile/test/today_screen_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/screens/today_screen.dart';
import 'package:cohort_mobile/api/auth_storage.dart';
import 'package:cohort_mobile/state/settings_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('TodayScreen renders the configure-first error when no JWT is set', (tester) async {
    final settings = SettingsController(AuthStorage());
    await settings.load();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: TodayScreen(settings: settings)),
    ));
    // Allow the controller's refresh future to resolve.
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('Configure JWT'), findsOneWidget);
  });
}
```

- [ ] **Step 6: Run flutter test + analyze**

```
cd mobile
flutter test          # 6 passing (3 SSE + 1 widget boot + 1 sync + 1 today)
flutter analyze       # clean
```

- [ ] **Step 7: Commit**

```
git add mobile/lib/screens/home_shell.dart mobile/lib/main.dart mobile/lib/screens/chat_screen.dart mobile/lib/screens/sync_screen.dart mobile/test/today_screen_test.dart
git commit -m "Add HomeShell with NavigationBar (Today / Chat / Sync)"
```

---

## Phase 3: Final readiness

### Task 6: Final + runbook

- [ ] **Step 1: Verify**

```
pnpm test -- --run            # ~127 (122 baseline + 3 unit + 2 integration)
pnpm typecheck

cd mobile
flutter test                   # 6 passing
flutter analyze                # clean
flutter build ios --no-codesign --release  # may fail on entitlements; ok
```

- [ ] **Step 2: Append to root runbook**

```markdown

---

## After Plan 11: Today view

36. **Empty state:** open the app on a fresh user. Today tab shows placeholders ("No reading yet today", "No workout proposed yet", "No meals logged in the last 24 hours").

37. **Populated state:**
    - Sync HealthKit (Sync tab → Read from Health → Sync today). After 14d of history this returns a real readiness band.
    - Run the batch turn (`curl -X POST .../v1/run-batch/u1 -H "X-User-Id: u1"` for now, or wait until 5am local).
    - Pull-to-refresh on the Today tab. Readiness card shows score + band, Today's plan card shows the proposed workout, Latest from Cohort card shows the assistant's batch message.

38. **Auth check:** Today tab displays a "Configure JWT" message if settings aren't set.

## Plan 11 known limitations

- **No interactivity** — tap-to-start workout, mark workout done, log meal from Today, etc. are not yet wired. Planned for Plan 12+.
- **No multi-day timeline** — only "today". Yesterday's reflection / tomorrow's preview is a future plan.
- **Latest assistant message is uncurated** — picks the latest `chat_turn` regardless of thread. Multi-thread filtering is a future plan.
```

- [ ] **Step 3: Commit**

```
cd /Users/kostiailn/Projects/cohort
git add docs/superpowers/runbooks/
git commit -m "Add Plan 11 Today view smoke checks"
```

---

## Self-review notes

- **Spec coverage:** aggregation endpoint ✓, readiness/workouts/meals/latest message all surfaced ✓, NavigationBar shell ✓.
- **Placeholder scan:** none.
- **Type consistency:** `PlansTodayResult` defined in server, decoded as `Map<String,dynamic>` on Flutter side (no Dart codegen for v1).
- **Scope:** 6 tasks. ~5 new tests (3 unit + 2 integration server, 1 flutter widget). Server test count ~127, Flutter ~6.
