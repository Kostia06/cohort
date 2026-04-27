import 'package:flutter/material.dart';
import '../state/profile_controller.dart';
import '../state/settings_controller.dart';

const _patterns = ['omnivore', 'vegetarian', 'vegan', 'pescatarian', 'keto'];

class ProfileScreen extends StatefulWidget {
  final SettingsController settings;
  const ProfileScreen({super.key, required this.settings});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late ProfileController _controller;
  final _displayName = TextEditingController();
  final _timezone = TextEditingController();
  final _age = TextEditingController();
  final _allergies = TextEditingController();
  final _dislikes = TextEditingController();
  final _capCents = TextEditingController();
  String? _pattern;

  @override
  void initState() {
    super.initState();
    _controller = ProfileController(widget.settings);
    _controller.addListener(_onControllerChange);
    _controller.load();
  }

  @override
  void dispose() {
    _controller.removeListener(_onControllerChange);
    _controller.dispose();
    _displayName.dispose();
    _timezone.dispose();
    _age.dispose();
    _allergies.dispose();
    _dislikes.dispose();
    _capCents.dispose();
    super.dispose();
  }

  void _onControllerChange() {
    final p = _controller.profile;
    if (p != null && !_controller.loading && !_controller.saving) {
      _populateFromProfile(p);
    }
    setState(() {});
  }

  void _populateFromProfile(Map<String, dynamic> p) {
    _displayName.text = (p['display_name'] as String?) ?? '';
    _timezone.text = (p['timezone'] as String?) ?? '';
    _age.text = p['age_years']?.toString() ?? '';
    final dp = p['dietary_pattern'] as String?;
    _pattern = (_patterns.contains(dp)) ? dp : null;
    final allergiesList = (p['allergies'] as List?)?.cast<String>() ?? [];
    _allergies.text = allergiesList.join(', ');
    final dislikesList = (p['dislikes'] as List?)?.cast<String>() ?? [];
    _dislikes.text = dislikesList.join(', ');
    _capCents.text = p['daily_cost_cap_cents']?.toString() ?? '';
  }

  List<String> _splitCsv(String text) {
    return text
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .where((s) => s.isNotEmpty)
        .toList();
  }

  Future<void> _save() async {
    final patch = <String, dynamic>{};
    patch['display_name'] = _displayName.text.trim();
    patch['timezone'] = _timezone.text.trim();
    final ageText = _age.text.trim();
    if (ageText.isNotEmpty) {
      patch['age_years'] = int.tryParse(ageText);
    }
    patch['dietary_pattern'] = _pattern;
    patch['allergies'] = _splitCsv(_allergies.text);
    patch['dislikes'] = _splitCsv(_dislikes.text);
    final capText = _capCents.text.trim();
    if (capText.isNotEmpty) {
      patch['daily_cost_cap_cents'] = int.tryParse(capText);
    }
    final ok = await _controller.save(patch);
    if (!mounted) return;
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Saved')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: _controller.loading && _controller.profile == null
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: _displayName,
                    decoration: const InputDecoration(labelText: 'Display name'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _timezone,
                    decoration: const InputDecoration(
                      labelText: 'Timezone (IANA)',
                      hintText: 'America/Edmonton',
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _age,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Age (years)'),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String?>(
                    initialValue: _pattern,
                    decoration: const InputDecoration(labelText: 'Dietary pattern'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('— none —')),
                      ..._patterns.map(
                        (p) => DropdownMenuItem<String?>(value: p, child: Text(p)),
                      ),
                    ],
                    onChanged: (v) => setState(() => _pattern = v),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _allergies,
                    decoration: const InputDecoration(
                      labelText: 'Allergies (comma-separated)',
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _dislikes,
                    decoration: const InputDecoration(
                      labelText: 'Dislikes (comma-separated)',
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _capCents,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Daily AI cost cap (cents)',
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (_controller.error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.errorContainer,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        _controller.error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onErrorContainer,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  FilledButton(
                    onPressed: _controller.saving ? null : _save,
                    child: Text(_controller.saving ? 'Saving…' : 'Save'),
                  ),
                ],
              ),
            ),
    );
  }
}
