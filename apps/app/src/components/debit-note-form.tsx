import { Calendar03Icon, Delete02Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Bill,
  contractErrorMap,
  type DebitNote,
  type DebitNoteExpenseFormValues,
  type DebitNoteFormValues,
  type DebitNoteLineFormValues,
  type DebitNoteReason,
  DEBIT_NOTE_REASONS,
  type PartyRef,
  plainQuantity,
  routes,
  updateDebitNoteInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Checkbox,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { debitFormTotals, debitLineItem, toDebitFormLine } from '../lib/purchase-returns';
import { billQuery, branchesQuery, postedBillsQuery, taxRatesQuery } from '../lib/queries';
import { debitReasonKey } from '../lib/returns';
import { Fact } from './adjustment-view';
import type { DebitReturnSource } from './debit-note-lines';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { SalesTotals } from './sales-parts';
import { useTenantId } from './stock-parts';

// The debit note form (step 17d): its own chunk, loaded by routes/debit-note.tsx. The supplier, then
// one of their posted bills (or none, decision 9), then the lines and expenses that come off it.
// The credit note form of 15d seen from the buyer's side.

// The editors, the supplier box and the date box as chunks of their own, like the credit note
// form's: they bring the money boxes and the popover
const DebitNoteLinesEditor = lazy(async () => ({
  default: (await import('./debit-note-lines')).DebitNoteLinesEditor,
}));
const DebitNoteExpensesEditor = lazy(async () => ({
  default: (await import('./debit-note-lines')).DebitNoteExpensesEditor,
}));
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = DebitNoteFormValues;

function fieldNames(lines: number, expenses: number): Path<FormValues>[] {
  return [
    'supplierId',
    'billId',
    'date',
    'branchId',
    'pricesIncludeVat',
    'reason',
    'supplierCreditNumber',
    'supplierCreditDate',
    'note',
    'lines',
    'expenses',
    ...Array.from({ length: lines }, (_, index) => [
      rowPath('lines', index, 'billLineId'),
      rowPath('lines', index, 'returnLineId'),
      rowPath('lines', index, 'taxRateId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'description'),
      rowPath('lines', index, 'unitPrice'),
      rowPath('lines', index, 'discountType'),
      rowPath('lines', index, 'discount'),
    ]).flat(),
    ...Array.from({ length: expenses }, (_, index) => [
      rowPath('expenses', index, 'billExpenseId'),
      rowPath('expenses', index, 'amount'),
    ]).flat(),
  ];
}

// What a new debit note starts with: "Write debit note" on a bill (no lines), "Debit whole bill"
// is saved by the bill's page itself, and "Write debit note" on a return (that return's lines of
// its first bill still to debit, or its lines on their own without a bill)
export interface DebitNoteStart {
  supplier: PartyRef;
  bill: Bill | null;
  lines: DebitNoteLineFormValues[];
  expenses: DebitNoteExpenseFormValues[];
  returnSources: readonly (readonly [string, DebitReturnSource])[];
  reason: DebitNoteReason;
}

// Writing a new debit note, or changing a draft. "Save draft" keeps it a draft; "Post debit note"
// saves and posts in one request: the purchase, its VAT and what the company owes come off, and its
// money is applied to its bill, all or nothing.
export function DebitNoteForm({
  debitNote,
  start,
  today,
}: {
  debitNote: DebitNote | null;
  start: DebitNoteStart | null;
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = usePurchaseRefresh();
  const [confirming, setConfirming] = useState(false);
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  const savedSupplier = debitNote?.supplier ?? start?.supplier ?? null;
  // The return number and item of each return line on the form, for its row
  const [returnSources, setReturnSources] = useState<ReadonlyMap<string, DebitReturnSource>>(
    () =>
      new Map([
        ...(debitNote?.lines ?? []).flatMap((line) =>
          line.returnLineId !== null && line.returnNumber !== null
            ? [
                [
                  line.returnLineId,
                  { number: line.returnNumber, item: debitLineItem(line) },
                ] as const,
              ]
            : [],
        ),
        ...(start?.returnSources ?? []),
      ]),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateDebitNoteInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: savedSupplier?.id ?? '',
      billId: debitNote?.bill?.id ?? start?.bill?.id ?? '',
      date: debitNote?.date ?? today,
      // Read by the server only without a bill; one branch needs no choice
      branchId:
        debitNote?.branchId ??
        start?.bill?.branchId ??
        (branches.length === 1 ? (branches[0]?.id ?? '') : ''),
      pricesIncludeVat: debitNote?.pricesIncludeVat ?? start?.bill?.pricesIncludeVat ?? false,
      reason:
        DEBIT_NOTE_REASONS.find((reason) => reason === debitNote?.reason) ??
        start?.reason ??
        'price_adjustment',
      supplierCreditNumber: debitNote?.supplierCreditNumber ?? '',
      supplierCreditDate: debitNote?.supplierCreditDate ?? '',
      note: debitNote?.note ?? '',
      lines: debitNote?.lines.map(toDebitFormLine) ?? start?.lines ?? [],
      expenses:
        debitNote?.expenses.map((expense) => ({
          billExpenseId: expense.billExpenseId,
          amount: plainQuantity(expense.amount),
        })) ??
        start?.expenses ??
        [],
      post: false,
      version: debitNote?.version ?? 1,
    },
  });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const billId = useWatch({ control, name: 'billId' }) ?? '';
  const lines = useWatch({ control, name: 'lines' });
  const expenses = useWatch({ control, name: 'expenses' });
  const ownPricing = useWatch({ control, name: 'pricesIncludeVat' });
  const bill = useQuery({ ...billQuery(tenantId, billId), enabled: billId !== '' }).data ?? null;
  const postedBills = useQuery({
    ...postedBillsQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  }).data;
  // Lines of one bill never sit under another: the supplier and bill boxes wait until the lines
  // and expenses are gone
  const locked = lines.length > 0 || expenses.length > 0;
  // A debit note for a bill writes its prices the bill's way, whatever the box says (the server
  // takes the bill's), so a line debited in full takes off exactly what it charged
  const pricesIncludeVat = billId === '' ? ownPricing : (bill?.pricesIncludeVat ?? ownPricing);
  const totals = debitFormTotals(lines, expenses, bill, rateOf, pricesIncludeVat);
  const money = (value: string) => format.money(value, { decimals: 2 });

  // The bill box: "No bill" first (decision 9), the supplier's posted bills, and the draft's own
  // bill when it is older than the 100 the list reads
  const billOptions = [
    {
      value: '',
      label: supplierId === '' ? t('debitNotes.pickSupplierFirst') : t('debitNotes.billNone'),
    },
    ...(postedBills ?? []).map((posted) => ({
      value: posted.id,
      label: t('debitNotes.billOption', {
        number: posted.number ?? '',
        supplierBillNumber: posted.supplierBillNumber,
        total: money(posted.total),
      }),
    })),
    ...(debitNote?.bill &&
    supplierId === debitNote.supplier.id &&
    !(postedBills ?? []).some((posted) => posted.id === debitNote.bill?.id)
      ? [{ value: debitNote.bill.id, label: debitNote.bill.number }]
      : []),
  ];
  const billHint = locked
    ? t('debitNotes.billLocked')
    : supplierId !== '' && postedBills?.length === 0
      ? t('debitNotes.noBills')
      : billId === ''
        ? t('debitNotes.noBillHint')
        : t('debitNotes.billHint');

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = debitNote
          ? await call(routes.debitNotes.update, {
              params: { id: debitNote.id },
              body: { ...body, version },
            })
          : await call(routes.debitNotes.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('debitNotes.posted', { number: saved.number ?? '' })
            : t('debitNotes.draftSaved'),
        );
        if (!debitNote) {
          void navigate({
            to: '/debit-notes/$debitNoteId',
            params: { debitNoteId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(
          error,
          fieldNames(getValues('lines').length, getValues('expenses').length),
          setError,
        );
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: DebitNote) =>
      call(routes.debitNotes.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('debitNotes.deleted'));
      void navigate({ to: '/debit-notes' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/debit-notes" label={t('debitNotes.back')} />
      <PageHeader
        title={debitNote ? t('debitNotes.draftTitle') : t('debitNotes.newTitle')}
        description={t('debitNotes.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField
            control={control}
            name="supplierId"
            label={t('debitNotes.supplier')}
            hint={locked ? t('debitNotes.billLocked') : undefined}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={savedSupplier}
                  disabled={locked}
                  onChange={(next) => {
                    setValue('supplierId', next, {
                      shouldValidate: errors.supplierId !== undefined,
                    });
                    // Another supplier's bill is not this one's to debit
                    setValue('billId', '');
                  }}
                />
              </Suspense>
            )}
          </FormField>
          <div className="sm:col-span-2">
            {/* Controlled, not registered: the options come from a query that answers after the
                form already holds its bill (a debit note started from a bill or a return) */}
            <Controller
              control={control}
              name="billId"
              render={({ field }) => (
                <SelectField
                  {...field}
                  value={field.value ?? ''}
                  label={t('debitNotes.bill')}
                  hint={billHint}
                  options={billOptions}
                  disabled={supplierId === '' || locked}
                  error={errors.billId?.message}
                />
              )}
            />
          </div>
          <FormField control={control} name="date" label={t('debitNotes.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('debitNotes.reason')}
            options={DEBIT_NOTE_REASONS.map((reason) => ({
              value: reason,
              label: t(debitReasonKey(reason)),
            }))}
            {...register('reason')}
            error={errors.reason?.message}
          />
          {billId === '' ? (
            <SelectField
              label={t('debitNotes.branch')}
              hint={t('debitNotes.branchHint')}
              options={[
                { value: '', label: t('debitNotes.branch') },
                ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
              {...register('branchId')}
              error={errors.branchId?.message}
            />
          ) : (
            <Fact
              label={t('debitNotes.branch')}
              value={
                bill
                  ? `${branches.find((branch) => branch.id === bill.branchId)?.name ?? '—'} · ${t('debitNotes.branchFromBill')}`
                  : '—'
              }
            />
          )}
          <TextField
            label={t('debitNotes.supplierCreditNumber')}
            optional
            hint={t('debitNotes.supplierCreditNumberHint')}
            placeholder={t('debitNotes.supplierCreditNumberPlaceholder')}
            autoComplete="off"
            {...register('supplierCreditNumber')}
            error={errors.supplierCreditNumber?.message}
          />
          <FormField
            control={control}
            name="supplierCreditDate"
            label={t('debitNotes.supplierCreditDate')}
            optional
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <div className="grid gap-2">
            <Controller
              control={control}
              name="pricesIncludeVat"
              render={({ field }) => (
                <Checkbox
                  id="pricesIncludeVat"
                  label={t('debitNotes.pricesIncludeVat')}
                  checked={pricesIncludeVat}
                  disabled={billId !== '' || locked}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true);
                  }}
                />
              )}
            />
            <p className="pl-[27px] text-label text-ink-3">
              {t('debitNotes.pricesIncludeVatHint')}
            </p>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('debitNotes.note')}
              optional
              placeholder={t('debitNotes.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Controller
          control={control}
          name="lines"
          render={({ field }) => (
            <Suspense fallback={<Card className="min-h-24" />}>
              <DebitNoteLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                bill={bill}
                supplierId={supplierId}
                pricesIncludeVat={pricesIncludeVat}
                returnSources={returnSources}
                onReturnSources={(entries) => {
                  setReturnSources((before) => new Map([...before, ...entries]));
                }}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />
        {bill && (bill.expenses.length > 0 || expenses.length > 0) && (
          <Controller
            control={control}
            name="expenses"
            render={({ field }) => (
              <Suspense fallback={<Card className="min-h-24" />}>
                <DebitNoteExpensesEditor
                  expenses={field.value}
                  onChange={field.onChange}
                  bill={bill}
                  pricesIncludeVat={pricesIncludeVat}
                  errors={errors.expenses}
                />
              </Suspense>
            )}
          />
        )}
        {(lines.length > 0 || expenses.length > 0) && (
          <Card className="overflow-hidden">
            <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
          </Card>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {debitNote && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(debitNote);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('debitNotes.confirmDelete') : t('debitNotes.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('debitNotes.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('debitNotes.saveDraft')}
          </Button>
          <Button
            disabled={isSubmitting || (lines.length === 0 && expenses.length === 0)}
            onClick={() => void save(true)()}
          >
            {isSubmitting ? t('debitNotes.posting') : t('debitNotes.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('debitNotes.postHint')}</p>
      </form>
    </div>
  );
}
