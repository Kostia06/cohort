# Real HealthKit Reader — Plan 10

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Plan 9 manual-numbers sync screen with a real HealthKit read. Foreground only — user opens the app and taps "Sync from Health"; the app reads HRV / RHR / sleep from the last night and posts to `/v1/healthkit/sync`. Background delivery is deferred.

**Architecture:** Use the `health` package from pub.dev (well-maintained, abstracts iOS HealthKit + Android Health Connect via platform channels). New `HealthKitService` in `mobile/lib/health/` requests permissions, reads "last night" samples, and exposes them to the existing `SyncScreen`. The screen now auto-fills numbers from HealthKit and lets the user override before syncing.

**Tech Stack:**
- `health: ^11.0.0` Flutter package.
- iOS entitlements: `HealthKit` capability.
- iOS Info.plist: `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`.

**Out of scope (deferred):**
- Background delivery (HealthKit → server without app being open).
- Android Health Connect (iOS only for v1).
- Reading historical backfill (only last night).
- Multi-source dedup (HealthKit may return multiple sources for the same metric — we use the most recent).

---

## File Structure

```
mobile/
  pubspec.yaml                            # MODIFY: add health
  ios/Runner/
    Info.plist                            # MODIFY: add usage descriptions
    Runner.entitlements                   # MODIFY (or CREATE): add HealthKit
  lib/
    health/
      health_kit_service.dart             # NEW
    screens/
      sync_screen.dart                    # MODIFY: integrate HealthKitService
  test/
    sync_screen_test.dart                 # NEW: widget test that the auto-fill button shows up
```

---

## Phase 1: Package + iOS configuration

### Task 1: Add `health` dependency + iOS Info.plist + entitlements

**Files:**
- Modify: `mobile/pubspec.yaml`
- Modify: `mobile/ios/Runner/Info.plist`
- Modify (or create): `mobile/ios/Runner/Runner.entitlements`

- [ ] **Step 1: Add the `health` package**

```
cd mobile
flutter pub add health
```

This pulls `health: ^11.x` into pubspec.yaml.

- [ ] **Step 2: Add Info.plist usage descriptions**

Read `mobile/ios/Runner/Info.plist`. Inside the top-level `<dict>`, before the closing `</dict>`, add:

```xml
<key>NSHealthShareUsageDescription</key>
<string>Cohort reads your HRV, resting heart rate, and sleep to compute your daily readiness score. Data is sent to your private Cohort backend.</string>
<key>NSHealthUpdateUsageDescription</key>
<string>Cohort does not write to Health.</string>
```

(The Update description is required even though we don't write — Apple still asks for it.)

- [ ] **Step 3: Add the HealthKit entitlement**

Check whether `mobile/ios/Runner/Runner.entitlements` exists. If not, create it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.healthkit</key>
    <true/>
    <key>com.apple.developer.healthkit.access</key>
    <array/>
</dict>
</plist>
```

If it already exists, ensure those two keys are present.

Then update `mobile/ios/Runner.xcodeproj/project.pbxproj` to reference the entitlements file. The simplest path: open the file in your editor, find the `PBXNativeTarget` for Runner, and ensure `CODE_SIGN_ENTITLEMENTS = Runner/Runner.entitlements;` is set in both Debug and Release `XCBuildConfiguration` blocks. (If you prefer, this can also be done via `xcodeproj` Ruby gem, but a sed-style edit is fine for v1.)

If editing pbxproj manually is fragile, an alternative: do this step via Xcode UI on first run by clicking "Capabilities → HealthKit" in the Runner target. Document if you can't safely automate.

- [ ] **Step 4: Verify Flutter still builds**

```
cd mobile
flutter pub get
flutter analyze
flutter build ios --no-codesign --release
```
The build should still succeed (the new keys are valid plist; entitlements only matter on a real device with a paired Apple Developer profile).

If `flutter build` fails on entitlements config, document the failure and continue — the rest of the plan still adds the Dart code.

- [ ] **Step 5: Commit**

```
cd /Users/kostiailn/Projects/cohort
git add mobile/pubspec.yaml mobile/pubspec.lock mobile/ios/Runner/Info.plist mobile/ios/Runner/Runner.entitlements mobile/ios/Runner.xcodeproj/project.pbxproj
git commit -m "Add health package + iOS HealthKit entitlements + Info.plist"
```

---

## Phase 2: Service

### Task 2: HealthKitService

**Files:**
- Create: `mobile/lib/health/health_kit_service.dart`

Reads HRV (SDNN), resting HR, and sleep from the previous night.

For "last night" we use: from yesterday-noon to today-noon. Sleep samples in this window are aggregated; HRV/RHR samples in the same window use the most recent value.

- [ ] **Step 1: Write `mobile/lib/health/health_kit_service.dart`**

```dart
import 'package:health/health.dart';

class HealthKitReading {
  final double? hrvSdnnMs;
  final double? rhrBpm;
  final int? sleepMinutes;
  final int? timeInBedMinutes;
  HealthKitReading({
    this.hrvSdnnMs,
    this.rhrBpm,
    this.sleepMinutes,
    this.timeInBedMinutes,
  });
}

class HealthKitService {
  final Health _health = Health();

  static const _types = <HealthDataType>[
    HealthDataType.HEART_RATE_VARIABILITY_SDNN,
    HealthDataType.RESTING_HEART_RATE,
    HealthDataType.SLEEP_ASLEEP,
    HealthDataType.SLEEP_IN_BED,
  ];

  /// Requests read-only permission for the data types we care about.
  /// Returns true if all types granted (or the system reports `null` —
  /// Apple intentionally hides denied authorisations from apps).
  Future<bool> requestPermissions() async {
    await _health.configure();
    final permissions = List<HealthDataAccess>.filled(_types.length, HealthDataAccess.READ);
    return await _health.requestAuthorization(_types, permissions: permissions) ?? false;
  }

  /// Reads samples for "last night" (yesterday noon → today noon local).
  Future<HealthKitReading> readLastNight({DateTime? now}) async {
    final n = now ?? DateTime.now();
    final today = DateTime(n.year, n.month, n.day, 12);
    final yesterdayNoon = today.subtract(const Duration(hours: 24));

    final samples = await _health.getHealthDataFromTypes(
      types: _types,
      startTime: yesterdayNoon,
      endTime: today,
    );

    double? hrv;
    double? rhr;
    int sleepMin = 0;
    int bedMin = 0;

    // Most recent HRV / RHR sample within the window.
    for (final s in samples.where((x) => x.type == HealthDataType.HEART_RATE_VARIABILITY_SDNN)) {
      final v = _numericValue(s);
      if (v != null) hrv = v;
    }
    for (final s in samples.where((x) => x.type == HealthDataType.RESTING_HEART_RATE)) {
      final v = _numericValue(s);
      if (v != null) rhr = v;
    }

    for (final s in samples.where((x) => x.type == HealthDataType.SLEEP_ASLEEP)) {
      sleepMin += s.dateTo.difference(s.dateFrom).inMinutes;
    }
    for (final s in samples.where((x) => x.type == HealthDataType.SLEEP_IN_BED)) {
      bedMin += s.dateTo.difference(s.dateFrom).inMinutes;
    }

    return HealthKitReading(
      hrvSdnnMs: hrv,
      rhrBpm: rhr,
      sleepMinutes: sleepMin > 0 ? sleepMin : null,
      timeInBedMinutes: bedMin > 0 ? bedMin : null,
    );
  }

  double? _numericValue(HealthDataPoint p) {
    final v = p.value;
    if (v is NumericHealthValue) return v.numericValue.toDouble();
    return null;
  }
}
```

- [ ] **Step 2: Run analyze**

```
cd mobile && flutter analyze
```

- [ ] **Step 3: Commit**

```
git add mobile/lib/health/health_kit_service.dart
git commit -m "Add HealthKitService for last-night sample reads"
```

---

## Phase 3: SyncScreen integration

### Task 3: Refactor SyncScreen to use HealthKitService

**Files:**
- Modify: `mobile/lib/screens/sync_screen.dart`

Add a "Read from Health" button that calls `HealthKitService.requestPermissions()` then `readLastNight()` and populates the text fields.

- [ ] **Step 1: Update `mobile/lib/screens/sync_screen.dart`**

Replace the file:

```dart
import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../health/health_kit_service.dart';
import '../state/settings_controller.dart';

class SyncScreen extends StatefulWidget {
  final SettingsController settings;
  const SyncScreen({super.key, required this.settings});

  @override
  State<SyncScreen> createState() => _SyncScreenState();
}

class _SyncScreenState extends State<SyncScreen> {
  final _hrv = TextEditingController();
  final _rhr = TextEditingController();
  final _sleep = TextEditingController();
  final _bed = TextEditingController();
  final HealthKitService _hk = HealthKitService();
  String? _result;
  bool _busy = false;
  bool _readingHk = false;

  @override
  void dispose() {
    _hrv.dispose();
    _rhr.dispose();
    _sleep.dispose();
    _bed.dispose();
    super.dispose();
  }

  Future<void> _readFromHealth() async {
    setState(() {
      _readingHk = true;
      _result = null;
    });
    try {
      final granted = await _hk.requestPermissions();
      if (!granted) {
        setState(() => _result = 'HealthKit permission not granted');
        return;
      }
      final r = await _hk.readLastNight();
      _hrv.text = r.hrvSdnnMs?.toStringAsFixed(1) ?? '';
      _rhr.text = r.rhrBpm?.toStringAsFixed(0) ?? '';
      _sleep.text = r.sleepMinutes?.toString() ?? '';
      _bed.text = r.timeInBedMinutes?.toString() ?? '';
      setState(() => _result = 'Loaded ${[
        if (r.hrvSdnnMs != null) 'HRV',
        if (r.rhrBpm != null) 'RHR',
        if (r.sleepMinutes != null) 'sleep',
        if (r.timeInBedMinutes != null) 'in-bed'
      ].join(', ')}');
    } catch (e) {
      setState(() => _result = 'health read error: $e');
    } finally {
      setState(() => _readingHk = false);
    }
  }

  Future<void> _sync() async {
    setState(() {
      _busy = true;
      _result = null;
    });
    final today = DateTime.now().toIso8601String().substring(0, 10);
    final client = ApiClient(
      baseUrl: widget.settings.baseUrl,
      jwt: widget.settings.jwt,
    );
    try {
      final res = await client.syncHealthKit(HealthKitSample(
        date: today,
        hrvSdnnMs: double.tryParse(_hrv.text),
        rhrBpm: double.tryParse(_rhr.text),
        sleepMinutes: int.tryParse(_sleep.text),
        timeInBedMinutes: int.tryParse(_bed.text),
      ));
      setState(() => _result = res.toString());
    } catch (e) {
      setState(() => _result = 'sync error: $e');
    } finally {
      client.close();
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('HealthKit Sync')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton.tonal(
              onPressed: _readingHk ? null : _readFromHealth,
              child: Text(_readingHk ? 'Reading…' : 'Read last night from Health'),
            ),
            const SizedBox(height: 24),
            TextField(controller: _hrv, decoration: const InputDecoration(labelText: 'HRV SDNN (ms)'), keyboardType: TextInputType.number),
            const SizedBox(height: 12),
            TextField(controller: _rhr, decoration: const InputDecoration(labelText: 'Resting HR (bpm)'), keyboardType: TextInputType.number),
            const SizedBox(height: 12),
            TextField(controller: _sleep, decoration: const InputDecoration(labelText: 'Sleep (min)'), keyboardType: TextInputType.number),
            const SizedBox(height: 12),
            TextField(controller: _bed, decoration: const InputDecoration(labelText: 'Time in bed (min)'), keyboardType: TextInputType.number),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _busy ? null : _sync,
              child: Text(_busy ? 'Syncing…' : 'Sync today'),
            ),
            if (_result != null) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: SelectableText(_result!, style: Theme.of(context).textTheme.bodySmall),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
```

- [ ] **Step 2: Run analyze**

```
cd mobile && flutter analyze
```

- [ ] **Step 3: Commit**

```
git add mobile/lib/screens/sync_screen.dart
git commit -m "Auto-fill SyncScreen from HealthKit"
```

---

## Phase 4: Tests

### Task 4: Widget test for SyncScreen

**Files:**
- Create: `mobile/test/sync_screen_test.dart`

We can't easily mock the platform channel for the `health` package, so the widget test only verifies the UI scaffolds and the button is reachable. End-to-end verification happens on a real device.

- [ ] **Step 1: Write `mobile/test/sync_screen_test.dart`**

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/api/auth_storage.dart';
import 'package:cohort_mobile/screens/sync_screen.dart';
import 'package:cohort_mobile/state/settings_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('SyncScreen renders with the Read from Health button', (tester) async {
    final settings = SettingsController(AuthStorage());
    await settings.load();
    await tester.pumpWidget(MaterialApp(
      home: SyncScreen(settings: settings),
    ));

    expect(find.text('Read last night from Health'), findsOneWidget);
    expect(find.text('Sync today'), findsOneWidget);
    expect(find.text('HRV SDNN (ms)'), findsOneWidget);
  });
}
```

- [ ] **Step 2: Run all flutter tests**

```
cd mobile && flutter test
```
Expected: 5 passing (3 SSE + 1 widget boot + 1 sync screen).

- [ ] **Step 3: Commit**

```
git add mobile/test/sync_screen_test.dart
git commit -m "Add widget test for sync screen"
```

---

## Phase 5: Final readiness

### Task 5: Final + runbook

- [ ] **Step 1: Verify**

```
cd mobile
flutter test
flutter analyze
flutter build ios --no-codesign --release
```

- [ ] **Step 2: Append to root runbook**

```markdown

---

## After Plan 10: real HealthKit reader

**Setup (iOS device only — simulator does not surface real Health data):**
1. Open `mobile/ios/Runner.xcworkspace` in Xcode.
2. Select the Runner target → Signing & Capabilities → ensure HealthKit capability is enabled (if it's missing, click "+ Capability" and add it).
3. Pair a physical iPhone, sign in with your Apple ID, set a development team on the Runner target, and run.

33. **Permission flow (first run):**
    - Open the Sync screen, tap "Read last night from Health".
    - iOS shows the Health permission prompt; allow access to HRV / Resting HR / Sleep.
    - The form auto-fills with last night's values.

34. **Sync to server:**
    - With values filled, tap "Sync today".
    - Server returns the readiness payload (calibrating until 14 days of history; otherwise score + band).

35. **Manual override:**
    - You can still edit any field after the auto-fill before syncing.

## Plan 10 known limitations

- **Foreground only** — user must open the app to trigger a sync. Background delivery (HealthKit observer queries that wake the app) is its own future plan.
- **iOS only** — Android Health Connect is supported by the `health` package but not configured here.
- **Last night only** — no historical backfill API. Bulk import would loop the per-day endpoint.
- **No source preference** — if Apple Watch and a third-party app both write HRV, we use whichever the most recent sample comes from.
```

- [ ] **Step 3: Commit**

```
cd /Users/kostiailn/Projects/cohort
git add docs/superpowers/runbooks/
git commit -m "Add Plan 10 HealthKit reader smoke checks"
```

---

## Self-review notes

- **Spec coverage:** real HealthKit read for HRV / RHR / sleep ✓; permission flow ✓; auto-fill UI ✓; manual override preserved ✓.
- **Placeholder scan:** none.
- **Type consistency:** new `HealthKitReading` shape is local to the service module; existing `HealthKitSample` API client type unchanged.
- **Scope:** 5 tasks. 1 new flutter test. Server tests unchanged at 122.
