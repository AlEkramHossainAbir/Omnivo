import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { challanLines } from '../lib/invoice-sources';
import { useCan } from '../lib/permissions';
import {
  branchesQuery,
  customerQuery,
  deliveryQuery,
  invoiceQuery,
  settingsQuery,
  taxRatesQuery,
  unitsQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own
const InvoiceForm = lazy(async () => ({
  default: (await import('../components/invoice-form')).InvoiceForm,
}));
const InvoiceView = lazy(async () => ({
  default: (await import('../components/invoice-view')).InvoiceView,
}));

// The units, the VAT rates, the warehouses, the branches and the settings: the form's lines and
// boxes need them all
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const { active } = useWarehouses();
  if (!units || !rates || !settings || !branches || !active) return null;
  return { pricesIncludeVat: settings.pricesIncludeVat };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/invoices" label={t('invoices.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('invoices.title')} description={message} />
    </div>
  );
}

// A new invoice. "Make invoice" on a challan comes with ?deliveryId=: the form starts with what is
// left to bill on it, priced from its order. "New invoice" on a customer's page comes with
// ?customerId=.
export function NewInvoicePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const canWrite = useCan()('sales.invoice.manage');
  const today = useToday();
  const ready = useReady();
  const { deliveryId = '', customerId = '' } = useSearch({ strict: false });
  const delivery = useQuery({
    ...deliveryQuery(tenantId, deliveryId),
    enabled: deliveryId !== '',
  });
  const start = useQuery({
    queryKey: ['sales', tenantId, 'invoice-start', deliveryId],
    queryFn: async () => {
      if (!delivery.data) throw new Error('No challan');
      return {
        delivery: delivery.data,
        ...(await challanLines(queryClient, tenantId, delivery.data, new Set())),
      };
    },
    enabled: delivery.data !== undefined,
    // Read once for this form: the next "Make invoice" asks again, after whatever was billed since
    gcTime: 0,
    retry: false,
  });
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/invoices" label={t('invoices.back')} />
        <p className="text-body-sm text-ink-3">{t('invoices.cantWrite')}</p>
      </div>
    );
  }
  if (delivery.isError || start.isError) return <CantFind message={t('deliveries.notFound')} />;
  if (customer.isError) return <CantFind message={t('customers.notFound')} />;
  // The form waits for the challan's lines or the customer: drawing it empty and filling it a
  // moment later would let the person type into a form that is about to be replaced
  if (!ready || (deliveryId !== '' && !start.data) || (customerId !== '' && !customer.data)) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <InvoiceForm
        invoice={null}
        start={start.data ? { delivery: start.data.delivery, lines: start.data.lines } : null}
        customer={customer.data ?? null}
        today={today}
        pricesIncludeVat={ready.pricesIncludeVat}
      />
    </Suspense>
  );
}

export function InvoicePage() {
  const { t } = useLocale();
  const { invoiceId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.invoice.manage');
  const today = useToday();
  const ready = useReady();
  const { data: invoice, isError } = useQuery({
    ...invoiceQuery(useTenantId(), invoiceId),
    enabled: invoiceId !== '',
  });

  if (isError) return <CantFind message={t('invoices.notFound')} />;
  if (!invoice || !ready) return null;
  if (invoice.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <InvoiceForm
          key={`${invoice.id}-${String(invoice.version)}`}
          invoice={invoice}
          start={null}
          customer={null}
          today={today}
          pricesIncludeVat={ready.pricesIncludeVat}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <InvoiceView invoice={invoice} today={today} />
    </Suspense>
  );
}
