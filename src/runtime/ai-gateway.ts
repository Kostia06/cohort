import type { AIGatewayClient, AnthropicStreamEvent, StreamMessageRequest } from '../types';

export interface AIGatewayConfig {
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const MODEL = 'claude-opus-4-7';

export function createAIGatewayClient(cfg: AIGatewayConfig): AIGatewayClient {
  const fetchImpl = cfg.fetch ?? fetch;

  return {
    async *streamMessage(req: StreamMessageRequest): AsyncIterable<AnthropicStreamEvent> {
      const body = {
        model: MODEL,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        max_tokens: req.maxTokens,
        stream: true
      };
      const resp = await fetchImpl(`${cfg.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal: req.signal
      });
      if (!resp.ok || !resp.body) {
        const errText = resp.body ? await resp.text() : '';
        throw new Error(`AI Gateway ${resp.status}: ${errText}`);
      }
      yield* parseAnthropicSse(resp.body);
    }
  };
}

async function* parseAnthropicSse(body: ReadableStream<Uint8Array>): AsyncIterable<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      const parsed = JSON.parse(json);
      yield normalizeEvent(parsed);
    }
  }
}

function normalizeEvent(raw: any): AnthropicStreamEvent {
  if (raw.type === 'message_start') {
    return { type: 'message_start', usage: { input_tokens: raw.message?.usage?.input_tokens ?? 0 } };
  }
  if (raw.type === 'content_block_start') {
    return { type: 'content_block_start', index: raw.index, block: raw.content_block };
  }
  if (raw.type === 'content_block_delta') {
    return { type: 'content_block_delta', index: raw.index, delta: raw.delta };
  }
  if (raw.type === 'content_block_stop') {
    return { type: 'content_block_stop', index: raw.index };
  }
  if (raw.type === 'message_delta') {
    return {
      type: 'message_delta',
      stop_reason: raw.delta?.stop_reason ?? 'end_turn',
      usage: { output_tokens: raw.usage?.output_tokens ?? 0 }
    };
  }
  if (raw.type === 'message_stop') {
    return { type: 'message_stop' };
  }
  throw new Error(`unknown anthropic event: ${raw.type}`);
}
