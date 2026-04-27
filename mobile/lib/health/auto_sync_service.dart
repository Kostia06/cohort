import '../api/api_client.dart';
import '../api/auth_storage.dart';
import 'health_kit_service.dart';

const Duration _staleAfter = Duration(hours: 6);

enum AutoSyncStatus {
  skipped,       // configured but not stale; nothing to do
  noPermission,  // HealthKit permission not granted
  notConfigured, // no JWT/baseUrl set
  noData,        // permission granted but no last-night samples to send
  synced,        // success
  error,         // network/server failure
}

class AutoSyncResult {
  final AutoSyncStatus status;
  final String? message;
  AutoSyncResult(this.status, [this.message]);
}

class AutoSyncService {
  final AuthStorage _auth;
  final HealthKitService _hk;
  final ApiClient Function(String baseUrl, String jwt) _clientFactory;
  final DateTime Function() _now;

  AutoSyncService({
    required AuthStorage auth,
    required HealthKitService hk,
    ApiClient Function(String, String)? clientFactory,
    DateTime Function()? now,
  })  : _auth = auth,
        _hk = hk,
        _clientFactory = clientFactory ?? ((url, jwt) => ApiClient(baseUrl: url, jwt: jwt)),
        _now = now ?? DateTime.now;

  /// Runs an opportunistic sync if conditions are met. Returns the resulting status.
  Future<AutoSyncResult> maybeSync() async {
    final jwt = await _auth.readJwt();
    if (jwt == null || jwt.isEmpty) {
      return AutoSyncResult(AutoSyncStatus.notConfigured);
    }

    final lastMs = await _auth.readLastSyncAt();
    final now = _now();
    if (lastMs != null) {
      final last = DateTime.fromMillisecondsSinceEpoch(lastMs);
      if (now.difference(last) < _staleAfter) {
        return AutoSyncResult(AutoSyncStatus.skipped);
      }
    }

    final granted = await _hk.requestPermissions();
    if (!granted) return AutoSyncResult(AutoSyncStatus.noPermission);

    final reading = await _hk.readLastNight(now: now);
    final isEmpty = reading.hrvSdnnMs == null
        && reading.rhrBpm == null
        && reading.sleepMinutes == null
        && reading.timeInBedMinutes == null;
    if (isEmpty) return AutoSyncResult(AutoSyncStatus.noData);

    final baseUrl = await _auth.readBaseUrl();
    final client = _clientFactory(baseUrl, jwt);
    try {
      final today = now.toIso8601String().substring(0, 10);
      await client.syncHealthKit(HealthKitSample(
        date: today,
        hrvSdnnMs: reading.hrvSdnnMs,
        rhrBpm: reading.rhrBpm,
        sleepMinutes: reading.sleepMinutes,
        timeInBedMinutes: reading.timeInBedMinutes,
      ));
      await _auth.writeLastSyncAt(now.millisecondsSinceEpoch);
      return AutoSyncResult(AutoSyncStatus.synced);
    } catch (e) {
      return AutoSyncResult(AutoSyncStatus.error, e.toString());
    } finally {
      client.close();
    }
  }
}
