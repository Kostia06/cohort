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

  Future<bool> requestPermissions() async {
    await _health.configure();
    final permissions = List<HealthDataAccess>.filled(_types.length, HealthDataAccess.READ);
    return await _health.requestAuthorization(_types, permissions: permissions);
  }

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
