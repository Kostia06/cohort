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
