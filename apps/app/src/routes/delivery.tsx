import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { deliveryQuery, salesOrderQuery, unitsQuery } from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own (the stock
// documents' pattern)
const DeliveryForm = lazy(async () => ({
  default: (await import('../components/delivery-form')).DeliveryForm,
}));
const DeliveryView = lazy(async () => ({
  default: (await import('../components/delivery-view')).DeliveryView,
}));

function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('deliveries.title')} description={message} />
    </div>
  );
}

// A new delivery; "New delivery" on an order comes here with ?orderId=
export function NewDeliveryPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.delivery.manage');
  const today = useToday();
  const ready = useReady();
  const { orderId = '' } = useSearch({ strict: false });
  const { data: order, isError } = useQuery({
    ...salesOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
        <p className="text-body-sm text-ink-3">{t('deliveries.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('salesOrders.notFound')} />;
  if (!ready || (orderId !== '' && !order)) return null;
  return (
    <Suspense fallback={null}>
      <DeliveryForm delivery={null} order={order ?? null} today={today} />
    </Suspense>
  );
}

export function DeliveryPage() {
  const { t } = useLocale();
  const { deliveryId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.delivery.manage');
  const today = useToday();
  const ready = useReady();
  const { data: delivery, isError } = useQuery({
    ...deliveryQuery(useTenantId(), deliveryId),
    enabled: deliveryId !== '',
  });

  if (isError) return <CantFind message={t('deliveries.notFound')} />;
  if (!delivery || !ready) return null;
  if (delivery.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <DeliveryForm
          key={`${delivery.id}-${String(delivery.version)}`}
          delivery={delivery}
          order={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <DeliveryView delivery={delivery} />
    </Suspense>
  );
}
