import { isZeroMoney, type Receipt, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PrintButton, ReceiptPrint } from './print-documents';
import { CustomerLink, DocumentNotice, ReceiptStatusPill, SalesBackLink } from './sales-parts';
import { useIsoDate, useTenantId } from './stock-parts';

// The two dialogs as a chunk of their own, loaded when one opens: they bring the form library, the
// money boxes (decimal.js) and the date picker, and inside this chunk they took it to 113 KB, over
// its 100 KB budget. Most visits only read the receipt.
const ApplyForm = lazy(async () => ({
  default: (await import('./receipt-dialogs')).ApplyForm,
}));
const VoidForm = lazy(async () => ({ default: (await import('./receipt-dialogs')).VoidForm }));

// A saved money receipt, read only: it is posted the moment it is saved. What can still change is
// where its money goes ("Apply money"), and a bounced cheque or a typing mistake is undone by
// "Void receipt". A voided one stays in the list with its number.
export function ReceiptView({ receipt, today }: { receipt: Receipt; today: string }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const canWrite = useCan()('sales.receipt.manage');
  const [dialog, setDialog] = useState<'apply' | 'void' | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = receipt.status === 'posted';
  const unapplied = subtractMoney(receipt.amount, receipt.applied);
  const account = accounts?.find((item) => item.id === receipt.accountId);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/receipts" label={t('receipts.back')} />
      <PageHeader
        title={receipt.number}
        description={receipt.customer.name}
        actions={
          <>
            <ReceiptStatusPill status={receipt.status} />
            {posted && <PrintButton />}
          </>
        }
      />
      {receipt.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('receipts.voidedNotice', {
            date: isoDate(receipt.voidDate),
            reason: receipt.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      {posted && !isZeroMoney(unapplied) && (
        <DocumentNotice tone="neutral">
          {t('receipts.unappliedNotice', { amount: money(unapplied) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('receipts.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={receipt.customer} />
          </span>
        </div>
        <Fact label={t('receipts.date')} value={isoDate(receipt.date)} />
        <Fact label={t('receipts.amount')} value={money(receipt.amount)} />
        <Fact label={t('receipts.method')} value={t(`receipts.methods.${receipt.method}`)} />
        {receipt.reference !== null && (
          <Fact label={t('receipts.reference')} value={receipt.reference} />
        )}
        <Fact
          label={t('receipts.account')}
          value={account ? `${account.code} · ${account.name}` : '—'}
        />
        <Fact
          label={t('receipts.branch')}
          value={branches?.find((branch) => branch.id === receipt.branchId)?.name ?? '—'}
        />
        <EntryLinks label={t('receipts.entry')} entries={[receipt.entry]} none="" />
        {receipt.voidEntry !== null && (
          <EntryLinks label={t('receipts.voidEntry')} entries={[receipt.voidEntry]} none="" />
        )}
        {receipt.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('receipts.note')} value={receipt.note} />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={t('receipts.invoicesTitle')} />
        {receipt.allocations.length === 0 ? (
          <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">{t('receipts.noAllocations')}</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1">
            {receipt.allocations.map((allocation) => (
              <li key={allocation.invoiceId}>
                <Link
                  to="/invoices/$invoiceId"
                  params={{ invoiceId: allocation.invoiceId }}
                  className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle"
                >
                  <span className="font-mono font-medium text-brand tabular-nums">
                    {allocation.invoiceNumber}
                  </span>
                  <span className="text-ink-3 tabular-nums">
                    {t('invoices.dueOn', { date: isoDate(allocation.dueDate) })}
                  </span>
                  <span className="ml-auto font-medium tabular-nums">
                    {money(allocation.amount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {posted && canWrite && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Away from "Apply money": voiding cannot be undone */}
          <div className="mr-auto">
            <Button
              variant="secondary"
              onClick={() => {
                setDialog('void');
              }}
            >
              {t('receipts.void')}
            </Button>
          </div>
          <Button
            onClick={() => {
              setDialog('apply');
            }}
          >
            {t('receipts.apply')}
          </Button>
        </div>
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Suspense fallback={null}>
          {dialog === 'apply' && (
            <ApplyForm
              receipt={receipt}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
          {dialog === 'void' && (
            <VoidForm
              receipt={receipt}
              today={today}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <ReceiptPrint receipt={receipt} />}
    </div>
  );
}
