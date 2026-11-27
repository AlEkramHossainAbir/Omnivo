import {
  ComputerPhoneSyncIcon,
  Download04Icon,
  LockKeyIcon,
  Logout01Icon,
  SquareLock02Icon,
  UnfoldMoreIcon,
  UserCircleIcon,
  Wifi01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { THEMES } from '@omnivo/contracts';
import { isLanguage, LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  AppShell as Shell,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Logo,
  ModuleRail,
  ModuleRailItem,
  NavGroup,
  NavItem,
  SidebarNav,
  toast,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { createLink, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { NotificationBell } from '../components/notification-bell';
import { type InstallWay, promptInstall, useInstallWay } from '../lib/install';
import {
  landingFor,
  leafBadge,
  leafExact,
  leafVisible,
  moduleById,
  moduleOf,
  type ModuleId,
  type NavBadge,
  sectionLabel,
  visibleModules,
  waitingIn,
} from '../lib/nav';
import { savePreference } from '../lib/preferences';
import { logout, switchTenant } from '../lib/session';
import { useCan } from '../lib/permissions';
import { storefrontOrderCountQuery, waitingCountQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useSyncAge, useSyncSummary } from '../lib/sync-summary';
import { isTheme } from '../lib/theme';
import { useOnline } from '../lib/use-online';

// Step 18b: the question before signing out with changes on the device. Loaded when it is asked:
// the dialog's code (about 14 KB gz with its focus trap and scroll lock) took the shell over its
// budget, for a dialog most sessions never open.
const SignOutDialog = lazy(async () => ({
  default: (await import('../components/sign-out-dialog')).SignOutDialog,
}));
// Step 20b: "Close the shift first", from the same chunk
const ShiftOpenDialog = lazy(async () => ({
  default: (await import('../components/sign-out-dialog')).ShiftOpenDialog,
}));
// Step 19a: Safari's how-to, the same way: opened once per device at most
const InstallDialog = lazy(async () => ({
  default: (await import('../components/install-dialog')).InstallDialog,
}));

// ui-র সাধারণ <a> → TanStack-এর টাইপ-চেকড লিংক: to="/kitchn-sink" লিখলে compile error,
// আর সক্রিয় রুটে Link নিজেই aria-current="page" বসায়
const NavLink = createLink(NavItem);
// Step 29: the rail's items are links too (to their module's landing page), so Back works and a
// module can be opened in a new tab
const ModuleLink = createLink(ModuleRailItem);

type Can = ReturnType<typeof useCan>;
type BadgeCounts = Readonly<Record<NavBadge, number>>;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

function WorkspaceSwitcher() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!me) return null;

  const summary = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand text-[12.5px] font-semibold text-brand-ink">
        {initials(me.tenant.name)}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-body-sm font-medium">{me.tenant.name}</span>
        <span className="block truncate text-caption text-ink-3">{me.tenant.slug}.omnivo.app</span>
      </span>
    </>
  );

  // একটাই workspace হলে বদলানোর কিছু নেই — মেনুর বদলে শুধু তথ্য
  if (me.memberships.length < 2) {
    return (
      <div className="flex items-center gap-2.5 rounded-control border border-line px-2.5 py-2">
        {summary}
      </div>
    );
  }

  return (
    // grid-cols-1 = minmax(0, 1fr): লম্বা কোম্পানির নাম বাটনকে সাইডবারের বাইরে ঠেলে না, truncate হয়
    <div className="grid grid-cols-1 gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={switching}
            aria-label={t('shell.switchWorkspace')}
            className="flex w-full items-center gap-2.5 rounded-control border border-line-strong px-2.5 py-2 shadow-sm transition-colors duration-150 hover:bg-subtle"
          >
            {summary}
            <HugeiconsIcon
              icon={UnfoldMoreIcon}
              size={16}
              strokeWidth={1.5}
              className="shrink-0 text-ink-3"
            />
          </button>
        </DropdownMenuTrigger>
        {/* Radix trigger-এর চওড়া CSS variable-এ দেয় — মেনু ঠিক বাটনের সমান চওড়া */}
        <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuLabel>{t('shell.workspaces')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={me.tenant.id}
            onValueChange={(tenantId) => {
              const target = me.memberships.find((m) => m.tenantId === tenantId);
              setSwitching(true);
              setFailed(false);
              // ব্যর্থ হলে store বদলায় না, তাই মেনুর টিক আগের workspace-এই থাকে
              switchTenant(tenantId)
                .then(() => {
                  if (target) toast(t('shell.switched', { name: target.name }));
                })
                .catch(() => {
                  setFailed(true);
                })
                .finally(() => {
                  setSwitching(false);
                });
            }}
          >
            {me.memberships.map((membership) => (
              <DropdownMenuRadioItem key={membership.tenantId} value={membership.tenantId}>
                {membership.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {failed && (
        <p role="alert" className="px-1 text-caption text-crit">
          {t('shell.switchFailed')}
        </p>
      )}
    </div>
  );
}

// Step 18b (decision 1): the sidebar line. It says whether the device is online, and how many
// changes wait (a refused one first, in crit, since the person must act on it). It links to the
// Sync page. The screen reader hears the whole sentence, not "Offline 3".
// Step 18c (decision 12): 24 hours after the last sync, the line says how long ago it was, in warn,
// in place of Online or Offline (the icon still says which). "Syncing…" wins: it is the answer.
// Step 29: it is the last item of every module's menu, not an item of one module: offline is
// something the person must see wherever they are.
function SyncNavItem() {
  const { t, format } = useLocale();
  const online = useOnline();
  const { syncing, waiting: total, failed } = useSyncSummary();
  const age = useSyncAge();
  const stale =
    !syncing && age !== null && age.age !== 'fresh'
      ? t('sync.lastSyncedDays', { count: age.days, formatted: format.number(age.days) })
      : null;
  const state = !online ? t('sync.offline') : syncing ? t('sync.syncing') : t('sync.online');
  const count = failed > 0 ? failed : total;
  const counted =
    failed > 0
      ? t('sync.needsAttention', { count: failed, formatted: format.number(failed) })
      : total > 0
        ? t('sync.waiting', { count: total, formatted: format.number(total) })
        : t('sync.allSynced');
  return (
    <NavLink
      to="/sync"
      icon={online ? Wifi01Icon : WifiDisconnected02Icon}
      count={count > 0 ? count : undefined}
      countTone={failed > 0 ? 'crit' : 'neutral'}
      aria-label={`${t('nav.sync')}: ${stale === null ? state : `${state}, ${stale}`}, ${counted}`}
    >
      {stale === null ? state : <span className="text-warn">{stale}</span>}
    </NavLink>
  );
}

// Step 29 (CLAUDE.md → Module rail): the eight modules. Which one is marked comes from the route,
// so a page deep inside a module still says where it is; a page that belongs to no module
// (/sync, /my-devices) marks none.
function Modules({ open, can, counts }: { open: ModuleId | null; can: Can; counts: BadgeCounts }) {
  const { t, format } = useLocale();
  return (
    <ModuleRail label={t('shell.modules')}>
      {visibleModules(can).map((module) => {
        const waiting = waitingIn(module, can, counts);
        const name = t(module.labelKey);
        return (
          <ModuleLink
            key={module.id}
            to={landingFor(module, can)}
            icon={module.icon}
            current={module.id === open}
            waiting={waiting > 0}
            // The dot is not a number, so the count goes into the name a screen reader reads
            aria-label={
              waiting > 0
                ? t('shell.moduleWaiting', {
                    name,
                    count: waiting,
                    formatted: format.number(waiting),
                  })
                : undefined
            }
          >
            {name}
          </ModuleLink>
        );
      })}
    </ModuleRail>
  );
}

// The open module's links, in sections that follow the order of work. The key on the nav remounts
// it on a module switch, which is what plays the 160ms fade (CLAUDE.md → Module switch motion)
function ModuleMenu({ open, can, counts }: { open: ModuleId; can: Can; counts: BadgeCounts }) {
  const { t } = useLocale();
  const module = moduleById(open);
  const name = t(module.labelKey);
  return (
    <>
      {/* Visible on a desktop, read by a screen reader on a phone, where there is no room for it */}
      <p className="sr-only px-2.5 text-h3 font-semibold min-[860px]:not-sr-only">{name}</p>
      <SidebarNav key={module.id} label={name} className="module-menu-in">
        {module.sections.map((section) => {
          const items = section.items.filter((leaf) => leafVisible(leaf, can));
          if (items.length === 0) return null;
          const label = sectionLabel(section);
          return (
            <NavGroup key={label ?? 'main'} label={label === undefined ? undefined : t(label)}>
              {items.map((leaf) => {
                const badge = leafBadge(leaf);
                const count = badge === undefined ? 0 : counts[badge];
                return (
                  <NavLink
                    key={leaf.to}
                    to={leaf.to}
                    icon={leaf.icon}
                    // exact: a route with children (/products, /stock, /) is active on its own page.
                    // Spread, not activeOptions={undefined}: exactOptionalPropertyTypes refuses an
                    // explicit undefined for a prop the router declares as optional
                    {...(leafExact(leaf) ? { activeOptions: { exact: true } } : {})}
                    count={count > 0 ? count : undefined}
                    countTone="crit"
                  >
                    {t(leaf.labelKey)}
                  </NavLink>
                );
              })}
            </NavGroup>
          );
        })}
        {/* sticky: Sell's fifteen links are taller than a 900px laptop, and the menu scrolls. The
            sync line says whether the device is offline and how much waits on it, so it stays on
            the screen instead of going under the fold with the last links */}
        <NavGroup className="min-[860px]:sticky min-[860px]:-bottom-5 min-[860px]:border-t min-[860px]:border-line min-[860px]:bg-surface min-[860px]:pt-4 min-[860px]:pb-5">
          <SyncNavItem />
        </NavGroup>
      </SidebarNav>
    </>
  );
}

// ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
// Step 19b: the account menu's lock item (decision 4), from the AppFrame, which has the copy.
// pin = "Lock now"; without a PIN the item opens the PIN dialog instead.
export interface LockAction {
  pin: boolean;
  run: () => void;
}

function UserMenuContent({
  align,
  onInstall,
  lock,
  onSignOut,
}: {
  align: 'start' | 'end';
  // Step 19a: undefined = nothing to install (installed already, or a browser that cannot)
  onInstall: (() => void) | undefined;
  // Step 19b: undefined = no copy open on this device, so nothing to lock
  lock: LockAction | undefined;
  onSignOut: () => void;
}) {
  const { t, language } = useLocale();
  const navigate = useNavigate();
  const theme = useSession((state) => state.me?.preferences.theme ?? 'system');
  return (
    <DropdownMenuContent align={align}>
      {/* Step 18c (decision 22): what is about the person themself is in this menu; the app has
          no profile page */}
      <DropdownMenuItem
        icon={ComputerPhoneSyncIcon}
        onSelect={() => void navigate({ to: '/my-devices' })}
      >
        {t('shell.myDevices')}
      </DropdownMenuItem>
      {/* Step 19a: about this device, like My devices */}
      {onInstall && (
        <DropdownMenuItem icon={Download04Icon} onSelect={onInstall}>
          {t('shell.installApp')}
        </DropdownMenuItem>
      )}
      {lock && (
        <DropdownMenuItem icon={lock.pin ? SquareLock02Icon : LockKeyIcon} onSelect={lock.run}>
          {lock.pin ? t('shell.lockNow') : t('shell.setPinToLock')}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={language}
        onValueChange={(value) => {
          // Radix মান দেয় string হিসেবে — type guard দিয়ে Language-এ নামানো, cast না।
          // এই ডিভাইসে সাথে সাথে, আর অ্যাকাউন্টে সেভ — অন্য ফোন/ল্যাপটপে লগইন করলেও একই ভাষা
          if (isLanguage(value)) void savePreference({ language: value });
        }}
      >
        {LANGUAGES.map((option) => (
          // lang: স্ক্রিন রিডার "বাংলা" বাংলা উচ্চারণে পড়ে
          <DropdownMenuRadioItem key={option.code} value={option.code} lang={option.code}>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => {
          if (isTheme(value)) void savePreference({ theme: value });
        }}
      >
        {THEMES.map((option) => (
          <DropdownMenuRadioItem key={option} value={option}>
            {t(`shell.themes.${option}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem icon={Logout01Icon} onSelect={onSignOut}>
        {t('common.signOut')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

// Step 19b: inside the AppFrame (app-frame.tsx), which runs the device's copy beside it and shows the
// lock screen in its place
export function AppShell({ lock }: { lock: LockAction | undefined }) {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
  const can = useCan();
  // Step 29: which module this page belongs to, worked out from the route (lib/nav.ts). null on a
  // page that belongs to none, and then the menu shows Home while the rail marks nothing
  const open = useRouterState({ select: (state) => moduleOf(state.location.pathname) });
  // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
  const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
  // Step 27b: the shop orders nobody has packed yet. Only for someone who may read them: anyone
  // else would be refused every 30 seconds
  const canShopOrders = can('storefront.order.read');
  const { data: newOrders = 0 } = useQuery({
    ...storefrontOrderCountQuery(me?.tenant.id ?? ''),
    enabled: canShopOrders,
  });
  const counts: BadgeCounts = { approvals: waiting, shopOrders: newOrders };
  // Step 18b: sign out at once with nothing on the device, else ask. Step 20b (decision 6): an
  // open POS shift comes first: it is closed before anything else.
  const { waiting: unsynced, openShift } = useSyncSummary();
  const [asking, setAsking] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const navigate = useNavigate();
  const signOut = () => {
    if (openShift !== null) setShiftOpen(true);
    else if (unsynced > 0) setAsking(true);
    else void logout();
  };
  // Step 19a (decision 20): Chrome's own prompt, or the dialog with Safari's steps
  const installWay = useInstallWay();
  const [installHelp, setInstallHelp] = useState<Exclude<InstallWay, 'prompt'> | null>(null);
  const install =
    installWay === null
      ? undefined
      : () => {
          if (installWay === 'prompt') promptInstall();
          else setInstallHelp(installWay);
        };

  return (
    <Shell
      brand={<Logo />}
      actions={<NotificationBell />}
      topBarActions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon={UserCircleIcon} label={t('shell.account')} />
          </DropdownMenuTrigger>
          <UserMenuContent align="end" onInstall={install} lock={lock} onSignOut={signOut} />
        </DropdownMenu>
      }
      rail={<Modules open={open} can={can} counts={counts} />}
      sidebarHeader={
        <>
          <WorkspaceSwitcher />
          {/* Someone who cannot see the rail hears which menu they are in now */}
          <p role="status" className="sr-only">
            {t('shell.moduleMenu', { name: t(moduleById(open ?? 'home').labelKey) })}
          </p>
        </>
      }
      nav={<ModuleMenu open={open ?? 'home'} can={can} counts={counts} />}
      sidebarFooter={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-subtle"
            >
              <HugeiconsIcon
                icon={UserCircleIcon}
                size={18}
                strokeWidth={1.5}
                className="shrink-0 text-ink-3"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm font-medium">{me?.user.fullName}</span>
                <span className="block truncate text-caption text-ink-3">{me?.user.email}</span>
              </span>
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                size={16}
                strokeWidth={1.5}
                className="shrink-0 text-ink-3"
              />
            </button>
          </DropdownMenuTrigger>
          <UserMenuContent align="start" onInstall={install} lock={lock} onSignOut={signOut} />
        </DropdownMenu>
      }
    >
      <Outlet />
      {asking && (
        <Suspense fallback={null}>
          <SignOutDialog
            count={unsynced}
            onClose={() => {
              setAsking(false);
            }}
          />
        </Suspense>
      )}
      {shiftOpen && openShift !== null && (
        <Suspense fallback={null}>
          <ShiftOpenDialog
            number={openShift}
            onClose={() => {
              setShiftOpen(false);
            }}
            onCloseShift={() => {
              void navigate({ to: '/pos', search: { close: true } });
            }}
          />
        </Suspense>
      )}
      {installHelp && (
        <Suspense fallback={null}>
          <InstallDialog
            way={installHelp}
            onClose={() => {
              setInstallHelp(null);
            }}
          />
        </Suspense>
      )}
    </Shell>
  );
}
