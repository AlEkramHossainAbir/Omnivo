import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import type { PartyRef } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { PurchaseBackLink } from '../components/purchase-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { type BillSourcedLine, orderServiceLines, receiptBillLines } from '../lib/bill-sources';
import { useCan } from '../lib/permissions';
import {
  accountsQuery,
  billQuery,
  branchesQuery,
  goodsReceiptQuery,
  purchaseOrderQuery,
  taxRatesQuery,
  unitsQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own, like the
// invoice's (step 15c)
const BillForm = lazy(async () => ({
  default: (await import('../components/bill-form')).BillForm,
}));
const BillView = lazy(async () => ({
  default: (await import('../components/bill-view')).BillView,
}));

// The units, the VAT rates, the warehouses, the branches and the accounts: the form's lines, its
// boxes and its expenses need them all, and the form's starting values read the branches
function useReady(): boolean {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const { active } = useWarehouses();
  return (
    units !== undefined &&
    rates !== undefined &&
    branches !== undefined &&
    accounts !== undefined &&
    active !== undefined
  );
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/bills" label={t('bills.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('bills.title')} description={message} />
    </div>
  );
}

// A new bill. "Make bill" on a goods receipt comes with ?receiptId=: the form starts with what is
// left to bill on it, at its order's prices. "Make bill" on an order comes with ?orderId=: the
// order's services not billed yet.
export function NewBillPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const canWrite = useCan()('purchase.bill.manage');
  const today = useToday();
  const ready = useReady();
  const { receiptId = '', orderId = '' } = useSearch({ strict: false });
  const start = useQuery({
    queryKey: ['purchase', tenantId, 'bill-start', receiptId, orderId],
    queryFn: async (): Promise<{ supplier: PartyRef; lines: BillSourcedLine[] }> => {
      if (receiptId !== '') {
        const receipt = await queryClient.query(goodsReceiptQuery(tenantId, receiptId));
        const { lines } = await receiptBillLines(queryClient, tenantId, receipt, new Set());
        return { supplier: receipt.supplier, lines };
      }
      const order = await queryClient.query(purchaseOrderQuery(tenantId, orderId));
      return { supplier: order.supplier, lines: orderServiceLines(order, new Set()) };
    },
    enabled: receiptId !== '' || orderId !== '',
    // Read once for this form: the next "Make bill" asks again, after whatever was billed since
    gcTime: 0,
    retry: false,
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PurchaseBackLink to="/bills" label={t('bills.back')} />
        <p className="text-body-sm text-ink-3">{t('bills.cantWrite')}</p>
      </div>
    );
  }
  if (start.isError) {
    return (
      <CantFind
        message={receiptId !== '' ? t('goodsReceipts.notFound') : t('purchaseOrders.notFound')}
      />
    );
  }
  // The form waits for the lines it starts with: drawing it empty and filling it a moment later
  // would let the person type into a form that is about to be replaced
  if (!ready || ((receiptId !== '' || orderId !== '') && !start.data)) return null;
  return (
    <Suspense fallback={null}>
      <BillForm bill={null} start={start.data ?? null} today={today} />
    </Suspense>
  );
}

export function BillPage() {
  const { t } = useLocale();
  const { billId = '' } = useParams({ strict: false });
  const canWrite = useCan()('purchase.bill.manage');
  const today = useToday();
  const ready = useReady();
  const { data: bill, isError } = useQuery({
    ...billQuery(useTenantId(), billId),
    enabled: billId !== '',
  });

  if (isError) return <CantFind message={t('bills.notFound')} />;
  if (!bill || !ready) return null;
  if (bill.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <BillForm
          key={`${bill.id}-${String(bill.version)}`}
          bill={bill}
          start={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <BillView bill={bill} today={today} />
    </Suspense>
  );
}
