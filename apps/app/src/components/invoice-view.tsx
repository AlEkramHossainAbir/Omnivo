import { Invoice04Icon, InvoiceIcon, MoneyReceive02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  amountDueOf,
  canCreditWhole,
  creditStateOf,
  type Invoice,
  isOverdue,
  isZeroMoney,
  paymentStatusOf,
  routes,
  wholeInvoiceCreditLines,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, FormAlert, PageHeader, toast } from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';

import { call } from '../lib/api';
import { daysLate } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { failureOf } from './journal-parts';
import { InvoicePrint, PrintButton } from './print-documents';
import { SalesLinesTable } from './sales-lines-table';
import {
  CustomerLink,
  DocumentNotice,
  LINK_NUMBER,
  LINK_ROW,
  LinkList,
  SalesBackLink,
  useSalesRefresh,
} from './sales-parts';
import { InvoicePills } from './sales-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// A posted invoice (or a draft for someone who may not write invoices), read only. A posted one
// never changes: a credit note corrects it (15d). What it was paid with, and "Record payment"
// while something is still due. Step 15d: what credit notes took back, "Write credit note", and
// "Credit whole invoice" while no credit note is posted for it.
export function InvoiceView({ invoice, today }: { invoice: Invoice; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const refresh = useSalesRefresh();
  const { byId } = useWarehouses();
  const branches = useQuery(branchesQuery(useTenantId(), 'active')).data;
  const can = useCan();
  const canPay = can('sales.receipt.manage');
  const canCredit = can('sales.credit_note.manage');
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = invoice.status === 'posted';
  const late = isOverdue(invoice, today) ? daysLate(invoice.dueDate, today) : 0;
  const open = posted && paymentStatusOf(invoice) !== 'paid';

  // "Credit whole invoice" (decision 5): a draft with every line as it was billed, saved in one
  // click and opened, so the person checks it before posting. No route of its own: the lines come
  // from the contracts, the same function the API's test uses (15d.4).
  const creditWhole = useMutation({
    mutationFn: () =>
      call(routes.creditNotes.create, {
        body: {
          invoiceId: invoice.id,
          date: today,
          reason: 'other',
          note: '',
          lines: wholeInvoiceCreditLines(invoice),
          post: false,
        },
      }),
    onSuccess: async (draft) => {
      await refresh();
      toast(t('invoices.creditWholeDone'));
      void navigate({ to: '/credit-notes/$creditNoteId', params: { creditNoteId: draft.id } });
    },
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/invoices" label={t('invoices.back')} />
      <PageHeader
        title={invoice.number ?? t('invoices.draftTitle')}
        description={invoice.customer.name}
        actions={
          <>
            <InvoicePills invoice={invoice} today={today} />
            {posted && <PrintButton />}
          </>
        }
      />
      {late > 0 && (
        <DocumentNotice tone="warn">
          {t('invoices.overdueNotice', { count: late, date: isoDate(invoice.dueDate) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('invoices.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={invoice.customer} />
          </span>
        </div>
        <Fact label={t('invoices.date')} value={isoDate(invoice.date)} />
        <Fact label={t('invoices.dueDate')} value={isoDate(invoice.dueDate)} />
        {invoice.customerReference !== null && (
          <Fact label={t('invoices.customerReference')} value={invoice.customerReference} />
        )}
        <Fact
          label={t('invoices.branch')}
          value={branches?.find((branch) => branch.id === invoice.branchId)?.name ?? '—'}
        />
        {invoice.warehouseId !== null && (
          <Fact
            label={t('invoices.warehouse')}
            value={warehouseLabel(byId.get(invoice.warehouseId))}
          />
        )}
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('invoices.billingAddress')}
          </span>
          {/* The address as it was when the invoice was saved, one part per line */}
          <span className="text-body-sm whitespace-pre-line text-ink">
            {invoice.billingAddress ?? t('invoices.noBillingAddress')}
          </span>
        </div>
        {invoice.postedAt !== null && (
          <Fact
            label={t('invoices.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('invoices.postedOn', { date: format.date(new Date(invoice.postedAt)) })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('invoices.entry')}
            entries={invoice.entry ? [invoice.entry] : []}
            none={t('invoices.noEntry')}
          />
        )}
        {posted && (
          <>
            <Fact label={t('invoices.paid')} value={money(invoice.amountPaid)} />
            {/* What credit notes applied to it: it lowers what is due like a payment */}
            {!isZeroMoney(invoice.amountCredited) && (
              <Fact label={t('invoices.credited')} value={money(invoice.amountCredited)} />
            )}
            <Fact label={t('invoices.due')} value={money(amountDueOf(invoice))} />
          </>
        )}
        {invoice.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('invoices.note')} value={invoice.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={invoice.lines}
        totals={invoice}
        pricesIncludeVat={invoice.pricesIncludeVat}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {invoice.deliveries.length > 0 && (
          <LinkList title={t('invoices.challansTitle')} subtitle={t('invoices.challansSubtitle')}>
            {invoice.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <Link
                  to="/deliveries/$deliveryId"
                  params={{ deliveryId: delivery.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{delivery.number}</span>
                  <span className="text-ink-3 tabular-nums">{isoDate(delivery.date)}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {invoice.orders.length > 0 && (
          <LinkList title={t('invoices.ordersTitle')}>
            {invoice.orders.map((order) => (
              <li key={order.id}>
                <Link
                  to="/sales-orders/$orderId"
                  params={{ orderId: order.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{order.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {posted && (
          <LinkList
            title={t('invoices.paymentsTitle')}
            subtitle={t('invoices.paymentsSubtitle')}
            empty={invoice.payments.length === 0 ? t('invoices.noPayments') : undefined}
          >
            {invoice.payments.map((payment) => (
              <li key={payment.receiptId}>
                <Link
                  to="/receipts/$receiptId"
                  params={{ receiptId: payment.receiptId }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{payment.receiptNumber}</span>
                  <span className="text-ink-3 tabular-nums">{isoDate(payment.date)}</span>
                  <span className="ml-auto font-medium tabular-nums">{money(payment.amount)}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {/* Step 15d: the posted credit notes, with their whole total (where their money went is on
            each credit note's page) */}
        {posted && (
          <LinkList
            title={t('invoices.creditNotesTitle')}
            subtitle={t('invoices.creditNotesSubtitle')}
            empty={invoice.creditNotes.length === 0 ? t('invoices.noCreditNotes') : undefined}
          >
            {invoice.creditNotes.map((note) => (
              <li key={note.id}>
                <Link
                  to="/credit-notes/$creditNoteId"
                  params={{ creditNoteId: note.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{note.number}</span>
                  <span className="text-ink-3 tabular-nums">{isoDate(note.date)}</span>
                  <span className="ml-auto font-medium tabular-nums">−{money(note.total)}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
      </div>

      {creditWhole.error && <FormAlert message={failureOf(creditWhole.error) ?? 'unknown_error'} />}
      {posted && (canPay || canCredit) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canCredit && canCreditWhole(invoice) && (
            <Button
              variant="secondary"
              disabled={creditWhole.isPending}
              onClick={() => {
                creditWhole.mutate();
              }}
            >
              <HugeiconsIcon icon={InvoiceIcon} size={17} strokeWidth={1.5} />
              {t('invoices.creditWhole')}
            </Button>
          )}
          {/* Nothing is left to take back once credit notes took the whole total */}
          {canCredit && creditStateOf(invoice) !== 'credited' && (
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({ to: '/credit-notes/new', search: { invoiceId: invoice.id } })
              }
            >
              <HugeiconsIcon icon={Invoice04Icon} size={17} strokeWidth={1.5} />
              {t('invoices.writeCreditNote')}
            </Button>
          )}
          {open && canPay && (
            <Button
              onClick={() =>
                void navigate({
                  to: '/receipts/new',
                  search: { customerId: invoice.customer.id, invoiceId: invoice.id },
                })
              }
            >
              <HugeiconsIcon icon={MoneyReceive02Icon} size={17} strokeWidth={1.5} />
              {t('invoices.recordPayment')}
            </Button>
          )}
        </div>
      )}
      {posted && <InvoicePrint invoice={invoice} />}
    </div>
  );
}
