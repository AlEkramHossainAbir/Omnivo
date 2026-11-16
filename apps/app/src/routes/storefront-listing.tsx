import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  FileEditIcon,
  FolderLibraryIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  Store04Icon,
  Tag01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  sectionsSummary,
  SHOP_BADGES,
  type StorefrontListing,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  CheckboxGroup,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import { PhotosCard } from '../components/storefront-photos';
import { DescriptionCard } from '../components/storefront-sections';
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
import { warehousesQuery } from '../lib/queries';
import {
  listingFormSchema,
  listingFormValues,
  type ListingFormValues,
  type PhotoState,
  plainAmount,
  pricePreview,
  SALE_FORM_KINDS,
  storefrontCategoriesQuery,
  storefrontCategoryOptions,
  storefrontListingQuery,
  storefrontSetupQuery,
} from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26g: one listing's editor (decision 1): Basics, Photos, Price and sale, Description and
// Search engines in one form that saves with one PUT, and beside it what the shop shows for the
// price right now. Publishing is its own button in the header: it waits until the form is saved,
// because the server publishes what is saved, not what is on the screen.

const FORM_ID = 'storefront-listing';
const SEO_TITLE_MAX = 120;
const SEO_DESCRIPTION_MAX = 300;

// Where the API's field errors can land; anything else shows at the top
const FIELDS: Path<ListingFormValues>[] = [
  'name',
  'slug',
  'packSize',
  'categoryId',
  'priceOverride',
  'badges',
  'images',
  'descriptionSections',
  'seoTitle',
  'seoDescription',
  'sale.value',
  'sale.startsAt',
  'sale.endsAt',
];

// A day as the page shows it ("30 Nov 2026"), from an ISO date
function useDay(): (isoDate: string) => string {
  const { format } = useLocale();
  return useCallback((isoDate: string) => format.date(new Date(`${isoDate}T00:00:00`)), [format]);
}

function PricePreviewCard({
  listing,
  control,
  timeZone,
}: {
  listing: StorefrontListing;
  control: ReturnType<
    typeof useForm<ListingFormValues, unknown, UpdateStorefrontListingInput>
  >['control'];
  timeZone: string;
}) {
  const { t } = useLocale();
  const money = useShopMoney();
  const day = useDay();
  const [priceOverride, sale, name, packSize, images] = useWatch({
    control,
    name: ['priceOverride', 'sale', 'name', 'packSize', 'images'],
  });
  const preview = pricePreview(
    priceOverride ?? '',
    listing.variant.salePrice,
    sale,
    timeZone,
    new Date(),
  );
  const firstPhoto = listing.images.find((image) => image.id === images[0]?.id);

  return (
    <Card>
      <CardHeader title={t('storefront.listing.preview')} />
      <div className="grid gap-3 px-5 pt-3.5 pb-5">
        <div className="flex items-center gap-3 rounded-control border border-line p-3">
          {firstPhoto ? (
            <img
              src={firstPhoto.url}
              alt=""
              className="size-14 shrink-0 rounded-lg border border-line object-contain"
            />
          ) : (
            <span className="size-14 shrink-0 rounded-lg bg-subtle" />
          )}
          <span className="grid min-w-0 gap-0.5">
            <span className="line-clamp-2 text-body-sm font-medium text-ink">{name}</span>
            {packSize !== '' && <span className="text-caption text-ink-3">{packSize}</span>}
          </span>
        </div>
        {preview.kind === 'none' ? (
          <p className="text-body-sm text-ink-2">{t('storefront.listing.previewNoPrice')}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-kpi tracking-[-0.03em] tabular-nums">
                {money(preview.pricing.price)}
              </span>
              {preview.pricing.compareAtPrice !== null && (
                <s className="text-body-sm text-ink-3 tabular-nums">
                  {money(preview.pricing.compareAtPrice)}
                </s>
              )}
              {preview.pricing.discount !== null && (
                <Pill tone="brand" icon={Tag01Icon}>
                  {preview.pricing.discount.kind === 'percent'
                    ? t('storefront.listing.ribbonPercent', {
                        percent: preview.pricing.discount.value,
                      })
                    : t('storefront.listing.ribbonAmount', {
                        amount: money(preview.pricing.discount.value),
                      })}
                </Pill>
              )}
            </p>
            {preview.sale === 'on' && sale.endsAt !== '' && (
              <p className="text-label text-ink-3">
                {t('storefront.listing.previewUntil', { date: day(sale.endsAt) })}
              </p>
            )}
            {preview.sale === 'later' && (
              <p className="text-label text-ink-3">
                {t('storefront.listing.previewLater', { date: day(sale.startsAt) })}
              </p>
            )}
            {preview.sale === 'ended' && (
              <p className="text-label text-ink-3">
                {t('storefront.listing.previewEnded', { date: day(sale.endsAt) })}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function ListingEditor({ listing }: { listing: StorefrontListing }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = useStorefrontRefresh();
  const money = useShopMoney();
  const setup = useQuery(storefrontSetupQuery(tenantId)).data;
  const categories = useQuery(storefrontCategoriesQuery(tenantId)).data;
  const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
  const [deleting, setDeleting] = useState(false);
  // The photos' states beside the form: the saved ones are ready (they have their small file)
  const [photos, setPhotos] = useState<ReadonlyMap<string, PhotoState>>(
    () => new Map(listing.images.map((image) => [image.id, { status: 'ready', url: image.url }])),
  );
  const onPhotoState = useCallback((id: string, next: PhotoState) => {
    setPhotos((current) => new Map(current).set(id, next));
  }, []);

  const schema = useMemo(() => listingFormSchema(timeZone), [timeZone]);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(schema, { error: contractErrorMap }),
    defaultValues: listingFormValues(listing, timeZone),
  });

  const saved = async (next: StorefrontListing) => {
    queryClient.setQueryData(storefrontListingQuery(tenantId, next.id).queryKey, next);
    reset(listingFormValues(next, timeZone));
    await refresh();
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const next = await call(routes.storefront.updateListing, {
        params: { id: listing.id },
        body: values,
      });
      await saved(next);
      toast(t('storefront.listing.updated', { name: next.name }));
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const publish = useMutation({
    mutationFn: (show: boolean) =>
      call(show ? routes.storefront.publishListing : routes.storefront.unpublishListing, {
        params: { id: listing.id },
        body: { version: listing.version },
      }),
    onSuccess: async (next) => {
      await saved(next);
      toast(
        t(
          next.status === 'published'
            ? 'storefront.listing.published'
            : 'storefront.listing.unpublished',
          { name: next.name },
        ),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.storefront.deleteListing, {
        params: { id: listing.id },
        query: { version: listing.version },
      }),
    onSuccess: async () => {
      toast(t('storefront.listing.deleted', { name: listing.name }));
      await refresh();
      void navigate({ to: '/storefront/listings' });
    },
  });

  const images = watch('images');
  const saleKind = watch('sale.kind');
  const name = watch('name');
  const slug = watch('slug');
  const seoTitle = watch('seoTitle') ?? '';
  const seoDescription = watch('seoDescription') ?? '';
  const sections = watch('descriptionSections');
  // Save waits until every photo is ready, and a failed one is removed: the API takes ready ones
  const photosBusy = images.some((image) => photos.get(image.id)?.status !== 'ready');
  const warehouse = warehouses?.find((item) => item.id === setup?.shop?.defaultWarehouseId);
  const actionError = publish.error ?? remove.error;
  const shownSlug = slug.trim() === '' ? listing.slug : slug.trim();
  const isPublished = listing.status === 'published';

  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/listings"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.listing.back')}
        </Link>
        <PageHeader
          title={listing.name}
          description={
            <>
              <span className="mb-1.5 flex">
                <ListingStatusPill status={listing.status} />
              </span>
              {t('storefront.listing.fromProduct', {
                name: [listing.product.name, listing.variant.name].filter(Boolean).join(' · '),
                sku: listing.variant.sku,
              })}
              <ShopLine />
            </>
          }
          actions={
            <>
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
                    icon={LinkSquare02Icon}
                    onSelect={() => {
                      window.open(listing.shopUrl, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    {t('storefront.listing.viewInShop')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setDeleting(true);
                    }}
                  >
                    {t('storefront.listing.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant={isPublished || isDirty ? 'secondary' : 'primary'}
                disabled={isDirty || publish.isPending}
                title={isDirty ? t('storefront.listing.saveFirst') : undefined}
                onClick={() => {
                  publish.mutate(!isPublished);
                }}
              >
                <HugeiconsIcon
                  icon={isPublished ? FileEditIcon : Store04Icon}
                  size={17}
                  strokeWidth={1.5}
                />
                {isPublished ? t('storefront.listing.unpublish') : t('storefront.listing.publish')}
              </Button>
            </>
          }
        />
        {isDirty && (
          <p className="text-label text-ink-3 sm:text-right">{t('storefront.listing.saveFirst')}</p>
        )}
      </div>
      {actionError && (
        <FormAlert
          message={actionError instanceof ApiRequestError ? actionError.code : 'unknown_error'}
        />
      )}
      {listing.product.status === 'archived' && (
        <DocumentNotice tone="warn" icon={Alert02Icon}>
          {t('storefront.listing.archivedNotice', { name: listing.product.name })}
        </DocumentNotice>
      )}
      {!isPublished && (
        <DocumentNotice tone="neutral">{t('storefront.listing.draftNotice')}</DocumentNotice>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
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
            <CardHeader title={t('storefront.listing.basicsTitle')} />
            <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
              <div className="sm:col-span-2">
                <TextField
                  label={t('storefront.listing.name')}
                  hint={t('storefront.listing.nameHint')}
                  {...register('name')}
                  error={errors.name?.message}
                />
              </div>
              <TextField
                label={t('storefront.listing.slug')}
                optional
                prefix="/p/"
                autoComplete="off"
                spellCheck={false}
                placeholder={listing.slug}
                hint={
                  shownSlug !== listing.slug
                    ? t('storefront.listing.slugChangeHint')
                    : t('storefront.listing.slugHint', { slug: shownSlug })
                }
                {...register('slug')}
                error={errors.slug?.message}
              />
              <TextField
                label={t('storefront.listing.packSize')}
                optional
                placeholder={t('storefront.listing.packSizePlaceholder')}
                hint={t('storefront.listing.packSizeHint')}
                {...register('packSize')}
                error={errors.packSize?.message}
              />
              <SelectField
                label={t('storefront.listing.category')}
                icon={FolderLibraryIcon}
                options={storefrontCategoryOptions(categories ?? [])}
                {...register('categoryId')}
                error={errors.categoryId?.message}
              />
              <Controller
                control={control}
                name="badges"
                render={({ field }) => (
                  <CheckboxGroup
                    legend={t('storefront.listing.badges')}
                    options={SHOP_BADGES.map((badge) => ({
                      value: badge,
                      label: t(`storefront.badges.${badge}`),
                    }))}
                    value={field.value}
                    onChange={(next) => {
                      field.onChange(next);
                    }}
                    hint={t('storefront.listing.badgesHint')}
                    error={errors.badges?.message}
                  />
                )}
              />
              <p
                className={
                  listing.inStock === true
                    ? 'flex items-center gap-2 text-body-sm text-good sm:col-span-2'
                    : 'flex items-center gap-2 text-body-sm text-ink-2 sm:col-span-2'
                }
              >
                {listing.inStock !== null && (
                  <HugeiconsIcon
                    icon={listing.inStock ? CheckmarkCircle02Icon : Alert02Icon}
                    size={16}
                    strokeWidth={1.5}
                  />
                )}
                {listing.inStock === null
                  ? t('storefront.listing.noWarehouse')
                  : t(
                      listing.inStock
                        ? 'storefront.listing.inStock'
                        : 'storefront.listing.outOfStock',
                      {
                        warehouse: warehouse?.name ?? '',
                      },
                    )}
              </p>
            </div>
          </Card>

          <PhotosCard
            control={control}
            register={register}
            errors={errors}
            photos={photos}
            onPhotoState={onPhotoState}
          />

          <Card>
            <CardHeader title={t('storefront.listing.priceTitle')} />
            <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
              <div className="sm:col-span-2">
                <FormField
                  control={control}
                  name="priceOverride"
                  label={t('storefront.listing.price')}
                  optional
                  hint={
                    listing.variant.salePrice === null
                      ? t('storefront.listing.priceHintNone')
                      : t('storefront.listing.priceHint', {
                          price: money(listing.variant.salePrice),
                        })
                  }
                >
                  {(field) => (
                    <MoneyInput
                      {...field}
                      value={field.value ?? ''}
                      placeholder={plainAmount(listing.variant.salePrice ?? '')}
                    />
                  )}
                </FormField>
              </div>
              <SelectField
                label={t('storefront.listing.sale')}
                options={SALE_FORM_KINDS.map((kind) => ({
                  value: kind,
                  label: t(`storefront.listing.saleKinds.${kind}`),
                }))}
                {...register('sale.kind')}
              />
              {saleKind === 'percent' && (
                <TextField
                  label={t('storefront.listing.saleValues.percent')}
                  inputMode="numeric"
                  autoComplete="off"
                  align="end"
                  suffix="%"
                  placeholder={t('storefront.listing.percentPlaceholder')}
                  {...register('sale.value')}
                  error={errors.sale?.value?.message}
                />
              )}
              {(saleKind === 'amount' || saleKind === 'price') && (
                <FormField
                  control={control}
                  name="sale.value"
                  label={t(`storefront.listing.saleValues.${saleKind}`)}
                >
                  {(field) => <MoneyInput {...field} />}
                </FormField>
              )}
              {saleKind !== 'none' && (
                <>
                  <FormField
                    control={control}
                    name="sale.startsAt"
                    label={t('storefront.listing.saleFrom')}
                    optional
                  >
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                  <FormField
                    control={control}
                    name="sale.endsAt"
                    label={t('storefront.listing.saleUntil')}
                    optional
                  >
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                  <p className="text-label text-ink-3 sm:col-span-2">
                    {t('storefront.listing.saleDatesHint')}
                  </p>
                </>
              )}
            </div>
          </Card>

          <DescriptionCard control={control} register={register} errors={errors} />

          <Card>
            <CardHeader
              title={t('storefront.listing.seoTitle')}
              subtitle={t('storefront.listing.seoHint')}
            />
            <div className="grid gap-5 p-5">
              <TextField
                label={t('storefront.listing.seoPageTitle')}
                optional
                // What the shop uses when the box is empty: the listing's name
                placeholder={name}
                hint={t('storefront.listing.seoCount', {
                  count: seoTitle.length,
                  max: SEO_TITLE_MAX,
                })}
                {...register('seoTitle')}
                error={errors.seoTitle?.message}
              />
              <TextAreaField
                label={t('storefront.listing.seoPageDescription')}
                optional
                // …and the start of the description
                placeholder={sectionsSummary(sections)}
                hint={t('storefront.listing.seoCount', {
                  count: seoDescription.length,
                  max: SEO_DESCRIPTION_MAX,
                })}
                {...register('seoDescription')}
                error={errors.seoDescription?.message}
              />
            </div>
          </Card>

          {isDirty && (
            <SaveBar
              formId={FORM_ID}
              saving={isSubmitting}
              blocked={photosBusy}
              onDiscard={() => {
                reset();
              }}
            />
          )}
        </form>
        <div className="grid gap-5 lg:sticky lg:top-5">
          <PricePreviewCard listing={listing} control={control} timeZone={timeZone} />
        </div>
      </div>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent
          title={t('storefront.listing.confirmDelete', { name: listing.name })}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">{t('common.cancel')}</Button>
              </DialogClose>
              <Button
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {t('storefront.listing.delete')}
              </Button>
            </>
          }
        >
          <p className="text-body-sm text-ink-2">{t('storefront.listing.deleteBody')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StorefrontListingPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const timeZone = useTimeZone();
  const { listingId = '' } = useParams({ strict: false });
  const { data, error } = useQuery({
    ...storefrontListingQuery(tenantId, listingId),
    enabled: online,
  });

  if (!online) return <StorefrontOffline />;
  if (error) {
    return (
      <p className="text-body-sm text-crit">
        {error instanceof ApiRequestError && error.status === 404
          ? t('storefront.listing.notFound')
          : t('storefront.listing.loadFailed')}
      </p>
    );
  }
  if (!data) return null;
  // key: another listing, or the workspace's time zone arriving after the first paint, starts
  // the form again (its sale days depend on the zone)
  return <ListingEditor key={`${data.id}-${timeZone}`} listing={data} />;
}
