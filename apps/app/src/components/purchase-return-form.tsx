import {
  Calendar03Icon,
  Delete02Icon,
  PackageReceiveIcon,
  PlusSignIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type GoodsReceipt,
  type GoodsReceiptLine,
  keptQuantity,
  MAX_STOCK_LINES,
  plainQuantity,
  type PurchaseReturn,
  type PurchaseReturnFormValues,
  RETURN_REASONS,
  routes,
  type StockItem,
  updatePurchaseReturnInputSchema,
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
import {
  receiptLineToReturn,
  returnableReceiptLines,
  toPurchaseReturnFormLine,
} from '../lib/purchase-returns';
import { goodsReceiptQuery, returnableReceiptsQuery, unitsQuery } from '../lib/queries';
import { purchaseReturnReasonKey } from '../lib/returns';
import { basePreview, fefoSplit, firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { PickButton, PickProblem } from './sales-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The purchase return form (step 17d): its own chunk, loaded by routes/purchase-return.tsx. The
// sales return form of 15d seen from the other side: a stock document with a supplier, whose lines
// are the stock line rows of step 13. A line sent back from a goods receipt also names that receipt
// line; a line on its own takes stock out of a batch like any line that takes stock out.

// Both bring the popover; the delivery form says why that matters for the chunk
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = PurchaseReturnFormValues;
type LineValues = FormValues['lines'][number];

// A line on its own (goods bought before the system was used): no receipt line, a batch to pick
function ownLine(item: LineItem): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    serialNumbers: [],
    receiptLineId: '',
  };
}

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'supplierId',
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
      rowPath('lines', index, 'receiptLineId'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// The receipt line behind a return line, with its receipt's number: what the row says under the
// item ("From GRN-2026-27-0007 · 650 kg can still go back")
interface ReceiptSource {
  number: string;
  line: GoodsReceiptLine;
}

// Writing a new return (from a goods receipt, or from nothing), or changing a draft. "Save draft"
// keeps it a draft; "Post return" saves and posts in one request: the goods leave stock at the cost
// they came in at, all or nothing.
export function PurchaseReturnForm({
  purchaseReturn,
  receipt,
  today,
}: {
  purchaseReturn: PurchaseReturn | null;
  // "Send goods back" on a goods receipt: the form starts with what can still go back on it
  receipt: GoodsReceipt | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const refresh = usePurchaseRefresh();
  const quantityText = useQuantity();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const [picking, setPicking] = useState<'receipts' | 'items' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () =>
      new Map(
        [...(purchaseReturn?.lines ?? []), ...(receipt?.lines ?? [])].map((line) => [
          line.variantId,
          toLineItem(line),
        ]),
      ),
  );
  // The receipts the lines come from: a draft's, the one it started from, and the ones the picker
  // adds. Read through the query cache, so the rows can say what is left on each receipt line.
  const [receiptIds, setReceiptIds] = useState<readonly string[]>(() => [
    ...new Set([
      ...(purchaseReturn?.receipts.map((ref) => ref.id) ?? []),
      ...(receipt ? [receipt.id] : []),
    ]),
  ]);
  const receipts = useQueries({
    queries: receiptIds.map((id) => goodsReceiptQuery(tenantId, id)),
  });
  const sources = new Map<string, ReceiptSource>();
  for (const found of receipts) {
    for (const line of found.data?.lines ?? []) {
      sources.set(line.id, { number: found.data?.number ?? '', line });
    }
  }

  const savedSupplier = purchaseReturn?.supplier ?? receipt?.supplier ?? null;
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
    resolver: zodResolver(updatePurchaseReturnInputSchema, { error: contractErrorMap }),
    defaultValues: {
      supplierId: savedSupplier?.id ?? '',
      date: purchaseReturn?.date ?? today,
      // From a receipt: where the goods came in, unless they were moved since. Otherwise the only
      // warehouse, or none.
      warehouseId:
        purchaseReturn?.warehouseId ??
        receipt?.warehouseId ??
        (active?.length === 1 ? (active[0]?.id ?? '') : ''),
      // A native select always shows one: the first reason, until the store keeper picks another
      reason:
        RETURN_REASONS.find((reason) => reason === purchaseReturn?.reason) ?? RETURN_REASONS[0],
      note: purchaseReturn?.note ?? '',
      lines:
        purchaseReturn?.lines.map(toPurchaseReturnFormLine) ??
        (receipt ? returnableReceiptLines(receipt.lines, new Set()).map(receiptLineToReturn) : []),
      post: false,
      version: purchaseReturn?.version ?? 1,
    },
  });
  const { fields, append, remove, insert, replace } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const supplierId = useWatch({ control, name: 'supplierId' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });

  const addItems = (next: readonly LineItem[]) => {
    setItems((before) => {
      const map = new Map(before);
      for (const item of next) map.set(item.variantId, toLineItem(item));
      return map;
    });
  };

  // Another supplier: the lines from the old supplier's receipts go (the API refuses them,
  // purchase_return_receipt_line_invalid); lines on their own stay
  const changeSupplier = (next: string) => {
    setValue('supplierId', next, { shouldValidate: errors.supplierId !== undefined });
    const kept = getValues('lines').filter((line) => (line.receiptLineId ?? '') === '');
    if (kept.length !== getValues('lines').length) replace(kept);
  };

  // The picker's receipt: what can still go back on it, less what is on the form already.
  // false = the return would hold too many lines; nothing is added.
  const addReceipt = (found: GoodsReceipt): boolean => {
    const onForm = new Set(
      getValues('lines').flatMap((line) => {
        const id = line.receiptLineId ?? '';
        return id === '' ? [] : [id];
      }),
    );
    const left = returnableReceiptLines(found.lines, onForm);
    if (getValues('lines').length + left.length > MAX_STOCK_LINES) return false;
    addItems(left);
    setReceiptIds((before) => (before.includes(found.id) ? before : [...before, found.id]));
    append(left.map(receiptLineToReturn));
    return true;
  };

  // FEFO for a line on its own, like the delivery form: one line per batch, from the one that
  // expires first. A line from a receipt has its receipt line's batch, so it has no such button.
  const split = (index: number, batches: readonly { batchId: string; quantity: string }[]) => {
    const now = getValues('lines')[index];
    const item = now ? items.get(now.variantId) : undefined;
    if (!now || !item) return;
    const wanted =
      now.unitId === item.baseUnitId
        ? now.quantity.trim() === ''
          ? null
          : now.quantity.trim()
        : basePreview(item, now.unitId, now.quantity, units);
    if (wanted === null) return;
    const { picks, missing } = fefoSplit(batches, wanted);
    if (picks.length === 0) return;
    remove(index);
    insert(
      index,
      picks.map((pick) => ({ ...ownLine(item), quantity: pick.quantity, batchId: pick.batchId })),
    );
    if (missing !== '0.0000') {
      toast(t('stockLines.fefoShort', { quantity: plainQuantity(missing) }));
    }
  };

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = purchaseReturn
          ? await call(routes.purchaseReturns.update, {
              params: { id: purchaseReturn.id },
              body: { ...body, version },
            })
          : await call(routes.purchaseReturns.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('purchaseReturns.posted', { number: saved.number ?? '' })
            : t('purchaseReturns.draftSaved'),
        );
        if (!purchaseReturn) {
          void navigate({
            to: '/purchase-returns/$returnId',
            params: { returnId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: PurchaseReturn) =>
      call(routes.purchaseReturns.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('purchaseReturns.deleted'));
      void navigate({ to: '/purchase-returns' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/purchase-returns" label={t('purchaseReturns.back')} />
      <PageHeader
        title={purchaseReturn ? t('purchaseReturns.draftTitle') : t('purchaseReturns.newTitle')}
        description={t('purchaseReturns.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField control={control} name="supplierId" label={t('purchaseReturns.supplier')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <PartyPicker
                  {...field}
                  role="supplier"
                  saved={savedSupplier}
                  onChange={changeSupplier}
                />
              </Suspense>
            )}
          </FormField>
          <FormField control={control} name="date" label={t('purchaseReturns.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('purchaseReturns.reason')}
            options={RETURN_REASONS.map((reason) => ({
              value: reason,
              label: t(purchaseReturnReasonKey(reason)),
            }))}
            {...register('reason')}
            error={errors.reason?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <SelectField
              label={t('purchaseReturns.warehouse')}
              hint={t('purchaseReturns.warehouseHint')}
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
              label={t('purchaseReturns.note')}
              optional
              placeholder={t('purchaseReturns.notePlaceholder')}
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
            const receiptLineId = lines[index]?.receiptLineId ?? '';
            const source = receiptLineId === '' ? undefined : sources.get(receiptLineId);
            return (
              <StockLineRow
                key={field.id}
                index={index}
                item={item}
                // A line on its own takes stock out of a batch here; a receipt line's batch is the
                // receipt line's own
                mode={receiptLineId === '' ? 'out' : 'fixed'}
                warehouseId={warehouseId}
                unitId={lines[index]?.unitId ?? item.baseUnitId}
                quantity={lines[index]?.quantity ?? ''}
                fields={{
                  unitId: register(rowPath('lines', index, 'unitId')),
                  quantity: register(rowPath('lines', index, 'quantity')),
                  batchId: register(rowPath('lines', index, 'batchId')),
                }}
                note={
                  receiptLineId === '' ? (
                    <span className="text-caption text-ink-3">{t('purchaseReturns.ownLine')}</span>
                  ) : (
                    <span className="grid gap-0.5 text-caption text-ink-3">
                      <span className="font-medium text-ink-2">
                        {t('purchaseReturns.fromReceipt', { number: source?.number ?? '' })}
                        {source?.line.lotNumber &&
                          ` · ${t('print.batch', { lot: source.line.lotNumber })}`}
                      </span>
                      {/* What posted returns left on it; this draft's own quantity is not
                          counted yet */}
                      {source && (
                        <span className="tabular-nums">
                          {t('purchaseReturns.leftToReturn', {
                            quantity: quantityText(keptQuantity(source.line), item.baseUnitId),
                          })}
                        </span>
                      )}
                      <span>{t('purchaseReturns.receiptLineHint')}</span>
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
                  // The item has no cost (purchase_return_cost_unknown), or the receipt line is
                  // not this supplier's or on the return twice
                  line: lineErrors?.variantId?.message ?? lineErrors?.receiptLineId?.message,
                  unitId: lineErrors?.unitId?.message,
                  quantity: lineErrors?.quantity?.message,
                  batchId: lineErrors?.batchId?.message,
                }}
                onRemove={() => {
                  remove(index);
                }}
                {...(receiptLineId === '' && {
                  onSplit: (batches: readonly { batchId: string; quantity: string }[]) => {
                    split(index, batches);
                  },
                })}
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
              disabled={supplierId === ''}
              onClick={() => {
                setPicking('receipts');
              }}
            >
              <HugeiconsIcon icon={PackageReceiveIcon} size={16} strokeWidth={1.5} />
              {t('purchaseReturns.addReceipts')}
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
            {supplierId === '' && (
              <span className="text-label text-ink-3">
                {t('purchaseReturns.pickSupplierFirst')}
              </span>
            )}
            {supplierId !== '' && warehouseId === '' && (
              <span className="text-label text-ink-3">{t('stockLines.pickWarehouse')}</span>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {purchaseReturn && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(purchaseReturn);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('purchaseReturns.confirmDelete') : t('purchaseReturns.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">
                  {t('purchaseReturns.deleteWarning')}
                </span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('purchaseReturns.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('purchaseReturns.posting') : t('purchaseReturns.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('purchaseReturns.postHint')}</p>
      </form>

      <Dialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
      >
        {picking === 'receipts' && <ReceiptPicker supplierId={supplierId} onAdd={addReceipt} />}
        {picking === 'items' && (
          <ItemPicker
            warehouseId={warehouseId}
            // An archived product's goods still on the shelf can still go back (the API's rule)
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

// "Add from goods receipts": the supplier's posted receipts with goods that can still go back. Each
// click adds what is kept on that receipt. The dialog stays open: one truck may take back goods of
// several receipts.
function ReceiptPicker({
  supplierId,
  onAdd,
}: {
  supplierId: string;
  onAdd: (receipt: GoodsReceipt) => boolean;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const { data: receipts } = useQuery(returnableReceiptsQuery(tenantId, supplierId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (receiptId: string) => {
    setLoading(receiptId);
    setProblem(null);
    try {
      const found = await queryClient.query(goodsReceiptQuery(tenantId, receiptId));
      if (onAdd(found)) setAdded((before) => new Set(before).add(receiptId));
      else setProblem(t('salesLines.tooMany', { max: MAX_STOCK_LINES }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('purchaseReturns.receiptPickerTitle')}
      description={t('purchaseReturns.receiptPickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {receipts?.length === 0 ? (
          <EmptyState
            icon={PackageReceiveIcon}
            title={t('purchaseReturns.receiptPickerEmpty')}
            description={t('purchaseReturns.receiptPickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {receipts?.map((found) => (
              <li
                key={found.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {found.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(found.date)} · {t('salesLines.lineCount', { count: found.lineCount })}
                    {found.order?.number && ` · ${found.order.number}`}
                  </span>
                </span>
                <PickButton
                  added={added.has(found.id)}
                  loading={loading === found.id}
                  onClick={() => void pick(found.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
