import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  Invoice01Icon,
  PackageReceiveIcon,
  Payment02Icon,
  PencilEdit02Icon,
  SentIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isZeroMoney,
  isZeroQuantity,
  type PurchaseOrder,
  routes,
  type StockDocumentStatus,
  subtractMoney,
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import { servicesLeft } from '../lib/bills';
import type { OutputTarget } from '../lib/document-output';
import { useCan } from '../lib/permissions';
import { leftToReceive } from '../lib/purchase';
import { purchaseOrderQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { failureOf } from './journal-parts';
import { PrintButton, PurchaseOrderPrint } from './print-documents';
import { PurchaseBackLink, SupplierLink, usePurchaseRefresh } from './purchase-parts';
import { GoodsReceiptStatusPill, PurchaseOrderStatusPills } from './purchase-pills';
import { SalesLinesTable } from './sales-lines-table';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// Step 16: the Send menu and the history cards, each a chunk of its own (send-menu.tsx says why)
const SendMenu = lazy(async () => ({ default: (await import('./send-menu')).SendMenu }));
const DocumentHistory = lazy(async () => ({
  default: (await import('./document-history')).DocumentHistory,
}));

// What the view asks before it acts: each changes what others may do next
type Asking = 'reopen' | 'close' | 'cancel';

// The receipts list on the order sends a status as a plain string (purchase-orders.ts); only the
// two a goods receipt has are shown as a pill
function receiptStatus(status: string): StockDocumentStatus | null {
  return status === 'draft' || status === 'posted' ? status : null;
}

// A purchase order as it was saved (step 17b), with its approval, what came in, and what can be
// done next. A draft is changed with Edit and submitted from here (decision 13), like a
// requisition; a pending or approved one is reopened first (decision 11). Step 17c: what posted
// bills billed, its bills and its advances, "Make bill" for its services and "Pay advance".
export function PurchaseOrderView({
  order,
  today,
  onEdit,
}: {
  order: PurchaseOrder;
  today: string;
  onEdit: () => void;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const refresh = usePurchaseRefresh();
  const { byId } = useWarehouses();
  const can = useCan();
  const canWrite = can('purchase.order.manage');
  const canReceive = can('purchase.receipt.manage');
  const canBill = can('purchase.bill.manage');
  const canPay = can('purchase.payment.manage');
  const [asking, setAsking] = useState<Asking | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { id, status, version, approval } = order;
  const number = order.number ?? '';
  const [round] = approval.rounds;
  // The step that sent it back, while it is a draft again: its comment says what to change
  const rejection =
    status === 'draft' && round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;
  // A posted receipt: goods came, so the rest is closed, never cancelled (decision 29). Any receipt,
  // even a draft, stops a reopen (decision 21).
  const received = order.receipts.some((receipt) => receipt.status === 'posted');
  // Step 17c: a posted bill billed one of its services (decision 30): the same as goods that came.
  // A draft or waiting bill holds it too; the API says so (purchase_order_billed) if one does.
  const billedService = order.lines.some(
    (line) => line.productType === 'service' && !isZeroQuantity(line.billedQuantity),
  );
  const endAction: Asking = received || billedService ? 'close' : 'cancel';
  // Decision 35: an order goes out once approved. A received or closed one may be sent again.
  const issued = status === 'approved' || status === 'received' || status === 'closed';
  // Step 17c: services no posted bill bills yet, for "Make bill"
  const servicesToBill = issued && servicesLeft(order.lines, new Set()).length > 0;
  const money = (value: string) => format.money(value, { decimals: 2 });
  const target: OutputTarget | null =
    issued && order.number !== null
      ? { kind: 'purchase_order', id, number: order.number, partyId: order.supplier.id }
      : null;

  // Every action answers with the order itself: straight into its cache, then the lists, the
  // requisitions it buys for and the stock page's "incoming"
  const settle = async (saved: PurchaseOrder) => {
    queryClient.setQueryData(purchaseOrderQuery(tenantId, saved.id).queryKey, saved);
    await refresh();
  };

  const submit = useMutation({
    mutationFn: () => call(routes.purchaseOrders.submit, { params: { id }, body: { version } }),
    onSuccess: async (saved) => {
      await settle(saved);
      // The first submit gives the number; with no level, or an Owner submitting, it comes back
      // approved in the same step
      toast(
        t(
          saved.status === 'approved'
            ? 'purchaseOrders.submittedApproved'
            : 'purchaseOrders.submitted',
          { number: saved.number ?? '' },
        ),
      );
    },
  });
  const act = useMutation({
    mutationFn: (action: Asking) =>
      call(routes.purchaseOrders[action], { params: { id }, body: { version } }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      await settle(saved);
      const done = { reopen: 'reopened', close: 'closed', cancel: 'cancelled' } as const;
      toast(t(`purchaseOrders.${done[action]}`, { number }));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(routes.purchaseOrders.remove, { params: { id }, query: { version } }),
    onSuccess: async () => {
      // To the list first: the deleted order's own query would otherwise refetch into a 404
      await navigate({ to: '/purchase-orders' });
      queryClient.removeQueries({ queryKey: purchaseOrderQuery(tenantId, id).queryKey });
      await refresh();
      toast(t('purchaseOrders.deleted'));
    },
  });
  // purchase_supplier_invalid (archived since), purchase_warehouse_*, version_conflict, …
  const failure = failureOf(submit.error) ?? failureOf(remove.error);
  const busy = submit.isPending || remove.isPending || act.isPending;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
      <PageHeader
        title={order.number ?? t('purchaseOrders.draftTitle')}
        description={order.supplier.name}
        actions={
          <>
            <PurchaseOrderStatusPills order={order} today={today} />
            {target && (
              <>
                <PrintButton />
                <Suspense fallback={null}>
                  <SendMenu target={target} />
                </Suspense>
              </>
            )}
          </>
        }
      />
      {failure && <FormAlert message={failure} />}
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('purchaseOrders.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {status === 'draft' && !rejection && order.number !== null && (
        <DocumentNotice tone="neutral">
          {t('purchaseOrders.numberedDraft', { number: order.number })}
        </DocumentNotice>
      )}
      {status !== 'draft' && (
        <DocumentNotice tone="neutral">
          {t(
            `purchaseOrders.notices.${
              status === 'approved' && received
                ? 'receiving'
                : status === 'approved' && billedService
                  ? 'billing'
                  : status
            }`,
          )}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('purchaseOrders.supplier')}
          </span>
          <span className="text-body-sm">
            <SupplierLink supplier={order.supplier} />
          </span>
        </div>
        <Fact label={t('purchaseOrders.date')} value={isoDate(order.date)} />
        <Fact
          label={t('purchaseOrders.expectedDate')}
          value={
            order.expectedDate === null ? t('purchaseOrders.noDate') : isoDate(order.expectedDate)
          }
        />
        <Fact
          label={t('purchaseOrders.warehouse')}
          value={warehouseLabel(byId.get(order.warehouseId))}
        />
        <Fact
          label={t('purchaseOrders.paymentTerms')}
          value={
            order.paymentTermsDays === 0
              ? t('print.onDelivery')
              : t('print.termsDays', { count: order.paymentTermsDays })
          }
        />
        {order.supplierReference !== null && (
          <Fact label={t('purchaseOrders.supplierReference')} value={order.supplierReference} />
        )}
        {order.requisitions.length > 0 && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('purchaseOrders.requisitions')}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {order.requisitions.map((requisition) => (
                <Link
                  key={requisition.id}
                  to="/requisitions/$requisitionId"
                  params={{ requisitionId: requisition.id }}
                  className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
                >
                  {requisition.number}
                </Link>
              ))}
            </span>
          </div>
        )}
        {order.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('purchaseOrders.note')} value={order.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={order.lines}
        totals={order}
        pricesIncludeVat={order.pricesIncludeVat}
        note={(line) =>
          line.requisitionLine && (
            <span className="text-caption text-ink-3">
              {t('purchaseOrders.forRequisition', { number: line.requisitionLine.number })}
            </span>
          )
        }
        // Once approved: what came in and what was turned back, in the base unit, the unit goods
        // receipts count in. Step 17c: and what posted bills billed, in the base unit too (a bill
        // bills a receipt line in that line's unit).
        more={
          issued
            ? {
                headers: [
                  t('purchaseOrders.received'),
                  t('purchaseOrders.rejected'),
                  t('purchaseOrders.billed'),
                ],
                cells: (line) => (
                  <>
                    {line.productType === 'service' ? (
                      <td colSpan={2} className="px-5 py-3 text-right text-caption text-ink-3">
                        {t('purchaseOrders.serviceLine')}
                      </td>
                    ) : (
                      <>
                        <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                          {quantity(line.receivedQuantity, line.baseUnitId)}
                          <span className="block text-caption text-ink-3">
                            {t('purchaseOrders.left')}:{' '}
                            {quantity(leftToReceive(line), line.baseUnitId)}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                          {quantity(line.rejectedQuantity, line.baseUnitId)}
                        </td>
                      </>
                    )}
                    <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                      {quantity(line.billedQuantity, line.baseUnitId)}
                    </td>
                  </>
                ),
              }
            : undefined
        }
      />
      <ApprovalCard
        document="purchase_order"
        id={id}
        number={number}
        amount={order.total}
        draft={status === 'draft'}
        approval={approval}
      />
      {issued && (
        <LinkList
          title={t('purchaseOrders.receiptsTitle')}
          subtitle={t('purchaseOrders.receiptsSubtitle')}
          empty={order.receipts.length === 0 ? t('purchaseOrders.noReceipts') : undefined}
        >
          {order.receipts.map((receipt) => {
            const pill = receiptStatus(receipt.status);
            return (
              <li key={receipt.id}>
                <Link
                  to="/goods-receipts/$receiptId"
                  params={{ receiptId: receipt.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>
                    {receipt.number ?? t('goodsReceipts.statuses.draft')}
                  </span>
                  <span className="text-ink-3 tabular-nums">{isoDate(receipt.date)}</span>
                  <span className="ml-auto">
                    {pill !== null && <GoodsReceiptStatusPill status={pill} />}
                  </span>
                </Link>
              </li>
            );
          })}
        </LinkList>
      )}
      {/* Step 17c: its posted bills, and the money paid ahead against it (decision 12) */}
      {issued && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <LinkList
            title={t('purchaseOrders.billsTitle')}
            subtitle={t('purchaseOrders.billsSubtitle')}
            empty={order.bills.length === 0 ? t('purchaseOrders.noBills') : undefined}
          >
            {order.bills.map((bill) => (
              <li key={bill.id}>
                <Link to="/bills/$billId" params={{ billId: bill.id }} className={LINK_ROW}>
                  <span className={LINK_NUMBER}>{bill.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
          <LinkList
            title={t('purchaseOrders.advancesTitle')}
            subtitle={t('purchaseOrders.advancesSubtitle')}
            empty={order.advances.length === 0 ? t('purchaseOrders.noAdvances') : undefined}
          >
            {order.advances.map((advance) => {
              const left = subtractMoney(advance.amount, advance.applied);
              return (
                <li key={advance.id}>
                  <Link
                    to="/supplier-payments/$paymentId"
                    params={{ paymentId: advance.id }}
                    className={LINK_ROW}
                  >
                    <span className={LINK_NUMBER}>{advance.number}</span>
                    <span className="text-ink-3 tabular-nums">{isoDate(advance.date)}</span>
                    <span className="ml-auto grid text-right">
                      <span className="font-medium tabular-nums">{money(advance.amount)}</span>
                      {/* All applied is history; what is left is money the supplier holds */}
                      <span className="text-caption text-ink-3 tabular-nums">
                        {isZeroMoney(left)
                          ? t('purchaseOrders.advanceUsed')
                          : t('purchaseOrders.advanceLeft', { amount: money(left) })}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </LinkList>
        </div>
      )}

      {canWrite && status === 'draft' && (
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Left, away from the rest */}
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {order.number === null ? (
                // Two clicks: a deleted draft cannot come back
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (confirmingDelete) remove.mutate();
                    else setConfirmingDelete(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {confirmingDelete
                    ? t('purchaseOrders.confirmDelete')
                    : t('purchaseOrders.deleteDraft')}
                </Button>
              ) : (
                // Numbered: its history stays, so it is cancelled (decision 13)
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setAsking('cancel');
                  }}
                >
                  {t('purchaseOrders.cancel')}
                </Button>
              )}
              {confirmingDelete && (
                <span className="text-body-sm text-ink-2">{t('purchaseOrders.deleteWarning')}</span>
              )}
            </div>
            <Button variant="secondary" disabled={busy} onClick={onEdit}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
              {t('purchaseOrders.edit')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                submit.mutate();
              }}
            >
              <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={1.5} />
              {t('purchaseOrders.submit')}
            </Button>
          </div>
          <p className="text-right text-label text-ink-3">{t('purchaseOrders.submitHint')}</p>
        </div>
      )}
      {canWrite && status === 'pending' && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setAsking('reopen');
            }}
          >
            {t('purchaseOrders.reopen')}
          </Button>
        </div>
      )}
      {issued &&
        ((status === 'approved' && (canWrite || canReceive)) ||
          (servicesToBill && canBill) ||
          canPay) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canWrite && status === 'approved' && (
              <Button
                variant="secondary"
                className="mr-auto"
                disabled={busy}
                onClick={() => {
                  setAsking(endAction);
                }}
              >
                {t(`purchaseOrders.${endAction}`)}
              </Button>
            )}
            {/* Back to draft only with no goods receipt at all, drafts included (decision 21), and
              (step 17c) no posted bill of a service (decision 30) */}
            {canWrite && status === 'approved' && order.receipts.length === 0 && !billedService && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setAsking('reopen');
                }}
              >
                {t('purchaseOrders.reopen')}
              </Button>
            )}
            {/* Step 17c: money ahead against the order (decision 12), and its services' bill. Goods
              are billed from their goods receipts. */}
            {canPay && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void navigate({ to: '/supplier-payments/new', search: { orderId: id } })
                }
              >
                <HugeiconsIcon icon={Payment02Icon} size={17} strokeWidth={1.5} />
                {t('purchaseOrders.payAdvance')}
              </Button>
            )}
            {servicesToBill && canBill && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void navigate({ to: '/bills/new', search: { orderId: id } })}
              >
                <HugeiconsIcon icon={Invoice01Icon} size={17} strokeWidth={1.5} />
                {t('purchaseOrders.makeBill')}
              </Button>
            )}
            {canReceive && status === 'approved' && (
              <Button
                disabled={busy}
                onClick={() =>
                  void navigate({ to: '/goods-receipts/new', search: { orderId: id } })
                }
              >
                <HugeiconsIcon icon={PackageReceiveIcon} size={17} strokeWidth={1.5} />
                {t('purchaseOrders.receive')}
              </Button>
            )}
          </div>
        )}

      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        {asking !== null && (
          <DialogContent
            title={t(`purchaseOrders.${asking}Title`, { number })}
            description={t(`purchaseOrders.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('purchaseOrders.keepOrder')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`purchaseOrders.${asking}`)}
                </Button>
              </>
            }
          >
            {failureOf(act.error) && <FormAlert message={failureOf(act.error) ?? ''} />}
          </DialogContent>
        )}
      </Dialog>
      {target && (
        <Suspense fallback={null}>
          <DocumentHistory target={target} />
        </Suspense>
      )}
      {target && <PurchaseOrderPrint order={order} />}
    </div>
  );
}
