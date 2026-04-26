import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          durableObjects: { USER_AGENT_DO: 'UserAgentDO' },
          serviceBindings: {
            MOCK_GATEWAY: 'mock-gateway'
          },
          workers: [{
            name: 'mock-gateway',
            modules: true,
            script: `
const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  ''
].join('\\n');
export default {
  async fetch() {
    return new Response(SSE_BODY, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }
};`
          }],
          bindings: {
            ANTHROPIC_API_KEY: 'test-key',
            AI_GATEWAY_URL: 'https://mock-gateway/v1/anthropic'
          }
        }
      }
    }
  }
});
