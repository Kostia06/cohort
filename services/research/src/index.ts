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
      const body = await req.json<{ query: string; k?: number; domain?: 'diet' | 'training' | 'sleep' | 'general'; evidenceGrade?: 'A' | 'B' | 'C' | 'D' }>();
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
  const hintDomain = req.headers.get('X-Hint-Domain') as 'diet' | 'training' | 'sleep' | 'general' | undefined;

  const buffer = new Uint8Array(await req.arrayBuffer());
  if (buffer.length === 0) return new Response('empty body', { status: 400 });

  const paperId = ulid();
  const r2Key = `papers/${paperId}/original.pdf`;
  await env.RESEARCH_BUCKET.put(r2Key, buffer, {
    httpMetadata: { contentType: 'application/pdf' }
  });

  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: true });

  const ai = createAIGatewayClient({
    url: env.AI_GATEWAY_URL,
    apiKey: env.ANTHROPIC_API_KEY
  });
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

  await env.DB.prepare(`UPDATE research_papers SET pdf_r2_key = ? WHERE id = ?`)
    .bind(r2Key, paperId)
    .run();

  return Response.json({
    paper_id: paperId,
    status: r.status,
    chunk_count: r.chunkCount,
    error: r.error
  });
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
