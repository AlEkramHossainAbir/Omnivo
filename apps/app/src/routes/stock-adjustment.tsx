import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink, useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockAdjustmentQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// journal entry's pattern): reading a posted adjustment needs neither the form library nor the
// date picker.
const AdjustmentForm = lazy(async () => ({
  default: (await import('../components/adjustment-form')).AdjustmentForm,
}));
const AdjustmentView = lazy(async () => ({
  default: (await import('../components/adjustment-view')).AdjustmentView,
}));

// What every adjustment page needs before it draws: the units and the warehouses
function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

export function NewStockAdjustmentPage() {
  const { t } = useLocale();
  const canWrite = useCan()('inventory.stock.adjust');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
        <p className="text-body-sm text-ink-3">{t('adjustments.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <AdjustmentForm adjustment={null} today={today} />
    </Suspense>
  );
}

export function StockAdjustmentPage() {
  const { t } = useLocale();
  const { adjustmentId = '' } = useParams({ strict: false });
  const canWrite = useCan()('inventory.stock.adjust');
  const today = useToday();
  const ready = useReady();
  const { data: adjustment, isError } = useQuery({
    ...stockAdjustmentQuery(useTenantId(), adjustmentId),
    enabled: adjustmentId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('adjustments.draftTitle')}
          description={t('adjustments.notFound')}
        />
      </div>
    );
  }
  if (!adjustment || !ready) return null;
  if (adjustment.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <AdjustmentForm
          key={`${adjustment.id}-${String(adjustment.version)}`}
          adjustment={adjustment}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <AdjustmentView adjustment={adjustment} />
    </Suspense>
  );
}
