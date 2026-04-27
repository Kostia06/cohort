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
