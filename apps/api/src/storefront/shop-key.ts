import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from '../common/http/app-error.js';

// Step 27a: is this call from the shop's own server? (27a's decision 13.) The shop's server sends
// the key in SHOP_KEY_HEADER on every order route; the API's is STOREFRONT_SHOP_KEY.
//
// Both sides are hashed first, then compared with timingSafeEqual: a plain === stops at the first
// different character, so the time it takes tells a patient stranger how much of a guess was
// right. timingSafeEqual needs two buffers of one length, and two SHA-256 digests always are, so
// the length of the guess tells nothing either.
export function shopKeyMatches(sent: string | undefined, expected: string | null): boolean {
  // No key set on this API: no shop server may call the order routes (config.ts)
  if (expected === null || sent === undefined) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(sent), digest(expected));
}

// The one answer for a missing or a wrong key. 401: the call is not from someone the API knows
export function shopKeyInvalid(): AppError {
  return new AppError(
    401,
    'storefront_shop_key_invalid',
    "This route is for the shop's server, with its key in X-Shop-Key.",
  );
}
