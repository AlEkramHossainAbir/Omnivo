import { MoneySend02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CreditNote,
  creditNoteAllocationsInputSchema,
  isZeroMoney,
  routes,
  subtractMoney,
  unappliedOf,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, cn, Dialog, PageHeader } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import type { OutputTarget } from '../lib/document-output';
import { useCan } from '../lib/permissions';
import { creditReasonKey } from '../lib/returns';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { CreditNotePrint, PrintButton } from './print-documents';
import { SalesLinesTable } from './sales-lines-table';
import {
  CustomerLink,
  DocumentNotice,
  LINK_NUMBER,
  LINK_ROW,
  LinkList,
  SalesBackLink,
} from './sales-parts';
import { DocumentStatusPill } from './sales-pills';
import { useIsoDate } from './stock-parts';

// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
const DocumentHistory = lazy(async () => ({
  default: (await import('./document-history')).DocumentHistory,
}));

// "Apply money" is the receipt's dialog (money-dialogs.tsx), loaded when it opens
const ApplyForm = lazy(async () => ({ default: (await import('./money-dialogs')).ApplyForm }));

// The credit note's own error codes for "Apply money"
const allocationsResolver = zodResolver(creditNoteAllocationsInputSchema, {
  error: contractErrorMap,
});

const LINK = 'font-medium text-brand underline-offset-3 hover:underline';

// A posted credit note (or a draft for someone who may not write them), read only. A posted one
// never changes (15d.1: no void). Where its money went can: "Apply money" moves it over the
// customer's invoices, and "Pay back" hands what is left to the customer with a refund.
export function CreditNoteView({ creditNote }: { creditNote: CreditNote }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const can = useCan();
  const canWrite = can('sales.credit_note.manage');
  const canRefund = can('sales.refund.manage');
  const [applying, setApplying] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = creditNote.status === 'posted';
  // Step 16: only a posted credit note has a number and goes out (decision 11)
  const target: OutputTarget | null =
    posted && creditNote.number !== null
      ? {
          kind: 'credit_note',
          id: creditNote.id,
          number: creditNote.number,
          partyId: creditNote.customer.id,
        }
      : null;
  const unapplied = unappliedOf({
    amount: creditNote.total,
    applied: creditNote.applied,
    refunded: creditNote.refunded,
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/credit-notes" label={t('creditNotes.back')} />
      <PageHeader
        title={creditNote.number ?? t('creditNotes.draftTitle')}
        description={creditNote.customer.name}
        actions={
          <>
            <DocumentStatusPill
              status={creditNote.status}
              label={t(`creditNotes.statuses.${creditNote.status}`)}
            />
            {posted && <PrintButton />}
            {target && (
              <Suspense fallback={null}>
                <SendMenu target={target} />
              </Suspense>
            )}
          </>
        }
      />
      {posted && !isZeroMoney(unapplied) && (
        <DocumentNotice tone="neutral">
          {t('creditNotes.unappliedNotice', { amount: money(unapplied) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('creditNotes.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={creditNote.customer} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('creditNotes.invoice')}</span>
          <Link
            to="/invoices/$invoiceId"
            params={{ invoiceId: creditNote.invoice.id }}
            className={cn('font-mono text-body-sm tabular-nums', LINK)}
          >
            {creditNote.invoice.number}
          </Link>
          <span className="text-caption text-ink-3 tabular-nums">
            {isoDate(creditNote.invoice.date)}
          </span>
        </div>
        <Fact label={t('creditNotes.date')} value={isoDate(creditNote.date)} />
        <Fact label={t('creditNotes.reason')} value={t(creditReasonKey(creditNote.reason))} />
        {posted && (
          <>
            <Fact label={t('creditNotes.applied')} value={money(creditNote.applied)} />
            {!isZeroMoney(creditNote.refunded) && (
              <Fact label={t('creditNotes.refunded')} value={money(creditNote.refunded)} />
            )}
          </>
        )}
        {creditNote.postedAt !== null && (
          <Fact
            label={t('creditNotes.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('creditNotes.postedOn', { date: format.date(new Date(creditNote.postedAt)) })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('creditNotes.entry')}
            entries={creditNote.entry ? [creditNote.entry] : []}
            none={t('creditNotes.noEntry')}
          />
        )}
        {creditNote.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('creditNotes.note')} value={creditNote.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={creditNote.lines}
        totals={creditNote}
        pricesIncludeVat={creditNote.pricesIncludeVat}
        note={(line) =>
          line.returnNumber !== null && (
            <span className="text-caption text-ink-3">
              {t('creditNotes.fromReturn', { number: line.returnNumber })}
            </span>
          )
        }
      />

      {posted && (
        <LinkList
          title={t('creditNotes.invoicesTitle')}
          empty={creditNote.allocations.length === 0 ? t('creditNotes.noAllocations') : undefined}
        >
          {creditNote.allocations.map((allocation) => (
            <li key={allocation.invoiceId}>
              <Link
                to="/invoices/$invoiceId"
                params={{ invoiceId: allocation.invoiceId }}
                className={LINK_ROW}
              >
                <span className={LINK_NUMBER}>{allocation.invoiceNumber}</span>
                <span className="text-ink-3 tabular-nums">
                  {t('invoices.dueOn', { date: isoDate(allocation.dueDate) })}
                </span>
                <span className="ml-auto font-medium tabular-nums">{money(allocation.amount)}</span>
              </Link>
            </li>
          ))}
        </LinkList>
      )}

      {posted && (canWrite || canRefund) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canRefund && !isZeroMoney(unapplied) && (
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({ to: '/refunds/new', search: { creditNoteId: creditNote.id } })
              }
            >
              <HugeiconsIcon icon={MoneySend02Icon} size={17} strokeWidth={1.5} />
              {t('creditNotes.refund')}
            </Button>
          )}
          {canWrite && (
            <Button
              onClick={() => {
                setApplying(true);
              }}
            >
              {t('creditNotes.apply')}
            </Button>
          )}
        </div>
      )}

      <Dialog open={applying} onOpenChange={setApplying}>
        <Suspense fallback={null}>
          {applying && (
            <ApplyForm
              title={t('creditNotes.applyDialogTitle', { number: creditNote.number ?? '' })}
              customerId={creditNote.customer.id}
              // What refunds paid back cannot go on an invoice too (credit_note_over_allocated)
              amount={subtractMoney(creditNote.total, creditNote.refunded)}
              version={creditNote.version}
              allocations={creditNote.allocations}
              resolver={allocationsResolver}
              save={async (body) => {
                const saved = await call(routes.creditNotes.allocate, {
                  params: { id: creditNote.id },
                  body,
                });
                return t('creditNotes.allocated', { number: saved.number ?? '' });
              }}
              onDone={() => {
                setApplying(false);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {target && (
        <Suspense fallback={null}>
          <DocumentHistory target={target} />
        </Suspense>
      )}
      {posted && <CreditNotePrint creditNote={creditNote} />}
    </div>
  );
}
