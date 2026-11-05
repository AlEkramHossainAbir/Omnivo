import { Calendar03Icon, UserIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  moneyAccountIds,
  type PartyRef,
  PAYMENT_METHODS,
  plainQuantity,
  refundInputSchema,
  type RefundFormValues,
  routes,
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
import { accountsQuery, branchesQuery, refundSourcesQuery } from '../lib/queries';
import {
  refundSourcesOf,
  type RefundSourceOption,
  sourceFields,
  sourceKeyOf,
} from '../lib/returns';
import { SalesBackLink, useSalesRefresh } from './sales-parts';
import { useTenantId } from './stock-parts';

// The refund form (step 15d): its own chunk, loaded by routes/refund.tsx. Like a money receipt,
// a refund is never a draft: saving it posts it, so there is only this form for a new one.

// Both bring the popover; the delivery form says why that matters for the chunk
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = RefundFormValues;

const FIELD_NAMES: Path<FormValues>[] = [
  'customerId',
  'date',
  'amount',
  'accountId',
  'method',
  'reference',
  'branchId',
  'note',
  'receiptId',
  'creditNoteId',
];

export function RefundForm({
  customer: startCustomer,
  source: startSource,
  today,
}: {
  // "Pay back" on a receipt or a credit note: its customer, and it as the source
  customer: PartyRef | null;
  source: RefundSourceOption | null;
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  // The accounts money leaves from: the contracts' own list, the one the API checks against
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id))
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts]);
  // The source's branch, when it is still active; otherwise the only branch, or none
  const branchOf = (source: RefundSourceOption | null): string =>
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
    resolver: zodResolver(refundInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: startCustomer?.id ?? '',
      date: today,
      amount: startSource ? plainQuantity(startSource.left) : '',
      // One cash box or bank account needs no choice
      accountId: moneyAccounts.length === 1 ? (moneyAccounts[0]?.id ?? '') : '',
      method: 'cash',
      reference: '',
      branchId: branchOf(startSource),
      note: '',
      ...(startSource ? sourceFields(sourceKeyOf(startSource)) : sourceFields('')),
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const method = useWatch({ control, name: 'method' });
  const receiptId = useWatch({ control, name: 'receiptId' }) ?? '';
  const creditNoteId = useWatch({ control, name: 'creditNoteId' }) ?? '';
  const { data: found } = useQuery({
    ...refundSourcesQuery(tenantId, customerId),
    enabled: customerId !== '',
    select: (lists) => refundSourcesOf(lists.receipts, lists.creditNotes),
  });
  // The customer's sources with money left, and the one the form started from when the list did
  // not read that far back (it reads the newest 100 of each)
  const sources = [
    ...(found ?? []),
    ...(startSource !== null &&
    customerId === startCustomer?.id &&
    !(found ?? []).some((source) => source.id === startSource.id)
      ? [startSource]
      : []),
  ];
  const chosenKey =
    receiptId !== ''
      ? sourceKeyOf({ type: 'receipt', id: receiptId })
      : creditNoteId !== ''
        ? sourceKeyOf({ type: 'credit_note', id: creditNoteId })
        : '';
  const chosen = sources.find((source) => sourceKeyOf(source) === chosenKey) ?? null;
  const money = (value: string) => format.money(value, { decimals: 2 });

  // Another source: its two boxes, what it has left as the amount, and its branch
  const changeSource = (key: string) => {
    const fields = sourceFields(key);
    setValue('receiptId', fields.receiptId, { shouldValidate: errors.receiptId !== undefined });
    setValue('creditNoteId', fields.creditNoteId);
    const picked = sources.find((source) => sourceKeyOf(source) === key);
    if (!picked) return;
    setValue('amount', plainQuantity(picked.left));
    setValue('branchId', branchOf(picked));
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.refunds.create, { body: values });
      await refresh();
      toast(t('refunds.saved', { number: saved.number }));
      void navigate({ to: '/refunds/$refundId', params: { refundId: saved.id }, replace: true });
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  const failure = errors.root?.server?.message;
  // Neither or both (refund_source), or not this customer's: the contract puts it on receiptId
  const sourceError = errors.receiptId?.message ?? errors.creditNoteId?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/refunds" label={t('refunds.back')} />
      <PageHeader title={t('refunds.newTitle')} description={t('refunds.description')} />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField control={control} name="customerId" label={t('refunds.customer')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <CustomerPicker
                  {...field}
                  saved={startCustomer}
                  onChange={(next) => {
                    setValue('customerId', next, {
                      shouldValidate: errors.customerId !== undefined,
                    });
                    // Another customer's money is not this one's to pay back
                    changeSource('');
                  }}
                />
              </Suspense>
            )}
          </FormField>
          <div className="sm:col-span-2">
            <SelectField
              label={t('refunds.source')}
              hint={
                customerId === ''
                  ? t('refunds.pickCustomer')
                  : found !== undefined && sources.length === 0
                    ? t('refunds.noSources')
                    : t('refunds.sourceHint')
              }
              disabled={customerId === '' || sources.length === 0}
              options={[
                { value: '', label: t('refunds.sourcePlaceholder') },
                ...sources.map((source) => ({
                  value: sourceKeyOf(source),
                  label: `${t(`refunds.sources.${source.type}`)} ${t('refunds.sourceOption', {
                    number: source.number,
                    amount: money(source.left),
                  })}`,
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
            label={t('refunds.amount')}
            hint={
              chosen
                ? t('refunds.amountHint', { amount: money(chosen.left), number: chosen.number })
                : undefined
            }
          >
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <FormField control={control} name="date" label={t('refunds.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('refunds.account')}
            hint={moneyAccounts.length === 0 ? t('receipts.noAccounts') : t('refunds.accountHint')}
            disabled={moneyAccounts.length === 0}
            options={[
              { value: '', label: t('refunds.accountPlaceholder') },
              ...moneyAccounts.map((account) => ({
                value: account.id,
                label: `${account.code} · ${account.name}`,
              })),
            ]}
            {...register('accountId')}
            error={errors.accountId?.message}
          />
          <SelectField
            label={t('refunds.method')}
            options={PAYMENT_METHODS.map((value) => ({
              value,
              label: t(`receipts.methods.${value}`),
            }))}
            {...register('method')}
            error={errors.method?.message}
          />
          <TextField
            label={t('refunds.reference')}
            optional
            // How this kind of payment out is usually written down
            placeholder={t(`refunds.referencePlaceholders.${method}`)}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <SelectField
            label={t('refunds.branch')}
            options={[
              { value: '', label: t('refunds.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('refunds.note')}
              optional
              placeholder={t('refunds.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('refunds.saving') : t('refunds.save')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('refunds.saveHint')}</p>
      </form>
    </div>
  );
}
