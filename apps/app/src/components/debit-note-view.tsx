import { MoneyReceiveCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type DebitNote, isZeroMoney, routes, subtractMoney, unappliedOf } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, cn, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { debitReasonKey } from '../lib/returns';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { ExpensesTable } from './expenses-table';
import { DebitNotePrint, PrintButton } from './print-documents';
import { PurchaseBackLink, SupplierLink } from './purchase-parts';
import { SalesLinesTable } from './sales-lines-table';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { DocumentStatusPill } from './sales-pills';
import { useIsoDate, useTenantId } from './stock-parts';

// "Apply money" is the supplier payment's dialog (payment-dialogs.tsx), loaded when it opens
const BillApplyForm = lazy(async () => ({
  default: (await import('./payment-dialogs')).BillApplyForm,
}));

const LINK = 'font-medium text-brand underline-offset-3 hover:underline';

// A posted debit note (or a draft for someone who may not write them), read only, like the credit
// note of 15d. A posted one never changes (17d.1: no void). Where its money went can: "Apply money"
// moves it over the supplier's bills, and "Record money back" records the supplier paying what is
// left back with a supplier refund.
export function DebitNoteView({ debitNote }: { debitNote: DebitNote }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const can = useCan();
  const canWrite = can('purchase.debit_note.manage');
  const canRefund = can('purchase.refund.manage');
  const [applying, setApplying] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = debitNote.status === 'posted';
  const { bill } = debitNote;
  const unapplied = unappliedOf({
    amount: debitNote.total,
    applied: debitNote.applied,
    refunded: debitNote.refunded,
  });
  const hasExpenses = debitNote.expenses.length > 0;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/debit-notes" label={t('debitNotes.back')} />
      <PageHeader
        title={debitNote.number ?? t('debitNotes.draftTitle')}
        description={debitNote.supplier.name}
        actions={
          <>
            <DocumentStatusPill
              status={debitNote.status}
              label={t(`debitNotes.statuses.${debitNote.status}`)}
            />
            {posted && <PrintButton />}
          </>
        }
      />
      {posted && !isZeroMoney(unapplied) && (
        <DocumentNotice tone="neutral">
          {t('debitNotes.unappliedNotice', { amount: money(unapplied) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('debitNotes.supplier')}</span>
          <span className="text-body-sm">
            <SupplierLink supplier={debitNote.supplier} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('debitNotes.bill')}</span>
          {bill === null ? (
            <span className="text-body-sm text-ink-2">{t('debitNotes.noBillColumn')}</span>
          ) : (
            <>
              <Link
                to="/bills/$billId"
                params={{ billId: bill.id }}
                className={cn('font-mono text-body-sm tabular-nums', LINK)}
              >
                {bill.number}
              </Link>
              <span className="text-caption text-ink-3 tabular-nums">
                {bill.supplierBillNumber} · {isoDate(bill.date)}
              </span>
            </>
          )}
        </div>
        <Fact label={t('debitNotes.date')} value={isoDate(debitNote.date)} />
        <Fact label={t('debitNotes.reason')} value={t(debitReasonKey(debitNote.reason))} />
        <Fact
          label={t('debitNotes.branch')}
          value={branches?.find((branch) => branch.id === debitNote.branchId)?.name ?? '—'}
        />
        {debitNote.supplierCreditNumber !== null && (
          <Fact
            label={t('debitNotes.supplierCreditNumber')}
            value={
              debitNote.supplierCreditDate === null
                ? debitNote.supplierCreditNumber
                : `${debitNote.supplierCreditNumber} · ${isoDate(debitNote.supplierCreditDate)}`
            }
          />
        )}
        {posted && (
          <>
            <Fact label={t('debitNotes.applied')} value={money(debitNote.applied)} />
            {!isZeroMoney(debitNote.refunded) && (
              <Fact label={t('debitNotes.refunded')} value={money(debitNote.refunded)} />
            )}
          </>
        )}
        {debitNote.postedAt !== null && (
          <Fact
            label={t('debitNotes.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('debitNotes.postedOn', { date: format.date(new Date(debitNote.postedAt)) })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('debitNotes.entry')}
            entries={debitNote.entry ? [debitNote.entry] : []}
            none={t('debitNotes.noEntry')}
          />
        )}
        {debitNote.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('debitNotes.note')} value={debitNote.note} />
          </div>
        )}
      </Card>
      {debitNote.lines.length > 0 && (
        <SalesLinesTable
          lines={debitNote.lines}
          // With expenses, the totals sit under them: they count both
          totals={hasExpenses ? null : debitNote}
          pricesIncludeVat={debitNote.pricesIncludeVat}
          note={(line) =>
            line.returnNumber !== null && (
              <span className="text-caption text-ink-3">
                {t('debitNotes.fromReturn', { number: line.returnNumber })}
              </span>
            )
          }
        />
      )}
      {hasExpenses && (
        <ExpensesTable
          title={t('debitNotes.expensesTitle')}
          subtitle={t('debitNotes.expensesSubtitle')}
          expenses={debitNote.expenses}
          totals={debitNote}
          pricesIncludeVat={debitNote.pricesIncludeVat}
          accountOf={(id) => accounts?.find((account) => account.id === id)}
        />
      )}

      {posted && (
        <LinkList
          title={t('debitNotes.billsTitle')}
          empty={debitNote.allocations.length === 0 ? t('debitNotes.noAllocations') : undefined}
        >
          {debitNote.allocations.map((allocation) => (
            <li key={allocation.billId}>
              <Link to="/bills/$billId" params={{ billId: allocation.billId }} className={LINK_ROW}>
                <span className={LINK_NUMBER}>{allocation.billNumber}</span>
                <span className="text-ink-2">
                  {t('supplierPayments.supplierBill', { number: allocation.supplierBillNumber })}
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
                void navigate({
                  to: '/supplier-refunds/new',
                  search: { debitNoteId: debitNote.id },
                })
              }
            >
              <HugeiconsIcon icon={MoneyReceiveCircleIcon} size={17} strokeWidth={1.5} />
              {t('debitNotes.refund')}
            </Button>
          )}
          {canWrite && (
            <Button
              onClick={() => {
                setApplying(true);
              }}
            >
              {t('debitNotes.apply')}
            </Button>
          )}
        </div>
      )}

      <Dialog open={applying} onOpenChange={setApplying}>
        <Suspense fallback={null}>
          {applying && (
            <BillApplyForm
              title={t('debitNotes.applyDialogTitle', { number: debitNote.number ?? '' })}
              supplierId={debitNote.supplier.id}
              // What refunds paid back cannot go on a bill too (debit_note_over_allocated)
              amount={subtractMoney(debitNote.total, debitNote.refunded)}
              version={debitNote.version}
              allocations={debitNote.allocations}
              document="debit_note"
              save={async (body) => {
                const saved = await call(routes.debitNotes.allocate, {
                  params: { id: debitNote.id },
                  body,
                });
                return t('debitNotes.allocated', { number: saved.number ?? '' });
              }}
              onDone={() => {
                setApplying(false);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <DebitNotePrint debitNote={debitNote} />}
    </div>
  );
}
