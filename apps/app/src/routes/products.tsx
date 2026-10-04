import {
  FileImportIcon,
  PackageIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isTrackingMode,
  PRODUCT_STATUSES,
  type ProductSort,
  type ProductStatus,
  type ProductSummary,
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
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCan } from '../lib/permissions';
import { categoryOptions, categoryPath } from '../lib/products';
import { productCategoriesQuery, productListQuery, unitsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<ProductSummary>();

// The table's sort → the API's. Two sortable columns; the server keeps a stable order on each.
function sortOf(state: SortingState): ProductSort {
  const [first] = state;
  if (first?.id === 'code') return first.desc ? '-code' : 'code';
  if (first?.id === 'name') return first.desc ? '-name' : 'name';
  return 'name';
}

// What the person typed, a moment after they stop: one request per word, not per key
function useDebounced(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

export function ProductsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('inventory.product.manage');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<ProductStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, categoryId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    productListQuery(tenantId, filter),
  );
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const units = useQuery(unitsQuery(tenantId)).data;
  const products = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const unitCode = useMemo(() => new Map(units?.map((unit) => [unit.id, unit.code])), [units]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('code', {
          header: t('products.fields.code'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="font-mono text-caption text-ink-2 tabular-nums">{getValue()}</span>
          ),
        }),
        column.accessor('name', {
          header: t('products.columns.product'),
          meta: { card: 'title' },
          cell: ({ row }) => {
            const where = categoryPath(categories ?? [], row.original.categoryId);
            return (
              <span className="grid max-w-[22rem]">
                <span className="truncate font-medium">{row.original.name}</span>
                {where !== '' && <span className="truncate text-caption text-ink-3">{where}</span>}
              </span>
            );
          },
        }),
        column.accessor('variantCount', {
          header: t('products.columns.variants'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            row.original.hasVariants
              ? t('products.variantCount', { count: row.original.variantCount })
              : t('products.simple'),
        }),
        column.accessor('baseUnitId', {
          header: t('products.columns.unit'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="font-mono text-caption">{unitCode.get(getValue()) ?? ''}</span>
          ),
        }),
        column.accessor('tracking', {
          header: t('products.columns.tracking'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const mode = getValue();
            return isTrackingMode(mode) ? t(`products.trackings.${mode}`) : mode;
          },
        }),
        column.accessor((product) => product.minPrice ?? '', {
          id: 'price',
          header: t('products.columns.price'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          // A sale price is a unit price: 2 decimals (CLAUDE.md → Money). A range when the
          // variants differ.
          cell: ({ row }) => {
            const { minPrice, maxPrice } = row.original;
            if (minPrice === null || maxPrice === null) return '—';
            const low = format.money(minPrice, { decimals: 2 });
            return minPrice === maxPrice
              ? low
              : `${low} – ${format.money(maxPrice, { decimals: 2 })}`;
          },
        }),
      ]),
    [t, format, categories, unitCode],
  );

  const filtered = settled !== '' || categoryId !== '';
  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('products.noMatchTitle', { query: settled })}
        description={t('products.noMatchBody')}
      />
    ) : status === 'archived' ? (
      <EmptyState
        icon={PackageIcon}
        title={t('products.archivedEmptyTitle')}
        description={t('products.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={PackageIcon}
        title={t('products.emptyTitle')}
        description={t('products.emptyBody')}
        action={
          canManage &&
          !filtered && (
            <Button onClick={() => void navigate({ to: '/products/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('products.add')}
            </Button>
          )
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('products.title')}
        description={t('products.description')}
        actions={
          canManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => void navigate({ to: '/products/imports' })}
              >
                <HugeiconsIcon icon={FileImportIcon} size={17} strokeWidth={1.5} />
                {t('products.import')}
              </Button>
              <Button onClick={() => void navigate({ to: '/products/new' })}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('products.add')}
              </Button>
            </>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('products.searchLabel')}
            placeholder={t('products.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('products.category')}
            options={[
              { value: '', label: t('products.allCategories') },
              ...categoryOptions(categories ?? []),
            ]}
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('products.show')}
          value={status}
          options={PRODUCT_STATUSES.map((value) => ({
            value,
            label: t(`products.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('products.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('products.loadFailed')}</p>}
      {products && (
        <DataTable
          label={t('products.title')}
          data={products}
          columns={columns}
          getRowId={(product) => product.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(product) =>
            void navigate({ to: '/products/$productId', params: { productId: product.id } })
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
