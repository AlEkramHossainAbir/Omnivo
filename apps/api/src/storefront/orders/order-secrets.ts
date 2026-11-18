import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { SHOP_CODE_LENGTH } from '@omnivo/contracts';

// Step 27a: the order's two tokens and its phone code. Only hashes reach the database
// (storefront_orders_hashes_check: 64 lower-case hex characters).

// A token: 16 random bytes as base64url, 22 characters (shopOrderTokenSchema and
// shopTrackingTokenSchema). 128 bits cannot be guessed, so the token alone opens what it opens
export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

// What the database keeps of a token: its SHA-256 (as document_shares does since step 16). A
// plain hash is enough here, unlike the code's: 128 random bits cannot be found by trying them
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Six digits, every one of the million equally likely. randomInt, never Math.random: the code is
// what stands between a stranger and an order placed in someone else's name
export function newCode(): string {
  return String(randomInt(0, 10 ** SHOP_CODE_LENGTH)).padStart(SHOP_CODE_LENGTH, '0');
}

// What the database keeps of a code: an HMAC with the API's own key (config.storefront.codeKey)
// over the order's token hash and the code. A plain SHA-256 of six digits is undone by trying all
// million, which a laptop does in a second; without the key, a leaked dump gives nothing. The
// token hash binds the code to its order, so a code's hash copied onto another order is no use
export function codeHash(key: Buffer, orderTokenHash: string, code: string): string {
  return createHmac('sha256', key).update(`${orderTokenHash}:${code}`).digest('hex');
}

// Compared in constant time, like the shop key (shop-key.ts). Both are 64 hex characters, so the
// buffers have one length; a stored value of another length is a broken row, and never matches
export function codeMatches(
  key: Buffer,
  orderTokenHash: string,
  code: string,
  stored: string,
): boolean {
  const sent = Buffer.from(codeHash(key, orderTokenHash, code), 'hex');
  const kept = Buffer.from(stored, 'hex');
  return sent.length === kept.length && timingSafeEqual(sent, kept);
}
