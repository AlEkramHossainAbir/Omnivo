import { Calendar03Icon, Delete02Icon, TaskDone01Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type GoodsReceipt,
  isQuantityOrZero,
  isZeroQuantity,
  plainQuantity,
  type PurchaseOrder,
  receivedOf,
  routes,
  updateGoodsReceiptInputSchema,
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
  Select,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useRef, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { allowedToReceive, leftToReceive, receiptFill } from '../lib/purchase';
import {
  goodsReceiptQuery,
  ordersToReceiveQuery,
  purchaseOrderQuery,
  settingsQuery,
  unitsQuery,
} from '../lib/queries';
import { baseByOrderLine } from '../lib/sales';
import { basePreview, firstMessage, serialPath } from '../lib/stock';
import { failureOf, LineField } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The goods receipt form (step 17b): its own chunk (loaded by routes/goods-receipt.tsx), like the
// delivery form. A receipt is a stock document made from an approved order (decision 8): its lines
// are the stock lines of step 13 that bring stock in (a lot and its dates, serial numbers), each
// naming its order line, with what the gate turned back beside what it accepted (decision 9).

// The supplier box and the date picker as chunks of their own, like the delivery form's: both
// bring the popover
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// The edit form's values, which the create form shares: the order is not one of them. A receipt
// keeps its order (the update route has no orderId), so the form keeps it beside its values, and
// a new receipt adds it to the body.
type FormValues = z.input<typeof updateGoodsReceiptInputSchema>;
type LineValues = FormValues['lines'][number];

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'date',
    'warehouseId',
    'supplierChallan',
    'vehicle',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'lotNumber'),
      rowPath('lines', index, 'expiresOn'),
      rowPath('lines', index, 'manufacturedOn'),
      rowPath('lines', index, 'serialNumbers'),
      rowPath('lines', index, 'orderLineId'),
      rowPath('lines', index, 'rejectedQuantity'),
      rowPath('lines', index, 'rejectionReason'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// What is left on an order, as receipt lines, and the items they need. `onForm`: what the form
// already accepts for each order line, in the base unit.
function linesFrom(
  order: PurchaseOrder,
  onForm: ReadonlyMap<string, string>,
): { lines: LineValues[]; items: LineItem[] } {
  return {
    lines: receiptFill(order.lines, onForm).map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      batchId: '',
      lotNumber: '',
      expiresOn: '',
      manufacturedOn: '',
      serialNumbers: [],
      orderLineId: line.orderLineId,
      rejectedQuantity: '',
      rejectionReason: '',
    })),
    items: order.lines.map(toLineItem),
  };
}

// Writing a new goods receipt (from an order's "Receive goods", or by picking the supplier and its
// order), or changing a draft. "Save draft" keeps it a draft; "Post goods receipt" saves and posts
// in one request: the accepted goods come into stock at the order's price, all or nothing.
export function GoodsReceiptForm({
  receipt,
  order,
  today,
}: {
  receipt: GoodsReceipt | null;
  // The order a new receipt starts from ("Receive goods" on the order's page); null otherwise
  order: PurchaseOrder | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const { active, byId } = useWarehouses();
  const [confirming, setConfirming] = useState(false);
  const [start] = useState(() => (order ? linesFrom(order, new Map()) : null));
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () =>
      new Map(
        [...(receipt?.lines ?? []), ...(start?.items ?? [])].map((line) => [
          line.variantId,
          toLineItem(line),
        ]),
      ),
  );
  // The supplier only narrows the order box; the receipt takes its supplier from the order
  const [supplierId, setSupplierId] = useState(receipt?.supplier.id ?? order?.supplier.id ?? '');
  // Step 17c: a receipt a bill made has no order (decision 21), but it is posted the moment it is
  // made, so a draft on this form always has one
  const [orderId, setOrderId] = useState(receipt?.order?.id ?? order?.id ?? '');
  // The order picked last, for the change that waits for its order: a quicker second pick wins
  const pickedRef = useRef(orderId);
  // A draft keeps its order (decision 20); "Receive goods" came with one
  const locked = receipt !== null || order !== null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateGoodsReceiptInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: receipt?.date ?? today,
      warehouseId: receipt?.warehouseId ?? order?.warehouseId ?? '',
      supplierChallan: receipt?.supplierChallan ?? '',
      vehicle: receipt?.vehicle ?? '',
      note: receipt?.note ?? '',
      lines:
        receipt?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          lotNumber: line.lotNumber ?? '',
          expiresOn: line.expiresOn ?? '',
          manufacturedOn: line.manufacturedOn ?? '',
          serialNumbers: line.serialNumbers,
          orderLineId: line.orderLineId ?? '',
          // Nothing turned back is an empty box, not "0"
          rejectedQuantity: isZeroQuantity(line.rejectedQuantity)
            ? ''
            : plainQuantity(line.rejectedQuantity),
          rejectionReason: line.rejectionReason ?? '',
        })) ??
        start?.lines ??
        [],
      post: false,
      version: receipt?.version ?? 1,
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  // The over-receipt percent (decision 22), for "Up to … may come"
  const percent = useQuery(settingsQuery(tenantId)).data?.overReceiptPercent ?? '0';
  const openOrders = useQuery({
    ...ordersToReceiveQuery(tenantId, supplierId),
    enabled: supplierId !== '' && !locked,
  }).data;
  // The chosen order with its lines: what each line ordered, received and has left
  const chosenOrder = useQuery({
    ...purchaseOrderQuery(tenantId, orderId),
    enabled: orderId !== '',
  }).data;
  const orderLines = new Map(chosenOrder?.lines.map((line) => [line.id, line]));

  // The order box: the supplier's approved orders with goods to come, or (locked) the one order
  const orderOptions = locked
    ? [{ value: orderId, label: receipt?.order?.number ?? order?.number ?? '' }]
    : [
        { value: '', label: t('goodsReceipts.orderPlaceholder') },
        ...(openOrders ?? []).map((open) => ({
          value: open.id,
          label: [open.number ?? '', isoDate(open.date), open.supplierReference]
            .filter((part) => part !== null && part !== '')
            .join(' · '),
        })),
      ];

  // The base quantity a line accepts, for "what is left" (null while a quantity is being typed)
  const baseOf = (line: LineValues): string | null => {
    const item = items.get(line.variantId);
    if (!item) return null;
    return line.unitId === item.baseUnitId
      ? line.quantity.trim() === ''
        ? null
        : line.quantity.trim()
      : basePreview(item, line.unitId, line.quantity, units);
  };

  const addItems = (next: readonly LineItem[]) => {
    setItems((before) => {
      const map = new Map(before);
      for (const item of next) map.set(item.variantId, toLineItem(item));
      return map;
    });
  };

  // Another supplier: its orders, so the order and its lines go
  const changeSupplier = (next: string) => {
    setSupplierId(next);
    setOrderId('');
    pickedRef.current = '';
    replace([]);
  };

  // Another order: its warehouse and what it has left replace what was there
  const changeOrder = async (next: string) => {
    setOrderId(next);
    pickedRef.current = next;
    replace([]);
    if (next === '') return;
    const picked = await queryClient.query(purchaseOrderQuery(tenantId, next));
    if (pickedRef.current !== next) return;
    setValue('warehouseId', picked.warehouseId);
    const filled = linesFrom(picked, new Map());
    addItems(filled.items);
    replace(filled.lines);
  };

  // "Add what is left on the order": only what the form does not accept yet
  const fillRest = () => {
    if (!chosenOrder) return;
    const onForm = baseByOrderLine(
      getValues('lines').map((line) => ({ orderLineId: line.orderLineId, base: baseOf(line) })),
    );
    const filled = linesFrom(chosenOrder, onForm);
    if (filled.lines.length === 0) {
      toast(t('goodsReceipts.nothingLeft'));
      return;
    }
    addItems(filled.items);
    append(filled.lines);
  };

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const saved = receipt
          ? await call(routes.goodsReceipts.update, {
              params: { id: receipt.id },
              body: { ...values, post, version },
            })
          : await call(routes.goodsReceipts.create, { body: { ...values, orderId, post } });
        queryClient.setQueryData(goodsReceiptQuery(tenantId, saved.id).queryKey, saved);
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('goodsReceipts.posted', { number: saved.number ?? '' })
            : t('goodsReceipts.draftSaved'),
        );
        if (!receipt) {
          void navigate({
            to: '/goods-receipts/$receiptId',
            params: { receiptId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: GoodsReceipt) =>
      call(routes.goodsReceipts.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await navigate({ to: '/goods-receipts' });
      await refresh();
      toast(t('goodsReceipts.deleted'));
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/goods-receipts" label={t('goodsReceipts.back')} />
      <PageHeader
        title={receipt ? t('goodsReceipts.draftTitle') : t('goodsReceipts.newTitle')}
        description={t('goodsReceipts.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          {/* Not form values: the update route keeps the order, and the supplier only narrows
              the order box */}
          <Field id="grn-supplier" label={t('goodsReceipts.supplier')}>
            <Suspense fallback={<Input id="grn-supplier" icon={UserIcon} disabled />}>
              <PartyPicker
                id="grn-supplier"
                role="supplier"
                value={supplierId}
                saved={receipt?.supplier ?? order?.supplier ?? null}
                disabled={locked}
                onChange={changeSupplier}
              />
            </Suspense>
          </Field>
          <Field
            id="grn-order"
            label={t('goodsReceipts.order')}
            hint={
              locked
                ? t('goodsReceipts.orderLocked')
                : openOrders?.length === 0
                  ? t('goodsReceipts.orderEmpty')
                  : t('goodsReceipts.orderHint')
            }
          >
            <Select
              id="grn-order"
              options={orderOptions}
              value={orderId}
              disabled={locked || supplierId === ''}
              aria-describedby="grn-order-hint"
              onChange={(event) => void changeOrder(event.target.value)}
            />
          </Field>
          <FormField control={control} name="date" label={t('goodsReceipts.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('goodsReceipts.warehouse')}
            // The truck may unload elsewhere (decision 20): say where the order wanted it
            hint={
              chosenOrder
                ? t('goodsReceipts.warehouseHint', {
                    warehouse: warehouseLabel(byId.get(chosenOrder.warehouseId)),
                  })
                : undefined
            }
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <TextField
            label={t('goodsReceipts.supplierChallan')}
            optional
            placeholder={t('goodsReceipts.supplierChallanPlaceholder')}
            {...register('supplierChallan')}
            error={errors.supplierChallan?.message}
          />
          <TextField
            label={t('goodsReceipts.vehicle')}
            optional
            placeholder={t('goodsReceipts.vehiclePlaceholder')}
            {...register('vehicle')}
            error={errors.vehicle?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('goodsReceipts.note')}
              optional
              placeholder={t('goodsReceipts.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('stockLines.noLines')}</p>
          ) : (
            <StockLinesHeader quantityLabel={t('goodsReceipts.accepted')} />
          )}
          {fields.map((field, index) => {
            const item = items.get(field.variantId);
            if (!item) return null;
            const line = lines[index];
            const lineErrors = errors.lines?.[index];
            const serials = rowPath('lines', index, 'serialNumbers');
            const rejected = rowPath('lines', index, 'rejectedQuantity');
            const reason = rowPath('lines', index, 'rejectionReason');
            const orderLine = orderLines.get(line?.orderLineId ?? '');
            const unitId = line?.unitId ?? item.baseUnitId;
            const typed = line?.quantity.trim() ?? '';
            // An empty accepted box counts as nothing: everything that came was turned back
            const accepted = typed === '' ? '0' : typed;
            const turnedBack = line?.rejectedQuantity.trim() ?? '';
            // Something typed in the rejected box that is not nothing: the reason box shows
            const rejecting =
              turnedBack !== '' && !(isQuantityOrZero(turnedBack) && isZeroQuantity(turnedBack));
            // What came off the truck, once both boxes hold quantities (decision 9)
            const came =
              rejecting && isQuantityOrZero(turnedBack) && isQuantityOrZero(accepted)
                ? receivedOf({ quantity: accepted, rejectedQuantity: turnedBack })
                : null;
            return (
              <StockLineRow
                key={field.id}
                index={index}
                item={item}
                mode="in"
                warehouseId={warehouseId}
                unitId={unitId}
                quantity={line?.quantity ?? ''}
                quantityLabel={t('goodsReceipts.accepted')}
                fields={{
                  unitId: register(rowPath('lines', index, 'unitId')),
                  quantity: register(rowPath('lines', index, 'quantity')),
                  batchId: register(rowPath('lines', index, 'batchId')),
                  lotNumber: register(rowPath('lines', index, 'lotNumber')),
                }}
                note={
                  orderLine && (
                    <span className="text-caption text-ink-3 tabular-nums">
                      {t('goodsReceipts.ordered', {
                        quantity: quantityText(orderLine.quantity, orderLine.unitId),
                      })}{' '}
                      ·{' '}
                      {t('goodsReceipts.leftOnOrder', {
                        quantity: quantityText(leftToReceive(orderLine), orderLine.baseUnitId),
                      })}
                      {/* Only when the workspace lets more in (decision 22) */}
                      {!isZeroQuantity(percent) &&
                        ` · ${t('goodsReceipts.allowed', {
                          quantity: quantityText(
                            allowedToReceive(orderLine, percent),
                            orderLine.baseUnitId,
                          ),
                        })}`}
                    </span>
                  )
                }
                rejection={
                  <div className="grid grid-cols-1 gap-3">
                    <LineField
                      id={rejected}
                      label={t('goodsReceipts.rejected')}
                      error={lineErrors?.rejectedQuantity?.message}
                    >
                      <Input
                        id={rejected}
                        inputMode="decimal"
                        autoComplete="off"
                        align="end"
                        invalid={lineErrors?.rejectedQuantity !== undefined}
                        {...register(rejected)}
                      />
                      {came !== null && (
                        <span className="text-right text-caption text-ink-3 tabular-nums">
                          {t('goodsReceipts.came', { quantity: quantityText(came, unitId) })}
                        </span>
                      )}
                    </LineField>
                    {/* The reason only when something was turned back: it is kept only then
                        (decision 38) */}
                    {rejecting || lineErrors?.rejectionReason !== undefined ? (
                      <LineField
                        id={reason}
                        label={t('goodsReceipts.rejectionReason')}
                        error={lineErrors?.rejectionReason?.message}
                      >
                        <Input
                          id={reason}
                          autoComplete="off"
                          placeholder={t('goodsReceipts.rejectionReasonPlaceholder')}
                          invalid={lineErrors?.rejectionReason !== undefined}
                          {...register(reason)}
                        />
                      </LineField>
                    ) : null}
                  </div>
                }
                dates={(['expiresOn', 'manufacturedOn'] as const).map((date) => (
                  <Controller
                    key={date}
                    control={control}
                    name={rowPath('lines', index, date)}
                    render={({ field: dateField, fieldState }) => (
                      <LineField
                        id={dateField.name}
                        label={t(`stockLines.${date}`)}
                        error={fieldState.error?.message}
                      >
                        <Suspense
                          fallback={<Input id={dateField.name} icon={Calendar03Icon} disabled />}
                        >
                          <DatePicker
                            id={dateField.name}
                            name={dateField.name}
                            ref={dateField.ref}
                            value={dateField.value ?? ''}
                            onChange={dateField.onChange}
                            onBlur={dateField.onBlur}
                            invalid={fieldState.error !== undefined}
                          />
                        </Suspense>
                      </LineField>
                    )}
                  />
                ))}
                serials={
                  <Controller
                    control={control}
                    name={serials}
                    render={({ field: serialField }) => {
                      const error = firstMessage(lineErrors?.serialNumbers);
                      return (
                        <LineField id={serials} label={t('stockLines.serials')} error={error}>
                          <SerialNumbersInput
                            id={serials}
                            name={serialField.name}
                            ref={serialField.ref}
                            value={serialField.value}
                            onChange={serialField.onChange}
                            onBlur={serialField.onBlur}
                            invalid={error !== undefined}
                          />
                          <span className="text-caption text-ink-3">
                            {t('stockLines.serialsHint')}
                          </span>
                        </LineField>
                      );
                    }}
                  />
                }
                errors={{
                  unitId: lineErrors?.unitId?.message,
                  // The order line's own problems (over the order, not this order's) show under
                  // the quantity, the box the person changes to fix them
                  quantity: lineErrors?.quantity?.message ?? lineErrors?.orderLineId?.message,
                  batchId: lineErrors?.batchId?.message,
                  lotNumber: lineErrors?.lotNumber?.message,
                }}
                onRemove={() => {
                  remove(index);
                }}
              />
            );
          })}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button variant="secondary" size="sm" disabled={!chosenOrder} onClick={fillRest}>
              <HugeiconsIcon icon={TaskDone01Icon} size={16} strokeWidth={1.5} />
              {t('goodsReceipts.fillFromOrder')}
            </Button>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {receipt && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(receipt);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('goodsReceipts.confirmDelete') : t('goodsReceipts.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('goodsReceipts.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting || orderId === ''}>
            {t('goodsReceipts.saveDraft')}
          </Button>
          <Button
            disabled={isSubmitting || orderId === '' || fields.length === 0}
            onClick={() => void save(true)()}
          >
            {isSubmitting ? t('goodsReceipts.posting') : t('goodsReceipts.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('goodsReceipts.postHint')}</p>
      </form>
    </div>
  );
}
