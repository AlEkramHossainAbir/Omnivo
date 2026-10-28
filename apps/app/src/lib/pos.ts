import {
  compareMoney,
  compareQuantity,
  type DiscountType,
  isMoneyAmount,
  isQuantity,
  type PosLineAmounts,
  type PosOverride,
  posOverridesOf,
  type PosPaperWidth,
  type PosPaymentMethod,
  posSaleAmounts,
  type PosSaleFormValues,
  type PosSaleTotals,
  type Product,
  type ProductVariant,
  subtractMoney,
  sumMoney,
  sumQuantity,
  type SyncPosRegister,
  type SyncStock,
  toBaseQuantity,
} from '@omnivo/contracts';

// Step 20a: the POS screen's cart, worked out without React, so the rules are tested on their own
// (pos.spec.ts). The screen keeps one Cart in state and changes it only through these functions.

// One line of the cart. Everything the receipt and the sale need is copied in when the line is
// added (the product may change in the copy while the cart is open; the line keeps what the
// cashier saw).
export interface CartLine {
  // For React and for picking a line; never sent
  key: string;
  productId: string;
  variantId: string;
  // The base unit, the product's sales unit or the pack a barcode named, and its size in the base
  // unit ("1", "10"): stock is counted in base units
  unitId: string;
  factor: string;
  name: string;
  sku: string;
  unitCode: string;
  // The unit's decimals (0 for pcs, 3 for kg): quantities show with them
  decimals: number;
  // 'none' | 'batch' | 'serial' (a string in the contract, so a newer server's mode does not break)
  tracking: string;
  // A service has no stock: no check, no batch
  goods: boolean;
  // As the cashier types them: they may be half typed ("1.") until the sale is paid
  quantity: string;
  // '' while there is no price (a product without one); the cashier types it
  unitPrice: string;
  // The price the line started with (posOverridesOf); null = there was none
  startingPrice: string | null;
  discountType: DiscountType;
  discount: string;
  taxRateId: string;
  // The rate in percent ("15.00"), kept with the line: the receipt is printed with it
  rate: string;
  batchId: string | null;
  serialNumbers: string[];
}

export interface CartCustomer {
  id: string;
  name: string;
  priceListId: string | null;
}

export interface Cart {
  // null = walk-in
  customer: CartCustomer | null;
  lines: CartLine[];
  billDiscountType: DiscountType;
  billDiscount: string;
}

export const EMPTY_CART: Cart = {
  customer: null,
  lines: [],
  billDiscountType: 'amount',
  billDiscount: '',
};

let lineKeys = 0;

// A counter, not crypto.randomUUID(): a key only has to be unique on this screen
export function newLineKey(): string {
  lineKeys += 1;
  return `line-${String(lineKeys)}`;
}

// "Polo shirt — M, Navy blue", like the sales documents' line (description null)
export function itemName(product: Pick<Product, 'name'>, variant: ProductVariant): string {
  return variant.optionValues.length === 0
    ? product.name
    : `${product.name} — ${variant.optionValues.join(', ')}`;
}

// A value still being typed counts as 0 in the totals. The arithmetic of the contracts throws on
// "1." or "", and the totals are worked out on every key press.
function money(value: string): string {
  return isMoneyAmount(value) ? value : '0';
}

function quantity(value: string): string {
  return isQuantity(value) ? value : '0';
}

// A scan of the same item again adds one to its line, the way a cashier expects. A serial item
// never merges: each scan is another serial number, and the line of serials is filled by the
// scanner (pos-cart.tsx). Nor does a line whose price or discount the cashier changed: the new one
// starts from the price again.
export function addToCart(cart: Cart, line: CartLine): Cart {
  const same = cart.lines.find(
    (other) =>
      other.tracking !== 'serial' &&
      other.variantId === line.variantId &&
      other.unitId === line.unitId &&
      other.batchId === line.batchId &&
      other.unitPrice === line.unitPrice &&
      money(other.discount) === '0',
  );
  if (!same || line.tracking === 'serial') return { ...cart, lines: [...cart.lines, line] };
  return changeLine(cart, same.key, {
    quantity: sumQuantity([quantity(same.quantity), quantity(line.quantity)]),
  });
}

export function changeLine(cart: Cart, key: string, change: Partial<CartLine>): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) => (line.key === key ? { ...line, ...change } : line)),
  };
}

export function removeLine(cart: Cart, key: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.key !== key) };
}

export interface CartAmounts {
  lines: PosLineAmounts[];
  totals: PosSaleTotals;
}

// The same arithmetic the server runs (posSaleAmounts in the contracts), so the screen's total is
// the receipt's and the books'
export function cartAmounts(cart: Cart, pricesIncludeVat: boolean): CartAmounts {
  return posSaleAmounts(
    cart.lines.map((line) => ({
      quantity: quantity(line.quantity),
      unitPrice: money(line.unitPrice),
      discountType: line.discountType,
      discount: money(line.discount),
      rate: line.rate,
    })),
    { type: cart.billDiscountType, value: money(cart.billDiscount) },
    pricesIncludeVat,
  );
}

// The line's quantity in the base unit, as the stock counts it
export function baseQuantity(line: Pick<CartLine, 'quantity' | 'factor'>): string {
  return toBaseQuantity(quantity(line.quantity), line.factor, 4);
}

// A line ready to sell: a quantity above 0, a price, and for a serial item one serial number per
// base unit (the server refuses anything else: stock_serial_count). Pay waits for every line.
export function lineReady(line: CartLine): boolean {
  if (!isQuantity(line.quantity) || !isMoneyAmount(line.unitPrice)) return false;
  return (
    line.tracking !== 'serial' ||
    compareQuantity(baseQuantity(line), String(line.serialNumbers.length)) === 0
  );
}

// What a variant has in the warehouse, every batch together, in the base unit
export function onHandOf(stock: readonly SyncStock[], variantId: string): string {
  return sumQuantity(stock.filter((row) => row.variantId === variantId).map((row) => row.quantity));
}

// Decision 7: when the workspace does not sell below zero, the screen stops a sale the copy says
// the warehouse cannot fill. Per variant, over all its lines (two lines of rice take from the same
// sacks). Every batch counts: the server takes the other batches when the line's own is short.
// The answer is per line: what the warehouse has of that line's variant.
export function shortLines(
  cart: Cart,
  stock: readonly SyncStock[],
  allowNegativeStock: boolean,
): Map<string, string> {
  const short = new Map<string, string>();
  if (allowNegativeStock) return short;
  const goods = cart.lines.filter((line) => line.goods);
  for (const variantId of new Set(goods.map((line) => line.variantId))) {
    const lines = goods.filter((line) => line.variantId === variantId);
    const wanted = sumQuantity(lines.map(baseQuantity));
    const onHand = onHandOf(stock, variantId);
    if (compareQuantity(wanted, onHand) > 0) {
      for (const line of lines) short.set(line.key, onHand);
    }
  }
  return short;
}

// Decision 11: what the cashier did that needs pos.price.override, worked out like the server's
// audit. Someone with the permission may; for everyone else the screen says it at the box and the
// Pay button waits.
export function overridesOf(
  cart: Cart,
  register: Pick<SyncPosRegister, 'maxDiscountPercent'>,
): PosOverride[] {
  return posOverridesOf(
    {
      lines: cart.lines.map((line) => ({
        quantity: quantity(line.quantity),
        unitPrice: money(line.unitPrice),
        discountType: line.discountType,
        discount: money(line.discount),
        startingPrice: line.startingPrice,
      })),
      billDiscountType: cart.billDiscountType,
      billDiscount: money(cart.billDiscount),
    },
    register.maxDiscountPercent,
  );
}

// The batch a line of a batch product takes: first expiry first (FEFO), among the batches with
// stock that have not expired. With none, a workspace that sells below zero still needs a batch
// (the server refuses a batch line without one): the one that expires last, so the shortfall lands
// on the freshest stock to come. null = this warehouse never had a batch of it.
export function fefoBatch(
  rows: readonly SyncStock[],
  today: string,
  allowNegativeStock: boolean,
): string | null {
  const batches = rows.filter(
    (row): row is SyncStock & { batchId: string } =>
      row.batchId !== null && (row.expiresOn === null || row.expiresOn >= today),
  );
  // No expiry date sorts after every date: '9' is after any ISO date
  const expiry = (row: SyncStock) => row.expiresOn ?? '9';
  const order = [...batches].sort(
    (a, b) =>
      expiry(a).localeCompare(expiry(b)) || (a.lotNumber ?? '').localeCompare(b.lotNumber ?? ''),
  );
  const inStock = order.find((row) => compareQuantity(row.quantity, '0') > 0);
  if (inStock) return inStock.batchId;
  return allowNegativeStock ? (order.at(-1)?.batchId ?? null) : null;
}

export interface PaymentRow {
  // For React; never sent
  key: string;
  method: PosPaymentMethod;
  amount: string;
  reference: string;
}

// What is still to pay after the rows typed so far ('0' once the total is covered)
export function dueOf(payments: readonly PaymentRow[], total: string): string {
  const due = subtractMoney(total, sumMoney(payments.map((row) => money(row.amount))));
  return compareMoney(due, '0') > 0 ? due : '0.0000';
}

// The notes a customer may hand over for this total, for the cash chips: the next ৳10, ৳50, ৳100,
// ৳500 and ৳1,000 above it, without repeats and without the exact total (it has its own button).
// In whole taka: a note is never ৳0.50.
export function quickCash(total: string): string[] {
  const whole = BigInt(money(total).split('.')[0] ?? '0');
  const amounts = [10n, 50n, 100n, 500n, 1000n].map((note) => (whole / note + 1n) * note);
  return [...new Set(amounts)]
    .filter((amount) => compareMoney(String(amount), total) > 0)
    .slice(0, 4)
    .map(String);
}

// The sale as posSaleInputSchema reads it. The form values (z.input): the schema trims, checks and
// turns '' into null, and the screen saves its output only (pos-pay.tsx).
export function saleValues(input: {
  cart: Cart;
  registerId: string;
  date: string;
  soldAt: string;
  pricesIncludeVat: boolean;
  payments: readonly PaymentRow[];
}): Omit<PosSaleFormValues, 'sequence'> {
  const { cart } = input;
  return {
    registerId: input.registerId,
    date: input.date,
    soldAt: input.soldAt,
    customerId: cart.customer?.id ?? null,
    pricesIncludeVat: input.pricesIncludeVat,
    lines: cart.lines.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      description: null,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: line.discount,
      taxRateId: line.taxRateId,
      rate: line.rate,
      startingPrice: line.startingPrice,
      batchId: line.batchId,
      serialNumbers: line.serialNumbers,
    })),
    billDiscountType: cart.billDiscountType,
    billDiscount: cart.billDiscount,
    payments: input.payments.map((row) => ({
      method: row.method,
      amount: row.amount,
      reference: row.reference,
    })),
  };
}

// What a receipt prints, from either side: the sale just paid on the screen (pos-screen.tsx) or a
// posted sale from the server, printed again from its page (pos-sale.tsx). Both fill this, so the
// two print the same paper.
export interface ReceiptLine {
  key: string;
  name: string;
  quantity: string;
  // The unit's decimals and code: "1.250 kg"
  decimals: number;
  unitCode: string;
  unitPrice: string;
  // The line's own discount in taka, and the line after it, in the price as typed
  discount: string;
  after: string;
}

export interface ReceiptData {
  number: string;
  soldAt: string;
  registerCode: string;
  paperWidth: PosPaperWidth;
  receiptFooter: string | null;
  cashier: string;
  // null = walk-in
  customerName: string | null;
  lines: ReceiptLine[];
  pricesIncludeVat: boolean;
  billDiscount: string;
  net: string;
  vat: string;
  total: string;
  payments: { method: PosPaymentMethod; amount: string; reference: string | null }[];
  paid: string;
  change: string;
}

// The company at the top, like useCompany() in print-documents.tsx: its legal name or the
// workspace's, the address one line per line, the BIN and the phone. From the device's copy of
// the settings on the screen (it works offline), from the server's on the sale's page.
export interface ReceiptCompany {
  name: string;
  lines: string[];
  timeZone: string;
}

// The receipt of the sale just paid, from the cart as it was paid (the pay dialog). A line's
// discount and its amount after it come from the same arithmetic as the saved sale.
export function receiptOfCart(input: {
  number: string;
  soldAt: string;
  register: Pick<SyncPosRegister, 'code' | 'paperWidth' | 'receiptFooter'>;
  cashier: string;
  cart: Cart;
  pricesIncludeVat: boolean;
  payments: ReceiptData['payments'];
  paid: string;
  change: string;
}): ReceiptData {
  const { cart, register } = input;
  const amounts = cartAmounts(cart, input.pricesIncludeVat);
  return {
    number: input.number,
    soldAt: input.soldAt,
    registerCode: register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: input.cashier,
    customerName: cart.customer?.name ?? null,
    lines: cart.lines.map((line, index) => {
      const amount = amounts.lines[index];
      return {
        key: line.key,
        name: line.name,
        quantity: line.quantity,
        decimals: line.decimals,
        unitCode: line.unitCode,
        unitPrice: line.unitPrice,
        discount: amount?.discount ?? '0',
        after: amount ? subtractMoney(amount.gross, amount.discount) : '0',
      };
    }),
    pricesIncludeVat: input.pricesIncludeVat,
    billDiscount: amounts.totals.billDiscount,
    net: amounts.totals.net,
    vat: amounts.totals.vat,
    total: amounts.totals.total,
    payments: input.payments,
    paid: input.paid,
    change: input.change,
  };
}
