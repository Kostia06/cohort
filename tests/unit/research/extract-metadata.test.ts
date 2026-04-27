import { describe, expect, it } from 'vitest';
import { extractMetadata, generateSummary } from '../../../services/research/src/extract-metadata';
import type { AIGatewayClient } from '../../../src/types';

function fakeAi(textResponses: string[]): AIGatewayClient {
  let idx = 0;
  return {
    async *streamMessage() { throw new Error('not used'); },
    async call(_req) {
      const text = textResponses[idx++];
      if (text === undefined) throw new Error('no more responses');
      return { text, tokensIn: 100, tokensOut: 50 };
    }
  };
}

describe('extractMetadata', () => {
  it('parses the JSON response into structured metadata', async () => {
    const json = JSON.stringify({
      title: 'Creatine timing trial',
      authors: ['Smith J'],
      year: 2024,
      journal: 'JISSN',
      doi: '10.1/abc',
      domain: 'training',
      study_type: 'RCT',
      evidence_grade: 'B',
      population: { n: 30, age_range: '18-30', sex: 'mixed' },
      key_findings: [{ claim: 'Pre vs post timing was not different.' }],
      limitations: ['short duration']
    });
    const ai = fakeAi([json]);
    const m = await extractMetadata('paper text', undefined, ai);
    expect(m.title).toBe('Creatine timing trial');
    expect(m.evidence_grade).toBe('B');
    expect(m.key_findings[0]?.claim).toContain('Pre vs post');
  });

  it('strips markdown fences', async () => {
    const json = '```json\n' + JSON.stringify({ title: 'T', authors: [], year: 2020, journal: '', doi: '', domain: 'general', study_type: 'narrative_review', evidence_grade: 'D', population: {}, key_findings: [], limitations: [] }) + '\n```';
    const ai = fakeAi([json]);
    const m = await extractMetadata('paper text', 'general', ai);
    expect(m.title).toBe('T');
  });
});

describe('generateSummary', () => {
  it('returns the model text body for the requested level', async () => {
    const ai = fakeAi(['A short summary.']);
    const summary = await generateSummary({ title: 'T' } as any, 'tldr', ai);
    expect(summary).toBe('A short summary.');
  });
});
