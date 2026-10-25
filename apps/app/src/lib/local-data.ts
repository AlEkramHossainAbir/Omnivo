import type { Branch, DeviceListItem, MoveDeviceInput } from '@omnivo/contracts';
import {
  customerCommands,
  readPullState,
  STORAGE_FAILED,
  type SyncDatabase,
  type SyncEngine,
  type SyncStatus,
  type Watch,
} from '@omnivo/sync';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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

// Step 18c: what moving this device answers. 'waiting' = its outbox is not empty (decision 2): the
// dialog checked, but a save in another tab may have come in between.
export type MoveResult = DeviceListItem | 'waiting';

interface LocalDataState {
  device: DeviceState;
  // The branch dialog is open
  asking: boolean;
  // "Try again" on a first pull that failed; set by the session
  retry: () => void;
  // Step 18c: this browser's device id for the person signed in now, for the "This device" pill
  // and for the actions only this device has. null = no session.
  deviceId: string | null;
  // Step 18c: the two device actions that change the copy on this device, set by the session like
  // `retry`. The pages call them through the store, so their chunks never load Dexie.
  moveHere: (input: MoveDeviceInput) => Promise<MoveResult>;
  // After this device was revoked from its own list: delete the copy, then sign out
  revokedHere: () => Promise<void>;
}

const noSession = () => Promise.reject(new Error('No device session'));

export const localDataStore = createStore<LocalDataState>()(() => ({
  device: { kind: 'starting' },
  asking: false,
  retry: () => undefined,
  deviceId: null,
  moveHere: noSession,
  revokedHere: noSession,
}));

export function useThisDeviceId(): string | null {
  return useStore(localDataStore, (state) => state.deviceId);
}

export function askForBranch(): void {
  localDataStore.setState({ asking: true });
}

export function retryLocalData(): void {
  localDataStore.getState().retry();
}

export function useDeviceState(): DeviceState {
  return useStore(localDataStore, (state) => state.device);
}

// Step 18b: a sync soon, after a save into the outbox (the engine waits 300 ms for more)
export function requestSync(): void {
  const { device } = localDataStore.getState();
  if (device.kind === 'ready') device.engine.request();
}

// The device's database, when it has one open: the outbox is in it
export function useLocalDb(): SyncDatabase | null {
  const device = useDeviceState();
  return device.kind === 'ready' ? device.db : null;
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

const NO_STATUS: SyncStatus = { syncing: false, problem: null, stopped: false };
const noSubscribe = () => () => undefined;
const noStatus = () => NO_STATUS;

// The engine's status (syncing, its problem), for the sidebar and the Sync page
export function useSyncStatus(): SyncStatus {
  const device = useDeviceState();
  const engine = device.kind === 'ready' ? device.engine : null;
  return useSyncExternalStore(engine?.subscribe ?? noSubscribe, engine?.getStatus ?? noStatus);
}

export function useLocalData(): { view: LocalView; notice: string | null } {
  const device = useDeviceState();
  const online = useOnline();
  const status = useSyncStatus();
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

// Where a customer form or an order form saves (decision 2): through the API online, into the
// outbox offline, and into the outbox online too while the customer has commands waiting, so
// its changes reach the server in the order they were made. '' = no customer (yet).
// undefined while the device's answer is not read yet: the form waits for it.
export type SaveMode = 'api' | 'device';

export function useSaveMode(customerId: string): SaveMode | undefined {
  const online = useOnline();
  const db = useLocalDb();
  const read = useCallback(
    (database: SyncDatabase) =>
      customerId === '' ? Promise.resolve([]) : customerCommands(database, customerId),
    [customerId],
  );
  const commands = useLocalQuery(db ? read : null);
  if (!online) return 'device';
  if (!db) return 'api';
  if (commands === undefined) return undefined;
  return commands.length > 0 ? 'device' : 'api';
}
