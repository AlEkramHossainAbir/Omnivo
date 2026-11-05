import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  PercentIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  TAX_RATE_KINDS,
  type TaxRate,
  type TaxRateKind,
  updateTaxRateInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { taxRatesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { plainRate, useRateText } from '../lib/tax-rates';
import { failureOf } from './journal-parts';

// Settings → VAT rates (step 15a): a card on the settings page, not a page of its own — a
// workspace has a handful of rates and changes them when the NBR does. Each rate is saved by its
// own dialog, apart from the company settings above.

const FIELD_NAMES = updateTaxRateInputSchema.keyof().options;

function isKind(value: string): value is TaxRateKind {
  return TAX_RATE_KINDS.some((kind) => kind === value);
}

// The two kinds that charge nothing
const ZERO_KINDS: readonly TaxRateKind[] = ['zero_rated', 'exempt'];

function RateForm({ rate, onDone }: { rate: TaxRate | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateTaxRateInputSchema, { error: contractErrorMap }),
    defaultValues: {
      name: rate?.name ?? '',
      kind: rate && isKind(rate.kind) ? rate.kind : 'standard',
      // "7.50" reads "7.5" in the box
      rate: rate ? plainRate(rate.rate) : '',
      isDefault: rate?.isDefault ?? false,
      version: rate?.version ?? 1,
    },
  });
  const kind = useWatch({ control, name: 'kind' });
  // The default is moved by making another rate the default, never switched off (the server
  // refuses it: one rate is always the default)
  const lockedDefault = rate?.isDefault === true;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tax-rates', tenantId] });

  const toggle = useMutation({
    mutationFn: (current: TaxRate) =>
      call(current.archivedAt === null ? routes.taxRates.archive : routes.taxRates.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'taxRates.restoredToast' : 'taxRates.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = rate
        ? await call(routes.taxRates.update, {
            params: { id: rate.id },
            body: { ...values, version },
          })
        : await call(routes.taxRates.create, { body: values });
      // A new default takes the flag from the old one: the whole list refetches
      await refresh();
      toast(t(rate ? 'taxRates.updated' : 'taxRates.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // tax_rate_default_archived, version_conflict: they belong to no field
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={rate ? t('taxRates.editTitle', { name: rate.name }) : t('taxRates.newTitle')}
      footer={
        <>
          {rate && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(rate);
              }}
            >
              {rate.archivedAt === null ? t('taxRates.archive') : t('taxRates.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="tax-rate-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : rate ? t('common.save') : t('taxRates.add')}
          </Button>
        </>
      }
    >
      <form
        id="tax-rate-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('taxRates.name')}
          placeholder={t('taxRates.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_9rem] sm:gap-x-4">
          <SelectField
            label={t('taxRates.kind')}
            hint={t(`taxRates.kindHints.${kind}`)}
            options={TAX_RATE_KINDS.map((value) => ({
              value,
              label: t(`taxRates.kinds.${value}`),
            }))}
            {...register('kind', {
              // Zero-rated and exempt are always 0%; moving away from them empties the box, so
              // a "standard 0%" is never saved by accident
              onChange: () => {
                const next = getValues('kind');
                if (ZERO_KINDS.includes(next)) setValue('rate', '0');
                else if (getValues('rate') === '0') setValue('rate', '');
              },
            })}
            error={errors.kind?.message}
          />
          <TextField
            label={t('taxRates.rate')}
            hint={t('taxRates.rateHint')}
            inputMode="decimal"
            suffix="%"
            readOnly={ZERO_KINDS.includes(kind)}
            {...register('rate')}
            error={errors.rate?.message}
          />
        </div>
        <div className="grid gap-2">
          <Controller
            control={control}
            name="isDefault"
            render={({ field }) => (
              <Checkbox
                id="isDefault"
                label={t('taxRates.makeDefault')}
                checked={field.value}
                disabled={lockedDefault}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
              />
            )}
          />
          {lockedDefault && (
            <p className="pl-[27px] text-label text-ink-3">{t('taxRates.defaultLocked')}</p>
          )}
        </div>
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | TaxRate;

export function TaxRatesCard({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const { t } = useLocale();
  const rateText = useRateText();
  const [editing, setEditing] = useState<Editing>(null);
  const { data: rates, isError } = useQuery(taxRatesQuery(tenantId));

  return (
    <Card>
      <CardHeader
        title={t('taxRates.title')}
        subtitle={t('taxRates.subtitle')}
        actions={
          canManage && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('taxRates.add')}
            </Button>
          )
        }
      />
      <div className="p-5 pt-4">
        {isError && <p className="text-body-sm text-crit">{t('taxRates.loadFailed')}</p>}
        {rates?.length === 0 && (
          <EmptyState
            icon={PercentIcon}
            title={t('taxRates.emptyTitle')}
            description={t('taxRates.emptyBody')}
          />
        )}
        {rates && rates.length > 0 && (
          <ul className="grid grid-cols-1 divide-y divide-line overflow-hidden rounded-control border border-line">
            {rates.map((rate) => {
              const content = (
                <>
                  <span className="grid min-w-0 flex-1 text-left">
                    <span className="truncate text-body-sm font-medium text-ink">{rate.name}</span>
                    <span className="truncate text-caption text-ink-3">
                      {isKind(rate.kind) ? t(`taxRates.kinds.${rate.kind}`) : rate.kind}
                    </span>
                  </span>
                  {rate.isDefault && (
                    <Pill tone="brand" icon={CheckmarkCircle02Icon}>
                      {t('taxRates.default')}
                    </Pill>
                  )}
                  {rate.archivedAt !== null && (
                    <Pill tone="neutral" icon={Archive02Icon}>
                      {t('taxRates.archived')}
                    </Pill>
                  )}
                  <span className="w-16 text-right text-body-sm font-medium tabular-nums">
                    {rateText(rate.rate)}
                  </span>
                </>
              );
              return (
                <li key={rate.id}>
                  {canManage ? (
                    // A real button: the whole row opens the rate, by mouse or keyboard
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-subtle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                      onClick={() => {
                        setEditing(rate);
                      }}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <RateForm
            key={editing === 'new' ? 'new' : editing.id}
            rate={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}
