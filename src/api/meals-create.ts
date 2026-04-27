import { ulid } from 'ulid';

export interface MealCreateInput {
  name: string;
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  notes?: string;
  eaten_at?: number;
}

export interface MealCreateDeps {
  db: D1Database;
  userId: string;
  now: number;
  input: MealCreateInput;
}

export interface MealCreateResult {
  ok: boolean;
  meal_id?: string;
  status?: number;
  reason?: string;
}

export async function handleMealCreate(deps: MealCreateDeps): Promise<MealCreateResult> {
  const { db, userId, now, input } = deps;

  if (!input.name || input.name.trim() === '') {
    return { ok: false, status: 400, reason: 'name is required' };
  }

  const mealId = `meal_${userId}_${ulid()}`;
  const eatenAt = input.eaten_at ?? now;

  await db.prepare(
    `INSERT INTO meals (meal_id, user_id, eaten_at, name, kcal, protein_g, carbs_g, fat_g, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')`
  ).bind(
    mealId,
    userId,
    eatenAt,
    input.name.trim(),
    input.kcal ?? null,
    input.protein_g ?? null,
    input.carbs_g ?? null,
    input.fat_g ?? null,
    input.notes ?? null,
  ).run();

  return { ok: true, meal_id: mealId };
}
