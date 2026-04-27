export interface DeleteResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface DeleteSetRequest {
  db: D1Database;
  userId: string;
  setId: string;
}

export async function handleDeleteSet(req: DeleteSetRequest): Promise<DeleteResult> {
  const owner = await req.db.prepare(
    `SELECT w.user_id AS user_id
     FROM workout_sets s
     JOIN workouts w ON w.workout_id = s.workout_id
     WHERE s.set_id = ?`
  ).bind(req.setId).first<{ user_id: string }>();
  if (!owner) return { ok: false, status: 404, reason: 'set not found' };
  if (owner.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  await req.db.prepare(`DELETE FROM workout_sets WHERE set_id = ?`).bind(req.setId).run();
  return { ok: true };
}

export interface DeleteMealRequest {
  db: D1Database;
  userId: string;
  mealId: string;
}

export async function handleDeleteMeal(req: DeleteMealRequest): Promise<DeleteResult> {
  const owner = await req.db.prepare(
    `SELECT user_id FROM meals WHERE meal_id = ?`
  ).bind(req.mealId).first<{ user_id: string }>();
  if (!owner) return { ok: false, status: 404, reason: 'meal not found' };
  if (owner.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  await req.db.prepare(`DELETE FROM meals WHERE meal_id = ?`).bind(req.mealId).run();
  return { ok: true };
}
