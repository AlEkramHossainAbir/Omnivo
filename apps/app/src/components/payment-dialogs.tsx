import { Calendar03Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  debitNoteAllocationsInputSchema,
  type PaymentAllocation,
  type PaymentAllocationsFormValues,
  type PaymentAllocationsInput,
  paymentAllocationsInputSchema,
  plainQuantity,
  type VoidSupplierPaymentInput,
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
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useMemo } from 'react';
import { Controller, type Path, useForm } from 'react-hook-form';

import { billAllocationRows } from '../lib/bills';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { openBillsQuery } from '../lib/queries';
import { AllocationTable, BILL_SIDE } from './allocation-table';
import { usePurchaseRefresh } from './purchase-parts';
import { useTenantId } from './stock-parts';

// The dialogs of the purchase money documents (step 17c), a lazy chunk of their own like the money
// receipt's (money-dialogs.tsx): "Apply money" on a supplier payment and (step 17d) on a debit note,
// and "Void" on a supplier payment and (17d) on a supplier refund. Here, not in money-dialogs.tsx:
// those refresh the sales documents and check the receipt's error codes; these refresh the purchase
// documents. Step 17d: each document passes what differs (its route, its error codes, its words),
// so one dialog serves both, as money-dialogs.tsx has done since 15d.

const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// Each document's own error codes for "Apply money": the shape is the same. Here, not on the
// document's page: a resolver brings the form library, which reading a document never needs.
const ALLOCATION_RESOLVERS = {
  supplier_payment: zodResolver(paymentAllocationsInputSchema, { error: contractErrorMap }),
  debit_note: zodResolver(debitNoteAllocationsInputSchema, { error: contractErrorMap }),
};

// The void's schema is the payment's for both: voidSupplierRefundInputSchema is the same one
const voidResolver = zodResolver(voidSupplierPaymentInputSchema, { error: contractErrorMap });

// "Apply money": where a posted document's money goes, the whole list at once (decision 23: no
// approval, the money left already). An advance paid before its bill came is applied here, and
// (17d) what a debit note keeps for later bills.
export function BillApplyForm({
  title,
  supplierId,
  amount,
  version,
  allocations,
  document,
  save,
  onDone,
}: {
  title: string;
  supplierId: string;
  // What the money can cover: the payment's amount or the debit note's total, less what supplier
  // refunds paid back (the server's cap; the table's "Left as advance" counts from it)
  amount: string;
  version: number;
  allocations: readonly PaymentAllocation[];
  // Whose error codes the form checks with
  document: keyof typeof ALLOCATION_RESOLVERS;
  // Sends the new list; answers the toast's words
  save: (body: PaymentAllocationsInput) => Promise<string>;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const refresh = usePurchaseRefresh();
  const { data: open } = useQuery(openBillsQuery(tenantId, supplierId));
  // Posted: its own amounts are in the bills' amountPaid (a payment) or amountDebited (a debit
  // note), so they count back in, and a bill it settled in full stays on the list
  const rows = useMemo(
    () => billAllocationRows(open ?? [], allocations, true),
    [open, allocations],
  );
  const {
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<PaymentAllocationsFormValues, unknown, PaymentAllocationsInput>({
    resolver: ALLOCATION_RESOLVERS[document],
    defaultValues: {
      version,
      allocations: allocations.map((allocation) => ({
        billId: allocation.billId,
        amount: plainQuantity(allocation.amount),
      })),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const done = await save(values);
      await refresh();
      toast(done);
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
      title={title}
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
                amount={amount}
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

// "Void": the date the money turned out not to have moved (a stopped cheque, a transfer the bank
// sent back, a supplier's cheque that bounced), and why. Its entry is reversed on that date.
export function PurchaseVoidForm({
  words,
  number,
  version,
  today,
  save,
  onDone,
}: {
  // The document's words: both sections have the same void keys
  words: 'supplierPayments' | 'supplierRefunds';
  number: string;
  version: number;
  today: string;
  save: (body: VoidSupplierPaymentInput) => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = usePurchaseRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: voidResolver,
    defaultValues: { version, date: today, reason: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await save(values);
      await refresh();
      toast(t(`${words}.voided`, { number }));
      onDone();
    } catch (error) {
      applyApiError(error, ['date', 'reason'], setError);
    }
  });

  return (
    <DialogContent
      title={t(`${words}.voidTitle`, { number })}
      description={t(`${words}.voidBody`)}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">
              {words === 'supplierPayments'
                ? t('supplierPayments.keepPayment')
                : t('supplierRefunds.keepRefund')}
            </Button>
          </DialogClose>
          <Button type="submit" form="purchase-void-form" disabled={isSubmitting}>
            {t(`${words}.confirmVoid`)}
          </Button>
        </>
      }
    >
      <form
        id="purchase-void-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <FormField
          control={control}
          name="date"
          label={t(`${words}.voidDate`)}
          hint={t(`${words}.voidDateHint`)}
        >
          {(field) => (
            <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
              <DatePicker {...field} />
            </Suspense>
          )}
        </FormField>
        <TextField
          label={t(`${words}.voidReason`)}
          placeholder={t(`${words}.voidReasonPlaceholder`)}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
