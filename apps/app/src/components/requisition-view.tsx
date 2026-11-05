import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  PencilEdit02Icon,
  SentIcon,
  ShoppingCart01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { defaultLineDescription, type Requisition, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { leftToOrder } from '../lib/purchase';
import { requisitionQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { Fact } from './adjustment-view';
import { ApprovalCard } from './approval-card';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { RequisitionOrderPill, RequisitionStatusPill } from './purchase-pills';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// What the view asks before it acts: each changes who may do what next, so none is one click.
// Step 17b: close, once orders buy for it.
type Asking = 'reopen' | 'cancel' | 'close';

// The lines as they were saved: a real <table> in a card, scrolling inside its own box on a phone.
// Step 17b: once approved, how much purchase orders cover and what is left, in the base unit (the
// unit orders count in: one may buy cones for a line asked in bags).
function LinesTable({ requisition }: { requisition: Requisition }) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const ordering = requisition.status === 'approved' || requisition.status === 'closed';
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-body-sm">
          <caption className="sr-only">{t('purchaseLines.items')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('purchaseLines.item')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('purchaseLines.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('purchaseLines.estimatedCost')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('purchaseLines.amount')}
              </th>
              {ordering && (
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('requisitions.ordered')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {requisition.lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <span className="grid max-w-[24rem] min-w-0 gap-1">
                    <span className="font-medium text-ink">{line.description}</span>
                    {/* The product too, when the line says something else ("Grey, for samples") */}
                    <span className="truncate text-caption text-ink-3">
                      {line.description !== defaultLineDescription(line) &&
                        `${variantName(line)} · `}
                      <span className="font-mono">{line.sku}</span>
                    </span>
                    {line.productType === 'service' && (
                      <span>
                        <Pill tone="neutral" icon={Wrench01Icon}>
                          {t('purchaseLines.service')}
                        </Pill>
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.unitId)}
                  {line.unitId !== line.baseUnitId && (
                    <span className="block text-caption text-ink-3">
                      {t('stockLines.equals', {
                        quantity: quantity(line.baseQuantity, line.baseUnitId),
                      })}
                    </span>
                  )}
                </td>
                {/* Stored with 4 decimals, shown with 2 (CLAUDE.md → Stock values) */}
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {money(line.estimatedCost)}
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(line.amount)}
                </td>
                {ordering && (
                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                    {quantity(line.orderedQuantity, line.baseUnitId)}
                    <span className="block text-caption text-ink-3">
                      {t('requisitions.leftToOrder')}:{' '}
                      {quantity(leftToOrder(line), line.baseUnitId)}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-5 py-3 text-body-sm">
        <span className="font-medium">{t('purchaseLines.total')}</span>
        <span className="font-medium tabular-nums">{money(requisition.amount)}</span>
      </div>
    </Card>
  );
}

// A requisition as it was saved (step 17a), with its approval and what can be done next. A draft
// is changed with Edit, then submitted; a pending or approved one is reopened first (decision 6).
export function RequisitionView({
  requisition,
  onEdit,
}: {
  requisition: Requisition;
  onEdit: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const refresh = usePurchaseRefresh();
  const { byId } = useWarehouses();
  const can = useCan();
  const canWrite = can('purchase.requisition.manage');
  // Step 17b: "Make purchase order" is the buyer's
  const canOrder = can('purchase.order.manage');
  const [asking, setAsking] = useState<Asking | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { id, number, status, version, approval } = requisition;
  const [round] = approval.rounds;
  // Never submitted: it may be deleted. Once a round exists, its history stays (decision 19).
  const neverSubmitted = approval.rounds.length === 0;
  // Step 17b: an order that is not cancelled buys for it, even a draft (decision 27). It is then
  // closed, never reopened or cancelled (decision 17).
  const held = requisition.orders.length > 0;
  // The step that sent it back, when the newest round was rejected: its comment says what to change
  const rejection =
    status === 'draft' && round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;

  // The answer of every action is the requisition itself: straight into its cache, then the
  // lists and the count
  const settle = async (saved: Requisition) => {
    queryClient.setQueryData(requisitionQuery(tenantId, saved.id).queryKey, saved);
    await refresh();
  };

  const submit = useMutation({
    mutationFn: () => call(routes.requisitions.submit, { params: { id }, body: { version } }),
    onSuccess: async (saved) => {
      await settle(saved);
      // No level applied, or an Owner submitted it: approved in the same step (decisions 13, 14)
      toast(
        t(
          saved.status === 'approved' ? 'requisitions.submittedApproved' : 'requisitions.submitted',
          { number },
        ),
      );
    },
  });
  const act = useMutation({
    mutationFn: (action: Asking) =>
      call(routes.requisitions[action], { params: { id }, body: { version } }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      await settle(saved);
      const done = { reopen: 'reopened', cancel: 'cancelled', close: 'closed' } as const;
      toast(t(`requisitions.${done[action]}`, { number }));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(routes.requisitions.remove, { params: { id }, query: { version } }),
    onSuccess: async () => {
      // To the list first: the deleted requisition's own query would otherwise refetch into a 404
      await navigate({ to: '/requisitions' });
      queryClient.removeQueries({ queryKey: requisitionQuery(tenantId, id).queryKey });
      await refresh();
      toast(t('requisitions.deleted', { number }));
    },
  });
  // purchase_not_draft, purchase_was_submitted, purchase_cannot_*, version_conflict
  const failure = failureOf(submit.error) ?? failureOf(remove.error);
  const busy = submit.isPending || remove.isPending || act.isPending;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
      <PageHeader
        title={number}
        description={warehouseLabel(byId.get(requisition.warehouseId))}
        actions={
          <span className="inline-flex flex-wrap gap-1.5">
            <RequisitionStatusPill status={status} />
            <RequisitionOrderPill state={requisition.orderState} />
          </span>
        }
      />
      {failure && <FormAlert message={failure} />}
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('requisitions.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {status !== 'draft' && (
        <DocumentNotice tone="neutral">
          {t(`requisitions.notices.${status === 'approved' && held ? 'ordered' : status}`)}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-4">
        <Fact label={t('requisitions.date')} value={isoDate(requisition.date)} />
        <Fact
          label={t('requisitions.neededBy')}
          value={
            requisition.neededBy === null ? t('requisitions.noDate') : isoDate(requisition.neededBy)
          }
        />
        <Fact
          label={t('requisitions.warehouse')}
          value={warehouseLabel(byId.get(requisition.warehouseId))}
        />
        <Fact label={t('requisitions.requestedBy')} value={requisition.requestedBy.name} />
        {requisition.note !== null && (
          <div className="sm:col-span-4">
            <Fact label={t('requisitions.note')} value={requisition.note} />
          </div>
        )}
      </Card>
      <LinesTable requisition={requisition} />
      <ApprovalCard
        document="requisition"
        id={id}
        number={number}
        amount={requisition.amount}
        draft={status === 'draft'}
        approval={approval}
      />
      {(status === 'approved' || status === 'closed') && (
        <LinkList
          title={t('requisitions.ordersTitle')}
          subtitle={t('requisitions.ordersSubtitle')}
          empty={held ? undefined : t('requisitions.noOrders')}
        >
          {requisition.orders.map((order) => (
            <li key={order.id}>
              <Link
                to="/purchase-orders/$orderId"
                params={{ orderId: order.id }}
                className={LINK_ROW}
              >
                {/* A draft nobody submitted has no number yet */}
                <span className={LINK_NUMBER}>
                  {order.number ?? t('purchaseOrders.statuses.draft')}
                </span>
              </Link>
            </li>
          ))}
        </LinkList>
      )}

      {canWrite && status === 'draft' && (
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Left, away from the rest */}
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {neverSubmitted ? (
                // Two clicks: a deleted requisition cannot come back
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
                    ? t('requisitions.confirmDelete', { number })
                    : t('requisitions.delete')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setAsking('cancel');
                  }}
                >
                  {t('requisitions.cancel')}
                </Button>
              )}
              {confirmingDelete && (
                <span className="text-body-sm text-ink-2">{t('requisitions.deleteWarning')}</span>
              )}
            </div>
            <Button variant="secondary" disabled={busy} onClick={onEdit}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
              {t('requisitions.edit')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                submit.mutate();
              }}
            >
              <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={1.5} />
              {t('requisitions.submit')}
            </Button>
          </div>
          <p className="text-right text-label text-ink-3">{t('requisitions.submitHint')}</p>
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
            {t('requisitions.reopen')}
          </Button>
        </div>
      )}
      {status === 'approved' && (canWrite || canOrder) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* An approved requisition may be cancelled at once, until an order buys for it; then
              the rest is closed (decision 17) */}
          {canWrite && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={busy}
              onClick={() => {
                setAsking(held ? 'close' : 'cancel');
              }}
            >
              {held ? t('requisitions.close') : t('requisitions.cancel')}
            </Button>
          )}
          {canWrite && !held && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAsking('reopen');
              }}
            >
              {t('requisitions.reopen')}
            </Button>
          )}
          {/* Decision 18: the order form opens with the lines still to order, narrowed to this
              requisition */}
          {canOrder && requisition.orderState !== 'ordered' && (
            <Button
              disabled={busy}
              onClick={() =>
                void navigate({ to: '/purchase-orders/new', search: { requisitionId: id } })
              }
            >
              <HugeiconsIcon icon={ShoppingCart01Icon} size={17} strokeWidth={1.5} />
              {t('requisitions.makeOrder')}
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
            title={t(`requisitions.${asking}Title`, { number })}
            description={t(`requisitions.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('requisitions.keep')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`requisitions.${asking}`)}
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
