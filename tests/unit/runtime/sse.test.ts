import { describe, expect, it } from 'vitest';
import { createSseStreamWriter } from '../../../src/runtime/sse';

describe('createSseStreamWriter', () => {
  it('emits events as SSE-framed chunks', async () => {
    const { writer, response } = createSseStreamWriter();
    writer.emit({ type: 'turn_started', data: { turn_id: 't1', ordinal: 0 } });
    writer.emit({ type: 'text_delta', data: { chunk: 'hi' } });
    writer.close();

    const text = await response.text();
    expect(text).toContain('event: turn_started');
    expect(text).toContain('data: {"turn_id":"t1","ordinal":0}');
    expect(text).toContain('event: text_delta');
    expect(text).toContain('data: {"chunk":"hi"}');
    expect(text.endsWith('\n\n')).toBe(true);
  });
});
