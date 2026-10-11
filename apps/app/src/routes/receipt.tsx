import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { paymentStatusOf } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import {
  accountsQuery,
  branchesQuery,
  customerQuery,
  invoiceQuery,
  receiptQuery,
} from '../lib/queries';

const ReceiptForm = lazy(async () => ({
  default: (await import('../components/receipt-form')).ReceiptForm,
}));
const ReceiptView = lazy(async () => ({
  default: (await import('../components/receipt-view')).ReceiptView,
}));

// The chart (for the money accounts) and the branches: the form's defaults are worked out from
// them once, as it opens
function useReady(): boolean {
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  return accounts !== undefined && branches !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/receipts" label={t('receipts.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('receipts.title')} description={message} />
    </div>
  );
}

// A new receipt. "Record payment" on an invoice comes with ?customerId= and ?invoiceId=, on a
// customer's page with ?customerId= alone.
export function NewReceiptPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('sales.receipt.manage');
  const today = useToday();
  const ready = useReady();
  const { customerId = '', invoiceId = '' } = useSearch({ strict: false });
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '' && invoiceId === '',
  });
  const invoice = useQuery({
    ...invoiceQuery(tenantId, invoiceId),
    enabled: invoiceId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/receipts" label={t('receipts.back')} />
        <p className="text-body-sm text-ink-3">{t('receipts.cantWrite')}</p>
      </div>
    );
  }
  if (invoice.isError) return <CantFind message={t('invoices.notFound')} />;
  if (customer.isError) return <CantFind message={t('customers.notFound')} />;
  if (!ready || (invoiceId !== '' && !invoice.data)) return null;
  if (customerId !== '' && invoiceId === '' && !customer.data) return null;
  // Only an invoice that still owes something starts the form; one paid since (or a draft) is
  // left out, and the form starts with its customer alone
  const owing =
    invoice.data?.status === 'posted' && paymentStatusOf(invoice.data) !== 'paid'
      ? invoice.data
      : null;
  return (
    <Suspense fallback={null}>
      <ReceiptForm
        customer={invoice.data?.customer ?? customer.data ?? null}
        invoice={owing}
        today={today}
      />
    </Suspense>
  );
}

export function ReceiptPage() {
  const { t } = useLocale();
  const { receiptId = '' } = useParams({ strict: false });
  const today = useToday();
  const { data: receipt, isError } = useQuery({
    ...receiptQuery(useTenantId(), receiptId),
    enabled: receiptId !== '',
  });
  if (isError) return <CantFind message={t('receipts.notFound')} />;
  if (!receipt) return null;
  return (
    <Suspense fallback={null}>
      <ReceiptView receipt={receipt} today={today} />
    </Suspense>
  );
}
