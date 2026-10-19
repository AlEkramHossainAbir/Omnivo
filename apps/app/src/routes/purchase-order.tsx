import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { purchaseOrderQuery, requisitionQuery, taxRatesQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// requisition's pattern): reading an order needs neither the form library nor the line editor.
const PurchaseOrderForm = lazy(async () => ({
  default: (await import('../components/purchase-order-form')).PurchaseOrderForm,
}));
const PurchaseOrderView = lazy(async () => ({
  default: (await import('../components/purchase-order-view')).PurchaseOrderView,
}));

// What every order page needs before it draws: the units (a line's quantity), the VAT rates (a
// line's rate) and the warehouses (the select, and the name of an archived one)
function useReady(): boolean {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const { active } = useWarehouses();
  return units !== undefined && rates !== undefined && active !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('purchaseOrders.title')} description={message} />
    </div>
  );
}

// A new order; "Make purchase order" on a requisition comes here with ?requisitionId=
export function NewPurchaseOrderPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.order.manage');
  const today = useToday();
  const ready = useReady();
  const { requisitionId = '' } = useSearch({ strict: false });
  const { data: requisition, isError } = useQuery({
    ...requisitionQuery(useTenantId(), requisitionId),
    enabled: requisitionId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
        <p className="text-body-sm text-ink-3">{t('purchaseOrders.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('requisitions.notFound')} />;
  if (!ready || (requisitionId !== '' && !requisition)) return null;
  return (
    <Suspense fallback={null}>
      <PurchaseOrderForm
        order={null}
        requisition={
          requisition ? { id: requisition.id, warehouseId: requisition.warehouseId } : null
        }
        today={today}
      />
    </Suspense>
  );
}

export function PurchaseOrderPage() {
  const { t } = useLocale();
  const { orderId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.order.manage');
  const today = useToday();
  const ready = useReady();
  // A draft is shown as it was saved, with Submit; "Edit" turns the page into the form until it
  // is saved
  const [editing, setEditing] = useState(false);
  const { data: order, isError } = useQuery({
    ...purchaseOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });

  if (isError) return <CantFind message={t('purchaseOrders.notFound')} />;
  if (!order || !ready) return null;
  // Only a draft is changed: one submitted meanwhile (from another tab) shows as it is now
  if (editing && canWrite && order.status === 'draft') {
    return (
      <Suspense fallback={null}>
        <PurchaseOrderForm
          key={`${order.id}-${String(order.version)}`}
          order={order}
          requisition={null}
          today={today}
          onClose={() => {
            setEditing(false);
          }}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <PurchaseOrderView
        order={order}
        today={today}
        onEdit={() => {
          setEditing(true);
        }}
      />
    </Suspense>
  );
}
