import { describe, expect, it } from 'vitest';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(s));
      controller.close();
    }
  });
}

describe('createAIGatewayClient', () => {
  it('parses Anthropic SSE events into typed events', async () => {
    const sseBody = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      ''
    ].join('\n');

    const fakeFetch = async () =>
      new Response(streamFromString(sseBody), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const client = createAIGatewayClient({
      url: 'https://example/anthropic',
      apiKey: 'k',
      fetch: fakeFetch as typeof fetch
    });

    const events: any[] = [];
    for await (const ev of client.streamMessage({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal
    })) {
      events.push(ev);
    }

    expect(events[0].type).toBe('message_start');
    expect(events.find((e) => e.type === 'content_block_delta').delta.text).toBe('hi');
    expect(events.find((e) => e.type === 'message_delta').stop_reason).toBe('end_turn');
  });

  it('parses the trailing frame even without a final \\n\\n', async () => {
    const sseBody = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}'  // note: no trailing \n\n
    ].join('\n');

    const fakeFetch = async () =>
      new Response(streamFromString(sseBody), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const client = createAIGatewayClient({
      url: 'https://example/anthropic',
      apiKey: 'k',
      fetch: fakeFetch as typeof fetch
    });

    const events: any[] = [];
    for await (const ev of client.streamMessage({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal
    })) {
      events.push(ev);
    }

    expect(events.length).toBe(2);
    expect(events.at(-1).type).toBe('message_stop');
  });
});
