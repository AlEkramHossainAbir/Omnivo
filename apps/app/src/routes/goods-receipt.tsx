import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { goodsReceiptQuery, purchaseOrderQuery, unitsQuery } from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own (the
// delivery's pattern)
const GoodsReceiptForm = lazy(async () => ({
  default: (await import('../components/goods-receipt-form')).GoodsReceiptForm,
}));
const GoodsReceiptView = lazy(async () => ({
  default: (await import('../components/goods-receipt-view')).GoodsReceiptView,
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
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('goodsReceipts.title')} description={message} />
    </div>
  );
}

// A new goods receipt; "Receive goods" on an order comes here with ?orderId=
export function NewGoodsReceiptPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.receipt.manage');
  const today = useToday();
  const ready = useReady();
  const { orderId = '' } = useSearch({ strict: false });
  const { data: order, isError } = useQuery({
    ...purchaseOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
        <p className="text-body-sm text-ink-3">{t('goodsReceipts.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('purchaseOrders.notFound')} />;
  if (!ready || (orderId !== '' && !order)) return null;
  return (
    <Suspense fallback={null}>
      <GoodsReceiptForm receipt={null} order={order ?? null} today={today} />
    </Suspense>
  );
}

export function GoodsReceiptPage() {
  const { t } = useLocale();
  const { receiptId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.receipt.manage');
  const today = useToday();
  const ready = useReady();
  const { data: receipt, isError } = useQuery({
    ...goodsReceiptQuery(useTenantId(), receiptId),
    enabled: receiptId !== '',
  });

  if (isError) return <CantFind message={t('goodsReceipts.notFound')} />;
  if (!receipt || !ready) return null;
  if (receipt.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <GoodsReceiptForm
          key={`${receipt.id}-${String(receipt.version)}`}
          receipt={receipt}
          order={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <GoodsReceiptView receipt={receipt} />
    </Suspense>
  );
}
