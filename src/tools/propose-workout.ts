import type { ToolCtx, ToolDef } from '../types';

interface Input {
  date: string;
  kind: 'strength' | 'cardio' | 'mobility' | 'mixed';
  duration_min?: number;
  rpe?: number;
  load_score?: number;
  notes?: string;
}
interface Output { workout_id: string }

export const proposeWorkoutTool: ToolDef<Input, Output> = {
  name: 'propose_workout',
  description: 'Propose a workout for a given date. Stored with status=planned. Idempotent within a turn.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      kind: { type: 'string', enum: ['strength', 'cardio', 'mobility', 'mixed'] },
      duration_min: { type: 'integer', minimum: 0 },
      rpe: { type: 'integer', minimum: 1, maximum: 10 },
      load_score: { type: 'number', minimum: 0 },
      notes: { type: 'string' }
    },
    required: ['date', 'kind'],
    additionalProperties: false
  },
  surface: 'visible',
  idempotent: true,
  async handler(input: Input, ctx: ToolCtx): Promise<Output> {
    const id = `workout_${ctx.turnId}_${ctx.toolCallIndex}`;
    await ctx.deps.db.prepare(
      `INSERT INTO workouts (workout_id, user_id, date, kind, duration_min, rpe, load_score, notes, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'agent')
       ON CONFLICT(workout_id) DO NOTHING`
    ).bind(
      id, ctx.userId, input.date, input.kind,
      input.duration_min ?? null, input.rpe ?? null, input.load_score ?? null, input.notes ?? null
    ).run();
    return { workout_id: id };
  }
};
