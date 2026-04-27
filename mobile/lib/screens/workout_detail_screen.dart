import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class WorkoutDetailScreen extends StatefulWidget {
  final SettingsController settings;
  final Map<String, dynamic> workout;
  const WorkoutDetailScreen({super.key, required this.settings, required this.workout});

  @override
  State<WorkoutDetailScreen> createState() => _WorkoutDetailScreenState();
}

class _WorkoutDetailScreenState extends State<WorkoutDetailScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _setStatus(String status) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.updateWorkoutStatus(
        workoutId: widget.workout['workout_id'] as String,
        status: status,
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
    final w = widget.workout;
    final kind = (w['kind'] as String?) ?? '';
    final duration = w['duration_min'];
    final rpe = w['rpe'];
    final notes = w['notes'] as String?;
    final status = (w['status'] as String?) ?? 'planned';

    return Scaffold(
      appBar: AppBar(title: const Text('Workout')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.fitness_center),
                const SizedBox(width: 8),
                Text(kind, style: Theme.of(context).textTheme.titleLarge),
              ],
            ),
            const SizedBox(height: 8),
            if (duration != null) Text('Duration: $duration min', style: Theme.of(context).textTheme.bodyLarge),
            if (rpe != null) Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('RPE: $rpe', style: Theme.of(context).textTheme.bodyLarge),
            ),
            const SizedBox(height: 8),
            _statusChip(status),
            if (notes != null && notes.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('Notes', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 4),
              Text(notes),
            ],
            const Spacer(),
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
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy || status == 'skipped' ? null : () => _setStatus('skipped'),
                    child: const Text('Skip'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy || status == 'logged' ? null : () => _setStatus('logged'),
                    child: Text(_busy ? 'Saving…' : 'Mark complete'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusChip(String status) {
    final color = switch (status) {
      'logged' => Colors.green,
      'planned' => Colors.blue,
      'skipped' => Colors.grey,
      _ => Colors.grey,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        status.toUpperCase(),
        style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 12),
      ),
    );
  }
}
