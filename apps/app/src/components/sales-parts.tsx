import {
  Alert02Icon,
  ArrowLeft01Icon,
  HourglassIcon,
  InformationCircleIcon,
  PlusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type CustomerAddress,
  type DocumentTotals,
  isZeroMoney,
  type PartyRef,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback } from 'react';

import { partyLabel } from '../lib/customers';
import { useTenantId } from './stock-parts';

// Shared by the quotation, order, delivery, invoice and money receipt pages, and (step 15d) the
// return, credit note and refund pages. Here, not in a route file: a route file is its own lazy
// chunk, and importing from one would pull that whole page into the others. The status pills are
// in sales-pills.tsx since 15d.

// After a save. Everything under ['sales', tenant] (the lists, the documents), and the stock and
// the books: confirming an order changes "on order" on the stock page, and posting a delivery
// takes stock out and writes a journal entry. Step 15c: the customers too, because an invoice and
// a receipt change what a customer owes, and an order its credit. One hook for every sales
// document, so none forgets one.
export function useSalesRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sales', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['customers', tenantId] }),
    ]);
  }, [queryClient, tenantId]);
}

export function SalesBackLink({
  to,
  label,
}: {
  to:
    | '/quotations'
    | '/sales-orders'
    | '/deliveries'
    | '/invoices'
    | '/receipts'
    | '/sales-returns'
    | '/credit-notes'
    | '/refunds';
  label: string;
}) {
  return (
    <Link
      to={to}
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {label}
    </Link>
  );
}

// A list of document links in a card: the challans an invoice bills, its payments, a challan's
// returns, a return's credit notes. Moved here from invoice-view.tsx in step 15d: the return and
// credit note pages use it too. Each row is a <li> with a Link in LINK_ROW, its number in
// LINK_NUMBER; the Link differs by page, so the rows are the caller's.
export function LinkList({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  // What the card says instead of the list (the caller passes it when there is no row)
  empty?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle={subtitle} />
      {empty ? (
        <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">{empty}</p>
      ) : (
        <ul className="mt-3 grid grid-cols-1">{children}</ul>
      )}
    </Card>
  );
}

export const LINK_ROW =
  'flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle';
export const LINK_NUMBER = 'font-mono font-medium text-brand tabular-nums';

// "C-00042 · Rahman Traders", linking to the customer's page (everyone may read customers)
export function CustomerLink({ customer }: { customer: PartyRef }) {
  return (
    <Link
      to="/customers/$customerId"
      params={{ customerId: customer.id }}
      className="font-medium text-brand underline-offset-3 hover:underline"
    >
      {partyLabel(customer)}
    </Link>
  );
}

// "Mirpur depot — House 12, Road 3, Mirpur 10": how an address reads in a form's select (its first
// line; the document keeps the whole text)
export function addressLabel(address: CustomerAddress): string {
  const firstLine = address.address.split('\n')[0] ?? address.address;
  return address.label === null ? firstLine : `${address.label} — ${firstLine}`;
}

// A notice above a document: what its state means and what to do next. Icon plus words, never
// colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
// neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
// too, and importing it from there would pull the quotation page into their chunks.
export function DocumentNotice({
  tone,
  children,
}: {
  tone: 'warn' | 'neutral';
  children: ReactNode;
}) {
  return (
    <p
      className={
        tone === 'warn'
          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
      }
    >
      <HugeiconsIcon
        icon={tone === 'warn' ? HourglassIcon : InformationCircleIcon}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}

// The totals under a quotation's or an order's lines, in the form and on the page. Line discounts
// show only when something was given away. Paisa: an accounting document's totals must visibly
// add up (CLAUDE.md → Money).
export function SalesTotals({
  totals,
  pricesIncludeVat,
}: {
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
}) {
  const { t, format } = useLocale();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-line bg-subtle px-5 py-4">
      <span className="text-caption text-ink-3">
        {pricesIncludeVat ? t('salesLines.pricesWithVat') : t('salesLines.pricesWithoutVat')}
      </span>
      <dl className="ml-auto grid min-w-[16rem] grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-body-sm">
        {!isZeroMoney(totals.discount) && (
          <>
            <dt className="text-ink-2">{t('salesLines.lineDiscounts')}</dt>
            <dd className="text-right tabular-nums">−{money(totals.discount)}</dd>
          </>
        )}
        <dt className="text-ink-2">{t('salesLines.net')}</dt>
        <dd className="text-right tabular-nums">{money(totals.net)}</dd>
        <dt className="text-ink-2">{t('salesLines.vat')}</dt>
        <dd className="text-right tabular-nums">{money(totals.vat)}</dd>
        <dt className="font-medium text-ink">{t('salesLines.total')}</dt>
        <dd className="text-right font-medium tabular-nums">{money(totals.total)}</dd>
      </dl>
    </div>
  );
}

// The pickers' parts (the invoice's challans and charges, and since 15d the return's challans and
// the credit note's invoice lines and returns). Moved here from invoice-lines.tsx: a return form
// importing them from there would pull the invoice's whole chunk in.

// Problems stay in the dialog, next to the button that caused them (a toast would hide behind it)
export function PickProblem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="status" className="flex items-center gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
      {message}
    </p>
  );
}

export function PickButton({
  added,
  loading,
  onClick,
}: {
  added: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const { t } = useLocale();
  return (
    <Button variant="secondary" size="sm" disabled={loading || added} onClick={onClick}>
      <HugeiconsIcon icon={added ? Tick02Icon : PlusSignIcon} size={16} strokeWidth={1.5} />
      {added ? t('salesLines.added') : t('salesLines.add')}
    </Button>
  );
}
