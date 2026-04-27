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
            Text("Today's plan", style: Theme.of(context).textTheme.titleMedium),
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
                    if (kcal != null) Text('$kcal kcal', style: Theme.of(context).textTheme.bodySmall),
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
            Text(text.length > 280 ? '${text.substring(0, 280)}…' : text),
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
