import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { ingestPaper } from '../../../services/research/src/ingest';
import type { AIGatewayClient } from '../../../src/types';
import { resetDb } from '../../fakes/seed';

const SAMPLE_TEXT = `Abstract
This study tests the effect of pre vs post creatine timing on muscle hypertrophy and strength outcomes in resistance-trained males. We hypothesized that timing would not meaningfully affect outcomes.

Introduction
Creatine monohydrate is one of the most well-researched ergogenic aids in sports nutrition. Despite extensive research on dosing protocols, the question of whether timing of ingestion relative to resistance training matters remains contested. This study aimed to address that gap with a rigorous controlled design.

Methods
Thirty male resistance-trained participants were randomly assigned to pre-workout or post-workout creatine supplementation (5g/day) for 8 weeks. All participants followed a standardized resistance training program three times per week. Muscle cross-sectional area was measured via ultrasound; strength via one-repetition maximum testing.

Results
No significant difference between pre and post supplementation groups was found for any primary or secondary outcome. Both groups improved from baseline, suggesting creatine itself is beneficial regardless of timing. Effect sizes were small to negligible for the between-group comparisons.

Discussion
The lack of effect may be due to the small sample size and the relatively short duration of the intervention. The saturated intramuscular creatine stores in both groups may have equalized any potential timing benefit. Future studies with larger samples and longer durations are warranted.

Limitations
Short duration of only 8 weeks. Small sample size of 30 participants. No dietary control beyond creatine supplementation.

References
1. Antonio J et al. (2013). The effects of pre versus post workout supplementation. J Int Soc Sports Nutr.
`;

const META_JSON = JSON.stringify({
  title: 'Creatine timing trial',
  authors: ['Smith J'],
  year: 2024,
  journal: 'JISSN',
  doi: '10.1/abc',
  domain: 'training',
  study_type: 'RCT',
  evidence_grade: 'B',
  population: { n: 30 },
  key_findings: [{ claim: 'No timing difference observed.' }],
  limitations: ['short duration']
});

function scriptedAi(responses: string[]): AIGatewayClient {
  let idx = 0;
  return {
    async *streamMessage() { throw new Error('not used'); },
    async call(_req) {
      return { text: responses[idx++] ?? 'fallback', tokensIn: 1, tokensOut: 1 };
    }
  };
}

beforeEach(async () => {
  await resetDb(env.DB);
});

describe('ingestPaper', () => {
  it('runs end-to-end and persists papers/summaries/chunks rows', async () => {
    const ai = scriptedAi([META_JSON, 'tldr', 'plain', 'detailed']);
    const upserts: any[] = [];
    const deps = {
      db: env.DB,
      ai,
      embed: async (texts: string[]) => texts.map(() => Array(1024).fill(0)),
      vectorize: { upsert: async (vs: any[]) => { upserts.push(vs); }, deleteByIds: async () => {} },
      clock: () => 1_700_000_000_000
    };

    const r = await ingestPaper({
      paperId: 'p1',
      preExtractedText: SAMPLE_TEXT,
      uploaderUserId: 'admin'
    }, deps);

    expect(r.status).toBe('ready');
    expect(r.chunkCount).toBeGreaterThan(0);
    const paper = await env.DB.prepare(`SELECT title, status, evidence_grade FROM research_papers WHERE id = 'p1'`).first();
    expect(paper).toEqual({ title: 'Creatine timing trial', status: 'ready', evidence_grade: 'B' });
    const summaryRows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM research_summaries WHERE paper_id = 'p1'`).first<{n: number}>();
    expect(summaryRows?.n).toBe(3);
    const chunkRows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM research_chunks WHERE paper_id = 'p1'`).first<{n: number}>();
    expect(chunkRows?.n).toBeGreaterThan(0);
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.length).toBe(chunkRows!.n);
  });

  it('returns needs_ocr when text is too short', async () => {
    const ai = scriptedAi([]);
    const deps = {
      db: env.DB,
      ai,
      embed: async () => [],
      vectorize: { upsert: async () => {} },
      clock: () => 1
    };
    const r = await ingestPaper({
      paperId: 'p2',
      preExtractedText: 'too short',
      uploaderUserId: 'admin'
    }, deps);
    expect(r.status).toBe('needs_ocr');
  });
});
