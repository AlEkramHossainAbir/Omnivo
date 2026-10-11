import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  moneyAccountIds,
  overAllocated,
  type PartyRef,
  type Receipt,
  type ReceiptInput,
  type ReceiptStatus,
  type ReceiptSummary,
  subtractMoney,
  sumMoney,
  type VoidReceiptInput,
} from '@omnivo/contracts';
import { invoices, ledgerAccounts, parties, receiptAllocations, receipts } from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type LineIssue, linesError } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { SalesBooksService } from './sales-books.service.js';
import { assertBranch, assertCustomer } from './sales-lines.js';

type ReceiptRow = typeof receipts.$inferSelect;

interface Allocation {
  invoiceId: string;
  amount: string;
}

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

function toSummary(row: ReceiptRow, customer: PartyRef): ReceiptSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    amount: row.amount,
    applied: row.applied,
    method: row.method,
    reference: row.reference,
    accountId: row.accountId,
    branchId: row.branchId,
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function voided(): AppError {
  return new AppError(409, 'receipt_voided', 'This receipt is voided and cannot be changed.');
}

function overAllocatedError(): AppError {
  return new AppError(
    409,
    'receipt_over_allocated',
    'More is applied than the receipt brought. Lower the amounts on the invoices.',
    { fieldErrors: { allocations: ['receipt_over_allocated'] } },
  );
}

// An allocation's problem, under its own row of the form: allocations.2.amount
function allocationPath(index: number, field: string): string {
  return `allocations.${String(index)}.${field}`;
}

// Money receipts (step 15c). Saving one posts it at once: it gets its number (MR-2026-27-0001) and
// its entry, and its money is applied to the invoices the form chose. Afterwards only two things
// happen to it: its money is applied again (allocate), or it is voided.
@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: SalesBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: ReceiptStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: ReceiptSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(receipts.status, query.status),
          query.customerId === undefined ? undefined : eq(receipts.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${receipts.date}, ${receipts.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.receipt.date, last.receipt.id]);
      return {
        items: page.items.map((row) => toSummary(row.receipt, row.customer)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Receipt> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: ReceiptInput): Promise<Receipt> {
    try {
      return await this.withTenant(async (tx) => {
        const customer = await assertCustomer(tx, input.customerId);
        await assertBranch(tx, input.branchId);
        await this.assertMoneyAccount(tx, input.accountId);
        const number = await this.numbering.next(tx, 'sales.receipt', input.date);
        const [row] = await tx
          .insert(receipts)
          .values({
            tenantId: getTenantId(),
            number,
            date: input.date,
            customerId: customer.id,
            amount: input.amount,
            accountId: input.accountId,
            method: input.method,
            reference: input.reference,
            branchId: input.branchId,
            note: input.note,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Receipt insert returned no row');
        // The books first: a closed period refuses here, before any invoice is touched
        const entry = await this.books.receipt(
          tx,
          { id: row.id, number, date: row.date },
          {
            customerId: customer.id,
            branchId: row.branchId,
            accountId: row.accountId,
            amount: row.amount,
          },
        );
        await this.apply(tx, row, input.allocations);
        await audit(tx, {
          action: 'receipt.created',
          entityType: 'receipt',
          entityId: row.id,
          changes: created({
            number,
            date: row.date,
            customer: customer.code,
            amount: row.amount,
            method: row.method,
            entry: entry.number,
            invoices: input.allocations.length,
          }),
        });
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw overInvoiceRace(error);
    }
  }

  // The whole list as the person left it: the money of an advance applied to a new invoice, or
  // moved from one invoice to another. Nothing in the books changes — the receivable is one
  // number per customer — only what each invoice still owes.
  async allocate(
    id: string,
    input: { version: number; allocations: readonly Allocation[] },
  ): Promise<Receipt> {
    try {
      return await this.withTenant(async (tx) => {
        const row = await this.lock(tx, id, input.version);
        if (overAllocated(row.amount, input.allocations)) throw overAllocatedError();
        const before = await this.allocationsOf(tx, id);
        await this.apply(tx, row, input.allocations);
        await tx
          .update(receipts)
          .set({ version: sql`${receipts.version} + 1`, updatedBy: currentPrincipal().userId })
          .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, id)));
        await audit(tx, {
          action: 'receipt.allocated',
          entityType: 'receipt',
          entityId: id,
          changes: this.allocationChanges(before, await this.allocationsOf(tx, id)),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw overInvoiceRace(error);
    }
  }

  // A bounced cheque or a receipt typed by mistake: its money comes off the invoices, and its entry
  // is reversed on the void date. The receipt stays, voided, so its number is never reused or
  // missing from the series.
  void(id: string, input: VoidReceiptInput): Promise<Receipt> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (input.date < row.date) {
        throw new AppError(
          409,
          'receipt_void_date',
          'A receipt cannot be voided before the day it was received.',
          { fieldErrors: { date: ['receipt_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id, 'sales_receipt');
      if (entry === null) throw new Error(`Receipt ${id} has no entry`);
      // The allocations first: the database lets a receipt be voided only once nothing of it is
      // applied (receipts_void_check). Their trigger takes the money off the invoices.
      await this.apply(tx, row, []);
      await tx
        .update(receipts)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${receipts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, id)));
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Money receipt ${row.number} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'receipt.voided',
        entityType: 'receipt',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }

  // Replaces the receipt's allocations with `wanted`. Each invoice must be a posted invoice of the
  // receipt's customer, and get no more than it still owes (what this receipt had on it counts as
  // owed again: it is being replaced). The invoices are locked FOR UPDATE in id order before
  // anything is written, so two receipts paying one invoice take turns, and the second sees what
  // the first paid. amount_paid and applied are not written here: the allocations' trigger keeps
  // them (migration 0030).
  private async apply(
    tx: Transaction,
    receipt: ReceiptRow,
    wanted: readonly Allocation[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const current = await tx
      .select({ invoiceId: receiptAllocations.invoiceId, amount: receiptAllocations.amount })
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receipt.id),
        ),
      );
    const invoiceIds = [
      ...new Set([...current, ...wanted].map((allocation) => allocation.invoiceId)),
    ];
    const rows =
      invoiceIds.length === 0
        ? []
        : await tx
            .select({
              id: invoices.id,
              customerId: invoices.customerId,
              status: invoices.status,
              total: invoices.total,
              amountPaid: invoices.amountPaid,
            })
            .from(invoices)
            .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, invoiceIds)))
            .orderBy(asc(invoices.id))
            .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const had = new Map(current.map((allocation) => [allocation.invoiceId, allocation.amount]));

    const issues: LineIssue[] = [];
    wanted.forEach((allocation, index) => {
      const invoice = byId.get(allocation.invoiceId);
      if (invoice?.customerId !== receipt.customerId || invoice.status !== 'posted') {
        issues.push({ path: allocationPath(index, 'invoiceId'), code: 'receipt_invoice_invalid' });
        return;
      }
      const due = sumMoney([
        subtractMoney(invoice.total, invoice.amountPaid),
        had.get(allocation.invoiceId) ?? '0',
      ]);
      if (compareMoney(allocation.amount, due) > 0) {
        issues.push({ path: allocationPath(index, 'amount'), code: 'receipt_over_invoice' });
      }
    });
    if (issues.length > 0) throw linesError(issues);

    await tx
      .delete(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receipt.id),
        ),
      );
    if (wanted.length === 0) return;
    await tx.insert(receiptAllocations).values(
      wanted.map((allocation) => ({
        tenantId,
        receiptId: receipt.id,
        customerId: receipt.customerId,
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
      })),
    );
  }

  // A money account: active, not a group, and flagged itself or under a flagged group
  // (contracts' moneyAccountIds — the receipt form offers exactly the same list). The whole chart
  // is read: it is a few hundred rows at most. FOR SHARE on the chosen one: nobody archives it or
  // unticks its group's flag before we commit (the journal locks it again when posting).
  private async assertMoneyAccount(tx: Transaction, accountId: string): Promise<void> {
    const chart = await tx
      .select({
        id: ledgerAccounts.id,
        parentId: ledgerAccounts.parentId,
        isGroup: ledgerAccounts.isGroup,
        holdsMoney: ledgerAccounts.holdsMoney,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.tenantId, getTenantId()));
    const money = moneyAccountIds(
      chart.map((account) => ({
        ...account,
        archivedAt: account.archivedAt?.toISOString() ?? null,
      })),
    );
    if (!money.has(accountId)) {
      throw new AppError(
        409,
        'receipt_account_invalid',
        'Pick a cash, bank or mobile wallet account.',
        { fieldErrors: { accountId: ['receipt_account_invalid'] } },
      );
    }
    await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, accountId)))
      .for('share');
  }

  // FOR UPDATE: an allocate and a void of one receipt take turns. A voided receipt is final.
  private async lock(tx: Transaction, id: string, version: number): Promise<ReceiptRow> {
    const [row] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, id)))
      .for('update');
    if (!row) throw notFound('Receipt');
    if (row.status === 'voided') throw voided();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  // The invoices it pays, oldest due date first: the order the form suggested them in
  private allocationsOf(tx: Transaction, receiptId: string) {
    return tx
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.number,
        invoiceDate: invoices.date,
        dueDate: invoices.dueDate,
        invoiceTotal: invoices.total,
        amount: receiptAllocations.amount,
      })
      .from(receiptAllocations)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, receiptAllocations.tenantId),
          eq(invoices.id, receiptAllocations.invoiceId),
        ),
      )
      .where(
        and(
          eq(receiptAllocations.tenantId, getTenantId()),
          eq(receiptAllocations.receiptId, receiptId),
        ),
      )
      .orderBy(asc(invoices.dueDate), asc(invoices.id));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        receipt: receipts,
        customer: { id: parties.id, code: parties.code, name: parties.name },
      })
      .from(receipts)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, receipts.tenantId), eq(parties.id, receipts.customerId)),
      )
      .where(and(eq(receipts.tenantId, getTenantId()), where))
      .orderBy(desc(receipts.date), desc(receipts.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Receipt> {
    const [found] = await this.rows(tx, eq(receipts.id, id), 1);
    if (!found) throw notFound('Receipt');
    const { receipt: row } = found;
    const [allocations, entry] = await Promise.all([
      this.allocationsOf(tx, id),
      this.books.entryOf(tx, id, 'sales_receipt'),
    ]);
    if (entry === null) throw new Error(`Receipt ${id} has no entry`);
    const voidEntry = row.status === 'voided' ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(row, found.customer),
      note: row.note,
      // Only posted invoices are ever paid, so each has a number
      allocations: allocations.flatMap((allocation) =>
        allocation.invoiceNumber === null
          ? []
          : [{ ...allocation, invoiceNumber: allocation.invoiceNumber }],
      ),
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
    };
  }

  // What the audit log shows of the allocations: one row per invoice number, with the amount
  // before and after. diff() walks the new list only, so an invoice the money was taken off is
  // added with null; without that, the log would not show where the money came from.
  private allocationChanges(
    before: readonly { invoiceNumber: string | null; amount: string }[],
    after: readonly { invoiceNumber: string | null; amount: string }[],
  ) {
    const from = allocationSnapshot(before);
    const to: Record<string, string | null> = allocationSnapshot(after);
    for (const invoiceNumber of Object.keys(from)) to[invoiceNumber] ??= null;
    return diff(from, to);
  }
}

// Invoice number → amount
function allocationSnapshot(
  allocations: readonly { invoiceNumber: string | null; amount: string }[],
): Record<string, string> {
  return Object.fromEntries(
    allocations.map((allocation) => [allocation.invoiceNumber ?? '', allocation.amount]),
  );
}

// The database's last word, if two writers got past the checks above: an invoice paid past its
// total (invoices_paid_check), or a receipt applied past its amount (receipts_amount_check). The
// locks in apply() make this rare; it still answers with the code the form knows.
function overInvoiceRace(error: unknown): unknown {
  if (isCheckViolation(error, 'invoices_paid_check')) {
    return new AppError(
      409,
      'receipt_over_invoice',
      'Another receipt paid one of these invoices first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'receipts_amount_check')) return overAllocatedError();
  return error;
}
