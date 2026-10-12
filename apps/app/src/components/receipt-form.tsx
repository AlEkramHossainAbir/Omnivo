import { Calendar03Icon, UserIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  amountDueOf,
  contractErrorMap,
  type Invoice,
  moneyAccountIds,
  type PartyRef,
  PAYMENT_METHODS,
  plainQuantity,
  receiptInputSchema,
  type ReceiptFormValues,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
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
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { allocationRows } from '../lib/invoices';
import { rowPath } from '../lib/products';
import { accountsQuery, branchesQuery, openInvoicesQuery } from '../lib/queries';
import { AllocationTable } from './allocation-table';
import { CreditLine } from './credit-parts';
import { SalesBackLink, useSalesRefresh } from './sales-parts';
import { useTenantId } from './stock-parts';

// The money receipt form (step 15c): its own chunk, loaded by routes/receipt.tsx. A receipt is
// never a draft: saving it posts it, so there is only this form for a new one.

// Both bring the popover; the delivery form says why that matters for the chunk
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = ReceiptFormValues;

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'amount',
    'accountId',
    'method',
    'reference',
    'branchId',
    'note',
    'allocations',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('allocations', index, 'invoiceId'),
      rowPath('allocations', index, 'amount'),
    ]).flat(),
  ];
}

export function ReceiptForm({
  customer: startCustomer,
  invoice,
  today,
}: {
  // "Record payment" on a customer's page
  customer: PartyRef | null;
  // "Record payment" on an invoice: its customer, what it still owes, applied to it
  invoice: Invoice | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  // The accounts money goes into: the contracts' own list, the one the API checks against
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id))
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts]);
  const savedCustomer = invoice?.customer ?? startCustomer;
  const due = invoice ? plainQuantity(amountDueOf(invoice)) : '';
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(receiptInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      date: today,
      amount: due,
      // One cash box or bank account needs no choice
      accountId: moneyAccounts.length === 1 ? (moneyAccounts[0]?.id ?? '') : '',
      method: 'cash',
      reference: '',
      branchId: invoice?.branchId ?? (branches.length === 1 ? (branches[0]?.id ?? '') : ''),
      note: '',
      allocations: invoice ? [{ invoiceId: invoice.id, amount: due }] : [],
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const amount = useWatch({ control, name: 'amount' });
  const method = useWatch({ control, name: 'method' });
  const { data: open } = useQuery({
    ...openInvoicesQuery(tenantId, customerId),
    enabled: customerId !== '',
  });
  const rows = useMemo(() => allocationRows(open ?? [], []), [open]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.receipts.create, { body: values });
      await refresh();
      toast(t('receipts.saved', { number: saved.number }));
      void navigate({
        to: '/receipts/$receiptId',
        params: { receiptId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(getValues('allocations').length), setError);
    }
  });

  const failure = errors.root?.server?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/receipts" label={t('receipts.back')} />
      <PageHeader title={t('receipts.newTitle')} description={t('receipts.description')} />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <FormField control={control} name="customerId" label={t('receipts.customer')}>
              {(field) => (
                <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                  <CustomerPicker
                    {...field}
                    saved={savedCustomer}
                    onChange={(next) => {
                      setValue('customerId', next, {
                        shouldValidate: errors.customerId !== undefined,
                      });
                      // Another customer's invoices are not this one's to pay
                      setValue('allocations', []);
                    }}
                  />
                </Suspense>
              )}
            </FormField>
            <CreditLine customerId={customerId} />
          </div>
          <FormField control={control} name="date" label={t('receipts.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="amount" label={t('receipts.amount')}>
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <SelectField
            label={t('receipts.account')}
            hint={moneyAccounts.length === 0 ? t('receipts.noAccounts') : t('receipts.accountHint')}
            disabled={moneyAccounts.length === 0}
            options={[
              { value: '', label: t('receipts.accountPlaceholder') },
              ...moneyAccounts.map((account) => ({
                value: account.id,
                label: `${account.code} · ${account.name}`,
              })),
            ]}
            {...register('accountId')}
            error={errors.accountId?.message}
          />
          <SelectField
            label={t('receipts.method')}
            options={PAYMENT_METHODS.map((value) => ({
              value,
              label: t(`receipts.methods.${value}`),
            }))}
            {...register('method')}
            error={errors.method?.message}
          />
          <TextField
            label={t('receipts.reference')}
            optional
            // How this kind of payment is usually written down: the cheque, the TrxID
            placeholder={t(`receipts.referencePlaceholders.${method}`)}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <SelectField
            label={t('receipts.branch')}
            options={[
              { value: '', label: t('receipts.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <div className="sm:col-span-2">
            <TextField
              label={t('receipts.note')}
              optional
              placeholder={t('receipts.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={t('receipts.applyTitle')} subtitle={t('receipts.applySubtitle')} />
          <Controller
            control={control}
            name="allocations"
            render={({ field }) => (
              <AllocationTable
                rows={rows}
                value={field.value}
                onChange={field.onChange}
                amount={amount}
                errors={errors.allocations}
                empty={
                  customerId === '' ? t('receipts.pickCustomer') : t('receipts.noOpenInvoices')
                }
              />
            )}
          />
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('receipts.saving') : t('receipts.save')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('receipts.saveHint')}</p>
      </form>
    </div>
  );
}
