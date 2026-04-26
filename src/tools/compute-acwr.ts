import type { ToolCtx, ToolDef } from '../types';

interface Output {
  acute_load: number;
  chronic_load: number;
  acwr: number | null;
  flag: 'low' | 'sweet_spot' | 'elevated' | 'detraining' | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const computeAcwrTool: ToolDef<Record<string, never>, Output> = {
  name: 'compute_acwr',
  description: 'Compute the Acute:Chronic Workload Ratio (Gabbett 2016) — sum of load over 7d / mean weekly load over 28d.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  surface: 'visible',
  idempotent: true,
  async handler(_input, ctx: ToolCtx): Promise<Output> {
    const now = ctx.deps.clock();
    const since28d = new Date(now - 28 * DAY_MS).toISOString().slice(0, 10);
    const since7d = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);

    const acuteRow = await ctx.deps.db.prepare(
      `SELECT COALESCE(SUM(load_score), 0) AS s
       FROM workouts WHERE user_id = ? AND date >= ? AND status = 'logged'`
    ).bind(ctx.userId, since7d).first<{ s: number }>();

    const chronicRow = await ctx.deps.db.prepare(
      `SELECT COALESCE(SUM(load_score), 0) AS s
       FROM workouts WHERE user_id = ? AND date >= ? AND status = 'logged'`
    ).bind(ctx.userId, since28d).first<{ s: number }>();

    const acute = acuteRow?.s ?? 0;
    const chronicTotal = chronicRow?.s ?? 0;
    const chronic = chronicTotal / 4;
    const acwr = chronic > 0 ? acute / chronic : null;

    let flag: Output['flag'] = null;
    if (acwr !== null) {
      if (acwr > 1.5) flag = 'elevated';
      else if (acwr < 0.8) flag = 'detraining';
      else flag = 'sweet_spot';
    } else if (acute > 0) flag = 'low';

    return { acute_load: acute, chronic_load: chronic, acwr, flag };
  }
};
