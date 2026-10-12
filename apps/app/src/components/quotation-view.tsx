import { Delete02Icon, PencilEdit02Icon, ShoppingCart01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Quotation, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, FormAlert, PageHeader, toast } from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { isExpired } from '../lib/sales';
import { Fact } from './adjustment-view';
import { failureOf } from './journal-parts';
import { PrintButton, QuotationPrint } from './print-documents';
import { SalesLinesTable } from './sales-lines-table';
import { CustomerLink, DocumentNotice, SalesBackLink, useSalesRefresh } from './sales-parts';
import { QuotationStatusPill } from './sales-pills';
import { useIsoDate } from './stock-parts';

// A quotation as the customer got it, with what can be done with it next: make the order, change
// it, mark it declined or delete it while it is open; open it again once declined.
export function QuotationView({
  quotation,
  today,
  onEdit,
}: {
  quotation: Quotation;
  today: string;
  onEdit: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const refresh = useSalesRefresh();
  const can = useCan();
  const canWrite = can('sales.quotation.manage');
  const canOrder = can('sales.order.manage');
  const [confirming, setConfirming] = useState(false);
  const open = quotation.status === 'open';
  const { version } = quotation;

  const decline = useMutation({
    mutationFn: () =>
      call(routes.quotations.decline, { params: { id: quotation.id }, body: { version } }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('quotations.declined', { number: saved.number }));
    },
  });
  const reopen = useMutation({
    mutationFn: () =>
      call(routes.quotations.reopen, { params: { id: quotation.id }, body: { version } }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('quotations.reopened', { number: saved.number }));
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.quotations.remove, { params: { id: quotation.id }, query: { version } }),
    onSuccess: async () => {
      await refresh();
      toast(t('quotations.deleted', { number: quotation.number }));
      void navigate({ to: '/quotations' });
    },
  });
  const failure = failureOf(decline.error) ?? failureOf(reopen.error) ?? failureOf(remove.error);
  const busy = decline.isPending || reopen.isPending || remove.isPending;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/quotations" label={t('quotations.back')} />
      <PageHeader
        title={quotation.number}
        description={quotation.customer.name}
        actions={
          <>
            <QuotationStatusPill quotation={quotation} today={today} />
            <PrintButton />
          </>
        }
      />
      {failure && <FormAlert message={failure} />}
      {isExpired(quotation, today) && quotation.validUntil !== null && (
        <DocumentNotice tone="warn">
          {t('quotations.expiredNotice', { date: isoDate(quotation.validUntil) })}
        </DocumentNotice>
      )}
      {quotation.status === 'declined' && (
        <DocumentNotice tone="neutral">{t('quotations.declinedNotice')}</DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('quotations.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={quotation.customer} />
          </span>
        </div>
        <Fact label={t('quotations.date')} value={isoDate(quotation.date)} />
        <Fact
          label={t('quotations.validUntil')}
          value={
            quotation.validUntil === null
              ? t('quotations.noEndDate')
              : isoDate(quotation.validUntil)
          }
        />
        {quotation.order !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('quotations.statuses.accepted')}
            </span>
            <Link
              to="/sales-orders/$orderId"
              params={{ orderId: quotation.order.id }}
              className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
            >
              {quotation.order.number === null
                ? t('quotations.acceptedOnDraft')
                : t('quotations.acceptedOn', { number: quotation.order.number })}
            </Link>
          </div>
        )}
        {quotation.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('quotations.note')} value={quotation.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={quotation.lines}
        totals={quotation}
        pricesIncludeVat={quotation.pricesIncludeVat}
      />

      {canWrite && open && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Left, away from the rest. Two clicks: a deleted quotation cannot come back. */}
          <div className="mr-auto flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (confirming) remove.mutate();
                else setConfirming(true);
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
              {confirming
                ? t('quotations.confirmDelete', { number: quotation.number })
                : t('quotations.delete')}
            </Button>
            {confirming && (
              <span className="text-body-sm text-ink-2">{t('quotations.deleteWarning')}</span>
            )}
          </div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              decline.mutate();
            }}
          >
            {t('quotations.decline')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onEdit}>
            <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
            {t('quotations.edit')}
          </Button>
          {canOrder && (
            <Button
              disabled={busy}
              onClick={() =>
                void navigate({
                  to: '/sales-orders/new',
                  search: { quotationId: quotation.id },
                })
              }
            >
              <HugeiconsIcon icon={ShoppingCart01Icon} size={17} strokeWidth={1.5} />
              {t('quotations.makeOrder')}
            </Button>
          )}
        </div>
      )}
      {canWrite && quotation.status === 'declined' && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              reopen.mutate();
            }}
          >
            {t('quotations.reopen')}
          </Button>
        </div>
      )}
      <QuotationPrint quotation={quotation} />
    </div>
  );
}
