import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { searchResearch } from '../../../services/research/src/search';
import { resetDb } from '../../fakes/seed';

beforeEach(async () => {
  await resetDb(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO research_papers (id, status, title, evidence_grade, domain, year, uploaded_by, added_at, updated_at)
                    VALUES ('p1','ready','Creatine timing','B','training',2024,'admin',1,2)`),
    env.DB.prepare(`INSERT INTO research_summaries (paper_id, level, body, reading_minutes, generated_at)
                    VALUES ('p1','tldr','One-line summary.',1,2)`),
    env.DB.prepare(`INSERT INTO research_chunks (id, paper_id, section, text, ordinal)
                    VALUES ('p1:0','p1','results','no significant difference',0)`)
  ]);
});

describe('searchResearch', () => {
  it('returns matched chunks with paper context', async () => {
    const deps = {
      db: env.DB,
      embed: async (_texts: string[]) => [Array(1024).fill(0.1)],
      vectorize: {
        query: async (_vec: number[], _opts: { topK: number; filter?: Record<string, unknown> }) => ({
          matches: [{ id: 'p1:0', score: 0.92, metadata: {} }]
        })
      }
    };
    const r = await searchResearch({ query: 'creatine timing', k: 1 }, deps);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]!.paper.title).toBe('Creatine timing');
    expect(r.matches[0]!.chunk.text).toContain('no significant');
    expect(r.matches[0]!.summaries.tldr).toContain('summary');
  });
});
