import { ArrowDataTransferHorizontalIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type StockTransferSummary,
  TRANSFER_STATUSES,
  type TransferStatus,
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
  TransferStatusPills,
  useIsoDate,
  useTenantId,
  useWarehouses,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockTransfersQuery } from '../lib/queries';

const column = dataTableColumns<StockTransferSummary>();

type Show = TransferStatus | 'all';

export function StockTransfersPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('inventory.stock.transfer');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockTransfersQuery(useTenantId(), show === 'all' ? undefined : show),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('transfers.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('transfers.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.sentOn)}
              </span>
            </span>
          ),
        }),
        column.accessor('fromWarehouseId', {
          header: t('transfers.columns.route'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            `${byId.get(row.original.fromWarehouseId)?.code ?? '—'} → ${byId.get(row.original.toWarehouseId)?.code ?? '—'}`,
        }),
        column.accessor('lineCount', {
          header: t('transfers.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('adjustments.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('transfers.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <TransferStatusPills transfer={row.original} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('transfers.title')}
        description={t('transfers.description')}
        actions={
          canWrite && (
            <Button onClick={() => void navigate({ to: '/stock/transfers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('transfers.new')}
            </Button>
          )
        }
      />
      <SegmentedControl
        label={t('transfers.show')}
        value={show}
        options={[
          { value: 'all', label: t('transfers.all') },
          ...TRANSFER_STATUSES.map((value) => ({ value, label: t(`transfers.statuses.${value}`) })),
        ]}
        onChange={setShow}
      />
      {isError && <p className="text-body-sm text-crit">{t('transfers.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('transfers.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/stock/transfers/$transferId', params: { transferId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ArrowDataTransferHorizontalIcon}
              title={t('transfers.emptyTitle')}
              description={t('transfers.emptyBody')}
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
