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

---

## After Plan 2: additional smoke checks

7. **Replay test:**
   - Send the same chat with the same `Idempotency-Key` twice.
   - Second response should be near-instant and contain the same `turn_id` plus the same text.
   - Example:
     ```
     KEY=$(uuidgen)
     for i in 1 2; do
       curl -N -X POST http://localhost:8787/v1/chat/th1 \
         -H "X-User-Id: u1" -H "Content-Type: application/json" \
         -H "Idempotency-Key: $KEY" \
         -d '{"message":"what should I have for breakfast?"}'
       echo "---"
     done
     ```

8. **Cancel test:**
   - In one terminal, start a chat (don't close it):
     ```
     curl -N -X POST http://localhost:8787/v1/chat/th1 \
       -H "X-User-Id: u1" -H "Content-Type: application/json" \
       -d '{"message":"explain creatine timing in detail"}'
     ```
   - In another terminal, immediately POST to /cancel:
     ```
     curl -X POST http://localhost:8787/v1/cancel/th1 -H "X-User-Id: u1"
     ```
   - Expected: cancel response `{"cancelled": true, "turn_id": "..."}` (200) or `{"cancelled": false, "reason": "no in-flight turn"}` (404) if the turn already completed.

9. **Cost cap test:**
   - Set the user's cap to 1 cent:
     ```
     wrangler d1 execute cohort --local --command "UPDATE users SET daily_cost_cap_cents=1 WHERE user_id='u1';"
     ```
   - After at least one prior chat (which logs cost), send a new chat.
   - Expected SSE: single `text_delta` with the cap message + `turn_complete`. The persisted turn has `status='cap_exceeded'`.
   - Reset the cap when done:
     ```
     wrangler d1 execute cohort --local --command "UPDATE users SET daily_cost_cap_cents=150 WHERE user_id='u1';"
     ```

10. **5xx retry behavior:**
    - This is harder to test manually since we can't induce a 5xx from Anthropic on demand. The retry logic is unit-tested.
    - If you want to verify, deploy with `AI_GATEWAY_URL` pointed at a non-existent endpoint briefly: the request should take ~1s longer than usual (one retry) before failing.

11. **postReview corrigendum:**
    - Send a message designed to elicit borderline content (e.g., "what's a good caffeine dosing strategy for a long ride?").
    - The response may include a `corrigendum` SSE event with a safety note appended.
    - Verify by checking the persisted turn's `text` includes the appended note.

## What Plan 2 adds vs. Plan 1

| Capability | Plan 1 | Plan 2 |
|---|---|---|
| Streaming chat | ✓ | ✓ |
| One tool (get_user_profile) | ✓ | ✓ |
| Preflight safety | ✓ | ✓ |
| Post-stream review (Haiku) | stub | real |
| Anthropic 5xx retry | ✗ | ✓ (1× backoff) |
| Cancel endpoint | ✗ | ✓ |
| SSE replay on idempotency | ✗ | ✓ |
| Daily cost cap | ✗ | ✓ |
| Remaining 8 tools | ✗ | ✗ (Plan 3) |
| 5am batch alarm | ✗ | ✗ (Plan 3) |
| JWT auth | ✗ | ✗ (Plan 3+) |
