import dangerousTopics from '../safety-data/dangerous-topics.json' with { type: 'json' };

export interface PreflightResult {
  allow: boolean;
  reason?: string;
  cannedResponse?: string;
}

interface RawPattern {
  id: string;
  regex: string;
  redirect: string;
  kcalMaxFloor?: number;
}

const COMPILED = (dangerousTopics.patterns as RawPattern[]).map((p) => ({
  ...p,
  compiled: new RegExp(p.regex.replace(/^\(\?i\)/, ''), 'i')
}));

export function preflightSafety(text: string): PreflightResult {
  for (const p of COMPILED) {
    const m = p.compiled.exec(text);
    if (!m) continue;
    if (p.kcalMaxFloor !== undefined) {
      const kcal = Number(m.groups?.kcal ?? 0);
      if (kcal >= p.kcalMaxFloor) continue;
    }
    return { allow: false, reason: p.id, cannedResponse: p.redirect };
  }
  return { allow: true };
}

// Stub for vertical slice — full implementation in Plan 2.
export async function postReview(_assembled: string): Promise<{ ok: true }> {
  return { ok: true };
}
