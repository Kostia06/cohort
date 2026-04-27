import type { ToolCtx, ToolDef } from '../types';

interface Input { days?: number }

interface Meal {
  meal_id: string;
  eaten_at: number;
  name: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  notes: string | null;
}

interface Output { meals: Meal[] }

const DAY_MS = 24 * 60 * 60 * 1000;

export const getRecentMealsTool: ToolDef<Input, Output> = {
  name: 'get_recent_meals',
  description: 'Return meals logged in the last N days (default 7), most recent first.',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
    additionalProperties: false
  },
  surface: 'hidden',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const days = Math.max(1, Math.min(90, input.days ?? 7));
    const since = ctx.deps.clock() - days * DAY_MS;
    const rows = await ctx.deps.db.prepare(
      `SELECT meal_id, eaten_at, name, kcal, protein_g, carbs_g, fat_g, notes
       FROM meals
       WHERE user_id = ? AND eaten_at >= ?
       ORDER BY eaten_at DESC`
    ).bind(ctx.userId, since).all<Meal>();
    return { meals: rows.results ?? [] };
  }
};
