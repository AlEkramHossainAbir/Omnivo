import { ArrowTurnBackwardIcon, Payment02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Account,
  type Bill,
  billAmountDueOf,
  billPaymentStatusOf,
  isBillOverdue,
  isZeroMoney,
  priceDifferenceOf,
  routes,
  subtractMoney,
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
import { useState } from 'react';

import { call } from '../lib/api';
import { daysLate } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { accountsQuery, billQuery, branchesQuery } from '../lib/queries';
import { useRateText } from '../lib/tax-rates';
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { EntryLinks } from './entry-links';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, SupplierLink, usePurchaseRefresh } from './purchase-parts';
import { BillPills } from './purchase-pills';
import { SalesLinesTable } from './sales-lines-table';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList, SalesTotals } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// What the page asks before it acts: each changes what the approvers see
type Asking = 'reopen' | 'cancel';

const accountLabel = (account: Account | undefined) =>
  account ? `${account.code} · ${account.name}` : '—';

// A supplier bill that is no longer a draft on its form (step 17c): waiting for approval, posted
// or cancelled, or a draft for someone who may not write bills. A posted bill never changes: a debit
// note corrects it (17d). What it was paid with, the advances that could pay it, and "Pay bill"
// while something is still owed. The approver reads the price difference here before deciding.
export function BillView({ bill, today }: { bill: Bill; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const refresh = usePurchaseRefresh();
  const { byId } = useWarehouses();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const can = useCan();
  const canWrite = can('purchase.bill.manage');
  const canPay = can('purchase.payment.manage');
  const [asking, setAsking] = useState<Asking | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const accountOf = (id: string | null) => accounts?.find((account) => account.id === id);
  const { id, status, version, approval } = bill;
  const number = bill.number ?? '';
  const posted = status === 'posted';
  const open = posted && billPaymentStatusOf(bill) !== 'paid';
  const late = isBillOverdue(bill, today) ? daysLate(bill.dueDate, today) : 0;
  const [round] = approval.rounds;
  const rejection =
    status === 'draft' && round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;
  // The column only when a line has an order's price to differ from
  const priced = bill.lines.some((line) => line.orderValue !== null);
  const hasExpenses = bill.expenses.length > 0;

  const act = useMutation({
    mutationFn: (action: Asking) =>
      call(routes.bills[action], { params: { id }, body: { version } }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      queryClient.setQueryData(billQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t(action === 'reopen' ? 'bills.reopened' : 'bills.cancelled', { number }));
    },
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/bills" label={t('bills.back')} />
      <PageHeader
        title={bill.number ?? t('bills.draftTitle')}
        description={bill.supplier.name}
        actions={<BillPills bill={bill} today={today} />}
      />
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('bills.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {(status === 'pending' || status === 'cancelled') && (
        <DocumentNotice tone="neutral">{t(`bills.notices.${status}`)}</DocumentNotice>
      )}
      {late > 0 && (
        <DocumentNotice tone="warn">
          {t('bills.overdueNotice', { count: late, date: isoDate(bill.dueDate) })}
        </DocumentNotice>
      )}
      {/* Decision 8: what posting books to the purchase price difference account */}
      {status !== 'cancelled' && !isZeroMoney(bill.priceDifference) && (
        <DocumentNotice tone="warn">
          {t('bills.priceDifferenceNotice', {
            amount: money(
              bill.priceDifference.startsWith('-')
                ? subtractMoney('0', bill.priceDifference)
                : bill.priceDifference,
            ),
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('bills.supplier')}</span>
          <span className="text-body-sm">
            <SupplierLink supplier={bill.supplier} />
          </span>
        </div>
        <Fact label={t('bills.supplierBillNumber')} value={bill.supplierBillNumber} />
        <Fact label={t('bills.date')} value={isoDate(bill.date)} />
        <Fact label={t('bills.dueDate')} value={isoDate(bill.dueDate)} />
        {bill.mushakNumber !== null && (
          <Fact
            label={t('bills.mushakNumber')}
            value={
              bill.mushakDate === null
                ? bill.mushakNumber
                : `${bill.mushakNumber} · ${isoDate(bill.mushakDate)}`
            }
          />
        )}
        <Fact
          label={t('bills.branch')}
          value={branches?.find((branch) => branch.id === bill.branchId)?.name ?? '—'}
        />
        {bill.warehouseId !== null && (
          <Fact label={t('bills.warehouse')} value={warehouseLabel(byId.get(bill.warehouseId))} />
        )}
        {bill.postedAt !== null && (
          <Fact
            label={t('bills.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('bills.postedOn', { date: format.date(new Date(bill.postedAt)) })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('bills.entry')}
            entries={bill.entry ? [bill.entry] : []}
            none={t('bills.noEntry')}
          />
        )}
        {posted && (
          <>
            <Fact label={t('bills.paid')} value={money(bill.amountPaid)} />
            <Fact label={t('bills.due')} value={money(billAmountDueOf(bill))} />
          </>
        )}
        {bill.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('bills.note')} value={bill.note} />
          </div>
        )}
      </Card>
      {bill.lines.length > 0 && (
        <SalesLinesTable
          lines={bill.lines}
          totals={hasExpenses ? null : bill}
          pricesIncludeVat={bill.pricesIncludeVat}
          note={(line) => (
            <span className="text-caption text-ink-3">
              {line.receiptNumber !== null
                ? t('bills.fromReceipt', { number: line.receiptNumber })
                : line.orderNumber !== null
                  ? t('bills.fromOrder', { number: line.orderNumber })
                  : line.accountId === null
                    ? t('bills.ownLine')
                    : null}
              {/* A service's account: the approver sees where it goes */}
              {line.accountId !== null && (
                <span className="block">
                  {t('bills.account')}: {accountLabel(accountOf(line.accountId))}
                </span>
              )}
            </span>
          )}
          more={
            priced
              ? {
                  headers: [t('bills.priceDifference')],
                  cells: (line) => {
                    const difference = priceDifferenceOf(line);
                    return (
                      <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                        {line.orderValue === null || isZeroMoney(difference)
                          ? '—'
                          : money(difference)}
                      </td>
                    );
                  },
                }
              : undefined
          }
        />
      )}
      {hasExpenses && <BillExpensesTable bill={bill} accountOf={accountOf} />}
      <ApprovalCard
        document="bill"
        id={id}
        number={number}
        amount={bill.total}
        draft={status === 'draft'}
        approval={approval}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {bill.receipts.length > 0 && (
          <LinkList title={t('bills.receiptsTitle')} subtitle={t('bills.receiptsSubtitle')}>
            {bill.receipts.map((receipt) => (
              <li key={receipt.id}>
                <Link
                  to="/goods-receipts/$receiptId"
                  params={{ receiptId: receipt.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{receipt.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {bill.orders.length > 0 && (
          <LinkList title={t('bills.ordersTitle')}>
            {bill.orders.map((order) => (
              <li key={order.id}>
                <Link
                  to="/purchase-orders/$orderId"
                  params={{ orderId: order.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{order.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {posted && (
          <LinkList
            title={t('bills.paymentsTitle')}
            subtitle={t('bills.paymentsSubtitle')}
            empty={bill.payments.length === 0 ? t('bills.noPayments') : undefined}
          >
            {bill.payments.map((payment) => (
              <li key={payment.paymentId}>
                <Link
                  to="/supplier-payments/$paymentId"
                  params={{ paymentId: payment.paymentId }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{payment.paymentNumber}</span>
                  <span className="text-ink-3 tabular-nums">{isoDate(payment.date)}</span>
                  <span className="ml-auto font-medium tabular-nums">{money(payment.amount)}</span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
        {/* Decision 12: money already paid to this supplier, this bill's orders first. It is
            applied from the payment's page, where the money is. */}
        {bill.advances.length > 0 && (
          <LinkList title={t('bills.advancesTitle')} subtitle={t('bills.advancesSubtitle')}>
            {bill.advances.map((advance) => (
              <li key={advance.paymentId}>
                <Link
                  to="/supplier-payments/$paymentId"
                  params={{ paymentId: advance.paymentId }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{advance.paymentNumber}</span>
                  <span className="text-ink-3 tabular-nums">
                    {advance.order === null
                      ? isoDate(advance.date)
                      : t('bills.advanceFor', { number: advance.order.number ?? '' })}
                  </span>
                  <span className="ml-auto font-medium tabular-nums">
                    {t('bills.advanceLeft', { amount: money(advance.unapplied) })}
                  </span>
                </Link>
              </li>
            ))}
          </LinkList>
        )}
      </div>

      {canWrite && status === 'pending' && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Away from Reopen: a cancelled bill cannot come back */}
          <Button
            variant="secondary"
            className="mr-auto"
            onClick={() => {
              setAsking('cancel');
            }}
          >
            {t('bills.cancel')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setAsking('reopen');
            }}
          >
            {t('bills.reopen')}
          </Button>
        </div>
      )}
      {open && canPay && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              void navigate({ to: '/supplier-payments/new', search: { billId: bill.id } })
            }
          >
            <HugeiconsIcon icon={Payment02Icon} size={17} strokeWidth={1.5} />
            {t('bills.pay')}
          </Button>
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
            title={t(`bills.${asking}Title`, { number })}
            description={t(`bills.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('bills.keepBill')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`bills.${asking}`)}
                </Button>
              </>
            }
          >
            {failureOf(act.error) && <FormAlert message={failureOf(act.error) ?? ''} />}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

// The expenses, read only, with the bill's totals under them: they count the item lines too
function BillExpensesTable({
  bill,
  accountOf,
}: {
  bill: Bill;
  accountOf: (id: string) => Account | undefined;
}) {
  const { t, format } = useLocale();
  const rateText = useRateText();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t('bills.expensesTitle')} subtitle={t('bills.expensesSubtitle')} />
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-body-sm">
          <caption className="sr-only">{t('bills.expensesTitle')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('bills.expenseDescription')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('bills.expenseAccount')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('bills.expenseVat')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {bill.expenses.map((expense) => {
              const account = accountOf(expense.accountId);
              return (
                <tr key={expense.id} className="border-t border-line align-top">
                  <td className="px-5 py-3 font-medium text-ink">{expense.description}</td>
                  <td className="px-5 py-3">{accountLabel(account)}</td>
                  <td className="px-5 py-3 whitespace-nowrap">
                    {expense.taxRate.name}
                    <span className="block text-caption text-ink-3 tabular-nums">
                      {rateText(expense.taxRate.rate)}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {money(bill.pricesIncludeVat ? expense.total : expense.net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SalesTotals totals={bill} pricesIncludeVat={bill.pricesIncludeVat} />
    </Card>
  );
}
