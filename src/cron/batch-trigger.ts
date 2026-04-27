export interface DueUser {
  user_id: string;
  timezone: string;
}

export async function findUsersDueForBatch(
  db: D1Database,
  nowMs: number,
  targetHour: number
): Promise<DueUser[]> {
  const rows = await db.prepare(`SELECT user_id, timezone FROM users`).all<DueUser>();
  const now = new Date(nowMs);
  return (rows.results ?? []).filter((u) => {
    try {
      const localHour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: u.timezone,
          hour: 'numeric',
          hourCycle: 'h23'
        }).format(now)
      );
      return localHour === targetHour;
    } catch {
      console.warn(`[batch-trigger] invalid timezone for ${u.user_id}: ${u.timezone}`);
      return false;
    }
  });
}

export async function runBatchTrigger(
  db: D1Database,
  nowMs: number,
  targetHour: number,
  dispatch: (userId: string) => Promise<void>
): Promise<{ dispatched: number; errors: number }> {
  const due = await findUsersDueForBatch(db, nowMs, targetHour);
  let dispatched = 0;
  let errors = 0;
  for (const u of due) {
    try {
      await dispatch(u.user_id);
      dispatched++;
    } catch (err) {
      errors++;
      console.error(`[batch-trigger] dispatch failed for ${u.user_id}:`, err);
    }
  }
  return { dispatched, errors };
}
