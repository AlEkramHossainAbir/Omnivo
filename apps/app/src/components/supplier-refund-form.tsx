import { Calendar03Icon, UserIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  moneyAccountIds,
  type PartyRef,
  PAYMENT_METHODS,
  plainQuantity,
  routes,
  supplierRefundInputSchema,
  type SupplierRefundFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  FormAlert,
  FormField,
  Input,
  MoneyInput,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useMemo } from 'react';
import { type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  supplierRefundSourcesOf,
  type SupplierRefundSourceOption,
  supplierSourceFields,
  supplierSourceKeyOf,
} from '../lib/purchase-returns';
import { accountsQuery, branchesQuery, supplierRefundSourcesQuery } from '../lib/queries';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { useTenantId } from './stock-parts';

// The supplier refund form (step 17d): its own chunk, loaded by routes/supplier-refund.tsx. The
// customer's refund of 15d the other way round: money comes in. Like it, a supplier refund is never
// a draft: saving it posts it, so there is only this form for a new one.

// Both bring the popover; the delivery form says why that matters for the chunk
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = SupplierRefundFormValues;

const FIELD_NAMES: Path<FormValues>[] = [
  'supplierId',
  'date',
  'amount',
  'accountId',
  'method',
  'reference',
  'branchId',
  'note',
  'debitNoteId',
  'paymentId',
];

export function SupplierRefundForm({
  supplier: startSupplier,
  source: startSource,
  today,
}: {
  // "Record money back" on a debit note or a payment: its supplier, and it as the source
  supplier: PartyRef | null;
  source: SupplierRefundSourceOption | null;
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = usePurchaseRefresh();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  // The accounts money comes into: the contracts' own list, the one the API checks against
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id))
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts]);
  // The source's branch, when it is still active; otherwise the only branch, or none
  const branchOf = (source: SupplierRefundSourceOption | null): string =>
    source !== null && branches.some((branch) => branch.id === source.branchId)
      ? source.branchId
      : branches.length === 1
        ? (branches[0]?.id ?? '')
        : '';
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(supplierRefundInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: startSupplier?.id ?? '',
      date: today,
      amount: startSource ? plainQuantity(startSource.left) : '',
      // One cash box or bank account needs no choice
      accountId: moneyAccounts.length === 1 ? (moneyAccounts[0]?.id ?? '') : '',
      method: 'cash',
      reference: '',
      branchId: branchOf(startSource),
      note: '',
      ...(startSource
        ? supplierSourceFields(supplierSourceKeyOf(startSource))
        : supplierSourceFields('')),
    },
  });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const method = useWatch({ control, name: 'method' });
  const debitNoteId = useWatch({ control, name: 'debitNoteId' }) ?? '';
  const paymentId = useWatch({ control, name: 'paymentId' }) ?? '';
  const { data: found } = useQuery({
    ...supplierRefundSourcesQuery(tenantId, supplierId),
    enabled: supplierId !== '',
    select: (lists) => supplierRefundSourcesOf(lists.debitNotes, lists.payments),
  });
  // The supplier's sources with money left, and the one the form started from when the list did
  // not read that far back (it reads the newest 100 of each)
  const sources = [
    ...(found ?? []),
    ...(startSource !== null &&
    supplierId === startSupplier?.id &&
    !(found ?? []).some((source) => source.id === startSource.id)
      ? [startSource]
      : []),
  ];
  const chosenKey =
    debitNoteId !== ''
      ? supplierSourceKeyOf({ type: 'debit_note', id: debitNoteId })
      : paymentId !== ''
        ? supplierSourceKeyOf({ type: 'supplier_payment', id: paymentId })
        : '';
  const chosen = sources.find((source) => supplierSourceKeyOf(source) === chosenKey) ?? null;
  const money = (value: string) => format.money(value, { decimals: 2 });

  // Another source: its two boxes, what it has left as the amount, and its branch
  const changeSource = (key: string) => {
    const fields = supplierSourceFields(key);
    setValue('debitNoteId', fields.debitNoteId, {
      shouldValidate: errors.debitNoteId !== undefined,
    });
    setValue('paymentId', fields.paymentId);
    const picked = sources.find((source) => supplierSourceKeyOf(source) === key);
    if (!picked) return;
    setValue('amount', plainQuantity(picked.left));
    setValue('branchId', branchOf(picked));
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.supplierRefunds.create, { body: values });
      await refresh();
      toast(t('supplierRefunds.saved', { number: saved.number }));
      void navigate({
        to: '/supplier-refunds/$refundId',
        params: { refundId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  const failure = errors.root?.server?.message;
  // Neither or both (supplier_refund_source), or not this supplier's: the contract puts it on
  // debitNoteId
  const sourceError = errors.debitNoteId?.message ?? errors.paymentId?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/supplier-refunds" label={t('supplierRefunds.back')} />
      <PageHeader
        title={t('supplierRefunds.newTitle')}
        description={t('supplierRefunds.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField control={control} name="supplierId" label={t('supplierRefunds.supplier')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={startSupplier}
                  onChange={(next) => {
                    setValue('supplierId', next, {
                      shouldValidate: errors.supplierId !== undefined,
                    });
                    // Another supplier's money is not this one's to take back
                    changeSource('');
                  }}
                />
              </Suspense>
            )}
          </FormField>
          <div className="sm:col-span-2">
            <SelectField
              label={t('supplierRefunds.source')}
              hint={
                supplierId === ''
                  ? t('supplierRefunds.pickSupplier')
                  : found !== undefined && sources.length === 0
                    ? t('supplierRefunds.noSources')
                    : t('supplierRefunds.sourceHint')
              }
              disabled={supplierId === '' || sources.length === 0}
              options={[
                { value: '', label: t('supplierRefunds.sourcePlaceholder') },
                ...sources.map((source) => ({
                  value: supplierSourceKeyOf(source),
                  label: `${t(`supplierRefunds.sources.${source.type}`)} ${t(
                    'supplierRefunds.sourceOption',
                    {
                      number: source.number,
                      amount: money(source.left),
                    },
                  )}`,
                })),
              ]}
              value={chosenKey}
              onChange={(event) => {
                changeSource(event.target.value);
              }}
              error={sourceError}
            />
          </div>
          <FormField
            control={control}
            name="amount"
            label={t('supplierRefunds.amount')}
            hint={
              chosen
                ? t('supplierRefunds.amountHint', {
                    amount: money(chosen.left),
                    number: chosen.number,
                  })
                : undefined
            }
          >
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <FormField control={control} name="date" label={t('supplierRefunds.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('supplierRefunds.account')}
            hint={
              moneyAccounts.length === 0
                ? t('receipts.noAccounts')
                : t('supplierRefunds.accountHint')
            }
            disabled={moneyAccounts.length === 0}
            options={[
              { value: '', label: t('supplierRefunds.accountPlaceholder') },
              ...moneyAccounts.map((account) => ({
                value: account.id,
                label: `${account.code} · ${account.name}`,
              })),
            ]}
            {...register('accountId')}
            error={errors.accountId?.message}
          />
          <SelectField
            label={t('supplierRefunds.method')}
            options={PAYMENT_METHODS.map((value) => ({
              value,
              label: t(`receipts.methods.${value}`),
            }))}
            {...register('method')}
            error={errors.method?.message}
          />
          <TextField
            label={t('supplierRefunds.reference')}
            optional
            // How money coming in from a supplier is usually written down
            placeholder={t(`supplierRefunds.referencePlaceholders.${method}`)}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <SelectField
            label={t('supplierRefunds.branch')}
            options={[
              { value: '', label: t('supplierRefunds.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('supplierRefunds.note')}
              optional
              placeholder={t('supplierRefunds.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('supplierRefunds.saving') : t('supplierRefunds.save')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('supplierRefunds.saveHint')}</p>
      </form>
    </div>
  );
}
