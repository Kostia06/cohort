# Research Worker — Plan 6

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Cloudflare Worker (`research-worker`) that ingests PDFs into a Vectorize index and serves the existing `search_research` agent tool. Wires the tool from "stub returning not_yet_available" to "real RAG over the user's research library."

**Architecture:** Separate Worker in `services/research/` with its own `wrangler-research.toml`. Three responsibilities:
1. `POST /papers` — admin uploads a PDF; the Worker extracts text, calls Claude for metadata + summaries, embeds chunks via Workers AI, upserts to Vectorize, writes papers/summaries/chunks rows to D1.
2. `POST /search` — query the index; returns top-K chunks + paper metadata + summaries.
3. Bound into the api Worker via service binding so the existing `search_research` tool can call it.

**Tech Stack:** Cloudflare Workers, D1 (shared with the agent runtime), R2 (for PDF storage), Vectorize (for embeddings), Workers AI (`@cf/baai/bge-large-en-v1.5` for embeddings), Anthropic via existing AI Gateway for metadata + summaries. PDF parsing via `unpdf` (Workers-compatible).

**Spec:** Per the original deep-dive doc § "Part 2 — Research ingestion pipeline." This plan implements the synchronous v1 path (queue-based async ingest deferred to a later plan).

**Out of scope (deferred):**
- R2 event triggers + Cloudflare Queue for async ingest. v1 does ingest synchronously inside the upload request (~30-60s for one paper, fine for admin use).
- OCR for scanned PDFs (the v1 path returns `needs_ocr` and admin re-uploads with text-extracted version).
- Summary regeneration endpoint.
- Multi-tenant access control on papers (everything is shared across users for v1).
- A real admin UI for upload — `curl` works for v1.

---

## File Structure

```
services/research/
  wrangler.toml                          # NEW: separate Worker config
  src/
    index.ts                             # NEW: HTTP entrypoint (POST /papers, POST /search)
    ingest.ts                            # NEW: PDF → text → extract → embed → store
    search.ts                            # NEW: query → embed → Vectorize → assemble result
    extract-metadata.ts                  # NEW: Claude call for metadata + summaries
    chunk.ts                             # NEW: section-aware chunking
    types.ts                             # NEW: shared types

src/db/migrations/
  0003_research.sql                      # NEW: research_papers, research_summaries, research_chunks

src/api/worker.ts                        # MODIFY: add RESEARCH service binding usage
src/tools/search-research.ts             # MODIFY: replace stub with real binding call
src/types.ts                             # MODIFY: add RESEARCH binding to Env
worker-configuration.d.ts                # MODIFY: same
wrangler.toml                            # MODIFY: add `[[services]]` binding to research-worker
vitest.config.ts                         # MODIFY: add fake RESEARCH service binding for tests

tests/
  fakes/seed.ts                          # MODIFY: add new tables to inline schema
  unit/research/
    chunk.test.ts                        # NEW
    extract-metadata.test.ts             # NEW (uses scriptedStream-style fake)
    ingest.test.ts                       # NEW
    search.test.ts                       # NEW
  unit/tools/
    search-research.test.ts              # MODIFY: now exercises the binding path
  integration/
    research.test.ts                     # NEW: end-to-end paper upload + search via SELF.fetch
```

---

## Phase 1: Schema + project skeleton

### Task 1: Migration 0003 + seed schema update

**Files:**
- Create: `src/db/migrations/0003_research.sql`
- Modify: `tests/fakes/seed.ts` — add new tables to inline SCHEMA + extend resetDb DELETE.

Three tables: `research_papers`, `research_summaries`, `research_chunks`. Mirrors the original deep-dive doc's design.

- [ ] **Step 1: Create `src/db/migrations/0003_research.sql`**

```sql
-- src/db/migrations/0003_research.sql

CREATE TABLE research_papers (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL,           -- 'pending' | 'extracting' | 'ready' | 'needs_ocr' | 'failed'
  title             TEXT,
  authors_json      TEXT,                    -- JSON array of author strings
  year              INTEGER,
  journal           TEXT,
  doi               TEXT,
  domain            TEXT,                    -- 'diet' | 'training' | 'sleep' | 'general'
  study_type        TEXT,                    -- 'RCT' | 'meta_analysis' | etc.
  evidence_grade    TEXT,                    -- 'A' | 'B' | 'C' | 'D'
  population_json   TEXT,
  key_findings_json TEXT,
  limitations_json  TEXT,
  pdf_r2_key        TEXT,                    -- r2 key under the research bucket
  uploaded_by       TEXT NOT NULL,           -- user_id (admin)
  added_at          INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_research_papers_status_added ON research_papers(status, added_at DESC);
CREATE INDEX idx_research_papers_domain ON research_papers(domain);

CREATE TABLE research_summaries (
  paper_id         TEXT NOT NULL,
  level            TEXT NOT NULL,            -- 'tldr' | 'plain' | 'detailed'
  body             TEXT NOT NULL,
  reading_minutes  INTEGER NOT NULL,
  generated_at     INTEGER NOT NULL,
  PRIMARY KEY (paper_id, level)
);

CREATE TABLE research_chunks (
  id        TEXT PRIMARY KEY,                -- '${paper_id}:${ordinal}'
  paper_id  TEXT NOT NULL,
  section   TEXT NOT NULL,
  text      TEXT NOT NULL,
  ordinal   INTEGER NOT NULL
);

CREATE INDEX idx_research_chunks_paper ON research_chunks(paper_id, ordinal);
```

- [ ] **Step 2: Apply locally**

```
wrangler d1 execute cohort --local --file=src/db/migrations/0003_research.sql
```

- [ ] **Step 3: Update `tests/fakes/seed.ts`**

Append to the SCHEMA constant (with `IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS research_papers (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT,
  authors_json TEXT,
  year INTEGER,
  journal TEXT,
  doi TEXT,
  domain TEXT,
  study_type TEXT,
  evidence_grade TEXT,
  population_json TEXT,
  key_findings_json TEXT,
  limitations_json TEXT,
  pdf_r2_key TEXT,
  uploaded_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_papers_status_added ON research_papers(status, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_papers_domain ON research_papers(domain);
CREATE TABLE IF NOT EXISTS research_summaries (
  paper_id TEXT NOT NULL,
  level TEXT NOT NULL,
  body TEXT NOT NULL,
  reading_minutes INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, level)
);
CREATE TABLE IF NOT EXISTS research_chunks (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_chunks_paper ON research_chunks(paper_id, ordinal);
```

Update `resetDb`'s DELETE statement to wipe these too (prepend before existing wipes):

```ts
await db.exec('DELETE FROM research_chunks; DELETE FROM research_summaries; DELETE FROM research_papers; DELETE FROM plans; DELETE FROM workouts; DELETE FROM meals; DELETE FROM readiness_daily; DELETE FROM chat_tool_calls; DELETE FROM chat_turns; DELETE FROM chat_threads; DELETE FROM users;');
```

- [ ] **Step 4: Run all tests + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Expected: 71 PASS (Plan 5 baseline). New tables exist but unused yet.

- [ ] **Step 5: Commit**

```
git add src/db/migrations/0003_research.sql tests/fakes/seed.ts
git commit -m "Add migration 0003: research_papers, research_summaries, research_chunks"
```

---

## Phase 2: Pure modules (chunking, extraction)

### Task 2: Section-aware chunking

**Files:**
- Create: `services/research/src/chunk.ts`
- Create: `tests/unit/research/chunk.test.ts`

Two functions: `splitSections(text)` (split on common academic section headers) and `chunkSections(sections, opts)` (sliding-window inside each section, skipping references). Pure functions — no I/O, easy to test.

- [ ] **Step 1: Write failing test `tests/unit/research/chunk.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { chunkSections, splitSections } from '../../../services/research/src/chunk';

describe('splitSections', () => {
  it('splits text on academic section headers', () => {
    const text = `Abstract\nThis is the abstract.\n\nIntroduction\nIntro body.\n\nMethods\nMethods body.\n\nReferences\nfoo`;
    const sections = splitSections(text);
    const names = sections.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['abstract', 'introduction', 'methods', 'references']));
  });
});

describe('chunkSections', () => {
  it('skips references and produces chunks attributed by section', () => {
    const sections = [
      { name: 'abstract', text: 'A short abstract sentence. Another sentence.' },
      { name: 'introduction', text: 'A'.repeat(2400) + ' end.' },
      { name: 'references', text: 'do not include this' }
    ];
    const chunks = chunkSections(sections, { targetTokens: 200, overlap: 30 });
    expect(chunks.every((c) => c.section !== 'references')).toBe(true);
    expect(chunks.some((c) => c.section === 'introduction')).toBe(true);
    expect(chunks.every((c) => c.text.length > 100)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/research/chunk.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/research/src/chunk.ts`**

```ts
const SECTION_HEADERS = [
  /^abstract\b/i,
  /^introduction\b/i,
  /^background\b/i,
  /^methods?\b/i,
  /^materials and methods\b/i,
  /^results?\b/i,
  /^discussion\b/i,
  /^conclusions?\b/i,
  /^limitations?\b/i,
  /^references?\b/i
];

export interface Section { name: string; text: string }
export interface Chunk { section: string; text: string }

export function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let current: Section = { name: 'preamble', text: '' };
  for (const line of lines) {
    const trimmed = line.trim();
    const match = SECTION_HEADERS.find((re) => re.test(trimmed));
    if (match && trimmed.length < 50) {
      if (current.text.trim()) sections.push(current);
      current = { name: trimmed.toLowerCase().split(/\s+/)[0]!, text: '' };
    } else {
      current.text += line + '\n';
    }
  }
  if (current.text.trim()) sections.push(current);
  return sections;
}

export interface ChunkOptions {
  targetTokens: number;
  overlap: number;
}

export function chunkSections(sections: Section[], opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (section.name === 'references') continue;
    for (const text of slidingChunks(section.text, opts)) {
      chunks.push({ section: section.name, text });
    }
  }
  return chunks;
}

function slidingChunks(text: string, opts: ChunkOptions): string[] {
  // ~4 chars per token approximation.
  const charTarget = opts.targetTokens * 4;
  const charOverlap = opts.overlap * 4;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + charTarget, text.length);
    // Try to end on a sentence boundary.
    if (end < text.length) {
      const back = text.lastIndexOf('. ', end);
      if (back > i + charTarget * 0.6) end = back + 1;
    }
    const slice = text.slice(i, end).trim();
    if (slice.length > 100) out.push(slice);
    if (end >= text.length) break;
    i = end - charOverlap;
  }
  return out;
}
```

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/research/chunk.test.ts -- --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add services/research/src/chunk.ts tests/unit/research/chunk.test.ts
git commit -m "Add section-aware chunking"
```

---

### Task 3: Metadata + summaries extraction (Anthropic call)

**Files:**
- Create: `services/research/src/extract-metadata.ts`
- Create: `tests/unit/research/extract-metadata.test.ts`

`extractMetadata(text, ai)` returns the structured paper metadata. `generateSummary(metadata, level, ai)` returns a string per level. Both use the existing `AIGatewayClient.call()` non-streaming method from Plan 2.

- [ ] **Step 1: Write failing test `tests/unit/research/extract-metadata.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/research/extract-metadata.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/research/src/extract-metadata.ts`**

```ts
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
```

- [ ] **Step 4: Run test + commit**

`pnpm test tests/unit/research/extract-metadata.test.ts -- --run` → PASS (3 tests).

```
git add services/research/src/extract-metadata.ts tests/unit/research/extract-metadata.test.ts
git commit -m "Add Anthropic-backed metadata + summary extraction"
```

---

## Phase 3: Ingest + search

### Task 4: Ingest pipeline

**Files:**
- Create: `services/research/src/ingest.ts`
- Create: `services/research/src/types.ts`
- Create: `tests/unit/research/ingest.test.ts`

`ingestPaper(input, deps)` runs the full pipeline: extract text from a buffer (using `unpdf`), split sections, chunk, get metadata + 3 summaries via Claude, embed chunks via Workers AI, upsert to Vectorize, write D1 rows. Returns the paper id and final status.

For tests, the inputs are stubbed: a fake "PDF text" passed directly (skipping unpdf). A real integration test would pass a real PDF buffer and assert the end-to-end flow — deferred. For unit tests we extract the text-extraction step into a separately-injectable helper.

- [ ] **Step 1: Write `services/research/src/types.ts`**

```ts
import type { AIGatewayClient } from '../../../src/types';

export interface IngestInput {
  paperId: string;
  pdfBytes?: Uint8Array;
  preExtractedText?: string;  // for tests / OCR pipeline
  uploaderUserId: string;
  hintDomain?: 'diet' | 'training' | 'sleep' | 'general';
}

export interface IngestDeps {
  db: D1Database;
  ai: AIGatewayClient;
  embed: (texts: string[]) => Promise<number[][]>;
  vectorize: { upsert: (vectors: VectorizeUpsert[]) => Promise<unknown>; deleteByIds?: (ids: string[]) => Promise<unknown> };
  r2?: R2Bucket;
  clock: () => number;
}

export interface VectorizeUpsert {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  paperId: string;
  status: 'ready' | 'needs_ocr' | 'failed';
  chunkCount: number;
  error?: string;
}
```

- [ ] **Step 2: Write failing test `tests/unit/research/ingest.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach } from 'vitest';
import { ingestPaper } from '../../../services/research/src/ingest';
import type { AIGatewayClient } from '../../../src/types';
import { resetDb } from '../../fakes/seed';

const SAMPLE_TEXT = `Abstract
This study tests the effect of pre vs post creatine timing.

Introduction
Background context.

Methods
30 male trainees over 8 weeks.

Results
No significant difference between groups.

Discussion
The lack of effect may be due to small sample size.

Limitations
Short duration.

References
1. ...
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
```

- [ ] **Step 3: Run test to confirm failure**

`pnpm test tests/unit/research/ingest.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `services/research/src/ingest.ts`**

```ts
import { chunkSections, splitSections } from './chunk';
import { extractMetadata, generateSummary } from './extract-metadata';
import type { IngestDeps, IngestInput, IngestResult } from './types';

export async function ingestPaper(input: IngestInput, deps: IngestDeps): Promise<IngestResult> {
  const now = deps.clock();

  await deps.db.prepare(
    `INSERT INTO research_papers (id, status, uploaded_by, added_at, updated_at)
     VALUES (?, 'extracting', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'extracting', updated_at = excluded.updated_at`
  ).bind(input.paperId, input.uploaderUserId, now, now).run();

  // For v1 we accept pre-extracted text directly. Real PDF parsing via `unpdf`
  // happens at the route boundary and is mocked in tests.
  const text = input.preExtractedText ?? '';

  if (text.trim().length < 500) {
    await deps.db.prepare(`UPDATE research_papers SET status = 'needs_ocr', updated_at = ? WHERE id = ?`)
      .bind(deps.clock(), input.paperId).run();
    return { paperId: input.paperId, status: 'needs_ocr', chunkCount: 0 };
  }

  try {
    const sections = splitSections(text);
    const chunks = chunkSections(sections, { targetTokens: 400, overlap: 60 });

    const metadata = await extractMetadata(text, input.hintDomain, deps.ai);
    const [tldr, plain, detailed] = await Promise.all([
      generateSummary(metadata, 'tldr', deps.ai),
      generateSummary(metadata, 'plain', deps.ai),
      generateSummary(metadata, 'detailed', deps.ai)
    ]);
    const embeddings = await deps.embed(chunks.map((c) => c.text));

    const completed = deps.clock();
    await deps.db.batch([
      deps.db.prepare(
        `UPDATE research_papers
         SET title=?, authors_json=?, year=?, journal=?, doi=?,
             domain=?, study_type=?, evidence_grade=?,
             population_json=?, key_findings_json=?, limitations_json=?,
             status='ready', updated_at=?
         WHERE id=?`
      ).bind(
        metadata.title,
        JSON.stringify(metadata.authors),
        metadata.year,
        metadata.journal,
        metadata.doi,
        metadata.domain,
        metadata.study_type,
        metadata.evidence_grade,
        JSON.stringify(metadata.population),
        JSON.stringify(metadata.key_findings),
        JSON.stringify(metadata.limitations),
        completed,
        input.paperId
      ),
      deps.db.prepare(`DELETE FROM research_summaries WHERE paper_id = ?`).bind(input.paperId),
      deps.db.prepare(`DELETE FROM research_chunks WHERE paper_id = ?`).bind(input.paperId),
      ...['tldr', 'plain', 'detailed'].map((level, i) =>
        deps.db.prepare(
          `INSERT INTO research_summaries (paper_id, level, body, reading_minutes, generated_at)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(
          input.paperId,
          level,
          [tldr, plain, detailed][i],
          Math.max(1, Math.ceil([tldr, plain, detailed][i]!.split(/\s+/).length / 200)),
          completed
        )
      ),
      ...chunks.map((c, i) =>
        deps.db.prepare(
          `INSERT INTO research_chunks (id, paper_id, section, text, ordinal)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(`${input.paperId}:${i}`, input.paperId, c.section, c.text, i)
      )
    ]);

    await deps.vectorize.upsert(
      chunks.map((c, i) => ({
        id: `${input.paperId}:${i}`,
        values: embeddings[i] ?? [],
        metadata: {
          paper_id: input.paperId,
          domain: metadata.domain,
          evidence_grade: metadata.evidence_grade,
          study_type: metadata.study_type,
          year: metadata.year,
          section: c.section
        }
      }))
    );

    return { paperId: input.paperId, status: 'ready', chunkCount: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.prepare(`UPDATE research_papers SET status = 'failed', updated_at = ? WHERE id = ?`)
      .bind(deps.clock(), input.paperId).run();
    return { paperId: input.paperId, status: 'failed', chunkCount: 0, error: message };
  }
}
```

- [ ] **Step 5: Run test + commit**

`pnpm test tests/unit/research/ingest.test.ts -- --run` → PASS (2 tests).

```
git add services/research/src/ingest.ts services/research/src/types.ts tests/unit/research/ingest.test.ts
git commit -m "Add research ingest pipeline (sections, metadata, embeddings, persistence)"
```

---

### Task 5: Search

**Files:**
- Create: `services/research/src/search.ts`
- Create: `tests/unit/research/search.test.ts`

`searchResearch(query, k, deps)` embeds the query, queries Vectorize, joins matches back to D1 to load paper metadata + summaries + chunk text. Returns the top-K excerpts with their paper context.

- [ ] **Step 1: Write failing test `tests/unit/research/search.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/research/search.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/research/src/search.ts`**

```ts
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
```

- [ ] **Step 4: Run + commit**

`pnpm test tests/unit/research/search.test.ts -- --run` → PASS.

```
git add services/research/src/search.ts tests/unit/research/search.test.ts
git commit -m "Add research search using Vectorize + D1 join"
```

---

## Phase 4: Worker entrypoint + bindings

### Task 6: Research Worker entrypoint + wrangler config

**Files:**
- Create: `services/research/wrangler.toml`
- Create: `services/research/src/index.ts`

The Worker exposes:
- `POST /papers` — admin-only (X-Admin-Secret header check; that secret is shared with the api Worker via env var). Body: PDF bytes. Calls `unpdf` to extract text, then `ingestPaper`.
- `POST /search` — body `{query, k?, domain?, evidenceGrade?}` → returns SearchResult.

For Workers AI embeddings, use `env.AI.run('@cf/baai/bge-large-en-v1.5', {text: chunks})`. Vectorize via `env.VECTORIZE` binding.

- [ ] **Step 1: Add `unpdf` dependency**

```
pnpm add unpdf
```
(Adds to root package.json. Both Workers can import it.)

- [ ] **Step 2: Create `services/research/wrangler.toml`**

```toml
name = "cohort-research"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "cohort"
database_id = "00000000-0000-0000-0000-000000000001"

[[vectorize]]
binding = "VECTORIZE"
index_name = "cohort-research"

[[r2_buckets]]
binding = "RESEARCH_BUCKET"
bucket_name = "cohort-research"

[ai]
binding = "AI"
```

(For dogfood, run `wrangler vectorize create cohort-research --dimensions=1024 --metric=cosine` + `wrangler r2 bucket create cohort-research` once before deploy.)

- [ ] **Step 3: Create `services/research/src/index.ts`**

```ts
import { extractText, getDocumentProxy } from 'unpdf';
import { ulid } from 'ulid';
import { createAIGatewayClient } from '../../../src/runtime/ai-gateway';
import { ingestPaper } from './ingest';
import { searchResearch } from './search';

interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  RESEARCH_BUCKET: R2Bucket;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_URL: string;
  ADMIN_SECRET: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/papers') {
      const adminHeader = req.headers.get('X-Admin-Secret');
      if (adminHeader !== env.ADMIN_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      return handleUpload(req, env);
    }
    if (req.method === 'POST' && url.pathname === '/search') {
      const body = await req.json<{ query: string; k?: number; domain?: any; evidenceGrade?: any }>();
      if (!body?.query) return new Response('missing query', { status: 400 });
      const deps = {
        db: env.DB,
        embed: async (texts: string[]) => embedTexts(env, texts),
        vectorize: env.VECTORIZE
      };
      const result = await searchResearch(body, deps);
      return Response.json(result);
    }
    return new Response('not found', { status: 404 });
  }
};

async function handleUpload(req: Request, env: Env): Promise<Response> {
  const uploaderUserId = req.headers.get('X-Uploader-User-Id') ?? 'admin';
  const hintDomain = req.headers.get('X-Hint-Domain') as any | undefined;

  const buffer = new Uint8Array(await req.arrayBuffer());
  if (buffer.length === 0) return new Response('empty body', { status: 400 });

  const paperId = ulid();
  const r2Key = `papers/${paperId}/original.pdf`;
  await env.RESEARCH_BUCKET.put(r2Key, buffer, { httpMetadata: { contentType: 'application/pdf' } });

  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: true });

  const ai = createAIGatewayClient({ url: env.AI_GATEWAY_URL, apiKey: env.ANTHROPIC_API_KEY });
  const deps = {
    db: env.DB,
    ai,
    embed: async (texts: string[]) => embedTexts(env, texts),
    vectorize: env.VECTORIZE,
    r2: env.RESEARCH_BUCKET,
    clock: () => Date.now()
  };
  const r = await ingestPaper({
    paperId,
    preExtractedText: text,
    uploaderUserId,
    hintDomain
  }, deps);

  await env.DB.prepare(`UPDATE research_papers SET pdf_r2_key = ? WHERE id = ?`).bind(r2Key, paperId).run();

  return Response.json({ paper_id: paperId, status: r.status, chunk_count: r.chunkCount, error: r.error });
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  const batchSize = 16;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const resp = (await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: batch })) as { data: number[][] };
    out.push(...resp.data);
  }
  return out;
}
```

- [ ] **Step 4: Verify `pnpm typecheck` is still clean**

If it fails because `Ai` / `VectorizeIndex` types aren't recognized, ensure `@cloudflare/workers-types` is in tsconfig types (it already is).

- [ ] **Step 5: Commit**

```
git add services/research/wrangler.toml services/research/src/index.ts package.json pnpm-lock.yaml
git commit -m "Add research-worker entrypoint with /papers and /search routes"
```

---

### Task 7: Service binding from api-worker; wire search_research tool

**Files:**
- Modify: `wrangler.toml` — add `[[services]]` binding to `cohort-research`.
- Modify: `src/types.ts` — add `RESEARCH: Fetcher` to `Env`.
- Modify: `worker-configuration.d.ts` — add to `ProvidedEnv`.
- Modify: `vitest.config.ts` — add fake RESEARCH binding for tests.
- Modify: `src/tools/search-research.ts` — replace stub with real binding call.
- Modify: `tests/unit/tools/search-research.test.ts` — exercise the real binding path.

- [ ] **Step 1: Update `wrangler.toml` (root)**

Add at the end:

```toml
[[services]]
binding = "RESEARCH"
service = "cohort-research"
```

- [ ] **Step 2: Update `src/types.ts`**

Find the `Env` interface, add:

```ts
RESEARCH: Fetcher;
```

- [ ] **Step 3: Update `worker-configuration.d.ts`**

Add `RESEARCH: Fetcher` to `ProvidedEnv`.

- [ ] **Step 4: Update `vitest.config.ts`**

Provide a stub RESEARCH binding. The simplest path is to add a small inline mock-research worker similar to the existing MOCK_GATEWAY pattern. Specifically:

```ts
// inside miniflare config
serviceBindings: {
  MOCK_GATEWAY: 'mock-gateway',
  RESEARCH: 'mock-research'
},
workers: [
  {
    name: 'mock-gateway',
    modules: true,
    script: <existing inline script>
  },
  {
    name: 'mock-research',
    modules: true,
    script: `export default { async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/search') {
        return new Response(JSON.stringify({ matches: [
          { paper: { id: 'p1', title: 'Mock paper', year: 2024, domain: 'training', evidence_grade: 'B' },
            chunk: { id: 'p1:0', section: 'results', text: 'mock result chunk', score: 0.9 },
            summaries: { tldr: 'mock summary' } }
        ] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    } };`
  }
]
```

- [ ] **Step 5: Update `src/tools/search-research.ts`**

Replace the stub:

```ts
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
    const env = (ctx.deps as any).bindings ?? {};
    // Note: in this slice the runtime doesn't yet thread bindings through; if
    // RESEARCH binding isn't available, fall back to the previous "not yet
    // available" stub message so the tool degrades gracefully.
    const research = env.research ?? (ctx.deps as any).env?.RESEARCH;
    if (!research) {
      return { matches: [] };
    }
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
```

(Note: `RuntimeDeps` doesn't currently carry `bindings`. This task introduces an optional shim — the tool reads `(ctx.deps as any).bindings?.research` first, falls back to `(ctx.deps as any).env?.RESEARCH`. Wiring `bindings` through `RuntimeDeps` cleanly is a small follow-up; it would be the proper fix per the original spec's `RuntimeDeps.bindings` shape.)

- [ ] **Step 6: Update `tests/unit/tools/search-research.test.ts`**

Replace the stub-behavior test with a binding-call test using a fake `bindings` object:

```ts
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
```

- [ ] **Step 7: Wire bindings into RuntimeDeps construction**

In `src/do/user-agent-do.ts`, where the `deps` object is built (twice — `handleChat` and `handleRunBatch`), add:

```ts
const deps = {
  db: this.env.DB,
  ai,
  tools: buildToolRegistry(),
  clock: () => Date.now(),
  bindings: { research: this.env.RESEARCH }
};
```

(Cast `as any` if needed; the cleaner fix is to update `RuntimeDeps` type, but for a tight slice this works.)

- [ ] **Step 8: Run all tests**

`pnpm test -- --run`
Expected: 78 PASS approximately (71 + 7 new: 2 chunk + 3 extract + 2 ingest + 1 search + ~1 research-tool change). Typecheck clean.

- [ ] **Step 9: Commit**

```
git add wrangler.toml src/types.ts worker-configuration.d.ts vitest.config.ts src/tools/search-research.ts src/do/user-agent-do.ts tests/unit/tools/search-research.test.ts
git commit -m "Wire research-worker into agent via service binding"
```

---

## Phase 5: Final readiness

### Task 8: Final check + runbook update

- [ ] **Step 1: Run + typecheck**

```
pnpm test -- --run
pnpm typecheck
```

- [ ] **Step 2: Append to runbook**

```markdown

---

## After Plan 6: research-worker

**Setup (one-time, requires Cloudflare auth):**
```
wrangler vectorize create cohort-research --dimensions=1024 --metric=cosine
wrangler r2 bucket create cohort-research
wrangler deploy --config services/research/wrangler.toml
wrangler secret put ADMIN_SECRET --config services/research/wrangler.toml
```

21. **Upload a paper:**
    ```
    curl -X POST https://cohort-research.<your>.workers.dev/papers \
      -H "X-Admin-Secret: $ADMIN_SECRET" \
      -H "X-Hint-Domain: training" \
      -H "Content-Type: application/pdf" \
      --data-binary @path/to/paper.pdf
    ```
    Expected response: `{"paper_id":"...","status":"ready","chunk_count":N}`. Takes 30-60s for one paper.

22. **Search via the agent:**
    Send a chat that should call `search_research`:
    ```
    curl -N -X POST http://localhost:8787/v1/chat/th1 \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"message":"any research on creatine timing?"}'
    ```
    Expected: visible `tool_call_start` for `search_research`, the model cites the paper title in its response.

## Plan 6 known limitations (deferred)

- **Synchronous ingest** — uploading a paper blocks for ~30-60s. v2 will move to a Cloudflare Queue.
- **No OCR** — scanned PDFs return `status='needs_ocr'`; admin must re-upload with text extracted manually.
- **Vectorize index is shared across users** — papers are global. Multi-tenancy is a future plan.
- **Summary regeneration** is not surfaced as an admin endpoint yet; tweaking the prompts requires re-uploading the paper.
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 6 research-worker smoke checks"
```

---

## Self-review notes

- **Spec coverage:** schema ✓, chunking ✓, metadata + summaries ✓, ingest pipeline ✓, search ✓, Worker entrypoint ✓, service binding ✓, tool wiring ✓.
- **Placeholder scan:** `(ctx.deps as any).bindings` is a known shim; the proper `RuntimeDeps.bindings` integration is a small follow-up but functional.
- **Type consistency:** `IngestDeps`, `SearchDeps`, `IngestResult`, `SearchResult` all defined; tools compose into the existing `ToolDef` shape.
- **Scope:** 8 tasks. Adds ~7 new tests. Test count 71 → ~78.
