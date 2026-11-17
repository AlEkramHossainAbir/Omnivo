// Step 26f.5 (decision 24): the shop's server keeps the API's answers for a short time. The API
// says no-store, because a cache in front of it would key an answer by its address and could hand
// one shop's page to another. This cache is inside the shop's server and keys every answer by the
// shop's host too, so it cannot.

// What is kept: the status and the body as JSON, before the contract's parse. The client parses
// each time it reads, so one cache holds every route's answer without a cast to each one's type
export interface ApiAnswer {
  status: number;
  body: unknown;
}

export interface AnswerCache {
  // The kept answer for this key, or the one `load` fetches. Callers that ask for the same key
  // while it is on the way share the one request
  read(key: string, load: () => Promise<ApiAnswer>): Promise<ApiAnswer>;
  readonly size: number;
}

interface Entry {
  expiresAt: number;
  answer: Promise<ApiAnswer>;
}

export function createAnswerCache({
  ttlMs,
  maxEntries,
  now = () => Date.now(),
}: {
  ttlMs: number;
  maxEntries: number;
  // For the tests, which move time
  now?: () => number;
}): AnswerCache {
  // A Map keeps the order keys went in, so its first key is the oldest. Dropping that one when the
  // map is full is enough here: every entry ends after ttlMs anyway
  const entries = new Map<string, Entry>();

  // Only the entry that failed: a newer one for the same key (asked after this one ended) stays
  function forget(key: string, entry: Entry) {
    if (entries.get(key) === entry) entries.delete(key);
  }

  return {
    read(key, load) {
      const at = now();
      const kept = entries.get(key);
      if (kept !== undefined && kept.expiresAt > at) return kept.answer;
      // Deleted before the set below, so the key moves to the end of the order (the newest)
      entries.delete(key);

      const entry: Entry = { expiresAt: at + ttlMs, answer: load() };
      entries.set(key, entry);
      // The map's size is the only thing that grows with traffic. A crawler walking every filter
      // of every shop makes new keys all day; without the limit they would fill the memory
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }

      // A failure is never kept: no answer at all (the API down, a timeout) or a 5xx. The next
      // page asks again instead of showing the error for 30 seconds. A 4xx is an answer ("no such
      // product") and is kept like a 200, so a wrong link asked again and again costs one request.
      // `void`: the caller awaits the same promise and handles its rejection; this branch only
      // tidies up, and its own rejection handler stops an "unhandled rejection"
      void entry.answer.then(
        (answer) => {
          if (answer.status >= 500) forget(key, entry);
        },
        () => {
          forget(key, entry);
        },
      );
      return entry.answer;
    },
    get size() {
      return entries.size;
    },
  };
}
