import {
  Calendar03Icon,
  Delete02Icon,
  PlusSignIcon,
  TaskDone01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Delivery,
  type DeliveryFormValues,
  plainQuantity,
  routes,
  type SalesOrder,
  type StockItem,
  updateDeliveryInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Dialog,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { customerQuery, openOrdersQuery, salesOrderQuery, unitsQuery } from '../lib/queries';
import { baseByOrderLine, fillFromOrder, leftToDeliver } from '../lib/sales';
import { basePreview, fefoSplit, firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { addressLabel, SalesBackLink, useSalesRefresh } from './sales-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The delivery form: its own chunk (loaded by routes/delivery.tsx), like the stock documents'
// forms. A delivery is a stock document with a customer: its lines are the stock lines of step 13
// (batch, FEFO, serial numbers), and a line made from an order also names its order line.

// The customer and date boxes as chunks of their own, loaded as the form opens: both bring the
// popover (date-input.tsx says why that matters), and with it inside, this chunk stood at its
// 100 KB budget. customer-picker.tsx is already a module of its own.
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = DeliveryFormValues;
type LineValues = FormValues['lines'][number];

function emptyLine(item: LineItem, orderLineId = ''): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    serialNumbers: [],
    orderLineId,
  };
}

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'customerId',
    'orderId',
    'date',
    'warehouseId',
    'shippingAddressId',
    'vehicle',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      rowPath('lines', index, 'orderLineId'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// The lines of an order as delivery lines: what is still left, and the items they need
function linesFrom(
  order: SalesOrder,
  onForm: ReadonlyMap<string, string>,
): { lines: LineValues[]; items: LineItem[] } {
  const fill = fillFromOrder(order.lines, onForm);
  return {
    lines: fill.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      batchId: '',
      serialNumbers: [],
      orderLineId: line.orderLineId,
    })),
    items: order.lines.map(toLineItem),
  };
}

// The first shipping address of a customer, the default a delivery goes to
function firstShipping(addresses: readonly { id: string; kind: string }[]): string {
  return addresses.find((address) => address.kind === 'shipping')?.id ?? '';
}

// Writing a new delivery (from an order, or for goods without one), or changing a draft. "Save
// draft" keeps it a draft; "Post delivery" saves and posts in one request: the stock goes out and
// its cost is booked, all or nothing.
export function DeliveryForm({
  delivery,
  order,
  today,
}: {
  delivery: Delivery | null;
  // The order a new delivery starts from ("New delivery" on the order's page); null otherwise
  order: SalesOrder | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = useSalesRefresh();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [start] = useState(() => (order ? linesFrom(order, new Map()) : null));
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () =>
      new Map(
        [...(delivery?.lines ?? []), ...(start?.items ?? [])].map((line) => [
          line.variantId,
          toLineItem(line),
        ]),
      ),
  );
  const savedCustomer = delivery?.customer ?? order?.customer ?? null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateDeliveryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      orderId: delivery?.order?.id ?? order?.id ?? '',
      date: delivery?.date ?? today,
      warehouseId: delivery?.warehouseId ?? order?.warehouseId ?? '',
      shippingAddressId: delivery?.shippingAddressId ?? order?.shippingAddressId ?? '',
      vehicle: delivery?.vehicle ?? '',
      note: delivery?.note ?? '',
      lines:
        delivery?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          serialNumbers: line.serialNumbers,
          orderLineId: line.orderLineId ?? '',
        })) ??
        start?.lines ??
        [],
      post: false,
      version: delivery?.version ?? 1,
    },
  });
  const { fields, append, remove, insert, replace } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const customerId = useWatch({ control, name: 'customerId' });
  const orderId = useWatch({ control, name: 'orderId' }) ?? '';
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const { active } = useWarehouses();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  const openOrders = useQuery({
    ...openOrdersQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  // The chosen order with its lines: what each line was ordered and has left
  const chosenOrder = useQuery({
    ...salesOrderQuery(tenantId, orderId),
    enabled: orderId !== '',
  }).data;
  const orderLines = new Map(chosenOrder?.lines.map((line) => [line.id, line]));

  // The order box: the customer's confirmed orders, and the draft's own order if it is no longer
  // confirmed (posting then says why: order_not_confirmed)
  const savedOrder = delivery?.order ?? null;
  const orderOptions = [
    { value: '', label: t('deliveries.noOrder') },
    ...(openOrders ?? []).map((open) => ({
      value: open.id,
      label: [open.number ?? '', isoDate(open.date), open.customerReference]
        .filter((part) => part !== null && part !== '')
        .join(' · '),
    })),
    ...(savedOrder !== null &&
    customerId === delivery?.customer.id &&
    !(openOrders ?? []).some((open) => open.id === savedOrder.id)
      ? [{ value: savedOrder.id, label: savedOrder.number ?? t('salesOrders.statuses.draft') }]
      : []),
  ];
  const addresses = (customer?.addresses ?? []).filter((address) => address.kind === 'shipping');
  // The draft's address, if it is no longer one of the customer's shipping addresses
  const keptId = delivery?.shippingAddressId ?? null;
  const keptAddress =
    delivery !== null &&
    keptId !== null &&
    customerId === delivery.customer.id &&
    !addresses.some((address) => address.id === keptId)
      ? { value: keptId, label: delivery.shippingAddress ?? '' }
      : null;

  // The base quantity each line holds, for "what is left" (null while a quantity is being typed)
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

  // Another customer: the order (theirs) and its lines go, and the address is the new customer's
  const changeCustomer = async (next: string) => {
    setValue('customerId', next, { shouldValidate: errors.customerId !== undefined });
    if (getValues('orderId') !== '') {
      setValue('orderId', '');
      replace([]);
    }
    setValue('shippingAddressId', '');
    if (next === '') return;
    const picked = await queryClient.query(customerQuery(tenantId, next));
    if (getValues('customerId') === next) {
      setValue('shippingAddressId', firstShipping(picked.addresses));
    }
  };

  // Another order: its warehouse, its address and what it has left replace what was there. Lines
  // of the old order, or without an order, cannot stay (the contract's delivery rules).
  const changeOrder = async (next: string) => {
    setValue('orderId', next);
    replace([]);
    if (next === '') return;
    const picked = await queryClient.query(salesOrderQuery(tenantId, next));
    if (getValues('orderId') !== next) return;
    setValue('warehouseId', picked.warehouseId);
    setValue('shippingAddressId', picked.shippingAddressId ?? '');
    const filled = linesFrom(picked, new Map());
    addItems(filled.items);
    replace(filled.lines);
  };

  // "Add what is left on the order": only what the form does not hold yet
  const fillRest = () => {
    if (!chosenOrder) return;
    const onForm = baseByOrderLine(
      getValues('lines').map((line) => ({
        orderLineId: line.orderLineId ?? '',
        base: baseOf(line),
      })),
    );
    const filled = linesFrom(chosenOrder, onForm);
    if (filled.lines.length === 0) {
      toast(t('deliveries.nothingLeft'));
      return;
    }
    addItems(filled.items);
    append(filled.lines);
  };

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = delivery
          ? await call(routes.deliveries.update, {
              params: { id: delivery.id },
              body: { ...body, version },
            })
          : await call(routes.deliveries.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('deliveries.posted', { number: saved.number ?? '' })
            : t('deliveries.draftSaved'),
        );
        if (!delivery) {
          void navigate({
            to: '/deliveries/$deliveryId',
            params: { deliveryId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: Delivery) =>
      call(routes.deliveries.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('deliveries.deleted'));
      void navigate({ to: '/deliveries' });
    },
  });

  // FEFO, as in the stock forms. The split lines keep the order line: one order line may be
  // delivered from two batches.
  const split = (index: number, batches: readonly { batchId: string; quantity: string }[]) => {
    const line = getValues(rowPath('lines', index, 'variantId'));
    const item = items.get(line);
    const now = getValues('lines')[index];
    if (!item || !now) return;
    const wanted = baseOf(now);
    if (wanted === null) return;
    const { picks, missing } = fefoSplit(batches, wanted);
    if (picks.length === 0) return;
    remove(index);
    insert(
      index,
      picks.map((pick) => ({
        ...emptyLine(item, now.orderLineId ?? ''),
        quantity: pick.quantity,
        batchId: pick.batchId,
      })),
    );
    if (missing !== '0.0000')
      toast(t('stockLines.fefoShort', { quantity: plainQuantity(missing) }));
  };

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
      <PageHeader
        title={delivery ? t('deliveries.draftTitle') : t('deliveries.newTitle')}
        description={t('deliveries.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField control={control} name="customerId" label={t('deliveries.customer')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <CustomerPicker
                  {...field}
                  saved={savedCustomer}
                  onChange={(next) => void changeCustomer(next)}
                />
              </Suspense>
            )}
          </FormField>
          <Controller
            control={control}
            name="orderId"
            render={({ field, fieldState }) => (
              <SelectField
                label={t('deliveries.order')}
                hint={t('deliveries.orderHint')}
                options={orderOptions}
                name={field.name}
                ref={field.ref}
                value={field.value ?? ''}
                disabled={customerId === ''}
                onChange={(event) => void changeOrder(event.target.value)}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
              />
            )}
          />
          <FormField control={control} name="date" label={t('deliveries.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('deliveries.warehouse')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <SelectField
            label={t('deliveries.shippingAddress')}
            optional
            options={[
              { value: '', label: t('deliveries.noShippingAddress') },
              ...addresses.map((address) => ({ value: address.id, label: addressLabel(address) })),
              ...(keptAddress ? [keptAddress] : []),
            ]}
            {...register('shippingAddressId')}
            error={errors.shippingAddressId?.message}
          />
          <TextField
            label={t('deliveries.vehicle')}
            optional
            placeholder={t('deliveries.vehiclePlaceholder')}
            {...register('vehicle')}
            error={errors.vehicle?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('deliveries.note')}
              optional
              placeholder={t('deliveries.notePlaceholder')}
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
            <StockLinesHeader />
          )}
          {fields.map((field, index) => {
            const item = items.get(field.variantId);
            if (!item) return null;
            const lineErrors = errors.lines?.[index];
            const serials = rowPath('lines', index, 'serialNumbers');
            const orderLine = orderLines.get(lines[index]?.orderLineId ?? '');
            return (
              <StockLineRow
                key={field.id}
                index={index}
                item={item}
                mode="out"
                warehouseId={warehouseId}
                unitId={lines[index]?.unitId ?? item.baseUnitId}
                quantity={lines[index]?.quantity ?? ''}
                fields={{
                  unitId: register(rowPath('lines', index, 'unitId')),
                  quantity: register(rowPath('lines', index, 'quantity')),
                  batchId: register(rowPath('lines', index, 'batchId')),
                }}
                note={
                  orderLine && (
                    <span className="text-caption text-ink-3 tabular-nums">
                      {t('deliveries.ordered', {
                        quantity: quantityText(orderLine.quantity, orderLine.unitId),
                      })}{' '}
                      ·{' '}
                      {t('deliveries.leftOnOrder', {
                        quantity: quantityText(leftToDeliver(orderLine), orderLine.baseUnitId),
                      })}
                    </span>
                  )
                }
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
                  // The order line's own problems (not on the order, over what is left) show
                  // under the quantity, the box the person changes to fix them
                  quantity: lineErrors?.quantity?.message ?? lineErrors?.orderLineId?.message,
                  batchId: lineErrors?.batchId?.message,
                }}
                onRemove={() => {
                  remove(index);
                }}
                onSplit={(batches) => {
                  split(index, batches);
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
            {orderId === '' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={warehouseId === ''}
                onClick={() => {
                  setPicking(true);
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('stockLines.addItems')}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" disabled={!chosenOrder} onClick={fillRest}>
                <HugeiconsIcon icon={TaskDone01Icon} size={16} strokeWidth={1.5} />
                {t('deliveries.fillFromOrder')}
              </Button>
            )}
            {orderId === '' && warehouseId === '' && (
              <p className="mt-2 text-label text-ink-3">{t('stockLines.pickWarehouse')}</p>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {delivery && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(delivery);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('deliveries.confirmDelete') : t('deliveries.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('deliveries.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('deliveries.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('deliveries.posting') : t('deliveries.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('deliveries.postHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId={warehouseId}
            // An archived product's last stock may still go out (the API's rule, 15b.3)
            allowArchived
            onAdd={(item: StockItem) => {
              addItems([item]);
              append(emptyLine(item));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
