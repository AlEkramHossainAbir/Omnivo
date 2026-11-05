import { Inject, Injectable } from '@nestjs/common';
import {
  amountDueOf,
  compareMoney,
  compareQuantity,
  type CreditNote,
  type CreditNoteAllocationsInput,
  type CreditNoteInput,
  type CreditNoteStatus,
  type CreditNoteSummary,
  defaultLineDescription,
  documentTotals,
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  isZeroMoney,
  lineAmounts,
  overAllocated,
  type PartyRef,
  type SalesLineInput,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  type UpdateCreditNoteInput,
} from '@omnivo/contracts';
import {
  creditNoteAllocations,
  creditNoteLines,
  creditNotes,
  invoiceLines,
  invoices,
  parties,
  salesReturnLines,
  salesReturns,
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
import { type LineIssue, linePath, linesError, loadVariants } from '../inventory/stock-lines.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { type Allocation, allocationChanges, checkAllocations } from './allocations.js';
import { SalesBooksService } from './sales-books.service.js';
import {
  assertCustomer,
  customerRefs,
  type ResolvedSalesLine,
  salesLineValues,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type CreditNoteRow = typeof creditNotes.$inferSelect;
type CreditLineRow = typeof creditNoteLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM credit_note_lines l
   WHERE l.tenant_id = credit_notes.tenant_id AND l.credit_note_id = credit_notes.id
)`;

// The invoice a credit note credits, as far as the credit note needs it
interface InvoiceInfo {
  id: string;
  number: string;
  date: string;
  customerId: string;
  branchId: string;
  pricesIncludeVat: boolean;
  total: string;
  amountPaid: string;
  amountCredited: string;
}

// What a line names, as the form sends it and as the database keeps it
interface LineRefs {
  invoiceLineId: string;
  returnLineId: string | null;
  unitId: string;
  quantity: string;
  description: string | null;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'sales_not_draft',
    'Only a draft credit note can be changed. A posted one is final: write another one.',
  );
}

function invoiceInvalid(): AppError {
  return new AppError(409, 'credit_note_invoice_invalid', 'Pick a posted invoice.', {
    fieldErrors: { invoiceId: ['credit_note_invoice_invalid'] },
  });
}

function overAllocatedError(): AppError {
  return new AppError(
    409,
    'credit_note_over_allocated',
    'More is applied than the credit note has. Lower the amounts on the invoices.',
    { fieldErrors: { allocations: ['credit_note_over_allocated'] } },
  );
}

function toSummary(
  row: CreditNoteRow,
  customer: PartyRef,
  invoice: { id: string; number: string; date: string; branchId: string },
  lines: number,
): CreditNoteSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    invoice: { id: invoice.id, number: invoice.number, date: invoice.date },
    branchId: invoice.branchId,
    reason: row.reason,
    status: row.status,
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

// A stored line as the check reads it again when the draft is posted
function storedRefs(line: CreditLineRow): LineRefs {
  return {
    invoiceLineId: line.invoiceLineId,
    returnLineId: line.returnLineId,
    unitId: line.unitId,
    quantity: line.quantity,
    description: line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: line.discount,
  };
}

// The database's last word, if two writers got past the checks: the invoice locks make these
// unreachable in practice, but each still answers with the code the form knows. A line credited
// past what it charged (invoice_lines_credited_check, and invoices_credited_check for the whole
// invoice), a return line past what came back, an invoice settled past its total by receipts and
// credit notes together, or a credit note applied and paid back past its total.
function moneyRace(error: unknown): unknown {
  if (
    isCheckViolation(error, 'invoice_lines_credited_check') ||
    isCheckViolation(error, 'invoices_credited_check')
  ) {
    return new AppError(
      409,
      'credit_note_over_line',
      'Another credit note took back some of these lines first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'sales_return_lines_credited_check')) {
    return new AppError(
      409,
      'credit_note_over_return',
      'Another credit note gave the money back for these goods first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'invoices_paid_check')) {
    return new AppError(
      409,
      'credit_note_over_invoice',
      'A receipt or another credit note settled one of these invoices first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'credit_notes_money_check')) return overAllocatedError();
  return error;
}

// Credit notes (step 15d): part or all of a posted invoice taken back. A draft is changed freely;
// "Post" numbers it, books the sale back, counts it on the invoice and the return lines it names,
// and applies its money to its own invoice. Afterwards only its money moves (allocate, and refunds).
@Injectable()
export class CreditNotesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: SalesBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: CreditNoteStatus | undefined;
    customerId?: string | undefined;
    invoiceId?: string | undefined;
  }): Promise<{ items: CreditNoteSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(creditNotes.status, query.status),
          query.customerId === undefined ? undefined : eq(creditNotes.customerId, query.customerId),
          query.invoiceId === undefined ? undefined : eq(creditNotes.invoiceId, query.invoiceId),
          after === undefined
            ? undefined
            : sql`(${creditNotes.date}, ${creditNotes.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.creditNote.date, last.creditNote.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.creditNote, row.customer, this.invoiceRef(row.invoice), row.lineCount),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<CreditNote> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: CreditNoteInput): Promise<CreditNote> {
    try {
      return await this.withTenant(async (tx) => {
        const fields = await this.check(tx, input, null);
        const [row] = await tx
          .insert(creditNotes)
          .values({
            tenantId: getTenantId(),
            ...fields.header,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Credit note insert returned no row');
        await this.writeLines(tx, row, input.lines, fields.lines);
        await audit(tx, {
          action: 'credit_note.created',
          entityType: 'credit_note',
          entityId: row.id,
          changes: created(
            this.snapshot(row, fields.customer, fields.invoice, fields.lines.length),
          ),
        });
        if (input.post) await this.postAndLog(tx, row);
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw moneyRace(error);
    }
  }

  async update(id: string, input: UpdateCreditNoteInput): Promise<CreditNote> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, input.version);
        const linesBefore = await this.linesOf(tx, id);
        const customerBefore = await this.customerOf(tx, before.customerId);
        const invoiceBefore = await this.invoiceOf(tx, before.invoiceId, null);
        const fields = await this.check(tx, input, before);
        const [updated] = await tx
          .update(creditNotes)
          .set({
            ...fields.header,
            version: sql`${creditNotes.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(creditNotes.tenantId, getTenantId()), eq(creditNotes.id, id)))
          .returning();
        if (!updated) throw notFound('Credit note');
        await this.writeLines(tx, updated, input.lines, fields.lines);
        await audit(tx, {
          action: 'credit_note.updated',
          entityType: 'credit_note',
          entityId: id,
          changes: diff(
            this.snapshot(before, customerBefore, invoiceBefore, linesBefore.length),
            this.snapshot(updated, fields.customer, fields.invoice, fields.lines.length),
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
      const customer = await this.customerOf(tx, before.customerId);
      const invoice = await this.invoiceOf(tx, before.invoiceId, null);
      // The lines go with it (ON DELETE CASCADE). A draft took nothing back: nothing to undo.
      await tx
        .delete(creditNotes)
        .where(and(eq(creditNotes.tenantId, getTenantId()), eq(creditNotes.id, id)));
      const snapshot = this.snapshot(before, customer, invoice, lines.length);
      await audit(tx, {
        action: 'credit_note.deleted',
        entityType: 'credit_note',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  async post(id: string, version: number): Promise<CreditNote> {
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

  // The whole list as the person left it, like a receipt's: what is left of the credit after its
  // own invoice moved to another invoice of the customer, or taken off to pay it back. Nothing in
  // the books changes, only what each invoice still owes.
  async allocate(id: string, input: CreditNoteAllocationsInput): Promise<CreditNote> {
    try {
      return await this.withTenant(async (tx) => {
        const row = await this.lockPosted(tx, id, input.version);
        // What refunds paid back is gone: only the rest can be applied
        if (overAllocated(subtractMoney(row.total, row.refunded), input.allocations)) {
          throw overAllocatedError();
        }
        const before = await this.allocationsOf(tx, id);
        await this.apply(tx, row, input.allocations);
        await tx
          .update(creditNotes)
          .set({ version: sql`${creditNotes.version} + 1`, updatedBy: currentPrincipal().userId })
          .where(and(eq(creditNotes.tenantId, getTenantId()), eq(creditNotes.id, id)));
        await audit(tx, {
          action: 'credit_note.allocated',
          entityType: 'credit_note',
          entityId: id,
          changes: allocationChanges(before, await this.allocationsOf(tx, id)),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw moneyRace(error);
    }
  }

  // Every rule of a save the contract cannot check, and the header it writes. `before`: the draft
  // being changed (null for a new one); its customer stays usable after it was archived, like every
  // draft. The customer is always the invoice's.
  private async check(tx: Transaction, input: CreditNoteInput, before: CreditNoteRow | null) {
    const invoice = await this.invoiceOf(tx, input.invoiceId, null);
    const customer = await assertCustomer(tx, invoice.customerId, before?.customerId ?? null);
    this.assertDate(input.date, invoice);
    const lines = await this.resolve(tx, invoice, input.lines);
    return {
      invoice,
      customer,
      header: {
        date: input.date,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        reason: input.reason,
        note: input.note,
        ...documentTotals(lines.map((line) => line.amounts)),
      },
      lines,
    };
  }

  // A credit note is written for something the invoice sold, so it is not dated before it. The
  // 6-month VAT rule (creditNoteIsLate) is only a warning on the form: you chose not to block it.
  private assertDate(date: string, invoice: InvoiceInfo): void {
    if (date < invoice.date) {
      throw new AppError(
        409,
        'credit_note_date',
        'A credit note cannot be dated before its invoice.',
        { fieldErrors: { date: ['credit_note_date'] } },
      );
    }
  }

  // The lines checked against the invoice and the returns they name, and worked out like the
  // invoice's lines: the invoice line's item, its VAT snapshot (VAT goes back at the rate it was
  // charged, even if the rate changed or was archived since) and the invoice's price setting, so
  // crediting a line in full gives back exactly what it charged. The caps: no line more than its
  // invoice line's quantity; the lines on one invoice line no more money than it charged less what
  // posted credit notes took back already (a price cut on all 100 pcs and a later return of 10 can
  // both be credited, up to what was billed); a return line's goods once. Drafts hold nothing, so
  // posting checks again under the invoice's lock. All problems at once, under each line.
  private async resolve(
    tx: Transaction,
    invoice: InvoiceInfo,
    lines: readonly LineRefs[],
  ): Promise<ResolvedSalesLine[]> {
    const tenantId = getTenantId();
    const invoiceLineRows = await tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.invoiceId, invoice.id)));
    const invoiceLine = new Map(invoiceLineRows.map((row) => [row.id, row]));
    const variants = await loadVariants(
      tx,
      invoiceLineRows.map((row) => row.variantId),
    );
    const returnLineIds = lines.flatMap((line) =>
      line.returnLineId === null ? [] : [line.returnLineId],
    );
    const returnLineRows =
      returnLineIds.length === 0
        ? []
        : await tx
            .select({
              id: salesReturnLines.id,
              invoiceLineId: salesReturnLines.invoiceLineId,
              baseQuantity: salesReturnLines.baseQuantity,
              creditedQuantity: salesReturnLines.creditedQuantity,
              status: salesReturns.status,
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
                eq(salesReturnLines.tenantId, tenantId),
                inArray(salesReturnLines.id, returnLineIds),
              ),
            );
    const returnLine = new Map(returnLineRows.map((row) => [row.id, row]));

    const issues: LineIssue[] = [];
    const resolved: ResolvedSalesLine[] = [];
    lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      const billed = invoiceLine.get(line.invoiceLineId);
      const variant = billed === undefined ? undefined : variants.get(billed.variantId);
      if (billed === undefined || variant === undefined) {
        at('invoiceLineId', 'credit_note_line_invalid');
        return;
      }
      // Any unit of the item: 3 strips back from a line of 2 boxes
      const unit =
        line.unitId === variant.baseUnitId
          ? { factor: '1', decimals: variant.baseDecimals }
          : variant.units.find((pack) => pack.unitId === line.unitId);
      if (unit === undefined) {
        at('unitId', 'stock_unit_invalid');
        return;
      }
      if (!fitsDecimals(line.quantity, unit.decimals)) {
        at('quantity', 'stock_quantity_decimals');
        return;
      }
      const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
      if (!isQuantity(baseQuantity)) {
        at('quantity', 'quantity_format');
        return;
      }
      if (compareQuantity(baseQuantity, billed.baseQuantity) > 0) {
        at('quantity', 'credit_note_over_quantity');
      }
      if (line.returnLineId !== null) {
        const back = returnLine.get(line.returnLineId);
        // The return line this invoice line billed (its invoice_line_id), on a posted return
        if (back?.invoiceLineId !== billed.id || back.status !== 'posted') {
          at('returnLineId', 'credit_note_return_invalid');
        } else if (
          compareQuantity(
            baseQuantity,
            subtractQuantity(back.baseQuantity, back.creditedQuantity),
          ) > 0
        ) {
          at('quantity', 'credit_note_over_return');
        }
      }
      resolved.push({
        variant,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: unit.factor,
        baseQuantity,
        description: line.description ?? defaultLineDescription(variant),
        unitPrice: line.unitPrice,
        discountType: line.discountType,
        discount: line.discount,
        taxRate: {
          id: billed.taxRateId,
          name: billed.taxRateName,
          kind: billed.taxRateKind,
          rate: billed.taxRate,
        },
        // The same function the form totals with, at the invoice's setting
        amounts: lineAmounts(
          {
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountType: line.discountType,
            discount: line.discount,
            rate: billed.taxRate,
          },
          invoice.pricesIncludeVat,
        ),
      });
    });
    if (issues.length > 0) throw linesError(issues);

    // The money on each invoice line, all of this credit note's lines on it together
    const byInvoiceLine = new Map<string, string[]>();
    resolved.forEach((line, index) => {
      const id = lines[index]?.invoiceLineId;
      if (id === undefined) return;
      byInvoiceLine.set(id, [...(byInvoiceLine.get(id) ?? []), line.amounts.total]);
    });
    for (const [id, totals] of byInvoiceLine) {
      const billed = invoiceLine.get(id);
      if (billed === undefined) continue;
      const left = subtractMoney(billed.total, billed.credited);
      if (compareMoney(sumMoney(totals), left) <= 0) continue;
      // Under every line that takes from it: the person decides which one to lower
      lines.forEach((line, index) => {
        if (line.invoiceLineId === id) {
          issues.push({ path: linePath(index, 'unitPrice'), code: 'credit_note_over_line' });
        }
      });
    }
    if (issues.length > 0) throw linesError(issues);
    return resolved;
  }

  // Posting, in the caller's transaction. The invoice is locked first: two credit notes of one
  // invoice post one after the other, and the second sees what the first took back (every return
  // line belongs to one invoice line, so this lock covers the return lines too). FOR NO KEY UPDATE:
  // the draft's insert took a KEY SHARE lock on the invoice (credit_notes_invoice_fk), in this
  // transaction and in every other one saving a credit note for it. FOR UPDATE conflicts with
  // KEY SHARE, so two of them would each wait for the other (a deadlock, a 500); NO KEY UPDATE
  // does not, and two of them still take turns. The sums go up in the order migration 0032
  // allows (lines while the credit note is a draft, the header posted, then the allocation, which
  // a draft cannot have). A refused step leaves nothing.
  private async postAndLog(tx: Transaction, draft: CreditNoteRow): Promise<void> {
    const tenantId = getTenantId();
    // The date first: a closed period refuses before anything is locked
    await assertPeriodOpen(tx, draft.date);
    const invoice = await this.invoiceOf(tx, draft.invoiceId, 'no key update');
    // Active now: the journal will not book a receivable line for an archived customer
    await assertCustomer(tx, draft.customerId);
    this.assertDate(draft.date, invoice);
    const stored = await this.linesOf(tx, draft.id);
    // Again, under the lock: another credit note may have taken back the same lines since
    const lines = await this.resolve(tx, invoice, stored.map(storedRefs));
    const number = await this.numbering.next(tx, 'sales.credit_note', draft.date);

    // What this credit note takes back, on the invoice's lines and its return lines. Only up:
    // migration 0032 refuses anything else on a posted invoice or a posted return.
    const credited = new Map<string, string[]>();
    const returned = new Map<string, string[]>();
    stored.forEach((line, index) => {
      const amounts = lines[index];
      if (amounts === undefined) return;
      credited.set(line.invoiceLineId, [
        ...(credited.get(line.invoiceLineId) ?? []),
        amounts.amounts.total,
      ]);
      if (line.returnLineId !== null) {
        returned.set(line.returnLineId, [
          ...(returned.get(line.returnLineId) ?? []),
          amounts.baseQuantity,
        ]);
      }
    });
    for (const [id, totals] of [...credited].toSorted(([a], [b]) => a.localeCompare(b))) {
      const total = sumMoney(totals);
      if (isZeroMoney(total)) continue;
      await tx
        .update(invoiceLines)
        .set({ credited: sql`${invoiceLines.credited} + ${total}::numeric` })
        .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.id, id)));
    }
    for (const [id, quantities] of [...returned].toSorted(([a], [b]) => a.localeCompare(b))) {
      await tx
        .update(salesReturnLines)
        .set({
          creditedQuantity: sql`${salesReturnLines.creditedQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(salesReturnLines.tenantId, tenantId), eq(salesReturnLines.id, id)));
    }
    // The invoice keeps its version: migration 0032 lets a posted invoice change only its money,
    // and no invoice action decides anything on its credited total
    if (!isZeroMoney(draft.total)) {
      await tx
        .update(invoices)
        .set({ creditNoteTotal: sql`${invoices.creditNoteTotal} + ${draft.total}::numeric` })
        .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoice.id)));
    }

    // The books: the sale back, on the invoice's branch
    const entry = await this.books.creditNote(
      tx,
      { id: draft.id, number, date: draft.date },
      {
        customerId: draft.customerId,
        branchId: invoice.branchId,
        net: draft.net,
        vat: draft.vat,
        total: draft.total,
      },
    );
    const [posted] = await tx
      .update(creditNotes)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${creditNotes.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(creditNotes.tenantId, tenantId), eq(creditNotes.id, draft.id)))
      .returning();
    if (!posted) throw notFound('Credit note');

    // Its money on its own invoice first (you chose this), up to what the invoice still owes; the
    // rest is the customer's advance. Read under the invoice's lock.
    const due = amountDueOf(invoice);
    const applied = compareMoney(draft.total, due) <= 0 ? draft.total : due;
    if (compareMoney(applied, '0') > 0) {
      await this.apply(tx, posted, [{ invoiceId: invoice.id, amount: applied }]);
    }
    await audit(tx, {
      action: 'credit_note.posted',
      entityType: 'credit_note',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null, applied }),
    });
  }

  // Replaces the credit note's allocations with `wanted`, once checkAllocations() has locked every
  // invoice involved and checked each row. invoices.amount_credited and credit_notes.applied are
  // not written here: the allocations' trigger keeps them (migration 0032).
  private async apply(
    tx: Transaction,
    creditNote: CreditNoteRow,
    wanted: readonly Allocation[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const current = await tx
      .select({
        invoiceId: creditNoteAllocations.invoiceId,
        amount: creditNoteAllocations.amount,
      })
      .from(creditNoteAllocations)
      .where(
        and(
          eq(creditNoteAllocations.tenantId, tenantId),
          eq(creditNoteAllocations.creditNoteId, creditNote.id),
        ),
      );
    await checkAllocations(tx, {
      customerId: creditNote.customerId,
      current,
      wanted,
      errors: { invoice: 'credit_note_allocation_invalid', over: 'credit_note_over_invoice' },
    });
    await tx
      .delete(creditNoteAllocations)
      .where(
        and(
          eq(creditNoteAllocations.tenantId, tenantId),
          eq(creditNoteAllocations.creditNoteId, creditNote.id),
        ),
      );
    if (wanted.length === 0) return;
    await tx.insert(creditNoteAllocations).values(
      wanted.map((allocation) => ({
        tenantId,
        creditNoteId: creditNote.id,
        customerId: creditNote.customerId,
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
      })),
    );
  }

  // The invoice of a credit note: a posted invoice of this workspace. lock: 'no key update' when
  // posting (see postAndLog), null to read it
  private async invoiceOf(
    tx: Transaction,
    invoiceId: string,
    lock: 'no key update' | null,
  ): Promise<InvoiceInfo> {
    const query = tx
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.date,
        customerId: invoices.customerId,
        branchId: invoices.branchId,
        status: invoices.status,
        pricesIncludeVat: invoices.pricesIncludeVat,
        total: invoices.total,
        amountPaid: invoices.amountPaid,
        amountCredited: invoices.amountCredited,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, invoiceId)));
    const [row] = lock === null ? await query : await query.for(lock);
    // A posted invoice always has its number; the check narrows it for TypeScript
    if (row?.status !== 'posted' || row.number === null) throw invoiceInvalid();
    return { ...row, number: row.number };
  }

  // The lines as typed, with what the check found: the invoice line's item and VAT snapshot
  private async writeLines(
    tx: Transaction,
    creditNote: CreditNoteRow,
    typed: readonly LineRefs[],
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(creditNoteLines)
      .where(
        and(
          eq(creditNoteLines.tenantId, tenantId),
          eq(creditNoteLines.creditNoteId, creditNote.id),
        ),
      );
    await tx.insert(creditNoteLines).values(
      lines.flatMap((line, index) => {
        const refs = typed[index];
        if (refs === undefined) return [];
        return [
          {
            ...salesLineValues(line, index),
            creditNoteId: creditNote.id,
            invoiceId: creditNote.invoiceId,
            invoiceLineId: refs.invoiceLineId,
            returnLineId: refs.returnLineId,
          },
        ];
      }),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<CreditNoteRow> {
    const row = await this.lockRow(tx, id);
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  // FOR UPDATE: an allocate and a refund of one credit note take turns (RefundsService locks it
  // too). A draft has no money to apply yet.
  private async lockPosted(tx: Transaction, id: string, version: number): Promise<CreditNoteRow> {
    const row = await this.lockRow(tx, id);
    if (row.status !== 'posted') {
      throw new AppError(
        409,
        'credit_note_not_posted',
        'Post the credit note before applying its money.',
      );
    }
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockRow(tx: Transaction, id: string): Promise<CreditNoteRow> {
    const [row] = await tx
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.tenantId, getTenantId()), eq(creditNotes.id, id)))
      .for('update');
    if (!row) throw notFound('Credit note');
    return row;
  }

  private linesOf(tx: Transaction, creditNoteId: string): Promise<CreditLineRow[]> {
    return tx
      .select()
      .from(creditNoteLines)
      .where(
        and(
          eq(creditNoteLines.tenantId, getTenantId()),
          eq(creditNoteLines.creditNoteId, creditNoteId),
        ),
      )
      .orderBy(asc(creditNoteLines.lineNo));
  }

  // The invoices its money is applied to, oldest due date first, like a receipt's
  private allocationsOf(tx: Transaction, creditNoteId: string) {
    return tx
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.number,
        invoiceDate: invoices.date,
        dueDate: invoices.dueDate,
        invoiceTotal: invoices.total,
        amount: creditNoteAllocations.amount,
      })
      .from(creditNoteAllocations)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, creditNoteAllocations.tenantId),
          eq(invoices.id, creditNoteAllocations.invoiceId),
        ),
      )
      .where(
        and(
          eq(creditNoteAllocations.tenantId, getTenantId()),
          eq(creditNoteAllocations.creditNoteId, creditNoteId),
        ),
      )
      .orderBy(asc(invoices.dueDate), asc(invoices.id));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        creditNote: creditNotes,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        invoice: {
          id: invoices.id,
          number: invoices.number,
          date: invoices.date,
          branchId: invoices.branchId,
          pricesIncludeVat: invoices.pricesIncludeVat,
        },
        lineCount,
      })
      .from(creditNotes)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, creditNotes.tenantId), eq(parties.id, creditNotes.customerId)),
      )
      .innerJoin(
        invoices,
        and(eq(invoices.tenantId, creditNotes.tenantId), eq(invoices.id, creditNotes.invoiceId)),
      )
      .where(and(eq(creditNotes.tenantId, getTenantId()), where))
      .orderBy(desc(creditNotes.date), desc(creditNotes.id))
      .limit(limit);
  }

  // The invoice of a listed credit note. Only a posted invoice can be credited, and a posted invoice
  // is never changed back, so it always has its number.
  private invoiceRef(invoice: {
    id: string;
    number: string | null;
    date: string;
    branchId: string;
  }) {
    if (invoice.number === null) throw new Error(`Credited invoice ${invoice.id} has no number`);
    return { ...invoice, number: invoice.number };
  }

  private async read(tx: Transaction, id: string): Promise<CreditNote> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(creditNotes.id, id), 1);
    if (!found) throw notFound('Credit note');
    const { creditNote: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    const returnLineIds = lines.flatMap(({ row: line }) =>
      line.returnLineId === null ? [] : [line.returnLineId],
    );
    const [returns, allocations, entry] = await Promise.all([
      returnLineIds.length === 0
        ? []
        : tx
            .select({ lineId: salesReturnLines.id, number: salesReturns.number })
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
                eq(salesReturnLines.tenantId, tenantId),
                inArray(salesReturnLines.id, returnLineIds),
              ),
            ),
      this.allocationsOf(tx, id),
      row.status === 'posted' ? this.books.entryOf(tx, id, 'sales_credit_note') : null,
    ]);
    const returnNumber = new Map(returns.map((line) => [line.lineId, line.number]));
    return {
      ...toSummary(row, found.customer, this.invoiceRef(found.invoice), found.lineCount),
      pricesIncludeVat: found.invoice.pricesIncludeVat,
      discount: row.discount,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        ...toSalesLine(line, variant),
        invoiceLineId: line.invoiceLineId,
        returnLineId: line.returnLineId,
        returnNumber:
          line.returnLineId === null ? null : (returnNumber.get(line.returnLineId) ?? null),
      })),
      // Only posted invoices are ever settled, so each has a number
      allocations: allocations.flatMap((allocation) =>
        allocation.invoiceNumber === null
          ? []
          : [{ ...allocation, invoiceNumber: allocation.invoiceNumber }],
      ),
      entry,
    };
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  // What the audit log shows: the header and the size, not every line
  private snapshot(
    row: CreditNoteRow,
    customer: PartyRef,
    invoice: { number: string },
    lines: number,
  ) {
    return {
      number: row.number,
      date: row.date,
      invoice: invoice.number,
      customer: customer.code,
      reason: row.reason,
      total: row.total,
      lines,
    };
  }
}
