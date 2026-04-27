import 'package:flutter/foundation.dart';
import '../api/auth_storage.dart';

class SettingsController extends ChangeNotifier {
  final AuthStorage _storage;
  String _baseUrl = '';
  String _jwt = '';
  bool _loaded = false;

  SettingsController(this._storage);

  String get baseUrl => _baseUrl;
  String get jwt => _jwt;
  bool get loaded => _loaded;
  bool get isConfigured => _jwt.isNotEmpty && _baseUrl.isNotEmpty;

  Future<void> load() async {
    _baseUrl = await _storage.readBaseUrl();
    _jwt = await _storage.readJwt() ?? '';
    _loaded = true;
    notifyListeners();
  }

  Future<void> setBaseUrl(String value) async {
    _baseUrl = value;
    await _storage.writeBaseUrl(value);
    notifyListeners();
  }

  Future<void> setJwt(String value) async {
    _jwt = value;
    await _storage.writeJwt(value);
    notifyListeners();
  }

  Future<void> clearJwt() async {
    _jwt = '';
    await _storage.clearJwt();
    notifyListeners();
  }
}
