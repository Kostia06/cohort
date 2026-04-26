import type { ToolCtx, ToolDef } from '../types';

interface Input { query: string; domain?: 'diet' | 'training' | 'sleep' | 'general'; k?: number }
interface Output { error: 'not_yet_available'; message: string }

export const searchResearchTool: ToolDef<Input, Output> = {
  name: 'search_research',
  description: 'Search the research RAG index for relevant findings, with hedging preserved. Returns top-K excerpts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 3 },
      domain: { type: 'string', enum: ['diet', 'training', 'sleep', 'general'] },
      k: { type: 'integer', minimum: 1, maximum: 10 }
    },
    required: ['query'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(_input, _ctx: ToolCtx): Promise<Output> {
    return {
      error: 'not_yet_available',
      message: 'Research search is not yet wired up. Tell the user this feature is coming soon.'
    };
  }
};
