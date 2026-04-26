import type { ToolCtx, ToolDef } from '../types';

interface Input { items: string[]; lat?: number; lng?: number; radius_m?: number }
interface Output { error: 'not_yet_available'; message: string }

export const searchGroceriesTool: ToolDef<Input, Output> = {
  name: 'search_groceries',
  description: 'Search nearby grocery stores for items with prices. Returns matched products + store + price.',
  inputSchema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'string' }, minItems: 1 },
      lat: { type: 'number' },
      lng: { type: 'number' },
      radius_m: { type: 'integer', minimum: 100, maximum: 50000 }
    },
    required: ['items'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(_input, _ctx: ToolCtx): Promise<Output> {
    return {
      error: 'not_yet_available',
      message: 'Grocery search is not yet wired up. Tell the user this feature is coming soon.'
    };
  }
};
