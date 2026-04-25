import type { SseEvent, SseWriter } from '../../src/types';

export function createSseCollector(): SseWriter & { events: SseEvent[]; closed: boolean } {
  const events: SseEvent[] = [];
  let closed = false;
  return {
    emit(event: SseEvent) { events.push(event); },
    close() { closed = true; },
    get events() { return events; },
    get closed() { return closed; }
  };
}
