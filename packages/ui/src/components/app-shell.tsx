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
  // Step 29: the module rail (<ModuleRail>). On a desktop it is the 72px column left of the menu;
  // on a phone the same items are a chip row inside the top bar. It is given once and drawn in
  // both places, each hidden at the other's width, so the links are never twice in one screen
  rail?: ReactNode;
  // workspace switcher
  sidebarHeader?: ReactNode;
  nav: ReactNode;
  // শুধু ডেস্কটপে, সাইডবারের তলায়
  sidebarFooter?: ReactNode;
  children: ReactNode;
}

// CLAUDE.md → Layout: ৭২px module rail + ২৪৪px module menu + বাকিটা content; ৮৬০px-এর নিচে
// দুটোই টপ বার হয়ে যায় — আগে module-এর সারি, তার নিচে খোলা module-এর লিংকের সারি। ui রাউটার
// চেনে না — লিংক, ইউজার, টেন্যান্ট সব app slot-এ পাঠায়
export function AppShell({
  brand,
  actions,
  topBarActions,
  rail,
  sidebarHeader,
  nav,
  sidebarFooter,
  children,
}: AppShellProps) {
  return (
    // print:block: on paper there is no sidebar column, even when a landscape page is wider than
    // 860px. print:hidden: the navigation is never printed.
    <div
      className={cn(
        'min-h-dvh print:block',
        rail
          ? 'min-[860px]:grid min-[860px]:grid-cols-[72px_244px_minmax(0,1fr)]'
          : 'min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)]',
      )}
    >
      {/* The rail's desktop column. It scrolls on its own so a short screen still reaches Setup */}
      {rail && (
        <div className="hidden border-line bg-surface min-[860px]:sticky min-[860px]:top-0 min-[860px]:block min-[860px]:h-dvh min-[860px]:overflow-y-auto min-[860px]:border-r min-[860px]:px-2 min-[860px]:py-5 print:hidden">
          {rail}
        </div>
      )}
      {/* overflow-y-auto: the menu stays put while the page scrolls, and scrolls on its own if a
          module ever outgrows the screen */}
      <aside className="flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:gap-4 min-[860px]:overflow-y-auto min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5 print:hidden">
        <div className="flex items-center justify-between gap-3 px-2">
          {brand}
          <div className="flex items-center gap-1">
            {actions}
            {topBarActions && <div className="min-[860px]:hidden">{topBarActions}</div>}
          </div>
        </div>
        {sidebarHeader}
        {/* The rail's phone row. It sits above the module's links, the way the rail sits left of
            the menu on a desktop: the module first, then what is in it */}
        {rail && <div className="min-[860px]:hidden">{rail}</div>}
        {nav}
        {sidebarFooter && (
          <div className="mt-auto hidden border-t border-line pt-4 min-[860px]:block">
            {sidebarFooter}
          </div>
        )}
      </aside>
      {/* min-w-0: grid-এর ভেতরে চওড়া টেবিল কলামটাকে ঠেলে বড় করতে না পারে — পেজ আড়াআড়ি scroll হয় না */}
      <main className="min-w-0 px-4 py-6 min-[860px]:px-8 min-[860px]:py-8 print:p-0">
        {children}
      </main>
    </div>
  );
}

export function SidebarNav({
  label,
  className,
  children,
}: {
  label: string;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    // ফোনে এক সারিতে, নিজের ভেতরে আড়াআড়ি scroll; -mx-4 px-4: scroll কিনারা পর্যন্ত যায়
    <nav
      aria-label={label}
      className={cn(
        '-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 min-[860px]:mx-0 min-[860px]:grid min-[860px]:gap-4 min-[860px]:overflow-visible min-[860px]:px-0 min-[860px]:pb-0',
        className,
      )}
    >
      {children}
    </nav>
  );
}

export function NavGroup({
  label,
  className,
  children,
}: {
  label?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    // ফোনে `contents`: group-এর বাক্স মুছে item-গুলো সরাসরি nav-এর সারিতে বসে
    <div className={cn('contents min-[860px]:grid min-[860px]:gap-px', className)}>
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

// Step 29 (CLAUDE.md → Module rail): the eight modules. A column of 56px items on a desktop, a
// chip row on a phone — one component, because it is drawn in both of the shell's rail slots
export function ModuleRail({
  label,
  className,
  children,
}: {
  label: string;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        '-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 min-[860px]:mx-0 min-[860px]:grid min-[860px]:gap-1 min-[860px]:overflow-visible min-[860px]:px-0 min-[860px]:pb-0',
        className,
      )}
    >
      {children}
    </nav>
  );
}

interface ModuleRailItemProps extends ComponentProps<'a'> {
  icon: IconSvgElement;
  // Which module is open comes from the route (lib/nav.ts → moduleOf), not from the router's own
  // active link: a rail item points at its module's landing page, but it stays marked on every
  // page of that module. Set after the spread, so it wins over the Link's own aria-current
  current: boolean;
  // Work waiting in this module: a 6px crit dot, never a number (the number is on the menu's
  // link). The count goes into the item's accessible name instead
  waiting?: boolean;
}

export function ModuleRailItem({
  icon,
  current,
  waiting = false,
  className,
  children,
  ...props
}: ModuleRailItemProps) {
  return (
    <a
      {...props}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'group flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-body-sm font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:bg-subtle aria-[current=page]:bg-brand-soft aria-[current=page]:text-brand min-[860px]:flex-col min-[860px]:gap-1 min-[860px]:px-1 min-[860px]:py-2 min-[860px]:text-micro',
        className,
      )}
    >
      {/* relative: the dot sits on the icon's corner, so it never widens the item */}
      <span className="relative flex shrink-0">
        <HugeiconsIcon
          icon={icon}
          size={20}
          strokeWidth={1.5}
          className="text-ink-3 group-aria-[current=page]:text-brand"
        />
        {waiting && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-crit" />}
      </span>
      <span className="min-[860px]:w-full min-[860px]:truncate min-[860px]:text-center">
        {children}
      </span>
    </a>
  );
}
