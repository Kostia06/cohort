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

const COMPILED = (dangerousTopics.patterns as RawPattern[]).map((p) => {
  try {
    const cleaned = p.regex.replace(/^\(\?i\)/, '');
    return { ...p, compiled: new RegExp(cleaned, 'i') };
  } catch (e) {
    throw new Error(`dangerous-topics.json: invalid regex for pattern "${p.id}": ${e instanceof Error ? e.message : String(e)}`);
  }
});

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

import type { AIGatewayClient } from '../types';

const POSTREVIEW_SYSTEM = `You are a safety reviewer for a non-medical health and training app. Read the assistant response and identify any of these issues:
- Specific medication, supplement dosage, or drug-interaction advice.
- Calorie targets below 1200/day for adults without explicit clinical-supervision framing.
- Diagnostic claims about the user's medical condition.
- Strengthening of research claims (turning "may" into "does", removing hedging).

Return ONLY a JSON object, no prose, no markdown. Either:
{"ok": true}
or
{"ok": false, "corrigendum": "<one-paragraph note to append to the response that adds caveats / redirects appropriately>"}`;

export async function postReview(
  assembled: string,
  ai: AIGatewayClient
): Promise<{ ok: boolean; corrigendum?: string }> {
  if (!assembled.trim()) return { ok: true };
  try {
    const result = await ai.call({
      model: 'claude-haiku-4-5-20251001',
      system: POSTREVIEW_SYSTEM,
      messages: [{ role: 'user', content: `Review this assistant response:\n\n${assembled}` }],
      maxTokens: 500,
      signal: new AbortController().signal
    });
    const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '');
    const parsed = JSON.parse(cleaned) as { ok: boolean; corrigendum?: string };
    if (parsed.ok === true) return { ok: true };
    if (parsed.ok === false && typeof parsed.corrigendum === 'string') {
      return { ok: false, corrigendum: parsed.corrigendum };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[postReview] Haiku call failed, failing open:', err);
    return { ok: true };
  }
}
