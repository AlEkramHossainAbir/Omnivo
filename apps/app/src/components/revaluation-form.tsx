import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  compareQuantity,
  contractErrorMap,
  multiplyMoney,
  routes,
  type StockItem,
  type StockRevaluationFormValues,
  stockRevaluationInputSchema,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  Dialog,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  TextField,
  toast,
} from '@omnivo/ui';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { ItemPicker } from './item-picker';
import { LineField } from './journal-parts';
import {
  BackLink,
  useQuantity,
  useStockRefresh,
  useUnitCode,
  useValue,
  VariantCell,
} from './stock-parts';

// Revaluing stock (step 14): its own chunk, loaded by routes/stock-revaluation.tsx. One line per
// item: what it has now (its stock and average cost, company-wide), the new cost per base unit, and
// the difference that will go to the books. Posted when it is saved.

type FormValues = StockRevaluationFormValues;

// One template for the header and every row on a wide card: the item, its cost now, the new cost,
// the new value, the difference, remove (CLAUDE.md → Stock line rows)
const COLUMNS = '@3xl:grid-cols-[minmax(0,2fr)_8rem_10rem_9rem_9rem_2.25rem] @3xl:items-start';

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'date',
    'note',
    'lines',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitCost'),
    ]).flat(),
  ];
}

export function RevaluationForm({ today }: { today: string }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const quantity = useQuantity();
  const unitCode = useUnitCode();
  const value = useValue();
  const [picking, setPicking] = useState(false);
  // What each line's item is (its stock and cost now), by variant: the form holds only what is sent
  const [items, setItems] = useState<ReadonlyMap<string, StockItem>>(new Map());
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(stockRevaluationInputSchema, { error: contractErrorMap }),
    defaultValues: { date: today, note: '', lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });

  // The difference each line will post: stock × new cost − its value now. Not yet typed = nothing.
  const differenceOf = (index: number): string | null => {
    const line = lines[index];
    const item = line ? items.get(line.variantId) : undefined;
    if (!line || !item || line.unitCost === '') return null;
    return subtractMoney(multiplyMoney(item.onHand, line.unitCost), item.value ?? '0');
  };
  const total = sumMoney(fields.map((_, index) => differenceOf(index) ?? '0'));

  const save = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.stockRevaluations.create, { body: values });
      await refresh();
      toast(t('revaluations.posted', { number: saved.number }));
      void navigate({
        to: '/stock/revaluations/$revaluationId',
        params: { revaluationId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(lines.length), setError);
    }
  });

  const failure = errors.root?.server?.message;
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/revaluations" label={t('revaluations.back')} />
      <PageHeader title={t('revaluations.newTitle')} description={t('revaluations.description')} />
      <form noValidate onSubmit={(event) => void save(event)} className="grid grid-cols-1 gap-5">
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
          <FormField control={control} name="date" label={t('revaluations.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <TextField
            label={t('revaluations.note')}
            optional
            placeholder={t('revaluations.notePlaceholder')}
            {...register('note')}
            error={errors.note?.message}
          />
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('revaluations.noLines')}</p>
          ) : (
            <div
              aria-hidden="true"
              className={cn(
                'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
                COLUMNS,
              )}
            >
              <span>{t('revaluations.lineColumns.product')}</span>
              <span className="text-right">{t('revaluations.lineColumns.oldCost')}</span>
              <span className="text-right">{t('revaluations.lineColumns.newCost')}</span>
              <span className="text-right">{t('revaluations.lineColumns.newValue')}</span>
              <span className="text-right">{t('revaluations.lineColumns.difference')}</span>
            </div>
          )}
          {fields.map((field, index) => {
            const item = items.get(field.variantId);
            if (!item) return null;
            const number = index + 1;
            const costPath = rowPath('lines', index, 'unitCost');
            const line = lines[index];
            const newValue =
              line && line.unitCost !== '' ? multiplyMoney(item.onHand, line.unitCost) : null;
            const lineErrors = errors.lines?.[index];
            const removeButton = (
              <IconButton
                icon={Delete02Icon}
                label={t('revaluations.remove', { number })}
                onClick={() => {
                  remove(index);
                  setItems((before) => {
                    const next = new Map(before);
                    next.delete(field.variantId);
                    return next;
                  });
                }}
              />
            );
            return (
              <div
                key={field.id}
                role="group"
                aria-label={t('revaluations.line', { number })}
                className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
              >
                <div className="col-span-2 flex items-start justify-between gap-3 @3xl:col-span-1">
                  <span className="grid min-w-0 gap-0.5">
                    <VariantCell item={item} />
                    <span className="text-caption text-ink-3 tabular-nums">
                      {compareQuantity(item.onHand, '0') > 0
                        ? quantity(item.onHand, item.baseUnitId)
                        : t('revaluations.noStock')}
                    </span>
                    {lineErrors?.variantId?.message && (
                      <span className="text-caption text-crit">{lineErrors.variantId.message}</span>
                    )}
                  </span>
                  <span className="@3xl:hidden">{removeButton}</span>
                </div>
                <div className="grid content-start gap-1.5 text-right">
                  <span className="text-label font-medium text-ink @3xl:sr-only">
                    {t('revaluations.lineColumns.oldCost')}
                  </span>
                  <span className="pt-2.5 text-body-sm tabular-nums">{value(item.unitCost)}</span>
                </div>
                <Controller
                  control={control}
                  name={costPath}
                  render={({ field: costField, fieldState }) => (
                    <LineField
                      id={costField.name}
                      label={t('revaluations.newCostPer', { unit: unitCode(item.baseUnitId) })}
                      error={fieldState.error?.message}
                    >
                      <MoneyInput
                        id={costField.name}
                        name={costField.name}
                        ref={costField.ref}
                        scale={4}
                        value={costField.value}
                        onChange={costField.onChange}
                        onBlur={costField.onBlur}
                        invalid={fieldState.error !== undefined}
                      />
                    </LineField>
                  )}
                />
                <div className="grid content-start gap-1.5 text-right">
                  <span className="text-label font-medium text-ink @3xl:sr-only">
                    {t('revaluations.lineColumns.newValue')}
                  </span>
                  <span className="pt-2.5 text-body-sm tabular-nums">{value(newValue)}</span>
                </div>
                <div className="grid content-start gap-1.5 text-right">
                  <span className="text-label font-medium text-ink @3xl:sr-only">
                    {t('revaluations.lineColumns.difference')}
                  </span>
                  <span className="pt-2.5 text-body-sm font-medium tabular-nums">
                    {value(differenceOf(index))}
                  </span>
                </div>
                <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
              </div>
            );
          })}
          {fields.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-5 py-3 text-body-sm">
              <span className="font-medium">{t('stockLines.total')}</span>
              <span className="font-medium tabular-nums">{value(total)}</span>
            </div>
          )}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPicking(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('stockLines.addItems')}
            </Button>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" disabled={isSubmitting || fields.length === 0}>
            {isSubmitting ? t('revaluations.posting') : t('revaluations.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('revaluations.postHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId=""
            allowArchived
            onAdd={(item) => {
              // One line per item: adding it again does nothing (the API refuses a second line)
              if (items.has(item.variantId)) return;
              setItems((before) => new Map(before).set(item.variantId, item));
              append({ variantId: item.variantId, unitCost: '' });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
