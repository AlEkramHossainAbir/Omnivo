import {
  Book02Icon,
  FolderTreeIcon,
  Invoice01Icon,
  PackageIcon,
  ShoppingBag01Icon,
} from '@hugeicons/core-free-icons';
import {
  PURCHASE_REPORT_GROUPS,
  PURCHASE_REPORT_SORTS,
  type PurchaseReportFilter,
  type PurchaseReportGroup,
  type PurchaseReportRow,
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

import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import { LoadFailed, NameTile, NeedsConnection } from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { branchesQuery, productCategoriesQuery, supplierGroupsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { purchaseReportQuery, sortingOf, sortOf } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: what was billed in a period, one row per supplier, product, expense account or month
// (decision 1). The sales report's twin, without cost and without a books' line: a bill's lines go
// to stock, to goods received not billed or to any expense account, so no one account says
// "purchases" the way the sales account says sales.

const column = dataTableColumns<PurchaseReportRow>();

export function PurchaseReportPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('purchase.report.read');
  const online = useOnline();
  const period = usePeriod('this_month');
  const [groupBy, setGroupBy] = useState<PurchaseReportGroup>('supplier');
  const [branchId, setBranchId] = useState('');
  const [supplierGroupId, setSupplierGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sorting, setSorting] = useState<SortingState>(sortingOf('-net'));

  // Quantity sorts only by product (the contract refuses it elsewhere). The column leaves the
  // table with its group, so a sort left on it falls back to the default instead of an error.
  const sort = sortOf(
    sorting.filter((item) => item.id !== 'quantity' || groupBy === 'product'),
    PURCHASE_REPORT_SORTS,
    '-net',
  );
  const filter: PurchaseReportFilter = {
    from: period.range.from,
    to: period.range.to,
    groupBy,
    sort,
    ...(branchId !== '' && { branchId }),
    ...(supplierGroupId !== '' && { supplierGroupId }),
    ...(categoryId !== '' && { categoryId }),
  };

  const report = useInfiniteQuery({
    ...purchaseReportQuery(tenantId, filter),
    enabled: canRead && online && period.valid,
  });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;
  const groups = useQuery({ ...supplierGroupsQuery(tenantId), enabled: canRead }).data;
  const categories = useQuery({ ...productCategoriesQuery(tenantId), enabled: canRead }).data;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const nameColumn = column.accessor('name', {
      header: t(`reports.purchases.groups.${groupBy}`),
      meta: { card: 'title' },
      cell: ({ row }) => {
        const item = row.original;
        // The one row that stands for everything the group has no row for (decision 11), so the
        // rows always add up to all purchases
        if (item.kind === 'expenses' || item.kind === 'products') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={item.kind === 'products' ? PackageIcon : Invoice01Icon} />
              <span className="grid">
                <span className="font-medium text-ink">
                  {t(`reports.purchases.rowKinds.${item.kind}`)}
                </span>
                <span className="text-caption text-ink-3">
                  {t(`reports.purchases.rowKindHints.${item.kind}`)}
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
        if (item.month !== null) {
          const date = parseIsoDate(`${item.month}-01`);
          return (
            <span className="font-medium text-ink">{date ? format.month(date) : item.month}</span>
          );
        }
        return (
          <span className="flex items-center gap-3">
            {groupBy === 'account' ? (
              <NameTile icon={Book02Icon} brand />
            ) : (
              <NameTile name={item.name ?? ''} />
            )}
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
        header: t(`reports.purchases.columns.${id}`),
        meta: { align: 'end', card: id === 'net' ? 'trailing' : 'detail' },
        cell: ({ getValue }) => (
          <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
            {format.money(getValue())}
          </span>
        ),
      });
    return column.columns([
      nameColumn,
      ...(groupBy === 'product'
        ? [
            column.accessor('quantity', {
              header: t('reports.purchases.columns.quantity'),
              meta: { align: 'end', card: 'detail' },
              cell: ({ row }) => {
                const { quantity, baseUnit } = row.original;
                // The "Expenses" row has no quantity: litres of diesel and a rent do not add up
                return quantity === null || baseUnit === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
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
    ]);
  }, [t, format, groupBy]);

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PageHeader
          title={t('reports.purchases.title')}
          description={t('reports.purchases.description')}
        />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'purchase.report.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.purchases.title')}
        description={t('reports.purchases.description')}
        actions={
          online &&
          period.valid && (
            <ExportMenu
              request={(format) => ({ report: 'purchase_report', format, query: filter })}
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
              options={PURCHASE_REPORT_GROUPS.map((value) => ({
                value,
                label: t(`reports.purchases.groups.${value}`),
              }))}
              onChange={(event) => {
                const next = PURCHASE_REPORT_GROUPS.find((value) => value === event.target.value);
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
              label={t('reports.supplierGroup')}
              value={supplierGroupId}
              options={[
                { value: '', label: t('reports.allGroups') },
                ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(event) => {
                setSupplierGroupId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.category')}
              value={categoryId}
              hint={categoryId === '' ? undefined : t('reports.purchases.categoryHint')}
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
            <LoadFailed icon={ShoppingBag01Icon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.purchases.columns.gross'),
                      value: format.money(first.totals.gross),
                      sub: t('reports.purchases.kpiHints.gross'),
                    },
                    {
                      label: t('reports.purchases.columns.returns'),
                      value: format.money(first.totals.returns),
                      sub: t('reports.purchases.kpiHints.returns'),
                    },
                    {
                      label: t('reports.purchases.columns.net'),
                      value: format.money(first.totals.net),
                    },
                  ]}
                />
                <DataTable
                  label={t('reports.purchases.title')}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.key}
                  sorting={{ state: sorting, onChange: setSorting }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={ShoppingBag01Icon}
                      title={t('reports.purchases.emptyTitle')}
                      description={t('reports.purchases.emptyBody')}
                    />
                  }
                  footer={
                    isFetchingNextPage && (
                      <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                    )
                  }
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
