import type { ToolCtx, ToolDef } from '../types';

interface Output {
  display_name: string;
  timezone: string;
  age_years: number | null;
  dietary_pattern: string | null;
  allergies: string[];
  dislikes: string[];
}

export const getUserProfileTool: ToolDef<Record<string, never>, Output> = {
  name: 'get_user_profile',
  description: 'Return the current user\'s profile (display name, timezone, age, dietary pattern, allergies, dislikes).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  surface: 'hidden',
  idempotent: true,
  async handler(_input, ctx: ToolCtx): Promise<Output> {
    const row = await ctx.deps.db.prepare(
      `SELECT display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json
       FROM users WHERE user_id = ?`
    ).bind(ctx.userId).first<{
      display_name: string;
      timezone: string;
      age_years: number | null;
      dietary_pattern: string | null;
      allergies_json: string;
      dislikes_json: string;
    }>();
    if (!row) throw new Error(`user not found: ${ctx.userId}`);
    return {
      display_name: row.display_name,
      timezone: row.timezone,
      age_years: row.age_years,
      dietary_pattern: row.dietary_pattern,
      allergies: JSON.parse(row.allergies_json) as string[],
      dislikes: JSON.parse(row.dislikes_json) as string[]
    };
  }
};
