import 'package:flutter/material.dart';
import '../state/settings_controller.dart';
import 'profile_screen.dart';

class SettingsScreen extends StatefulWidget {
  final SettingsController controller;
  const SettingsScreen({super.key, required this.controller});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late TextEditingController _jwtController;
  late TextEditingController _urlController;

  @override
  void initState() {
    super.initState();
    _jwtController = TextEditingController(text: widget.controller.jwt);
    _urlController = TextEditingController(text: widget.controller.baseUrl);
  }

  @override
  void dispose() {
    _jwtController.dispose();
    _urlController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _urlController,
              decoration: const InputDecoration(labelText: 'Base URL'),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _jwtController,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'JWT (Bearer token)',
                helperText: 'Generate with `pnpm mint-jwt <user_id>`.',
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () async {
                final messenger = ScaffoldMessenger.of(context);
                await widget.controller.setBaseUrl(_urlController.text.trim());
                await widget.controller.setJwt(_jwtController.text.trim());
                if (!mounted) return;
                messenger.showSnackBar(
                  const SnackBar(content: Text('Saved')),
                );
              },
              child: const Text('Save'),
            ),
            const SizedBox(height: 32),
            const Divider(),
            const SizedBox(height: 16),
            ListTile(
              leading: const Icon(Icons.person_outline),
              title: const Text('Edit profile'),
              subtitle: const Text('Display name, timezone, dietary preferences'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => ProfileScreen(settings: widget.controller),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
