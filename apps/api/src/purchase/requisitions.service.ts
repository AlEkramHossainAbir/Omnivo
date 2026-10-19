import { Inject, Injectable } from '@nestjs/common';
import {
  type OpenRequisitionLinePage,
  type Requisition,
  type RequisitionInput,
  type RequisitionLine,
  requisitionLineAmount,
  type RequisitionOrderFilter,
  type RequisitionOrderState,
  type RequisitionStatus,
  type RequisitionSummary,
  subtractQuantity,
  sumMoney,
  type UpdateRequisitionInput,
} from '@omnivo/contracts';
import {
  products,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  requisitionLines,
  requisitions,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { containsPattern } from '../common/db/search.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import type { VariantInfo } from '../inventory/stock-lines.js';
import { withVariants } from '../sales/sales-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { ApprovalsService } from './approvals.service.js';
import { assertWarehouse, resolvePurchaseItems } from './purchase-lines.js';

type RequisitionRow = typeof requisitions.$inferSelect;
type LineRow = typeof requisitionLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);
// The open lines: oldest requisition first, then its lines in order
const openCursorSchema = z.tuple([z.iso.date(), z.uuid(), z.number().int()]);

// How much of a requisition line purchase orders took, in the base unit (step 17b, decision 16):
// all of an order line while its order is open or received, only what came in once it is closed
// (the rest is still wanted), nothing once it is cancelled. A service is never received, so a
// closed order counts it in full: it was bought. Counted here, never stored (decision 26).
// `line` is the requisition line's name in the outer query.
function orderedOf(line: string): SQL<string> {
  const l = sql.raw(line);
  return sql<string>`coalesce((
    SELECT sum(CASE WHEN po.status = 'closed' AND p.type = 'goods' THEN pl.received_quantity
                    ELSE pl.base_quantity END)
      FROM purchase_order_lines pl
      JOIN purchase_orders po ON po.tenant_id = pl.tenant_id AND po.id = pl.order_id
      JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
     WHERE pl.tenant_id = ${l}.tenant_id AND pl.requisition_line_id = ${l}.id
       AND po.status <> 'cancelled'), 0)`;
}

// Some line of it was ordered, and some line still waits for more
const lineOrdered = sql`EXISTS (
  SELECT 1 FROM requisition_lines rl
   WHERE rl.tenant_id = requisitions.tenant_id AND rl.requisition_id = requisitions.id
     AND ${orderedOf('rl')} > 0
)`;
const lineToOrder = sql`EXISTS (
  SELECT 1 FROM requisition_lines rl
   WHERE rl.tenant_id = requisitions.tenant_id AND rl.requisition_id = requisitions.id
     AND ${orderedOf('rl')} < rl.base_quantity
)`;

// Only an approved or closed requisition is ordered from: a draft's lines are not settled yet
const orderState = sql<RequisitionOrderState>`CASE
  WHEN requisitions.status NOT IN ('approved', 'closed') OR NOT ${lineOrdered} THEN 'not_ordered'
  WHEN ${lineToOrder} THEN 'partly_ordered'
  ELSE 'ordered' END`;

// The list's order filter: approved, with a line still to order (what a buyer works through)
function orderFilter(filter: RequisitionOrderFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  return and(eq(requisitions.status, 'approved'), lineToOrder);
}

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM requisition_lines l
   WHERE l.tenant_id = requisitions.tenant_id AND l.requisition_id = requisitions.id
)`;

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'This requisition was submitted. Reopen it to change it.',
  );
}

function wasSubmitted(): AppError {
  return new AppError(
    409,
    'purchase_was_submitted',
    'This requisition was submitted once, so its approval history stays. Cancel it instead.',
  );
}

// Step 17b: a purchase order buys for it, so its lines must stay as they are
function closeInstead(): AppError {
  return new AppError(
    409,
    'purchase_close_instead',
    'A purchase order buys for this requisition. Close it instead.',
  );
}

function toSummary(
  row: RequisitionRow,
  requestedByName: string,
  lines: number,
  ordered: RequisitionOrderState,
): RequisitionSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    neededBy: row.neededBy,
    warehouseId: row.warehouseId,
    status: row.status,
    orderState: ordered,
    amount: row.amount,
    lineCount: lines,
    requestedBy: { id: row.requestedBy, name: requestedByName },
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows of a requisition: what a person recognises, not ids or every line
function snapshot(row: RequisitionRow, warehouse: string, lines: number) {
  return {
    number: row.number,
    date: row.date,
    neededBy: row.neededBy,
    warehouse,
    amount: row.amount,
    lines,
  };
}

// A line ready to store: the item checked, its amount worked out with the contract's own function
// (the form shows the same number)
interface ResolvedLine {
  item: Awaited<ReturnType<typeof resolvePurchaseItems>>[number];
  estimatedCost: string;
  amount: string;
}

// Purchase requisitions (step 17a). Numbered when saved (decision 19); a draft is changed freely,
// then submitted for approval through ApprovalsService, which moves its status. It moves no stock
// and posts nothing.
@Injectable()
export class RequisitionsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: RequisitionStatus | undefined;
    warehouseId?: string | undefined;
    order?: RequisitionOrderFilter | undefined;
  }): Promise<{ items: RequisitionSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(requisitions.status, query.status),
          query.warehouseId === undefined
            ? undefined
            : eq(requisitions.warehouseId, query.warehouseId),
          orderFilter(query.order),
          after === undefined
            ? undefined
            : sql`(${requisitions.date}, ${requisitions.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [
        last.requisition.date,
        last.requisition.id,
      ]);
      return {
        items: page.items.map((row) =>
          toSummary(row.requisition, row.requestedByName, row.lineCount, row.orderState),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Requisition> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  // Step 17b: the lines a purchase order for this warehouse may buy for (decision 18): lines of
  // approved requisitions with something still to order, oldest requisition first. A closed
  // requisition is left out: its rest will not be bought.
  openLines(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId: string;
    requisitionId?: string | undefined;
    search?: string | undefined;
  }): Promise<OpenRequisitionLinePage> {
    const after = decodeCursor(query.cursor, openCursorSchema);
    const ordered = sql<string>`round(${orderedOf('requisition_lines')}, 4)::text`;
    return this.withTenant(async (tx) => {
      const search =
        query.search === undefined || query.search === ''
          ? undefined
          : containsPattern(query.search);
      const rows = await tx
        .select({
          line: requisitionLines,
          requisition: {
            id: requisitions.id,
            number: requisitions.number,
            date: requisitions.date,
            neededBy: requisitions.neededBy,
          },
          orderedQuantity: ordered,
        })
        .from(requisitionLines)
        .innerJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, requisitionLines.tenantId),
            eq(requisitions.id, requisitionLines.requisitionId),
          ),
        )
        .innerJoin(
          productVariants,
          and(
            eq(productVariants.tenantId, requisitionLines.tenantId),
            eq(productVariants.id, requisitionLines.variantId),
          ),
        )
        .innerJoin(
          products,
          and(
            eq(products.tenantId, productVariants.tenantId),
            eq(products.id, productVariants.productId),
          ),
        )
        .where(
          and(
            eq(requisitionLines.tenantId, getTenantId()),
            eq(requisitions.status, 'approved'),
            eq(requisitions.warehouseId, query.warehouseId),
            query.requisitionId === undefined
              ? undefined
              : eq(requisitions.id, query.requisitionId),
            sql`${orderedOf('requisition_lines')} < ${requisitionLines.baseQuantity}`,
            search === undefined
              ? undefined
              : sql`(lower(${requisitions.number}) LIKE ${search} OR lower(${products.name}) LIKE ${search}
                     OR lower(${products.code}) LIKE ${search} OR lower(${productVariants.sku}) LIKE ${search})`,
            after === undefined
              ? undefined
              : sql`(${requisitions.date}, ${requisitions.id}, ${requisitionLines.lineNo}) > (${after[0]}::date, ${after[1]}::uuid, ${after[2]}::int)`,
          ),
        )
        .orderBy(asc(requisitions.date), asc(requisitions.id), asc(requisitionLines.lineNo))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [
        last.requisition.date,
        last.requisition.id,
        last.line.lineNo,
      ]);
      const lines = await withVariants(
        tx,
        page.items.map((row) => ({ ...row, variantId: row.line.variantId })),
      );
      return {
        items: lines.map(({ row, variant }) => ({
          ...toLine(row.line, variant, row.orderedQuantity),
          requisition: row.requisition,
          remainingQuantity: subtractQuantity(row.line.baseQuantity, row.orderedQuantity),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  create(input: RequisitionInput): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      await assertWarehouse(tx, input.warehouseId);
      const lines = await this.resolveLines(tx, input.lines);
      // Numbered at once, like a quotation: people refer to it while it waits. A deleted draft
      // leaves a gap, which is fine for a request.
      const number = await this.numbering.next(tx, 'purchase.requisition', input.date);
      const userId = currentPrincipal().userId;
      const [row] = await tx
        .insert(requisitions)
        .values({
          tenantId: getTenantId(),
          number,
          date: input.date,
          neededBy: input.neededBy,
          warehouseId: input.warehouseId,
          amount: sumMoney(lines.map((line) => line.amount)),
          note: input.note,
          requestedBy: userId,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error('Requisition insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'requisition.created',
        entityType: 'requisition',
        entityId: row.id,
        changes: created(snapshot(row, await this.warehouseName(tx, row), lines.length)),
      });
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateRequisitionInput): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      if (before.status !== 'draft') throw notDraft();
      const linesBefore = await this.linesOf(tx, id);
      await assertWarehouse(tx, input.warehouseId, before.warehouseId);
      const lines = await this.resolveLines(tx, input.lines);
      const [updated] = await tx
        .update(requisitions)
        .set({
          date: input.date,
          neededBy: input.neededBy,
          warehouseId: input.warehouseId,
          amount: sumMoney(lines.map((line) => line.amount)),
          note: input.note,
          version: sql`${requisitions.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)))
        .returning();
      if (!updated) throw notFound('Requisition');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'requisition.updated',
        entityType: 'requisition',
        entityId: id,
        changes: diff(
          snapshot(before, await this.warehouseName(tx, before), linesBefore.length),
          snapshot(updated, await this.warehouseName(tx, updated), lines.length),
        ),
      });
      return this.read(tx, id);
    });
  }

  // Only a draft that was never submitted: a mistake nobody saw. Once submitted, its approval
  // history stays, and it is cancelled instead (decision 19).
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id, version);
        const { rounds } = await this.approvals.history(tx, 'requisition', id);
        if (before.status !== 'draft' || rounds.length > 0) throw wasSubmitted();
        const lines = await this.linesOf(tx, id);
        const warehouse = await this.warehouseName(tx, before);
        // The lines go with it (ON DELETE CASCADE)
        await tx
          .delete(requisitions)
          .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
        await audit(tx, {
          action: 'requisition.deleted',
          entityType: 'requisition',
          entityId: id,
          changes: diff(snapshot(before, warehouse, lines.length), {
            number: null,
            date: null,
            neededBy: null,
            warehouse: null,
            amount: null,
            lines: null,
          }),
        });
      });
    } catch (error) {
      // The database's own rule (0036), should a submit commit between our check and the delete
      if (isCheckViolation(error, 'requisitions_submitted_immutable')) throw wasSubmitted();
      throw error;
    }
  }

  // Sent for approval with the amount it has now: that amount chooses the levels
  submit(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft') throw notDraft();
      await this.approvals.submit(tx, 'requisition', id, row.amount);
      return this.read(tx, id);
    });
  }

  // Pending: taken back to change it. Approved: changed after all, then approved again from the
  // first level (decision 6). Step 17b: refused once a purchase order buys for it, even a draft one
  // (decision 27): reopening writes its lines again, and the order's lines would lose their link.
  reopen(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'pending' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_reopen',
          'Only a pending or approved requisition can be reopened.',
        );
      }
      if (row.status === 'approved' && (await this.isOrdered(tx, id))) throw closeInstead();
      await this.approvals.reopen(tx, 'requisition', id, row.status);
      return this.read(tx, id);
    });
  }

  // Will not be bought. A pending one is reopened first: someone may be deciding it right now.
  // Step 17b: once an order buys for it, some of it is being bought, so it is closed instead.
  cancel(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_cancel',
          'Only a draft or approved requisition can be cancelled. Reopen a pending one first.',
        );
      }
      if (row.status === 'approved' && (await this.isOrdered(tx, id))) throw closeInstead();
      await tx
        .update(requisitions)
        .set({
          status: 'cancelled',
          version: sql`${requisitions.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
      await audit(tx, {
        action: 'requisition.cancelled',
        entityType: 'requisition',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'cancelled' }),
      });
      return this.read(tx, id);
    });
  }

  // Step 17b (decision 17): partly ordered, and the rest will not be. It leaves the lines still to
  // order; the orders already written go on. Closed is final.
  close(id: string, version: number): Promise<Requisition> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_not_approved',
          'Only an approved requisition can be closed.',
        );
      }
      if (!(await this.isOrdered(tx, id))) {
        throw new AppError(
          409,
          'purchase_cancel_instead',
          'No purchase order buys for this requisition. Cancel it instead.',
        );
      }
      await tx
        .update(requisitions)
        .set({
          status: 'closed',
          version: sql`${requisitions.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
      await audit(tx, {
        action: 'requisition.closed',
        entityType: 'requisition',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'closed' }),
      });
      return this.read(tx, id);
    });
  }

  // An order that is not cancelled buys for one of its lines (migration 0038's function, the same
  // question its guard asks). Asked after lock(): a purchase order line written at the same moment
  // locks the requisition FOR SHARE, so it either committed before our FOR UPDATE (and is counted
  // here) or waits for us and then finds the requisition changed.
  private async isOrdered(tx: Transaction, id: string): Promise<boolean> {
    const [row] = z
      .array(z.object({ ordered: z.boolean() }))
      .parse(
        await tx.execute(
          sql`SELECT requisition_is_ordered(${getTenantId()}::uuid, ${id}::uuid) AS ordered`,
        ),
      );
    return row?.ordered === true;
  }

  // What each line of it was ordered, in the base unit (orderedOf)
  private async orderedQuantities(
    tx: Transaction,
    requisitionId: string,
  ): Promise<Map<string, string>> {
    const rows = await tx
      .select({
        id: requisitionLines.id,
        ordered: sql<string>`round(${orderedOf('requisition_lines')}, 4)::text`,
      })
      .from(requisitionLines)
      .where(
        and(
          eq(requisitionLines.tenantId, getTenantId()),
          eq(requisitionLines.requisitionId, requisitionId),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.ordered]));
  }

  // The orders that buy for it, by number; a cancelled one bought nothing. A draft that was never
  // submitted has no number yet (null).
  private ordersOf(tx: Transaction, requisitionId: string) {
    return tx
      .selectDistinct({ id: purchaseOrders.id, number: purchaseOrders.number })
      .from(purchaseOrderLines)
      .innerJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, purchaseOrderLines.tenantId),
          eq(purchaseOrders.id, purchaseOrderLines.orderId),
        ),
      )
      .where(
        and(
          eq(purchaseOrderLines.tenantId, getTenantId()),
          inArray(
            purchaseOrderLines.requisitionLineId,
            tx
              .select({ id: requisitionLines.id })
              .from(requisitionLines)
              .where(
                and(
                  eq(requisitionLines.tenantId, getTenantId()),
                  eq(requisitionLines.requisitionId, requisitionId),
                ),
              ),
          ),
          ne(purchaseOrders.status, 'cancelled'),
        ),
      )
      .orderBy(asc(purchaseOrders.number), asc(purchaseOrders.id));
  }

  private async resolveLines(
    tx: Transaction,
    lines: RequisitionInput['lines'],
  ): Promise<ResolvedLine[]> {
    const items = await resolvePurchaseItems(tx, lines);
    return items.map((item, index) => {
      // resolvePurchaseItems() returns one item per line, in order, or throws
      const estimatedCost = lines[index]?.estimatedCost ?? '0';
      return {
        item,
        estimatedCost,
        amount: requisitionLineAmount(item.quantity, estimatedCost),
      };
    });
  }

  // A save replaces all the lines, like a quotation's. The database lets it only while the
  // requisition is a draft (requisition_lines_locked).
  private async writeLines(
    tx: Transaction,
    requisitionId: string,
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(requisitionLines)
      .where(
        and(
          eq(requisitionLines.tenantId, tenantId),
          eq(requisitionLines.requisitionId, requisitionId),
        ),
      );
    await tx.insert(requisitionLines).values(
      lines.map((line, index) => ({
        tenantId,
        requisitionId,
        lineNo: index + 1,
        productId: line.item.variant.productId,
        variantId: line.item.variant.variantId,
        unitId: line.item.unitId,
        quantity: line.item.quantity,
        factor: line.item.factor,
        baseQuantity: line.item.baseQuantity,
        description: line.item.description,
        estimatedCost: line.estimatedCost,
        amount: line.amount,
      })),
    );
  }

  // FOR UPDATE: two saves, a save and a submit, or a submit and an approval take turns. The
  // approvals engine locks the document first too (APPROVAL_TARGETS).
  private async lock(tx: Transaction, id: string, version: number): Promise<RequisitionRow> {
    const [row] = await tx
      .select()
      .from(requisitions)
      .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)))
      .for('update');
    if (!row) throw notFound('Requisition');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, requisitionId: string) {
    return tx
      .select()
      .from(requisitionLines)
      .where(
        and(
          eq(requisitionLines.tenantId, getTenantId()),
          eq(requisitionLines.requisitionId, requisitionId),
        ),
      )
      .orderBy(asc(requisitionLines.lineNo));
  }

  private async warehouseName(tx: Transaction, row: RequisitionRow): Promise<string> {
    const [warehouse] = await tx
      .select({ name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return warehouse?.name ?? row.warehouseId;
  }

  // The requisitions with who asked and their line counts, newest date first
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({ requisition: requisitions, requestedByName: users.fullName, lineCount, orderState })
      .from(requisitions)
      .innerJoin(users, eq(users.id, requisitions.requestedBy))
      .where(and(eq(requisitions.tenantId, getTenantId()), where))
      .orderBy(desc(requisitions.date), desc(requisitions.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Requisition> {
    const [found] = await this.rows(tx, eq(requisitions.id, id), 1);
    if (!found) throw notFound('Requisition');
    const { requisition: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    const ordered = await this.orderedQuantities(tx, id);
    return {
      ...toSummary(row, found.requestedByName, found.lineCount, found.orderState),
      note: row.note,
      lines: lines.map(({ row: line, variant }) =>
        toLine(line, variant, ordered.get(line.id) ?? '0.0000'),
      ),
      approval: await this.approvals.history(tx, 'requisition', id),
      orders: await this.ordersOf(tx, id),
    };
  }
}

// A stored line with its variant, as the API sends it
function toLine(line: LineRow, variant: VariantInfo, orderedQuantity: string): RequisitionLine {
  return {
    id: line.id,
    variantId: variant.variantId,
    productId: variant.productId,
    productCode: variant.productCode,
    productName: variant.productName,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: variant.baseUnitId,
    productType: variant.type,
    units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    unitId: line.unitId,
    quantity: line.quantity,
    baseQuantity: line.baseQuantity,
    description: line.description,
    estimatedCost: line.estimatedCost,
    amount: line.amount,
    orderedQuantity,
  };
}
