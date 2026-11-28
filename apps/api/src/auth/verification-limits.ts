import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS } from '../infra/tokens.js';

// How often one person may get a new link: "Send the link again" and every refused sign-in send
// one. Without a limit, a script could fill someone's inbox from the sign-in page with their
// address and any password... no: a refused sign-in needs the right password. But "Send the link
// again" needs only the address, so it is the one that must be limited.
const PER_MINUTE = 1;
const PER_HOUR = 5;

// The user id is hashed, like the shop's limits (storefront/orders/shop-limits.ts): Redis only has
// to tell two people apart, and a dump of it should not list who signed up when
function keyOf(window: 'minute' | 'hour', userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 32);
  return `verify-link:${window}:${digest}`;
}

// The count a MULTI reply holds at this position. ioredis gives [error, result] pairs, typed as
// unknown, so it is narrowed here instead of cast
function countAt(replies: [Error | null, unknown][] | null, index: number): number {
  const reply = replies?.[index];
  if (!reply || reply[0] !== null || typeof reply[1] !== 'number') {
    throw new Error('Redis did not count the verification link');
  }
  return reply[1];
}

@Injectable()
export class VerificationLimits {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // true = send a new link now. Counts the try either way, in one round trip: INCR first, so two
  // requests at the same moment cannot both see "0 so far". EXPIRE … NX starts each window at its
  // first count, and later counts do not move its end.
  //
  // Redis down is an error (500): letting links through without a limit would let a script through
  // too, and refusing quietly would leave the person without a link and no reason.
  async take(userId: string): Promise<boolean> {
    const minute = keyOf('minute', userId);
    const hour = keyOf('hour', userId);
    const replies = await this.redis
      .multi()
      .incr(minute)
      .expire(minute, 60, 'NX')
      .incr(hour)
      .expire(hour, 60 * 60, 'NX')
      .exec();
    return countAt(replies, 0) <= PER_MINUTE && countAt(replies, 2) <= PER_HOUR;
  }
}
