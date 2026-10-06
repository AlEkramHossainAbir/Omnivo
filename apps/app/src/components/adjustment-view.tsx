import { isAdjustmentDirection, isAdjustmentReason, type StockAdjustment } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';

import { EntryLinks } from './entry-links';
import { StockLinesTable } from './stock-lines-table';
import {
  AdjustmentStatusPill,
  BackLink,
  useIsoDate,
  useWarehouses,
  warehouseLabel,
} from './stock-parts';

// A posted adjustment, read only: it never changes. A mistake is put right with another one.
export function AdjustmentView({ adjustment }: { adjustment: StockAdjustment }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const direction = isAdjustmentDirection(adjustment.direction)
    ? t(`adjustments.directions.${adjustment.direction}`)
    : adjustment.direction;
  const reason = isAdjustmentReason(adjustment.reason)
    ? t(`adjustments.reasons.${adjustment.reason}`)
    : adjustment.reason;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
      <PageHeader
        title={adjustment.number ?? t('adjustments.draftTitle')}
        description={`${direction} · ${reason}`}
        actions={<AdjustmentStatusPill status={adjustment.status} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('adjustments.date')} value={isoDate(adjustment.date)} />
        <Fact
          label={t('adjustments.warehouse')}
          value={warehouseLabel(byId.get(adjustment.warehouseId))}
        />
        {adjustment.note !== null && <Fact label={t('adjustments.note')} value={adjustment.note} />}
        {adjustment.status === 'posted' && (
          <EntryLinks
            label={t('adjustments.entry')}
            entries={adjustment.entry ? [adjustment.entry] : []}
            none={t('adjustments.noEntry')}
          />
        )}
      </Card>
      <StockLinesTable lines={adjustment.lines} />
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-caption font-medium text-ink-3">{label}</span>
      <span className="text-body-sm text-ink">{value}</span>
    </div>
  );
}
