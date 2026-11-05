import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import {
  accountsQuery,
  billQuery,
  branchesQuery,
  purchaseOrderQuery,
  supplierPaymentQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own, like the
// bill's
const SupplierPaymentForm = lazy(async () => ({
  default: (await import('../components/supplier-payment-form')).SupplierPaymentForm,
}));
const SupplierPaymentView = lazy(async () => ({
  default: (await import('../components/supplier-payment-view')).SupplierPaymentView,
}));

// The accounts and the branches: the form's starting values read them (one cash box, one branch)
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
      <PurchaseBackLink to="/supplier-payments" label={t('supplierPayments.back')} />
      <EmptyState
        icon={AlertCircleIcon}
        title={t('supplierPayments.title')}
        description={message}
      />
    </div>
  );
}

// A new payment. "Pay bill" comes with ?billId=: its supplier, what it still owes, applied to it.
// "Pay advance" on a purchase order comes with ?orderId=: its supplier, and the order it is paid
// against (decision 12).
export function NewSupplierPaymentPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('purchase.payment.manage');
  const today = useToday();
  const ready = useReady();
  const { billId = '', orderId = '' } = useSearch({ strict: false });
  const bill = useQuery({ ...billQuery(tenantId, billId), enabled: billId !== '' });
  const order = useQuery({ ...purchaseOrderQuery(tenantId, orderId), enabled: orderId !== '' });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/supplier-payments" label={t('supplierPayments.back')} />
        <p className="text-body-sm text-ink-3">{t('supplierPayments.cantWrite')}</p>
      </div>
    );
  }
  if (bill.isError) return <CantFind message={t('bills.notFound')} />;
  if (order.isError) return <CantFind message={t('purchaseOrders.notFound')} />;
  // The form waits for what it starts from: its boxes take their first values once
  if (!ready || (billId !== '' && !bill.data) || (orderId !== '' && !order.data)) return null;
  return (
    <Suspense fallback={null}>
      <SupplierPaymentForm
        payment={null}
        bill={bill.data ?? null}
        order={order.data ? { id: order.data.id, supplier: order.data.supplier } : null}
        today={today}
      />
    </Suspense>
  );
}

export function SupplierPaymentPage() {
  const { t } = useLocale();
  const { paymentId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.payment.manage');
  const today = useToday();
  const ready = useReady();
  const { data: payment, isError } = useQuery({
    ...supplierPaymentQuery(useTenantId(), paymentId),
    enabled: paymentId !== '',
  });

  if (isError) return <CantFind message={t('supplierPayments.notFound')} />;
  if (!payment || !ready) return null;
  if (payment.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <SupplierPaymentForm
          key={`${payment.id}-${String(payment.version)}`}
          payment={payment}
          bill={null}
          order={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <SupplierPaymentView payment={payment} today={today} />
    </Suspense>
  );
}
