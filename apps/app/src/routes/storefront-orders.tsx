import { Download04Icon, Search01Icon, ShoppingBag01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  routes,
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
  toast,
  toIsoDate,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  NeedsAttentionPill,
  OrderStatusPill,
  ParcelWaitPill,
} from '../components/storefront-order-pills';
import { StorefrontOffline, useShopMoney, ViewShopLink } from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { storefrontSetupQuery } from '../lib/storefront';
import { courierCsv, type OrderFilter, storefrontOrdersQuery } from '../lib/storefront-orders';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 27b: the shop's orders (decision 10), a page at a time by tab, searched and sorted on the
// server like the catalog. The tab is in the address (?view=packed), so the browser's Back from an
// order returns to the tab it was opened from. A row opens the order's page.

const column = dataTableColumns<StorefrontOrderSummary>();

// A file the browser makes itself: a Blob, a hidden link, a click (the product import's template
// does the same)
function saveCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// Step 28a (decision 19): "Export for courier", for a shop that books on the courier's own panel.
// The packed orders with no parcel on its way, whatever tab is open (approved with the mockup), as
// a CSV in the courier's bulk-upload columns. An empty answer is a toast, never an empty file: a
// file with only a header uploads as nothing and looks like the courier's fault
function ExportButton() {
  const { t, format, errorText } = useLocale();
  const exporter = useMutation({
    mutationFn: () => call(routes.storefrontOrders.courierExport),
    onSuccess: ({ rows, more }) => {
      if (rows.length === 0) {
        toast(t('storefront.orders.exportEmpty'));
        return;
      }
      const items = (count: number) =>
        t('storefront.orders.items', { count, formatted: format.number(count) });
      // The local day in the name, so two exports of one day sort together
      saveCsv(`courier-orders-${toIsoDate(new Date())}.csv`, courierCsv(rows, items));
      const done = t('storefront.orders.exported', {
        count: rows.length,
        formatted: format.number(rows.length),
      });
      // One toast: a second would replace the first before it is read
      toast(more ? `${done}. ${t('storefront.orders.exportedMore')}` : done);
    },
    onError: (error) => {
      toast(errorText(error instanceof ApiRequestError ? error.code : 'unknown_error'));
    },
  });
  return (
    <Button
      variant="secondary"
      disabled={exporter.isPending}
      onClick={() => {
        exporter.mutate();
      }}
    >
      <HugeiconsIcon icon={Download04Icon} size={17} strokeWidth={1.5} />
      {exporter.isPending ? t('storefront.orders.exporting') : t('storefront.orders.exportCourier')}
    </Button>
  );
}

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
              {/* Step 28b: a shipped order that waits for the staff (partly delivered, coming
                  back), so the Shipped tab says which ones need the order's page */}
              <ParcelWaitPill
                status={row.original.status}
                parcelStatus={row.original.parcelStatus}
              />
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
        actions={
          <>
            {shop !== null && <ViewShopLink href={shop.shopUrl} />}
            {/* For booking, so .manage, like the route; online only, like the page */}
            {online && can('storefront.order.manage') && <ExportButton />}
          </>
        }
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
