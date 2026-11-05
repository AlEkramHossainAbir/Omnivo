import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { deliveryQuery, salesReturnQuery, unitsQuery } from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own (the
// delivery's pattern)
const ReturnForm = lazy(async () => ({
  default: (await import('../components/return-form')).ReturnForm,
}));
const ReturnView = lazy(async () => ({
  default: (await import('../components/return-view')).ReturnView,
}));

// The units and the warehouses: the lines and the warehouse box need them
function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-returns" label={t('salesReturns.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('salesReturns.title')} description={message} />
    </div>
  );
}

// A new return; "Take goods back" on a challan comes here with ?deliveryId=
export function NewSalesReturnPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.return.manage');
  const today = useToday();
  const ready = useReady();
  const { deliveryId = '' } = useSearch({ strict: false });
  const { data: delivery, isError } = useQuery({
    ...deliveryQuery(useTenantId(), deliveryId),
    enabled: deliveryId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/sales-returns" label={t('salesReturns.back')} />
        <p className="text-body-sm text-ink-3">{t('salesReturns.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('deliveries.notFound')} />;
  // The form waits for the challan: drawing it empty and filling it a moment later would let the
  // person type into a form that is about to be replaced
  if (!ready || (deliveryId !== '' && !delivery)) return null;
  // Only a posted challan's goods can come back; a draft's start the form empty
  const posted = delivery?.status === 'posted' ? delivery : null;
  return (
    <Suspense fallback={null}>
      <ReturnForm salesReturn={null} delivery={posted} today={today} />
    </Suspense>
  );
}

export function SalesReturnPage() {
  const { t } = useLocale();
  const { returnId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.return.manage');
  const today = useToday();
  const ready = useReady();
  const { data: salesReturn, isError } = useQuery({
    ...salesReturnQuery(useTenantId(), returnId),
    enabled: returnId !== '',
  });

  if (isError) return <CantFind message={t('salesReturns.notFound')} />;
  if (!salesReturn || !ready) return null;
  if (salesReturn.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <ReturnForm
          key={`${salesReturn.id}-${String(salesReturn.version)}`}
          salesReturn={salesReturn}
          delivery={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <ReturnView salesReturn={salesReturn} />
    </Suspense>
  );
}
