import {
  ArrowTurnBackwardIcon,
  InvoiceIcon,
  NoteRemoveIcon,
  Payment02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Bill,
  billAmountDueOf,
  billPaymentStatusOf,
  canDebitWhole,
  debitStateOf,
  isBillOverdue,
  isZeroMoney,
  priceDifferenceOf,
  routes,
  subtractMoney,
  wholeBillDebit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
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
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { EntryLinks } from './entry-links';
import { accountLabel, ExpensesTable } from './expenses-table';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, SupplierLink, usePurchaseRefresh } from './purchase-parts';
import { BillPills } from './purchase-pills';
import { SalesLinesTable } from './sales-lines-table';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// What the page asks before it acts: each changes what the approvers see
type Asking = 'reopen' | 'cancel';

// A supplier bill that is no longer a draft on its form (step 17c): waiting for approval, posted
// or cancelled, or a draft for someone who may not write bills. A posted bill never changes: a debit
// note corrects it (17d). What it was paid with, the advances that could pay it, and "Pay bill"
// while something is still owed. The approver reads the price difference here before deciding.
// Step 17d: what debit notes took off it (each line, each expense, the total), their list, the
// supplier's debit notes with money left, "Write debit note" and "Debit whole bill".
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
  const canDebit = can('purchase.debit_note.manage');
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
  const debitedOf = (debited: string) =>
    !isZeroMoney(debited) && (
      <span className="block text-caption font-normal text-ink-3 tabular-nums">
        {t('bills.lineDebited', { amount: money(debited) })}
      </span>
    );

  // "Debit whole bill" (decision 6): a draft with every line and expense as it was billed, saved in
  // one click and opened, so the person checks it before posting, like "Credit whole invoice" of
  // 15d. The lines come from the contracts (wholeBillDebit), the function the API's test uses.
  const debitWhole = useMutation({
    mutationFn: () =>
      call(routes.debitNotes.create, {
        body: {
          supplierId: bill.supplier.id,
          billId: bill.id,
          date: today,
          branchId: bill.branchId,
          pricesIncludeVat: bill.pricesIncludeVat,
          reason: 'billing_error',
          supplierCreditNumber: '',
          supplierCreditDate: '',
          note: '',
          ...wholeBillDebit(bill),
          post: false,
        },
      }),
    onSuccess: async (draft) => {
      await refresh();
      toast(t('bills.debitWholeDone'));
      void navigate({ to: '/debit-notes/$debitNoteId', params: { debitNoteId: draft.id } });
    },
  });

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
            {/* Step 17d: what debit notes applied, which settles it like a payment */}
            {!isZeroMoney(bill.amountDebited) && (
              <Fact label={t('bills.debited')} value={money(bill.amountDebited)} />
            )}
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
              {debitedOf(line.debited)}
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
      {hasExpenses && (
        <ExpensesTable
          title={t('bills.expensesTitle')}
          subtitle={t('bills.expensesSubtitle')}
          expenses={bill.expenses}
          totals={bill}
          pricesIncludeVat={bill.pricesIncludeVat}
          accountOf={accountOf}
          detail={(expense) => debitedOf(expense.debited)}
        />
      )}
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
        {/* Step 17d: the posted debit notes written for it, wherever their money went */}
        {posted && (
          <LinkList
            title={t('bills.debitNotesTitle')}
            subtitle={t('bills.debitNotesSubtitle')}
            empty={bill.debitNotes.length === 0 ? t('bills.noDebitNotes') : undefined}
          >
            {bill.debitNotes.map((note) => (
              <li key={note.id}>
                <Link
                  to="/debit-notes/$debitNoteId"
                  params={{ debitNoteId: note.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{note.number}</span>
                  <span className="text-ink-3 tabular-nums">{isoDate(note.date)}</span>
                  <span className="ml-auto font-medium tabular-nums">−{money(note.total)}</span>
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
        {/* Step 17d: the supplier's debit notes with money left, which can settle this bill too.
            Applied from the debit note's page, like an advance from its payment's. */}
        {bill.openDebitNotes.length > 0 && (
          <LinkList
            title={t('bills.openDebitNotesTitle')}
            subtitle={t('bills.openDebitNotesSubtitle')}
          >
            {bill.openDebitNotes.map((note) => (
              <li key={note.debitNoteId}>
                <Link
                  to="/debit-notes/$debitNoteId"
                  params={{ debitNoteId: note.debitNoteId }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>{note.debitNoteNumber}</span>
                  <span className="text-ink-3 tabular-nums">
                    {note.bill === null
                      ? t('bills.debitNoteNoBill')
                      : t('bills.debitNoteOn', { number: note.bill.number ?? '' })}
                  </span>
                  <span className="ml-auto font-medium tabular-nums">
                    {t('bills.advanceLeft', { amount: money(note.unapplied) })}
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
      {debitWhole.error && <FormAlert message={failureOf(debitWhole.error) ?? 'unknown_error'} />}
      {posted && ((open && canPay) || canDebit) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canDebit && canDebitWhole(bill) && (
            <Button
              variant="secondary"
              disabled={debitWhole.isPending}
              onClick={() => {
                debitWhole.mutate();
              }}
            >
              <HugeiconsIcon icon={InvoiceIcon} size={17} strokeWidth={1.5} />
              {t('bills.debitWhole')}
            </Button>
          )}
          {/* Nothing is left to take off once debit notes took the whole total */}
          {canDebit && debitStateOf(bill) !== 'debited' && (
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: '/debit-notes/new', search: { billId: bill.id } })}
            >
              <HugeiconsIcon icon={NoteRemoveIcon} size={17} strokeWidth={1.5} />
              {t('bills.writeDebitNote')}
            </Button>
          )}
          {open && canPay && (
            <Button
              onClick={() =>
                void navigate({ to: '/supplier-payments/new', search: { billId: bill.id } })
              }
            >
              <HugeiconsIcon icon={Payment02Icon} size={17} strokeWidth={1.5} />
              {t('bills.pay')}
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
