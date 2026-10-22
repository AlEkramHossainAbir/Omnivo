import {
  CloudUploadIcon,
  PlusSignIcon,
  Search01Icon,
  UserMultiple02Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CUSTOMER_STATUSES,
  type CustomerStatus,
  type CustomerSummary,
  MAX_BALANCE_IDS,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  Select,
  type SortingState,
} from '@omnivo/ui';
import {
  allRows,
  customerPage,
  customerSummaryOf,
  type LocalCustomerSort,
  type SyncDatabase,
} from '@omnivo/sync';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { LocalState, SyncNotice } from '../components/local-state';
import { initialsOf, useCustomerText } from '../lib/customers';
import { useLocalData, useLocalQuery } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { customerBalancesQuery, customerGroupsQuery, customerListQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';

const column = dataTableColumns<CustomerSummary>();

// Step 18a: the active customers come from the device, this many more each time the list is
// scrolled to its end. The same as the balances route's limit, so each step is one more request.
const PAGE = MAX_BALANCE_IDS;

// The ids of the rows, in groups the balances route takes. A group keeps its ids as long as the
// rows before it do not change, so scrolling further asks only for the new group.
function chunksOf(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += MAX_BALANCE_IDS) {
    chunks.push(ids.slice(start, start + MAX_BALANCE_IDS));
  }
  return chunks;
}

// A read must be one stable function (useLocalQuery)
const readGroups = (db: SyncDatabase) => allRows(db.customerGroups);

// The groups' answers as one map. Outside the component: TanStack runs `combine` again only when
// the answers or the function change, so an inline function would make a new map (and sort the
// table again) on every render.
function combineBalances(results: { data?: Map<string, string> | undefined; isError: boolean }[]) {
  return {
    byId: new Map(results.flatMap((result) => [...(result.data ?? [])])),
    failed: results.some((result) => result.isError),
  };
}

// The customer column sorts by name; the server keeps a stable order (name, then id), and the
// device's index does the same
function sortOf(state: SortingState): LocalCustomerSort {
  const [first] = state;
  return first?.id === 'name' && first.desc ? '-name' : 'name';
}

export function CustomersPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canManage = can('sales.customer.manage');
  // The column is left out without the permission, instead of a column of dashes
  const canSeeBalance = can('sales.customer.balance');
  const text = useCustomerText();
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const settled = useDebounced(search.trim());
  const sort = sortOf(sorting);
  const archived = status === 'archived';
  const online = useOnline();
  const { view, notice } = useLocalData();
  const hasCopy = view.kind === 'ready';

  const localGroups = useLocalQuery(readGroups);
  const serverGroups = useQuery({ ...customerGroupsQuery(tenantId), enabled: !hasCopy }).data;
  const groups = hasCopy ? localGroups : serverGroups;
  const groupName = useMemo(
    () => new Map(groups?.map((group) => [group.id, group.name])),
    [groups],
  );

  // How far the list has been scrolled, for this filter only (like the products page)
  const filterKey = JSON.stringify([settled, groupId, sort]);
  const [grown, setGrown] = useState({ key: filterKey, limit: PAGE });
  const limit = grown.key === filterKey ? grown.limit : PAGE;
  const readPage = useCallback(
    (db: SyncDatabase) => customerPage(db, { search: settled, groupId, sort, limit }),
    [settled, groupId, sort, limit],
  );
  const local = useLocalQuery(archived ? null : readPage);
  // Step 18b: the customers with changes waiting on this device (decision 34). A customer made
  // here has version 0: no page on the server yet, so it opens in its form.
  const pending = local?.pending;
  const madeHere = useMemo(
    () => new Set(local?.rows.filter((row) => row.version === 0).map((row) => row.id)),
    [local],
  );
  // The archived tab: the server's pages, with their balances, online only (decision 11)
  const server = useInfiniteQuery({
    ...customerListQuery(tenantId, { search: settled, groupId, status, sort }),
    enabled: archived && online,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = server;

  // The balances of the rows shown (decision 10). Online and with the permission only: offline
  // the column shows a dash.
  const balances = useQueries({
    // A customer made here has no balance on the server: it is not asked for
    queries: chunksOf(
      local?.rows.filter((row) => row.version !== 0).map((customer) => customer.id) ?? [],
    ).map((ids) => ({
      ...customerBalancesQuery(tenantId, ids),
      enabled: canSeeBalance && online,
    })),
    combine: combineBalances,
  });

  const customers = useMemo(
    () =>
      archived
        ? server.data?.pages.flatMap((page) => page.items)
        : local?.rows.map((customer) => ({
            ...customerSummaryOf(customer),
            // Offline, none: TanStack keeps the answers of a minute ago, and a balance that may
            // be wrong by now is worse than a dash (decision 10)
            balance: online ? (balances.byId.get(customer.id) ?? null) : null,
          })),
    [archived, server.data, local, balances.byId, online],
  );

  const more = local?.more ?? false;
  const loadMore = useCallback(() => {
    if (!archived) {
      if (more) setGrown({ key: filterKey, limit: limit + PAGE });
    } else if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [archived, more, filterKey, limit, hasNextPage, isFetchingNextPage, fetchNextPage, setGrown]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('customers.columns.customer'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand"
              >
                {initialsOf(row.original.name)}
              </span>
              <span className="grid min-w-0 max-w-[20rem]">
                <span className="truncate font-medium">{row.original.name}</span>
                <span className="flex min-w-0 items-center gap-2">
                  {/* No code yet: the server gives the next number when it arrives */}
                  <span className="truncate font-mono text-caption text-ink-3 tabular-nums">
                    {row.original.code === '' ? t('sync.noNumberYet') : row.original.code}
                  </span>
                  {pending?.has(row.original.id) && (
                    <Pill tone="neutral" icon={CloudUploadIcon}>
                      {t('sync.notSynced')}
                    </Pill>
                  )}
                </span>
              </span>
            </span>
          ),
        }),
        column.accessor('phone', {
          header: t('customers.columns.phone'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0">
              <span className="tabular-nums">{row.original.phone ?? '—'}</span>
              {row.original.contactPerson && (
                <span className="truncate text-caption text-ink-3">
                  {row.original.contactPerson}
                </span>
              )}
            </span>
          ),
        }),
        column.accessor('groupId', {
          header: t('customers.columns.group'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const id = getValue();
            return id === null ? '—' : (groupName.get(id) ?? '—');
          },
        }),
        column.accessor('paymentTermsDays', {
          header: t('customers.columns.terms'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => text.terms(getValue()),
        }),
        column.accessor('creditLimit', {
          header: t('customers.columns.creditLimit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => text.creditLimit(getValue()),
        }),
        ...(canSeeBalance
          ? [
              column.accessor('balance', {
                header: t('customers.columns.balance'),
                enableSorting: false,
                meta: { align: 'end', card: 'trailing' },
                // null = not here yet, or no connection (decision 10): a dash, never "Nothing
                // owed", which would be a wrong answer
                cell: ({ getValue }) => {
                  const balance = getValue();
                  return balance === null ? (
                    <span className="text-ink-3">
                      <span aria-hidden="true">—</span>
                      {!online && <span className="sr-only">{t('customers.balancesOffline')}</span>}
                    </span>
                  ) : (
                    <span className="font-medium">{text.balance(balance)}</span>
                  );
                },
              }),
            ]
          : []),
      ]),
    [t, text, groupName, canSeeBalance, online, pending],
  );

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('customers.noMatchTitle', { query: settled })}
        description={t('customers.noMatchBody')}
      />
    ) : archived ? (
      <EmptyState
        icon={UserMultiple02Icon}
        title={t('customers.archivedEmptyTitle')}
        description={t('customers.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={UserMultiple02Icon}
        title={t('customers.emptyTitle')}
        description={t('customers.emptyBody')}
        action={
          canManage &&
          groupId === '' && (
            <Button onClick={() => void navigate({ to: '/customers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customers.add')}
            </Button>
          )
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('customers.title')}
        description={t('customers.description')}
        actions={
          canManage && (
            <Button onClick={() => void navigate({ to: '/customers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customers.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('customers.searchLabel')}
            placeholder={t('customers.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('customers.group')}
            options={[
              { value: '', label: t('customers.allGroups') },
              ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
            ]}
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('customers.show')}
          value={status}
          options={CUSTOMER_STATUSES.map((value) => ({
            value,
            label: t(`customers.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
      {notice !== null && <SyncNotice code={notice} />}
      {archived && server.isError && (
        <p className="text-body-sm text-crit">{t('customers.loadFailed')}</p>
      )}
      {!archived && canSeeBalance && view.kind === 'ready' && !online && (
        <p className="text-body-sm text-ink-3">{t('customers.balancesOffline')}</p>
      )}
      {!archived && canSeeBalance && online && balances.failed && (
        <p className="text-body-sm text-crit">{t('customers.balancesFailed')}</p>
      )}
      {!archived && view.kind !== 'ready' && <LocalState view={view} />}
      {archived && !online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('customers.archivedOfflineBody')}
        />
      )}
      {customers && (archived ? online : view.kind === 'ready') && (
        <DataTable
          label={t('customers.title')}
          data={customers}
          columns={columns}
          getRowId={(customer) => customer.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(customer) =>
            void (madeHere.has(customer.id)
              ? navigate({
                  to: '/customers/$customerId/edit',
                  params: { customerId: customer.id },
                })
              : navigate({ to: '/customers/$customerId', params: { customerId: customer.id } }))
          }
          onEndReached={loadMore}
          maxHeight={640}
          empty={empty}
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
