const ALLOWED_STATUSES = ['planned', 'logged', 'skipped'] as const;
type WorkoutStatus = typeof ALLOWED_STATUSES[number];

export interface WorkoutUpdateInput {
  db: D1Database;
  userId: string;
  workoutId: string;
  status: WorkoutStatus;
}

export interface WorkoutUpdateResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export async function handleWorkoutUpdate(input: WorkoutUpdateInput): Promise<WorkoutUpdateResult> {
  if (!ALLOWED_STATUSES.includes(input.status)) {
    return { ok: false, status: 400, reason: 'invalid status' };
  }

  const row = await input.db.prepare(
    `SELECT user_id FROM workouts WHERE workout_id = ?`
  ).bind(input.workoutId).first<{ user_id: string }>();

  if (!row) return { ok: false, status: 404, reason: 'not found' };
  if (row.user_id !== input.userId) return { ok: false, status: 403, reason: 'forbidden' };

  await input.db.prepare(
    `UPDATE workouts SET status = ? WHERE workout_id = ?`
  ).bind(input.status, input.workoutId).run();

  return { ok: true };
}
