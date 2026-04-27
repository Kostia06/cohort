const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 365;

export interface StatsStreaksInput {
  db: D1Database;
  userId: string;
  now: number;
  timezone: string;
}

export interface StatsStreaksResult {
  workouts: number;
  meals: number;
  sync: number;
}

export async function handleStatsStreaks(input: StatsStreaksInput): Promise<StatsStreaksResult> {
  const todayStr = formatDate(input.now, input.timezone);
  const earliest = formatDate(input.now - MAX_LOOKBACK_DAYS * DAY_MS, input.timezone);

  const workoutDates = await uniqueDates(input.db,
    `SELECT date FROM workouts WHERE user_id = ? AND status = 'logged' AND date >= ?`,
    [input.userId, earliest]
  );

  const earliestMs = parseDate(earliest, input.timezone);
  const mealRows = await input.db.prepare(
    `SELECT eaten_at FROM meals WHERE user_id = ? AND eaten_at >= ?`
  ).bind(input.userId, earliestMs).all<{ eaten_at: number }>();
  const mealDates = new Set<string>();
  for (const m of mealRows.results ?? []) {
    mealDates.add(formatDate(m.eaten_at, input.timezone));
  }

  const syncDates = await uniqueDates(input.db,
    `SELECT date FROM readiness_daily WHERE user_id = ? AND status = 'ready' AND date >= ?`,
    [input.userId, earliest]
  );

  return {
    workouts: countStreak(workoutDates, todayStr, input.timezone, input.now),
    meals: countStreak(mealDates, todayStr, input.timezone, input.now),
    sync: countStreak(syncDates, todayStr, input.timezone, input.now),
  };
}

async function uniqueDates(db: D1Database, sql: string, binds: unknown[]): Promise<Set<string>> {
  const rows = await db.prepare(sql).bind(...binds).all<{ date: string }>();
  const out = new Set<string>();
  for (const r of rows.results ?? []) out.add(r.date);
  return out;
}

function countStreak(dates: Set<string>, todayStr: string, timezone: string, nowMs: number): number {
  if (!dates.has(todayStr)) return 0;
  let count = 0;
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    const t = nowMs - i * DAY_MS;
    const day = formatDate(t, timezone);
    if (!dates.has(day)) break;
    count++;
  }
  return count;
}

function formatDate(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function parseDate(date: string, timezone: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const localStr = new Date(utcMidnight).toLocaleString('sv-SE', { timeZone: timezone });
  const utcStr = new Date(utcMidnight).toLocaleString('sv-SE', { timeZone: 'UTC' });
  const offsetMin = (Date.parse(localStr + 'Z') - Date.parse(utcStr + 'Z')) / 60_000;
  return utcMidnight - offsetMin * 60_000;
}
