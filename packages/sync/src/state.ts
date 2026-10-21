import type { PullState, SyncDatabase } from './database.js';

export const NO_PULL: PullState = {
  key: 'pull',
  cursor: null,
  generation: 0,
  full: false,
  lastSyncAt: null,
  copied: 0,
};

// Where the pull is. Type imports only: a page reads it (for "1,250 items copied so far") without
// loading Dexie; the database object comes from the code that opened it.
export async function readPullState(db: SyncDatabase): Promise<PullState> {
  return (await db.meta.get('pull')) ?? NO_PULL;
}
