import {
  FolderLibraryIcon,
  Image01Icon,
  PackageIcon,
  PlusSignIcon,
  Search01Icon,
  Store04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createStorefrontListingInputSchema,
  routes,
  type StorefrontListingSort,
  type StorefrontListingSummary,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Combobox,
  type ComboboxOption,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  SelectField,
  type SortingState,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  ListingStatusPill,
  ShopLine,
  StockPill,
  StorefrontOffline,
  useShopMoney,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  type ListingFilter,
  storefrontCandidatesQuery,
  storefrontCategoriesQuery,
  storefrontCategoryOptions,
  storefrontListingsQuery,
  storefrontSetupQuery,
} from '../lib/storefront';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26g: the catalog, the shop's listings a page at a time (decision 1): searched, filtered and
// sorted on the server, like the devices list. A row opens the listing's editor; "Add to shop"
// makes a draft from one product variant and opens it.

const column = dataTableColumns<StorefrontListingSummary>();
const STATUSES = ['all', 'published', 'draft'] as const;

// Only the name sorts both ways; with no sort the newest change is first (the API's default)
function sortOf(state: SortingState): StorefrontListingSort {
  const first = state[0];
  if (first?.id === 'name') return first.desc ? '-name' : 'name';
  return '-updated';
}

// The photo, or a grey tile that says there is none (a draft before its first photo)
function Thumb({ url }: { url: string | null }) {
  const { t } = useLocale();
  return url === null ? (
    <span
      title={t('storefront.catalog.noPhoto')}
      className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-ink-3"
    >
      <HugeiconsIcon icon={Image01Icon} size={18} strokeWidth={1.5} />
    </span>
  ) : (
    <img
      src={url}
      alt=""
      className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
    />
  );
}

function AddDialog({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const refresh = useStorefrontRefresh();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const candidates = useQuery(storefrontCandidatesQuery(tenantId, settled));
  const categories = useQuery(storefrontCategoriesQuery(tenantId)).data;
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createStorefrontListingInputSchema, { error: contractErrorMap }),
    defaultValues: { variantId: '', categoryId: '' },
  });

  const options = useMemo<ComboboxOption[]>(
    () =>
      (candidates.data ?? []).map((candidate) => ({
        value: candidate.variantId,
        label: candidate.name,
        detail:
          candidate.salePrice === null
            ? candidate.sku
            : t('storefront.add.detail', { sku: candidate.sku, price: money(candidate.salePrice) }),
      })),
    [candidates.data, money, t],
  );

  const onSubmit = handleSubmit(async (values) => {
    try {
      const listing = await call(routes.storefront.createListing, { body: values });
      await refresh();
      toast(t('storefront.add.added', { name: listing.name }));
      onDone();
      void navigate({ to: '/storefront/listings/$listingId', params: { listingId: listing.id } });
    } catch (error) {
      applyApiError(error, ['variantId', 'categoryId'], setError);
    }
  });

  return (
    <DialogContent
      title={t('storefront.add.title')}
      description={t('storefront.add.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            type="submit"
            form="add-to-shop"
            disabled={isSubmitting || categories?.length === 0}
          >
            {isSubmitting ? t('common.saving') : t('storefront.add.submit')}
          </Button>
        </>
      }
    >
      <form
        id="add-to-shop"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <FormField control={control} name="variantId" label={t('storefront.add.product')}>
          {(field) => (
            <Combobox
              {...field}
              selectedLabel={picked?.value === field.value ? picked.label : null}
              options={options}
              search={search}
              onSearchChange={setSearch}
              onChange={(value, option) => {
                setPicked({ value, label: option.label });
                field.onChange(value);
              }}
              loading={candidates.isFetching}
              icon={PackageIcon}
              placeholder={t('storefront.add.productPlaceholder')}
              // The search box's name too (the ui's Combobox), so it says what it searches,
              // like the customer box's "Search customers"
              searchPlaceholder={t('storefront.add.searchLabel')}
              emptyText={t('storefront.add.noMatch')}
            />
          )}
        </FormField>
        {categories?.length === 0 ? (
          // A listing needs a category, and the shop has none yet: say where to make one
          <p className="text-body-sm text-ink-2">
            {t('storefront.add.noCategories')}{' '}
            <Link
              to="/storefront/categories"
              className="font-medium text-brand underline-offset-3 hover:underline"
            >
              {t('storefront.add.addCategories')}
            </Link>
          </p>
        ) : (
          <SelectField
            label={t('storefront.add.category')}
            icon={FolderLibraryIcon}
            options={[
              { value: '', label: t('storefront.add.categoryPlaceholder') },
              ...storefrontCategoryOptions(categories ?? []),
            ]}
            {...register('categoryId')}
            error={errors.categoryId?.message}
          />
        )}
      </form>
    </DialogContent>
  );
}

export function StorefrontCatalogPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const navigate = useNavigate();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState<ListingFilter['status']>('all');
  const [categoryId, setCategoryId] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [adding, setAdding] = useState(false);

  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const categories = useQuery({ ...storefrontCategoriesQuery(tenantId), enabled: online }).data;
  const filter: ListingFilter = { search: settled, status, categoryId, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontListingsQuery(tenantId, filter),
    // Listings need the shop first (storefront_not_set_up): no request before there is one
    enabled: online && shop !== null,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const filtered = settled !== '' || status !== 'all' || categoryId !== '';

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('storefront.catalog.columns.listing'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex min-w-0 items-center gap-3">
              <Thumb url={row.original.image?.url ?? null} />
              <span className="grid min-w-0">
                <span className="truncate font-medium text-ink">{row.original.name}</span>
                <span className="truncate text-caption text-ink-3">
                  {row.original.packSize === '' ? (
                    <span className="font-mono">{row.original.sku}</span>
                  ) : (
                    <>
                      <span className="font-mono">{row.original.sku}</span> ·{' '}
                      {row.original.packSize}
                    </>
                  )}
                </span>
              </span>
            </span>
          ),
        }),
        column.accessor('categoryName', {
          header: t('storefront.catalog.columns.category'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="text-ink-2">{getValue()}</span>,
        }),
        column.accessor('price', {
          header: t('storefront.catalog.columns.price'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) =>
            row.original.price === null ? (
              <span className="text-ink-3">{t('storefront.catalog.noPrice')}</span>
            ) : (
              <span className="grid justify-items-end tabular-nums">
                <span className="font-medium">{money(row.original.price)}</span>
                {row.original.compareAtPrice !== null && (
                  <s className="text-caption text-ink-3">{money(row.original.compareAtPrice)}</s>
                )}
              </span>
            ),
        }),
        column.accessor('inStock', {
          header: t('storefront.catalog.columns.stock'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <StockPill inStock={getValue()} />,
        }),
        column.accessor('status', {
          header: t('storefront.catalog.columns.status'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <ListingStatusPill status={getValue()} />,
        }),
        column.accessor('updatedAt', {
          header: t('storefront.catalog.columns.updated'),
          enableSorting: false,
          meta: { card: 'detail' },
          // The day in the workspace's time zone, like every other list's date
          cell: ({ getValue }) => (
            <span className="text-ink-2 tabular-nums">
              {format.date(new Date(`${todayIn(timeZone, new Date(getValue()))}T00:00:00`))}
            </span>
          ),
        }),
      ]),
    [t, format, money, timeZone],
  );

  const statusOptions = STATUSES.map((value) => ({
    value,
    label: t(`storefront.catalog.statuses.${value}`),
  }));

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.catalog.title')}
        description={
          <>
            {t('storefront.catalog.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={
          shop !== null && (
            <>
              <ViewShopLink href={shop.shopUrl} />
              <Button
                onClick={() => {
                  setAdding(true);
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('storefront.catalog.add')}
              </Button>
            </>
          )
        }
      />
      {!online && <StorefrontOffline />}
      {online && (isError || setup.isError) && (
        <p className="text-body-sm text-crit">{t('storefront.catalog.loadFailed')}</p>
      )}
      {online && setup.data && shop === null && (
        <EmptyState
          icon={Store04Icon}
          title={t('storefront.catalog.notSetUpTitle')}
          description={t('storefront.catalog.notSetUpBody')}
          action={
            <Button
              onClick={() => {
                void navigate({ to: '/storefront/settings' });
              }}
            >
              {t('storefront.catalog.goToSettings')}
            </Button>
          }
        />
      )}
      {online && shop !== null && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
              <Input
                type="search"
                icon={Search01Icon}
                aria-label={t('storefront.catalog.searchLabel')}
                placeholder={t('storefront.catalog.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <SegmentedControl
              label={t('storefront.catalog.status')}
              value={status}
              options={statusOptions}
              onChange={setStatus}
            />
            <div className="w-full sm:w-60">
              <Select
                aria-label={t('storefront.catalog.category')}
                icon={FolderLibraryIcon}
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                }}
                options={[
                  { value: '', label: t('storefront.catalog.allCategories') },
                  ...storefrontCategoryOptions(categories ?? []),
                ]}
              />
            </div>
          </div>
          {rows && (
            <DataTable
              label={t('storefront.catalog.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              sorting={{ state: sorting, onChange: setSorting }}
              onRowClick={(row) =>
                void navigate({
                  to: '/storefront/listings/$listingId',
                  params: { listingId: row.id },
                })
              }
              onEndReached={loadMore}
              empty={
                filtered ? (
                  <EmptyState
                    icon={Search01Icon}
                    title={t('storefront.catalog.noMatchTitle')}
                    description={t('storefront.catalog.noMatchBody')}
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearch('');
                          setStatus('all');
                          setCategoryId('');
                        }}
                      >
                        {t('storefront.catalog.clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={Store04Icon}
                    title={t('storefront.catalog.emptyTitle')}
                    description={t('storefront.catalog.emptyBody')}
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
        </>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddDialog
            onDone={() => {
              setAdding(false);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
