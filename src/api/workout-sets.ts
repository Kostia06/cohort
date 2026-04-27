import { ulid } from 'ulid';

export interface CreateSetInput {
  exercise: string;
  reps?: number;
  weight_kg?: number;
  rpe?: number;
  notes?: string;
}

export interface CreateSetRequest {
  db: D1Database;
  userId: string;
  workoutId: string;
  now: number;
  input: CreateSetInput;
}

export interface CreateSetResult {
  ok: boolean;
  set_id?: string;
  ordinal?: number;
  status?: number;
  reason?: string;
}

export async function handleCreateSet(req: CreateSetRequest): Promise<CreateSetResult> {
  const exercise = req.input?.exercise?.trim();
  if (!exercise) return { ok: false, status: 400, reason: 'missing exercise' };

  const owner = await req.db.prepare(
    `SELECT user_id FROM workouts WHERE workout_id = ?`
  ).bind(req.workoutId).first<{ user_id: string }>();
  if (!owner) return { ok: false, status: 404, reason: 'workout not found' };
  if (owner.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  const ordRow = await req.db.prepare(
    `SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ord FROM workout_sets WHERE workout_id = ?`
  ).bind(req.workoutId).first<{ next_ord: number }>();
  const ordinal = ordRow?.next_ord ?? 0;

  const setId = `set_${ulid()}`;
  await req.db.prepare(
    `INSERT INTO workout_sets (set_id, workout_id, ordinal, exercise, reps, weight_kg, rpe, notes, logged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    setId,
    req.workoutId,
    ordinal,
    exercise,
    req.input.reps ?? null,
    req.input.weight_kg ?? null,
    req.input.rpe ?? null,
    req.input.notes ?? null,
    req.now
  ).run();

  return { ok: true, set_id: setId, ordinal };
}

export interface GetWorkoutRequest {
  db: D1Database;
  userId: string;
  workoutId: string;
}

export interface WorkoutSet {
  set_id: string;
  workout_id: string;
  ordinal: number;
  exercise: string;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  notes: string | null;
  logged_at: number;
}

export interface GetWorkoutResult {
  ok: boolean;
  workout?: {
    workout_id: string;
    user_id: string;
    date: string;
    kind: string;
    duration_min: number | null;
    rpe: number | null;
    status: string;
    notes: string | null;
  };
  sets?: WorkoutSet[];
  status?: number;
  reason?: string;
}

export async function handleGetWorkout(req: GetWorkoutRequest): Promise<GetWorkoutResult> {
  const w = await req.db.prepare(
    `SELECT workout_id, user_id, date, kind, duration_min, rpe, status, notes
     FROM workouts WHERE workout_id = ?`
  ).bind(req.workoutId).first<{
    workout_id: string; user_id: string; date: string; kind: string;
    duration_min: number | null; rpe: number | null; status: string; notes: string | null;
  }>();
  if (!w) return { ok: false, status: 404, reason: 'workout not found' };
  if (w.user_id !== req.userId) return { ok: false, status: 403, reason: 'forbidden' };

  const setRows = await req.db.prepare(
    `SELECT set_id, workout_id, ordinal, exercise, reps, weight_kg, rpe, notes, logged_at
     FROM workout_sets WHERE workout_id = ? ORDER BY ordinal`
  ).bind(req.workoutId).all<WorkoutSet>();

  return { ok: true, workout: w, sets: setRows.results ?? [] };
}
