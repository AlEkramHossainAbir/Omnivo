import { createHash, randomBytes } from 'node:crypto';

// A share link's token (decision 13), like an invitation's: random bytes, and only the SHA-256 in
// the database. 16 bytes = 128 bits, which nobody can guess, in 22 base64url characters
// (SHARE_TOKEN_PATTERN), so the link stays short in a WhatsApp message. A fast hash is enough: the
// token is random, not a password a person chose.
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString('base64url');
  return { token, hash: hashShareToken(token) };
}
