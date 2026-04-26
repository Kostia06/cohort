import type { ToolCtx, ToolDef } from '../types';

interface Input {
  name: string;
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  notes?: string;
  eaten_at?: number;
}
interface Output { meal_id: string; eaten_at: number }

export const logMealTool: ToolDef<Input, Output> = {
  name: 'log_meal',
  description: 'Log a meal the user just ate. Returns the meal_id. Idempotent within a single turn.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      kcal: { type: 'integer', minimum: 0 },
      protein_g: { type: 'number', minimum: 0 },
      carbs_g: { type: 'number', minimum: 0 },
      fat_g: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
      eaten_at: { type: 'integer' }
    },
    required: ['name'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const mealId = `meal_${ctx.turnId}_${ctx.toolCallIndex}`;
    const eatenAt = input.eaten_at ?? ctx.deps.clock();
    await ctx.deps.db.prepare(
      `INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, protein_g, carbs_g, fat_g, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent')
       ON CONFLICT(meal_id) DO NOTHING`
    ).bind(
      mealId, ctx.userId, eatenAt, input.name,
      input.kcal ?? null, input.protein_g ?? null, input.carbs_g ?? null, input.fat_g ?? null,
      input.notes ?? null
    ).run();
    return { meal_id: mealId, eaten_at: eatenAt };
  }
};
