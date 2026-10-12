import { Calendar03Icon, Delete02Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CreditNote,
  type CreditNoteFormValues,
  type CreditNoteLineFormValues,
  creditNoteIsLate,
  type CreditNoteReason,
  CREDIT_NOTE_REASONS,
  type Invoice,
  routes,
  updateCreditNoteInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Field,
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

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { invoiceQuery, postedInvoicesQuery } from '../lib/queries';
import { creditReasonKey, toCreditFormLine } from '../lib/returns';
import { failureOf } from './journal-parts';
import { DocumentNotice, SalesBackLink, useSalesRefresh } from './sales-parts';
import { useIsoDate, useTenantId } from './stock-parts';

// The credit note form (step 15d): its own chunk, loaded by routes/credit-note.tsx. The customer,
// then one of their posted invoices, then the lines that take part of it back.

// The lines editor, the customer box and the date box as chunks of their own, like the invoice
// form's: they bring the money boxes and the popover
const CreditNoteLinesEditor = lazy(async () => ({
  default: (await import('./credit-note-lines')).CreditNoteLinesEditor,
}));
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = CreditNoteFormValues;

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'invoiceId',
    'date',
    'reason',
    'note',
    'lines',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('lines', index, 'invoiceLineId'),
      rowPath('lines', index, 'returnLineId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'description'),
      rowPath('lines', index, 'unitPrice'),
      rowPath('lines', index, 'discountType'),
      rowPath('lines', index, 'discount'),
    ]).flat(),
  ];
}

// What a new credit note starts with: "Write credit note" on an invoice (no lines) or on a return
// (that return's lines billed on its first invoice still to credit)
export interface CreditNoteStart {
  invoice: Invoice;
  lines: CreditNoteLineFormValues[];
  returnNumbers: readonly (readonly [string, string])[];
  reason: CreditNoteReason;
}

// Writing a new credit note, or changing a draft. "Save draft" keeps it a draft; "Post credit note"
// saves and posts in one request: the sale, its VAT and what the customer owes are taken back, and
// its money pays the invoice, all or nothing.
export function CreditNoteForm({
  creditNote,
  start,
  today,
}: {
  creditNote: CreditNote | null;
  start: CreditNoteStart | null;
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const isoDate = useIsoDate();
  const [confirming, setConfirming] = useState(false);
  const savedCustomer = creditNote?.customer ?? start?.invoice.customer ?? null;
  // Not sent: the server takes the customer from the invoice (15d.1). The box narrows the invoices.
  const [customerId, setCustomerId] = useState(savedCustomer?.id ?? '');
  const [returnNumbers, setReturnNumbers] = useState<ReadonlyMap<string, string>>(
    () =>
      new Map([
        ...(creditNote?.lines ?? []).flatMap((line) =>
          line.returnLineId !== null && line.returnNumber !== null
            ? [[line.returnLineId, line.returnNumber] as const]
            : [],
        ),
        ...(start?.returnNumbers ?? []),
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
    resolver: zodResolver(updateCreditNoteInputSchema, { error: contractErrorMap }),
    defaultValues: {
      invoiceId: creditNote?.invoice.id ?? start?.invoice.id ?? '',
      date: creditNote?.date ?? today,
      reason:
        CREDIT_NOTE_REASONS.find((reason) => reason === creditNote?.reason) ??
        start?.reason ??
        'price_adjustment',
      note: creditNote?.note ?? '',
      lines: creditNote?.lines.map(toCreditFormLine) ?? start?.lines ?? [],
      post: false,
      version: creditNote?.version ?? 1,
    },
  });
  const invoiceId = useWatch({ control, name: 'invoiceId' });
  const date = useWatch({ control, name: 'date' });
  const lines = useWatch({ control, name: 'lines' });
  const invoice =
    useQuery({ ...invoiceQuery(tenantId, invoiceId), enabled: invoiceId !== '' }).data ?? null;
  const postedInvoices = useQuery({
    ...postedInvoicesQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  // Lines of one invoice never sit under another: both boxes wait until the lines are gone
  const locked = lines.length > 0;
  const money = (value: string) => format.money(value, { decimals: 2 });

  // The invoice box: the customer's posted invoices, and the draft's own invoice when it is older
  // than the 100 the list reads
  const invoiceOptions = [
    {
      value: '',
      label:
        customerId === ''
          ? t('creditNotes.pickCustomerFirst')
          : t('creditNotes.invoicePlaceholder'),
    },
    ...(postedInvoices ?? []).map((posted) => ({
      value: posted.id,
      label: t('creditNotes.invoiceOption', {
        number: posted.number ?? '',
        date: isoDate(posted.date),
        total: money(posted.total),
      }),
    })),
    ...(creditNote !== null &&
    customerId === creditNote.customer.id &&
    !(postedInvoices ?? []).some((posted) => posted.id === creditNote.invoice.id)
      ? [{ value: creditNote.invoice.id, label: creditNote.invoice.number }]
      : []),
  ];
  const invoiceHint = locked
    ? t('creditNotes.invoiceLocked')
    : customerId !== '' && postedInvoices?.length === 0
      ? t('creditNotes.noInvoices')
      : t('creditNotes.invoiceHint');
  const late = invoice !== null && date !== '' && creditNoteIsLate(invoice.date, date);

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = creditNote
          ? await call(routes.creditNotes.update, {
              params: { id: creditNote.id },
              body: { ...body, version },
            })
          : await call(routes.creditNotes.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('creditNotes.posted', { number: saved.number ?? '' })
            : t('creditNotes.draftSaved'),
        );
        if (!creditNote) {
          void navigate({
            to: '/credit-notes/$creditNoteId',
            params: { creditNoteId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(getValues('lines').length), setError);
        // The form has no customer box for the server's customerId to sit under (15d.3): an
        // archived customer is said above the form, with what to do
        if (
          error instanceof ApiRequestError &&
          error.problem.fieldErrors?.customerId?.includes('sales_customer_invalid')
        ) {
          setError('root.server', { message: t('creditNotes.customerArchived') });
        }
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: CreditNote) =>
      call(routes.creditNotes.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('creditNotes.deleted'));
      void navigate({ to: '/credit-notes' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/credit-notes" label={t('creditNotes.back')} />
      <PageHeader
        title={creditNote ? t('creditNotes.draftTitle') : t('creditNotes.newTitle')}
        description={t('creditNotes.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {/* Decision 6: a warning, not a block — saving and posting stay open */}
        {late && (
          <DocumentNotice tone="warn">
            {t('creditNotes.lateNotice', {
              number: invoice.number ?? '',
              date: isoDate(invoice.date),
            })}
          </DocumentNotice>
        )}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <Field
            id="credit-note-customer"
            label={t('creditNotes.customer')}
            hint={locked ? t('creditNotes.invoiceLocked') : undefined}
          >
            <Suspense fallback={<Input id="credit-note-customer" icon={UserIcon} disabled />}>
              <CustomerPicker
                id="credit-note-customer"
                value={customerId}
                saved={savedCustomer}
                disabled={locked}
                onChange={(next) => {
                  setCustomerId(next);
                  // Another customer's invoice is not this one's to credit
                  setValue('invoiceId', '');
                }}
              />
            </Suspense>
          </Field>
          <div className="sm:col-span-2">
            {/* Controlled, not registered: the options come from a query that answers after the
                form already holds its invoice (a credit note started from a return or an
                invoice). A registered select would keep showing the placeholder. */}
            <Controller
              control={control}
              name="invoiceId"
              render={({ field }) => (
                <SelectField
                  {...field}
                  label={t('creditNotes.invoice')}
                  hint={invoiceHint}
                  options={invoiceOptions}
                  disabled={customerId === '' || locked}
                  error={errors.invoiceId?.message}
                />
              )}
            />
          </div>
          <FormField control={control} name="date" label={t('creditNotes.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('creditNotes.reason')}
            options={CREDIT_NOTE_REASONS.map((reason) => ({
              value: reason,
              label: t(creditReasonKey(reason)),
            }))}
            {...register('reason')}
            error={errors.reason?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('creditNotes.note')}
              optional
              placeholder={t('creditNotes.notePlaceholder')}
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
              <CreditNoteLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                invoice={invoice}
                customerId={customerId}
                returnNumbers={returnNumbers}
                onReturnNumbers={(entries) => {
                  setReturnNumbers((before) => new Map([...before, ...entries]));
                }}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {creditNote && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(creditNote);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('creditNotes.confirmDelete') : t('creditNotes.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('creditNotes.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('creditNotes.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || lines.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('creditNotes.posting') : t('creditNotes.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('creditNotes.postHint')}</p>
      </form>
    </div>
  );
}
