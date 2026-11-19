// Step 26e: a limit on how often one connection may get something wrong, kept in the server's
// memory (decision 3). The /track form uses it: a wrong number and phone is the only answer a
// guesser gets, so the limit is what stops someone from walking through the order numbers with a
// phone they know.
//
// Each key has one window that starts at its first miss. When the window ends, the key starts
// again with none. A sliding window (every miss forgotten 15 minutes after it happened) would be a
// little smoother, but it has to keep every miss's time; this keeps two numbers per key, and a
// guesser still gets no more than `tries` misses in any one window.
//
// The memory is this process's. Two shop servers behind one address would each have their own, so
// a guesser would get `tries` from each; that is fine for one server.
//
// Step 27a: moved from server/ into the mock. The API keeps the real limit in Redis, next to the
// orders (shop-limits.ts), so only the mock source counts misses here (mock-source.ts). The key
// is made by addressKey() from @omnivo/contracts, the same function the API uses.

interface Window {
  misses: number;
  // When the window ends (milliseconds since 1970)
  endsAt: number;
}

export interface RateLimitOptions {
  // Misses allowed in one window
  tries: number;
  windowMs: number;
  // Passed in so a test can move time
  now?: () => number;
  // How many keys it keeps at most. A key is about 100 bytes, so 50,000 is a few megabytes, even
  // when someone sends misses from a huge number of addresses
  maxKeys?: number;
}

export interface RateLimiter {
  // Seconds until this key may try again: 0 when it may try now
  waitFor(key: string): number;
  // Counts one miss for this key
  miss(key: string): void;
}

export function createRateLimiter({
  tries,
  windowMs,
  now = () => Date.now(),
  maxKeys = 50_000,
}: RateLimitOptions): RateLimiter {
  const windows = new Map<string, Window>();

  // The key's window while it lasts. An ended one is deleted when it is asked for, so the limiter
  // needs no timer
  function current(key: string): Window | undefined {
    const window = windows.get(key);
    if (window && window.endsAt <= now()) {
      windows.delete(key);
      return undefined;
    }
    return window;
  }

  // Makes room for one more key by dropping the oldest window. A Map keeps its keys in the order
  // they were added, and every window has the same length, so the first key is the window that
  // ends first: it has ended already, or it is the closest to its end. If it is still open, that
  // key gets its tries back early, which is better than a server that runs out of memory
  function makeRoom(): void {
    const oldest = windows.keys().next();
    if (oldest.done !== true) windows.delete(oldest.value);
  }

  return {
    waitFor(key) {
      const window = current(key);
      if (!window || window.misses < tries) return 0;
      // Rounded up: "wait 0 seconds" would let the next try in too early
      return Math.ceil((window.endsAt - now()) / 1000);
    },

    miss(key) {
      const window = current(key);
      if (window) {
        window.misses += 1;
        return;
      }
      if (windows.size >= maxKeys) makeRoom();
      windows.set(key, { misses: 1, endsAt: now() + windowMs });
    },
  };
}
