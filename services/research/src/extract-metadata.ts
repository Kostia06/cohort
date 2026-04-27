import type { AIGatewayClient } from '../../../src/types';

export interface PaperMetadata {
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi: string;
  domain: 'diet' | 'training' | 'sleep' | 'general';
  study_type: string;
  evidence_grade: 'A' | 'B' | 'C' | 'D';
  population: Record<string, unknown>;
  key_findings: Array<{ claim: string; [key: string]: unknown }>;
  limitations: string[];
}

const META_SYSTEM = `You are a research-extraction system. You will receive the body text of a scientific paper. Produce a JSON object matching the schema. Do not infer beyond what the text states. Return ONLY JSON, no prose.`;

export async function extractMetadata(
  text: string,
  hintDomain: string | undefined,
  ai: AIGatewayClient
): Promise<PaperMetadata> {
  const trimmed = text.slice(0, 25000);
  const userPrompt = `Hint domain (may be wrong): ${hintDomain ?? 'unknown'}

Schema:
{
  "title": "",
  "authors": ["Last F", ...],
  "year": 0,
  "journal": "",
  "doi": "",
  "domain": "diet | training | sleep | general",
  "study_type": "RCT | meta_analysis | systematic_review | cohort | cross_sectional | guideline | narrative_review | animal | mechanistic",
  "evidence_grade": "A | B | C | D",
  "population": { "n": 0, "age_range": "", "sex": "", "training_status": "", "health_status": "", "exclusions": [] },
  "key_findings": [
    { "claim": "single declarative sentence", "effect_size": "", "confidence_interval": "", "p_value": "", "applies_to": "", "does_not_apply_to": "" }
  ],
  "limitations": ["..."]
}

Rules:
- Never strengthen claims. "may" stays "may".
- For evidence_grade use GRADE-style: A=high-quality RCT or meta-analysis of RCTs; B=well-designed cohort or single RCT; C=case-control or low-quality RCT; D=expert opinion / case series / animal / mechanistic.
- If a field is absent, use null.

Paper text:
"""
${trimmed}
"""`;

  const result = await ai.call({
    model: 'claude-opus-4-7',
    system: META_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 4000,
    signal: new AbortController().signal
  });
  const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '').trim();
  return JSON.parse(cleaned) as PaperMetadata;
}

const SUMMARY_PROMPTS: Record<'tldr' | 'plain' | 'detailed', { system: string; user: (m: PaperMetadata) => string; maxTokens: number }> = {
  tldr: {
    system: 'You write 1-2 sentence research summaries for non-experts. Never strengthen claims.',
    user: (m) => `Given this metadata, write a single sentence (max 35 words) stating the most actionable finding for a non-expert. Preserve hedging.\n\n${JSON.stringify(m)}`,
    maxTokens: 200
  },
  plain: {
    system: 'You write plain-language research summaries at an 8th-grade reading level. Never strengthen claims.',
    user: (m) => `Write a 250-350 word summary covering: 1. What did they ask? 2. Who did they study? 3. What did they do? 4. What did they find? 5. What this DOESN\'T tell us.\n\n${JSON.stringify(m)}`,
    maxTokens: 1500
  },
  detailed: {
    system: 'You write detailed research summaries for motivated non-experts. Never strengthen claims.',
    user: (m) => `Write 800-1200 words covering background, methods, results (with effect sizes), discussion, limitations, practical takeaway.\n\n${JSON.stringify(m)}`,
    maxTokens: 4000
  }
};

export async function generateSummary(
  metadata: PaperMetadata,
  level: 'tldr' | 'plain' | 'detailed',
  ai: AIGatewayClient
): Promise<string> {
  const cfg = SUMMARY_PROMPTS[level];
  const result = await ai.call({
    model: 'claude-opus-4-7',
    system: cfg.system,
    messages: [{ role: 'user', content: cfg.user(metadata) }],
    maxTokens: cfg.maxTokens,
    signal: new AbortController().signal
  });
  return result.text.trim();
}
