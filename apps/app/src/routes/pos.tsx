import {
  ArrowLeft01Icon,
  ArrowLeftRightIcon,
  CashierIcon,
  KeyboardIcon,
  Wifi01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  formatPosNumber,
  routes,
  type SyncPosRegister,
  type SyncSettings,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  allRows,
  dropClaim,
  type LocalCopy,
  localRegisters,
  readClaim,
  type RegisterClaim,
  waitingSales,
} from '@omnivo/sync';
import { cn, EmptyState, IconButton, Logo, Pill, toast } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { LocalState, SyncNotice } from '../components/local-state';
import { PosScreen } from '../components/pos-screen';
import { ApiRequestError, call } from '../lib/api';
import { useLocalData, useLocalQuery, useThisDeviceId } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';
import { useSyncSummary } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';

// Step 20a: the POS screen (decision 12). The AppFrame draws it without the shell: a slim bar on
// top, then the register this device sells on, then the products and the cart (pos-screen.tsx).
// Everything it sells from is the device's copy, so it works the same with or without a
// connection; only taking or changing a register needs one.

// "Which counter is this?": once per device, online, so in a chunk of its own (with the server
// query it needs), and the selling screen's chunk stays in its budget
const RegisterChooser = lazy(async () => ({
  default: (await import('../components/pos-register')).RegisterChooser,
}));

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

export function PosPage() {
  const { t } = useLocale();
  const can = useCan();
  const deviceId = useThisDeviceId();
  const { view, notice } = useLocalData();
  const ready = view.kind === 'ready';
  const registers = useLocalQuery(ready ? localRegisters : null);
  const claim = useLocalQuery(ready ? readClaim : null);
  const settings = useLocalQuery(ready ? readSettings : null);
  const [shortcuts, setShortcuts] = useState(false);

  const register =
    registers && claim !== undefined ? heldRegister(registers, claim, deviceId) : undefined;

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
    return (
      <PosScreen
        copy={view.copy}
        register={register}
        settings={settings}
        shortcuts={shortcuts}
        onShortcuts={setShortcuts}
      />
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
        onShortcuts={
          register
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
        {view.kind === 'ready' && register && claim && settings ? (
          content()
        ) : (
          <div className="grid flex-1 place-items-center overflow-y-auto p-4">{content()}</div>
        )}
      </main>
    </div>
  );
}

// The bar: the logo, the register and who sells, the next number, the sync line and the way out.
// On a phone only what fits: the register's code, the sync icon and the exit icon.
function PosTopBar({
  copy,
  register,
  claim,
  onShortcuts,
}: {
  copy: LocalCopy | null;
  register: SyncPosRegister | null;
  claim: RegisterClaim | null;
  onShortcuts: (() => void) | undefined;
}) {
  const { t } = useLocale();
  const cashier = useSession((state) => state.me?.user.fullName) ?? '';
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 print:hidden">
      <Logo />
      <Pill tone="brand" icon={CashierIcon}>
        {t('pos.title')}
      </Pill>
      {register && claim && copy && (
        <>
          <span aria-hidden="true" className="h-6 w-px bg-line max-sm:hidden" />
          <ChangeRegister copy={copy} register={register} />
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
function ChangeRegister({ copy, register }: { copy: LocalCopy; register: SyncPosRegister }) {
  const { t, errorText } = useLocale();
  const online = useOnline();
  const deviceId = useThisDeviceId();
  const [busy, setBusy] = useState(false);
  const change = async () => {
    if (!deviceId) return;
    if ((await waitingSales(copy)) > 0) {
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
