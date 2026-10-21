import { SYNC_PROTOCOL, type SyncPull, type SyncPullQuery } from '@omnivo/contracts';
import { Dexie } from 'dexie';

import { applyPage } from './apply.js';
import type { SyncDatabase } from './database.js';
import { STORAGE_FAILED } from './problems.js';
import { readPullState } from './state.js';

// After these, pulling again cannot help until the page is reloaded (a new app version) or the
// device is set up again
const FINAL_PROBLEMS: ReadonlySet<string> = new Set([
  'sync_protocol_mismatch',
  'device_revoked',
  'device_not_found',
]);

export interface SyncStatus {
  // A pull is running in this tab
  pulling: boolean;
  // Why the last pull stopped, as an error code (network_error, storage_failed, …); null = the
  // last pull finished
  problem: string | null;
  // The engine pulls no more (decision 18's reload, a revoked device)
  stopped: boolean;
}

// Runs fn while no other tab of this browser pulls into the same database. Two tabs pulling at
// once would interleave their pages and cursors. Web Locks by default (like the token refresh in
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

const IDLE: SyncStatus = { pulling: false, problem: null, stopped: false };

// The pull loop of one device: one pull at a time, each page applied before the next is asked
// for. Framework-free; the app reads its status with useSyncExternalStore.
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

  // A pull now, and on every wake-up: the connection coming back, the window getting the focus
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
    void this.pullNow();
  }

  // The session ended (sign-out, another workspace). A page being applied finishes; no more.
  stop(): void {
    this.ended = true;
    this.detach?.();
    this.detach = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
  }

  // A pull soon: the focus and visibility events of one tab switch, and the saves of one form,
  // come within milliseconds of each other and make one pull
  request(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.pullNow();
    }, 300);
  }

  // One pull at a time. Asked while one runs, it runs once more after it: the change that made
  // someone ask may have committed after the running pull read its watermark.
  pullNow(): Promise<void> {
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
    this.set({ ...this.status, pulling: true });
    let problem: string | null = null;
    try {
      const lock = this.options.lock ?? webLock;
      await lock(`omnivo-sync:${this.options.db.name}`, () => this.pullWithRetry());
    } catch (error) {
      problem = this.problemOf(error);
    }
    if (this.ended) return;
    if (problem === 'device_revoked') this.options.onRevoked();
    this.set({
      pulling: false,
      problem,
      stopped: problem !== null && FINAL_PROBLEMS.has(problem),
    });
  }

  private async pullWithRetry(): Promise<void> {
    try {
      await this.pullAll();
    } catch (error) {
      if (this.options.codeOf(error) !== 'device_not_found') throw error;
      await this.options.registerAgain();
      await this.pullAll();
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
