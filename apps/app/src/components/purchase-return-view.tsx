import { NoteRemoveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isZeroQuantity, type PurchaseReturn, type PurchaseReturnLine } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, PageHeader } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';
import { debitStartOf } from '../lib/purchase-returns';
import { purchaseReturnReasonKey } from '../lib/returns';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PrintButton, PurchaseReturnPrint } from './print-documents';
import { PurchaseBackLink, SupplierLink } from './purchase-parts';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { DocumentStatusPill } from './sales-pills';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useQuantity, useWarehouses, warehouseLabel } from './stock-parts';

const LINK = 'font-medium text-brand underline-offset-3 hover:underline';

// A posted purchase return (or a draft for someone who may not write returns), read only, like the
// sales return of 15d. Each line says where it came from and whether a bill had billed it when the
// return was posted: a billed line, or a line on its own, needs a debit note to take its money off,
// which the notice and "Write debit note" offer until every such line is debited.
export function PurchaseReturnView({ purchaseReturn }: { purchaseReturn: PurchaseReturn }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  const canDebit = useCan()('purchase.debit_note.manage');
  const posted = purchaseReturn.status === 'posted';
  // The receipts by number: a line names its receipt by number, the page links it by id
  const receiptIds = new Map(purchaseReturn.receipts.map((ref) => [ref.number, ref.id]));
  const debitable = posted && debitStartOf(purchaseReturn) !== null;
  const warehouse = warehouseLabel(byId.get(purchaseReturn.warehouseId));

  const detail = (line: PurchaseReturnLine) => {
    const debited = !isZeroQuantity(line.debitedQuantity) && (
      <span className="tabular-nums">
        {t('purchaseReturns.lineDebited', {
          quantity: quantity(line.debitedQuantity, line.baseUnitId),
        })}
      </span>
    );
    if (line.receiptNumber === null) {
      return (
        <span className="mt-1 grid gap-0.5 text-caption text-ink-3">
          <span>{t('purchaseReturns.ownLine')}</span>
          {debited}
        </span>
      );
    }
    const receiptId = receiptIds.get(line.receiptNumber);
    return (
      <span className="mt-1 grid gap-0.5 text-caption text-ink-3">
        {receiptId === undefined ? (
          <span>{t('purchaseReturns.fromReceipt', { number: line.receiptNumber })}</span>
        ) : (
          <Link to="/goods-receipts/$receiptId" params={{ receiptId }} className={LINK}>
            {t('purchaseReturns.fromReceipt', { number: line.receiptNumber })}
          </Link>
        )}
        {/* Fixed when the return was posted; a draft has not looked yet */}
        {posted &&
          (line.billId !== null && line.billNumber !== null ? (
            <Link to="/bills/$billId" params={{ billId: line.billId }} className={LINK}>
              {t('purchaseReturns.lineBilled', { number: line.billNumber })}
            </Link>
          ) : (
            <span>{t('purchaseReturns.lineNotBilled')}</span>
          ))}
        {debited}
      </span>
    );
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-returns" label={t('purchaseReturns.back')} />
      <PageHeader
        title={purchaseReturn.number ?? t('purchaseReturns.draftTitle')}
        description={purchaseReturn.supplier.name}
        actions={
          <>
            <DocumentStatusPill
              status={purchaseReturn.status}
              label={t(`purchaseReturns.statuses.${purchaseReturn.status}`)}
            />
            {posted && <PrintButton />}
          </>
        }
      />
      {debitable && (
        <DocumentNotice tone="neutral">{t('purchaseReturns.debitNotice')}</DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('purchaseReturns.supplier')}
          </span>
          <span className="text-body-sm">
            <SupplierLink supplier={purchaseReturn.supplier} />
          </span>
        </div>
        <Fact label={t('purchaseReturns.date')} value={isoDate(purchaseReturn.date)} />
        <Fact
          label={t('purchaseReturns.reason')}
          value={t(purchaseReturnReasonKey(purchaseReturn.reason))}
        />
        <Fact label={t('purchaseReturns.warehouse')} value={warehouse} />
        {purchaseReturn.postedAt !== null && (
          <Fact
            label={t('purchaseReturns.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('purchaseReturns.postedOn', {
              date: format.date(new Date(purchaseReturn.postedAt)),
            })}
          />
        )}
        {posted && (
          <EntryLinks
            label={t('purchaseReturns.entry')}
            entries={purchaseReturn.entry ? [purchaseReturn.entry] : []}
            none={t('purchaseReturns.noEntry')}
          />
        )}
        {purchaseReturn.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('purchaseReturns.note')} value={purchaseReturn.note} />
          </div>
        )}
      </Card>
      <StockLinesTable lines={purchaseReturn.lines} detail={detail} />

      {posted && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {purchaseReturn.receipts.length > 0 && (
            <LinkList
              title={t('purchaseReturns.receiptsTitle')}
              subtitle={t('purchaseReturns.receiptsSubtitle')}
            >
              {purchaseReturn.receipts.map((receipt) => (
                <li key={receipt.id}>
                  <Link
                    to="/goods-receipts/$receiptId"
                    params={{ receiptId: receipt.id }}
                    className={LINK_ROW}
                  >
                    <span className={LINK_NUMBER}>{receipt.number ?? ''}</span>
                  </Link>
                </li>
              ))}
            </LinkList>
          )}
          {/* Drafts too (17d.1), so nobody writes a second debit note by mistake */}
          <LinkList
            title={t('purchaseReturns.debitNotesTitle')}
            subtitle={t('purchaseReturns.debitNotesSubtitle')}
            empty={
              purchaseReturn.debitNotes.length === 0 ? t('purchaseReturns.noDebitNotes') : undefined
            }
          >
            {purchaseReturn.debitNotes.map((note) => (
              <li key={note.id}>
                <Link
                  to="/debit-notes/$debitNoteId"
                  params={{ debitNoteId: note.id }}
                  className={LINK_ROW}
                >
                  <span className={LINK_NUMBER}>
                    {note.number ?? t('debitNotes.statuses.draft')}
                  </span>
                </Link>
              </li>
            ))}
          </LinkList>
        </div>
      )}

      {debitable && canDebit && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              void navigate({ to: '/debit-notes/new', search: { returnId: purchaseReturn.id } })
            }
          >
            <HugeiconsIcon icon={NoteRemoveIcon} size={17} strokeWidth={1.5} />
            {t('purchaseReturns.makeDebitNote')}
          </Button>
        </div>
      )}
      {posted && <PurchaseReturnPrint purchaseReturn={purchaseReturn} warehouse={warehouse} />}
    </div>
  );
}
