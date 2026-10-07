import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { quotationQuery, settingsQuery, taxRatesQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// stock documents' pattern): reading a quotation needs neither the form library nor the editor.
const QuotationForm = lazy(async () => ({
  default: (await import('../components/quotation-form')).QuotationForm,
}));
const QuotationView = lazy(async () => ({
  default: (await import('../components/quotation-view')).QuotationView,
}));

// What every quotation page needs before it draws: the units, the VAT rates (a line's rate and
// its totals) and the settings (whether a new quotation's prices include VAT)
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  if (units === undefined || rates === undefined || settings === undefined) return null;
  return { pricesIncludeVat: settings.pricesIncludeVat };
}

export function NewQuotationPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.quotation.manage');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/quotations" label={t('quotations.back')} />
        <p className="text-body-sm text-ink-3">{t('quotations.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <QuotationForm quotation={null} today={today} pricesIncludeVat={ready.pricesIncludeVat} />
    </Suspense>
  );
}

export function QuotationPage() {
  const { t } = useLocale();
  const { quotationId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.quotation.manage');
  const today = useToday();
  const ready = useReady();
  // An open quotation is shown as sent; "Edit" turns the page into the form until it is saved
  const [editing, setEditing] = useState(false);
  const { data: quotation, isError } = useQuery({
    ...quotationQuery(useTenantId(), quotationId),
    enabled: quotationId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/quotations" label={t('quotations.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('quotations.title')}
          description={t('quotations.notFound')}
        />
      </div>
    );
  }
  if (!quotation || !ready) return null;
  if (editing && canWrite && quotation.status === 'open') {
    return (
      <Suspense fallback={null}>
        <QuotationForm
          key={`${quotation.id}-${String(quotation.version)}`}
          quotation={quotation}
          today={today}
          pricesIncludeVat={quotation.pricesIncludeVat}
          onClose={() => {
            setEditing(false);
          }}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <QuotationView
        quotation={quotation}
        today={today}
        onEdit={() => {
          setEditing(true);
        }}
      />
    </Suspense>
  );
}
