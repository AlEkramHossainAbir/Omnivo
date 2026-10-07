import type { Delivery } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { CustomerLink, DeliveryStatusPill, SalesBackLink } from './sales-parts';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useWarehouses, warehouseLabel } from './stock-parts';

// A posted delivery (or a draft for someone who may not write deliveries), read only. A posted one
// never changes: goods that come back are a return (15d).
export function DeliveryView({ delivery }: { delivery: Delivery }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
      <PageHeader
        title={delivery.number ?? t('deliveries.draftTitle')}
        description={delivery.customer.name}
        actions={<DeliveryStatusPill status={delivery.status} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('deliveries.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={delivery.customer} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('deliveries.order')}</span>
          {delivery.order === null ? (
            <span className="text-body-sm text-ink-3">{t('deliveries.noOrder')}</span>
          ) : (
            <Link
              to="/sales-orders/$orderId"
              params={{ orderId: delivery.order.id }}
              className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {delivery.order.number ?? t('salesOrders.statuses.draft')}
            </Link>
          )}
        </div>
        <Fact label={t('deliveries.date')} value={isoDate(delivery.date)} />
        <Fact
          label={t('deliveries.warehouse')}
          value={warehouseLabel(byId.get(delivery.warehouseId))}
        />
        {delivery.shippingAddress !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('deliveries.shippingAddress')}
            </span>
            <span className="text-body-sm whitespace-pre-line text-ink">
              {delivery.shippingAddress}
            </span>
          </div>
        )}
        {delivery.vehicle !== null && (
          <Fact label={t('deliveries.vehicle')} value={delivery.vehicle} />
        )}
        {delivery.postedAt !== null && (
          <Fact
            label={t('deliveries.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('deliveries.postedOn', { date: format.date(new Date(delivery.postedAt)) })}
          />
        )}
        {delivery.status === 'posted' && (
          <EntryLinks
            label={t('deliveries.entry')}
            entries={delivery.entry ? [delivery.entry] : []}
            none={t('deliveries.noEntry')}
          />
        )}
        {delivery.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('deliveries.note')} value={delivery.note} />
          </div>
        )}
      </Card>
      <StockLinesTable lines={delivery.lines} />
    </div>
  );
}
