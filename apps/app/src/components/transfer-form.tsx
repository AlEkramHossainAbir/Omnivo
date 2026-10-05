import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  routes,
  type StockItem,
  type StockTransfer,
  type StockTransferFormValues,
  updateStockTransferInputSchema,
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
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
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

// The transfer form: writing a new transfer or changing a draft. "Send transfer" saves and sends
// in one request: the stock leaves the first warehouse and is in transit. Its own chunk, like the
// adjustment form.

type FormValues = StockTransferFormValues;
type LineValues = FormValues['lines'][number];

function emptyLine(item: LineItem): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    serialNumbers: [],
  };
}

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'fromWarehouseId',
    'toWarehouseId',
    'date',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

export function TransferForm({
  transfer,
  today,
}: {
  transfer: StockTransfer | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () => new Map(transfer?.lines.map((line) => [line.variantId, toLineItem(line)])),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateStockTransferInputSchema, { error: contractErrorMap }),
    defaultValues: {
      fromWarehouseId: transfer?.fromWarehouseId ?? '',
      toWarehouseId: transfer?.toWarehouseId ?? '',
      date: transfer?.sentOn ?? today,
      note: transfer?.note ?? '',
      lines:
        transfer?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          serialNumbers: line.serialNumbers,
        })) ?? [],
      send: false,
      version: transfer?.version ?? 1,
    },
  });
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const fromWarehouseId = useWatch({ control, name: 'fromWarehouseId' });
  const { active } = useWarehouses();
  const units = useQuery(unitsQuery(useTenantId())).data ?? [];
  const placeOptions = [
    { value: '', label: t('stockLines.pickWarehouse') },
    ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
  ];

  const save = (send: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, send };
        const saved = transfer
          ? await call(routes.stockTransfers.update, {
              params: { id: transfer.id },
              body: { ...body, version },
            })
          : await call(routes.stockTransfers.create, { body });
        await refresh();
        toast(
          saved.status === 'draft'
            ? t('transfers.draftSaved')
            : t('transfers.sent', { number: saved.number ?? '' }),
        );
        if (!transfer) {
          void navigate({
            to: '/stock/transfers/$transferId',
            params: { transferId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: StockTransfer) =>
      call(routes.stockTransfers.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('transfers.deleted'));
      void navigate({ to: '/stock/transfers' });
    },
  });

  // FEFO, as in the adjustment form
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
      picks.map((pick) => ({ ...emptyLine(item), quantity: pick.quantity, batchId: pick.batchId })),
    );
    if (missing !== '0.0000')
      toast(t('stockLines.fefoShort', { quantity: plainQuantity(missing) }));
  };

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/transfers" label={t('transfers.back')} />
      <PageHeader
        title={transfer ? t('transfers.draftTitle') : t('transfers.newTitle')}
        description={t('transfers.description')}
      />
      <form
        id="transfer-form"
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_13rem]">
          <SelectField
            label={t('transfers.from')}
            options={placeOptions}
            {...register('fromWarehouseId')}
            error={errors.fromWarehouseId?.message}
          />
          <SelectField
            label={t('transfers.to')}
            options={placeOptions}
            {...register('toWarehouseId')}
            error={errors.toWarehouseId?.message}
          />
          <FormField control={control} name="date" label={t('transfers.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('transfers.note')}
              optional
              placeholder={t('transfers.notePlaceholder')}
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
              const serials = rowPath('lines', index, 'serialNumbers');
              return (
                <StockLineRow
                  key={field.id}
                  index={index}
                  item={item}
                  mode="out"
                  warehouseId={fromWarehouseId}
                  unitId={lines[index]?.unitId ?? item.baseUnitId}
                  quantity={lines[index]?.quantity ?? ''}
                  fields={{
                    unitId: register(rowPath('lines', index, 'unitId')),
                    quantity: register(rowPath('lines', index, 'quantity')),
                    batchId: register(rowPath('lines', index, 'batchId')),
                  }}
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
                    quantity: lineErrors?.quantity?.message,
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
            <Button
              variant="secondary"
              size="sm"
              disabled={fromWarehouseId === ''}
              onClick={() => {
                setPicking(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('stockLines.addItems')}
            </Button>
            {fromWarehouseId === '' && (
              <p className="mt-2 text-label text-ink-3">{t('stockLines.pickWarehouse')}</p>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {transfer && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(transfer);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('transfers.confirmDelete') : t('transfers.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('transfers.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('transfers.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('transfers.sending') : t('transfers.send')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('transfers.sendHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId={fromWarehouseId}
            allowArchived
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
