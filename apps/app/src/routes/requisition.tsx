import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { requisitionQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// quotation's pattern): reading a requisition needs neither the form library nor the line editor.
const RequisitionForm = lazy(async () => ({
  default: (await import('../components/requisition-form')).RequisitionForm,
}));
const RequisitionView = lazy(async () => ({
  default: (await import('../components/requisition-view')).RequisitionView,
}));

// What every requisition page needs before it draws: the units (a line's quantity) and the
// warehouses (the select, and the name of an archived one)
function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

export function NewRequisitionPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.requisition.manage');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
        <p className="text-body-sm text-ink-3">{t('requisitions.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <RequisitionForm requisition={null} today={today} />
    </Suspense>
  );
}

export function RequisitionPage() {
  const { t } = useLocale();
  const { requisitionId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.requisition.manage');
  const today = useToday();
  const ready = useReady();
  // A draft is shown as it was saved, with Submit; "Edit" turns the page into the form until it is
  // saved
  const [editing, setEditing] = useState(false);
  const { data: requisition, isError } = useQuery({
    ...requisitionQuery(useTenantId(), requisitionId),
    enabled: requisitionId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('requisitions.title')}
          description={t('requisitions.notFound')}
        />
      </div>
    );
  }
  if (!requisition || !ready) return null;
  // Only a draft is changed: one submitted or approved meanwhile (by this person elsewhere) shows
  // as it is now
  if (editing && canWrite && requisition.status === 'draft') {
    return (
      <Suspense fallback={null}>
        <RequisitionForm
          key={`${requisition.id}-${String(requisition.version)}`}
          requisition={requisition}
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
      <RequisitionView
        requisition={requisition}
        onEdit={() => {
          setEditing(true);
        }}
      />
    </Suspense>
  );
}
