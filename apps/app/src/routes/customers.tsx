import { PlusSignIcon, Search01Icon, UserMultiple02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CUSTOMER_STATUSES,
  type CustomerSort,
  type CustomerStatus,
  type CustomerSummary,
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
  Select,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { initialsOf, useCustomerText } from '../lib/customers';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, customerListQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

const column = dataTableColumns<CustomerSummary>();

// The customer column sorts by name; the server keeps a stable order (name, then id)
function sortOf(state: SortingState): CustomerSort {
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
  const filter = { search: settled, groupId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    customerListQuery(tenantId, filter),
  );
  const groups = useQuery(customerGroupsQuery(tenantId)).data;
  const customers = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const groupName = useMemo(
    () => new Map(groups?.map((group) => [group.id, group.name])),
    [groups],
  );

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
                <span className="truncate font-mono text-caption text-ink-3 tabular-nums">
                  {row.original.code}
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
              column.accessor((customer) => customer.balance ?? '0', {
                id: 'balance',
                header: t('customers.columns.balance'),
                enableSorting: false,
                meta: { align: 'end', card: 'trailing' },
                cell: ({ getValue }) => (
                  <span className="font-medium">{text.balance(getValue())}</span>
                ),
              }),
            ]
          : []),
      ]),
    [t, text, groupName, canSeeBalance],
  );

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('customers.noMatchTitle', { query: settled })}
        description={t('customers.noMatchBody')}
      />
    ) : status === 'archived' ? (
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
      {isError && <p className="text-body-sm text-crit">{t('customers.loadFailed')}</p>}
      {customers && (
        <DataTable
          label={t('customers.title')}
          data={customers}
          columns={columns}
          getRowId={(customer) => customer.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(customer) =>
            void navigate({ to: '/customers/$customerId', params: { customerId: customer.id } })
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
