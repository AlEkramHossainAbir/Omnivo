import { Calendar03Icon, Delete02Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Delivery,
  dueDateOf,
  type Invoice,
  type InvoiceFormValues,
  type PartyRef,
  routes,
  updateInvoiceInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
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
import type { SourcedLine } from '../lib/invoice-sources';
import { type LineOrigin, orderPricing, savedInvoiceLines, sourceIdOf } from '../lib/invoices';
import { useCan } from '../lib/permissions';
import { rowPath } from '../lib/products';
import { branchesQuery, customerQuery } from '../lib/queries';
import { SALES_LINE_FIELDS } from '../lib/sales';
import { serialPath } from '../lib/stock';
import {
  CreditLimitDialog,
  CreditLine,
  type CreditStop,
  creditStopOf,
  useCreditText,
} from './credit-parts';
import { failureOf } from './journal-parts';
import { SalesBackLink, useSalesRefresh } from './sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The invoice form (step 15c): its own chunk, loaded by routes/invoice.tsx, like the order's.

// The lines are a chunk of their own (sales-line-editor.tsx says why), and so are the customer box
// and the date picker: both bring the popover, as on the delivery form
const InvoiceLinesEditor = lazy(async () => ({
  default: (await import('./invoice-lines')).InvoiceLinesEditor,
}));
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = InvoiceFormValues;
type LineValues = FormValues['lines'][number];

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'dueDate',
    'customerReference',
    'branchId',
    'warehouseId',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      ...SALES_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
      rowPath('lines', index, 'deliveryLineId'),
      rowPath('lines', index, 'orderLineId'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// Writing a new invoice (from nothing, from a challan, or for a customer), or changing a draft.
// "Save draft" keeps it a draft; "Post invoice" saves and posts in one request: the number, the
// sale in the books, and a challan for the goods it delivers itself, all or nothing.
export function InvoiceForm({
  invoice,
  start,
  customer: startCustomer,
  today,
  pricesIncludeVat: workspacePricing,
}: {
  invoice: Invoice | null;
  // "Make invoice" on a challan: the challan and its lines, priced
  start: { delivery: Delivery; lines: SourcedLine[] } | null;
  // "New invoice" on a customer's page
  customer: PartyRef | null;
  today: string;
  // The workspace's setting now: the price setting of an invoice no order prices
  pricesIncludeVat: boolean;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const canOverride = useCan()('sales.credit.override');
  const creditText = useCreditText();
  const [confirming, setConfirming] = useState(false);
  const [stop, setStop] = useState<CreditStop | null>(null);
  const [saved] = useState(() => {
    if (invoice) return savedInvoiceLines(invoice);
    return {
      values: start?.lines.map((entry) => entry.line) ?? [],
      meta: start?.lines.map((entry) => entry.meta) ?? [],
      origins: new Map(start?.lines.map((entry) => entry.origin)),
    };
  });
  // Where each challan line and order line on the form comes from, by its id
  const [origins, setOrigins] = useState<ReadonlyMap<string, LineOrigin>>(saved.origins);
  const savedCustomer = invoice?.customer ?? start?.delivery.customer ?? startCustomer;
  // A challan's branch is the branch of the warehouse it left from; one branch needs no choice
  const branchOf = (warehouseId: string | null) =>
    (warehouseId === null ? undefined : byId.get(warehouseId)?.branchId) ??
    (branches.length === 1 ? branches[0]?.id : undefined);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateInvoiceInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      date: invoice?.date ?? today,
      // A draft's due date is kept as saved; the API filled an empty one from the terms
      dueDate: invoice?.dueDate ?? '',
      customerReference: invoice?.customerReference ?? '',
      branchId: invoice?.branchId ?? branchOf(start?.delivery.warehouseId ?? null) ?? '',
      warehouseId: invoice?.warehouseId ?? '',
      note: invoice?.note ?? '',
      lines: saved.values,
      post: false,
      overrideCreditLimit: false,
      version: invoice?.version ?? 1,
    },
  });
  const lines = useWatch({ control, name: 'lines' });
  const customerId = useWatch({ control, name: 'customerId' });
  const date = useWatch({ control, name: 'date' });
  const dueDate = useWatch({ control, name: 'dueDate' }) ?? '';
  const warehouseId = useWatch({ control, name: 'warehouseId' }) ?? '';
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  // The orders' way of writing prices, else the draft's, else the workspace's (the API's order)
  const linePricing = orderPricing(lines, origins);
  const pricesIncludeVat = linePricing ?? invoice?.pricesIncludeVat ?? workspacePricing;
  // A challan line or an order line belongs to its customer: the customer stays while one is here
  const customerLocked = lines.some((line) => sourceIdOf(line) !== null);
  const billingAddress =
    customer?.addresses.find((address) => address.kind === 'billing')?.address ?? null;

  // Lines a picker added: keep where they came from, and take the branch of the challan's
  // warehouse when none is picked yet
  const sourced = (added: readonly SourcedLine[], fromWarehouse: string | null) => {
    setOrigins((before) => new Map([...before, ...added.map((entry) => entry.origin)]));
    const branchId = branchOf(fromWarehouse);
    if (getValues('branchId') === '' && branchId !== undefined) setValue('branchId', branchId);
  };

  // override: the second try, after the person saw the credit dialog and went on
  const save = (post: boolean, override = false) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post, overrideCreditLimit: override };
        const result = invoice
          ? await call(routes.invoices.update, {
              params: { id: invoice.id },
              body: { ...body, version },
            })
          : await call(routes.invoices.create, { body });
        await refresh();
        setStop(null);
        toast(
          result.status === 'posted'
            ? t('invoices.posted', { number: result.number ?? '' })
            : t('invoices.draftSaved'),
        );
        if (!invoice) {
          void navigate({
            to: '/invoices/$invoiceId',
            params: { invoiceId: result.id },
            replace: true,
          });
        }
      } catch (error) {
        const credit = creditStopOf(error);
        if (credit !== null && canOverride && !override) {
          setStop(credit);
          return;
        }
        setStop(null);
        const text = creditText(error);
        if (text !== null) setError('root.server', { message: text });
        else applyApiError(error, fieldNames(getValues('lines')), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: Invoice) =>
      call(routes.invoices.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('invoices.deleted'));
      void navigate({ to: '/invoices' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const terms = customer?.paymentTermsDays;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/invoices" label={t('invoices.back')} />
      <PageHeader
        title={invoice ? t('invoices.draftTitle') : t('invoices.newTitle')}
        description={t('invoices.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <FormField
              control={control}
              name="customerId"
              label={t('invoices.customer')}
              hint={customerLocked ? t('invoices.customerLocked') : undefined}
            >
              {(field) => (
                <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                  <CustomerPicker
                    {...field}
                    saved={savedCustomer}
                    disabled={customerLocked}
                    onChange={(next) => {
                      setValue('customerId', next, {
                        shouldValidate: errors.customerId !== undefined,
                      });
                    }}
                  />
                </Suspense>
              )}
            </FormField>
            <CreditLine customerId={customerId} />
          </div>
          <FormField control={control} name="date" label={t('invoices.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField
            control={control}
            name="dueDate"
            label={t('invoices.dueDate')}
            optional
            // Empty: what the customer's payment terms make it, worked out the API's way
            hint={
              dueDate === '' && terms !== undefined
                ? `${t('invoices.dueDateHint')} ${t('invoices.dueOn', {
                    date: isoDate(dueDateOf(date, terms)),
                  })}`
                : t('invoices.dueDateHint')
            }
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <TextField
            label={t('invoices.customerReference')}
            optional
            hint={t('invoices.customerReferenceHint')}
            placeholder={t('invoices.customerReferencePlaceholder')}
            {...register('customerReference')}
            error={errors.customerReference?.message}
          />
          <SelectField
            label={t('invoices.branch')}
            hint={t('invoices.branchHint')}
            options={[
              { value: '', label: t('invoices.branch') },
              ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
          <SelectField
            label={t('invoices.warehouse')}
            optional
            hint={t('invoices.warehouseHint')}
            options={[
              { value: '', label: t('invoices.noWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId', {
              // The goods leave a branch's warehouse: its branch, when none is picked yet
              onChange: () => {
                const branchId = branchOf(getValues('warehouseId') ?? null);
                if (getValues('branchId') === '' && branchId !== undefined) {
                  setValue('branchId', branchId);
                }
              },
            })}
            error={errors.warehouseId?.message}
          />
          <div className="grid min-w-0 content-start gap-1.5">
            <span className="text-label font-medium text-ink">{t('invoices.billingAddress')}</span>
            {/* Copied onto the invoice when it is saved; changed on the customer's page */}
            <span className="text-body-sm whitespace-pre-line text-ink-2">
              {billingAddress ?? t('invoices.noBillingAddress')}
            </span>
          </div>
          <div className="sm:col-span-2">
            <TextField
              label={t('invoices.note')}
              optional
              placeholder={t('invoices.notePlaceholder')}
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
              <InvoiceLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={saved.meta}
                customerId={customerId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
                warehouseId={warehouseId}
                origins={origins}
                orderPricing={linePricing}
                onSourced={sourced}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {invoice && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(invoice);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('invoices.confirmDelete') : t('invoices.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('invoices.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('invoices.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || lines.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('invoices.posting') : t('invoices.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('invoices.postHint')}</p>
      </form>
      <CreditLimitDialog
        stop={stop}
        customer={customer?.name ?? savedCustomer?.name ?? ''}
        confirmLabel={t('creditLimit.postInvoice')}
        pending={isSubmitting}
        onConfirm={() => void save(true, true)()}
        onClose={() => {
          setStop(null);
        }}
      />
    </div>
  );
}
