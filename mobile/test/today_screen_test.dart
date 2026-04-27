import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/screens/today_screen.dart';
import 'package:cohort_mobile/api/auth_storage.dart';
import 'package:cohort_mobile/state/settings_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('TodayScreen renders the configure-first error when no JWT is set', (tester) async {
    final settings = SettingsController(AuthStorage());
    await settings.load();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: TodayScreen(settings: settings)),
    ));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('Configure JWT'), findsOneWidget);
  });
}
