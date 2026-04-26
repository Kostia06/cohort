import { describe, expect, it } from 'vitest';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';

describe('AIGatewayClient.call', () => {
  it('makes a non-streaming POST and returns text + tokens', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'safe' }],
      usage: { input_tokens: 5, output_tokens: 1 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const client = createAIGatewayClient({
      url: 'https://example/anthropic',
      apiKey: 'k',
      fetch: fakeFetch
    });

    const r = await client.call({
      model: 'claude-haiku-4-5-20251001',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      signal: new AbortController().signal
    });

    expect(r.text).toBe('safe');
    expect(r.tokensIn).toBe(5);
    expect(r.tokensOut).toBe(1);
  });

  it('throws on non-2xx with status + body', async () => {
    const fakeFetch = (async () => new Response('upstream error', { status: 503 })) as typeof fetch;
    const client = createAIGatewayClient({ url: 'https://example/anthropic', apiKey: 'k', fetch: fakeFetch });
    await expect(
      client.call({
        model: 'claude-haiku-4-5-20251001',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/503/);
  });
});
