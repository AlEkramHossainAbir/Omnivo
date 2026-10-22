import { type Device, routes } from '@omnivo/contracts';
import { formatNumber, i18n, isLanguage } from '@omnivo/i18n';
import {
  allRows,
  customerCommands,
  databaseName,
  deleteLocalDatabase,
  type DeviceIdentity,
  deviceNameParts,
  localCustomer,
  lookUpPrices,
  newDeviceId,
  outboxCounts,
  type PushOutcome,
  readDevice,
  saveDevice,
  SyncDatabase,
  SyncEngine,
  watch,
} from '@omnivo/sync';
import { toast } from '@omnivo/ui';

import { ApiRequestError, call, onApiWrite } from './api';
import { setDeviceReads } from './device-reads';
import { localDataStore } from './local-data';
import { queryClient } from './query-client';
import { NO_SUMMARY, syncSummaryStore } from './sync-summary';

// Step 18a: this browser as a device, and its copy of the data, for the person signed in now.
// This module brings Dexie, so only lazy code imports it: the AppShell's host
// (local-data-host.tsx) and the branch dialog, and session.ts with import() to delete the copy.
// The pages read the copy through local-data.ts, which never loads Dexie itself.

// localStorage itself can throw (a sandboxed frame, storage turned off): then no storage
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function codeOf(error: unknown): string | null {
  return error instanceof ApiRequestError ? error.code : null;
}

const set = localDataStore.setState;

interface Session {
  tenantId: string;
  userId: string;
  identity: DeviceIdentity;
  // Set when the session ends: an answer that comes after it changes nothing
  stopped: boolean;
  // What the running copy needs undone: the engine, the database, the listeners
  cleanup: (() => void)[];
}

let current: Session | null = null;

function remember(session: Session, identity: DeviceIdentity): void {
  session.identity = identity;
  saveDevice(storage(), session.tenantId, session.userId, identity);
}

function runCleanup(session: Session): void {
  for (const undo of session.cleanup.splice(0)) undo();
}

export function startLocalData(input: { tenantId: string; userId: string }): () => void {
  stopLocalData();
  const session: Session = {
    ...input,
    identity: readDevice(storage(), input.tenantId, input.userId),
    stopped: false,
    cleanup: [],
  };
  current = session;
  // Saved before the first registration: if its answer is lost, the next try sends the same id
  // and the server returns the same device (decision 20)
  remember(session, session.identity);
  set({
    device: { kind: 'starting' },
    asking: false,
    retry: () => {
      retry(session);
    },
  });
  void setUp(session);
  return () => {
    if (current === session) stopLocalData();
  };
}

export function stopLocalData(): void {
  if (!current) return;
  current.stopped = true;
  runCleanup(current);
  current = null;
  set({ device: { kind: 'starting' }, asking: false });
  syncSummaryStore.setState(NO_SUMMARY);
}

// The copy is the workspace's data: signing out deletes it (decision 41). The device's id stays
// in localStorage, so the next sign-in is the same device, with a new full pull.
export async function deleteLocalData(tenantId: string, userId: string): Promise<void> {
  if (current?.tenantId === tenantId && current.userId === userId) stopLocalData();
  await deleteLocalDatabase(tenantId, userId);
}

async function setUp(session: Session): Promise<void> {
  if (session.identity.branchId !== null) {
    await open(session);
    return;
  }
  try {
    const { items: branches } = await call(routes.branches.list, { query: { status: 'active' } });
    if (session.stopped) return;
    const [only, ...others] = branches;
    // One branch: no question (decision 12)
    if (only && others.length === 0) {
      await register(session, only.id);
      return;
    }
    // Several (or none, which a workspace never has: sign-up makes the head office)
    set({ device: { kind: 'not-set-up', branches }, asking: !session.identity.later });
  } catch {
    if (!session.stopped) waitForServer(session);
  }
}

// Not set up and no answer: try again when the connection comes back, or in a minute
function waitForServer(session: Session): void {
  set({ device: { kind: 'unreachable' } });
  const again = () => {
    retry(session);
  };
  const timer = setInterval(again, 60_000);
  window.addEventListener('online', again);
  session.cleanup.push(() => {
    clearInterval(timer);
    window.removeEventListener('online', again);
  });
}

// "Try again" on the first-pull error: pull again, or set up again
function retry(session: Session): void {
  if (session.stopped) return;
  const { device } = localDataStore.getState();
  if (device.kind === 'ready') {
    void device.engine.syncNow();
    return;
  }
  runCleanup(session);
  void setUp(session);
}

// "Chrome on Windows" in the language of the person who sets it up (decision 12). The server
// keeps the name it got first; renaming is 18c's.
function deviceName(): string {
  const parts = deviceNameParts(navigator.userAgent);
  return parts ? i18n.t('devices.defaultName', parts) : i18n.t('devices.fallbackName');
}

// Step 18b: after a push that sent something. The screens that show customers read them again (a
// customer page, the credit line, a form's customer box), and one toast says what happened. A
// refusal comes first: it is the one the person must act on, and the sidebar count leads there
// too, for someone who misses the toast.
function pushed(session: Session, outcome: PushOutcome): void {
  void queryClient.invalidateQueries({ queryKey: ['customers', session.tenantId] });
  void queryClient.invalidateQueries({ queryKey: ['sales', session.tenantId, 'orders'] });
  const language = isLanguage(i18n.language) ? i18n.language : 'en';
  if (outcome.rejected > 0) toast(i18n.t('sync.someFailed'));
  else if (outcome.kept > 0) toast(i18n.t('sync.someKept'));
  else {
    toast(
      i18n.t('sync.synced', {
        count: outcome.accepted,
        formatted: formatNumber(outcome.accepted, language),
      }),
    );
  }
}

function registerDevice(session: Session, branchId: string): Promise<Device> {
  return call(routes.sync.registerDevice, {
    body: { id: session.identity.id, name: deviceName(), branchId },
  });
}

async function register(session: Session, branchId: string): Promise<Device> {
  let device: Device;
  try {
    device = await registerDevice(session, branchId);
  } catch (error) {
    // The id is another person's device (a browser profile copied to another computer): a new
    // id, once. Any other error goes to the caller.
    if (codeOf(error) !== 'device_id_invalid') throw error;
    remember(session, { ...session.identity, id: newDeviceId() });
    device = await registerDevice(session, branchId);
  }
  if (session.stopped) return device;
  // The server's branch, not the one asked for: registering an existing device again changes
  // nothing (decision 37)
  remember(session, { id: device.id, branchId: device.branchId, later: false });
  if (device.revokedAt === null) await open(session);
  else await revoke(session);
  return device;
}

// The branch dialog's "Use this branch". The dialog shows the errors (device_branch_invalid
// under the box). null = the session ended while the dialog was open.
export async function chooseBranch(branchId: string): Promise<Device | null> {
  return current ? register(current, branchId) : null;
}

// "Not now" (decision 40): no dialog by itself any more on this device; the pages show a button
export function chooseLater(): void {
  if (current) remember(current, { ...current.identity, later: true });
  set({ asking: false });
}

async function open(session: Session): Promise<void> {
  const db = new SyncDatabase(databaseName(session.tenantId, session.userId));
  try {
    await db.open();
  } catch {
    // A private window that refuses IndexedDB, a full disk
    if (!session.stopped) set({ device: { kind: 'storage-failed' } });
    return;
  }
  if (session.stopped) {
    db.close();
    return;
  }
  const engine = new SyncEngine({
    db,
    deviceId: session.identity.id,
    pull: (query) => call(routes.sync.pull, { query }),
    push: (body) => call(routes.sync.push, { body }),
    onPushed: (outcome) => {
      if (!session.stopped) pushed(session, outcome);
    },
    codeOf,
    registerAgain: async () => {
      const { branchId } = session.identity;
      if (branchId === null) return;
      try {
        await registerDevice(session, branchId);
      } catch (error) {
        // The branch was archived while the server did not know the device: forget it and ask
        // again, like a new device
        if (codeOf(error) === 'device_branch_invalid') {
          remember(session, { ...session.identity, branchId: null });
          queueMicrotask(() => {
            runCleanup(session);
            set({ device: { kind: 'starting' } });
            void setUp(session);
          });
        }
        throw error;
      }
    },
    onRevoked: () => {
      void revoke(session);
    },
  });
  // Step 18b: the queries read the copy offline through these (device-reads.ts). The balance is the
  // server's only, so a customer from the device has none.
  setDeviceReads({
    units: () => allRows(db.units),
    taxRates: () => allRows(db.taxRates),
    warehouses: () => allRows(db.warehouses),
    customer: async (customerId) => {
      const local = await localCustomer(db, customerId);
      return local && { ...local, balance: null };
    },
    hasCommands: async (customerId) => (await customerCommands(db, customerId)).length > 0,
    settings: async () => (await allRows(db.settings))[0] ?? null,
    prices: async (customerId, items) => {
      const customer = customerId === '' ? null : await localCustomer(db, customerId);
      return lookUpPrices(db, customer?.priceListId ?? null, items);
    },
  });
  session.cleanup.push(
    // A save on this device: pull its change now (api.ts)
    onApiWrite(() => {
      engine.request();
    }),
    // Step 18b: the sidebar's numbers (sync-summary.ts), live: a save, a push or another tab
    // changes the outbox, and the count follows
    watch(
      () => outboxCounts(db),
      (counts) => {
        syncSummaryStore.setState({ waiting: counts.total, failed: counts.failed });
      },
      () => undefined,
    ),
    engine.subscribe(() => {
      syncSummaryStore.setState({ syncing: engine.getStatus().syncing });
    }),
    () => {
      setDeviceReads(null);
    },
    () => {
      engine.stop();
    },
    () => {
      db.close();
    },
  );
  set({ device: { kind: 'ready', db, engine, watch }, asking: false });
  engine.start();
}

// A revoked device keeps nothing (decision 7). The identity stays: registering it again returns
// the same revoked device, so it stays revoked until step 18c says otherwise.
async function revoke(session: Session): Promise<void> {
  runCleanup(session);
  await deleteLocalDatabase(session.tenantId, session.userId);
  if (!session.stopped) set({ device: { kind: 'revoked' }, asking: false });
}
