import { Calendar03Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  type ReceiptAllocation,
  type ReceiptAllocationsFormValues,
  type ReceiptAllocationsInput,
  type VoidReceiptInput,
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
import { Controller, type Path, type Resolver, useForm } from 'react-hook-form';

import { applyApiError } from '../lib/field-errors';
import { allocationRows } from '../lib/invoices';
import { rowPath } from '../lib/products';
import { openInvoicesQuery } from '../lib/queries';
import { AllocationTable, INVOICE_SIDE } from './allocation-table';
import { useSalesRefresh } from './sales-parts';
import { useTenantId } from './stock-parts';

// The dialogs of the money documents, a lazy chunk of their own (receipt-view.tsx says why):
// "Apply money" on a receipt and (step 15d) on a credit note, and "Void" on a receipt and on a
// refund. Called receipt-dialogs.tsx in 15c; each document passes what differs (its route, its
// error codes, its words), so one dialog serves both.

// The void date's picker as a chunk of its own: with the popover inside, the dialogs stood at
// 106 KB of their 100 KB budget
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// "Apply money": the document's money over the customer's invoices again, the whole list at once
// (an advance that came before its invoice, money put on the wrong invoice, or the rest of a credit
// note kept as an advance)
export function ApplyForm({
  title,
  customerId,
  amount,
  version,
  allocations,
  resolver,
  save,
  onDone,
}: {
  title: string;
  customerId: string;
  // What the money can cover: the receipt's amount or the credit note's total, less what refunds
  // paid back (the server's cap; the table's "Left as advance" counts from it)
  amount: string;
  version: number;
  allocations: readonly ReceiptAllocation[];
  // The document's own schema: the shape is the same, the error codes are its own
  resolver: Resolver<ReceiptAllocationsFormValues, unknown, ReceiptAllocationsInput>;
  // Sends the new list; answers the toast's words
  save: (body: ReceiptAllocationsInput) => Promise<string>;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const { data: open } = useQuery(openInvoicesQuery(tenantId, customerId));
  // Its own invoices too: one it paid in full is not open any more
  const rows = useMemo(() => allocationRows(open ?? [], allocations), [open, allocations]);
  const {
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ReceiptAllocationsFormValues, unknown, ReceiptAllocationsInput>({
    resolver,
    defaultValues: {
      version,
      allocations: allocations.map((allocation) => ({
        invoiceId: allocation.invoiceId,
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
      title={title}
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
                side={INVOICE_SIDE}
                rows={rows}
                value={field.value}
                onChange={field.onChange}
                amount={amount}
                errors={{
                  list: errors.allocations?.root?.message ?? errors.allocations?.message,
                  row: (index) =>
                    errors.allocations?.[index]?.amount?.message ??
                    errors.allocations?.[index]?.invoiceId?.message,
                }}
                empty={t('receipts.noOpenInvoices')}
              />
            )}
          />
        </div>
      </form>
    </DialogContent>
  );
}

// "Void": the date the money turned out not to be there (or never reached the customer), and why.
// `words` picks the document's own texts; both have the same keys, but for the dialog's No button.
export function VoidForm({
  words,
  number,
  version,
  today,
  save,
  onDone,
}: {
  words: 'receipts' | 'refunds';
  number: string;
  version: number;
  today: string;
  save: (body: VoidReceiptInput) => Promise<void>;
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
              {words === 'receipts' ? t('receipts.keepReceipt') : t('refunds.keepRefund')}
            </Button>
          </DialogClose>
          <Button type="submit" form="void-form" disabled={isSubmitting}>
            {t(`${words}.confirmVoid`)}
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
