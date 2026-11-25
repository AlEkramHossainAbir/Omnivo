import {
  addMoney,
  billableQuantity,
  type BookShipmentInput,
  compareMoney,
  compareQuantity,
  type CustomerInput,
  type DeliverStorefrontOrderInput,
  type DocumentRef,
  type ErrorCode,
  isOpenShipment,
  isTrackingMode,
  isZeroMoney,
  listingPricing,
  multiplyMoney,
  type PackStorefrontOrderInput,
  type PartlyDeliverStorefrontOrderInput,
  type ReturnStorefrontOrderInput,
  productInputSchema,
  type SalesLineInput,
  type ShopDeliveryZone,
  type ShopPaymentMethod,
  type StorefrontImage,
  type StorefrontOrder,
  type StorefrontOrderCounts,
  type storefrontOrderQuerySchema,
  type StorefrontOrderSort,
  type StorefrontOrderSummary,
  type StorefrontPackPlan,
  type StorefrontReturnPlan,
  type StorefrontSetup,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';
import type { z } from 'zod';

import {
  allocateReceipt,
  confirmWithCredit,
  createReceipt,
  dueOn,
  findInvoice,
  postInvoice,
  saveInvoice,
} from './invoice-data';
import { MockProblem } from './mock';
import { saveProduct } from './product-data';
import { postReturn, saveReturn } from './return-data';
import { saveCustomer } from './sales-data';
import {
  changeOrderStatus,
  createOrder,
  findDelivery,
  findOrder,
  type MockDelivery,
  type MockOrder,
  pageOf,
  postDelivery,
  resolveSalesLines,
  saveDelivery,
} from './sales-document-data';
import { balancesOf, branchOf, findVariant, postAdjustment, saveAdjustment } from './stock-data';
import {
  applyPaymentsToInvoice,
  makePaymentReceipts,
  retryPaymentReceipt,
  seedGateway,
  seedTry,
  toPayment,
} from './storefront-payment-data';
import { createPayout } from './storefront-payout-data';
import {
  bookableAtPack,
  cancelShipments,
  codAmountOf,
  courierNotice,
  followOrder,
  parcelNeedsAttention,
  retryShipment,
  seedCouriers,
  seedParcel,
  settleBookings,
  shipmentsOf,
  startShipment,
  step,
} from './storefront-shipping-data';
import {
  type MockCategory,
  type MockCourierAccount,
  type MockListing,
  type MockShipment,
  type MockShopOrder,
  type MockShopOrderLine,
  seedPhoto,
} from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 27b: the shop's orders in the ERP (Storefront → Shop orders), with the API's rules
// (apps/api/src/storefront/orders/storefront-orders.service.ts and sales-order-maker.ts). A move
// makes its ERP documents with the mock's own sales code (sales-document-data.ts, invoice-data.ts,
// return-data.ts), so the documents it links open on their own pages like any other. The handlers
// run every move in transaction(): a refused document leaves nothing behind. The audit rows are
// the handlers' (handlers.ts): this file imports workspace-data.ts's type only, because
// workspace-data.ts imports the seed below (an import cycle otherwise).
//
// The seed is the garments workspace's Rahman Fashion after 12 days open, only when a test asks
// for it (fixtures.ts → seedsShopOrders): its orders make sales orders, challans, an invoice and
// customers, which would change the numbers and the lists other tests read.

type OrderQuery = z.output<typeof storefrontOrderQuerySchema>;

function now(): string {
  return new Date().toISOString();
}

function stepInvalid(): MockProblem {
  return new MockProblem(409, 'storefront_order_step_invalid');
}

// A day in the workspace's time zone: the documents a move makes are dated on it (decision 21)
function dayOf(data: WorkspaceData, at: string): string {
  return todayIn(data.settings.timezone, new Date(at));
}

// The API's phoneDigits: digits only, and +880 … the same as 0 …
function localPhone(phone: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
}

// ---------------------------------------------------------------------------------------------
// Reading

function itemCount(order: MockShopOrder): number {
  return order.lines.reduce((count, line) => count + line.quantity, 0);
}

function summaryOf(order: MockShopOrder): StorefrontOrderSummary {
  const [placed, confirmed] = order.history;
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    placedAt: placed?.at ?? now(),
    confirmedAt: confirmed?.at ?? now(),
    customerName: order.customerName,
    phone: order.phone,
    zoneName: order.zoneName,
    paymentMethod: order.paymentMethod,
    itemCount: itemCount(order),
    total: order.total,
    // Step 28a: or its last parcel failed to book (step 28b: or a COD receipt failed)
    needsAttention: order.documentError !== null || parcelNeedsAttention(order),
    // Step 28b: the newest parcel's status, for the Shipped tab's second pill
    parcelStatus: order.shipments.at(-1)?.status ?? null,
  };
}

function confirmedAt(order: MockShopOrder): string {
  return summaryOf(order).confirmedAt;
}

// Each sort with its tie-breaker by id, so a page never repeats or skips an order. The mock's
// cursor is an offset (pageOf), so it cannot tell another sort's cursor the way the API does
const SORTS = {
  '-confirmed': (a, b) => confirmedAt(b).localeCompare(confirmedAt(a)) || b.id.localeCompare(a.id),
  confirmed: (a, b) => confirmedAt(a).localeCompare(confirmedAt(b)) || a.id.localeCompare(b.id),
  '-total': (a, b) => compareMoney(b.total, a.total) || b.id.localeCompare(a.id),
  total: (a, b) => compareMoney(a.total, b.total) || a.id.localeCompare(b.id),
} satisfies Record<StorefrontOrderSort, (a: MockShopOrder, b: MockShopOrder) => number>;

// The API's searchFilter: part of the number, of the name, or of the phone with its spaces and
// dashes dropped
function matches(order: MockShopOrder, search: string): boolean {
  const pattern = search.normalize('NFC').toLowerCase();
  const digits = search.replace(/[\s-]/g, '');
  return (
    order.orderNo.toLowerCase().includes(pattern) ||
    order.customerName.toLowerCase().includes(pattern) ||
    (/^\d+$/.test(digits) && order.phone.includes(digits))
  );
}

export function shopOrderPage(
  data: WorkspaceData,
  query: OrderQuery,
): { items: StorefrontOrderSummary[]; nextCursor: string | null } {
  const search = query.search ?? '';
  // Step 28a: the pretend worker's bookings first, as any read sees the worker's
  settleBookings(data);
  const found = data.storefront.orders.filter(
    (order) =>
      (query.view === 'all' || order.status === query.view) &&
      (search === '' || matches(order, search)),
  );
  const page = pageOf(found.toSorted(SORTS[query.sort]), query);
  return { items: page.items.map(summaryOf), nextCursor: page.nextCursor };
}

export function shopOrderCounts(data: WorkspaceData): StorefrontOrderCounts {
  return {
    confirmed: data.storefront.orders.filter((order) => order.status === 'confirmed').length,
  };
}

export function findShopOrder(data: WorkspaceData, id: string): MockShopOrder {
  settleBookings(data);
  const found = data.storefront.orders.find((order) => order.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// A photo whose file is gone shows no picture, not a broken one (the API's `ready` check)
function imageOf(data: WorkspaceData, image: StorefrontImage | null) {
  if (image === null) return null;
  const photo = data.storefront.photos.get(image.id);
  return photo?.outcome?.kind === 'ready' && photo.url !== null
    ? { ...image, url: photo.url }
    : null;
}

// The variant now: its SKU and its base unit's code ("2 pcs"), its tracking for the pack plan
function variantOf(data: WorkspaceData, line: MockShopOrderLine) {
  const found = findVariant(data, line.variantId);
  if (!found) throw new Error(`Shop order line of a missing variant ${line.variantId}`);
  const unit = data.catalog.units.find((item) => item.id === found.product.baseUnitId);
  return { ...found, unitCode: unit?.code ?? '' };
}

function refOf(document: { id: string; number: string | null } | undefined): DocumentRef | null {
  return document === undefined ? null : { id: document.id, number: document.number };
}

export function toShopOrder(data: WorkspaceData, order: MockShopOrder): StorefrontOrder {
  const salesOrder = data.salesDocuments.orders.find((item) => item.id === order.salesOrderId);
  return {
    ...summaryOf(order),
    address: order.address,
    history: order.history,
    lines: order.lines.map((line) => {
      const { variant, unitCode } = variantOf(data, line);
      return {
        position: line.position,
        listingId: line.listingId,
        name: line.name,
        packSize: line.packSize,
        image: imageOf(data, line.image),
        productId: line.productId,
        variantId: line.variantId,
        sku: variant.sku,
        unitCode,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      };
    }),
    subtotal: order.subtotal,
    discount: order.discount,
    couponCode: order.couponCode,
    deliveryCharge: order.deliveryCharge,
    cancelReason: order.cancelReason,
    customer:
      salesOrder === undefined
        ? null
        : { id: salesOrder.customer.id, name: salesOrder.customer.name },
    salesOrder: refOf(salesOrder),
    delivery: refOf(data.salesDocuments.deliveries.find((item) => item.id === order.deliveryId)),
    invoice: refOf(data.billing.invoices.find((item) => item.id === order.invoiceId)),
    salesReturn: refOf(data.returns.salesReturns.find((item) => item.id === order.salesReturnId)),
    documentError: order.documentError,
    // Step 27d
    payments: order.payments.map((payment) => toPayment(data, payment)),
    // Step 28a
    codAmount: codAmountOf(order),
    shipments: shipmentsOf(data, order),
    version: order.version,
    updatedAt: order.updatedAt,
  };
}

// FOR UPDATE's checks: the order, and the version the page read
function lockShopOrder(data: WorkspaceData, id: string, version: number): MockShopOrder {
  const order = findShopOrder(data, id);
  if (order.version !== version) throw new MockProblem(409, 'version_conflict');
  return order;
}

// A move: the new status, the step on the timeline, the version up. The audit row is the
// handler's (recordShopMove in handlers.ts)
function move(
  order: MockShopOrder,
  status: MockShopOrder['status'],
  at: string,
  fields: Partial<MockShopOrder> = {},
): void {
  Object.assign(order, fields, {
    status,
    history: [...order.history, { status, at }],
    version: order.version + 1,
    updatedAt: at,
  });
}

// ---------------------------------------------------------------------------------------------
// The sales order (decisions 1 to 4, ShopSalesOrderMaker)

// What the handlers write audit rows for, besides the move itself
export interface MadeSalesOrder {
  salesOrder: MockOrder;
  customerId: string;
  customerMade: boolean;
  deliveryProductId: string | null;
  overridden: { limit: string; exposure: string } | null;
}

// A product's VAT rate: its own, else the workspace's default. Neither: the sales order's own error
function rateOf(data: WorkspaceData, taxRateId: string | null): string {
  const rate =
    taxRateId ??
    data.sales.taxRates.find((item) => item.isDefault && item.archivedAt === null)?.id ??
    null;
  if (rate === null) throw new MockProblem(409, 'tax_rate_invalid');
  return rate;
}

// One line per shop line, in the cart's order, in the base unit at the shop's price (decision 3)
function goodsLines(data: WorkspaceData, order: MockShopOrder): SalesLineInput[] {
  return order.lines.map((line) => {
    const { product } = variantOf(data, line);
    return {
      variantId: line.variantId,
      unitId: product.baseUnitId,
      quantity: String(line.quantity),
      description: null,
      unitPrice: line.unitPrice,
      discountType: 'amount',
      discount: '0',
      taxRateId: rateOf(data, product.taxRateId),
    };
  });
}

// "Delivery charge", made by the first order with a charge (decision 4): a service in the piece
// unit, its id kept in the shop's settings, whose version goes up (a settings form open somewhere
// must reload before its save)
function makeDeliveryService(data: WorkspaceData): string {
  const shop = data.storefront.shop;
  if (shop === null) throw new Error('A shop order without a shop');
  const unit = data.catalog.units
    .filter((item) => item.archivedAt === null && item.dimension === 'count')
    .filter((item) => item.ratio !== null && compareQuantity(item.ratio, '1') === 0)
    .toSorted((a, b) => Number(b.code === 'pcs') - Number(a.code === 'pcs'))[0];
  if (unit === undefined) throw new MockProblem(409, 'storefront_delivery_product_invalid');
  const product = saveProduct(
    data.catalog,
    productInputSchema.parse({
      code: '',
      name: 'Delivery charge',
      type: 'service',
      categoryId: '',
      description: '',
      baseUnitId: unit.id,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      taxRateId: '',
      options: [],
      variants: [
        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
      ],
      units: [],
      customFields: {},
    }),
  );
  data.catalog.products.push(product);
  const [variant] = product.variants;
  if (!variant) throw new Error('Delivery charge was made without a variant');
  Object.assign(shop, {
    deliveryVariantId: variant.id,
    version: shop.version + 1,
    updatedAt: now(),
  });
  return product.id;
}

// The address on the sales order and the challan: who, where and the phone, on their own lines
function shippingText(order: MockShopOrder): string {
  return [order.customerName, order.address, order.phone].join('\n');
}

// Decision 2: the first active customer with this phone, else a new one with no credit limit
function customerFor(data: WorkspaceData, order: MockShopOrder): { id: string; made: boolean } {
  const found = data.sales.customers.find(
    (customer) => customer.archivedAt === null && localPhone(customer.phone) === order.phone,
  );
  if (found) return { id: found.id, made: false };
  const language = data.storefront.shop?.language ?? 'en';
  const input: CustomerInput = {
    code: null,
    name: order.customerName,
    groupId: null,
    contactPerson: null,
    phone: order.phone,
    email: null,
    documentLanguage: language,
    bin: null,
    paymentTermsDays: 0,
    creditLimit: null,
    priceListId: null,
    notes: null,
    addresses: [{ id: null, kind: 'shipping', label: null, address: order.address, phone: null }],
  };
  const saved = saveCustomer(data, input);
  data.sales.customers.push(saved);
  return { id: saved.id, made: true };
}

// The API's maker, in the order that lets a refusal leave nothing behind: the API rolls its
// transaction back, while the mock's transaction() does not copy the catalog (10,000 products), the
// customers or the shop. So the goods lines are checked first (an archived product, no VAT rate:
// the sales order's own errors), then the service, the customer and the order are made
export function makeShopSalesOrder(
  data: WorkspaceData,
  order: MockShopOrder,
  at: string = now(),
): MadeSalesOrder {
  const shop = data.storefront.shop;
  if (shop === null) throw new Error('A shop order without a shop');
  const goods = goodsLines(data, order);
  resolveSalesLines(data, goods, true, new Set());
  let deliveryProductId: string | null = null;
  const lines = [...goods];
  // A free delivery adds no line: a line of ৳0 would print a service nobody paid for
  if (compareMoney(order.deliveryCharge, '0') > 0) {
    if (shop.deliveryVariantId === null) deliveryProductId = makeDeliveryService(data);
    const variantId = shop.deliveryVariantId;
    const found = variantId === null ? undefined : findVariant(data, variantId);
    if (!found) throw new Error('The delivery charge service is missing');
    lines.push({
      variantId: found.variant.id,
      unitId: found.product.baseUnitId,
      quantity: '1',
      description: null,
      unitPrice: order.deliveryCharge,
      discountType: 'amount',
      discount: '0',
      taxRateId: rateOf(data, found.product.taxRateId),
    });
  }
  const customer = customerFor(data, order);
  const salesOrder = createOrder(
    data,
    {
      customerId: customer.id,
      date: dayOf(data, at),
      deliveryDate: null,
      // The shop's number, as a buyer's PO number would be
      customerReference: order.orderNo,
      warehouseId: order.warehouseId,
      shippingAddressId: null,
      note: null,
      lines,
    },
    null,
    crypto.randomUUID(),
    { pricesIncludeVat: true, shippingAddress: shippingText(order) },
  );
  // Over the limit it still goes (CreditOverride 'storefront_order'): the audit log says so
  const overridden = confirmWithCredit(data, salesOrder, true);
  Object.assign(order, {
    salesOrderId: salesOrder.id,
    documentError: null,
    version: order.version + 1,
    updatedAt: at,
  });
  // Step 27d: the paid tries' receipts need the sales order's customer (the API's makeAll)
  makePaymentReceipts(data, order, at);
  return {
    salesOrder,
    customerId: customer.id,
    customerMade: customer.made,
    deliveryProductId,
    overridden,
  };
}

// Step 27d: "Make the receipt" on a paid try whose receipt failed. The version moves on, so another
// tab that still shows the error reloads first. The handler calls it outside transaction(): the
// try's error must stay when the receipt is refused again
export function makeShopPaymentReceipt(
  data: WorkspaceData,
  id: string,
  paymentId: string,
  version: number,
): { order: MockShopOrder; receiptId: string } {
  const order = lockShopOrder(data, id, version);
  const receiptId = retryPaymentReceipt(data, order, paymentId);
  Object.assign(order, { version: order.version + 1, updatedAt: now() });
  return { order, receiptId };
}

// "Make the sales order" (decision 1's retry): a refusal is kept on the order, as the handler
// keeps it, and still answered. The handler calls it outside transaction(): the order's error must
// stay when the sales order is refused
export function retrySalesOrder(data: WorkspaceData, id: string, version: number): MadeSalesOrder {
  const order = lockShopOrder(data, id, version);
  if (order.status !== 'confirmed' || order.salesOrderId !== null) throw stepInvalid();
  try {
    return makeShopSalesOrder(data, order);
  } catch (error) {
    if (error instanceof MockProblem) order.documentError = error.code;
    throw error;
  }
}

function salesOrderOf(data: WorkspaceData, order: MockShopOrder): MockOrder {
  if (order.salesOrderId === null) throw new MockProblem(409, 'storefront_order_no_sales_order');
  return findOrder(data, order.salesOrderId);
}

// ---------------------------------------------------------------------------------------------
// Packed (decisions 5, 14, 15)

// The batches of a variant with stock in the warehouse, earliest expiry first (none last), then
// the oldest batch: the order FEFO takes them in
function batchesIn(data: WorkspaceData, warehouseId: string, variantId: string) {
  const balances = balancesOf(data.stock);
  return data.stock.batches
    .filter((batch) => batch.variantId === variantId)
    .map((batch) => ({
      batchId: batch.id,
      lotNumber: batch.lotNumber,
      expiresOn: batch.expiresOn,
      available: balances.byBatch.get(`${warehouseId}|${variantId}|${batch.id}`) ?? '0',
    }))
    .filter((batch) => compareQuantity(batch.available, '0') > 0)
    .toSorted((a, b) => (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'));
}

// FEFO: take from the first batch until the line is full, then the next. A line the batches
// cannot fill keeps what they have; the challan's stock check has the last word
function fefo(
  quantity: string,
  available: StorefrontPackPlan['lines'][number]['batches'],
): StorefrontPackPlan['lines'][number]['picks'] {
  const picks: StorefrontPackPlan['lines'][number]['picks'] = [];
  let left = quantity;
  for (const batch of available) {
    if (compareQuantity(left, '0') <= 0) break;
    const take = compareQuantity(batch.available, left) < 0 ? batch.available : left;
    picks.push({ batchId: batch.batchId, quantity: sumQuantity([take]), serialNumbers: [] });
    left = subtractQuantity(left, take);
  }
  return picks;
}

export function packPlanOf(data: WorkspaceData, id: string): StorefrontPackPlan {
  const order = findShopOrder(data, id);
  if (order.status !== 'confirmed') throw stepInvalid();
  const salesOrder = salesOrderOf(data, order);
  const warehouse = data.stock.warehouses.find((place) => place.id === salesOrder.warehouseId);
  if (!warehouse) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);
  return {
    warehouse: { id: warehouse.id, name: warehouse.name },
    lines: order.lines.map((line) => {
      const { product, variant, unitCode } = variantOf(data, line);
      const quantity = String(line.quantity);
      // A product's tracking is a plain string in its answer (a newer server's new mode must not
      // break an older client); the plan's is the enum
      const tracking = isTrackingMode(product.tracking) ? product.tracking : 'none';
      const batches = tracking === 'batch' ? batchesIn(data, warehouse.id, line.variantId) : [];
      return {
        position: line.position,
        name: line.name,
        packSize: line.packSize,
        sku: variant.sku,
        unitCode,
        quantity,
        tracking,
        batches,
        picks:
          tracking === 'none'
            ? [{ batchId: null, quantity, serialNumbers: [] }]
            : tracking === 'batch'
              ? fefo(quantity, batches)
              : [],
      };
    }),
  };
}

// The challan's own errors name its lines (lines.0, lines.1 …); the dialog has the order's lines,
// each split into picks. The API's onPicks(): each challan line back to its line and pick
function onPicks(error: unknown, at: readonly { line: number; pick: number }[]): never {
  if (!(error instanceof MockProblem) || error.fieldErrors === undefined) throw error;
  const fieldErrors = Object.fromEntries(
    Object.entries(error.fieldErrors).map(([path, codes]) => {
      const match = /^lines\.(\d+)\.(.+)$/.exec(path);
      const where = match === null ? undefined : at[Number(match[1])];
      const field = match?.[2];
      return [
        where === undefined || field === undefined
          ? path
          : `lines.${String(where.line)}.picks.${String(where.pick)}.${field}`,
        codes,
      ];
    }),
  );
  throw new MockProblem(error.status, error.code, fieldErrors, error.params);
}

export function packShopOrder(
  data: WorkspaceData,
  id: string,
  input: PackStorefrontOrderInput,
  at: string = now(),
): { order: MockShopOrder; delivery: MockDelivery; courier: MockCourierAccount | null } {
  const order = lockShopOrder(data, id, input.version);
  if (order.status !== 'confirmed') throw stepInvalid();
  // Step 28a: the courier first, so a wrong pick is refused before any stock moves
  if (input.courierAccountId !== null) bookableAtPack(data, input.courierAccountId);
  const salesOrder = salesOrderOf(data, order);

  // Every line of the order once, and the picks of each add up to what the shopper ordered
  const byPosition = new Map(order.lines.map((line, index) => [line.position, index]));
  const fieldErrors: Record<string, ErrorCode[]> = {};
  input.lines.forEach((line, lineIndex) => {
    const index = byPosition.get(line.position);
    const ordered = index === undefined ? undefined : order.lines[index];
    if (ordered === undefined) {
      fieldErrors[`lines.${String(lineIndex)}.position`] = ['storefront_order_line_missing'];
      return;
    }
    const picked = sumQuantity(line.picks.map((pick) => pick.quantity));
    if (compareQuantity(picked, String(ordered.quantity)) !== 0) {
      fieldErrors[`lines.${String(lineIndex)}.picks`] = ['storefront_order_pick_total'];
    }
  });
  const [first] = Object.values(fieldErrors);
  if (first?.[0] !== undefined) throw new MockProblem(409, first[0], fieldErrors);
  if (input.lines.length !== order.lines.length) {
    throw new MockProblem(409, 'storefront_order_line_missing');
  }

  // Line i of the order is line i of the sales order (the maker wrote them so)
  const challanLines = input.lines.flatMap((line, lineIndex) => {
    const index = byPosition.get(line.position) ?? -1;
    const soLine = salesOrder.lines[index];
    if (soLine === undefined || soLine.variantId !== order.lines[index]?.variantId) {
      throw new Error(`Order ${id} line ${String(line.position)} has no sales order line`);
    }
    return line.picks.map((pick, pickIndex) => ({
      at: { line: lineIndex, pick: pickIndex },
      line: {
        variantId: soLine.variantId,
        unitId: soLine.unitId,
        quantity: pick.quantity,
        batchId: pick.batchId,
        serialNumbers: pick.serialNumbers,
        orderLineId: soLine.id,
      },
    }));
  });
  let delivery: MockDelivery;
  try {
    const draft = saveDelivery(data, {
      customerId: salesOrder.customer.id,
      orderId: salesOrder.id,
      date: dayOf(data, at),
      warehouseId: salesOrder.warehouseId,
      shippingAddressId: null,
      vehicle: null,
      note: null,
      lines: challanLines.map((entry) => entry.line),
    });
    // The shopper's address as text, like the API's postForShopOrder
    draft.shippingAddress = salesOrder.shippingAddress;
    delivery = postDelivery(data, draft);
  } catch (error) {
    onPicks(
      error,
      challanLines.map((entry) => entry.at),
    );
  }
  move(order, 'packed', at, { deliveryId: delivery.id });
  // Step 28a: the parcel with the challan; the pretend worker books it (storefront-shipping-data.ts)
  const courier =
    input.courierAccountId === null
      ? null
      : startShipment(data, order, { accountId: input.courierAccountId, trackingCode: '' }, at);
  return { order, delivery, courier };
}

// ---------------------------------------------------------------------------------------------
// Step 28a: Book courier and Book again (the parcel's rules are storefront-shipping-data.ts's)

export function bookShopOrder(
  data: WorkspaceData,
  id: string,
  input: BookShipmentInput,
): { order: MockShopOrder; courier: MockCourierAccount } {
  const order = lockShopOrder(data, id, input.version);
  return { order, courier: startShipment(data, order, input) };
}

export function retryShopParcel(
  data: WorkspaceData,
  id: string,
  shipmentId: string,
  version: number,
): { order: MockShopOrder; courier: MockCourierAccount; invoice: string } {
  const order = lockShopOrder(data, id, version);
  const { account, parcel } = retryShipment(data, order, shipmentId);
  return { order, courier: account, invoice: parcel.invoice };
}

// ---------------------------------------------------------------------------------------------
// Shipped, Delivered, Cancel (decisions 6 to 8)

export function shipShopOrder(
  data: WorkspaceData,
  id: string,
  version: number,
  at: string = now(),
): MockShopOrder {
  const order = lockShopOrder(data, id, version);
  if (order.status !== 'packed') throw stepInvalid();
  move(order, 'shipped', at);
  // Step 28a: a parcel booked by hand follows the button
  followOrder(data, order, 'picked_up', at);
  return order;
}

// What a Delivered made, for the handler's audit rows
export interface DeliveredShopOrder {
  order: MockShopOrder;
  invoiceId: string;
  receiptId: string | null;
}

// Mark delivered: a posted invoice for what the challan took, at the sales order's prices, and the
// delivery charge after it, dated that day. Step 28b: and the rider's COD receipt for what was
// collected (settleCod)
export function deliverShopOrder(
  data: WorkspaceData,
  id: string,
  input: Pick<DeliverStorefrontOrderInput, 'version' | 'collectedAmount'>,
  at: string = now(),
): DeliveredShopOrder {
  const order = lockShopOrder(data, id, input.version);
  return { order, ...deliverIn(data, order, input.collectedAmount, null, at) };
}

// The move itself, after the lock: Mark delivered, Record what came back (`salesReturnId`: the
// sales return of what came back, posted just before) and the courier's news. The order is moved
// last: transaction() puts back the documents of a refused move, not the shop's own rows, so every
// refusal (the invoice's, the collected amount's) comes before the order changes
function deliverIn(
  data: WorkspaceData,
  order: MockShopOrder,
  collected: string | null,
  salesReturnId: string | null,
  at: string,
): { invoiceId: string; receiptId: string | null } {
  if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
  const salesOrder = salesOrderOf(data, order);
  const challan = findDelivery(data, order.deliveryId);
  const branchId = branchOf(data, salesOrder.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
  // Step 28b: what did not come back before the invoice (the invoice's own rule, 15d); a line
  // that came back whole is not billed. The mock's shop orders have no coupon, so no discount
  const goods = challan.lines.flatMap((line) => {
    const soLine = salesOrder.lines.find((item) => item.id === line.orderLineId);
    if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
    const kept = billableQuantity(line);
    if (compareQuantity(kept, '0') <= 0) return [];
    return [
      {
        variantId: line.variantId,
        unitId: line.unitId,
        // A shop's challan is in the base unit, so what is kept is the line's quantity
        quantity: compareQuantity(kept, line.baseQuantity) === 0 ? line.quantity : kept,
        description: soLine.description,
        unitPrice: soLine.unitPrice,
        discountType: 'amount' as const,
        discount: '0',
        taxRateId: soLine.taxRate.id,
        deliveryLineId: line.id,
        orderLineId: null,
        batchId: null,
        serialNumbers: [],
      },
    ];
  });
  const charges = salesOrder.lines.slice(order.lines.length).map((soLine) => ({
    variantId: soLine.variantId,
    unitId: soLine.unitId,
    quantity: soLine.quantity,
    description: soLine.description,
    unitPrice: soLine.unitPrice,
    discountType: 'amount' as const,
    discount: '0',
    taxRateId: soLine.taxRate.id,
    deliveryLineId: null,
    orderLineId: soLine.id,
    batchId: null,
    serialNumbers: [],
  }));
  const draft = saveInvoice(data, {
    customerId: salesOrder.customer.id,
    date: dayOf(data, at),
    note: null,
    lines: [...goods, ...charges],
    dueDate: null,
    customerReference: order.orderNo,
    branchId,
    warehouseId: null,
  });
  // Never over the limit: it moves the amount from "on order" to "owed" and adds nothing
  postInvoice(data, draft, false);
  // Step 27d (decision 6): the invoice takes the advances of the paid tries
  applyPaymentsToInvoice(data, order, draft.id);
  // Step 28b: then the rider's money, which pays what the advances left
  const receiptId = settleCod(
    data,
    order,
    draft.id,
    collected,
    salesReturnId === null ? 'delivered' : 'partly_delivered',
    at,
  );
  move(order, 'delivered', at, {
    invoiceId: draft.id,
    ...(salesReturnId === null ? {} : { salesReturnId }),
  });
  return { invoiceId: draft.id, receiptId };
}

// ---------------------------------------------------------------------------------------------
// Step 28b: the COD receipt (the API's cod-receipts.ts)

// The parcel the courier took to the door: the newest one not still booking or failed, not a
// cancelled booking, and not one received back
function doorParcelOf(order: MockShopOrder): MockShipment | undefined {
  const skip = ['booking', 'booking_failed', 'cancelled', 'returned'];
  return order.shipments.toReversed().find((parcel) => !skip.includes(parcel.status));
}

// What the rider collected goes on the parcel, and a posted receipt for it into the courier
// account's COD account, paying the invoice. The amount: what was typed, else what the courier
// said, else (a whole delivery) the parcel's codAmount. A receipt the books refuse is kept on the
// parcel as its error and rings the bell: the Delivered stays (the API's savepoint)
function settleCod(
  data: WorkspaceData,
  order: MockShopOrder,
  invoiceId: string,
  typed: string | null,
  door: 'delivered' | 'partly_delivered',
  at: string,
): string | null {
  const parcel = doorParcelOf(order);
  // No parcel at the door (undefined !== null too), or one that has its receipt already
  if (parcel?.receiptId !== null) return null;
  const account = data.storefront.couriers.find((item) => item.id === parcel.accountId);
  const codAccountId = account?.codAccountId ?? null;
  const collected =
    typed ?? parcel.collectedAmount ?? (door === 'delivered' ? parcel.codAmount : null);
  if (collected === null && codAccountId !== null) {
    throw new MockProblem(422, 'storefront_order_collected_required', {
      collectedAmount: ['storefront_order_collected_required'],
    });
  }
  if (collected !== null && compareMoney(collected, parcel.codAmount) > 0) {
    throw new MockProblem(
      422,
      'storefront_order_collected_over',
      { collectedAmount: ['storefront_order_collected_over'] },
      { amount: parcel.codAmount },
    );
  }
  // The parcel follows the order: a manual one always, an API one whose news is late
  if (isOpenShipment(parcel.status)) {
    parcel.status = door;
    step(parcel, door, at, null);
  }
  parcel.collectedAmount = collected === null ? null : addMoney(collected, '0');
  if (account === undefined || codAccountId === null || collected === null) return null;
  if (isZeroMoney(collected)) return null;
  try {
    return makeCodReceiptIn(data, order, parcel, invoiceId, at);
  } catch (error) {
    if (!(error instanceof MockProblem)) throw error;
    parcel.receiptError = error.code;
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'storefront.cod_receipt_failed',
      params: { id: order.id, number: order.orderNo, courier: account.name },
      readAt: null,
      createdAt: at,
    });
    return null;
  }
}

// The receipt (the API's make): the sales order's customer and branch, the COD account the
// courier account names now, the courier's code as the reference (its payout lists it), then as
// much of it as the invoice still owes. Throws the receipt's own refusal
function makeCodReceiptIn(
  data: WorkspaceData,
  order: MockShopOrder,
  parcel: MockShipment,
  invoiceId: string,
  at: string,
): string {
  const account = data.storefront.couriers.find((item) => item.id === parcel.accountId);
  if (account?.codAccountId == null || parcel.collectedAmount === null) {
    throw new MockProblem(409, 'receipt_account_invalid');
  }
  const salesOrder = salesOrderOf(data, order);
  const branchId = branchOf(data, salesOrder.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
  const receipt = createReceipt(data, {
    customerId: salesOrder.customer.id,
    date: dayOf(data, at),
    amount: parcel.collectedAmount,
    accountId: account.codAccountId,
    method: 'courier',
    reference: (parcel.trackingCode ?? parcel.invoice).slice(0, 60),
    branchId,
    note: `COD for shop order ${order.orderNo} (${account.name} ${parcel.invoice})`,
    allocations: [],
  });
  parcel.receiptId = receipt.id;
  parcel.receiptError = null;
  // More than is owed stays an advance; less leaves the invoice partly paid
  const due = dueOn(data, findInvoice(data, invoiceId));
  if (compareMoney(due, '0') > 0) {
    const amount = compareMoney(receipt.amount, due) < 0 ? receipt.amount : due;
    allocateReceipt(data, receipt, [{ invoiceId, amount }]);
  }
  return receipt.id;
}

// "Make the receipt" on a parcel whose COD receipt was refused. The handler calls it outside
// transaction(): a refusal again is kept on the parcel and still answered
export function makeShopCodReceipt(
  data: WorkspaceData,
  id: string,
  shipmentId: string,
  version: number,
  at: string = now(),
): { order: MockShopOrder; receiptId: string } {
  const order = lockShopOrder(data, id, version);
  const parcel = order.shipments.find((item) => item.id === shipmentId);
  if (
    parcel?.receiptError == null ||
    parcel.receiptId !== null ||
    parcel.collectedAmount === null ||
    order.invoiceId === null
  ) {
    throw new MockProblem(409, 'storefront_cod_receipt_not_failed');
  }
  try {
    const receiptId = makeCodReceiptIn(data, order, parcel, order.invoiceId, at);
    Object.assign(order, { version: order.version + 1, updatedAt: at });
    return { order, receiptId };
  } catch (error) {
    if (error instanceof MockProblem) parcel.receiptError = error.code;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Step 28b: what came back (decisions 6 and 7)

// The challan's lines as the return plan shows them, each with the shop order line it was packed
// for (the sales order's line i is the order's line i, the maker's rule)
function challanLinesOf(data: WorkspaceData, order: MockShopOrder) {
  if (order.deliveryId === null) throw stepInvalid();
  const salesOrder = salesOrderOf(data, order);
  const challan = findDelivery(data, order.deliveryId);
  return {
    challan,
    lines: challan.lines.map((line) => {
      const index = salesOrder.lines.findIndex((item) => item.id === line.orderLineId);
      const ordered = order.lines[index];
      if (ordered === undefined) throw new Error(`Challan line ${line.id} has no shop order line`);
      return { line, ordered };
    }),
  };
}

export function returnPlanOf(data: WorkspaceData, id: string): StorefrontReturnPlan {
  const order = findShopOrder(data, id);
  if (order.status !== 'shipped') throw stepInvalid();
  const { challan, lines } = challanLinesOf(data, order);
  const warehouse = data.stock.warehouses.find((place) => place.id === challan.warehouseId);
  if (!warehouse) throw new Error(`Warehouse ${challan.warehouseId} is missing`);
  return {
    warehouse: { id: warehouse.id, name: warehouse.name },
    lines: lines.map(({ line, ordered }) => {
      const { product, variant, unitCode } = variantOf(data, ordered);
      return {
        deliveryLineId: line.id,
        position: ordered.position,
        name: ordered.name,
        packSize: ordered.packSize,
        sku: variant.sku,
        unitCode,
        quantity: billableQuantity(line),
        tracking: isTrackingMode(product.tracking) ? product.tracking : 'none',
        batch:
          line.lotNumber === null ? null : { lotNumber: line.lotNumber, expiresOn: line.expiresOn },
        serialNumbers: line.serialNumbers,
      };
    }),
  };
}

// What "Record what came back" and "Receive the return" made, for the audit rows
export interface CameBackShopOrder {
  order: MockShopOrder;
  salesReturnId: string;
  salesOrderId: string | null;
}

// A posted sales return of what came back, dated that day, into the warehouse the goods left from
function returnOf(
  data: WorkspaceData,
  order: MockShopOrder,
  lines: { deliveryLineId: string; quantity: string; serialNumbers: string[] }[],
  note: string | null,
  at: string,
): string {
  const { challan } = challanLinesOf(data, order);
  const draft = saveReturn(data, {
    customerId: challan.customer.id,
    date: dayOf(data, at),
    warehouseId: challan.warehouseId,
    reason: 'other',
    note,
    lines: lines.map((back) => {
      const line = challan.lines.find((item) => item.id === back.deliveryLineId);
      if (line === undefined) throw new Error(`Challan line ${back.deliveryLineId} is missing`);
      return {
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: back.quantity,
        batchId: line.batchId,
        serialNumbers: back.serialNumbers,
        deliveryLineId: line.id,
      };
    }),
  });
  postReturn(data, draft);
  return draft.id;
}

// Record what came back (decision 6): the sales return of the ticked lines, in the dialog's order
// (its errors land under the dialog's rows), then Delivered with the invoice of the rest and the
// COD receipt, then the sales order closed. Every piece back is Receive the return
export function partlyDeliverShopOrder(
  data: WorkspaceData,
  id: string,
  input: PartlyDeliverStorefrontOrderInput,
  at: string = now(),
): CameBackShopOrder & { invoiceId: string; receiptId: string | null } {
  const order = lockShopOrder(data, id, input.version);
  if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
  const { lines } = challanLinesOf(data, order);
  const fieldErrors: Record<string, ErrorCode[]> = {};
  input.lines.forEach((line, index) => {
    if (!lines.some((item) => item.line.id === line.deliveryLineId)) {
      fieldErrors[`lines.${String(index)}.deliveryLineId`] = ['storefront_order_line_missing'];
    }
  });
  if (Object.keys(fieldErrors).length > 0) {
    throw new MockProblem(409, 'storefront_order_line_missing', fieldErrors);
  }
  const back = new Map(input.lines.map((line) => [line.deliveryLineId, line.quantity]));
  if (
    lines.every(
      ({ line }) => compareQuantity(back.get(line.id) ?? '0', billableQuantity(line)) >= 0,
    )
  ) {
    throw new MockProblem(409, 'storefront_order_return_everything');
  }
  const salesReturnId = returnOf(data, order, input.lines, input.reason, at);
  const delivered = deliverIn(data, order, input.collectedAmount, salesReturnId, at);
  const salesOrder = order.salesOrderId === null ? undefined : findOrder(data, order.salesOrderId);
  if (salesOrder) changeOrderStatus(data, salesOrder, 'close');
  return { order, salesReturnId, salesOrderId: salesOrder?.id ?? null, ...delivered };
}

// Receive the return (decision 7): a sales return of the whole challan, the sales order cancelled,
// the parcel returned, the order Returned. The SMS to the shopper is the API's: the mock sends none
export function returnShopOrder(
  data: WorkspaceData,
  id: string,
  input: ReturnStorefrontOrderInput,
  at: string = now(),
): CameBackShopOrder {
  const order = lockShopOrder(data, id, input.version);
  if (order.status !== 'shipped') throw stepInvalid();
  const { lines } = challanLinesOf(data, order);
  const salesReturnId = returnOf(
    data,
    order,
    lines.map(({ line }) => ({
      deliveryLineId: line.id,
      quantity: billableQuantity(line),
      serialNumbers: line.serialNumbers,
    })),
    input.reason,
    at,
  );
  const salesOrder = order.salesOrderId === null ? undefined : findOrder(data, order.salesOrderId);
  if (salesOrder) changeOrderStatus(data, salesOrder, 'cancel');
  // The parcel the courier had, unless it says returned already
  const parcel = order.shipments
    .toReversed()
    .find((item) => !['booking', 'booking_failed', 'cancelled'].includes(item.status));
  if (parcel !== undefined && parcel.status !== 'returned') {
    parcel.status = 'returned';
    step(parcel, 'returned', at, null);
  }
  move(order, 'returned', at, { salesReturnId });
  return { order, salesReturnId, salesOrderId: salesOrder?.id ?? null };
}

// ---------------------------------------------------------------------------------------------
// Step 28b: the courier's news (storefront-shipping-data.ts reads the notice)

// The order follows the parcel: Shipped once the goods left. `deliver` says the courier delivered
// it: the handler then runs courierDeliver in a transaction() of its own, the API's savepoint
export function shopCourierNews(
  data: WorkspaceData,
  accountId: string,
  authorization: string | null,
  body: unknown,
  at: string = now(),
): { order: MockShopOrder; shipped: boolean; deliver: boolean } | null {
  const news = courierNotice(data, accountId, authorization, body, at);
  if (news === null) return null;
  const { order } = news;
  if (news.shipped) move(order, 'shipped', at);
  return { order, shipped: news.shipped, deliver: news.delivered && order.status === 'shipped' };
}

// The courier's Delivered: the invoice and the COD receipt for what its notice said. A Delivered
// the books refuse leaves the order Shipped (the handler's transaction() puts its documents
// back), and Mark delivered then shows why
export function courierDeliver(
  data: WorkspaceData,
  order: MockShopOrder,
  at: string = now(),
): { invoiceId: string; receiptId: string | null } {
  return deliverIn(data, order, null, null, at);
}

export interface CancelledShopOrder {
  order: MockShopOrder;
  salesReturnId: string | null;
  salesOrderId: string | null;
}

// A new order's sales order is cancelled (its hold ends with it); a packed one's goods come back
// on a posted sales return of the whole challan first, which opens its sales order again, and then
// the sales order is cancelled. The SMS to the shopper is the API's: the mock sends none
export function cancelShopOrder(
  data: WorkspaceData,
  id: string,
  input: { version: number; reason: string | null },
  at: string = now(),
): CancelledShopOrder {
  const order = lockShopOrder(data, id, input.version);
  if (order.status !== 'confirmed' && order.status !== 'packed') throw stepInvalid();
  // Step 28a: a parcel only booked is cancelled with the order; one booking or with the courier
  // refuses the cancel
  cancelShipments(order, at);
  let salesReturnId: string | null = null;
  if (order.status === 'packed') {
    if (order.deliveryId === null) throw stepInvalid();
    const challan = findDelivery(data, order.deliveryId);
    const draft = saveReturn(data, {
      customerId: challan.customer.id,
      date: dayOf(data, at),
      warehouseId: challan.warehouseId,
      // The return's reasons have no "order cancelled"; the shop order's page says why
      reason: 'other',
      note: null,
      lines: challan.lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        deliveryLineId: line.id,
      })),
    });
    postReturn(data, draft);
    salesReturnId = draft.id;
  }
  const salesOrder = order.salesOrderId === null ? undefined : findOrder(data, order.salesOrderId);
  if (salesOrder) changeOrderStatus(data, salesOrder, 'cancel');
  move(order, 'cancelled', at, { cancelReason: input.reason, salesReturnId });
  return { order, salesReturnId, salesOrderId: salesOrder?.id ?? null };
}

// ---------------------------------------------------------------------------------------------
// Shop settings' delivery charge service (decision 17, settings.service.ts)

// What the select offers: the active services by name, and the saved one even when archived
export function deliveryChoicesOf(data: WorkspaceData): StorefrontSetup['deliveryChoices'] {
  const saved = data.storefront.shop?.deliveryVariantId ?? null;
  return data.catalog.products
    .flatMap((product) => product.variants.map((variant) => ({ product, variant })))
    .filter(
      ({ product, variant }) =>
        variant.id === saved ||
        (product.type === 'service' && product.archivedAt === null && variant.archivedAt === null),
    )
    .toSorted(
      (a, b) =>
        a.product.name.toLowerCase().localeCompare(b.product.name.toLowerCase()) ||
        a.variant.sku.localeCompare(b.variant.sku),
    )
    .slice(0, 200)
    .map(({ product, variant }) => ({
      variantId: variant.id,
      name:
        variant.optionValues.length === 0
          ? product.name
          : `${product.name} — ${variant.optionValues.join(', ')}`,
      sku: variant.sku,
    }));
}

// A new choice must be an active service; the saved one is kept even if archived since. Emptied
// again: refused once a shop order's sales order has a line of the saved one
export function checkDeliveryService(data: WorkspaceData, variantId: string | null): void {
  const saved = data.storefront.shop?.deliveryVariantId ?? null;
  const problem = (code: ErrorCode) => new MockProblem(409, code, { deliveryVariantId: [code] });
  if (variantId === null) {
    if (saved === null) return;
    const used = data.storefront.orders.some((order) =>
      data.salesDocuments.orders.some(
        (salesOrder) =>
          salesOrder.id === order.salesOrderId &&
          salesOrder.lines.some((line) => line.variantId === saved),
      ),
    );
    if (used) throw problem('storefront_delivery_product_required');
    return;
  }
  const found = findVariant(data, variantId);
  if (!found) throw problem('storefront_delivery_product_invalid');
  const archived = found.product.archivedAt !== null || found.variant.archivedAt !== null;
  if (variantId !== saved && (found.product.type !== 'service' || archived)) {
    throw problem('storefront_delivery_product_invalid');
  }
}

// ---------------------------------------------------------------------------------------------
// The seed

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function money(value: string): string {
  return addMoney(value, '0');
}

interface OrderSpec {
  name: string;
  phone: string;
  address: string;
  zone: ShopDeliveryZone;
  lines: { listing: MockListing; quantity: number }[];
  // Minutes ago the code confirmed it; the shopper placed it two minutes before
  confirmed: number;
  // Step 27d: Cash on Delivery unless it says so
  paymentMethod?: ShopPaymentMethod;
}

// The shop's price now (the listing's own, or the variant's, less a running sale)
function priceOf(data: WorkspaceData, listing: MockListing): string {
  const variant = findVariant(data, listing.variantId)?.variant;
  const regular = listing.priceOverride ?? variant?.salePrice ?? '0';
  return money(listingPricing(regular, listing.sale, new Date()).price);
}

function placeOrder(
  data: WorkspaceData,
  number: number,
  spec: OrderSpec,
  warehouseId: string,
): MockShopOrder {
  const shop = data.storefront.shop;
  const lines = spec.lines.map(({ listing, quantity }, index) => {
    const unitPrice = priceOf(data, listing);
    return {
      position: index + 1,
      listingId: listing.id,
      name: listing.name,
      packSize: listing.packSize,
      image: listing.images[0] ?? null,
      productId: listing.productId,
      variantId: listing.variantId,
      quantity,
      unitPrice,
      lineTotal: multiplyMoney(String(quantity), unitPrice),
    };
  });
  const subtotal = sumMoney(lines.map((line) => line.lineTotal));
  // Free from the shop's threshold, else the zone's charge
  const free =
    shop?.freeDeliveryFrom !== null &&
    shop?.freeDeliveryFrom !== undefined &&
    compareMoney(subtotal, shop.freeDeliveryFrom) >= 0;
  const deliveryCharge = free ? '0.0000' : money(spec.zone.charge);
  const confirmed = minutesAgo(spec.confirmed);
  const order: MockShopOrder = {
    id: crypto.randomUUID(),
    orderNo: `W-${String(number).padStart(6, '0')}`,
    status: 'confirmed',
    history: [
      { status: 'pending', at: minutesAgo(spec.confirmed + 2) },
      { status: 'confirmed', at: confirmed },
    ],
    customerName: spec.name,
    phone: spec.phone,
    address: spec.address,
    zoneName: spec.zone.name,
    paymentMethod: spec.paymentMethod ?? 'cod',
    lines,
    subtotal,
    discount: '0.0000',
    couponCode: null,
    deliveryCharge,
    total: money(sumMoney([subtotal, deliveryCharge])),
    warehouseId,
    cancelReason: null,
    salesOrderId: null,
    deliveryId: null,
    invoiceId: null,
    salesReturnId: null,
    documentError: null,
    payments: [],
    shipments: [],
    version: 1,
    updatedAt: confirmed,
  };
  data.storefront.orders.unshift(order);
  return order;
}

// Step 28c: Steadfast Dhaka's last week, for Shop payouts (fixtures.ts → seedsShopPayouts). Four
// Cash on Delivery orders of one attar each, delivered 6 to 2 days ago, each with its COD receipt
// into 1191 Cash with Steadfast. W-000008's money reached the bank 4 days ago: CPO-…-0001, Steadfast's
// SFC-23618228, into the Dutch-Bangla account. W-000009 to W-000011 wait for the next payout, and
// Steadfast has not said W-000011's charge yet. With W-000001's charge (paid online, nothing
// collected), the new payout's list has three cash parcels and one charge-only line
function seedPayoutWeek(
  data: WorkspaceData,
  dhaka: MockCourierAccount,
  attar: MockListing,
  zones: { inside: ShopDeliveryZone; outside: ShopDeliveryZone },
  warehouseId: string,
): void {
  const days = (count: number) => count * 24 * 60;
  const week = [
    {
      spec: {
        name: 'Nasima Akter',
        phone: '01715667788',
        address: 'House 22, Road 11, Banani, Dhaka 1213',
        zone: zones.inside,
      },
      delivered: days(6),
      consignmentId: '148920512',
      trackingCode: 'SFR2611190008',
      courierCharge: '60.0000',
    },
    {
      spec: {
        name: 'Jahid Hasan',
        phone: '01817334455',
        address: 'Flat 3A, Lalmatia Block D, Dhaka 1207',
        zone: zones.inside,
      },
      delivered: days(4),
      consignmentId: '148920688',
      trackingCode: 'SFR2611210019',
      courierCharge: '60.0000',
    },
    {
      spec: {
        name: 'Rumana Chowdhury',
        phone: '01914223344',
        address: 'Road 2, Nasirabad H/S, Chattogram 4209',
        zone: zones.outside,
      },
      delivered: days(3),
      consignmentId: '148920745',
      trackingCode: 'SFR2611220031',
      courierCharge: '130.0000',
    },
    {
      spec: {
        name: 'Imran Kabir',
        phone: '01556112233',
        address: 'House 5, Sector 4, Uttara, Dhaka 1230',
        zone: zones.inside,
      },
      delivered: days(2),
      consignmentId: '148920802',
      trackingCode: 'SFR2611230044',
      courierCharge: null,
    },
  ];
  const sent = week.map((day, index) => {
    const order = placeOrder(
      data,
      8 + index,
      { ...day.spec, lines: [{ listing: attar, quantity: 1 }], confirmed: day.delivered + days(1) },
      warehouseId,
    );
    const at = (minutes: number) =>
      new Date(Date.parse(confirmedAt(order)) + minutes * 60_000).toISOString();
    makeShopSalesOrder(data, order, confirmedAt(order));
    packAsPlanned(data, order, at(90));
    shipShopOrder(data, order.id, order.version, at(180));
    const parcel = seedParcel(
      order,
      dhaka,
      { consignmentId: day.consignmentId, trackingCode: day.trackingCode },
      at(92),
      [
        { status: 'picked_up', at: at(180), note: 'Picked up from Rahman Fashion' },
        { status: 'out_for_delivery', at: at(days(1) - 150), note: null },
      ],
      { collectedAmount: codAmountOf(order), courierCharge: day.courierCharge },
    );
    // Steadfast's delivered notice: the parcel follows, and settleCod makes the COD receipt
    deliverShopOrder(
      data,
      order.id,
      { version: order.version, collectedAmount: null },
      at(days(1)),
    );
    return { order, parcel, day: dayOf(data, at(days(1))) };
  });
  const first = sent[0];
  const bank = data.accounts.find((account) => account.code === '1121');
  if (!first || !bank) return;
  const paidOn = dayOf(data, minutesAgo(days(4)));
  createPayout(
    data,
    {
      accountId: dhaka.id,
      date: paidOn,
      bankAccountId: bank.id,
      reference: 'SFC-23618228',
      note: null,
      lines: [{ shipmentId: first.parcel.id, charge: '60' }],
    },
    minutesAgo(days(4)),
  );
}

// Packed with what the plan suggests: FEFO for a batch line, the first serial numbers in stock for
// a serial one (the seed's packer scans those)
function packAsPlanned(data: WorkspaceData, order: MockShopOrder, at: string): void {
  const plan = packPlanOf(data, order.id);
  packShopOrder(
    data,
    order.id,
    {
      version: order.version,
      lines: plan.lines.map((line, index) => {
        const variantId = order.lines[index]?.variantId ?? '';
        const serials = [...data.stock.serials.entries()]
          .filter(([key, place]) => key.startsWith(`${variantId}|`) && place === order.warehouseId)
          .map(([key]) => key.slice(variantId.length + 1))
          .slice(0, Number(line.quantity));
        return {
          position: line.position,
          picks:
            line.tracking === 'serial'
              ? [{ batchId: null, quantity: line.quantity, serialNumbers: serials }]
              : line.picks,
        };
      }),
      courierAccountId: null,
    },
    at,
  );
}

// Two accessories the shop sells beside its garments, so the Packed dialog has a batch line (an
// attar's lots, with their expiry) and a serial line (a watch's case numbers)
function seedAccessories(data: WorkspaceData, warehouseId: string): MockListing[] {
  const pcs = data.catalog.units.find((unit) => unit.code === 'pcs');
  if (!pcs) return [];
  const accessory = (code: string, name: string, price: string, tracking: 'batch' | 'serial') => {
    const product = saveProduct(
      data.catalog,
      productInputSchema.parse({
        code,
        name,
        type: 'goods',
        categoryId: '',
        description: '',
        baseUnitId: pcs.id,
        salesUnitId: '',
        purchaseUnitId: '',
        tracking,
        hasExpiry: tracking === 'batch',
        taxRateId: '',
        options: [],
        variants: [
          { id: null, sku: '', optionValues: [], barcode: '', salePrice: price, archived: false },
        ],
        units: [],
        customFields: {},
      }),
    );
    data.catalog.products.push(product);
    return product;
  };
  const attar = accessory('ACC-ATTAR', 'Oud attar 6 ml', '650', 'batch');
  const watch = accessory('ACC-WATCH', 'Steel analog wristwatch', '3450', 'serial');
  const [attarVariant] = attar.variants;
  const [watchVariant] = watch.variants;
  if (!attarVariant || !watchVariant) return [];
  const today = todayIn(data.settings.timezone);
  const inDays = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const line = {
    batchId: null,
    lotNumber: null,
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
  };
  // The later lot came in first: FEFO still takes AT-2408 first, because it expires first
  postAdjustment(
    data,
    saveAdjustment(data, {
      date: inDays(-12),
      warehouseId,
      direction: 'in',
      reason: 'opening',
      note: null,
      lines: [
        {
          ...line,
          variantId: attarVariant.id,
          unitId: pcs.id,
          quantity: '10',
          lotNumber: 'AT-2411',
          expiresOn: inDays(200),
          unitCost: '380',
        },
        {
          ...line,
          variantId: attarVariant.id,
          unitId: pcs.id,
          quantity: '2',
          lotNumber: 'AT-2408',
          expiresOn: inDays(80),
          unitCost: '380',
        },
        {
          ...line,
          variantId: watchVariant.id,
          unitId: pcs.id,
          quantity: '4',
          unitCost: '2100',
          serialNumbers: ['SW-7781', 'SW-7782', 'SW-7783', 'SW-7784'],
        },
      ],
    }),
  );
  const category: MockCategory = {
    id: crypto.randomUUID(),
    parentId: null,
    slug: 'accessories',
    name: 'Accessories',
    position: 4,
    version: 1,
    updatedAt: minutesAgo(60 * 24 * 12),
  };
  data.storefront.categories.push(category);
  const listing = (
    product: typeof attar,
    variantId: string,
    packSize: string,
    colour: string,
  ): MockListing => {
    const item: MockListing = {
      id: crypto.randomUUID(),
      productId: product.id,
      variantId,
      categoryId: category.id,
      slug: product.code.toLowerCase(),
      name: product.name,
      packSize,
      priceOverride: null,
      sale: null,
      badges: [],
      images: [seedPhoto(data, product.name, colour, product.name)],
      descriptionSections: [],
      seoTitle: null,
      seoDescription: null,
      publishedAt: minutesAgo(60 * 24 * 12),
      version: 2,
      updatedAt: minutesAgo(60 * 24 * 12),
    };
    data.storefront.listings.push(item);
    return item;
  };
  return [
    listing(attar, attarVariant.id, '6 ml', '#8B471F'),
    listing(watch, watchVariant.id, '40 mm case', '#475467'),
  ];
}

// Step 27d: the online tries of the seeded orders, as the API leaves them, so the order page shows
// each of the Payments card's cases:
// - W-000001 (delivered): paid with bKash; its receipt was the advance its invoice took
// - W-000002 (cancelled): a card refused, then paid by Visa; the money has to go back
// - W-000004 (packed, Cash on Delivery): paid with Nagad after the phone code confirmed it, so the
//   rider must collect nothing and one of the two is refunded
// - W-000006 (new): paid twice in two tabs; the second receipt failed (the money account was
//   archived for a moment) and waits for "Make the receipt"
function seedTries(
  delivered: MockShopOrder,
  cancelled: MockShopOrder,
  packed: MockShopOrder,
  twice: MockShopOrder,
): void {
  const placed = (order: MockShopOrder) => order.history[0]?.at ?? now();
  const later = (at: string, minutes: number) =>
    new Date(Date.parse(at) + minutes * 60_000).toISOString();
  seedTry(delivered, placed(delivered), {
    status: 'paid',
    cardType: 'BKASH-BKash',
    bankTranId: 'BK7XQ2M4PL',
    settledAt: confirmedAt(delivered),
  });
  seedTry(cancelled, placed(cancelled), {
    status: 'failed',
    settledAt: later(placed(cancelled), 1),
  });
  seedTry(cancelled, later(placed(cancelled), 1), {
    status: 'paid',
    cardType: 'VISA-Dutch Bangla',
    bankTranId: '2611120042VD',
    settledAt: confirmedAt(cancelled),
  });
  seedTry(packed, placed(packed), {
    status: 'paid',
    cardType: 'NAGAD-Nagad',
    bankTranId: 'NG73LQ9X0A',
    settledAt: later(confirmedAt(packed), 30),
  });
  seedTry(twice, placed(twice), {
    status: 'paid',
    cardType: 'BKASH-BKash',
    bankTranId: 'BK9TR4C2ZE',
    settledAt: confirmedAt(twice),
  });
  const second = seedTry(twice, placed(twice), {
    status: 'paid',
    cardType: 'BKASH-BKash',
    bankTranId: 'BK9TR4C3WD',
    settledAt: confirmedAt(twice),
  });
  second.receiptError = 'receipt_account_invalid';
}

// Rahman Fashion's orders: one delivered (its invoice waits for the rider's cash), one cancelled
// before packing, one on its way, one packed, and three new ones. Of the new ones, W-000005 has a
// line of each kind for the Packed dialog (a batch, a serial, an untracked polo), W-000006 is a
// small one to cancel, and W-000007's sales order was refused when it was confirmed (the T-shirt
// was archived for a moment); it is active again, so "Make the sales order" works. Farhana Islam
// ordered twice: one customer in the ERP. Step 28c: `payouts` adds Steadfast Dhaka's last week
// (seedPayoutWeek)
export function seedShopOrders(data: WorkspaceData, payouts = false): void {
  const shop = data.storefront.shop;
  const warehouseId = shop?.defaultWarehouseId ?? null;
  const [inside, outside] = shop?.deliveryZones ?? [];
  if (shop === null || warehouseId === null || !inside || !outside) return;
  // Step 27d: the shop was paid online, so its SSLCommerz store is saved (before the orders: their
  // receipts go to its money account)
  seedGateway(data, minutesAgo(13 * 24 * 60));
  const [attar, watch] = seedAccessories(data, warehouseId);
  const bySlug = (slug: string) => data.storefront.listings.find((item) => item.slug === slug);
  const poloM = bySlug('pique-polo-navy-m');
  const poloL = bySlug('pique-polo-navy-l');
  const tee = bySlug('basic-crew-neck-t-shirt');
  if (!attar || !watch || !poloM || !poloL || !tee) return;

  const farhana = {
    name: 'Farhana Islam',
    phone: '01711223344',
    address: 'House 7, Road 3, Dhanmondi, Dhaka 1205',
  };
  const hours = (count: number) => count * 60;
  const days = (count: number) => count * 24 * 60;
  const specs: OrderSpec[] = [
    {
      ...farhana,
      zone: inside,
      lines: [{ listing: poloM, quantity: 2 }],
      confirmed: days(9),
      paymentMethod: 'online',
    },
    {
      name: 'Sabbir Hossain',
      phone: '01819556677',
      address: 'Flat 4B, Block C, Mirpur 10, Dhaka 1216',
      zone: inside,
      lines: [{ listing: tee, quantity: 1 }],
      confirmed: days(7),
      paymentMethod: 'online',
    },
    {
      name: 'Tanvir Ahmed',
      phone: '01913445566',
      address: 'Road 5, Agrabad C/A, Chattogram 4100',
      zone: outside,
      lines: [
        { listing: poloL, quantity: 1 },
        { listing: tee, quantity: 2 },
      ],
      confirmed: days(2),
    },
    {
      name: 'Mitu Akter',
      phone: '01552334455',
      address: 'House 12, Sector 7, Uttara, Dhaka 1230',
      zone: inside,
      lines: [{ listing: tee, quantity: 3 }],
      confirmed: days(1),
    },
    {
      ...farhana,
      zone: inside,
      lines: [
        { listing: attar, quantity: 3 },
        { listing: watch, quantity: 1 },
        { listing: poloM, quantity: 2 },
      ],
      confirmed: hours(3),
    },
    {
      name: 'Rakib Hasan',
      phone: '01611889900',
      address: 'Lane 2, Khulshi, Chattogram 4209',
      zone: outside,
      lines: [{ listing: poloL, quantity: 1 }],
      confirmed: 50,
      paymentMethod: 'online',
    },
    {
      name: 'Shirin Sultana',
      phone: '01712990011',
      address: 'Block D, Road 8, Bashundhara R/A, Dhaka 1229',
      zone: inside,
      lines: [{ listing: tee, quantity: 2 }],
      confirmed: 20,
    },
  ];
  const orders = specs.map((spec, index) => placeOrder(data, index + 1, spec, warehouseId));
  const [delivered, cancelled, shipped, packed, , twice, refused] = orders;
  if (!delivered || !cancelled || !shipped || !packed || !twice || !refused) return;
  seedTries(delivered, cancelled, packed, twice);
  // The handler made each sales order when the code confirmed the order, except W-000007's
  for (const order of orders) {
    if (order === refused) continue;
    makeShopSalesOrder(data, order, confirmedAt(order));
  }
  refused.documentError = 'sales_item_invalid';
  const after = (order: MockShopOrder, minutes: number) =>
    new Date(Date.parse(confirmedAt(order)) + minutes * 60_000).toISOString();

  packAsPlanned(data, delivered, after(delivered, 90));
  shipShopOrder(data, delivered.id, delivered.version, after(delivered, 180));
  deliverShopOrder(
    data,
    delivered.id,
    { version: delivered.version, collectedAmount: null },
    after(delivered, days(1)),
  );
  cancelShopOrder(
    data,
    cancelled.id,
    { version: cancelled.version, reason: 'The shopper did not answer the phone' },
    after(cancelled, 45),
  );
  packAsPlanned(data, shipped, after(shipped, 120));
  shipShopOrder(data, shipped.id, shipped.version, after(shipped, 240));
  packAsPlanned(data, packed, after(packed, 200));

  // Step 28a: the shop's couriers, and the parcels Steadfast Dhaka carried: W-000001 to the door,
  // W-000003 on its way to Chattogram. W-000004 waits for Book courier (or the export)
  const [dhaka] = seedCouriers(data, minutesAgo(13 * 24 * 60));
  if (!dhaka) return;
  seedParcel(
    delivered,
    dhaka,
    { consignmentId: '148920107', trackingCode: 'SFR2611140017' },
    after(delivered, 92),
    [
      { status: 'picked_up', at: after(delivered, 180), note: 'Picked up from Rahman Fashion' },
      { status: 'in_transit', at: after(delivered, 300), note: 'At the Dhanmondi hub' },
      { status: 'out_for_delivery', at: after(delivered, days(1) - 150), note: null },
      { status: 'delivered', at: after(delivered, days(1)), note: null },
    ],
    // Step 28b: paid online, so the rider collected nothing; Steadfast's charge inside Dhaka
    { collectedAmount: '0.0000', courierCharge: '60.0000' },
  );
  seedParcel(
    shipped,
    dhaka,
    { consignmentId: '148920331', trackingCode: 'SFR2611210042' },
    after(shipped, 122),
    [
      { status: 'picked_up', at: after(shipped, 240), note: 'Picked up from Rahman Fashion' },
      { status: 'in_transit', at: after(shipped, 600), note: 'Reached the Chattogram hub' },
    ],
    // Step 28b: outside Dhaka, Steadfast charges more; nothing collected yet
    { collectedAmount: null, courierCharge: '130.0000' },
  );
  if (payouts) seedPayoutWeek(data, dhaka, attar, { inside, outside }, warehouseId);

  // The bell of the newest order that is not refused, unread (27a's handler rings it)
  const newest = orders[5];
  if (newest) {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'storefront.order_confirmed',
      params: { id: newest.id, number: newest.orderNo, total: newest.total },
      readAt: null,
      createdAt: confirmedAt(newest),
    });
  }
}
