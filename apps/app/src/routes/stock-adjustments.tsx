import { PlusSignIcon, TaskEdit01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isAdjustmentDirection,
  isAdjustmentReason,
  STOCK_DOCUMENT_STATUSES,
  type StockAdjustmentSummary,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  AdjustmentStatusPill,
  useIsoDate,
  useTenantId,
  useWarehouses,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockAdjustmentsQuery } from '../lib/queries';

const column = dataTableColumns<StockAdjustmentSummary>();

type Show = StockDocumentStatus | 'all';

export function StockAdjustmentsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('inventory.stock.adjust');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockAdjustmentsQuery(useTenantId(), show === 'all' ? undefined : show),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('adjustments.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('adjustments.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor('warehouseId', {
          header: t('adjustments.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => byId.get(getValue())?.name ?? '—',
        }),
        column.accessor('reason', {
          header: t('adjustments.columns.reason'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => {
            const { direction, reason } = row.original;
            return (
              <span className="grid">
                <span>
                  {isAdjustmentReason(reason) ? t(`adjustments.reasons.${reason}`) : reason}
                </span>
                <span className="text-caption text-ink-3">
                  {isAdjustmentDirection(direction)
                    ? t(`adjustments.directions.${direction}`)
                    : direction}
                </span>
              </span>
            );
          },
        }),
        column.accessor('lineCount', {
          header: t('adjustments.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('adjustments.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('adjustments.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <AdjustmentStatusPill status={getValue()} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('adjustments.title')}
        description={t('adjustments.description')}
        actions={
          canWrite && (
            <Button onClick={() => void navigate({ to: '/stock/adjustments/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('adjustments.new')}
            </Button>
          )
        }
      />
      <SegmentedControl
        label={t('adjustments.show')}
        value={show}
        options={[
          { value: 'all', label: t('adjustments.all') },
          ...STOCK_DOCUMENT_STATUSES.map((value) => ({
            value,
            label: t(`adjustments.statuses.${value}`),
          })),
        ]}
        onChange={setShow}
      />
      {isError && <p className="text-body-sm text-crit">{t('adjustments.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('adjustments.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/stock/adjustments/$adjustmentId',
              params: { adjustmentId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={TaskEdit01Icon}
              title={t('adjustments.emptyTitle')}
              description={t('adjustments.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
