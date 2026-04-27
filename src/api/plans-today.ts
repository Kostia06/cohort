const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlansTodayInput {
  userId: string;
  date: string;
  now: number;
  db: D1Database;
}

export interface PlansTodayResult {
  date: string;
  readiness: {
    score: number | null;
    band: string | null;
    status: string;
    components: Record<string, unknown>;
    reasons: string[];
  } | null;
  planned_workouts: Array<{
    workout_id: string;
    kind: string;
    duration_min: number | null;
    rpe: number | null;
    status: string;
    notes: string | null;
  }>;
  recent_meals: Array<{
    meal_id: string;
    name: string;
    eaten_at: number;
    kcal: number | null;
    notes: string | null;
  }>;
  latest_assistant_message: {
    turn_id: string;
    text: string;
    actor: string;
    started_at: number;
  } | null;
}

export async function handlePlansToday(input: PlansTodayInput): Promise<PlansTodayResult> {
  const { db, userId, date, now } = input;

  const readinessRow = await db.prepare(
    `SELECT score, band, status, components_json, reasons_json
     FROM readiness_daily
     WHERE user_id = ? AND date = ?`
  ).bind(userId, date).first<{
    score: number | null; band: string | null; status: string;
    components_json: string; reasons_json: string;
  }>();

  const readiness = readinessRow ? {
    score: readinessRow.score,
    band: readinessRow.band,
    status: readinessRow.status,
    components: safeJson(readinessRow.components_json) as Record<string, unknown>,
    reasons: safeJson(readinessRow.reasons_json) as string[]
  } : null;

  const workoutRows = await db.prepare(
    `SELECT workout_id, kind, duration_min, rpe, status, notes
     FROM workouts
     WHERE user_id = ? AND date = ? AND status = 'planned'
     ORDER BY workout_id`
  ).bind(userId, date).all<{
    workout_id: string; kind: string; duration_min: number | null;
    rpe: number | null; status: string; notes: string | null;
  }>();

  const mealRows = await db.prepare(
    `SELECT meal_id, name, eaten_at, kcal, notes
     FROM meals
     WHERE user_id = ? AND eaten_at >= ?
     ORDER BY eaten_at DESC`
  ).bind(userId, now - DAY_MS).all<{
    meal_id: string; name: string; eaten_at: number;
    kcal: number | null; notes: string | null;
  }>();

  const latestRow = await db.prepare(
    `SELECT t.turn_id, t.text, t.actor, t.started_at
     FROM chat_turns t
     JOIN chat_threads th ON th.thread_id = t.thread_id
     WHERE th.user_id = ? AND t.status = 'complete' AND t.text IS NOT NULL
     ORDER BY t.started_at DESC
     LIMIT 1`
  ).bind(userId).first<{
    turn_id: string; text: string; actor: string; started_at: number;
  }>();

  return {
    date,
    readiness,
    planned_workouts: workoutRows.results ?? [],
    recent_meals: mealRows.results ?? [],
    latest_assistant_message: latestRow ?? null
  };
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
