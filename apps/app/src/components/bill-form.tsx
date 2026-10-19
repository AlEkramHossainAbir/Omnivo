import {
  ArrowTurnBackwardIcon,
  Calendar03Icon,
  Delete02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Bill,
  type BillExpenseFormValues,
  type BillFormValues,
  contractErrorMap,
  dueDateOf,
  isZeroMoney,
  levelsFor,
  type PartyRef,
  routes,
  subtractMoney,
  updateBillInputSchema,
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
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import type { BillSourcedLine } from '../lib/bill-sources';
import {
  BILL_EXPENSE_FIELDS,
  BILL_LINE_FIELDS,
  type BillLineOrigin,
  billFormTotals,
  billOrderPricing,
  billSourceIdOf,
  costAccounts,
  formPriceDifference,
  savedBillLines,
  toFormExpense,
} from '../lib/bills';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import {
  accountsQuery,
  approvalRulesQuery,
  billQuery,
  branchesQuery,
  purchaseAccountsQuery,
  stockAccountsQuery,
  supplierQuery,
  taxRatesQuery,
} from '../lib/queries';
import { serialPath } from '../lib/stock';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { DocumentNotice, SalesTotals } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The supplier bill form (step 17c): its own chunk, loaded by routes/bill.tsx, like the invoice's.
// A new bill, or a draft (a new one, or one sent back by a rejection or a reopen). "Save draft"
// keeps it a draft; the second button saves and submits it in one request (decision 14), which
// posts it at once when no approval level applies to its total, else sends it for approval.

// The line editor, the expenses card, the supplier box and the date picker are chunks of their own,
// like the invoice form's: the editors bring decimal.js with the money boxes, the boxes the popover
const BillLinesEditor = lazy(async () => ({
  default: (await import('./bill-lines')).BillLinesEditor,
}));
const BillExpensesEditor = lazy(async () => ({
  default: (await import('./bill-expenses')).BillExpensesEditor,
}));
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
// A saved draft's approval card and the dialog of "Cancel bill" come later: the form was over its
// 100 KB budget with them inside, and both sit below the form or behind a click
const ApprovalCard = lazy(async () => ({
  default: (await import('./approval-card')).ApprovalCard,
}));
const CancelDraftDialog = lazy(async () => ({
  default: (await import('./cancel-draft-dialog')).CancelDraftDialog,
}));

type FormValues = BillFormValues;

// Every field the server may name, each line's and each expense's included, so applyApiError can
// put an error under its box
function fieldNames(values: {
  lines: readonly { serialNumbers: readonly unknown[] }[];
  expenses: readonly BillExpenseFormValues[];
}): Path<FormValues>[] {
  return [
    'supplierId',
    'supplierBillNumber',
    'date',
    'dueDate',
    'mushakNumber',
    'mushakDate',
    'branchId',
    'warehouseId',
    'pricesIncludeVat',
    'note',
    'lines',
    'expenses',
    ...values.lines.flatMap((line, index) => [
      ...BILL_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
    ...values.expenses.flatMap((_, index) =>
      BILL_EXPENSE_FIELDS.map((field) => rowPath('expenses', index, field)),
    ),
  ];
}

export function BillForm({
  bill,
  start,
  today,
}: {
  bill: Bill | null;
  // "Make bill" on a goods receipt or an order: the supplier and the lines it starts with
  start: { supplier: PartyRef; lines: BillSourcedLine[] } | null;
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const stockAccounts = useQuery(stockAccountsQuery(tenantId)).data;
  const purchaseAccounts = useQuery(purchaseAccountsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const rules = useQuery(approvalRulesQuery(tenantId)).data;
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [saved] = useState(() => {
    if (bill) return savedBillLines(bill);
    return {
      values: start?.lines.map((entry) => entry.line) ?? [],
      meta: start?.lines.map((entry) => entry.meta) ?? [],
      origins: new Map(start?.lines.map((entry) => entry.origin)),
    };
  });
  // Where each goods receipt line and order line on the form comes from, by its id
  const [origins, setOrigins] = useState<ReadonlyMap<string, BillLineOrigin>>(saved.origins);
  const savedSupplier = bill?.supplier ?? start?.supplier ?? null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateBillInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: savedSupplier?.id ?? '',
      supplierBillNumber: bill?.supplierBillNumber ?? '',
      date: bill?.date ?? today,
      // A draft's due date is kept as saved; the API filled an empty one from the terms
      dueDate: bill?.dueDate ?? '',
      mushakNumber: bill?.mushakNumber ?? '',
      mushakDate: bill?.mushakDate ?? '',
      // One branch needs no choice
      branchId: bill?.branchId ?? (branches.length === 1 ? (branches[0]?.id ?? '') : ''),
      warehouseId: bill?.warehouseId ?? '',
      // Off for a new bill: a supplier bills before VAT (the orders' setting wins, below)
      pricesIncludeVat: bill?.pricesIncludeVat ?? false,
      note: bill?.note ?? '',
      lines: saved.values,
      expenses: bill?.expenses.map(toFormExpense) ?? [],
      submit: false,
      version: bill?.version ?? 1,
    },
  });
  const lines = useWatch({ control, name: 'lines' });
  const expenses = useWatch({ control, name: 'expenses' });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const date = useWatch({ control, name: 'date' });
  const dueDate = useWatch({ control, name: 'dueDate' }) ?? '';
  const ownPricing = useWatch({ control, name: 'pricesIncludeVat' });
  const supplier = useQuery({
    ...supplierQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  }).data;

  // The orders' way of writing prices, else the bill's own (the API's order)
  const linePricing = billOrderPricing(lines, origins);
  const pricesIncludeVat = linePricing ?? ownPricing;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  const totals = billFormTotals(lines, expenses, rateOf, pricesIncludeVat);
  const difference = formPriceDifference(lines, origins, rateOf, pricesIncludeVat);
  // A line from a receipt or an order belongs to its supplier; a number the approvers saw keeps it
  // (the API refuses that change with purchase_supplier_invalid)
  const sourced = lines.some((line) => billSourceIdOf(line) !== null);
  const numbered = bill?.number ?? null;
  // The accounts a service line or an expense may post to, its own archived ones kept
  const choices = useMemo(
    () =>
      costAccounts(accounts ?? [], stockAccounts, [
        ...(bill?.lines.flatMap((line) => line.accountId ?? []) ?? []),
        ...(bill?.expenses.map((expense) => expense.accountId) ?? []),
      ]),
    [accounts, stockAccounts, bill],
  );
  const servicesAccount =
    accounts?.find((account) => account.id === purchaseAccounts?.services) ?? null;
  // Decision 14: "Post bill" when no level applies to the total now, else "Submit for approval"
  const needsApproval =
    levelsFor(rules?.find((rule) => rule.document === 'bill')?.levels ?? [], totals.total).length >
    0;
  const [round] = bill?.approval.rounds ?? [];
  const rejection =
    round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;

  const save = (submit: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, submit };
        const result = bill
          ? await call(routes.bills.update, {
              params: { id: bill.id },
              body: { ...body, version },
            })
          : await call(routes.bills.create, { body });
        // Into its cache first, so the page shows it at once (posted: the view, not this form)
        queryClient.setQueryData(billQuery(tenantId, result.id).queryKey, result);
        await refresh();
        const number = result.number ?? '';
        toast(
          result.status === 'posted'
            ? t('bills.posted', { number })
            : result.status === 'pending'
              ? t('bills.submitted', { number })
              : result.number === null
                ? t('bills.draftSaved')
                : t('bills.saved', { number }),
        );
        if (!bill) {
          void navigate({ to: '/bills/$billId', params: { billId: result.id }, replace: true });
        }
      } catch (error) {
        applyApiError(error, fieldNames(getValues()), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: Bill) =>
      call(routes.bills.remove, { params: { id: draft.id }, query: { version: draft.version } }),
    onSuccess: async (_, draft) => {
      // To the list first: the deleted bill's own query would otherwise refetch into a 404
      await navigate({ to: '/bills' });
      queryClient.removeQueries({ queryKey: billQuery(tenantId, draft.id).queryKey });
      await refresh();
      toast(t('bills.deleted'));
    },
  });
  // A numbered draft is cancelled, never deleted (decision 13): its number stays in the list
  const cancel = useMutation({
    mutationFn: (draft: Bill) =>
      call(routes.bills.cancel, { params: { id: draft.id }, body: { version: draft.version } }),
    onSuccess: async (result) => {
      setCancelling(false);
      queryClient.setQueryData(billQuery(tenantId, result.id).queryKey, result);
      await refresh();
      toast(t('bills.cancelled', { number: result.number ?? '' }));
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const terms = supplier?.paymentTermsDays;
  const money = (value: string) => format.money(value, { decimals: 2 });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/bills" label={t('bills.back')} />
      <PageHeader
        title={numbered ?? (bill ? t('bills.draftTitle') : t('bills.newTitle'))}
        description={t('bills.description')}
      />
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('bills.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {numbered !== null && !rejection && (
        <DocumentNotice tone="neutral">
          {t('bills.numberedDraft', { number: numbered })}
        </DocumentNotice>
      )}
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
            label={t('bills.supplier')}
            hint={
              numbered !== null
                ? t('bills.supplierNumbered')
                : sourced
                  ? t('bills.supplierLocked')
                  : undefined
            }
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={savedSupplier}
                  disabled={sourced || numbered !== null}
                  onChange={(next) => {
                    setValue('supplierId', next, {
                      shouldValidate: errors.supplierId !== undefined,
                    });
                  }}
                />
              </Suspense>
            )}
          </FormField>
          <TextField
            label={t('bills.supplierBillNumber')}
            hint={t('bills.supplierBillNumberHint')}
            placeholder={t('bills.supplierBillNumberPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            {...register('supplierBillNumber')}
            error={errors.supplierBillNumber?.message}
          />
          <FormField
            control={control}
            name="date"
            label={t('bills.date')}
            hint={t('bills.dateHint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField
            control={control}
            name="dueDate"
            label={t('bills.dueDate')}
            optional
            // Empty: the date plus the terms. Only the supplier's are known here; with an order
            // behind a line, the API takes the order's (decision 39), so the hint names no date.
            hint={
              dueDate === '' && terms !== undefined && !sourced
                ? `${t('bills.dueDateHint')} ${t('bills.dueOn', {
                    date: isoDate(dueDateOf(date, terms)),
                  })}`
                : t('bills.dueDateHint')
            }
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <TextField
            label={t('bills.mushakNumber')}
            optional
            hint={t('bills.mushakNumberHint')}
            placeholder={t('bills.mushakNumberPlaceholder')}
            autoComplete="off"
            {...register('mushakNumber')}
            error={errors.mushakNumber?.message}
          />
          <FormField control={control} name="mushakDate" label={t('bills.mushakDate')} optional>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('bills.branch')}
            hint={t('bills.branchHint')}
            options={[
              { value: '', label: t('bills.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <SelectField
            label={t('bills.warehouse')}
            optional
            hint={t('bills.warehouseHint')}
            options={[
              { value: '', label: t('bills.noWarehouse') },
              // A draft keeps its warehouse even when it was archived since; the API says so at
              // submit, like a purchase order's (17b)
              ...(bill?.warehouseId && !active?.some((place) => place.id === bill.warehouseId)
                ? [{ value: bill.warehouseId, label: warehouseLabel(byId.get(bill.warehouseId)) }]
                : []),
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
            <Controller
              control={control}
              name="pricesIncludeVat"
              render={({ field }) => (
                <Checkbox
                  id="pricesIncludeVat"
                  label={t('bills.pricesIncludeVat')}
                  // A bill of orders writes its prices the way they do
                  checked={pricesIncludeVat}
                  disabled={linePricing !== null}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true);
                  }}
                />
              )}
            />
            <p className="pl-[27px] text-label text-ink-3">
              {linePricing !== null ? t('bills.pricesFromOrder') : t('bills.pricesIncludeVatHint')}
            </p>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextAreaField
              label={t('bills.note')}
              optional
              placeholder={t('bills.notePlaceholder')}
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
              <BillLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={saved.meta}
                supplierId={supplierId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
                origins={origins}
                orderPricing={linePricing}
                accounts={choices}
                servicesAccount={servicesAccount}
                onSourced={(added) => {
                  setOrigins(
                    (before) => new Map([...before, ...added.map((entry) => entry.origin)]),
                  );
                }}
              />
            </Suspense>
          )}
        />
        <Controller
          control={control}
          name="expenses"
          render={({ field }) => (
            <Suspense fallback={<Card className="min-h-24" />}>
              <BillExpensesEditor
                expenses={field.value}
                onChange={field.onChange}
                accounts={choices}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.expenses}
              />
            </Suspense>
          )}
        />
        {/* The bill's totals: its item lines and its expenses together, as the API stores them */}
        {(lines.length > 0 || expenses.length > 0) && (
          <Card className="overflow-hidden">
            <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
          </Card>
        )}
        {/* Decision 8: the approver sees it too, on the bill's page */}
        {!isZeroMoney(difference) && (
          <DocumentNotice tone="warn">
            {t('bills.priceDifferenceNotice', {
              // How far, either way: each line says whether it is over or under its order
              amount: money(
                difference.startsWith('-') ? subtractMoney('0', difference) : difference,
              ),
            })}
          </DocumentNotice>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {bill && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {numbered === null ? (
                // Two clicks: a deleted draft cannot come back
                <Button
                  variant="secondary"
                  disabled={removeDraft.isPending}
                  onClick={() => {
                    if (confirming) removeDraft.mutate(bill);
                    else setConfirming(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {confirming ? t('bills.confirmDelete') : t('bills.deleteDraft')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCancelling(true);
                  }}
                >
                  {t('bills.cancel')}
                </Button>
              )}
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('bills.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('bills.saveDraft')}
          </Button>
          <Button
            disabled={isSubmitting || (lines.length === 0 && expenses.length === 0)}
            onClick={() => void save(true)()}
          >
            {isSubmitting
              ? t('bills.posting')
              : needsApproval
                ? t('bills.submit')
                : t('bills.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">
          {needsApproval ? t('bills.submitHint') : t('bills.postHint')}
        </p>
      </form>

      {/* A saved draft: the levels its total reaches now, and the rounds it went through */}
      {bill && (
        <Suspense fallback={null}>
          <ApprovalCard
            document="bill"
            id={bill.id}
            number={numbered ?? ''}
            amount={totals.total}
            draft
            approval={bill.approval}
          />
        </Suspense>
      )}
      {cancelling && bill && (
        <Suspense fallback={null}>
          <CancelDraftDialog
            title={t('bills.cancelTitle', { number: numbered ?? '' })}
            body={t('bills.cancelBody')}
            keep={t('bills.keepBill')}
            confirm={t('bills.cancel')}
            pending={cancel.isPending}
            error={failureOf(cancel.error)}
            onConfirm={() => {
              cancel.mutate(bill);
            }}
            onClose={() => {
              setCancelling(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
