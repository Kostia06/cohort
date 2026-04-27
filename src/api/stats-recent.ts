const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatsRecentInput {
  db: D1Database;
  userId: string;
  now: number;
  days: number;
  timezone: string;
}

export interface DayStats {
  date: string;
  readiness: {
    score: number | null;
    band: string | null;
    status: string;
  } | null;
  workouts: {
    logged: number;
    planned: number;
    skipped: number;
  };
  meals: {
    count: number;
    total_kcal: number;
  };
}

export interface StatsRecentResult {
  days: DayStats[];
}

export function formatDate(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(ms));
}

export function parseDate(date: string, timezone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const dt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  // Use the Date constructor with a timezone-aware approach.
  // Build midnight in local tz by finding the UTC ms where local date matches.
  const target = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Approximate: assume UTC offset is stable across the day range
  const probe = new Date(`${target}T12:00:00Z`).getTime();
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(probe);
  // Offset between UTC noon probe and local date
  const probeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(probe);
  const h = Number(probeParts.find(p => p.type === 'hour')?.value ?? 12);
  const m = Number(probeParts.find(p => p.type === 'minute')?.value ?? 0);
  // Offset in ms: probe is at UTC noon (43200000ms into day), local shows h:m
  const localMinutes = h * 60 + m;
  const utcMinutes = 12 * 60;
  const offsetMs = (utcMinutes - localMinutes) * 60 * 1000;
  // Midnight local = UTC midnight + offsetMs
  return new Date(`${target}T00:00:00Z`).getTime() + offsetMs;
}

export async function handleStatsRecent(input: StatsRecentInput): Promise<StatsRecentResult> {
  const clampedDays = Math.max(1, Math.min(90, Math.floor(input.days || 1)));

  const dates: string[] = [];
  for (let i = clampedDays - 1; i >= 0; i--) {
    const t = input.now - i * DAY_MS;
    dates.push(formatDate(t, input.timezone));
  }

  const earliest = dates[0]!;
  const latest = dates.at(-1)!;

  const readinessRows = await input.db.prepare(
    `SELECT date, score, band, status FROM readiness_daily
     WHERE user_id = ? AND date >= ? AND date <= ?`
  ).bind(input.userId, earliest, latest).all<{
    date: string; score: number | null; band: string | null; status: string;
  }>();

  const workoutRows = await input.db.prepare(
    `SELECT date, status, COUNT(*) AS cnt FROM workouts
     WHERE user_id = ? AND date >= ? AND date <= ?
     GROUP BY date, status`
  ).bind(input.userId, earliest, latest).all<{
    date: string; status: string; cnt: number;
  }>();

  const earliestMs = parseDate(earliest, input.timezone);
  const latestMs = parseDate(latest, input.timezone) + DAY_MS;
  const mealRows = await input.db.prepare(
    `SELECT eaten_at, kcal FROM meals
     WHERE user_id = ? AND eaten_at >= ? AND eaten_at < ?`
  ).bind(input.userId, earliestMs, latestMs).all<{ eaten_at: number; kcal: number | null }>();

  const readinessByDate = new Map<string, { score: number | null; band: string | null; status: string }>();
  for (const r of readinessRows.results ?? []) {
    readinessByDate.set(r.date, { score: r.score, band: r.band, status: r.status });
  }

  const workoutByDate = new Map<string, { logged: number; planned: number; skipped: number }>();
  for (const w of workoutRows.results ?? []) {
    const acc = workoutByDate.get(w.date) ?? { logged: 0, planned: 0, skipped: 0 };
    if (w.status === 'logged') acc.logged += w.cnt;
    else if (w.status === 'planned') acc.planned += w.cnt;
    else if (w.status === 'skipped') acc.skipped += w.cnt;
    workoutByDate.set(w.date, acc);
  }

  const mealsByDate = new Map<string, { count: number; total_kcal: number }>();
  for (const m of mealRows.results ?? []) {
    const date = formatDate(m.eaten_at, input.timezone);
    const acc = mealsByDate.get(date) ?? { count: 0, total_kcal: 0 };
    acc.count += 1;
    acc.total_kcal += m.kcal ?? 0;
    mealsByDate.set(date, acc);
  }

  return {
    days: dates.map((date) => ({
      date,
      readiness: readinessByDate.get(date) ?? null,
      workouts: workoutByDate.get(date) ?? { logged: 0, planned: 0, skipped: 0 },
      meals: mealsByDate.get(date) ?? { count: 0, total_kcal: 0 },
    })),
  };
}
