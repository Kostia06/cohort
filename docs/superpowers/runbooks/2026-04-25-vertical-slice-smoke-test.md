# Vertical-Slice Smoke Test

After merging the agent runtime DO vertical slice, verify it works end-to-end against real Anthropic.

## Prereqs

- `wrangler` authenticated (`wrangler login`).
- An Anthropic API key set up: `wrangler secret put ANTHROPIC_API_KEY` (run from project root, paste your key when prompted).
- Cloudflare AI Gateway URL configured in `wrangler.toml` (`AI_GATEWAY_URL` var) or `.dev.vars`. Default placeholder is `https://gateway.ai.cloudflare.com/v1/REPLACE_ACCT/REPLACE_GW/anthropic` — replace with your gateway URL.

## Steps

1. Apply schema + seed a user:
```
pnpm db:apply
wrangler d1 execute cohort --local --command "INSERT INTO users (user_id, display_name, timezone, allergies_json, dislikes_json, daily_cost_cap_cents, created_at) VALUES ('u1','Alex','UTC','[]','[]',150,strftime('%s','now')*1000); INSERT INTO chat_threads (thread_id, user_id, kind, created_at) VALUES ('th1','u1','main',strftime('%s','now')*1000);"
```

2. Set local secret:
```
echo "ANTHROPIC_API_KEY=sk-ant-..." > .dev.vars
```

3. Start dev server:
```
pnpm dev
```

4. In another terminal, send a chat:
```
curl -N -X POST http://localhost:8787/v1/chat/th1 \
  -H "X-User-Id: u1" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"message":"what should I have for breakfast?"}'
```

5. Expected output:
   - SSE stream: `event: turn_started`, multiple `event: text_delta`, `event: turn_complete`.
   - Final response is a reasonable answer from Opus 4.7.

6. Verify D1:
```
wrangler d1 execute cohort --local --command "SELECT turn_id, status, substr(text,1,80) AS text FROM chat_turns ORDER BY started_at DESC LIMIT 1;"
```
   - Expected: one row with `status='complete'` and a non-empty text snippet.

## Failure modes

- `401 missing X-User-Id` — header was not sent.
- `409 turn_in_flight` — a previous turn is still streaming for this user; wait or use a different user_id.
- `Anthropic 401` — API key not configured. Check `.dev.vars`.
- `Anthropic 5xx` — provider issue; try again.
- Empty response with no SSE events — check console output of `wrangler dev` for errors.

## What this validates

Successful smoke test confirms the full vertical slice: HTTP routing → JWT-stub auth → DO dispatch → runtime context build → preflight → orchestrator with streaming → SSE response → D1 persistence. The next steps are Plan 2 (additional tools, post-review, idempotency replay, cost cap) and Plan 3 (alarm/batch, janitor, smoke automation).
