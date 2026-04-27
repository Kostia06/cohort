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

---

## After Plan 3: tools + batch smoke checks

12. **Tools available:**
    Send a chat that should exercise tools, e.g. "what did I eat in the last week?" or "log: oatmeal 380 kcal at 7am". The response should include `tool_call_start`/`tool_call_result` SSE events for visible tools (`log_meal`, `propose_workout`, `compute_acwr`, `search_groceries`, `search_research`). Hidden tools (`get_user_profile`, `get_readiness`, `get_recent_meals`, `note_dislike`) emit no SSE.

13. **Batch turn:**
    After at least one chat (so the DO has cached user_id):
    ```
    curl -X POST http://localhost:8787/v1/run-batch/u1 -H "X-User-Id: u1"
    ```
    Expected: `{"ok":true,"status":"complete","turn_id":"..."}`. Check D1:
    ```
    wrangler d1 execute cohort --local --command "SELECT thread_id, actor, status, substr(text,1,80) FROM chat_turns WHERE actor='system' ORDER BY started_at DESC LIMIT 1;"
    ```
    Expected: one row with actor=system and a generated text.

14. **Stub tools (search_groceries, search_research):**
    Send a chat about groceries or research, e.g. "find me oats nearby" or "any research on creatine timing?". The orchestrator will call the stub tool; the tool returns `{error: 'not_yet_available'}` and the model should explain this gracefully to the user.

## Plan 3 Known limitations (deferred to Plan 4+)

- **Cold-DO alarm gap:** `userId` is cached in-memory in the DO. If the DO is evicted (long idle) and then the alarm fires on a fresh instance, the alarm silently no-ops because `cachedUserId` is null. Workaround: chat at least once per cold-start window; durable fix is to switch to `state.storage` with proper test isolation.
- **No cron trigger:** the alarm endpoint exists but no `[triggers] crons` entry in wrangler.toml fires it. Plan 4 wires this up.
- **`grocery-worker` and `research-worker`** are stubs returning "not_yet_available". The real Workers (per the original deep-dive doc) are separate plans.

## Plan 1 → Plan 2 → Plan 3 capability matrix

| Capability | P1 | P2 | P3 |
|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ |
| One tool (get_user_profile) | ✓ | ✓ | ✓ |
| 8 more tools | ✗ | ✗ | ✓ |
| Preflight safety | ✓ | ✓ | ✓ |
| Post-stream review (Haiku) | stub | ✓ | ✓ |
| Anthropic 5xx retry | ✗ | ✓ | ✓ |
| Cancel endpoint | ✗ | ✓ | ✓ |
| SSE replay on idempotency | ✗ | ✓ | ✓ |
| Daily cost cap | ✗ | ✓ | ✓ |
| Batch turn | ✗ | ✗ | ✓ (manual trigger) |
| Cron trigger | ✗ | ✗ | ✗ (Plan 4) |
| JWT auth | ✗ | ✗ | ✗ (Plan 4+) |
| Janitor cron | ✗ | ✗ | ✗ (Plan 4) |

---

## After Plan 4: cron + janitor + per-thread cancel + calendar-day cap

15. **Janitor sweep:**
    - Insert a stuck row:
      ```
      wrangler d1 execute cohort --local --command "INSERT INTO chat_turns (turn_id, thread_id, ordinal, actor, status, started_at) VALUES ('stuck','th1',99,'user','streaming',$(($(date +%s) - 600))*1000);"
      ```
    - Trigger the cron manually (only works when `wrangler dev --test-scheduled` is running):
      ```
      curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*%2F5+*+*+*+*'
      ```
    - Check: `wrangler d1 execute cohort --local --command "SELECT status, error FROM chat_turns WHERE turn_id='stuck';"` → expects `error / janitor_sweep`.

16. **Batch cron (manual trigger):**
    - Confirm a user has a timezone where their current local hour is 5am. Example for testing:
      ```
      wrangler d1 execute cohort --local --command "UPDATE users SET timezone='Etc/GMT-$(date -u +%H | sed 's/^0//')' WHERE user_id='u1';"
      ```
    - Trigger the cron: `curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*'`
    - Check: `wrangler d1 execute cohort --local --command "SELECT thread_id, actor, status FROM chat_turns WHERE actor='system' ORDER BY started_at DESC LIMIT 1;"` should show a system turn.

17. **Per-thread cancel:**
    - Start a long chat on thread A:
      ```
      curl -N -X POST http://localhost:8787/v1/chat/thA -H "X-User-Id: u1" -H "Content-Type: application/json" -d '{"message":"explain creatine timing in detail"}'
      ```
    - In another terminal cancel a different thread B:
      ```
      curl -X POST http://localhost:8787/v1/cancel/thB -H "X-User-Id: u1"
      ```
    - Expected: 409 with body `{"cancelled": false, "reason": "in-flight turn is on a different thread", "in_flight_thread_id": "thA"}`.
    - Then cancel the correct thread:
      ```
      curl -X POST http://localhost:8787/v1/cancel/thA -H "X-User-Id: u1"
      ```
    - Expected: 200 with `{"cancelled": true, "turn_id": "..."}`.

18. **Calendar-day cost cap:**
    - Set the cap to a low value: `wrangler d1 execute cohort --local --command "UPDATE users SET daily_cost_cap_cents=1 WHERE user_id='u1';"`
    - Make sure there's prior cost: `wrangler d1 execute cohort --local --command "INSERT INTO chat_turns (turn_id,thread_id,ordinal,actor,status,cost_usd,started_at,ended_at) VALUES ('seed','th1',999,'user','complete',0.10, strftime('%s','now')*1000, strftime('%s','now')*1000);"`
    - Send a chat → expect cap_exceeded.
    - Wait until local midnight (or fudge the started_at to be from yesterday) — the cap should reset.
    - Reset cap: `wrangler d1 execute cohort --local --command "UPDATE users SET daily_cost_cap_cents=150 WHERE user_id='u1';"`

## Plan 4 known limitations (deferred to Plan 5)

- **Cron triggers only fire on deploy.** Local `wrangler dev` doesn't run crons automatically; use `--test-scheduled` and the manual handler URLs above.
- **Batch trigger iterates ALL users every hour.** O(N) scan is fine for v1 dogfood; at scale, store a `next_batch_at` column or use a per-hour bucket index.
- **JWT auth still deferred** — `X-User-Id` header is still trusted on every request. Plan 5.
- **Real grocery / research workers** still stubs.
- **HealthKit sync** still external.

## P1 → P2 → P3 → P4 capability matrix

| Capability | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ |
| 9 tools (1 + 8) | 1 | 1 | 9 | 9 |
| Preflight safety | ✓ | ✓ | ✓ | ✓ |
| Post-stream review (Haiku) | stub | ✓ | ✓ | ✓ |
| Anthropic 5xx retry | ✗ | ✓ | ✓ | ✓ |
| Cancel endpoint | ✗ | DO-wide | DO-wide | per-thread |
| SSE replay on idempotency | ✗ | ✓ | ✓ | ✓ |
| Daily cost cap | ✗ | rolling 24h | rolling 24h | calendar-day local-tz |
| Batch turn endpoint | ✗ | ✗ | manual | cron |
| Janitor sweep | ✗ | ✗ | ✗ | cron |
| JWT auth | ✗ | ✗ | ✗ | ✗ (Plan 5) |

---

## After Plan 5: JWT auth

**Setup:** before any smoke step that hits the API, generate a token:
```
JWT_SECRET=<your-secret> pnpm mint-jwt u1 > /tmp/cohort-token
TOKEN=$(cat /tmp/cohort-token)
```
Set `JWT_SECRET` as a dev secret: `wrangler secret put JWT_SECRET` (interactive) or in `.dev.vars`.

19. **Auth required:**
    - Send a chat WITHOUT Authorization header → 401.
    - Send with bad token → 401.
    - Send with valid token → success.
    ```
    curl -X POST http://localhost:8787/v1/chat/th1 -H "Content-Type: application/json" -d '{"message":"hi"}'
    # → 401

    curl -X POST http://localhost:8787/v1/chat/th1 -H "Authorization: Bearer junk" -H "Content-Type: application/json" -d '{"message":"hi"}'
    # → 401

    curl -N -X POST http://localhost:8787/v1/chat/th1 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"message":"hi"}'
    # → SSE stream
    ```

20. **Token expiration:**
    - For a short-lived test, edit `scripts/mint-jwt.ts` temporarily to use `expiresInSec: 1`, mint, sleep 2, send → 401.
    - Real refresh flow is deferred to a future plan.

## Plan 5 known limitations (deferred)

- **Token issuance flow** — Apple Sign In → JWT exchange. For now the user mints tokens manually with `pnpm mint-jwt`.
- **No refresh tokens** — clients re-mint when their token expires.
- **No JWKS / RS256** — single shared HMAC secret. Rotation requires a deploy.
- **No revocation** — short expiry (24h via `mint-jwt`) is the only invalidation mechanism.

## P1 → P5 capability matrix

| Capability | P1 | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tools | 1 | 1 | 9 | 9 | 9 |
| Preflight + post-review | partial | ✓ | ✓ | ✓ | ✓ |
| Anthropic 5xx retry | ✗ | ✓ | ✓ | ✓ | ✓ |
| Cancel | ✗ | DO-wide | DO-wide | per-thread | per-thread |
| SSE replay | ✗ | ✓ | ✓ | ✓ | ✓ |
| Daily cost cap | ✗ | rolling 24h | rolling 24h | calendar-day | calendar-day |
| Batch turn | ✗ | ✗ | manual | cron | cron |
| Janitor | ✗ | ✗ | ✗ | ✓ | ✓ |
| Auth | X-User-Id | X-User-Id | X-User-Id | X-User-Id | JWT (HS256) |

---

## After Plan 6: research-worker

**Setup (one-time, requires Cloudflare auth):**
```
wrangler vectorize create cohort-research --dimensions=1024 --metric=cosine
wrangler r2 bucket create cohort-research
wrangler secret put ADMIN_SECRET --config services/research/wrangler.toml
wrangler secret put ANTHROPIC_API_KEY --config services/research/wrangler.toml
wrangler deploy --config services/research/wrangler.toml
```

Then re-deploy the api Worker so the service binding takes effect:
```
wrangler deploy
```

21. **Upload a paper:**
    ```
    curl -X POST https://cohort-research.<your-subdomain>.workers.dev/papers \
      -H "X-Admin-Secret: $ADMIN_SECRET" \
      -H "X-Hint-Domain: training" \
      -H "Content-Type: application/pdf" \
      --data-binary @path/to/paper.pdf
    ```
    Expected response: `{"paper_id":"...","status":"ready","chunk_count":N}`. Takes 30-60s for one paper.

    Check D1:
    ```
    wrangler d1 execute cohort --command "SELECT id, title, status, evidence_grade FROM research_papers ORDER BY added_at DESC LIMIT 5;"
    ```

22. **Search via the agent:**
    Send a chat that should trigger `search_research`:
    ```
    curl -N -X POST https://<your-api>.workers.dev/v1/chat/th1 \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"message":"any research on creatine timing?"}'
    ```
    Expected SSE: `tool_call_start` for `search_research`, `tool_call_result` with a summary, then text from the model citing the paper title in its response.

23. **Direct search test:**
    Bypass the agent and call the research worker directly:
    ```
    curl -X POST https://cohort-research.<your-subdomain>.workers.dev/search \
      -H "Content-Type: application/json" \
      -d '{"query":"creatine timing","k":3}'
    ```
    Expected: JSON with up to 3 matches, each with paper metadata + chunk text + summaries.

## Plan 6 known limitations (deferred)

- **Synchronous ingest** — `/papers` blocks for ~30-60s while extracting + embedding. v2 will move to a Cloudflare Queue.
- **No OCR fallback** — scanned PDFs return `status='needs_ocr'`; admin must re-upload with text-extracted version.
- **Vectorize index is shared across users** — papers are global. Multi-tenant access control deferred.
- **Summary regeneration endpoint** is missing; tweaking the prompts requires re-uploading the paper.
- **No admin UI** — `curl` is the only upload path.

## Final P1 → P6 capability matrix

| Capability | P1 | P2 | P3 | P4 | P5 | P6 |
|---|---|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tools | 1 | 1 | 9 | 9 | 9 | 9 |
| Preflight + post-review | partial | ✓ | ✓ | ✓ | ✓ | ✓ |
| Anthropic 5xx retry | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cancel | ✗ | DO-wide | DO-wide | per-thread | per-thread | per-thread |
| SSE replay | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Daily cost cap | ✗ | rolling 24h | rolling 24h | calendar-day | calendar-day | calendar-day |
| Batch turn | ✗ | ✗ | manual | cron | cron | cron |
| Janitor | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Auth | X-User-Id | X-User-Id | X-User-Id | X-User-Id | JWT (HS256) | JWT (HS256) |
| `search_groceries` | ✗ | ✗ | stub | stub | stub | stub |
| `search_research` | ✗ | ✗ | stub | stub | stub | **real (Vectorize RAG)** |

---

## After Plan 7: grocery-worker

**Setup (one-time):**
```
wrangler kv:namespace create GROCERY_KV
# paste returned id into services/grocery/wrangler.toml
wrangler secret put GOOGLE_PLACES_KEY --config services/grocery/wrangler.toml
wrangler secret put USDA_API_KEY --config services/grocery/wrangler.toml
wrangler deploy --config services/grocery/wrangler.toml
wrangler deploy
```

**Seed Calgary price estimates:**
```
node -e 'const e=require("./services/grocery/src/seed-estimates.json"); console.log(e.map(x=>"INSERT INTO price_estimates (category, region, price, currency, unit) VALUES ('"'"'"+x.category+"'"'"','"'"'"+x.region+"'"'"',"+x.price+",'"'"'"+x.currency+"'"'"','"'"'"+x.unit+"'"'"');").join("\n"))' | tee /tmp/seed.sql
wrangler d1 execute cohort --remote --file=/tmp/seed.sql
```

24. **Direct grocery search:**
    ```
    curl -X POST https://cohort-grocery.<your>.workers.dev/search \
      -H "Content-Type: application/json" \
      -d '{"items":["rolled oats","chicken breast"],"lat":51.05,"lng":-114.07,"radius_m":5000,"region":"calgary"}'
    ```
    Expected: JSON `{results: [{query, matches: [{product, store, price}, ...]}]}`. Each price has `source: 'estimate'` for v1.

25. **Search via the agent:**
    ```
    curl -N -X POST https://<your-api>.workers.dev/v1/chat/th1 \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"message":"what are oats and chicken going for nearby? im at 51.05, -114.07"}'
    ```
    Expected SSE: `tool_call_start` for `search_groceries`, `tool_call_result` summary, then text mentioning a couple stores + estimated prices.

26. **Community price submission:** not yet exposed; deferred to a future plan.

## Plan 7 known limitations (deferred)

- **No real-time chain prices** — Calgary chains have no public APIs in v1. Static estimates + (future) community submissions only.
- **Category mapping is hardcoded** in `inferCategory`. Extending requires editing the function. LLM-based mapping is a future plan.
- **No store-level prices** — each store gets the same regional estimate.
- **No haversine sort** — stores returned in Google's order; not sorted by distance.
- **No per-tenant data** — papers and grocery results are global.

## Final P1 → P7 capability matrix

| Capability | P1 | P2 | P3 | P4 | P5 | P6 | P7 |
|---|---|---|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tools | 1 | 1 | 9 | 9 | 9 | 9 | 9 |
| Preflight + post-review | partial | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Anthropic 5xx retry | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cancel | ✗ | DO-wide | DO-wide | per-thread | per-thread | per-thread | per-thread |
| SSE replay | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Daily cost cap | ✗ | rolling 24h | rolling 24h | calendar-day | calendar-day | calendar-day | calendar-day |
| Batch turn | ✗ | ✗ | manual | cron | cron | cron | cron |
| Janitor | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Auth | X-User-Id | X-User-Id | X-User-Id | X-User-Id | JWT (HS256) | JWT (HS256) | JWT (HS256) |
| `search_research` | ✗ | ✗ | stub | stub | stub | **real** | real |
| `search_groceries` | ✗ | ✗ | stub | stub | stub | stub | **real (Calgary v1)** |

---

## After Plan 8: HealthKit sync + readiness scoring

27. **Sync a daily sample (calibrating phase):**
    ```
    curl -X POST https://<your-api>.workers.dev/v1/healthkit/sync \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"date":"2026-04-25","hrv_sdnn_ms":50,"rhr_bpm":60,"sleep_minutes":480,"time_in_bed_minutes":510}'
    ```
    Expected: 200 with `{readiness: {status: 'calibrating', score: null, ...}}` for the first 14 days.

28. **Sync 14+ days then check readiness:**
    Backfill 14 days of samples (script or repeated curls), then sync today.
    Expected: 200 with `{readiness: {status: 'ready', score: <0..100>, band: 'rest'|'easy'|'normal'|'green', components: {...}, reasons: [...]}}`.

29. **Verify `get_readiness` tool now returns data:**
    ```
    curl -N -X POST https://<your-api>.workers.dev/v1/chat/th1 \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"message":"what is my readiness today?"}'
    ```
    The orchestrator calls `get_readiness`; it now returns the latest `readiness_daily` row and the model can talk about the band + reasons.

30. **Integration with batch turn:**
    The 5am cron-fired batch turn calls `get_readiness` as part of generating tomorrow's plan. With real readiness data, the agent can dial volume up/down based on band.

## Plan 8 known limitations (deferred)

- **No Flutter HealthKit reader** — server endpoint is ready; iOS-side code is its own project.
- **No multi-device dedup** — assume one source of truth per (user_id, date). Multiple uploads on the same date overwrite.
- **No backfill endpoint** — bulk historical sync is a single-row API that the client must loop over. A `/sync/batch` taking an array could come later.
- **Age-based target only** — sleep target is 540 min for under-18, 480 otherwise. No personalization or sleep-need detection.

## Final P1 → P8 capability matrix

| Capability | P1-P5 | P6 | P7 | P8 |
|---|---|---|---|---|
| Streaming chat | ✓ | ✓ | ✓ | ✓ |
| 9 tools | ✓ | ✓ | ✓ | ✓ |
| Full hardening (retry, cancel, replay, cap, batch, janitor, JWT) | ✓ | ✓ | ✓ | ✓ |
| `search_research` | stub→**real** | real | real | real |
| `search_groceries` | stub | stub | **real** | real |
| `get_readiness` | always null | always null | always null | **real (after 14d calibration)** |
| HealthKit sync endpoint | ✗ | ✗ | ✗ | ✓ |

---

## After Plan 9: Flutter MVP

**Setup:**
```
cd mobile
flutter pub get
# Open in Xcode for first run + simulator selection
open ios/Runner.xcworkspace
```

Then to run on the simulator:
```
flutter run
```

**In-app config:**
- Tap the gear icon, paste a token from `pnpm mint-jwt u1` (run from the repo root with `JWT_SECRET=...`).
- Set Base URL to your dev Worker URL or `http://localhost:8787` (note: simulator can hit localhost; physical device needs your dev tunnel URL).

31. **Chat round-trip:**
    - Type "hi" and tap send. Expect SSE bubble that streams text. Tool events appear above the text.
    - Tap stop while streaming → cancel triggers.

32. **HealthKit sync test:**
    - Open the heart icon in the app bar.
    - Adjust HRV/RHR/sleep numbers and tap Sync today.
    - Result panel shows the readiness payload (calibrating until 14 days of history; otherwise score + band).

## Plan 9 known limitations

- **No real HealthKit reader** — manual numbers only. Plan 10 will add the iOS HealthKit integration.
- **No Apple Sign In** — JWT is pasted manually.
- **No plan view** — chat-only UI; the daily plan from `/v1/run-batch` is not rendered yet.
- **No iOS push notifications** — APN integration is its own future plan.
- **Single thread (`main`)** — multi-thread support is a UI feature, not a server one.
- **Android build is generated but untested** — iOS only for v1.

---

## After Plan 10: real HealthKit reader

**Setup (iOS device only — simulator does not surface real Health data):**
1. Open `mobile/ios/Runner.xcworkspace` in Xcode.
2. Select the Runner target → Signing & Capabilities → ensure HealthKit capability is enabled (if it's missing, click "+ Capability" and add it).
3. Pair a physical iPhone, sign in with your Apple ID, set a development team on the Runner target, and run.

33. **Permission flow (first run):**
    - Open the Sync screen, tap "Read last night from Health".
    - iOS shows the Health permission prompt; allow access to HRV / Resting HR / Sleep.
    - The form auto-fills with last night's values.

34. **Sync to server:**
    - With values filled, tap "Sync today".
    - Server returns the readiness payload (calibrating until 14 days of history; otherwise score + band).

35. **Manual override:**
    - You can still edit any field after the auto-fill before syncing.

## Plan 10 known limitations

- **Foreground only** — user must open the app to trigger a sync. Background delivery (HealthKit observer queries that wake the app) is its own future plan.
- **iOS only** — Android Health Connect is supported by the `health` package but not configured here.
- **Last night only** — no historical backfill API. Bulk import would loop the per-day endpoint.
- **No source preference** — if Apple Watch and a third-party app both write HRV, we use whichever the most recent sample comes from.

---

## After Plan 11: Today view

36. **Empty state:** open the app on a fresh user. Today tab shows placeholders ("No reading yet today", "No workout proposed yet", "No meals logged in the last 24 hours").

37. **Populated state:**
    - Sync HealthKit (Sync tab → Read from Health → Sync today). After 14d of history this returns a real readiness band.
    - Run the batch turn (`curl -X POST .../v1/run-batch/u1 -H "Authorization: Bearer $TOKEN"` or wait until 5am local).
    - Pull-to-refresh on the Today tab. Readiness card shows score + band, Today's plan card shows the proposed workout, Latest from Cohort card shows the assistant's batch message.

38. **Auth check:** Today tab displays a "Configure JWT" message if settings aren't set.

## Plan 11 known limitations

- **No interactivity** — tap-to-start workout, mark workout done, log meal from Today, etc. are not yet wired. Planned for Plan 12+.
- **No multi-day timeline** — only "today". Yesterday's reflection / tomorrow's preview is a future plan.
- **Latest assistant message is uncurated** — picks the latest `chat_turn` regardless of thread. Multi-thread filtering is a future plan.
