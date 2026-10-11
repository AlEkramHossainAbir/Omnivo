import { Calendar03Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  type Receipt,
  receiptAllocationsInputSchema,
  type ReceiptAllocationsFormValues,
  routes,
  voidReceiptInputSchema,
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

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { allocationRows } from '../lib/invoices';
import { rowPath } from '../lib/products';
import { openInvoicesQuery } from '../lib/queries';
import { AllocationTable } from './allocation-table';
import { useSalesRefresh } from './sales-parts';
import { useTenantId } from './stock-parts';

// The receipt page's two dialogs (step 15c), a lazy chunk of their own (receipt-view.tsx says why)

// The void date's picker as a chunk of its own: with the popover inside, the dialogs stood at
// 106 KB of their 100 KB budget
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// "Apply money": the receipt's money over the customer's invoices again, the whole list at once
// (an advance that came before its invoice, or money put on the wrong invoice)
export function ApplyForm({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const { data: open } = useQuery(openInvoicesQuery(tenantId, receipt.customer.id));
  // Its own invoices too: one it paid in full is not open any more
  const rows = useMemo(
    () => allocationRows(open ?? [], receipt.allocations),
    [open, receipt.allocations],
  );
  const {
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ReceiptAllocationsFormValues>({
    resolver: zodResolver(receiptAllocationsInputSchema, { error: contractErrorMap }),
    defaultValues: {
      version: receipt.version,
      allocations: receipt.allocations.map((allocation) => ({
        invoiceId: allocation.invoiceId,
        amount: plainQuantity(allocation.amount),
      })),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.receipts.allocate, {
        params: { id: receipt.id },
        body: values,
      });
      await refresh();
      toast(t('receipts.allocated', { number: saved.number }));
      onDone();
    } catch (error) {
      const count = getValues('allocations').length;
      const names: Path<ReceiptAllocationsFormValues>[] = [
        'allocations',
        ...Array.from({ length: count }, (_, index) => [
          rowPath('allocations', index, 'invoiceId'),
          rowPath('allocations', index, 'amount'),
        ]).flat(),
      ];
      applyApiError(error, names, setError);
    }
  });

  return (
    <DialogContent
      title={t('receipts.applyDialogTitle', { number: receipt.number })}
      description={t('receipts.applySubtitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="apply-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('receipts.applySave')}
          </Button>
        </>
      }
    >
      <form id="apply-form" noValidate onSubmit={(event) => void onSubmit(event)}>
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* The table's own padding is a card's; the dialog has its own, so it runs edge to edge */}
        <div className="-mx-[18px] sm:-mx-6">
          <Controller
            control={control}
            name="allocations"
            render={({ field }) => (
              <AllocationTable
                rows={rows}
                value={field.value}
                onChange={field.onChange}
                amount={receipt.amount}
                errors={errors.allocations}
                empty={t('receipts.noOpenInvoices')}
              />
            )}
          />
        </div>
      </form>
    </DialogContent>
  );
}

// "Void receipt": the date the money turned out not to be there, and why
export function VoidForm({
  receipt,
  today,
  onDone,
}: {
  receipt: Receipt;
  today: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useSalesRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(voidReceiptInputSchema, { error: contractErrorMap }),
    defaultValues: { version: receipt.version, date: today, reason: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.receipts.void, { params: { id: receipt.id }, body: values });
      await refresh();
      toast(t('receipts.voided', { number: saved.number }));
      onDone();
    } catch (error) {
      applyApiError(error, ['date', 'reason'], setError);
    }
  });

  return (
    <DialogContent
      title={t('receipts.voidTitle', { number: receipt.number })}
      description={t('receipts.voidBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('receipts.keepReceipt')}</Button>
          </DialogClose>
          <Button type="submit" form="void-form" disabled={isSubmitting}>
            {t('receipts.confirmVoid')}
          </Button>
        </>
      }
    >
      <form
        id="void-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <FormField
          control={control}
          name="date"
          label={t('receipts.voidDate')}
          hint={t('receipts.voidDateHint')}
        >
          {(field) => (
            <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
              <DatePicker {...field} />
            </Suspense>
          )}
        </FormField>
        <TextField
          label={t('receipts.voidReason')}
          placeholder={t('receipts.voidReasonPlaceholder')}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
