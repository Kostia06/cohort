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
