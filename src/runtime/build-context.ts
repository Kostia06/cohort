export interface BuildContextInput {
  db: D1Database;
  userId: string;
  threadId: string;
  actor: 'user' | 'system';
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  timezone: string;
  age_years: number | null;
  dietary_pattern: string | null;
  allergies: string[];
  dislikes: string[];
}

export interface RecentMessage {
  ordinal: number;
  actor: 'user' | 'assistant' | 'system';
  user_text: string | null;
  text: string | null;
}

export interface RuntimeContext {
  profile: UserProfile;
  recentMessages: RecentMessage[];
}

export async function buildContext(input: BuildContextInput): Promise<RuntimeContext> {
  const profileRow = await input.db.prepare(
    `SELECT user_id, display_name, timezone, age_years, dietary_pattern, allergies_json, dislikes_json
     FROM users WHERE user_id = ?`
  ).bind(input.userId).first<{
    user_id: string;
    display_name: string;
    timezone: string;
    age_years: number | null;
    dietary_pattern: string | null;
    allergies_json: string;
    dislikes_json: string;
  }>();

  if (!profileRow) throw new Error(`user not found: ${input.userId}`);

  const profile: UserProfile = {
    user_id: profileRow.user_id,
    display_name: profileRow.display_name,
    timezone: profileRow.timezone,
    age_years: profileRow.age_years,
    dietary_pattern: profileRow.dietary_pattern,
    allergies: JSON.parse(profileRow.allergies_json) as string[],
    dislikes: JSON.parse(profileRow.dislikes_json) as string[]
  };

  const limit = input.actor === 'user' ? 20 : 5;
  const rows = await input.db.prepare(
    `SELECT ordinal, actor, user_text, text
     FROM chat_turns
     WHERE thread_id = ? AND status = 'complete'
     ORDER BY ordinal DESC
     LIMIT ?`
  ).bind(input.threadId, limit).all<RecentMessage>();

  const recentMessages = (rows.results ?? []).reverse();
  return { profile, recentMessages };
}
