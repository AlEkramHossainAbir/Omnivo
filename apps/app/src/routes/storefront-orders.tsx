import { Search01Icon, ShoppingBag01Icon } from '@hugeicons/core-free-icons';
import {
  STOREFRONT_ORDER_VIEWS,
  type StorefrontOrderSort,
  type StorefrontOrderSummary,
  type StorefrontOrderView,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
import { StorefrontOffline, useShopMoney, ViewShopLink } from '../components/storefront-parts';
import { useCan } from '../lib/permissions';
import { storefrontSetupQuery } from '../lib/storefront';
import { type OrderFilter, storefrontOrdersQuery } from '../lib/storefront-orders';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 27b: the shop's orders (decision 10), a page at a time by tab, searched and sorted on the
// server like the catalog. The tab is in the address (?view=packed), so the browser's Back from an
// order returns to the tab it was opened from. A row opens the order's page.

const column = dataTableColumns<StorefrontOrderSummary>();

// Confirmed and Total sort both ways; the newest confirmed first is the contract's default
const DEFAULT_SORT: SortingState = [{ id: 'confirmedAt', desc: true }];

function sortOf(state: SortingState): StorefrontOrderSort {
  const first = state[0];
  if (first?.id === 'total') return first.desc ? '-total' : 'total';
  return first?.desc === false ? 'confirmed' : '-confirmed';
}

export function StorefrontOrdersPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const navigate = useNavigate();
  const money = useShopMoney();
  const can = useCan();
  const { view = 'confirmed' } = useSearch({ strict: false });
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 300);
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORT);

  // "View shop" needs the shop's address, which only storefront.manage may read: a packer with
  // storefront.order.read alone has no button, and no refused request either
  const setup = useQuery({
    ...storefrontSetupQuery(tenantId),
    enabled: online && can('storefront.manage'),
  });
  const shop = setup.data?.shop ?? null;
  const filter: OrderFilter = { view, search: settled, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontOrdersQuery(tenantId, filter),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setView = useCallback(
    (next: StorefrontOrderView) => {
      // The default tab has no ?view=, so the sidebar's link and this tab are one address
      void navigate({
        to: '/storefront/orders',
        search: next === 'confirmed' ? {} : { view: next },
        replace: true,
      });
    },
    [navigate],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('orderNo', {
          header: t('storefront.orders.columns.order'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* Order numbers are Geist Mono, as on the shop's own pages */}
              <span className="font-mono font-medium whitespace-nowrap text-ink">
                {row.original.orderNo}
              </span>
              <span className="text-caption text-ink-3">
                {t('storefront.orders.items', {
                  count: row.original.itemCount,
                  formatted: format.number(row.original.itemCount),
                })}
              </span>
            </span>
          ),
        }),
        column.accessor('confirmedAt', {
          header: t('storefront.orders.columns.confirmed'),
          meta: { card: 'detail' },
          // The time too: a shop takes many orders a day, and the packer works oldest first
          cell: ({ getValue }) => (
            <span className="whitespace-nowrap text-ink-2 tabular-nums">
              {format.dateTime(new Date(getValue()), timeZone)}
            </span>
          ),
        }),
        column.accessor('customerName', {
          header: t('storefront.orders.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0">
              <span className="truncate font-medium text-ink">{row.original.customerName}</span>
              <span className="text-caption text-ink-3 tabular-nums">{row.original.phone}</span>
            </span>
          ),
        }),
        column.accessor('zoneName', {
          header: t('storefront.orders.columns.zone'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="text-ink-2">{getValue()}</span>,
        }),
        column.accessor('paymentMethod', {
          header: t('storefront.orders.columns.payment'),
          enableSorting: false,
          // No meta.card, so not on a phone's card (the user's choice in 27b.7). Step 27d: the
          // list's own words, "Paid online", since an online order is only listed once it is paid
          cell: ({ getValue }) => (
            <span className="text-ink-2">{t(`storefront.orderPayments.${getValue()}`)}</span>
          ),
        }),
        column.accessor('total', {
          header: t('storefront.orders.columns.total'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium">{money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('storefront.orders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => (
            <span className="inline-flex flex-wrap justify-end gap-1.5 min-[860px]:justify-start">
              <OrderStatusPill status={row.original.status} />
              {row.original.needsAttention && <NeedsAttentionPill />}
            </span>
          ),
        }),
      ]),
    [t, format, money, timeZone],
  );

  const viewOptions = STOREFRONT_ORDER_VIEWS.map((value) => ({
    value,
    label: t(`storefront.orders.views.${value}`),
  }));

  // Decision 38: why the table is empty, in the order that explains it best. A search that found
  // nothing; the All tab with nothing in it, which is a shop with no orders at all; another tab
  // with nothing waiting
  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('storefront.orders.noMatchTitle')}
        description={t('storefront.orders.noMatchBody')}
        action={
          view !== 'all' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setView('all');
              }}
            >
              {t('storefront.orders.searchAll')}
            </Button>
          )
        }
      />
    ) : view === 'all' ? (
      <EmptyState
        icon={ShoppingBag01Icon}
        title={t('storefront.orders.emptyTitle')}
        description={t('storefront.orders.emptyBody')}
      />
    ) : (
      <EmptyState
        icon={ShoppingBag01Icon}
        title={t('storefront.orders.viewEmptyTitle')}
        description={t(`storefront.orders.viewEmpty.${view}`)}
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.orders.title')}
        description={t('storefront.orders.description')}
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
              <Input
                type="search"
                icon={Search01Icon}
                aria-label={t('storefront.orders.searchLabel')}
                placeholder={t('storefront.orders.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <SegmentedControl
              label={t('storefront.orders.view')}
              value={view}
              options={viewOptions}
              onChange={setView}
            />
          </div>
          {isError && (
            <p role="alert" className="text-body-sm text-crit">
              {t('storefront.orders.loadFailed')}
            </p>
          )}
          {rows && (
            <DataTable
              label={t('storefront.orders.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              sorting={{ state: sorting, onChange: setSorting }}
              onRowClick={(row) =>
                void navigate({
                  to: '/storefront/orders/$orderId',
                  params: { orderId: row.id },
                })
              }
              onEndReached={loadMore}
              empty={empty}
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}
