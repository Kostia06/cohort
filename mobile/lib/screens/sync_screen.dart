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
  final _hrv = TextEditingController(text: '50');
  final _rhr = TextEditingController(text: '60');
  final _sleep = TextEditingController(text: '480');
  final _bed = TextEditingController(text: '510');
  String? _result;
  bool _busy = false;
  bool _readingHk = false;
  final HealthKitService _hk = HealthKitService();

  @override
  void dispose() {
    _hrv.dispose();
    _rhr.dispose();
    _sleep.dispose();
    _bed.dispose();
    super.dispose();
  }

  Future<void> _readFromHealth() async {
    setState(() => _readingHk = true);
    try {
      final granted = await _hk.requestPermissions();
      if (!granted) return;
      final reading = await _hk.readLastNight();
      setState(() {
        if (reading.hrvSdnnMs != null) _hrv.text = reading.hrvSdnnMs!.toStringAsFixed(1);
        if (reading.rhrBpm != null) _rhr.text = reading.rhrBpm!.toStringAsFixed(0);
        if (reading.sleepMinutes != null) _sleep.text = reading.sleepMinutes!.toString();
        if (reading.timeInBedMinutes != null) _bed.text = reading.timeInBedMinutes!.toString();
      });
    } catch (e) {
      setState(() => _result = 'Health read error: $e');
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
      setState(() => _result = 'error: $e');
    } finally {
      client.close();
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton.tonal(
              onPressed: (_busy || _readingHk) ? null : _readFromHealth,
              child: Text(_readingHk ? 'Reading…' : 'Read last night from Health'),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _hrv,
              decoration: const InputDecoration(labelText: 'HRV SDNN (ms)'),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _rhr,
              decoration: const InputDecoration(labelText: 'Resting HR (bpm)'),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _sleep,
              decoration: const InputDecoration(labelText: 'Sleep (min)'),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _bed,
              decoration: const InputDecoration(labelText: 'Time in bed (min)'),
              keyboardType: TextInputType.number,
            ),
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
                child: SelectableText(
                  _result!,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ],
        ),
      );
  }
}
