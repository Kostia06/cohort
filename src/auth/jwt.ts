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

  const key = await importKey(secret);
  const sigBytes = base64UrlDecode(sigB64);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) return null;

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
