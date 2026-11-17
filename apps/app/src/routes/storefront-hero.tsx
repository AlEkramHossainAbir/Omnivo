import {
  ArrowLeft01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CONTRAST_LARGE_TEXT,
  CONTRAST_TEXT,
  contractErrorMap,
  routes,
  saveStorefrontHeroInputSchema,
  type SaveStorefrontHeroInput,
  SHOP_WHITE,
  type StorefrontAppearance,
  type StorefrontHero,
  type StorefrontTheme,
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
  SegmentedControl,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { type Path, Controller, useForm, useWatch } from 'react-hook-form';

import { ColorInput, ContrastList } from '../components/storefront-color';
import { LinkPicker } from '../components/storefront-link';
import {
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
} from '../components/storefront-parts';
import { PictureField } from '../components/storefront-picture';
import { HeroDesktopPreview, HeroPhonePreview } from '../components/storefront-shop-preview';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { type PhotoState, storefrontSetupQuery } from '../lib/storefront';
import { heroFormValues, storefrontAppearanceQuery } from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: the hero's own page (/storefront/appearance/hero, approved with the mockup instead of a
// dialog: four cards and a preview do not fit in 520px). One form that makes the hero or changes
// it with one PUT (decision 13), and above it the hero as the shop will draw it, from the boxes.

const FORM_ID = 'storefront-hero';

const FIELDS: Path<ReturnType<typeof heroFormValues>>[] = [
  'href',
  'headline',
  'line',
  'eyebrow',
  'buttonLabel',
  'desktopImage',
  'desktopImage.id',
  'desktopImage.alt',
  'phoneImage',
  'phoneImage.id',
  'phoneImage.alt',
  'backgroundColor',
  'panelColor',
  'buttonColor',
  'buttonTextColor',
];

const COLOR_FIELDS = [
  ['backgroundColor', 'background', 'backgroundHint'],
  ['panelColor', 'panel', 'panelHint'],
  ['buttonColor', 'buttonColor', null],
  ['buttonTextColor', 'buttonText', null],
] as const;

function HeroEditor({ hero, theme }: { hero: StorefrontHero | null; theme: StorefrontTheme }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const [view, setView] = useState<'desktop' | 'phone'>('desktop');
  const [deleting, setDeleting] = useState(false);
  const [pictures, setPictures] = useState<ReadonlyMap<string, PhotoState>>(
    () =>
      new Map(
        hero === null
          ? []
          : [
              [hero.desktopImage.id, { status: 'ready', url: hero.desktopImage.url }],
              [hero.phoneImage.id, { status: 'ready', url: hero.phoneImage.url }],
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
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(saveStorefrontHeroInputSchema, { error: contractErrorMap }),
    defaultValues: heroFormValues(hero),
  });
  const look = useWatch({ control });
  const desktopId = look.desktopImage?.id ?? '';
  const phoneId = look.phoneImage?.id ?? '';
  const urlOf = (id: string) => {
    const state = pictures.get(id);
    return state?.status === 'ready' ? state.url : null;
  };
  const busy = [desktopId, phoneId].some((id) => id !== '' && pictures.get(id)?.status !== 'ready');
  const preview = {
    headline: look.headline ?? '',
    line: look.line ?? '',
    eyebrow: look.eyebrow ?? '',
    buttonLabel: look.buttonLabel ?? '',
    backgroundColor: look.backgroundColor ?? '',
    panelColor: look.panelColor ?? '',
    buttonColor: look.buttonColor ?? '',
    buttonTextColor: look.buttonTextColor ?? '',
  };

  const saved = (next: StorefrontHero | null) => {
    queryClient.setQueryData(
      storefrontAppearanceQuery(tenantId).queryKey,
      (current: StorefrontAppearance | undefined) =>
        current === undefined ? current : { ...current, hero: next },
    );
  };

  const onSubmit = handleSubmit(async (values: SaveStorefrontHeroInput) => {
    try {
      // The schema turned an empty line or tag into null (that is what the table keeps); the body
      // is the schema's input, which takes '' for "none", so the request sends '' back
      const next = await call(routes.storefrontAppearance.saveHero, {
        body: { ...values, line: values.line ?? '', eyebrow: values.eyebrow ?? '' },
      });
      saved(next);
      reset(heroFormValues(next));
      toast(t('storefront.appearance.hero.saved'));
      await refresh();
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const remove = useMutation({
    mutationFn: (version: number) =>
      call(routes.storefrontAppearance.deleteHero, { query: { version } }),
    onSuccess: async () => {
      saved(null);
      toast(t('storefront.appearance.hero.deleted'));
      await refresh();
      void navigate({ to: '/storefront/appearance' });
    },
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/appearance"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.appearance.title')}
        </Link>
        <PageHeader
          title={
            hero === null
              ? t('storefront.appearance.hero.newTitle')
              : t('storefront.appearance.hero.editTitle')
          }
          description={
            <>
              {t('storefront.appearance.hero.description')}
              <ShopLine />
            </>
          }
          actions={
            hero !== null && (
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
                    {t('storefront.appearance.hero.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        />
      </div>

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
          <div className="flex flex-wrap items-start justify-between gap-3 pr-5">
            <CardHeader title={t('storefront.appearance.hero.previewTitle')} />
            <div className="mt-3.5 ml-5">
              <SegmentedControl
                label={t('storefront.appearance.hero.previewLabel')}
                value={view}
                options={[
                  { value: 'desktop', label: t('storefront.appearance.hero.previewDesktop') },
                  { value: 'phone', label: t('storefront.appearance.hero.previewPhone') },
                ]}
                onChange={setView}
              />
            </div>
          </div>
          <div className="p-5">
            {view === 'desktop' ? (
              <HeroDesktopPreview hero={preview} imageUrl={urlOf(desktopId)} />
            ) : (
              <div className="rounded-control bg-subtle px-4 py-5">
                <HeroPhonePreview
                  hero={preview}
                  imageUrl={urlOf(phoneId)}
                  brand={theme.brandColor}
                  accent={theme.accentColor}
                />
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t('storefront.appearance.hero.wordsTitle')} />
          <div className="grid gap-5 p-5">
            <TextField
              label={t('storefront.appearance.hero.headline')}
              placeholder={t('storefront.appearance.hero.headlinePlaceholder')}
              hint={t('storefront.appearance.hero.headlineHint')}
              {...register('headline')}
              error={errors.headline?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('storefront.appearance.hero.button')}
                placeholder={t('storefront.appearance.hero.buttonPlaceholder')}
                hint={t('storefront.appearance.hero.buttonHint')}
                {...register('buttonLabel')}
                error={errors.buttonLabel?.message}
              />
              <TextField
                label={t('storefront.appearance.hero.eyebrow')}
                optional
                placeholder={t('storefront.appearance.hero.eyebrowPlaceholder')}
                hint={t('storefront.appearance.hero.eyebrowHint')}
                {...register('eyebrow')}
                error={errors.eyebrow?.message}
              />
            </div>
            <TextField
              label={t('storefront.appearance.hero.line')}
              optional
              placeholder={t('storefront.appearance.hero.linePlaceholder')}
              hint={t('storefront.appearance.hero.lineHint')}
              {...register('line')}
              error={errors.line?.message}
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
          </div>
        </Card>

        <Card>
          <CardHeader title={t('storefront.appearance.hero.picturesTitle')} />
          <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-2 md:gap-x-4">
            <PictureField
              label={t('storefront.appearance.hero.desktopImage')}
              hint={t('storefront.appearance.hero.desktopImageHint')}
              aspectClass="aspect-[1200/700]"
              value={desktopId}
              state={pictures.get(desktopId)}
              onPicked={(id) => {
                setValue('desktopImage.id', id, { shouldDirty: true });
              }}
              onState={onPictureState}
              alt={register('desktopImage.alt')}
              altPlaceholder={t('storefront.appearance.hero.altPlaceholder')}
              altError={errors.desktopImage?.alt?.message}
              idError={errors.desktopImage?.id?.message ?? errors.desktopImage?.message}
            />
            <PictureField
              label={t('storefront.appearance.hero.phoneImage')}
              hint={t('storefront.appearance.hero.phoneImageHint')}
              aspectClass="aspect-[361/220]"
              cover
              value={phoneId}
              state={pictures.get(phoneId)}
              onPicked={(id) => {
                setValue('phoneImage.id', id, { shouldDirty: true });
              }}
              onState={onPictureState}
              alt={register('phoneImage.alt')}
              altPlaceholder={t('storefront.appearance.hero.altPlaceholder')}
              altError={errors.phoneImage?.alt?.message}
              idError={errors.phoneImage?.id?.message ?? errors.phoneImage?.message}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title={t('storefront.appearance.hero.colorsTitle')} />
          <div className="grid gap-5 p-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              {COLOR_FIELDS.map(([name, label, hint]) => (
                <FormField
                  key={name}
                  control={control}
                  name={name}
                  label={t(`storefront.appearance.hero.${label}`)}
                  hint={hint === null ? undefined : t(`storefront.appearance.hero.${hint}`)}
                >
                  {(field) => (
                    <ColorInput {...field} label={t(`storefront.appearance.hero.${label}`)} />
                  )}
                </FormField>
              ))}
            </div>
            <ContrastList
              lines={[
                {
                  label: t('storefront.appearance.hero.contrastButton'),
                  first: preview.buttonColor,
                  second: preview.buttonTextColor,
                  min: CONTRAST_TEXT,
                },
                {
                  label: t('storefront.appearance.hero.contrastPanel'),
                  first: preview.panelColor,
                  second: SHOP_WHITE,
                  min: CONTRAST_LARGE_TEXT,
                },
              ]}
            />
          </div>
        </Card>

        {/* A new hero has nothing saved yet, so its buttons always show */}
        {(isDirty || hero === null) && (
          <SaveBar
            formId={FORM_ID}
            saving={isSubmitting}
            blocked={busy}
            onDiscard={() => {
              if (hero === null) void navigate({ to: '/storefront/appearance' });
              else reset();
            }}
          />
        )}
      </form>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent
          title={t('storefront.appearance.hero.confirmDelete')}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">{t('common.cancel')}</Button>
              </DialogClose>
              <Button
                disabled={remove.isPending || hero === null}
                onClick={() => {
                  if (hero !== null) remove.mutate(hero.version);
                }}
              >
                {t('storefront.appearance.hero.delete')}
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
          <p className="text-body-sm text-ink-2">{t('storefront.appearance.hero.deleteBody')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StorefrontHeroPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const appearance = useQuery({
    ...storefrontAppearanceQuery(tenantId),
    enabled: online && shop !== null,
  });

  if (!online) return <StorefrontOffline />;
  if (setup.isError || appearance.isError) {
    return <p className="text-body-sm text-crit">{t('storefront.appearance.loadFailed')}</p>;
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
  if (!appearance.data) return null;
  const { hero, theme } = appearance.data;
  // key: a hero made or deleted in another tab starts the form again from it
  return <HeroEditor key={hero?.id ?? 'new'} hero={hero} theme={theme} />;
}
