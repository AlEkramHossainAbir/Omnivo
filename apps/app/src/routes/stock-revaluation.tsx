import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink, useTenantId, useToday } from '../components/stock-parts';
import { stockRevaluationQuery, unitsQuery } from '../lib/queries';

// Like an adjustment's page: the data here, the form and the view each a lazy chunk of their own
const RevaluationForm = lazy(async () => ({
  default: (await import('../components/revaluation-form')).RevaluationForm,
}));
const RevaluationView = lazy(async () => ({
  default: (await import('../components/revaluation-view')).RevaluationView,
}));

// The route needs inventory.stock.revalue (the API refuses the rest): the nav only shows it then
export function NewStockRevaluationPage() {
  const today = useToday();
  const units = useQuery(unitsQuery(useTenantId())).data;
  if (units === undefined) return null;
  return (
    <Suspense fallback={null}>
      <RevaluationForm today={today} />
    </Suspense>
  );
}

export function StockRevaluationPage() {
  const { t } = useLocale();
  const { revaluationId = '' } = useParams({ strict: false });
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { data: revaluation, isError } = useQuery({
    ...stockRevaluationQuery(useTenantId(), revaluationId),
    enabled: revaluationId !== '',
  });
  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/revaluations" label={t('revaluations.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('revaluations.title')}
          description={t('revaluations.notFound')}
        />
      </div>
    );
  }
  if (!revaluation || units === undefined) return null;
  return (
    <Suspense fallback={null}>
      <RevaluationView revaluation={revaluation} />
    </Suspense>
  );
}
