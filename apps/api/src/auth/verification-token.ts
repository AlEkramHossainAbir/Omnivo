import { createHash, randomBytes } from 'node:crypto';

// The email link's token, made like an invitation's (invitations/invitation-token.ts): 32 random
// bytes, and only the SHA-256 in the database. 256 random bits cannot be guessed, so a fast hash is
// enough; a slow one (bcrypt) would only make every link check slow
export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newVerificationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashVerificationToken(token) };
}
