export async function getDailySpentCents(
  db: D1Database,
  userId: string,
  nowMs: number,
  timezone: string
): Promise<number> {
  const sinceMs = startOfLocalDayMs(nowMs, timezone);
  const row = await db.prepare(
    `SELECT COALESCE(SUM(t.cost_usd), 0) AS sum_usd
     FROM chat_turns t
     JOIN chat_threads th ON th.thread_id = t.thread_id
     WHERE th.user_id = ? AND t.started_at >= ?`
  ).bind(userId, sinceMs).first<{ sum_usd: number }>();
  const usd = row?.sum_usd ?? 0;
  return Math.round(usd * 100);
}

function startOfLocalDayMs(nowMs: number, timezone: string): number {
  const localDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(nowMs));

  const localStrAsUtc = new Date(nowMs).toLocaleString('sv-SE', { timeZone: timezone });
  const utcStrAsUtc = new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'UTC' });
  const offsetMinutes = (Date.parse(localStrAsUtc + 'Z') - Date.parse(utcStrAsUtc + 'Z')) / 60_000;

  const utcMidnightForLocalDate = Date.parse(`${localDateStr}T00:00:00Z`);
  return utcMidnightForLocalDate - offsetMinutes * 60_000;
}

export async function getCostCapCents(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT daily_cost_cap_cents FROM users WHERE user_id = ?`
  ).bind(userId).first<{ daily_cost_cap_cents: number }>();
  return row?.daily_cost_cap_cents ?? 150;
}
