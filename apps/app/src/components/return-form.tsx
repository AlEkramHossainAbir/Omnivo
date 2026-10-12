import {
  Calendar03Icon,
  Delete02Icon,
  DeliveryReturn01Icon,
  PlusSignIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Delivery,
  type DeliveryLine,
  MAX_STOCK_LINES,
  RETURN_REASONS,
  routes,
  type SalesReturn,
  type SalesReturnFormValues,
  type StockItem,
  updateSalesReturnInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { deliveryQuery, returnableChallansQuery } from '../lib/queries';
import {
  challanLineToReturn,
  leftToReturn,
  returnableLines,
  returnReasonKey,
  toReturnFormLine,
} from '../lib/returns';
import { firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { PickButton, PickProblem, SalesBackLink, useSalesRefresh } from './sales-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The sales return form (step 15d): its own chunk, loaded by routes/sales-return.tsx. A return is a
// stock document with a customer, like the delivery form: its lines are the stock line rows of
// step 13, and a line taken back from a challan also names that challan line.

// Both bring the popover; the delivery form says why that matters for the chunk
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = SalesReturnFormValues;
type LineValues = FormValues['lines'][number];

// A line on its own (goods sold before the system was used): no challan line, a batch to pick
function ownLine(item: LineItem): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    serialNumbers: [],
    deliveryLineId: '',
  };
}

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'warehouseId',
    'reason',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      rowPath('lines', index, 'deliveryLineId'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// The challan line behind a return line, with its challan's number: what the row says under the
// item ("From DC-2026-27-0042 · 18 strip can still come back")
interface ChallanSource {
  number: string;
  line: DeliveryLine;
}

// Writing a new return (from a challan, or from nothing), or changing a draft. "Save draft" keeps
// it a draft; "Post return" saves and posts in one request: the goods come back into stock and their
// cost comes off the cost of goods sold, all or nothing.
export function ReturnForm({
  salesReturn,
  delivery,
  today,
}: {
  salesReturn: SalesReturn | null;
  // "Take goods back" on a challan: the form starts with what can still come back on it
  delivery: Delivery | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = useSalesRefresh();
  const quantityText = useQuantity();
  const [picking, setPicking] = useState<'challans' | 'items' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () =>
      new Map(
        [...(salesReturn?.lines ?? []), ...(delivery?.lines ?? [])].map((line) => [
          line.variantId,
          toLineItem(line),
        ]),
      ),
  );
  // The challans the lines come from: a draft's, the one it started from, and the ones the picker
  // adds. Read through the query cache, so the rows can say what is left on each challan line.
  const [deliveryIds, setDeliveryIds] = useState<readonly string[]>(() => [
    ...new Set([
      ...(salesReturn?.deliveries.map((ref) => ref.id) ?? []),
      ...(delivery ? [delivery.id] : []),
    ]),
  ]);
  const challans = useQueries({
    queries: deliveryIds.map((id) => deliveryQuery(tenantId, id)),
  });
  const sources = new Map<string, ChallanSource>();
  for (const challan of challans) {
    for (const line of challan.data?.lines ?? []) {
      sources.set(line.id, { number: challan.data?.number ?? '', line });
    }
  }

  const savedCustomer = salesReturn?.customer ?? delivery?.customer ?? null;
  const { active } = useWarehouses();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSalesReturnInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      date: salesReturn?.date ?? today,
      // From a challan: back where the goods left from, unless the store keeper picks a damage
      // store. Otherwise the only warehouse, or none.
      warehouseId:
        salesReturn?.warehouseId ??
        delivery?.warehouseId ??
        (active?.length === 1 ? (active[0]?.id ?? '') : ''),
      // A native select always shows one: the first reason, until the store keeper picks another
      reason: RETURN_REASONS.find((reason) => reason === salesReturn?.reason) ?? RETURN_REASONS[0],
      note: salesReturn?.note ?? '',
      lines:
        salesReturn?.lines.map(toReturnFormLine) ??
        (delivery ? returnableLines(delivery.lines, new Set()).map(challanLineToReturn) : []),
      post: false,
      version: salesReturn?.version ?? 1,
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const customerId = useWatch({ control, name: 'customerId' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });

  const addItems = (next: readonly LineItem[]) => {
    setItems((before) => {
      const map = new Map(before);
      for (const item of next) map.set(item.variantId, toLineItem(item));
      return map;
    });
  };

  // Another customer: the lines from the old customer's challans go (the API refuses them,
  // return_delivery_line_invalid); lines on their own stay
  const changeCustomer = (next: string) => {
    setValue('customerId', next, { shouldValidate: errors.customerId !== undefined });
    const kept = getValues('lines').filter((line) => (line.deliveryLineId ?? '') === '');
    if (kept.length !== getValues('lines').length) replace(kept);
  };

  // The picker's challan: what can still come back on it, less what is on the form already.
  // false = the return would hold too many lines; nothing is added.
  const addChallan = (challan: Delivery): boolean => {
    const onForm = new Set(
      getValues('lines').flatMap((line) => {
        const id = line.deliveryLineId ?? '';
        return id === '' ? [] : [id];
      }),
    );
    const left = returnableLines(challan.lines, onForm);
    if (getValues('lines').length + left.length > MAX_STOCK_LINES) return false;
    addItems(left);
    setDeliveryIds((before) => (before.includes(challan.id) ? before : [...before, challan.id]));
    append(left.map(challanLineToReturn));
    return true;
  };

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = salesReturn
          ? await call(routes.salesReturns.update, {
              params: { id: salesReturn.id },
              body: { ...body, version },
            })
          : await call(routes.salesReturns.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('salesReturns.posted', { number: saved.number ?? '' })
            : t('salesReturns.draftSaved'),
        );
        if (!salesReturn) {
          void navigate({
            to: '/sales-returns/$returnId',
            params: { returnId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: SalesReturn) =>
      call(routes.salesReturns.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('salesReturns.deleted'));
      void navigate({ to: '/sales-returns' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-returns" label={t('salesReturns.back')} />
      <PageHeader
        title={salesReturn ? t('salesReturns.draftTitle') : t('salesReturns.newTitle')}
        description={t('salesReturns.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField control={control} name="customerId" label={t('salesReturns.customer')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <CustomerPicker {...field} saved={savedCustomer} onChange={changeCustomer} />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="date" label={t('salesReturns.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('salesReturns.reason')}
            options={RETURN_REASONS.map((reason) => ({
              value: reason,
              label: t(returnReasonKey(reason)),
            }))}
            {...register('reason')}
            error={errors.reason?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <SelectField
              label={t('salesReturns.warehouse')}
              hint={t('salesReturns.warehouseHint')}
              options={[
                { value: '', label: t('stockLines.pickWarehouse') },
                ...(active ?? []).map((place) => ({
                  value: place.id,
                  label: warehouseLabel(place),
                })),
              ]}
              {...register('warehouseId')}
              error={errors.warehouseId?.message}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('salesReturns.note')}
              optional
              placeholder={t('salesReturns.notePlaceholder')}
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
            const deliveryLineId = lines[index]?.deliveryLineId ?? '';
            const source = deliveryLineId === '' ? undefined : sources.get(deliveryLineId);
            return (
              <StockLineRow
                key={field.id}
                index={index}
                item={item}
                mode={deliveryLineId === '' ? 'return' : 'fixed'}
                warehouseId={warehouseId}
                unitId={lines[index]?.unitId ?? item.baseUnitId}
                quantity={lines[index]?.quantity ?? ''}
                fields={{
                  unitId: register(rowPath('lines', index, 'unitId')),
                  quantity: register(rowPath('lines', index, 'quantity')),
                  batchId: register(rowPath('lines', index, 'batchId')),
                }}
                note={
                  deliveryLineId === '' ? (
                    <span className="text-caption text-ink-3">{t('salesReturns.ownLine')}</span>
                  ) : (
                    <span className="grid gap-0.5 text-caption text-ink-3">
                      <span className="font-medium text-ink-2">
                        {t('salesReturns.fromChallan', { number: source?.number ?? '' })}
                        {source?.line.lotNumber &&
                          ` · ${t('print.batch', { lot: source.line.lotNumber })}`}
                      </span>
                      {/* What posted returns left on it; this draft's own quantity is not
                          counted yet */}
                      {source && (
                        <span className="tabular-nums">
                          {t('salesReturns.leftToReturn', {
                            quantity: quantityText(leftToReturn(source.line), item.baseUnitId),
                          })}
                        </span>
                      )}
                      <span>{t('salesReturns.challanLineHint')}</span>
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
                  // The item has no cost yet (return_cost_unknown), or the challan line is not
                  // this customer's (return_delivery_line_invalid) or on the return twice
                  line: lineErrors?.variantId?.message ?? lineErrors?.deliveryLineId?.message,
                  unitId: lineErrors?.unitId?.message,
                  quantity: lineErrors?.quantity?.message,
                  batchId: lineErrors?.batchId?.message,
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
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={customerId === ''}
              onClick={() => {
                setPicking('challans');
              }}
            >
              <HugeiconsIcon icon={DeliveryReturn01Icon} size={16} strokeWidth={1.5} />
              {t('salesReturns.addChallans')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={warehouseId === ''}
              onClick={() => {
                setPicking('items');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('stockLines.addItems')}
            </Button>
            {customerId === '' && (
              <span className="text-label text-ink-3">{t('salesReturns.pickCustomerFirst')}</span>
            )}
            {customerId !== '' && warehouseId === '' && (
              <span className="text-label text-ink-3">{t('stockLines.pickWarehouse')}</span>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {salesReturn && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(salesReturn);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('salesReturns.confirmDelete') : t('salesReturns.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('salesReturns.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('salesReturns.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('salesReturns.posting') : t('salesReturns.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('salesReturns.postHint')}</p>
      </form>

      <Dialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
      >
        {picking === 'challans' && <ChallanPicker customerId={customerId} onAdd={addChallan} />}
        {picking === 'items' && (
          <ItemPicker
            warehouseId={warehouseId}
            // An archived product can still come back (the API's rule, 15d.3)
            allowArchived
            onAdd={(item: StockItem) => {
              addItems([item]);
              append(ownLine(item));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// "Add from challans": the customer's posted challans with goods that can still come back. Each
// click adds what is left on that challan. The dialog stays open: a pharmacy sends back strips of
// several deliveries in one carton.
function ChallanPicker({
  customerId,
  onAdd,
}: {
  customerId: string;
  onAdd: (challan: Delivery) => boolean;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const { data: challans } = useQuery(returnableChallansQuery(tenantId, customerId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (deliveryId: string) => {
    setLoading(deliveryId);
    setProblem(null);
    try {
      const challan = await queryClient.query(deliveryQuery(tenantId, deliveryId));
      if (onAdd(challan)) setAdded((before) => new Set(before).add(deliveryId));
      else setProblem(t('salesLines.tooMany', { max: MAX_STOCK_LINES }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('salesReturns.challanPickerTitle')}
      description={t('salesReturns.challanPickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {challans?.length === 0 ? (
          <EmptyState
            icon={DeliveryReturn01Icon}
            title={t('salesReturns.challanPickerEmpty')}
            description={t('salesReturns.challanPickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {challans?.map((challan) => (
              <li
                key={challan.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {challan.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(challan.date)} ·{' '}
                    {t('invoices.challanLines', { count: challan.lineCount })}
                    {challan.order?.number && ` · ${challan.order.number}`}
                  </span>
                </span>
                <PickButton
                  added={added.has(challan.id)}
                  loading={loading === challan.id}
                  onClick={() => void pick(challan.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
