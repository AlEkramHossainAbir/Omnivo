import {
  addQuantity,
  compareQuantity,
  type DocumentRef,
  type ErrorCode,
  fitsDecimals,
  type GoodsReceipt,
  type GoodsReceiptInput,
  type GoodsReceiptLine,
  type GoodsReceiptLineInput,
  isQuantity,
  isWholeQuantity,
  isZeroQuantity,
  negateMoney,
  type PartyRef,
  prorateMoney,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderLineInput,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type RequisitionLineRef,
  shiftIsoDate,
  type StockDocumentStatus,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  todayIn,
  wholeCount,
  withTolerance,
} from '@omnivo/contracts';

import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import { assertWarehouse, endPendingRound, historyOf, submitRound } from './requisition-data';
import {
  fieldProblem,
  newestFirst,
  now,
  ratesOf,
  type ResolvedLine,
  resolveSalesLines,
  seriesNumber,
  totalsOf,
} from './sales-document-data';
import {
  assertDate,
  assertWarehouses,
  batchesForLots,
  bookAccounts,
  branchOf,
  decimalsOf,
  findVariant,
  issuesError,
  postMoves,
  refOf,
} from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 17b: purchase orders and goods receipts. The API's rules
// (purchase-orders.service.ts, goods-receipts.service.ts) on plain arrays, shortened, so
// `pnpm dev:mock` and the e2e tests walk the same paths as the real API. An order is priced with
// the sales line arithmetic (resolveSalesLines(), decision 6) and approved by the 17a engine
// (requisition-data.ts): the mock signs in as the Owner, so a submitted order is approved at once.
// A posted receipt moves stock in at the order's price and books Dr Inventory / Cr Goods received
// not billed, like a stock adjustment (stock-data.ts).

// An order as stored. "Partly received", its line count, its requisitions, its receipts and its
// approval history are worked out on read, like the API's subqueries.
export type MockPurchaseOrder = Omit<
  PurchaseOrder,
  'partlyReceived' | 'lineCount' | 'requisitions' | 'receipts' | 'approval'
>;

// A receipt as stored, with its order's id: the order's number is looked up on read, like a
// delivery's order
export type MockGoodsReceipt = Omit<GoodsReceipt, 'order' | 'lineCount'> & { orderId: string };

function conflict(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}

// 'purchase.order' at an order's first submit, 'inventory.receipt' when a receipt is posted
function nextNumber(data: WorkspaceData, series: 'order' | 'receipt', date: string): string {
  data.purchase.counters[series] += 1;
  return seriesNumber(
    data,
    series === 'order' ? 'purchase.order' : 'inventory.receipt',
    data.purchase.counters[series],
    date,
  );
}

// A document's status, with a new version: a page open somewhere must reload before its next action
function moveTo(target: MockPurchaseOrder, status: PurchaseOrderStatus): void {
  Object.assign(target, { status, version: target.version + 1, updatedAt: now() });
}

// --- Purchase orders, read ----------------------------------------------------------------------

export function findPurchaseOrder(data: WorkspaceData, id: string): MockPurchaseOrder {
  const found = data.purchase.orders.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function anythingReceived(order: MockPurchaseOrder): boolean {
  return order.lines.some((line) => !isZeroQuantity(line.receivedQuantity));
}

// Approved, with a goods line that has not all come in: what the goods receipt form offers. An
// order of services only is never received (the bill takes it, 17c).
function goodsToReceive(order: MockPurchaseOrder): boolean {
  return (
    order.status === 'approved' &&
    order.lines.some(
      (line) =>
        line.productType === 'goods' &&
        compareQuantity(line.receivedQuantity, line.baseQuantity) < 0,
    )
  );
}

export function purchaseOrderSummaryOf(stored: MockPurchaseOrder): PurchaseOrderSummary {
  return {
    id: stored.id,
    number: stored.number,
    date: stored.date,
    expectedDate: stored.expectedDate,
    supplier: stored.supplier,
    supplierReference: stored.supplierReference,
    warehouseId: stored.warehouseId,
    status: stored.status,
    partlyReceived: stored.status === 'approved' && anythingReceived(stored),
    net: stored.net,
    vat: stored.vat,
    total: stored.total,
    lineCount: stored.lines.length,
    version: stored.version,
    updatedAt: stored.updatedAt,
  };
}

export function toPurchaseOrder(data: WorkspaceData, stored: MockPurchaseOrder): PurchaseOrder {
  // The requisitions its lines buy for, once each, in line order
  const requisitions = new Map<string, DocumentRef>();
  for (const line of stored.lines) {
    const link = line.requisitionLine;
    if (link) requisitions.set(link.requisitionId, { id: link.requisitionId, number: link.number });
  }
  return {
    ...stored,
    ...purchaseOrderSummaryOf(stored),
    requisitions: [...requisitions.values()],
    // Drafts too, oldest first: the order page lists every receipt made against it
    receipts: data.purchase.receipts
      .filter((item) => item.orderId === stored.id)
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({ id: item.id, number: item.number, date: item.date, status: item.status })),
    approval: historyOf(data, 'purchase_order', stored.id),
  };
}

// Newest date first, like the API; the filters are the list's own
export function listPurchaseOrders(
  data: WorkspaceData,
  query: {
    status?: PurchaseOrderStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    receipt?: PurchaseOrderReceiptFilter | undefined;
  },
): MockPurchaseOrder[] {
  return newestFirst(
    data.purchase.orders.filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
        (query.receipt === undefined || goodsToReceive(item)),
    ),
  );
}

// --- Purchase orders, written -------------------------------------------------------------------

// An active supplier. A draft keeps its supplier (keptId) even after the supplier is archived, like
// the API's assertSupplier(), so the person can still finish it.
function supplierOf(data: WorkspaceData, supplierId: string, keptId: string | null): PartyRef {
  const found = data.suppliers.suppliers.find((item) => item.id === supplierId);
  if (!found || (found.archivedAt !== null && found.id !== keptId)) {
    throw fieldProblem('purchase_supplier_invalid', 'supplierId');
  }
  return { id: found.id, code: found.code, name: found.name };
}

// The requisition lines the order's lines buy for (decision 16): a line of an approved requisition
// for this order's warehouse, for the same item. A link the draft already had (keptIds) may stay
// after its requisition was closed. Returns each line's link, in line order.
function requisitionLinks(
  data: WorkspaceData,
  input: { warehouseId: string; lines: readonly PurchaseOrderLineInput[] },
  resolved: readonly ResolvedLine[],
  keptIds: ReadonlySet<string>,
): (RequisitionLineRef | null)[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const links = input.lines.map((line, index): RequisitionLineRef | null => {
    const id = line.requisitionLineId;
    if (id === null) return null;
    const requisition = data.purchase.requisitions.find((item) =>
      item.lines.some((candidate) => candidate.id === id),
    );
    const found = requisition?.lines.find((candidate) => candidate.id === id);
    const open =
      requisition?.status === 'approved' || (requisition?.status === 'closed' && keptIds.has(id));
    if (
      !requisition ||
      !open ||
      requisition.warehouseId !== input.warehouseId ||
      found?.variantId !== resolved[index]?.line.variantId
    ) {
      issues.push({
        path: `lines.${String(index)}.requisitionLineId`,
        code: 'purchase_requisition_line_invalid',
      });
      return null;
    }
    return { id, requisitionId: requisition.id, number: requisition.number };
  });
  if (issues.length > 0) throw issuesError(issues);
  return links;
}

// Create (no `existing`: a draft without a number, decision 13) or change a draft. A numbered
// draft (reopened) keeps its supplier: its number was given to that supplier.
export function savePurchaseOrder(
  data: WorkspaceData,
  input: PurchaseOrderInput,
  existing?: MockPurchaseOrder,
): MockPurchaseOrder {
  if (existing && existing.status !== 'draft') throw conflict('purchase_not_draft');
  const supplier = supplierOf(data, input.supplierId, existing?.supplier.id ?? null);
  if (existing && existing.number !== null && supplier.id !== existing.supplier.id) {
    throw fieldProblem('purchase_supplier_invalid', 'supplierId');
  }
  assertWarehouse(data, input.warehouseId, existing?.warehouseId ?? null);
  // The order's own "prices include VAT" (decision 15), and purchase_item_invalid for an item
  const resolved = resolveSalesLines(
    data,
    input.lines,
    input.pricesIncludeVat,
    existing ? ratesOf(existing.lines) : new Set(),
    new Set(),
    'purchase_item_invalid',
  );
  const kept = new Set(existing?.lines.flatMap((line) => line.requisitionLine?.id ?? []));
  const links = requisitionLinks(data, input, resolved, kept);
  const fields = {
    date: input.date,
    expectedDate: input.expectedDate,
    supplier,
    supplierReference: input.supplierReference,
    warehouseId: input.warehouseId,
    paymentTermsDays: input.paymentTermsDays,
    pricesIncludeVat: input.pricesIncludeVat,
    note: input.note,
    ...totalsOf(resolved),
    lines: resolved.map((item, index) => ({
      ...item.line,
      requisitionLine: links[index] ?? null,
      receivedQuantity: '0.0000',
      rejectedQuantity: '0.0000',
    })),
    updatedAt: now(),
  };
  if (existing) {
    Object.assign(existing, fields, { version: existing.version + 1 });
    return existing;
  }
  const created: MockPurchaseOrder = {
    ...fields,
    id: crypto.randomUUID(),
    number: null,
    status: 'draft',
    version: 1,
  };
  data.purchase.orders.unshift(created);
  return created;
}

// Only a draft that was never submitted: once numbered it is cancelled instead (decision 13)
export function removePurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  if (target.number !== null) throw conflict('purchase_was_submitted');
  data.purchase.orders = data.purchase.orders.filter((item) => item.id !== target.id);
}

// Numbered the first time, then sent for approval with its total, VAT included (decision 14). A
// supplier or warehouse archived while it was a draft stops it here. Returns how many steps its
// round has.
export function submitPurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): number {
  if (target.status !== 'draft') throw conflict('purchase_not_draft');
  supplierOf(data, target.supplier.id, null);
  assertWarehouse(data, target.warehouseId, null);
  target.number ??= nextNumber(data, 'order', target.date);
  const steps = submitRound(data, 'purchase_order', { id: target.id, amount: target.total });
  moveTo(target, 'approved');
  return steps;
}

// A posted receipt: some came in, so the order is closed, not reopened or cancelled. A draft one:
// the store keeper deletes it first (decision 21).
function assertNoReceipt(data: WorkspaceData, orderId: string): void {
  const receipts = data.purchase.receipts.filter((item) => item.orderId === orderId);
  if (receipts.some((item) => item.status === 'posted')) throw conflict('purchase_close_instead');
  if (receipts.length > 0) throw conflict('purchase_receipt_draft');
}

// Pending: taken back to change it. Approved: changed after all, and approved again from the first
// level (decision 11).
export function reopenPurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'pending' && target.status !== 'approved') {
    throw conflict('purchase_cannot_reopen');
  }
  assertNoReceipt(data, target.id);
  if (target.status === 'pending') endPendingRound(data, 'purchase_order', target.id);
  moveTo(target, 'draft');
}

// Partly received, and the rest will not come
export function closePurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'approved') throw conflict('purchase_not_approved');
  const posted = data.purchase.receipts.some(
    (item) => item.orderId === target.id && item.status === 'posted',
  );
  if (!posted) throw conflict('purchase_cancel_instead');
  moveTo(target, 'closed');
}

// Will not be bought: a draft that was submitted once, or an approved order before any receipt
export function cancelPurchaseOrder(data: WorkspaceData, target: MockPurchaseOrder): void {
  if (target.status !== 'draft' && target.status !== 'approved') {
    throw conflict('purchase_cannot_cancel');
  }
  if (target.number === null) throw conflict('purchase_delete_instead');
  assertNoReceipt(data, target.id);
  moveTo(target, 'cancelled');
}

// --- Goods receipts, read -----------------------------------------------------------------------

export function findGoodsReceipt(data: WorkspaceData, id: string): MockGoodsReceipt {
  const found = data.purchase.receipts.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toGoodsReceipt(data: WorkspaceData, stored: MockGoodsReceipt): GoodsReceipt {
  const { orderId, ...receipt } = stored;
  const order = data.purchase.orders.find((item) => item.id === orderId);
  return {
    ...receipt,
    order: { id: orderId, number: order?.number ?? null },
    lineCount: stored.lines.length,
  };
}

export function listGoodsReceipts(
  data: WorkspaceData,
  query: {
    status?: StockDocumentStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    orderId?: string | undefined;
  },
): GoodsReceipt[] {
  return newestFirst(data.purchase.receipts)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.supplierId === undefined || item.supplier.id === query.supplierId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId) &&
        (query.orderId === undefined || item.orderId === query.orderId),
    )
    .map((item) => toGoodsReceipt(data, item));
}

// --- Goods receipts, written --------------------------------------------------------------------

// The order a receipt takes goods against: approved (decision 8). Reopened, received, closed or
// cancelled since the page was opened, it is not waiting for goods any more.
function receivingOrder(data: WorkspaceData, orderId: string): MockPurchaseOrder {
  const order = data.purchase.orders.find((item) => item.id === orderId);
  if (!order) throw fieldProblem('grn_order_invalid', 'orderId');
  if (order.status !== 'approved') throw fieldProblem('purchase_not_approved', 'orderId');
  return order;
}

type ReceiptLineInput = Omit<GoodsReceiptLineInput, 'batchId'>;

// The API's resolveReceiptLines(): like an "in" stock line, with two differences. The accepted
// quantity may be zero (everything that came was turned back), and then nothing comes in: no lot,
// no serial numbers. The rejected quantity is checked against the same unit, and keeps its reason
// only when something was turned back. Every problem at once, each under its own field.
function resolveReceiptLines(
  data: WorkspaceData,
  lines: readonly ReceiptLineInput[],
): GoodsReceiptLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index): GoodsReceiptLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, input.variantId);
    // Goods only: a service is never received. Archived: nothing new comes in.
    if (
      found?.product.type !== 'goods' ||
      found.product.archivedAt !== null ||
      found.variant.archivedAt !== null
    ) {
      at('variantId', 'stock_variant_invalid');
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
    // In the base unit; zero stays zero, and a quantity that rounds to nothing is a typing mistake
    const inBase = (quantity: string, field: string): string | null => {
      if (isZeroQuantity(quantity)) return '0.0000';
      if (!fitsDecimals(quantity, decimalsOf(data, input.unitId))) {
        at(field, 'stock_quantity_decimals');
        return null;
      }
      const base = toBaseQuantity(quantity, factor, decimalsOf(data, product.baseUnitId));
      if (!isQuantity(base)) {
        at(field, 'quantity_format');
        return null;
      }
      return base;
    };
    const baseQuantity = inBase(input.quantity, 'quantity');
    const rejectedBaseQuantity = inBase(input.rejectedQuantity, 'rejectedQuantity');
    if (baseQuantity === null || rejectedBaseQuantity === null) return [];
    const accepting = !isZeroQuantity(baseQuantity);
    const lot = product.tracking === 'batch' && accepting ? input.lotNumber : null;
    if (product.tracking === 'batch' && accepting && lot === null) {
      at('lotNumber', 'stock_lot_required');
      return [];
    }
    // One serial number per base unit accepted: a rejected machine does not come in
    const serialNumbers = product.tracking === 'serial' ? input.serialNumbers : [];
    if (
      product.tracking === 'serial' &&
      (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== serialNumbers.length)
    ) {
      at('serialNumbers', 'stock_serial_count');
      return [];
    }
    return [
      {
        ...refOf(product, variant),
        id: crypto.randomUUID(),
        tracking: product.tracking,
        hasExpiry: product.hasExpiry,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: input.unitId,
        // "600" → "600.0000": the way Postgres sends NUMERIC(19,4)
        quantity: addQuantity(input.quantity, '0'),
        baseQuantity,
        batchId: null,
        lotNumber: lot,
        expiresOn: lot === null ? null : input.expiresOn,
        manufacturedOn: lot === null ? null : input.manufacturedOn,
        serialNumbers,
        orderLineId: input.orderLineId,
        rejectedQuantity: addQuantity(input.rejectedQuantity, '0'),
        rejectedBaseQuantity,
        rejectionReason: isZeroQuantity(rejectedBaseQuantity) ? null : input.rejectionReason,
        value: null,
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

// Each line receives a line of this order, for the same variant, and the lines together never
// bring in more than the order line still takes: ordered × (100 + the workspace's percent) ÷ 100,
// less what posted receipts accepted (decisions 7 and 22). What was rejected does not count: it
// did not come in. Drafts hold nothing, so the second of two drafts to post is refused here.
function checkOrderLines(
  data: WorkspaceData,
  order: MockPurchaseOrder,
  lines: readonly GoodsReceiptLine[],
): void {
  const issues: { path: string; code: ErrorCode }[] = [];
  const taken = new Map<string, string[]>();
  lines.forEach((line, index) => {
    const orderLine = order.lines.find((item) => item.id === line.orderLineId);
    if (orderLine?.variantId !== line.variantId) {
      issues.push({ path: `lines.${String(index)}.orderLineId`, code: 'grn_order_line_invalid' });
      return;
    }
    taken.set(line.orderLineId, [...(taken.get(line.orderLineId) ?? []), line.baseQuantity]);
  });
  for (const [orderLineId, quantities] of taken) {
    const orderLine = order.lines.find((item) => item.id === orderLineId);
    if (!orderLine) continue;
    const most = withTolerance(orderLine.baseQuantity, data.settings.overReceiptPercent);
    const after = sumQuantity([orderLine.receivedQuantity, ...quantities]);
    if (compareQuantity(after, most) <= 0) continue;
    // Under every line that takes from it: the person decides which one to cut
    lines.forEach((line, index) => {
      if (line.orderLineId === orderLineId) {
        issues.push({ path: `lines.${String(index)}.quantity`, code: 'grn_over_order' });
      }
    });
  }
  if (issues.length > 0) throw issuesError(issues);
}

type ReceiptFields = Omit<GoodsReceiptInput, 'post' | 'orderId'>;

// Create (no `existing`) or change a draft. A receipt keeps its order (decision 20) and the order's
// supplier, never one the form sends.
export function saveGoodsReceipt(
  data: WorkspaceData,
  orderId: string,
  input: ReceiptFields,
  existing?: MockGoodsReceipt,
): MockGoodsReceipt {
  if (existing && existing.status !== 'draft') throw conflict('stock_not_draft');
  const order = receivingOrder(data, orderId);
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const lines = resolveReceiptLines(data, input.lines);
  checkOrderLines(data, order, lines);
  const saved: MockGoodsReceipt = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    supplier: order.supplier,
    orderId: order.id,
    warehouseId: input.warehouseId,
    status: 'draft',
    supplierChallan: input.supplierChallan,
    vehicle: input.vehicle,
    note: input.note,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines,
    entry: null,
  };
  const { receipts } = data.purchase;
  data.purchase.receipts = existing
    ? receipts.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...receipts];
  return saved;
}

// A draft, even one of an order that was closed since: it brought nothing in
export function removeGoodsReceipt(data: WorkspaceData, target: MockGoodsReceipt): void {
  if (target.status !== 'draft') throw conflict('stock_not_draft');
  data.purchase.receipts = data.purchase.receipts.filter((item) => item.id !== target.id);
}

// What the posted lines accepted and turned back, onto their order lines; when every goods line
// has all it ordered, the order is received. A service line never holds the order open.
function receiveOnOrder(order: MockPurchaseOrder, lines: readonly GoodsReceiptLine[]): void {
  for (const line of lines) {
    const orderLine = order.lines.find((item) => item.id === line.orderLineId);
    if (!orderLine) continue;
    orderLine.receivedQuantity = addQuantity(orderLine.receivedQuantity, line.baseQuantity);
    orderLine.rejectedQuantity = addQuantity(orderLine.rejectedQuantity, line.rejectedBaseQuantity);
  }
  const done = order.lines.every(
    (line) =>
      line.productType !== 'goods' ||
      compareQuantity(line.receivedQuantity, line.baseQuantity) >= 0,
  );
  // A new version either way: an order page open somewhere shows old received quantities
  Object.assign(order, {
    ...(done && { status: 'received' }),
    version: order.version + 1,
    updatedAt: now(),
  });
}

// The API's postAndLog(): the date, the warehouse and the order checked again, the lines checked
// against what the order still takes, the number taken, the accepted goods moved in at the order's
// price, the entry booked and the order's lines counted.
export function postGoodsReceipt(data: WorkspaceData, draft: MockGoodsReceipt): MockGoodsReceipt {
  if (draft.status !== 'draft') throw conflict('stock_not_draft');
  assertDate(data, draft.date);
  if (data.journal.lockDate !== null && draft.date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
  assertWarehouses(data, [{ field: 'warehouseId', id: draft.warehouseId }]);
  const order = receivingOrder(data, draft.orderId);
  // Again: another receipt of this order may have been posted since this one was saved
  checkOrderLines(data, order, draft.lines);
  // The accounts first: a missing one refuses the posting before anything moves
  const accounts = bookAccounts(data);
  const notBilled = accounts.use('received_not_billed');
  const lines = batchesForLots(data, draft.lines);
  // At the order's price (decision 2): the line's net, after its discount and before VAT, shared
  // by what came in. 600 of 1,000 gross worth ৳62,000 are worth ৳37,200.
  const values = lines.map((line) => {
    const orderLine = order.lines.find((item) => item.id === line.orderLineId);
    return orderLine ? prorateMoney(orderLine.net, line.baseQuantity, orderLine.baseQuantity) : '0';
  });
  // The handler runs this in transaction() (workspace-data.ts): a refused posting gives everything
  // back, the number and any new batch too, like the API's transaction
  const number = nextNumber(data, 'receipt', draft.date);
  postMoves(
    data,
    { date: draft.date, kind: 'purchase_receipt', direction: 'in', documentId: draft.id, number },
    // Only what was accepted comes in. A line that turned everything back moves nothing.
    lines.flatMap((line, index) =>
      isZeroQuantity(line.baseQuantity)
        ? []
        : [
            {
              line: index,
              warehouseId: draft.warehouseId,
              stockLine: line,
              batchId: line.batchId,
              quantity: line.baseQuantity,
              serialNumbers: line.serialNumbers,
              value: values[index] ?? '0',
            },
          ],
    ),
  );
  const total = sumMoney(values);
  const branchId = branchOf(data, draft.warehouseId);
  // Nothing when the accepted goods cost nothing (postStockEntry writes no entry for zero)
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'purchase_receipt',
    document: { id: draft.id, number },
    narration: `Goods receipt ${number}`,
    amounts: [
      { accountId: accounts.inventory, branchId, amount: total },
      { accountId: notBilled, branchId, amount: negateMoney(total) },
    ],
  });
  Object.assign(draft, {
    lines: lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
    entry,
    number,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  receiveOnOrder(order, draft.lines);
  return draft;
}

// --- Seed ---------------------------------------------------------------------------------------

// The garments workspace's orders (after the requisitions: the rounds name the same people). The
// requisitions stay as 17a seeded them, so PR-…-0002 still waits for its order.
//   PO-…-0001 1,000 gross of buttons from Unitex (৳71,300 with VAT): Sadia wrote it, Kamal approved
//             it as purchase manager, and the goods are two days late. Nothing came in yet.
//   a draft   the Owner's, for 500 m of jersey from Meghna Spinning Mills, never submitted
// No receipt is posted: the seeded books (reports, journal, stock values) stay as they were.
export function seedPurchaseOrders(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const [main] = data.stock.warehouses;
  const unitex = data.suppliers.suppliers.find((item) => item.name.startsWith('Unitex'));
  const meghna = data.suppliers.suppliers.find((item) => item.name.startsWith('Meghna'));
  const rate = data.sales.taxRates.find((item) => item.isDefault);
  const manager = data.people.roles.find((item) => item.name === 'Purchase manager');
  const person = (name: string) => {
    const found = data.people.members.find((member) => member.fullName === name);
    if (!found) throw new Error(`The mock has no member ${name}`);
    return { id: found.userId, name: found.fullName };
  };
  if (!main || !unitex || !meghna || !rate || !manager) return;
  const today = todayIn(data.settings.timezone);
  const daysAgo = (days: number, hour: number) => {
    const moment = new Date(Date.now() - days * 86_400_000);
    moment.setHours(hour, 0, 0, 0);
    return moment.toISOString();
  };
  // A line of the product's first variant, in a unit by its code, at a price per that unit
  const line = (code: string, unitCode: string, quantity: string, unitPrice: string) => {
    const product = data.catalog.products.find((item) => item.code === code);
    const unit = data.catalog.units.find((item) => item.code === unitCode);
    const variant = product?.variants[0];
    if (!variant || !unit) throw new Error(`The mock catalog has no ${code} in ${unitCode}`);
    return {
      variantId: variant.id,
      unitId: unit.id,
      quantity,
      description: null,
      unitPrice,
      discountType: 'percent' as const,
      discount: '0',
      taxRateId: rate.id,
      requisitionLineId: null,
    };
  };

  const buttons = savePurchaseOrder(data, {
    supplierId: unitex.id,
    date: shiftIsoDate(today, -12),
    expectedDate: shiftIsoDate(today, -2),
    warehouseId: main.id,
    supplierReference: 'PI-UT-2026-0412',
    paymentTermsDays: unitex.paymentTermsDays,
    pricesIncludeVat: false,
    note: 'Black, 18L, packed 10 gross to a carton. Gate 2, 9 am to 5 pm.',
    lines: [line('P-00003', 'gross', '1000', '62')],
  });
  const sadia = person('Sadia Islam');
  const decidedAt = daysAgo(11, 10);
  data.purchase.rounds.push({
    id: crypto.randomUUID(),
    document: 'purchase_order',
    documentId: buttons.id,
    status: 'approved',
    amount: buttons.total,
    submittedBy: sadia,
    submittedAt: daysAgo(12, 11),
    closedAt: decidedAt,
    steps: [
      {
        position: 1,
        minAmount: '50000.0000',
        role: { id: manager.id, name: manager.name },
        decision: 'approved',
        decidedBy: person('Kamal Uddin'),
        decidedAt,
        comment: 'Same price as the last order',
      },
    ],
  });
  Object.assign(buttons, {
    number: nextNumber(data, 'order', buttons.date),
    status: 'approved',
  });

  savePurchaseOrder(data, {
    supplierId: meghna.id,
    date: today,
    expectedDate: shiftIsoDate(today, 14),
    warehouseId: main.id,
    supplierReference: null,
    paymentTermsDays: meghna.paymentTermsDays,
    pricesIncludeVat: false,
    note: null,
    lines: [line('P-00002', 'm', '500', '510')],
  });
}
