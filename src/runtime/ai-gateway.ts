import type { AIGatewayClient, AnthropicStreamEvent, NonStreamMessageRequest, NonStreamMessageResult, StreamMessageRequest } from '../types';

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
    },

    async call(req: NonStreamMessageRequest): Promise<NonStreamMessageResult> {
      const body = {
        model: req.model,
        system: req.system,
        messages: req.messages,
        max_tokens: req.maxTokens,
        stream: false
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
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`AI Gateway ${resp.status}: ${errText}`);
      }
      const data = await resp.json() as {
        content: Array<{ type: 'text'; text: string } | { type: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      const text = data.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0
      };
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
      const normalized = normalizeEvent(parsed);
      if (normalized) yield normalized;
    }
  }
  // Flush any residual frame that didn't end with \n\n.
  if (buffer.trim()) {
    const dataLine = buffer.split('\n').find((l) => l.startsWith('data:'));
    if (dataLine) {
      const json = dataLine.slice(5).trim();
      if (json) {
        const normalized = normalizeEvent(JSON.parse(json));
        if (normalized) yield normalized;
      }
    }
  }
}

function normalizeEvent(raw: any): AnthropicStreamEvent | null {
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
  // Unknown events (ping, error, etc.) are silently dropped — log for observability.
  console.debug(`[ai-gateway] dropping unknown anthropic event: ${raw?.type}`);
  return null;
}
