import { Calendar03Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type PaymentAllocationsFormValues,
  paymentAllocationsInputSchema,
  plainQuantity,
  routes,
  type SupplierPayment,
  voidSupplierPaymentInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  Input,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo } from 'react';
import { Controller, type Path, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { billAllocationRows } from '../lib/bills';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { openBillsQuery, supplierPaymentQuery } from '../lib/queries';
import { AllocationTable, BILL_SIDE } from './allocation-table';
import { usePurchaseRefresh } from './purchase-parts';
import { useTenantId } from './stock-parts';

// The dialogs of a posted supplier payment (step 17c), a lazy chunk of their own like the money
// receipt's (money-dialogs.tsx): "Apply money" and "Void payment". Here, not in money-dialogs.tsx:
// those refresh the sales documents and check the receipt's error codes; these refresh the
// purchase documents and check the payment's.

const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// "Apply money": where a posted payment's money goes, the whole list at once (decision 23: no
// approval, the money left already). An advance paid before its bill came is applied here.
export function PaymentApplyForm({
  payment,
  onDone,
}: {
  payment: SupplierPayment;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const { data: open } = useQuery(openBillsQuery(tenantId, payment.supplier.id));
  // Posted: its own amounts are in the bills' amountPaid, so they count back in, and a bill it
  // paid in full stays on the list
  const rows = useMemo(
    () => billAllocationRows(open ?? [], payment.allocations, true),
    [open, payment.allocations],
  );
  const {
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(paymentAllocationsInputSchema, { error: contractErrorMap }),
    defaultValues: {
      version: payment.version,
      allocations: payment.allocations.map((allocation) => ({
        billId: allocation.billId,
        amount: plainQuantity(allocation.amount),
      })),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.supplierPayments.allocate, {
        params: { id: payment.id },
        body: values,
      });
      queryClient.setQueryData(supplierPaymentQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t('supplierPayments.allocated', { number: saved.number ?? '' }));
      onDone();
    } catch (error) {
      const count = getValues('allocations').length;
      const names: Path<PaymentAllocationsFormValues>[] = [
        'allocations',
        ...Array.from({ length: count }, (_, index) => [
          rowPath('allocations', index, 'billId'),
          rowPath('allocations', index, 'amount'),
        ]).flat(),
      ];
      applyApiError(error, names, setError);
    }
  });

  return (
    <DialogContent
      title={t('supplierPayments.applyDialogTitle', { number: payment.number ?? '' })}
      description={t('supplierPayments.applySubtitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="payment-apply-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('supplierPayments.applySave')}
          </Button>
        </>
      }
    >
      <form id="payment-apply-form" noValidate onSubmit={(event) => void onSubmit(event)}>
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* The table's own padding is a card's; the dialog has its own, so it runs edge to edge */}
        <div className="-mx-[18px] sm:-mx-6">
          <Controller
            control={control}
            name="allocations"
            render={({ field }) => (
              <AllocationTable
                side={BILL_SIDE}
                rows={rows}
                value={field.value}
                onChange={field.onChange}
                amount={payment.amount}
                errors={{
                  list: errors.allocations?.root?.message ?? errors.allocations?.message,
                  row: (index) =>
                    errors.allocations?.[index]?.amount?.message ??
                    errors.allocations?.[index]?.billId?.message,
                }}
                empty={t('supplierPayments.noOpenBills')}
              />
            )}
          />
        </div>
      </form>
    </DialogContent>
  );
}

// "Void payment": the date the money turned out not to have gone (a stopped cheque, a transfer the
// bank sent back), and why. Its entry is reversed on that date and its money comes off the bills.
export function PaymentVoidForm({
  payment,
  today,
  onDone,
}: {
  payment: SupplierPayment;
  today: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const number = payment.number ?? '';
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(voidSupplierPaymentInputSchema, { error: contractErrorMap }),
    defaultValues: { version: payment.version, date: today, reason: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.supplierPayments.void, {
        params: { id: payment.id },
        body: values,
      });
      queryClient.setQueryData(supplierPaymentQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t('supplierPayments.voided', { number }));
      onDone();
    } catch (error) {
      applyApiError(error, ['date', 'reason'], setError);
    }
  });

  return (
    <DialogContent
      title={t('supplierPayments.voidTitle', { number })}
      description={t('supplierPayments.voidBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('supplierPayments.keepPayment')}</Button>
          </DialogClose>
          <Button type="submit" form="payment-void-form" disabled={isSubmitting}>
            {t('supplierPayments.confirmVoid')}
          </Button>
        </>
      }
    >
      <form
        id="payment-void-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <FormField
          control={control}
          name="date"
          label={t('supplierPayments.voidDate')}
          hint={t('supplierPayments.voidDateHint')}
        >
          {(field) => (
            <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
              <DatePicker {...field} />
            </Suspense>
          )}
        </FormField>
        <TextField
          label={t('supplierPayments.voidReason')}
          placeholder={t('supplierPayments.voidReasonPlaceholder')}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
