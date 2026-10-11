import {
  Agreement01Icon,
  ArrowLeft01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Coins01Icon,
  DeliveryTruck01Icon,
  FileEditIcon,
  HourglassIcon,
  InformationCircleIcon,
  Invoice01Icon,
  Invoice02Icon,
  Invoice03Icon,
  PackageDeliveredIcon,
  StopCircleIcon,
  Time04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type CustomerAddress,
  type DeliveryInvoiceState,
  type DocumentTotals,
  type InvoiceStatus,
  isOverdue,
  isZeroMoney,
  type OrderStatus,
  type PartyRef,
  paymentStatusOf,
  type QuotationStatus,
  type ReceiptStatus,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useCallback } from 'react';

import { partyLabel } from '../lib/customers';
import { isExpired, isLate } from '../lib/sales';
import { useTenantId } from './stock-parts';

// Shared by the quotation, order, delivery, invoice and money receipt pages. Here, not in a route file: a route file is its
// own lazy chunk, and importing from one would pull that whole page into the others.

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
  to: '/quotations' | '/sales-orders' | '/deliveries' | '/invoices' | '/receipts';
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

// Open, Expired (open, but the offer has ended: attention), Accepted, Declined. Never colour alone.
export function QuotationStatusPill({
  quotation,
  today,
}: {
  quotation: { status: QuotationStatus; validUntil: string | null };
  today: string;
}) {
  const { t } = useLocale();
  if (isExpired(quotation, today)) {
    return (
      <Pill tone="warn" icon={HourglassIcon}>
        {t('quotations.expired')}
      </Pill>
    );
  }
  if (quotation.status === 'accepted') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('quotations.statuses.accepted')}
      </Pill>
    );
  }
  if (quotation.status === 'declined') {
    return (
      <Pill tone="neutral" icon={CancelCircleIcon}>
        {t('quotations.statuses.declined')}
      </Pill>
    );
  }
  return (
    <Pill tone="brand" icon={Clock01Icon}>
      {t('quotations.statuses.open')}
    </Pill>
  );
}

const ORDER_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  confirmed: { tone: 'brand', icon: Agreement01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  closed: { tone: 'neutral', icon: StopCircleIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const;

// The status, and beside it what a confirmed order is up to: partly delivered (brand: work in
// progress, not a problem) and late (warn: its delivery date has passed)
export function OrderStatusPills({
  order,
  today,
}: {
  order: { status: OrderStatus; partlyDelivered: boolean; deliveryDate: string | null };
  today: string;
}) {
  const { t } = useLocale();
  const pill = ORDER_PILLS[order.status];
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {order.partlyDelivered ? (
        <Pill tone="brand" icon={DeliveryTruck01Icon}>
          {t('salesOrders.partlyDelivered')}
        </Pill>
      ) : (
        <Pill tone={pill.tone} icon={pill.icon}>
          {t(`salesOrders.statuses.${order.status}`)}
        </Pill>
      )}
      {isLate(order, today) && (
        <Pill tone="warn" icon={Time04Icon}>
          {t('salesOrders.late')}
        </Pill>
      )}
    </span>
  );
}

export function DeliveryStatusPill({ status }: { status: StockDocumentStatus }) {
  const { t } = useLocale();
  return status === 'draft' ? (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('deliveries.statuses.draft')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('deliveries.statuses.posted')}
    </Pill>
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

// Step 15c: how much of a posted challan is billed. A draft shows nothing: it cannot be billed yet.
const INVOICE_STATE_PILLS = {
  not_invoiced: { tone: 'neutral', icon: Invoice01Icon },
  partly_invoiced: { tone: 'brand', icon: Invoice03Icon },
  invoiced: { tone: 'good', icon: Invoice02Icon },
} as const;

export function InvoiceStatePill({ state }: { state: DeliveryInvoiceState }) {
  const { t } = useLocale();
  const pill = INVOICE_STATE_PILLS[state];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`deliveries.invoiceStates.${state}`)}
    </Pill>
  );
}

const PAYMENT_PILLS = {
  unpaid: { tone: 'brand', icon: Clock01Icon },
  partly_paid: { tone: 'brand', icon: Coins01Icon },
  paid: { tone: 'good', icon: CheckmarkCircle02Icon },
} as const;

// A draft says Draft. A posted invoice says what was paid (unpaid and partly paid are brand: money
// on its way, not a problem), and beside it Overdue (crit, CLAUDE.md: overdue) once its due date
// has passed. Worked out here from the totals and today: nothing is stored when the date passes.
export function InvoicePills({
  invoice,
  today,
}: {
  invoice: { status: InvoiceStatus; dueDate: string; total: string; amountPaid: string };
  today: string;
}) {
  const { t } = useLocale();
  if (invoice.status === 'draft') {
    return (
      <Pill tone="neutral" icon={FileEditIcon}>
        {t('invoices.statuses.draft')}
      </Pill>
    );
  }
  const payment = paymentStatusOf(invoice);
  const pill = PAYMENT_PILLS[payment];
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <Pill tone={pill.tone} icon={pill.icon}>
        {t(`invoices.payment.${payment}`)}
      </Pill>
      {isOverdue(invoice, today) && (
        <Pill tone="crit" icon={Time04Icon}>
          {t('invoices.overdue')}
        </Pill>
      )}
    </span>
  );
}

export function ReceiptStatusPill({ status }: { status: ReceiptStatus }) {
  const { t } = useLocale();
  return status === 'voided' ? (
    <Pill tone="neutral" icon={CancelCircleIcon}>
      {t('receipts.statuses.voided')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('receipts.statuses.posted')}
    </Pill>
  );
}
