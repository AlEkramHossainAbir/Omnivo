import { Delete02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomerAddress,
  type Quotation,
  routes,
  type SalesOrder,
  type SalesOrderFormValues,
  updateSalesOrderInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  FormAlert,
  DatePicker,
  FormField,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { SALES_LINE_FIELDS, savedLines } from '../lib/sales';
import { customerQuery } from '../lib/queries';
import { CustomerPicker } from './customer-picker';
import { failureOf } from './journal-parts';
import { addressLabel, SalesBackLink, useSalesRefresh } from './sales-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The order form: its own chunk (loaded by routes/sales-order.tsx), like the quotation's.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money and discount boxes (cost-input.tsx says the same of the adjustment form), and inside this
// chunk it took the form over its 100 KB budget
const SalesLinesEditor = lazy(async () => ({
  default: (await import('./sales-line-editor')).SalesLinesEditor,
}));

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

// Writing a new order (from nothing, or from a quotation), or changing a draft. "Save draft" keeps
// it a draft; "Confirm order" saves and confirms in one request, all or nothing.
export function SalesOrderForm({
  order,
  quotation,
  today,
  pricesIncludeVat,
}: {
  order: SalesOrder | null;
  // The quotation a new order is made from ("Make order"); null otherwise
  quotation: Quotation | null;
  today: string;
  // The order's own copy, the quotation's (an order keeps its quotation's prices), or the
  // workspace's now
  pricesIncludeVat: boolean;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = useSalesRefresh();
  const { active } = useWarehouses();
  const [confirming, setConfirming] = useState(false);
  const [start] = useState(() => {
    if (order) return savedLines(order.lines, order.customer.id);
    if (quotation) return savedLines(quotation.lines, quotation.customer.id);
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
      customerId: savedCustomer?.id ?? '',
      date: order?.date ?? today,
      deliveryDate: order?.deliveryDate ?? '',
      customerReference: order?.customerReference ?? '',
      warehouseId: order?.warehouseId ?? onlyWarehouse ?? '',
      shippingAddressId: order?.shippingAddressId ?? '',
      note: order?.note ?? '',
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

  const save = (confirm: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, confirm };
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
        if (!order) {
          void navigate({
            to: '/sales-orders/$orderId',
            params: { orderId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lineCount), setError);
      }
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
        title={order ? (order.number ?? t('salesOrders.draftTitle')) : t('salesOrders.newTitle')}
        description={
          quotation
            ? `${t('salesOrders.quotation')}: ${quotation.number}`
            : t('salesOrders.description')
        }
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {keptNumber !== null && (
          <p className="text-body-sm text-ink-2">
            {t('salesOrders.numberedDraft', { number: keptNumber })}
          </p>
        )}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField
            control={control}
            name="customerId"
            label={t('salesOrders.customer')}
            hint={customerLocked ? t('salesOrders.customerLocked') : undefined}
          >
            {(field) => (
              <CustomerPicker
                {...field}
                saved={savedCustomer}
                disabled={customerLocked}
                onChange={(next) => void changeCustomer(next)}
              />
            )}
          </FormField>
          <FormField control={control} name="date" label={t('salesOrders.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <FormField
            control={control}
            name="deliveryDate"
            label={t('salesOrders.deliveryDate')}
            optional
            hint={t('salesOrders.deliveryDateHint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
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
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

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
        <p className="text-right text-label text-ink-3">{t('salesOrders.confirmHint')}</p>
      </form>
    </div>
  );
}
