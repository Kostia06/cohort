import { describe, expect, it } from 'vitest';
import { postReview } from '../../../src/runtime/safety';
import type { AIGatewayClient, NonStreamMessageRequest, NonStreamMessageResult } from '../../../src/types';

function fakeAi(result: NonStreamMessageResult): AIGatewayClient {
  return {
    async *streamMessage() { throw new Error('not used'); },
    async call(_req: NonStreamMessageRequest) { return result; }
  };
}

describe('postReview', () => {
  it('returns ok when Haiku says ok', async () => {
    const ai = fakeAi({ text: '{"ok": true}', tokensIn: 50, tokensOut: 5 });
    const r = await postReview('A balanced breakfast: oatmeal, eggs, fruit.', ai);
    expect(r.ok).toBe(true);
    expect(r.corrigendum).toBeUndefined();
  });

  it('returns corrigendum when Haiku flags issues', async () => {
    const ai = fakeAi({
      text: '{"ok": false, "corrigendum": "Note: this is general guidance, not medical advice."}',
      tokensIn: 50, tokensOut: 20
    });
    const r = await postReview('Take 200mg of caffeine before training.', ai);
    expect(r.ok).toBe(false);
    expect(r.corrigendum).toContain('not medical advice');
  });

  it('returns ok when Haiku response is malformed (fail open)', async () => {
    const ai = fakeAi({ text: 'not json at all', tokensIn: 50, tokensOut: 5 });
    const r = await postReview('benign answer', ai);
    expect(r.ok).toBe(true);
  });
});
