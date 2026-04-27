import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class TodayController extends ChangeNotifier {
  final SettingsController settings;
  Map<String, dynamic>? data;
  Map<String, dynamic>? streaks;
  String? error;
  bool loading = false;

  TodayController(this.settings);

  Future<void> refresh() async {
    if (!settings.isConfigured) {
      error = 'Configure JWT in Settings first';
      notifyListeners();
      return;
    }
    loading = true;
    error = null;
    notifyListeners();
    final client = ApiClient(baseUrl: settings.baseUrl, jwt: settings.jwt);
    try {
      final results = await Future.wait([client.fetchToday(), client.fetchStreaks()]);
      data = results[0];
      streaks = results[1];
    } catch (e) {
      error = e.toString();
    } finally {
      client.close();
      loading = false;
      notifyListeners();
    }
  }
}
