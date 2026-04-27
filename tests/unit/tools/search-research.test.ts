import { describe, expect, it } from 'vitest';
import { searchResearchTool } from '../../../src/tools/search-research';

describe('searchResearchTool', () => {
  it('forwards to the RESEARCH binding and shapes the response', async () => {
    const fakeResearch: Fetcher = {
      async fetch() {
        return new Response(JSON.stringify({
          matches: [
            { paper: { id: 'p1', title: 'Test', year: 2024, domain: 'training', evidence_grade: 'B' },
              chunk: { id: 'p1:0', section: 'results', text: 'finding', score: 0.9 },
              summaries: { tldr: 'short' } }
          ]
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    } as any;
    const ctx: any = { deps: { bindings: { research: fakeResearch } } };
    const r = await searchResearchTool.handler({ query: 'creatine' }, ctx);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]!.paper.title).toBe('Test');
    expect(r.matches[0]!.tldr).toBe('short');
  });

  it('returns empty matches when no RESEARCH binding is available', async () => {
    const ctx: any = { deps: {} };
    const r = await searchResearchTool.handler({ query: 'creatine' }, ctx);
    expect(r.matches).toEqual([]);
  });
});
