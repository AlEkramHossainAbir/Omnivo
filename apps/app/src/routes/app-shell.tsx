import { DashboardSquare01Icon, Logout01Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { Logo } from '../components/logo';
import { logout, switchTenant } from '../lib/session';
import { useSession } from '../lib/session-store';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

// একাধিক টেন্যান্টে থাকলে native <select>: কিবোর্ড, স্ক্রিন রিডার, মোবাইল পিকার সব বিনা খরচে
function TenantSwitcher() {
  const me = useSession((state) => state.me);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!me) return null;

  const tile = (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand text-[12.5px] font-semibold text-brand-ink">
      {initials(me.tenant.name)}
    </span>
  );

  if (me.memberships.length < 2) {
    return (
      <div className="flex items-center gap-2.5 rounded-control border border-line px-2.5 py-2">
        {tile}
        <span className="min-w-0">
          <span className="block truncate text-body-sm font-medium">{me.tenant.name}</span>
          <span className="block truncate text-caption text-ink-3">
            {me.tenant.slug}.omnivo.app
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <label className="relative flex items-center gap-2.5 rounded-control border border-line-strong px-2.5 py-2 shadow-sm transition-colors duration-150 hover:bg-subtle focus-within:border-brand focus-within:shadow-ring">
        {tile}
        <span className="sr-only">Switch workspace</span>
        <select
          value={me.tenant.id}
          disabled={switching}
          onChange={(event) => {
            setSwitching(true);
            setFailed(false);
            // ব্যর্থ হলে store বদলায় না, তাই select আগের workspace-এই থাকে
            switchTenant(event.target.value)
              .catch(() => {
                setFailed(true);
              })
              .finally(() => {
                setSwitching(false);
              });
          }}
          className="min-w-0 flex-1 appearance-none truncate bg-transparent pr-6 text-body-sm font-medium outline-none"
        >
          {me.memberships.map((membership) => (
            <option key={membership.tenantId} value={membership.tenantId}>
              {membership.name}
            </option>
          ))}
        </select>
        <HugeiconsIcon
          icon={UnfoldMoreIcon}
          size={16}
          strokeWidth={1.5}
          className="pointer-events-none absolute right-2.5 text-ink-3"
        />
      </label>
      {failed && (
        <p role="alert" className="px-1 text-caption text-crit">
          Couldn&apos;t switch workspace. Try again.
        </p>
      )}
    </div>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const status = useSession((state) => state.status);
  const me = useSession((state) => state.me);

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  return (
    <div className="min-h-dvh min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-5 border-b border-line bg-surface px-4 py-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5">
        <div className="flex items-center justify-between px-2">
          <Logo />
          {/* ফোনে সাইডবার নেই, তাই sign out উপরের বারে */}
          <button
            type="button"
            aria-label="Sign out"
            onClick={() => {
              void logout();
            }}
            className="grid place-items-center rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink min-[860px]:hidden"
          >
            <HugeiconsIcon icon={Logout01Icon} size={18} strokeWidth={1.5} />
          </button>
        </div>
        <TenantSwitcher />
        <nav aria-label="Main" className="grid gap-px">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-lg bg-brand-soft px-2.5 py-2 text-[14px] font-medium text-brand"
          >
            <HugeiconsIcon icon={DashboardSquare01Icon} size={18} strokeWidth={1.5} />
            Overview
          </Link>
        </nav>
        <div className="mt-auto hidden border-t border-line pt-4 min-[860px]:block">
          <p className="truncate px-2 text-body-sm font-medium">{me?.user.fullName}</p>
          <p className="truncate px-2 text-caption text-ink-3">{me?.user.email}</p>
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
            className="mt-3 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle"
          >
            <HugeiconsIcon icon={Logout01Icon} size={18} strokeWidth={1.5} className="text-ink-3" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="px-4 py-6 min-[860px]:px-8 min-[860px]:py-8">
        <Outlet />
      </main>
    </div>
  );
}
