import 'package:flutter/material.dart';
import 'chat_screen.dart';
import 'settings_screen.dart';
import 'sync_screen.dart';
import 'today_screen.dart';
import '../state/settings_controller.dart';

class HomeShell extends StatefulWidget {
  final SettingsController settings;
  const HomeShell({super.key, required this.settings});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      TodayScreen(settings: widget.settings),
      ChatScreen(settings: widget.settings),
      SyncScreen(settings: widget.settings),
    ];
    final titles = ['Today', 'Chat', 'Sync'];

    return Scaffold(
      appBar: AppBar(
        title: Text(titles[_index]),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(controller: widget.settings),
              ),
            ),
          ),
        ],
      ),
      body: pages[_index],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.today_outlined), label: 'Today'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Chat'),
          NavigationDestination(icon: Icon(Icons.health_and_safety_outlined), label: 'Sync'),
        ],
      ),
    );
  }
}
