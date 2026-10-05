import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink, useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockTransferQuery, unitsQuery } from '../lib/queries';

// Like the adjustment page: data first, then the draft form or the view (with the receipt form)
const TransferForm = lazy(async () => ({
  default: (await import('../components/transfer-form')).TransferForm,
}));
const TransferView = lazy(async () => ({
  default: (await import('../components/transfer-view')).TransferView,
}));

function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

export function NewStockTransferPage() {
  const { t } = useLocale();
  const canWrite = useCan()('inventory.stock.transfer');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/transfers" label={t('transfers.back')} />
        <p className="text-body-sm text-ink-3">{t('transfers.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <TransferForm transfer={null} today={today} />
    </Suspense>
  );
}

export function StockTransferPage() {
  const { t } = useLocale();
  const { transferId = '' } = useParams({ strict: false });
  const canWrite = useCan()('inventory.stock.transfer');
  const today = useToday();
  const ready = useReady();
  const { data: transfer, isError } = useQuery({
    ...stockTransferQuery(useTenantId(), transferId),
    enabled: transferId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/transfers" label={t('transfers.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('transfers.draftTitle')}
          description={t('transfers.notFound')}
        />
      </div>
    );
  }
  if (!transfer || !ready) return null;
  if (transfer.status === 'draft' && canWrite) {
    return (
      <Suspense fallback={null}>
        <TransferForm
          key={`${transfer.id}-${String(transfer.version)}`}
          transfer={transfer}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <TransferView
        key={`${transfer.id}-${String(transfer.version)}`}
        transfer={transfer}
        canReceive={canWrite}
        today={today}
      />
    </Suspense>
  );
}
