import 'package:flutter/foundation.dart';
import '../health/auto_sync_service.dart';

class AutoSyncController extends ChangeNotifier {
  final AutoSyncService service;
  AutoSyncResult? lastResult;
  bool running = false;

  AutoSyncController(this.service);

  Future<void> run() async {
    if (running) return;
    running = true;
    notifyListeners();
    try {
      lastResult = await service.maybeSync();
    } finally {
      running = false;
      notifyListeners();
    }
  }
}
