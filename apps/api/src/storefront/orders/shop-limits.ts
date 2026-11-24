import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  addressKey,
  SHOP_ORDER_WINDOW_MINUTES,
  SHOP_ORDERS_PER_ADDRESS,
  SHOP_ORDERS_PER_PHONE,
  SHOP_TRACK_TRIES,
  SHOP_TRACK_WINDOW_MINUTES,
} from '@omnivo/contracts';
import type { Redis } from 'ioredis';

import { REDIS } from '../../infra/tokens.js';

// One limit: so many in a window. Each key's window starts at its first count and ends
// windowMinutes later, like the shop's own limiter (26e). Two numbers per key, kept by Redis with
// its own expiry, so nothing here needs a timer or a cleanup job
interface Limit {
  name: string;
  max: number;
  windowMinutes: number;
}

const ORDERS_BY_PHONE: Limit = {
  name: 'orders-phone',
  max: SHOP_ORDERS_PER_PHONE,
  windowMinutes: SHOP_ORDER_WINDOW_MINUTES,
};
const ORDERS_BY_ADDRESS: Limit = {
  name: 'orders-address',
  max: SHOP_ORDERS_PER_ADDRESS,
  windowMinutes: SHOP_ORDER_WINDOW_MINUTES,
};
const TRACK_MISSES: Limit = {
  name: 'track-misses',
  max: SHOP_TRACK_TRIES,
  windowMinutes: SHOP_TRACK_WINDOW_MINUTES,
};

// The Redis key. The phone or the address is hashed: the limits need to tell two phones apart,
// not to read them, and a Redis dump should not be a list of who ordered in the last hour. Not per
// shop: a script that sends one phone a code from every shop on the platform is still one phone
function keyOf(limit: Limit, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `shop-limit:${limit.name}:${digest}`;
}

// Step 27a: the API's limits on the shop's order routes (27a's decisions 7 and 17), in Redis so
// every API process counts together. Each answer is the minutes to wait, 0 when there is none: the
// problem's params.minutes, which the shop's words put in "try again in 12 minutes".
//
// Redis down is an error here, so the route answers 500 and places nothing. Letting orders through
// without limits would let a script through too, and the code's SMS needs Redis anyway.
@Injectable()
export class ShopLimits {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // Before an order: whichever of its phone or its connection is over its limit, the longer wait
  async orderWait(phone: string, address: string): Promise<number> {
    const waits = await Promise.all([
      this.wait(ORDERS_BY_PHONE, phone),
      this.wait(ORDERS_BY_ADDRESS, addressKey(address)),
    ]);
    return Math.max(...waits);
  }

  // After an order was placed. Only a placed one counts: an order refused because its price
  // changed sent no SMS and holds no stock, and the shopper must be able to try again at once
  async countOrder(phone: string, address: string): Promise<void> {
    await Promise.all([
      this.count(ORDERS_BY_PHONE, phone),
      this.count(ORDERS_BY_ADDRESS, addressKey(address)),
    ]);
  }

  // The /track form: only its misses count (26e's decision 3), so a shopper who looks at their
  // own order ten times is never stopped
  trackWait(address: string): Promise<number> {
    return this.wait(TRACK_MISSES, addressKey(address));
  }

  async trackMiss(address: string): Promise<void> {
    await this.count(TRACK_MISSES, addressKey(address));
  }

  private async wait(limit: Limit, value: string): Promise<number> {
    const key = keyOf(limit, value);
    const count = Number((await this.redis.get(key)) ?? 0);
    if (count < limit.max) return 0;
    // The seconds left of the key's window. -1 (no expiry, which count() never leaves) or -2 (gone
    // since the get) wait one minute: never "wait 0 minutes" to someone who was just refused
    const seconds = await this.redis.ttl(key);
    return Math.max(1, Math.ceil(seconds / 60));
  }

  // INCR then EXPIRE … NX in one round trip: the first count starts the window, and later counts
  // do not move its end (NX: only when the key has no expiry yet)
  private async count(limit: Limit, value: string): Promise<void> {
    const key = keyOf(limit, value);
    await this.redis
      .multi()
      .incr(key)
      .expire(key, limit.windowMinutes * 60, 'NX')
      .exec();
  }
}
