import {
  addMoney,
  addQuantity,
  compareQuantity,
  defaultLineDescription,
  defaultNumberFormat,
  type Delivery,
  type DeliveryInput,
  documentTotals,
  type DocumentType,
  type ErrorCode,
  fitsDecimals,
  formatDocumentNumber,
  isZeroQuantity,
  type LineAmounts,
  lineAmounts,
  negateMoney,
  type PartyRef,
  periodOf,
  type PriceLookup,
  type PriceLookupInput,
  type PriceLookupItem,
  type Quotation,
  type QuotationInput,
  type SalesLine,
  type SalesLineInput,
  type SalesOrder,
  type SalesOrderInput,
  type StockLine,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  todayIn,
} from '@omnivo/contracts';

import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  assertDate,
  assertWarehouses,
  branchOf,
  decimalsOf,
  findVariant,
  issuesError,
  postMoves,
  refOf,
  resolveLines,
} from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15b: quotations, sales orders, deliveries, and the price a new line starts with.
// The API's rules (quotations.service.ts, sales-orders.service.ts, deliveries.service.ts,
// price-lookup.service.ts) on plain arrays, shortened, so `pnpm dev:mock` and the e2e tests walk
// the same paths as the real API. The line arithmetic is contracts' lineAmounts(): the same
// function the form and the API use, so the mock's totals match theirs to the paisa.

// A quotation as stored: the order that accepted it is looked up on read
export type MockQuotation = Omit<Quotation, 'order'>;

// An order as stored, with the quotation it was made from. "Partly delivered" and the order's
// deliveries are worked out on read, like the API's subqueries, so a posted delivery shows at once.
export type MockOrder = Omit<SalesOrder, 'partlyDelivered' | 'quotation' | 'deliveries'> & {
  quotationId: string | null;
};

// A delivery as stored, with its order's id: the order's number is looked up on read
export type MockDelivery = Omit<Delivery, 'order'> & { orderId: string | null };

export interface MockSalesDocuments {
  quotations: MockQuotation[];
  orders: MockOrder[];
  deliveries: MockDelivery[];
  // The last number given from each series. One counter per series, like the mock's stock
  // documents; the API starts again each fiscal year.
  counters: { quotation: number; order: number; delivery: number };
}

export function emptySalesDocuments(): MockSalesDocuments {
  return {
    quotations: [],
    orders: [],
    deliveries: [],
    counters: { quotation: 0, order: 0, delivery: 0 },
  };
}

function now(): string {
  return new Date().toISOString();
}

function fieldProblem(code: ErrorCode, field: string): MockProblem {
  return new MockProblem(409, code, { [field]: [code] });
}

// The mock's cursor is an offset, like its other lists
export function pageOf<T>(
  all: readonly T[],
  query: { cursor?: string | undefined; limit: number },
): { items: T[]; nextCursor: string | null } {
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const items = all.slice(start, start + query.limit);
  const end = start + items.length;
  return { items, nextCursor: end < all.length ? String(end) : null };
}

// Newest date first, like the API. Two documents of one day keep the array's order: a new one is
// put first, so it comes first, like the API's uuidv7 ids.
function newestFirst<T extends { date: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => b.date.localeCompare(a.date));
}

type Series = keyof MockSalesDocuments['counters'];

const SERIES = {
  quotation: 'sales.quotation',
  order: 'sales.order',
  delivery: 'sales.delivery',
} as const satisfies Record<Series, DocumentType>;

// The next number of a series, in the format saved on the Numbering page (or the default one)
function nextNumber(data: WorkspaceData, series: Series, date: string): string {
  const type = SERIES[series];
  const format = data.series.get(type) ?? defaultNumberFormat(type);
  data.salesDocuments.counters[series] += 1;
  return formatDocumentNumber(
    format,
    periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth),
    data.salesDocuments.counters[series],
  );
}

// --- What every sales document checks -----------------------------------------------------------

// An active customer. A draft keeps its customer (keptId) even after the customer is archived,
// like the API's assertCustomer(), so the person can still finish it.
function customerOf(data: WorkspaceData, customerId: string, keptId: string | null): PartyRef {
  const found = data.sales.customers.find((item) => item.id === customerId);
  if (!found || (found.archivedAt !== null && found.id !== keptId)) {
    throw fieldProblem('sales_customer_invalid', 'customerId');
  }
  return { id: found.id, code: found.code, name: found.name };
}

// One of the customer's addresses, as the document keeps it: the label, the address and the phone
// on their own lines, the way a challan prints them
function shippingAddressOf(
  data: WorkspaceData,
  customerId: string,
  addressId: string | null,
): { id: string; text: string } | null {
  if (addressId === null) return null;
  const address = data.sales.customers
    .find((item) => item.id === customerId)
    ?.addresses.find((item) => item.id === addressId);
  if (!address) throw fieldProblem('sales_address_invalid', 'shippingAddressId');
  const text = [address.label, address.address, address.phone]
    .filter((part): part is string => part !== null)
    .join('\n');
  return { id: address.id, text };
}

interface ResolvedLine {
  line: SalesLine;
  amounts: LineAmounts;
}

// The API's resolveSalesLines(): an active product or service, its unit, the decimals, and an
// active VAT rate (or one the document's lines already use: keptRateIds). Every problem at once,
// each under its own field.
function resolveSalesLines(
  data: WorkspaceData,
  lines: readonly SalesLineInput[],
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string>,
): ResolvedLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index): ResolvedLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, input.variantId);
    if (found?.product.archivedAt !== null || found.variant.archivedAt !== null) {
      at('variantId', 'sales_item_invalid');
      return [];
    }
    const { product, variant } = found;
    const factor =
      input.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === input.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!fitsDecimals(input.quantity, decimalsOf(data, input.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const rate = data.sales.taxRates.find((item) => item.id === input.taxRateId);
    if (!rate || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
      at('taxRateId', 'tax_rate_invalid');
      return [];
    }
    const amounts = lineAmounts(
      {
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        discountType: input.discountType,
        discount: input.discount,
        rate: rate.rate,
      },
      pricesIncludeVat,
    );
    const ref = refOf(product, variant);
    return [
      {
        amounts,
        line: {
          ...ref,
          id: crypto.randomUUID(),
          productType: product.type,
          tracking: product.tracking,
          hasExpiry: product.hasExpiry,
          units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
          unitId: input.unitId,
          // "2" → "2.0000": the way Postgres sends NUMERIC(19,4)
          quantity: addQuantity(input.quantity, '0'),
          baseQuantity: toBaseQuantity(
            input.quantity,
            factor,
            decimalsOf(data, product.baseUnitId),
          ),
          description: input.description ?? defaultLineDescription(ref),
          unitPrice: addMoney(input.unitPrice, '0'),
          discountType: input.discountType,
          discount: addMoney(input.discount, '0'),
          taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate },
          net: amounts.net,
          vat: amounts.vat,
          total: amounts.total,
        },
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

function totalsOf(resolved: readonly ResolvedLine[]) {
  return documentTotals(resolved.map((item) => item.amounts));
}

// The VAT rates a document's lines use now: they stay usable on it after they are archived
function ratesOf(lines: readonly SalesLine[]): Set<string> {
  return new Set(lines.map((line) => line.taxRate.id));
}

// --- The price a line starts with ---------------------------------------------------------------

// The API's PriceLookupService: the customer's active price list, else the variant's own price ×
// the unit's factor, else none; and the product's own active VAT rate, else the default one
export function lookupPrices(data: WorkspaceData, input: PriceLookupInput): PriceLookup {
  const { sales } = data;
  const customer =
    input.customerId === null
      ? undefined
      : sales.customers.find((item) => item.id === input.customerId);
  // An archived list falls back to the products' own prices, as 15a promised
  const list = sales.priceLists.find(
    (item) => item.id === customer?.priceListId && item.archivedAt === null,
  );
  const fallbackRate = sales.taxRates.find((rate) => rate.isDefault);
  const items = input.items.flatMap((item): PriceLookupItem[] => {
    const found = findVariant(data, item.variantId);
    if (!found) return [];
    const { product, variant } = found;
    const factor =
      item.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
    // A unit that is not this product's is left out, like an unknown variant
    if (factor === undefined) return [];
    const rate =
      sales.taxRates.find((row) => row.id === product.taxRateId && row.archivedAt === null) ??
      fallbackRate;
    if (!rate) return [];
    const listPrice =
      list === undefined
        ? undefined
        : sales.priceItems.find(
            (price) =>
              price.priceListId === list.id &&
              price.variantId === variant.id &&
              price.unitId === item.unitId,
          )?.price;
    // The price per base unit × the pack's factor, rounded to the 4 decimals a price keeps, like
    // the API's NUMERIC round(…, 4). toBaseQuantity() is exactly that sum: a number with 4 decimals
    // times a factor with 6, rounded half up.
    const productPrice =
      variant.salePrice === null ? null : toBaseQuantity(variant.salePrice, factor, 4);
    const price = listPrice ?? productPrice;
    return [
      {
        variantId: variant.id,
        unitId: item.unitId,
        price,
        source: listPrice !== undefined ? 'price_list' : price === null ? null : 'product',
        taxRateId: rate.id,
      },
    ];
  });
  return { pricesIncludeVat: data.settings.pricesIncludeVat, items };
}

// --- Quotations ---------------------------------------------------------------------------------

export function findQuotation(data: WorkspaceData, id: string): MockQuotation {
  const found = data.salesDocuments.quotations.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toQuotation(data: WorkspaceData, stored: MockQuotation): Quotation {
  const order = data.salesDocuments.orders.find((item) => item.quotationId === stored.id);
  return { ...stored, order: order ? { id: order.id, number: order.number } : null };
}

export function listQuotations(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): Quotation[] {
  return newestFirst(data.salesDocuments.quotations)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toQuotation(data, item));
}

// A new quotation gets its number at once; an open one can be changed, keeping its number, its
// customer (even if archived since) and its way of reading prices
export function saveQuotation(
  data: WorkspaceData,
  input: QuotationInput,
  existing?: MockQuotation,
): MockQuotation {
  if (existing && existing.status !== 'open') throw new MockProblem(409, 'quotation_not_open');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  const pricesIncludeVat = existing?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
  const resolved = resolveSalesLines(
    data,
    input.lines,
    pricesIncludeVat,
    ratesOf(existing?.lines ?? []),
  );
  const saved: MockQuotation = {
    id: existing?.id ?? crypto.randomUUID(),
    // Taken last: a refused quotation uses no number
    number: existing?.number ?? nextNumber(data, 'quotation', input.date),
    date: input.date,
    validUntil: input.validUntil,
    customer,
    status: 'open',
    pricesIncludeVat,
    ...totalsOf(resolved),
    note: input.note,
    lines: resolved.map((item) => item.line),
    lineCount: resolved.length,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
  const { quotations } = data.salesDocuments;
  data.salesDocuments.quotations = existing
    ? quotations.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...quotations];
  return saved;
}

export function removeQuotation(data: WorkspaceData, target: MockQuotation): void {
  if (target.status !== 'open') throw new MockProblem(409, 'quotation_not_open');
  data.salesDocuments.quotations = data.salesDocuments.quotations.filter(
    (item) => item.id !== target.id,
  );
}

// "Mark declined" on an open one, "Open again" on a declined one. Accepted is set by an order.
export function answerQuotation(target: MockQuotation, action: 'decline' | 'reopen'): void {
  if (action === 'decline' && target.status !== 'open') {
    throw new MockProblem(409, 'quotation_not_open');
  }
  if (action === 'reopen' && target.status !== 'declined') {
    throw new MockProblem(409, 'quotation_not_declined');
  }
  Object.assign(target, {
    status: action === 'decline' ? 'declined' : 'open',
    version: target.version + 1,
    updatedAt: now(),
  });
}

// --- Sales orders -------------------------------------------------------------------------------

type OrderFields = Omit<SalesOrderInput, 'confirm' | 'quotationId'>;

export function findOrder(data: WorkspaceData, id: string): MockOrder {
  const found = data.salesDocuments.orders.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function anythingDelivered(order: MockOrder): boolean {
  return order.lines.some((line) => !isZeroQuantity(line.deliveredQuantity));
}

export function toOrder(data: WorkspaceData, stored: MockOrder): SalesOrder {
  const { quotationId, ...order } = stored;
  const quotation = data.salesDocuments.quotations.find((item) => item.id === quotationId);
  return {
    ...order,
    partlyDelivered: stored.status === 'confirmed' && anythingDelivered(stored),
    quotation: quotation ? { id: quotation.id, number: quotation.number } : null,
    // Drafts too, oldest first: the order page lists every challan made against it
    deliveries: data.salesDocuments.deliveries
      .filter((item) => item.orderId === stored.id)
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({ id: item.id, number: item.number, date: item.date, status: item.status })),
  };
}

export function listOrders(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): SalesOrder[] {
  return newestFirst(data.salesDocuments.orders)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toOrder(data, item));
}

// What a new order and a changed draft share: the warehouse, the address and the lines, checked
function orderParts(
  data: WorkspaceData,
  input: OrderFields,
  customer: PartyRef,
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string>,
) {
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const address = shippingAddressOf(data, customer.id, input.shippingAddressId);
  const resolved = resolveSalesLines(data, input.lines, pricesIncludeVat, keptRateIds);
  return {
    date: input.date,
    deliveryDate: input.deliveryDate,
    customer,
    customerReference: input.customerReference,
    warehouseId: input.warehouseId,
    shippingAddressId: address?.id ?? null,
    shippingAddress: address?.text ?? null,
    note: input.note,
    pricesIncludeVat,
    ...totalsOf(resolved),
    lineCount: resolved.length,
    lines: resolved.map((item) => ({ ...item.line, deliveredQuantity: '0.0000' })),
  };
}

// The quotation an order is made from: this customer's, and still waiting for an answer
function openQuotation(data: WorkspaceData, quotationId: string, customerId: string) {
  const quotation = data.salesDocuments.quotations.find((item) => item.id === quotationId);
  if (quotation?.customer.id !== customerId) {
    throw fieldProblem('order_quotation_invalid', 'quotationId');
  }
  if (quotation.status !== 'open') throw new MockProblem(409, 'quotation_not_open');
  return quotation;
}

export function createOrder(
  data: WorkspaceData,
  input: OrderFields,
  quotationId: string | null,
): MockOrder {
  const customer = customerOf(data, input.customerId, null);
  const quotation = quotationId === null ? null : openQuotation(data, quotationId, customer.id);
  // An order made from a quotation reads its prices the way the quotation did
  const pricesIncludeVat = quotation?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
  const created: MockOrder = {
    id: crypto.randomUUID(),
    number: null,
    status: 'draft',
    confirmedAt: null,
    quotationId: quotation?.id ?? null,
    ...orderParts(data, input, customer, pricesIncludeVat, new Set()),
    version: 1,
    updatedAt: now(),
  };
  data.salesDocuments.orders = [created, ...data.salesDocuments.orders];
  // The customer said yes: the order accepts its quotation
  if (quotation) {
    Object.assign(quotation, {
      status: 'accepted',
      version: quotation.version + 1,
      updatedAt: now(),
    });
  }
  return created;
}

export function updateOrder(data: WorkspaceData, target: MockOrder, input: OrderFields): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  const customer = customerOf(data, input.customerId, target.customer.id);
  // A reopened order keeps its customer: its number was given to this customer, and a quotation
  // of this customer may point at it
  if (
    (target.number !== null || target.quotationId !== null) &&
    customer.id !== target.customer.id
  ) {
    throw fieldProblem('sales_customer_invalid', 'customerId');
  }
  Object.assign(
    target,
    orderParts(data, input, customer, target.pricesIncludeVat, ratesOf(target.lines)),
    { version: target.version + 1, updatedAt: now() },
  );
}

// The number the first time; a reopened order confirms again with the number it already has
export function confirmOrder(data: WorkspaceData, target: MockOrder): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  Object.assign(target, {
    status: 'confirmed',
    number: target.number ?? nextNumber(data, 'order', target.date),
    confirmedAt: now(),
    version: target.version + 1,
    updatedAt: now(),
  });
}

// Only a draft that never had a number; its quotation waits for an answer again
export function removeOrder(data: WorkspaceData, target: MockOrder): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  if (target.number !== null) throw new MockProblem(409, 'order_numbered');
  data.salesDocuments.orders = data.salesDocuments.orders.filter((item) => item.id !== target.id);
  const quotation = data.salesDocuments.quotations.find((item) => item.id === target.quotationId);
  if (quotation) {
    Object.assign(quotation, { status: 'open', version: quotation.version + 1, updatedAt: now() });
  }
}

// Back to draft (no delivery at all, not even a draft one), close (something delivered) or cancel
// (nothing delivered): the API's three rules
export function changeOrderStatus(
  data: WorkspaceData,
  target: MockOrder,
  action: 'reopen' | 'close' | 'cancel',
): void {
  if (target.status !== 'confirmed') throw new MockProblem(409, 'order_not_confirmed');
  if (
    action === 'reopen' &&
    data.salesDocuments.deliveries.some((item) => item.orderId === target.id)
  ) {
    throw new MockProblem(409, 'order_has_deliveries');
  }
  if (action === 'close' && !anythingDelivered(target)) {
    throw new MockProblem(409, 'order_nothing_delivered');
  }
  if (action === 'cancel' && anythingDelivered(target)) {
    throw new MockProblem(409, 'order_partly_delivered');
  }
  const status = action === 'reopen' ? 'draft' : action === 'close' ? 'closed' : 'cancelled';
  Object.assign(target, {
    status,
    ...(action === 'reopen' && { confirmedAt: null }),
    version: target.version + 1,
    updatedAt: now(),
  });
}

// --- Deliveries ---------------------------------------------------------------------------------

type DeliveryFields = Omit<DeliveryInput, 'post'>;

export function findDelivery(data: WorkspaceData, id: string): MockDelivery {
  const found = data.salesDocuments.deliveries.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toDelivery(data: WorkspaceData, stored: MockDelivery): Delivery {
  const { orderId, ...delivery } = stored;
  const order = data.salesDocuments.orders.find((item) => item.id === orderId);
  return { ...delivery, order: order ? { id: order.id, number: order.number } : null };
}

export function listDeliveries(
  data: WorkspaceData,
  query: {
    status?: string | undefined;
    customerId?: string | undefined;
    warehouseId?: string | undefined;
  },
): Delivery[] {
  return newestFirst(data.salesDocuments.deliveries)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
    )
    .map((item) => toDelivery(data, item));
}

// The order of a delivery: this customer's, and confirmed (waiting for deliveries)
function deliverableOrder(data: WorkspaceData, orderId: string, customerId: string): MockOrder {
  const order = data.salesDocuments.orders.find((item) => item.id === orderId);
  if (order?.customer.id !== customerId) throw fieldProblem('delivery_order_invalid', 'orderId');
  if (order.status !== 'confirmed') throw fieldProblem('order_not_confirmed', 'orderId');
  return order;
}

// Each line delivers a line of the order, of the same variant, and the lines together never take
// more than an order line has left: ordered − delivered by posted deliveries. Drafts hold
// nothing, so two drafts may each take the whole rest; the second one to post is refused here.
function checkOrderLines(
  order: MockOrder,
  orderLineIds: readonly (string | null)[],
  lines: readonly StockLine[],
): void {
  const issues: { path: string; code: ErrorCode }[] = [];
  const taken = new Map<string, string[]>();
  lines.forEach((line, index) => {
    const path = (field: string) => `lines.${String(index)}.${field}`;
    const orderLineId = orderLineIds[index] ?? null;
    const orderLine = order.lines.find((item) => item.id === orderLineId);
    if (orderLineId === null) {
      issues.push({ path: path('orderLineId'), code: 'delivery_order_line_required' });
    } else if (orderLine?.variantId !== line.variantId) {
      issues.push({ path: path('orderLineId'), code: 'delivery_order_line_invalid' });
    } else {
      taken.set(orderLineId, [...(taken.get(orderLineId) ?? []), line.baseQuantity]);
    }
  });
  for (const [orderLineId, quantities] of taken) {
    const orderLine = order.lines.find((item) => item.id === orderLineId);
    if (!orderLine) continue;
    const left = subtractQuantity(orderLine.baseQuantity, orderLine.deliveredQuantity);
    if (compareQuantity(sumQuantity(quantities), left) <= 0) continue;
    // Under every line that takes from it: the person decides which one to cut
    orderLineIds.forEach((id, index) => {
      if (id === orderLineId) {
        issues.push({ path: `lines.${String(index)}.quantity`, code: 'delivery_over_order' });
      }
    });
  }
  if (issues.length > 0) throw issuesError(issues);
}

export function saveDelivery(
  data: WorkspaceData,
  input: DeliveryFields,
  existing?: MockDelivery,
): MockDelivery {
  if (existing && existing.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const order = input.orderId === null ? null : deliverableOrder(data, input.orderId, customer.id);
  const address = shippingAddressOf(data, customer.id, input.shippingAddressId);
  const lines = resolveLines(data, input.lines, 'out');
  const orderLineIds = input.lines.map((line) => line.orderLineId);
  if (order) checkOrderLines(order, orderLineIds, lines);
  const saved: MockDelivery = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    customer,
    orderId: order?.id ?? null,
    warehouseId: input.warehouseId,
    status: 'draft',
    shippingAddressId: address?.id ?? null,
    shippingAddress: address?.text ?? null,
    vehicle: input.vehicle,
    note: input.note,
    lineCount: lines.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines: lines.map((line, index) => ({
      ...line,
      orderLineId: orderLineIds[index] ?? null,
      value: null,
    })),
    entry: null,
  };
  const { deliveries } = data.salesDocuments;
  data.salesDocuments.deliveries = existing
    ? deliveries.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...deliveries];
  return saved;
}

export function removeDelivery(data: WorkspaceData, target: MockDelivery): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  data.salesDocuments.deliveries = data.salesDocuments.deliveries.filter(
    (item) => item.id !== target.id,
  );
}

// The accounts a delivery posts to: Dr cost of goods sold / Cr inventory
function deliveryAccounts(data: WorkspaceData) {
  const usable = (purpose: string) =>
    data.accounts.find(
      (account) => account.purpose === purpose && !account.isGroup && account.archivedAt === null,
    )?.id;
  const inventory = usable('inventory');
  const costOfGoodsSold = usable('cost_of_goods_sold');
  if (inventory === undefined) throw new MockProblem(409, 'stock_account_missing');
  if (costOfGoodsSold === undefined) {
    throw new MockProblem(409, 'stock_account_missing', undefined, { use: 'cost_of_goods_sold' });
  }
  return { inventory, costOfGoodsSold };
}

// What the posted lines delivered goes onto their order lines; when every goods line has all it
// ordered, the order is delivered. A service line never counts.
function deliverOnOrder(
  order: MockOrder,
  orderLineIds: readonly (string | null)[],
  lines: readonly StockLine[],
): void {
  lines.forEach((line, index) => {
    const orderLine = order.lines.find((item) => item.id === orderLineIds[index]);
    if (orderLine) {
      orderLine.deliveredQuantity = addQuantity(orderLine.deliveredQuantity, line.baseQuantity);
    }
  });
  const done = order.lines.every(
    (line) =>
      line.productType !== 'goods' ||
      compareQuantity(line.deliveredQuantity, line.baseQuantity) >= 0,
  );
  // A new version either way: an order page open somewhere shows old delivered quantities
  Object.assign(order, {
    ...(done && { status: 'delivered' }),
    version: order.version + 1,
    updatedAt: now(),
  });
}

// The API's postAndLog(): the date, the warehouse and the order checked again, the number taken,
// the stock moved at its average cost (step 14), the cost of goods sold booked, and the order's
// delivered quantities moved on. A refused posting changes nothing and uses no number.
export function postDelivery(data: WorkspaceData, draft: MockDelivery): MockDelivery {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.date);
  // Before anything moves, like the API's StockPostingService.assertDate()
  if (data.journal.lockDate !== null && draft.date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
  assertWarehouses(data, [{ field: 'warehouseId', id: draft.warehouseId }]);
  const order =
    draft.orderId === null ? null : deliverableOrder(data, draft.orderId, draft.customer.id);
  const orderLineIds = draft.lines.map((line) => line.orderLineId);
  // Again: another delivery of this order may have been posted since this one was saved
  if (order) checkOrderLines(order, orderLineIds, draft.lines);
  const accounts = deliveryAccounts(data);
  const number = nextNumber(data, 'delivery', draft.date);
  let values: string[];
  try {
    values = postMoves(
      data,
      { date: draft.date, kind: 'delivery', direction: 'out', documentId: draft.id, number },
      draft.lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    );
  } catch (error) {
    // The API's transaction gives the number back; so does the mock
    data.salesDocuments.counters.delivery -= 1;
    throw error;
  }
  const total = sumMoney(values);
  const branchId = branchOf(data, draft.warehouseId);
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'sales_delivery',
    document: { id: draft.id, number },
    narration: `Delivery ${number}`,
    amounts: [
      { accountId: accounts.costOfGoodsSold, branchId, amount: total },
      { accountId: accounts.inventory, branchId, amount: negateMoney(total) },
    ],
  });
  Object.assign(draft, {
    lines: draft.lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
    entry,
    number,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  if (order) deliverOnOrder(order, orderLineIds, draft.lines);
  return draft;
}

// --- Seed ---------------------------------------------------------------------------------------

function daysFromToday(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// What a fixture workspace starts with, so every list and pill has something to show. Garments:
// a declined quotation (H&M), an expired one (Primark), an open one (Aarong), H&M's confirmed
// export order, and a draft for Aarong. Pharma: Lazz Pharma's confirmed order for 40 boxes of
// Napa, more than the batch that expires first holds, so a delivery splits it (FEFO). No delivery
// is posted: the seeded books (reports, journal) stay as they were before step 15b.
export function seedSalesDocuments(data: WorkspaceData, garments: boolean): void {
  const today = todayIn(data.settings.timezone);
  const day = (days: number) => daysFromToday(today, days);
  const customer = (name: string) => {
    const found = data.sales.customers.find((item) => item.name === name);
    if (!found) throw new Error(`The mock has no customer ${name}`);
    return found;
  };
  const rate = (name: string) => {
    const found = data.sales.taxRates.find((item) => item.name === name);
    if (!found) throw new Error(`The mock has no VAT rate ${name}`);
    return found.id;
  };
  const unit = (code: string) => {
    const found = data.catalog.units.find((item) => item.code === code);
    if (!found) throw new Error(`The mock has no unit ${code}`);
    return found.id;
  };
  const line = (
    code: string,
    options: string[],
    unitCode: string,
    quantity: string,
    unitPrice: string,
    rateName: string,
    discount = '0',
  ): SalesLineInput => {
    const variant = data.catalog.products
      .find((item) => item.code === code)
      ?.variants.find((item) => item.optionValues.join('|') === options.join('|'));
    if (!variant) throw new Error(`The mock has no ${code} ${options.join(', ')}`);
    return {
      variantId: variant.id,
      unitId: unit(unitCode),
      quantity,
      description: null,
      unitPrice,
      discountType: 'percent',
      discount,
      taxRateId: rate(rateName),
    };
  };
  const quotation = (input: QuotationInput) => saveQuotation(data, input);
  const [main] = data.stock.warehouses;
  if (!main) return;

  if (garments) {
    const hm = customer('H&M Hennes & Mauritz GBC AB');
    const aarong = customer('Aarong');
    answerQuotation(
      quotation({
        customerId: hm.id,
        date: day(-30),
        validUntil: day(-16),
        note: null,
        lines: [
          line('ST-118', ['M', 'Navy blue'], 'dozen', '40', '6900', 'Zero-rated'),
          line('ST-118', ['L', 'Navy blue'], 'dozen', '40', '6900', 'Zero-rated'),
        ],
      }),
      'decline',
    );
    quotation({
      customerId: customer('Primark Stores Ltd.').id,
      date: day(-20),
      validUntil: day(-6),
      note: 'FOB Chattogram. Shipment 45 days after the LC opens.',
      lines: [line('P-00001', [], 'pcs', '2400', '300', 'Zero-rated')],
    });
    quotation({
      customerId: aarong.id,
      date: day(-3),
      validUntil: day(11),
      note: null,
      lines: [
        line('P-00001', [], 'pcs', '200', '290', 'VAT 15%'),
        line('P-00004', [], 'carton', '2', '2750', 'VAT 15%', '5'),
      ],
    });
    const port = hm.addresses.find((address) => address.kind === 'shipping');
    confirmOrder(
      data,
      createOrder(
        data,
        {
          customerId: hm.id,
          date: day(-10),
          deliveryDate: day(20),
          customerReference: 'PO-HM-2026-1187',
          warehouseId: main.id,
          shippingAddressId: port?.id ?? null,
          note: '12 pieces per carton, the buyer’s hangtag on each',
          lines: [
            line('ST-118', ['M', 'Navy blue'], 'dozen', '5', '6900', 'Zero-rated'),
            line('ST-118', ['L', 'Navy blue'], 'dozen', '5', '6900', 'Zero-rated'),
          ],
        },
        null,
      ),
    );
    createOrder(
      data,
      {
        customerId: aarong.id,
        date: day(-1),
        deliveryDate: null,
        customerReference: null,
        warehouseId: main.id,
        shippingAddressId: null,
        note: null,
        lines: [line('P-00001', [], 'pcs', '100', '290', 'VAT 15%')],
      },
      null,
    );
    return;
  }
  const lazz = customer('Lazz Pharma Ltd.');
  confirmOrder(
    data,
    createOrder(
      data,
      {
        customerId: lazz.id,
        date: day(-2),
        deliveryDate: day(1),
        customerReference: 'IND-0915',
        warehouseId: main.id,
        shippingAddressId:
          lazz.addresses.find((address) => address.kind === 'shipping')?.id ?? null,
        note: null,
        lines: [line('P-00001', [], 'box', '40', '102', 'Exempt')],
      },
      null,
    ),
  );
}
