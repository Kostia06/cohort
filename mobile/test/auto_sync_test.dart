import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/api/auth_storage.dart';
import 'package:cohort_mobile/health/auto_sync_service.dart';
import 'package:cohort_mobile/health/health_kit_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('returns notConfigured when JWT is unset', () async {
    final svc = AutoSyncService(
      auth: AuthStorage(),
      hk: HealthKitService(),
    );
    final r = await svc.maybeSync();
    expect(r.status, AutoSyncStatus.notConfigured);
  });

  test('returns skipped when last sync is recent', () async {
    SharedPreferences.setMockInitialValues({
      'jwt': 'token',
      'baseUrl': 'http://localhost:8787',
      'lastSyncAtMs': DateTime.now().millisecondsSinceEpoch - 60 * 60 * 1000, // 1h ago
    });
    final svc = AutoSyncService(
      auth: AuthStorage(),
      hk: HealthKitService(),
    );
    final r = await svc.maybeSync();
    expect(r.status, AutoSyncStatus.skipped);
  });
}
