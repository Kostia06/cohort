const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDailySpentCents(db: D1Database, userId: string, now: number): Promise<number> {
  const since = now - DAY_MS;
  const row = await db.prepare(
    `SELECT COALESCE(SUM(t.cost_usd), 0) AS sum_usd
     FROM chat_turns t
     JOIN chat_threads th ON th.thread_id = t.thread_id
     WHERE th.user_id = ? AND t.started_at >= ?`
  ).bind(userId, since).first<{ sum_usd: number }>();
  const usd = row?.sum_usd ?? 0;
  return Math.round(usd * 100);
}

export async function getCostCapCents(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT daily_cost_cap_cents FROM users WHERE user_id = ?`
  ).bind(userId).first<{ daily_cost_cap_cents: number }>();
  return row?.daily_cost_cap_cents ?? 150;
}
