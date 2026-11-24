import {
  Edit02Icon,
  Key01Icon,
  LockKeyholeIcon,
  Plug01Icon,
  ShippingTruck01Icon,
  Tag01Icon,
} from '@hugeicons/core-free-icons';
import {
  contractErrorMap,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierProvider,
  createCourierAccountInputSchema,
  routes,
  SHOP_COURIERS,
  updateCourierAccountInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  SelectableCardGroup,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { type Resolver, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';

// Step 28a: the courier account's dialog (approved with the mockup), its own chunk like the coupon
// form. One form for both providers: the contract's create and update schemas are unions by
// `provider`, so the form keeps one flat shape (every box), and the resolver builds the union's
// body from it and checks that with the contract's own schema. That way the keys of a Steadfast
// account never travel with a manual one, and the errors land under the same boxes as the API's.

interface AccountForm {
  provider: CourierProvider;
  name: string;
  apiKey: string;
  secretKey: string;
  // '' = "Pick a courier" (courier_pick_one)
  courier: string;
  version: number;
}

const FIELDS = ['provider', 'name', 'apiKey', 'secretKey', 'courier'] as const;

// The union's body for the provider picked. unknown: the schema below checks it (an empty courier
// is its error, not a type error here)
function bodyOf(values: AccountForm, isNew: boolean): unknown {
  const version = isNew ? {} : { version: values.version };
  return values.provider === 'manual'
    ? { provider: 'manual', name: values.name, courier: values.courier, ...version }
    : {
        provider: values.provider,
        name: values.name,
        apiKey: values.apiKey,
        secretKey: values.secretKey,
        ...version,
      };
}

function schemaOf(isNew: boolean) {
  return isNew ? createCourierAccountInputSchema : updateCourierAccountInputSchema;
}

// react-hook-form's resolver, by hand: the contract's schema over the body, each issue under the
// box its path names. The values stay the form's own (the page builds the body again to send it)
function resolverOf(isNew: boolean): Resolver<AccountForm> {
  return (values) => {
    const parsed = schemaOf(isNew).safeParse(bodyOf(values, isNew), { error: contractErrorMap });
    if (parsed.success) return { values, errors: {} };
    const errors: Partial<Record<(typeof FIELDS)[number], { type: string; message: string }>> = {};
    for (const issue of parsed.error.issues) {
      const field = FIELDS.find((name) => name === issue.path[0]);
      if (field !== undefined) errors[field] ??= { type: 'validation', message: issue.message };
    }
    return { values: {}, errors };
  };
}

function AccountForm({
  account,
  onSaved,
}: {
  account: CourierAccount | null;
  onSaved: (saved: CourierAccountSaved) => Promise<void>;
}) {
  const { t } = useLocale();
  const isNew = account === null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AccountForm>({
    resolver: resolverOf(isNew),
    defaultValues: {
      provider: account?.provider ?? 'steadfast',
      name: account?.name ?? '',
      // Write-only (decision 7): the boxes always start empty; on a saved account an empty box
      // keeps its key
      apiKey: '',
      secretKey: '',
      courier: account?.provider === 'manual' ? account.courier : '',
      version: account?.version ?? 0,
    },
  });
  const provider = useWatch({ control, name: 'provider' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      // The resolver checked it; parse again for the typed body
      const body = bodyOf(values, isNew);
      if (account === null) {
        const saved = await call(routes.shipping.createCourier, {
          body: createCourierAccountInputSchema.parse(body),
        });
        toast(t('storefront.couriers.form.created', { name: saved.account.name }));
        await onSaved(saved);
      } else {
        const saved = await call(routes.shipping.updateCourier, {
          params: { id: account.id },
          body: updateCourierAccountInputSchema.parse(body),
        });
        toast(t('storefront.couriers.form.updated'));
        await onSaved({ account: saved, webhookToken: null });
      }
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });
  const serverError = errors.root?.server?.message;

  return (
    <DialogContent
      title={
        isNew
          ? t('storefront.couriers.form.addTitle')
          : t('storefront.couriers.form.editTitle', { name: account.name })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="courier-account" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : isNew
                ? t('storefront.couriers.form.create')
                : t('storefront.couriers.form.save')}
          </Button>
        </>
      }
    >
      <form
        id="courier-account"
        noValidate
        className="grid gap-[18px]"
        onSubmit={(event) => void onSubmit(event)}
      >
        {serverError !== undefined && <FormAlert message={serverError} />}
        {isNew ? (
          <div className="grid gap-1.5">
            {/* The group's legend is for screen readers; this is the same words on screen */}
            <p aria-hidden="true" className="text-label font-medium text-ink">
              {t('storefront.couriers.form.provider')}
            </p>
            <SelectableCardGroup
              legend={t('storefront.couriers.form.provider')}
              value={provider}
              options={[
                {
                  value: 'steadfast',
                  icon: Plug01Icon,
                  title: t('storefront.couriers.form.providers.steadfast'),
                  description: t('storefront.couriers.form.providerHints.steadfast'),
                },
                {
                  value: 'manual',
                  icon: Edit02Icon,
                  title: t('storefront.couriers.form.providers.manual'),
                  description: t('storefront.couriers.form.providerHints.manual'),
                },
              ]}
              onChange={(next: CourierProvider) => {
                setValue('provider', next);
              }}
            />
          </div>
        ) : (
          // courier_provider_fixed: shown as a fact, not offered (approved with the mockup)
          <div className="grid gap-0.5 rounded-control bg-subtle p-3">
            <span className="text-label font-medium text-ink">
              {t('storefront.couriers.form.provider')}
            </span>
            <span className="text-body text-ink-2">
              {t(`storefront.couriers.form.providers.${account.provider}`)}
            </span>
            <span className="text-label text-ink-3">
              {t('storefront.couriers.form.providerFixed')}
            </span>
          </div>
        )}
        <TextField
          label={t('storefront.couriers.form.name')}
          icon={Tag01Icon}
          placeholder={t('storefront.couriers.form.namePlaceholder')}
          autoComplete="off"
          maxLength={60}
          hint={t('storefront.couriers.form.nameHint')}
          {...register('name')}
          error={errors.name?.message}
        />
        {provider === 'manual' ? (
          <SelectField
            label={t('storefront.couriers.form.courier')}
            icon={ShippingTruck01Icon}
            options={[
              { value: '', label: t('storefront.couriers.form.courierPlaceholder') },
              ...SHOP_COURIERS.map((courier) => ({
                value: courier,
                label: t(`storefront.couriers.names.${courier}`),
              })),
            ]}
            hint={t('storefront.couriers.form.courierHint')}
            {...register('courier')}
            error={errors.courier?.message}
          />
        ) : (
          <>
            {/* new-password: the browser must not fill in the member's own password here */}
            <TextField
              label={t('storefront.couriers.form.apiKey')}
              icon={Key01Icon}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={isNew ? undefined : t('storefront.couriers.form.keySavedPlaceholder')}
              {...register('apiKey')}
              error={errors.apiKey?.message}
            />
            <TextField
              label={t('storefront.couriers.form.secretKey')}
              icon={LockKeyholeIcon}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={isNew ? undefined : t('storefront.couriers.form.keySavedPlaceholder')}
              hint={
                isNew
                  ? t('storefront.couriers.form.keysHint')
                  : t('storefront.couriers.form.keysSavedHint')
              }
              {...register('secretKey')}
              error={errors.secretKey?.message}
            />
          </>
        )}
      </form>
    </DialogContent>
  );
}

export function AccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: CourierAccount | null;
  onClose: () => void;
  onSaved: (saved: CourierAccountSaved) => Promise<void>;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AccountForm key={account?.id ?? 'new'} account={account} onSaved={onSaved} />
    </Dialog>
  );
}
