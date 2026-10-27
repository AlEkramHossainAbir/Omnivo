import { Calendar03Icon, Delete02Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomerAddress,
  type Quotation,
  routes,
  type SalesOrder,
  type SalesOrderDraftInput,
  type SalesOrderFormValues,
  SYNC_BLOCK_AFTER_DAYS,
  type SyncCommandError,
  updateSalesOrderInputSchema,
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
import { saveOrderDraft } from '@omnivo/sync';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError, applyCommandError } from '../lib/field-errors';
import { requestSync, useLocalCopy, useSaveMode } from '../lib/local-data';
import { useSyncAge } from '../lib/sync-summary';
import { rowPath } from '../lib/products';
import { formTotals, type LineMeta, SALES_LINE_FIELDS, savedLines } from '../lib/sales';
import { useCan } from '../lib/permissions';
import { customerQuery, taxRatesQuery } from '../lib/queries';
import { useOnline } from '../lib/use-online';
import {
  CreditLimitDialog,
  CreditLine,
  type CreditStop,
  creditStopOf,
  useCreditText,
} from './credit-parts';
import { failureOf } from './journal-parts';
import { addressLabel, DocumentNotice, SalesBackLink, useSalesRefresh } from './sales-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The order form: its own chunk (loaded by routes/sales-order.tsx), like the quotation's.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money and discount boxes (cost-input.tsx says the same of the adjustment form), and inside this
// chunk it took the form over its 100 KB budget
const SalesLinesEditor = lazy(async () => ({
  default: (await import('./sales-line-editor')).SalesLinesEditor,
}));
// The customer box and the date picker too (step 15c): both bring the popover, and with the 15c
// contracts and the credit line this chunk went over its budget (the delivery form did the same)
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = SalesOrderFormValues;

function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'deliveryDate',
    'customerReference',
    'warehouseId',
    'shippingAddressId',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      SALES_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// The addresses goods can go to: the shipping ones (the first is the default)
function shippingAddresses(addresses: readonly CustomerAddress[]): CustomerAddress[] {
  return addresses.filter((address) => address.kind === 'shipping');
}

// Step 18b: a draft order waiting in the outbox, opened again from the unsynced orders or the
// Sync page. Its lines come with their products from the device (sales.ts → draftLines).
export interface OutboxDraft {
  orderId: string;
  input: SalesOrderDraftInput;
  lines: { values: SalesOrderFormValues['lines']; meta: LineMeta[] };
  // Refused by the server: its errors go under the boxes
  error: SyncCommandError | null;
}

// Writing a new order (from nothing, or from a quotation), or changing a draft. "Save draft" keeps
// it a draft; "Confirm order" saves and confirms in one request, all or nothing. Step 18b: offline,
// or for a customer whose changes wait on this device, it saves a draft into the outbox instead.
export function SalesOrderForm({
  order,
  quotation,
  draft = null,
  today,
  pricesIncludeVat,
}: {
  order: SalesOrder | null;
  // The quotation a new order is made from ("Make order"); null otherwise
  quotation: Quotation | null;
  draft?: OutboxDraft | null;
  today: string;
  // The order's own copy, the quotation's (an order keeps its quotation's prices), or the
  // workspace's now
  pricesIncludeVat: boolean;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = useSalesRefresh();
  const { active } = useWarehouses();
  const [confirming, setConfirming] = useState(false);
  // Step 15c: the limit and the amount when confirming would go over the customer's credit limit,
  // for someone who may go over it (the dialog asks); null otherwise
  const [stop, setStop] = useState<CreditStop | null>(null);
  const canOverride = useCan()('sales.credit.override');
  const creditText = useCreditText();
  const [start] = useState(() => {
    if (order) return savedLines(order.lines, order.customer.id);
    if (quotation) return savedLines(quotation.lines, quotation.customer.id);
    if (draft) return draft.lines;
    return { values: [], meta: [] };
  });
  // A draft that has a number, or comes from a quotation, keeps its customer (the API refuses a
  // change): the box is read only and says why
  const customerLocked =
    quotation !== null || (order !== null && (order.number !== null || order.quotation !== null));
  const savedCustomer = order?.customer ?? quotation?.customer ?? null;
  // A reopened draft keeps its number (15b.3)
  const keptNumber = order?.number ?? null;
  const onlyWarehouse = active?.length === 1 ? active[0]?.id : undefined;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSalesOrderInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? draft?.input.customerId ?? '',
      date: order?.date ?? draft?.input.date ?? today,
      deliveryDate: order?.deliveryDate ?? draft?.input.deliveryDate ?? '',
      customerReference: order?.customerReference ?? draft?.input.customerReference ?? '',
      warehouseId: order?.warehouseId ?? draft?.input.warehouseId ?? onlyWarehouse ?? '',
      shippingAddressId: order?.shippingAddressId ?? draft?.input.shippingAddressId ?? '',
      note: order?.note ?? draft?.input.note ?? '',
      lines: start.values,
      confirm: false,
      version: order?.version ?? 1,
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const lineCount = useWatch({ control, name: 'lines' }).length;
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  const addresses = shippingAddresses(customer?.addresses ?? []);
  // Step 18b (decision 2): a new order goes into the outbox offline, and online when its customer
  // has changes waiting on this device (a customer made offline is not on the server yet). A
  // server draft and an order from a quotation stay with the API: neither can be a command.
  const online = useOnline();
  const copy = useLocalCopy();
  const customerMode = useSaveMode(customerId);
  const onDevice =
    order === null &&
    quotation === null &&
    (draft !== null || !online || customerMode === 'device');
  // Step 18c (decision 12): 7 days after the last sync, no new draft on the device. A refused draft
  // opened from the Sync page is blocked too: saving it again is new work on the device.
  const age = useSyncAge();
  const blocked = onDevice && age?.age === 'blocked';
  const rates = useQuery(taxRatesQuery(tenantId)).data;

  // Once, when the form opens a refused draft: its errors where the person fixes them
  useEffect(() => {
    if (draft?.error)
      applyCommandError(draft.error, fieldNames(draft.lines.values.length), setError);
  }, [draft, setError]);
  // The address the draft was saved with, if it is no longer one of the customer's shipping
  // addresses: it still shows as chosen, by the text the order kept
  const keptId = order?.shippingAddressId ?? null;
  const keptAddress =
    order !== null &&
    keptId !== null &&
    customerId === order.customer.id &&
    !addresses.some((address) => address.id === keptId)
      ? { value: keptId, label: order.shippingAddress ?? '' }
      : null;

  // A new customer: their first shipping address, or none
  const changeCustomer = async (next: string) => {
    setValue('customerId', next, { shouldValidate: errors.customerId !== undefined });
    setValue('shippingAddressId', '');
    if (next === '') return;
    const picked = await queryClient.query(customerQuery(tenantId, next));
    if (getValues('customerId') !== next) return;
    setValue('shippingAddressId', shippingAddresses(picked.addresses)[0]?.id ?? '');
  };

  // override: the second try, after the person saw the credit dialog and went on
  const save = (confirm: boolean, override = false) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, confirm, overrideCreditLimit: override };
        const saved = order
          ? await call(routes.salesOrders.update, {
              params: { id: order.id },
              body: { ...body, version },
            })
          : await call(routes.salesOrders.create, {
              body: { ...body, quotationId: quotation?.id ?? null },
            });
        await refresh();
        toast(
          saved.status === 'confirmed'
            ? t('salesOrders.confirmed', { number: saved.number ?? '' })
            : t('salesOrders.draftSaved'),
        );
        setStop(null);
        if (!order) {
          void navigate({
            to: '/sales-orders/$orderId',
            params: { orderId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        // Over the credit limit: ask, if the person may go over it; else say so, with the amounts
        const credit = creditStopOf(error);
        if (credit !== null && canOverride && !override) {
          setStop(credit);
          return;
        }
        setStop(null);
        const text = creditText(error);
        if (text !== null) setError('root.server', { message: text });
        else applyApiError(error, fieldNames(lineCount), setError);
      }
    });

  // Into the outbox (decision 15): a draft only, so no confirm and no credit check. The name and
  // the total are kept with it for the Sync page and the unsynced orders.
  const saveOnDevice = handleSubmit(async (values) => {
    // Enter in a box submits the form even with no submit button
    if (!copy || blocked) return;
    const input: SalesOrderDraftInput = {
      customerId: values.customerId,
      date: values.date,
      deliveryDate: values.deliveryDate,
      customerReference: values.customerReference,
      warehouseId: values.warehouseId,
      shippingAddressId: values.shippingAddressId,
      note: values.note,
      lines: values.lines,
    };
    const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
    let result;
    try {
      result = await saveOrderDraft(copy, {
        orderId: draft?.orderId ?? null,
        input,
        name: customer?.name ?? '',
        total: formTotals(values.lines, rateOf, pricesIncludeVat).totals.total,
        savedAt: new Date().toISOString(),
      });
    } catch {
      setError('root.server', { message: t('sync.saveFailed') });
      return;
    }
    if (result === 'busy') {
      setError('root.server', { message: t('sync.busy') });
      return;
    }
    requestSync();
    toast(t('sync.savedOnDevice'));
    void navigate({ to: '/sales-orders', replace: true });
  });

  const removeDraft = useMutation({
    mutationFn: (draft: SalesOrder) =>
      call(routes.salesOrders.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('salesOrders.deleted'));
      void navigate({ to: '/sales-orders' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
      <PageHeader
        title={
          order
            ? (order.number ?? t('salesOrders.draftTitle'))
            : draft
              ? t('salesOrders.draftTitle')
              : t('salesOrders.newTitle')
        }
        description={
          quotation
            ? `${t('salesOrders.quotation')}: ${quotation.number}`
            : t('salesOrders.description')
        }
      />
      <form
        noValidate
        onSubmit={(event) => void (onDevice ? saveOnDevice(event) : save(false)(event))}
        className="grid grid-cols-1 gap-5"
      >
        {onDevice && !blocked && (
          <DocumentNotice tone="neutral">
            {online ? t('sync.waitingNotice') : t('sync.orderOfflineNotice')}
          </DocumentNotice>
        )}
        {blocked && (
          <DocumentNotice tone="warn">
            {t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
          </DocumentNotice>
        )}
        {failure && <FormAlert message={failure} />}
        {keptNumber !== null && (
          <p className="text-body-sm text-ink-2">
            {t('salesOrders.numberedDraft', { number: keptNumber })}
          </p>
        )}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <FormField
              control={control}
              name="customerId"
              label={t('salesOrders.customer')}
              hint={customerLocked ? t('salesOrders.customerLocked') : undefined}
            >
              {(field) => (
                <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                  <CustomerPicker
                    {...field}
                    saved={savedCustomer}
                    disabled={customerLocked}
                    onChange={(next) => void changeCustomer(next)}
                  />
                </Suspense>
              )}
            </FormField>
            <CreditLine customerId={customerId} onDevice={onDevice} />
          </div>
          <FormField control={control} name="date" label={t('salesOrders.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField
            control={control}
            name="deliveryDate"
            label={t('salesOrders.deliveryDate')}
            optional
            hint={t('salesOrders.deliveryDateHint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <TextField
            label={t('salesOrders.customerReference')}
            optional
            hint={t('salesOrders.customerReferenceHint')}
            placeholder={t('salesOrders.customerReferencePlaceholder')}
            {...register('customerReference')}
            error={errors.customerReference?.message}
          />
          <SelectField
            label={t('salesOrders.warehouse')}
            hint={t('salesOrders.warehouseHint')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <SelectField
            label={t('salesOrders.shippingAddress')}
            optional
            options={[
              { value: '', label: t('salesOrders.noShippingAddress') },
              ...addresses.map((address) => ({ value: address.id, label: addressLabel(address) })),
              ...(keptAddress ? [keptAddress] : []),
            ]}
            {...register('shippingAddressId')}
            error={errors.shippingAddressId?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('salesOrders.note')}
              optional
              placeholder={t('salesOrders.notePlaceholder')}
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
              <SalesLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                customerId={customerId}
                onDevice={onDevice}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

        {onDevice ? (
          !blocked && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {t('sync.saveOnDevice')}
              </Button>
            </div>
          )
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* A reopened draft keeps its number and cannot be deleted (it says so above) */}
            {order?.number === null && (
              <div className="mr-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={removeDraft.isPending}
                  onClick={() => {
                    if (confirming) removeDraft.mutate(order);
                    else setConfirming(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {confirming ? t('salesOrders.confirmDelete') : t('salesOrders.deleteDraft')}
                </Button>
                {confirming && (
                  <span className="text-body-sm text-ink-2">{t('salesOrders.deleteWarning')}</span>
                )}
              </div>
            )}
            <Button type="submit" variant="secondary" disabled={isSubmitting}>
              {t('salesOrders.saveDraft')}
            </Button>
            <Button disabled={isSubmitting || lineCount === 0} onClick={() => void save(true)()}>
              {isSubmitting ? t('salesOrders.confirming') : t('salesOrders.confirm')}
            </Button>
          </div>
        )}
        {!onDevice && (
          <p className="text-right text-label text-ink-3">{t('salesOrders.confirmHint')}</p>
        )}
      </form>
      <CreditLimitDialog
        stop={stop}
        customer={customer?.name ?? savedCustomer?.name ?? ''}
        confirmLabel={t('creditLimit.confirmOrder')}
        pending={isSubmitting}
        onConfirm={() => void save(true, true)()}
        onClose={() => {
          setStop(null);
        }}
      />
    </div>
  );
}
