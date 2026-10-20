import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  type PartyRef,
  type SupplierRefund,
  type SupplierRefundInput,
  type SupplierRefundSource,
  type SupplierRefundStatus,
  type SupplierRefundSummary,
  unappliedOf,
  type VoidSupplierRefundInput,
} from '@omnivo/contracts';
import { debitNotes, parties, supplierPayments, supplierRefunds } from '@omnivo/db';
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
import { assertBranch, assertMoneyAccount } from '../sales/sales-lines.js';
import { PurchaseBooksService } from './purchase-books.service.js';
import { assertSupplier } from './purchase-lines.js';

type RefundRow = typeof supplierRefunds.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The source's number, read through two joins: one of them finds it
const sourcePayment = alias(supplierPayments, 'source_payment');
const sourceDebitNote = alias(debitNotes, 'source_debit_note');

// The money a refund takes back, as the check needs it: what was paid or debited, and what of it
// is used already
interface Source {
  number: string;
  amount: string;
  applied: string;
  refunded: string;
}

function toSummary(
  row: RefundRow,
  supplier: PartyRef,
  source: SupplierRefundSource,
): SupplierRefundSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    supplier,
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
    'supplier_refund_over_source',
    'This is more than the supplier still owes from it. Lower the amount.',
    { fieldErrors: { amount: ['supplier_refund_over_source'] } },
  );
}

// The database's last word (supplier_payments_amount_check, debit_notes_money_check), if two
// writers got past the lock on the source. Answers with the code the form knows.
function overSourceRace(error: unknown): unknown {
  if (
    isCheckViolation(error, 'supplier_payments_amount_check') ||
    isCheckViolation(error, 'debit_notes_money_check')
  ) {
    return overSourceError();
  }
  return error;
}

// Supplier refunds (step 17d): money a supplier paid back into a cash, bank or wallet account, out
// of a debit note's money or a payment's advance (decision 4). The customer's refund of 15d the
// other way round: saving one posts it at once (SRF-2026-27-0001 and its entry), and afterwards it
// can only be voided.
@Injectable()
export class SupplierRefundsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: PurchaseBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: SupplierRefundStatus | undefined;
    supplierId?: string | undefined;
  }): Promise<{ items: SupplierRefundSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(supplierRefunds.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(supplierRefunds.supplierId, query.supplierId),
          after === undefined
            ? undefined
            : sql`(${supplierRefunds.date}, ${supplierRefunds.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.refund.date, last.refund.id]);
      return {
        items: page.items.map((row) => toSummary(row.refund, row.supplier, sourceOf(row))),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<SupplierRefund> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: SupplierRefundInput): Promise<SupplierRefund> {
    try {
      return await this.withTenant(async (tx) => {
        const supplier = await assertSupplier(tx, input.supplierId);
        await assertBranch(tx, input.branchId, 'purchase_branch_invalid');
        await assertMoneyAccount(tx, input.accountId, 'supplier_refund_account_invalid');
        // Locked: a second refund of the same money, or applying it to a bill, waits for us
        const source = await this.lockSource(tx, supplier.id, input);
        if (compareMoney(input.amount, unappliedOf(source)) > 0) throw overSourceError();
        const number = await this.numbering.next(tx, 'purchase.refund', input.date);
        // Saved = posted: the trigger adds the amount to the source's `refunded` (migration 0042)
        const [row] = await tx
          .insert(supplierRefunds)
          .values({
            tenantId: getTenantId(),
            number,
            date: input.date,
            supplierId: supplier.id,
            amount: input.amount,
            accountId: input.accountId,
            method: input.method,
            reference: input.reference,
            branchId: input.branchId,
            note: input.note,
            debitNoteId: input.debitNoteId,
            paymentId: input.paymentId,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Supplier refund insert returned no row');
        // The journal checks the period of the date: a refund in a closed month is refused here
        const entry = await this.books.refund(
          tx,
          { id: row.id, number, date: row.date },
          {
            supplierId: supplier.id,
            branchId: row.branchId,
            accountId: row.accountId,
            amount: row.amount,
          },
        );
        await audit(tx, {
          action: 'supplier_refund.created',
          entityType: 'supplier_refund',
          entityId: row.id,
          changes: created({
            number,
            date: row.date,
            supplier: supplier.code,
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

  // A refund typed by mistake, or a cheque from the supplier that bounced: its entry is reversed
  // on the void date, and its money is the source's again (the trigger takes it off `refunded`).
  // The refund stays, voided, so its number is never reused or missing.
  void(id: string, input: VoidSupplierRefundInput): Promise<SupplierRefund> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (input.date < row.date) {
        throw new AppError(
          409,
          'payment_void_date',
          'A refund cannot be voided before the day it was received.',
          { fieldErrors: { date: ['payment_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id, 'purchase_refund');
      if (entry === null) throw new Error(`Supplier refund ${id} has no entry`);
      await tx
        .update(supplierRefunds)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${supplierRefunds.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(supplierRefunds.tenantId, getTenantId()), eq(supplierRefunds.id, id)));
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Supplier refund ${row.number} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'supplier_refund.voided',
        entityType: 'supplier_refund',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }

  // The debit note or payment the money comes from: posted, and this supplier's. FOR UPDATE, the
  // lock its own page takes to apply its money (and a payment's void), so they all take turns.
  // Another workspace's, another supplier's, a voided payment and a draft debit note all get the
  // same answer, under the box that named it.
  private async lockSource(
    tx: Transaction,
    supplierId: string,
    input: Pick<SupplierRefundInput, 'debitNoteId' | 'paymentId'>,
  ): Promise<Source> {
    const tenantId = getTenantId();
    const invalid = (field: 'debitNoteId' | 'paymentId') =>
      new AppError(
        409,
        'supplier_refund_source_invalid',
        'Pick a posted debit note or supplier payment of this supplier.',
        { fieldErrors: { [field]: ['supplier_refund_source_invalid'] } },
      );
    if (input.debitNoteId !== null) {
      const [row] = await tx
        .select()
        .from(debitNotes)
        .where(and(eq(debitNotes.tenantId, tenantId), eq(debitNotes.id, input.debitNoteId)))
        .for('update');
      if (row?.supplierId !== supplierId || row.status !== 'posted' || row.number === null) {
        throw invalid('debitNoteId');
      }
      return { ...row, number: row.number, amount: row.total };
    }
    if (input.paymentId !== null) {
      const [row] = await tx
        .select()
        .from(supplierPayments)
        .where(
          and(eq(supplierPayments.tenantId, tenantId), eq(supplierPayments.id, input.paymentId)),
        )
        .for('update');
      if (row?.supplierId !== supplierId || row.status !== 'posted' || row.number === null) {
        throw invalid('paymentId');
      }
      return { ...row, number: row.number };
    }
    // The contract makes sure one of the two is there (supplier_refund_source)
    throw new AppError(
      409,
      'supplier_refund_source',
      'Pick the debit note or payment the money comes back from.',
      { fieldErrors: { debitNoteId: ['supplier_refund_source'] } },
    );
  }

  // FOR UPDATE: two voids of one refund take turns. A voided refund is final.
  private async lock(tx: Transaction, id: string, version: number): Promise<RefundRow> {
    const [row] = await tx
      .select()
      .from(supplierRefunds)
      .where(and(eq(supplierRefunds.tenantId, getTenantId()), eq(supplierRefunds.id, id)))
      .for('update');
    if (!row) throw notFound('Supplier refund');
    if (row.status === 'voided') {
      throw new AppError(
        409,
        'supplier_refund_voided',
        'This refund is voided and cannot be changed.',
      );
    }
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        refund: supplierRefunds,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        paymentNumber: sourcePayment.number,
        debitNoteNumber: sourceDebitNote.number,
      })
      .from(supplierRefunds)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, supplierRefunds.tenantId),
          eq(parties.id, supplierRefunds.supplierId),
        ),
      )
      .leftJoin(
        sourcePayment,
        and(
          eq(sourcePayment.tenantId, supplierRefunds.tenantId),
          eq(sourcePayment.id, supplierRefunds.paymentId),
        ),
      )
      .leftJoin(
        sourceDebitNote,
        and(
          eq(sourceDebitNote.tenantId, supplierRefunds.tenantId),
          eq(sourceDebitNote.id, supplierRefunds.debitNoteId),
        ),
      )
      .where(and(eq(supplierRefunds.tenantId, getTenantId()), where))
      .orderBy(desc(supplierRefunds.date), desc(supplierRefunds.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<SupplierRefund> {
    const [found] = await this.rows(tx, eq(supplierRefunds.id, id), 1);
    if (!found) throw notFound('Supplier refund');
    const { refund: row } = found;
    const entry = await this.books.entryOf(tx, id, 'purchase_refund');
    if (entry === null) throw new Error(`Supplier refund ${id} has no entry`);
    const voidEntry = row.status === 'voided' ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(row, found.supplier, sourceOf(found)),
      note: row.note,
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
    };
  }
}

// Where a refund's money came from. supplier_refunds_source_check keeps exactly one of the two
// ids, and a refund is only made from a posted debit note or payment, which always has a number:
// anything else is a broken row.
function sourceOf(row: {
  refund: RefundRow;
  paymentNumber: string | null;
  debitNoteNumber: string | null;
}): SupplierRefundSource {
  if (row.refund.debitNoteId !== null && row.debitNoteNumber !== null) {
    return { type: 'debit_note', id: row.refund.debitNoteId, number: row.debitNoteNumber };
  }
  if (row.refund.paymentId !== null && row.paymentNumber !== null) {
    return { type: 'supplier_payment', id: row.refund.paymentId, number: row.paymentNumber };
  }
  throw new Error(`Supplier refund ${row.refund.id} has no source`);
}
