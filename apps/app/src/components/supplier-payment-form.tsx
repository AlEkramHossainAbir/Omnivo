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
  billAmountDueOf,
  contractErrorMap,
  isMoneyAmount,
  levelsFor,
  moneyAccountIds,
  type PartyRef,
  PAYMENT_METHODS,
  plainQuantity,
  routes,
  type SupplierPayment,
  type SupplierPaymentFormValues,
  updateSupplierPaymentInputSchema,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { billAllocationRows } from '../lib/bills';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import {
  accountsQuery,
  approvalRulesQuery,
  branchesQuery,
  openBillsQuery,
  ordersToPayQuery,
  supplierPaymentQuery,
  supplierQuery,
} from '../lib/queries';
import { AllocationTable, BILL_SIDE } from './allocation-table';
import { failureOf } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { DocumentNotice } from './sales-parts';
import { useIsoDate, useTenantId } from './stock-parts';

// The supplier payment form (step 17c): its own chunk, loaded by routes/supplier-payment.tsx. A new
// payment or a draft, like the bill form: "Save draft", or save and submit in one request (decision
// 14), which posts it at once when no approval level applies to its amount. Built like the money
// receipt's form (15c), with the money going out instead of coming in.

// Both bring the popover; the delivery form says why that matters for the chunk
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
// Like the bill form: a saved draft's approval card and the "Cancel payment" dialog come later
const ApprovalCard = lazy(async () => ({
  default: (await import('./approval-card')).ApprovalCard,
}));
const CancelDraftDialog = lazy(async () => ({
  default: (await import('./cancel-draft-dialog')).CancelDraftDialog,
}));

type FormValues = SupplierPaymentFormValues;

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'supplierId',
    'date',
    'amount',
    'accountId',
    'method',
    'reference',
    'supplierBankAccountId',
    'branchId',
    'orderId',
    'note',
    'allocations',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('allocations', index, 'billId'),
      rowPath('allocations', index, 'amount'),
    ]).flat(),
  ];
}

export function SupplierPaymentForm({
  payment,
  bill,
  order,
  today,
}: {
  payment: SupplierPayment | null;
  // "Pay bill": its supplier, what it still owes, applied to it
  bill: Bill | null;
  // "Pay advance" on a purchase order: its supplier, and the order it is paid against
  order: { id: string; supplier: PartyRef } | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const isoDate = useIsoDate();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const rules = useQuery(approvalRulesQuery(tenantId)).data;
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The accounts money leaves from: the contracts' own list, the one the API checks against
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id) || account.id === payment?.accountId)
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts, payment]);
  const savedSupplier = payment?.supplier ?? bill?.supplier ?? order?.supplier ?? null;
  const due = bill ? plainQuantity(billAmountDueOf(bill)) : '';
  const numbered = payment?.number ?? null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSupplierPaymentInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: savedSupplier?.id ?? '',
      date: payment?.date ?? today,
      amount: payment ? plainQuantity(payment.amount) : due,
      // One cash box or bank account needs no choice
      accountId:
        payment?.accountId ?? (moneyAccounts.length === 1 ? (moneyAccounts[0]?.id ?? '') : ''),
      // A supplier is mostly paid by bank: a BEFTN transfer or a cheque
      method: payment?.method ?? 'bank_transfer',
      reference: payment?.reference ?? '',
      supplierBankAccountId: payment?.supplierBankAccount?.id ?? '',
      branchId:
        payment?.branchId ??
        bill?.branchId ??
        (branches.length === 1 ? (branches[0]?.id ?? '') : ''),
      orderId: payment?.order?.id ?? order?.id ?? '',
      note: payment?.note ?? '',
      allocations:
        payment?.allocations.map((allocation) => ({
          billId: allocation.billId,
          amount: plainQuantity(allocation.amount),
        })) ?? (bill ? [{ billId: bill.id, amount: due }] : []),
      submit: false,
      version: payment?.version ?? 1,
    },
  });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const amount = useWatch({ control, name: 'amount' });
  const method = useWatch({ control, name: 'method' });
  const supplier = useQuery({
    ...supplierQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  }).data;
  const { data: open } = useQuery({
    ...openBillsQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  });
  const orders = useQuery({
    ...ordersToPayQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  }).data;
  // A draft's plan holds nothing (decision 23): the bills owe what they owe
  const rows = useMemo(
    () => billAllocationRows(open ?? [], payment?.allocations ?? [], false),
    [open, payment],
  );
  // The amount as typed, once it is an amount (one being typed, like "12.", counts as nothing)
  const typed = isMoneyAmount(amount.trim()) ? amount.trim() : '0';
  // Decision 14: "Post payment" when no level applies to the amount, else "Submit for approval"
  const needsApproval =
    levelsFor(rules?.find((rule) => rule.document === 'supplier_payment')?.levels ?? [], typed)
      .length > 0;
  const [round] = payment?.approval.rounds ?? [];
  const rejection =
    round?.status === 'rejected'
      ? round.steps.find((step) => step.decision === 'rejected')
      : undefined;
  // The supplier's bank accounts, and the draft's own if the supplier removed it meanwhile (the
  // database clears the link then, decision 33, so this is only until the next load)
  const bankAccounts = supplier?.bankAccounts ?? [];
  // The order box: the supplier's orders an advance may name (decision 44), and the draft's own
  const orderOptions = [
    ...(payment?.order && !orders?.some((each) => each.id === payment.order?.id)
      ? [{ value: payment.order.id, label: payment.order.number ?? '' }]
      : []),
    ...(orders ?? []).map((each) => ({
      value: each.id,
      label: [each.number ?? '', isoDate(each.date)].join(' · '),
    })),
  ];

  const save = (submit: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, submit };
        const result = payment
          ? await call(routes.supplierPayments.update, {
              params: { id: payment.id },
              body: { ...body, version },
            })
          : await call(routes.supplierPayments.create, { body });
        queryClient.setQueryData(supplierPaymentQuery(tenantId, result.id).queryKey, result);
        await refresh();
        const number = result.number ?? '';
        toast(
          result.status === 'posted'
            ? t('supplierPayments.posted', { number })
            : result.status === 'pending'
              ? t('supplierPayments.submitted', { number })
              : result.number === null
                ? t('supplierPayments.draftSaved')
                : t('supplierPayments.saved', { number }),
        );
        if (!payment) {
          void navigate({
            to: '/supplier-payments/$paymentId',
            params: { paymentId: result.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(getValues('allocations').length), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: SupplierPayment) =>
      call(routes.supplierPayments.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async (_, draft) => {
      await navigate({ to: '/supplier-payments' });
      queryClient.removeQueries({ queryKey: supplierPaymentQuery(tenantId, draft.id).queryKey });
      await refresh();
      toast(t('supplierPayments.deleted'));
    },
  });
  // A numbered draft is cancelled, never deleted (decision 13)
  const cancel = useMutation({
    mutationFn: (draft: SupplierPayment) =>
      call(routes.supplierPayments.cancel, {
        params: { id: draft.id },
        body: { version: draft.version },
      }),
    onSuccess: async (result) => {
      setCancelling(false);
      queryClient.setQueryData(supplierPaymentQuery(tenantId, result.id).queryKey, result);
      await refresh();
      toast(t('supplierPayments.cancelled', { number: result.number ?? '' }));
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/supplier-payments" label={t('supplierPayments.back')} />
      <PageHeader
        title={
          numbered ?? (payment ? t('supplierPayments.draftTitle') : t('supplierPayments.newTitle'))
        }
        description={t('supplierPayments.description')}
      />
      {rejection && (
        <DocumentNotice tone="warn" icon={ArrowTurnBackwardIcon}>
          {t('supplierPayments.notices.rejected', {
            name: rejection.decidedBy?.name ?? '',
            comment: rejection.comment ?? '',
          })}
        </DocumentNotice>
      )}
      {numbered !== null && !rejection && (
        <DocumentNotice tone="neutral">
          {t('supplierPayments.numberedDraft', { number: numbered })}
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
            label={t('supplierPayments.supplier')}
            hint={numbered !== null ? t('supplierPayments.supplierLocked') : undefined}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={savedSupplier}
                  disabled={numbered !== null}
                  onChange={(next) => {
                    setValue('supplierId', next, {
                      shouldValidate: errors.supplierId !== undefined,
                    });
                    // Another supplier's bills, bank accounts and orders are not this one's
                    setValue('allocations', []);
                    setValue('supplierBankAccountId', '');
                    setValue('orderId', '');
                  }}
                />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="date" label={t('supplierPayments.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="amount" label={t('supplierPayments.amount')}>
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <SelectField
            label={t('supplierPayments.account')}
            hint={
              moneyAccounts.length === 0
                ? t('supplierPayments.noAccounts')
                : t('supplierPayments.accountHint')
            }
            disabled={moneyAccounts.length === 0}
            options={[
              { value: '', label: t('supplierPayments.accountPlaceholder') },
              ...moneyAccounts.map((account) => ({
                value: account.id,
                label: `${account.code} · ${account.name}`,
              })),
            ]}
            {...register('accountId')}
            error={errors.accountId?.message}
          />
          <SelectField
            label={t('supplierPayments.method')}
            options={PAYMENT_METHODS.map((value) => ({
              value,
              label: t(`receipts.methods.${value}`),
            }))}
            {...register('method')}
            error={errors.method?.message}
          />
          <TextField
            label={t('supplierPayments.reference')}
            optional
            // How this kind of payment is usually written down: the cheque, the BEFTN reference
            placeholder={t(`supplierPayments.referencePlaceholders.${method}`)}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <SelectField
            label={t('supplierPayments.bankAccount')}
            optional
            hint={
              supplierId !== '' && bankAccounts.length === 0
                ? t('supplierPayments.noBankAccounts')
                : t('supplierPayments.bankAccountHint')
            }
            options={[
              { value: '', label: t('supplierPayments.bankAccountNone') },
              ...bankAccounts.map((account) => ({
                value: account.id,
                label: t('supplierPayments.bankAccountLine', {
                  bank: account.bankName,
                  number: account.accountNumber,
                }),
              })),
            ]}
            {...register('supplierBankAccountId')}
            error={errors.supplierBankAccountId?.message}
          />
          <SelectField
            label={t('supplierPayments.branch')}
            options={[
              { value: '', label: t('supplierPayments.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <SelectField
            label={t('supplierPayments.order')}
            optional
            hint={t('supplierPayments.orderHint')}
            options={[{ value: '', label: t('supplierPayments.orderNone') }, ...orderOptions]}
            {...register('orderId')}
            error={errors.orderId?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('supplierPayments.note')}
              optional
              placeholder={t('supplierPayments.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title={t('supplierPayments.applyTitle')}
            subtitle={t('supplierPayments.applySubtitle')}
          />
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
                empty={
                  supplierId === ''
                    ? t('supplierPayments.pickSupplier')
                    : t('supplierPayments.noOpenBills')
                }
              />
            )}
          />
          {/* Decision 23: a plan until it is posted */}
          {rows.length > 0 && (
            <p className="border-t border-line px-5 py-3 text-label text-ink-3">
              {t('supplierPayments.planHint')}
            </p>
          )}
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {payment && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {numbered === null ? (
                <Button
                  variant="secondary"
                  disabled={removeDraft.isPending}
                  onClick={() => {
                    if (confirming) removeDraft.mutate(payment);
                    else setConfirming(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {confirming
                    ? t('supplierPayments.confirmDelete')
                    : t('supplierPayments.deleteDraft')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCancelling(true);
                  }}
                >
                  {t('supplierPayments.cancel')}
                </Button>
              )}
              {confirming && (
                <span className="text-body-sm text-ink-2">
                  {t('supplierPayments.deleteWarning')}
                </span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('supplierPayments.saveDraft')}
          </Button>
          <Button disabled={isSubmitting} onClick={() => void save(true)()}>
            {isSubmitting
              ? t('supplierPayments.posting')
              : needsApproval
                ? t('supplierPayments.submit')
                : t('supplierPayments.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">
          {needsApproval ? t('supplierPayments.submitHint') : t('supplierPayments.postHint')}
        </p>
      </form>

      {payment && (
        <Suspense fallback={null}>
          <ApprovalCard
            document="supplier_payment"
            id={payment.id}
            number={numbered ?? ''}
            amount={typed}
            draft
            approval={payment.approval}
          />
        </Suspense>
      )}
      {cancelling && payment && (
        <Suspense fallback={null}>
          <CancelDraftDialog
            title={t('supplierPayments.cancelTitle', { number: numbered ?? '' })}
            body={t('supplierPayments.cancelBody')}
            keep={t('supplierPayments.keepPayment')}
            confirm={t('supplierPayments.cancel')}
            pending={cancel.isPending}
            error={failureOf(cancel.error)}
            onConfirm={() => {
              cancel.mutate(payment);
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
