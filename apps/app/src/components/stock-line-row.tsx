import { Delete02Icon, Layers01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { plainQuantity, type StockItem, type StockLine } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn, IconButton, Input, Select } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { stockCardQuery, unitsQuery } from '../lib/queries';
import { basePreview, unitChoices } from '../lib/stock';
import { LineField } from './journal-parts';
import { useIsoDate, useQuantity, useTenantId, VariantCell } from './stock-parts';

// What a line needs to know about its variant, from the picker (StockItem) or a saved line
// (StockLine): both carry these fields
export type LineItem = Pick<
  StockItem,
  | 'variantId'
  | 'productId'
  | 'productCode'
  | 'productName'
  | 'optionValues'
  | 'sku'
  | 'baseUnitId'
  | 'tracking'
  | 'hasExpiry'
  | 'units'
>;

export function toLineItem(source: StockItem | StockLine): LineItem {
  return {
    variantId: source.variantId,
    productId: source.productId,
    productCode: source.productCode,
    productName: source.productName,
    optionValues: source.optionValues,
    sku: source.sku,
    baseUnitId: source.baseUnitId,
    tracking: source.tracking,
    hasExpiry: source.hasExpiry,
    units: source.units,
  };
}

// One template for every row, so the columns line up on a wide card: the item, the unit, the
// quantity, (step 14, on lines that bring stock in) the unit cost, what the tracking asks for, and
// the remove button. A container query (@3xl), not a screen one, like the journal's lines: the
// sidebar takes room the screen width does not show.
const COLUMNS =
  '@3xl:grid-cols-[minmax(0,2fr)_8.5rem_9rem_minmax(0,1.8fr)_2.25rem] @3xl:items-start';
const COSTED_COLUMNS =
  '@3xl:grid-cols-[minmax(0,2fr)_8.5rem_9rem_10rem_minmax(0,1.6fr)_2.25rem] @3xl:items-start';

// The column headers of a wide card. Hidden from screen readers: each control has its own
// (sr-only) label there, which reads better than a header far away.
export function StockLinesHeader({ costed = false }: { costed?: boolean }) {
  const { t } = useLocale();
  return (
    <div
      aria-hidden="true"
      className={cn(
        'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
        costed ? COSTED_COLUMNS : COLUMNS,
      )}
    >
      <span>{t('stockLines.items')}</span>
      <span>{t('stockLines.unit')}</span>
      <span className="text-right">{t('stockLines.quantity')}</span>
      {costed && <span className="text-right">{t('stockLines.unitCost')}</span>}
      <span>{t('stock.history.detail')}</span>
    </div>
  );
}

export interface LineErrors {
  unitId?: string | undefined;
  quantity?: string | undefined;
  batchId?: string | undefined;
  lotNumber?: string | undefined;
}

// One line of an adjustment or a transfer. It holds no form state of its own: the form passes its
// registered inputs (unit, quantity, batch, lot) and renders the controlled ones (dates, serial
// numbers) itself, so the same row works in both forms, each with its own types.
export function StockLineRow({
  index,
  item,
  mode,
  warehouseId,
  unitId,
  quantity,
  fields,
  dates,
  serials,
  cost,
  errors,
  onRemove,
  onSplit,
}: {
  index: number;
  item: LineItem;
  // in: a lot is typed (it becomes a batch when posted); out: an existing batch is picked
  mode: 'in' | 'out';
  warehouseId: string;
  // The line's current unit and quantity, for the "= 72 pcs" under the box
  unitId: string;
  quantity: string;
  fields: {
    unitId: UseFormRegisterReturn;
    quantity: UseFormRegisterReturn;
    batchId: UseFormRegisterReturn;
    lotNumber?: UseFormRegisterReturn | undefined;
  };
  // The expiry and manufacturing dates of an "in" batch line, already in their LineFields
  dates?: ReactNode;
  // The serial number box of a serial line, already in its LineField
  serials?: ReactNode;
  // Step 14: the unit cost box of a line that brings stock in, already in its LineField. Given =
  // the row has the cost column (the header must say costed too).
  cost?: ReactNode;
  errors: LineErrors;
  onRemove: () => void;
  onSplit: (batches: readonly { batchId: string; quantity: string }[]) => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  // The variant's stock card: what is here, and in which batches (FEFO order)
  const card = useQuery({
    ...stockCardQuery(tenantId, item.variantId),
    enabled: warehouseId !== '',
  }).data;
  const here = card?.warehouses.find((place) => place.warehouseId === warehouseId);
  const batchesHere = (card?.batches ?? []).filter((batch) => batch.warehouseId === warehouseId);
  const preview = basePreview(item, unitId, quantity, units);
  const number = index + 1;
  const id = (field: string) => `lines.${String(index)}.${field}`;

  const removeButton = (
    <IconButton icon={Delete02Icon} label={t('stockLines.remove', { number })} onClick={onRemove} />
  );

  return (
    <div
      role="group"
      aria-label={t('stockLines.line', { number })}
      className={cn(
        'grid grid-cols-2 gap-3 border-t border-line px-5 py-4',
        cost === undefined ? COLUMNS : COSTED_COLUMNS,
      )}
    >
      <div className="col-span-2 flex items-start justify-between gap-3 @3xl:col-span-1">
        <span className="grid min-w-0 gap-0.5">
          <VariantCell item={item} />
          {here && (
            <span className="text-caption text-ink-3 tabular-nums">
              {t('stockLines.inStock', { quantity: quantityText(here.onHand, item.baseUnitId) })}
            </span>
          )}
        </span>
        <span className="@3xl:hidden">{removeButton}</span>
      </div>
      <LineField id={id('unitId')} label={t('stockLines.unit')} error={errors.unitId}>
        <Select
          id={id('unitId')}
          options={unitChoices(item, units)}
          invalid={errors.unitId !== undefined}
          {...fields.unitId}
        />
      </LineField>
      <LineField id={id('quantity')} label={t('stockLines.quantity')} error={errors.quantity}>
        <Input
          id={id('quantity')}
          inputMode="decimal"
          autoComplete="off"
          align="end"
          invalid={errors.quantity !== undefined}
          aria-describedby={errors.quantity ? `${id('quantity')}-error` : undefined}
          {...fields.quantity}
        />
        {preview !== null && (
          <span className="text-right text-caption text-ink-3 tabular-nums">
            {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
          </span>
        )}
      </LineField>
      {cost !== undefined && <div className="col-span-2 @3xl:col-span-1">{cost}</div>}
      <div className="col-span-2 grid grid-cols-1 gap-3 @3xl:col-span-1">
        {item.tracking === 'batch' && mode === 'in' && fields.lotNumber && (
          <>
            <LineField id={id('lotNumber')} label={t('stockLines.lot')} error={errors.lotNumber}>
              <Input
                id={id('lotNumber')}
                autoComplete="off"
                spellCheck={false}
                placeholder="NP24117"
                invalid={errors.lotNumber !== undefined}
                {...fields.lotNumber}
              />
            </LineField>
            {dates}
          </>
        )}
        {item.tracking === 'batch' && mode === 'out' && (
          <>
            <LineField id={id('batchId')} label={t('stockLines.batch')} error={errors.batchId}>
              <Select
                id={id('batchId')}
                invalid={errors.batchId !== undefined}
                options={[
                  { value: '', label: t('stockLines.batchPlaceholder') },
                  ...batchesHere.map((batch) => ({
                    value: batch.batchId,
                    label: t('stockLines.batchOption', {
                      lot: batch.lotNumber,
                      quantity: quantityText(batch.quantity, item.baseUnitId),
                      expiry:
                        batch.expiresOn === null ? t('stock.noExpiry') : isoDate(batch.expiresOn),
                    }),
                  })),
                ]}
                {...fields.batchId}
              />
            </LineField>
            {batchesHere.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onSplit(
                    batchesHere.map((batch) => ({
                      batchId: batch.batchId,
                      quantity: plainQuantity(batch.quantity),
                    })),
                  );
                }}
                className="inline-flex w-fit items-center gap-1.5 text-label font-medium text-brand underline-offset-3 hover:underline"
              >
                <HugeiconsIcon icon={Layers01Icon} size={15} strokeWidth={1.5} />
                {t('stockLines.pickFefo')}
              </button>
            )}
          </>
        )}
        {item.tracking === 'serial' && serials}
      </div>
      <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
    </div>
  );
}
