import 'package:flutter/material.dart';
import '../state/chat_controller.dart';
import '../state/settings_controller.dart';
import '../widgets/message_bubble.dart';
import 'settings_screen.dart';
import 'sync_screen.dart';

class ChatScreen extends StatefulWidget {
  final SettingsController settings;
  const ChatScreen({super.key, required this.settings});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late ChatController _chat;
  final _input = TextEditingController();
  final _scrollCtrl = ScrollController();

  @override
  void initState() {
    super.initState();
    _chat = ChatController(settings: widget.settings, threadId: 'main');
    _chat.addListener(_onChatChange);
  }

  void _onChatChange() {
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.jumpTo(_scrollCtrl.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    _chat.removeListener(_onChatChange);
    _chat.dispose();
    _input.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cohort'),
        actions: [
          IconButton(
            icon: const Icon(Icons.health_and_safety_outlined),
            tooltip: 'Sync',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SyncScreen(settings: widget.settings),
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: 'Settings',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(controller: widget.settings),
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (_chat.error != null)
              Container(
                width: double.infinity,
                color: Theme.of(context).colorScheme.errorContainer,
                padding: const EdgeInsets.all(8),
                child: Text(_chat.error!),
              ),
            Expanded(
              child: ListView.builder(
                controller: _scrollCtrl,
                itemCount: _chat.messages.length,
                itemBuilder: (_, i) => MessageBubble(message: _chat.messages[i]),
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      decoration: InputDecoration(
                        hintText: widget.settings.isConfigured
                            ? 'Ask Cohort something…'
                            : 'Configure JWT in Settings first',
                        border: const OutlineInputBorder(),
                      ),
                      enabled: widget.settings.isConfigured && !_chat.streaming,
                      onSubmitted: _send,
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (_chat.streaming)
                    IconButton(
                      icon: const Icon(Icons.stop),
                      onPressed: _chat.cancel,
                    )
                  else
                    IconButton(
                      icon: const Icon(Icons.send),
                      onPressed: widget.settings.isConfigured
                          ? () => _send(_input.text)
                          : null,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _send(String text) {
    if (text.trim().isEmpty) return;
    _chat.send(text);
    _input.clear();
  }
}
