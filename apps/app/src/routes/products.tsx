import {
  FileImportIcon,
  PackageIcon,
  PlusSignIcon,
  Search01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isTrackingMode,
  PRODUCT_STATUSES,
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
import {
  allRows,
  type LocalProductSort,
  productPage,
  productSummaryOf,
  type SyncDatabase,
} from '@omnivo/sync';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { LocalState, SyncNotice } from '../components/local-state';
import { useLocalData, useLocalQuery } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { categoryAndBelow, categoryOptions, categoryPath } from '../lib/products';
import { productCategoriesQuery, productListQuery, unitsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';

const column = dataTableColumns<ProductSummary>();

// Step 18a: the active products are read from the device, this many more each time the list is
// scrolled to its end. The first screen reads a hundred rows, not the whole catalog.
const PAGE = 100;

// The small lists of the rows' categories and units, whole. Outside the component: a read must be
// one stable function (useLocalQuery).
const readCategories = (db: SyncDatabase) => allRows(db.productCategories);
const readUnits = (db: SyncDatabase) => allRows(db.units);

// The table's sort → the list's. Two sortable columns, each with an index on the device and a
// stable order on the server.
function sortOf(state: SortingState): LocalProductSort {
  const [first] = state;
  if (first?.id === 'code') return first.desc ? '-code' : 'code';
  if (first?.id === 'name') return first.desc ? '-name' : 'name';
  return 'name';
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
  const sort = sortOf(sorting);
  const archived = status === 'archived';
  const online = useOnline();
  const { view, notice } = useLocalData();
  const hasCopy = view.kind === 'ready';

  // The categories and units of the rows: from the device, or from the server while the device
  // has no copy (the archived tab works without one)
  const localCategories = useLocalQuery(readCategories);
  const localUnits = useLocalQuery(readUnits);
  const serverCategories = useQuery({
    ...productCategoriesQuery(tenantId),
    enabled: !hasCopy,
  }).data;
  const serverUnits = useQuery({ ...unitsQuery(tenantId), enabled: !hasCopy }).data;
  const categories = hasCopy ? localCategories : serverCategories;
  const units = hasCopy ? localUnits : serverUnits;
  const unitCode = useMemo(() => new Map(units?.map((unit) => [unit.id, unit.code])), [units]);

  // How far the list has been scrolled, for this filter only: a new search or sort starts at the
  // top again. Kept with its filter instead of reset in an effect, so there is no render with
  // the old length.
  const filterKey = JSON.stringify([settled, categoryId, sort]);
  const [grown, setGrown] = useState({ key: filterKey, limit: PAGE });
  const limit = grown.key === filterKey ? grown.limit : PAGE;
  const categoryIds = useMemo(
    () => (categoryId === '' ? null : categoryAndBelow(categories ?? [], categoryId)),
    [categories, categoryId],
  );
  // The active tab (decision 5): a live query, so a pull that changes a product changes its row
  const readPage = useCallback(
    (db: SyncDatabase) => productPage(db, { search: settled, categoryIds, sort, limit }),
    [settled, categoryIds, sort, limit],
  );
  const local = useLocalQuery(archived ? null : readPage);
  // The archived tab: the server's pages, as before, online only (decision 11)
  const server = useInfiniteQuery({
    ...productListQuery(tenantId, { search: settled, categoryId, status, sort }),
    enabled: archived && online,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = server;

  const products = useMemo(
    () =>
      archived
        ? server.data?.pages.flatMap((page) => page.items)
        : local?.rows.map(productSummaryOf),
    [archived, server.data, local],
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
    ) : archived ? (
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
      {notice !== null && <SyncNotice code={notice} />}
      {archived && server.isError && (
        <p className="text-body-sm text-crit">{t('products.loadFailed')}</p>
      )}
      {!archived && view.kind !== 'ready' && <LocalState view={view} />}
      {archived && !online && (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('products.archivedOfflineBody')}
        />
      )}
      {products && (archived ? online : view.kind === 'ready') && (
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
