const SECTION_HEADERS = [
  /^abstract$/i,
  /^introduction$/i,
  /^background$/i,
  /^methods?$/i,
  /^materials and methods$/i,
  /^results?$/i,
  /^discussion$/i,
  /^conclusions?$/i,
  /^limitations?$/i,
  /^references?$/i
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
