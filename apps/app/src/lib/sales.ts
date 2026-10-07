import {
  compareQuantity,
  defaultLineDescription,
  type DocumentTotals,
  documentTotals,
  draftLineAmounts,
  isZeroMoney,
  isZeroQuantity,
  type LineAmounts,
  plainQuantity,
  type PriceSource,
  type SalesLine,
  type SalesLineFormValues,
  type SalesOrderLine,
  subtractQuantity,
  sumQuantity,
} from '@omnivo/contracts';

// The pure parts of the sales pages: no React, so they are unit-tested (sales.spec.ts) and shared
// by the forms and the views. The line editor's helpers live here too, not in
// sales-line-editor.tsx: the forms need them at once, and the editor is a lazy chunk of its own.

// A saved discount comes back as "10.0000". The box takes at most 2 decimals (contracts' DISCOUNT),
// so it gets "10"; no discount at all is an empty box, not "0", on every line.
export function formDiscount(value: string): string {
  return isZeroMoney(value) ? '' : plainQuantity(value);
}

// An open quotation whose offer has ended. Not a status: nothing changes in the database when the
// date passes, and the customer may still accept it. ISO dates compare as strings.
export function isExpired(
  quotation: { status: string; validUntil: string | null },
  today: string,
): boolean {
  return (
    quotation.status === 'open' && quotation.validUntil !== null && quotation.validUntil < today
  );
}

// A confirmed order whose delivery date has passed: attention, not a status
export function isLate(
  order: { status: string; deliveryDate: string | null },
  today: string,
): boolean {
  return order.status === 'confirmed' && order.deliveryDate !== null && order.deliveryDate < today;
}

// A service line (a delivery charge) is sold but never delivered
export function isServiceLine(line: { productType: string }): boolean {
  return line.productType === 'service';
}

// What an order line still has to deliver, in the base unit. A service line has nothing to deliver;
// a line delivered in full has nothing left, never less than nothing.
export function leftToDeliver(line: SalesOrderLine): string {
  if (isServiceLine(line)) return '0.0000';
  const left = subtractQuantity(line.baseQuantity, line.deliveredQuantity);
  return compareQuantity(left, '0') > 0 ? left : '0.0000';
}

// A delivery line made from an order line: what it sends to the API
export interface FillLine {
  orderLineId: string;
  variantId: string;
  unitId: string;
  quantity: string;
}

// "Add what is left on the order": one line per goods line that still has something to deliver,
// minus what the form already holds for it (`onForm`: base quantities by order line). A line
// nothing went out for yet keeps the order's unit and quantity (3 case); a partly delivered one
// asks for the rest in the base unit (24 pcs), because the rest is rarely whole cases.
export function fillFromOrder(
  lines: readonly SalesOrderLine[],
  onForm: ReadonlyMap<string, string>,
): FillLine[] {
  return lines.flatMap((line) => {
    const already = onForm.get(line.id) ?? '0';
    const left = subtractQuantity(leftToDeliver(line), already);
    if (compareQuantity(left, '0') <= 0) return [];
    const untouched = isZeroQuantity(line.deliveredQuantity) && isZeroQuantity(already);
    return [
      {
        orderLineId: line.id,
        variantId: line.variantId,
        unitId: untouched ? line.unitId : line.baseUnitId,
        quantity: untouched ? plainQuantity(line.quantity) : plainQuantity(left),
      },
    ];
  });
}

// The base quantities a form holds per order line, from each line's base quantity (null while a
// line's quantity is not a quantity yet: it counts as nothing)
export function baseByOrderLine(
  lines: readonly { orderLineId: string; base: string | null }[],
): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of lines) {
    if (line.orderLineId === '' || line.base === null) continue;
    sums.set(line.orderLineId, sumQuantity([sums.get(line.orderLineId) ?? '0', line.base]));
  }
  return sums;
}

// What a form's lines are worth while they are typed: each line's amounts (null until its boxes
// hold complete values) and the totals of the complete ones. The same contracts functions the API
// stores with, so the form shows the saved total to the paisa.
export function formTotals(
  lines: readonly SalesLineFormValues[],
  rateOf: (taxRateId: string) => string | null,
  pricesIncludeVat: boolean,
): { amounts: (LineAmounts | null)[]; totals: DocumentTotals } {
  const amounts = lines.map((line) =>
    draftLineAmounts(line, rateOf(line.taxRateId), pricesIncludeVat),
  );
  return {
    amounts,
    totals: documentTotals(amounts.filter((amount): amount is LineAmounts => amount !== null)),
  };
}

// ---------------------------------------------------------------------------------------------
// The line editor's data

// What a line needs to know about its product, beside what the form sends
export type SalesItem = Pick<
  SalesLine,
  | 'variantId'
  | 'productId'
  | 'productCode'
  | 'productName'
  | 'optionValues'
  | 'sku'
  | 'baseUnitId'
  | 'units'
  | 'productType'
>;

// What the editor keeps per line, beside the form value, at the same index
export interface LineMeta {
  // React's key: stays with the line when a line above it is removed
  key: string;
  item: SalesItem;
  // Where a new line's price came from (the price lookup). undefined for a saved line: nothing new
  // to say about it.
  source: PriceSource | null | undefined;
  // The customer the price was looked up for ('' = none chosen yet). When the form's customer is
  // another one, the editor offers to reprice.
  pricedFor: string;
}

// The fields of a line the server may name in an error ("lines.3.unitPrice"); each form adds
// them to its own list for applyApiError
export const SALES_LINE_FIELDS = [
  'variantId',
  'unitId',
  'quantity',
  'description',
  'unitPrice',
  'discount',
  'taxRateId',
] as const;

function salesItemOf(line: SalesLine): SalesItem {
  return {
    variantId: line.variantId,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    optionValues: line.optionValues,
    sku: line.sku,
    baseUnitId: line.baseUnitId,
    units: line.units,
    productType: line.productType,
  };
}

// A saved line, as the form holds it. A description that is just the product's name is shown as
// an empty box (with the name as its placeholder), so the next save keeps following the product.
export function toFormLine(line: SalesLine): SalesLineFormValues {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: formDiscount(line.discount),
    taxRateId: line.taxRate.id,
  };
}

// The form's starting lines and the editor's meta for a saved document (or the quotation an order
// is made from)
export function savedLines(
  lines: readonly SalesLine[],
  customerId: string,
): { values: SalesLineFormValues[]; meta: LineMeta[] } {
  return {
    values: lines.map(toFormLine),
    meta: lines.map((line) => ({
      key: line.id,
      item: salesItemOf(line),
      source: undefined,
      pricedFor: customerId,
    })),
  };
}
