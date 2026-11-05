import { Inject, Injectable } from '@nestjs/common';
import {
  billAmountDueOf,
  compareMoney,
  compareQuantity,
  type DebitNote,
  type DebitNoteAllocationsInput,
  type DebitNoteInput,
  type DebitNoteStatus,
  type DebitNoteSummary,
  defaultLineDescription,
  documentTotals,
  type ErrorCode,
  expenseLineAmounts,
  fitsDecimals,
  isQuantity,
  isZeroMoney,
  type LineAmounts,
  lineAmounts,
  overAllocated,
  type PartyRef,
  prorateMoney,
  type SalesLineInput,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  type UpdateDebitNoteInput,
} from '@omnivo/contracts';
import {
  billExpenses,
  billLines,
  bills,
  debitNoteAllocations,
  debitNoteExpenses,
  debitNoteLines,
  debitNotes,
  goodsReceiptLines,
  goodsReceipts,
  parties,
  purchaseReturnLines,
  purchaseReturns,
  taxRates,
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
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { allocationChanges } from '../sales/allocations.js';
import {
  assertBranch,
  customerRefs,
  type ResolvedSalesLine,
  salesLineValues,
  type TaxRateSnapshot,
  toSalesLine,
  withVariants,
} from '../sales/sales-lines.js';
import { type DebitNotePosting, PurchaseBooksService } from './purchase-books.service.js';
import { assertSupplier } from './purchase-lines.js';
import { type BillAllocationErrors, checkBillAllocations } from './supplier-payments.service.js';

type DebitNoteRow = typeof debitNotes.$inferSelect;
type DebitLineRow = typeof debitNoteLines.$inferSelect;
type DebitExpenseRow = typeof debitNoteExpenses.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM debit_note_lines l
   WHERE l.tenant_id = debit_notes.tenant_id AND l.debit_note_id = debit_notes.id
)`;

const ALLOCATION_ERRORS = {
  bill: 'debit_note_allocation_invalid',
  over: 'debit_note_over_bill',
} as const satisfies BillAllocationErrors;

// The bill a debit note debits, as far as the debit note needs it
interface BillInfo {
  id: string;
  number: string;
  date: string;
  supplierId: string;
  branchId: string;
  pricesIncludeVat: boolean;
  total: string;
  amountPaid: string;
  amountDebited: string;
}

// What a line names, as the form sends it and as the database keeps it
interface LineRefs {
  billLineId: string | null;
  returnLineId: string | null;
  // Only on a debit note without a bill: a stored line keeps its rate's id
  taxRateId: string | null;
  unitId: string;
  quantity: string;
  description: string | null;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
}

interface ExpenseRefs {
  billExpenseId: string;
  amount: string;
}

// A return line a debit note line takes the money off for, with what the posting needs: what the
// return put on goods received not billed and where (the branch of the receipt's warehouse, or of
// the return's own for a line on its own)
interface ReturnLineInfo {
  id: string;
  returnId: string;
  number: string | null;
  supplierId: string;
  status: string;
  variantId: string;
  receiptLineId: string | null;
  billLineId: string | null;
  baseQuantity: string;
  debitedQuantity: string;
  value: string | null;
  warehouseId: string;
}

interface ResolvedExpense {
  billExpenseId: string;
  amount: string;
  rate: TaxRateSnapshot;
  amounts: LineAmounts;
}

// Everything a save writes, worked out by check()
interface CheckedDebitNote {
  bill: BillInfo | null;
  supplier: PartyRef;
  header: Omit<typeof debitNotes.$inferInsert, 'tenantId' | 'createdBy' | 'updatedBy'>;
  lines: ResolvedSalesLine[];
  expenses: ResolvedExpense[];
}

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'Only a draft debit note can be changed. A posted one is final: write another one.',
  );
}

function billInvalid(): AppError {
  return new AppError(409, 'debit_note_bill_invalid', 'Pick a posted bill of this supplier.', {
    fieldErrors: { billId: ['debit_note_bill_invalid'] },
  });
}

function overAllocatedError(): AppError {
  return new AppError(
    409,
    'debit_note_over_allocated',
    'More is applied than the debit note has. Lower the amounts on the bills.',
    { fieldErrors: { allocations: ['debit_note_over_allocated'] } },
  );
}

function expensePath(index: number, field: string): string {
  return `expenses.${String(index)}.${field}`;
}

// The database's last word, if two writers got past the checks: the bill locks make these
// unreachable in practice, but each still answers with the code the form knows. A line or an
// expense debited past what it charged (bill_lines_debited_check, bill_expenses_debited_check, and
// bills_debited_check for the whole bill), a return line past what went back, a bill settled past
// its total by payments and debit notes together, or a debit note applied and paid back past its
// total.
function moneyRace(error: unknown): unknown {
  if (
    isCheckViolation(error, 'bill_lines_debited_check') ||
    isCheckViolation(error, 'bill_expenses_debited_check') ||
    isCheckViolation(error, 'bills_debited_check')
  ) {
    return new AppError(
      409,
      'debit_note_over_line',
      'Another debit note took some of these lines off first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'purchase_return_lines_debited_check')) {
    return new AppError(
      409,
      'debit_note_over_return',
      'Another debit note took the money off for these goods first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'bills_paid_check')) {
    return new AppError(
      409,
      'debit_note_over_bill',
      'A payment or another debit note settled one of these bills first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'debit_notes_money_check')) return overAllocatedError();
  return error;
}

function toSummary(
  row: DebitNoteRow,
  supplier: PartyRef,
  bill: { id: string; number: string; date: string; supplierBillNumber: string } | null,
  lines: number,
): DebitNoteSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    supplier,
    bill,
    branchId: row.branchId,
    reason: row.reason,
    status: row.status,
    supplierCreditNumber: row.supplierCreditNumber,
    supplierCreditDate: row.supplierCreditDate,
    net: row.net,
    vat: row.vat,
    total: row.total,
    applied: row.applied,
    refunded: row.refunded,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A stored line as the check reads it again when the draft is posted. A line of a bill names no
// rate (the bill line's is copied): only a line without a bill keeps its own.
function storedRefs(line: DebitLineRow): LineRefs {
  return {
    billLineId: line.billLineId,
    returnLineId: line.returnLineId,
    taxRateId: line.billLineId === null ? line.taxRateId : null,
    unitId: line.unitId,
    quantity: line.quantity,
    description: line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: line.discount,
  };
}

function storedExpense(expense: DebitExpenseRow): ExpenseRefs {
  return { billExpenseId: expense.billExpenseId, amount: expense.amount };
}

// The quantity of a line in its item's base unit, in any unit of the item (and that unit's factor),
// or the problem with it
function baseOf(
  line: { unitId: string; quantity: string },
  variant: VariantInfo,
): { base: string; factor: string } | { field: string; code: ErrorCode } {
  const unit =
    line.unitId === variant.baseUnitId
      ? { factor: '1', decimals: variant.baseDecimals }
      : variant.units.find((pack) => pack.unitId === line.unitId);
  if (unit === undefined) return { field: 'unitId', code: 'stock_unit_invalid' };
  if (!fitsDecimals(line.quantity, unit.decimals)) {
    return { field: 'quantity', code: 'stock_quantity_decimals' };
  }
  const base = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
  return isQuantity(base)
    ? { base, factor: unit.factor }
    : { field: 'quantity', code: 'quantity_format' };
}

// What `quantity` of a return line takes off goods received not billed: its share of what the
// return put there (decision 22), counted over everything debited from the line so far, so a line
// debited in two goes gives back exactly its value
function returnShare(line: ReturnLineInfo, quantity: string): string {
  if (line.value === null) throw new Error(`Posted return line ${line.id} has no value`);
  const after = sumQuantity([line.debitedQuantity, quantity]);
  return subtractMoney(
    prorateMoney(line.value, after, line.baseQuantity),
    prorateMoney(line.value, line.debitedQuantity, line.baseQuantity),
  );
}

// Debit notes (step 17d): money taken off what the company owes a supplier, for one posted bill or
// for goods from before Omnivo (decision 9). A draft is changed freely; "Post" numbers it, books it,
// counts it on the bill and the return lines it names, and applies its money to its own bill.
// Afterwards only its money moves (allocate, and supplier refunds).
@Injectable()
export class DebitNotesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: PurchaseBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: DebitNoteStatus | undefined;
    supplierId?: string | undefined;
    billId?: string | undefined;
  }): Promise<{ items: DebitNoteSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(debitNotes.status, query.status),
          query.supplierId === undefined ? undefined : eq(debitNotes.supplierId, query.supplierId),
          query.billId === undefined ? undefined : eq(debitNotes.billId, query.billId),
          after === undefined
            ? undefined
            : sql`(${debitNotes.date}, ${debitNotes.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.debitNote.date, last.debitNote.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.debitNote, row.supplier, billRef(row.bill), row.lineCount),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<DebitNote> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: DebitNoteInput): Promise<DebitNote> {
    try {
      return await this.withTenant(async (tx) => {
        const fields = await this.check(tx, input, null);
        const [row] = await tx
          .insert(debitNotes)
          .values({
            tenantId: getTenantId(),
            ...fields.header,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Debit note insert returned no row');
        await this.writeLines(tx, row, input.lines, fields);
        await audit(tx, {
          action: 'debit_note.created',
          entityType: 'debit_note',
          entityId: row.id,
          changes: created(this.snapshot(row, fields.supplier, fields.bill, this.size(fields))),
        });
        if (input.post) await this.postAndLog(tx, row);
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw moneyRace(error);
    }
  }

  async update(id: string, input: UpdateDebitNoteInput): Promise<DebitNote> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, input.version);
        const linesBefore = await this.linesOf(tx, id);
        const expensesBefore = await this.expensesOf(tx, id);
        const supplierBefore = await this.supplierOf(tx, before.supplierId);
        const billBefore =
          before.billId === null ? null : await this.billOf(tx, before.billId, null);
        const fields = await this.check(tx, input, {
          row: before,
          lines: linesBefore,
          expenses: expensesBefore,
        });
        // The lines and expenses first: a new bill's keys would refuse the old bill's lines
        await this.clearLines(tx, id);
        const [updated] = await tx
          .update(debitNotes)
          .set({
            ...fields.header,
            version: sql`${debitNotes.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(debitNotes.tenantId, getTenantId()), eq(debitNotes.id, id)))
          .returning();
        if (!updated) throw notFound('Debit note');
        await this.writeLines(tx, updated, input.lines, fields);
        await audit(tx, {
          action: 'debit_note.updated',
          entityType: 'debit_note',
          entityId: id,
          changes: diff(
            this.snapshot(
              before,
              supplierBefore,
              billBefore,
              linesBefore.length + expensesBefore.length,
            ),
            this.snapshot(updated, fields.supplier, fields.bill, this.size(fields)),
          ),
        });
        if (input.post) await this.postAndLog(tx, updated);
        return this.read(tx, id);
      });
    } catch (error) {
      throw moneyRace(error);
    }
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const expenses = await this.expensesOf(tx, id);
      const supplier = await this.supplierOf(tx, before.supplierId);
      const bill = before.billId === null ? null : await this.billOf(tx, before.billId, null);
      // The lines and expenses go with it (ON DELETE CASCADE). A draft took nothing off.
      await tx
        .delete(debitNotes)
        .where(and(eq(debitNotes.tenantId, getTenantId()), eq(debitNotes.id, id)));
      const snapshot = this.snapshot(before, supplier, bill, lines.length + expenses.length);
      await audit(tx, {
        action: 'debit_note.deleted',
        entityType: 'debit_note',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  async post(id: string, version: number): Promise<DebitNote> {
    try {
      return await this.withTenant(async (tx) => {
        const draft = await this.lockDraft(tx, id, version);
        await this.postAndLog(tx, draft);
        return this.read(tx, id);
      });
    } catch (error) {
      throw moneyRace(error);
    }
  }

  // The whole list as the person left it, like a supplier payment's: what is left after its own
  // bill moved to another bill of the supplier, or taken off to be paid back. Nothing in the books
  // changes, only what each bill still owes.
  async allocate(id: string, input: DebitNoteAllocationsInput): Promise<DebitNote> {
    try {
      return await this.withTenant(async (tx) => {
        const row = await this.lockPosted(tx, id, input.version);
        // What supplier refunds paid back is gone: only the rest can be applied
        if (overAllocated(subtractMoney(row.total, row.refunded), input.allocations)) {
          throw overAllocatedError();
        }
        const before = await this.allocationsOf(tx, id);
        await this.apply(tx, row, input.allocations);
        await tx
          .update(debitNotes)
          .set({ version: sql`${debitNotes.version} + 1`, updatedBy: currentPrincipal().userId })
          .where(and(eq(debitNotes.tenantId, getTenantId()), eq(debitNotes.id, id)));
        await audit(tx, {
          action: 'debit_note.allocated',
          entityType: 'debit_note',
          entityId: id,
          changes: allocationChanges(
            before.map(asInvoiceNumber),
            (await this.allocationsOf(tx, id)).map(asInvoiceNumber),
          ),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw moneyRace(error);
    }
  }

  // Every rule of a save the contract cannot check, and the header it writes. `before`: the draft
  // being changed (null for a new one); its supplier stays usable after it was archived, and its VAT
  // rates too, like every draft. With a bill: the bill's supplier, branch and "prices include VAT"
  // (decision 19), whatever the form sent.
  private async check(
    tx: Transaction,
    input: DebitNoteInput,
    before: {
      row: DebitNoteRow;
      lines: readonly DebitLineRow[];
      expenses: readonly DebitExpenseRow[];
    } | null,
  ): Promise<CheckedDebitNote> {
    const supplier = await assertSupplier(tx, input.supplierId, before?.row.supplierId ?? null);
    const bill = input.billId === null ? null : await this.billOf(tx, input.billId, null);
    if (bill !== null && bill.supplierId !== supplier.id) throw billInvalid();
    if (bill !== null) this.assertDate(input.date, bill);
    // The contract makes sure a debit note without a bill names a branch
    const branchId = bill?.branchId ?? input.branchId;
    if (branchId === null) throw new Error('A debit note without a bill names no branch');
    if (bill === null) await assertBranch(tx, branchId, 'purchase_branch_invalid');
    const pricesIncludeVat = bill?.pricesIncludeVat ?? input.pricesIncludeVat;
    const keptRateIds = new Set(before?.lines.map((line) => line.taxRateId) ?? []);
    const lines = await this.resolve(tx, supplier.id, bill, pricesIncludeVat, input.lines, {
      keptRateIds,
    });
    const expenses = bill === null ? [] : await this.resolveExpenses(tx, bill, input.expenses);
    return {
      bill,
      supplier,
      header: {
        date: input.date,
        supplierId: supplier.id,
        billId: bill?.id ?? null,
        branchId,
        pricesIncludeVat,
        reason: input.reason,
        supplierCreditNumber: input.supplierCreditNumber,
        supplierCreditDate: input.supplierCreditDate,
        note: input.note,
        ...documentTotals([
          ...lines.map((line) => line.amounts),
          ...expenses.map((expense) => expense.amounts),
        ]),
      },
      lines,
      expenses,
    };
  }

  // A debit note is written for something the bill billed, so it is not dated before it. No
  // 6-month warning (decision 23).
  private assertDate(date: string, bill: BillInfo): void {
    if (date < bill.date) {
      throw new AppError(409, 'debit_note_date', 'A debit note cannot be dated before its bill.', {
        fieldErrors: { date: ['debit_note_date'] },
      });
    }
  }

  // The lines checked against what they name, and worked out like the bill's lines.
  // With a bill: each line debits a line of that bill, with the bill line's item and its VAT
  // snapshot (VAT comes off at the rate it was claimed, even if the rate changed or was archived
  // since) and the bill's price setting, so debiting a line in full takes off exactly what it
  // charged. The caps (decision 20): no line more than its bill line's quantity; the lines on one
  // bill line no more money than it charged less what posted debit notes took off already; a
  // return line (one that THIS bill line billed) no more than went back less what was debited.
  // Without a bill (decision 9): each line names a return line of its own of this supplier, with
  // that line's item, a VAT rate of the workspace, the same return line cap.
  // Drafts hold nothing, so posting checks again under the locks. All problems at once.
  private async resolve(
    tx: Transaction,
    supplierId: string,
    bill: BillInfo | null,
    pricesIncludeVat: boolean,
    lines: readonly LineRefs[],
    { keptRateIds }: { keptRateIds: ReadonlySet<string> },
  ): Promise<ResolvedSalesLine[]> {
    const tenantId = getTenantId();
    const billLineRows =
      bill === null
        ? []
        : await tx
            .select()
            .from(billLines)
            .where(and(eq(billLines.tenantId, tenantId), eq(billLines.billId, bill.id)));
    const billLine = new Map(billLineRows.map((row) => [row.id, row]));
    const returnLine = await this.returnLines(
      tx,
      lines.flatMap((line) => (line.returnLineId === null ? [] : [line.returnLineId])),
      false,
    );
    const variants = await loadVariants(tx, [
      ...billLineRows.map((row) => row.variantId),
      ...[...returnLine.values()].map((row) => row.variantId),
    ]);
    const rateIds = [
      ...new Set(lines.flatMap((line) => (line.taxRateId === null ? [] : [line.taxRateId]))),
    ];
    const rateRows =
      rateIds.length === 0
        ? []
        : await tx
            .select({
              id: taxRates.id,
              name: taxRates.name,
              kind: taxRates.kind,
              rate: taxRates.rate,
              archivedAt: taxRates.archivedAt,
            })
            .from(taxRates)
            .where(and(eq(taxRates.tenantId, tenantId), inArray(taxRates.id, rateIds)));
    const rates = new Map(rateRows.map((row) => [row.id, row]));

    const issues: LineIssue[] = [];
    const resolved: ResolvedSalesLine[] = [];
    lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      const billed = line.billLineId === null ? undefined : billLine.get(line.billLineId);
      const back = line.returnLineId === null ? undefined : returnLine.get(line.returnLineId);
      let variant: VariantInfo | undefined;
      let rate: TaxRateSnapshot | undefined;
      if (bill !== null) {
        variant = billed === undefined ? undefined : variants.get(billed.variantId);
        if (billed === undefined || variant === undefined) {
          at('billLineId', 'debit_note_line_invalid');
          return;
        }
        rate = {
          id: billed.taxRateId,
          name: billed.taxRateName,
          kind: billed.taxRateKind,
          rate: billed.taxRate,
        };
      } else {
        // Without a bill: a return line on its own, of a posted return of this supplier
        variant = back === undefined ? undefined : variants.get(back.variantId);
        if (
          back?.supplierId !== supplierId ||
          back.status !== 'posted' ||
          back.receiptLineId !== null ||
          variant === undefined
        ) {
          at('returnLineId', 'debit_note_return_invalid');
          return;
        }
        const found = line.taxRateId === null ? undefined : rates.get(line.taxRateId);
        if (found === undefined || (found.archivedAt !== null && !keptRateIds.has(found.id))) {
          at('taxRateId', 'tax_rate_invalid');
          return;
        }
        rate = { id: found.id, name: found.name, kind: found.kind, rate: found.rate };
      }
      // Any unit of the item: 3 strips off a line of 2 boxes
      const quantity = baseOf(line, variant);
      if ('code' in quantity) {
        at(quantity.field, quantity.code);
        return;
      }
      if (billed !== undefined && compareQuantity(quantity.base, billed.baseQuantity) > 0) {
        at('quantity', 'debit_note_over_quantity');
      }
      if (line.returnLineId !== null && bill !== null) {
        // The return line this bill line billed (its bill_line_id), on a posted return
        if (back?.billLineId !== billed?.id || back?.status !== 'posted') {
          at('returnLineId', 'debit_note_return_invalid');
        }
      }
      if (
        back !== undefined &&
        compareQuantity(quantity.base, subtractQuantity(back.baseQuantity, back.debitedQuantity)) >
          0
      ) {
        at('quantity', 'debit_note_over_return');
      }
      resolved.push({
        variant,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: quantity.factor,
        baseQuantity: quantity.base,
        description: line.description ?? defaultLineDescription(variant),
        unitPrice: line.unitPrice,
        discountType: line.discountType,
        discount: line.discount,
        taxRate: rate,
        // The same function the form totals with, at the bill's setting
        amounts: lineAmounts(
          {
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountType: line.discountType,
            discount: line.discount,
            rate: rate.rate,
          },
          pricesIncludeVat,
        ),
      });
    });
    if (issues.length > 0) throw linesError(issues);

    // The money on each bill line, all of this debit note's lines on it together
    const byBillLine = new Map<string, string[]>();
    resolved.forEach((line, index) => {
      const id = lines[index]?.billLineId ?? null;
      if (id === null) return;
      byBillLine.set(id, [...(byBillLine.get(id) ?? []), line.amounts.total]);
    });
    for (const [id, totals] of byBillLine) {
      const billed = billLine.get(id);
      if (billed === undefined) continue;
      if (compareMoney(sumMoney(totals), subtractMoney(billed.total, billed.debited)) <= 0) {
        continue;
      }
      // Under every line that takes from it: the person decides which one to lower
      lines.forEach((line, index) => {
        if (line.billLineId === id) {
          issues.push({ path: linePath(index, 'unitPrice'), code: 'debit_note_over_line' });
        }
      });
    }
    if (issues.length > 0) throw linesError(issues);
    return resolved;
  }

  // The bill's expenses, debited by money at the expense's own VAT snapshot and the bill's price
  // setting, each no more than it charged less what posted debit notes took off
  private async resolveExpenses(
    tx: Transaction,
    bill: BillInfo,
    expenses: readonly ExpenseRefs[],
  ): Promise<ResolvedExpense[]> {
    if (expenses.length === 0) return [];
    const rows = await tx
      .select()
      .from(billExpenses)
      .where(and(eq(billExpenses.tenantId, getTenantId()), eq(billExpenses.billId, bill.id)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const issues: LineIssue[] = [];
    const resolved = expenses.flatMap((expense, index): ResolvedExpense[] => {
      const billed = byId.get(expense.billExpenseId);
      if (billed === undefined) {
        issues.push({
          path: expensePath(index, 'billExpenseId'),
          code: 'debit_note_expense_invalid',
        });
        return [];
      }
      const amounts = expenseLineAmounts(
        { amount: expense.amount, rate: billed.taxRate },
        bill.pricesIncludeVat,
      );
      if (compareMoney(amounts.total, subtractMoney(billed.total, billed.debited)) > 0) {
        issues.push({ path: expensePath(index, 'amount'), code: 'debit_note_over_line' });
      }
      return [
        {
          billExpenseId: billed.id,
          amount: expense.amount,
          rate: {
            id: billed.taxRateId,
            name: billed.taxRateName,
            kind: billed.taxRateKind,
            rate: billed.taxRate,
          },
          amounts,
        },
      ];
    });
    if (issues.length > 0) throw linesError(issues);
    return resolved;
  }

  // The return lines some debit note lines name, with their return and where their goods received
  // not billed was put. lock: FOR NO KEY UPDATE in id order, so two debit notes without a bill for
  // one return line take turns, and the second sees what the first debited. A return line of a bill
  // is covered by the bill's lock (it belongs to one bill line).
  private async returnLines(
    tx: Transaction,
    ids: readonly string[],
    lock: boolean,
  ): Promise<Map<string, ReturnLineInfo>> {
    if (ids.length === 0) return new Map();
    const query = tx
      .select({
        id: purchaseReturnLines.id,
        returnId: purchaseReturnLines.returnId,
        number: purchaseReturns.number,
        supplierId: purchaseReturns.supplierId,
        status: purchaseReturns.status,
        variantId: purchaseReturnLines.variantId,
        receiptLineId: purchaseReturnLines.receiptLineId,
        billLineId: purchaseReturnLines.billLineId,
        baseQuantity: purchaseReturnLines.baseQuantity,
        debitedQuantity: purchaseReturnLines.debitedQuantity,
        value: purchaseReturnLines.value,
        returnWarehouseId: purchaseReturns.warehouseId,
        receiptWarehouseId: goodsReceipts.warehouseId,
      })
      .from(purchaseReturnLines)
      .innerJoin(
        purchaseReturns,
        and(
          eq(purchaseReturns.tenantId, purchaseReturnLines.tenantId),
          eq(purchaseReturns.id, purchaseReturnLines.returnId),
        ),
      )
      .leftJoin(
        goodsReceiptLines,
        and(
          eq(goodsReceiptLines.tenantId, purchaseReturnLines.tenantId),
          eq(goodsReceiptLines.id, purchaseReturnLines.receiptLineId),
        ),
      )
      .leftJoin(
        goodsReceipts,
        and(
          eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
          eq(goodsReceipts.id, goodsReceiptLines.receiptId),
        ),
      )
      .where(
        and(
          eq(purchaseReturnLines.tenantId, getTenantId()),
          inArray(purchaseReturnLines.id, [...new Set(ids)]),
        ),
      )
      .orderBy(asc(purchaseReturnLines.id));
    const rows = lock ? await query.for('no key update', { of: purchaseReturnLines }) : await query;
    return new Map(
      rows.map((row) => [
        row.id,
        {
          ...row,
          // The goods received not billed the return put back: at the receipt's branch, or the
          // return's for a line on its own (StockBooksService.purchaseReturn)
          warehouseId: row.receiptWarehouseId ?? row.returnWarehouseId,
        },
      ]),
    );
  }

  // Posting, in the caller's transaction. The bill is locked first: two debit notes of one bill
  // post one after the other, and the second sees what the first took off (every return line of a
  // bill belongs to one bill line, so this lock covers them too). FOR NO KEY UPDATE, like a credit
  // note's invoice (15d): the draft's insert holds a KEY SHARE lock on the bill (debit_notes_bill_fk),
  // in this transaction and in every other one saving a debit note for it, and FOR UPDATE would
  // wait for them while they wait for us. Without a bill, its return lines are locked instead. The
  // sums go up in the order migration 0042 allows (the bill and the return lines while the debit
  // note is a draft, the header posted, then the allocation, which a draft cannot have). A refused
  // step leaves nothing.
  private async postAndLog(tx: Transaction, draft: DebitNoteRow): Promise<void> {
    const tenantId = getTenantId();
    // The date first: a closed period refuses before anything is locked
    await assertPeriodOpen(tx, draft.date);
    const bill =
      draft.billId === null ? null : await this.billOf(tx, draft.billId, 'no key update');
    // Active now: the journal will not book a payable line for an archived supplier
    await assertSupplier(tx, draft.supplierId);
    if (bill !== null) this.assertDate(draft.date, bill);
    else await assertBranch(tx, draft.branchId, 'purchase_branch_invalid');
    const stored = await this.linesOf(tx, draft.id);
    const storedExpenses = await this.expensesOf(tx, draft.id);
    const returnLine = await this.returnLines(
      tx,
      stored.flatMap((line) => (line.returnLineId === null ? [] : [line.returnLineId])),
      bill === null,
    );
    // Again, under the lock: another debit note may have taken off the same lines since. The
    // draft's own rates stay usable.
    const lines = await this.resolve(
      tx,
      draft.supplierId,
      bill,
      draft.pricesIncludeVat,
      stored.map(storedRefs),
      { keptRateIds: new Set(stored.map((line) => line.taxRateId)) },
    );
    const expenses =
      bill === null ? [] : await this.resolveExpenses(tx, bill, storedExpenses.map(storedExpense));
    const number = await this.numbering.next(tx, 'purchase.debit_note', draft.date);

    // What this debit note takes off, on the bill's lines and expenses and on the return lines.
    // Only up: migration 0042 refuses anything else on a posted bill or a posted return.
    const debited = new Map<string, string[]>();
    const returned = new Map<string, string[]>();
    stored.forEach((line, index) => {
      const amounts = lines[index];
      if (amounts === undefined) return;
      if (line.billLineId !== null) {
        debited.set(line.billLineId, [
          ...(debited.get(line.billLineId) ?? []),
          amounts.amounts.total,
        ]);
      }
      if (line.returnLineId !== null) {
        returned.set(line.returnLineId, [
          ...(returned.get(line.returnLineId) ?? []),
          amounts.baseQuantity,
        ]);
      }
    });
    for (const [id, totals] of [...debited].toSorted(([a], [b]) => a.localeCompare(b))) {
      const total = sumMoney(totals);
      if (isZeroMoney(total)) continue;
      await tx
        .update(billLines)
        .set({ debited: sql`${billLines.debited} + ${total}::numeric` })
        .where(and(eq(billLines.tenantId, tenantId), eq(billLines.id, id)));
    }
    for (const expense of expenses.toSorted((a, b) =>
      a.billExpenseId.localeCompare(b.billExpenseId),
    )) {
      if (isZeroMoney(expense.amounts.total)) continue;
      await tx
        .update(billExpenses)
        .set({ debited: sql`${billExpenses.debited} + ${expense.amounts.total}::numeric` })
        .where(
          and(eq(billExpenses.tenantId, tenantId), eq(billExpenses.id, expense.billExpenseId)),
        );
    }
    for (const [id, quantities] of [...returned].toSorted(([a], [b]) => a.localeCompare(b))) {
      await tx
        .update(purchaseReturnLines)
        .set({
          debitedQuantity: sql`${purchaseReturnLines.debitedQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(purchaseReturnLines.tenantId, tenantId), eq(purchaseReturnLines.id, id)));
    }
    // The bill keeps its version (decision 31): only its money changed, nobody edited it
    if (bill !== null && !isZeroMoney(draft.total)) {
      await tx
        .update(bills)
        .set({ debitNoteTotal: sql`${bills.debitNoteTotal} + ${draft.total}::numeric` })
        .where(and(eq(bills.tenantId, tenantId), eq(bills.id, bill.id)));
    }

    // The books (decision 1)
    const entry = await this.books.debitNote(
      tx,
      { id: draft.id, number, date: draft.date },
      await this.posting(tx, draft, bill, stored, lines, returnLine, expenses),
    );
    const [posted] = await tx
      .update(debitNotes)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${debitNotes.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(debitNotes.tenantId, tenantId), eq(debitNotes.id, draft.id)))
      .returning();
    if (!posted) throw notFound('Debit note');

    // Its money on its own bill first (decision 4), up to what the bill still owes; the rest is
    // money the supplier owes the company. Read under the bill's lock.
    let applied = '0.0000';
    if (bill !== null) {
      const due = billAmountDueOf(bill);
      applied = compareMoney(draft.total, due) <= 0 ? draft.total : due;
      if (compareMoney(applied, '0') > 0) {
        await this.apply(tx, posted, [{ billId: bill.id, amount: applied }]);
      }
    }
    await audit(tx, {
      action: 'debit_note.posted',
      entityType: 'debit_note',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null, applied }),
    });
  }

  // The entry's parts (decision 22). A goods line takes its return line's share off goods received
  // not billed, and the rest of its net is the price difference; a service line of the bill (it has
  // an account) and an expense come off the account the bill charged.
  private async posting(
    tx: Transaction,
    draft: DebitNoteRow,
    bill: BillInfo | null,
    stored: readonly DebitLineRow[],
    lines: readonly ResolvedSalesLine[],
    returnLine: ReadonlyMap<string, ReturnLineInfo>,
    expenses: readonly ResolvedExpense[],
  ): Promise<DebitNotePosting> {
    const tenantId = getTenantId();
    const accountOf = new Map<string, string | null>();
    if (bill !== null) {
      const rows = await tx
        .select({ id: billLines.id, accountId: billLines.accountId })
        .from(billLines)
        .where(and(eq(billLines.tenantId, tenantId), eq(billLines.billId, bill.id)));
      for (const row of rows) accountOf.set(row.id, row.accountId);
    }
    const expenseAccounts =
      expenses.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await tx
                .select({ id: billExpenses.id, accountId: billExpenses.accountId })
                .from(billExpenses)
                .where(
                  and(
                    eq(billExpenses.tenantId, tenantId),
                    inArray(
                      billExpenses.id,
                      expenses.map((expense) => expense.billExpenseId),
                    ),
                  ),
                )
            ).map((row) => [row.id, row.accountId]),
          );
    const branchOf = await this.branchesOf(
      tx,
      [...returnLine.values()].map((line) => line.warehouseId),
    );
    const goods: DebitNotePosting['goods'][number][] = [];
    const costs: DebitNotePosting['costs'][number][] = [];
    stored.forEach((line, index) => {
      const amounts = lines[index]?.amounts;
      if (amounts === undefined) return;
      const accountId = line.billLineId === null ? null : (accountOf.get(line.billLineId) ?? null);
      if (accountId !== null) {
        costs.push({ accountId, net: amounts.net });
        return;
      }
      const back = line.returnLineId === null ? undefined : returnLine.get(line.returnLineId);
      const base = lines[index]?.baseQuantity;
      if (back === undefined || base === undefined) {
        goods.push({ net: amounts.net, receivedNotBilled: null });
        return;
      }
      const branchId = branchOf.get(back.warehouseId);
      if (branchId === undefined) throw new Error(`Warehouse ${back.warehouseId} has no branch`);
      goods.push({
        net: amounts.net,
        receivedNotBilled: { branchId, value: returnShare(back, base) },
      });
    });
    for (const expense of expenses) {
      const accountId = expenseAccounts.get(expense.billExpenseId);
      if (accountId === undefined)
        throw new Error(`Bill expense ${expense.billExpenseId} is missing`);
      costs.push({ accountId, net: expense.amounts.net });
    }
    return {
      supplierId: draft.supplierId,
      branchId: draft.branchId,
      vat: draft.vat,
      total: draft.total,
      goods,
      costs,
    };
  }

  // Replaces the debit note's allocations with `wanted`, once checkBillAllocations() has locked
  // every bill involved and checked each row (the supplier payment's check, decision 24).
  // bills.amount_debited and debit_notes.applied are not written here: the allocations' trigger
  // keeps them (migration 0042).
  private async apply(
    tx: Transaction,
    debitNote: DebitNoteRow,
    wanted: readonly { billId: string; amount: string }[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const current = await tx
      .select({ billId: debitNoteAllocations.billId, amount: debitNoteAllocations.amount })
      .from(debitNoteAllocations)
      .where(
        and(
          eq(debitNoteAllocations.tenantId, tenantId),
          eq(debitNoteAllocations.debitNoteId, debitNote.id),
        ),
      );
    await checkBillAllocations(tx, {
      supplierId: debitNote.supplierId,
      current,
      wanted,
      errors: ALLOCATION_ERRORS,
    });
    await tx
      .delete(debitNoteAllocations)
      .where(
        and(
          eq(debitNoteAllocations.tenantId, tenantId),
          eq(debitNoteAllocations.debitNoteId, debitNote.id),
        ),
      );
    if (wanted.length === 0) return;
    await tx.insert(debitNoteAllocations).values(
      wanted.map((allocation) => ({
        tenantId,
        debitNoteId: debitNote.id,
        supplierId: debitNote.supplierId,
        billId: allocation.billId,
        amount: allocation.amount,
      })),
    );
  }

  // The bill of a debit note: a posted bill of this workspace. lock: 'no key update' when posting
  // (see postAndLog), null to read it
  private async billOf(
    tx: Transaction,
    billId: string,
    lock: 'no key update' | null,
  ): Promise<BillInfo> {
    const query = tx
      .select({
        id: bills.id,
        number: bills.number,
        date: bills.date,
        supplierId: bills.supplierId,
        branchId: bills.branchId,
        status: bills.status,
        pricesIncludeVat: bills.pricesIncludeVat,
        total: bills.total,
        amountPaid: bills.amountPaid,
        amountDebited: bills.amountDebited,
      })
      .from(bills)
      .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, billId)));
    const [row] = lock === null ? await query : await query.for(lock);
    // A posted bill always has its number; the check narrows it for TypeScript
    if (row?.status !== 'posted' || row.number === null) throw billInvalid();
    return { ...row, number: row.number };
  }

  private async clearLines(tx: Transaction, debitNoteId: string): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(debitNoteLines)
      .where(
        and(eq(debitNoteLines.tenantId, tenantId), eq(debitNoteLines.debitNoteId, debitNoteId)),
      );
    await tx
      .delete(debitNoteExpenses)
      .where(
        and(
          eq(debitNoteExpenses.tenantId, tenantId),
          eq(debitNoteExpenses.debitNoteId, debitNoteId),
        ),
      );
  }

  // The lines as typed, with what the check found: the bill line's item and VAT snapshot, or the
  // return line's item and the typed rate; and the expenses at the bill expense's rate
  private async writeLines(
    tx: Transaction,
    debitNote: DebitNoteRow,
    typed: readonly LineRefs[],
    fields: CheckedDebitNote,
  ): Promise<void> {
    const tenantId = getTenantId();
    await this.clearLines(tx, debitNote.id);
    if (fields.lines.length > 0) {
      await tx.insert(debitNoteLines).values(
        fields.lines.flatMap((line, index) => {
          const refs = typed[index];
          if (refs === undefined) return [];
          return [
            {
              ...salesLineValues(line, index),
              debitNoteId: debitNote.id,
              billId: debitNote.billId,
              billLineId: refs.billLineId,
              returnLineId: refs.returnLineId,
            },
          ];
        }),
      );
    }
    const { billId } = debitNote;
    if (fields.expenses.length > 0 && billId !== null) {
      await tx.insert(debitNoteExpenses).values(
        fields.expenses.map((expense) => ({
          tenantId,
          debitNoteId: debitNote.id,
          billId,
          billExpenseId: expense.billExpenseId,
          amount: expense.amount,
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

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<DebitNoteRow> {
    const row = await this.lockRow(tx, id);
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  // FOR UPDATE: an allocate and a supplier refund of one debit note take turns
  // (SupplierRefundsService locks it too). A draft has no money to apply yet.
  private async lockPosted(tx: Transaction, id: string, version: number): Promise<DebitNoteRow> {
    const row = await this.lockRow(tx, id);
    if (row.status !== 'posted') {
      throw new AppError(
        409,
        'debit_note_not_posted',
        'Post the debit note before applying its money.',
      );
    }
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockRow(tx: Transaction, id: string): Promise<DebitNoteRow> {
    const [row] = await tx
      .select()
      .from(debitNotes)
      .where(and(eq(debitNotes.tenantId, getTenantId()), eq(debitNotes.id, id)))
      .for('update');
    if (!row) throw notFound('Debit note');
    return row;
  }

  private linesOf(tx: Transaction, debitNoteId: string): Promise<DebitLineRow[]> {
    return tx
      .select()
      .from(debitNoteLines)
      .where(
        and(
          eq(debitNoteLines.tenantId, getTenantId()),
          eq(debitNoteLines.debitNoteId, debitNoteId),
        ),
      )
      .orderBy(asc(debitNoteLines.lineNo));
  }

  // In the order they were written (the ids are random, so by the bill's expense order)
  private expensesOf(tx: Transaction, debitNoteId: string) {
    return tx
      .select({ expense: debitNoteExpenses, lineNo: billExpenses.lineNo })
      .from(debitNoteExpenses)
      .innerJoin(
        billExpenses,
        and(
          eq(billExpenses.tenantId, debitNoteExpenses.tenantId),
          eq(billExpenses.id, debitNoteExpenses.billExpenseId),
        ),
      )
      .where(
        and(
          eq(debitNoteExpenses.tenantId, getTenantId()),
          eq(debitNoteExpenses.debitNoteId, debitNoteId),
        ),
      )
      .orderBy(asc(billExpenses.lineNo))
      .then((rows) => rows.map((row) => row.expense));
  }

  // The bills its money is applied to, oldest due date first, like a supplier payment's
  private allocationsOf(tx: Transaction, debitNoteId: string) {
    return tx
      .select({
        billId: bills.id,
        billNumber: bills.number,
        supplierBillNumber: bills.supplierBillNumber,
        billDate: bills.date,
        dueDate: bills.dueDate,
        billTotal: bills.total,
        amount: debitNoteAllocations.amount,
      })
      .from(debitNoteAllocations)
      .innerJoin(
        bills,
        and(
          eq(bills.tenantId, debitNoteAllocations.tenantId),
          eq(bills.id, debitNoteAllocations.billId),
        ),
      )
      .where(
        and(
          eq(debitNoteAllocations.tenantId, getTenantId()),
          eq(debitNoteAllocations.debitNoteId, debitNoteId),
        ),
      )
      .orderBy(asc(bills.dueDate), asc(bills.id));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return (
      tx
        .select({
          debitNote: debitNotes,
          supplier: { id: parties.id, code: parties.code, name: parties.name },
          bill: {
            id: bills.id,
            number: bills.number,
            date: bills.date,
            supplierBillNumber: bills.supplierBillNumber,
          },
          lineCount,
        })
        .from(debitNotes)
        .innerJoin(
          parties,
          and(eq(parties.tenantId, debitNotes.tenantId), eq(parties.id, debitNotes.supplierId)),
        )
        // A left join: a debit note without a bill has none
        .leftJoin(
          bills,
          and(eq(bills.tenantId, debitNotes.tenantId), eq(bills.id, debitNotes.billId)),
        )
        .where(and(eq(debitNotes.tenantId, getTenantId()), where))
        .orderBy(desc(debitNotes.date), desc(debitNotes.id))
        .limit(limit)
    );
  }

  private async read(tx: Transaction, id: string): Promise<DebitNote> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(debitNotes.id, id), 1);
    if (!found) throw notFound('Debit note');
    const { debitNote: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    const expenses = await this.expensesOf(tx, id);
    const returnLineIds = lines.flatMap(({ row: line }) =>
      line.returnLineId === null ? [] : [line.returnLineId],
    );
    const [returns, billed, allocations, entry] = await Promise.all([
      returnLineIds.length === 0
        ? []
        : tx
            .select({ lineId: purchaseReturnLines.id, number: purchaseReturns.number })
            .from(purchaseReturnLines)
            .innerJoin(
              purchaseReturns,
              and(
                eq(purchaseReturns.tenantId, purchaseReturnLines.tenantId),
                eq(purchaseReturns.id, purchaseReturnLines.returnId),
              ),
            )
            .where(
              and(
                eq(purchaseReturnLines.tenantId, tenantId),
                inArray(purchaseReturnLines.id, returnLineIds),
              ),
            ),
      expenses.length === 0
        ? []
        : tx
            .select({
              id: billExpenses.id,
              accountId: billExpenses.accountId,
              description: billExpenses.description,
            })
            .from(billExpenses)
            .where(
              and(
                eq(billExpenses.tenantId, tenantId),
                inArray(
                  billExpenses.id,
                  expenses.map((expense) => expense.billExpenseId),
                ),
              ),
            ),
      this.allocationsOf(tx, id),
      row.status === 'posted' ? this.books.entryOf(tx, id, 'purchase_debit_note') : null,
    ]);
    const returnNumber = new Map(returns.map((line) => [line.lineId, line.number]));
    const billExpense = new Map(billed.map((expense) => [expense.id, expense]));
    return {
      ...toSummary(row, found.supplier, billRef(found.bill), found.lineCount),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        ...toSalesLine(line, variant),
        billLineId: line.billLineId,
        returnLineId: line.returnLineId,
        returnNumber:
          line.returnLineId === null ? null : (returnNumber.get(line.returnLineId) ?? null),
      })),
      expenses: expenses.flatMap((expense) => {
        const source = billExpense.get(expense.billExpenseId);
        // debit_note_expenses_bill_expense_fk keeps it
        if (source === undefined) return [];
        return [
          {
            id: expense.id,
            billExpenseId: expense.billExpenseId,
            accountId: source.accountId,
            description: source.description,
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
          },
        ];
      }),
      // Only posted bills are ever settled, so each has a number
      allocations: allocations.flatMap((allocation) =>
        allocation.billNumber === null
          ? []
          : [{ ...allocation, billNumber: allocation.billNumber }],
      ),
      entry,
    };
  }

  private async supplierOf(tx: Transaction, supplierId: string): Promise<PartyRef> {
    const supplier = (await customerRefs(tx, [supplierId])).get(supplierId);
    if (!supplier) throw new Error(`Supplier ${supplierId} is missing`);
    return supplier;
  }

  private size(fields: CheckedDebitNote): number {
    return fields.lines.length + fields.expenses.length;
  }

  // What the audit log shows: the header and the size (lines and expenses), not every line
  private snapshot(
    row: DebitNoteRow,
    supplier: PartyRef,
    bill: { number: string } | null,
    lines: number,
  ) {
    return {
      number: row.number,
      date: row.date,
      bill: bill?.number ?? null,
      supplier: supplier.code,
      reason: row.reason,
      supplierCreditNumber: row.supplierCreditNumber,
      total: row.total,
      lines,
    };
  }
}

// The bill of a listed debit note, from a left join: null for a debit note without a bill. Only a
// posted bill can be debited, and a posted bill is never changed back, so it has its number.
function billRef(
  bill: { id: string; number: string | null; date: string; supplierBillNumber: string } | null,
) {
  if (bill === null) return null;
  if (bill.number === null) throw new Error(`Debited bill ${bill.id} has no number`);
  return { ...bill, number: bill.number };
}

// allocationChanges() (step 15c) names each row by its invoice number; a bill's number takes that
// place in the audit log
function asInvoiceNumber(allocation: { billNumber: string | null; amount: string }) {
  return { invoiceNumber: allocation.billNumber, amount: allocation.amount };
}
