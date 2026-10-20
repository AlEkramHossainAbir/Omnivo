import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { goodsReceiptQuery, purchaseReturnQuery, unitsQuery } from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own (the
// delivery's pattern), like the sales return of 15d
const PurchaseReturnForm = lazy(async () => ({
  default: (await import('../components/purchase-return-form')).PurchaseReturnForm,
}));
const PurchaseReturnView = lazy(async () => ({
  default: (await import('../components/purchase-return-view')).PurchaseReturnView,
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
      <PurchaseBackLink to="/purchase-returns" label={t('purchaseReturns.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('purchaseReturns.title')} description={message} />
    </div>
  );
}

// A new return; "Send goods back" on a goods receipt comes here with ?receiptId=
export function NewPurchaseReturnPage() {
  const { t } = useLocale();
  const canWrite = useCan()('purchase.return.manage');
  const today = useToday();
  const ready = useReady();
  const { receiptId = '' } = useSearch({ strict: false });
  const { data: receipt, isError } = useQuery({
    ...goodsReceiptQuery(useTenantId(), receiptId),
    enabled: receiptId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/purchase-returns" label={t('purchaseReturns.back')} />
        <p className="text-body-sm text-ink-3">{t('purchaseReturns.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('goodsReceipts.notFound')} />;
  // The form waits for the receipt: drawing it empty and filling it a moment later would let the
  // person type into a form that is about to be replaced
  if (!ready || (receiptId !== '' && !receipt)) return null;
  // Only a posted receipt's goods can go back; a draft's start the form empty
  const posted = receipt?.status === 'posted' ? receipt : null;
  return (
    <Suspense fallback={null}>
      <PurchaseReturnForm purchaseReturn={null} receipt={posted} today={today} />
    </Suspense>
  );
}

export function PurchaseReturnPage() {
  const { t } = useLocale();
  const { returnId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.return.manage');
  const today = useToday();
  const ready = useReady();
  const { data: purchaseReturn, isError } = useQuery({
    ...purchaseReturnQuery(useTenantId(), returnId),
    enabled: returnId !== '',
  });

  if (isError) return <CantFind message={t('purchaseReturns.notFound')} />;
  if (!purchaseReturn || !ready) return null;
  if (purchaseReturn.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <PurchaseReturnForm
          key={`${purchaseReturn.id}-${String(purchaseReturn.version)}`}
          purchaseReturn={purchaseReturn}
          receipt={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <PurchaseReturnView purchaseReturn={purchaseReturn} />
    </Suspense>
  );
}
