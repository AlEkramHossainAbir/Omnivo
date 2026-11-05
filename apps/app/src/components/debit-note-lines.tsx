import {
  Alert02Icon,
  Delete02Icon,
  InvoiceIcon,
  PlusSignIcon,
  TruckReturnIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Bill,
  type BillExpense,
  type BillLine,
  compareMoney,
  type DebitNoteExpenseFormValues,
  type DebitNoteLineFormValues,
  defaultLineDescription,
  draftLineAmounts,
  isMoneyAmount,
  MAX_BILL_EXPENSES,
  MAX_BILL_LINES,
  priceInUnit,
  wholeBillDebit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
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
import { type ReactNode, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { draftExpenseAmounts } from '../lib/bills';
import {
  type DebitItem,
  debitableExpenses,
  debitableReturnLines,
  debitLeft,
  debitLineRate,
  expenseToDebit,
  ownReturnLineToDebit,
  returnLineItem,
  returnLineToDebit,
} from '../lib/purchase-returns';
import {
  postedPurchaseReturnsQuery,
  purchaseReturnQuery,
  taxRatesQuery,
  unitsQuery,
} from '../lib/queries';
import { basePreview, unitChoices } from '../lib/stock';
import { taxRateOptions, useRateText } from '../lib/tax-rates';
import { failureOf } from './journal-parts';
import { FixedValue, SALES_LINE_COLUMNS, SalesField } from './sales-line-editor';
import { PickButton, PickProblem } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, VariantCell } from './stock-parts';

// The lines and the expenses of a debit note (step 17d): the credit note's line editor (15d) seen
// from the buyer's side, plus a card for the bill's expenses. With a bill, every line takes off a
// line of that bill: the item and the VAT rate are the bill line's (the VAT taken off is the VAT
// that was claimed), so they are shown, not picked; the unit, quantity, price and discount can
// change. Without a bill (decision 9), every line takes off goods that went back on a return line
// of its own: the item is the return line's, and the VAT rate is picked here, from the supplier's
// credit note. Lines come only from the pickers. Its own chunk, loaded by the debit note form.

export type DebitNoteLinesErrors = FieldErrors<{ lines: DebitNoteLineFormValues[] }>['lines'];
export type DebitNoteExpensesErrors = FieldErrors<{
  expenses: DebitNoteExpenseFormValues[];
}>['expenses'];

// What the form knows about a return line on the form, by its id: the return's number, for "Goods
// sent back on PRN-…", and the item, for a line without a bill (which has no bill line to show)
export interface DebitReturnSource {
  number: string;
  item: DebitItem;
}

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `debit-${String(lastKey)}`;
}

// A unit's size in the base unit: "1" for the base unit itself
function factorOf(item: DebitItem, unitId: string): string | null {
  if (unitId === item.baseUnitId) return '1';
  return item.units.find((unit) => unit.unitId === unitId)?.factor ?? null;
}

export function DebitNoteLinesEditor({
  lines,
  onChange,
  getLines,
  bill,
  supplierId,
  pricesIncludeVat,
  returnSources,
  onReturnSources,
  errors,
}: {
  lines: DebitNoteLineFormValues[];
  onChange: (lines: DebitNoteLineFormValues[]) => void;
  // The form's lines right now (getValues): a picker that waited for the API appends to these
  getLines: () => DebitNoteLineFormValues[];
  // The chosen bill with its lines; null for a debit note without a bill
  bill: Bill | null;
  supplierId: string;
  pricesIncludeVat: boolean;
  returnSources: ReadonlyMap<string, DebitReturnSource>;
  onReturnSources: (entries: readonly (readonly [string, DebitReturnSource])[]) => void;
  errors: DebitNoteLinesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const rateText = useRateText();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  // React's key for each line: stays with the line when a line above it is removed
  const [keys, setKeys] = useState<string[]>(() => lines.map(() => nextKey()));
  const [picking, setPicking] = useState<'lines' | 'returns' | null>(null);
  const billLines = new Map(bill?.lines.map((line) => [line.id, line]));
  const money = (value: string) => format.money(value, { decimals: 2 });

  // The line's item and its bill line (null for a line without a bill)
  const sourceOf = (
    line: DebitNoteLineFormValues,
  ): { item: DebitItem; billLine: BillLine | null } | null => {
    const billLine = billLines.get(line.billLineId ?? '');
    if (billLine) return { item: billLine, billLine };
    const own = returnSources.get(line.returnLineId ?? '');
    return own ? { item: own.item, billLine: null } : null;
  };

  // Lines from a picker. false = the debit note would hold too many; nothing is added.
  const add = (added: readonly DebitNoteLineFormValues[]): boolean => {
    if (getLines().length + added.length > MAX_BILL_LINES) return false;
    onChange([...getLines(), ...added]);
    setKeys((before) => [...before, ...added.map(() => nextKey())]);
    return true;
  };

  const remove = (index: number) => {
    onChange(lines.filter((_, at) => at !== index));
    setKeys((before) => before.filter((_, at) => at !== index));
  };

  const update = (index: number, patch: Partial<DebitNoteLineFormValues>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };

  // A price is per unit, so another unit moves the typed price with it: ৳7,800 a bag is ৳156 a kg.
  // A price being typed stays as it is.
  const changeUnit = (index: number, unitId: string) => {
    const line = lines[index];
    const source = line ? sourceOf(line) : null;
    if (!line || !source) return;
    const from = factorOf(source.item, line.unitId);
    const to = factorOf(source.item, unitId);
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
        const source = sourceOf(line);
        const key = keys[index] ?? `line-${String(index)}`;
        if (!source) return null;
        const { item, billLine } = source;
        const number = index + 1;
        const lineErrors = errors?.[index];
        const id = (field: string) => `lines.${String(index)}.${field}`;
        const preview = basePreview(item, line.unitId, line.quantity, units);
        const amount = draftLineAmounts(
          {
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountType: line.discountType,
            discount: line.discount,
          },
          debitLineRate(line, billLines, rateOf),
          pricesIncludeVat,
        );
        const returnLineId = line.returnLineId ?? '';
        const taxRateId = line.taxRateId ?? '';
        // The line's own problem: not a line of this bill, or a return line it cannot debit
        const lineError = lineErrors?.billLineId?.message ?? lineErrors?.returnLineId?.message;
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
                <VariantCell item={item} />
                <span className="@5xl:hidden">{removeButton}</span>
              </div>
              <span className="grid gap-0.5 text-caption text-ink-3">
                <span className="font-medium text-ink-2">
                  {returnLineId === ''
                    ? t('debitNotes.fromBillLine', {
                        number: billLine ? (bill?.lines.indexOf(billLine) ?? 0) + 1 : 0,
                      })
                    : t('debitNotes.fromReturn', {
                        number: returnSources.get(returnLineId)?.number ?? '',
                      })}
                </span>
                {/* The money cap of 17d.1: what posted debit notes left on the bill line */}
                {billLine && (
                  <span className="tabular-nums">
                    {t('debitNotes.leftToDebit', { amount: money(debitLeft(billLine)) })}
                  </span>
                )}
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
                  placeholder={billLine ? defaultLineDescription(billLine) : item.productName}
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
            {billLine ? (
              <FixedValue
                label={t('salesLines.vatRate')}
                value={`${billLine.taxRate.name} · ${rateText(billLine.taxRate.rate)}`}
              />
            ) : (
              // Without a bill, the rate on the supplier's credit note (tax_rate_invalid when
              // none is picked)
              <SalesField
                id={id('taxRateId')}
                label={t('salesLines.vatRate')}
                error={lineErrors?.taxRateId?.message}
              >
                <Select
                  id={id('taxRateId')}
                  options={[
                    { value: '', label: t('salesLines.vatRate') },
                    ...taxRateOptions(rates ?? [], rateText, taxRateId),
                  ]}
                  value={taxRateId}
                  invalid={lineErrors?.taxRateId !== undefined}
                  onChange={(event) => {
                    update(index, { taxRateId: event.target.value });
                  }}
                />
              </SalesField>
            )}
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
        {/* A debit note without a bill has no bill lines to take off: only returned goods */}
        {bill !== null && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPicking('lines');
            }}
          >
            <HugeiconsIcon icon={InvoiceIcon} size={16} strokeWidth={1.5} />
            {t('debitNotes.addBillLines')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={supplierId === ''}
          onClick={() => {
            setPicking('returns');
          }}
        >
          <HugeiconsIcon icon={TruckReturnIcon} size={16} strokeWidth={1.5} />
          {t('debitNotes.addReturns')}
        </Button>
        {supplierId === '' && (
          <span className="text-label text-ink-3">{t('debitNotes.pickSupplierFirst')}</span>
        )}
      </div>

      <Dialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
      >
        {picking === 'lines' && bill && <BillLinePicker bill={bill} add={add} />}
        {picking === 'returns' && (
          <ReturnPicker
            bill={bill}
            supplierId={supplierId}
            onForm={
              new Set(
                lines.flatMap((line) => {
                  const lineId = line.returnLineId ?? '';
                  return lineId === '' ? [] : [lineId];
                }),
              )
            }
            add={add}
            onReturnSources={onReturnSources}
          />
        )}
      </Dialog>
    </Card>
  );
}

// "Add bill lines": a line of the bill as it was billed, for a price cut (keep the quantity, type
// the cut per unit) or a billing mistake. Lines taken off in full are left out.
function BillLinePicker({
  bill,
  add,
}: {
  bill: Bill;
  add: (lines: readonly DebitNoteLineFormValues[]) => boolean;
}) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const open = bill.lines.filter((line) => compareMoney(debitLeft(line), '0') > 0);

  const pick = (line: BillLine) => {
    setProblem(null);
    if (add(wholeBillDebit({ lines: [line], expenses: [] }).lines)) {
      setAdded((before) => new Set(before).add(line.id));
    } else {
      setProblem(t('salesLines.tooMany', { max: MAX_BILL_LINES }));
    }
  };

  return (
    <DialogContent
      title={t('debitNotes.billLinePickerTitle')}
      description={t('debitNotes.billLinePickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {open.length === 0 ? (
          <EmptyState
            icon={InvoiceIcon}
            title={t('debitNotes.billLinePickerEmpty')}
            description={t('debitNotes.billLinePickerDescription')}
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
                    {t('debitNotes.fromBillLine', { number: bill.lines.indexOf(line) + 1 })} ·{' '}
                    {quantity(line.quantity, line.unitId)} ·{' '}
                    {t('debitNotes.leftToDebit', {
                      amount: format.money(debitLeft(line), { decimals: 2 }),
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

// "Add returned goods": the supplier's posted returns. A click opens the return and adds its lines
// that this bill billed and debit notes have not taken off yet, at the bill's price; without a bill,
// its lines on their own, with the price and the rate to type. The list cannot say which returns
// hold such lines, so one with none says so when opened.
function ReturnPicker({
  bill,
  supplierId,
  onForm,
  add,
  onReturnSources,
}: {
  bill: Bill | null;
  supplierId: string;
  onForm: ReadonlySet<string>;
  add: (lines: readonly DebitNoteLineFormValues[]) => boolean;
  onReturnSources: (entries: readonly (readonly [string, DebitReturnSource])[]) => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const { data: returns } = useQuery(postedPurchaseReturnsQuery(tenantId, supplierId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const billLines = new Map(bill?.lines.map((line) => [line.id, line]));
  const description = bill
    ? t('debitNotes.returnPickerDescription')
    : t('debitNotes.returnPickerOwnDescription');

  const pick = async (returnId: string) => {
    setLoading(returnId);
    setProblem(null);
    try {
      const purchaseReturn = await queryClient.query(purchaseReturnQuery(tenantId, returnId));
      const found = debitableReturnLines(purchaseReturn, bill?.id ?? null, onForm).flatMap(
        (line) => {
          if (bill === null) return [{ line, debit: ownReturnLineToDebit(line) }];
          const billLine = billLines.get(line.billLineId ?? '');
          return billLine ? [{ line, debit: returnLineToDebit(line, billLine) }] : [];
        },
      );
      if (found.length === 0) {
        setProblem(t('debitNotes.returnPickerEmpty'));
        return;
      }
      if (!add(found.map((entry) => entry.debit))) {
        setProblem(t('salesLines.tooMany', { max: MAX_BILL_LINES }));
        return;
      }
      onReturnSources(
        found.map(
          (entry) =>
            [
              entry.line.id,
              { number: purchaseReturn.number ?? '', item: returnLineItem(entry.line) },
            ] as const,
        ),
      );
      setAdded((before) => new Set(before).add(returnId));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent title={t('debitNotes.returnPickerTitle')} description={description}>
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {returns?.length === 0 ? (
          <EmptyState
            icon={TruckReturnIcon}
            title={t('debitNotes.returnPickerEmpty')}
            description={description}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {returns?.map((purchaseReturn) => (
              <li
                key={purchaseReturn.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {purchaseReturn.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(purchaseReturn.date)} ·{' '}
                    {t('salesLines.lineCount', { count: purchaseReturn.lineCount })}
                  </span>
                </span>
                <PickButton
                  added={added.has(purchaseReturn.id)}
                  loading={loading === purchaseReturn.id}
                  onClick={() => void pick(purchaseReturn.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

// One template for the header and every row on a wide card; below it each box shows its label
const EXPENSE_COLUMNS =
  '@3xl:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_7.5rem_2.25rem] @3xl:items-start @3xl:gap-2';

// The bill's expenses a debit note takes money off, by money only: a transport charge billed
// twice, a repair the supplier agreed to charge less for. Each names its bill expense, whose
// account, description and VAT rate it keeps. Shown only with a bill.
export function DebitNoteExpensesEditor({
  expenses,
  onChange,
  bill,
  pricesIncludeVat,
  errors,
}: {
  expenses: DebitNoteExpenseFormValues[];
  onChange: (expenses: DebitNoteExpenseFormValues[]) => void;
  bill: Bill;
  pricesIncludeVat: boolean;
  errors: DebitNoteExpensesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const rateText = useRateText();
  const [picking, setPicking] = useState(false);
  const billExpenses = new Map(bill.expenses.map((expense) => [expense.id, expense]));
  const money = (value: string) => format.money(value, { decimals: 2 });
  const listError = errors?.root?.message ?? errors?.message;

  const update = (index: number, amount: string) => {
    onChange(expenses.map((expense, at) => (at === index ? { ...expense, amount } : expense)));
  };
  const remove = (index: number) => {
    onChange(expenses.filter((_, at) => at !== index));
  };
  const add = (expense: BillExpense): boolean => {
    if (expenses.length >= MAX_BILL_EXPENSES) return false;
    onChange([...expenses, expenseToDebit(expense)]);
    return true;
  };

  // A value that is shown, not typed: its label hides on a wide card, like a box's
  const cell = (label: string, value: ReactNode, amount: boolean) => (
    <div className="grid content-start gap-1.5">
      <span className="text-label font-medium text-ink @3xl:sr-only">{label}</span>
      <span
        className={cn('py-2.5 text-body-sm tabular-nums', amount && 'font-medium @3xl:text-right')}
      >
        {value}
      </span>
    </div>
  );

  return (
    <Card className="@container grid grid-cols-1 overflow-hidden">
      <CardHeader
        title={t('debitNotes.expensesTitle')}
        subtitle={t('debitNotes.expensesSubtitle')}
      />
      {expenses.length > 0 && (
        <div
          aria-hidden="true"
          className={cn(
            'mt-3 hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            EXPENSE_COLUMNS,
          )}
        >
          <span>{t('salesLines.description')}</span>
          <span>{t('salesLines.vatRate')}</span>
          <span className="text-right">{t('debitNotes.expenseAmount')}</span>
          <span className="text-right">{t('salesLines.amount')}</span>
        </div>
      )}
      <div className={cn('grid grid-cols-1', expenses.length === 0 && 'mt-3')}>
        {expenses.map((expense, index) => {
          const source = billExpenses.get(expense.billExpenseId);
          if (!source) return null;
          const number = index + 1;
          const id = `expenses.${String(index)}.amount`;
          const expenseErrors = errors?.[index];
          const error = expenseErrors?.amount?.message ?? expenseErrors?.billExpenseId?.message;
          const amounts = draftExpenseAmounts(
            { amount: expense.amount, taxRateId: source.taxRate.id },
            source.taxRate.rate,
            pricesIncludeVat,
          );
          return (
            <div
              key={expense.billExpenseId}
              role="group"
              aria-label={t('salesLines.line', { number })}
              className={cn(
                'grid grid-cols-2 gap-3 border-t border-line px-5 py-4',
                EXPENSE_COLUMNS,
              )}
            >
              <div className="col-span-2 grid min-w-0 content-start gap-0.5 @3xl:col-span-1">
                <span className="flex items-start justify-between gap-3">
                  <span className="pt-2 text-body-sm text-ink">{source.description}</span>
                  <span className="@3xl:hidden">
                    <IconButton
                      icon={Delete02Icon}
                      label={t('debitNotes.removeExpense', { number })}
                      onClick={() => {
                        remove(index);
                      }}
                    />
                  </span>
                </span>
                <span className="text-caption text-ink-3 tabular-nums">
                  {t('debitNotes.leftToDebit', { amount: money(debitLeft(source)) })}
                </span>
              </div>
              {cell(
                t('salesLines.vatRate'),
                `${source.taxRate.name} · ${rateText(source.taxRate.rate)}`,
                false,
              )}
              <SalesField id={id} label={t('debitNotes.expenseAmount')} error={error}>
                <MoneyInput
                  id={id}
                  value={expense.amount}
                  invalid={error !== undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(value) => {
                    update(index, value);
                  }}
                />
              </SalesField>
              {cell(
                t('salesLines.amount'),
                amounts ? money(pricesIncludeVat ? amounts.total : amounts.net) : '—',
                true,
              )}
              <div className="hidden @3xl:block @3xl:pt-1">
                <IconButton
                  icon={Delete02Icon}
                  label={t('debitNotes.removeExpense', { number })}
                  onClick={() => {
                    remove(index);
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
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
          {t('debitNotes.addExpenses')}
        </Button>
      </div>
      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ExpensePicker
            bill={bill}
            onForm={new Set(expenses.map((expense) => expense.billExpenseId))}
            add={add}
          />
        )}
      </Dialog>
    </Card>
  );
}

// "Add bill expenses": the bill's expenses with money left to take off. Each click adds one with
// what is left of it.
function ExpensePicker({
  bill,
  onForm,
  add,
}: {
  bill: Bill;
  onForm: ReadonlySet<string>;
  add: (expense: BillExpense) => boolean;
}) {
  const { t, format } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  // What was on the form when the dialog opened: an expense added here stays in the list, marked
  const [open] = useState(() => debitableExpenses(bill.expenses, onForm));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  return (
    <DialogContent
      title={t('debitNotes.expensePickerTitle')}
      description={t('debitNotes.expensePickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {open.length === 0 ? (
          <EmptyState
            icon={InvoiceIcon}
            title={t('debitNotes.expensePickerEmpty')}
            description={t('debitNotes.expensePickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {open.map((expense) => (
              <li
                key={expense.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{expense.description}</span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {t('debitNotes.leftToDebit', {
                      amount: format.money(debitLeft(expense), { decimals: 2 }),
                    })}
                  </span>
                </span>
                <PickButton
                  added={added.has(expense.id)}
                  loading={false}
                  onClick={() => {
                    setProblem(null);
                    if (added.has(expense.id)) return;
                    if (add(expense)) setAdded((before) => new Set(before).add(expense.id));
                    else setProblem(t('salesLines.tooMany', { max: MAX_BILL_EXPENSES }));
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
