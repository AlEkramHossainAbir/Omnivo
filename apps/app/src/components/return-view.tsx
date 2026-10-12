import { Invoice04Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isZeroQuantity, type SalesReturn, type SalesReturnLine } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, PageHeader } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';
import { firstCreditableInvoice, returnReasonKey } from '../lib/returns';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PrintButton, SalesReturnPrint } from './print-documents';
import {
  CustomerLink,
  DocumentNotice,
  LINK_NUMBER,
  LINK_ROW,
  LinkList,
  SalesBackLink,
} from './sales-parts';
import { DocumentStatusPill } from './sales-pills';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useQuantity, useWarehouses, warehouseLabel } from './stock-parts';

const LINK = 'font-medium text-brand underline-offset-3 hover:underline';

// A posted return (or a draft for someone who may not write returns), read only. A posted return
// never changes. Each line says where it came from, and whether the invoice had billed it when the
// return was posted: a billed line needs a credit note to give the money back, which the notice
// and "Write credit note" offer until every billed line is credited.
export function ReturnView({ salesReturn }: { salesReturn: SalesReturn }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  const canCredit = useCan()('sales.credit_note.manage');
  const posted = salesReturn.status === 'posted';
  // The challans by number: a line names its challan by number, the page links it by id
  const challanIds = new Map(salesReturn.deliveries.map((ref) => [ref.number, ref.id]));
  const creditable = posted && firstCreditableInvoice(salesReturn) !== null;
  const warehouse = warehouseLabel(byId.get(salesReturn.warehouseId));

  const detail = (line: SalesReturnLine) => {
    if (line.deliveryNumber === null) {
      return <span className="block text-caption text-ink-3">{t('salesReturns.ownLine')}</span>;
    }
    const challanId = challanIds.get(line.deliveryNumber);
    return (
      <span className="mt-1 grid gap-0.5 text-caption text-ink-3">
        {challanId === undefined ? (
          <span>{t('salesReturns.fromChallan', { number: line.deliveryNumber })}</span>
        ) : (
          <Link to="/deliveries/$deliveryId" params={{ deliveryId: challanId }} className={LINK}>
            {t('salesReturns.fromChallan', { number: line.deliveryNumber })}
          </Link>
        )}
        {/* Fixed when the return was posted; a draft has not looked yet */}
        {posted &&
          (line.invoiceId !== null && line.invoiceNumber !== null ? (
            <Link to="/invoices/$invoiceId" params={{ invoiceId: line.invoiceId }} className={LINK}>
              {t('salesReturns.lineBilled', { number: line.invoiceNumber })}
            </Link>
          ) : (
            <span>{t('salesReturns.lineNotBilled')}</span>
          ))}
        {!isZeroQuantity(line.creditedQuantity) && (
          <span className="tabular-nums">
            {t('salesReturns.lineCredited', {
              quantity: quantity(line.creditedQuantity, line.baseUnitId),
            })}
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-returns" label={t('salesReturns.back')} />
      <PageHeader
        title={salesReturn.number ?? t('salesReturns.draftTitle')}
        description={salesReturn.customer.name}
        actions={
          <>
            <DocumentStatusPill
              status={salesReturn.status}
              label={t(`salesReturns.statuses.${salesReturn.status}`)}
            />
            {posted && <PrintButton />}
          </>
        }
      />
      {creditable && (
        <DocumentNotice tone="neutral">{t('salesReturns.creditNotice')}</DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('salesReturns.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={salesReturn.customer} />
          </span>
        </div>
        <Fact label={t('salesReturns.date')} value={isoDate(salesReturn.date)} />
        <Fact label={t('salesReturns.reason')} value={t(returnReasonKey(salesReturn.reason))} />
        <Fact label={t('salesReturns.warehouse')} value={warehouse} />
        {salesReturn.postedAt !== null && (
          <Fact
            label={t('salesReturns.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('salesReturns.postedOn', {
              date: format.date(new Date(salesReturn.postedAt)),
            })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('salesReturns.entry')}
            entries={salesReturn.entry ? [salesReturn.entry] : []}
            none={t('salesReturns.noEntry')}
          />
        )}
        {salesReturn.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('salesReturns.note')} value={salesReturn.note} />
          </div>
        )}
      </Card>
      <StockLinesTable lines={salesReturn.lines} detail={detail} />

      {posted && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {salesReturn.deliveries.length > 0 && (
            <LinkList
              title={t('salesReturns.challansTitle')}
              subtitle={t('salesReturns.challansSubtitle')}
            >
              {salesReturn.deliveries.map((challan) => (
                <li key={challan.id}>
                  <Link
                    to="/deliveries/$deliveryId"
                    params={{ deliveryId: challan.id }}
                    className={LINK_ROW}
                  >
                    <span className={LINK_NUMBER}>{challan.number ?? ''}</span>
                  </Link>
                </li>
              ))}
            </LinkList>
          )}
          {/* Drafts too (15d.1), so nobody writes a second credit note by mistake */}
          <LinkList
            title={t('salesReturns.creditNotesTitle')}
            subtitle={t('salesReturns.creditNotesSubtitle')}
            empty={
              salesReturn.creditNotes.length === 0 ? t('salesReturns.noCreditNotes') : undefined
            }
          >
            {salesReturn.creditNotes.map((note) => (
              <li key={note.id}>
                <Link
                  to="/credit-notes/$creditNoteId"
                  params={{ creditNoteId: note.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>
                    {note.number ?? t('creditNotes.statuses.draft')}
                  </span>
                </Link>
              </li>
            ))}
          </LinkList>
        </div>
      )}

      {creditable && canCredit && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              void navigate({ to: '/credit-notes/new', search: { returnId: salesReturn.id } })
            }
          >
            <HugeiconsIcon icon={Invoice04Icon} size={17} strokeWidth={1.5} />
            {t('salesReturns.makeCreditNote')}
          </Button>
        </div>
      )}
      {posted && <SalesReturnPrint salesReturn={salesReturn} warehouse={warehouse} />}
    </div>
  );
}
