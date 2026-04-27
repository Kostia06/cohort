import type { ToolCtx, ToolDef } from '../types';

interface Input { query: string; domain?: 'diet' | 'training' | 'sleep' | 'general'; k?: number; evidenceGrade?: 'A' | 'B' | 'C' | 'D' }

interface Output {
  matches: Array<{
    paper: { id: string; title: string; year: number | null; domain: string | null; evidence_grade: string | null };
    chunk: { section: string; text: string; score: number };
    tldr?: string;
  }>;
}

export const searchResearchTool: ToolDef<Input, Output> = {
  name: 'search_research',
  description: 'Search the research RAG index for relevant findings, with hedging preserved. Returns top-K excerpts with the paper title, year, evidence grade, and a TL;DR.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 3 },
      domain: { type: 'string', enum: ['diet', 'training', 'sleep', 'general'] },
      k: { type: 'integer', minimum: 1, maximum: 10 },
      evidenceGrade: { type: 'string', enum: ['A', 'B', 'C', 'D'] }
    },
    required: ['query'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const research = (ctx.deps as any).bindings?.research as Fetcher | undefined;
    if (!research) return { matches: [] };
    const resp = await research.fetch('https://research/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    if (!resp.ok) return { matches: [] };
    const data = await resp.json() as { matches: Array<{ paper: any; chunk: any; summaries: { tldr?: string } }> };
    return {
      matches: data.matches.map((m) => ({
        paper: m.paper,
        chunk: { section: m.chunk.section, text: m.chunk.text, score: m.chunk.score },
        tldr: m.summaries?.tldr
      }))
    };
  }
};
