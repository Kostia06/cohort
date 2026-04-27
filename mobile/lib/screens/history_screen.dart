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
    final reversed = days.reversed.toList();
    return reversed.map(_dayCard).toList();
  }

  Widget _dayCard(Map<String, dynamic> day) {
    final date = day['date'] as String;
    final readiness = day['readiness'] as Map<String, dynamic>?;
    final workouts = (day['workouts'] as Map<String, dynamic>?) ?? {};
    final meals = (day['meals'] as Map<String, dynamic>?) ?? {};
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
                if ((workouts['skipped'] ?? 0) != 0)
                  _stat(Icons.skip_next, 'skipped', workouts['skipped']),
                _stat(Icons.restaurant, '${meals['count'] ?? 0} meals · $kcal kcal', null),
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
        Text(
          value == null ? label : '$value $label',
          style: Theme.of(context).textTheme.bodySmall,
        ),
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
      child: Text(
        band.toUpperCase(),
        style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 11),
      ),
    );
  }
}
