import {
  compareMoney,
  defaultLineDescription,
  type DeliveryLine,
  type Invoice,
  type InvoiceLineFormValues,
  type InvoiceSummary,
  isMoneyAmount,
  isZeroMoney,
  isZeroQuantity,
  plainQuantity,
  priceInUnit,
  type PriceLookupItem,
  prorateMoney,
  type ReceiptAllocation,
  type SalesOrderLine,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';

import {
  formDiscount,
  isServiceLine,
  type LineMeta,
  type SalesItem,
  savedLines,
  toFormLine,
} from './sales';
import { daysUntil } from './stock';

// The pure parts of the invoice and money receipt pages (step 15c), unit-tested in
// invoices.spec.ts like lib/sales.ts.

// ---------------------------------------------------------------------------------------------
// Where an invoice line comes from

// What the form knows about a line that bills a challan line or an order's service line, by that
// line's id. The form value holds only the id the API wants; the page needs the numbers to say
// "From DC-2026-27-0042", and the order's price setting to price the invoice the same way.
export interface LineOrigin {
  deliveryNumber: string | null;
  orderNumber: string | null;
  // The order's "prices include VAT"; null when no order is behind the line
  pricesIncludeVat: boolean | null;
}

// The challan line or order line a line bills; null for a line of its own. The form's ids are ''
// or null when empty (the schema's input takes both).
export function sourceIdOf(line: {
  deliveryLineId?: string | null;
  orderLineId?: string | null;
}): string | null {
  const filled = (id: string | null | undefined) =>
    id === undefined || id === null || id === '' ? null : id;
  return filled(line.deliveryLineId) ?? filled(line.orderLineId);
}

// How the lines that come from orders write their prices: true or false, or null when no line
// does. The API prices the invoice the orders' way and refuses two ways at once
// (invoice_vat_mixed), so the form takes the same answer.
export function orderPricing(
  lines: readonly { deliveryLineId?: string | null; orderLineId?: string | null }[],
  origins: ReadonlyMap<string, LineOrigin>,
): boolean | null {
  for (const line of lines) {
    const id = sourceIdOf(line);
    const setting = id === null ? null : (origins.get(id)?.pricesIncludeVat ?? null);
    if (setting !== null) return setting;
  }
  return null;
}

// A goods line from a challan: always goods, with the challan line's own item fields
export function itemOfDeliveryLine(line: DeliveryLine): SalesItem {
  return {
    variantId: line.variantId,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    optionValues: line.optionValues,
    sku: line.sku,
    baseUnitId: line.baseUnitId,
    units: line.units,
    productType: 'goods',
    tracking: line.tracking,
    hasExpiry: line.hasExpiry,
  };
}

// A unit's size in the base unit, from the product's packs: "1" for the base unit itself
function factorOf(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  unitId: string,
): string {
  if (unitId === item.baseUnitId) return '1';
  const pack = item.units.find((unit) => unit.unitId === unitId);
  if (pack === undefined) throw new Error(`The product has no unit ${unitId}`);
  return pack.factor;
}

// A challan line as an invoice line. It bills the line whole: the item, unit and quantity are the
// challan's. With an order behind it, the price, discount, VAT rate and description are the
// order's, moved to the challan's unit (an order of cases delivered by the piece bills ৳21 a
// piece, not ৳504), and an amount discount goes with the share of the order this challan line
// carries. Without an order, the price lookup's price for this customer, as on a new order line.
export function challanLineToInvoice(
  line: DeliveryLine,
  orderLine: SalesOrderLine | undefined,
  price: PriceLookupItem | undefined,
): InvoiceLineFormValues {
  const fixed = {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    deliveryLineId: line.id,
    // The API reads the order line from the challan line; the contract refuses both on one line
    orderLineId: '',
    // The goods left with their own batch and serial numbers, on the challan
    batchId: '',
    serialNumbers: [],
  };
  if (orderLine === undefined) {
    return {
      ...fixed,
      description: '',
      unitPrice: price?.price ?? '',
      discountType: 'percent',
      discount: '',
      taxRateId: price?.taxRateId ?? '',
    };
  }
  const discount =
    orderLine.discountType === 'percent'
      ? orderLine.discount
      : prorateMoney(orderLine.discount, line.baseQuantity, orderLine.baseQuantity);
  return {
    ...fixed,
    description:
      orderLine.description === defaultLineDescription(orderLine) ? '' : orderLine.description,
    unitPrice: priceInUnit(
      orderLine.unitPrice,
      factorOf(line, orderLine.unitId),
      factorOf(line, line.unitId),
    ),
    discountType: orderLine.discountType,
    discount: formDiscount(discount),
    taxRateId: orderLine.taxRate.id,
  };
}

// An order's service line (a delivery charge) as an invoice line: billed whole, as it was sold
export function orderChargeToInvoice(line: SalesOrderLine): InvoiceLineFormValues {
  return {
    ...toFormLine(line),
    deliveryLineId: '',
    orderLineId: line.id,
    batchId: '',
    serialNumbers: [],
  };
}

// The lines of a challan an invoice may still bill: not billed by a posted invoice, and not on
// this form already
export function challanLinesLeft(
  lines: readonly DeliveryLine[],
  onForm: ReadonlySet<string>,
): DeliveryLine[] {
  return lines.filter((line) => !line.invoiced && !onForm.has(line.id));
}

// The service lines of an order an invoice may still bill. A goods line is billed through its
// challan: only the challan says the goods left.
export function chargesLeft(
  lines: readonly SalesOrderLine[],
  onForm: ReadonlySet<string>,
): SalesOrderLine[] {
  return lines.filter(
    (line) => isServiceLine(line) && isZeroQuantity(line.invoicedQuantity) && !onForm.has(line.id),
  );
}

// A draft invoice, as the form holds it: its lines, the editor's meta, and where each billed line
// comes from. A challan line goes back without its order line and without the challan's batch
// (the API sent them for the page and the print; the contract refuses them on such a line).
export function savedInvoiceLines(
  invoice: Pick<Invoice, 'customer' | 'pricesIncludeVat' | 'lines'>,
): {
  values: InvoiceLineFormValues[];
  meta: LineMeta[];
  origins: Map<string, LineOrigin>;
} {
  const origins = new Map<string, LineOrigin>();
  const values = invoice.lines.map((line): InvoiceLineFormValues => {
    const billed = line.deliveryLineId !== null || line.orderLineId !== null;
    const sourceId = line.deliveryLineId ?? line.orderLineId;
    if (sourceId !== null) {
      origins.set(sourceId, {
        deliveryNumber: line.deliveryNumber,
        orderNumber: line.orderNumber,
        // A draft is priced the way its orders write prices (the API checked that)
        pricesIncludeVat: line.orderNumber === null ? null : invoice.pricesIncludeVat,
      });
    }
    return {
      ...toFormLine(line),
      deliveryLineId: line.deliveryLineId ?? '',
      orderLineId: line.deliveryLineId === null ? (line.orderLineId ?? '') : '',
      batchId: billed ? '' : (line.batchId ?? ''),
      serialNumbers: billed ? [] : line.serialNumbers,
    };
  });
  return { values, meta: savedLines(invoice.lines, invoice.customer.id).meta, origins };
}

// ---------------------------------------------------------------------------------------------
// What is owed

// What an invoice still asks for
export function amountDue(invoice: { total: string; amountPaid: string }): string {
  return subtractMoney(invoice.total, invoice.amountPaid);
}

// How many days past its due date an invoice is (0 on the due date itself)
export function daysLate(dueDate: string, today: string): number {
  return Math.max(0, -daysUntil(dueDate, today));
}

// ---------------------------------------------------------------------------------------------
// Applying a receipt's money

// One invoice the money can go to. `due` is what this receipt may put on it: what the invoice still
// owes, plus what this receipt already put there (applying it again replaces its own amounts).
export interface AllocationRow {
  invoiceId: string;
  number: string;
  date: string;
  dueDate: string;
  total: string;
  due: string;
}

// The invoices a receipt can pay: the customer's open ones, and those it already pays (one it paid
// in full is not open any more, but it is still on the receipt). The oldest due date first, the
// order the money goes in.
export function allocationRows(
  open: readonly InvoiceSummary[],
  mine: readonly ReceiptAllocation[],
): AllocationRow[] {
  const own = new Map(mine.map((allocation) => [allocation.invoiceId, allocation.amount]));
  const rows = new Map<string, AllocationRow>();
  for (const invoice of open) {
    rows.set(invoice.id, {
      invoiceId: invoice.id,
      // An open invoice is posted, so it has a number
      number: invoice.number ?? '',
      date: invoice.date,
      dueDate: invoice.dueDate,
      total: invoice.total,
      due: sumMoney([amountDue(invoice), own.get(invoice.id) ?? '0']),
    });
  }
  for (const allocation of mine) {
    if (rows.has(allocation.invoiceId)) continue;
    // Paid in full, partly by this receipt: what it may hold is what it holds now
    rows.set(allocation.invoiceId, {
      invoiceId: allocation.invoiceId,
      number: allocation.invoiceNumber,
      date: allocation.invoiceDate,
      dueDate: allocation.dueDate,
      total: allocation.invoiceTotal,
      due: allocation.amount,
    });
  }
  return [...rows.values()].toSorted(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.date.localeCompare(b.date) ||
      a.number.localeCompare(b.number),
  );
}

// "Apply oldest first": the amount over the rows in their order, each taking what it still owes
// until the money runs out. What is left after the last row stays as an advance. Nothing while
// the amount box does not hold an amount.
export function suggestAllocations(
  amount: string,
  rows: readonly AllocationRow[],
): { invoiceId: string; amount: string }[] {
  if (!isMoneyAmount(amount.trim())) return [];
  let left = amount.trim();
  const allocations: { invoiceId: string; amount: string }[] = [];
  for (const row of rows) {
    if (compareMoney(left, '0') <= 0) break;
    const take = compareMoney(left, row.due) < 0 ? left : row.due;
    if (isZeroMoney(take)) continue;
    allocations.push({ invoiceId: row.invoiceId, amount: plainQuantity(take) });
    left = subtractMoney(left, take);
  }
  return allocations;
}

// What the boxes add up to, counting only those that hold an amount (one being typed counts as
// nothing, so the line under the table never throws)
export function appliedOf(allocations: readonly { amount: string }[]): string {
  return sumMoney(
    allocations
      .map((allocation) => allocation.amount.trim())
      .filter((value) => isMoneyAmount(value)),
  );
}
