import {
  Alert02Icon,
  Delete02Icon,
  DeliveryReturn01Icon,
  InvoiceIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  type CreditNoteLineFormValues,
  defaultLineDescription,
  documentTotals,
  draftLineAmounts,
  type Invoice,
  type InvoiceLine,
  isMoneyAmount,
  type LineAmounts,
  MAX_INVOICE_LINES,
  priceInUnit,
  wholeInvoiceCreditLines,
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
  Select,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { postedReturnsQuery, salesReturnQuery, unitsQuery } from '../lib/queries';
import { creditableReturnLines, creditLeft, returnLineToCredit } from '../lib/returns';
import { basePreview, unitChoices } from '../lib/stock';
import { useRateText } from '../lib/tax-rates';
import { failureOf } from './journal-parts';
import { FixedValue, SALES_LINE_COLUMNS, SalesField } from './sales-line-editor';
import { PickButton, PickProblem, SalesTotals } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, VariantCell } from './stock-parts';

// The lines of a credit note (step 15d): the sales line editor's grid and boxes, but every line
// takes back a line of the chosen invoice. The item and the VAT rate are that line's (the VAT taken
// back is the VAT charged), so they are shown, not picked; the unit, quantity, price and discount
// can change (3 strips back from a line of 2 boxes; a price cut of ৳2 a strip). Lines come only from
// the two pickers: an invoice line, or goods that came back on a return. Its own chunk, loaded by
// the credit note form.

export type CreditNoteLinesErrors = FieldErrors<{ lines: CreditNoteLineFormValues[] }>['lines'];

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `credit-${String(lastKey)}`;
}

// A unit's size in the base unit: "1" for the base unit itself
function factorOf(line: InvoiceLine, unitId: string): string | null {
  if (unitId === line.baseUnitId) return '1';
  return line.units.find((unit) => unit.unitId === unitId)?.factor ?? null;
}

export function CreditNoteLinesEditor({
  lines,
  onChange,
  getLines,
  invoice,
  customerId,
  returnNumbers,
  onReturnNumbers,
  errors,
}: {
  lines: CreditNoteLineFormValues[];
  onChange: (lines: CreditNoteLineFormValues[]) => void;
  // The form's lines right now (getValues): a picker that waited for the API appends to these
  getLines: () => CreditNoteLineFormValues[];
  // The chosen invoice with its lines; null until one is picked
  invoice: Invoice | null;
  customerId: string;
  // The return number of each return line on the form, for "Goods back on SR-…"
  returnNumbers: ReadonlyMap<string, string>;
  onReturnNumbers: (entries: readonly (readonly [string, string])[]) => void;
  errors: CreditNoteLinesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const rateText = useRateText();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  // React's key for each line: stays with the line when a line above it is removed
  const [keys, setKeys] = useState<string[]>(() => lines.map(() => nextKey()));
  const [picking, setPicking] = useState<'lines' | 'returns' | null>(null);
  const invoiceLines = new Map(invoice?.lines.map((line) => [line.id, line]));
  const pricesIncludeVat = invoice?.pricesIncludeVat ?? false;
  const money = (value: string) => format.money(value, { decimals: 2 });

  // Worked out like the API: the invoice's own pricing, the invoice line's VAT rate
  const amounts = lines.map((line) => {
    const source = invoiceLines.get(line.invoiceLineId);
    return source
      ? draftLineAmounts(
          {
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountType: line.discountType,
            discount: line.discount,
          },
          source.taxRate.rate,
          pricesIncludeVat,
        )
      : null;
  });
  const totals = documentTotals(amounts.filter((amount): amount is LineAmounts => amount !== null));

  // Lines from a picker. false = the credit note would hold too many; nothing is added.
  const add = (added: readonly CreditNoteLineFormValues[]): boolean => {
    if (getLines().length + added.length > MAX_INVOICE_LINES) return false;
    onChange([...getLines(), ...added]);
    setKeys((before) => [...before, ...added.map(() => nextKey())]);
    return true;
  };

  const remove = (index: number) => {
    onChange(lines.filter((_, at) => at !== index));
    setKeys((before) => before.filter((_, at) => at !== index));
  };

  const update = (index: number, patch: Partial<CreditNoteLineFormValues>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };

  // A price is per unit, so another unit moves the typed price with it: ৳120 a box is ৳12 a strip.
  // A price being typed stays as it is.
  const changeUnit = (index: number, unitId: string) => {
    const line = lines[index];
    const source = line ? invoiceLines.get(line.invoiceLineId) : undefined;
    if (!line || !source) return;
    const from = factorOf(source, line.unitId);
    const to = factorOf(source, unitId);
    const price = line.unitPrice.trim();
    update(index, {
      unitId,
      ...(from !== null && to !== null && isMoneyAmount(price)
        ? { unitPrice: priceInUnit(price, from, to) }
        : {}),
    });
  };

  const listError = errors?.root?.message ?? errors?.message;

  return (
    <Card
      className="@container grid grid-cols-1 overflow-hidden"
      aria-label={t('salesLines.items')}
    >
      {lines.length === 0 ? (
        <p className="px-5 py-6 text-body-sm text-ink-2">{t('salesLines.noLines')}</p>
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
        const source = invoiceLines.get(line.invoiceLineId);
        const key = keys[index] ?? `line-${String(index)}`;
        if (!source) return null;
        const number = index + 1;
        const lineErrors = errors?.[index];
        const id = (field: string) => `lines.${String(index)}.${field}`;
        const preview = basePreview(source, line.unitId, line.quantity, units);
        const amount = amounts[index];
        const returnLineId = line.returnLineId ?? '';
        // The line's own problem: not a line of this invoice, or a return line it cannot credit
        const lineError = lineErrors?.invoiceLineId?.message ?? lineErrors?.returnLineId?.message;
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
            key={key}
            role="group"
            aria-label={t('salesLines.line', { number })}
            className={cn(
              'grid grid-cols-2 gap-3 border-t border-line px-5 py-4',
              SALES_LINE_COLUMNS,
            )}
          >
            <div className="col-span-2 grid min-w-0 gap-2 @5xl:col-span-1">
              <div className="flex items-start justify-between gap-3">
                <VariantCell item={source} />
                <span className="@5xl:hidden">{removeButton}</span>
              </div>
              <span className="grid gap-0.5 text-caption text-ink-3">
                <span className="font-medium text-ink-2">
                  {returnLineId === ''
                    ? t('creditNotes.fromInvoiceLine', {
                        number: (invoice?.lines.indexOf(source) ?? 0) + 1,
                      })
                    : t('creditNotes.fromReturn', {
                        number: returnNumbers.get(returnLineId) ?? '',
                      })}
                </span>
                {/* The money cap of 15d.1: what posted credit notes left on the invoice line */}
                <span className="tabular-nums">
                  {t('creditNotes.leftToCredit', { amount: money(creditLeft(source)) })}
                </span>
                {lineError && (
                  <span className="flex items-start gap-1.5 text-label text-crit">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={15}
                      strokeWidth={1.5}
                      className="mt-px shrink-0"
                    />
                    {errorText(lineError)}
                  </span>
                )}
              </span>
              <SalesField
                id={id('description')}
                label={t('salesLines.description')}
                error={lineErrors?.description?.message}
              >
                <Input
                  id={id('description')}
                  autoComplete="off"
                  placeholder={defaultLineDescription(source)}
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
                options={unitChoices(source, units)}
                value={line.unitId}
                invalid={lineErrors?.unitId !== undefined}
                onChange={(event) => {
                  changeUnit(index, event.target.value);
                }}
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
                  {t('stockLines.equals', { quantity: quantityText(preview, source.baseUnitId) })}
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
            <FixedValue
              label={t('salesLines.vatRate')}
              value={`${source.taxRate.name} · ${rateText(source.taxRate.rate)}`}
            />
            <div className="grid content-start gap-1.5">
              <span className="text-label font-medium text-ink @5xl:sr-only">
                {t('salesLines.amount')}
              </span>
              <span className="py-2.5 text-right text-body-sm font-medium tabular-nums">
                {amount ? money(pricesIncludeVat ? amount.total : amount.net) : '—'}
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
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={invoice === null}
          onClick={() => {
            setPicking('lines');
          }}
        >
          <HugeiconsIcon icon={InvoiceIcon} size={16} strokeWidth={1.5} />
          {t('creditNotes.addInvoiceLines')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={invoice === null}
          onClick={() => {
            setPicking('returns');
          }}
        >
          <HugeiconsIcon icon={DeliveryReturn01Icon} size={16} strokeWidth={1.5} />
          {t('creditNotes.addReturns')}
        </Button>
        {invoice === null && (
          <span className="text-label text-ink-3">{t('creditNotes.pickInvoiceFirst')}</span>
        )}
      </div>
      {lines.length > 0 && <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />}

      <Dialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
      >
        {picking === 'lines' && invoice && <InvoiceLinePicker invoice={invoice} add={add} />}
        {picking === 'returns' && invoice && (
          <ReturnPicker
            invoice={invoice}
            customerId={customerId}
            onForm={
              new Set(
                lines.flatMap((line) => {
                  const id = line.returnLineId ?? '';
                  return id === '' ? [] : [id];
                }),
              )
            }
            add={add}
            onReturnNumbers={onReturnNumbers}
          />
        )}
      </Dialog>
    </Card>
  );
}

// "Add invoice lines": a line of the invoice as it was billed, for a price cut (keep the quantity,
// type the cut per unit) or goods that came back without a return in the system. Lines taken back
// in full are left out.
function InvoiceLinePicker({
  invoice,
  add,
}: {
  invoice: Invoice;
  add: (lines: readonly CreditNoteLineFormValues[]) => boolean;
}) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const open = invoice.lines.filter((line) => compareMoney(creditLeft(line), '0') > 0);

  const pick = (line: InvoiceLine) => {
    setProblem(null);
    if (add(wholeInvoiceCreditLines({ lines: [line] }))) {
      setAdded((before) => new Set(before).add(line.id));
    } else {
      setProblem(t('salesLines.tooMany', { max: MAX_INVOICE_LINES }));
    }
  };

  return (
    <DialogContent
      title={t('creditNotes.invoiceLinePickerTitle')}
      description={t('creditNotes.invoiceLinePickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {open.length === 0 ? (
          <EmptyState
            icon={InvoiceIcon}
            title={t('creditNotes.invoiceLinePickerEmpty')}
            description={t('creditNotes.invoiceLinePickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {open.map((line) => (
              <li
                key={line.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{line.description}</span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {t('creditNotes.fromInvoiceLine', { number: invoice.lines.indexOf(line) + 1 })}{' '}
                    · {quantity(line.quantity, line.unitId)} ·{' '}
                    {t('creditNotes.leftToCredit', {
                      amount: format.money(creditLeft(line), { decimals: 2 }),
                    })}
                  </span>
                </span>
                <PickButton
                  added={added.has(line.id)}
                  loading={false}
                  onClick={() => {
                    pick(line);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

// "Add returned goods": the customer's posted returns. A click opens the return and adds its lines
// that this invoice billed and credit notes have not given the money back for, at the invoice's
// price. The list cannot say which returns hold such lines, so one with none says so when opened.
function ReturnPicker({
  invoice,
  customerId,
  onForm,
  add,
  onReturnNumbers,
}: {
  invoice: Invoice;
  customerId: string;
  onForm: ReadonlySet<string>;
  add: (lines: readonly CreditNoteLineFormValues[]) => boolean;
  onReturnNumbers: (entries: readonly (readonly [string, string])[]) => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const { data: returns } = useQuery(postedReturnsQuery(tenantId, customerId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const invoiceLines = new Map(invoice.lines.map((line) => [line.id, line]));

  const pick = async (returnId: string) => {
    setLoading(returnId);
    setProblem(null);
    try {
      const salesReturn = await queryClient.query(salesReturnQuery(tenantId, returnId));
      const lines = creditableReturnLines(salesReturn, invoice.id, onForm).flatMap((line) => {
        const source = invoiceLines.get(line.invoiceLineId ?? '');
        return source ? [{ line, credit: returnLineToCredit(line, source) }] : [];
      });
      if (lines.length === 0) {
        setProblem(t('creditNotes.returnPickerEmpty'));
        return;
      }
      if (!add(lines.map((entry) => entry.credit))) {
        setProblem(t('salesLines.tooMany', { max: MAX_INVOICE_LINES }));
        return;
      }
      onReturnNumbers(lines.map((entry) => [entry.line.id, salesReturn.number ?? ''] as const));
      setAdded((before) => new Set(before).add(returnId));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('creditNotes.returnPickerTitle')}
      description={t('creditNotes.returnPickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {returns?.length === 0 ? (
          <EmptyState
            icon={DeliveryReturn01Icon}
            title={t('creditNotes.returnPickerEmpty')}
            description={t('creditNotes.returnPickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {returns?.map((salesReturn) => (
              <li
                key={salesReturn.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {salesReturn.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(salesReturn.date)} ·{' '}
                    {t('salesLines.lineCount', { count: salesReturn.lineCount })}
                  </span>
                </span>
                <PickButton
                  added={added.has(salesReturn.id)}
                  loading={loading === salesReturn.id}
                  onClick={() => void pick(salesReturn.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
