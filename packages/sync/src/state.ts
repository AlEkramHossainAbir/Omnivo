import type { PullState, SyncDatabase } from './database.js';

export const NO_PULL: PullState = {
  key: 'pull',
  cursor: null,
  generation: 0,
  full: false,
  lastSyncAt: null,
  syncedAt: null,
  copied: 0,
};

// Where the pull is. Type imports only: a page reads it (for "1,250 items copied so far") without
// loading Dexie; the database object comes from the code that opened it. Spread over NO_PULL: a
// row saved by an older version of the app lacks the fields added since (syncedAt, step 18c).
export async function readPullState(db: SyncDatabase): Promise<PullState> {
  const saved = await db.meta.get('pull');
  return saved ? { ...NO_PULL, ...saved } : NO_PULL;
}

// Step 18c: when the last pull ended, on this device's clock, for the time limits (syncAge in the
// contracts). Both ends of "how long ago" then come from the same clock, so a device whose clock is
// three hours wrong still counts 24 hours right. A copy from before step 18c has only the server's
// time, which stands in until its next pull ends. null = no pull has ended.
export function syncedAtOf(state: PullState): number | null {
  if (state.lastSyncAt === null) return null;
  return state.syncedAt ?? Date.parse(state.lastSyncAt);
}
