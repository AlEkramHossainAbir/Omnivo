import type { Branch } from '@omnivo/contracts';
import {
  readPullState,
  STORAGE_FAILED,
  type SyncDatabase,
  type SyncEngine,
  type SyncStatus,
  type Watch,
} from '@omnivo/sync';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { useOnline } from './use-online';

// Step 18a: what the screens know of the device and its copy of the data, and how they read it.
// No Dexie here: this file is imported by the products and customers pages and by the pickers in
// every sales form, and Dexie is 30 KB gz. The code that opens the database (local-session.ts)
// is loaded once, lazily, by the AppShell, and puts the database, the engine and Dexie's
// liveQuery (`watch`) into this store.

export type DeviceState =
  | { kind: 'starting' }
  // More than one branch, and none chosen yet (decision 12); the dialog lists `branches`
  | { kind: 'not-set-up'; branches: Branch[] }
  // The server could not be reached to set the device up. It tries again when the connection
  // comes back, and every minute.
  | { kind: 'unreachable' }
  | { kind: 'storage-failed' }
  | { kind: 'revoked' }
  | { kind: 'ready'; db: SyncDatabase; engine: SyncEngine; watch: Watch };

interface LocalDataState {
  device: DeviceState;
  // The branch dialog is open
  asking: boolean;
  // "Try again" on a first pull that failed; set by the session
  retry: () => void;
}

export const localDataStore = createStore<LocalDataState>()(() => ({
  device: { kind: 'starting' },
  asking: false,
  retry: () => undefined,
}));

export function askForBranch(): void {
  localDataStore.setState({ asking: true });
}

export function retryLocalData(): void {
  localDataStore.getState().retry();
}

export function useDeviceState(): DeviceState {
  return useStore(localDataStore, (state) => state.device);
}

// A read of the copy that runs again by itself when a pull changes what it read. `query` must be
// stable (useCallback): a new function is a new read. null = nothing to read (the archived tab).
// While a new read runs, the last answer stays, so a list does not flash empty on each key press.
// undefined until the first answer, and while the device has no open copy.
export function useLocalQuery<T>(query: ((db: SyncDatabase) => Promise<T>) | null): T | undefined {
  const device = useDeviceState();
  const ready = device.kind === 'ready' ? device : null;
  // The answer keeps the device it came from: another workspace's copy is never shown
  const [answer, setAnswer] = useState<{ from: DeviceState; value: T } | null>(null);
  useEffect(() => {
    if (!ready || !query) return;
    return ready.watch(
      () => query(ready.db),
      (value) => {
        setAnswer({ from: ready, value });
      },
      // A read that fails (the database closed on sign-out) keeps the last answer
      () => undefined,
    );
  }, [ready, query]);
  return ready && query && answer?.from === ready ? answer.value : undefined;
}

export type LocalView =
  | { kind: 'loading' }
  // The device has a complete copy (one pull finished), so lists read it, online or not
  | { kind: 'ready'; db: SyncDatabase }
  | { kind: 'not-set-up' }
  | { kind: 'first-pull'; copied: number }
  | { kind: 'first-pull-failed' }
  | { kind: 'offline-empty' }
  | { kind: 'storage-failed' }
  | { kind: 'revoked' };

// The engine's problems a page says above its list, because they need the person: the others
// (no connection, a server error) only mean the copy is a little older, and 18c's sidebar says so
const NOTICES: ReadonlySet<string> = new Set([
  'sync_protocol_mismatch',
  'device_not_found',
  'device_id_invalid',
  'device_branch_invalid',
]);

const NO_STATUS: SyncStatus = { pulling: false, problem: null, stopped: false };
const noSubscribe = () => () => undefined;
const noStatus = () => NO_STATUS;

export function useLocalData(): { view: LocalView; notice: string | null } {
  const device = useDeviceState();
  const online = useOnline();
  const engine = device.kind === 'ready' ? device.engine : null;
  const status = useSyncExternalStore(
    engine?.subscribe ?? noSubscribe,
    engine?.getStatus ?? noStatus,
  );
  // Live: the first pull's count and its end show here as the pages arrive
  const pull = useLocalQuery(readPullState);
  const notice = status.problem !== null && NOTICES.has(status.problem) ? status.problem : null;
  return { view: viewOf(device, status, pull?.lastSyncAt, pull?.copied ?? 0, online), notice };
}

function viewOf(
  device: DeviceState,
  status: SyncStatus,
  // undefined = not read yet
  lastSyncAt: string | null | undefined,
  copied: number,
  online: boolean,
): LocalView {
  switch (device.kind) {
    case 'starting':
      return { kind: 'loading' };
    case 'not-set-up':
    case 'storage-failed':
    case 'revoked':
      return { kind: device.kind };
    case 'unreachable':
      return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
    case 'ready':
      if (lastSyncAt === undefined) return { kind: 'loading' };
      if (lastSyncAt !== null) return { kind: 'ready', db: device.db };
      if (status.problem === STORAGE_FAILED) return { kind: 'storage-failed' };
      if (status.problem === null) return { kind: 'first-pull', copied };
      return online ? { kind: 'first-pull-failed' } : { kind: 'offline-empty' };
  }
}
