import { Alert02Icon, Delete02Icon, PlusSignIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type CostLookupItem,
  defaultLineDescription,
  MAX_PURCHASE_LINES,
  type Product,
  type RequisitionLineFormValues,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, cn, Dialog, IconButton, Input, MoneyInput, Pill, Select } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import {
  type PurchaseLineMeta,
  purchaseItemOf,
  purchaseUnitOf,
  requisitionFormTotals,
} from '../lib/purchase';
import { unitsQuery } from '../lib/queries';
import { basePreview, unitChoices } from '../lib/stock';
import { LineField } from './journal-parts';
import { ProductPicker } from './product-picker';
import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-parts';

// The lines of a requisition (step 17a): item, unit, quantity, estimated cost. Like the sales line
// editor, the form holds the lines as one controlled value (a Controller on "lines"), and this
// editor changes that array; 17b's purchase order adds its price, discount and VAT here. A lazy
// chunk of its own: it brings decimal.js with the money box, and the product picker.

export type PurchaseLinesErrors = FieldErrors<{ lines: RequisitionLineFormValues[] }>['lines'];

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `new-${String(lastKey)}`;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

// One template for the header and every line on a wide card (@3xl = 48rem, like the stock lines):
// item, unit, quantity, estimated cost, amount, remove. Below it, each control shows its label.
const LINE_COLUMNS =
  '@3xl:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_9.5rem_8.5rem_2.25rem] @3xl:items-start @3xl:gap-2';

export function PurchaseLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  errors,
}: {
  lines: RequisitionLineFormValues[];
  onChange: (lines: RequisitionLineFormValues[]) => void;
  // The form's lines right now (react-hook-form's getValues): an add that waited for the cost
  // lookup appends to these, not to the lines of the render that started it
  getLines: () => RequisitionLineFormValues[];
  initialMeta: PurchaseLineMeta[];
  errors: PurchaseLinesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const unitCode = useUnitCode();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const [meta, setMeta] = useState<PurchaseLineMeta[]>(initialMeta);
  const [picking, setPicking] = useState(false);
  // The meta of the last render, for the async handlers (a unit change waits for its cost)
  const metaRef = useRef(meta);
  useEffect(() => {
    metaRef.current = meta;
  });
  const { amounts, total } = requisitionFormTotals(lines);

  // The starting cost of some variants in some units. Without inventory.stock.value the server
  // sends no cost (decision 20), and the person types one.
  const lookUp = async (items: { variantId: string; unitId: string }[]) => {
    const answer = await call(routes.purchaseCosts.lookup, { body: { items } });
    return new Map<string, CostLookupItem>(
      answer.items.map((item) => [keyOf(item.variantId, item.unitId), item]),
    );
  };

  // "Add": every active variant of the product, in its buying unit, at the looked-up cost.
  // false = the requisition would hold too many lines; nothing is added.
  const addProduct = async (product: Product): Promise<boolean> => {
    const variants = product.variants.filter((variant) => variant.archivedAt === null);
    if (getLines().length + variants.length > MAX_PURCHASE_LINES) return false;
    const unitId = purchaseUnitOf(product);
    const costs = await lookUp(variants.map((variant) => ({ variantId: variant.id, unitId })));
    // Checked again after the wait: another add may have come in meanwhile
    if (getLines().length + variants.length > MAX_PURCHASE_LINES) return false;
    const added = variants.map((variant) => {
      const found = costs.get(keyOf(variant.id, unitId));
      return {
        line: {
          variantId: variant.id,
          unitId,
          quantity: '',
          description: '',
          // Left empty when nothing is known: the box says to type one
          estimatedCost: found?.cost ?? '',
        },
        meta: {
          key: nextKey(),
          item: purchaseItemOf(product, variant),
          source: found?.source ?? null,
        },
      };
    });
    onChange([...getLines(), ...added.map((entry) => entry.line)]);
    setMeta((before) => [...before, ...added.map((entry) => entry.meta)]);
    return true;
  };

  const remove = (index: number) => {
    onChange(lines.filter((_, at) => at !== index));
    setMeta((before) => before.filter((_, at) => at !== index));
  };

  const update = (index: number, patch: Partial<RequisitionLineFormValues>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };

  // A cost is per unit: a bag of 24 cones costs 24 times a cone. A new unit asks for its cost; when
  // none is known, the typed one stays and the person changes it.
  const changeUnit = async (index: number, unitId: string) => {
    update(index, { unitId });
    const key = meta[index]?.key;
    const variantId = lines[index]?.variantId;
    if (key === undefined || variantId === undefined) return;
    try {
      const found = (await lookUp([{ variantId, unitId }])).get(keyOf(variantId, unitId));
      // The line may have moved (a line above it removed) or gone while we waited
      const at = metaRef.current.findIndex((line) => line.key === key);
      const now = getLines()[at];
      const cost = found?.cost ?? null;
      if (at === -1 || now?.unitId !== unitId || cost === null) return;
      onChange(getLines().map((line, i) => (i === at ? { ...line, estimatedCost: cost } : line)));
      setMeta((before) =>
        before.map((line, i) => (i === at ? { ...line, source: found?.source ?? null } : line)),
      );
    } catch {
      // The typed cost stays; the person can type the new one
    }
  };

  const listError = errors?.root?.message ?? errors?.message;

  return (
    <Card
      className="@container grid grid-cols-1 overflow-hidden"
      aria-label={t('purchaseLines.items')}
    >
      {lines.length === 0 ? (
        <p className="px-5 py-6 text-body-sm text-ink-2">{t('purchaseLines.noLines')}</p>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            'hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            LINE_COLUMNS,
          )}
        >
          <span>{t('purchaseLines.item')}</span>
          <span>{t('purchaseLines.unit')}</span>
          <span className="text-right">{t('purchaseLines.quantity')}</span>
          <span className="text-right">{t('purchaseLines.estimatedCost')}</span>
          <span className="text-right">{t('purchaseLines.amount')}</span>
        </div>
      )}
      {lines.map((line, index) => {
        const lineMeta = meta[index];
        if (!lineMeta) return null;
        const { item } = lineMeta;
        const number = index + 1;
        const lineErrors = errors?.[index];
        const id = (field: string) => `lines.${String(index)}.${field}`;
        const preview = basePreview(item, line.unitId, line.quantity, units);
        const amount = amounts[index];
        const removeButton = (
          <IconButton
            icon={Delete02Icon}
            label={t('purchaseLines.remove', { number })}
            onClick={() => {
              remove(index);
            }}
          />
        );
        return (
          <div
            key={lineMeta.key}
            role="group"
            aria-label={t('purchaseLines.line', { number })}
            className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', LINE_COLUMNS)}
          >
            <div className="col-span-2 grid min-w-0 gap-2 @3xl:col-span-1">
              <div className="flex items-start justify-between gap-3">
                <span className="grid min-w-0 gap-1">
                  <VariantCell item={item} />
                  {item.productType === 'service' && (
                    <span>
                      <Pill tone="neutral" icon={Wrench01Icon}>
                        {t('purchaseLines.service')}
                      </Pill>
                    </span>
                  )}
                </span>
                <span className="@3xl:hidden">{removeButton}</span>
              </div>
              <LineField
                id={id('description')}
                label={t('purchaseLines.description')}
                error={lineErrors?.description?.message}
              >
                <Input
                  id={id('description')}
                  autoComplete="off"
                  placeholder={defaultLineDescription(item)}
                  value={line.description ?? ''}
                  invalid={lineErrors?.description !== undefined}
                  onChange={(event) => {
                    update(index, { description: event.target.value });
                  }}
                />
              </LineField>
            </div>
            <LineField
              id={id('unitId')}
              label={t('purchaseLines.unit')}
              error={lineErrors?.unitId?.message}
            >
              <Select
                id={id('unitId')}
                options={unitChoices(item, units)}
                value={line.unitId}
                invalid={lineErrors?.unitId !== undefined}
                onChange={(event) => void changeUnit(index, event.target.value)}
              />
            </LineField>
            <LineField
              id={id('quantity')}
              label={t('purchaseLines.quantity')}
              error={lineErrors?.quantity?.message}
            >
              <Input
                id={id('quantity')}
                inputMode="decimal"
                autoComplete="off"
                align="end"
                value={line.quantity}
                invalid={lineErrors?.quantity !== undefined}
                aria-describedby={lineErrors?.quantity ? `${id('quantity')}-error` : undefined}
                onChange={(event) => {
                  update(index, { quantity: event.target.value });
                }}
              />
              {preview !== null && (
                <span className="text-right text-caption text-ink-3 tabular-nums">
                  {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
                </span>
              )}
            </LineField>
            <LineField
              id={id('estimatedCost')}
              label={t('purchaseLines.costPer', { unit: unitCode(line.unitId) })}
              error={lineErrors?.estimatedCost?.message}
            >
              {/* 4 decimals, like every unit cost (CLAUDE.md → Stock values): an average cost per
                  cone is rarely a round number of paisa */}
              <MoneyInput
                id={id('estimatedCost')}
                scale={4}
                value={line.estimatedCost}
                invalid={lineErrors?.estimatedCost !== undefined}
                aria-describedby={
                  lineErrors?.estimatedCost ? `${id('estimatedCost')}-error` : undefined
                }
                onChange={(value) => {
                  update(index, { estimatedCost: value });
                }}
              />
              {lineMeta.source !== undefined && (
                <span className="text-right text-caption text-ink-3">
                  {lineMeta.source === 'average_cost'
                    ? t('purchaseLines.fromAverage')
                    : t('purchaseLines.noCost')}
                </span>
              )}
            </LineField>
            <div className="grid content-start gap-1.5">
              <span className="text-label font-medium text-ink @3xl:sr-only">
                {t('purchaseLines.amount')}
              </span>
              <span className="py-2.5 text-right text-body-sm font-medium tabular-nums">
                {amount ? format.money(amount, { decimals: 2 }) : '—'}
              </span>
            </div>
            <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
          </div>
        );
      })}
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
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
          {t('purchaseLines.addItems')}
        </Button>
      </div>
      {lines.length > 0 && (
        // The amount that chooses the approval levels (decision 7), to the paisa like the server's
        <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-5 py-3 text-body-sm">
          <span className="grid">
            <span className="font-medium">{t('purchaseLines.total')}</span>
            <span className="text-caption text-ink-3">
              {t('purchaseLines.lineCount', { count: lines.length })}
            </span>
          </span>
          <span className="font-medium tabular-nums">{format.money(total, { decimals: 2 })}</span>
        </div>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ProductPicker words="purchaseLines" onAdd={addProduct} maxLines={MAX_PURCHASE_LINES} />
        )}
      </Dialog>
    </Card>
  );
}
