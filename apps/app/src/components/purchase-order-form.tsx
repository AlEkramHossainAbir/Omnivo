import { Calendar03Icon, UserIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type PurchaseOrder,
  type PurchaseOrderFormValues,
  routes,
  updatePurchaseOrderInputSchema,
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
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { PURCHASE_ORDER_LINE_FIELDS, savedOrderLines } from '../lib/purchase';
import { purchaseOrderQuery, supplierQuery } from '../lib/queries';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The purchase order form (step 17b): its own chunk (loaded by routes/purchase-order.tsx), like
// the requisition's. It writes a draft; the order's page submits it for approval (decision 13), so
// the person sees the levels its total reaches before sending it.

// The line editor, the supplier box and the date picker as chunks of their own, loaded as the form
// opens, like the sales order form's: the editor brings decimal.js with the money and discount
// boxes, and the two boxes bring the popover
const PurchaseOrderLinesEditor = lazy(async () => ({
  default: (await import('./purchase-order-lines')).PurchaseOrderLinesEditor,
}));
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = PurchaseOrderFormValues;

function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'supplierId',
    'date',
    'expectedDate',
    'warehouseId',
    'supplierReference',
    'paymentTermsDays',
    'pricesIncludeVat',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      PURCHASE_ORDER_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// Writing a new order, or changing a draft (a new one, or one sent back by a rejection or a
// reopen). "Make purchase order" on a requisition comes with that requisition: its warehouse, and
// the lines still to order open at once.
export function PurchaseOrderForm({
  order,
  requisition,
  today,
  onClose,
}: {
  order: PurchaseOrder | null;
  requisition: { id: string; warehouseId: string } | null;
  today: string;
  // Back to the order's page (an edit); a new order goes to its page instead
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const { active, byId } = useWarehouses();
  const [start] = useState(() =>
    order ? savedOrderLines(order) : { values: [], meta: [], links: new Map() },
  );
  // A reopened draft keeps its number, and with it its supplier (decision 33): the number went to
  // that supplier
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
    resolver: zodResolver(updatePurchaseOrderInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: order?.supplier.id ?? '',
      date: order?.date ?? today,
      expectedDate: order?.expectedDate ?? '',
      warehouseId: order?.warehouseId ?? requisition?.warehouseId ?? onlyWarehouse ?? '',
      supplierReference: order?.supplierReference ?? '',
      paymentTermsDays: order?.paymentTermsDays ?? 0,
      // Off for a new order (decision 15): a supplier quotes before VAT
      pricesIncludeVat: order?.pricesIncludeVat ?? false,
      note: order?.note ?? '',
      lines: start.values,
      // A new order has no version; 1 passes the schema, and the create route never reads it
      version: order?.version ?? 1,
    },
  });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const pricesIncludeVat = useWatch({ control, name: 'pricesIncludeVat' });

  // The active warehouses, and the draft's own if it was archived since (decision 34: a draft may
  // keep it, and the submit says so)
  const own = order ? byId.get(order.warehouseId) : undefined;
  const warehouses = [...(active ?? []), ...(own && own.archivedAt !== null ? [own] : [])];

  // Another supplier: its payment terms (decision 15). The lines keep their prices; the editor
  // offers this supplier's last prices with one click.
  const changeSupplier = async (next: string) => {
    setValue('supplierId', next, { shouldValidate: errors.supplierId !== undefined });
    if (next === '') return;
    const picked = await queryClient.query(supplierQuery(tenantId, next));
    if (getValues('supplierId') === next) setValue('paymentTermsDays', picked.paymentTermsDays);
  };

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = order
        ? await call(routes.purchaseOrders.update, {
            params: { id: order.id },
            body: { ...values, version },
          })
        : await call(routes.purchaseOrders.create, { body: values });
      queryClient.setQueryData(purchaseOrderQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(
        saved.number === null
          ? t('purchaseOrders.draftSaved')
          : t('purchaseOrders.saved', { number: saved.number }),
      );
      if (order) onClose?.();
      else {
        void navigate({
          to: '/purchase-orders/$orderId',
          params: { orderId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(getValues('lines').length), setError);
    }
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-orders" label={t('purchaseOrders.back')} />
      <PageHeader
        title={
          order ? (order.number ?? t('purchaseOrders.draftTitle')) : t('purchaseOrders.newTitle')
        }
        description={t('purchaseOrders.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {keptNumber !== null && (
          <p className="text-body-sm text-ink-2">
            {t('purchaseOrders.numberedDraft', { number: keptNumber })}
          </p>
        )}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField
            control={control}
            name="supplierId"
            label={t('purchaseOrders.supplier')}
            hint={keptNumber !== null ? t('purchaseOrders.supplierLocked') : undefined}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={order?.supplier ?? null}
                  disabled={keptNumber !== null}
                  onChange={(next) => void changeSupplier(next)}
                />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="date" label={t('purchaseOrders.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <FormField
            control={control}
            name="expectedDate"
            label={t('purchaseOrders.expectedDate')}
            optional
            hint={t('purchaseOrders.expectedDateHint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('purchaseOrders.warehouse')}
            hint={t('purchaseOrders.warehouseHint')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...warehouses.map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <TextField
            label={t('purchaseOrders.supplierReference')}
            optional
            hint={t('purchaseOrders.supplierReferenceHint')}
            placeholder={t('purchaseOrders.supplierReferencePlaceholder')}
            {...register('supplierReference')}
            error={errors.supplierReference?.message}
          />
          <TextField
            label={t('purchaseOrders.paymentTerms')}
            hint={t('purchaseOrders.paymentTermsHint')}
            inputMode="numeric"
            autoComplete="off"
            align="end"
            suffix={t('suppliers.fields.days')}
            // The contract takes a number of days, not the box's text
            {...register('paymentTermsDays', { valueAsNumber: true })}
            error={errors.paymentTermsDays?.message}
          />
          <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
            <Controller
              control={control}
              name="pricesIncludeVat"
              render={({ field }) => (
                <Checkbox
                  id="pricesIncludeVat"
                  label={t('purchaseOrders.pricesIncludeVat')}
                  checked={field.value}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true);
                  }}
                />
              )}
            />
            <p className="pl-[27px] text-label text-ink-3">
              {t('purchaseOrders.pricesIncludeVatHint')}
            </p>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextAreaField
              label={t('purchaseOrders.note')}
              optional
              placeholder={t('purchaseOrders.notePlaceholder')}
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
              <PurchaseOrderLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                initialLinks={start.links}
                supplierId={supplierId}
                warehouseId={warehouseId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
                startPicking={requisition?.id ?? null}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('purchaseOrders.saveDraft')}
          </Button>
        </div>
      </form>
    </div>
  );
}
