import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import {
  quotationQuery,
  salesOrderQuery,
  settingsQuery,
  taxRatesQuery,
  unitsQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own
const SalesOrderForm = lazy(async () => ({
  default: (await import('../components/sales-order-form')).SalesOrderForm,
}));
const SalesOrderView = lazy(async () => ({
  default: (await import('../components/sales-order-view')).SalesOrderView,
}));

// The units, the VAT rates, the warehouses and the settings: the form and the view need them all
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const { active } = useWarehouses();
  if (units === undefined || rates === undefined || settings === undefined || !active) return null;
  return { pricesIncludeVat: settings.pricesIncludeVat };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('salesOrders.title')} description={message} />
    </div>
  );
}

// A new order; "Make order" on a quotation comes here with ?quotationId=
export function NewSalesOrderPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.order.manage');
  const today = useToday();
  const ready = useReady();
  const { quotationId = '' } = useSearch({ strict: false });
  const { data: quotation, isError } = useQuery({
    ...quotationQuery(useTenantId(), quotationId),
    enabled: quotationId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
        <p className="text-body-sm text-ink-3">{t('salesOrders.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('quotations.notFound')} />;
  if (!ready || (quotationId !== '' && !quotation)) return null;
  return (
    <Suspense fallback={null}>
      <SalesOrderForm
        order={null}
        quotation={quotation ?? null}
        today={today}
        // An order keeps its quotation's way of writing prices (decision of 15b.3)
        pricesIncludeVat={quotation?.pricesIncludeVat ?? ready.pricesIncludeVat}
      />
    </Suspense>
  );
}

export function SalesOrderPage() {
  const { t } = useLocale();
  const { orderId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.order.manage');
  const today = useToday();
  const ready = useReady();
  const { data: order, isError } = useQuery({
    ...salesOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });

  if (isError) return <CantFind message={t('salesOrders.notFound')} />;
  if (!order || !ready) return null;
  if (order.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <SalesOrderForm
          key={`${order.id}-${String(order.version)}`}
          order={order}
          quotation={null}
          today={today}
          pricesIncludeVat={order.pricesIncludeVat}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <SalesOrderView order={order} today={today} />
    </Suspense>
  );
}
