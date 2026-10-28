import {
  ArrowDataTransferHorizontalIcon,
  BalanceScaleIcon,
  Book02Icon,
  BookOpen02Icon,
  CalendarLock01Icon,
  Cashier02Icon,
  CashierIcon,
  ChartIncreaseIcon,
  CheckmarkBadge01Icon,
  Coins01Icon,
  ComputerPhoneSyncIcon,
  DashboardSquare01Icon,
  DeliveryReturn01Icon,
  DeliveryTruck01Icon,
  Download04Icon,
  Factory01Icon,
  FileDownloadIcon,
  FileImportIcon,
  FolderTreeIcon,
  HourglassIcon,
  Invoice01Icon,
  Invoice03Icon,
  Invoice04Icon,
  Layers01Icon,
  LayoutGridIcon,
  LeftToRightListNumberIcon,
  LockKeyIcon,
  Logout01Icon,
  MoneyExchange01Icon,
  MoneyReceive02Icon,
  MoneyReceiveCircleIcon,
  MoneySend02Icon,
  Note01Icon,
  Notebook02Icon,
  NoteRemoveIcon,
  PackageIcon,
  PackageOutOfStockIcon,
  PackageReceiveIcon,
  PackageRemoveIcon,
  Payment02Icon,
  PieChartIcon,
  ReceiptDollarIcon,
  RulerIcon,
  SecurityCheckIcon,
  Settings02Icon,
  ShoppingBasket01Icon,
  ShoppingCart01Icon,
  SquareLock02Icon,
  Store01Icon,
  TableIcon,
  Tag01Icon,
  TaskAdd01Icon,
  TaskEdit01Icon,
  TextIcon,
  TruckReturnIcon,
  UnfoldMoreIcon,
  UserCheck01Icon,
  UserCircleIcon,
  UserGroup02Icon,
  UserGroup03Icon,
  UserGroupIcon,
  UserMultiple02Icon,
  WarehouseIcon,
  Wifi01Icon,
  WifiDisconnected02Icon,
  WorkHistoryIcon,
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
  NavGroup,
  NavItem,
  SidebarNav,
  toast,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { NotificationBell } from '../components/notification-bell';
import { type InstallWay, promptInstall, useInstallWay } from '../lib/install';
import { savePreference } from '../lib/preferences';
import { logout, switchTenant } from '../lib/session';
import { useCan } from '../lib/permissions';
import { waitingCountQuery } from '../lib/queries';
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
// Step 19a: Safari's how-to, the same way: opened once per device at most
const InstallDialog = lazy(async () => ({
  default: (await import('../components/install-dialog')).InstallDialog,
}));

// ui-র সাধারণ <a> → TanStack-এর টাইপ-চেকড লিংক: to="/kitchn-sink" লিখলে compile error,
// আর সক্রিয় রুটে Link নিজেই aria-current="page" বসায়
const NavLink = createLink(NavItem);

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
  // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
  const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
  // Step 18b: sign out at once with nothing on the device, else ask
  const { waiting: unsynced } = useSyncSummary();
  const [asking, setAsking] = useState(false);
  const signOut = () => {
    if (unsynced > 0) setAsking(true);
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
      sidebarHeader={<WorkspaceSwitcher />}
      nav={
        <SidebarNav label={t('shell.mainNav')}>
          <NavGroup>
            {/* exact: নাহলে "/" সব রুটের পূর্বপুরুষ, তাই সব পেজে Overview-ও সক্রিয় দেখাত */}
            <NavLink to="/" icon={DashboardSquare01Icon} activeOptions={{ exact: true }}>
              {t('nav.overview')}
            </NavLink>
            <SyncNavItem />
            {import.meta.env.DEV && (
              <NavLink to="/kitchen-sink" icon={LayoutGridIcon}>
                {t('nav.kitchenSink')}
              </NavLink>
            )}
          </NavGroup>
          {/* Every member reads the chart (from step 10, every entry form picks accounts from it) */}
          <NavGroup label={t('nav.accounting')}>
            <NavLink to="/accounts" icon={BookOpen02Icon}>
              {t('nav.chartOfAccounts')}
            </NavLink>
            {/* The books themselves (salaries, margins) are for people with the read permission */}
            {can('accounting.journal.read') && (
              <>
                <NavLink to="/journal" icon={Notebook02Icon}>
                  {t('nav.journal')}
                </NavLink>
                <NavLink to="/ledger" icon={Book02Icon}>
                  {t('nav.ledger')}
                </NavLink>
                <NavLink to="/opening-balances" icon={BalanceScaleIcon}>
                  {t('nav.openingBalances')}
                </NavLink>
                <NavLink to="/year-end" icon={CalendarLock01Icon}>
                  {t('nav.yearEnd')}
                </NavLink>
              </>
            )}
          </NavGroup>
          {/* The statements: for anyone with the report permission, journal or not (a director) */}
          {can('accounting.report.read') && (
            <NavGroup label={t('nav.reports')}>
              <NavLink to="/reports/trial-balance" icon={TableIcon}>
                {t('nav.trialBalance')}
              </NavLink>
              <NavLink to="/reports/profit-and-loss" icon={ChartIncreaseIcon}>
                {t('nav.profitAndLoss')}
              </NavLink>
              <NavLink to="/reports/balance-sheet" icon={PieChartIcon}>
                {t('nav.balanceSheet')}
              </NavLink>
              <NavLink to="/reports/exports" icon={FileDownloadIcon}>
                {t('nav.exports')}
              </NavLink>
            </NavGroup>
          )}
          {/* Sales (step 15a): everyone reads the customers and the price lists — every sales
              document picks them. Changing them is checked on the pages and by the API. Step 15b:
              the documents come first, in the order they follow each other; everyone reads them
              too (a store keeper looks up an order before loading the truck). Step 15c: the
              invoice and the money receipt end the chain. Step 15d: what goes back the other way
              comes after them, goods first, then money. */}
          <NavGroup label={t('nav.sales')}>
            {/* Step 20a: the counter screen first, for the cashiers who sell there (it opens
                without this sidebar) */}
            {can('pos.sale.create') && (
              <NavLink to="/pos" icon={CashierIcon}>
                {t('nav.pointOfSale')}
              </NavLink>
            )}
            {/* Everyone reads the posted sales, like every sales document */}
            <NavLink to="/pos/sales" icon={ReceiptDollarIcon}>
              {t('nav.posSales')}
            </NavLink>
            <NavLink to="/quotations" icon={Note01Icon}>
              {t('nav.quotations')}
            </NavLink>
            <NavLink to="/sales-orders" icon={ShoppingCart01Icon}>
              {t('nav.salesOrders')}
            </NavLink>
            <NavLink to="/deliveries" icon={DeliveryTruck01Icon}>
              {t('nav.deliveries')}
            </NavLink>
            <NavLink to="/invoices" icon={Invoice03Icon}>
              {t('nav.invoices')}
            </NavLink>
            <NavLink to="/receipts" icon={MoneyReceive02Icon}>
              {t('nav.receipts')}
            </NavLink>
            <NavLink to="/sales-returns" icon={DeliveryReturn01Icon}>
              {t('nav.salesReturns')}
            </NavLink>
            <NavLink to="/credit-notes" icon={Invoice04Icon}>
              {t('nav.creditNotes')}
            </NavLink>
            <NavLink to="/refunds" icon={MoneySend02Icon}>
              {t('nav.refunds')}
            </NavLink>
            <NavLink to="/customers" icon={UserMultiple02Icon}>
              {t('nav.customers')}
            </NavLink>
            <NavLink to="/customer-groups" icon={UserGroup03Icon}>
              {t('nav.customerGroups')}
            </NavLink>
            <NavLink to="/price-lists" icon={Tag01Icon}>
              {t('nav.priceLists')}
            </NavLink>
          </NavGroup>
          {/* Purchase (step 17a): everyone reads the requisitions and the suppliers, like the sales
              side. Approvals is "waiting for me": anyone may hold a level's role, so it is there
              for everyone, with a crit count while something waits (CLAUDE.md → Sidebar nav). */}
          <NavGroup label={t('nav.purchase')}>
            <NavLink to="/requisitions" icon={TaskAdd01Icon}>
              {t('nav.requisitions')}
            </NavLink>
            {/* Step 17b: the documents in the order they happen, like the Sales group */}
            <NavLink to="/purchase-orders" icon={ShoppingBasket01Icon}>
              {t('nav.purchaseOrders')}
            </NavLink>
            <NavLink to="/goods-receipts" icon={PackageReceiveIcon}>
              {t('nav.goodsReceipts')}
            </NavLink>
            {/* Step 17c: then the supplier's bill and what was paid. Not the sales invoice's and
                receipt's icons: a person scanning for the customer's money must not land here. */}
            <NavLink to="/bills" icon={Invoice01Icon}>
              {t('nav.bills')}
            </NavLink>
            <NavLink to="/supplier-payments" icon={Payment02Icon}>
              {t('nav.supplierPayments')}
            </NavLink>
            {/* Step 17d: what goes back, what comes off the bill, and what the supplier pays back,
                after the payments like the sales side's returns after its receipts. Their own
                icons, not the sales return's and credit note's, for the same reason as above. */}
            <NavLink to="/purchase-returns" icon={TruckReturnIcon}>
              {t('nav.purchaseReturns')}
            </NavLink>
            <NavLink to="/debit-notes" icon={NoteRemoveIcon}>
              {t('nav.debitNotes')}
            </NavLink>
            <NavLink to="/supplier-refunds" icon={MoneyReceiveCircleIcon}>
              {t('nav.supplierRefunds')}
            </NavLink>
            <NavLink
              to="/approvals"
              icon={CheckmarkBadge01Icon}
              count={waiting > 0 ? waiting : undefined}
              countTone="crit"
            >
              {t('nav.approvals')}
            </NavLink>
            <NavLink to="/suppliers" icon={Factory01Icon}>
              {t('nav.suppliers')}
            </NavLink>
            <NavLink to="/supplier-groups" icon={UserGroup02Icon}>
              {t('nav.supplierGroups')}
            </NavLink>
          </NavGroup>
          {/* Every member reads products (every sales and stock line picks one); imports change
              them, so only managers see that page */}
          <NavGroup label={t('nav.inventory')}>
            <NavLink to="/products" icon={PackageIcon} activeOptions={{ exact: true }}>
              {t('nav.products')}
            </NavLink>
            <NavLink to="/products/categories" icon={FolderTreeIcon}>
              {t('nav.categories')}
            </NavLink>
            <NavLink to="/products/units" icon={RulerIcon}>
              {t('nav.units')}
            </NavLink>
            {can('inventory.product.manage') && (
              <NavLink to="/products/imports" icon={FileImportIcon}>
                {t('nav.productImports')}
              </NavLink>
            )}
          </NavGroup>
          {/* Stock (step 13): everyone reads it — a sales officer checks it before promising a
              delivery. Adjusting and moving it is checked on the pages and by the API. */}
          <NavGroup label={t('nav.stock')}>
            <NavLink to="/stock" icon={Layers01Icon} activeOptions={{ exact: true }}>
              {t('nav.stockOnHand')}
            </NavLink>
            <NavLink to="/stock/adjustments" icon={TaskEdit01Icon}>
              {t('nav.adjustments')}
            </NavLink>
            <NavLink to="/stock/transfers" icon={ArrowDataTransferHorizontalIcon}>
              {t('nav.transfers')}
            </NavLink>
            <NavLink to="/stock/batches" icon={HourglassIcon}>
              {t('nav.expiry')}
            </NavLink>
            <NavLink to="/stock/sold-short" icon={PackageRemoveIcon}>
              {t('nav.soldShort')}
            </NavLink>
            <NavLink to="/stock/reorder" icon={PackageOutOfStockIcon}>
              {t('nav.reorder')}
            </NavLink>
            {/* Step 14: what it costs — only for the people who may see it */}
            {can('inventory.stock.value') && (
              <NavLink to="/stock/valuation" icon={Coins01Icon}>
                {t('nav.valuation')}
              </NavLink>
            )}
            {can('inventory.stock.revalue') && (
              <NavLink to="/stock/revaluations" icon={MoneyExchange01Icon}>
                {t('nav.revaluations')}
              </NavLink>
            )}
            <NavLink to="/warehouses" icon={WarehouseIcon}>
              {t('nav.warehouses')}
            </NavLink>
          </NavGroup>
          <NavGroup label={t('nav.workspace')}>
            {(can('core.user.read') || can('core.user.invite')) && (
              <NavLink to="/team" icon={UserGroupIcon}>
                {t('nav.team')}
              </NavLink>
            )}
            {(can('core.user.read') || can('core.role.manage')) && (
              <NavLink to="/roles" icon={SecurityCheckIcon}>
                {t('nav.roles')}
              </NavLink>
            )}
            {/* Step 17a: a workspace setting, next to the roles its levels name; shown to the
                people who may change it, like Numbering */}
            {can('core.settings.manage') && (
              <NavLink to="/approval-rules" icon={UserCheck01Icon}>
                {t('nav.approvalRules')}
              </NavLink>
            )}
            <NavLink to="/custom-fields" icon={TextIcon}>
              {t('nav.customFields')}
            </NavLink>
            {/* Step 20a: everyone reads the registers (read-only without pos.register.manage) */}
            <NavLink to="/pos/registers" icon={Cashier02Icon}>
              {t('nav.registers')}
            </NavLink>
            <NavLink to="/branches" icon={Store01Icon}>
              {t('nav.branches')}
            </NavLink>
            {/* Step 18c (decision 22): after the branches the devices are in, for the people who
                may see them all */}
            {can('core.device.manage') && (
              <NavLink to="/devices" icon={ComputerPhoneSyncIcon}>
                {t('nav.devices')}
              </NavLink>
            )}
            {can('core.settings.manage') && (
              <NavLink to="/numbering" icon={LeftToRightListNumberIcon}>
                {t('nav.numbering')}
              </NavLink>
            )}
            {can('core.audit.read') && (
              <NavLink to="/audit-log" icon={WorkHistoryIcon}>
                {t('nav.auditLog')}
              </NavLink>
            )}
            <NavLink to="/settings" icon={Settings02Icon}>
              {t('nav.settings')}
            </NavLink>
          </NavGroup>
        </SidebarNav>
      }
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
