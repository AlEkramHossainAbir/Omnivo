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
// a guesser would get `tries` from each; that is fine for one server, and step 27's real tracking
// moves the limit into the API, next to the orders.

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

// The part of an address that names one connection. An IPv4 address is one home or one phone (or
// many phones behind a mobile operator's shared address, which is why the form counts only misses).
// An IPv6 home or phone gets a whole /64 block: 18 billion billion addresses that are all the same
// person, so the key is the block, the first four groups. Without that, every miss could come from
// a new address and the limit would never be reached.
export function addressKey(address: string): string {
  // "%en0" is a link-local address's interface name, not part of the address
  const plain = address.trim().toLowerCase().replace(/%.*$/, '');
  // An IPv4 address written as IPv6 ("::ffff:203.0.113.7"), which Node gives on a server that
  // listens on both
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!plain.includes(':')) return plain;

  // "2001:db8::7" leaves out the groups that are zero. Put them back, so "2001:db8::7" and
  // "2001:db8:0:0::8" give the same /64
  const [head = '', tail] = plain.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  // Leading zeros dropped too ("0db8" and "db8" are the same group)
  const block = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''));
  return `${block.join(':')}::/64`;
}
