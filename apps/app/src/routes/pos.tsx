import {
  ArrowLeft01Icon,
  ArrowLeftRightIcon,
  CashierIcon,
  KeyboardIcon,
  LockKeyIcon,
  Wifi01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  formatPosNumber,
  lockAfterMs,
  routes,
  type SyncPosRegister,
  type SyncSettings,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  allRows,
  type DeviceShift,
  dropClaim,
  heldCount,
  type LocalCopy,
  localCashReasons,
  localRegisters,
  readClaim,
  readShift,
  type RegisterClaim,
  type ShiftCloseResult,
  shiftStart,
  waitingAtCounter,
} from '@omnivo/sync';
import { Button, cn, EmptyState, IconButton, Logo, Pill, toast } from '@omnivo/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { LocalState, SyncNotice } from '../components/local-state';
import { ShiftButton } from '../components/pos-parts';
import { PosScreen, type ShiftRequest } from '../components/pos-screen';
import { ApiRequestError, call } from '../lib/api';
import {
  askForPin,
  lockIdle,
  useKeyStatus,
  useLocalData,
  useLocalQuery,
  useThisDeviceId,
} from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { logout } from '../lib/session';
import { useSession } from '../lib/session-store';
import { useSyncSummary } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';

// Step 20a: the POS screen (decision 12). The AppFrame draws it without the shell: a slim bar on
// top, then the register this device sells on, then the products and the cart (pos-screen.tsx).
// Everything it sells from is the device's copy, so it works the same with or without a
// connection; only taking or changing a register needs one.
// Step 20b: and between the register and the selling screen, the shift (decision 1): the open
// card until one is open, the shift menu in the bar while it is, the result after its close.

// "Which counter is this?": once per device, online, so in a chunk of its own (with the server
// query it needs), and the selling screen's chunk stays in its budget
const RegisterChooser = lazy(async () => ({
  default: (await import('../components/pos-register')).RegisterChooser,
}));
// Step 20b: the open card and the close's result, in the shift's chunk (pos-shift.tsx)
const OpenShiftCard = lazy(async () => ({
  default: (await import('../components/pos-shift')).OpenShiftCard,
}));
const ShiftClosedDialog = lazy(async () => ({
  default: (await import('../components/pos-shift')).ShiftClosedDialog,
}));
// Step 20b: the shift menu brings the dropdown's code, which no other part of /pos has (the
// shell's menus are not drawn here): its own chunk, with a look-alike button for the moment it loads
const ShiftMenu = lazy(async () => ({
  default: (await import('../components/pos-shift-menu')).ShiftMenu,
}));
const SignOutDialog = lazy(async () => ({
  default: (await import('../components/sign-out-dialog')).SignOutDialog,
}));

type ClosedShift = Extract<ShiftCloseResult, { kind: 'closed' }>;

// Module level, so they are stable for useLocalQuery (a new function is a new read)
async function readSettings(copy: LocalCopy): Promise<SyncSettings | null> {
  const [settings] = await allRows(copy, copy.db.settings);
  return settings ?? null;
}

// The register the device sells on: the one its claim names, as the copy has it. A row that says
// another device holds it means the register was taken from this device (a revoke or a move frees
// it, 20a.2, and someone else took it), so the claim no longer counts. A row with no holder is
// this device's claim before the next pull brings the holder.
function heldRegister(
  registers: readonly SyncPosRegister[],
  claim: RegisterClaim | null,
  deviceId: string | null,
): SyncPosRegister | null {
  if (!claim) return null;
  const register = registers.find((row) => row.id === claim.registerId);
  return register && (register.deviceId === null || register.deviceId === deviceId)
    ? register
    : null;
}

// Step 20b (decision 7): the register's idle lock. No key, click, touch or scroll in this tab for
// the register's minutes, and the device locks, the way Lock now does (the other tabs too). The
// lock screen takes the AppFrame's place, so this screen goes; its cart is on the device
// (pos-screen.tsx). A dialog open (the payment) does not stop it: a counter left alone locks.
// null = off, or nothing to lock with (no PIN, no open shift).
function useIdleLock(lockAfter: SyncPosRegister['lockAfter'] | null) {
  useEffect(() => {
    if (lockAfter === null) return;
    const ms = lockAfterMs(lockAfter);
    if (ms === null) return;
    let last = Date.now();
    const seen = () => {
      last = Date.now();
    };
    const events = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'] as const;
    for (const name of events) window.addEventListener(name, seen, { passive: true });
    // A check every few seconds, not a timer reset on every move of the mouse
    const timer = setInterval(() => {
      if (Date.now() - last >= ms) lockIdle(Number(lockAfter));
    }, 5_000);
    return () => {
      for (const name of events) window.removeEventListener(name, seen);
      clearInterval(timer);
    };
  }, [lockAfter]);
}

export function PosPage() {
  const { t } = useLocale();
  const can = useCan();
  const deviceId = useThisDeviceId();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const { view, notice } = useLocalData();
  const ready = view.kind === 'ready';
  const registers = useLocalQuery(ready ? localRegisters : null);
  const claim = useLocalQuery(ready ? readClaim : null);
  const settings = useLocalQuery(ready ? readSettings : null);
  const shift = useLocalQuery(ready ? readShift : null);
  const reasons = useLocalQuery(ready ? localCashReasons : null);
  const keys = useKeyStatus();
  const [shortcuts, setShortcuts] = useState(false);
  const [request, setRequest] = useState<ShiftRequest | null>(null);
  const [closed, setClosed] = useState<ClosedShift | null>(null);
  const [asking, setAsking] = useState(false);
  const { waiting: unsynced } = useSyncSummary();

  const register =
    registers && claim !== undefined ? heldRegister(registers, claim, deviceId) : undefined;
  // The shift this screen sells on: open, and of the register the device holds
  const openShift = shift?.status === 'open' && shift.registerId === register?.id ? shift : null;

  // By the id: the shift's row is a new object after every write (each sale), the same read
  const openShiftId = openShift?.id ?? null;
  const readHeld = useCallback(
    (copy: LocalCopy) => (openShiftId ? heldCount(copy, openShiftId) : Promise.resolve(0)),
    [openShiftId],
  );
  const held = useLocalQuery(ready ? readHeld : null) ?? 0;

  // The sign-out's "Close shift" (decision 6) comes here with ?close=true: the close opens once,
  // and the address loses the flag, so a reload does not open it again
  const wantsClose = search.close === true;
  const closeHere = openShift !== null;
  useEffect(() => {
    if (!wantsClose || shift === undefined) return;
    void navigate({ to: '/pos', search: {}, replace: true }).then(() => {
      if (closeHere) setRequest('close');
    });
  }, [wantsClose, shift, closeHere, navigate]);

  useIdleLock(
    openShift && register && keys?.hasPin && register.lockAfter !== 'off'
      ? register.lockAfter
      : null,
  );

  const signOut = () => {
    setClosed(null);
    if (unsynced > 0) setAsking(true);
    else void logout();
  };

  // "Sign out" sits right after the close, whose command may still wait a moment when it is
  // pressed. Once nothing waits, there is nothing to lose: the question goes (it is drawn only
  // while something waits) and the sign-out goes on by itself, instead of asking about "0 changes".
  useEffect(() => {
    if (asking && unsynced === 0) void logout();
  }, [asking, unsynced]);

  const content = () => {
    if (view.kind !== 'ready') return <LocalState view={view} />;
    // Still reading the copy: a moment, nothing to draw
    if (registers === undefined || register === undefined || settings === undefined) return null;
    if (!can('pos.sale.create')) {
      return (
        <EmptyState icon={CashierIcon} title={t('pos.title')} description={t('pos.cantSell')} />
      );
    }
    if (registers.length === 0) {
      return (
        <EmptyState
          icon={CashierIcon}
          title={t('pos.noRegistersTitle')}
          description={t('pos.noRegistersBody')}
        />
      );
    }
    if (!register || !claim || !settings) {
      return (
        <Suspense fallback={null}>
          <RegisterChooser copy={view.copy} registers={registers} />
        </Suspense>
      );
    }
    if (shift === undefined || reasons === undefined) return null;
    if (openShift) {
      return (
        <PosScreen
          copy={view.copy}
          register={register}
          settings={settings}
          shift={openShift}
          reasons={reasons}
          request={request}
          onRequest={setRequest}
          onClosed={setClosed}
          shortcuts={shortcuts}
          onShortcuts={setShortcuts}
        />
      );
    }
    // Decision 13: no account for a difference, no shift (a register made before 20b)
    if (register.overShortAccountId === null) {
      return (
        <EmptyState
          icon={CashierIcon}
          title={t('pos.shift.openTitle')}
          description={t('pos.shift.needsOverShort', { code: register.code })}
        />
      );
    }
    // Decision 7: a register that locks itself needs the device's PIN to lock with
    if (register.lockAfter !== 'off' && !keys?.hasPin) {
      return (
        <EmptyState
          icon={LockKeyIcon}
          title={t('pos.shift.openTitle')}
          description={t('pos.shift.needsPin', { code: register.code })}
          action={
            keys && (
              <Button
                onClick={() => {
                  askForPin(keys.pinBlocked ? 'new' : 'set-up');
                }}
              >
                {t('pin.card.set')}
              </Button>
            )
          }
        />
      );
    }
    return (
      <Suspense fallback={null}>
        <OpenShiftCard
          copy={view.copy}
          register={register}
          start={shiftStart(register, shift)}
          reasons={reasons}
          today={todayIn(settings.timezone)}
        />
      </Suspense>
    );
  };

  return (
    // h-dvh and a column: the bar stays, the screen below takes the rest and scrolls inside its
    // own parts, never the page (a phone's address bar comes and goes: dvh follows it)
    <div className="flex h-dvh flex-col bg-bg text-ink">
      <PosTopBar
        copy={view.kind === 'ready' ? view.copy : null}
        register={register ?? null}
        claim={claim ?? null}
        shift={openShift}
        held={held}
        timeZone={settings?.timezone ?? 'Asia/Dhaka'}
        onRequest={setRequest}
        onShortcuts={
          openShift
            ? () => {
                setShortcuts(true);
              }
            : undefined
        }
      />
      {notice && (
        <div className="px-4 pt-3">
          <SyncNotice code={notice} />
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col">
        {view.kind === 'ready' && openShift ? (
          content()
        ) : (
          <div className="grid flex-1 place-items-center overflow-y-auto p-4">{content()}</div>
        )}
      </main>
      {closed && (
        <Suspense fallback={null}>
          <ShiftClosedDialog
            result={closed}
            onSignOut={signOut}
            onNext={() => {
              setClosed(null);
            }}
          />
        </Suspense>
      )}
      {asking && unsynced > 0 && (
        <Suspense fallback={null}>
          <SignOutDialog
            count={unsynced}
            onClose={() => {
              setAsking(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

// The bar: the logo, the register and who sells, the shift, the next number, the sync line and
// the way out. On a phone only what fits: the register's code, the shift, the sync icon and the
// exit icon.
function PosTopBar({
  copy,
  register,
  claim,
  shift,
  held,
  timeZone,
  onRequest,
  onShortcuts,
}: {
  copy: LocalCopy | null;
  register: SyncPosRegister | null;
  claim: RegisterClaim | null;
  shift: DeviceShift | null;
  held: number;
  timeZone: string;
  onRequest: (request: ShiftRequest) => void;
  onShortcuts: (() => void) | undefined;
}) {
  const { t } = useLocale();
  const cashier = useSession((state) => state.me?.user.fullName) ?? '';
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 print:hidden">
      <Logo />
      {/* Step 20b: not on a phone, where the shift's button (POS1-S0042) says it is the POS */}
      <span className={cn('inline-flex', shift && 'max-sm:hidden')}>
        <Pill tone="brand" icon={CashierIcon}>
          {t('pos.title')}
        </Pill>
      </span>
      {register && claim && copy && (
        <>
          <span aria-hidden="true" className="h-6 w-px bg-line max-sm:hidden" />
          <ChangeRegister copy={copy} register={register} shift={shift} />
          {shift && (
            <Suspense fallback={<ShiftButton number={shift.number} />}>
              <ShiftMenu
                shift={shift}
                held={held}
                cashier={cashier}
                timeZone={timeZone}
                onRequest={onRequest}
              />
            </Suspense>
          )}
          <span className="text-body-sm text-ink-2 max-lg:hidden">
            {t('pos.cashier', { name: cashier })}
          </span>
          <span className="text-body-sm text-ink-3 tabular-nums max-md:hidden">
            {t('pos.nextNumber', { number: formatPosNumber(register.code, claim.last + 1) })}
          </span>
        </>
      )}
      <span className="flex-1" />
      <PosSyncLink />
      {onShortcuts && (
        <IconButton
          icon={KeyboardIcon}
          label={t('pos.shortcuts')}
          onClick={onShortcuts}
          className="max-md:hidden"
        />
      )}
      <Link
        to="/"
        aria-label={t('pos.exit')}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle hover:text-ink"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={18} strokeWidth={1.5} />
        <span className="max-sm:hidden">{t('pos.exit')}</span>
      </Link>
    </header>
  );
}

// The register's name, and the way to let it go (decision 14). Only online, and only with no sale
// of it waiting on the device: the server must have every number before another device goes on
// from its last one. The claim goes after the server let go, so the chooser comes back.
// Step 20b: and only with no shift open (decision 32): the server refuses it, so the screen says
// what to do first.
function ChangeRegister({
  copy,
  register,
  shift,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  shift: DeviceShift | null;
}) {
  const { t, errorText } = useLocale();
  const online = useOnline();
  const deviceId = useThisDeviceId();
  const [busy, setBusy] = useState(false);
  const change = async () => {
    if (!deviceId) return;
    if (shift) {
      toast(t('pos.shift.changeRegisterOpen', { number: shift.number }));
      return;
    }
    if ((await waitingAtCounter(copy)) > 0) {
      toast(t('pos.changeRegisterWaiting', { code: register.code }));
      return;
    }
    if (!online) {
      toast(t('pos.chooseOffline'));
      return;
    }
    setBusy(true);
    try {
      await call(routes.pos.releaseRegister, {
        params: { id: register.id },
        body: { deviceId },
      });
      await dropClaim(copy);
    } catch (error) {
      toast(errorText(error instanceof ApiRequestError ? error.code : 'unknown_error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void change()}
      title={t('pos.changeRegister')}
      className="inline-flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-body-sm font-medium transition-colors duration-150 hover:bg-subtle"
    >
      <span className="truncate">
        <span className="sm:hidden">{register.code}</span>
        <span className="max-sm:hidden">
          {t('pos.register', { code: register.code, name: register.name })}
        </span>
      </span>
      <HugeiconsIcon
        icon={ArrowLeftRightIcon}
        size={16}
        strokeWidth={1.5}
        className="shrink-0 text-ink-3"
      />
      <span className="sr-only">{t('pos.changeRegister')}</span>
    </button>
  );
}

// The sidebar's sync line, small: online or not, and the changes waiting (a refused one in crit).
// It links to the Sync page, which opens in the shell; the browser's Back comes back here.
function PosSyncLink() {
  const { t, format } = useLocale();
  const online = useOnline();
  const { syncing, waiting, failed } = useSyncSummary();
  const state = !online ? t('sync.offline') : syncing ? t('sync.syncing') : t('sync.online');
  const count = failed > 0 ? failed : waiting;
  const counted =
    failed > 0
      ? t('sync.needsAttention', { count: failed, formatted: format.number(failed) })
      : waiting > 0
        ? t('sync.waiting', { count: waiting, formatted: format.number(waiting) })
        : t('sync.allSynced');
  return (
    <Link
      to="/sync"
      aria-label={`${t('nav.sync')}: ${state}, ${counted}`}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle"
    >
      <HugeiconsIcon
        icon={online ? Wifi01Icon : WifiDisconnected02Icon}
        size={18}
        strokeWidth={1.5}
        className="text-ink-3"
      />
      <span className="max-sm:hidden">{state}</span>
      {count > 0 && (
        <span
          className={cn(
            'text-caption text-ink-3 tabular-nums',
            failed > 0 && 'font-medium text-crit',
          )}
        >
          {format.number(count)}
        </span>
      )}
    </Link>
  );
}
