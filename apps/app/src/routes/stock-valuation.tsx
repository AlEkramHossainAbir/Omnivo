import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  MoneyExchange01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { absMoney, isZeroMoney, sumMoney, type StockValue } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  KpiStrip,
  PageHeader,
  Pill,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { useQuantity, useTenantId, VariantCell } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import {
  accountsQuery,
  productCategoriesQuery,
  stockValuationQuery,
  valuationSummaryQuery,
} from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';

const column = dataTableColumns<StockValue>();

// What the stock is worth (step 14): the total in the warehouses and on the road, each variant at
// its average cost, and the check that matters to an accountant — the inventory and goods in
// transit accounts say the same. Every stock document posts both sides at once, so they agree;
// a difference means something reached those accounts another way (an opening balance from
// before step 14).
export function StockValuationPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const can = useCan();
  const quantity = useQuantity();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const settled = useDebounced(search.trim());
  const summary = useQuery(valuationSummaryQuery(tenantId)).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockValuationQuery(tenantId, { search: settled, categoryId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('valuation.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('quantity', {
          header: t('valuation.columns.quantity'),
          enableSorting: false,
          meta: { align: 'end', card: 'subtitle' },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {quantity(row.original.quantity, row.original.baseUnitId)}
            </span>
          ),
        }),
        column.accessor('unitCost', {
          header: t('valuation.columns.unitCost'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A unit price: with paisa (CLAUDE.md → Money)
          cell: ({ getValue }) => {
            const cost = getValue();
            return cost === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="tabular-nums">{format.money(cost, { decimals: 2 })}</span>
            );
          },
        }),
        column.accessor('value', {
          header: t('valuation.columns.value'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => (
            <span className="font-medium tabular-nums">{format.money(getValue())}</span>
          ),
        }),
      ]),
    [t, format, quantity],
  );

  const nameOf = (id: string | undefined) => {
    const account = accounts?.find((row) => row.id === id);
    return account ? `${account.code} ${account.name}` : t('valuation.noInTransitAccount');
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('valuation.title')}
        description={t('valuation.description')}
        actions={
          can('inventory.stock.revalue') && (
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: '/stock/revaluations/new' })}
            >
              <HugeiconsIcon icon={MoneyExchange01Icon} size={17} strokeWidth={1.5} />
              {t('valuation.revalue')}
            </Button>
          )
        }
      />
      {summary && (
        <>
          <KpiStrip
            cells={[
              { label: t('valuation.kpis.stock'), value: format.money(summary.stockValue) },
              { label: t('valuation.kpis.inTransit'), value: format.money(summary.inTransitValue) },
              {
                label: t('valuation.kpis.total'),
                value: format.money(sumMoney([summary.stockValue, summary.inTransitValue])),
              },
              {
                label: t('valuation.kpis.books'),
                value: format.money(
                  sumMoney([
                    summary.inventoryAccount?.balance ?? '0',
                    summary.inTransitAccount?.balance ?? '0',
                  ]),
                ),
                sub: t('valuation.booksHint', {
                  inventory: nameOf(summary.inventoryAccount?.id),
                  inTransit: nameOf(summary.inTransitAccount?.id),
                }),
              },
            ]}
          />
          <div>
            {isZeroMoney(summary.difference) ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('valuation.booksAgree')}
              </Pill>
            ) : (
              <Pill tone="crit" icon={Alert02Icon}>
                {t('valuation.booksOutBy', {
                  amount: format.money(absMoney(summary.difference), { decimals: 2 }),
                })}
              </Pill>
            )}
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('valuation.searchLabel')}
            placeholder={t('valuation.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="w-full sm:w-56">
          <Select
            aria-label={t('valuation.category')}
            value={categoryId}
            options={[
              { value: '', label: t('valuation.allCategories') },
              ...categoryOptions(categories ?? []),
            ]}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          />
        </div>
      </div>
      {isError && <p className="text-body-sm text-crit">{t('valuation.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('valuation.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.variantId}
          onRowClick={(row) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: row.variantId } })
          }
          onEndReached={loadMore}
          empty={
            settled === '' ? (
              <EmptyState
                icon={Coins01Icon}
                title={t('valuation.emptyTitle')}
                description={t('valuation.emptyBody')}
              />
            ) : (
              <EmptyState
                icon={Search01Icon}
                title={t('valuation.noMatchTitle', { query: settled })}
                description={t('valuation.noMatchBody')}
              />
            )
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
