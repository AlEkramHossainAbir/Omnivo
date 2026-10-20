import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import {
  compareMoney,
  type DebitNote,
  type PartyRef,
  type SupplierPayment,
  unappliedOf,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import type { SupplierRefundSourceOption } from '../lib/purchase-returns';
import {
  accountsQuery,
  branchesQuery,
  debitNoteQuery,
  supplierPaymentQuery,
  supplierRefundQuery,
} from '../lib/queries';

const SupplierRefundForm = lazy(async () => ({
  default: (await import('../components/supplier-refund-form')).SupplierRefundForm,
}));
const SupplierRefundView = lazy(async () => ({
  default: (await import('../components/supplier-refund-view')).SupplierRefundView,
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
      <PurchaseBackLink to="/supplier-refunds" label={t('supplierRefunds.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('supplierRefunds.title')} description={message} />
    </div>
  );
}

// "Record money back" on a debit note or a payment: it as the form's source, while it is posted and
// has money left. Otherwise (voided, a draft, or used up since) the form starts with its supplier
// alone: a source with nothing left would only fill the amount with ৳0.
function startOf(
  debitNote: DebitNote | undefined,
  payment: SupplierPayment | undefined,
): { supplier: PartyRef | null; source: SupplierRefundSourceOption | null } {
  const usable = (source: SupplierRefundSourceOption, posted: boolean) =>
    posted && compareMoney(source.left, '0') > 0 ? source : null;
  if (debitNote) {
    const source: SupplierRefundSourceOption = {
      type: 'debit_note',
      id: debitNote.id,
      number: debitNote.number ?? '',
      date: debitNote.date,
      branchId: debitNote.branchId,
      left: unappliedOf({
        amount: debitNote.total,
        applied: debitNote.applied,
        refunded: debitNote.refunded,
      }),
    };
    return {
      supplier: debitNote.supplier,
      source: usable(source, debitNote.status === 'posted'),
    };
  }
  if (payment) {
    const source: SupplierRefundSourceOption = {
      type: 'supplier_payment',
      id: payment.id,
      number: payment.number ?? '',
      date: payment.date,
      branchId: payment.branchId,
      left: unappliedOf(payment),
    };
    return { supplier: payment.supplier, source: usable(source, payment.status === 'posted') };
  }
  return { supplier: null, source: null };
}

// A new supplier refund. "Record money back" on a debit note comes with ?debitNoteId=, on a
// supplier payment with ?paymentId=.
export function NewSupplierRefundPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('purchase.refund.manage');
  const today = useToday();
  const ready = useReady();
  const { debitNoteId = '', paymentId = '' } = useSearch({ strict: false });
  const debitNote = useQuery({
    ...debitNoteQuery(tenantId, debitNoteId),
    enabled: debitNoteId !== '',
  });
  const payment = useQuery({
    ...supplierPaymentQuery(tenantId, paymentId),
    enabled: paymentId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/supplier-refunds" label={t('supplierRefunds.back')} />
        <p className="text-body-sm text-ink-3">{t('supplierRefunds.cantWrite')}</p>
      </div>
    );
  }
  if (debitNote.isError) return <CantFind message={t('debitNotes.notFound')} />;
  if (payment.isError) return <CantFind message={t('supplierPayments.notFound')} />;
  if (!ready || (debitNoteId !== '' && !debitNote.data) || (paymentId !== '' && !payment.data)) {
    return null;
  }
  const start = startOf(debitNote.data, payment.data);
  return (
    <Suspense fallback={null}>
      <SupplierRefundForm supplier={start.supplier} source={start.source} today={today} />
    </Suspense>
  );
}

export function SupplierRefundPage() {
  const { t } = useLocale();
  const { refundId = '' } = useParams({ strict: false });
  const today = useToday();
  const { data: refund, isError } = useQuery({
    ...supplierRefundQuery(useTenantId(), refundId),
    enabled: refundId !== '',
  });
  if (isError) return <CantFind message={t('supplierRefunds.notFound')} />;
  if (!refund) return null;
  return (
    <Suspense fallback={null}>
      <SupplierRefundView refund={refund} today={today} />
    </Suspense>
  );
}
