import { MoneyReceive02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Invoice, isOverdue, paymentStatusOf } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { amountDue, daysLate } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { InvoicePrint, PrintButton } from './print-documents';
import { SalesLinesTable } from './sales-lines-table';
import { CustomerLink, DocumentNotice, InvoicePills, SalesBackLink } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// A list of document links in a card: the challans an invoice bills, its orders, its payments
function LinkList({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle={subtitle} />
      <ul className="mt-3 grid grid-cols-1">{children}</ul>
    </Card>
  );
}

const ROW =
  'flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle';
const NUMBER = 'font-mono font-medium text-brand tabular-nums';

// A posted invoice (or a draft for someone who may not write invoices), read only. A posted one
// never changes: a credit note corrects it (15d). What it was paid with, and "Record payment"
// while something is still due.
export function InvoiceView({ invoice, today }: { invoice: Invoice; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const branches = useQuery(branchesQuery(useTenantId(), 'active')).data;
  const canPay = useCan()('sales.receipt.manage');
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = invoice.status === 'posted';
  const late = isOverdue(invoice, today) ? daysLate(invoice.dueDate, today) : 0;
  const open = posted && paymentStatusOf(invoice) !== 'paid';

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
            <Fact label={t('invoices.due')} value={money(amountDue(invoice))} />
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
                  className={ROW}
                >
                  <span className={NUMBER}>{delivery.number}</span>
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
                <Link to="/sales-orders/$orderId" params={{ orderId: order.id }} className={ROW}>
                  <span className={NUMBER}>{order.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {posted && (
          <Card className="overflow-hidden">
            <CardHeader
              title={t('invoices.paymentsTitle')}
              subtitle={t('invoices.paymentsSubtitle')}
            />
            {invoice.payments.length === 0 ? (
              <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">{t('invoices.noPayments')}</p>
            ) : (
              <ul className="mt-3 grid grid-cols-1">
                {invoice.payments.map((payment) => (
                  <li key={payment.receiptId}>
                    <Link
                      to="/receipts/$receiptId"
                      params={{ receiptId: payment.receiptId }}
                      className={ROW}
                    >
                      <span className={NUMBER}>{payment.receiptNumber}</span>
                      <span className="text-ink-3 tabular-nums">{isoDate(payment.date)}</span>
                      <span className="ml-auto font-medium tabular-nums">
                        {money(payment.amount)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {open && canPay && (
        <div className="flex justify-end">
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
        </div>
      )}
      {posted && <InvoicePrint invoice={invoice} />}
    </div>
  );
}
