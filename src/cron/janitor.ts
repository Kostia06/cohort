const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export async function runJanitor(db: D1Database, now: number): Promise<{ swept: number }> {
  const cutoff = now - STALE_THRESHOLD_MS;
  const result = await db.prepare(
    `UPDATE chat_turns
     SET status = 'error', error = 'janitor_sweep', ended_at = ?
     WHERE status = 'streaming' AND started_at < ?`
  ).bind(now, cutoff).run();
  return { swept: result.meta.changes ?? 0 };
}
