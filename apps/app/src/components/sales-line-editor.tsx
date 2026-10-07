import {
  Alert02Icon,
  Delete02Icon,
  PackageSearchIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  MAX_SALES_LINES,
  type PriceLookupItem,
  type Product,
  type ProductSummary,
  routes,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DiscountInput,
  EmptyState,
  IconButton,
  Input,
  MoneyInput,
  Pill,
  Select,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import { formTotals, isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
import { basePreview, unitChoices } from '../lib/stock';
import { taxRateOptions, useRateText } from '../lib/tax-rates';
import { productQuery, productSearchQuery, taxRatesQuery, unitsQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';
import { failureOf, LineError } from './journal-parts';
import { SalesTotals } from './sales-parts';
import { useQuantity, useTenantId, VariantCell } from './stock-parts';

// The lines of a quotation or an order: one editor for both. The form holds the lines as one
// controlled value (a Controller on "lines"), and this editor changes that array. A field array
// would need the form's own type here, and the two forms have different types; one array value has
// the same type in both (SalesLineFormValues[]), so neither form needs a cast.

export type SalesLinesErrors = FieldErrors<{ lines: SalesLineFormValues[] }>['lines'];

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `new-${String(lastKey)}`;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

// One template for the header and every line on a wide card. @5xl (64rem), not the @3xl of the
// stock lines: seven columns of controls do not fit in 48rem. Below it, each control shows its
// label.
const COLUMNS =
  '@5xl:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_8.5rem_8.5rem_8.5rem_7.5rem_2.25rem] @5xl:items-start @5xl:gap-2';

// LineField's look, with the label hidden at @5xl (LineField hides it at @3xl)
function SalesField({
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

export function SalesLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  customerId,
  pricesIncludeVat,
  errors,
}: {
  lines: SalesLineFormValues[];
  onChange: (lines: SalesLineFormValues[]) => void;
  // The form's lines right now (react-hook-form's getValues): an add that waited for the price
  // lookup appends to these, not to the lines of the render that started it
  getLines: () => SalesLineFormValues[];
  initialMeta: LineMeta[];
  customerId: string;
  pricesIncludeVat: boolean;
  errors: SalesLinesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
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
  const repriceable =
    customerId !== '' && meta.some((line) => line.pricedFor !== customerId) && lines.length > 0;

  // Prices and rates for some variants in some units, for this customer
  const lookUp = async (items: { variantId: string; unitId: string }[]) => {
    const answer = await call(routes.salesPrices.lookup, {
      body: { customerId: customerId === '' ? null : customerId, items },
    });
    return new Map<string, PriceLookupItem>(
      answer.items.map((item) => [keyOf(item.variantId, item.unitId), item]),
    );
  };

  // "Add": every active variant of the product, in its selling unit, at the looked-up price.
  // false = the document would hold too many lines; nothing is added.
  const addProduct = async (product: Product): Promise<boolean> => {
    const variants = product.variants.filter((variant) => variant.archivedAt === null);
    if (getLines().length + variants.length > MAX_SALES_LINES) return false;
    const unitId = product.salesUnitId ?? product.baseUnitId;
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
      const item: SalesItem = {
        variantId: variant.id,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        optionValues: variant.optionValues,
        sku: variant.sku,
        baseUnitId: product.baseUnitId,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        productType: product.type,
      };
      return {
        line,
        meta: { key: nextKey(), item, source: found?.source ?? null, pricedFor: customerId },
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

  const update = (index: number, patch: Partial<SalesLineFormValues>) => {
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
          i === at ? { ...line, source: found?.source ?? null, pricedFor: customerId } : line,
        ),
      );
    } catch {
      // The typed price stays; the person can type the new one
    }
  };

  // "Use this customer's prices on every line": only lines with a price somewhere change
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
          return { ...line, source: found?.source ?? null, pricedFor: customerId };
        }),
      );
      toast(t('salesLines.repriced'));
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
            {t('salesLines.reprice')}
          </button>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="px-5 py-6 text-body-sm text-ink-2">{t('salesLines.noLines')}</p>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            'hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @5xl:grid',
            COLUMNS,
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
            className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
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
                  {lineMeta.source === 'price_list'
                    ? t('salesLines.fromPriceList')
                    : lineMeta.source === 'product'
                      ? t('salesLines.fromProduct')
                      : t('salesLines.noPrice')}
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
      <div className="border-t border-line px-5 py-3">
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
      </div>
      {lines.length > 0 && <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />}

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && <SalesItemPicker onAdd={addProduct} />}
      </Dialog>
    </Card>
  );
}

// "Add items": search the products and services, then add one. The dialog stays open, so a long
// order is put together without closing it; each click adds the product's lines at once.
function SalesItemPicker({ onAdd }: { onAdd: (product: Product) => Promise<boolean> }) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: products } = useQuery(productSearchQuery(tenantId, settled));

  // The list sends a summary; the variants, the packs and the selling unit come with the product
  const add = async (summary: ProductSummary) => {
    setLoading(summary.id);
    setProblem(null);
    try {
      const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
      if (fits) setAdded((before) => new Set(before).add(summary.id));
      else setProblem(t('salesLines.tooMany', { max: MAX_SALES_LINES }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('salesLines.pickerTitle')}
      description={t('salesLines.pickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('salesLines.pickerSearch')}
          placeholder={t('products.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        {problem !== null && (
          <p role="status" className="flex items-center gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
            {problem}
          </p>
        )}
        {products?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t('salesLines.pickerEmpty')}
            description={t('salesLines.pickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {products?.map((product) => (
              <li
                key={product.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{product.name}</span>
                  <span className="truncate text-caption text-ink-3">
                    <span className="font-mono tabular-nums">{product.code}</span>
                    {product.hasVariants &&
                      ` · ${t('products.variantCount', { count: product.variantCount })}`}
                  </span>
                </span>
                {isServiceLine({ productType: product.type }) && (
                  <Pill tone="neutral" icon={Wrench01Icon}>
                    {t('salesLines.service')}
                  </Pill>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading === product.id}
                  onClick={() => void add(product)}
                >
                  <HugeiconsIcon
                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(product.id) ? t('salesLines.added') : t('salesLines.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
