import {
  ArrowDataTransferHorizontalIcon,
  BalanceScaleIcon,
  Book02Icon,
  BookOpen02Icon,
  CalendarLock01Icon,
  ChartIncreaseIcon,
  DashboardSquare01Icon,
  FileDownloadIcon,
  FileImportIcon,
  FolderTreeIcon,
  HourglassIcon,
  Layers01Icon,
  LayoutGridIcon,
  LeftToRightListNumberIcon,
  Logout01Icon,
  Notebook02Icon,
  PackageIcon,
  PackageOutOfStockIcon,
  PieChartIcon,
  RulerIcon,
  SecurityCheckIcon,
  Settings02Icon,
  Store01Icon,
  TableIcon,
  TaskEdit01Icon,
  TextIcon,
  UnfoldMoreIcon,
  UserCircleIcon,
  UserGroupIcon,
  WarehouseIcon,
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
import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { NotificationBell } from '../components/notification-bell';
import { savePreference } from '../lib/preferences';
import { logout, switchTenant } from '../lib/session';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';
import { isTheme } from '../lib/theme';

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

// ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
function UserMenuContent({ align }: { align: 'start' | 'end' }) {
  const { t, language } = useLocale();
  const theme = useSession((state) => state.me?.preferences.theme ?? 'system');
  return (
    <DropdownMenuContent align={align}>
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
      <DropdownMenuItem
        icon={Logout01Icon}
        onSelect={() => {
          void logout();
        }}
      >
        {t('common.signOut')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function AppShell() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const status = useSession((state) => state.status);
  const me = useSession((state) => state.me);
  // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
  const can = useCan();

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  return (
    <Shell
      brand={<Logo />}
      actions={<NotificationBell />}
      topBarActions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon={UserCircleIcon} label={t('shell.account')} />
          </DropdownMenuTrigger>
          <UserMenuContent align="end" />
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
            <NavLink to="/stock/reorder" icon={PackageOutOfStockIcon}>
              {t('nav.reorder')}
            </NavLink>
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
            <NavLink to="/custom-fields" icon={TextIcon}>
              {t('nav.customFields')}
            </NavLink>
            <NavLink to="/branches" icon={Store01Icon}>
              {t('nav.branches')}
            </NavLink>
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
          <UserMenuContent align="start" />
        </DropdownMenu>
      }
    >
      <Outlet />
    </Shell>
  );
}
