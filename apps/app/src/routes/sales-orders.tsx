import {
  PlusSignIcon,
  ShoppingCart01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ORDER_STATUSES, type OrderStatus, type SalesOrderSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { type OutboxEntry, outboxEntries, type SyncDatabase } from '@omnivo/sync';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SectionHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { CustomerFilter } from '../components/customer-filter';
import { OrderStatusPills } from '../components/sales-pills';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { NotSyncedPill, OutboxStatusPill } from '../components/sync-parts';
import { useLocalDb, useLocalQuery } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { salesOrdersQuery } from '../lib/queries';
import { useOnline } from '../lib/use-online';

const column = dataTableColumns<SalesOrderSummary>();

// Step 18b (decision 3): the drafts written on this device that the server does not have yet, read
// from the outbox, online and offline. Opening one opens its waiting command in the form.
interface UnsyncedOrder {
  id: string;
  entry: OutboxEntry;
  date: string;
}

const unsyncedColumn = dataTableColumns<UnsyncedOrder>();

// A stable read (useLocalQuery): the outbox's orders, oldest first
const readUnsynced = async (db: SyncDatabase) =>
  (await outboxEntries(db)).flatMap((entry): UnsyncedOrder[] =>
    entry.command.type === 'sales_order.create_draft'
      ? [{ id: entry.key, entry, date: entry.command.input.date }]
      : [],
  );

function UnsyncedOrders() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const db = useLocalDb();
  const rows = useLocalQuery(db ? readUnsynced : null);
  const columns = useMemo(
    () =>
      unsyncedColumn.columns([
        unsyncedColumn.accessor('date', {
          id: 'number',
          header: t('salesOrders.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-medium text-ink-3">{t('sync.noNumberYet')}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        unsyncedColumn.accessor((order) => order.entry.name, {
          id: 'customer',
          header: t('salesOrders.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => (
            <span className="block max-w-[18rem] truncate">{getValue()}</span>
          ),
        }),
        unsyncedColumn.accessor((order) => order.entry.total ?? '0', {
          id: 'total',
          header: t('salesOrders.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => format.money(getValue()),
        }),
        unsyncedColumn.accessor((order) => order.entry.status, {
          id: 'status',
          header: t('salesOrders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          // A refused draft says so; one that only waits is "Not synced"
          cell: ({ getValue }) => {
            const status = getValue();
            return status === 'failed' ? <OutboxStatusPill status={status} /> : <NotSyncedPill />;
          },
        }),
      ]),
    [t, format, isoDate],
  );
  if (!rows || rows.length === 0) return null;
  return (
    <section className="grid grid-cols-1 gap-3">
      <SectionHeader title={t('sync.unsyncedTitle')} subtitle={t('sync.unsyncedSubtitle')} />
      <DataTable
        label={t('sync.unsyncedTitle')}
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        onRowClick={(row) =>
          void navigate({ to: '/sales-orders/$orderId', params: { orderId: row.id } })
        }
      />
    </section>
  );
}

export function SalesOrdersPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.order.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const online = useOnline();
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    salesOrdersQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('salesOrders.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('salesOrders.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((order) => order.customer.name, {
          id: 'customer',
          header: t('salesOrders.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              {/* The buyer's PO number is how the customer asks about the order */}
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customerReference ?? row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('deliveryDate', {
          header: t('salesOrders.columns.deliveryDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = getValue();
            return date === null ? '—' : isoDate(date);
          },
        }),
        column.accessor('total', {
          header: t('salesOrders.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka (CLAUDE.md → Money); the order's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor('status', {
          header: t('salesOrders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <OrderStatusPills order={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/sales-orders/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('salesOrders.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('salesOrders.title')}
        description={t('salesOrders.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerFilter
            id="orders-customer"
            aria-label={t('salesOrders.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('salesOrders.show')}
          value={status}
          options={[
            { value: '', label: t('salesOrders.all') },
            ...ORDER_STATUSES.map((value) => ({
              value,
              label: t(`salesOrders.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      <UnsyncedOrders />
      {isError && <p className="text-body-sm text-crit">{t('salesOrders.loadFailed')}</p>}
      {/* The server's list offline: what it showed a minute ago may be wrong by now */}
      {!online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('sync.ordersOffline')}
        />
      )}
      {online && rows && (
        <DataTable
          label={t('salesOrders.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/sales-orders/$orderId', params: { orderId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ShoppingCart01Icon}
              title={t('salesOrders.emptyTitle')}
              description={t('salesOrders.emptyBody')}
              action={write}
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
