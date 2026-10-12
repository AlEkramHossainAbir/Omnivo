import {
  Agreement01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Coins01Icon,
  DeliveryReturn01Icon,
  DeliveryTruck01Icon,
  FileEditIcon,
  HourglassIcon,
  Invoice01Icon,
  Invoice02Icon,
  Invoice03Icon,
  Invoice04Icon,
  PackageDeliveredIcon,
  PackageReceiveIcon,
  StopCircleIcon,
  Time04Icon,
} from '@hugeicons/core-free-icons';
import {
  creditStateOf,
  type DeliveryInvoiceState,
  type DeliveryReturnState,
  type InvoiceStatus,
  isOverdue,
  type OrderStatus,
  paymentStatusOf,
  type QuotationStatus,
  type ReceiptStatus,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

import { isExpired, isLate } from '../lib/sales';

// The status pills of the sales documents. Split from sales-parts.tsx in step 15d: a form needs
// the back link and the refresh hook from there, not a dozen status icons, and with the pills
// inside, every form's chunk carried them all (receipt-form.tsx went over its 100 KB budget).
// Never colour alone: each pill has its icon and its words.

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

// Step 15c: how much of a posted challan is billed. A draft shows nothing: it cannot be billed yet.
const INVOICE_STATE_PILLS = {
  not_invoiced: { tone: 'neutral', icon: Invoice01Icon },
  partly_invoiced: { tone: 'brand', icon: Invoice03Icon },
  invoiced: { tone: 'good', icon: Invoice02Icon },
} as const;

// Step 15d: how much of a posted challan came back. Nothing came back shows no pill: that is the
// normal case, and a pill on every row would say nothing. Neutral, not a status colour: a return is
// neither a success nor a problem.
const RETURN_STATE_PILLS = {
  partly_returned: { icon: DeliveryReturn01Icon },
  returned: { icon: PackageReceiveIcon },
} as const;

export function ReturnStatePill({ state }: { state: DeliveryReturnState }) {
  const { t } = useLocale();
  if (state === 'none') return null;
  return (
    <Pill tone="neutral" icon={RETURN_STATE_PILLS[state].icon}>
      {t(`deliveries.returnStates.${state}`)}
    </Pill>
  );
}

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
// Step 15d: an invoice credit notes took back in full says Credited (neutral: the sale is undone,
// like a cancelled order) instead of what was paid; one taken back in part says so beside it. What
// credit notes applied counts as settled (paymentStatusOf, isOverdue).
export function InvoicePills({
  invoice,
  today,
}: {
  invoice: {
    status: InvoiceStatus;
    dueDate: string;
    total: string;
    amountPaid: string;
    amountCredited: string;
    creditNoteTotal: string;
  };
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
  const credit = creditStateOf(invoice);
  if (credit === 'credited') {
    return (
      <Pill tone="neutral" icon={Invoice04Icon}>
        {t('invoices.creditStates.credited')}
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
      {credit === 'partly_credited' && (
        <Pill tone="neutral" icon={Invoice04Icon}>
          {t('invoices.creditStates.partly_credited')}
        </Pill>
      )}
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

// Step 15d: the statuses of a sales return and a credit note (draft, posted) and of a refund
// (posted, voided). Like a challan's and a receipt's: posted is good, and a draft or a voided one is
// neutral. The words are each document's own (salesReturns.statuses.posted), so the page passes them.
const DOCUMENT_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  posted: { tone: 'good', icon: CheckmarkCircle02Icon },
  voided: { tone: 'neutral', icon: CancelCircleIcon },
} as const;

export function DocumentStatusPill({
  status,
  label,
}: {
  status: keyof typeof DOCUMENT_PILLS;
  label: string;
}) {
  const pill = DOCUMENT_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {label}
    </Pill>
  );
}
