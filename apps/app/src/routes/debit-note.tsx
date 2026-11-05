import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import type { Bill, PurchaseReturn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import type { DebitNoteStart } from '../components/debit-note-form';
import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import {
  debitableReturnLines,
  debitStartOf,
  ownReturnLineToDebit,
  returnLineItem,
  returnLineToDebit,
} from '../lib/purchase-returns';
import {
  billQuery,
  branchesQuery,
  debitNoteQuery,
  purchaseReturnQuery,
  unitsQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own
const DebitNoteForm = lazy(async () => ({
  default: (await import('../components/debit-note-form')).DebitNoteForm,
}));
const DebitNoteView = lazy(async () => ({
  default: (await import('../components/debit-note-view')).DebitNoteView,
}));

// The units (the lines) and the branches (the form's default branch is worked out once, as it
// opens)
function useReady(): boolean {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  return units !== undefined && branches !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/debit-notes" label={t('debitNotes.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('debitNotes.title')} description={message} />
    </div>
  );
}

// What a new debit note starts with. From a return: its goods of the first bill not debited yet at
// that bill's prices, or (no bill left) its lines on their own, for a debit note without a bill.
// From a bill: the bill, no lines. Only a posted bill or return can be debited; anything else
// starts the form empty.
function startOf(
  bill: Bill | undefined,
  purchaseReturn: PurchaseReturn | undefined,
): DebitNoteStart | null {
  const postedBill = bill?.status === 'posted' ? bill : null;
  if (purchaseReturn?.status === 'posted') {
    const billLines = new Map(postedBill?.lines.map((line) => [line.id, line]));
    const lines = debitableReturnLines(purchaseReturn, postedBill?.id ?? null, new Set()).flatMap(
      (line) => {
        if (postedBill === null) return [{ line, debit: ownReturnLineToDebit(line) }];
        const billLine = billLines.get(line.billLineId ?? '');
        return billLine ? [{ line, debit: returnLineToDebit(line, billLine) }] : [];
      },
    );
    return {
      supplier: purchaseReturn.supplier,
      bill: postedBill,
      lines: lines.map((entry) => entry.debit),
      expenses: [],
      returnSources: lines.map(
        (entry) =>
          [
            entry.line.id,
            { number: purchaseReturn.number ?? '', item: returnLineItem(entry.line) },
          ] as const,
      ),
      reason: 'goods_returned',
    };
  }
  if (postedBill === null) return null;
  return {
    supplier: postedBill.supplier,
    bill: postedBill,
    lines: [],
    expenses: [],
    returnSources: [],
    reason: 'price_adjustment',
  };
}

// A new debit note. "Write debit note" on a bill comes with ?billId=; on a return with ?returnId=,
// and then the bill is the first one that billed goods of the return not debited yet, or none.
export function NewDebitNotePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('purchase.debit_note.manage');
  const today = useToday();
  const ready = useReady();
  const { billId = '', returnId = '' } = useSearch({ strict: false });
  const purchaseReturn = useQuery({
    ...purchaseReturnQuery(tenantId, returnId),
    enabled: returnId !== '',
  });
  const fromReturn = purchaseReturn.data ? debitStartOf(purchaseReturn.data) : null;
  const startId = returnId === '' ? billId : (fromReturn?.billId ?? '');
  const bill = useQuery({ ...billQuery(tenantId, startId), enabled: startId !== '' });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/debit-notes" label={t('debitNotes.back')} />
        <p className="text-body-sm text-ink-3">{t('debitNotes.cantWrite')}</p>
      </div>
    );
  }
  if (purchaseReturn.isError) return <CantFind message={t('purchaseReturns.notFound')} />;
  if (bill.isError) return <CantFind message={t('bills.notFound')} />;
  // The form waits for its start: drawing it empty and filling it a moment later would let the
  // person type into a form that is about to be replaced
  if (!ready || (returnId !== '' && !purchaseReturn.data) || (startId !== '' && !bill.data)) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <DebitNoteForm
        debitNote={null}
        start={startOf(bill.data, purchaseReturn.data)}
        today={today}
      />
    </Suspense>
  );
}

export function DebitNotePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const { debitNoteId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.debit_note.manage');
  const today = useToday();
  const ready = useReady();
  const { data: debitNote, isError } = useQuery({
    ...debitNoteQuery(tenantId, debitNoteId),
    enabled: debitNoteId !== '',
  });

  if (isError) return <CantFind message={t('debitNotes.notFound')} />;
  if (!debitNote || !ready) return null;
  if (debitNote.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <DebitNoteForm
          key={`${debitNote.id}-${String(debitNote.version)}`}
          debitNote={debitNote}
          start={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <DebitNoteView debitNote={debitNote} />
    </Suspense>
  );
}
