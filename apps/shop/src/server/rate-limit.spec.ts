import { describe, expect, it } from 'vitest';

import { addressKey, createRateLimiter } from './rate-limit';

// Step 26e: the misses limit and the address it counts by

const MINUTE = 60 * 1000;

// A limiter whose clock the test moves: 10 misses in 15 minutes, like the /track form
function withClock(maxKeys?: number) {
  let now = 0;
  const limiter = createRateLimiter({
    tries: 10,
    windowMs: 15 * MINUTE,
    now: () => now,
    ...(maxKeys === undefined ? {} : { maxKeys }),
  });
  return {
    limiter,
    wait: (ms: number) => {
      now += ms;
    },
  };
}

function missTimes(limiter: ReturnType<typeof createRateLimiter>, key: string, times: number) {
  for (let miss = 0; miss < times; miss += 1) limiter.miss(key);
}

describe('the misses limit', () => {
  it('lets ten misses through, then says how long to wait', () => {
    const { limiter } = withClock();
    missTimes(limiter, 'a', 9);
    expect(limiter.waitFor('a')).toBe(0);
    limiter.miss('a');
    expect(limiter.waitFor('a')).toBe(15 * 60);
  });

  it('ends the window 15 minutes after the first miss, and counts again from none', () => {
    const { limiter, wait } = withClock();
    limiter.miss('a');
    wait(10 * MINUTE);
    missTimes(limiter, 'a', 9);
    // Five minutes are left of the window that the first miss started
    expect(limiter.waitFor('a')).toBe(5 * 60);
    wait(5 * MINUTE);
    expect(limiter.waitFor('a')).toBe(0);
    // A new window: nine misses are not ten
    missTimes(limiter, 'a', 9);
    expect(limiter.waitFor('a')).toBe(0);
  });

  it('rounds the wait up, so it never says 0 while it still refuses', () => {
    const { limiter, wait } = withClock();
    missTimes(limiter, 'a', 10);
    wait(15 * MINUTE - 500);
    expect(limiter.waitFor('a')).toBe(1);
  });

  it('counts each key on its own', () => {
    const { limiter } = withClock();
    missTimes(limiter, 'a', 10);
    expect(limiter.waitFor('b')).toBe(0);
  });

  it('keeps no more keys than it may, dropping the oldest window', () => {
    const { limiter, wait } = withClock(2);
    missTimes(limiter, 'old', 10);
    wait(1 * MINUTE);
    missTimes(limiter, 'newer', 10);
    // Full: 'old' is the window that ends first, so it goes, though it is still open
    missTimes(limiter, 'third', 10);
    expect(limiter.waitFor('old')).toBe(0);
    expect(limiter.waitFor('newer')).toBeGreaterThan(0);
    expect(limiter.waitFor('third')).toBeGreaterThan(0);
  });

  it('adds to a key it keeps without dropping another', () => {
    const { limiter } = withClock(2);
    limiter.miss('a');
    limiter.miss('b');
    // Two keys, the most it may keep: more misses for them must not push either out
    missTimes(limiter, 'b', 9);
    missTimes(limiter, 'a', 9);
    expect(limiter.waitFor('a')).toBeGreaterThan(0);
    expect(limiter.waitFor('b')).toBeGreaterThan(0);
  });
});

describe('the address a miss counts against', () => {
  it('keeps an IPv4 address as it is, also when Node writes it as IPv6', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv6 address by its /64 block, however it is written', () => {
    const block = addressKey('2001:db8:1:2::a');
    expect(block).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(block);
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    // Zero groups left out before the fourth group are put back
    expect(addressKey('2001:db8::7')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it('gives two neighbouring blocks two keys', () => {
    expect(addressKey('2001:db8:1:2::a')).not.toBe(addressKey('2001:db8:1:3::a'));
  });
});
