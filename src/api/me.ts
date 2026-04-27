export type DietaryPattern = 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian' | 'keto';

const ALLOWED_PATTERNS: DietaryPattern[] = ['omnivore', 'vegetarian', 'vegan', 'pescatarian', 'keto'];

export interface Profile {
  user_id: string;
  display_name: string;
  timezone: string;
  age_years: number | null;
  dietary_pattern: string | null;
  allergies: string[];
  dislikes: string[];
  daily_cost_cap_cents: number;
}

export interface MeGetRequest {
  db: D1Database;
  userId: string;
}

export interface MeGetResult {
  ok: boolean;
  profile?: Profile;
  status?: number;
  reason?: string;
}

export interface MeUpdateInput {
  display_name?: string;
  timezone?: string;
  age_years?: number | null;
  dietary_pattern?: DietaryPattern | null;
  allergies?: string[];
  dislikes?: string[];
  daily_cost_cap_cents?: number;
}

export interface MeUpdateRequest {
  db: D1Database;
  userId: string;
  input: MeUpdateInput;
}

export interface MeUpdateResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    return [];
  } catch {
    return [];
  }
}

export async function handleMeGet(req: MeGetRequest): Promise<MeGetResult> {
  const row = await req.db.prepare(
    `SELECT user_id, display_name, timezone, age_years, dietary_pattern,
            allergies_json, dislikes_json, daily_cost_cap_cents
     FROM users WHERE user_id = ?`
  ).bind(req.userId).first<{
    user_id: string;
    display_name: string;
    timezone: string;
    age_years: number | null;
    dietary_pattern: string | null;
    allergies_json: string;
    dislikes_json: string;
    daily_cost_cap_cents: number;
  }>();

  if (!row) return { ok: false, status: 404, reason: 'user not found' };

  return {
    ok: true,
    profile: {
      user_id: row.user_id,
      display_name: row.display_name,
      timezone: row.timezone,
      age_years: row.age_years,
      dietary_pattern: row.dietary_pattern,
      allergies: safeArr(row.allergies_json),
      dislikes: safeArr(row.dislikes_json),
      daily_cost_cap_cents: row.daily_cost_cap_cents,
    },
  };
}

export async function handleMeUpdate(req: MeUpdateRequest): Promise<MeUpdateResult> {
  const fields: string[] = [];
  const binds: unknown[] = [];

  if (req.input.display_name !== undefined) {
    const v = req.input.display_name.trim();
    if (!v) return { ok: false, status: 400, reason: 'display_name cannot be empty' };
    fields.push('display_name = ?');
    binds.push(v);
  }

  if (req.input.timezone !== undefined) {
    const v = req.input.timezone.trim();
    if (!v) return { ok: false, status: 400, reason: 'timezone cannot be empty' };
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: v }).format(new Date());
    } catch {
      return { ok: false, status: 400, reason: 'invalid timezone' };
    }
    fields.push('timezone = ?');
    binds.push(v);
  }

  if (req.input.age_years !== undefined) {
    const v = req.input.age_years;
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 150)) {
      return { ok: false, status: 400, reason: 'age_years out of range' };
    }
    fields.push('age_years = ?');
    binds.push(v);
  }

  if (req.input.dietary_pattern !== undefined) {
    const v = req.input.dietary_pattern;
    if (v !== null && !ALLOWED_PATTERNS.includes(v as DietaryPattern)) {
      return { ok: false, status: 400, reason: 'invalid dietary_pattern' };
    }
    fields.push('dietary_pattern = ?');
    binds.push(v);
  }

  if (req.input.allergies !== undefined) {
    if (!Array.isArray(req.input.allergies) || !req.input.allergies.every((s) => typeof s === 'string')) {
      return { ok: false, status: 400, reason: 'allergies must be string[]' };
    }
    fields.push('allergies_json = ?');
    binds.push(JSON.stringify(req.input.allergies.map((s) => s.trim().toLowerCase())));
  }

  if (req.input.dislikes !== undefined) {
    if (!Array.isArray(req.input.dislikes) || !req.input.dislikes.every((s) => typeof s === 'string')) {
      return { ok: false, status: 400, reason: 'dislikes must be string[]' };
    }
    fields.push('dislikes_json = ?');
    binds.push(JSON.stringify(req.input.dislikes.map((s) => s.trim().toLowerCase())));
  }

  if (req.input.daily_cost_cap_cents !== undefined) {
    const v = req.input.daily_cost_cap_cents;
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      return { ok: false, status: 400, reason: 'daily_cost_cap_cents out of range (0–100000)' };
    }
    fields.push('daily_cost_cap_cents = ?');
    binds.push(v);
  }

  if (fields.length === 0) return { ok: true };

  binds.push(req.userId);
  await req.db.prepare(
    `UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`
  ).bind(...binds).run();

  return { ok: true };
}
