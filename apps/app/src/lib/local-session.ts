import { type Device, type MoveDeviceInput, routes } from '@omnivo/contracts';
import { formatNumber, i18n, isLanguage } from '@omnivo/i18n';
import {
  allRows,
  customerCommands,
  databaseName,
  deleteLocalDatabase,
  type DeviceIdentity,
  deviceNameParts,
  deviceStorageKey,
  forgetDevice,
  localCustomer,
  lookUpPrices,
  newDeviceId,
  outboxCounts,
  type PushOutcome,
  readDevice,
  readPullState,
  saveDevice,
  SyncDatabase,
  SyncEngine,
  syncedAtOf,
  watch,
} from '@omnivo/sync';
import { toast } from '@omnivo/ui';

import { ApiRequestError, call, onApiWrite, refreshSession } from './api';
import { setDeviceReads } from './device-reads';
import { localDataStore, type MoveResult } from './local-data';
import { queryClient } from './query-client';
import { sessionStore } from './session-store';
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
  // Step 18c: stops following the other tabs; only when the session ends, not with the copy
  unfollow: () => void;
}

let current: Session | null = null;

function remember(session: Session, identity: DeviceIdentity): void {
  session.identity = identity;
  saveDevice(storage(), session.tenantId, session.userId, identity);
  set({ deviceId: identity.id });
}

const ended = () => Promise.reject(new Error('The device session ended'));

// Step 18c: for a check after a second await. Another call may end the session during any await,
// but TypeScript keeps `session.stopped` narrowed to false after the first check; a function call
// is read again each time.
function hasEnded(session: Session): boolean {
  return session.stopped;
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
    unfollow: () => undefined,
  };
  current = session;
  session.unfollow = followOtherTabs(session);
  // Saved before the first registration: if its answer is lost, the next try sends the same id
  // and the server returns the same device (decision 20)
  remember(session, session.identity);
  set({
    device: { kind: 'starting' },
    asking: false,
    retry: () => {
      retry(session);
    },
    moveHere: (input) => moveHere(session, input),
    revokedHere: () => revoke(session),
  });
  void setUp(session);
  return () => {
    if (current === session) stopLocalData();
  };
}

export function stopLocalData(): void {
  if (!current) return;
  current.stopped = true;
  current.unfollow();
  runCleanup(current);
  current = null;
  set({
    device: { kind: 'starting' },
    asking: false,
    deviceId: null,
    moveHere: ended,
    revokedHere: ended,
  });
  syncSummaryStore.setState(NO_SUMMARY);
}

// Step 18c: another tab of this browser moved this device or found it revoked. It changed the
// identity in localStorage (a `storage` event reaches every other tab of the same site) and deleted
// the copy, which closed this tab's database too. This tab follows, instead of showing a copy
// that is gone until the page is reloaded. Its own writes do not come back to it: the browser
// sends the event to the other tabs only.
function followOtherTabs(session: Session): () => void {
  const key = deviceStorageKey(session.tenantId, session.userId);
  const changed = (event: StorageEvent) => {
    if (event.key !== key || session.stopped) return;
    // Removed: revoked there. The same steps here (forgetting it again changes nothing).
    if (event.newValue === null) {
      void revoke(session);
      return;
    }
    const next = readDevice(storage(), session.tenantId, session.userId);
    // "Not now" there, or the same identity saved again: nothing to follow
    if (next.id === session.identity.id && next.branchId === session.identity.branchId) return;
    session.identity = next;
    runCleanup(session);
    set({ device: { kind: 'starting' }, deviceId: next.id });
    void setUp(session);
  };
  window.addEventListener('storage', changed);
  return () => {
    window.removeEventListener('storage', changed);
  };
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
    // Step 18c: the time of the last sync, for the limits (sync-summary.ts: useSyncAge)
    watch(
      () => readPullState(db),
      (state) => {
        syncSummaryStore.setState({ syncedAt: syncedAtOf(state) });
      },
      () => undefined,
    ),
    // The copy closes (a move, a revoke, a retry from the start): its numbers go with it
    () => {
      syncSummaryStore.setState(NO_SUMMARY);
    },
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

// A revoked device keeps nothing (decision 7), and step 18c (decisions 3 and 4) adds two things.
// Its identity goes too, so the next set-up makes a new id and signing in again makes a new device.
// And the sign-in: a revoke ends the device's session on the server, so a refresh tells whether it
// happened during this sign-in. It fails: the person is signed out, with a notice on the sign-in
// page. It works: they signed in again after the revoke on a browser that still had the revoked
// id (the engine's first pull or the registration found it), so the device is set up again as a
// new one, with the branch dialog. Four callers: the engine (device_revoked), a registration that
// answers a revoked device, the device's own list (revokedHere) and another tab (followOtherTabs).
async function revoke(session: Session): Promise<void> {
  runCleanup(session);
  set({ device: { kind: 'revoked' }, asking: false });
  // Before the delete: the other tabs hear of it and stop using the copy
  forgetDevice(storage(), session.tenantId, session.userId);
  await deleteLocalDatabase(session.tenantId, session.userId);
  if (session.stopped) return;
  // No answer from the server signs out too: the data is gone already, and signing in again sets
  // the device up
  const renewed = await refreshSession().catch(() => null);
  if (hasEnded(session)) return;
  if (!renewed) {
    queryClient.clear();
    sessionStore.getState().signOut('device_revoked');
    return;
  }
  sessionStore.getState().setAccessToken(renewed.accessToken);
  remember(session, readDevice(storage(), session.tenantId, session.userId));
  set({ device: { kind: 'starting' } });
  await setUp(session);
}

// Step 18c (decision 2): this device to another branch, from its own list. Only with an empty
// outbox: its commands were made for the old branch's warehouses, and the server cannot see them
// to check. The dialog checked it already; this checks again, because another tab may have saved
// something since. Then the old branch's copy goes, and a full pull copies the new one: an empty
// database has no cursor (18a's pull would start a full pull anyway, but the old rows would stay
// on the lists until its last page).
async function moveHere(session: Session, input: MoveDeviceInput): Promise<MoveResult> {
  const { device } = localDataStore.getState();
  // The page offers the move only with an open copy: without one, the outbox cannot be read
  if (device.kind !== 'ready') throw new Error('No copy is open on this device');
  if ((await outboxCounts(device.db)).total > 0) return 'waiting';
  const moved = await call(routes.devices.move, {
    params: { id: session.identity.id },
    body: input,
  });
  if (session.stopped) return moved;
  runCleanup(session);
  set({ device: { kind: 'starting' } });
  await deleteLocalDatabase(session.tenantId, session.userId);
  // Saved after the delete: another tab follows the new branch only once the old copy is gone
  remember(session, { id: moved.id, branchId: moved.branchId, later: false });
  if (!hasEnded(session)) await open(session);
  return moved;
}
