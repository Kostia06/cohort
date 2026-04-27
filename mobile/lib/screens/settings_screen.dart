import 'package:flutter/material.dart';
import '../state/settings_controller.dart';

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
                await widget.controller.setBaseUrl(_urlController.text.trim());
                await widget.controller.setJwt(_jwtController.text.trim());
                if (!mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Saved')),
                );
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }
}
