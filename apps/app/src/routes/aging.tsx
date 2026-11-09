import { Clock01Icon, TimeQuarterPassIcon } from '@hugeicons/core-free-icons';
import {
  AGING_SORTS,
  type AgingBucket,
  type AgingReport,
  type AgingRow,
  type AgingShow,
  type ApAgingFilter,
  type ArAgingFilter,
  isZeroMoney,
  type ReportExportInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  KpiStrip,
  PageHeader,
  SegmentedControl,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import {
  type AgingNamespace,
  useAgingFilters,
  useAgingKpis,
  useBalanceWords,
} from '../components/aging-parts';
import { ExportMenu } from '../components/report-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NameTile,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, supplierGroupsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { apAgingQuery, arAgingQuery, sortingOf, sortOf } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: on a chosen day, what each customer owes or each supplier is owed, split by how long it
// has been due (decisions 5 and 6). The two reports are one page with different words, so each
// route only runs its own query and gives the view what differs.

const column = dataTableColumns<AgingRow>();

const BUCKETS: readonly AgingBucket[] = [
  'current',
  'days1To30',
  'days31To60',
  'days61To90',
  'over90',
];

// A-Z: this report is for finding a party, and the KPI strip already says how much is overdue
const DEFAULT_SORT = 'name';

export function ArAgingPage() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('sales.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { search } = filters;
  const [sorting, setSorting] = useState<SortingState>(sortingOf(DEFAULT_SORT));
  const filter: ArAgingFilter = {
    asOf: filters.asOf,
    show: filters.show,
    sort: sortOf(sorting, AGING_SORTS, DEFAULT_SORT),
    ...(filters.groupId !== '' && { customerGroupId: filters.groupId }),
  };
  const report = useInfiniteQuery({
    ...arAgingQuery(tenantId, filter),
    enabled: canRead && online && filter.asOf !== '',
  });
  const groups = useQuery({ ...customerGroupsQuery(tenantId), enabled: canRead }).data;
  const partyLink = useCallback(
    (row: AgingRow, children: ReactNode) => (
      <Link
        to="/reports/ar-aging/$customerId"
        params={{ customerId: row.party.id }}
        search={search}
        // The row opens the same page; without this the click would navigate twice
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {children}
      </Link>
    ),
    [search],
  );
  return (
    <AgingView
      namespace="arAging"
      permission="sales.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      report={report}
      groups={groups ?? []}
      groupLabel="reports.customerGroup"
      exportRequest={(format) => ({ report: 'ar_aging', format, query: filter })}
      sorting={sorting}
      onSorting={setSorting}
      partyLink={partyLink}
      openParty={(navigate, row) => {
        void navigate({
          to: '/reports/ar-aging/$customerId',
          params: { customerId: row.party.id },
          search: filters.search,
        });
      }}
    />
  );
}

export function ApAgingPage() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('purchase.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { search } = filters;
  const [sorting, setSorting] = useState<SortingState>(sortingOf(DEFAULT_SORT));
  const filter: ApAgingFilter = {
    asOf: filters.asOf,
    show: filters.show,
    sort: sortOf(sorting, AGING_SORTS, DEFAULT_SORT),
    ...(filters.groupId !== '' && { supplierGroupId: filters.groupId }),
  };
  const report = useInfiniteQuery({
    ...apAgingQuery(tenantId, filter),
    enabled: canRead && online && filter.asOf !== '',
  });
  const groups = useQuery({ ...supplierGroupsQuery(tenantId), enabled: canRead }).data;
  const partyLink = useCallback(
    (row: AgingRow, children: ReactNode) => (
      <Link
        to="/reports/ap-aging/$supplierId"
        params={{ supplierId: row.party.id }}
        search={search}
        // The row opens the same page; without this the click would navigate twice
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {children}
      </Link>
    ),
    [search],
  );
  return (
    <AgingView
      namespace="apAging"
      permission="purchase.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      report={report}
      groups={groups ?? []}
      groupLabel="reports.supplierGroup"
      exportRequest={(format) => ({ report: 'ap_aging', format, query: filter })}
      sorting={sorting}
      onSorting={setSorting}
      partyLink={partyLink}
      openParty={(navigate, row) => {
        void navigate({
          to: '/reports/ap-aging/$supplierId',
          params: { supplierId: row.party.id },
          search: filters.search,
        });
      }}
    />
  );
}

function AgingView({
  namespace,
  permission,
  canRead,
  online,
  filters,
  report,
  groups,
  groupLabel,
  exportRequest,
  sorting,
  onSorting,
  partyLink,
  openParty,
}: {
  namespace: AgingNamespace;
  permission: 'sales.report.read' | 'purchase.report.read';
  canRead: boolean;
  online: boolean;
  filters: ReturnType<typeof useAgingFilters>;
  report: UseInfiniteQueryResult<InfiniteData<AgingReport>>;
  groups: readonly { id: string; name: string }[];
  groupLabel: 'reports.customerGroup' | 'reports.supplierGroup';
  exportRequest: (format: 'xlsx' | 'pdf') => ReportExportInput;
  sorting: SortingState;
  onSorting: (next: SortingState) => void;
  partyLink: (row: AgingRow, children: ReactNode) => ReactNode;
  openParty: (navigate: ReturnType<typeof useNavigate>, row: AgingRow) => void;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const kpis = useAgingKpis(namespace);
  const balanceWords = useBalanceWords(namespace);
  const { asOf, today, show, groupId } = filters;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    // A zero is a dash, not ৳0: a row of five bucket columns reads by where its money is
    const amount = (id: AgingBucket | 'due' | 'advances', header: string, strong = false) =>
      column.accessor(id, {
        header,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) =>
          isZeroMoney(getValue()) ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
              {format.money(getValue())}
            </span>
          ),
      });
    return column.columns([
      column.accessor((row) => row.party.name, {
        id: 'name',
        header: t(`reports.${namespace}.party`),
        meta: { card: 'title' },
        cell: ({ row }) => {
          const { party } = row.original;
          return partyLink(
            row.original,
            <span
              className="flex items-center gap-3"
              aria-label={t('reports.aging.openParty', { name: party.name })}
            >
              <NameTile name={party.name} />
              <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[16rem]">
                <span className="truncate font-medium text-ink">{party.name}</span>
                <span className="font-mono text-caption text-ink-3 tabular-nums">{party.code}</span>
              </span>
            </span>,
          );
        },
      }),
      ...BUCKETS.map((bucket) => amount(bucket, t(`reports.aging.buckets.${bucket}`))),
      amount('due', t('reports.aging.columns.due'), true),
      amount('advances', t('reports.aging.columns.advances')),
      column.accessor('balance', {
        header: t('reports.aging.columns.balance'),
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => (
          <span className="font-medium text-ink">{balanceWords(getValue())}</span>
        ),
      }),
    ]);
  }, [t, format, namespace, partyLink, balanceWords]);

  const header = (
    <PageHeader
      title={t(`reports.${namespace}.title`)}
      description={t(`reports.${namespace}.description`)}
      actions={canRead && online && asOf !== '' && <ExportMenu request={exportRequest} />}
    />
  );
  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: permission })}
        </p>
      </div>
    );
  }

  const overdueOnly = show === 'overdue';
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
      {!online ? (
        <NeedsConnection />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-full sm:w-56">
              <Field id="aging-as-of" label={t('reports.asOf')}>
                <DatePicker id="aging-as-of" value={asOf} onChange={filters.chooseDay} />
              </Field>
            </div>
            <div className="w-full sm:w-56">
              <SelectField
                label={t(groupLabel)}
                value={groupId}
                options={[
                  { value: '', label: t('reports.allGroups') },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                onChange={(event) => {
                  filters.chooseGroup(event.target.value);
                }}
              />
            </div>
            <SegmentedControl<AgingShow>
              label={t('reports.aging.show')}
              value={show}
              options={[
                { value: 'all', label: t('reports.aging.shows.all') },
                { value: 'overdue', label: t('reports.aging.shows.overdue') },
              ]}
              onChange={filters.chooseShow}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={TimeQuarterPassIcon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip cells={kpis(first.totals)} />
                <BooksLine
                  report={first.totals.balance}
                  books={first.ledger}
                  noBooks={t('reports.aging.noLedger')}
                />
                <DataTable
                  label={t(`reports.${namespace}.title`)}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.party.id}
                  sorting={{ state: sorting, onChange: onSorting }}
                  onRowClick={(row) => {
                    openParty(navigate, row);
                  }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={overdueOnly ? Clock01Icon : TimeQuarterPassIcon}
                      title={t(
                        overdueOnly
                          ? `reports.${namespace}.overdueEmptyTitle`
                          : `reports.${namespace}.emptyTitle`,
                      )}
                      description={t(
                        overdueOnly
                          ? `reports.${namespace}.overdueEmptyBody`
                          : `reports.${namespace}.emptyBody`,
                      )}
                      action={
                        overdueOnly ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              filters.chooseShow('all');
                            }}
                          >
                            {t('reports.aging.showEveryone')}
                          </Button>
                        ) : undefined
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
                    t('reports.aging.bucketsHint'),
                    first.ledger !== null && t(`reports.${namespace}.ledgerHint`),
                    asOf > today && t('reports.aging.futureHint'),
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
