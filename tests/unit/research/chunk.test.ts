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
