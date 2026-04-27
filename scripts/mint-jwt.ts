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
