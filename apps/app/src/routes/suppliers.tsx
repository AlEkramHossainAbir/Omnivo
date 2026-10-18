import { Factory01Icon, PlusSignIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  SUPPLIER_STATUSES,
  type SupplierSort,
  type SupplierStatus,
  type SupplierSummary,
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

import { useTenantId } from '../components/supplier-parts';
import { initialsOf } from '../lib/customers';
import { useCan } from '../lib/permissions';
import { supplierGroupsQuery, supplierListQuery } from '../lib/queries';
import { useSupplierText } from '../lib/suppliers';
import { useDebounced } from '../lib/use-debounced';

// Step 17a: the supplier's twin of the customer list (routes/customers.tsx). No credit limit
// column: a supplier gives the company credit, the company does not give it any.

const column = dataTableColumns<SupplierSummary>();

// The supplier column sorts by name; the server keeps a stable order (name, then id)
function sortOf(state: SortingState): SupplierSort {
  const [first] = state;
  return first?.id === 'name' && first.desc ? '-name' : 'name';
}

export function SuppliersPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('purchase.supplier.manage');
  // The column is left out without the permission, instead of a column of dashes
  const canSeeBalance = can('purchase.supplier.balance');
  const text = useSupplierText();
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<SupplierStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, groupId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    supplierListQuery(tenantId, filter),
  );
  const groups = useQuery(supplierGroupsQuery(tenantId)).data;
  const suppliers = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
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
          header: t('suppliers.columns.supplier'),
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
          header: t('suppliers.columns.phone'),
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
          header: t('suppliers.columns.group'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const id = getValue();
            return id === null ? '—' : (groupName.get(id) ?? '—');
          },
        }),
        column.accessor('paymentTermsDays', {
          header: t('suppliers.columns.terms'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => text.terms(getValue()),
        }),
        ...(canSeeBalance
          ? [
              column.accessor((supplier) => supplier.balance ?? '0', {
                id: 'balance',
                header: t('suppliers.columns.balance'),
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
        title={t('suppliers.noMatchTitle', { query: settled })}
        description={t('suppliers.noMatchBody')}
      />
    ) : status === 'archived' ? (
      <EmptyState
        icon={Factory01Icon}
        title={t('suppliers.archivedEmptyTitle')}
        description={t('suppliers.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={Factory01Icon}
        title={t('suppliers.emptyTitle')}
        description={t('suppliers.emptyBody')}
        action={
          canManage &&
          groupId === '' && (
            <Button onClick={() => void navigate({ to: '/suppliers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('suppliers.add')}
            </Button>
          )
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('suppliers.title')}
        description={t('suppliers.description')}
        actions={
          canManage && (
            <Button onClick={() => void navigate({ to: '/suppliers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('suppliers.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('suppliers.searchLabel')}
            placeholder={t('suppliers.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('suppliers.group')}
            options={[
              { value: '', label: t('suppliers.allGroups') },
              ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
            ]}
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('suppliers.show')}
          value={status}
          options={SUPPLIER_STATUSES.map((value) => ({
            value,
            label: t(`suppliers.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('suppliers.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('suppliers.loadFailed')}</p>}
      {suppliers && (
        <DataTable
          label={t('suppliers.title')}
          data={suppliers}
          columns={columns}
          getRowId={(supplier) => supplier.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(supplier) =>
            void navigate({ to: '/suppliers/$supplierId', params: { supplierId: supplier.id } })
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
