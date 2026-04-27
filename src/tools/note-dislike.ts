import type { ToolCtx, ToolDef } from '../types';

interface Input { food: string }
interface Output { dislikes: string[] }

export const noteDislikeTool: ToolDef<Input, Output> = {
  name: 'note_dislike',
  description: 'Add a food the user dislikes to their persistent profile. Idempotent.',
  inputSchema: {
    type: 'object',
    properties: { food: { type: 'string', minLength: 1 } },
    required: ['food'],
    additionalProperties: false
  },
  surface: 'hidden',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const food = input.food.trim().toLowerCase();
    const row = await ctx.deps.db.prepare(
      `SELECT dislikes_json FROM users WHERE user_id = ?`
    ).bind(ctx.userId).first<{ dislikes_json: string }>();
    const current = JSON.parse(row?.dislikes_json ?? '[]') as string[];
    if (current.includes(food)) return { dislikes: current };
    const next = [...current, food];
    await ctx.deps.db.prepare(
      `UPDATE users SET dislikes_json = ? WHERE user_id = ?`
    ).bind(JSON.stringify(next), ctx.userId).run();
    return { dislikes: next };
  }
};
