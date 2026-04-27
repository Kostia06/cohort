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

  Future<Map<String, dynamic>> fetchToday({String? date}) async {
    final dateParam = date == null ? '' : '?date=$date';
    final uri = Uri.parse('$baseUrl/v1/plans/today$dateParam');
    final req = await _http.getUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('plans/today ${resp.statusCode}: $body');
    }
    return jsonDecode(body) as Map<String, dynamic>;
  }

  Future<void> updateWorkoutStatus({
    required String workoutId,
    required String status, // 'planned' | 'logged' | 'skipped'
  }) async {
    final uri = Uri.parse('$baseUrl/v1/workouts/$workoutId');
    final req = await _http.patchUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    req.headers.set('Content-Type', 'application/json');
    req.add(utf8.encode(jsonEncode({'status': status})));
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('updateWorkout ${resp.statusCode}: $body');
    }
  }

  Future<Map<String, dynamic>> fetchWorkout(String workoutId) async {
    final uri = Uri.parse('$baseUrl/v1/workouts/$workoutId');
    final req = await _http.getUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('fetchWorkout ${resp.statusCode}: $body');
    }
    return jsonDecode(body) as Map<String, dynamic>;
  }

  Future<void> addWorkoutSet({
    required String workoutId,
    required String exercise,
    int? reps,
    double? weightKg,
    int? rpe,
    String? notes,
  }) async {
    final uri = Uri.parse('$baseUrl/v1/workouts/$workoutId/sets');
    final r = await _http.postUrl(uri);
    r.headers.set('Authorization', 'Bearer $jwt');
    r.headers.set('Content-Type', 'application/json');
    final body = <String, dynamic>{'exercise': exercise};
    if (reps != null) body['reps'] = reps;
    if (weightKg != null) body['weight_kg'] = weightKg;
    if (rpe != null) body['rpe'] = rpe;
    if (notes != null && notes.isNotEmpty) body['notes'] = notes;
    r.add(utf8.encode(jsonEncode(body)));
    final resp = await r.close();
    final respBody = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('addSet ${resp.statusCode}: $respBody');
    }
  }

  Future<Map<String, dynamic>> fetchRecentStats({int days = 7}) async {
    final uri = Uri.parse('$baseUrl/v1/stats/recent?days=$days');
    final req = await _http.getUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('stats/recent ${resp.statusCode}: $body');
    }
    return jsonDecode(body) as Map<String, dynamic>;
  }

  Future<String> logMeal({
    required String name,
    int? kcal,
    double? proteinG,
    double? carbsG,
    double? fatG,
    String? notes,
    int? eatenAt,
  }) async {
    final uri = Uri.parse('$baseUrl/v1/meals');
    final req = await _http.postUrl(uri);
    req.headers.set('Authorization', 'Bearer $jwt');
    req.headers.set('Content-Type', 'application/json');
    final payload = <String, dynamic>{'name': name};
    if (kcal != null) payload['kcal'] = kcal;
    if (proteinG != null) payload['protein_g'] = proteinG;
    if (carbsG != null) payload['carbs_g'] = carbsG;
    if (fatG != null) payload['fat_g'] = fatG;
    if (notes != null) payload['notes'] = notes;
    if (eatenAt != null) payload['eaten_at'] = eatenAt;
    req.add(utf8.encode(jsonEncode(payload)));
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    if (resp.statusCode != 200) {
      throw HttpException('logMeal ${resp.statusCode}: $body');
    }
    final json = jsonDecode(body) as Map<String, dynamic>;
    return json['meal_id'] as String;
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
