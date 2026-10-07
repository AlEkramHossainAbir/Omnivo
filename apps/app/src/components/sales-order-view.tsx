import { DeliveryTruck01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { routes, type SalesOrder, type StockDocumentStatus } from '@omnivo/contracts';
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
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { Fact } from './adjustment-view';
import { failureOf } from './journal-parts';
import { SalesLinesTable } from './sales-lines-table';
import {
  CustomerLink,
  DeliveryStatusPill,
  OrderStatusPills,
  SalesBackLink,
  useSalesRefresh,
} from './sales-parts';
import { useIsoDate, useWarehouses, warehouseLabel } from './stock-parts';

// What the three order actions that cannot be undone are called, and what they say before they run
type Action = 'reopen' | 'close' | 'cancel';

// The deliveries list on the order sends a status as a plain string (sales-orders.ts); only the
// two a delivery has are shown as a pill
function deliveryStatus(status: string): StockDocumentStatus | null {
  return status === 'draft' || status === 'posted' ? status : null;
}

// An order that is not edited here (confirmed, delivered, closed, cancelled — or a draft for
// someone who may not write orders): its lines with what went out, its deliveries, and what can be
// done next.
export function SalesOrderView({ order, today }: { order: SalesOrder; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const refresh = useSalesRefresh();
  const { byId } = useWarehouses();
  const can = useCan();
  const canWrite = can('sales.order.manage');
  const canDeliver = can('sales.delivery.manage');
  const [asking, setAsking] = useState<Action | null>(null);
  const number = order.number ?? '';

  const act = useMutation({
    mutationFn: (action: Action) =>
      call(routes.salesOrders[action], {
        params: { id: order.id },
        body: { version: order.version },
      }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      await refresh();
      const done = { reopen: 'reopened', close: 'closed', cancel: 'cancelled' } as const;
      toast(t(`salesOrders.${done[action]}`, { number: saved.number ?? '' }));
    },
  });

  const confirmed = order.status === 'confirmed';
  // Back to draft only with no delivery at all, drafts included (the API's order_has_deliveries)
  const canReopen = confirmed && order.deliveries.length === 0;
  // Something went out: the rest is closed. Nothing went out: the order is cancelled.
  const endAction: Action = order.partlyDelivered ? 'close' : 'cancel';

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
      <PageHeader
        title={order.number ?? t('salesOrders.draftTitle')}
        description={order.customer.name}
        actions={<OrderStatusPills order={order} today={today} />}
      />
      {failureOf(act.error) && asking === null && (
        <FormAlert message={failureOf(act.error) ?? ''} />
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('salesOrders.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={order.customer} />
          </span>
        </div>
        <Fact label={t('salesOrders.date')} value={isoDate(order.date)} />
        <Fact
          label={t('salesOrders.deliveryDate')}
          value={order.deliveryDate === null ? '—' : isoDate(order.deliveryDate)}
        />
        {order.customerReference !== null && (
          <Fact label={t('salesOrders.customerReference')} value={order.customerReference} />
        )}
        <Fact
          label={t('salesOrders.warehouse')}
          value={warehouseLabel(byId.get(order.warehouseId))}
        />
        {order.shippingAddress !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('salesOrders.shippingAddress')}
            </span>
            {/* The address as it was saved, one part per line (label, address, phone) */}
            <span className="text-body-sm whitespace-pre-line text-ink">
              {order.shippingAddress}
            </span>
          </div>
        )}
        {order.quotation !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('salesOrders.quotation')}
            </span>
            <Link
              to="/quotations/$quotationId"
              params={{ quotationId: order.quotation.id }}
              className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {order.quotation.number}
            </Link>
          </div>
        )}
        {order.confirmedAt !== null && (
          <Fact
            label={t('salesOrders.statuses.confirmed')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('salesOrders.confirmedOn', { date: format.date(new Date(order.confirmedAt)) })}
          />
        )}
        {order.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('salesOrders.note')} value={order.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={order.lines}
        totals={order}
        pricesIncludeVat={order.pricesIncludeVat}
        delivered={order.status !== 'draft'}
      />
      {order.status !== 'draft' && (
        <Card className="overflow-hidden">
          <CardHeader
            title={t('salesOrders.deliveriesTitle')}
            subtitle={t('salesOrders.deliveriesSubtitle')}
          />
          {order.deliveries.length === 0 ? (
            <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">
              {t('salesOrders.noDeliveries')}
            </p>
          ) : (
            <ul className="mt-3 grid grid-cols-1">
              {order.deliveries.map((delivery) => {
                const status = deliveryStatus(delivery.status);
                return (
                  <li key={delivery.id} className="border-t border-line">
                    <Link
                      to="/deliveries/$deliveryId"
                      params={{ deliveryId: delivery.id }}
                      className="flex flex-wrap items-center gap-3 px-5 py-3 text-body-sm hover:bg-subtle"
                    >
                      <span className="font-mono font-medium text-brand tabular-nums">
                        {delivery.number ?? t('deliveries.statuses.draft')}
                      </span>
                      <span className="text-ink-3 tabular-nums">{isoDate(delivery.date)}</span>
                      <span className="ml-auto">
                        {status !== null && <DeliveryStatusPill status={status} />}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {confirmed && (canWrite || canDeliver) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canWrite && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setAsking(endAction);
                }}
              >
                {t(`salesOrders.${endAction}`)}
              </Button>
            </div>
          )}
          {canWrite && canReopen && (
            <Button
              variant="secondary"
              onClick={() => {
                setAsking('reopen');
              }}
            >
              {t('salesOrders.reopen')}
            </Button>
          )}
          {canDeliver && (
            <Button
              onClick={() =>
                void navigate({ to: '/deliveries/new', search: { orderId: order.id } })
              }
            >
              <HugeiconsIcon icon={DeliveryTruck01Icon} size={17} strokeWidth={1.5} />
              {t('salesOrders.deliver')}
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
            title={t(`salesOrders.${asking}Title`, { number })}
            description={t(`salesOrders.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('salesOrders.keepOrder')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`salesOrders.${asking}`)}
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
