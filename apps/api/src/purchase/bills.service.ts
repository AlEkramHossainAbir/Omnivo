import { Inject, Injectable } from '@nestjs/common';
import {
  type Bill,
  type BillInput,
  type BillLineInput,
  type BillPaymentFilter,
  type BillStatus,
  type BillSummary,
  billAmountDueOf,
  compareMoney,
  compareQuantity,
  documentTotals,
  dueDateOf,
  type ErrorCode,
  expenseLineAmounts,
  isQuantity,
  isZeroQuantity,
  type LineAmounts,
  moneyAccountIds,
  type PartyRef,
  priceDifferenceOf,
  subtractMoney,
  sumMoney,
  toBaseQuantity,
  todayIn,
  type UpdateBillInput,
} from '@omnivo/contracts';
import {
  billExpenses,
  billLines,
  bills,
  goodsReceiptLines,
  goodsReceipts,
  ledgerAccounts,
  parties,
  products,
  purchaseOrderLines,
  purchaseOrders,
  supplierPaymentAllocations,
  supplierPayments,
  taxRates,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  batchesOf,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';
import { stockAccountIds } from '../journal/posting.service.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertBranch,
  customerRefs,
  type ResolvedSalesLine,
  salesLineValues,
  toSalesLine,
  withVariants,
} from '../sales/sales-lines.js';
import { ApprovalsService } from './approvals.service.js';
import { GoodsReceiptsService, resolveReceiptLines } from './goods-receipts.service.js';
import { readPurchaseAccounts } from './purchase-accounts.service.js';
import { type BillPosting, PurchaseBooksService } from './purchase-books.service.js';
import { assertSupplier, assertWarehouse, resolvePurchaseLines } from './purchase-lines.js';

type BillRow = typeof bills.$inferSelect;
type BillLineRow = typeof billLines.$inferSelect;
type ExpenseRow = typeof billExpenses.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM bill_lines l
   WHERE l.tenant_id = bills.tenant_id AND l.bill_id = bills.id
)`;

// Posted and not paid in full: what a payment can still be applied to. The same condition as the
// two partial indexes (bills_open_supplier_idx, bills_open_due_idx), so they are used.
const isOpen = sql`${bills.status} = 'posted' AND ${bills.amountPaid} < ${bills.total}`;

// What a line names, as the form sends it and as the database keeps it. A stored receipt line has
// both ids (it keeps a copy of its order line), so a receipt line is recognised first.
interface LineRefs {
  receiptLineId: string | null;
  orderLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
}

// What a line bills, once checked
interface LineSource {
  receiptLineId: string | null;
  // The order line behind it: a receipt line's own, or an order's service line
  orderLineId: string | null;
}

// A goods receipt line a bill line bills, as the posting needs it: what the receipt booked and
// where (the branch of its warehouse)
interface ReceiptLineInfo {
  orderValue: string;
  warehouseId: string;
}

// What checkSources() found
interface Sources {
  lines: LineSource[];
  // The prices-with-VAT setting of the orders behind the lines; null when no line has an order
  pricesIncludeVat: boolean | null;
  // The shortest payment terms of those orders, for an empty due date (decision 19)
  paymentTermsDays: number | null;
  // What the lines bill stays billable after it is archived: the goods came in, the service was
  // ordered
  keptVariantIds: Set<string>;
  keptRateIds: Set<string>;
  receiptLines: Map<string, ReceiptLineInfo>;
}

// A line's stock fields, as a goods line of its own keeps them until its posting receives it
interface OwnStock {
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: string[];
}

// Everything a save writes, worked out by check()
interface CheckedBill {
  header: Omit<typeof bills.$inferInsert, 'tenantId' | 'createdBy' | 'updatedBy'>;
  lines: ResolvedSalesLine[];
  sources: LineSource[];
  accounts: (string | null)[];
  stock: OwnStock[];
  expenses: { input: BillInput['expenses'][number]; rate: RateRow; amounts: LineAmounts }[];
}

type RateRow = Pick<typeof taxRates.$inferSelect, 'id' | 'name' | 'kind' | 'rate'>;

const NO_STOCK: OwnStock = {
  lotNumber: null,
  expiresOn: null,
  manufacturedOn: null,
  serialNumbers: [],
};

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'This bill was submitted. Reopen it to change it, if it is not posted.',
  );
}

function wasSubmitted(): AppError {
  return new AppError(
    409,
    'purchase_was_submitted',
    'This bill was submitted once, so its number and approval history stay. Cancel it instead.',
  );
}

function numberTaken(): AppError {
  return new AppError(
    409,
    'bill_supplier_number_taken',
    'This supplier already has a bill with this number. Check that it is not booked already.',
    { fieldErrors: { supplierBillNumber: ['bill_supplier_number_taken'] } },
  );
}

function warehouseRequired(): AppError {
  return new AppError(
    409,
    'bill_warehouse_required',
    'Pick the warehouse the goods of this bill come into.',
    { fieldErrors: { warehouseId: ['bill_warehouse_required'] } },
  );
}

// The database's last word, if two writers got past the API's checks (two bills of the same
// supplier number saved at the same moment, two bills of the same receipt line or service posted
// at the same moment): the codes the form knows
function billRace(error: unknown): unknown {
  if (isUniqueViolation(error, 'bills_supplier_bill_number_idx')) return numberTaken();
  if (
    isCheckViolation(error, 'bills_receipts_check') ||
    isCheckViolation(error, 'goods_receipt_lines_posted_immutable')
  ) {
    return new AppError(
      409,
      'bill_receipt_line_billed',
      'Another bill billed some of these goods receipt lines first.',
    );
  }
  if (isCheckViolation(error, 'bills_order_lines_check')) {
    return new AppError(
      409,
      'bill_order_line_billed',
      'Another bill billed some of these services first.',
    );
  }
  return error;
}

function toSummary(row: BillRow, supplier: PartyRef, lines: number): BillSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    dueDate: row.dueDate,
    supplier,
    supplierBillNumber: row.supplierBillNumber,
    mushakNumber: row.mushakNumber,
    mushakDate: row.mushakDate,
    branchId: row.branchId,
    status: row.status,
    net: row.net,
    vat: row.vat,
    total: row.total,
    amountPaid: row.amountPaid,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What a line comes to in its item's base unit: a receipt line is billed whole, in any unit of the
// item. null when the unit is not one of the item's.
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

// The goods receipt a bill makes names its lines lines.0, lines.1 …; on the bill those are, say,
// lines.2 and lines.5. `indexes` maps one to the other, so each problem shows under the bill line
// it belongs to (like an invoice's own challan, step 15c).
function onBillLines(error: unknown, indexes: readonly number[]): never {
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

// Supplier bills (step 17c). A draft is changed freely; submitting numbers it and hands it to the
// approvals engine (17a), whose last approval posts it (decision 7): its own goods come in on a
// goods receipt, the receipt lines it bills are marked billed, and the entry is booked, all in the
// approver's transaction. A posted bill never changes; payments settle it.
@Injectable()
export class BillsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly receipts: GoodsReceiptsService,
    private readonly books: PurchaseBooksService,
  ) {
    // The engine calls this when a bill's last approval is given, or at its submit when no level
    // applies (decision 7)
    approvals.onApproved('bill', (tx, id) => this.post(tx, id));
  }

  // Newest date first; open and overdue bills oldest due date first, the order a payment pays them
  // in (the payment form reads this list for its suggestion)
  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: BillStatus | undefined;
    supplierId?: string | undefined;
    payment?: BillPaymentFilter | undefined;
  }): Promise<{ items: BillSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    const byDue = query.payment === 'open' || query.payment === 'overdue';
    return this.withTenant(async (tx) => {
      const today = query.payment === 'overdue' ? await this.today(tx) : null;
      const keyset = byDue
        ? sql`(${bills.dueDate}, ${bills.id}) > (${after?.[0]}::date, ${after?.[1]}::uuid)`
        : sql`(${bills.date}, ${bills.id}) < (${after?.[0]}::date, ${after?.[1]}::uuid)`;
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(bills.status, query.status),
          query.supplierId === undefined ? undefined : eq(bills.supplierId, query.supplierId),
          this.paymentFilter(query.payment, today),
          after === undefined ? undefined : keyset,
        ),
        query.limit + 1,
        byDue ? [asc(bills.dueDate), asc(bills.id)] : undefined,
      );
      const page = toPage(rows, query.limit, (last) =>
        byDue ? [last.bill.dueDate, last.bill.id] : [last.bill.date, last.bill.id],
      );
      return {
        items: page.items.map((row) => toSummary(row.bill, row.supplier, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Bill> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: BillInput): Promise<Bill> {
    try {
      return await this.withTenant(async (tx) => {
        const supplier = await assertSupplier(tx, input.supplierId);
        const fields = await this.check(tx, supplier.id, input, null);
        const userId = currentPrincipal().userId;
        const [row] = await tx
          .insert(bills)
          .values({
            tenantId: getTenantId(),
            ...fields.header,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning();
        if (!row) throw new Error('Bill insert returned no row');
        await this.writeLines(tx, row.id, fields);
        await audit(tx, {
          action: 'bill.created',
          entityType: 'bill',
          entityId: row.id,
          changes: created(this.snapshot(row, supplier, fields)),
        });
        if (input.submit) await this.submitLocked(tx, row);
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw billRace(error);
    }
  }

  async update(id: string, input: UpdateBillInput): Promise<Bill> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, input.version);
        const linesBefore = await this.linesOf(tx, id);
        const expensesBefore = await this.expensesOf(tx, id);
        const supplierBefore = await this.supplierOf(tx, before.supplierId);
        const supplier = await assertSupplier(tx, input.supplierId, before.supplierId);
        // Once numbered, the approvers saw it as this supplier's bill: a reopened bill keeps its
        // supplier, like a reopened order (17b's decision 33)
        if (before.number !== null && supplier.id !== before.supplierId) {
          throw new AppError(
            409,
            'purchase_supplier_invalid',
            'This bill was submitted for its supplier. Write a new bill for another one.',
            { fieldErrors: { supplierId: ['purchase_supplier_invalid'] } },
          );
        }
        const fields = await this.check(tx, supplier.id, input, {
          row: before,
          lines: linesBefore,
          expenses: expensesBefore,
        });
        const [updated] = await tx
          .update(bills)
          .set({
            ...fields.header,
            version: sql`${bills.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, id)))
          .returning();
        if (!updated) throw notFound('Bill');
        await this.writeLines(tx, id, fields);
        await audit(tx, {
          action: 'bill.updated',
          entityType: 'bill',
          entityId: id,
          changes: diff(
            this.snapshotOf(before, supplierBefore, linesBefore.length, expensesBefore.length),
            this.snapshot(updated, supplier, fields),
          ),
        });
        if (input.submit) await this.submitLocked(tx, updated);
        return this.read(tx, id);
      });
    } catch (error) {
      throw billRace(error);
    }
  }

  // Only a draft that was never submitted (decision 13); once numbered it is cancelled instead
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, version);
        if (before.number !== null) throw wasSubmitted();
        const lines = await this.linesOf(tx, id);
        const expenses = await this.expensesOf(tx, id);
        const supplier = await this.supplierOf(tx, before.supplierId);
        // The lines and expenses go with it (ON DELETE CASCADE)
        await tx.delete(bills).where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, id)));
        const snapshot = this.snapshotOf(before, supplier, lines.length, expenses.length);
        await audit(tx, {
          action: 'bill.deleted',
          entityType: 'bill',
          entityId: id,
          changes: diff(
            snapshot,
            Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
          ),
        });
      });
    } catch (error) {
      // The database's own rule (0040), should a submit commit between our check and the delete
      if (isCheckViolation(error, 'bills_submitted_immutable')) throw wasSubmitted();
      throw error;
    }
  }

  submit(id: string, version: number): Promise<Bill> {
    return this.withTenant(async (tx) => {
      const row = await this.lockDraft(tx, id, version);
      try {
        await this.submitLocked(tx, row);
      } catch (error) {
        throw billRace(error);
      }
      return this.read(tx, id);
    });
  }

  // Pending: taken back to change it, or because the supplier sent a corrected bill. A posted bill
  // is never reopened: a debit note corrects it (17d).
  reopen(id: string, version: number): Promise<Bill> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'pending') {
        throw new AppError(
          409,
          'purchase_cannot_reopen',
          'Only a bill waiting for approval can be reopened.',
        );
      }
      await this.approvals.reopen(tx, 'bill', id, 'pending');
      return this.read(tx, id);
    });
  }

  // Will not be booked: a numbered draft, or a pending bill, which is reopened first in the same
  // transaction so its waiting round ends as reopened (decision 31). Its supplier number is free
  // again (bills_supplier_bill_number_idx leaves cancelled bills out).
  cancel(id: string, version: number): Promise<Bill> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft' && row.status !== 'pending') {
        throw new AppError(
          409,
          'purchase_cannot_cancel',
          'A posted bill is not cancelled. A debit note corrects it.',
        );
      }
      if (row.number === null) {
        throw new AppError(
          409,
          'purchase_delete_instead',
          'This bill was never submitted. Delete it instead.',
        );
      }
      if (row.status === 'pending') await this.approvals.reopen(tx, 'bill', id, 'pending');
      await tx
        .update(bills)
        .set({
          status: 'cancelled',
          version: sql`${bills.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, id)));
      await audit(tx, {
        action: 'bill.cancelled',
        entityType: 'bill',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'cancelled' }),
      });
      return this.read(tx, id);
    });
  }

  // Numbered the first time (decision 13), checked again as it stands now, then handed to the
  // engine with its total, VAT included. With no level for that total, the engine posts it at once
  // (post() below); else it waits for the first level. The bill is locked by the caller.
  private async submitLocked(tx: Transaction, row: BillRow): Promise<void> {
    await this.recheck(tx, row, 'share');
    // Still a draft here, so the database lets the number be set; bills_number_check needs it
    // before the engine moves the status to pending
    if (row.number === null) {
      await tx
        .update(bills)
        .set({ number: await this.numbering.next(tx, 'purchase.bill', row.date) })
        .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, row.id)));
    }
    await this.approvals.submit(tx, 'bill', row.id, row.total);
  }

  // The stored bill against what is true now, without the draft's allowances: an active supplier,
  // branch and warehouse (decision 34 of 17b), each line's source still billable, each account still
  // usable. Returns what the posting needs.
  private async recheck(tx: Transaction, row: BillRow, lock: 'share' | 'update') {
    await assertSupplier(tx, row.supplierId);
    await assertBranch(tx, row.branchId, 'purchase_branch_invalid');
    const stored = await this.linesOf(tx, row.id);
    const expenses = await this.expensesOf(tx, row.id);
    const sources = await this.checkSources(tx, row.id, row.supplierId, stored, lock);
    const goods = await this.goodsProducts(
      tx,
      stored.map((line) => line.productId),
    );
    const own = stored.flatMap((line, index) =>
      line.receiptLineId === null && line.orderLineId === null && goods.has(line.productId)
        ? [index]
        : [],
    );
    if (own.length > 0) {
      if (row.warehouseId === null) throw warehouseRequired();
      await assertWarehouse(tx, row.warehouseId);
    }
    await checkCostAccounts(tx, [
      ...stored.flatMap((line, index) =>
        line.accountId === null
          ? []
          : [{ path: linePath(index, 'accountId'), accountId: line.accountId }],
      ),
      ...expenses.map((expense, index) => ({
        path: `expenses.${String(index)}.accountId`,
        accountId: expense.accountId,
      })),
    ]);
    return { stored, expenses, sources, own };
  }

  // Posting (decision 7), called by the approvals engine when the last approval is given, or at
  // submit when no level applies. The bill is locked (the engine's lock order) and still pending;
  // its round is approved. In the order migration 0040 needs: (1) the goods of its own lines come
  // in on a goods receipt the bill makes, (2) those lines get their receipt lines, (3) every
  // receipt line it bills is marked billed, (4) the entry, (5) the bill becomes posted. A refused
  // step leaves nothing: no number used, no stock moved, nothing billed, and the approval with it.
  private async post(tx: Transaction, id: string): Promise<void> {
    try {
      await this.postLocked(tx, id);
    } catch (error) {
      throw billRace(error);
    }
  }

  private async postLocked(tx: Transaction, id: string): Promise<void> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.tenantId, tenantId), eq(bills.id, id)));
    if (row?.status !== 'pending' || row.number === null) {
      throw new Error(`Bill ${id} is not a numbered pending bill`);
    }
    const number = row.number;
    // The date first: a closed period refuses before anything is locked or moved
    await assertPeriodOpen(tx, row.date);
    // Again, under the locks: another bill may have billed a line since this one was submitted
    const { stored, expenses, sources, own } = await this.recheck(tx, row, 'update');

    // (1) and (2): the goods of its own lines, received into the bill's warehouse at their net
    const receiptLineIds = sources.lines.map((source) => source.receiptLineId);
    const ownBranch = new Map<string, string>();
    if (own.length > 0 && row.warehouseId !== null) {
      let made: string[];
      try {
        made = await this.receipts.receiveForBill(tx, {
          billId: id,
          billNumber: number,
          supplierId: row.supplierId,
          date: row.date,
          warehouseId: row.warehouseId,
          lines: own.map((index) => {
            const line = stored[index];
            if (line === undefined) throw new Error(`Bill line ${String(index)} is missing`);
            return {
              variantId: line.variantId,
              unitId: line.unitId,
              quantity: line.quantity,
              lotNumber: line.lotNumber,
              expiresOn: line.expiresOn,
              manufacturedOn: line.manufacturedOn,
              serialNumbers: line.serialNumbers,
              value: line.net,
            };
          }),
        });
      } catch (error) {
        onBillLines(error, own);
      }
      const branchId = await this.branchOf(tx, row.warehouseId);
      for (const [position, index] of own.entries()) {
        const line = stored[index];
        const receiptLineId = made[position];
        if (line === undefined || receiptLineId === undefined) continue;
        receiptLineIds[index] = receiptLineId;
        ownBranch.set(line.id, branchId);
        // Only this column in this statement: the one change a pending bill's line allows
        await tx
          .update(billLines)
          .set({ receiptLineId })
          .where(and(eq(billLines.tenantId, tenantId), eq(billLines.id, line.id)));
      }
    }

    // (3) Each receipt line billed once: false → true, never back. The lines are locked
    // (checkSources), so a second bill waits and then fails there; the condition on `billed` is
    // the last word if anything slipped past.
    const toMark = receiptLineIds.filter((lineId): lineId is string => lineId !== null);
    if (toMark.length > 0) {
      const marked = await tx
        .update(goodsReceiptLines)
        .set({ billed: true })
        .where(
          and(
            eq(goodsReceiptLines.tenantId, tenantId),
            inArray(goodsReceiptLines.id, toMark),
            eq(goodsReceiptLines.billed, false),
          ),
        )
        .returning({ id: goodsReceiptLines.id });
      if (marked.length !== toMark.length) {
        throw new AppError(
          409,
          'bill_receipt_line_billed',
          'Another bill billed some of these goods receipt lines first.',
        );
      }
    }

    // (4) The books
    const branchOfWarehouse = await this.branchesOf(
      tx,
      [...sources.receiptLines.values()].map((line) => line.warehouseId),
    );
    const posting: BillPosting = {
      supplierId: row.supplierId,
      branchId: row.branchId,
      vat: row.vat,
      total: row.total,
      goods: stored.flatMap((line, index) => {
        const ownBranchId = ownBranch.get(line.id);
        // A line of its own came in at its net: no price difference
        if (ownBranchId !== undefined) {
          return [{ receiptBranchId: ownBranchId, orderValue: line.net, difference: '0' }];
        }
        const receiptLineId = sources.lines[index]?.receiptLineId ?? null;
        const receipt =
          receiptLineId === null ? undefined : sources.receiptLines.get(receiptLineId);
        if (receipt === undefined) return [];
        const receiptBranchId = branchOfWarehouse.get(receipt.warehouseId);
        if (receiptBranchId === undefined) {
          throw new Error(`Warehouse ${receipt.warehouseId} has no branch`);
        }
        return [
          {
            receiptBranchId,
            orderValue: receipt.orderValue,
            difference: priceDifferenceOf({ net: line.net, orderValue: receipt.orderValue }),
          },
        ];
      }),
      costs: [
        ...stored.flatMap((line) =>
          line.accountId === null ? [] : [{ accountId: line.accountId, net: line.net }],
        ),
        ...expenses.map((expense) => ({ accountId: expense.accountId, net: expense.net })),
      ],
    };
    const entry = await this.books.bill(tx, { id, number, date: row.date }, posting);

    // (5) Posted last: the database checks (1)–(3) happened (bills_receipts_check)
    await tx
      .update(bills)
      .set({
        status: 'posted',
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${bills.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(bills.tenantId, tenantId), eq(bills.id, id)));
    await audit(tx, {
      action: 'bill.posted',
      entityType: 'bill',
      entityId: id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // Every rule of a save the contract cannot check, and what the save writes. `before`: the draft
  // being changed (null for a new bill); its VAT rates stay usable, like an invoice's.
  private async check(
    tx: Transaction,
    supplierId: string,
    input: BillInput,
    before: {
      row: BillRow;
      lines: readonly BillLineRow[];
      expenses: readonly ExpenseRow[];
    } | null,
  ): Promise<CheckedBill> {
    await assertBranch(tx, input.branchId, 'purchase_branch_invalid');
    // FOR SHARE on the orders of the service lines: a reopen waits until we commit, then sees
    // this draft's lines (decision 30)
    const sources = await this.checkSources(
      tx,
      before?.row.id ?? null,
      supplierId,
      input.lines,
      'share',
    );
    // The orders' setting when the lines bill orders (decision 15 of 17b), else the form's
    const pricesIncludeVat = sources.pricesIncludeVat ?? input.pricesIncludeVat;
    const keptRateIds = new Set([
      ...sources.keptRateIds,
      ...(before?.lines.map((line) => line.taxRateId) ?? []),
      ...(before?.expenses.map((expense) => expense.taxRateId) ?? []),
    ]);
    const lines = await resolvePurchaseLines(
      tx,
      input.lines,
      pricesIncludeVat,
      keptRateIds,
      sources.keptVariantIds,
    );
    const own = await this.checkOwnLines(tx, input, lines, sources.lines, before?.row ?? null);
    const expenses = await this.resolveExpenses(tx, input.expenses, pricesIncludeVat, keptRateIds);
    await checkCostAccounts(tx, [
      ...own.accounts.flatMap((accountId, index) =>
        accountId === null ? [] : [{ path: linePath(index, 'accountId'), accountId }],
      ),
      ...input.expenses.map((expense, index) => ({
        path: `expenses.${String(index)}.accountId`,
        accountId: expense.accountId,
      })),
    ]);
    const [supplier] = await tx
      .select({ paymentTermsDays: parties.supplierPaymentTermsDays })
      .from(parties)
      .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, supplierId)));
    const terms = sources.paymentTermsDays ?? supplier?.paymentTermsDays ?? 0;
    return {
      header: {
        date: input.date,
        // An empty box: the date plus the orders' payment terms, else the supplier's (decision 19)
        dueDate: input.dueDate ?? dueDateOf(input.date, terms),
        supplierId,
        supplierBillNumber: input.supplierBillNumber,
        mushakNumber: input.mushakNumber,
        mushakDate: input.mushakDate,
        branchId: input.branchId,
        // Only a bill with goods of its own receives anything (the contract: null when none)
        warehouseId: own.warehouseId,
        pricesIncludeVat,
        note: input.note,
        ...documentTotals([
          ...lines.map((line) => line.amounts),
          ...expenses.map((expense) => expense.amounts),
        ]),
      },
      lines,
      sources: sources.lines,
      accounts: own.accounts,
      stock: own.stock,
      expenses,
    };
  }

  // What each line bills, checked against the goods receipts and orders it names (decision 4): a
  // receipt line must be on a posted goods receipt of this supplier that a person made from an
  // order (a receipt a bill made is that bill's), of the same item, accepted something, billed
  // whole (in any unit of the item) and not billed yet by a posted bill; an order line must be a
  // service line of an approved, received or closed order of this supplier, billed whole, and not
  // billed by another posted bill. A draft bill holds nothing (decision 29). All problems come
  // back at once, under each line.
  // lock 'share' (a save, a submit): the orders of the service lines FOR SHARE in id order, so a
  // reopen or a cancel of the order waits for us. lock 'update' (the posting): the receipt lines
  // and the service lines FOR NO KEY UPDATE in id order, so a second bill posting the same line
  // waits, then finds it billed; NO KEY, so a draft bill line being saved against them (a KEY SHARE
  // lock through its foreign key) is not blocked.
  private async checkSources(
    tx: Transaction,
    billId: string | null,
    supplierId: string,
    lines: readonly LineRefs[],
    lock: 'share' | 'update',
  ): Promise<Sources> {
    const receiptLineIds = lines.flatMap((line) =>
      line.receiptLineId === null ? [] : [line.receiptLineId],
    );
    const serviceLineIds = lines.flatMap((line) =>
      line.receiptLineId === null && line.orderLineId !== null ? [line.orderLineId] : [],
    );
    const receiptLines = await this.receiptLines(tx, receiptLineIds, lock);
    const orderLineIds = [
      ...new Set([
        ...serviceLineIds,
        ...[...receiptLines.values()].flatMap((line) =>
          line.orderLineId === null ? [] : [line.orderLineId],
        ),
      ]),
    ];
    const orderLines = await this.orderLines(tx, orderLineIds, new Set(serviceLineIds), lock);
    const billedServices = await this.billedServices(tx, billId, serviceLineIds);
    const variants = await loadVariants(
      tx,
      lines.flatMap((line) => (line.receiptLineId === null ? [] : [line.variantId])),
    );

    const issues: LineIssue[] = [];
    const sources: LineSource[] = [];
    const vatSettings = new Set<boolean>();
    const terms: number[] = [];
    const keptVariantIds = new Set<string>();
    const keptRateIds = new Set<string>();
    const found = new Map<string, ReceiptLineInfo>();
    const useOrderLine = (orderLineId: string | null) => {
      const orderLine = orderLineId === null ? undefined : orderLines.get(orderLineId);
      if (orderLine === undefined) return;
      vatSettings.add(orderLine.pricesIncludeVat);
      terms.push(orderLine.paymentTermsDays);
      keptRateIds.add(orderLine.taxRateId);
    };

    lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      if (line.receiptLineId !== null) {
        const receipt = receiptLines.get(line.receiptLineId);
        const base = baseQuantityOf(line, variants.get(line.variantId));
        if (
          receipt?.supplierId !== supplierId ||
          receipt.status !== 'posted' ||
          receipt.billId !== null ||
          receipt.variantId !== line.variantId ||
          isZeroQuantity(receipt.baseQuantity)
        ) {
          at('receiptLineId', 'bill_receipt_line_invalid');
        } else if (base === null || compareQuantity(base, receipt.baseQuantity) !== 0) {
          at('quantity', 'bill_receipt_line_quantity');
        } else if (receipt.billed) {
          at('receiptLineId', 'bill_receipt_line_billed');
        } else if (receipt.value !== null) {
          found.set(line.receiptLineId, {
            orderValue: receipt.value,
            warehouseId: receipt.warehouseId,
          });
        }
        sources.push({
          receiptLineId: line.receiptLineId,
          orderLineId: receipt?.orderLineId ?? null,
        });
        keptVariantIds.add(line.variantId);
        useOrderLine(receipt?.orderLineId ?? null);
        return;
      }
      if (line.orderLineId !== null) {
        const orderLine = orderLines.get(line.orderLineId);
        // Goods on an order are billed through their goods receipt: only the receipt says they came
        if (
          orderLine?.supplierId !== supplierId ||
          !['approved', 'received', 'closed'].includes(orderLine.status) ||
          orderLine.productType !== 'service' ||
          orderLine.variantId !== line.variantId ||
          orderLine.unitId !== line.unitId ||
          compareQuantity(orderLine.quantity, line.quantity) !== 0
        ) {
          at('orderLineId', 'bill_order_line_invalid');
        } else if (billedServices.has(line.orderLineId)) {
          at('orderLineId', 'bill_order_line_billed');
        }
        sources.push({ receiptLineId: null, orderLineId: line.orderLineId });
        keptVariantIds.add(line.variantId);
        useOrderLine(line.orderLineId);
        return;
      }
      sources.push({ receiptLineId: null, orderLineId: null });
    });
    if (issues.length > 0) throw linesError(issues);
    // One bill reads its prices one way: two orders that disagree cannot share a bill
    if (vatSettings.size > 1) {
      throw new AppError(
        409,
        'bill_vat_mixed',
        'These orders price differently (with and without VAT). Bill them on separate bills.',
      );
    }
    const [pricesIncludeVat] = [...vatSettings];
    return {
      lines: sources,
      pricesIncludeVat: pricesIncludeVat ?? null,
      // The shortest: the bill is due when the first of its orders says
      paymentTermsDays: terms.length === 0 ? null : Math.min(...terms),
      keptVariantIds,
      keptRateIds,
      receiptLines: found,
    };
  }

  // The goods receipt lines a bill names, with their receipt. At posting the lines are locked FOR
  // NO KEY UPDATE in id order, then read: `billed` is read after the lock.
  private async receiptLines(tx: Transaction, ids: readonly string[], lock: 'share' | 'update') {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map<string, never>();
    const query = tx
      .select({
        id: goodsReceiptLines.id,
        variantId: goodsReceiptLines.variantId,
        baseQuantity: goodsReceiptLines.baseQuantity,
        orderLineId: goodsReceiptLines.orderLineId,
        billed: goodsReceiptLines.billed,
        value: goodsReceiptLines.value,
        supplierId: goodsReceipts.supplierId,
        status: goodsReceipts.status,
        billId: goodsReceipts.billId,
        warehouseId: goodsReceipts.warehouseId,
      })
      .from(goodsReceiptLines)
      .innerJoin(
        goodsReceipts,
        and(
          eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
          eq(goodsReceipts.id, goodsReceiptLines.receiptId),
        ),
      )
      .where(and(eq(goodsReceiptLines.tenantId, tenantId), inArray(goodsReceiptLines.id, [...ids])))
      .orderBy(asc(goodsReceiptLines.id));
    const rows =
      lock === 'update' ? await query.for('no key update', { of: goodsReceiptLines }) : await query;
    return new Map(rows.map((row) => [row.id, row]));
  }

  // The order lines a bill bills, directly (services) or through a receipt line, with their order.
  // Locked as checkSources() says, the service lines' only: a receipt line's order has a posted
  // receipt, so it is never reopened or cancelled.
  private async orderLines(
    tx: Transaction,
    ids: readonly string[],
    serviceLineIds: ReadonlySet<string>,
    lock: 'share' | 'update',
  ) {
    const tenantId = getTenantId();
    if (ids.length === 0) return new Map<string, never>();
    if (serviceLineIds.size > 0) {
      if (lock === 'share') {
        const owners = await tx
          .selectDistinct({ orderId: purchaseOrderLines.orderId })
          .from(purchaseOrderLines)
          .where(
            and(
              eq(purchaseOrderLines.tenantId, tenantId),
              inArray(purchaseOrderLines.id, [...serviceLineIds]),
            ),
          );
        await tx
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(
            and(
              eq(purchaseOrders.tenantId, tenantId),
              inArray(
                purchaseOrders.id,
                owners.map((owner) => owner.orderId),
              ),
            ),
          )
          .orderBy(asc(purchaseOrders.id))
          .for('share');
      } else {
        // The same lock, in the same order, as the database's own check at posting (0040)
        await tx
          .select({ id: purchaseOrderLines.id })
          .from(purchaseOrderLines)
          .where(
            and(
              eq(purchaseOrderLines.tenantId, tenantId),
              inArray(purchaseOrderLines.id, [...serviceLineIds]),
            ),
          )
          .orderBy(asc(purchaseOrderLines.id))
          .for('no key update');
      }
    }
    const rows = await tx
      .select({
        id: purchaseOrderLines.id,
        variantId: purchaseOrderLines.variantId,
        unitId: purchaseOrderLines.unitId,
        quantity: purchaseOrderLines.quantity,
        taxRateId: purchaseOrderLines.taxRateId,
        productType: products.type,
        supplierId: purchaseOrders.supplierId,
        status: purchaseOrders.status,
        pricesIncludeVat: purchaseOrders.pricesIncludeVat,
        paymentTermsDays: purchaseOrders.paymentTermsDays,
      })
      .from(purchaseOrderLines)
      .innerJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, purchaseOrderLines.tenantId),
          eq(purchaseOrders.id, purchaseOrderLines.orderId),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.tenantId, purchaseOrderLines.tenantId),
          eq(products.id, purchaseOrderLines.productId),
        ),
      )
      .where(
        and(eq(purchaseOrderLines.tenantId, tenantId), inArray(purchaseOrderLines.id, [...ids])),
      );
    return new Map(rows.map((row) => [row.id, row]));
  }

  // The service lines among `ids` another posted bill billed already
  private async billedServices(
    tx: Transaction,
    billId: string | null,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ orderLineId: billLines.orderLineId })
      .from(billLines)
      .innerJoin(bills, and(eq(bills.tenantId, billLines.tenantId), eq(bills.id, billLines.billId)))
      .where(
        and(
          eq(billLines.tenantId, getTenantId()),
          inArray(billLines.orderLineId, [...ids]),
          isNull(billLines.receiptLineId),
          eq(bills.status, 'posted'),
          billId === null ? undefined : ne(bills.id, billId),
        ),
      );
    return new Set(rows.flatMap((row) => (row.orderLineId === null ? [] : [row.orderLineId])));
  }

  // The lines that are neither a receipt line nor an order's service line (decision 4), and every
  // line's account. A goods line of its own is received by the bill when it is posted, so it is
  // checked like a goods receipt line now (resolveReceiptLines(): goods, the unit, the lot of a
  // batch product, one serial number per unit) and needs the warehouse; it takes no account. A
  // service line (of its own or from an order) goes to its account, or to Settings' "Purchased
  // services" when it names none (decision 16), and takes no lot. A receipt line has neither.
  private async checkOwnLines(
    tx: Transaction,
    input: BillInput,
    lines: readonly ResolvedSalesLine[],
    sources: readonly LineSource[],
    before: BillRow | null,
  ): Promise<{ accounts: (string | null)[]; stock: OwnStock[]; warehouseId: string | null }> {
    const issues: LineIssue[] = [];
    const goods: number[] = [];
    const services = (await readPurchaseAccounts(tx)).services;
    const accounts = lines.map((line, index): string | null => {
      const source = sources[index];
      const typed = input.lines[index];
      if (source === undefined || typed === undefined || source.receiptLineId !== null) return null;
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      if (line.variant.type === 'goods') {
        // The contract sends an order's goods line to bill_order_line_invalid in checkSources()
        if (source.orderLineId !== null) return null;
        if (typed.accountId !== null) at('accountId', 'bill_account_not_allowed');
        goods.push(index);
        return null;
      }
      const stockFields = [
        ['lotNumber', typed.lotNumber !== null],
        ['expiresOn', typed.expiresOn !== null],
        ['manufacturedOn', typed.manufacturedOn !== null],
        ['serialNumbers', typed.serialNumbers.length > 0],
      ] as const;
      for (const [field, filled] of stockFields) {
        if (filled) at(field, 'bill_stock_not_allowed');
      }
      const accountId = typed.accountId ?? services;
      if (accountId === null) at('accountId', 'bill_account_required');
      return accountId;
    });
    if (issues.length > 0) throw linesError(issues);
    const stock = lines.map((): OwnStock => NO_STOCK);
    if (goods.length === 0) return { accounts, stock, warehouseId: null };
    if (input.warehouseId === null) throw warehouseRequired();
    await assertWarehouse(tx, input.warehouseId, before?.warehouseId ?? null);
    let checked: Awaited<ReturnType<typeof resolveReceiptLines>>;
    try {
      checked = await resolveReceiptLines(
        tx,
        goods.flatMap((index) => {
          const line = input.lines[index];
          return line === undefined ? [] : [ownGoodsInput(line)];
        }),
      );
    } catch (error) {
      onBillLines(error, goods);
    }
    // As the goods receipt will keep them: no lot on a product without batches, no serial numbers
    // on one without them
    goods.forEach((index, position) => {
      const accepted = checked[position]?.accepted;
      if (accepted === undefined) return;
      stock[index] = {
        lotNumber: accepted.lotNumber,
        expiresOn: accepted.expiresOn,
        manufacturedOn: accepted.manufacturedOn,
        serialNumbers: accepted.serialNumbers,
      };
    });
    return { accounts, stock, warehouseId: input.warehouseId };
  }

  // The expenses priced like a sales line of one unit (expenseLineAmounts), each with an active VAT
  // rate of this workspace (or one the draft already used)
  private async resolveExpenses(
    tx: Transaction,
    expenses: BillInput['expenses'],
    pricesIncludeVat: boolean,
    keptRateIds: ReadonlySet<string>,
  ): Promise<CheckedBill['expenses']> {
    if (expenses.length === 0) return [];
    const rows = await tx
      .select({
        id: taxRates.id,
        name: taxRates.name,
        kind: taxRates.kind,
        rate: taxRates.rate,
        archivedAt: taxRates.archivedAt,
      })
      .from(taxRates)
      .where(
        and(
          eq(taxRates.tenantId, getTenantId()),
          inArray(taxRates.id, [...new Set(expenses.map((expense) => expense.taxRateId))]),
        ),
      );
    const rates = new Map(rows.map((row) => [row.id, row]));
    const issues: LineIssue[] = [];
    const resolved = expenses.flatMap((expense, index) => {
      const rate = rates.get(expense.taxRateId);
      if (rate === undefined || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
        issues.push({ path: `expenses.${String(index)}.taxRateId`, code: 'tax_rate_invalid' });
        return [];
      }
      const snapshot = { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate };
      return [
        {
          input: expense,
          rate: snapshot,
          amounts: expenseLineAmounts(
            { amount: expense.amount, rate: rate.rate },
            pricesIncludeVat,
          ),
        },
      ];
    });
    if (issues.length > 0) throw linesError(issues);
    return resolved;
  }

  // The lines and expenses as checked: the server's own order line for a receipt line, the
  // resolved account of a service line
  private async writeLines(tx: Transaction, billId: string, fields: CheckedBill): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(billLines)
      .where(and(eq(billLines.tenantId, tenantId), eq(billLines.billId, billId)));
    await tx
      .delete(billExpenses)
      .where(and(eq(billExpenses.tenantId, tenantId), eq(billExpenses.billId, billId)));
    if (fields.lines.length > 0) {
      await tx.insert(billLines).values(
        fields.lines.map((line, index) => {
          const stock = fields.stock[index] ?? NO_STOCK;
          return {
            ...salesLineValues(line, index),
            billId,
            receiptLineId: fields.sources[index]?.receiptLineId ?? null,
            orderLineId: fields.sources[index]?.orderLineId ?? null,
            accountId: fields.accounts[index] ?? null,
            lotNumber: stock.lotNumber,
            expiresOn: stock.expiresOn,
            manufacturedOn: stock.manufacturedOn,
            serialNumbers: stock.serialNumbers,
          };
        }),
      );
    }
    if (fields.expenses.length > 0) {
      await tx.insert(billExpenses).values(
        fields.expenses.map((expense, index) => ({
          tenantId,
          billId,
          lineNo: index + 1,
          accountId: expense.input.accountId,
          description: expense.input.description,
          amount: expense.input.amount,
          taxRateId: expense.rate.id,
          taxRateName: expense.rate.name,
          taxRateKind: expense.rate.kind,
          taxRate: expense.rate.rate,
          net: expense.amounts.net,
          vat: expense.amounts.vat,
          total: expense.amounts.total,
        })),
      );
    }
  }

  private async goodsProducts(
    tx: Transaction,
    productIds: readonly string[],
  ): Promise<Set<string>> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.tenantId, getTenantId()),
          inArray(products.id, ids),
          eq(products.type, 'goods'),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  private async branchOf(tx: Transaction, warehouseId: string): Promise<string> {
    const branchId = (await this.branchesOf(tx, [warehouseId])).get(warehouseId);
    if (branchId === undefined) throw new Error(`Warehouse ${warehouseId} has no branch`);
    return branchId;
  }

  private async branchesOf(
    tx: Transaction,
    warehouseIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(warehouseIds)];
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: warehouses.id, branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), inArray(warehouses.id, ids)));
    return new Map(rows.map((row) => [row.id, row.branchId]));
  }

  // FOR UPDATE: every change to a bill takes turns with the others and with an approval (the
  // engine locks it the same way)
  private async lock(tx: Transaction, id: string, version: number): Promise<BillRow> {
    const [row] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, id)))
      .for('update');
    if (!row) throw notFound('Bill');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<BillRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'draft') throw notDraft();
    return row;
  }

  private linesOf(tx: Transaction, billId: string) {
    return tx
      .select()
      .from(billLines)
      .where(and(eq(billLines.tenantId, getTenantId()), eq(billLines.billId, billId)))
      .orderBy(asc(billLines.lineNo));
  }

  private expensesOf(tx: Transaction, billId: string) {
    return tx
      .select()
      .from(billExpenses)
      .where(and(eq(billExpenses.tenantId, getTenantId()), eq(billExpenses.billId, billId)))
      .orderBy(asc(billExpenses.lineNo));
  }

  private paymentFilter(
    payment: BillPaymentFilter | undefined,
    today: string | null,
  ): SQL | undefined {
    if (payment === 'paid') {
      return sql`${bills.status} = 'posted' AND ${bills.amountPaid} >= ${bills.total}`;
    }
    if (payment === 'open') return isOpen;
    if (payment === 'overdue') return sql`${isOpen} AND ${bills.dueDate} < ${today}::date`;
    return undefined;
  }

  // The workspace's today: a bill is overdue the day after its due date there, not in UTC
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
    order: SQL[] = [desc(bills.date), desc(bills.id)],
  ) {
    return tx
      .select({
        bill: bills,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(bills)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, bills.tenantId), eq(parties.id, bills.supplierId)),
      )
      .where(and(eq(bills.tenantId, getTenantId()), where))
      .orderBy(...order)
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Bill> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(bills.id, id), 1);
    if (!found) throw notFound('Bill');
    const { bill: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    const expenses = await this.expensesOf(tx, id);
    const receiptLineIds = lines.flatMap(({ row: line }) =>
      line.receiptLineId === null ? [] : [line.receiptLineId],
    );
    const orderLineIds = lines.flatMap(({ row: line }) =>
      line.orderLineId === null ? [] : [line.orderLineId],
    );
    const [receiptLines, orders, payments] = await Promise.all([
      receiptLineIds.length === 0
        ? []
        : tx
            .select({
              id: goodsReceiptLines.id,
              batchId: goodsReceiptLines.batchId,
              serialNumbers: goodsReceiptLines.serialNumbers,
              orderLineId: goodsReceiptLines.orderLineId,
              value: goodsReceiptLines.value,
              receiptId: goodsReceipts.id,
              number: goodsReceipts.number,
              date: goodsReceipts.date,
            })
            .from(goodsReceiptLines)
            .innerJoin(
              goodsReceipts,
              and(
                eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
                eq(goodsReceipts.id, goodsReceiptLines.receiptId),
              ),
            )
            .where(
              and(
                eq(goodsReceiptLines.tenantId, tenantId),
                inArray(goodsReceiptLines.id, receiptLineIds),
              ),
            ),
      orderLineIds.length === 0
        ? []
        : tx
            .select({
              lineId: purchaseOrderLines.id,
              id: purchaseOrders.id,
              number: purchaseOrders.number,
            })
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
                eq(purchaseOrderLines.tenantId, tenantId),
                inArray(purchaseOrderLines.id, orderLineIds),
              ),
            )
            .orderBy(asc(purchaseOrders.number)),
      // Money posted payments applied to it. A draft payment's plan is not money paid (decision
      // 23), and a cancelled one keeps its plan as history: both are left out.
      tx
        .select({
          paymentId: supplierPayments.id,
          paymentNumber: supplierPayments.number,
          date: supplierPayments.date,
          amount: supplierPaymentAllocations.amount,
        })
        .from(supplierPaymentAllocations)
        .innerJoin(
          supplierPayments,
          and(
            eq(supplierPayments.tenantId, supplierPaymentAllocations.tenantId),
            eq(supplierPayments.id, supplierPaymentAllocations.paymentId),
          ),
        )
        .where(
          and(
            eq(supplierPaymentAllocations.tenantId, tenantId),
            eq(supplierPaymentAllocations.billId, id),
            eq(supplierPayments.status, 'posted'),
          ),
        )
        .orderBy(asc(supplierPayments.date), asc(supplierPayments.number)),
    ]);
    const receiptLine = new Map(receiptLines.map((line) => [line.id, line]));
    const batches = await batchesOf(
      tx,
      receiptLines.map((line) => line.batchId),
    );
    const orderOf = new Map(orders.map((order) => [order.lineId, order]));
    const orderRefs = [
      ...new Map(
        orders.map((order) => [order.id, { id: order.id, number: order.number }]),
      ).values(),
    ];
    const receiptRefs = [
      ...new Map(
        receiptLines.map((line) => [
          line.receiptId,
          { id: line.receiptId, number: line.number, date: line.date },
        ]),
      ).values(),
    ].toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

    const billLinesOut = lines.map(({ row: line, variant }) => {
      const receipt = line.receiptLineId === null ? undefined : receiptLine.get(line.receiptLineId);
      const batch =
        receipt?.batchId === null || receipt === undefined
          ? undefined
          : batches.get(receipt.batchId);
      // The order's price is what a receipt from an order booked; a receipt a bill made has none
      const orderValue =
        receipt !== undefined && receipt.orderLineId !== null ? receipt.value : null;
      return {
        ...toSalesLine(line, variant),
        receiptLineId: line.receiptLineId,
        receiptNumber: receipt?.number ?? null,
        orderLineId: line.orderLineId,
        orderNumber:
          line.orderLineId === null ? null : (orderOf.get(line.orderLineId)?.number ?? null),
        accountId: line.accountId,
        orderValue,
        // What the goods came with: the receipt line's batch once received, else the lot typed on
        // a goods line of its own
        batchId: receipt?.batchId ?? null,
        lotNumber: batch?.lotNumber ?? line.lotNumber,
        expiresOn: batch?.expiresOn ?? line.expiresOn,
        manufacturedOn: batch?.manufacturedOn ?? line.manufacturedOn,
        serialNumbers: receipt?.serialNumbers ?? line.serialNumbers,
      };
    });
    const priceDifference = sumMoney(
      billLinesOut.map((line) => priceDifferenceOf({ net: line.net, orderValue: line.orderValue })),
    );
    const due = billAmountDueOf(row);
    const [advances, entry, approval] = await Promise.all([
      row.status === 'posted' && compareMoney(due, '0') > 0
        ? this.advancesFor(
            tx,
            row.supplierId,
            orderRefs.map((order) => order.id),
          )
        : [],
      row.status === 'posted' ? this.books.entryOf(tx, id, 'purchase_bill') : null,
      this.approvals.history(tx, 'bill', id),
    ]);
    return {
      ...toSummary(row, found.supplier, found.lineCount),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      warehouseId: row.warehouseId,
      note: row.note,
      lines: billLinesOut,
      expenses: expenses.map((expense) => ({
        id: expense.id,
        accountId: expense.accountId,
        description: expense.description,
        amount: expense.amount,
        taxRate: {
          id: expense.taxRateId,
          name: expense.taxRateName,
          kind: expense.taxRateKind,
          rate: expense.taxRate,
        },
        net: expense.net,
        vat: expense.vat,
        total: expense.total,
      })),
      priceDifference,
      receipts: receiptRefs.map((receipt) => ({ id: receipt.id, number: receipt.number })),
      orders: orderRefs,
      // Posted, so each has a number
      payments: payments.flatMap((payment) =>
        payment.paymentNumber === null
          ? []
          : [{ ...payment, paymentNumber: payment.paymentNumber }],
      ),
      advances,
      entry,
      approval,
    };
  }

  // The supplier's posted payments with money not applied yet (supplier_payments_unapplied_idx):
  // those paid against one of this bill's orders first (decision 12), then the oldest
  private async advancesFor(tx: Transaction, supplierId: string, orderIds: readonly string[]) {
    const rows = await tx
      .select({
        paymentId: supplierPayments.id,
        paymentNumber: supplierPayments.number,
        date: supplierPayments.date,
        amount: supplierPayments.amount,
        applied: supplierPayments.applied,
        orderId: purchaseOrders.id,
        orderNumber: purchaseOrders.number,
      })
      .from(supplierPayments)
      .leftJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, supplierPayments.tenantId),
          eq(purchaseOrders.id, supplierPayments.orderId),
        ),
      )
      .where(
        and(
          eq(supplierPayments.tenantId, getTenantId()),
          eq(supplierPayments.supplierId, supplierId),
          eq(supplierPayments.status, 'posted'),
          sql`${supplierPayments.applied} < ${supplierPayments.amount}`,
        ),
      )
      .orderBy(asc(supplierPayments.date), asc(supplierPayments.id));
    const linked = new Set(orderIds);
    return rows
      .flatMap((row) =>
        row.paymentNumber === null
          ? []
          : [
              {
                paymentId: row.paymentId,
                paymentNumber: row.paymentNumber,
                date: row.date,
                order: row.orderId === null ? null : { id: row.orderId, number: row.orderNumber },
                unapplied: subtractMoney(row.amount, row.applied),
              },
            ],
      )
      .toSorted(
        (a, b) =>
          Number(b.order !== null && linked.has(b.order.id)) -
          Number(a.order !== null && linked.has(a.order.id)),
      );
  }

  private async supplierOf(tx: Transaction, supplierId: string): Promise<PartyRef> {
    const supplier = (await customerRefs(tx, [supplierId])).get(supplierId);
    if (!supplier) throw new Error(`Supplier ${supplierId} is missing`);
    return supplier;
  }

  // What the audit log shows: the header and the size, not every line
  private snapshot(row: BillRow, supplier: PartyRef, fields: CheckedBill) {
    return this.snapshotOf(row, supplier, fields.lines.length, fields.expenses.length);
  }

  private snapshotOf(row: BillRow, supplier: PartyRef, lines: number, expenses: number) {
    return {
      number: row.number,
      date: row.date,
      dueDate: row.dueDate,
      supplier: supplier.code,
      supplierBillNumber: row.supplierBillNumber,
      mushakNumber: row.mushakNumber,
      total: row.total,
      lines,
      expenses,
    };
  }
}

// A goods line of its own as resolveReceiptLines() takes it: everything accepted, nothing rejected
function ownGoodsInput(line: BillLineInput) {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    serialNumbers: [...line.serialNumbers],
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn,
    manufacturedOn: line.manufacturedOn,
    orderLineId: null,
    rejectedQuantity: '0',
    rejectionReason: null,
  };
}

// The accounts a service line or an expense posts to (decision 6): an active expense or asset
// ledger (a repair is an expense, a new sewing machine an asset) that is not one only the system
// posts to: no purpose (the payable, VAT, inventory, cost of goods sold), no stock account (goods
// received not billed, goods in transit) and no money account (a payment pays a bill, a bill does
// not). FOR SHARE: nobody archives one before we commit; the posting checks them again.
async function checkCostAccounts(
  tx: Transaction,
  wanted: readonly { path: string; accountId: string }[],
): Promise<void> {
  if (wanted.length === 0) return;
  const tenantId = getTenantId();
  const chart = await tx
    .select({
      id: ledgerAccounts.id,
      parentId: ledgerAccounts.parentId,
      type: ledgerAccounts.type,
      purpose: ledgerAccounts.purpose,
      isGroup: ledgerAccounts.isGroup,
      holdsMoney: ledgerAccounts.holdsMoney,
      archivedAt: ledgerAccounts.archivedAt,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tenantId));
  const money = moneyAccountIds(
    chart.map((account) => ({ ...account, archivedAt: account.archivedAt?.toISOString() ?? null })),
  );
  const stock = await stockAccountIds(tx);
  const usable = new Set(
    chart
      .filter(
        (account) =>
          (account.type === 'expense' || account.type === 'asset') &&
          !account.isGroup &&
          account.archivedAt === null &&
          account.purpose === null &&
          !money.has(account.id) &&
          !stock.has(account.id),
      )
      .map((account) => account.id),
  );
  const issues: LineIssue[] = wanted.flatMap((item) =>
    usable.has(item.accountId) ? [] : [{ path: item.path, code: 'bill_account_invalid' }],
  );
  if (issues.length > 0) throw linesError(issues);
  await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.tenantId, tenantId),
        inArray(ledgerAccounts.id, [...new Set(wanted.map((item) => item.accountId))]),
      ),
    )
    .for('share');
}
