# Profile Edit — Plan 17

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let the user edit their own profile from the app — display name, timezone, age, dietary pattern, allergies, dislikes, daily cost cap. Currently those columns can only be changed via raw SQL.

**Out of scope:**
- Account deletion / data export.
- Password / auth flows (Plan 11+).
- Email or contact info — not yet a column.
- Photo / avatar.

---

## File Structure

```
src/api/
  worker.ts                              # MODIFY: add GET /v1/me + PATCH /v1/me
  me.ts                                  # NEW: pure handlers

mobile/
  lib/
    api/api_client.dart                  # MODIFY: getMe, updateMe
    state/profile_controller.dart        # NEW
    screens/profile_screen.dart          # NEW
    screens/settings_screen.dart         # MODIFY: add an "Edit profile" tile

tests/
  unit/api/me.test.ts                    # NEW
  integration/me.test.ts                 # NEW
```

---

## Phase 1: Server

### Task 1: `handleMeGet` + `handleMeUpdate` + tests

**Files:**
- Create: `src/api/me.ts`
- Create: `tests/unit/api/me.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/unit/api/me.test.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { handleMeGet, handleMeUpdate } from '../../../src/api/me';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'omnivore','["peanut"]','["fish"]',150,1)`).run();
});

describe('handleMeGet', () => {
  it('returns the current user profile', async () => {
    const r = await handleMeGet({ db: env.DB, userId: 'u1' });
    expect(r.ok).toBe(true);
    expect(r.profile).toEqual({
      user_id: 'u1',
      display_name: 'Alex',
      timezone: 'UTC',
      age_years: 32,
      dietary_pattern: 'omnivore',
      allergies: ['peanut'],
      dislikes: ['fish'],
      daily_cost_cap_cents: 150
    });
  });

  it('returns 404 for missing user', async () => {
    const r = await handleMeGet({ db: env.DB, userId: 'no-such' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe('handleMeUpdate', () => {
  it('updates editable fields', async () => {
    const r = await handleMeUpdate({
      db: env.DB,
      userId: 'u1',
      input: {
        display_name: 'A.',
        timezone: 'America/Edmonton',
        age_years: 33,
        dietary_pattern: 'pescatarian',
        allergies: ['peanut', 'shellfish'],
        dislikes: [],
        daily_cost_cap_cents: 200
      }
    });
    expect(r.ok).toBe(true);
    const get = await handleMeGet({ db: env.DB, userId: 'u1' });
    expect(get.profile?.display_name).toBe('A.');
    expect(get.profile?.timezone).toBe('America/Edmonton');
    expect(get.profile?.age_years).toBe(33);
    expect(get.profile?.dietary_pattern).toBe('pescatarian');
    expect(get.profile?.allergies).toEqual(['peanut', 'shellfish']);
    expect(get.profile?.dislikes).toEqual([]);
    expect(get.profile?.daily_cost_cap_cents).toBe(200);
  });

  it('partial update only changes provided fields', async () => {
    await handleMeUpdate({ db: env.DB, userId: 'u1', input: { display_name: 'Only Name' } });
    const r = await handleMeGet({ db: env.DB, userId: 'u1' });
    expect(r.profile?.display_name).toBe('Only Name');
    expect(r.profile?.timezone).toBe('UTC');
    expect(r.profile?.age_years).toBe(32);
  });

  it('rejects empty display_name with 400', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { display_name: '   ' } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects daily_cost_cap_cents below 0', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { daily_cost_cap_cents: -1 } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects unknown dietary_pattern', async () => {
    const r = await handleMeUpdate({ db: env.DB, userId: 'u1', input: { dietary_pattern: 'invented' as any } });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run + fail**

`pnpm test tests/unit/api/me.test.ts -- --run` → FAIL.

- [ ] **Step 3: Implement `src/api/me.ts`**

```ts
const ALLOWED_PATTERNS = ['omnivore', 'vegetarian', 'vegan', 'pescatarian', 'keto'] as const;
type DietaryPattern = typeof ALLOWED_PATTERNS[number];

export interface Profile {
  user_id: string;
  display_name: string;
  timezone: string;
  age_years: number | null;
  dietary_pattern: string | null;
  allergies: string[];
  dislikes: string[];
  daily_cost_cap_cents: number;
}

export interface MeGetRequest {
  db: D1Database;
  userId: string;
}

export interface MeGetResult {
  ok: boolean;
  profile?: Profile;
  status?: number;
  reason?: string;
}

export async function handleMeGet(req: MeGetRequest): Promise<MeGetResult> {
  const row = await req.db.prepare(
    `SELECT user_id, display_name, timezone, age_years, dietary_pattern,
            allergies_json, dislikes_json, daily_cost_cap_cents
     FROM users WHERE user_id = ?`
  ).bind(req.userId).first<{
    user_id: string;
    display_name: string;
    timezone: string;
    age_years: number | null;
    dietary_pattern: string | null;
    allergies_json: string;
    dislikes_json: string;
    daily_cost_cap_cents: number;
  }>();
  if (!row) return { ok: false, status: 404, reason: 'user not found' };
  return {
    ok: true,
    profile: {
      user_id: row.user_id,
      display_name: row.display_name,
      timezone: row.timezone,
      age_years: row.age_years,
      dietary_pattern: row.dietary_pattern,
      allergies: safeArr(row.allergies_json),
      dislikes: safeArr(row.dislikes_json),
      daily_cost_cap_cents: row.daily_cost_cap_cents
    }
  };
}

export interface MeUpdateInput {
  display_name?: string;
  timezone?: string;
  age_years?: number | null;
  dietary_pattern?: DietaryPattern | null;
  allergies?: string[];
  dislikes?: string[];
  daily_cost_cap_cents?: number;
}

export interface MeUpdateRequest {
  db: D1Database;
  userId: string;
  input: MeUpdateInput;
}

export interface MeUpdateResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export async function handleMeUpdate(req: MeUpdateRequest): Promise<MeUpdateResult> {
  const fields: string[] = [];
  const binds: unknown[] = [];

  if (req.input.display_name !== undefined) {
    const v = req.input.display_name.trim();
    if (!v) return { ok: false, status: 400, reason: 'display_name cannot be empty' };
    fields.push('display_name = ?'); binds.push(v);
  }

  if (req.input.timezone !== undefined) {
    const v = req.input.timezone.trim();
    if (!v) return { ok: false, status: 400, reason: 'timezone cannot be empty' };
    try {
      // Validate the timezone by attempting to format.
      new Intl.DateTimeFormat('en-CA', { timeZone: v }).format(new Date());
    } catch {
      return { ok: false, status: 400, reason: 'invalid timezone' };
    }
    fields.push('timezone = ?'); binds.push(v);
  }

  if (req.input.age_years !== undefined) {
    const v = req.input.age_years;
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 150)) {
      return { ok: false, status: 400, reason: 'age_years out of range' };
    }
    fields.push('age_years = ?'); binds.push(v);
  }

  if (req.input.dietary_pattern !== undefined) {
    const v = req.input.dietary_pattern;
    if (v !== null && !ALLOWED_PATTERNS.includes(v as DietaryPattern)) {
      return { ok: false, status: 400, reason: 'invalid dietary_pattern' };
    }
    fields.push('dietary_pattern = ?'); binds.push(v);
  }

  if (req.input.allergies !== undefined) {
    if (!Array.isArray(req.input.allergies) || !req.input.allergies.every((s) => typeof s === 'string')) {
      return { ok: false, status: 400, reason: 'allergies must be string[]' };
    }
    fields.push('allergies_json = ?'); binds.push(JSON.stringify(req.input.allergies.map((s) => s.trim().toLowerCase())));
  }

  if (req.input.dislikes !== undefined) {
    if (!Array.isArray(req.input.dislikes) || !req.input.dislikes.every((s) => typeof s === 'string')) {
      return { ok: false, status: 400, reason: 'dislikes must be string[]' };
    }
    fields.push('dislikes_json = ?'); binds.push(JSON.stringify(req.input.dislikes.map((s) => s.trim().toLowerCase())));
  }

  if (req.input.daily_cost_cap_cents !== undefined) {
    const v = req.input.daily_cost_cap_cents;
    if (!Number.isInteger(v) || v < 0 || v > 100_000) {
      return { ok: false, status: 400, reason: 'daily_cost_cap_cents out of range' };
    }
    fields.push('daily_cost_cap_cents = ?'); binds.push(v);
  }

  if (fields.length === 0) {
    return { ok: false, status: 400, reason: 'no editable fields provided' };
  }

  binds.push(req.userId);
  await req.db.prepare(
    `UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`
  ).bind(...binds).run();
  return { ok: true };
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    return [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Pass + commit**

```
pnpm test tests/unit/api/me.test.ts -- --run    # 8 PASS
git add src/api/me.ts tests/unit/api/me.test.ts
git commit -m "Add handleMeGet + handleMeUpdate"
```

### Task 1 (continued): Routes + integration test

- [ ] **Step 5: Add routes to `src/api/worker.ts`**

```ts
import { handleMeGet, handleMeUpdate } from './me';
```

```ts
if (req.method === 'GET' && url.pathname === '/v1/me') {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const r = await handleMeGet({ db: env.DB, userId: auth });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json(r.profile);
}

if (req.method === 'PATCH' && url.pathname === '/v1/me') {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const body = await req.json<any>();
  const r = await handleMeUpdate({ db: env.DB, userId: auth, input: body });
  if (!r.ok) return Response.json({ error: r.reason ?? 'failed' }, { status: r.status ?? 500 });
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Integration test `tests/integration/me.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { mintTestJwt } from '../fakes/jwt-helper';
import { resetDb } from '../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.prepare(`INSERT INTO users (user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json, daily_cost_cap_cents, created_at)
                        VALUES ('u1','Alex','UTC',32,'omnivore','[]','[]',150,1)`).run();
});

describe('GET /v1/me', () => {
  it('returns the profile', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as { display_name: string };
    expect(data.display_name).toBe('Alex');
  });

  it('rejects without auth', async () => {
    const resp = await SELF.fetch('https://api/v1/me');
    expect(resp.status).toBe(401);
  });
});

describe('PATCH /v1/me', () => {
  it('updates the profile', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/me', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'A.', age_years: 33 })
    });
    expect(resp.status).toBe(200);
    const get = await SELF.fetch('https://api/v1/me', { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await get.json() as { display_name: string; age_years: number };
    expect(data.display_name).toBe('A.');
    expect(data.age_years).toBe(33);
  });

  it('returns 400 for invalid input', async () => {
    const token = await mintTestJwt('u1');
    const resp = await SELF.fetch('https://api/v1/me', {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_cost_cap_cents: -5 })
    });
    expect(resp.status).toBe(400);
  });
});
```

- [ ] **Step 7: Commit**

```
pnpm test -- --run     # ~165 (157 + 8 unit + 4 integration ≈ 169)
pnpm typecheck
git add src/api/worker.ts tests/integration/me.test.ts
git commit -m "Wire GET /v1/me and PATCH /v1/me routes"
```

---

## Phase 2: Flutter

### Task 2: API client + ProfileController + ProfileScreen + Settings tile

**Files:**
- Modify: `mobile/lib/api/api_client.dart`
- Create: `mobile/lib/state/profile_controller.dart`
- Create: `mobile/lib/screens/profile_screen.dart`
- Modify: `mobile/lib/screens/settings_screen.dart`

- [ ] **Step 1: Add `getMe` and `updateMe` to `mobile/lib/api/api_client.dart`**

```dart
Future<Map<String, dynamic>> getMe() async {
  final uri = Uri.parse('$baseUrl/v1/me');
  final r = await _http.getUrl(uri);
  r.headers.set('Authorization', 'Bearer $jwt');
  final resp = await r.close();
  final body = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('getMe ${resp.statusCode}: $body');
  }
  return jsonDecode(body) as Map<String, dynamic>;
}

Future<void> updateMe(Map<String, dynamic> patch) async {
  final uri = Uri.parse('$baseUrl/v1/me');
  final r = await _http.patchUrl(uri);
  r.headers.set('Authorization', 'Bearer $jwt');
  r.headers.set('Content-Type', 'application/json');
  r.add(utf8.encode(jsonEncode(patch)));
  final resp = await r.close();
  final body = await resp.transform(utf8.decoder).join();
  if (resp.statusCode != 200) {
    throw HttpException('updateMe ${resp.statusCode}: $body');
  }
}
```

- [ ] **Step 2: Write `mobile/lib/state/profile_controller.dart`**

```dart
import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class ProfileController extends ChangeNotifier {
  final SettingsController settings;
  Map<String, dynamic>? profile;
  String? error;
  bool loading = false;
  bool saving = false;

  ProfileController(this.settings);

  Future<void> load() async {
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
      profile = await client.getMe();
    } catch (e) {
      error = e.toString();
    } finally {
      client.close();
      loading = false;
      notifyListeners();
    }
  }

  Future<bool> save(Map<String, dynamic> patch) async {
    saving = true;
    error = null;
    notifyListeners();
    final client = ApiClient(baseUrl: settings.baseUrl, jwt: settings.jwt);
    try {
      await client.updateMe(patch);
      profile = await client.getMe();
      return true;
    } catch (e) {
      error = e.toString();
      return false;
    } finally {
      client.close();
      saving = false;
      notifyListeners();
    }
  }
}
```

- [ ] **Step 3: Write `mobile/lib/screens/profile_screen.dart`**

```dart
import 'package:flutter/material.dart';
import '../state/profile_controller.dart';
import '../state/settings_controller.dart';

const _patterns = ['omnivore', 'vegetarian', 'vegan', 'pescatarian', 'keto'];

class ProfileScreen extends StatefulWidget {
  final SettingsController settings;
  const ProfileScreen({super.key, required this.settings});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late ProfileController _controller;
  final _displayName = TextEditingController();
  final _timezone = TextEditingController();
  final _age = TextEditingController();
  final _allergies = TextEditingController();
  final _dislikes = TextEditingController();
  final _capCents = TextEditingController();
  String? _pattern;

  @override
  void initState() {
    super.initState();
    _controller = ProfileController(widget.settings);
    _controller.addListener(_onChange);
    _controller.load().then((_) => _populateFromProfile());
  }

  void _populateFromProfile() {
    final p = _controller.profile;
    if (p == null) return;
    _displayName.text = p['display_name'] as String? ?? '';
    _timezone.text = p['timezone'] as String? ?? '';
    _age.text = (p['age_years'] as int?)?.toString() ?? '';
    _allergies.text = ((p['allergies'] as List?)?.join(', ')) ?? '';
    _dislikes.text = ((p['dislikes'] as List?)?.join(', ')) ?? '';
    _capCents.text = (p['daily_cost_cap_cents'] as int?)?.toString() ?? '';
    _pattern = p['dietary_pattern'] as String?;
    setState(() {});
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    _controller.removeListener(_onChange);
    _controller.dispose();
    _displayName.dispose();
    _timezone.dispose();
    _age.dispose();
    _allergies.dispose();
    _dislikes.dispose();
    _capCents.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final patch = <String, dynamic>{};
    final p = _controller.profile;
    if (_displayName.text.trim() != (p?['display_name'] ?? '')) patch['display_name'] = _displayName.text.trim();
    if (_timezone.text.trim() != (p?['timezone'] ?? '')) patch['timezone'] = _timezone.text.trim();
    final ageNum = int.tryParse(_age.text.trim());
    if (ageNum != p?['age_years']) patch['age_years'] = ageNum;
    if (_pattern != p?['dietary_pattern']) patch['dietary_pattern'] = _pattern;
    final allergies = _allergies.text.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
    if (!_listEquals(allergies, (p?['allergies'] as List?)?.cast<String>() ?? [])) patch['allergies'] = allergies;
    final dislikes = _dislikes.text.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
    if (!_listEquals(dislikes, (p?['dislikes'] as List?)?.cast<String>() ?? [])) patch['dislikes'] = dislikes;
    final capNum = int.tryParse(_capCents.text.trim());
    if (capNum != null && capNum != p?['daily_cost_cap_cents']) patch['daily_cost_cap_cents'] = capNum;

    if (patch.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No changes')));
      return;
    }
    final ok = await _controller.save(patch);
    if (ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved')));
    }
  }

  bool _listEquals(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: _controller.loading && _controller.profile == null
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(controller: _displayName, decoration: const InputDecoration(labelText: 'Display name')),
                  const SizedBox(height: 12),
                  TextField(controller: _timezone, decoration: const InputDecoration(labelText: 'Timezone (IANA)', hintText: 'America/Edmonton')),
                  const SizedBox(height: 12),
                  TextField(controller: _age, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Age (years)')),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String?>(
                    initialValue: _pattern,
                    decoration: const InputDecoration(labelText: 'Dietary pattern'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('— none —')),
                      ..._patterns.map((p) => DropdownMenuItem<String?>(value: p, child: Text(p))),
                    ],
                    onChanged: (v) => setState(() => _pattern = v),
                  ),
                  const SizedBox(height: 12),
                  TextField(controller: _allergies, decoration: const InputDecoration(labelText: 'Allergies (comma-separated)')),
                  const SizedBox(height: 12),
                  TextField(controller: _dislikes, decoration: const InputDecoration(labelText: 'Dislikes (comma-separated)')),
                  const SizedBox(height: 12),
                  TextField(controller: _capCents, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Daily AI cost cap (cents)')),
                  const SizedBox(height: 24),
                  if (_controller.error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.errorContainer,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(_controller.error!, style: TextStyle(color: Theme.of(context).colorScheme.onErrorContainer)),
                    ),
                    const SizedBox(height: 12),
                  ],
                  FilledButton(
                    onPressed: _controller.saving ? null : _save,
                    child: Text(_controller.saving ? 'Saving…' : 'Save'),
                  ),
                ],
              ),
            ),
    );
  }
}
```

- [ ] **Step 4: Add an "Edit profile" tile to `mobile/lib/screens/settings_screen.dart`**

Read the current file. After the existing fields and Save button, add:

```dart
const SizedBox(height: 32),
const Divider(),
const SizedBox(height: 16),
ListTile(
  leading: const Icon(Icons.person_outline),
  title: const Text('Edit profile'),
  subtitle: const Text('Display name, timezone, dietary preferences'),
  trailing: const Icon(Icons.chevron_right),
  onTap: () => Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) => ProfileScreen(settings: widget.controller),
    ),
  ),
),
```

Add the import at the top:
```dart
import 'profile_screen.dart';
```

- [ ] **Step 5: Run analyze + commit**

```
cd mobile && flutter analyze
git add mobile/lib/api/api_client.dart mobile/lib/state/profile_controller.dart mobile/lib/screens/profile_screen.dart mobile/lib/screens/settings_screen.dart
git commit -m "Add ProfileScreen + Edit profile entry in Settings"
```

---

## Phase 3: Final readiness

### Task 3: Verify + runbook

- [ ] **Step 1: Verify**

```
cd /Users/kostiailn/Projects/cohort
pnpm test -- --run     # ~169
pnpm typecheck

cd mobile
flutter test
flutter analyze
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 17: profile edit

58. **Open Profile:** Settings → Edit profile.
    Form populates with the current profile (display name, timezone, age, dietary pattern, allergies, dislikes, daily cost cap).

59. **Edit + save:**
    Change display name, tap Save. Server PATCHes the row, the form re-loads with the new value, snackbar says "Saved". Allergies / dislikes are comma-separated text fields → stored as JSON arrays.

60. **Validation:**
    - Empty display name → 400 + error banner.
    - Invalid timezone → 400.
    - Dietary pattern not in {omnivore, vegetarian, vegan, pescatarian, keto} → 400.
    - daily_cost_cap_cents < 0 or > 100000 → 400.

61. **Cross-feature integration:**
    - Changing timezone affects calendar-day cost cap window (Plan 4) and the History view (Plan 15).
    - Changing dietary pattern is read by the agent's chat tools (e.g., when generating tomorrow's plan).

## Plan 17 known limitations

- **No optimistic UI** — saves are blocking with a Save button.
- **No allergies / dislikes autocomplete.**
- **No partial-failure handling on multi-field saves** (server is single-statement so it's atomic, but if validation rejects, the whole patch is rejected).
- **No data-export / delete account** flows.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 17 profile edit smoke checks"
```

---

## Self-review notes

- **Spec coverage:** GET + PATCH /v1/me ✓, profile screen with form ✓, validation ✓, Settings tile ✓.
- **Scope:** 3 tasks. ~8 unit + 4 integration server tests. No new Flutter widget tests (the new screen is mostly form-state — could add a populate-from-profile test in a future pass).
