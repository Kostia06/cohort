# History View — Plan 15

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** A "History" screen that shows the last 7 days at a glance: per-day readiness band/score, workout count + completion rate, meals logged + total kcal. Backed by one new aggregation endpoint `/v1/stats/recent?days=7`.

**Out of scope:**
- Long-range trends / charts (sparklines OK, full charts later).
- Per-week / per-month rollups.
- Export.

---

## File Structure

```
src/api/
  worker.ts                              # MODIFY: add GET /v1/stats/recent
  stats-recent.ts                        # NEW: pure aggregator

mobile/
  lib/
    api/api_client.dart                  # MODIFY: fetchRecentStats
    state/history_controller.dart        # NEW
    screens/history_screen.dart          # NEW
    screens/home_shell.dart              # MODIFY: 4-tab NavigationBar with History

tests/
  unit/api/stats-recent.test.ts          # NEW
  integration/stats-recent.test.ts       # NEW
mobile/test/
  history_screen_test.dart               # NEW
```

---

## Phase 1: Server

### Task 1: `handleStatsRecent` + tests

**Files:**
- Create: `src/api/stats-recent.ts`
- Create: `tests/unit/api/stats-recent.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/unit/api/stats-recent.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleStatsRecent } from '../../../src/api/stats-recent';
import { resetDb } from '../../fakes/seed';

const NOW = Date.parse('2026-04-25T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                    VALUES ('u1','Alex','UTC',32,'[]','[]',150,1)`),
    // 2 readiness rows
    env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                    VALUES ('u1','2026-04-24',60,'normal','ready','{}','[]',?)`).bind(NOW - DAY),
    env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                    VALUES ('u1','2026-04-25',72,'normal','ready','{}','[]',?)`).bind(NOW),
    // workouts: 1 logged, 1 planned, 1 skipped on 2026-04-25
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w1','u1','2026-04-25','strength','logged')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w2','u1','2026-04-25','cardio','planned')`),
    env.DB.prepare(`INSERT INTO workouts (workout_id, user_id, date, kind, status) VALUES ('w3','u1','2026-04-25','mobility','skipped')`),
    // meals: 2 today (kcal 380 + 600 = 980)
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                    VALUES ('m1','u1',?,'oats',380,'user')`).bind(NOW - 6 * 60 * 60 * 1000),
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                    VALUES ('m2','u1',?,'lunch',600,'user')`).bind(NOW - 2 * 60 * 60 * 1000),
    // an old meal outside the window
    env.DB.prepare(`INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, source)
                    VALUES ('m_old','u1',?,'old',900,'user')`).bind(NOW - 10 * DAY)
  ]);
});

describe('handleStatsRecent', () => {
  it('aggregates last N days per-day rolling window', async () => {
    const r = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 7, timezone: 'UTC' });
    expect(r.days.length).toBe(7);
    expect(r.days[0]!.date).toBe('2026-04-19');  // oldest
    expect(r.days.at(-1)!.date).toBe('2026-04-25');  // today

    const today = r.days.find((d) => d.date === '2026-04-25')!;
    expect(today.readiness?.score).toBe(72);
    expect(today.readiness?.band).toBe('normal');
    expect(today.workouts.logged).toBe(1);
    expect(today.workouts.planned).toBe(1);
    expect(today.workouts.skipped).toBe(1);
    expect(today.meals.count).toBe(2);
    expect(today.meals.total_kcal).toBe(980);

    const yesterday = r.days.find((d) => d.date === '2026-04-24')!;
    expect(yesterday.readiness?.score).toBe(60);
    expect(yesterday.workouts.logged).toBe(0);
    expect(yesterday.meals.count).toBe(0);
  });

  it('clamps days to [1, 90]', async () => {
    const r = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 0, timezone: 'UTC' });
    expect(r.days.length).toBe(1);
    const r2 = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 200, timezone: 'UTC' });
    expect(r2.days.length).toBe(90);
  });

  it('skips data for other users', async () => {
    await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                          VALUES ('u2','Other','UTC',32,'[]','[]',150,1)`).run();
    await env.DB.prepare(`INSERT INTO readiness_daily (user_id, date, score, band, status, components_json, reasons_json, computed_at)
                          VALUES ('u2','2026-04-25',99,'green','ready','{}','[]',?)`).bind(NOW).run();
    const r = await handleStatsRecent({ db: env.DB, userId: 'u1', now: NOW, days: 7, timezone: 'UTC' });
    const today = r.days.find((d) => d.date === '2026-04-25')!;
    expect(today.readiness?.score).toBe(72);  // u1's, not 99
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/stats-recent.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/stats-recent.ts`**

```ts
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatsRecentInput {
  db: D1Database;
  userId: string;
  now: number;
  days: number;
  timezone: string;
}

export interface DayStats {
  date: string;                   // YYYY-MM-DD local
  readiness: {
    score: number | null;
    band: string | null;
    status: string;
  } | null;
  workouts: {
    logged: number;
    planned: number;
    skipped: number;
  };
  meals: {
    count: number;
    total_kcal: number;
  };
}

export interface StatsRecentResult {
  days: DayStats[];
}

export async function handleStatsRecent(input: StatsRecentInput): Promise<StatsRecentResult> {
  const days = Math.max(1, Math.min(90, Math.floor(input.days || 0)));

  // Build the list of YYYY-MM-DD dates in the user's timezone, oldest first.
  const todayStr = formatDate(input.now, input.timezone);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = input.now - i * DAY_MS;
    dates.push(formatDate(t, input.timezone));
  }

  const earliest = dates[0]!;
  const latest = dates.at(-1)!;

  // Readiness rows in window.
  const readinessRows = await input.db.prepare(
    `SELECT date, score, band, status FROM readiness_daily
     WHERE user_id = ? AND date >= ? AND date <= ?`
  ).bind(input.userId, earliest, latest).all<{
    date: string; score: number | null; band: string | null; status: string;
  }>();

  // Workouts in window.
  const workoutRows = await input.db.prepare(
    `SELECT date, status, COUNT(*) AS cnt FROM workouts
     WHERE user_id = ? AND date >= ? AND date <= ?
     GROUP BY date, status`
  ).bind(input.userId, earliest, latest).all<{
    date: string; status: string; cnt: number;
  }>();

  // Meals in window: aggregate by local date.
  const earliestMs = parseDate(earliest, input.timezone);
  const latestMs = parseDate(latest, input.timezone) + DAY_MS;
  const mealRows = await input.db.prepare(
    `SELECT eaten_at, kcal FROM meals
     WHERE user_id = ? AND eaten_at >= ? AND eaten_at < ?`
  ).bind(input.userId, earliestMs, latestMs).all<{ eaten_at: number; kcal: number | null }>();

  // Index by date.
  const readinessByDate = new Map<string, { score: number | null; band: string | null; status: string }>();
  for (const r of readinessRows.results ?? []) {
    readinessByDate.set(r.date, { score: r.score, band: r.band, status: r.status });
  }

  const workoutByDate = new Map<string, { logged: number; planned: number; skipped: number }>();
  for (const w of workoutRows.results ?? []) {
    const acc = workoutByDate.get(w.date) ?? { logged: 0, planned: 0, skipped: 0 };
    if (w.status === 'logged') acc.logged += w.cnt;
    else if (w.status === 'planned') acc.planned += w.cnt;
    else if (w.status === 'skipped') acc.skipped += w.cnt;
    workoutByDate.set(w.date, acc);
  }

  const mealsByDate = new Map<string, { count: number; total_kcal: number }>();
  for (const m of mealRows.results ?? []) {
    const date = formatDate(m.eaten_at, input.timezone);
    const acc = mealsByDate.get(date) ?? { count: 0, total_kcal: 0 };
    acc.count += 1;
    acc.total_kcal += m.kcal ?? 0;
    mealsByDate.set(date, acc);
  }

  const result: DayStats[] = dates.map((date) => ({
    date,
    readiness: readinessByDate.get(date) ?? null,
    workouts: workoutByDate.get(date) ?? { logged: 0, planned: 0, skipped: 0 },
    meals: mealsByDate.get(date) ?? { count: 0, total_kcal: 0 }
  }));

  return { days: result };
}

function formatDate(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

function parseDate(date: string, timezone: string): number {
  // Best-effort: midnight local converted via offset (matches startOfLocalDayMs in cost.ts).
  const utcMidnightForLocalDate = Date.parse(`${date}T00:00:00Z`);
  const localStrAsUtc = new Date(utcMidnightForLocalDate).toLocaleString('sv-SE', { timeZone: timezone });
  const utcStrAsUtc = new Date(utcMidnightForLocalDate).toLocaleString('sv-SE', { timeZone: 'UTC' });
  const offsetMinutes = (Date.parse(localStrAsUtc + 'Z') - Date.parse(utcStrAsUtc + 'Z')) / 60_000;
  return utcMidnightForLocalDate - offsetMinutes * 60_000;
}
```

- [ ] **Step 4: Pass + commit**

```
pnpm test tests/unit/api/stats-recent.test.ts -- --run
git add src/api/stats-recent.ts tests/unit/api/stats-recent.test.ts
git commit -m "Add handleStatsRecent (last-N-days aggregator: readiness + workouts + meals)"
```

### Task 1 (continued): Wire route + integration test

- [ ] **Step 5: Add route to `src/api/worker.ts`**

```ts
import { handleStatsRecent } from './stats-recent';
```

```ts
if (req.method === 'GET' && url.pathname === '/v1/stats/recent') {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const days = parseInt(url.searchParams.get('days') ?? '7', 10);
  const profile = await env.DB.prepare(`SELECT timezone FROM users WHERE user_id = ?`).bind(userId).first<{ timezone: string }>();
  const tz = profile?.timezone ?? 'UTC';
  const result = await handleStatsRecent({ db: env.DB, userId, now: Date.now(), days, timezone: tz });
  return Response.json(result);
}
```

- [ ] **Step 6: Integration test `tests/integration/stats-recent.test.ts`**

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

describe('GET /v1/stats/recent', () => {
  it('returns 7 days by default with empty defaults', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/stats/recent', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { days: any[] };
    expect(data.days.length).toBe(7);
    expect(data.days[0]!.workouts).toEqual({ logged: 0, planned: 0, skipped: 0 });
    expect(data.days[0]!.meals).toEqual({ count: 0, total_kcal: 0 });
  });

  it('supports ?days=14', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/stats/recent?days=14', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { days: any[] };
    expect(data.days.length).toBe(14);
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/stats/recent');
    expect(resp.status).toBe(401);
  });
});
```

- [ ] **Step 7: Commit**

```
pnpm test -- --run    # ~146 (140 + 3 unit + 3 integration)
pnpm typecheck
git add src/api/worker.ts tests/integration/stats-recent.test.ts
git commit -m "Wire GET /v1/stats/recent route"
```

---

## Phase 2: Flutter

### Task 2: API client + HistoryController + HistoryScreen + nav

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Create: `mobile/lib/state/history_controller.dart`
- Create: `mobile/lib/screens/history_screen.dart`
- Modify: `mobile/lib/screens/home_shell.dart`

- [ ] **Step 1: Add `fetchRecentStats(days:)` to `mobile/lib/api/api_client.dart`**

```dart
Future<Map<String, dynamic>> fetchRecentStats({int days = 7}) async {
  final uri = Uri.parse('$baseUrl/v1/stats/recent?days=$days');
  final req = await _http.getUrl(uri);
  req.headers.set('Authorization', 'Bearer $jwt');
  final resp = await req.close();
  final body = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('stats/recent ${resp.statusCode}: $body');
  }
  return jsonDecode(body) as Map<String, dynamic>;
}
```

- [ ] **Step 2: Write `mobile/lib/state/history_controller.dart`**

```dart
import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class HistoryController extends ChangeNotifier {
  final SettingsController settings;
  Map<String, dynamic>? data;
  String? error;
  bool loading = false;

  HistoryController(this.settings);

  Future<void> refresh({int days = 7}) async {
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
      data = await client.fetchRecentStats(days: days);
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

- [ ] **Step 3: Write `mobile/lib/screens/history_screen.dart`**

```dart
import 'package:flutter/material.dart';
import '../state/history_controller.dart';
import '../state/settings_controller.dart';

class HistoryScreen extends StatefulWidget {
  final SettingsController settings;
  const HistoryScreen({super.key, required this.settings});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  late HistoryController _controller;

  @override
  void initState() {
    super.initState();
    _controller = HistoryController(widget.settings);
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
      onRefresh: () => _controller.refresh(),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: _buildSections(),
      ),
    );
  }

  List<Widget> _buildSections() {
    if (_controller.loading && _controller.data == null) {
      return [const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))];
    }
    if (_controller.error != null) {
      return [Card(
        color: Theme.of(context).colorScheme.errorContainer,
        child: Padding(padding: const EdgeInsets.all(16), child: Text(_controller.error!)),
      )];
    }
    final days = (_controller.data?['days'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    if (days.isEmpty) return [const Center(child: Text('No data yet.'))];
    // Reverse so most recent is on top.
    final reversed = days.reversed.toList();
    return reversed.map(_dayCard).toList();
  }

  Widget _dayCard(Map<String, dynamic> day) {
    final date = day['date'] as String;
    final readiness = day['readiness'] as Map<String, dynamic>?;
    final workouts = (day['workouts'] as Map<String, dynamic>?) ?? const {};
    final meals = (day['meals'] as Map<String, dynamic>?) ?? const {};
    final kcal = meals['total_kcal'] ?? 0;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(date, style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                if (readiness != null && readiness['score'] != null) ...[
                  Text('${readiness['score']}', style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(width: 8),
                  _bandChip(readiness['band'] as String?),
                ],
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 12,
              runSpacing: 4,
              children: [
                _stat(Icons.fitness_center, 'logged', workouts['logged'] ?? 0),
                _stat(Icons.event_available_outlined, 'planned', workouts['planned'] ?? 0),
                if ((workouts['skipped'] ?? 0) != 0) _stat(Icons.skip_next, 'skipped', workouts['skipped']),
                _stat(Icons.restaurant, '${meals['count'] ?? 0} meals · ${kcal} kcal', null),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(IconData icon, String label, dynamic value) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: Theme.of(context).colorScheme.outline),
        const SizedBox(width: 4),
        Text(value == null ? label : '$value $label', style: Theme.of(context).textTheme.bodySmall),
      ],
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
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(band.toUpperCase(), style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 11)),
    );
  }
}
```

- [ ] **Step 4: Update `mobile/lib/screens/home_shell.dart` to add the History tab**

The current shell has 3 tabs (Today / Chat / Sync). Add a 4th tab between Chat and Sync, named History.

```dart
import 'package:flutter/material.dart';
import 'chat_screen.dart';
import 'history_screen.dart';
import 'settings_screen.dart';
import 'sync_screen.dart';
import 'today_screen.dart';
import '../state/auto_sync_controller.dart';
import '../state/settings_controller.dart';

class HomeShell extends StatefulWidget {
  final SettingsController settings;
  final AutoSyncController autoSync;
  const HomeShell({super.key, required this.settings, required this.autoSync});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      TodayScreen(settings: widget.settings, autoSync: widget.autoSync),
      ChatScreen(settings: widget.settings),
      HistoryScreen(settings: widget.settings),
      SyncScreen(settings: widget.settings),
    ];
    final titles = ['Today', 'Chat', 'History', 'Sync'];

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
          NavigationDestination(icon: Icon(Icons.history), label: 'History'),
          NavigationDestination(icon: Icon(Icons.health_and_safety_outlined), label: 'Sync'),
        ],
      ),
    );
  }
}
```

- [ ] **Step 5: Widget test `mobile/test/history_screen_test.dart`**

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/api/auth_storage.dart';
import 'package:cohort_mobile/screens/history_screen.dart';
import 'package:cohort_mobile/state/settings_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('HistoryScreen shows configure-first error when no JWT', (tester) async {
    final settings = SettingsController(AuthStorage());
    await settings.load();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: HistoryScreen(settings: settings)),
    ));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('Configure JWT'), findsOneWidget);
  });
}
```

- [ ] **Step 6: Run + commit**

```
cd mobile && flutter test    # 9 (8 + 1 new history)
flutter analyze              # clean
git add mobile/lib/api/api_client.dart mobile/lib/state/history_controller.dart mobile/lib/screens/history_screen.dart mobile/lib/screens/home_shell.dart mobile/test/history_screen_test.dart
git commit -m "Add HistoryScreen + 4-tab NavigationBar"
```

---

## Phase 3: Final readiness

### Task 3: Verify + runbook

- [ ] **Step 1: Verify**

```
cd /Users/kostiailn/Projects/cohort
pnpm test -- --run    # ~146
pnpm typecheck

cd mobile
flutter test           # 9
flutter analyze        # clean
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 15: history view

50. **Open History tab:** the third bottom-nav tab. Pull-to-refresh. Shows the last 7 days, most-recent first.

51. **Per-day card:** date + readiness score + band chip on the top row. Below: workouts (logged / planned / skipped) and meals (count · kcal).

52. **Empty days:** days with no data show 0 across the board — useful to spot gaps.

53. **Future range options:** the controller accepts `days: 14` etc. — UI selector deferred.

## Plan 15 known limitations

- **Fixed 7-day window** — the API supports up to 90 but the UI doesn't expose a picker yet.
- **No charts / sparklines** — just numbers.
- **No streaks / averages** — derive in a future plan.
- **Timezone uses the user's stored timezone** — doesn't reflect travel.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 15 history view smoke checks"
```

---

## Self-review notes

- **Spec coverage:** server aggregator with N-day window ✓, Flutter screen ✓, History added to nav ✓.
- **Scope:** 3 tasks. ~3 unit + 3 integration server, 1 flutter widget. Server ~146, Flutter ~9.
