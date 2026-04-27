export interface SearchInput {
  query: string;
  k?: number;
  domain?: 'diet' | 'training' | 'sleep' | 'general';
  evidenceGrade?: 'A' | 'B' | 'C' | 'D';
}

export interface SearchDeps {
  db: D1Database;
  embed: (texts: string[]) => Promise<number[][]>;
  vectorize: {
    query: (vec: number[], opts: { topK: number; filter?: Record<string, unknown> }) => Promise<{
      matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
    }>;
  };
}

export interface SearchMatch {
  paper: {
    id: string;
    title: string;
    year: number | null;
    domain: string | null;
    evidence_grade: string | null;
  };
  chunk: { id: string; section: string; text: string; score: number };
  summaries: { tldr?: string; plain?: string; detailed?: string };
}

export interface SearchResult {
  matches: SearchMatch[];
}

export async function searchResearch(input: SearchInput, deps: SearchDeps): Promise<SearchResult> {
  const k = Math.max(1, Math.min(10, input.k ?? 3));
  const [vec] = await deps.embed([input.query]);
  if (!vec) return { matches: [] };

  const filter: Record<string, unknown> = {};
  if (input.domain) filter.domain = input.domain;
  if (input.evidenceGrade) filter.evidence_grade = input.evidenceGrade;

  const result = await deps.vectorize.query(vec, { topK: k, filter });
  const matches: SearchMatch[] = [];
  for (const m of result.matches) {
    const chunk = await deps.db.prepare(
      `SELECT id, section, text, paper_id FROM research_chunks WHERE id = ?`
    ).bind(m.id).first<{ id: string; section: string; text: string; paper_id: string }>();
    if (!chunk) continue;
    const paper = await deps.db.prepare(
      `SELECT id, title, year, domain, evidence_grade FROM research_papers WHERE id = ? AND status = 'ready'`
    ).bind(chunk.paper_id).first<{ id: string; title: string; year: number | null; domain: string | null; evidence_grade: string | null }>();
    if (!paper) continue;
    const summaryRows = await deps.db.prepare(
      `SELECT level, body FROM research_summaries WHERE paper_id = ?`
    ).bind(chunk.paper_id).all<{ level: string; body: string }>();
    const summaries: SearchMatch['summaries'] = {};
    for (const s of summaryRows.results ?? []) {
      summaries[s.level as 'tldr' | 'plain' | 'detailed'] = s.body;
    }
    matches.push({
      paper,
      chunk: { id: chunk.id, section: chunk.section, text: chunk.text, score: m.score },
      summaries
    });
  }
  return { matches };
}
