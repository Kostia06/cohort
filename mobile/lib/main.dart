import 'package:flutter/material.dart';
import 'api/auth_storage.dart';
import 'screens/chat_screen.dart';
import 'state/settings_controller.dart';

void main() {
  runApp(const CohortApp());
}

class CohortApp extends StatelessWidget {
  const CohortApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Cohort',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.indigo,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const _Bootstrap(),
    );
  }
}

class _Bootstrap extends StatefulWidget {
  const _Bootstrap();

  @override
  State<_Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<_Bootstrap> {
  late final SettingsController _settings;

  @override
  void initState() {
    super.initState();
    _settings = SettingsController(AuthStorage());
    _settings.addListener(_onChange);
    _settings.load();
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    _settings.removeListener(_onChange);
    _settings.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_settings.loaded) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return ChatScreen(settings: _settings);
  }
}
