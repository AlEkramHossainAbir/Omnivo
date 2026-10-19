import { type GoodsReceipt, isZeroQuantity } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PurchaseBackLink, SupplierLink } from './purchase-parts';
import { GoodsReceiptStatusPill } from './purchase-pills';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useQuantity, useWarehouses, warehouseLabel } from './stock-parts';

// A posted goods receipt (or a draft for someone who may not write receipts), read only, like a
// posted delivery. A posted receipt never changes: goods that go back to the supplier after it are
// a purchase return (17d).
export function GoodsReceiptView({ receipt }: { receipt: GoodsReceipt }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <PageHeader
        title={receipt.number ?? t('goodsReceipts.draftTitle')}
        description={receipt.supplier.name}
        actions={<GoodsReceiptStatusPill status={receipt.status} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('goodsReceipts.supplier')}</span>
          <span className="text-body-sm">
            <SupplierLink supplier={receipt.supplier} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('goodsReceipts.order')}</span>
          <Link
            to="/purchase-orders/$orderId"
            params={{ orderId: receipt.order.id }}
            className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
          >
            {receipt.order.number ?? t('purchaseOrders.statuses.draft')}
          </Link>
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
        detail={(line) =>
          isZeroQuantity(line.rejectedQuantity) ? null : (
            <span className="mt-1 block text-caption text-ink-3 tabular-nums">
              {t('goodsReceipts.rejected')}: {quantity(line.rejectedQuantity, line.unitId)}
              {line.rejectionReason !== null && ` · ${line.rejectionReason}`}
            </span>
          )
        }
      />
    </div>
  );
}
