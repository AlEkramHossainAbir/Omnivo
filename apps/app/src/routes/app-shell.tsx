import {
  DashboardSquare01Icon,
  LayoutGridIcon,
  Logout01Icon,
  UnfoldMoreIcon,
  UserCircleIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isLanguage, LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
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

import { logout, switchTenant } from '../lib/session';
import { useSession } from '../lib/session-store';

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
  return (
    <DropdownMenuContent align={align}>
      <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={language}
        onValueChange={(value) => {
          // Radix মান দেয় string হিসেবে — type guard দিয়ে Language-এ নামানো, cast না
          if (isLanguage(value)) void setLanguage(value);
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

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  return (
    <Shell
      brand={<Logo />}
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
