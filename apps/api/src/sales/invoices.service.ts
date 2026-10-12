import { Inject, Injectable } from '@nestjs/common';
import {
  billableQuantity,
  compareQuantity,
  documentTotals,
  dueDateOf,
  type ErrorCode,
  type Invoice,
  type InvoiceInput,
  type InvoiceLineInput,
  type InvoicePaymentFilter,
  type InvoiceStatus,
  type InvoiceSummary,
  isQuantity,
  type PartyRef,
  sumQuantity,
  toBaseQuantity,
  todayIn,
  type UpdateInvoiceInput,
} from '@omnivo/contracts';
import {
  creditNotes,
  deliveries,
  deliveryLines,
  invoiceLines,
  invoices,
  parties,
  products,
  receiptAllocations,
  receipts,
  salesOrderLines,
  salesOrders,
  salesReturnLines,
  salesReturns,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineInput,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  resolveLines,
  type VariantInfo,
} from '../inventory/stock-lines.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { CreditService } from './credit.service.js';
import { DeliveriesService } from './deliveries.service.js';
import { SalesBooksService } from './sales-books.service.js';
import {
  assertBranch,
  assertCustomer,
  billingAddressOf,
  customerRefs,
  pricesIncludeVatNow,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM invoice_lines l
   WHERE l.tenant_id = invoices.tenant_id AND l.invoice_id = invoices.id
)`;

// Posted and not settled in full by receipts and credit notes (step 15d): what a receipt or a
// credit note can still be applied to. The same condition as the two partial indexes
// (invoices_open_customer_idx, invoices_open_due_idx), so they are used.
const isOpen = sql`${invoices.status} = 'posted' AND ${invoices.amountPaid} + ${invoices.amountCredited} < ${invoices.total}`;

// What a line bills, once checked: a challan line (with the order line behind it, if any), an
// order's service line, or neither (a line of its own)
interface LineSource {
  deliveryLineId: string | null;
  orderLineId: string | null;
}

// What checkSources() found, for the save and the posting
interface Sources {
  lines: LineSource[];
  // The prices-with-VAT setting of the orders behind the lines; null when no line has an order
  pricesIncludeVat: boolean | null;
  // What the lines bill stays billable after it is archived: the goods already left, the service
  // was already ordered
  keptVariantIds: Set<string>;
  keptRateIds: Set<string>;
}

// What a line names, as the form sends it and as the database keeps it
interface LineRefs {
  deliveryLineId: string | null;
  orderLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'sales_not_draft',
    'Only a draft invoice can be changed. A posted one is corrected by a credit note.',
  );
}

function toSummary(row: InvoiceRow, customer: PartyRef, lines: number): InvoiceSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    dueDate: row.dueDate,
    customer,
    customerReference: row.customerReference,
    branchId: row.branchId,
    status: row.status,
    net: row.net,
    vat: row.vat,
    total: row.total,
    amountPaid: row.amountPaid,
    amountCredited: row.amountCredited,
    creditNoteTotal: row.creditNoteTotal,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A goods line of its own as the challan the invoice makes takes it
function stockLineOf(line: InvoiceLineInput | InvoiceLineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: [...line.serialNumbers],
  };
}

// What a line comes to in its item's base unit (step 15d: a challan line is billed by its base
// quantity, in any unit of the item). null when the unit is not one of the item's: the line is then
// refused as not matching its challan line.
function baseQuantityOf(
  line: { unitId: string; quantity: string },
  variant: VariantInfo | undefined,
): string | null {
  if (variant === undefined || !isQuantity(line.quantity)) return null;
  const factor =
    line.unitId === variant.baseUnitId
      ? '1'
      : variant.units.find((pack) => pack.unitId === line.unitId)?.factor;
  return factor === undefined ? null : toBaseQuantity(line.quantity, factor, variant.baseDecimals);
}

// The challan an invoice makes for its own goods lines names its lines lines.0, lines.1 …; the
// person sees the invoice, where those are, say, lines.2 and lines.5. `indexes` maps one to the
// other, so each problem shows under the invoice line it belongs to.
function onInvoiceLines(error: unknown, indexes: readonly number[]): never {
  if (!(error instanceof AppError) || error.options.fieldErrors === undefined) throw error;
  const fieldErrors = Object.fromEntries(
    Object.entries(error.options.fieldErrors).map(([path, codes]) => {
      const match = /^lines\.(\d+)\.(.+)$/.exec(path);
      const index = match === null ? undefined : indexes[Number(match[1])];
      const field = match?.[2];
      return [index === undefined || field === undefined ? path : linePath(index, field), codes];
    }),
  );
  throw new AppError(error.status, error.code, error.message, { ...error.options, fieldErrors });
}

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly deliveries: DeliveriesService,
    private readonly books: SalesBooksService,
    private readonly credit: CreditService,
  ) {}

  // Newest date first; open and overdue invoices oldest due date first, the order a receipt pays
  // them in (the receipt form reads this list for its suggestion)
  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: InvoiceStatus | undefined;
    customerId?: string | undefined;
    payment?: InvoicePaymentFilter | undefined;
  }): Promise<{ items: InvoiceSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    const byDue = query.payment === 'open' || query.payment === 'overdue';
    return this.withTenant(async (tx) => {
      const today = query.payment === 'overdue' ? await this.today(tx) : null;
      const keyset = byDue
        ? sql`(${invoices.dueDate}, ${invoices.id}) > (${after?.[0]}::date, ${after?.[1]}::uuid)`
        : sql`(${invoices.date}, ${invoices.id}) < (${after?.[0]}::date, ${after?.[1]}::uuid)`;
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(invoices.status, query.status),
          query.customerId === undefined ? undefined : eq(invoices.customerId, query.customerId),
          this.paymentFilter(query.payment, today),
          after === undefined ? undefined : keyset,
        ),
        query.limit + 1,
        byDue ? [asc(invoices.dueDate), asc(invoices.id)] : undefined,
      );
      const page = toPage(rows, query.limit, (last) =>
        byDue ? [last.invoice.dueDate, last.invoice.id] : [last.invoice.date, last.invoice.id],
      );
      return {
        items: page.items.map((row) => toSummary(row.invoice, row.customer, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Invoice> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: InvoiceInput): Promise<Invoice> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      const fields = await this.check(tx, customer.id, input, null);
      const [row] = await tx
        .insert(invoices)
        .values({
          tenantId: getTenantId(),
          ...fields.header,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Invoice insert returned no row');
      await this.writeLines(tx, row.id, input.lines, fields.lines, fields.sources);
      await audit(tx, {
        action: 'invoice.created',
        entityType: 'invoice',
        entityId: row.id,
        changes: created(this.snapshot(row, customer, fields.lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row, input.overrideCreditLimit);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateInvoiceInput): Promise<Invoice> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      const fields = await this.check(tx, customer.id, input, { row: before, lines: linesBefore });
      const [updated] = await tx
        .update(invoices)
        .set({
          ...fields.header,
          version: sql`${invoices.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, id)))
        .returning();
      if (!updated) throw notFound('Invoice');
      await this.writeLines(tx, id, input.lines, fields.lines, fields.sources);
      await audit(tx, {
        action: 'invoice.updated',
        entityType: 'invoice',
        entityId: id,
        changes: diff(
          this.snapshot(before, customerBefore, linesBefore.length),
          this.snapshot(updated, customer, fields.lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, updated, input.overrideCreditLimit);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE). A draft claimed no challan line: nothing to undo.
      await tx
        .delete(invoices)
        .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, id)));
      const snapshot = this.snapshot(before, customer, lines.length);
      await audit(tx, {
        action: 'invoice.deleted',
        entityType: 'invoice',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  post(id: string, input: { version: number; overrideCreditLimit: boolean }): Promise<Invoice> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, input.version);
      await this.postAndLog(tx, draft, input.overrideCreditLimit);
      return this.read(tx, id);
    });
  }

  // Every rule of a save the contract cannot check, and the header it writes. `before`: the draft
  // being changed (null for a new invoice); its VAT rates and its price setting stay usable. Its
  // items do not: like a quotation or an order (15b), an archived product is not sold any more,
  // unless the line bills a challan or an order that already sold it.
  private async check(
    tx: Transaction,
    customerId: string,
    input: InvoiceInput,
    before: { row: InvoiceRow; lines: readonly InvoiceLineRow[] } | null,
  ) {
    await assertBranch(tx, input.branchId);
    // FOR SHARE on the orders: a reopen waits until we commit, then sees this draft's lines
    const sources = await this.checkSources(tx, customerId, input.lines, 'share');
    const pricesIncludeVat =
      sources.pricesIncludeVat ?? before?.row.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
    const keptRateIds = new Set([
      ...sources.keptRateIds,
      ...(before?.lines.map((line) => line.taxRateId) ?? []),
    ]);
    const lines = await resolveSalesLines(
      tx,
      input.lines,
      pricesIncludeVat,
      keptRateIds,
      sources.keptVariantIds,
    );
    await this.checkOwnLines(tx, input, lines, sources.lines);
    const [terms] = await tx
      .select({ paymentTermsDays: parties.paymentTermsDays })
      .from(parties)
      .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, customerId)));
    return {
      header: {
        date: input.date,
        // An empty box: the customer's payment terms (step 15a), counted from the invoice date
        dueDate: input.dueDate ?? dueDateOf(input.date, terms?.paymentTermsDays ?? 0),
        customerId,
        customerReference: input.customerReference,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        billingAddress: await billingAddressOf(tx, customerId),
        pricesIncludeVat,
        note: input.note,
        ...documentTotals(lines.map((line) => line.amounts)),
      },
      lines,
      sources: sources.lines,
    };
  }

  // The lines of its own (neither a challan line nor an order line). A goods one is delivered by
  // the invoice when it is posted, so it is checked like a challan line now: the warehouse is
  // there and active, and the batch and serial numbers fit the product (resolveLines, the stock
  // documents' own check). A service one delivers nothing, so it takes no batch or serial.
  private async checkOwnLines(
    tx: Transaction,
    input: InvoiceInput,
    lines: readonly ResolvedSalesLine[],
    sources: readonly LineSource[],
  ): Promise<void> {
    const issues: LineIssue[] = [];
    const goods: number[] = [];
    lines.forEach((line, index) => {
      const source = sources[index];
      const typed = input.lines[index];
      if (source === undefined || typed === undefined) return;
      if (source.deliveryLineId !== null || source.orderLineId !== null) return;
      if (line.variant.type === 'goods') {
        goods.push(index);
        return;
      }
      if (typed.batchId !== null) {
        issues.push({ path: linePath(index, 'batchId'), code: 'invoice_stock_not_allowed' });
      }
      if (typed.serialNumbers.length > 0) {
        issues.push({ path: linePath(index, 'serialNumbers'), code: 'invoice_stock_not_allowed' });
      }
    });
    if (issues.length > 0) throw linesError(issues);
    if (goods.length === 0) return;
    if (input.warehouseId === null) {
      throw new AppError(
        409,
        'invoice_warehouse_required',
        'Pick the warehouse the goods of this invoice leave from.',
        { fieldErrors: { warehouseId: ['invoice_warehouse_required'] } },
      );
    }
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
    try {
      await resolveLines(
        tx,
        goods.flatMap((index) => {
          const line = input.lines[index];
          return line === undefined ? [] : [stockLineOf(line)];
        }),
        'out',
      );
    } catch (error) {
      onInvoiceLines(error, goods);
    }
  }

  // What each line bills, checked against the challans and orders it names: a challan line must be
  // on a posted challan of this customer, of the same item, for what left less what came back before
  // it was billed (step 15d, billableQuantity: in any unit of the item), and not billed yet;
  // an order line must be a service line of a confirmed (or delivered, or closed) order of this
  // customer, billed whole, and not billed yet. All problems come back at once, under each line.
  // lock: 'share' when a draft is saved (a reopen of the order waits for us), 'update' when it is
  // posted (another invoice billing the same lines waits, then finds them billed). The challans
  // and orders are locked in id order, so two postings never wait for each other in a circle.
  private async checkSources(
    tx: Transaction,
    customerId: string,
    lines: readonly LineRefs[],
    lock: 'share' | 'update',
  ): Promise<Sources> {
    const deliveryLineIds = lines.flatMap((line) =>
      line.deliveryLineId === null ? [] : [line.deliveryLineId],
    );
    const challanLines = await this.challanLines(tx, deliveryLineIds, lock);
    // The order lines named directly, and those behind the challan lines
    const orderLineIds = [
      ...new Set([
        ...lines.flatMap((line) => (line.orderLineId === null ? [] : [line.orderLineId])),
        ...[...challanLines.values()].flatMap((line) =>
          line.orderLineId === null ? [] : [line.orderLineId],
        ),
      ]),
    ];
    const orderLines = await this.orderLines(tx, orderLineIds, lock);
    // The items of the lines that bill a challan line, for their quantities in the base unit
    const variants = await loadVariants(
      tx,
      lines.flatMap((line) => (line.deliveryLineId === null ? [] : [line.variantId])),
    );

    const issues: LineIssue[] = [];
    const sources: LineSource[] = [];
    const vatSettings = new Set<boolean>();
    const keptVariantIds = new Set<string>();
    const keptRateIds = new Set<string>();
    const same = (line: LineRefs, other: Omit<LineRefs, 'deliveryLineId' | 'orderLineId'>) =>
      line.variantId === other.variantId &&
      line.unitId === other.unitId &&
      compareQuantity(line.quantity, other.quantity) === 0;
    const useOrderLine = (orderLineId: string | null) => {
      const orderLine = orderLineId === null ? undefined : orderLines.get(orderLineId);
      if (orderLine === undefined) return;
      vatSettings.add(orderLine.pricesIncludeVat);
      keptRateIds.add(orderLine.taxRateId);
    };

    lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      if (line.deliveryLineId !== null) {
        const challan = challanLines.get(line.deliveryLineId);
        const base = baseQuantityOf(line, variants.get(line.variantId));
        if (
          challan?.customerId !== customerId ||
          challan.status !== 'posted' ||
          line.variantId !== challan.variantId ||
          base === null ||
          compareQuantity(base, billableQuantity(challan)) !== 0
        ) {
          at('deliveryLineId', 'invoice_delivery_line_invalid');
        } else if (challan.invoiced) {
          at('deliveryLineId', 'invoice_delivery_line_billed');
        }
        sources.push({
          deliveryLineId: line.deliveryLineId,
          orderLineId: challan?.orderLineId ?? null,
        });
        keptVariantIds.add(line.variantId);
        useOrderLine(challan?.orderLineId ?? null);
        return;
      }
      if (line.orderLineId !== null) {
        const orderLine = orderLines.get(line.orderLineId);
        // Goods on an order are billed through their challan: only the challan says they left
        if (
          orderLine?.customerId !== customerId ||
          !['confirmed', 'delivered', 'closed'].includes(orderLine.status) ||
          orderLine.productType !== 'service' ||
          !same(line, orderLine)
        ) {
          at('orderLineId', 'invoice_order_line_invalid');
        } else if (compareQuantity(orderLine.invoicedQuantity, '0') > 0) {
          at('orderLineId', 'invoice_order_line_billed');
        }
        sources.push({ deliveryLineId: null, orderLineId: line.orderLineId });
        keptVariantIds.add(line.variantId);
        useOrderLine(line.orderLineId);
        return;
      }
      sources.push({ deliveryLineId: null, orderLineId: null });
    });
    if (issues.length > 0) throw linesError(issues);
    // One invoice reads its prices one way: two orders that disagree cannot share an invoice
    if (vatSettings.size > 1) {
      throw new AppError(
        409,
        'invoice_vat_mixed',
        'These orders price differently (with and without VAT). Bill them on separate invoices.',
      );
    }
    const [pricesIncludeVat] = [...vatSettings];
    return {
      lines: sources,
      pricesIncludeVat: pricesIncludeVat ?? null,
      keptVariantIds,
      keptRateIds,
    };
  }

  // The challan lines an invoice names, with their challan's customer and status. The challans are
  // read (and locked) first, in id order; then the lines, so `invoiced` is read after the lock.
  private async challanLines(tx: Transaction, ids: readonly string[], lock: 'share' | 'update') {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map<string, never>();
    const owners = await tx
      .selectDistinct({ deliveryId: deliveryLines.deliveryId })
      .from(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, [...ids])));
    const challans = await tx
      .select({ id: deliveries.id, customerId: deliveries.customerId, status: deliveries.status })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenantId, tenantId),
          inArray(
            deliveries.id,
            owners.map((owner) => owner.deliveryId),
          ),
        ),
      )
      .orderBy(asc(deliveries.id))
      .for(lock);
    const byId = new Map(challans.map((challan) => [challan.id, challan]));
    const rows = await tx
      .select({
        id: deliveryLines.id,
        deliveryId: deliveryLines.deliveryId,
        variantId: deliveryLines.variantId,
        unitId: deliveryLines.unitId,
        quantity: deliveryLines.quantity,
        baseQuantity: deliveryLines.baseQuantity,
        orderLineId: deliveryLines.orderLineId,
        invoiced: deliveryLines.invoiced,
        returnedQuantity: deliveryLines.returnedQuantity,
      })
      .from(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, [...ids])));
    return new Map(
      rows.flatMap((row) => {
        const challan = byId.get(row.deliveryId);
        return challan === undefined
          ? []
          : [[row.id, { ...row, customerId: challan.customerId, status: challan.status }] as const];
      }),
    );
  }

  // The order lines an invoice bills, directly or through a challan, with their order. Locked the
  // same way: the orders first, in id order, then the lines.
  private async orderLines(tx: Transaction, ids: readonly string[], lock: 'share' | 'update') {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map<string, never>();
    const owners = await tx
      .selectDistinct({ orderId: salesOrderLines.orderId })
      .from(salesOrderLines)
      .where(and(eq(salesOrderLines.tenantId, tenantId), inArray(salesOrderLines.id, [...ids])));
    const orders = await tx
      .select({
        id: salesOrders.id,
        customerId: salesOrders.customerId,
        status: salesOrders.status,
        pricesIncludeVat: salesOrders.pricesIncludeVat,
      })
      .from(salesOrders)
      .where(
        and(
          eq(salesOrders.tenantId, tenantId),
          inArray(
            salesOrders.id,
            owners.map((owner) => owner.orderId),
          ),
        ),
      )
      .orderBy(asc(salesOrders.id))
      .for(lock);
    const byId = new Map(orders.map((order) => [order.id, order]));
    const rows = await tx
      .select({
        id: salesOrderLines.id,
        orderId: salesOrderLines.orderId,
        variantId: salesOrderLines.variantId,
        unitId: salesOrderLines.unitId,
        quantity: salesOrderLines.quantity,
        invoicedQuantity: salesOrderLines.invoicedQuantity,
        taxRateId: salesOrderLines.taxRateId,
        productType: products.type,
      })
      .from(salesOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, salesOrderLines.tenantId),
          eq(products.id, salesOrderLines.productId),
        ),
      )
      .where(and(eq(salesOrderLines.tenantId, tenantId), inArray(salesOrderLines.id, [...ids])));
    return new Map(
      rows.flatMap((row) => {
        const order = byId.get(row.orderId);
        return order === undefined
          ? []
          : [
              [
                row.id,
                {
                  ...row,
                  customerId: order.customerId,
                  status: order.status,
                  pricesIncludeVat: order.pricesIncludeVat,
                },
              ] as const,
            ];
      }),
    );
  }

  // Posting, in the caller's transaction, in the order migration 0030 needs: the invoice is still a
  // draft while its lines change (a line of its own gets its challan line), and becomes posted
  // last. A refused step leaves nothing: no number used, no stock moved, nothing billed.
  private async postAndLog(
    tx: Transaction,
    draft: InvoiceRow,
    overrideCreditLimit: boolean,
  ): Promise<void> {
    const tenantId = getTenantId();
    // The date first: a closed period refuses before anything is locked or moved
    await assertPeriodOpen(tx, draft.date);
    // Active now: the journal will not book a sale to an archived customer (the party rule)
    await assertCustomer(tx, draft.customerId);
    await assertBranch(tx, draft.branchId);
    const stored = await this.linesOf(tx, draft.id);
    // Again, under the locks: another invoice may have billed a line since the draft was saved
    const sources = await this.checkSources(tx, draft.customerId, stored, 'update');
    const before = await this.credit.lock(tx, draft.customerId);
    const number = await this.numbering.next(tx, 'sales.invoice', draft.date);

    // The goods lines of its own leave on a challan of their own
    const own = await this.ownGoodsLines(tx, stored, sources.lines);
    const billed = sources.lines.map((source) => source.deliveryLineId);
    if (own.length > 0) {
      if (draft.warehouseId === null) {
        throw new AppError(
          409,
          'invoice_warehouse_required',
          'Pick the warehouse the goods of this invoice leave from.',
          { fieldErrors: { warehouseId: ['invoice_warehouse_required'] } },
        );
      }
      let made: { lineIds: string[] };
      try {
        made = await this.deliveries.deliverForInvoice(tx, {
          customerId: draft.customerId,
          date: draft.date,
          warehouseId: draft.warehouseId,
          note: `Invoice ${number}`,
          lines: own.map((index) => {
            const line = stored[index];
            if (line === undefined) throw new Error(`Invoice line ${String(index)} is missing`);
            return stockLineOf(line);
          }),
        });
      } catch (error) {
        onInvoiceLines(error, own);
      }
      for (const [position, index] of own.entries()) {
        const line = stored[index];
        const deliveryLineId = made.lineIds[position];
        if (line === undefined || deliveryLineId === undefined) continue;
        billed[index] = deliveryLineId;
        await tx
          .update(invoiceLines)
          .set({ deliveryLineId })
          .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.id, line.id)));
      }
    }

    // Each challan line billed once: false → true, never back (migration 0030). The lock on the
    // challans makes a second invoice wait and then fail in checkSources(); the condition on
    // `invoiced` is the last word if anything slipped past.
    const challanLineIds = billed.filter((id): id is string => id !== null);
    if (challanLineIds.length > 0) {
      const marked = await tx
        .update(deliveryLines)
        .set({ invoiced: true })
        .where(
          and(
            eq(deliveryLines.tenantId, tenantId),
            inArray(deliveryLines.id, challanLineIds),
            eq(deliveryLines.invoiced, false),
          ),
        )
        .returning({ id: deliveryLines.id });
      if (marked.length !== challanLineIds.length) {
        throw new AppError(
          409,
          'invoice_delivery_line_billed',
          'Another invoice billed some of these challan lines.',
        );
      }
    }
    await this.invoiceOnOrders(tx, stored, sources.lines);

    // The books: the sale, the receivable and the VAT (SalesBooksService). Then the credit check,
    // with this invoice in what the customer owes and its order lines no longer "on order".
    const entry = await this.books.invoice(
      tx,
      { id: draft.id, number, date: draft.date },
      {
        customerId: draft.customerId,
        branchId: draft.branchId,
        net: draft.net,
        vat: draft.vat,
        total: draft.total,
      },
    );
    await this.credit.check(tx, {
      customerId: draft.customerId,
      before,
      overrideCreditLimit,
      entityType: 'invoice',
      entityId: draft.id,
    });
    await tx
      .update(invoices)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${invoices.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, draft.id)));
    await audit(tx, {
      action: 'invoice.posted',
      entityType: 'invoice',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The indexes of the goods lines of its own: what the invoice delivers itself
  private async ownGoodsLines(
    tx: Transaction,
    stored: readonly InvoiceLineRow[],
    sources: readonly LineSource[],
  ): Promise<number[]> {
    const own = sources.flatMap((source, index) =>
      source.deliveryLineId === null && source.orderLineId === null ? [index] : [],
    );
    if (own.length === 0) return [];
    const productIds = [...new Set(own.flatMap((index) => stored[index]?.productId ?? []))];
    const goods = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.tenantId, getTenantId()),
          inArray(products.id, productIds),
          eq(products.type, 'goods'),
        ),
      );
    const isGoods = new Set(goods.map((product) => product.id));
    return own.filter((index) => isGoods.has(stored[index]?.productId ?? ''));
  }

  // What the invoice billed, onto its order lines: a challan line's quantity onto the order line it
  // delivered, a service line's onto itself. The orders are locked (checkSources); the database
  // lets invoiced_quantity change on a confirmed, delivered or closed order (migration 0030), never
  // past what was ordered. The order keeps its version: a delivered or closed order's header is
  // frozen (migration 0028), and no order action decides on a stale invoiced quantity — cancel and
  // reopen read it again under the order's lock.
  private async invoiceOnOrders(
    tx: Transaction,
    stored: readonly InvoiceLineRow[],
    sources: readonly LineSource[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, string[]>();
    stored.forEach((line, index) => {
      const orderLineId = sources[index]?.orderLineId ?? null;
      if (orderLineId === null) return;
      byOrderLine.set(orderLineId, [...(byOrderLine.get(orderLineId) ?? []), line.baseQuantity]);
    });
    for (const [orderLineId, quantities] of byOrderLine) {
      await tx
        .update(salesOrderLines)
        .set({
          invoicedQuantity: sql`${salesOrderLines.invoicedQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(salesOrderLines.tenantId, tenantId), eq(salesOrderLines.id, orderLineId)));
    }
  }

  // The lines as typed, with what the check found: the server's own order line for a challan line
  private async writeLines(
    tx: Transaction,
    invoiceId: string,
    typed: readonly InvoiceLineInput[],
    lines: readonly ResolvedSalesLine[],
    sources: readonly LineSource[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.invoiceId, invoiceId)));
    await tx.insert(invoiceLines).values(
      lines.map((line, index) => ({
        ...salesLineValues(line, index),
        invoiceId,
        deliveryLineId: sources[index]?.deliveryLineId ?? null,
        orderLineId: sources[index]?.orderLineId ?? null,
        batchId: typed[index]?.batchId ?? null,
        serialNumbers: [...(typed[index]?.serialNumbers ?? [])],
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<InvoiceRow> {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, id)))
      .for('update');
    if (!row) throw notFound('Invoice');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, invoiceId: string) {
    return tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, getTenantId()), eq(invoiceLines.invoiceId, invoiceId)))
      .orderBy(asc(invoiceLines.lineNo));
  }

  private paymentFilter(
    payment: InvoicePaymentFilter | undefined,
    today: string | null,
  ): SQL | undefined {
    if (payment === 'paid') {
      return sql`${invoices.status} = 'posted' AND ${invoices.amountPaid} + ${invoices.amountCredited} >= ${invoices.total}`;
    }
    if (payment === 'open') return isOpen;
    if (payment === 'overdue') return sql`${isOpen} AND ${invoices.dueDate} < ${today}::date`;
    return undefined;
  }

  // The workspace's today: an invoice is overdue the day after its due date there, not in UTC
  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }

  private rows(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
    order: SQL[] = [desc(invoices.date), desc(invoices.id)],
  ) {
    return tx
      .select({
        invoice: invoices,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(invoices)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, invoices.tenantId), eq(parties.id, invoices.customerId)),
      )
      .where(and(eq(invoices.tenantId, getTenantId()), where))
      .orderBy(...order)
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Invoice> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(invoices.id, id), 1);
    if (!found) throw notFound('Invoice');
    const { invoice: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    // A challan line left with its batch and serial numbers: the invoice prints those
    const challanLineIds = lines.flatMap(({ row: line }) =>
      line.deliveryLineId === null ? [] : [line.deliveryLineId],
    );
    const challanLines =
      challanLineIds.length === 0
        ? []
        : await tx
            .select({
              id: deliveryLines.id,
              batchId: deliveryLines.batchId,
              serialNumbers: deliveryLines.serialNumbers,
              deliveryId: deliveries.id,
              number: deliveries.number,
              date: deliveries.date,
            })
            .from(deliveryLines)
            .innerJoin(
              deliveries,
              and(
                eq(deliveries.tenantId, deliveryLines.tenantId),
                eq(deliveries.id, deliveryLines.deliveryId),
              ),
            )
            .where(
              and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, challanLineIds)),
            );
    const challanLine = new Map(challanLines.map((line) => [line.id, line]));
    // Step 15d: the serial numbers that came back before the line was billed were never billed, so
    // the invoice does not print them. Those that came back later were billed (a credit note gives
    // their money back), so they stay.
    const unbilledReturns = await this.returnedBeforeBilling(tx, challanLineIds);
    const stockOf = (line: InvoiceLineRow) => {
      const challan =
        line.deliveryLineId === null ? undefined : challanLine.get(line.deliveryLineId);
      const back =
        line.deliveryLineId === null ? undefined : unbilledReturns.get(line.deliveryLineId);
      return {
        batchId: challan?.batchId ?? line.batchId,
        serialNumbers: (challan?.serialNumbers ?? line.serialNumbers).filter(
          (serial) => back?.has(serial) !== true,
        ),
      };
    };
    const orderLineIds = lines.flatMap(({ row: line }) =>
      line.orderLineId === null ? [] : [line.orderLineId],
    );
    const [batches, orders, payments, credits, entry] = await Promise.all([
      batchesOf(
        tx,
        lines.map(({ row: line }) => stockOf(line).batchId),
      ),
      orderLineIds.length === 0
        ? []
        : tx
            .select({
              lineId: salesOrderLines.id,
              id: salesOrders.id,
              number: salesOrders.number,
            })
            .from(salesOrderLines)
            .innerJoin(
              salesOrders,
              and(
                eq(salesOrders.tenantId, salesOrderLines.tenantId),
                eq(salesOrders.id, salesOrderLines.orderId),
              ),
            )
            .where(
              and(
                eq(salesOrderLines.tenantId, tenantId),
                inArray(salesOrderLines.id, orderLineIds),
              ),
            )
            .orderBy(asc(salesOrders.number)),
      tx
        .select({
          receiptId: receipts.id,
          receiptNumber: receipts.number,
          date: receipts.date,
          amount: receiptAllocations.amount,
        })
        .from(receiptAllocations)
        .innerJoin(
          receipts,
          and(
            eq(receipts.tenantId, receiptAllocations.tenantId),
            eq(receipts.id, receiptAllocations.receiptId),
          ),
        )
        .where(and(eq(receiptAllocations.tenantId, tenantId), eq(receiptAllocations.invoiceId, id)))
        .orderBy(asc(receipts.date), asc(receipts.number)),
      // Step 15d: the posted credit notes written for it, oldest first
      tx
        .select({
          id: creditNotes.id,
          number: creditNotes.number,
          date: creditNotes.date,
          total: creditNotes.total,
        })
        .from(creditNotes)
        .where(
          and(
            eq(creditNotes.tenantId, tenantId),
            eq(creditNotes.invoiceId, id),
            eq(creditNotes.status, 'posted'),
          ),
        )
        .orderBy(asc(creditNotes.date), asc(creditNotes.number)),
      row.status === 'posted' ? this.books.entryOf(tx, id, 'sales_invoice') : null,
    ]);
    // Each order once, by number; and the number of the order behind each order line
    const orderOf = new Map(orders.map((order) => [order.lineId, order.number]));
    const orderRefs = [
      ...new Map(
        orders.map((order) => [order.id, { id: order.id, number: order.number }]),
      ).values(),
    ];
    // Each challan once, oldest first. Posted, so each has a number.
    const challans = new Map(
      challanLines.flatMap((line) =>
        line.number === null
          ? []
          : [
              [
                line.deliveryId,
                { id: line.deliveryId, number: line.number, date: line.date },
              ] as const,
            ],
      ),
    );
    return {
      ...toSummary(row, found.customer, found.lineCount),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      warehouseId: row.warehouseId,
      billingAddress: row.billingAddress,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => {
        const stock = stockOf(line);
        const batch = stock.batchId === null ? undefined : batches.get(stock.batchId);
        return {
          ...toSalesLine(line, variant),
          deliveryLineId: line.deliveryLineId,
          orderLineId: line.orderLineId,
          deliveryNumber:
            line.deliveryLineId === null
              ? null
              : (challanLine.get(line.deliveryLineId)?.number ?? null),
          orderNumber: line.orderLineId === null ? null : (orderOf.get(line.orderLineId) ?? null),
          batchId: stock.batchId,
          lotNumber: batch?.lotNumber ?? null,
          expiresOn: batch?.expiresOn ?? null,
          serialNumbers: stock.serialNumbers,
          credited: line.credited,
        };
      }),
      deliveries: [...challans.values()].toSorted(
        (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
      ),
      orders: orderRefs,
      payments,
      // Posted, so each has a number
      creditNotes: credits.flatMap((credit) =>
        credit.number === null ? [] : [{ ...credit, number: credit.number }],
      ),
      entry,
    };
  }

  // Challan line → the serial numbers posted returns brought back before the line was billed (step
  // 15d: their return line has no invoice line)
  private async returnedBeforeBilling(
    tx: Transaction,
    deliveryLineIds: readonly string[],
  ): Promise<Map<string, Set<string>>> {
    if (deliveryLineIds.length === 0) return new Map();
    const rows = await tx
      .select({
        deliveryLineId: salesReturnLines.deliveryLineId,
        serialNumbers: salesReturnLines.serialNumbers,
      })
      .from(salesReturnLines)
      .innerJoin(
        salesReturns,
        and(
          eq(salesReturns.tenantId, salesReturnLines.tenantId),
          eq(salesReturns.id, salesReturnLines.returnId),
        ),
      )
      .where(
        and(
          eq(salesReturnLines.tenantId, getTenantId()),
          inArray(salesReturnLines.deliveryLineId, [...deliveryLineIds]),
          isNull(salesReturnLines.invoiceLineId),
          eq(salesReturns.status, 'posted'),
        ),
      );
    const back = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.deliveryLineId === null || row.serialNumbers.length === 0) continue;
      const set = back.get(row.deliveryLineId) ?? new Set<string>();
      for (const serial of row.serialNumbers) set.add(serial);
      back.set(row.deliveryLineId, set);
    }
    return back;
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  // What the audit log shows: the header and the size, not every line
  private snapshot(row: InvoiceRow, customer: PartyRef, lines: number) {
    return {
      number: row.number,
      date: row.date,
      dueDate: row.dueDate,
      customer: customer.code,
      customerReference: row.customerReference,
      total: row.total,
      lines,
    };
  }
}
