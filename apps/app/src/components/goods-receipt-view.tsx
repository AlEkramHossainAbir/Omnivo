import { Invoice03Icon, TruckReturnIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type GoodsReceipt, isZeroQuantity } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, PageHeader } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';

import { receiptLinesLeft } from '../lib/bills';
import { useCan } from '../lib/permissions';
import { returnableReceiptLines } from '../lib/purchase-returns';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PurchaseBackLink, SupplierLink } from './purchase-parts';
import {
  GoodsReceiptBillPill,
  GoodsReceiptReturnPill,
  GoodsReceiptStatusPill,
} from './purchase-pills';
import { DocumentNotice, LINK_NUMBER, LINK_ROW, LinkList } from './sales-parts';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useQuantity, useWarehouses, warehouseLabel } from './stock-parts';

const DOCUMENT_LINK =
  'font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline';

// A posted goods receipt (or a draft for someone who may not write receipts), read only, like a
// posted delivery. A posted receipt never changes: goods that go back to the supplier after it are
// a purchase return (17d). Step 17c: how much of it is billed, its bills, and "Make bill"; and a
// receipt a supplier bill made, which has no order (decision 21). Step 17d: how much of it went
// back, its returns, and "Send goods back".
export function GoodsReceiptView({ receipt }: { receipt: GoodsReceipt }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  const can = useCan();
  const canBill = can('purchase.bill.manage');
  const canReturn = can('purchase.return.manage');
  const posted = receipt.status === 'posted';
  // Lines the bill form would take: accepted something, not billed. A receipt that turned
  // everything back has none (decision 43), and one a bill made was billed by that bill.
  const toBill = posted && receiptLinesLeft(receipt.lines, new Set()).length > 0;
  // Step 17d: something kept that can still go back (a receipt a bill made too: its goods came in)
  const toReturn = posted && returnableReceiptLines(receipt.lines, new Set()).length > 0;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <PageHeader
        title={receipt.number ?? t('goodsReceipts.draftTitle')}
        description={receipt.supplier.name}
        actions={
          <>
            <GoodsReceiptStatusPill status={receipt.status} />
            {posted && <GoodsReceiptBillPill state={receipt.billState} />}
            {posted && <GoodsReceiptReturnPill state={receipt.returnState} />}
          </>
        }
      />
      {/* Bought without an order: a store keeper who finds it should not think one was skipped */}
      {receipt.bill !== null && (
        <DocumentNotice tone="neutral">
          {t('goodsReceipts.billMadeNotice', { number: receipt.bill.number ?? '' })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('goodsReceipts.supplier')}</span>
          <span className="text-body-sm">
            <SupplierLink supplier={receipt.supplier} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('goodsReceipts.order')}</span>
          {receipt.order !== null ? (
            <Link
              to="/purchase-orders/$orderId"
              params={{ orderId: receipt.order.id }}
              className={DOCUMENT_LINK}
            >
              {receipt.order.number ?? t('purchaseOrders.statuses.draft')}
            </Link>
          ) : receipt.bill !== null ? (
            <Link
              to="/bills/$billId"
              params={{ billId: receipt.bill.id }}
              className={DOCUMENT_LINK}
            >
              {t('goodsReceipts.fromBill', { number: receipt.bill.number ?? '' })}
            </Link>
          ) : (
            <span className="text-body-sm text-ink-2">{t('goodsReceipts.noOrder')}</span>
          )}
        </div>
        <Fact label={t('goodsReceipts.date')} value={isoDate(receipt.date)} />
        <Fact
          label={t('goodsReceipts.warehouse')}
          value={warehouseLabel(byId.get(receipt.warehouseId))}
        />
        {receipt.supplierChallan !== null && (
          <Fact label={t('goodsReceipts.supplierChallan')} value={receipt.supplierChallan} />
        )}
        {receipt.vehicle !== null && (
          <Fact label={t('goodsReceipts.vehicle')} value={receipt.vehicle} />
        )}
        {receipt.postedAt !== null && (
          <Fact
            label={t('goodsReceipts.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('goodsReceipts.postedOn', { date: format.date(new Date(receipt.postedAt)) })}
          />
        )}
        {receipt.status === 'posted' && (
          <EntryLinks
            label={t('goodsReceipts.entry')}
            entries={receipt.entry ? [receipt.entry] : []}
            none={t('goodsReceipts.noEntry')}
          />
        )}
        {receipt.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('goodsReceipts.note')} value={receipt.note} />
          </div>
        )}
      </Card>
      {/* The quantity is what was accepted (decision 20); what the gate turned back, and why,
          is under the line, in the line's unit */}
      <StockLinesTable
        lines={receipt.lines}
        detail={(line) => (
          <>
            {!isZeroQuantity(line.rejectedQuantity) && (
              <span className="mt-1 block text-caption text-ink-3 tabular-nums">
                {t('goodsReceipts.rejected')}: {quantity(line.rejectedQuantity, line.unitId)}
                {line.rejectionReason !== null && ` · ${line.rejectionReason}`}
              </span>
            )}
            {/* Step 17c: a posted bill bills it (decision 29) */}
            {line.billed && (
              <span className="mt-1 block text-caption text-ink-3">
                {t('goodsReceipts.lineBilled')}
              </span>
            )}
            {/* Step 17d: what posted purchase returns sent back, in the base unit */}
            {!isZeroQuantity(line.returnedQuantity) && (
              <span className="mt-1 block text-caption text-ink-3 tabular-nums">
                {t('goodsReceipts.lineReturned', {
                  quantity: quantity(line.returnedQuantity, line.baseUnitId),
                })}
              </span>
            )}
          </>
        )}
      />
      {posted && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <LinkList
            title={t('goodsReceipts.billsTitle')}
            subtitle={t('goodsReceipts.billsSubtitle')}
            empty={receipt.bills.length === 0 ? t('goodsReceipts.notBilledYet') : undefined}
          >
            {receipt.bills.map((bill) => (
              <li key={bill.id}>
                <Link to="/bills/$billId" params={{ billId: bill.id }} className={LINK_ROW}>
                  <span className={LINK_NUMBER}>{bill.number ?? ''}</span>
                </Link>
              </li>
            ))}
          </LinkList>
          {/* Step 17d: the posted returns that sent goods of it back; none shows no card */}
          {receipt.returns.length > 0 && (
            <LinkList
              title={t('goodsReceipts.returnsTitle')}
              subtitle={t('goodsReceipts.returnsSubtitle')}
            >
              {receipt.returns.map((purchaseReturn) => (
                <li key={purchaseReturn.id}>
                  <Link
                    to="/purchase-returns/$returnId"
                    params={{ returnId: purchaseReturn.id }}
                    className={LINK_ROW}
                  >
                    <span className={LINK_NUMBER}>{purchaseReturn.number ?? ''}</span>
                  </Link>
                </li>
              ))}
            </LinkList>
          )}
        </div>
      )}
      {((canBill && toBill) || (canReturn && toReturn)) && (
        <div className="flex flex-wrap justify-end gap-2">
          {canReturn && toReturn && (
            <Button
              variant="secondary"
              onClick={() =>
                void navigate({
                  to: '/purchase-returns/new',
                  search: { receiptId: receipt.id },
                })
              }
            >
              <HugeiconsIcon icon={TruckReturnIcon} size={17} strokeWidth={1.5} />
              {t('goodsReceipts.makeReturn')}
            </Button>
          )}
          {canBill && toBill && (
            <Button
              onClick={() => void navigate({ to: '/bills/new', search: { receiptId: receipt.id } })}
            >
              <HugeiconsIcon icon={Invoice03Icon} size={17} strokeWidth={1.5} />
              {t('goodsReceipts.makeBill')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
