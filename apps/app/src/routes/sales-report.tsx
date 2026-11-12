import { CashierIcon, ChartLineData01Icon, FolderTreeIcon } from '@hugeicons/core-free-icons';
import {
  SALES_REPORT_GROUPS,
  SALES_REPORT_SORTS,
  type SalesReportFilter,
  type SalesReportGroup,
  type SalesReportRow,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  parseIsoDate,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { branchName, ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NameTile,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { branchesQuery, customerGroupsQuery, productCategoriesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { salesReportQuery, sortingOf, sortOf } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: what was sold in a period, one row per customer, product, category, branch or month
// (decision 1). Sorted and paged on the server (decision 8): the table asks for the next 50 rows as
// it nears its end, and the totals in the KPI strip are of every row, not of the rows loaded.

const column = dataTableColumns<SalesReportRow>();

export function SalesReportPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canRead = can('sales.report.read');
  const online = useOnline();
  // A month is the usual question ("how did October go"); the presets change it in one click
  const period = usePeriod('this_month');
  const [groupBy, setGroupBy] = useState<SalesReportGroup>('customer');
  const [branchId, setBranchId] = useState('');
  const [customerGroupId, setCustomerGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sorting, setSorting] = useState<SortingState>(sortingOf('-net'));

  // Quantity sorts only by product (the contract refuses it elsewhere, report_sort_invalid), and
  // cost, margin and percent only with inventory.stock.value (a 403 otherwise). A column leaves
  // the table with its group or the permission, so a sort left on it falls back to the default
  // instead of an error.
  const canSeeCost = can('inventory.stock.value');
  const sort = sortOf(
    sorting.filter(
      (item) =>
        (item.id !== 'quantity' || groupBy === 'product') &&
        (canSeeCost || !['cost', 'margin', 'marginPercent'].includes(item.id)),
    ),
    SALES_REPORT_SORTS,
    '-net',
  );
  // The filters without the page: what the export carries too, so the file has the same rows in
  // the same order. The ids only when chosen: an empty string is not a uuid.
  const filter: SalesReportFilter = {
    from: period.range.from,
    to: period.range.to,
    groupBy,
    sort,
    ...(branchId !== '' && { branchId }),
    ...(customerGroupId !== '' && { customerGroupId }),
    ...(categoryId !== '' && { categoryId }),
  };

  const report = useInfiniteQuery({
    ...salesReportQuery(tenantId, filter),
    // Without the permission the API answers 403; offline it cannot answer at all; a range that
    // ends before it starts is a 400, and the page says so under "To" instead of asking
    enabled: canRead && online && period.valid,
  });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;
  const groups = useQuery({ ...customerGroupsQuery(tenantId), enabled: canRead }).data;
  const categories = useQuery({ ...productCategoriesQuery(tenantId), enabled: canRead }).data;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // From the answer, not from the permission: the API decides, so the columns are right even when
  // a role changed since the page loaded, and even with no rows
  const withCost = first?.withCost ?? false;

  const columns = useMemo(() => {
    // The first column says what the rows are: "Customer", "Month"
    const nameColumn = column.accessor('name', {
      header: t(`reports.sales.groups.${groupBy}`),
      meta: { card: 'title' },
      cell: ({ row }) => {
        const item = row.original;
        if (item.kind === 'walk_in') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={CashierIcon} />
              <span className="grid">
                <span className="font-medium text-ink">{t('reports.sales.rowKinds.walk_in')}</span>
                <span className="text-caption text-ink-3">
                  {t('reports.sales.rowKindHints.walk_in')}
                </span>
              </span>
            </span>
          );
        }
        if (item.kind === 'no_category') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={FolderTreeIcon} />
              <span className="font-medium text-ink">
                {t('reports.sales.rowKinds.no_category')}
              </span>
            </span>
          );
        }
        // A month: "October 2026", from its first day read with local date parts
        if (item.month !== null) {
          const date = parseIsoDate(`${item.month}-01`);
          return (
            <span className="font-medium text-ink">{date ? format.month(date) : item.month}</span>
          );
        }
        // A category has no code, and no tile: its name is a word, not a party's
        if (item.code === null) {
          return <span className="font-medium text-ink">{item.name}</span>;
        }
        return (
          <span className="flex items-center gap-3">
            <NameTile name={item.name ?? ''} />
            <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[20rem]">
              <span className="truncate font-medium text-ink">{item.name}</span>
              <span className="font-mono text-caption text-ink-3 tabular-nums">{item.code}</span>
            </span>
          </span>
        );
      },
    });
    const money = (id: 'gross' | 'returns' | 'net', strong = false) =>
      column.accessor(id, {
        header: t(`reports.sales.columns.${id}`),
        meta: { align: 'end', card: id === 'net' ? 'trailing' : 'detail' },
        cell: ({ getValue }) => (
          <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
            {format.money(getValue())}
          </span>
        ),
      });
    // null without inventory.stock.value; the column is not drawn then, the dash is for a percent
    // of a row whose net is zero
    const cost = (id: 'cost' | 'margin') =>
      column.accessor(id, {
        header: t(`reports.sales.columns.${id}`),
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => {
          const value = getValue();
          return value === null ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className="text-ink-2">{format.money(value)}</span>
          );
        },
      });
    return column.columns([
      nameColumn,
      ...(groupBy === 'product'
        ? [
            column.accessor('quantity', {
              header: t('reports.sales.columns.quantity'),
              meta: { align: 'end', card: 'detail' },
              cell: ({ row }) => {
                const { quantity, baseUnit } = row.original;
                return quantity === null || baseUnit === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  // "18,400 tab": the base unit's own decimals and code (CLAUDE.md → Quantities)
                  <span className="text-ink-2">
                    {format.number(quantity, baseUnit.decimals)} {baseUnit.code}
                  </span>
                );
              },
            }),
          ]
        : []),
      money('gross'),
      money('returns'),
      money('net', true),
      ...(withCost
        ? [
            cost('cost'),
            cost('margin'),
            column.accessor('marginPercent', {
              header: t('reports.sales.columns.marginPercent'),
              meta: { align: 'end', card: 'detail' },
              cell: ({ getValue }) => {
                const value = getValue();
                return value === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="text-ink-2">{format.number(value, 1)}%</span>
                );
              },
            }),
          ]
        : []),
    ]);
  }, [t, format, groupBy, withCost]);

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PageHeader title={t('reports.sales.title')} description={t('reports.sales.description')} />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'sales.report.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.sales.title')}
        description={t('reports.sales.description')}
        actions={
          online &&
          period.valid && (
            <ExportMenu
              request={(format) => ({ report: 'sales_report', format, query: filter })}
              names={{
                branch: branchName(branches, branchId),
                group: groups?.find((group) => group.id === customerGroupId)?.name,
                category: categories?.find((category) => category.id === categoryId)?.name,
              }}
            />
          )
        }
      />
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
              label={t('reports.groupBy')}
              value={groupBy}
              options={SALES_REPORT_GROUPS.map((value) => ({
                value,
                label: t(`reports.sales.groups.${value}`),
              }))}
              onChange={(event) => {
                const next = SALES_REPORT_GROUPS.find((value) => value === event.target.value);
                if (next) setGroupBy(next);
              }}
            />
            <SelectField
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((branch) => ({
                  value: branch.id,
                  label: `${branch.code} · ${branch.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.customerGroup')}
              value={customerGroupId}
              options={[
                { value: '', label: t('reports.allGroups') },
                ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(event) => {
                setCustomerGroupId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.category')}
              value={categoryId}
              // Said only once a category is chosen: before that there is nothing to explain
              hint={categoryId === '' ? undefined : t('reports.categoryHint')}
              options={[
                { value: '', label: t('reports.allCategories') },
                ...categoryOptions(categories ?? []),
              ]}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={ChartLineData01Icon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.sales.columns.gross'),
                      value: format.money(first.totals.gross),
                      sub: t('reports.sales.kpiHints.gross'),
                    },
                    {
                      label: t('reports.sales.columns.returns'),
                      value: format.money(first.totals.returns),
                      sub: t('reports.sales.kpiHints.returns'),
                    },
                    {
                      label: t('reports.sales.columns.net'),
                      value: format.money(first.totals.net),
                    },
                    ...(withCost && first.totals.margin !== null
                      ? [
                          {
                            label: t('reports.sales.columns.margin'),
                            value: format.money(first.totals.margin),
                            sub:
                              first.totals.marginPercent === null
                                ? undefined
                                : t('reports.sales.kpiHints.margin', {
                                    percent: format.number(first.totals.marginPercent, 1),
                                  }),
                          },
                        ]
                      : []),
                  ]}
                />
                <BooksLine
                  report={first.totals.net}
                  books={first.books}
                  noBooks={t('reports.sales.noBooks')}
                />
                <DataTable
                  label={t('reports.sales.title')}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.key}
                  sorting={{ state: sorting, onChange: setSorting }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={ChartLineData01Icon}
                      title={t('reports.sales.emptyTitle')}
                      description={t('reports.sales.emptyBody')}
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
                    first.books !== null && t('reports.sales.booksHint'),
                    withCost && t('reports.sales.costHint'),
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
