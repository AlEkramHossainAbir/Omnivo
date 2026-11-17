import {
  Call02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Facebook01Icon,
  Globe02Icon,
  Instagram,
  LanguageSkillIcon,
  Linkedin01Icon,
  Location01Icon,
  NewTwitterIcon,
  PlusSignIcon,
  Rocket01Icon,
  Store01Icon,
  StoreVerified01Icon,
  Tick02Icon,
  WarehouseIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  SHOP_PAYMENT_METHODS,
  STOREFRONT_ZONES_MAX,
  type StorefrontSettings,
  type StorefrontSetup,
  todayIn,
  type UpdateStorefrontSettingsInput,
  updateStorefrontSettingsInputSchema,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  CheckboxGroup,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import {
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { warehousesQuery } from '../lib/queries';
import { settingsFormValues, storefrontSetupQuery } from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26g: the shop's settings (decision 1). Before the first save there is no shop: the form
// starts from the workspace's own details and its button says "Set up the shop" (POST). After it,
// the same form saves with the version (PUT). Beside it, the launch checklist until the shop is
// open, then the "The shop is open" card. Online only, like the whole menu.

type SettingsValues = ReturnType<typeof settingsFormValues>;

const FORM_ID = 'storefront-settings';
const TOP_FIELDS = updateStorefrontSettingsInputSchema.keyof().options;

// The API names a zone's box in its field errors ("deliveryZones.1.name"), so the form knows those
// paths too, for as many zones as there are
function fieldNames(zoneCount: number): Path<SettingsValues>[] {
  const zones = Array.from({ length: zoneCount }, (_, index) => [
    rowPath('deliveryZones', index, 'name'),
    rowPath('deliveryZones', index, 'charge'),
  ]).flat();
  return [...TOP_FIELDS, ...zones];
}

function SettingsForm({
  setup,
  onSaved,
  onDirtyChange,
}: {
  setup: StorefrontSetup;
  onSaved: (saved: StorefrontSettings) => void;
  // The checklist beside the form waits while the form has changes
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, language } = useLocale();
  const tenantId = useTenantId();
  const shop = setup.shop;
  const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
  const [moving, setMoving] = useState<UpdateStorefrontSettingsInput | null>(null);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStorefrontSettingsInputSchema, { error: contractErrorMap }),
    defaultValues: settingsFormValues(setup, language),
  });
  const zones = useFieldArray({ control, name: 'deliveryZones' });
  const subdomain = watch('subdomain');
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const save = async (values: UpdateStorefrontSettingsInput) => {
    try {
      // The first save makes the shop: the create body has no version (its schema has none)
      const { version, ...fields } = values;
      const saved = shop
        ? await call(routes.storefront.updateSettings, { body: { ...fields, version } })
        : await call(routes.storefront.createSettings, { body: fields });
      reset(settingsFormValues({ ...setup, shop: saved }, language));
      toast(t(shop ? 'storefront.settings.updated' : 'storefront.settings.created'));
      onSaved(saved);
    } catch (error) {
      applyApiError(error, fieldNames(values.deliveryZones.length), setError);
    }
  };

  // Decision 3: an open shop's new address breaks every link to the old one, so the save asks
  // first. The dialog holds the parsed values and saves them on "Change the address"
  const onSubmit = handleSubmit(async (values) => {
    if (shop?.launchedAt != null && values.subdomain !== shop.subdomain) {
      setMoving(values);
      return;
    }
    await save(values);
  });

  const serverError = errors.root?.server?.message;
  const warehouseOptions = [
    { value: '', label: t('storefront.settings.warehousePlaceholder') },
    ...(warehouses ?? []).map((warehouse) => ({
      value: warehouse.id,
      label: `${warehouse.code} · ${warehouse.name}`,
    })),
  ];
  const languageOptions = LANGUAGES.map((item) => ({ value: item.code, label: item.label }));
  const paymentOptions = SHOP_PAYMENT_METHODS.map((method) => ({
    value: method,
    label: t(`storefront.payments.${method}`),
  }));

  return (
    <form id={FORM_ID} noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5">
      {serverError && <FormAlert message={serverError} />}

      <Card>
        <CardHeader title={t('storefront.settings.addressTitle')} />
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          <div className="sm:col-span-2">
            <TextField
              label={t('storefront.settings.subdomain')}
              icon={Globe02Icon}
              suffix={`.${setup.baseDomain}`}
              autoComplete="off"
              spellCheck={false}
              hint={
                shop?.launchedAt != null
                  ? t('storefront.settings.subdomainLiveHint')
                  : t('storefront.settings.subdomainHint')
              }
              {...register('subdomain')}
              error={errors.subdomain?.message}
            />
          </div>
          <TextField
            label={t('storefront.settings.name')}
            icon={Store01Icon}
            hint={t('storefront.settings.nameHint')}
            {...register('name')}
            error={errors.name?.message}
          />
          <SelectField
            label={t('storefront.settings.language')}
            icon={LanguageSkillIcon}
            hint={t('storefront.settings.languageHint')}
            options={languageOptions}
            {...register('language')}
            error={errors.language?.message}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t('storefront.settings.contactTitle')}
          subtitle={t('storefront.settings.contactHint')}
        />
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          <TextField
            label={t('storefront.settings.hotline')}
            icon={Call02Icon}
            type="tel"
            placeholder={t('storefront.settings.hotlinePlaceholder')}
            hint={t('storefront.settings.hotlineHint')}
            {...register('hotline')}
            error={errors.hotline?.message}
          />
          <TextField
            label={t('storefront.settings.address')}
            icon={Location01Icon}
            placeholder={t('storefront.settings.addressPlaceholder')}
            hint={t('storefront.settings.addressHint')}
            {...register('address')}
            error={errors.address?.message}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t('storefront.settings.socialTitle')}
          subtitle={t('storefront.settings.socialHint')}
        />
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          <TextField
            label={t('storefront.settings.facebookUrl')}
            icon={Facebook01Icon}
            optional
            type="url"
            placeholder={t('storefront.settings.facebookPlaceholder')}
            {...register('facebookUrl')}
            error={errors.facebookUrl?.message}
          />
          <TextField
            label={t('storefront.settings.instagramUrl')}
            icon={Instagram}
            optional
            type="url"
            placeholder={t('storefront.settings.instagramPlaceholder')}
            {...register('instagramUrl')}
            error={errors.instagramUrl?.message}
          />
          <TextField
            label={t('storefront.settings.xUrl')}
            icon={NewTwitterIcon}
            optional
            type="url"
            placeholder={t('storefront.settings.xPlaceholder')}
            {...register('xUrl')}
            error={errors.xUrl?.message}
          />
          <TextField
            label={t('storefront.settings.linkedinUrl')}
            icon={Linkedin01Icon}
            optional
            type="url"
            placeholder={t('storefront.settings.linkedinPlaceholder')}
            {...register('linkedinUrl')}
            error={errors.linkedinUrl?.message}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t('storefront.settings.deliveryTitle')} />
        <div className="grid gap-5 p-5">
          <SelectField
            label={t('storefront.settings.warehouse')}
            icon={WarehouseIcon}
            hint={t('storefront.settings.warehouseHint')}
            options={warehouseOptions}
            {...register('defaultWarehouseId')}
            error={errors.defaultWarehouseId?.message}
          />
          <fieldset className="grid min-w-0 gap-3">
            <legend className="mb-1.5 text-label font-medium text-ink">
              {t('storefront.settings.zones')}
            </legend>
            <p className="-mt-1.5 text-label text-ink-3">
              {t('storefront.settings.zonesHint', { max: STOREFRONT_ZONES_MAX })}
            </p>
            {zones.fields.length === 0 && (
              <p className="text-body-sm text-ink-2">{t('storefront.settings.noZones')}</p>
            )}
            {zones.fields.map((zone, index) => {
              const number = index + 1;
              return (
                <div
                  key={zone.id}
                  role="group"
                  aria-label={t('storefront.settings.zoneNumber', { number })}
                  // On a phone the remove button sits beside the name; from sm the three share a row
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 sm:grid-cols-[minmax(0,1fr)_180px_auto]"
                >
                  <TextField
                    label={t('storefront.settings.zoneName')}
                    placeholder={t('storefront.settings.zoneNamePlaceholder')}
                    {...register(rowPath('deliveryZones', index, 'name'))}
                    error={errors.deliveryZones?.[index]?.name?.message}
                  />
                  <div className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1">
                    <FormField
                      control={control}
                      name={rowPath('deliveryZones', index, 'charge')}
                      label={t('storefront.settings.zoneCharge')}
                    >
                      {(field) => <MoneyInput {...field} />}
                    </FormField>
                  </div>
                  <IconButton
                    icon={Delete02Icon}
                    label={t('storefront.settings.removeZone', { number })}
                    // Lines the icon up with the boxes, under their labels
                    className="mt-[26px] sm:col-start-3"
                    onClick={() => {
                      zones.remove(index);
                    }}
                  />
                </div>
              );
            })}
            <p className="text-label text-ink-3">{t('storefront.settings.zoneChargeHint')}</p>
            {errors.deliveryZones?.root?.message !== undefined && (
              <FormAlert message={errors.deliveryZones.root.message} />
            )}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={zones.fields.length >= STOREFRONT_ZONES_MAX}
                onClick={() => {
                  zones.append({ id: null, name: '', charge: '' });
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('storefront.settings.addZone')}
              </Button>
            </div>
          </fieldset>
          <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
            <FormField
              control={control}
              name="freeDeliveryFrom"
              label={t('storefront.settings.freeDeliveryFrom')}
              optional
              hint={t('storefront.settings.freeDeliveryHint')}
            >
              {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
            </FormField>
            <FormField
              control={control}
              name="minimumOrder"
              label={t('storefront.settings.minimumOrder')}
              optional
              hint={t('storefront.settings.minimumOrderHint')}
            >
              {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
            </FormField>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('storefront.settings.paymentTitle')} />
        <div className="p-5">
          <Controller
            control={control}
            name="paymentMethods"
            render={({ field }) => (
              <CheckboxGroup
                legend={t('storefront.settings.payments')}
                options={paymentOptions}
                value={field.value}
                onChange={(next) => {
                  field.onChange(next);
                }}
                hint={t('storefront.settings.paymentsHint')}
                error={errors.paymentMethods?.message}
              />
            )}
          />
        </div>
      </Card>

      {shop === null ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
            {isSubmitting ? t('common.saving') : t('storefront.settings.create')}
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

      <Dialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
      >
        {moving !== null && shop !== null && (
          <DialogContent
            title={t('storefront.settings.moveTitle')}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={isSubmitting}
                  onClick={() => {
                    const values = moving;
                    setMoving(null);
                    void save(values);
                  }}
                >
                  {t('storefront.settings.moveConfirm')}
                </Button>
              </>
            }
          >
            <p className="text-body-sm text-ink-2">
              {t('storefront.settings.moveBody', {
                from: `${shop.subdomain}.${setup.baseDomain}`,
                to: `${subdomain.trim().toLowerCase()}.${setup.baseDomain}`,
              })}
            </p>
          </DialogContent>
        )}
      </Dialog>
    </form>
  );
}

// The checklist until the shop is open (decision 1). It reads the saved settings (readiness comes
// from the API), so it waits while the form has changes: "Open" would open what is saved, not what
// is on the screen
function LaunchCard({
  shop,
  dirty,
  onLaunched,
}: {
  shop: StorefrontSettings | null;
  dirty: boolean;
  onLaunched: (saved: StorefrontSettings) => void;
}) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const launch = useMutation({
    mutationFn: (version: number) => call(routes.storefront.launch, { body: { version } }),
    onSuccess: (saved) => {
      setConfirming(false);
      toast(t('storefront.launch.opened', { name: saved.name }));
      onLaunched(saved);
    },
  });
  const ready = shop?.readiness;
  const steps = [
    { key: 'warehouse', done: ready?.warehouse === true, text: t('storefront.launch.warehouse') },
    { key: 'zone', done: ready?.zone === true, text: t('storefront.launch.zone') },
    { key: 'listing', done: ready?.listing === true, text: t('storefront.launch.listing') },
  ] as const;
  const allDone = steps.every((step) => step.done);

  return (
    <Card>
      <CardHeader
        title={t('storefront.launch.title')}
        subtitle={t('storefront.launch.description')}
      />
      <div className="grid gap-4 px-5 pt-3 pb-5">
        <ol className="grid">
          {steps.map((step) => (
            <li
              key={step.key}
              className="flex items-start gap-3 border-t border-line py-3.5 first:border-t-0 first:pt-1"
            >
              <span
                className={
                  step.done
                    ? 'mt-px grid size-[22px] shrink-0 place-items-center rounded-full bg-good-bg text-good'
                    : 'mt-px size-[22px] shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong'
                }
              >
                {step.done && <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />}
              </span>
              <span className="grid gap-1">
                <span className={step.done ? 'text-body-sm text-ink' : 'text-body-sm text-ink-2'}>
                  {step.text}
                </span>
                <span className={step.done ? 'text-caption text-good' : 'text-caption text-ink-3'}>
                  {step.done ? t('storefront.launch.done') : t('storefront.launch.notDone')}
                </span>
                {step.key === 'listing' && !step.done && shop !== null && (
                  <Link
                    to="/storefront/listings"
                    className="text-label font-medium text-brand underline-offset-3 hover:underline"
                  >
                    {t('storefront.launch.goToCatalog')}
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ol>
        {(shop === null || dirty) && (
          <p className="text-label text-ink-3">{t('storefront.launch.saveFirst')}</p>
        )}
        {launch.error && (
          <FormAlert
            message={launch.error instanceof ApiRequestError ? launch.error.code : 'unknown_error'}
          />
        )}
        <Button
          variant={allDone ? 'primary' : 'secondary'}
          disabled={shop === null || dirty || !allDone}
          className="w-full"
          onClick={() => {
            setConfirming(true);
          }}
        >
          <HugeiconsIcon icon={Rocket01Icon} size={17} strokeWidth={1.5} />
          {t('storefront.launch.open')}
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        {shop !== null && (
          <DialogContent
            title={t('storefront.launch.confirmTitle', { name: shop.name })}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={launch.isPending}
                  onClick={() => {
                    launch.mutate(shop.version);
                  }}
                >
                  <HugeiconsIcon icon={Rocket01Icon} size={17} strokeWidth={1.5} />
                  {t('storefront.launch.open')}
                </Button>
              </>
            }
          >
            <p className="text-body-sm text-ink-2">
              {t('storefront.launch.confirmBody', { url: shop.shopUrl })}
            </p>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

function OpenCard({ shop }: { shop: StorefrontSettings }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const day = useMemo(() => {
    if (shop.launchedAt === null) return '';
    // The launch day in the workspace's time zone, as a date (no time: "Open since 12 Nov 2026")
    const iso = todayIn(timeZone, new Date(shop.launchedAt));
    return format.date(new Date(`${iso}T00:00:00`));
  }, [shop.launchedAt, timeZone, format]);
  return (
    <Card>
      <CardHeader title={t('storefront.launch.openTitle')} />
      <div className="grid gap-4 px-5 pt-3 pb-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-good-bg text-good">
            <HugeiconsIcon icon={StoreVerified01Icon} size={20} strokeWidth={1.5} />
          </span>
          <p className="text-body-sm text-ink-2">
            {t('storefront.launch.openSince', { date: day, url: shop.shopUrl })}
          </p>
        </div>
        <Pill tone="good" icon={CheckmarkCircle02Icon}>
          {t('storefront.settings.statusOpen')}
        </Pill>
        <ViewShopLink href={shop.shopUrl} className="w-full" />
      </div>
    </Card>
  );
}

export function StorefrontSettingsPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const { data: setup, isError } = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  // Whether the form has changes, for the checklist (the form reports it)
  const [formDirty, setFormDirty] = useState(false);
  const shop = setup?.shop ?? null;

  const saved = (next: StorefrontSettings) => {
    if (setup) {
      queryClient.setQueryData(storefrontSetupQuery(tenantId).queryKey, { ...setup, shop: next });
    }
    // The catalog's stock column and the checklist depend on the warehouse and the zones
    void refresh();
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.settings.title')}
        description={
          <>
            {t('storefront.settings.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && isError && (
        <p className="text-body-sm text-crit">{t('storefront.settings.loadFailed')}</p>
      )}
      {online && setup && (
        <>
          {shop === null && (
            <DocumentNotice tone="neutral">{t('storefront.settings.notSetUp')}</DocumentNotice>
          )}
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            {/* key: a new version (the first save, the launch) starts the form again from it, so
                the next save sends that version */}
            <SettingsForm
              key={`${tenantId}-${String(shop?.version ?? 0)}`}
              setup={setup}
              onSaved={saved}
              onDirtyChange={setFormDirty}
            />
            <div className="grid gap-5 lg:sticky lg:top-5">
              {shop?.launchedAt != null ? (
                <OpenCard shop={shop} />
              ) : (
                <LaunchCard shop={shop} dirty={formDirty} onLaunched={saved} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
