import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../state/settings_controller.dart';

class ProfileController extends ChangeNotifier {
  final SettingsController settings;
  Map<String, dynamic>? profile;
  String? error;
  bool loading = false;
  bool saving = false;

  ProfileController(this.settings);

  Future<void> load() async {
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
      profile = await client.getMe();
    } catch (e) {
      error = e.toString();
    } finally {
      client.close();
      loading = false;
      notifyListeners();
    }
  }

  Future<bool> save(Map<String, dynamic> patch) async {
    saving = true;
    error = null;
    notifyListeners();
    final client = ApiClient(baseUrl: settings.baseUrl, jwt: settings.jwt);
    try {
      await client.updateMe(patch);
      profile = await client.getMe();
      return true;
    } catch (e) {
      error = e.toString();
      return false;
    } finally {
      client.close();
      saving = false;
      notifyListeners();
    }
  }
}
