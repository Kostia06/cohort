import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/api/auth_storage.dart';
import 'package:cohort_mobile/screens/sync_screen.dart';
import 'package:cohort_mobile/state/settings_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('SyncScreen renders with the Read from Health button', (tester) async {
    final settings = SettingsController(AuthStorage());
    await settings.load();
    await tester.pumpWidget(MaterialApp(
      home: SyncScreen(settings: settings),
    ));

    expect(find.text('Read last night from Health'), findsOneWidget);
    expect(find.text('Sync today'), findsOneWidget);
    expect(find.text('HRV SDNN (ms)'), findsOneWidget);
  });
}
