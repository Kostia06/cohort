import { describe, expect, it } from 'vitest';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';

describe('AI Gateway retry on 5xx', () => {
  it('retries call() once on 503, succeeds on second attempt', async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response('upstream blip', { status: 503 });
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const client = createAIGatewayClient({
      url: 'https://example/anthropic',
      apiKey: 'k',
      fetch: fakeFetch,
      retryBackoffMs: 0
    });
    const r = await client.call({
      model: 'claude-haiku-4-5-20251001',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      signal: new AbortController().signal
    });
    expect(r.text).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('throws after second 5xx', async () => {
    const fakeFetch = (async () => new Response('still down', { status: 502 })) as typeof fetch;
    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch, retryBackoffMs: 0 });
    await expect(
      client.call({
        model: 'claude-haiku-4-5-20251001',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/502/);
  });

  it('does not retry on 4xx (e.g. 400 bad request)', async () => {
    let attempts = 0;
    const fakeFetch = (async () => { attempts++; return new Response('bad', { status: 400 }); }) as typeof fetch;
    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch, retryBackoffMs: 0 });
    await expect(
      client.call({
        model: 'claude-haiku-4-5-20251001',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });
});
