import { MoneySend02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  isZeroMoney,
  type Receipt,
  receiptAllocationsInputSchema,
  routes,
  subtractMoney,
  unappliedOf,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import type { OutputTarget } from '../lib/document-output';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PrintButton, ReceiptPrint } from './print-documents';
import { CustomerLink, DocumentNotice, SalesBackLink } from './sales-parts';
import { ReceiptStatusPill } from './sales-pills';
import { useIsoDate, useTenantId } from './stock-parts';

// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
const DocumentHistory = lazy(async () => ({
  default: (await import('./document-history')).DocumentHistory,
}));

// The two dialogs as a chunk of their own, loaded when one opens: they bring the form library, the
// money boxes (decimal.js) and the date picker, and inside this chunk they took it to 113 KB, over
// its 100 KB budget. Most visits only read the receipt.
const ApplyForm = lazy(async () => ({ default: (await import('./money-dialogs')).ApplyForm }));
const VoidForm = lazy(async () => ({ default: (await import('./money-dialogs')).VoidForm }));

// The receipt's own error codes for "Apply money" (the dialog is shared with the credit note)
const allocationsResolver = zodResolver(receiptAllocationsInputSchema, {
  error: contractErrorMap,
});

// A saved money receipt, read only: it is posted the moment it is saved. What can still change is
// where its money goes ("Apply money"), and a bounced cheque or a typing mistake is undone by
// "Void receipt". A voided one stays in the list with its number. Step 15d: what refunds paid back,
// and "Pay back" while some of its money is an advance.
export function ReceiptView({ receipt, today }: { receipt: Receipt; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const can = useCan();
  const canWrite = can('sales.receipt.manage');
  const canRefund = can('sales.refund.manage');
  const [dialog, setDialog] = useState<'apply' | 'void' | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = receipt.status === 'posted';
  // Step 15d: money a refund paid back is neither applied nor an advance any more
  const unapplied = unappliedOf(receipt);
  const account = accounts?.find((item) => item.id === receipt.accountId);
  // Step 16: a voided receipt does not go out (decision 11), the same rule as Print
  const target: OutputTarget | null = posted
    ? { kind: 'receipt', id: receipt.id, number: receipt.number, customerId: receipt.customer.id }
    : null;

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
            {target && (
              <Suspense fallback={null}>
                <SendMenu target={target} />
              </Suspense>
            )}
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
        {!isZeroMoney(receipt.refunded) && (
          <Fact label={t('receipts.refunded')} value={money(receipt.refunded)} />
        )}
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

      {posted && (canWrite || canRefund) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Away from "Apply money": voiding cannot be undone */}
          {canWrite && (
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
          )}
          {/* Step 15d: the advance goes back to the customer (paying out is its own permission) */}
          {canRefund && !isZeroMoney(unapplied) && (
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({ to: '/refunds/new', search: { receiptId: receipt.id } })
              }
            >
              <HugeiconsIcon icon={MoneySend02Icon} size={17} strokeWidth={1.5} />
              {t('receipts.refund')}
            </Button>
          )}
          {canWrite && (
            <Button
              onClick={() => {
                setDialog('apply');
              }}
            >
              {t('receipts.apply')}
            </Button>
          )}
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
              title={t('receipts.applyDialogTitle', { number: receipt.number })}
              customerId={receipt.customer.id}
              // What refunds paid back cannot go on an invoice too (receipt_over_allocated)
              amount={subtractMoney(receipt.amount, receipt.refunded)}
              version={receipt.version}
              allocations={receipt.allocations}
              resolver={allocationsResolver}
              save={async (body) => {
                const saved = await call(routes.receipts.allocate, {
                  params: { id: receipt.id },
                  body,
                });
                return t('receipts.allocated', { number: saved.number });
              }}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
          {dialog === 'void' && (
            <VoidForm
              words="receipts"
              number={receipt.number}
              version={receipt.version}
              today={today}
              save={async (body) => {
                await call(routes.receipts.void, { params: { id: receipt.id }, body });
              }}
              onDone={() => {
                setDialog(null);
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
      {posted && <ReceiptPrint receipt={receipt} />}
    </div>
  );
}
