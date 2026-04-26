import type { SseEvent, SseWriter } from '../types';

export function createSseStreamWriter(): { writer: SseWriter; response: Response } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sse: SseWriter = {
    emit(event: SseEvent) {
      const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      writer.write(encoder.encode(frame)).catch((err) => {
        console.warn('[sse] write failed (client likely disconnected)', err);
      });
    },
    close() {
      writer.close().catch((err) => {
        console.warn('[sse] close failed', err);
      });
    }
  };

  const response = new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive'
    }
  });

  return { writer: sse, response };
}
