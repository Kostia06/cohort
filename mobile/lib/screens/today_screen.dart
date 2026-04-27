import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../api/auth_storage.dart';
import '../health/auto_sync_service.dart';
import '../state/auto_sync_controller.dart';
import '../state/settings_controller.dart';
import '../state/today_controller.dart';
import 'log_meal_screen.dart';
import 'workout_detail_screen.dart';

class TodayScreen extends StatefulWidget {
  final SettingsController settings;
  final AutoSyncController? autoSync;
  const TodayScreen({super.key, required this.settings, this.autoSync});

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  late TodayController _controller;
  int? _lastSyncAtMs;

  @override
  void initState() {
    super.initState();
    _controller = TodayController(widget.settings);
    _controller.addListener(_onChange);
    _controller.refresh();
    widget.autoSync?.addListener(_onAutoSyncChange);
    _loadLastSync();
  }

  void _onAutoSyncChange() {
    if (widget.autoSync?.lastResult?.status == AutoSyncStatus.synced) {
      _controller.refresh();
    }
    _loadLastSync();
  }

  Future<void> _loadLastSync() async {
    final ms = await AuthStorage().readLastSyncAt();
    if (mounted) setState(() => _lastSyncAtMs = ms);
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    widget.autoSync?.removeListener(_onAutoSyncChange);
    _controller.removeListener(_onChange);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        await widget.autoSync?.run();
        await _controller.refresh();
      },
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          ..._buildSections(context),
          const SizedBox(height: 16),
          _syncFooter(),
        ],
      ),
    );
  }

  Widget _syncFooter() {
    final running = widget.autoSync?.running ?? false;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.sync, size: 16, color: Theme.of(context).colorScheme.outline),
            const SizedBox(width: 6),
            Text(
              running ? 'Syncing…' : 'Last sync: ${_formatLastSync(_lastSyncAtMs)}',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.outline,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatLastSync(int? ms) {
    if (ms == null) return 'never';
    final last = DateTime.fromMillisecondsSinceEpoch(ms);
    final diff = DateTime.now().difference(last);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
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
                child: InkWell(
                  onTap: () async {
                    final result = await Navigator.of(context).push<bool>(
                      MaterialPageRoute(
                        builder: (_) => WorkoutDetailScreen(
                          settings: widget.settings,
                          workout: w as Map<String, dynamic>,
                        ),
                      ),
                    );
                    if (result == true) _controller.refresh();
                  },
                  child: Row(
                    children: [
                      const Icon(Icons.fitness_center, size: 18),
                      const SizedBox(width: 8),
                      Expanded(child: Text('$kind${duration != null ? ' · ${duration}m' : ''}${rpe != null ? ' · RPE $rpe' : ''}')),
                      const Icon(Icons.chevron_right, size: 18),
                    ],
                  ),
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
            Row(
              children: [
                Text('Recent meals (24h)', style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                TextButton.icon(
                  onPressed: () async {
                    final result = await Navigator.of(context).push<bool>(
                      MaterialPageRoute(
                        builder: (_) => LogMealScreen(settings: widget.settings),
                      ),
                    );
                    if (result == true) _controller.refresh();
                  },
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Log'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (meals.isEmpty) const Text('No meals logged in the last 24 hours.'),
            ...meals.map((m) {
              final mealId = (m['meal_id'] as String?) ?? '';
              final name = (m['name'] as String?) ?? '';
              final kcal = m['kcal'];
              final inner = Padding(
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
              return Dismissible(
                key: ValueKey('meal-$mealId'),
                direction: DismissDirection.endToStart,
                background: Container(
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  color: Theme.of(context).colorScheme.errorContainer,
                  child: Icon(Icons.delete, color: Theme.of(context).colorScheme.onErrorContainer),
                ),
                confirmDismiss: (_) async {
                  final client = ApiClient(baseUrl: widget.settings.baseUrl, jwt: widget.settings.jwt);
                  try {
                    await client.deleteMeal(mealId);
                    return true;
                  } catch (e) {
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text('Delete failed: $e')),
                      );
                    }
                    return false;
                  } finally {
                    client.close();
                  }
                },
                onDismissed: (_) => _controller.refresh(),
                child: inner,
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
