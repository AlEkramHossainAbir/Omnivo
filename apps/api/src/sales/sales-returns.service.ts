import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type ErrorCode,
  type PartyRef,
  prorateMoney,
  type SalesReturn,
  type SalesReturnInput,
  type SalesReturnSummary,
  type StockDocumentStatus,
  subtractMoney,
  subtractQuantity,
  sumQuantity,
  type UpdateSalesReturnInput,
} from '@omnivo/contracts';
import {
  creditNoteLines,
  creditNotes,
  deliveries,
  deliveryLines,
  invoiceLines,
  invoices,
  parties,
  salesOrderLines,
  salesOrders,
  salesReturnLines,
  salesReturns,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from '../inventory/stock-lines.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { StockPostingService } from '../inventory/stock-posting.service.js';
import { ValueAccess } from '../inventory/value-access.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { assertCustomer, customerRefs } from './sales-lines.js';

type ReturnRow = typeof salesReturns.$inferSelect;
type LineRow = typeof salesReturnLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM sales_return_lines l
   WHERE l.tenant_id = sales_returns.tenant_id AND l.return_id = sales_returns.id
)`;

// What a line names, as the form sends it and as the database keeps it
interface LineRefs {
  deliveryLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: readonly string[];
}

// A challan line a return line comes back from, with what its challan says about it
interface ChallanLine {
  id: string;
  deliveryId: string;
  customerId: string;
  status: StockDocumentStatus;
  // The warehouse the goods left from: its branch booked their cost (15b), so the return takes the
  // cost off there
  warehouseId: string;
  variantId: string;
  baseQuantity: string;
  returnedQuantity: string;
  batchId: string | null;
  serialNumbers: string[];
  value: string | null;
  invoiced: boolean;
  orderLineId: string | null;
}

// The lines once checked: resolved like a stock document's (the batch of a challan line is the
// challan line's), with the challan lines they name
interface Checked {
  lines: ResolvedLine[];
  challans: Map<string, ChallanLine>;
}

// The invoice line that billed a challan line, and its invoice
interface Billing {
  invoiceId: string;
  invoiceLineId: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. A posted return is final: goods that go out again go on a delivery.',
  );
}

function toSummary(row: ReturnRow, customer: PartyRef, lines: number): SalesReturnSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    warehouseId: row.warehouseId,
    reason: row.reason,
    status: row.status,
    note: row.note,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What `quantity` coming back from a challan line is worth: its share of what the line took out
// (you chose this: the cost of goods sold is reversed exactly). Counted over everything returned
// from the line so far, so a line that comes back in three goes gives back exactly its value, with
// no paisa left over by rounding.
function returnValue(challan: ChallanLine, quantity: string): string {
  if (challan.value === null) throw new Error(`Posted challan line ${challan.id} has no value`);
  const after = sumQuantity([challan.returnedQuantity, quantity]);
  return subtractMoney(
    prorateMoney(challan.value, after, challan.baseQuantity),
    prorateMoney(challan.value, challan.returnedQuantity, challan.baseQuantity),
  );
}

// StockPostingService asks for a cost (lines.2.unitCost) when an item has none yet: its first
// stock. A line on its own comes back at the average cost, and a return has no cost box, so the
// problem goes under the item with the return's own code: the item needs its opening stock first.
function noCostError(error: unknown): never {
  if (
    !(error instanceof AppError) ||
    error.code !== 'stock_cost_required' ||
    error.options.fieldErrors === undefined
  ) {
    throw error;
  }
  const fieldErrors = Object.fromEntries(
    Object.keys(error.options.fieldErrors).map((path) => [
      path.replace(/\.unitCost$/, '.variantId'),
      ['return_cost_unknown' as const satisfies ErrorCode],
    ]),
  );
  throw new AppError(
    409,
    'return_cost_unknown',
    'Some items have no cost yet. Bring in their opening stock first.',
    { fieldErrors },
  );
}

// The database's last word on a challan line (delivery_lines_returned_check): never more back than
// left. The locks in postAndLog() make it unreachable in practice; it still answers with the code
// the form knows.
function overDeliveredRace(error: unknown): unknown {
  if (isCheckViolation(error, 'delivery_lines_returned_check')) {
    return new AppError(
      409,
      'return_over_delivered',
      'Another return brought some of these goods back first. Reload and try again.',
    );
  }
  return error;
}

// Sales returns (step 15d): goods a customer sent back, into the warehouse the return names. A
// draft is changed freely; "Post" numbers it, puts the stock back at what it cost, takes that cost
// off cost of goods sold, and counts it on the challan lines it names. It moves no money: a credit
// note does that.
@Injectable()
export class SalesReturnsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
    private readonly access: ValueAccess,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: StockDocumentStatus | undefined;
    customerId?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: SalesReturnSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(salesReturns.status, query.status),
          query.customerId === undefined
            ? undefined
            : eq(salesReturns.customerId, query.customerId),
          query.warehouseId === undefined
            ? undefined
            : eq(salesReturns.warehouseId, query.warehouseId),
          after === undefined
            ? undefined
            : sql`(${salesReturns.date}, ${salesReturns.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [
        last.salesReturn.date,
        last.salesReturn.id,
      ]);
      return {
        items: page.items.map((row) => toSummary(row.salesReturn, row.customer, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<SalesReturn> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: SalesReturnInput): Promise<SalesReturn> {
    try {
      return await this.withTenant(async (tx) => {
        const customer = await assertCustomer(tx, input.customerId);
        await assertWarehousesActive(tx, [
          { field: 'warehouseId', warehouseId: input.warehouseId },
        ]);
        const checked = await this.checkLines(tx, customer.id, input.lines, false);
        const [row] = await tx
          .insert(salesReturns)
          .values({
            tenantId: getTenantId(),
            date: input.date,
            customerId: customer.id,
            warehouseId: input.warehouseId,
            reason: input.reason,
            note: input.note,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Sales return insert returned no row');
        await this.writeLines(tx, row.id, input.lines, checked.lines);
        await audit(tx, {
          action: 'sales_return.created',
          entityType: 'sales_return',
          entityId: row.id,
          changes: created(await this.snapshot(tx, row, customer, checked.lines.length)),
        });
        if (input.post) await this.postAndLog(tx, row);
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw overDeliveredRace(error);
    }
  }

  async update(id: string, input: UpdateSalesReturnInput): Promise<SalesReturn> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, input.version);
        const linesBefore = await this.linesOf(tx, id);
        const customerBefore = await this.customerOf(tx, before.customerId);
        const customer = await assertCustomer(tx, input.customerId, before.customerId);
        await assertWarehousesActive(tx, [
          { field: 'warehouseId', warehouseId: input.warehouseId },
        ]);
        const checked = await this.checkLines(tx, customer.id, input.lines, false);
        const [updated] = await tx
          .update(salesReturns)
          .set({
            date: input.date,
            customerId: customer.id,
            warehouseId: input.warehouseId,
            reason: input.reason,
            note: input.note,
            version: sql`${salesReturns.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(salesReturns.tenantId, getTenantId()), eq(salesReturns.id, id)))
          .returning();
        if (!updated) throw notFound('Sales return');
        await this.writeLines(tx, id, input.lines, checked.lines);
        await audit(tx, {
          action: 'sales_return.updated',
          entityType: 'sales_return',
          entityId: id,
          changes: diff(
            await this.snapshot(tx, before, customerBefore, linesBefore.length),
            await this.snapshot(tx, updated, customer, checked.lines.length),
          ),
        });
        if (input.post) await this.postAndLog(tx, updated);
        return this.read(tx, id);
      });
    } catch (error) {
      throw overDeliveredRace(error);
    }
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE). A draft brought nothing back: nothing to undo.
      await tx
        .delete(salesReturns)
        .where(and(eq(salesReturns.tenantId, getTenantId()), eq(salesReturns.id, id)));
      const snapshot = await this.snapshot(tx, before, customer, lines.length);
      await audit(tx, {
        action: 'sales_return.deleted',
        entityType: 'sales_return',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  async post(id: string, version: number): Promise<SalesReturn> {
    try {
      return await this.withTenant(async (tx) => {
        const draft = await this.lockDraft(tx, id, version);
        await this.postAndLog(tx, draft);
        return this.read(tx, id);
      });
    } catch (error) {
      throw overDeliveredRace(error);
    }
  }

  // Every rule of a line the contract cannot check. A line from a challan: a line of a posted
  // challan of this customer, of the same item (in any of its units), with its batch, no more than
  // what left on it less what came back already, and only serial numbers that left on it. A line on
  // its own: an item of this workspace with an existing batch, like a stock line that goes out
  // (resolveLines in 'out' mode: an archived item can still come back). All problems at once, under
  // each line. lock: true when posting (the challans are locked FOR UPDATE, see challanLines()).
  private async checkLines(
    tx: Transaction,
    customerId: string,
    lines: readonly LineRefs[],
    lock: boolean,
  ): Promise<Checked> {
    const challans = await this.challanLines(
      tx,
      lines.flatMap((line) => (line.deliveryLineId === null ? [] : [line.deliveryLineId])),
      lock,
    );
    const challanOf = (line: LineRefs) =>
      line.deliveryLineId === null ? undefined : challans.get(line.deliveryLineId);

    const issues: LineIssue[] = [];
    lines.forEach((line, index) => {
      if (line.deliveryLineId === null) return;
      const challan = challanOf(line);
      if (
        challan?.customerId !== customerId ||
        challan.status !== 'posted' ||
        challan.variantId !== line.variantId
      ) {
        issues.push({
          path: linePath(index, 'deliveryLineId'),
          code: 'return_delivery_line_invalid',
        });
      }
    });
    if (issues.length > 0) throw linesError(issues);

    // A challan line's goods come back in its own batch: the form sends none (the contract refuses
    // one), and a stored draft line keeps the one written when it was saved
    const resolved = await resolveLines(
      tx,
      lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        batchId: challanOf(line)?.batchId ?? line.batchId,
        serialNumbers: [...line.serialNumbers],
      })),
      'out',
      { lock },
    );

    resolved.forEach((line, index) => {
      const typed = lines[index];
      const challan = typed === undefined ? undefined : challanOf(typed);
      if (challan === undefined) return;
      const left = subtractQuantity(challan.baseQuantity, challan.returnedQuantity);
      if (compareQuantity(line.baseQuantity, left) > 0) {
        issues.push({ path: linePath(index, 'quantity'), code: 'return_over_delivered' });
      }
      const sent = new Set(challan.serialNumbers);
      if (line.serialNumbers.some((serial) => !sent.has(serial))) {
        issues.push({ path: linePath(index, 'serialNumbers'), code: 'return_serial_invalid' });
      }
    });
    if (issues.length > 0) throw linesError(issues);
    return { lines: resolved, challans };
  }

  // The challan lines some return lines name, with their challan's customer, status and
  // warehouse. lock: the challans are locked FOR UPDATE in id order first, then the lines are read,
  // so returned_quantity and invoiced are what the last posting committed. An invoice posting
  // locks the same challans (InvoicesService.challanLines), so a return and an invoice of one
  // challan line take turns: whichever is second sees the first.
  private async challanLines(
    tx: Transaction,
    ids: readonly string[],
    lock: boolean,
  ): Promise<Map<string, ChallanLine>> {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map();
    const owners = await tx
      .selectDistinct({ deliveryId: deliveryLines.deliveryId })
      .from(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, [...ids])));
    const query = tx
      .select({
        id: deliveries.id,
        customerId: deliveries.customerId,
        status: deliveries.status,
        warehouseId: deliveries.warehouseId,
      })
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
      .orderBy(asc(deliveries.id));
    const challans = lock ? await query.for('update') : await query;
    const byId = new Map(challans.map((challan) => [challan.id, challan]));
    const rows = await tx
      .select({
        id: deliveryLines.id,
        deliveryId: deliveryLines.deliveryId,
        variantId: deliveryLines.variantId,
        baseQuantity: deliveryLines.baseQuantity,
        returnedQuantity: deliveryLines.returnedQuantity,
        batchId: deliveryLines.batchId,
        serialNumbers: deliveryLines.serialNumbers,
        value: deliveryLines.value,
        invoiced: deliveryLines.invoiced,
        orderLineId: deliveryLines.orderLineId,
      })
      .from(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, [...ids])));
    return new Map(
      rows.flatMap((row) => {
        const challan = byId.get(row.deliveryId);
        return challan === undefined
          ? []
          : [
              [
                row.id,
                {
                  ...row,
                  customerId: challan.customerId,
                  status: challan.status,
                  warehouseId: challan.warehouseId,
                },
              ] as const,
            ];
      }),
    );
  }

  // Posting, in the caller's transaction, in the order migration 0032 needs: the lines are written
  // while the return is still a draft (their values, and the invoice line of a billed challan
  // line), then the challan lines and the orders, and the return becomes posted last. A refused
  // step leaves nothing: no number used, no stock moved.
  private async postAndLog(tx: Transaction, draft: ReturnRow): Promise<void> {
    const tenantId = getTenantId();
    // Open period, and not in the future: tomorrow's goods cannot come back today
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    const stored = await this.linesOf(tx, draft.id);
    // Again, under the locks: another return may have brought the same goods back since the draft
    // was saved, or an invoice may have billed them
    const { lines, challans } = await this.checkLines(tx, draft.customerId, stored, true);
    const challanOf = (index: number) => {
      const id = stored[index]?.deliveryLineId ?? null;
      return id === null ? undefined : challans.get(id);
    };

    // Not billed yet, and from an order: the order can deliver them again (you chose this)
    const unbilled = lines.flatMap((line, index) => {
      const challan = challanOf(index);
      return challan === undefined || challan.invoiced || challan.orderLineId === null
        ? []
        : [{ orderLineId: challan.orderLineId, quantity: line.baseQuantity }];
    });
    const orders = await this.lockOrders(
      tx,
      unbilled.map((line) => line.orderLineId),
    );
    // Billed already: a credit note gives the money back for this invoice line
    const billing = await this.billingOf(
      tx,
      [...challans.values()].filter((challan) => challan.invoiced).map((challan) => challan.id),
    );

    const number = await this.numbering.next(tx, 'sales.return', draft.date);
    let values: string[];
    try {
      values = await this.posting.post(tx, {
        date: draft.date,
        kind: 'sales_return',
        direction: 'in',
        documentId: draft.id,
        documentNumber: number,
        moves: lines.map((line, index) => {
          const challan = challanOf(index);
          return {
            line: index,
            warehouseId: draft.warehouseId,
            variant: line.variant,
            batchId: line.batchId,
            quantity: line.baseQuantity,
            serialNumbers: line.serialNumbers,
            // A challan line's cost; a line on its own at the average cost (null)
            value: challan === undefined ? null : returnValue(challan, line.baseQuantity),
          };
        }),
      });
    } catch (error) {
      noCostError(error);
    }

    // Still a draft here: the lines may change, and take their values and their billing
    await this.writeLines(tx, draft.id, stored, lines, {
      values,
      billing: stored.map((line) =>
        line.deliveryLineId === null ? null : (billing.get(line.deliveryLineId) ?? null),
      ),
    });
    // What came back, on each challan line, in id order (the order every posting locks rows in).
    // Only up: migration 0032 refuses anything else on a posted challan's line.
    const back = lines
      .flatMap((line, index) => {
        const challan = challanOf(index);
        return challan === undefined ? [] : [{ id: challan.id, quantity: line.baseQuantity }];
      })
      .toSorted((a, b) => a.id.localeCompare(b.id));
    for (const line of back) {
      await tx
        .update(deliveryLines)
        .set({
          returnedQuantity: sql`${deliveryLines.returnedQuantity} + ${line.quantity}::numeric`,
        })
        .where(and(eq(deliveryLines.tenantId, tenantId), eq(deliveryLines.id, line.id)));
    }
    await this.returnOnOrders(tx, orders, unbilled);
    await tx
      .update(salesReturns)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${salesReturns.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(salesReturns.tenantId, tenantId), eq(salesReturns.id, draft.id)));

    // The books (you chose this): Dr Inventory / Cr Cost of goods sold, at what the goods cost
    const entry = await this.books.salesReturn(
      tx,
      { id: draft.id, number, date: draft.date },
      {
        warehouseId: draft.warehouseId,
        costs: values.map((value, index) => ({
          warehouseId: challanOf(index)?.warehouseId ?? draft.warehouseId,
          value,
        })),
      },
    );
    await audit(tx, {
      action: 'sales_return.posted',
      entityType: 'sales_return',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The orders behind some order lines, locked FOR UPDATE in id order (after the challans, the
  // order every posting takes them in): a delivery of the same order waits, then sees what came
  // back. Returns order id → its status.
  private async lockOrders(
    tx: Transaction,
    orderLineIds: readonly string[],
  ): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    if (orderLineIds.length === 0) return new Map();
    const owners = await tx
      .selectDistinct({ orderId: salesOrderLines.orderId })
      .from(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, tenantId), inArray(salesOrderLines.id, [...orderLineIds])),
      );
    const rows = await tx
      .select({ id: salesOrders.id, status: salesOrders.status })
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
      .for('update');
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  // What came back before it was billed goes back onto its order lines (you chose this): their
  // delivered quantity comes down, and a delivered order is confirmed again, so a replacement can go
  // out on it or it can be closed. A confirmed order gets a new version (its page shows old
  // delivered quantities). A closed order keeps its status and its version: migration 0028 freezes
  // a closed order's header, and 0032 lets only its lines' delivered quantity come down.
  private async returnOnOrders(
    tx: Transaction,
    orders: ReadonlyMap<string, string>,
    lines: readonly { orderLineId: string; quantity: string }[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, string[]>();
    for (const line of lines) {
      byOrderLine.set(line.orderLineId, [
        ...(byOrderLine.get(line.orderLineId) ?? []),
        line.quantity,
      ]);
    }
    for (const [orderLineId, quantities] of byOrderLine) {
      await tx
        .update(salesOrderLines)
        .set({
          deliveredQuantity: sql`${salesOrderLines.deliveredQuantity} - ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(salesOrderLines.tenantId, tenantId), eq(salesOrderLines.id, orderLineId)));
    }
    for (const [orderId, status] of orders) {
      if (status !== 'delivered' && status !== 'confirmed') continue;
      await tx
        .update(salesOrders)
        .set({
          status: 'confirmed',
          version: sql`${salesOrders.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, orderId)));
    }
  }

  // Challan line → the posted invoice line that billed it. Read under the challans' lock, so the
  // `invoiced` flag and this agree.
  private async billingOf(
    tx: Transaction,
    deliveryLineIds: readonly string[],
  ): Promise<Map<string, Billing>> {
    if (deliveryLineIds.length === 0) return new Map();
    const rows = await tx
      .select({
        deliveryLineId: invoiceLines.deliveryLineId,
        invoiceId: invoiceLines.invoiceId,
        invoiceLineId: invoiceLines.id,
      })
      .from(invoiceLines)
      .innerJoin(
        invoices,
        and(eq(invoices.tenantId, invoiceLines.tenantId), eq(invoices.id, invoiceLines.invoiceId)),
      )
      .where(
        and(
          eq(invoiceLines.tenantId, getTenantId()),
          inArray(invoiceLines.deliveryLineId, [...deliveryLineIds]),
          eq(invoices.status, 'posted'),
        ),
      );
    const billing = new Map(
      rows.flatMap((row) =>
        row.deliveryLineId === null
          ? []
          : [[row.deliveryLineId, { invoiceId: row.invoiceId, invoiceLineId: row.invoiceLineId }]],
      ),
    );
    for (const id of deliveryLineIds) {
      if (!billing.has(id))
        throw new Error(`Invoiced challan line ${id} has no posted invoice line`);
    }
    return billing;
  }

  // The lines in the order they were written. posted: set when posting has priced them and found
  // the invoice lines that billed them.
  private async writeLines(
    tx: Transaction,
    returnId: string,
    typed: readonly LineRefs[],
    lines: readonly ResolvedLine[],
    posted?: { values: readonly string[]; billing: readonly (Billing | null)[] },
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(salesReturnLines)
      .where(and(eq(salesReturnLines.tenantId, tenantId), eq(salesReturnLines.returnId, returnId)));
    await tx.insert(salesReturnLines).values(
      lines.map((line, index) => ({
        tenantId,
        returnId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        deliveryLineId: typed[index]?.deliveryLineId ?? null,
        invoiceId: posted?.billing[index]?.invoiceId ?? null,
        invoiceLineId: posted?.billing[index]?.invoiceLineId ?? null,
        value: posted?.values[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<ReturnRow> {
    const [row] = await tx
      .select()
      .from(salesReturns)
      .where(and(eq(salesReturns.tenantId, getTenantId()), eq(salesReturns.id, id)))
      .for('update');
    if (!row) throw notFound('Sales return');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, returnId: string): Promise<LineRow[]> {
    return tx
      .select()
      .from(salesReturnLines)
      .where(
        and(eq(salesReturnLines.tenantId, getTenantId()), eq(salesReturnLines.returnId, returnId)),
      )
      .orderBy(asc(salesReturnLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        salesReturn: salesReturns,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(salesReturns)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, salesReturns.tenantId), eq(parties.id, salesReturns.customerId)),
      )
      .where(and(eq(salesReturns.tenantId, getTenantId()), where))
      .orderBy(desc(salesReturns.date), desc(salesReturns.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<SalesReturn> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(salesReturns.id, id), 1);
    if (!found) throw notFound('Sales return');
    const { salesReturn: row } = found;
    const lines = await this.linesOf(tx, id);
    const deliveryLineIds = lines.flatMap((line) =>
      line.deliveryLineId === null ? [] : [line.deliveryLineId],
    );
    const invoiceIds = [
      ...new Set(lines.flatMap((line) => (line.invoiceId === null ? [] : [line.invoiceId]))),
    ];
    const [canSee, entries, variants, batches, challans, billed, credits] = await Promise.all([
      this.access.canSee(),
      this.books.entriesOf(tx, id),
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
      deliveryLineIds.length === 0
        ? []
        : tx
            .select({ lineId: deliveryLines.id, id: deliveries.id, number: deliveries.number })
            .from(deliveryLines)
            .innerJoin(
              deliveries,
              and(
                eq(deliveries.tenantId, deliveryLines.tenantId),
                eq(deliveries.id, deliveryLines.deliveryId),
              ),
            )
            .where(
              and(eq(deliveryLines.tenantId, tenantId), inArray(deliveryLines.id, deliveryLineIds)),
            )
            .orderBy(asc(deliveries.number)),
      invoiceIds.length === 0
        ? []
        : tx
            .select({ id: invoices.id, number: invoices.number })
            .from(invoices)
            .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, invoiceIds))),
      // Drafts too: a second credit note for the same goods is then easy to spot
      tx
        .selectDistinct({ id: creditNotes.id, number: creditNotes.number })
        .from(creditNoteLines)
        .innerJoin(
          creditNotes,
          and(
            eq(creditNotes.tenantId, creditNoteLines.tenantId),
            eq(creditNotes.id, creditNoteLines.creditNoteId),
          ),
        )
        .innerJoin(
          salesReturnLines,
          and(
            eq(salesReturnLines.tenantId, creditNoteLines.tenantId),
            eq(salesReturnLines.id, creditNoteLines.returnLineId),
          ),
        )
        .where(and(eq(creditNoteLines.tenantId, tenantId), eq(salesReturnLines.returnId, id)))
        .orderBy(asc(creditNotes.number)),
    ]);
    const challanOf = new Map(challans.map((challan) => [challan.lineId, challan]));
    const invoiceNumber = new Map(billed.map((invoice) => [invoice.id, invoice.number]));
    return {
      ...toSummary(row, found.customer, found.lineCount),
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          {
            ...toStockLine(
              line,
              variant,
              line.batchId === null ? undefined : batches.get(line.batchId),
            ),
            deliveryLineId: line.deliveryLineId,
            deliveryNumber:
              line.deliveryLineId === null
                ? null
                : (challanOf.get(line.deliveryLineId)?.number ?? null),
            billed: line.invoiceLineId !== null,
            invoiceLineId: line.invoiceLineId,
            invoiceId: line.invoiceId,
            invoiceNumber:
              line.invoiceId === null ? null : (invoiceNumber.get(line.invoiceId) ?? null),
            creditedQuantity: line.creditedQuantity,
            // Worked out from the books: needs inventory.stock.value (step 14)
            value: canSee ? line.value : null,
          },
        ];
      }),
      // Each challan once, by number (the query sorted them)
      deliveries: [
        ...new Map(
          challans.map((challan) => [challan.id, { id: challan.id, number: challan.number }]),
        ).values(),
      ],
      creditNotes: credits,
      entry: entries[0] ?? null,
    };
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: ReturnRow, customer: PartyRef, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      date: row.date,
      customer: customer.code,
      warehouse: warehouse?.code ?? null,
      reason: row.reason,
      lines,
    };
  }
}
