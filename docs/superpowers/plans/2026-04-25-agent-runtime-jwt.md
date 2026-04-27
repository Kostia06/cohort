# Agent Runtime DO — Plan 5: JWT Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `X-User-Id` stub with JWT-based auth on every entrypoint. HS256 with a shared `JWT_SECRET`. Hand-rolled using WebCrypto — no new dependencies.

**Architecture:** A small `src/auth/jwt.ts` module with `verify(token, secret)` returning the decoded claims (or null). The api Worker reads `Authorization: Bearer <jwt>`, verifies it, extracts `sub` as `userId`. The DO no longer needs to read user_id from the request — the Worker has already done auth and forwards the trusted user_id internally.

**Tech Stack:** Same as Plans 1-4. No new deps. Uses WebCrypto's `crypto.subtle.importKey` + `crypto.subtle.verify`.

**Spec:** Builds on Plans 1-4. The original design spec assumed JWT auth as a deferred concern.

**Out of scope (deferred to dedicated plans):**
- Token issuance flow (Apple Sign In → JWT exchange). For dogfood, the user mints test JWTs with a CLI helper.
- Refresh tokens, key rotation, RS256 / Apple JWKS verification.
- Email magic links / web auth.
- Role-based authorization (everyone is just a user for v1).

---

## File Structure (changes from Plan 4)

```
src/
  auth/
    jwt.ts                              # NEW: hand-rolled HS256 verify (and a sign helper for tests/CLI)
  api/worker.ts                         # MODIFY: replace X-User-Id with Authorization: Bearer
  do/user-agent-do.ts                   # MODIFY: trust X-Internal-User-Id instead of X-User-Id

scripts/
  mint-jwt.ts                           # NEW: tiny CLI helper to mint a dev JWT

tests/
  unit/auth/
    jwt.test.ts                         # NEW
  fakes/jwt-helper.ts                   # NEW: shared sign helper for tests
  integration/
    do-flow.test.ts                     # MODIFY: tests now send Authorization: Bearer
    alarm.test.ts                       # MODIFY: same

worker-configuration.d.ts               # MODIFY: add JWT_SECRET to ProvidedEnv
```

---

## Phase 1: JWT module

### Task 1: HS256 verify + sign

**Files:**
- Create: `src/auth/jwt.ts`
- Create: `tests/unit/auth/jwt.test.ts`

WebCrypto-based HS256. `sign` is exposed alongside `verify` for tests and a CLI mint helper. The implementation is small (~80 lines).

- [ ] **Step 1: Write failing test `tests/unit/auth/jwt.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from '../../../src/auth/jwt';

const SECRET = 'test-secret-at-least-32-characters-long';

describe('JWT HS256 sign + verify', () => {
  it('round-trips a valid claim', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET, { expiresInSec: 3600 });
    const claims = await verifyJwt(token, SECRET);
    expect(claims?.sub).toBe('u1');
    expect(typeof claims?.exp).toBe('number');
  });

  it('rejects a token with wrong signature', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET, { expiresInSec: 3600 });
    // Flip a byte in the signature.
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.AAAA${parts[2]!.slice(4)}`;
    const claims = await verifyJwt(tampered, SECRET);
    expect(claims).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signJwt({ sub: 'u1' }, SECRET, { expiresInSec: -1 });
    const claims = await verifyJwt(token, SECRET);
    expect(claims).toBeNull();
  });

  it('rejects a malformed token', async () => {
    const claims = await verifyJwt('not.a.real.jwt', SECRET);
    expect(claims).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

`pnpm test tests/unit/auth/jwt.test.ts -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/jwt.ts`**

```ts
export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export interface SignOptions {
  expiresInSec: number;
}

export async function signJwt(
  claims: { sub: string; [key: string]: unknown },
  secret: string,
  opts: SignOptions
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: JwtClaims = {
    ...claims,
    sub: claims.sub,
    iat: now,
    exp: now + opts.expiresInSec
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(fullClaims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JwtClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;

  // Verify signature.
  const key = await importKey(secret);
  const sigBytes = base64UrlDecode(sigB64);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) return null;

  // Verify expiration.
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp < nowSec) return null;

  return claims;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
```

- [ ] **Step 4: Run test to confirm pass**

`pnpm test tests/unit/auth/jwt.test.ts -- --run`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add src/auth/jwt.ts tests/unit/auth/jwt.test.ts
git commit -m "Add HS256 JWT sign + verify"
```

---

## Phase 2: Wire into Worker + DO

### Task 2: Replace X-User-Id with Authorization: Bearer

**Files:**
- Modify: `src/api/worker.ts` — read Bearer token, verify, extract sub.
- Modify: `src/do/user-agent-do.ts` — trust an internal `X-Internal-User-Id` header set by the Worker (no longer read X-User-Id).
- Modify: `worker-configuration.d.ts` — add `JWT_SECRET` to ProvidedEnv.
- Modify: `src/types.ts` — add `JWT_SECRET: string` to `Env`.
- Modify: `vitest.config.ts` — add JWT_SECRET to test bindings.

The Worker is now the auth boundary. The DO trusts whatever the Worker forwards.

- [ ] **Step 1: Update `src/types.ts`**

Find the `Env` interface and add `JWT_SECRET: string`.

```ts
export interface Env {
  DB: D1Database;
  USER_AGENT_DO: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  AI_GATEWAY_URL: string;
  JWT_SECRET: string;
  MOCK_GATEWAY?: { fetch: typeof fetch };
}
```

- [ ] **Step 2: Update `worker-configuration.d.ts`**

Add `JWT_SECRET: string` to `ProvidedEnv`.

- [ ] **Step 3: Update `vitest.config.ts`**

In the `bindings` block (where ANTHROPIC_API_KEY and AI_GATEWAY_URL are set), add:
```ts
JWT_SECRET: 'test-secret-at-least-32-characters-long'
```

- [ ] **Step 4: Update `src/api/worker.ts`**

Replace every `req.headers.get('X-User-Id')` check with a JWT-based extraction. Add a helper near the top:

```ts
import { verifyJwt } from '../auth/jwt';

async function authenticateRequest(req: Request, env: Env): Promise<string | Response> {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response('missing or malformed Authorization', { status: 401 });
  }
  const token = auth.slice('Bearer '.length);
  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (!claims) return new Response('invalid or expired token', { status: 401 });
  return claims.sub;
}
```

Then in each route, replace the X-User-Id check. Example for /v1/chat/:

```ts
if (req.method === 'POST' && url.pathname.startsWith('/v1/chat/')) {
  const auth = await authenticateRequest(req, env);
  if (auth instanceof Response) return auth;
  const userId = auth;
  const threadId = url.pathname.slice('/v1/chat/'.length);
  const id = env.USER_AGENT_DO.idFromName(userId);
  const stub = env.USER_AGENT_DO.get(id);
  const innerUrl = new URL(`https://do/chat/${threadId}`);
  const innerReq = new Request(innerUrl, req);
  innerReq.headers.set('X-Internal-User-Id', userId);
  return stub.fetch(innerReq);
}
```

Apply the same pattern to `/v1/cancel/{thread_id}` and `/v1/run-batch/{user_id}`.

For `/v1/run-batch/{user_id}`: keep the path/header parity check, but compare path to the JWT-derived userId:
```ts
const pathUserId = url.pathname.slice('/v1/run-batch/'.length);
if (pathUserId !== userId) return new Response('user_id mismatch', { status: 403 });
```

- [ ] **Step 5: Update `src/do/user-agent-do.ts`**

The DO should now read `X-Internal-User-Id` (set by the Worker after auth) instead of `X-User-Id`. Find every `req.headers.get('X-User-Id')` in the DO and change to `req.headers.get('X-Internal-User-Id')`.

The DO remains the source of `userId` storage; the change is just which header it reads from.

- [ ] **Step 6: Run typecheck**

```
pnpm typecheck
```
Expected: exit 0.

- [ ] **Step 7: Commit**

```
git add src/types.ts src/api/worker.ts src/do/user-agent-do.ts worker-configuration.d.ts vitest.config.ts
git commit -m "Wire JWT verification into Worker and trust X-Internal-User-Id in DO"
```

---

### Task 3: Update integration tests + a JWT helper for tests

**Files:**
- Create: `tests/fakes/jwt-helper.ts` — `mintTestJwt(userId)` shared by all integration tests.
- Modify: `tests/integration/do-flow.test.ts` — use Bearer header.
- Modify: `tests/integration/alarm.test.ts` — same.

- [ ] **Step 1: Write `tests/fakes/jwt-helper.ts`**

```ts
import { signJwt } from '../../src/auth/jwt';

const TEST_SECRET = 'test-secret-at-least-32-characters-long';

export async function mintTestJwt(userId: string, expiresInSec = 3600): Promise<string> {
  return signJwt({ sub: userId }, TEST_SECRET, { expiresInSec });
}
```

(The test secret matches the value in vitest.config.ts.)

- [ ] **Step 2: Update `tests/integration/do-flow.test.ts`**

For every `headers: { 'X-User-Id': 'u1', ... }`, replace with:
```ts
headers: { 'Authorization': `Bearer ${await mintTestJwt('u1')}`, ... }
```

Add `import { mintTestJwt } from '../fakes/jwt-helper';` at the top.

The "rejects requests without X-User-Id" test should be renamed to "rejects requests without Authorization" and assert 401:
```ts
it('rejects requests without Authorization', async () => {
  const resp = await SELF.fetch('https://api/v1/chat/th1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hi' })
  });
  expect(resp.status).toBe(401);
});
```

Add a new test for invalid token:
```ts
it('rejects requests with an invalid token', async () => {
  const resp = await SELF.fetch('https://api/v1/chat/th1', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hi' })
  });
  expect(resp.status).toBe(401);
});
```

- [ ] **Step 3: Update `tests/integration/alarm.test.ts`**

Same pattern: replace X-User-Id headers with Bearer JWTs minted via `mintTestJwt`.

- [ ] **Step 4: Run all tests**

`pnpm test -- --run`
Expected: 67-68 PASS (66 + 1-2 new auth tests, depending on how many new tests you add).
`pnpm typecheck` — exit 0.

- [ ] **Step 5: Commit**

```
git add tests/fakes/jwt-helper.ts tests/integration/
git commit -m "Use Bearer JWT in integration tests"
```

---

## Phase 3: Dev-mint helper

### Task 4: CLI mint helper for local development

**Files:**
- Create: `scripts/mint-jwt.ts`

Tiny script the developer runs to get a dev JWT for local curl calls:

```ts
// scripts/mint-jwt.ts
import { signJwt } from '../src/auth/jwt';

async function main() {
  const userId = process.argv[2];
  const secret = process.env.JWT_SECRET ?? '';
  if (!userId) {
    console.error('usage: pnpm mint-jwt <user_id>');
    console.error('  (reads JWT_SECRET from env)');
    process.exit(1);
  }
  if (!secret) {
    console.error('JWT_SECRET env var is required');
    process.exit(1);
  }
  const token = await signJwt({ sub: userId }, secret, { expiresInSec: 24 * 60 * 60 });
  console.log(token);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Add a `package.json` script:
```json
"mint-jwt": "tsx scripts/mint-jwt.ts"
```

(If `tsx` isn't a dependency, the script can be invoked via `node --experimental-strip-types scripts/mint-jwt.ts` on Node 22+, OR the implementer can install `tsx` as a devDep.)

- [ ] **Step 1: Write the file**
- [ ] **Step 2: Add the npm script**
- [ ] **Step 3: Verify it runs**

```
JWT_SECRET=test-secret-at-least-32-characters-long pnpm mint-jwt u1
```
Expected: prints a JWT.

- [ ] **Step 4: Commit**

```
git add scripts/mint-jwt.ts package.json
git commit -m "Add mint-jwt CLI helper for local dev"
```

---

## Phase 4: Final readiness

### Task 5: Final check + runbook update

- [ ] **Step 1: Run + typecheck**

```
pnpm test -- --run
pnpm typecheck
```
Confirm counts.

- [ ] **Step 2: Append to runbook**

```markdown

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
    - Mint a token with a 1-second expiration:
      ```
      JWT_SECRET=$JWT_SECRET pnpm mint-jwt u1
      ```
      (For testing: temporarily edit the script to use `expiresInSec: 1`, mint, sleep 2, send → 401.)
    - Real refresh flow is deferred to a future plan.

## Plan 5 known limitations (deferred)

- **Token issuance flow** — Apple Sign In → JWT exchange. For now the user mints tokens manually with `pnpm mint-jwt`.
- **No refresh tokens** — clients re-mint when their token expires.
- **No JWKS / RS256** — single shared HMAC secret. Rotation requires a deploy.
- **No revocation** — short expiry (1h default in tests, 24h via `mint-jwt`) is the only invalidation mechanism.

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
```

- [ ] **Step 3: Commit**

```
git add docs/superpowers/runbooks/
git commit -m "Add Plan 5 JWT auth smoke checks"
```

---

## Self-review notes

- **Spec coverage:** JWT auth on every API entrypoint ✓; signature/expiration validation ✓; DO trusts internal header from authenticated Worker ✓.
- **Placeholder scan:** none.
- **Type consistency:** `JWT_SECRET` added to Env + ProvidedEnv + vitest config. `verifyJwt` returns nullable claims or null — callers narrow.
- **Scope:** 5 tasks. ~5 new tests (4 jwt unit + 1-2 auth integration). Total 66 → ~71.
