import { Inject, Injectable } from '@nestjs/common';
import {
  overAllocated,
  type PartyRef,
  type Receipt,
  type ReceiptInput,
  type ReceiptStatus,
  type ReceiptSummary,
  subtractMoney,
  type VoidReceiptInput,
} from '@omnivo/contracts';
import { invoices, parties, receiptAllocations, receipts, refunds } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { type Allocation, allocationChanges, checkAllocations } from './allocations.js';
import { SalesBooksService } from './sales-books.service.js';
import { assertBranch, assertCustomer, assertMoneyAccount } from './sales-lines.js';

type ReceiptRow = typeof receipts.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

function toSummary(row: ReceiptRow, customer: PartyRef): ReceiptSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    amount: row.amount,
    applied: row.applied,
    refunded: row.refunded,
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

// Step 15d: a refund paid some of its money back. Voiding the receipt would leave that money paid
// out of nowhere, so the refund is voided first (the database's receipts_void_check agrees).
function hasRefundsError(): AppError {
  return new AppError(
    409,
    'receipt_has_refunds',
    'Some of this money was paid back to the customer. Void the refund first.',
  );
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
        await assertMoneyAccount(tx, input.accountId, 'receipt_account_invalid');
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
        // What refunds paid back (step 15d) is gone: only the rest can be applied
        if (overAllocated(subtractMoney(row.amount, row.refunded), input.allocations)) {
          throw overAllocatedError();
        }
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
          changes: allocationChanges(before, await this.allocationsOf(tx, id)),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw overInvoiceRace(error);
    }
  }

  // A bounced cheque or a receipt typed by mistake: its money comes off the invoices, and its entry
  // is reversed on the void date. The receipt stays, voided, so its number is never reused or
  // missing from the series. Not while a posted refund pays some of it back (step 15d).
  void(id: string, input: VoidReceiptInput): Promise<Receipt> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      // The lock on the receipt makes a new refund of it wait (RefundsService locks it too), so
      // what this finds is what there is. The database's receipts_void_check is the last word.
      const [refund] = await tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(
          and(
            eq(refunds.tenantId, getTenantId()),
            eq(refunds.receiptId, id),
            eq(refunds.status, 'posted'),
          ),
        )
        .limit(1);
      if (refund) throw hasRefundsError();
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

  // Replaces the receipt's allocations with `wanted`, once checkAllocations() has locked every
  // invoice involved and checked each row (step 15d moved that check to allocations.ts, for the
  // credit notes too). amount_paid and applied are not written here: the allocations' trigger keeps
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
    await checkAllocations(tx, {
      customerId: receipt.customerId,
      current,
      wanted,
      errors: { invoice: 'receipt_invoice_invalid', over: 'receipt_over_invoice' },
    });
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
}

// The database's last word, if two writers got past the checks above: an invoice settled past its
// total by receipts and credit notes together (invoices_paid_check), or a receipt applied and paid
// back past its amount (receipts_amount_check). The locks in apply() make this rare; it still
// answers with the code the form knows.
function overInvoiceRace(error: unknown): unknown {
  if (isCheckViolation(error, 'invoices_paid_check')) {
    return new AppError(
      409,
      'receipt_over_invoice',
      'Another receipt or a credit note settled one of these invoices first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'receipts_amount_check')) return overAllocatedError();
  return error;
}
