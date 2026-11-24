import { LockKeyholeIcon, CouponPercentIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  SHOP_COUPON_KINDS,
  type ShopCouponKind,
  type StorefrontCoupon,
  updateStorefrontCouponInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  FormField,
  MoneyInput,
  SegmentedControl,
  TextField,
  toast,
} from '@omnivo/ui';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { plainAmount } from '../lib/storefront';
import { useStorefrontRefresh } from './storefront-parts';

// Step 27c: the coupon's dialog form, for a new coupon and a change. Its own lazy chunk, loaded the
// first time the dialog opens (like the schedule dialog, step 21c): the money boxes and the date
// picker would take the Coupons page over its lazy budget, and most visits only read the list.

// One form for both, the update schema: the create schema plus the version. A new coupon sends
// everything but the version. `raw: true` below: the API's body is what the boxes hold (strings,
// the kind and the value apart, z.input), so the form sends its own values after the schema has
// checked them, not the schema's output (one `discount` object and a number limit), which the
// route would refuse
const formSchema = updateStorefrontCouponInputSchema;
type FormValues = z.input<typeof formSchema>;

// The boxes the API may name in a refusal (storefront_coupon_code_taken lands under the code)
const FIELD_NAMES = [
  'code',
  'kind',
  'value',
  'upTo',
  'minimum',
  'startsOn',
  'lastDay',
  'usageLimit',
  'onePerPhone',
] as const satisfies readonly Path<FormValues>[];

// What the boxes hold for a coupon (or a new one). Everything is a string, like the form: '' is
// "none" for the optional boxes, and the schema turns it into null. The API sends amounts as
// Postgres keeps them, "200.0000", and the schema takes 2 decimals at most (decision 13), so
// plainAmount() writes them as a person would ("200", "47.5"): else a coupon could not be saved
// without retyping every amount (found by 27c.7's Playwright test)
function formValues(coupon: StorefrontCoupon | null): FormValues {
  if (coupon === null) {
    return {
      code: '',
      // Percent first: "10% off" is what most shops run
      kind: 'percent',
      value: '',
      upTo: '',
      minimum: '',
      startsOn: '',
      lastDay: '',
      usageLimit: '',
      onePerPhone: false,
      version: 1,
    };
  }
  return {
    code: coupon.code,
    kind: coupon.discount.kind,
    value:
      coupon.discount.kind === 'amount'
        ? plainAmount(coupon.discount.value)
        : String(coupon.discount.value),
    upTo: coupon.upTo === null ? '' : plainAmount(coupon.upTo),
    minimum: coupon.minimum === null ? '' : plainAmount(coupon.minimum),
    startsOn: coupon.startsOn ?? '',
    lastDay: coupon.lastDay ?? '',
    usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
    onePerPhone: coupon.onePerPhone,
    version: coupon.version,
  };
}

function CouponForm({
  coupon: current,
  onDone,
}: {
  coupon: StorefrontCoupon | null;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(formSchema, { error: contractErrorMap }, { raw: true }),
    defaultValues: formValues(current),
  });
  // The value box's label and control follow the kind; Up to is for a percent only
  const kind = useWatch({ control, name: 'kind' });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = current
        ? await call(routes.storefrontCoupons.updateCoupon, {
            params: { id: current.id },
            body: { ...fields, version },
          })
        : await call(routes.storefrontCoupons.createCoupon, { body: fields });
      await refresh();
      toast(
        t(current ? 'storefront.coupon.updated' : 'storefront.coupon.created', {
          code: saved.code,
        }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={
        current
          ? t('storefront.coupon.editTitle', { code: current.code })
          : t('storefront.coupon.newTitle')
      }
      description={t('storefront.coupon.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="coupon-form" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : current
                ? t('storefront.coupon.submitEdit')
                : t('storefront.coupon.submitNew')}
          </Button>
        </>
      }
    >
      <form
        id="coupon-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {current?.codeLocked ? (
          // Decision 16 (27c.1): an order has had the code, and its page and documents say it, so
          // the code is shown, not offered. The form still sends it (the default value): the API
          // compares it with the saved one and refuses only a change
          <Field
            id="coupon-code"
            label={t('storefront.coupon.code')}
            hint={t('storefront.coupon.codeLockedHint')}
          >
            <p
              id="coupon-code"
              aria-describedby="coupon-code-hint"
              className="flex min-h-[42px] items-center gap-2.5 rounded-control border border-line bg-subtle px-3 font-mono text-body text-ink"
            >
              <HugeiconsIcon
                icon={LockKeyholeIcon}
                size={17}
                strokeWidth={1.5}
                className="shrink-0 text-ink-3"
              />
              {current.code}
            </p>
          </Field>
        ) : (
          <TextField
            label={t('storefront.coupon.code')}
            icon={CouponPercentIcon}
            placeholder={t('storefront.coupon.codePlaceholder')}
            hint={t('storefront.coupon.codeHint')}
            // A code is a word to copy, not a sentence: no capital first letter, no spelling marks
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            {...register('code')}
            error={errors.code?.message}
          />
        )}
        <Controller
          control={control}
          name="kind"
          render={({ field }) => (
            <Field id="coupon-kind" label={t('storefront.coupon.kind')}>
              <SegmentedControl
                label={t('storefront.coupon.kind')}
                value={field.value}
                options={SHOP_COUPON_KINDS.map((value) => ({
                  value,
                  label: t(`storefront.coupon.kinds.${value}`),
                }))}
                onChange={(next: ShopCouponKind) => {
                  field.onChange(next);
                  // "৳50 off, up to ৳30" says two things, and the schema refuses an Up to on an
                  // amount: the box goes, and so does what it held. The value box keeps its
                  // number (decision 17): 10 typed as a percent is ৳10 as an amount
                  if (next === 'amount') setValue('upTo', '');
                }}
              />
            </Field>
          )}
        />
        {kind === 'percent' ? (
          <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
            <TextField
              label={t('storefront.coupon.values.percent')}
              inputMode="numeric"
              autoComplete="off"
              align="end"
              suffix="%"
              placeholder={t('storefront.coupon.percentPlaceholder')}
              {...register('value')}
              error={errors.value?.message}
            />
            <FormField
              control={control}
              name="upTo"
              label={t('storefront.coupon.upTo')}
              optional
              hint={t('storefront.coupon.upToHint')}
            >
              {(field) => <MoneyInput {...field} />}
            </FormField>
          </div>
        ) : (
          <FormField control={control} name="value" label={t('storefront.coupon.values.amount')}>
            {(field) => <MoneyInput {...field} />}
          </FormField>
        )}
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
          <FormField
            control={control}
            name="minimum"
            label={t('storefront.coupon.minimum')}
            optional
            hint={t('storefront.coupon.minimumHint')}
          >
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <TextField
            label={t('storefront.coupon.usageLimit')}
            optional
            hint={t('storefront.coupon.usageLimitHint')}
            inputMode="numeric"
            autoComplete="off"
            align="end"
            {...register('usageLimit')}
            error={errors.usageLimit?.message}
          />
        </div>
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <FormField
            control={control}
            name="startsOn"
            label={t('storefront.coupon.startsOn')}
            optional
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <FormField
            control={control}
            name="lastDay"
            label={t('storefront.coupon.lastDay')}
            optional
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <p className="-mt-2 text-label text-ink-3 sm:col-span-2">
            {t('storefront.coupon.daysHint')}
          </p>
        </div>
        <Controller
          control={control}
          name="onePerPhone"
          render={({ field }) => (
            <div className="grid gap-1.5">
              <Checkbox
                id="coupon-one-per-phone"
                label={t('storefront.coupon.onePerPhone')}
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
                aria-describedby="coupon-one-per-phone-hint"
              />
              <p id="coupon-one-per-phone-hint" className="pl-[27px] text-label text-ink-3">
                {t('storefront.coupon.onePerPhoneHint')}
              </p>
            </div>
          )}
        />
      </form>
    </DialogContent>
  );
}

// The dialog itself, so the page renders nothing of the form until it is needed. `coupon` null =
// a new coupon. The key makes each coupon a fresh form: the boxes never keep the last one's values
export function CouponDialog({
  coupon,
  onClose,
}: {
  coupon: StorefrontCoupon | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CouponForm key={coupon?.id ?? 'new'} coupon={coupon} onDone={onClose} />
    </Dialog>
  );
}
