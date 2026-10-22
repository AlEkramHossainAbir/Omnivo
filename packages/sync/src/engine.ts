import {
  SYNC_PROTOCOL,
  type SyncPull,
  type SyncPullQuery,
  type SyncPush,
  type SyncPushInput,
} from '@omnivo/contracts';
import { Dexie } from 'dexie';

import { applyPage } from './apply.js';
import type { SyncDatabase } from './database.js';
import { STORAGE_FAILED } from './problems.js';
import {
  applyAnswers,
  NO_PUSH,
  type PushOutcome,
  releaseBatch,
  resetSending,
  takeBatch,
} from './push.js';
import { readPullState } from './state.js';

// After these, syncing again cannot help until the page is reloaded (a new app version) or the
// device is set up again
const FINAL_PROBLEMS: ReadonlySet<string> = new Set([
  'sync_protocol_mismatch',
  'device_revoked',
  'device_not_found',
]);

export interface SyncStatus {
  // A sync is running in this tab: the outbox going up (step 18b), then the pull
  syncing: boolean;
  // Why the last sync stopped, as an error code (network_error, storage_failed, …); null = the
  // last pull finished
  problem: string | null;
  // The engine syncs no more (decision 18's reload, a revoked device)
  stopped: boolean;
}

// Runs fn while no other tab of this browser syncs the same database. Two tabs pulling at once
// would interleave their pages and cursors; two pushing at once would send one command twice. Web Locks by default (like the token refresh in
// the app's api.ts); a test passes its own.
export type LockRunner = (name: string, fn: () => Promise<void>) => Promise<void>;

const webLock: LockRunner = async (name, fn) => {
  await navigator.locks.request(name, fn);
};

export interface SyncEngineOptions {
  db: SyncDatabase;
  deviceId: string;
  // The app's API call (routes.sync.pull). The engine knows nothing of tokens or the API's url.
  pull: (query: SyncPullQuery) => Promise<SyncPull>;
  // Step 18b: the app's call(routes.sync.push)
  push: (input: SyncPushInput) => Promise<SyncPush>;
  // After a push that sent something: the app refreshes what it shows, and says what happened
  onPushed?: (outcome: PushOutcome) => void;
  // The error code of a failed call (the app's ApiRequestError.code), or null for anything else
  codeOf: (error: unknown) => string | null;
  // device_not_found: the server does not know this device (its database was restored from an
  // older backup, or the registration was lost). The app registers it again with the same id and
  // branch; then the engine tries once more.
  registerAgain: () => Promise<void>;
  // device_revoked: the app deletes the local data (decision 7)
  onRevoked: () => void;
  pageSize?: number;
  intervalMs?: number;
  lock?: LockRunner;
}

const IDLE: SyncStatus = { syncing: false, problem: null, stopped: false };

// The sync loop of one device: one sync at a time. A sync sends the outbox first (step 18b), then
// pulls page after page, each applied before the next is asked for. Framework-free; the app reads
// its status with useSyncExternalStore.
export class SyncEngine {
  private status: SyncStatus = IDLE;
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  // Counts the pulls asked for while one ran
  private asks = 0;
  private ended = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private detach: (() => void) | null = null;

  constructor(private readonly options: SyncEngineOptions) {}

  // Arrow functions: React calls them without `this`
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getStatus = (): SyncStatus => this.status;

  // A sync now, and on every wake-up: the connection coming back, the window getting the focus
  // again, a tab coming back to the front, and every minute while online and in front
  start(): void {
    const wake = () => {
      this.request();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') this.request();
    };
    const tick = setInterval(() => {
      // A tab in the background does not pull: its lists are not on screen, and it pulls when it
      // comes back. Ten tabs left open would otherwise ask the server ten times a minute.
      if (navigator.onLine && document.visibilityState === 'visible') this.request();
    }, this.options.intervalMs ?? 60_000);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', visible);
    this.detach = () => {
      clearInterval(tick);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', visible);
    };
    void this.syncNow();
  }

  // The session ended (sign-out, another workspace). A page being applied finishes; no more.
  stop(): void {
    this.ended = true;
    this.detach?.();
    this.detach = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
  }

  // A sync soon: the focus and visibility events of one tab switch, and the saves of one form,
  // come within milliseconds of each other and make one sync
  request(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, 300);
  }

  // One sync at a time. Asked while one runs, it runs once more after it: the change that made
  // someone ask may have committed after the running pull read its watermark, or a command may
  // have been saved after the push read the outbox.
  syncNow(): Promise<void> {
    if (this.ended || this.status.stopped) return Promise.resolve();
    if (this.running) {
      this.asks += 1;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    let asked: number;
    do {
      asked = this.asks;
      await this.runOnce();
    } while (this.asks !== asked && !this.ended && !this.status.stopped);
  }

  private async runOnce(): Promise<void> {
    this.set({ ...this.status, syncing: true });
    let problem: string | null = null;
    try {
      const lock = this.options.lock ?? webLock;
      await lock(`omnivo-sync:${this.options.db.name}`, async () => {
        // The outbox first: the pull after it then brings what the commands changed, and a full
        // pull's sweep never meets a customer that is only in the outbox
        const outcome = await this.withRegistration(() => this.pushAll());
        if (outcome.accepted + outcome.rejected > 0) this.options.onPushed?.(outcome);
        await this.withRegistration(() => this.pullAll());
      });
    } catch (error) {
      problem = this.problemOf(error);
    }
    if (this.ended) return;
    if (problem === 'device_revoked') this.options.onRevoked();
    this.set({
      syncing: false,
      problem,
      stopped: problem !== null && FINAL_PROBLEMS.has(problem),
    });
  }

  // device_not_found: register the same id again, and try once more
  private async withRegistration<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (this.options.codeOf(error) !== 'device_not_found') throw error;
      await this.options.registerAgain();
      return run();
    }
  }

  // Batch after batch until nothing more can go: each round takes the commands that are free now
  // (push.ts), and an accepted customer frees the order that waited for it in the next round. A
  // refused command is marked failed and is not taken again, so the loop always ends.
  private async pushAll(): Promise<PushOutcome> {
    const { db, deviceId } = this.options;
    await resetSending(db);
    const outcome = { ...NO_PUSH };
    for (;;) {
      if (this.ended) return outcome;
      const batch = await takeBatch(db);
      if (batch.length === 0) return outcome;
      let answer: SyncPush;
      try {
        answer = await this.options.push({
          deviceId,
          protocol: SYNC_PROTOCOL,
          commands: batch.map((entry) => entry.command),
        });
      } catch (error) {
        await releaseBatch(db, batch);
        throw error;
      }
      const round = await applyAnswers(db, batch, answer);
      outcome.accepted += round.accepted;
      outcome.rejected += round.rejected;
      outcome.kept += round.kept;
      // Nothing answered: the next round would send the same commands again
      if (round.accepted + round.rejected === 0) return outcome;
    }
  }

  // Pages until hasMore is false. The cursor is read from the database, not kept in memory:
  // another tab may have pulled since, and it saved its own cursor there.
  private async pullAll(): Promise<void> {
    const { db, deviceId, pageSize = 500 } = this.options;
    let cursor = (await readPullState(db)).cursor;
    for (;;) {
      if (this.ended) return;
      const page = await this.options.pull({
        deviceId,
        protocol: SYNC_PROTOCOL,
        limit: pageSize,
        ...(cursor !== null && { cursor }),
      });
      await applyPage(db, page, cursor);
      if (!page.hasMore) return;
      cursor = page.cursor;
    }
  }

  private problemOf(error: unknown): string {
    const code = this.options.codeOf(error);
    if (code !== null) return code;
    // IndexedDB refused a write or an open: Dexie wraps every such failure in its own errors
    if (error instanceof Dexie.DexieError) return STORAGE_FAILED;
    return 'unknown_error';
  }

  private set(next: SyncStatus): void {
    this.status = next;
    for (const listener of this.listeners) listener();
  }
}
