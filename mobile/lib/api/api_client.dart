import 'dart:async';
import 'dart:convert';
import 'dart:io';

class SseEvent {
  final String type;
  final Map<String, dynamic> data;
  SseEvent(this.type, this.data);
}

class HealthKitSample {
  final String date;
  final double? hrvSdnnMs;
  final double? rhrBpm;
  final int? sleepMinutes;
  final int? timeInBedMinutes;
  HealthKitSample({
    required this.date,
    this.hrvSdnnMs,
    this.rhrBpm,
    this.sleepMinutes,
    this.timeInBedMinutes,
  });

  Map<String, dynamic> toJson() => {
    'date': date,
    if (hrvSdnnMs != null) 'hrv_sdnn_ms': hrvSdnnMs,
    if (rhrBpm != null) 'rhr_bpm': rhrBpm,
    if (sleepMinutes != null) 'sleep_minutes': sleepMinutes,
    if (timeInBedMinutes != null) 'time_in_bed_minutes': timeInBedMinutes,
  };
}

class ApiClient {
  final String baseUrl;
  final String jwt;
  final HttpClient _http = HttpClient();

  ApiClient({required this.baseUrl, required this.jwt});

  /// Streams typed SSE events from POST /v1/chat/{thread_id}.
  Stream<SseEvent> streamChat({
    required String threadId,
    required String message,
    String? idempotencyKey,
  }) async* {
    final uri = Uri.parse('$baseUrl/v1/chat/$threadId');
    final req = await _http.postUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    req.headers.set('Content-Type', 'application/json');
    if (idempotencyKey != null) req.headers.set('Idempotency-Key', idempotencyKey);
    req.add(utf8.encode(jsonEncode({'message': message})));
    final resp = await req.close();
    if (resp.statusCode != 200) {
      final body = await resp.transform(utf8.decoder).join();
      throw HttpException('chat ${resp.statusCode}: $body');
    }
    yield* parseSse(resp.transform(utf8.decoder));
  }

  /// Cancels the in-flight turn for a thread.
  Future<bool> cancel(String threadId) async {
    final uri = Uri.parse('$baseUrl/v1/cancel/$threadId');
    final req = await _http.postUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode == 200) {
      final json = jsonDecode(body) as Map<String, dynamic>;
      return json['cancelled'] == true;
    }
    return false;
  }

  /// Sync a HealthKit sample (returns the readiness payload).
  Future<Map<String, dynamic>> syncHealthKit(HealthKitSample sample) async {
    final uri = Uri.parse('$baseUrl/v1/healthkit/sync');
    final req = await _http.postUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    req.headers.set('Content-Type', 'application/json');
    req.add(utf8.encode(jsonEncode(sample.toJson())));
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('sync ${resp.statusCode}: $body');
    }
    return jsonDecode(body) as Map<String, dynamic>;
  }

  void close() => _http.close(force: true);
}

/// Parses a Stream of SSE-formatted text into typed [SseEvent]s.
/// Visible for testing; pure function over its input.
Stream<SseEvent> parseSse(Stream<String> source) async* {
  String buffer = '';
  await for (final chunk in source) {
    buffer += chunk;
    int sep;
    while ((sep = buffer.indexOf('\n\n')) != -1) {
      final frame = buffer.substring(0, sep);
      buffer = buffer.substring(sep + 2);
      final ev = _parseFrame(frame);
      if (ev != null) yield ev;
    }
  }
  if (buffer.trim().isNotEmpty) {
    final ev = _parseFrame(buffer);
    if (ev != null) yield ev;
  }
}

SseEvent? _parseFrame(String frame) {
  String? eventName;
  String? dataLine;
  for (final line in frame.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.substring('event: '.length);
    } else if (line.startsWith('data: ')) {
      dataLine = (dataLine ?? '') + line.substring('data: '.length);
    }
  }
  if (eventName == null || dataLine == null) return null;
  try {
    final data = jsonDecode(dataLine) as Map<String, dynamic>;
    return SseEvent(eventName, data);
  } catch (_) {
    return null;
  }
}
