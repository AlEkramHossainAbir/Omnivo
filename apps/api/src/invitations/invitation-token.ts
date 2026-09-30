import { createHash, randomBytes } from 'node:crypto';

// refresh token-এর মতোই (packages/auth/refresh-token.ts): ৩২ random byte, DB-তে শুধু SHA-256। token নিজে
// 256-bit random, তাই অনুমান করা অসম্ভব — bcrypt-এর মতো ধীর hash লাগে না
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}
