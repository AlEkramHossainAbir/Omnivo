import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

interface AppShellProps {
  // সাইডবারের মাথায় (ডেস্কটপ) / টপ বারের বাঁয়ে (ফোন) — সাধারণত <Logo />
  brand: ReactNode;
  // Next to the logo on every screen size — the notification bell
  actions?: ReactNode;
  // শুধু ফোনে, টপ বারের ডানে (যেমন user menu) — ডেস্কটপে সেই কাজ sidebarFooter-এর
  topBarActions?: ReactNode;
  // workspace switcher
  sidebarHeader?: ReactNode;
  nav: ReactNode;
  // শুধু ডেস্কটপে, সাইডবারের তলায়
  sidebarFooter?: ReactNode;
  children: ReactNode;
}

// CLAUDE.md → Layout: ২৪৪px সাইডবার + বাকিটা content; ৮৬০px-এর নিচে সাইডবার উপরে টপ বার হয়ে
// যায় আর nav আড়াআড়ি। ui রাউটার চেনে না — লিংক, ইউজার, টেন্যান্ট সব app slot-এ পাঠায়
export function AppShell({
  brand,
  actions,
  topBarActions,
  sidebarHeader,
  nav,
  sidebarFooter,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-dvh min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:gap-5 min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5">
        <div className="flex items-center justify-between gap-3 px-2">
          {brand}
          <div className="flex items-center gap-1">
            {actions}
            {topBarActions && <div className="min-[860px]:hidden">{topBarActions}</div>}
          </div>
        </div>
        {sidebarHeader}
        {nav}
        {sidebarFooter && (
          <div className="mt-auto hidden border-t border-line pt-4 min-[860px]:block">
            {sidebarFooter}
          </div>
        )}
      </aside>
      {/* min-w-0: grid-এর ভেতরে চওড়া টেবিল কলামটাকে ঠেলে বড় করতে না পারে — পেজ আড়াআড়ি scroll হয় না */}
      <main className="min-w-0 px-4 py-6 min-[860px]:px-8 min-[860px]:py-8">{children}</main>
    </div>
  );
}

export function SidebarNav({ label, children }: { label: string; children: ReactNode }) {
  return (
    // ফোনে এক সারিতে, নিজের ভেতরে আড়াআড়ি scroll; -mx-4 px-4: scroll কিনারা পর্যন্ত যায়
    <nav
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 min-[860px]:mx-0 min-[860px]:grid min-[860px]:gap-4 min-[860px]:overflow-visible min-[860px]:px-0 min-[860px]:pb-0"
    >
      {children}
    </nav>
  );
}

export function NavGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    // ফোনে `contents`: group-এর বাক্স মুছে item-গুলো সরাসরি nav-এর সারিতে বসে
    <div className="contents min-[860px]:grid min-[860px]:gap-px">
      {label && (
        <p className="hidden px-2.5 pb-1 text-[11.5px] font-medium text-ink-3 min-[860px]:block">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

interface NavItemProps extends ComponentProps<'a'> {
  icon: IconSvgElement;
  count?: number | undefined;
  // CLAUDE.md: কাজ বাকি থাকলে সংখ্যা crit রঙে
  countTone?: 'neutral' | 'crit';
}

// সাধারণ <a> — app-এ TanStack Router-এর createLink(NavItem) দিয়ে টাইপ-চেকড লিংক বানায়।
// Link সক্রিয় রুটে aria-current="page" বসায়; সেটা দেখেই রং, আলাদা isActive prop লাগে না
export function NavItem({
  icon,
  count,
  countTone = 'neutral',
  className,
  children,
  ...props
}: NavItemProps) {
  return (
    <a
      className={cn(
        'group flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:bg-subtle aria-[current=page]:bg-brand-soft aria-[current=page]:text-brand',
        className,
      )}
      {...props}
    >
      <HugeiconsIcon
        icon={icon}
        size={18}
        strokeWidth={1.5}
        className="shrink-0 text-ink-3 group-aria-[current=page]:text-brand"
      />
      <span className="truncate">{children}</span>
      {count !== undefined && (
        <span
          className={cn(
            'ml-auto pl-2 text-caption tabular-nums',
            countTone === 'crit' ? 'text-crit' : 'text-ink-3',
          )}
        >
          {count}
        </span>
      )}
    </a>
  );
}
