import { PlusSignIcon, TaskAdd01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  REQUISITION_ORDER_FILTERS,
  REQUISITION_STATUSES,
  type RequisitionOrderFilter,
  type RequisitionStatus,
  type RequisitionSummary,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { RequisitionOrderPill, RequisitionStatusPill } from '../components/purchase-pills';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { requisitionsQuery } from '../lib/queries';

const column = dataTableColumns<RequisitionSummary>();

// Step 17b: "To order" sits with the statuses: it is a kind of approved requisition, the buyer's
// queue (approved, with a line not ordered in full)
type Show = RequisitionStatus | RequisitionOrderFilter | 'all';

function isOrderFilter(show: Show): show is RequisitionOrderFilter {
  return REQUISITION_ORDER_FILTERS.some((filter) => filter === show);
}

// The purchase requisitions (step 17a), newest date first. Everyone reads them (a store keeper
// checks whether the yarn was asked for already); writing them needs purchase.requisition.manage.
export function RequisitionsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('purchase.requisition.manage');
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    requisitionsQuery(useTenantId(), {
      status: show === 'all' || isOrderFilter(show) ? '' : show,
      warehouseId,
      order: isOrderFilter(show) ? show : '',
    }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('requisitions.columns.number'),
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
        column.accessor('warehouseId', {
          header: t('requisitions.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('neededBy', {
          header: t('requisitions.columns.neededBy'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = getValue();
            return date === null ? '—' : <span className="tabular-nums">{isoDate(date)}</span>;
          },
        }),
        column.accessor((row) => row.requestedBy.name, {
          id: 'requestedBy',
          header: t('requisitions.columns.requestedBy'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        // Whole taka, like every list (CLAUDE.md → Money); the page shows the paisa
        column.accessor('amount', {
          header: t('requisitions.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('requisitions.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          // Step 17b: how much is ordered, beside the status
          cell: ({ row }) => (
            <span className="inline-flex flex-wrap gap-1.5">
              <RequisitionStatusPill status={row.original.status} />
              <RequisitionOrderPill state={row.original.orderState} />
            </span>
          ),
        }),
      ]),
    [t, format, isoDate, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('requisitions.title')}
        description={t('requisitions.description')}
        actions={
          canWrite && (
            <Button onClick={() => void navigate({ to: '/requisitions/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('requisitions.new')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('requisitions.warehouse')}
            options={[
              { value: '', label: t('requisitions.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('requisitions.show')}
          value={show}
          options={[
            { value: 'all', label: t('requisitions.all') },
            ...REQUISITION_STATUSES.map((value) => ({
              value,
              label: t(`requisitions.statuses.${value}`),
            })),
            ...REQUISITION_ORDER_FILTERS.map((value) => ({
              value,
              label: t(`requisitions.orderFilters.${value}`),
            })),
          ]}
          onChange={setShow}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('requisitions.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('requisitions.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/requisitions/$requisitionId',
              params: { requisitionId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={TaskAdd01Icon}
              title={t('requisitions.emptyTitle')}
              description={t('requisitions.emptyBody')}
              action={
                canWrite && (
                  <Button onClick={() => void navigate({ to: '/requisitions/new' })}>
                    <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                    {t('requisitions.new')}
                  </Button>
                )
              }
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
