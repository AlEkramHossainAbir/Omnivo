import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  InformationCircleIcon,
  LockKeyholeIcon,
  MinusSignCircleIcon,
  Plug01Icon,
  Store01Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createStorefrontPaymentGatewayInputSchema,
  PAYMENT_GATEWAY_MODES,
  type PaymentGatewayMode,
  routes,
  type StorefrontAccountChoice,
  type StorefrontPaymentGateway,
  type StorefrontPaymentSetup,
  updateStorefrontPaymentGatewayInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  Field,
  FormAlert,
  Pill,
  SegmentedControl,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { DocumentNotice } from './document-notice';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useTimeZone } from '../lib/workspace';

// Step 27d (decisions 4 and 9): the shop's SSLCommerz store, under the Payment card of Shop settings.
// Its own form with its own footer, not a part of the settings form: it saves to its own route with
// its own version, and its password must never ride along with the shop's other settings. The
// password box always starts empty; once one is saved, an empty box keeps it. "Test connection"
// tests what is saved (the password never travels for a test), so it waits while the form has
// changes.

const FIELDS = ['storeId', 'mode', 'password', 'moneyAccountId', 'feeAccountId'] as const;

// The first save has no version and needs a password. The form keeps one shape for both saves
// (a version of 0 that the first save leaves out), so this is the create schema with any whole
// number there. Not the update schema's version: it is min(1), so the 0 would fail on a box the form
// does not draw, and "Save gateway" would do nothing and say nothing (27d.7's Playwright test found
// it). A number, not z.literal(0): both resolvers must give the form one type of values
const FIRST_SAVE_SCHEMA = createStorefrontPaymentGatewayInputSchema.extend({
  version: z.number().int(),
});

type GatewayStatus = 'notSaved' | 'ready' | 'notReady';

const STATUS_PILLS = {
  notSaved: { tone: 'neutral', icon: MinusSignCircleIcon },
  ready: { tone: 'good', icon: CheckmarkCircle02Icon },
  notReady: { tone: 'warn', icon: Alert02Icon },
} as const satisfies Record<
  GatewayStatus,
  { tone: 'neutral' | 'good' | 'warn'; icon: IconSvgElement }
>;

// A saved account that is no longer offered (archived, or no longer a money or an expense
// account) starts empty, so the select never shows a value it has no option for, and the box says
// to pick another one
function choiceOrEmpty(id: string, choices: readonly StorefrontAccountChoice[]): string {
  return choices.some((choice) => choice.id === id) ? id : '';
}

function formValues(setup: StorefrontPaymentSetup) {
  const gateway = setup.gateway;
  return {
    storeId: gateway?.storeId ?? '',
    mode: gateway?.mode ?? 'sandbox',
    password: '',
    moneyAccountId: gateway ? choiceOrEmpty(gateway.moneyAccountId, setup.moneyAccounts) : '',
    feeAccountId: gateway ? choiceOrEmpty(gateway.feeAccountId, setup.feeAccounts) : '',
    version: gateway?.version ?? 0,
  };
}

// The last test, in the footer's left. Each answer in its own colour and with its own icon, so the
// colour is never the only sign
function TestLine({ gateway, dirty }: { gateway: StorefrontPaymentGateway; dirty: boolean }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const line = (tone: string, icon: IconSvgElement, text: string) => (
    <p className={cn('flex items-start gap-1.5 text-label', tone)}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
  if (dirty)
    return line('text-ink-3', InformationCircleIcon, t('storefront.gateway.testSaveFirst'));
  const test = gateway.lastTest;
  if (test === null)
    return line('text-ink-3', InformationCircleIcon, t('storefront.gateway.neverTested'));
  const date = format.dateTime(new Date(test.at), timeZone);
  switch (test.problem) {
    case null:
      return line('text-good', CheckmarkCircle02Icon, t('storefront.gateway.testWorked', { date }));
    case 'rejected':
      return line('text-crit', Alert02Icon, t('storefront.gateway.testRejected', { date }));
    case 'unreachable':
      return line('text-warn', Alert02Icon, t('storefront.gateway.testUnreachable', { date }));
  }
}

export function GatewayCard({
  setup,
  onSaved,
}: {
  setup: StorefrontPaymentSetup;
  // The page puts the answer in its cache: the Payment card's "Pay online" box reads `ready`
  onSaved: (gateway: StorefrontPaymentGateway) => void;
}) {
  const { t } = useLocale();
  const gateway = setup.gateway;
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver:
      gateway === null
        ? zodResolver(FIRST_SAVE_SCHEMA, { error: contractErrorMap })
        : zodResolver(updateStorefrontPaymentGatewayInputSchema, { error: contractErrorMap }),
    defaultValues: formValues(setup),
  });

  // A saved account that no longer fits started empty (formValues): say so under its box at once,
  // with the same words the API would answer on a save
  useEffect(() => {
    if (gateway === null) return;
    if (!setup.moneyAccounts.some((choice) => choice.id === gateway.moneyAccountId)) {
      setError('moneyAccountId', { message: 'storefront_gateway_money_account_invalid' });
    }
    if (!setup.feeAccounts.some((choice) => choice.id === gateway.feeAccountId)) {
      setError('feeAccountId', { message: 'storefront_gateway_fee_account_invalid' });
    }
  }, [gateway, setup.moneyAccounts, setup.feeAccounts, setError]);

  const test = useMutation({
    mutationFn: () => call(routes.storefrontPayments.testPaymentGateway),
    onSuccess: onSaved,
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { version, ...fields } = values;
      const saved =
        gateway === null
          ? await call(routes.storefrontPayments.createPaymentGateway, { body: fields })
          : await call(routes.storefrontPayments.updatePaymentGateway, {
              body: { ...fields, version },
            });
      test.reset();
      onSaved(saved);
      toast(t(gateway === null ? 'storefront.gateway.created' : 'storefront.gateway.updated'));
      // The page's key starts the card again from the new version; this reset is for the moment
      // in between, so the save bar does not flash back
      reset(formValues({ ...setup, gateway: saved }));
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const status: GatewayStatus =
    gateway === null ? 'notSaved' : gateway.ready ? 'ready' : 'notReady';
  const pill = STATUS_PILLS[status];
  const accountOptions = (choices: readonly StorefrontAccountChoice[], placeholder: string) => [
    { value: '', label: placeholder },
    ...choices.map((choice) => ({
      value: choice.id,
      label: t('storefront.gateway.accountOption', { code: choice.code, name: choice.name }),
    })),
  ];
  const serverError = errors.root?.server?.message;
  const testError =
    test.error instanceof ApiRequestError ? test.error.code : test.error ? 'unknown_error' : null;

  return (
    <Card>
      <form
        id="storefront-gateway"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        aria-label={t('storefront.gateway.title')}
      >
        <div className="flex items-start justify-between gap-4">
          <CardHeader
            title={t('storefront.gateway.title')}
            subtitle={t('storefront.gateway.description')}
          />
          {/* The card header's own padding on the right, its top line */}
          <span className="shrink-0 pt-[18px] pr-5">
            <Pill tone={pill.tone} icon={pill.icon}>
              {t(`storefront.gateway.statuses.${status}`)}
            </Pill>
          </span>
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          {status === 'notReady' && (
            <div className="sm:col-span-2">
              <DocumentNotice tone="warn" icon={Alert02Icon}>
                {t('storefront.gateway.notReady')}
              </DocumentNotice>
            </div>
          )}
          {serverError !== undefined && (
            <div className="sm:col-span-2">
              <FormAlert message={serverError} />
            </div>
          )}
          {/* One gateway for now (PAYMENT_GATEWAY_PROVIDERS), so a fact, not a select */}
          <p className="flex items-baseline gap-3 sm:col-span-2">
            <span className="text-label font-medium text-ink">
              {t('storefront.gateway.provider')}
            </span>
            <span className="text-body text-ink-2">
              {t(`storefront.gateway.providers.${gateway?.provider ?? 'sslcommerz'}`)}
            </span>
          </p>
          <div className="sm:col-span-2">
            <Controller
              control={control}
              name="mode"
              render={({ field }) => (
                <Field
                  id="gateway-mode"
                  label={t('storefront.gateway.mode')}
                  hint={t('storefront.gateway.modeHint')}
                  error={errors.mode?.message}
                >
                  <div>
                    <SegmentedControl
                      label={t('storefront.gateway.mode')}
                      value={field.value}
                      options={PAYMENT_GATEWAY_MODES.map((value) => ({
                        value,
                        label: t(`storefront.gateway.modes.${value}`),
                      }))}
                      onChange={(next: PaymentGatewayMode) => {
                        field.onChange(next);
                      }}
                    />
                  </div>
                </Field>
              )}
            />
          </div>
          <TextField
            label={t('storefront.gateway.storeId')}
            icon={Store01Icon}
            placeholder={t('storefront.gateway.storeIdPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            hint={t('storefront.gateway.storeIdHint')}
            {...register('storeId')}
            error={errors.storeId?.message}
          />
          {/* new-password: the browser must not fill in the member's own Omnivo password here */}
          <TextField
            label={t('storefront.gateway.password')}
            icon={LockKeyholeIcon}
            type="password"
            autoComplete="new-password"
            placeholder={
              gateway === null ? undefined : t('storefront.gateway.passwordSavedPlaceholder')
            }
            hint={
              gateway === null
                ? t('storefront.gateway.passwordHint')
                : t('storefront.gateway.passwordSavedHint')
            }
            {...register('password')}
            error={errors.password?.message}
          />
          <SelectField
            label={t('storefront.gateway.moneyAccount')}
            icon={Wallet01Icon}
            options={accountOptions(
              setup.moneyAccounts,
              t('storefront.gateway.moneyAccountPlaceholder'),
            )}
            hint={
              setup.moneyAccounts.length === 0
                ? t('storefront.gateway.noMoneyAccounts')
                : t('storefront.gateway.moneyAccountHint')
            }
            {...register('moneyAccountId')}
            error={errors.moneyAccountId?.message}
          />
          <SelectField
            label={t('storefront.gateway.feeAccount')}
            icon={Coins01Icon}
            options={accountOptions(
              setup.feeAccounts,
              t('storefront.gateway.feeAccountPlaceholder'),
            )}
            hint={
              setup.feeAccounts.length === 0
                ? t('storefront.gateway.noFeeAccounts')
                : t('storefront.gateway.feeAccountHint')
            }
            {...register('feeAccountId')}
            error={errors.feeAccountId?.message}
          />
        </div>
        {/* The footer: the last test on the left, the buttons on the right. Before the first save
            there is nothing to test, so only "Save gateway" */}
        <footer className="grid gap-3 border-t border-line px-5 py-4 sm:flex sm:items-center sm:justify-between">
          <div className="grid min-w-0 gap-2">
            {gateway !== null && <TestLine gateway={gateway} dirty={isDirty} />}
            {testError !== null && <FormAlert message={testError} />}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {gateway !== null && (
              <Button
                variant="secondary"
                disabled={isDirty || test.isPending}
                onClick={() => {
                  test.mutate();
                }}
              >
                <HugeiconsIcon icon={Plug01Icon} size={17} strokeWidth={1.5} />
                {test.isPending ? t('storefront.gateway.testing') : t('storefront.gateway.test')}
              </Button>
            )}
            {gateway !== null && isDirty && (
              <Button
                variant="secondary"
                onClick={() => {
                  reset();
                }}
              >
                {t('storefront.discard')}
              </Button>
            )}
            {(gateway === null || isDirty) && (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : gateway === null
                    ? t('storefront.gateway.create')
                    : t('common.save')}
              </Button>
            )}
          </div>
        </footer>
      </form>
    </Card>
  );
}
