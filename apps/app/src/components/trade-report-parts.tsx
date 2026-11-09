import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { absMoney, isZeroMoney, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, EmptyState, Pill } from '@omnivo/ui';

import { initialsOf } from '../lib/customers';

// Step 21b: what the sales and purchase reports and the two agings share. Here, not in a route
// file: each route is its own lazy chunk, and importing from one would pull that page into the
// others (the same reason as report-parts.tsx).

// The books' line under a report's KPI strip: "Books agree" or "Out by ৳12,000.00", then what the
// books say in whole taka. `books` null means there is nothing to compare with (a customer group,
// a category, "Overdue only"), and the line says why instead, in neutral words: it is not a fault.
export function BooksLine({
  report,
  books,
  noBooks,
}: {
  // What the report adds up to, in the same sense as the books (net sales, or the balance)
  report: string;
  books: string | null;
  noBooks: string;
}) {
  const { t, format } = useLocale();
  if (books === null) {
    return (
      <p className="flex items-center gap-2 text-label font-normal text-ink-3">
        <HugeiconsIcon
          icon={InformationCircleIcon}
          size={15}
          strokeWidth={1.5}
          className="shrink-0"
        />
        {noBooks}
      </p>
    );
  }
  const difference = subtractMoney(report, books);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {isZeroMoney(difference) ? (
        <Pill tone="good" icon={CheckmarkCircle02Icon}>
          {t('reports.booksAgree')}
        </Pill>
      ) : (
        <Pill tone="crit" icon={Alert02Icon}>
          {/* With paisa: a difference under one taka would read "Out by ৳0" in whole taka */}
          {t('reports.booksOutBy', { amount: format.money(absMoney(difference), { decimals: 2 }) })}
        </Pill>
      )}
      <span className="text-label font-normal text-ink-3 tabular-nums">
        {t('reports.inBooks', { amount: format.money(books) })}
      </span>
    </div>
  );
}

// The first column's 30px tile (CLAUDE.md → Table): the name's initials on brand-soft, or for a row
// that stands for many things (walk-in customers, "Products") an icon on subtle, so it never reads
// as one more customer. `brand` puts an icon on brand-soft: an expense account is one thing of the
// group, like a customer, but has no initials worth showing ("6110 Warehouse rent").
export function NameTile({
  name,
  icon,
  brand = false,
}: {
  name?: string;
  icon?: IconSvgElement;
  brand?: boolean;
}) {
  return icon ? (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-[30px] shrink-0 place-items-center rounded-lg',
        brand ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
      )}
    >
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand"
    >
      {initialsOf(name ?? '')}
    </span>
  );
}

// Reports other than the Overview are made on the server only (a step 21 decision): offline the
// page says so in place of its filters and numbers, in the words of every online-only page
export function NeedsConnection() {
  const { t } = useLocale();
  return (
    <EmptyState
      icon={WifiDisconnected02Icon}
      title={t('sync.needsConnectionTitle')}
      description={t('reports.needsConnection')}
    />
  );
}

// The crit empty state with Retry (CLAUDE.md → Empty state)
export function LoadFailed({ icon, onRetry }: { icon: IconSvgElement; onRetry: () => void }) {
  const { t } = useLocale();
  return (
    <EmptyState
      tone="crit"
      icon={icon}
      title={t('reports.loadFailedTitle')}
      description={t('reports.loadFailedBody')}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      }
    />
  );
}

// The notes under a report: what its numbers mean, in 12px ink-3
export function Footnotes({ notes }: { notes: readonly (string | false)[] }) {
  const shown = notes.filter((note) => note !== false);
  if (shown.length === 0) return null;
  return (
    <div className="grid max-w-3xl gap-1 text-caption font-normal text-ink-3">
      {shown.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}
