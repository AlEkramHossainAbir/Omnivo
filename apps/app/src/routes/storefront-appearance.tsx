import {
  Alert02Icon,
  Delete02Icon,
  DashboardSquareAddIcon,
  Edit02Icon,
  FireIcon,
  Image02Icon,
  ImageAdd01Icon,
  ImageUploadIcon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  PlusSignIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CONTRAST_TEXT,
  contractErrorMap,
  createStorefrontBannerInputSchema,
  type CreateStorefrontBannerInput,
  routes,
  SHOP_CREAM,
  STOREFRONT_BANNERS_MAX,
  STOREFRONT_COLLECTIONS_MAX,
  STOREFRONT_DEFAULT_THEME,
  STOREFRONT_HOME_BLOCKS_MAX,
  type StorefrontAppearance,
  type StorefrontBanner,
  type StorefrontCollectionSummary,
  type StorefrontHero,
  type StorefrontHomeBlock,
  type StorefrontTheme,
  updateStorefrontThemeInputSchema,
  type UpdateStorefrontThemeInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormAlert,
  FormField,
  IconButton,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { ColorInput, ContrastList } from '../components/storefront-color';
import { LinkPicker } from '../components/storefront-link';
import {
  LINK_BUTTON_SM,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { useJobState } from '../components/storefront-photos';
import { PictureError, PictureField, usePictureUpload } from '../components/storefront-picture';
import {
  HeroDesktopPreview,
  HeroPhonePreview,
  ThemePreview,
} from '../components/storefront-shop-preview';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import type { PhotoState } from '../lib/storefront';
import { storefrontSetupQuery } from '../lib/storefront';
import {
  bannerFormValues,
  homeBlockId,
  homeBlockKey,
  homeRoom,
  storefrontAppearanceQuery,
  storefrontPreviewListingsQuery,
  themeFormValues,
} from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: Shop appearance (decision 2). Three cards on one page: the logo and the two colors
// (their own form and Save, decision approved with the mockup), the hero (a picture of it and a
// link to its own page), and the home page's blocks under the product grid. Every picture banner
// and collection is on the home page: Add puts one at the end, Delete deletes it.

// The page's read in the cache, changed in place after a save so the page does not wait for a
// second read; useStorefrontRefresh() still reads the menu again in the background
function useAppearanceCache(): (
  change: (current: StorefrontAppearance) => StorefrontAppearance,
) => void {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    (change) => {
      queryClient.setQueryData(storefrontAppearanceQuery(tenantId).queryKey, (current) =>
        current === undefined ? current : change(current),
      );
    },
    [queryClient, tenantId],
  );
}

// ---------------------------------------------------------------------------------------------
// Logo and colors

const THEME_FORM = 'storefront-theme';

function LogoField({
  value,
  onChange,
  state,
  onState,
  name,
  savedUrl,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  state: PhotoState | undefined;
  onState: (id: string, next: PhotoState) => void;
  name: string;
  // The saved logo's address, while the box still holds it
  savedUrl: string | null;
}) {
  const { t, errorText } = useLocale();
  const upload = usePictureUpload({
    onPicked: (id) => {
      onChange(id === '' ? null : id);
    },
    onState,
  });
  useJobState(value ?? '', state ?? { status: 'ready', url: '' }, onState);
  const url = state?.status === 'ready' ? state.url : savedUrl;

  return (
    <div role="group" aria-labelledby="logo-label" className="grid content-start gap-1.5">
      <span id="logo-label" className="text-label font-medium text-ink">
        {t('storefront.appearance.theme.logo')}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-subtle">
          {value !== null && state !== undefined && state.status !== 'ready' ? (
            <HugeiconsIcon
              icon={state.status === 'failed' ? Alert02Icon : ImageUploadIcon}
              size={20}
              strokeWidth={1.5}
              className={state.status === 'failed' ? 'text-crit' : 'text-ink-3'}
            />
          ) : value !== null && url !== null && url !== '' ? (
            <img
              src={url}
              alt={t('storefront.appearance.theme.logoAlt', { name })}
              className="size-full object-contain"
            />
          ) : (
            // The Omnivo mark the shop shows without a logo (CLAUDE.md → Logo)
            <span aria-hidden="true" className="relative size-7">
              <span className="absolute top-0 left-0 size-[18px] rounded-[5px] bg-brand" />
              <span className="absolute right-0 bottom-0 size-[18px] rounded-[5px] border-2 border-brand" />
            </span>
          )}
        </span>
        <div className="grid gap-2">
          {value === null && (
            <span className="text-body-sm text-ink-2">
              {t('storefront.appearance.theme.noLogo')}
            </span>
          )}
          {value !== null && state?.status === 'uploading' && (
            <span role="status" className="text-body-sm text-ink-2">
              {t('storefront.picture.uploading')}
            </span>
          )}
          {value !== null && state?.status === 'processing' && (
            <span role="status" className="text-body-sm text-ink-2">
              {t('storefront.picture.preparing')}
            </span>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={upload.open}>
              <HugeiconsIcon icon={ImageUploadIcon} size={17} strokeWidth={1.5} />
              {value === null ? t('storefront.picture.upload') : t('storefront.picture.replace')}
            </Button>
            {value !== null && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onChange(null);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {t('storefront.picture.remove')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {state?.status === 'failed' && value !== null ? (
        <PictureError>{errorText(state.code)}</PictureError>
      ) : upload.failure !== null ? (
        <PictureError>{errorText(upload.failure)}</PictureError>
      ) : (
        <p className="text-label text-ink-3">
          {t('storefront.appearance.theme.logoHint')} {t('storefront.picture.fileHint')}
        </p>
      )}
      {upload.fileInput}
    </div>
  );
}

function ThemeCard({ theme }: { theme: StorefrontTheme }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const refresh = useStorefrontRefresh();
  const updateCache = useAppearanceCache();
  const products = useQuery(storefrontPreviewListingsQuery(tenantId)).data;
  const [logoStates, setLogoStates] = useState<ReadonlyMap<string, PhotoState>>(() =>
    theme.logo === null
      ? new Map()
      : new Map([[theme.logo.id, { status: 'ready', url: theme.logo.url }]]),
  );
  const onLogoState = useCallback((id: string, next: PhotoState) => {
    setLogoStates((current) => new Map(current).set(id, next));
  }, []);

  const {
    control,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStorefrontThemeInputSchema, { error: contractErrorMap }),
    defaultValues: themeFormValues(theme),
  });
  const [brand, accent, logoId] = useWatch({
    control,
    name: ['brandColor', 'accentColor', 'logoImageId'],
  });
  const logoState = logoId === null ? undefined : logoStates.get(logoId);
  // Save waits for the logo's job: the API refuses a picture that is not ready
  const logoBusy = logoId !== null && logoState !== undefined && logoState.status !== 'ready';

  const onSubmit = handleSubmit(async (values: UpdateStorefrontThemeInput) => {
    try {
      const next = await call(routes.storefrontAppearance.updateTheme, { body: values });
      updateCache((current) => ({ ...current, theme: next }));
      reset(themeFormValues(next));
      toast(t('storefront.appearance.theme.saved'));
      await refresh();
    } catch (error) {
      applyApiError(error, ['logoImageId', 'brandColor', 'accentColor'], setError);
    }
  });

  return (
    <Card>
      <CardHeader
        title={t('storefront.appearance.theme.title')}
        subtitle={t('storefront.appearance.theme.description')}
      />
      <form
        id={THEME_FORM}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 items-start gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_380px]"
      >
        <div className="grid min-w-0 gap-[18px]">
          {errors.root?.server?.message !== undefined && (
            <FormAlert message={errors.root.server.message} />
          )}
          <Controller
            control={control}
            name="logoImageId"
            render={({ field }) => (
              <LogoField
                value={field.value}
                onChange={field.onChange}
                state={logoState}
                onState={onLogoState}
                name={theme.name}
                savedUrl={theme.logo?.id === field.value ? theme.logo.url : null}
              />
            )}
          />
          {errors.logoImageId?.message !== undefined && (
            <FormAlert message={errors.logoImageId.message} />
          )}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
            <FormField
              control={control}
              name="brandColor"
              label={t('storefront.appearance.theme.brand')}
              hint={t('storefront.appearance.theme.brandHint')}
            >
              {(field) => <ColorInput {...field} label={t('storefront.appearance.theme.brand')} />}
            </FormField>
            <FormField
              control={control}
              name="accentColor"
              label={t('storefront.appearance.theme.accent')}
              hint={t('storefront.appearance.theme.accentHint')}
            >
              {(field) => <ColorInput {...field} label={t('storefront.appearance.theme.accent')} />}
            </FormField>
          </div>
          <ContrastList
            lines={[
              {
                label: t('storefront.appearance.theme.contrastCream'),
                first: brand,
                second: SHOP_CREAM,
                min: CONTRAST_TEXT,
              },
              {
                label: t('storefront.appearance.theme.contrastAccent'),
                first: brand,
                second: accent,
                min: CONTRAST_TEXT,
              },
            ]}
          />
        </div>
        <ThemePreview
          brand={brand}
          accent={accent}
          logoUrl={
            logoId === null
              ? null
              : logoState?.status === 'ready' && logoState.url !== ''
                ? logoState.url
                : theme.logo?.id === logoId
                  ? theme.logo.url
                  : null
          }
          name={theme.name}
          products={(products ?? []).map((listing) => ({
            id: listing.id,
            name: listing.name,
            packSize: listing.packSize,
            price: listing.price,
            imageUrl: listing.image?.url ?? null,
          }))}
        />
      </form>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
        <button
          type="button"
          className="mr-auto text-body-sm font-medium text-brand underline-offset-3 hover:underline"
          onClick={() => {
            setValue('brandColor', STOREFRONT_DEFAULT_THEME.brandColor, { shouldDirty: true });
            setValue('accentColor', STOREFRONT_DEFAULT_THEME.accentColor, { shouldDirty: true });
          }}
        >
          {t('storefront.appearance.theme.reset')}
        </button>
        {isDirty && (
          <Button
            variant="secondary"
            disabled={isSubmitting}
            onClick={() => {
              reset();
            }}
          >
            {t('storefront.discard')}
          </Button>
        )}
        <Button type="submit" form={THEME_FORM} disabled={!isDirty || isSubmitting || logoBusy}>
          {isSubmitting ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The hero

function HeroCard({ hero, theme }: { hero: StorefrontHero | null; theme: StorefrontTheme }) {
  const { t } = useLocale();
  if (hero === null) {
    return (
      <Card>
        <CardHeader
          title={t('storefront.appearance.hero.title')}
          subtitle={t('storefront.appearance.hero.description')}
        />
        <div className="grid justify-items-center gap-3 px-5 py-7 text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={Image02Icon} size={20} strokeWidth={1.5} />
          </span>
          <p className="text-body-sm text-ink-2">{t('storefront.appearance.hero.none')}</p>
          <Link to="/storefront/appearance/hero" className={LINK_BUTTON_SM}>
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('storefront.appearance.hero.add')}
          </Link>
        </div>
      </Card>
    );
  }
  const look = {
    headline: hero.headline,
    line: hero.line ?? '',
    eyebrow: hero.eyebrow ?? '',
    buttonLabel: hero.buttonLabel,
    backgroundColor: hero.backgroundColor,
    panelColor: hero.panelColor,
    buttonColor: hero.buttonColor,
    buttonTextColor: hero.buttonTextColor,
  };
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 pr-5">
        <CardHeader
          title={t('storefront.appearance.hero.title')}
          subtitle={t('storefront.appearance.hero.description')}
        />
        <Link to="/storefront/appearance/hero" className={`${LINK_BUTTON_SM} mt-4 ml-5`}>
          <HugeiconsIcon icon={Edit02Icon} size={17} strokeWidth={1.5} />
          {t('storefront.appearance.hero.edit')}
        </Link>
      </div>
      <div className="grid gap-3 p-5">
        {/* The shop's own two layouts: the phone's below sm, as a phone would see it */}
        <div className="max-sm:hidden">
          <HeroDesktopPreview hero={look} imageUrl={hero.desktopImage.url} />
        </div>
        <div className="sm:hidden">
          <HeroPhonePreview
            hero={look}
            imageUrl={hero.phoneImage.url}
            brand={theme.brandColor}
            accent={theme.accentColor}
          />
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-body-sm font-medium text-ink">{hero.headline}</span>
          <span className="text-caption font-normal text-ink-3">
            {t('storefront.link.goesTo', { href: hero.href })}
          </span>
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The home page's blocks

// The line under a block's name: where a banner goes, how much of a collection is in the shop
function BlockLine({ block }: { block: StorefrontHomeBlock }) {
  const { t, format } = useLocale();
  if (block.kind === 'banner') {
    return (
      <span className="truncate text-caption font-normal text-ink-3">
        {t('storefront.appearance.home.banner')} ·{' '}
        {t('storefront.link.goesTo', { href: block.banner.href })}
      </span>
    );
  }
  const { listingCount, publishedCount } = block.collection;
  if (publishedCount === 0) {
    // The shop hides an empty row: say so, it is something to act on
    return (
      <span className="flex items-center gap-1.5 text-caption font-normal text-warn">
        <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.5} className="shrink-0" />
        {t('storefront.appearance.home.collection')} ·{' '}
        {t('storefront.appearance.home.nonePublished')}
      </span>
    );
  }
  return (
    <span className="truncate text-caption font-normal text-ink-3">
      {t('storefront.appearance.home.collection')} ·{' '}
      {publishedCount === listingCount
        ? t('storefront.appearance.home.products', {
            count: listingCount,
            formatted: format.number(listingCount),
          })
        : t('storefront.appearance.home.partlyPublished', {
            published: format.number(publishedCount),
            total: format.number(listingCount),
          })}
    </span>
  );
}

// A banner's name: the words of its computer picture (26h.5 decision 35)
function useBlockName(): (block: StorefrontHomeBlock) => string {
  const { t } = useLocale();
  return (block) =>
    block.kind === 'banner'
      ? t('storefront.appearance.banner.name', { alt: block.banner.desktopImage.alt })
      : block.collection.title;
}

type Deleting =
  | { kind: 'banner'; banner: StorefrontBanner }
  | { kind: 'collection'; collection: StorefrontCollectionSummary };

function HomeCard({
  blocks,
  onEditBanner,
  onAddBanner,
  onDelete,
}: {
  blocks: readonly StorefrontHomeBlock[];
  onEditBanner: (banner: StorefrontBanner) => void;
  onAddBanner: () => void;
  onDelete: (deleting: Deleting) => void;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const updateCache = useAppearanceCache();
  const nameOf = useBlockName();
  const room = homeRoom(blocks, {
    banners: STOREFRONT_BANNERS_MAX,
    collections: STOREFRONT_COLLECTIONS_MAX,
    blocks: STOREFRONT_HOME_BLOCKS_MAX,
  });
  const move = useMutation({
    mutationFn: (input: { block: StorefrontHomeBlock; direction: 'up' | 'down' }) =>
      call(routes.storefrontAppearance.moveHomeBlock, {
        body: { kind: input.block.kind, id: homeBlockId(input.block), direction: input.direction },
      }),
    // The answer is the whole list in its new order (decision 14)
    onSuccess: (next) => {
      updateCache((current) => ({ ...current, blocks: next.blocks }));
    },
  });
  // Why an Add button is disabled (decision 6): the block limit first, it covers both
  const fullLine =
    room.banner === 'blocks'
      ? t('storefront.appearance.home.full', { max: format.number(STOREFRONT_HOME_BLOCKS_MAX) })
      : [
          room.banner === 'banners'
            ? t('storefront.appearance.home.bannersFull', {
                max: format.number(STOREFRONT_BANNERS_MAX),
              })
            : null,
          room.collection === 'collections'
            ? t('storefront.appearance.home.collectionsFull', {
                max: format.number(STOREFRONT_COLLECTIONS_MAX),
              })
            : null,
        ]
          .filter((line) => line !== null)
          .join(' ');

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 pr-5">
        <CardHeader
          title={t('storefront.appearance.home.title')}
          subtitle={t('storefront.appearance.home.description')}
        />
        <span className="mt-[21px] shrink-0 text-caption font-normal text-ink-3 tabular-nums">
          {t('storefront.appearance.home.count', {
            count: format.number(blocks.length),
            max: format.number(STOREFRONT_HOME_BLOCKS_MAX),
          })}
        </span>
      </div>
      <div className="grid gap-4 p-5">
        <p className="flex items-center gap-2 text-caption font-normal text-ink-3">
          <HugeiconsIcon icon={InformationCircleIcon} size={14} strokeWidth={1.5} />
          {t('storefront.appearance.home.fixed')}
        </p>
        {move.error && (
          <FormAlert
            message={move.error instanceof ApiRequestError ? move.error.code : 'unknown_error'}
          />
        )}
        {blocks.length === 0 ? (
          <EmptyState
            icon={DashboardSquareAddIcon}
            title={t('storefront.appearance.home.emptyTitle')}
            description={t('storefront.appearance.home.emptyBody')}
          />
        ) : (
          <ol className="rounded-control border border-line">
            {blocks.map((block, index) => {
              const name = nameOf(block);
              return (
                <li
                  key={homeBlockKey(block)}
                  className="flex min-h-16 items-center gap-3 border-t border-line py-2.5 pr-2.5 pl-3 first:border-t-0"
                >
                  {block.kind === 'banner' ? (
                    <span className="h-10 w-24 shrink-0 overflow-hidden rounded-md border border-line bg-subtle max-sm:hidden">
                      <img
                        src={block.banner.desktopImage.url}
                        alt=""
                        className="size-full object-cover"
                      />
                    </span>
                  ) : (
                    // A row of cards, drawn small: the block is a row of products
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-24 shrink-0 items-center justify-center gap-[3px] rounded-md bg-brand-soft max-sm:hidden"
                    >
                      {[0, 1, 2, 3].map((card) => (
                        <span
                          key={card}
                          className="h-[22px] w-[18px] rounded-[3px] border border-brand-line bg-surface"
                        />
                      ))}
                    </span>
                  )}
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    {block.kind === 'banner' ? (
                      <button
                        type="button"
                        onClick={() => {
                          onEditBanner(block.banner);
                        }}
                        className="truncate text-left text-body-sm font-medium text-ink underline-offset-3 hover:underline"
                      >
                        {name}
                      </button>
                    ) : (
                      <Link
                        to="/storefront/appearance/collections/$collectionId"
                        params={{ collectionId: block.collection.id }}
                        className="flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-ink underline-offset-3 hover:underline"
                      >
                        <span className="truncate">{name}</span>
                        {block.collection.icon === 'fire' && (
                          <HugeiconsIcon
                            icon={FireIcon}
                            size={14}
                            strokeWidth={1.5}
                            className="shrink-0 text-ink-3"
                          />
                        )}
                      </Link>
                    )}
                    <BlockLine block={block} />
                  </span>
                  <span className="flex shrink-0 gap-0.5">
                    <IconButton
                      icon={ArrowUp01Icon}
                      label={t('storefront.appearance.home.moveUpLabel', { name })}
                      disabled={index === 0 || move.isPending}
                      onClick={() => {
                        move.mutate({ block, direction: 'up' });
                      }}
                    />
                    <IconButton
                      icon={ArrowDown01Icon}
                      label={t('storefront.appearance.home.moveDownLabel', { name })}
                      disabled={index === blocks.length - 1 || move.isPending}
                      onClick={() => {
                        move.mutate({ block, direction: 'down' });
                      }}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          icon={MoreHorizontalIcon}
                          label={t('storefront.appearance.home.actions', { name })}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          icon={Edit02Icon}
                          onSelect={() => {
                            if (block.kind === 'banner') onEditBanner(block.banner);
                            else
                              void navigate({
                                to: '/storefront/appearance/collections/$collectionId',
                                params: { collectionId: block.collection.id },
                              });
                          }}
                        >
                          {t('storefront.appearance.home.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          icon={Delete02Icon}
                          onSelect={() => {
                            onDelete(
                              block.kind === 'banner'
                                ? { kind: 'banner', banner: block.banner }
                                : { kind: 'collection', collection: block.collection },
                            );
                          }}
                        >
                          {t('storefront.appearance.home.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={room.banner !== 'ok'}
            onClick={onAddBanner}
          >
            <HugeiconsIcon icon={ImageAdd01Icon} size={17} strokeWidth={1.5} />
            {t('storefront.appearance.home.addBanner')}
          </Button>
          {room.collection === 'ok' ? (
            <Link to="/storefront/appearance/collections/new" className={LINK_BUTTON_SM}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.appearance.home.addCollection')}
            </Link>
          ) : (
            <Button variant="secondary" size="sm" disabled>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.appearance.home.addCollection')}
            </Button>
          )}
        </div>
        {fullLine !== '' && <p className="text-label text-ink-3">{fullLine}</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// A picture banner's dialog

const BANNER_FORM = 'storefront-banner';

function BannerDialog({
  banner,
  onDone,
  onDelete,
}: {
  // null = a new banner
  banner: StorefrontBanner | null;
  onDone: () => void;
  onDelete: (banner: StorefrontBanner) => void;
}) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const updateCache = useAppearanceCache();
  const [pictures, setPictures] = useState<ReadonlyMap<string, PhotoState>>(
    () =>
      new Map(
        banner === null
          ? []
          : [
              [banner.desktopImage.id, { status: 'ready', url: banner.desktopImage.url }],
              [banner.phoneImage.id, { status: 'ready', url: banner.phoneImage.url }],
            ],
      ),
  );
  const onPictureState = useCallback((id: string, next: PhotoState) => {
    setPictures((current) => new Map(current).set(id, next));
  }, []);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createStorefrontBannerInputSchema, { error: contractErrorMap }),
    defaultValues: bannerFormValues(banner),
  });
  const [desktopId, phoneId] = useWatch({ control, name: ['desktopImage.id', 'phoneImage.id'] });
  const busy = [desktopId, phoneId].some(
    (id) => id !== '' && pictures.get(id) !== undefined && pictures.get(id)?.status !== 'ready',
  );

  const onSubmit = handleSubmit(async (values: CreateStorefrontBannerInput) => {
    try {
      if (banner === null) {
        await call(routes.storefrontAppearance.createBanner, { body: values });
        toast(t('storefront.appearance.banner.added'));
      } else {
        const next = await call(routes.storefrontAppearance.updateBanner, {
          params: { id: banner.id },
          body: { ...values, version: banner.version },
        });
        updateCache((current) => ({
          ...current,
          blocks: current.blocks.map((block) =>
            block.kind === 'banner' && block.banner.id === next.id
              ? { ...block, banner: next }
              : block,
          ),
        }));
        toast(t('storefront.appearance.banner.saved'));
      }
      // A new banner's place on the page comes from the server (the end of the list)
      await refresh();
      onDone();
    } catch (error) {
      applyApiError(
        error,
        [
          'href',
          'desktopImage',
          'desktopImage.id',
          'desktopImage.alt',
          'phoneImage',
          'phoneImage.id',
          'phoneImage.alt',
        ],
        setError,
      );
    }
  });

  return (
    <DialogContent
      className="sm:max-w-140"
      title={
        banner === null
          ? t('storefront.appearance.banner.newTitle')
          : t('storefront.appearance.banner.editTitle')
      }
      description={t('storefront.appearance.banner.description')}
      footer={
        <>
          {banner !== null && (
            <Button
              variant="secondary"
              className="sm:mr-auto"
              onClick={() => {
                onDelete(banner);
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
              {t('storefront.appearance.home.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form={BANNER_FORM} disabled={isSubmitting || busy}>
            {isSubmitting
              ? t('common.saving')
              : banner === null
                ? t('storefront.appearance.banner.submit')
                : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={BANNER_FORM}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-[18px]"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <PictureField
          label={t('storefront.appearance.hero.desktopImage')}
          hint={t('storefront.appearance.banner.desktopImageHint')}
          aspectClass="aspect-[1280/280]"
          value={desktopId}
          state={pictures.get(desktopId)}
          onPicked={(id) => {
            setValue('desktopImage.id', id, { shouldDirty: true });
          }}
          onState={onPictureState}
          alt={register('desktopImage.alt')}
          altPlaceholder={t('storefront.appearance.banner.altPlaceholder')}
          altHint={t('storefront.appearance.banner.altHint')}
          altError={errors.desktopImage?.alt?.message}
          idError={errors.desktopImage?.id?.message ?? errors.desktopImage?.message}
        />
        <PictureField
          label={t('storefront.appearance.hero.phoneImage')}
          hint={t('storefront.appearance.banner.phoneImageHint')}
          aspectClass="aspect-[361/140]"
          value={phoneId}
          state={pictures.get(phoneId)}
          onPicked={(id) => {
            setValue('phoneImage.id', id, { shouldDirty: true });
          }}
          onState={onPictureState}
          alt={register('phoneImage.alt')}
          altPlaceholder={t('storefront.appearance.banner.altPlaceholder')}
          altError={errors.phoneImage?.alt?.message}
          idError={errors.phoneImage?.id?.message ?? errors.phoneImage?.message}
        />
        <Controller
          control={control}
          name="href"
          render={({ field, fieldState }) => (
            <LinkPicker
              value={field.value}
              onChange={field.onChange}
              error={fieldState.error?.message}
              ref={field.ref}
            />
          )}
        />
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// Deleting a banner or a collection

function DeleteDialog({ deleting, onDone }: { deleting: Deleting; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const remove = useMutation({
    mutationFn: () =>
      deleting.kind === 'banner'
        ? call(routes.storefrontAppearance.deleteBanner, {
            params: { id: deleting.banner.id },
            query: { version: deleting.banner.version },
          })
        : call(routes.storefrontAppearance.deleteCollection, {
            params: { id: deleting.collection.id },
            query: { version: deleting.collection.version },
          }),
    onSuccess: async () => {
      toast(
        deleting.kind === 'banner'
          ? t('storefront.appearance.banner.deleted')
          : t('storefront.collection.deleted', { title: deleting.collection.title }),
      );
      await refresh();
      onDone();
    },
  });
  return (
    <DialogContent
      title={
        deleting.kind === 'banner'
          ? t('storefront.appearance.banner.confirmDelete')
          : t('storefront.collection.confirmDelete', { title: deleting.collection.title })
      }
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
            {deleting.kind === 'banner'
              ? t('storefront.appearance.home.delete')
              : t('storefront.collection.delete')}
          </Button>
        </>
      }
    >
      {remove.error && (
        <FormAlert
          message={remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'}
        />
      )}
      <p className="text-body-sm text-ink-2">
        {deleting.kind === 'banner'
          ? t('storefront.appearance.banner.deleteBody')
          : t('storefront.collection.deleteBody')}
      </p>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// The page

function AppearanceView({ appearance }: { appearance: StorefrontAppearance }) {
  // The banner dialog: a banner to change, 'new', or closed
  const [editing, setEditing] = useState<StorefrontBanner | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  return (
    <>
      <ThemeCard theme={appearance.theme} />
      <HeroCard hero={appearance.hero} theme={appearance.theme} />
      <HomeCard
        blocks={appearance.blocks}
        onEditBanner={setEditing}
        onAddBanner={() => {
          setEditing('new');
        }}
        onDelete={setDeleting}
      />
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <BannerDialog
            key={editing === 'new' ? 'new' : editing.id}
            banner={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
            onDelete={(banner) => {
              setEditing(null);
              setDeleting({ kind: 'banner', banner });
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        {deleting !== null && (
          <DeleteDialog
            deleting={deleting}
            onDone={() => {
              setDeleting(null);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

export function StorefrontAppearancePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  // Every route here needs the shop's settings first (storefront_not_set_up): no read before
  const appearance = useQuery({
    ...storefrontAppearanceQuery(tenantId),
    enabled: online && shop !== null,
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.appearance.title')}
        description={
          <>
            {t('storefront.appearance.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && (setup.isError || appearance.isError) && (
        <p className="text-body-sm text-crit">{t('storefront.appearance.loadFailed')}</p>
      )}
      {online && setup.data && shop === null && (
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
      )}
      {online && appearance.data && <AppearanceView appearance={appearance.data} />}
    </div>
  );
}
