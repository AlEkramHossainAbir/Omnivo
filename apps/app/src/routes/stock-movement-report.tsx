import { PackageMovingIcon } from '@hugeicons/core-free-icons';
import {
  isZeroMoney,
  STOCK_MOVEMENT_SHOWS,
  STOCK_MOVEMENT_SORTS,
  type StockMovementFilter,
  type StockMovementRow,
  type StockMovementShow,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import { Footnotes, LoadFailed, NameTile, NeedsConnection } from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { productCategoriesQuery, warehousesQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { sortingOf, sortOf, stockMovementQuery } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 21c: the stock movement report. One row per variant, in its base unit: what it opened with,
// what came in and went out, and what it closed with. The quantities never add up to a total (40
// pcs and 2.74 m are not one number), so the strip counts the products instead, and the values
// (with inventory.stock.value) are the only totals.

const column = dataTableColumns<StockMovementRow>();

// The four columns between opening and closing, in the contract's order
const MOVEMENT_COLUMNS = ['purchased', 'sold', 'transfers', 'adjusted'] as const;

export function StockMovementReportPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const can = useCan();
  const canRead = can('inventory.report.read');
  const online = useOnline();
  const period = usePeriod('this_month');
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [show, setShow] = useState<StockMovementShow>('moved');
  const [sorting, setSorting] = useState<SortingState>(sortingOf('name'));

  // Without the value permission the API refuses a value sort (its order would tell the hidden
  // number), so the page never asks for one
  const canSeeValue = can('inventory.stock.value');
  const sort = sortOf(
    sorting.filter((item) => canSeeValue || !['openingValue', 'closingValue'].includes(item.id)),
    STOCK_MOVEMENT_SORTS,
    'name',
  );
  const filter: StockMovementFilter = {
    from: period.range.from,
    to: period.range.to,
    show,
    sort,
    ...(warehouseId !== '' && { warehouseId }),
    ...(categoryId !== '' && { categoryId }),
  };

  const report = useInfiniteQuery({
    ...stockMovementQuery(tenantId, filter),
    enabled: canRead && online && period.valid,
  });
  const warehouses = useQuery({ ...warehousesQuery(tenantId, 'active'), enabled: canRead }).data;
  const categories = useQuery({ ...productCategoriesQuery(tenantId), enabled: canRead }).data;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // From the answer, not the permission: the columns are right even before the first rows
  const withValue = first?.withValue ?? false;

  const columns = useMemo(() => {
    // A quantity with its unit ("1,338 strip", "167.75 m"). Zero is a dash, like the aging: the
    // eye finds what moved.
    const quantity = (
      id: 'opening' | (typeof MOVEMENT_COLUMNS)[number] | 'closing',
      strong = false,
    ) =>
      column.accessor(id, {
        header: t(`reports.stockMovement.columns.${id}`),
        meta: { align: 'end', card: id === 'closing' ? 'trailing' : 'detail' },
        cell: ({ row, getValue }) => {
          const value = getValue();
          if (isZeroMoney(value)) return <span className="text-ink-3">—</span>;
          const { baseUnit } = row.original;
          return (
            <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
              {format.number(value, baseUnit.decimals)} {baseUnit.code}
            </span>
          );
        },
      });
    const value = (id: 'openingValue' | 'closingValue') =>
      column.accessor(id, {
        header: t(`reports.stockMovement.columns.${id}`),
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => {
          const amount = getValue();
          return amount === null || isZeroMoney(amount) ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className="text-ink-2">{format.money(amount)}</span>
          );
        },
      });
    return column.columns([
      column.accessor((row) => variantName(row), {
        id: 'name',
        header: t('reports.stockMovement.columns.product'),
        meta: { card: 'title' },
        cell: ({ row, getValue }) => {
          const name = getValue();
          // The stock card has every single movement behind the row's numbers
          return (
            <Link
              to="/stock/$variantId"
              params={{ variantId: row.original.variantId }}
              aria-label={t('reports.stockMovement.openCard', { name })}
              className="flex items-center gap-3 underline-offset-3 hover:underline"
            >
              <NameTile name={row.original.productName} />
              <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[18rem]">
                <span className="truncate font-medium text-ink">{name}</span>
                <span className="font-mono text-caption text-ink-3 tabular-nums">
                  {row.original.sku}
                </span>
              </span>
            </Link>
          );
        },
      }),
      quantity('opening'),
      ...MOVEMENT_COLUMNS.map((id) => quantity(id)),
      quantity('closing', true),
      ...(withValue ? [value('openingValue'), value('closingValue')] : []),
    ]);
  }, [t, format, withValue]);

  const warehouse = warehouses?.find((item) => item.id === warehouseId);
  const category = categories?.find((item) => item.id === categoryId);

  const header = (
    <PageHeader
      title={t('reports.stockMovement.title')}
      description={t('reports.stockMovement.description')}
      actions={
        canRead &&
        online &&
        period.valid && (
          <ExportMenu
            request={(exportFormat) => ({
              report: 'stock_movement',
              format: exportFormat,
              query: filter,
            })}
            names={{
              warehouse: warehouse && `${warehouse.code} · ${warehouse.name}`,
              category: category?.name,
            }}
          />
        )
      }
    />
  );

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'inventory.report.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
      {!online ? (
        <NeedsConnection />
      ) : (
        <>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3 xl:grid-cols-4">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
            <SelectField
              label={t('reports.stockMovement.warehouse')}
              value={warehouseId}
              options={[
                { value: '', label: t('reports.stockMovement.allWarehouses') },
                ...(warehouses ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.code} · ${item.name}`,
                })),
              ]}
              onChange={(event) => {
                setWarehouseId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.category')}
              value={categoryId}
              hint={categoryId === '' ? undefined : t('reports.categoryHint')}
              options={[
                { value: '', label: t('reports.allCategories') },
                ...categoryOptions(categories ?? []),
              ]}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.stockMovement.show')}
              value={show}
              options={STOCK_MOVEMENT_SHOWS.map((value) => ({
                value,
                label: t(`reports.stockMovement.shows.${value}`),
              }))}
              onChange={(event) => {
                const next = STOCK_MOVEMENT_SHOWS.find((value) => value === event.target.value);
                if (next) setShow(next);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={PackageMovingIcon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.stockMovement.kpis.variants'),
                      value: format.number(first.totals.variants),
                      sub: t('reports.stockMovement.kpiHints.variants'),
                    },
                    ...(withValue &&
                    first.totals.openingValue !== null &&
                    first.totals.closingValue !== null
                      ? [
                          {
                            label: t('reports.stockMovement.kpis.openingValue'),
                            value: format.money(first.totals.openingValue),
                          },
                          {
                            label: t('reports.stockMovement.kpis.closingValue'),
                            value: format.money(first.totals.closingValue),
                          },
                        ]
                      : []),
                  ]}
                />
                <DataTable
                  label={t('reports.stockMovement.title')}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.variantId}
                  sorting={{ state: sorting, onChange: setSorting }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={PackageMovingIcon}
                      title={t('reports.stockMovement.emptyTitle')}
                      description={
                        show === 'moved'
                          ? t('reports.stockMovement.emptyBody')
                          : t('reports.stockMovement.emptyAllBody')
                      }
                    />
                  }
                  footer={
                    isFetchingNextPage && (
                      <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                    )
                  }
                />
                <Footnotes
                  notes={[
                    t('reports.stockMovement.returnsHint'),
                    t('reports.stockMovement.transfersHint'),
                  ]}
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
