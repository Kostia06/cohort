import 'dart:async';
import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class ChatMessage {
  final String role; // 'user' | 'assistant' | 'system'
  String text;
  final List<String> toolEvents;
  ChatMessage({required this.role, required this.text, List<String>? toolEvents})
      : toolEvents = toolEvents ?? [];
}

class ChatController extends ChangeNotifier {
  final SettingsController settings;
  final String threadId;
  final List<ChatMessage> messages = [];
  StreamSubscription<SseEvent>? _sub;
  bool _streaming = false;
  String? _error;

  ChatController({required this.settings, required this.threadId});

  bool get streaming => _streaming;
  String? get error => _error;

  Future<void> send(String text) async {
    if (_streaming || text.trim().isEmpty) return;
    _error = null;
    messages.add(ChatMessage(role: 'user', text: text));
    final assistant = ChatMessage(role: 'assistant', text: '');
    messages.add(assistant);
    _streaming = true;
    notifyListeners();

    final client = ApiClient(baseUrl: settings.baseUrl, jwt: settings.jwt);
    final stream = client.streamChat(threadId: threadId, message: text);
    _sub = stream.listen(
      (ev) {
        if (ev.type == 'text_delta') {
          assistant.text += (ev.data['chunk'] as String?) ?? '';
        } else if (ev.type == 'tool_call_start') {
          assistant.toolEvents.add('🔧 ${ev.data['tool']}');
        } else if (ev.type == 'tool_call_result') {
          assistant.toolEvents.add('✓ ${ev.data['summary'] ?? ''}');
        } else if (ev.type == 'corrigendum') {
          assistant.text += '\n\n${ev.data['text']}';
        } else if (ev.type == 'error') {
          _error = (ev.data['message'] as String?) ?? 'unknown error';
        }
        notifyListeners();
      },
      onError: (err) {
        _error = err.toString();
        _streaming = false;
        notifyListeners();
      },
      onDone: () {
        _streaming = false;
        client.close();
        notifyListeners();
      },
      cancelOnError: true,
    );
  }

  Future<void> cancel() async {
    if (!_streaming) return;
    final client = ApiClient(baseUrl: settings.baseUrl, jwt: settings.jwt);
    await client.cancel(threadId);
    client.close();
    await _sub?.cancel();
    _streaming = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
