import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADJUSTMENT_DIRECTIONS,
  ADJUSTMENT_REASONS,
  type AdjustmentDirection,
  contractErrorMap,
  isAdjustmentDirection,
  plainQuantity,
  reasonFits,
  routes,
  type StockAdjustment,
  type StockAdjustmentFormValues,
  type StockItem,
  updateStockAdjustmentInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  Dialog,
  FormAlert,
  FormField,
  PageHeader,
  SegmentedControl,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { unitsQuery } from '../lib/queries';
import { basePreview, fefoSplit, firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import {
  BackLink,
  useStockRefresh,
  useTenantId,
  useWarehouses,
  warehouseLabel,
} from './stock-parts';

// The adjustment form: its own chunk (loaded by routes/stock-adjustment.tsx), because the form
// library, the date picker and the picker are only needed to write — a posted adjustment is read
// without them.

type FormValues = StockAdjustmentFormValues;
type LineValues = FormValues['lines'][number];

function emptyLine(item: LineItem): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
  };
}

// The server's field names for the errors it can send — one set per line, and one per serial
// number it may point at ("lines.2.serialNumbers.1")
function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'date',
    'warehouseId',
    'direction',
    'reason',
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
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// Writing a new adjustment, or changing a draft. "Save draft" keeps it a draft; "Post adjustment"
// saves and posts in one request, all or nothing.
export function AdjustmentForm({
  adjustment,
  today,
}: {
  adjustment: StockAdjustment | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // What each line's variant is (name, packs, tracking): kept beside the form, by variant, because
  // the form holds only what is sent
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () => new Map(adjustment?.lines.map((line) => [line.variantId, toLineItem(line)])),
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
    resolver: zodResolver(updateStockAdjustmentInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: adjustment?.date ?? today,
      warehouseId: adjustment?.warehouseId ?? '',
      direction:
        adjustment && isAdjustmentDirection(adjustment.direction) ? adjustment.direction : 'in',
      reason: ADJUSTMENT_REASONS.find((reason) => reason === adjustment?.reason) ?? 'opening',
      note: adjustment?.note ?? '',
      lines:
        adjustment?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          lotNumber: line.lotNumber ?? '',
          expiresOn: line.expiresOn ?? '',
          manufacturedOn: line.manufacturedOn ?? '',
          serialNumbers: line.serialNumbers,
        })) ?? [],
      post: false,
      version: adjustment?.version ?? 1,
    },
  });
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const direction = useWatch({ control, name: 'direction' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const { active } = useWarehouses();
  const units = useQuery(unitsQuery(useTenantId())).data ?? [];

  const reasonOptions = useMemo(
    () =>
      ADJUSTMENT_REASONS.filter((reason) => reasonFits(reason, direction)).map((reason) => ({
        value: reason,
        label: t(`adjustments.reasons.${reason}`),
      })),
    [direction, t],
  );

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = adjustment
          ? await call(routes.stockAdjustments.update, {
              params: { id: adjustment.id },
              body: { ...body, version },
            })
          : await call(routes.stockAdjustments.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('adjustments.posted', { number: saved.number ?? '' })
            : t('adjustments.draftSaved'),
        );
        if (!adjustment) {
          void navigate({
            to: '/stock/adjustments/$adjustmentId',
            params: { adjustmentId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: StockAdjustment) =>
      call(routes.stockAdjustments.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('adjustments.deleted'));
      void navigate({ to: '/stock/adjustments' });
    },
  });

  // FEFO for a line that takes stock out: the line becomes one line per batch, the batch that
  // expires first taking as much as it holds, in the base unit
  const split = (index: number, batches: readonly { batchId: string; quantity: string }[]) => {
    const typed = getValues(rowPath('lines', index, 'quantity'));
    const unitId = getValues(rowPath('lines', index, 'unitId'));
    const item = items.get(getValues(rowPath('lines', index, 'variantId')));
    if (!item) return;
    const wanted =
      unitId === item.baseUnitId ? typed.trim() : basePreview(item, unitId, typed, units);
    if (wanted === null || wanted === '') return;
    const { picks, missing } = fefoSplit(batches, wanted);
    if (picks.length === 0) return;
    remove(index);
    insert(
      index,
      picks.map((pick) => ({
        ...emptyLine(item),
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
      <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
      <PageHeader
        title={adjustment ? t('adjustments.draftTitle') : t('adjustments.newTitle')}
        description={t('adjustments.description')}
      />
      <form
        id="adjustment-form"
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)]">
          <FormField control={control} name="date" label={t('adjustments.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <SelectField
            label={t('adjustments.warehouse')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <div className="grid grid-cols-1 content-start gap-1.5">
            <span className="text-label font-medium text-ink">{t('adjustments.direction')}</span>
            <Controller
              control={control}
              name="direction"
              render={({ field }) => (
                <SegmentedControl
                  label={t('adjustments.direction')}
                  value={field.value}
                  options={ADJUSTMENT_DIRECTIONS.map((value) => ({
                    value,
                    label: t(`adjustments.directions.${value}`),
                  }))}
                  onChange={(next: AdjustmentDirection) => {
                    field.onChange(next);
                    // A reason that does not go this way gives way to the first one that does
                    if (!reasonFits(getValues('reason'), next)) {
                      setValue('reason', next === 'in' ? 'opening' : 'damaged');
                    }
                  }}
                />
              )}
            />
          </div>
          {/* Controlled, not registered: when the direction changes, the reason is set in the same
              render as its new options. A registered select took the value before the options
              existed, and the browser fell back to the one option both lists share. */}
          <Controller
            control={control}
            name="reason"
            render={({ field, fieldState }) => (
              <SelectField
                label={t('adjustments.reason')}
                options={reasonOptions}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onChange={(event) => {
                  const next = ADJUSTMENT_REASONS.find((reason) => reason === event.target.value);
                  if (next) field.onChange(next);
                }}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
              />
            )}
          />
          <div className="sm:col-span-2">
            <TextField
              label={t('adjustments.note')}
              optional
              placeholder={t('adjustments.notePlaceholder')}
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
          {fields.length > 0 &&
            fields.map((field, index) => {
              const item = items.get(field.variantId);
              if (!item) return null;
              const lineErrors = errors.lines?.[index];
              const serialPath = rowPath('lines', index, 'serialNumbers');
              return (
                <StockLineRow
                  key={field.id}
                  index={index}
                  item={item}
                  mode={direction}
                  warehouseId={warehouseId}
                  unitId={lines[index]?.unitId ?? item.baseUnitId}
                  quantity={lines[index]?.quantity ?? ''}
                  fields={{
                    unitId: register(rowPath('lines', index, 'unitId')),
                    quantity: register(rowPath('lines', index, 'quantity')),
                    batchId: register(rowPath('lines', index, 'batchId')),
                    lotNumber: register(rowPath('lines', index, 'lotNumber')),
                  }}
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
                          <DatePicker
                            id={dateField.name}
                            name={dateField.name}
                            ref={dateField.ref}
                            value={dateField.value ?? ''}
                            onChange={dateField.onChange}
                            onBlur={dateField.onBlur}
                            invalid={fieldState.error !== undefined}
                          />
                        </LineField>
                      )}
                    />
                  ))}
                  serials={
                    <Controller
                      control={control}
                      name={serialPath}
                      render={({ field: serialField }) => {
                        const error = firstMessage(lineErrors?.serialNumbers);
                        return (
                          <LineField id={serialPath} label={t('stockLines.serials')} error={error}>
                            <SerialNumbersInput
                              id={serialPath}
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
                    quantity: lineErrors?.quantity?.message,
                    batchId: lineErrors?.batchId?.message,
                    lotNumber: lineErrors?.lotNumber?.message,
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
            {warehouseId === '' && (
              <p className="mt-2 text-label text-ink-3">{t('stockLines.pickWarehouse')}</p>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {adjustment && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(adjustment);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('adjustments.confirmDelete') : t('adjustments.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('adjustments.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('adjustments.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('adjustments.posting') : t('adjustments.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('adjustments.postHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId={warehouseId}
            allowArchived={direction === 'out'}
            onAdd={(item: StockItem) => {
              setItems((before) => new Map(before).set(item.variantId, toLineItem(item)));
              append(emptyLine(item));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
