import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class HistoryController extends ChangeNotifier {
  final SettingsController settings;
  Map<String, dynamic>? data;
  String? error;
  bool loading = false;

  HistoryController(this.settings);

  Future<void> refresh({int days = 7}) async {
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
      data = await client.fetchRecentStats(days: days);
    } catch (e) {
      error = e.toString();
    } finally {
      client.close();
      loading = false;
      notifyListeners();
    }
  }
}
