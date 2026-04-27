import 'package:flutter_test/flutter_test.dart';
import 'package:cohort_mobile/api/api_client.dart';

void main() {
  test('parseSse parses a simple frame', () async {
    final source = Stream<String>.fromIterable([
      'event: turn_started\n',
      'data: {"turn_id":"t1","ordinal":0}\n\n',
      'event: text_delta\n',
      'data: {"chunk":"hello"}\n\n',
    ]);
    final events = await parseSse(source).toList();
    expect(events.length, 2);
    expect(events[0].type, 'turn_started');
    expect(events[0].data['turn_id'], 't1');
    expect(events[1].type, 'text_delta');
    expect(events[1].data['chunk'], 'hello');
  });

  test('parseSse handles a frame without trailing \\n\\n', () async {
    final source = Stream<String>.fromIterable([
      'event: turn_complete\n',
      'data: {"turn_id":"t1","full_text":"hi","cost_usd":0}',
    ]);
    final events = await parseSse(source).toList();
    expect(events.length, 1);
    expect(events[0].type, 'turn_complete');
  });

  test('parseSse skips frames with no data: line', () async {
    final source = Stream<String>.fromIterable([
      ': comment\n\n',
      'event: text_delta\ndata: {"chunk":"x"}\n\n',
    ]);
    final events = await parseSse(source).toList();
    expect(events.length, 1);
    expect(events[0].data['chunk'], 'x');
  });
}
