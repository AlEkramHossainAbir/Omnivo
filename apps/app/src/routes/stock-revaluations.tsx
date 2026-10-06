import { MoneyExchange01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { StockRevaluationSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DataTable, dataTableColumns, EmptyState, PageHeader } from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useIsoDate, useTenantId } from '../components/stock-parts';
import { stockRevaluationsQuery } from '../lib/queries';

const column = dataTableColumns<StockRevaluationSummary>();

// Every revaluation, newest first. The route needs inventory.stock.revalue (the API refuses the
// list without it), and the nav shows it only then.
export function StockRevaluationsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockRevaluationsQuery(useTenantId()),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('revaluations.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor('lineCount', {
          header: t('revaluations.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'subtitle' },
          cell: ({ getValue }) => t('revaluations.lineCount', { count: getValue() }),
        }),
        column.accessor('difference', {
          header: t('revaluations.columns.difference'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => (
            <span className="font-medium tabular-nums">{format.money(getValue())}</span>
          ),
        }),
      ]),
    [t, format, isoDate],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('revaluations.title')}
        description={t('revaluations.description')}
        actions={
          <Button onClick={() => void navigate({ to: '/stock/revaluations/new' })}>
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('revaluations.new')}
          </Button>
        }
      />
      {isError && <p className="text-body-sm text-crit">{t('revaluations.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('revaluations.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/stock/revaluations/$revaluationId',
              params: { revaluationId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={MoneyExchange01Icon}
              title={t('revaluations.emptyTitle')}
              description={t('revaluations.emptyBody')}
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
