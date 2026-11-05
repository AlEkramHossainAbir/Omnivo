import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import {
  compareMoney,
  type CreditNote,
  type PartyRef,
  type Receipt,
  unappliedOf,
} from '@omnivo/contracts';
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
  creditNoteQuery,
  receiptQuery,
  refundQuery,
} from '../lib/queries';
import type { RefundSourceOption } from '../lib/returns';

const RefundForm = lazy(async () => ({
  default: (await import('../components/refund-form')).RefundForm,
}));
const RefundView = lazy(async () => ({
  default: (await import('../components/refund-view')).RefundView,
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
      <SalesBackLink to="/refunds" label={t('refunds.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('refunds.title')} description={message} />
    </div>
  );
}

// "Pay back" on a receipt or a credit note: it as the form's source, while it is posted and has
// money left. Otherwise (voided, a draft, or used up since) the form starts with its customer
// alone: a source with nothing left would only fill the amount with ৳0.
function startOf(
  receipt: Receipt | undefined,
  creditNote: CreditNote | undefined,
): { customer: PartyRef | null; source: RefundSourceOption | null } {
  const usable = (source: RefundSourceOption, posted: boolean) =>
    posted && compareMoney(source.left, '0') > 0 ? source : null;
  if (receipt) {
    const source: RefundSourceOption = {
      type: 'receipt',
      id: receipt.id,
      number: receipt.number,
      date: receipt.date,
      branchId: receipt.branchId,
      left: unappliedOf(receipt),
    };
    return { customer: receipt.customer, source: usable(source, receipt.status === 'posted') };
  }
  if (creditNote) {
    const source: RefundSourceOption = {
      type: 'credit_note',
      id: creditNote.id,
      number: creditNote.number ?? '',
      date: creditNote.date,
      branchId: creditNote.branchId,
      left: unappliedOf({
        amount: creditNote.total,
        applied: creditNote.applied,
        refunded: creditNote.refunded,
      }),
    };
    return {
      customer: creditNote.customer,
      source: usable(source, creditNote.status === 'posted'),
    };
  }
  return { customer: null, source: null };
}

// A new refund. "Pay back" on a receipt comes with ?receiptId=, on a credit note with
// ?creditNoteId=.
export function NewRefundPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('sales.refund.manage');
  const today = useToday();
  const ready = useReady();
  const { receiptId = '', creditNoteId = '' } = useSearch({ strict: false });
  const receipt = useQuery({ ...receiptQuery(tenantId, receiptId), enabled: receiptId !== '' });
  const creditNote = useQuery({
    ...creditNoteQuery(tenantId, creditNoteId),
    enabled: creditNoteId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/refunds" label={t('refunds.back')} />
        <p className="text-body-sm text-ink-3">{t('refunds.cantWrite')}</p>
      </div>
    );
  }
  if (receipt.isError) return <CantFind message={t('receipts.notFound')} />;
  if (creditNote.isError) return <CantFind message={t('creditNotes.notFound')} />;
  if (!ready || (receiptId !== '' && !receipt.data) || (creditNoteId !== '' && !creditNote.data)) {
    return null;
  }
  const start = startOf(receipt.data, creditNote.data);
  return (
    <Suspense fallback={null}>
      <RefundForm customer={start.customer} source={start.source} today={today} />
    </Suspense>
  );
}

export function RefundPage() {
  const { t } = useLocale();
  const { refundId = '' } = useParams({ strict: false });
  const today = useToday();
  const { data: refund, isError } = useQuery({
    ...refundQuery(useTenantId(), refundId),
    enabled: refundId !== '',
  });
  if (isError) return <CantFind message={t('refunds.notFound')} />;
  if (!refund) return null;
  return (
    <Suspense fallback={null}>
      <RefundView refund={refund} today={today} />
    </Suspense>
  );
}
