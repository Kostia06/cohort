const CHAIN_PATTERNS: Array<{ regex: RegExp; chain: string }> = [
  { regex: /\b(?:real canadian )?superstore\b/i, chain: 'loblaw' },
  { regex: /\bno frills\b/i, chain: 'loblaw' },
  { regex: /\b(?:safeway|sobeys)\b/i, chain: 'sobeys' },
  { regex: /\bsave[- ]on[- ]foods\b/i, chain: 'saveon' },
  { regex: /\b(?:calgary )?co[- ]?op\b/i, chain: 'calgary_coop' },
  { regex: /\bcostco\b/i, chain: 'costco' },
  { regex: /\bwalmart\b/i, chain: 'walmart' },
  { regex: /\bkroger\b/i, chain: 'kroger' }
];

export function detectChain(name: string): string | null {
  for (const { regex, chain } of CHAIN_PATTERNS) {
    if (regex.test(name)) return chain;
  }
  return null;
}
