import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import type { Invoice, SalesReturn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import type { CreditNoteStart } from '../components/credit-note-form';
import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { creditNoteQuery, invoiceQuery, salesReturnQuery, unitsQuery } from '../lib/queries';
import { creditableReturnLines, firstCreditableInvoice, returnLineToCredit } from '../lib/returns';

// The page loads the data and picks the form or the view, each a lazy chunk of its own
const CreditNoteForm = lazy(async () => ({
  default: (await import('../components/credit-note-form')).CreditNoteForm,
}));
const CreditNoteView = lazy(async () => ({
  default: (await import('../components/credit-note-view')).CreditNoteView,
}));

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/credit-notes" label={t('creditNotes.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('creditNotes.title')} description={message} />
    </div>
  );
}

// What a new credit note starts with. Only a posted invoice can be credited; a draft (or a return
// with nothing left to credit) starts the form empty.
function startOf(
  invoice: Invoice | undefined,
  salesReturn: SalesReturn | undefined,
): CreditNoteStart | null {
  if (invoice?.status !== 'posted') return null;
  if (!salesReturn) {
    return { invoice, lines: [], returnNumbers: [], reason: 'price_adjustment' };
  }
  const invoiceLines = new Map(invoice.lines.map((line) => [line.id, line]));
  const lines = creditableReturnLines(salesReturn, invoice.id, new Set()).flatMap((line) => {
    const source = invoiceLines.get(line.invoiceLineId ?? '');
    return source ? [returnLineToCredit(line, source)] : [];
  });
  return {
    invoice,
    lines,
    returnNumbers: lines.map((line) => [line.returnLineId ?? '', salesReturn.number ?? '']),
    reason: 'goods_returned',
  };
}

// A new credit note. "Write credit note" on an invoice comes with ?invoiceId=; on a return with
// ?returnId=, and then the invoice is the first one that billed goods of the return not credited
// yet, and the form starts with those goods at that invoice's prices.
export function NewCreditNotePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canWrite = useCan()('sales.credit_note.manage');
  const today = useToday();
  const units = useQuery(unitsQuery(tenantId)).data;
  const { invoiceId = '', returnId = '' } = useSearch({ strict: false });
  const salesReturn = useQuery({
    ...salesReturnQuery(tenantId, returnId),
    enabled: returnId !== '',
  });
  const fromReturn = salesReturn.data ? firstCreditableInvoice(salesReturn.data) : null;
  const startId = returnId === '' ? invoiceId : (fromReturn ?? '');
  const invoice = useQuery({ ...invoiceQuery(tenantId, startId), enabled: startId !== '' });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/credit-notes" label={t('creditNotes.back')} />
        <p className="text-body-sm text-ink-3">{t('creditNotes.cantWrite')}</p>
      </div>
    );
  }
  if (salesReturn.isError) return <CantFind message={t('salesReturns.notFound')} />;
  if (invoice.isError) return <CantFind message={t('invoices.notFound')} />;
  // The form waits for its start: drawing it empty and filling it a moment later would let the
  // person type into a form that is about to be replaced
  if (!units || (returnId !== '' && !salesReturn.data) || (startId !== '' && !invoice.data)) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <CreditNoteForm
        creditNote={null}
        start={startOf(invoice.data, salesReturn.data)}
        today={today}
      />
    </Suspense>
  );
}

export function CreditNotePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const { creditNoteId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.credit_note.manage');
  const today = useToday();
  const units = useQuery(unitsQuery(tenantId)).data;
  const { data: creditNote, isError } = useQuery({
    ...creditNoteQuery(tenantId, creditNoteId),
    enabled: creditNoteId !== '',
  });

  if (isError) return <CantFind message={t('creditNotes.notFound')} />;
  if (!creditNote || !units) return null;
  if (creditNote.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <CreditNoteForm
          key={`${creditNote.id}-${String(creditNote.version)}`}
          creditNote={creditNote}
          start={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <CreditNoteView creditNote={creditNote} />
    </Suspense>
  );
}
