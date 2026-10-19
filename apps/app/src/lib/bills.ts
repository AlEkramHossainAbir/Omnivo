import {
  type Account,
  type Bill,
  billAmountDueOf,
  type BillExpense,
  type BillExpenseFormValues,
  type BillLineFormValues,
  type BillSummary,
  defaultLineDescription,
  type DocumentTotals,
  documentTotals,
  expenseLineAmounts,
  type GoodsReceiptLine,
  isMoneyAmount,
  isZeroQuantity,
  type LineAmounts,
  moneyAccountIds,
  plainQuantity,
  type PaymentAllocation,
  priceDifferenceOf,
  priceInUnit,
  prorateMoney,
  type PurchaseOrderLine,
  type SalesLineFormValues,
  type StockAccounts,
  sumMoney,
} from '@omnivo/contracts';

import { type AllocationRow, factorOf } from './invoices';
import {
  draftAmounts,
  formDiscount,
  isServiceLine,
  type LineMeta,
  SALES_LINE_FIELDS,
  salesItemOf,
  type SalesItem,
  toFormLine,
} from './sales';

// The pure parts of the supplier bill and supplier payment pages (step 17c), unit-tested in
// bills.spec.ts like lib/invoices.ts. A bill is the invoice's mirror (decision 15), so most of
// this is the invoice's helpers with a goods receipt where the invoice has a challan.

// ---------------------------------------------------------------------------------------------
// Where a bill line comes from

// What the form knows about a line that bills a goods receipt line or an order's service line, by
// that line's id. The form value holds only the id the API wants; the page needs the numbers to
// say "From GRN-2026-27-0007", the order's price setting to price the bill the same way, and what
// the goods receipt booked, to show the price difference (decision 8) before the bill is saved.
export interface BillLineOrigin {
  receiptNumber: string | null;
  orderNumber: string | null;
  // The order's "prices include VAT"; null when no order is behind the line
  pricesIncludeVat: boolean | null;
  // What the goods receipt booked the goods at, the order's price (decision 18); null for a
  // service, which no goods receipt booked
  orderValue: string | null;
}

// The goods receipt line or order line a bill line bills; null for a line of its own. The form's
// ids are '' or null when empty (the schema's input takes both).
export function billSourceIdOf(line: {
  receiptLineId?: string | null;
  orderLineId?: string | null;
}): string | null {
  const filled = (id: string | null | undefined) =>
    id === undefined || id === null || id === '' ? null : id;
  return filled(line.receiptLineId) ?? filled(line.orderLineId);
}

// How the lines that come from orders write their prices: true or false, or null when no line
// does. The API prices the bill the orders' way and refuses two ways at once (bill_vat_mixed).
export function billOrderPricing(
  lines: readonly { receiptLineId?: string | null; orderLineId?: string | null }[],
  origins: ReadonlyMap<string, BillLineOrigin>,
): boolean | null {
  for (const line of lines) {
    const id = billSourceIdOf(line);
    const setting = id === null ? null : (origins.get(id)?.pricesIncludeVat ?? null);
    if (setting !== null) return setting;
  }
  return null;
}

// What the goods receipt booked a line's goods at (17b): the order line's net shared by what was
// accepted, the API's own sum (goods-receipts.service.ts), so the form's difference is the one
// posting will book
export function receiptOrderValue(
  line: Pick<GoodsReceiptLine, 'baseQuantity'>,
  orderLine: Pick<PurchaseOrderLine, 'net' | 'baseQuantity'>,
): string {
  return prorateMoney(orderLine.net, line.baseQuantity, orderLine.baseQuantity);
}

// The fields a bill line has beside a sales line's, empty: a line of its own, an order's service
// line or a goods receipt line fill the ones they need
const NO_SOURCE = {
  receiptLineId: '',
  orderLineId: '',
  accountId: '',
  lotNumber: '',
  expiresOn: '',
  manufacturedOn: '',
  serialNumbers: [],
} satisfies Partial<BillLineFormValues>;

// A product added with "Add items": a line of its own. Posting the bill receives its goods into the
// bill's warehouse, or books its service to an expense account.
export function ownBillLine(line: SalesLineFormValues): BillLineFormValues {
  return { ...line, ...NO_SOURCE };
}

// A goods receipt line as a bill line. It bills the line whole (decision 4): the item, unit and
// quantity are the receipt's. The price, discount, VAT rate and description are the order's,
// moved to the receipt line's unit (an order of bags received in kg bills per kg), and an amount
// discount goes with the share of the order this receipt line carries, like an invoice line of a
// challan (15c). No order line known: an empty price, which the person types.
export function receiptLineToBill(
  line: GoodsReceiptLine,
  orderLine: PurchaseOrderLine | undefined,
): BillLineFormValues {
  const fixed = {
    ...NO_SOURCE,
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    receiptLineId: line.id,
  };
  if (orderLine === undefined) {
    return {
      ...fixed,
      description: '',
      unitPrice: '',
      discountType: 'percent',
      discount: '',
      taxRateId: '',
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

// A goods line from a goods receipt: always goods, with the receipt line's own item fields
export function itemOfReceiptLine(line: GoodsReceiptLine): SalesItem {
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

// The lines of a posted goods receipt a bill may still bill: accepted something (a line that
// turned everything back has nothing to bill, decision 43), not billed by a posted bill, and not on
// this form already
export function receiptLinesLeft(
  lines: readonly GoodsReceiptLine[],
  onForm: ReadonlySet<string>,
): GoodsReceiptLine[] {
  return lines.filter(
    (line) => !line.billed && !isZeroQuantity(line.baseQuantity) && !onForm.has(line.id),
  );
}

// An order's service line (a dyeing charge) as a bill line: billed whole, as it was ordered. Its
// account is left empty: Settings' "Purchased services" (decision 16), unless the person picks one.
export function orderServiceToBill(line: PurchaseOrderLine): BillLineFormValues {
  return { ...toFormLine(line), ...NO_SOURCE, orderLineId: line.id };
}

// The service lines of an order a bill may still bill. Its goods are billed through their goods
// receipts: only a receipt says they came (decision 22).
export function servicesLeft(
  lines: readonly PurchaseOrderLine[],
  onForm: ReadonlySet<string>,
): PurchaseOrderLine[] {
  return lines.filter(
    (line) => isServiceLine(line) && isZeroQuantity(line.billedQuantity) && !onForm.has(line.id),
  );
}

// The fields of a bill line the server may name in an error ("lines.2.receiptLineId"), each
// line's serial numbers apart
export const BILL_LINE_FIELDS = [
  ...SALES_LINE_FIELDS,
  'receiptLineId',
  'orderLineId',
  'accountId',
  'lotNumber',
  'expiresOn',
  'manufacturedOn',
  'serialNumbers',
] as const;

export const BILL_EXPENSE_FIELDS = ['accountId', 'description', 'amount', 'taxRateId'] as const;

// A draft bill, as the form holds it: its lines, the editor's meta, and where each billed line
// comes from. A goods receipt line goes back without its order line (the API reads it from the
// receipt line; the contract refuses both on one line) and without the receipt's lot.
export function savedBillLines(bill: Pick<Bill, 'supplier' | 'pricesIncludeVat' | 'lines'>): {
  values: BillLineFormValues[];
  meta: LineMeta[];
  origins: Map<string, BillLineOrigin>;
} {
  const origins = new Map<string, BillLineOrigin>();
  const values = bill.lines.map((line): BillLineFormValues => {
    const sourceId = line.receiptLineId ?? line.orderLineId;
    if (sourceId !== null) {
      origins.set(sourceId, {
        receiptNumber: line.receiptNumber,
        orderNumber: line.orderNumber,
        // A draft is priced the way its orders write prices (the API checked that)
        pricesIncludeVat: line.orderNumber === null ? null : bill.pricesIncludeVat,
        orderValue: line.orderValue,
      });
    }
    const own = sourceId === null;
    return {
      ...toFormLine(line),
      receiptLineId: line.receiptLineId ?? '',
      orderLineId: line.receiptLineId === null ? (line.orderLineId ?? '') : '',
      accountId: line.accountId ?? '',
      lotNumber: own ? (line.lotNumber ?? '') : '',
      expiresOn: own ? (line.expiresOn ?? '') : '',
      manufacturedOn: own ? (line.manufacturedOn ?? '') : '',
      serialNumbers: own ? line.serialNumbers : [],
    };
  });
  return {
    values,
    meta: bill.lines.map((line) => ({
      key: line.id,
      item: salesItemOf(line),
      source: undefined,
      pricedFor: bill.supplier.id,
    })),
    origins,
  };
}

// A saved expense as the form holds it: the amount as it was typed, without the trailing zeros
export function toFormExpense(expense: BillExpense): BillExpenseFormValues {
  return {
    accountId: expense.accountId,
    description: expense.description,
    amount: plainQuantity(expense.amount),
    taxRateId: expense.taxRate.id,
  };
}

// The accounts a service line or an expense may post to (decision 40), the API's own rule
// (bills.service.ts → checkCostAccounts): an active expense or asset account that is not a group,
// has no purpose (the payable, VAT, inventory, cost of goods sold), is not a stock account (goods
// in transit, goods received not billed) and does not hold money. `keep` stays in the list even when
// it no longer fits (a draft's account archived since), so the select shows it instead of silently
// moving to another. By code, like every account select.
export function costAccounts(
  accounts: readonly Account[],
  stock: StockAccounts | undefined,
  keep: readonly string[],
): Account[] {
  const money = moneyAccountIds(accounts);
  const stockIds = new Set([stock?.in_transit, stock?.received_not_billed]);
  return accounts
    .filter(
      (account) =>
        keep.includes(account.id) ||
        ((account.type === 'expense' || account.type === 'asset') &&
          !account.isGroup &&
          account.archivedAt === null &&
          account.purpose === null &&
          !money.has(account.id) &&
          !stockIds.has(account.id)),
    )
    .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------------------------
// What the bill adds up to while it is typed

// An expense's amounts, null until its boxes hold complete values
export function draftExpenseAmounts(
  expense: { amount: string; taxRateId: string },
  rate: string | null,
  pricesIncludeVat: boolean,
): LineAmounts | null {
  const amount = expense.amount.trim();
  if (rate === null || !isMoneyAmount(amount)) return null;
  return expenseLineAmounts({ amount, rate }, pricesIncludeVat);
}

// The bill's totals: its item lines and its expenses together, the documentTotals() the API
// stores (bills.ts says why an expense is worked out like a line of one unit)
export function billFormTotals(
  lines: readonly BillLineFormValues[],
  expenses: readonly { amount: string; taxRateId: string }[],
  rateOf: (taxRateId: string) => string | null,
  pricesIncludeVat: boolean,
): DocumentTotals {
  const amounts = [
    ...draftAmounts(lines, rateOf, pricesIncludeVat),
    ...expenses.map((expense) =>
      draftExpenseAmounts(expense, rateOf(expense.taxRateId), pricesIncludeVat),
    ),
  ];
  return documentTotals(amounts.filter((amount): amount is LineAmounts => amount !== null));
}

// What the receipt lines' prices differ from their orders by, together (decision 8): the sum of
// each line's net less what its goods receipt booked. A line still being typed counts as nothing.
export function formPriceDifference(
  lines: readonly BillLineFormValues[],
  origins: ReadonlyMap<string, BillLineOrigin>,
  rateOf: (taxRateId: string) => string | null,
  pricesIncludeVat: boolean,
): string {
  const amounts = draftAmounts(lines, rateOf, pricesIncludeVat);
  return sumMoney(
    lines.flatMap((line, index) => {
      const orderValue = origins.get(line.receiptLineId ?? '')?.orderValue ?? null;
      const amount = amounts[index];
      return orderValue === null || !amount ? [] : [priceDifferenceOf({ ...amount, orderValue })];
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Applying a payment's money

// The bills a payment can pay: the supplier's open ones, and those it already names (one paid in
// full meanwhile is not open any more, but it is still on the payment). The rows of the money
// receipt's table (allocationRows), with the supplier's own bill number under ours, the number
// their accountant asks about. The oldest due date first, the order the money goes in.
// `posted`: a posted payment's amounts are in the bills' amountPaid, so applying it again may put
// them back (what is still owed plus its own). A draft's are a plan that holds nothing (decision
// 23): a bill owes what it owes, and one the plan names that was paid in full since owes nothing,
// so posting the plan would be refused (payment_over_bill) and the row says why.
export function billAllocationRows(
  open: readonly BillSummary[],
  mine: readonly PaymentAllocation[],
  posted: boolean,
): AllocationRow[] {
  const own = new Map(mine.map((allocation) => [allocation.billId, allocation.amount]));
  const rows = new Map<string, AllocationRow>();
  for (const bill of open) {
    rows.set(bill.id, {
      id: bill.id,
      // An open bill is posted, so it has a number
      number: bill.number ?? '',
      detail: bill.supplierBillNumber,
      date: bill.date,
      dueDate: bill.dueDate,
      total: bill.total,
      due: posted
        ? sumMoney([billAmountDueOf(bill), own.get(bill.id) ?? '0'])
        : billAmountDueOf(bill),
    });
  }
  for (const allocation of mine) {
    if (rows.has(allocation.billId)) continue;
    rows.set(allocation.billId, {
      id: allocation.billId,
      number: allocation.billNumber,
      detail: allocation.supplierBillNumber,
      date: allocation.billDate,
      dueDate: allocation.dueDate,
      total: allocation.billTotal,
      due: posted ? allocation.amount : '0.0000',
    });
  }
  return [...rows.values()].toSorted(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.date.localeCompare(b.date) ||
      a.number.localeCompare(b.number),
  );
}
