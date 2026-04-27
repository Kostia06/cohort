import { signJwt } from '../../src/auth/jwt';

const TEST_SECRET = 'test-secret-at-least-32-characters-long';

export async function mintTestJwt(userId: string, expiresInSec = 3600): Promise<string> {
  return signJwt({ sub: userId }, TEST_SECRET, { expiresInSec });
}
