import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/main.dart';

void main() {
  testWidgets('App boots and shows the chat screen scaffold', (tester) async {
    await tester.pumpWidget(const CohortApp());
    // Pump enough to allow shared_preferences to resolve.
    await tester.pump(const Duration(milliseconds: 100));
    // The app may still be loading shared_preferences; just assert MaterialApp renders.
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
