import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  FileEditIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { JournalEntry, JournalEntrySummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { parseIsoDate, Pill } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback } from 'react';

import { ApiRequestError } from '../lib/api';
import { balanceSide } from '../lib/journal';
import { journalEntryQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Shared by the journal pages. Here, not in a route file: a route file is its own lazy chunk, and
// importing from one would pull the whole page into the others.

// "23 Sep 2026" from "2026-09-23", read with local date parts, never as UTC (CLAUDE.md → Dates)
export function useIsoDate(): (iso: string) => string {
  const { format } = useLocale();
  return useCallback(
    (iso: string) => {
      const date = parseIsoDate(iso);
      return date ? format.date(date) : iso;
    },
    [format],
  );
}

// "৳12,500.00 Dr" — a balance with its side; zero has none. Moved here from routes/ledger.tsx in
// step 15a: a customer's statement shows its balances the same way.
export function useBalanceText(): (value: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (value: string) => {
      const { amount, side } = balanceSide(value);
      const money = format.money(amount, { decimals: 2 });
      if (side === null) return money;
      return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
        amount: money,
      });
    },
    [t, format],
  );
}

// Draft, Posted, or Reversed (a posted entry that a later entry undid). Never colour alone: each
// has its icon and its word.
export function JournalStatusPill({ entry }: { entry: JournalEntrySummary }) {
  const { t } = useLocale();
  if (entry.status === 'draft') {
    return (
      <Pill tone="neutral" icon={FileEditIcon}>
        {t('journal.statuses.draft')}
      </Pill>
    );
  }
  if (entry.reversedBy !== null) {
    return (
      <Pill tone="neutral" icon={Undo02Icon}>
        {t('journal.statuses.reversed')}
      </Pill>
    );
  }
  return (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('journal.statuses.posted')}
    </Pill>
  );
}

// A control with its label for rows that repeat (journal lines, opening balances): the label sits
// above the control on a narrow card, and only screen readers read it on a wide one, where the
// column header says it. The parent card is the container (@container); @3xl = 48rem wide.
// Same error look as ui's Field.
export function LineField({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 content-start gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink @3xl:sr-only">
        {label}
      </label>
      {children}
      <LineError id={id} error={error} />
    </div>
  );
}

// The error under a control, in the current language; `${id}-error` is what the control's
// aria-describedby points at
export function LineError({ id, error }: { id: string; error: string | undefined }) {
  const { errorText } = useLocale();
  if (error === undefined) return null;
  return (
    <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
      {errorText(error)}
    </p>
  );
}

export function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

export function BackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/journal"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('journal.back')}
    </Link>
  );
}

// After a save: the saved entry straight into its cache, then everything under ['journal', tenant]
// (the list, ledgers, opening balances) refetched
export function useJournalRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return async (saved?: JournalEntry) => {
    if (saved) queryClient.setQueryData(journalEntryQuery(tenantId, saved.id).queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
    // A line on the receivable changes what a customer owes (step 15a): the customer list and
    // pages show the balance
    await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
  };
}
