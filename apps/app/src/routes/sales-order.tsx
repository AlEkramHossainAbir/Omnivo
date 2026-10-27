import { AlertCircleIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { type LocalCopy, outboxOf, productsOfVariants } from '@omnivo/sync';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useCallback } from 'react';

import { LocalState } from '../components/local-state';
import type { OutboxDraft } from '../components/sales-order-form';
import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useLocalCopy, useLocalData, useLocalQuery } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { draftLines } from '../lib/sales';
import { useOnline } from '../lib/use-online';
import {
  deviceSettingsQuery,
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

// The units, the VAT rates, the warehouses and the settings: the form and the view need them all.
// Step 18b: offline, the first three come from the device (queries.ts), and the way prices are
// written from the device's copy of the settings.
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const local = useQuery({ ...deviceSettingsQuery(tenantId), enabled: !settings }).data;
  const pricesIncludeVat = settings?.pricesIncludeVat ?? local?.pricesIncludeVat;
  const { active } = useWarehouses();
  if (units === undefined || rates === undefined || pricesIncludeVat === undefined || !active) {
    return null;
  }
  return { pricesIncludeVat };
}

// A draft order waiting in the outbox under this id, with its lines' products from the device;
// null = none (the order is the server's)
async function readDraft(copy: LocalCopy, orderId: string): Promise<OutboxDraft | null> {
  const [entry] = await outboxOf(copy, orderId);
  if (entry?.command.type !== 'sales_order.create_draft') return null;
  const { input } = entry.command;
  const products = await productsOfVariants(
    copy,
    input.lines.map((line) => line.variantId),
  );
  return {
    orderId,
    input,
    lines: draftLines(input.lines, products, input.customerId),
    error: entry.error,
  };
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
  const online = useOnline();
  const { view } = useLocalData();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
        <p className="text-body-sm text-ink-3">{t('salesOrders.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('quotations.notFound')} />;
  // Offline, an order is saved on the device: without a complete copy, its state says what to do
  if (!online && quotationId === '' && view.kind !== 'ready') {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
        <LocalState view={view} />
      </div>
    );
  }
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
  const online = useOnline();
  const copy = useLocalCopy();
  // Step 18b: a draft saved on this device opens from the outbox; the server is asked only when
  // there is none (it does not know the order yet)
  const read = useCallback((open: LocalCopy) => readDraft(open, orderId), [orderId]);
  const draft = useLocalQuery(copy ? read : null);
  const { data: order, isError } = useQuery({
    ...salesOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '' && (copy === null || draft === null),
  });

  if (copy && draft === undefined) return null;
  if (draft && ready) {
    return (
      <Suspense fallback={null}>
        <SalesOrderForm
          order={null}
          quotation={null}
          draft={draft}
          today={today}
          pricesIncludeVat={ready.pricesIncludeVat}
        />
      </Suspense>
    );
  }
  if (!online && !order) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('sync.orderOffline')}
        />
      </div>
    );
  }
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
