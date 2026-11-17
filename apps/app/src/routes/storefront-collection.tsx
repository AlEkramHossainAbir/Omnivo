import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  FireIcon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  Store04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  STOREFRONT_COLLECTION_ITEMS_MAX,
  type StorefrontCollection,
  type StorefrontListingSummary,
  updateStorefrontCollectionInputSchema,
  type UpdateStorefrontCollectionInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Combobox,
  type ComboboxOption,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FormAlert,
  IconButton,
  PageHeader,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import {
  ListingStatusPill,
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useShopMoney,
  useStorefrontRefresh,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { storefrontSetupQuery } from '../lib/storefront';
import {
  collectionFormValues,
  type CollectionFormValues,
  storefrontCollectionQuery,
  storefrontListingSearchQuery,
} from '../lib/storefront-appearance';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: one collection (decision 2: its own page). Under /storefront/appearance like the
// hero's page and the API's own path (/storefront/appearance/collections/:id), so the sidebar's
// "Shop appearance" stays marked while it is open; /storefront/appearance/collections/new for a new one. A title, the flame, and up to 24 listings in the
// order the shop's row shows them. Drafts may wait in it: the row shows a listing once it is in
// the shop.

const FORM_ID = 'storefront-collection';

function Thumb({ url }: { url: string | null }) {
  return url === null ? (
    <span className="size-10 shrink-0 rounded-lg bg-subtle" />
  ) : (
    <img
      src={url}
      alt=""
      className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
    />
  );
}

// The "Product to add" box: the catalog's search, without the listings already in the row
function AddListingBox({
  chosen,
  full,
  onAdd,
}: {
  chosen: ReadonlySet<string>;
  full: boolean;
  onAdd: (listing: StorefrontListingSummary) => void;
}) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const matches = useQuery(storefrontListingSearchQuery(tenantId, settled));
  const left = (matches.data ?? []).filter((listing) => !chosen.has(listing.id));
  const options = useMemo<ComboboxOption[]>(
    () =>
      left.map((listing) => ({
        value: listing.id,
        label: listing.name,
        detail: [
          listing.sku,
          listing.price === null ? null : money(listing.price),
          listing.status === 'draft' ? t('storefront.statuses.draft') : null,
        ]
          .filter((part) => part !== null)
          .join(' · '),
      })),
    [left, money, t],
  );

  if (full) {
    return (
      <p className="text-label text-ink-3">
        {t('storefront.collection.full', { max: format.number(STOREFRONT_COLLECTION_ITEMS_MAX) })}
      </p>
    );
  }
  return (
    <div className="max-w-[520px]">
      <Field id="collection-add" label={t('storefront.collection.addLabel')}>
        <Combobox
          id="collection-add"
          // Always empty: a pick goes into the list, and the box is ready for the next one
          value=""
          selectedLabel={null}
          options={options}
          search={search}
          onSearchChange={setSearch}
          onChange={(value) => {
            const listing = left.find((item) => item.id === value);
            if (listing !== undefined) onAdd(listing);
          }}
          loading={matches.isFetching}
          icon={Store04Icon}
          placeholder={t('storefront.collection.addPlaceholder')}
          searchPlaceholder={t('storefront.collection.searchLabel')}
          emptyText={t('storefront.collection.noMatch')}
        />
      </Field>
    </div>
  );
}

function CollectionEditor({ collection }: { collection: StorefrontCollection | null }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const money = useShopMoney();
  const [deleting, setDeleting] = useState(false);
  // The listings the rows draw, by id: the saved ones and every one picked since
  const [listings, setListings] = useState<ReadonlyMap<string, StorefrontListingSummary>>(
    () => new Map((collection?.listings ?? []).map((listing) => [listing.id, listing])),
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStorefrontCollectionInputSchema, { error: contractErrorMap }),
    defaultValues: collectionFormValues(collection),
  });
  const ids = useWatch({ control, name: 'listingIds' });
  const inShop = ids.filter((id) => listings.get(id)?.status === 'published').length;

  const onSubmit = handleSubmit(async (values: UpdateStorefrontCollectionInput) => {
    try {
      if (collection === null) {
        // The create route has no version: the new row starts at 1
        const next = await call(routes.storefrontAppearance.createCollection, {
          body: { title: values.title, icon: values.icon, listingIds: values.listingIds },
        });
        queryClient.setQueryData(storefrontCollectionQuery(tenantId, next.id).queryKey, next);
        toast(t('storefront.collection.created', { title: next.title }));
        await refresh();
        void navigate({
          to: '/storefront/appearance/collections/$collectionId',
          params: { collectionId: next.id },
          replace: true,
        });
        return;
      }
      const next = await call(routes.storefrontAppearance.updateCollection, {
        params: { id: collection.id },
        body: values,
      });
      queryClient.setQueryData(storefrontCollectionQuery(tenantId, next.id).queryKey, next);
      reset(collectionFormValues(next));
      toast(t('storefront.collection.saved', { title: next.title }));
      await refresh();
    } catch (error) {
      applyApiError<CollectionFormValues>(error, ['title', 'icon', 'listingIds'], setError);
    }
  });

  const remove = useMutation({
    mutationFn: (current: StorefrontCollection) =>
      call(routes.storefrontAppearance.deleteCollection, {
        params: { id: current.id },
        query: { version: current.version },
      }),
    onSuccess: async (_answer, current) => {
      toast(t('storefront.collection.deleted', { title: current.title }));
      await refresh();
      void navigate({ to: '/storefront/appearance' });
    },
  });

  return (
    <div className="grid max-w-[880px] grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/appearance"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.collection.back')}
        </Link>
        <PageHeader
          title={collection?.title ?? t('storefront.collection.newTitle')}
          description={
            <>
              {t('storefront.collection.description')}
              {collection !== null && <ShopLine />}
            </>
          }
          actions={
            collection !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('storefront.listing.moreActions')}
                    className="size-[42px] rounded-control border border-line-strong bg-surface shadow-sm"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setDeleting(true);
                    }}
                  >
                    {t('storefront.collection.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        />
      </div>
      {ids.length > 0 && inShop === 0 && (
        <DocumentNotice tone="warn" icon={Alert02Icon}>
          {t('storefront.collection.hiddenNotice')}
        </DocumentNotice>
      )}

      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid min-w-0 gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <Card>
          <div className="grid gap-4 p-5">
            <TextField
              label={t('storefront.collection.title')}
              placeholder={t('storefront.collection.titlePlaceholder')}
              {...register('title')}
              error={errors.title?.message}
            />
            <Controller
              control={control}
              name="icon"
              render={({ field }) => (
                <Checkbox
                  id="collection-fire"
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {t('storefront.collection.fire')}
                      <HugeiconsIcon
                        icon={FireIcon}
                        size={14}
                        strokeWidth={1.5}
                        className="text-ink-3"
                      />
                    </span>
                  }
                  checked={field.value === 'fire'}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true ? 'fire' : null);
                  }}
                />
              )}
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3 pr-5">
            <CardHeader
              title={t('storefront.collection.products')}
              subtitle={t('storefront.collection.productsHint', {
                max: format.number(STOREFRONT_COLLECTION_ITEMS_MAX),
              })}
            />
            <span className="mt-[21px] shrink-0 text-caption font-normal text-ink-3 tabular-nums">
              {t('storefront.collection.count', {
                count: format.number(ids.length),
                max: format.number(STOREFRONT_COLLECTION_ITEMS_MAX),
              })}
            </span>
          </div>
          <Controller
            control={control}
            name="listingIds"
            render={({ field, fieldState }) => {
              const move = (from: number, to: number) => {
                const next = [...field.value];
                const [item] = next.splice(from, 1);
                if (item !== undefined) next.splice(to, 0, item);
                field.onChange(next);
              };
              return (
                <div className="grid gap-4 p-5">
                  {fieldState.error?.message !== undefined && (
                    <FormAlert message={fieldState.error.message} />
                  )}
                  {field.value.length === 0 ? (
                    <DocumentNotice tone="neutral">
                      {t('storefront.collection.none')}
                    </DocumentNotice>
                  ) : (
                    <>
                      <ol className="rounded-control border border-line">
                        {field.value.map((id, index) => {
                          const listing = listings.get(id);
                          const name = listing?.name ?? id;
                          return (
                            <li
                              key={id}
                              className="flex items-center gap-3 border-t border-line py-2.5 pr-2.5 pl-3 first:border-t-0"
                            >
                              <span className="w-5 shrink-0 text-right text-caption font-normal text-ink-3 tabular-nums max-sm:hidden">
                                {format.number(index + 1)}
                              </span>
                              <Thumb url={listing?.image?.url ?? null} />
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="truncate text-body-sm font-medium text-ink">
                                  {name}
                                </span>
                                {listing !== undefined && (
                                  <span className="truncate text-caption font-normal text-ink-3">
                                    <span className="font-mono">{listing.sku}</span>
                                    {listing.packSize !== '' && ` · ${listing.packSize}`}
                                    <span className="sm:hidden">
                                      {listing.price !== null && ` · ${money(listing.price)}`}
                                    </span>
                                  </span>
                                )}
                                {listing !== undefined && (
                                  <span className="mt-1 sm:hidden">
                                    <ListingStatusPill status={listing.status} />
                                  </span>
                                )}
                              </span>
                              {listing !== undefined && (
                                <>
                                  <span className="w-18 shrink-0 text-right text-body-sm tabular-nums max-sm:hidden">
                                    {listing.price === null ? '' : money(listing.price)}
                                  </span>
                                  <span className="w-26 shrink-0 max-sm:hidden">
                                    <ListingStatusPill status={listing.status} />
                                  </span>
                                </>
                              )}
                              <span className="flex shrink-0 gap-0.5">
                                <IconButton
                                  icon={ArrowUp01Icon}
                                  label={t('storefront.collection.moveUpLabel', { name })}
                                  disabled={index === 0}
                                  onClick={() => {
                                    move(index, index - 1);
                                  }}
                                />
                                <IconButton
                                  icon={ArrowDown01Icon}
                                  label={t('storefront.collection.moveDownLabel', { name })}
                                  disabled={index === field.value.length - 1}
                                  onClick={() => {
                                    move(index, index + 1);
                                  }}
                                />
                                <IconButton
                                  icon={Delete02Icon}
                                  label={t('storefront.collection.remove', { name })}
                                  onClick={() => {
                                    field.onChange(field.value.filter((item) => item !== id));
                                  }}
                                />
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                      <p className="-mt-1 text-label text-ink-3">
                        {t('storefront.collection.draftHint')}
                      </p>
                    </>
                  )}
                  <AddListingBox
                    chosen={new Set(field.value)}
                    full={field.value.length >= STOREFRONT_COLLECTION_ITEMS_MAX}
                    onAdd={(listing) => {
                      setListings((current) => new Map(current).set(listing.id, listing));
                      field.onChange([...field.value, listing.id]);
                    }}
                  />
                </div>
              );
            }}
          />
        </Card>

        {collection === null ? (
          <div className="flex justify-end gap-2.5">
            <Button
              variant="secondary"
              onClick={() => {
                void navigate({ to: '/storefront/appearance' });
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : t('storefront.collection.create')}
            </Button>
          </div>
        ) : (
          isDirty && (
            <SaveBar
              formId={FORM_ID}
              saving={isSubmitting}
              onDiscard={() => {
                reset();
              }}
            />
          )
        )}
      </form>

      {collection !== null && (
        <Dialog open={deleting} onOpenChange={setDeleting}>
          <DialogContent
            title={t('storefront.collection.confirmDelete', { title: collection.title })}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.mutate(collection);
                  }}
                >
                  {t('storefront.collection.delete')}
                </Button>
              </>
            }
          >
            {remove.error && (
              <FormAlert
                message={
                  remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'
                }
              />
            )}
            <p className="text-body-sm text-ink-2">{t('storefront.collection.deleteBody')}</p>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function StorefrontCollectionPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  // No id on /storefront/appearance/collections/new
  const { collectionId } = useParams({ strict: false });
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const collection = useQuery({
    ...storefrontCollectionQuery(tenantId, collectionId ?? ''),
    enabled: online && shop !== null && collectionId !== undefined,
  });

  if (!online) return <StorefrontOffline />;
  if (setup.isError || collection.isError) {
    return (
      <p className="text-body-sm text-crit">
        {collection.error instanceof ApiRequestError && collection.error.status === 404
          ? t('storefront.collection.notFound')
          : t('storefront.collection.loadFailed')}
      </p>
    );
  }
  if (setup.data && shop === null) {
    return (
      <EmptyState
        icon={PaintBoardIcon}
        title={t('storefront.appearance.notSetUpTitle')}
        description={t('storefront.appearance.notSetUpBody')}
        action={
          <Button
            onClick={() => {
              void navigate({ to: '/storefront/settings' });
            }}
          >
            {t('storefront.appearance.goToSettings')}
          </Button>
        }
      />
    );
  }
  if (collectionId === undefined) {
    return shop === null ? null : <CollectionEditor key="new" collection={null} />;
  }
  if (!collection.data) return null;
  return <CollectionEditor key={collection.data.id} collection={collection.data} />;
}
