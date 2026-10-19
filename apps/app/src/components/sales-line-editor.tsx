import { Alert02Icon, Delete02Icon, PlusSignIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  MAX_SALES_LINES,
  plainQuantity,
  type Product,
  routes,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  Dialog,
  DiscountInput,
  IconButton,
  Input,
  MoneyInput,
  Pill,
  Select,
  toast,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import {
  formTotals,
  isServiceLine,
  type LineMeta,
  productItemOf,
  type SalesItem,
} from '../lib/sales';
import { basePreview, unitChoices } from '../lib/stock';
import { taxRateOptions, useRateText } from '../lib/tax-rates';
import { taxRatesQuery, unitsQuery } from '../lib/queries';
import { failureOf, LineError } from './journal-parts';
import { ProductPicker } from './product-picker';
import { SalesTotals } from './sales-parts';
import { useQuantity, useTenantId, useUnitCode, VariantCell } from './stock-parts';

// The lines of a quotation, an order and (step 15c) an invoice: one editor for all three. The form
// holds the lines as one controlled value (a Controller on "lines"), and this editor changes that
// array. A field array would need the form's own type here, and the forms have different types;
// one array value has the same type in the quotation and the order (SalesLineFormValues[]), so
// neither form needs a cast. An invoice line has more fields, so the editor is generic over the
// line (LinesEditor<L>), and SalesLinesEditor is its plain sales-line form. Step 17b: a purchase
// order's line is a sales line too (decision 6), so its editor (purchase-order-lines.tsx) is this
// one with another LinePricing: the supplier's last prices instead of the customer's price list.

export type SalesLinesErrors = FieldErrors<{ lines: SalesLineFormValues[] }>['lines'];

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `new-${String(lastKey)}`;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

// A new line's starting price, from either lookup: per one of the unit, null when nothing is
// known (the person types it), where it came from, and the VAT rate the line starts with
export interface LinePrice {
  price: string | null;
  source: string | null;
  taxRateId: string;
}

// How a document prices the lines it adds (step 17b): the sales price lookup for a customer, or
// the purchase cost lookup for a supplier. Everything else the editor does is the same for both.
export interface LinePricing {
  // The party the prices are for; '' = none chosen yet
  partyId: string;
  // The unit a product added with "Add items" starts in: its selling unit, or its buying unit
  unitOf: (product: Product) => string;
  // The prices of some variants in some units, by `${variantId}:${unitId}` (linePriceKey)
  lookUp: (
    items: readonly { variantId: string; unitId: string }[],
  ) => Promise<ReadonlyMap<string, LinePrice>>;
  // Where a new line's price came from, under its box ("From their price list")
  sourceText: (source: string | null) => string;
  // The empty card, the reprice link and its toast
  words: { noLines: string; reprice: string; repriced: string };
  // The "Add items" dialog's section of texts, and its description when the section's own is not
  // the one
  picker: { words: 'salesLines' | 'purchaseLines'; description?: string };
}

export const linePriceKey = keyOf;

// The quotation's, the order's and the invoice's pricing: the customer's price list, else the
// product's price, in the selling unit
export function useSalesPricing(customerId: string): LinePricing {
  const { t } = useLocale();
  return {
    partyId: customerId,
    unitOf: (product) => product.salesUnitId ?? product.baseUnitId,
    lookUp: async (items) => {
      const answer = await call(routes.salesPrices.lookup, {
        body: { customerId: customerId === '' ? null : customerId, items: [...items] },
      });
      return new Map(
        answer.items.map((item) => [
          keyOf(item.variantId, item.unitId),
          { price: item.price, source: item.source, taxRateId: item.taxRateId },
        ]),
      );
    },
    sourceText: (source) =>
      source === 'price_list'
        ? t('salesLines.fromPriceList')
        : source === 'product'
          ? t('salesLines.fromProduct')
          : t('salesLines.noPrice'),
    words: {
      noLines: t('salesLines.noLines'),
      reprice: t('salesLines.reprice'),
      repriced: t('salesLines.repriced'),
    },
    picker: { words: 'salesLines' },
  };
}

// One template for the header and every line on a wide card. @5xl (64rem), not the @3xl of the
// stock lines: seven columns of controls do not fit in 48rem. Below it, each control shows its
// label. Exported for the credit note's lines (15d), which line up the same way.
export const SALES_LINE_COLUMNS =
  '@5xl:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_8.5rem_8.5rem_8.5rem_7.5rem_2.25rem] @5xl:items-start @5xl:gap-2';

// LineField's look, with the label hidden at @5xl (LineField hides it at @3xl). Exported for the
// invoice's own boxes under a line (invoice-lines.tsx).
export function SalesField({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid grid-cols-1 content-start gap-1.5', className)}>
      <label htmlFor={id} className="text-label font-medium text-ink @5xl:sr-only">
        {label}
      </label>
      {children}
      <LineError id={id} error={error} />
    </div>
  );
}

// A unit or a quantity a line cannot change (a challan line on an invoice): the same cell, as text.
// Exported for the credit note's VAT rate (15d), which is the invoice line's.
export function FixedValue({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <span className="text-label font-medium text-ink @5xl:sr-only">{label}</span>
      <span className={cn('py-2.5 text-body-sm text-ink-2 tabular-nums', className)}>{value}</span>
    </div>
  );
}

export interface LinesEditorProps<L extends SalesLineFormValues> {
  lines: L[];
  onChange: (lines: L[]) => void;
  // The form's lines right now (react-hook-form's getValues): an add that waited for the price
  // lookup appends to these, not to the lines of the render that started it
  getLines: () => L[];
  initialMeta: LineMeta[];
  // Step 17b: where new lines get their prices (useSalesPricing for the sales documents)
  pricing: LinePricing;
  pricesIncludeVat: boolean;
  errors: SalesLinesErrors;
  // The form's own line for a product added with "Add items" (an invoice line has more fields)
  newLine: (line: SalesLineFormValues) => L;
  // The most lines the document takes
  maxLines?: number;
  // A line whose item, unit and quantity come from elsewhere (a challan line on an invoice, billed
  // whole): they are shown, not changed. Its price, discount and VAT rate still are.
  fixed?: (line: L) => boolean;
  // Under the item: where the line comes from, or the batch of an invoice's own goods line.
  // `update` changes this line's own fields.
  lineNote?: (line: {
    value: L;
    index: number;
    item: SalesItem;
    update: (patch: Partial<L>) => void;
  }) => ReactNode;
  // More buttons beside "Add items" (an invoice's "Add challans"). They add lines with their meta
  // through `add`, which adds nothing and says false when the document would hold too many.
  moreAdds?: (add: (entries: readonly { line: L; meta: LineMeta }[]) => boolean) => ReactNode;
  // Step 17c: false = no totals under the lines. A supplier bill's totals count its expenses too,
  // so the bill form shows them itself, under both.
  totals?: boolean;
}

const sameLine = (line: SalesLineFormValues): SalesLineFormValues => line;

// The quotation's and the order's editor: a product added is a plain sales line, priced for the
// customer
export function SalesLinesEditor({
  customerId,
  ...props
}: Omit<LinesEditorProps<SalesLineFormValues>, 'newLine' | 'pricing'> & { customerId: string }) {
  const pricing = useSalesPricing(customerId);
  return <LinesEditor {...props} pricing={pricing} newLine={sameLine} />;
}

export function LinesEditor<L extends SalesLineFormValues>({
  lines,
  onChange,
  getLines,
  initialMeta,
  pricing,
  pricesIncludeVat,
  errors,
  newLine,
  maxLines = MAX_SALES_LINES,
  fixed = () => false,
  lineNote,
  moreAdds,
  totals: showTotals = true,
}: LinesEditorProps<L>) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const unitCode = useUnitCode();
  const rateText = useRateText();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const [meta, setMeta] = useState<LineMeta[]>(initialMeta);
  const [picking, setPicking] = useState(false);
  const [repricing, setRepricing] = useState(false);
  // The meta of the last render, for the async handlers (a unit change waits for its price)
  const metaRef = useRef(meta);
  useEffect(() => {
    metaRef.current = meta;
  });

  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  const { amounts, totals } = formTotals(lines, rateOf, pricesIncludeVat);
  // The rates a line may pick: the active ones, and the line's own if it was archived since
  const rateOptions = useMemo(
    () => (keep: string) => [
      { value: '', label: t('salesLines.vatRate') },
      ...taxRateOptions(rates ?? [], rateText, keep),
    ],
    [rates, rateText, t],
  );
  const { partyId, lookUp } = pricing;
  const repriceable =
    partyId !== '' && meta.some((line) => line.pricedFor !== partyId) && lines.length > 0;

  // Lines made elsewhere (an invoice's challan picker), with their meta. false = too many.
  const add = (entries: readonly { line: L; meta: LineMeta }[]): boolean => {
    if (getLines().length + entries.length > maxLines) return false;
    onChange([...getLines(), ...entries.map((entry) => entry.line)]);
    setMeta((before) => [...before, ...entries.map((entry) => entry.meta)]);
    return true;
  };

  // "Add": every active variant of the product, in its selling (17b: buying) unit, at the
  // looked-up price. false = the document would hold too many lines; nothing is added.
  const addProduct = async (product: Product): Promise<boolean> => {
    const variants = product.variants.filter((variant) => variant.archivedAt === null);
    if (getLines().length + variants.length > maxLines) return false;
    const unitId = pricing.unitOf(product);
    const prices = await lookUp(variants.map((variant) => ({ variantId: variant.id, unitId })));
    const added = variants.map((variant) => {
      const found = prices.get(keyOf(variant.id, unitId));
      const line: SalesLineFormValues = {
        variantId: variant.id,
        unitId,
        quantity: '',
        description: '',
        unitPrice: found?.price ?? '',
        discountType: 'percent',
        discount: '',
        // Left empty when the lookup had no rate (no default rate): the box says to pick one
        taxRateId: found?.taxRateId ?? '',
      };
      return {
        line: newLine(line),
        meta: {
          key: nextKey(),
          item: productItemOf(product, variant),
          source: found?.source ?? null,
          pricedFor: partyId,
        },
      };
    });
    // Checked above, before the wait; another add may have come in meanwhile
    return add(added);
  };

  const remove = (index: number) => {
    onChange(lines.filter((_, at) => at !== index));
    setMeta((before) => before.filter((_, at) => at !== index));
  };

  // The sales fields every line has, and (lineNote) the fields of the form's own line type
  const update = (index: number, patch: Partial<SalesLineFormValues>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };
  const updateOwn = (index: number, patch: Partial<L>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };

  // A price is per unit: a carton has its own price on a price list. A new unit asks for its
  // price; a unit with no price anywhere keeps what was typed.
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
      const price = found?.price ?? null;
      if (at === -1 || now?.unitId !== unitId || price === null) return;
      onChange(getLines().map((line, i) => (i === at ? { ...line, unitPrice: price } : line)));
      setMeta((before) =>
        before.map((line, i) =>
          i === at ? { ...line, source: found?.source ?? null, pricedFor: partyId } : line,
        ),
      );
    } catch {
      // The typed price stays; the person can type the new one
    }
  };

  // "Use this customer's prices on every line" (17b: "this supplier's last prices"): only lines
  // with a price somewhere change
  const reprice = async () => {
    setRepricing(true);
    try {
      const prices = await lookUp(
        lines.map((line) => ({ variantId: line.variantId, unitId: line.unitId })),
      );
      onChange(
        getLines().map((line) => {
          const price = prices.get(keyOf(line.variantId, line.unitId))?.price ?? null;
          return price === null ? line : { ...line, unitPrice: price };
        }),
      );
      setMeta((before) =>
        before.map((line, at) => {
          const now = lines[at];
          const found = now ? prices.get(keyOf(now.variantId, now.unitId)) : undefined;
          return { ...line, source: found?.source ?? null, pricedFor: partyId };
        }),
      );
      toast(pricing.words.repriced);
    } catch (error) {
      toast(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setRepricing(false);
    }
  };

  const listError = errors?.root?.message ?? errors?.message;

  return (
    <Card
      className="@container grid grid-cols-1 overflow-hidden"
      aria-label={t('salesLines.items')}
    >
      {repriceable && (
        <div className="border-b border-line px-5 py-3">
          <button
            type="button"
            disabled={repricing}
            onClick={() => void reprice()}
            className="text-label font-medium text-brand underline-offset-3 hover:underline"
          >
            {pricing.words.reprice}
          </button>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="px-5 py-6 text-body-sm text-ink-2">{pricing.words.noLines}</p>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            'hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @5xl:grid',
            SALES_LINE_COLUMNS,
          )}
        >
          <span>{t('salesLines.item')}</span>
          <span>{t('salesLines.unit')}</span>
          <span className="text-right">{t('salesLines.quantity')}</span>
          <span className="text-right">
            {pricesIncludeVat ? t('salesLines.priceWithVat') : t('salesLines.priceWithoutVat')}
          </span>
          <span className="text-right">{t('salesLines.discount')}</span>
          <span>{t('salesLines.vatRate')}</span>
          <span className="text-right">{t('salesLines.amount')}</span>
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
        const locked = fixed(line);
        const removeButton = (
          <IconButton
            icon={Delete02Icon}
            label={t('salesLines.remove', { number })}
            onClick={() => {
              remove(index);
            }}
          />
        );
        return (
          <div
            key={lineMeta.key}
            role="group"
            aria-label={t('salesLines.line', { number })}
            className={cn(
              'grid grid-cols-2 gap-3 border-t border-line px-5 py-4',
              SALES_LINE_COLUMNS,
            )}
          >
            <div className="col-span-2 grid min-w-0 gap-2 @5xl:col-span-1">
              <div className="flex items-start justify-between gap-3">
                <span className="grid min-w-0 gap-1">
                  <VariantCell item={item} />
                  {isServiceLine(item) && (
                    <span>
                      <Pill tone="neutral" icon={Wrench01Icon}>
                        {t('salesLines.service')}
                      </Pill>
                    </span>
                  )}
                </span>
                <span className="@5xl:hidden">{removeButton}</span>
              </div>
              {lineNote?.({
                value: line,
                index,
                item,
                update: (patch) => {
                  updateOwn(index, patch);
                },
              })}
              <SalesField
                id={id('description')}
                label={t('salesLines.description')}
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
              </SalesField>
            </div>
            {locked ? (
              <>
                <FixedValue label={t('salesLines.unit')} value={unitCode(line.unitId)} />
                <FixedValue
                  label={t('salesLines.quantity')}
                  value={plainQuantity(line.quantity)}
                  className="text-right"
                />
              </>
            ) : (
              <>
                <SalesField
                  id={id('unitId')}
                  label={t('salesLines.unit')}
                  error={lineErrors?.unitId?.message}
                >
                  <Select
                    id={id('unitId')}
                    options={unitChoices(item, units)}
                    value={line.unitId}
                    invalid={lineErrors?.unitId !== undefined}
                    onChange={(event) => void changeUnit(index, event.target.value)}
                  />
                </SalesField>
                <SalesField
                  id={id('quantity')}
                  label={t('salesLines.quantity')}
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
                </SalesField>
              </>
            )}
            <SalesField
              id={id('unitPrice')}
              label={
                pricesIncludeVat ? t('salesLines.priceWithVat') : t('salesLines.priceWithoutVat')
              }
              error={lineErrors?.unitPrice?.message}
            >
              <MoneyInput
                id={id('unitPrice')}
                value={line.unitPrice}
                invalid={lineErrors?.unitPrice !== undefined}
                aria-describedby={lineErrors?.unitPrice ? `${id('unitPrice')}-error` : undefined}
                onChange={(value) => {
                  update(index, { unitPrice: value });
                }}
              />
              {lineMeta.source !== undefined && (
                <span className="text-right text-caption text-ink-3">
                  {pricing.sourceText(lineMeta.source)}
                </span>
              )}
            </SalesField>
            <SalesField
              id={id('discount')}
              label={t('salesLines.discount')}
              error={lineErrors?.discount?.message}
            >
              <DiscountInput
                id={id('discount')}
                value={line.discount}
                discountType={line.discountType}
                invalid={lineErrors?.discount !== undefined}
                aria-describedby={lineErrors?.discount ? `${id('discount')}-error` : undefined}
                onChange={(value) => {
                  update(index, { discount: value });
                }}
                onDiscountTypeChange={(discountType) => {
                  update(index, { discountType });
                }}
              />
            </SalesField>
            <SalesField
              id={id('taxRateId')}
              label={t('salesLines.vatRate')}
              error={lineErrors?.taxRateId?.message}
            >
              <Select
                id={id('taxRateId')}
                options={rateOptions(line.taxRateId)}
                value={line.taxRateId}
                invalid={lineErrors?.taxRateId !== undefined}
                onChange={(event) => {
                  update(index, { taxRateId: event.target.value });
                }}
              />
            </SalesField>
            <div className="grid content-start gap-1.5">
              <span className="text-label font-medium text-ink @5xl:sr-only">
                {t('salesLines.amount')}
              </span>
              {/* Quantity × price, less the discount: the line in the price's own terms (with VAT
                  when prices include it). The VAT is in the totals below. */}
              <span className="py-2.5 text-right text-body-sm font-medium tabular-nums">
                {amount
                  ? format.money(pricesIncludeVat ? amount.total : amount.net, { decimals: 2 })
                  : '—'}
              </span>
            </div>
            <div className="hidden @5xl:block @5xl:pt-1">{removeButton}</div>
          </div>
        );
      })}
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setPicking(true);
          }}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
          {t('salesLines.addItems')}
        </Button>
        {moreAdds?.(add)}
      </div>
      {showTotals && lines.length > 0 && (
        <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ProductPicker
            words={pricing.picker.words}
            description={pricing.picker.description}
            onAdd={addProduct}
            maxLines={maxLines}
          />
        )}
      </Dialog>
    </Card>
  );
}
