import { type Device, type DeviceKey, type MoveDeviceInput, routes } from '@omnivo/contracts';
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
  forgetPin,
  type KeyProblem,
  type KeyRecord,
  keyStatus,
  LocalCopy,
  localCustomer,
  lookUpPrices,
  markPinAsked,
  newDeviceId,
  openKey,
  outboxCounts,
  type PushOutcome,
  readDevice,
  readClaim,
  readPullState,
  renewServerKey,
  saveDevice,
  setPin,
  SyncDatabase,
  SyncEngine,
  syncedAtOf,
  type Unlock,
  waitingSales,
  watch,
} from '@omnivo/sync';
import { toast } from '@omnivo/ui';

import { ApiRequestError, call, onApiWrite, refreshSession } from './api';
import { setDeviceReads } from './device-reads';
import {
  type LockReason,
  localDataStore,
  type MoveResult,
  type PinSave,
  type UnlockAnswer,
} from './local-data';
import { queryClient } from './query-client';
import { clearLocked, isLocked, LOCKED_KEY, markLocked } from './remembered-session';
import { sessionStore } from './session-store';
import { askToKeep } from './storage';
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
  // Step 19b: "Lock now" in this tab. The flag in localStorage says the same for the next reload and
  // the other tabs, but a storage that refuses must not leave the copy open here.
  locked: boolean;
}

// Step 19b: one opening of the database. runCleanup ends it (a lock, a move, a retry, the end of the
// session), and every step after an await checks it, so an ended opening never changes the screen.
interface Opening {
  db: SyncDatabase;
  live: boolean;
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

// Step 19b: the same for an opening, read again after each await
function closed(opening: Opening): boolean {
  return !opening.live;
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
    locked: false,
  };
  current = session;
  const unfollowTabs = followOtherTabs(session);
  const unfollowSignIn = followSignIn(session);
  session.unfollow = () => {
    unfollowTabs();
    unfollowSignIn();
  };
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
    pinDialog: null,
    savePin: (save) => savePin(session, save),
    closePin,
    lockNow: () => {
      lockNow(session);
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
  current.unfollow();
  runCleanup(current);
  current = null;
  set({
    device: { kind: 'starting' },
    asking: false,
    deviceId: null,
    moveHere: ended,
    revokedHere: ended,
    pinDialog: null,
    keys: null,
    savePin: ended,
    closePin: () => undefined,
    lockNow: () => undefined,
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
    if (session.stopped) return;
    if (event.key === LOCKED_KEY) {
      followLock(session, event.newValue !== null);
      return;
    }
    if (event.key !== key) return;
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

// Step 19b: "Lock now" in another tab locks this one too. The right PIN there, or a sign-in with the
// password, opens this one again: with the server's key when this tab's sign-in was checked, else
// with the PIN typed here.
function followLock(session: Session, locked: boolean): void {
  const { device } = localDataStore.getState();
  if (locked) {
    if (device.kind === 'ready') reopen(session);
    return;
  }
  session.locked = false;
  if (device.kind === 'locked' && device.reason === 'locked') reopen(session);
}

// Step 19b: the connection came back after an offline reload, and the server checked the sign-in
// (offline-session.ts). A copy still waiting for its PIN then opens with the server's key, as any
// online opening does (decision 1). Not one the person locked: that one waits for the PIN.
function followSignIn(session: Session): () => void {
  return sessionStore.subscribe((state, previous) => {
    if (!previous.openedOffline || state.openedOffline || state.status !== 'signed-in') return;
    // Another person signed in meanwhile: the host stops this session and starts theirs
    if (state.me?.user.id !== session.userId || state.me.tenant.id !== session.tenantId) return;
    const { device } = localDataStore.getState();
    if (device.kind === 'locked' && device.reason === 'offline') reopen(session);
  });
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
  if (device.revokedAt === null) {
    // Step 19a: the copy is about to be pulled, so the browser is asked to keep it. Not awaited:
    // Firefox shows a question, and the pull must not wait for the answer.
    void askToKeep();
    await open(session);
  } else await revoke(session);
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

// Step 19b: `keep` = the key's row of the copy a move deleted (moveHere)
async function open(session: Session, keep?: KeyRecord): Promise<void> {
  const db = new SyncDatabase(databaseName(session.tenantId, session.userId));
  try {
    await db.open();
    if (keep) await db.keys.put(keep);
  } catch {
    // A private window that refuses IndexedDB, a full disk
    if (!session.stopped) set({ device: { kind: 'storage-failed' } });
    return;
  }
  if (session.stopped) {
    db.close();
    return;
  }
  // First on the list, so it runs last: what start() adds goes in front of it (unshift)
  const opening: Opening = { db, live: true };
  session.cleanup.push(() => {
    opening.live = false;
    db.close();
  });
  await openCopy(session, opening);
}

// Step 19b: what opens the copy (decision 1). A checked sign-in, not locked: the server's key, and
// no PIN. "Lock now" (decision 6), or an opening with no checked sign-in (an offline reload,
// decision 2): the PIN, on the lock screen.
async function openCopy(session: Session, opening: Opening): Promise<void> {
  const { db } = opening;
  const locked = session.locked || isLocked();
  if (locked || sessionStore.getState().openedOffline) {
    await showLock(session, opening, locked ? 'locked' : 'offline', null);
    return;
  }
  let serverKey: Uint8Array<ArrayBuffer>;
  try {
    serverKey = await fetchServerKey(session);
  } catch (error) {
    if (closed(opening)) return;
    const code = codeOf(error);
    // A revoked device: the 18c steps (the copy goes, then a sign-in check)
    if (code === 'device_revoked') {
      void revoke(session);
      return;
    }
    // registerAgain found the branch archived, and starts the set-up again
    if (code === 'device_branch_invalid') return;
    // No answer (the API is down): the PIN opens it, as offline. Without one, it tries again later.
    const { hasPin } = await keyStatus(db);
    if (hasPin) await showLock(session, opening, 'offline', null);
    else if (!closed(opening)) waitForServer(session);
    return;
  }
  if (closed(opening)) return;
  const opened = await openKey(db, { serverKey });
  if (closed(opening)) return;
  if (opened.kind === 'open') {
    await start(session, opening, opened.key, true);
    return;
  }
  // key-changed, the one problem a server key answers (decision 17): the PIN opens the copy once,
  // and wraps its key for the server's new one. Without a PIN nothing can open it.
  const { hasPin } = await keyStatus(db);
  if (hasPin) await showLock(session, opening, 'key-changed', serverKey);
  else if (!closed(opening)) await remake(session);
}

// Step 19b (19b.2): the device's own key, asked at every online opening and never written anywhere
// (decision 23). A device the server does not know (its database restored to a time before this
// device) registers again, as the engine's pull does, and asks once more.
async function fetchServerKey(session: Session): Promise<Uint8Array<ArrayBuffer>> {
  const request = () => call(routes.sync.deviceKey, { params: { id: session.identity.id } });
  let answer: DeviceKey;
  try {
    answer = await request();
  } catch (error) {
    if (codeOf(error) !== 'device_not_found') throw error;
    await registerAgain(session);
    answer = await request();
  }
  // The contract checked it: 43 base64 characters and one '=', so 32 bytes
  return Uint8Array.from(atob(answer.key), (char) => char.charCodeAt(0));
}

// Step 19b: the lock screen (decision 7). The changes waiting are counted from the fields the
// outbox keeps readable, the legacy outbox too (a device not opened since version 3), so Sign out
// can ask first. Showing it again after a wrong PIN reads the new count of wrong ones.
async function showLock(
  session: Session,
  opening: Opening,
  reason: LockReason,
  serverKey: Uint8Array<ArrayBuffer> | null,
): Promise<void> {
  const { db } = opening;
  const [status, waiting, legacy] = await Promise.all([
    keyStatus(db),
    db.outbox.count(),
    db.legacyOutbox.count(),
  ]);
  if (closed(opening)) return;
  set({
    device: {
      kind: 'locked',
      reason,
      status,
      waiting: waiting + legacy,
      unlock: (pin) => unlock(session, opening, reason, serverKey, pin),
      // Decision 35: the PIN goes (a PIN nobody remembers only helps someone guessing it). The
      // lock screen then ends the sign-in: session.ts imports this module (logout), so this one
      // does not import it back (found by the 19b.5 boundaries check).
      forgetPin: () => forgetPin(db),
    },
    asking: false,
    pinDialog: null,
  });
}

// The lock screen's Unlock. A problem shows the screen again (fewer tries left, or the PIN off)
// and goes back to the field.
async function unlock(
  session: Session,
  opening: Opening,
  reason: LockReason,
  serverKey: Uint8Array<ArrayBuffer> | null,
  pin: string,
): Promise<UnlockAnswer> {
  const { db } = opening;
  const failed = async (problem: KeyProblem): Promise<UnlockAnswer> => {
    await showLock(session, opening, reason, serverKey);
    return problem;
  };
  if (serverKey) {
    // key-changed: the PIN wraps the key for the new server key first, and the server key then
    // opens it (no second PBKDF2, which takes up to a second on a cheap phone)
    const renewed = await renewServerKey(db, pin, serverKey);
    if (renewed.kind !== 'set') return failed(renewed);
  }
  const opened = await openKey(db, serverKey ? { serverKey } : { pin });
  if (opened.kind !== 'open') return failed(opened);
  if (closed(opening)) return { kind: 'open' };
  // The right PIN ends "Lock now", here and (the storage event) in the other tabs
  if (reason === 'locked') {
    session.locked = false;
    clearLocked();
  }
  await start(session, opening, opened.key, false);
  return { kind: 'open' };
}

// Step 19b: the open copy, its engine and the reads the queries use offline. `ask` = opened with
// the server's key, so the PIN dialog may follow (decision 5): no PIN yet, and not asked since the
// last one went. Opened with the PIN, there is one.
async function start(
  session: Session,
  opening: Opening,
  key: CryptoKey,
  ask: boolean,
): Promise<void> {
  const { db } = opening;
  let copy: LocalCopy;
  try {
    copy = await LocalCopy.open(db, key);
  } catch {
    // A row that does not open (changed on the disk), or a read the browser refused
    if (!closed(opening)) set({ device: { kind: 'storage-failed' } });
    return;
  }
  const status = ask ? await keyStatus(db) : null;
  if (closed(opening)) {
    copy.close();
    return;
  }
  // "Lock now" in another tab while this copy was opening: followLock found no open copy to close.
  // No await from here to the 'ready' state, so a later lock finds it open (found by the 19b.5 e2e).
  if (session.locked || isLocked()) {
    copy.close();
    await showLock(session, opening, 'locked', null);
    return;
  }
  const engine = new SyncEngine({
    copy,
    deviceId: session.identity.id,
    pull: (query) => call(routes.sync.pull, { query }),
    push: (body) => call(routes.sync.push, { body }),
    onPushed: (outcome) => {
      if (!session.stopped) pushed(session, outcome);
    },
    codeOf,
    registerAgain: () => registerAgain(session),
    onRevoked: () => {
      void revoke(session);
    },
  });
  // Step 18b: the queries read the copy offline through these (device-reads.ts). The balance is the
  // server's only, so a customer from the device has none.
  setDeviceReads({
    units: () => allRows(copy, db.units),
    taxRates: () => allRows(copy, db.taxRates),
    warehouses: () => allRows(copy, db.warehouses),
    customer: async (customerId) => {
      const local = await localCustomer(copy, customerId);
      return local && { ...local, balance: null };
    },
    hasCommands: async (customerId) => (await customerCommands(copy, customerId)).length > 0,
    settings: async () => (await allRows(copy, db.settings))[0] ?? null,
    prices: async (customerId, items) => {
      const customer = customerId === '' ? null : await localCustomer(copy, customerId);
      return lookUpPrices(copy, customer?.priceListId ?? null, items);
    },
  });
  // In front of the database's close, which open() put on the list
  session.cleanup.unshift(
    // A save on this device: pull its change now (api.ts)
    onApiWrite(() => {
      engine.request();
    }),
    // Step 18b: the sidebar's numbers (sync-summary.ts), live: a save, a push or another tab
    // changes the outbox, and the count follows
    watch(
      () => outboxCounts(copy),
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
    // Step 19b: the PIN, live: a new one or a wrong one, here or in another tab
    watch(
      () => keyStatus(db),
      (keys) => {
        set({ keys });
      },
      () => undefined,
    ),
    // The copy closes (a move, a revoke, a retry from the start): its numbers go with it
    () => {
      syncSummaryStore.setState(NO_SUMMARY);
    },
    () => {
      setDeviceReads(null);
      set({ keys: null });
    },
    () => {
      engine.stop();
    },
    // Step 19b: the key and the opened rows leave memory (decision 20)
    () => {
      copy.close();
    },
  );
  const pinDialog =
    status && !status.hasPin && !status.pinAsked ? (status.pinBlocked ? 'new' : 'set-up') : null;
  set({ device: { kind: 'ready', copy, engine, watch }, asking: false, pinDialog });
  engine.start();
}

// The server does not know this device (its database was restored): the same id and branch again.
// For the engine's pull and for the key's request.
async function registerAgain(session: Session): Promise<void> {
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
}

// Step 19b (decision 17, no PIN): the server's key does not open the copy, and nothing else can. It
// is deleted and pulled again; what had not synced cannot be read any more, and goes with it.
async function remake(session: Session): Promise<void> {
  runCleanup(session);
  await deleteLocalDatabase(session.tenantId, session.userId);
  if (hasEnded(session)) return;
  toast(i18n.t('sync.copyRemade'));
  await open(session);
}

// Step 19b: the copy closes and opens again, which decides afresh how (openCopy)
function reopen(session: Session): void {
  runCleanup(session);
  set({ device: { kind: 'starting' } });
  void open(session);
}

// Step 19b (decision 4): "Lock now". The flag first, so a reload from here on shows the lock screen
// too, and the other tabs lock (followLock). Closing the copy drops its key and its in-memory
// tables; it then opens again only as far as the lock screen.
function lockNow(session: Session): void {
  session.locked = true;
  markLocked();
  reopen(session);
}

// Step 19b: the PIN dialog's save (decision 5). A new PIN is wrapped with the server's key, so it
// needs the connection; a change opens the key with the current PIN, and a wrong one counts as on
// the lock screen (keys.ts). The API's errors (no connection) go to the dialog.
async function savePin(session: Session, save: PinSave): Promise<{ kind: 'set' } | KeyProblem> {
  const { device } = localDataStore.getState();
  if (device.kind !== 'ready') throw new Error('No copy is open on this device');
  const unlock: Unlock =
    save.current === '' ? { serverKey: await fetchServerKey(session) } : { pin: save.current };
  return setPin(device.copy.db, unlock, save.pin);
}

// After set-up, closing the dialog any way is "Not now": not asked again on this copy. The Sync
// page's card still sets one. The dialog closes once the answer is saved: a reload right after the
// click would otherwise cut the write off, and ask again (found by the 19b.5 e2e test). Only this
// dialog: the fifth wrong current PIN may have put the "new PIN" dialog in its place meanwhile.
function closePin(): void {
  const { device, pinDialog } = localDataStore.getState();
  const close = () => {
    if (localDataStore.getState().pinDialog === pinDialog) set({ pinDialog: null });
  };
  if (pinDialog === 'change' || device.kind !== 'ready') {
    close();
    return;
  }
  void markPinAsked(device.copy.db).finally(close);
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

// Step 20a (decision 14): signing out lets go of the register this device holds, so the next
// cashier's device can take it. Only with no sale of it waiting in the outbox: the server must
// receive every number before another device goes on from its last one. logout() calls this
// before the server's session ends (the release needs it). No copy open (locked, not set up), no
// connection, or a refusal: the register stays with this device, and the sign-out goes on. The
// next sign-in on this browser is the same device and takes it back; a lost PC is revoked, which
// frees it (20a.2).
export async function releaseRegister(): Promise<void> {
  const session = current;
  const { device } = localDataStore.getState();
  if (!session || device.kind !== 'ready') return;
  const claim = await readClaim(device.copy);
  if (!claim || (await waitingSales(device.copy)) > 0) return;
  await call(routes.pos.releaseRegister, {
    params: { id: claim.registerId },
    body: { deviceId: session.identity.id },
  });
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
  if ((await outboxCounts(device.copy)).total > 0) return 'waiting';
  // Step 19b (decision 37): the key's row goes into the new copy, so the PIN still opens it
  const keep = await device.copy.db.keys.get('data');
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
  if (!hasEnded(session)) await open(session, keep);
  return moved;
}
