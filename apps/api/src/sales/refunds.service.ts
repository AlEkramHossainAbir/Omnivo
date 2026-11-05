import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  type PartyRef,
  type Refund,
  type RefundInput,
  type RefundSource,
  type RefundStatus,
  type RefundSummary,
  unappliedOf,
  type VoidRefundInput,
} from '@omnivo/contracts';
import { creditNotes, parties, receipts, refunds } from '@omnivo/db';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { SalesBooksService } from './sales-books.service.js';
import { assertBranch, assertCustomer, assertMoneyAccount } from './sales-lines.js';

type RefundRow = typeof refunds.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The source's number, read through two joins: one of them finds it
const sourceReceipt = alias(receipts, 'source_receipt');
const sourceCreditNote = alias(creditNotes, 'source_credit_note');

// The money a refund pays back, as the check needs it: what came in or was credited, and what of
// it is used already
interface Source {
  number: string;
  amount: string;
  applied: string;
  refunded: string;
}

function toSummary(row: RefundRow, customer: PartyRef, source: RefundSource): RefundSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    amount: row.amount,
    method: row.method,
    reference: row.reference,
    accountId: row.accountId,
    branchId: row.branchId,
    source,
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function overSourceError(): AppError {
  return new AppError(
    409,
    'refund_over_source',
    'This is more than is left to pay back. Lower the amount.',
    { fieldErrors: { amount: ['refund_over_source'] } },
  );
}

// The database's last word (receipts_amount_check, credit_notes_money_check), if two writers got
// past the lock on the source. Answers with the code the form knows.
function overSourceRace(error: unknown): unknown {
  if (
    isCheckViolation(error, 'receipts_amount_check') ||
    isCheckViolation(error, 'credit_notes_money_check')
  ) {
    return overSourceError();
  }
  return error;
}

// Refunds (step 15d): a customer's advance paid back out of a cash, bank or wallet account. Saving
// one posts it at once, like a money receipt: it gets its number (RF-2026-27-0001) and its entry.
// Afterwards it can only be voided.
@Injectable()
export class RefundsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: SalesBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: RefundStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: RefundSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(refunds.status, query.status),
          query.customerId === undefined ? undefined : eq(refunds.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${refunds.date}, ${refunds.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.refund.date, last.refund.id]);
      return {
        items: page.items.map((row) => toSummary(row.refund, row.customer, sourceOf(row))),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Refund> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: RefundInput): Promise<Refund> {
    try {
      return await this.withTenant(async (tx) => {
        const customer = await assertCustomer(tx, input.customerId);
        await assertBranch(tx, input.branchId);
        await assertMoneyAccount(tx, input.accountId, 'refund_account_invalid');
        // Locked: a second refund of the same money, or applying it to an invoice, waits for us
        const source = await this.lockSource(tx, customer.id, input);
        if (compareMoney(input.amount, unappliedOf(source)) > 0) throw overSourceError();
        const number = await this.numbering.next(tx, 'sales.refund', input.date);
        // Saved = posted: the trigger adds the amount to the source's `refunded` (migration 0032)
        const [row] = await tx
          .insert(refunds)
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
            receiptId: input.receiptId,
            creditNoteId: input.creditNoteId,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Refund insert returned no row');
        // The journal checks the period of the date: a refund in a closed month is refused here
        const entry = await this.books.refund(
          tx,
          { id: row.id, number, date: row.date },
          {
            customerId: customer.id,
            branchId: row.branchId,
            accountId: row.accountId,
            amount: row.amount,
          },
        );
        await audit(tx, {
          action: 'refund.created',
          entityType: 'refund',
          entityId: row.id,
          changes: created({
            number,
            date: row.date,
            customer: customer.code,
            amount: row.amount,
            method: row.method,
            source: source.number,
            entry: entry.number,
          }),
        });
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw overSourceRace(error);
    }
  }

  // A refund typed by mistake, or money that never reached the customer: its entry is reversed on
  // the void date, and its money is the source's advance again (the trigger takes it off
  // `refunded`). The refund stays, voided, so its number is never reused or missing.
  void(id: string, input: VoidRefundInput): Promise<Refund> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (input.date < row.date) {
        throw new AppError(
          409,
          'receipt_void_date',
          'A refund cannot be voided before the day it was paid.',
          { fieldErrors: { date: ['receipt_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id, 'sales_refund');
      if (entry === null) throw new Error(`Refund ${id} has no entry`);
      await tx
        .update(refunds)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${refunds.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(refunds.tenantId, getTenantId()), eq(refunds.id, id)));
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Refund ${row.number} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'refund.voided',
        entityType: 'refund',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }

  // The receipt or credit note the money comes from: posted, and this customer's. FOR UPDATE, the
  // lock its own page takes to apply its money (and a receipt's void), so they all take turns.
  // Another workspace's, another customer's, a voided receipt and a draft credit note all get the
  // same answer, under the box that named it.
  private async lockSource(
    tx: Transaction,
    customerId: string,
    input: Pick<RefundInput, 'receiptId' | 'creditNoteId'>,
  ): Promise<Source> {
    const tenantId = getTenantId();
    const invalid = (field: 'receiptId' | 'creditNoteId') =>
      new AppError(409, 'refund_source_invalid', 'Pick a posted receipt or credit note.', {
        fieldErrors: { [field]: ['refund_source_invalid'] },
      });
    if (input.receiptId !== null) {
      const [row] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, input.receiptId)))
        .for('update');
      if (row?.customerId !== customerId || row.status !== 'posted') throw invalid('receiptId');
      return row;
    }
    if (input.creditNoteId !== null) {
      const [row] = await tx
        .select()
        .from(creditNotes)
        .where(and(eq(creditNotes.tenantId, tenantId), eq(creditNotes.id, input.creditNoteId)))
        .for('update');
      if (row?.customerId !== customerId || row.status !== 'posted' || row.number === null) {
        throw invalid('creditNoteId');
      }
      return { ...row, number: row.number, amount: row.total };
    }
    // The contract makes sure one of the two is there (refund_source)
    throw new AppError(409, 'refund_source', 'Pick the receipt or credit note to pay back from.', {
      fieldErrors: { receiptId: ['refund_source'] },
    });
  }

  // FOR UPDATE: two voids of one refund take turns. A voided refund is final.
  private async lock(tx: Transaction, id: string, version: number): Promise<RefundRow> {
    const [row] = await tx
      .select()
      .from(refunds)
      .where(and(eq(refunds.tenantId, getTenantId()), eq(refunds.id, id)))
      .for('update');
    if (!row) throw notFound('Refund');
    if (row.status === 'voided') {
      throw new AppError(409, 'refund_voided', 'This refund is voided and cannot be changed.');
    }
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        refund: refunds,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        receiptNumber: sourceReceipt.number,
        creditNoteNumber: sourceCreditNote.number,
      })
      .from(refunds)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, refunds.tenantId), eq(parties.id, refunds.customerId)),
      )
      .leftJoin(
        sourceReceipt,
        and(eq(sourceReceipt.tenantId, refunds.tenantId), eq(sourceReceipt.id, refunds.receiptId)),
      )
      .leftJoin(
        sourceCreditNote,
        and(
          eq(sourceCreditNote.tenantId, refunds.tenantId),
          eq(sourceCreditNote.id, refunds.creditNoteId),
        ),
      )
      .where(and(eq(refunds.tenantId, getTenantId()), where))
      .orderBy(desc(refunds.date), desc(refunds.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Refund> {
    const [found] = await this.rows(tx, eq(refunds.id, id), 1);
    if (!found) throw notFound('Refund');
    const { refund: row } = found;
    const entry = await this.books.entryOf(tx, id, 'sales_refund');
    if (entry === null) throw new Error(`Refund ${id} has no entry`);
    const voidEntry = row.status === 'voided' ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(row, found.customer, sourceOf(found)),
      note: row.note,
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
    };
  }
}

// Where a refund's money came from. refunds_source_check keeps exactly one of the two ids, and a
// refund is only made from a posted receipt or credit note, which always has a number: anything
// else is a broken row.
function sourceOf(row: {
  refund: RefundRow;
  receiptNumber: string | null;
  creditNoteNumber: string | null;
}): RefundSource {
  if (row.refund.receiptId !== null && row.receiptNumber !== null) {
    return { type: 'receipt', id: row.refund.receiptId, number: row.receiptNumber };
  }
  if (row.refund.creditNoteId !== null && row.creditNoteNumber !== null) {
    return { type: 'credit_note', id: row.refund.creditNoteId, number: row.creditNoteNumber };
  }
  throw new Error(`Refund ${row.refund.id} has no source`);
}
