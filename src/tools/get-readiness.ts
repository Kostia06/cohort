import type { ToolCtx, ToolDef } from '../types';

interface Output {
  readiness: {
    date: string;
    score: number | null;
    band: 'rest' | 'easy' | 'normal' | 'green' | null;
    status: string;
    components: Record<string, unknown>;
    reasons: string[];
    computed_at: number;
  } | null;
}

export const getReadinessTool: ToolDef<Record<string, never>, Output> = {
  name: 'get_readiness',
  description: 'Return the most recent readiness score for the user, including band (rest/easy/normal/green) and component breakdown.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  surface: 'hidden',
  idempotent: true,
  async handler(_input, ctx: ToolCtx): Promise<Output> {
    const row = await ctx.deps.db.prepare(
      `SELECT date, score, band, status, components_json, reasons_json, computed_at
       FROM readiness_daily
       WHERE user_id = ?
       ORDER BY date DESC
       LIMIT 1`
    ).bind(ctx.userId).first<{
      date: string; score: number | null; band: string | null;
      status: string; components_json: string; reasons_json: string; computed_at: number;
    }>();
    if (!row) return { readiness: null };
    return {
      readiness: {
        date: row.date,
        score: row.score,
        band: row.band as 'rest' | 'easy' | 'normal' | 'green' | null,
        status: row.status,
        components: JSON.parse(row.components_json) as Record<string, unknown>,
        reasons: JSON.parse(row.reasons_json) as string[],
        computed_at: row.computed_at
      }
    };
  }
};
