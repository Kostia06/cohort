import 'package:shared_preferences/shared_preferences.dart';
import '../config/app_config.dart';

class AuthStorage {
  static const _kJwt = 'jwt';
  static const _kBaseUrl = 'baseUrl';

  Future<String?> readJwt() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kJwt);
  }

  Future<void> writeJwt(String jwt) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kJwt, jwt);
  }

  Future<void> clearJwt() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kJwt);
  }

  Future<String> readBaseUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kBaseUrl) ?? AppConfig.defaultBaseUrl;
  }

  Future<void> writeBaseUrl(String baseUrl) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kBaseUrl, baseUrl);
  }
}
