import 'package:flutter/material.dart';
import 'api/auth_storage.dart';
import 'health/auto_sync_service.dart';
import 'health/health_kit_service.dart';
import 'screens/home_shell.dart';
import 'state/auto_sync_controller.dart';
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
  late final AuthStorage _storage;
  late final SettingsController _settings;
  late final AutoSyncController _autoSync;

  @override
  void initState() {
    super.initState();
    _storage = AuthStorage();
    _settings = SettingsController(_storage);
    _autoSync = AutoSyncController(AutoSyncService(
      auth: _storage,
      hk: HealthKitService(),
    ));
    _settings.addListener(_onChange);
    _autoSync.addListener(_onChange);
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _settings.load();
    if (_settings.isConfigured) {
      // Don't await — let the home shell render.
      _autoSync.run();
    }
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    _settings.removeListener(_onChange);
    _autoSync.removeListener(_onChange);
    _settings.dispose();
    _autoSync.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_settings.loaded) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return HomeShell(settings: _settings, autoSync: _autoSync);
  }
}
