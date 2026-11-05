import { ArrowTurnBackwardIcon, MoneyReceiveCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isZeroMoney,
  routes,
  subtractMoney,
  type SupplierPayment,
  unappliedPaymentOf,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery, supplierPaymentQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { EntryLinks } from './entry-links';
import { failureOf } from './journal-parts';
import { PrintButton, SupplierPaymentPrint } from './print-documents';
import { PurchaseBackLink, SupplierLink, usePurchaseRefresh } from './purchase-parts';
import { SupplierPaymentStatusPill } from './purchase-pills';
import { DocumentNotice } from './sales-parts';
import { useIsoDate, useTenantId } from './stock-parts';

// The two dialogs of a posted payment as a chunk of their own, loaded when one opens: they bring
// the form library, the money boxes and the date picker, which reading a payment never needs.
// Step 17d: the debit note and the supplier refund share them.
const BillApplyForm = lazy(async () => ({
  default: (await import('./payment-dialogs')).BillApplyForm,
}));
const PurchaseVoidForm = lazy(async () => ({
  default: (await import('./payment-dialogs')).PurchaseVoidForm,
}));

type Asking = 'reopen' | 'cancel';

// A supplier payment that is no longer a draft on its form (step 17c): waiting for approval,
// posted, voided or cancelled, or a draft for someone who may not write payments. A posted one can
// still be applied to other bills ("Apply money") or voided, like a money receipt (15c), and prints
// its voucher (decision 10). A voided or cancelled one stays in the list with its number.
export function SupplierPaymentView({
  payment,
  today,
}: {
  payment: SupplierPayment;
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const refresh = usePurchaseRefresh();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const can = useCan();
  const canWrite = can('purchase.payment.manage');
  // Step 17d: an advance the supplier pays back is a supplier refund, its own permission
  const canRefund = can('purchase.refund.manage');
  const [asking, setAsking] = useState<Asking | null>(null);
  const [dialog, setDialog] = useState<'apply' | 'void' | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const { id, status, version, approval } = payment;
  const number = payment.number ?? '';
  const posted = status === 'posted';
  const unapplied = unappliedPaymentOf(payment);
  const account = accounts?.find((item) => item.id === payment.accountId);
  const accountName = account ? `${account.code} · ${account.name}` : '—';
  const bank = payment.supplierBankAccount;
  const [round] = approval.rounds;
  const rejection =
    status === 'draft' && round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;

  const act = useMutation({
    mutationFn: (action: Asking) =>
      call(routes.supplierPayments[action], { params: { id }, body: { version } }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      queryClient.setQueryData(supplierPaymentQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(
        t(action === 'reopen' ? 'supplierPayments.reopened' : 'supplierPayments.cancelled', {
          number,
        }),
      );
    },
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/supplier-payments" label={t('supplierPayments.back')} />
      <PageHeader
        title={payment.number ?? t('supplierPayments.draftTitle')}
        description={payment.supplier.name}
        actions={
          <>
            <SupplierPaymentStatusPill status={status} />
            {/* Only a posted payment prints: a voided one is not money paid */}
            {posted && <PrintButton />}
          </>
        }
      />
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('supplierPayments.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {(status === 'pending' || status === 'cancelled') && (
        <DocumentNotice tone="neutral">{t(`supplierPayments.notices.${status}`)}</DocumentNotice>
      )}
      {payment.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('supplierPayments.voidedNotice', {
            date: isoDate(payment.voidDate),
            reason: payment.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      {posted && !isZeroMoney(unapplied) && (
        <DocumentNotice tone="neutral">
          {t('supplierPayments.unappliedNotice', { amount: money(unapplied) })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('supplierPayments.supplier')}
          </span>
          <span className="text-body-sm">
            <SupplierLink supplier={payment.supplier} />
          </span>
        </div>
        <Fact label={t('supplierPayments.date')} value={isoDate(payment.date)} />
        <Fact label={t('supplierPayments.amount')} value={money(payment.amount)} />
        {!isZeroMoney(payment.refunded) && (
          <Fact label={t('supplierPayments.refunded')} value={money(payment.refunded)} />
        )}
        <Fact
          label={t('supplierPayments.method')}
          value={t(`receipts.methods.${payment.method}`)}
        />
        {payment.reference !== null && (
          <Fact label={t('supplierPayments.reference')} value={payment.reference} />
        )}
        <Fact label={t('supplierPayments.account')} value={accountName} />
        {bank !== null && (
          <Fact
            label={t('supplierPayments.bankAccount')}
            value={t('supplierPayments.bankAccountLine', {
              bank: bank.bankName,
              number: bank.accountNumber,
            })}
          />
        )}
        <Fact
          label={t('supplierPayments.branch')}
          value={branches?.find((branch) => branch.id === payment.branchId)?.name ?? '—'}
        />
        {payment.order !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('supplierPayments.order')}
            </span>
            <Link
              to="/purchase-orders/$orderId"
              params={{ orderId: payment.order.id }}
              className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {payment.order.number ?? ''}
            </Link>
          </div>
        )}
        {payment.entry !== null && (
          <EntryLinks label={t('supplierPayments.entry')} entries={[payment.entry]} none="" />
        )}
        {payment.voidEntry !== null && (
          <EntryLinks
            label={t('supplierPayments.voidEntry')}
            entries={[payment.voidEntry]}
            none=""
          />
        )}
        {payment.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('supplierPayments.note')} value={payment.note} />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={t('supplierPayments.billsTitle')} />
        {payment.allocations.length === 0 ? (
          <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">
            {t('supplierPayments.noAllocations')}
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-1">
            {payment.allocations.map((allocation) => (
              <li key={allocation.billId}>
                <Link
                  to="/bills/$billId"
                  params={{ billId: allocation.billId }}
                  className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 text-body-sm hover:bg-subtle"
                >
                  <span className="font-mono font-medium text-brand tabular-nums">
                    {allocation.billNumber}
                  </span>
                  <span className="text-ink-2">
                    {t('supplierPayments.supplierBill', { number: allocation.supplierBillNumber })}
                  </span>
                  <span className="text-ink-3 tabular-nums">
                    {t('bills.dueOn', { date: isoDate(allocation.dueDate) })}
                  </span>
                  <span className="ml-auto font-medium tabular-nums">
                    {money(allocation.amount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {/* A draft's bills are a plan (decision 23) */}
        {(status === 'draft' || status === 'pending') && payment.allocations.length > 0 && (
          <p className="border-t border-line px-5 py-3 text-label text-ink-3">
            {t('supplierPayments.planHint')}
          </p>
        )}
      </Card>
      <ApprovalCard
        document="supplier_payment"
        id={id}
        number={number}
        amount={payment.amount}
        draft={status === 'draft'}
        approval={approval}
      />

      {canWrite && status === 'pending' && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            className="mr-auto"
            onClick={() => {
              setAsking('cancel');
            }}
          >
            {t('supplierPayments.cancel')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setAsking('reopen');
            }}
          >
            {t('supplierPayments.reopen')}
          </Button>
        </div>
      )}
      {posted && (canWrite || canRefund) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Away from "Apply money": voiding cannot be undone. A payment the supplier paid some
              of back cannot be voided (payment_has_refunds): void the refund first. */}
          {canWrite && isZeroMoney(payment.refunded) && (
            <div className="mr-auto">
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog('void');
                }}
              >
                {t('supplierPayments.void')}
              </Button>
            </div>
          )}
          {canRefund && !isZeroMoney(unapplied) && (
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({ to: '/supplier-refunds/new', search: { paymentId: payment.id } })
              }
            >
              <HugeiconsIcon icon={MoneyReceiveCircleIcon} size={17} strokeWidth={1.5} />
              {t('supplierPayments.refund')}
            </Button>
          )}
          {canWrite && (
            <Button
              onClick={() => {
                setDialog('apply');
              }}
            >
              {t('supplierPayments.apply')}
            </Button>
          )}
        </div>
      )}

      <Dialog
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
      >
        {asking !== null && (
          <DialogContent
            title={t(`supplierPayments.${asking}Title`, { number })}
            description={t(`supplierPayments.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('supplierPayments.keepPayment')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`supplierPayments.${asking}`)}
                </Button>
              </>
            }
          >
            {failureOf(act.error) && <FormAlert message={failureOf(act.error) ?? ''} />}
          </DialogContent>
        )}
      </Dialog>
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      >
        <Suspense fallback={null}>
          {dialog === 'apply' && (
            <BillApplyForm
              title={t('supplierPayments.applyDialogTitle', { number })}
              supplierId={payment.supplier.id}
              // What supplier refunds paid back cannot go on a bill too (payment_over_allocated)
              amount={subtractMoney(payment.amount, payment.refunded)}
              version={version}
              allocations={payment.allocations}
              document="supplier_payment"
              save={async (body) => {
                const saved = await call(routes.supplierPayments.allocate, {
                  params: { id },
                  body,
                });
                return t('supplierPayments.allocated', { number: saved.number ?? '' });
              }}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
          {dialog === 'void' && (
            <PurchaseVoidForm
              words="supplierPayments"
              number={number}
              version={version}
              today={today}
              save={async (body) => {
                await call(routes.supplierPayments.void, { params: { id }, body });
              }}
              onDone={() => {
                setDialog(null);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <SupplierPaymentPrint payment={payment} account={accountName} />}
    </div>
  );
}
