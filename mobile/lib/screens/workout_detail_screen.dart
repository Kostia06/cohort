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
  Map<String, dynamic>? _workout;
  List<Map<String, dynamic>> _sets = [];
  bool _busy = false;
  String? _error;

  final _exercise = TextEditingController();
  final _reps = TextEditingController();
  final _weight = TextEditingController();
  final _rpe = TextEditingController();

  @override
  void initState() {
    super.initState();
    _workout = Map<String, dynamic>.from(widget.workout);
    _refresh();
  }

  @override
  void dispose() {
    _exercise.dispose();
    _reps.dispose();
    _weight.dispose();
    _rpe.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final id = (_workout?['workout_id'] as String?) ?? '';
    if (id.isEmpty) return;
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      final data = await client.fetchWorkout(id);
      setState(() {
        _workout = data['workout'] as Map<String, dynamic>;
        _sets = ((data['sets'] as List?) ?? const []).cast<Map<String, dynamic>>();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      client.close();
    }
  }

  Future<void> _setStatus(String status) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.updateWorkoutStatus(workoutId: widget.workout['workout_id'] as String, status: status);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      client.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addSet() async {
    final ex = _exercise.text.trim();
    if (ex.isEmpty) {
      setState(() => _error = 'Exercise is required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
    try {
      await client.addWorkoutSet(
        workoutId: widget.workout['workout_id'] as String,
        exercise: ex,
        reps: int.tryParse(_reps.text),
        weightKg: double.tryParse(_weight.text),
        rpe: int.tryParse(_rpe.text),
      );
      _reps.clear();
      _weight.clear();
      _rpe.clear();
      await _refresh();
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      client.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = _workout ?? widget.workout;
    final kind = (w['kind'] as String?) ?? '';
    final duration = w['duration_min'];
    final rpePlanned = w['rpe'];
    final status = (w['status'] as String?) ?? 'planned';

    return Scaffold(
      appBar: AppBar(title: const Text('Workout')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(children: [
            const Icon(Icons.fitness_center),
            const SizedBox(width: 8),
            Text(kind, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(width: 12),
            _statusChip(status),
          ]),
          const SizedBox(height: 8),
          if (duration != null) Text('Planned: $duration min'),
          if (rpePlanned != null) Text('Planned RPE: $rpePlanned'),
          const SizedBox(height: 24),
          Text('Sets', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_sets.isEmpty)
            const Text('No sets logged yet.')
          else
            ..._sets.map(_setRow),
          const Divider(height: 32),
          Text('Add set', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          TextField(controller: _exercise, decoration: const InputDecoration(labelText: 'Exercise')),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: TextField(controller: _reps, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Reps'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _weight, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Weight (kg)'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _rpe, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'RPE'))),
          ]),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            icon: const Icon(Icons.add),
            label: Text(_busy ? 'Saving…' : 'Add set'),
            onPressed: _busy ? null : _addSet,
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
          Row(children: [
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
                child: const Text('Mark complete'),
              ),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _setRow(Map<String, dynamic> s) {
    final exercise = (s['exercise'] as String?) ?? '';
    final reps = s['reps'];
    final weight = s['weight_kg'];
    final rpe = s['rpe'];
    final ord = (s['ordinal'] as int?) ?? 0;
    final parts = <String>[];
    if (reps != null) parts.add('$reps reps');
    if (weight != null) parts.add('$weight kg');
    if (rpe != null) parts.add('RPE $rpe');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(width: 28, child: Text('#${ord + 1}', style: Theme.of(context).textTheme.labelSmall)),
          Expanded(child: Text(exercise, style: Theme.of(context).textTheme.bodyMedium)),
          if (parts.isNotEmpty) Text(parts.join(' · '), style: Theme.of(context).textTheme.bodySmall),
        ],
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
      child: Text(status.toUpperCase(), style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 12)),
    );
  }
}
