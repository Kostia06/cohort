import { ulid } from 'ulid';
import type { RuntimeDeps, TurnInput, TurnResult } from '../types';
import { buildContext } from './build-context';
import { runOrchestrator } from './orchestrator';
import { finalizeChatTurn, insertChatTurnStreaming } from './persist';
import { preflightSafety, postReview } from './safety';

const SYSTEM_PROMPT_USER = `You are Cohort, a health and training coach. You have tools to read the user's profile, recent meals, readiness, and to log things on their behalf. Stay within scope: training, nutrition, sleep, recovery. Never give specific medication, diagnosis, or drug-interaction advice. Preserve hedging in research; never strengthen claims.`;
const SYSTEM_PROMPT_BATCH = `You are Cohort generating tomorrow's plan. Read the user's current state via tools, then propose a session and meals using propose_workout / propose_meals.`;

export async function runTurn(input: TurnInput, deps: RuntimeDeps): Promise<TurnResult> {
  const turnId = input.turnId ?? ulid();
  const now = deps.clock();

  if (input.actor === 'user') {
    const pf = preflightSafety(input.message ?? '');
    if (!pf.allow) {
      const inserted = await insertChatTurnStreaming({
        db: deps.db, turnId, threadId: input.threadId, actor: 'user',
        userText: input.message ?? null, idempotencyKey: input.idempotencyKey, now
      });
      if (!inserted.replay) {
        input.stream?.emit({ type: 'turn_started', data: { turn_id: inserted.turnId, ordinal: inserted.ordinal } });
        input.stream?.emit({ type: 'text_delta', data: { chunk: pf.cannedResponse ?? '' } });
        await finalizeChatTurn({
          db: deps.db, turnId: inserted.turnId, status: 'preflight_blocked',
          text: pf.cannedResponse ?? '', costUsd: 0, now: deps.clock()
        });
        input.stream?.emit({ type: 'turn_complete', data: { turn_id: inserted.turnId, full_text: pf.cannedResponse ?? '', cost_usd: 0 } });
        input.stream?.close();
      }
      return { turnId: inserted.turnId, status: 'preflight_blocked', text: pf.cannedResponse ?? '', costUsd: 0 };
    }
  }

  const inserted = await insertChatTurnStreaming({
    db: deps.db, turnId, threadId: input.threadId, actor: input.actor,
    userText: input.actor === 'user' ? (input.message ?? null) : null,
    idempotencyKey: input.idempotencyKey, now
  });
  if (inserted.replay) {
    return { turnId: inserted.turnId, status: 'complete', text: '', costUsd: 0 };
  }

  input.stream?.emit({ type: 'turn_started', data: { turn_id: inserted.turnId, ordinal: inserted.ordinal } });

  try {
    const context = await buildContext({
      db: deps.db, userId: input.userId, threadId: input.threadId, actor: input.actor
    });

    const messages = [
      ...buildHistoryMessages(context.recentMessages),
      ...(input.actor === 'user'
        ? [{ role: 'user' as const, content: input.message ?? '' }]
        : [{ role: 'user' as const, content: input.systemHint ?? 'Generate the requested plan.' }])
    ];

    const systemPrompt = `${input.actor === 'user' ? SYSTEM_PROMPT_USER : SYSTEM_PROMPT_BATCH}\n\nUser profile:\n${JSON.stringify(context.profile, null, 2)}`;

    const orch = await runOrchestrator({
      deps,
      userId: input.userId,
      threadId: input.threadId,
      turnId: inserted.turnId,
      systemPrompt,
      messages,
      emit: (e) => input.stream?.emit(e),
      signal: input.signal
    });

    await postReview(orch.text, deps.ai);

    await finalizeChatTurn({
      db: deps.db, turnId: inserted.turnId, status: 'complete',
      text: orch.text, costUsd: orch.costUsd, now: deps.clock()
    });
    input.stream?.emit({ type: 'turn_complete', data: { turn_id: inserted.turnId, full_text: orch.text, cost_usd: orch.costUsd } });
    input.stream?.close();
    return { turnId: inserted.turnId, status: 'complete', text: orch.text, costUsd: orch.costUsd };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    const status = isAbort ? 'cancelled' : 'error';
    await finalizeChatTurn({
      db: deps.db, turnId: inserted.turnId, status, text: '', costUsd: 0, error: message, now: deps.clock()
    });
    input.stream?.emit({ type: 'error', data: { message, retryable: !isAbort } });
    input.stream?.close();
    return { turnId: inserted.turnId, status, text: '', costUsd: 0 };
  }
}

function buildHistoryMessages(
  recent: Array<{ actor: 'user' | 'assistant' | 'system'; user_text: string | null; text: string | null }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of recent) {
    if (m.actor === 'user' && m.user_text) out.push({ role: 'user', content: m.user_text });
    else if (m.actor === 'assistant' && m.text) out.push({ role: 'assistant', content: m.text });
  }
  return out;
}
