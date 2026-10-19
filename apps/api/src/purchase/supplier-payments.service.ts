import { Inject, Injectable } from '@nestjs/common';
import {
  billAmountDueOf,
  compareMoney,
  overAllocated,
  type PartyRef,
  type SupplierPayment,
  type SupplierPaymentInput,
  type SupplierPaymentStatus,
  type SupplierPaymentSummary,
  sumMoney,
  type UpdateSupplierPaymentInput,
  type VoidSupplierPaymentInput,
} from '@omnivo/contracts';
import {
  bills,
  parties,
  partyBankAccounts,
  purchaseOrders,
  supplierPaymentAllocations,
  supplierPayments,
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
import { type LineIssue, linesError } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { allocationChanges, allocationPath } from '../sales/allocations.js';
import { assertBranch, assertMoneyAccount, customerRefs } from '../sales/sales-lines.js';
import { ApprovalsService } from './approvals.service.js';
import { PurchaseBooksService } from './purchase-books.service.js';
import { assertSupplier } from './purchase-lines.js';

type PaymentRow = typeof supplierPayments.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

interface Allocation {
  billId: string;
  amount: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'This payment was submitted. Reopen it to change it, if it is not posted.',
  );
}

function wasSubmitted(): AppError {
  return new AppError(
    409,
    'purchase_was_submitted',
    'This payment was submitted once, so its number and approval history stay. Cancel it instead.',
  );
}

function notPosted(): AppError {
  return new AppError(
    409,
    'payment_not_posted',
    'Only a posted payment is applied again or voided. Change a draft with its form.',
  );
}

function overAllocatedError(): AppError {
  return new AppError(
    409,
    'payment_over_allocated',
    'More is applied than the payment paid. Lower the amounts on the bills.',
    { fieldErrors: { allocations: ['payment_over_allocated'] } },
  );
}

// The database's last word, if two writers got past the checks below: a bill paid past its total
// (bills_paid_check, two payments posted for its last money at the same moment), a payment applied
// past its amount (supplier_payments_amount_check), or money put on a bill that is not posted
// (supplier_payment_allocations_bill_check)
function paymentRace(error: unknown): unknown {
  if (isCheckViolation(error, 'bills_paid_check')) {
    return new AppError(
      409,
      'payment_over_bill',
      'Another payment paid one of these bills first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'supplier_payments_amount_check')) return overAllocatedError();
  if (isCheckViolation(error, 'supplier_payment_allocations_bill_check')) {
    return new AppError(409, 'payment_bill_invalid', 'Pick a posted bill of this supplier.');
  }
  return error;
}

function toSummary(
  row: PaymentRow,
  supplier: PartyRef,
  order: { id: string; number: string | null } | null,
): SupplierPaymentSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    supplier,
    amount: row.amount,
    applied: row.applied,
    method: row.method,
    reference: row.reference,
    accountId: row.accountId,
    branchId: row.branchId,
    order,
    status: row.status,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Supplier payments (step 17c): a money receipt the other way round, with the approval in the
// middle (decision 5). A draft's allocations are a plan (decision 23): they are rows, so the form
// and the list show what will be applied, but no bill counts them until the payment is posted. The
// last approval posts it (decision 7): its entry is booked and its plan lands on the bills. A
// posted payment is applied again or voided, never edited.
@Injectable()
export class SupplierPaymentsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
    private readonly books: PurchaseBooksService,
  ) {
    approvals.onApproved('supplier_payment', (tx, id) => this.post(tx, id));
  }

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: SupplierPaymentStatus | undefined;
    supplierId?: string | undefined;
    orderId?: string | undefined;
  }): Promise<{ items: SupplierPaymentSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(supplierPayments.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(supplierPayments.supplierId, query.supplierId),
          query.orderId === undefined ? undefined : eq(supplierPayments.orderId, query.orderId),
          after === undefined
            ? undefined
            : sql`(${supplierPayments.date}, ${supplierPayments.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.payment.date, last.payment.id]);
      return {
        items: page.items.map((row) => toSummary(row.payment, row.supplier, row.order)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<SupplierPayment> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: SupplierPaymentInput): Promise<SupplierPayment> {
    try {
      return await this.withTenant(async (tx) => {
        const supplier = await assertSupplier(tx, input.supplierId);
        await this.check(tx, supplier.id, input);
        const userId = currentPrincipal().userId;
        const [row] = await tx
          .insert(supplierPayments)
          .values({
            tenantId: getTenantId(),
            ...this.fields(supplier.id, input),
            createdBy: userId,
            updatedBy: userId,
          })
          .returning();
        if (!row) throw new Error('Supplier payment insert returned no row');
        await this.replaceAllocations(tx, row, input.allocations);
        await audit(tx, {
          action: 'supplier_payment.created',
          entityType: 'supplier_payment',
          entityId: row.id,
          changes: created(this.snapshot(row, supplier, input.allocations.length)),
        });
        if (input.submit) await this.submitLocked(tx, row);
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw paymentRace(error);
    }
  }

  async update(id: string, input: UpdateSupplierPaymentInput): Promise<SupplierPayment> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, input.version);
        const planBefore = await this.allocationsOf(tx, id);
        const supplierBefore = await this.supplierOf(tx, before.supplierId);
        const supplier = await assertSupplier(tx, input.supplierId, before.supplierId);
        // Numbered: the approvers saw it as a payment to this supplier
        if (before.number !== null && supplier.id !== before.supplierId) {
          throw new AppError(
            409,
            'purchase_supplier_invalid',
            'This payment was submitted for its supplier. Write a new payment for another one.',
            { fieldErrors: { supplierId: ['purchase_supplier_invalid'] } },
          );
        }
        await this.check(tx, supplier.id, input);
        // The plan first: a new supplier's key would refuse the old supplier's bills
        await this.replaceAllocations(tx, before, []);
        const [updated] = await tx
          .update(supplierPayments)
          .set({
            ...this.fields(supplier.id, input),
            version: sql`${supplierPayments.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)))
          .returning();
        if (!updated) throw notFound('Supplier payment');
        await this.replaceAllocations(tx, updated, input.allocations);
        await audit(tx, {
          action: 'supplier_payment.updated',
          entityType: 'supplier_payment',
          entityId: id,
          changes: diff(
            this.snapshot(before, supplierBefore, planBefore.length),
            this.snapshot(updated, supplier, input.allocations.length),
          ),
        });
        if (input.submit) await this.submitLocked(tx, updated);
        return this.read(tx, id);
      });
    } catch (error) {
      throw paymentRace(error);
    }
  }

  // Only a draft that was never submitted; its plan goes with it (ON DELETE CASCADE)
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, version);
        if (before.number !== null) throw wasSubmitted();
        const plan = await this.allocationsOf(tx, id);
        const supplier = await this.supplierOf(tx, before.supplierId);
        await tx
          .delete(supplierPayments)
          .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
        const snapshot = this.snapshot(before, supplier, plan.length);
        await audit(tx, {
          action: 'supplier_payment.deleted',
          entityType: 'supplier_payment',
          entityId: id,
          changes: diff(
            snapshot,
            Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
          ),
        });
      });
    } catch (error) {
      if (isCheckViolation(error, 'supplier_payments_submitted_immutable')) throw wasSubmitted();
      throw error;
    }
  }

  async submit(id: string, version: number): Promise<SupplierPayment> {
    try {
      return await this.withTenant(async (tx) => {
        const row = await this.lockDraft(tx, id, version);
        await this.submitLocked(tx, row);
        return this.read(tx, id);
      });
    } catch (error) {
      throw paymentRace(error);
    }
  }

  reopen(id: string, version: number): Promise<SupplierPayment> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'pending') {
        throw new AppError(
          409,
          'purchase_cannot_reopen',
          'Only a payment waiting for approval can be reopened.',
        );
      }
      await this.approvals.reopen(tx, 'supplier_payment', id, 'pending');
      return this.read(tx, id);
    });
  }

  // Will not be paid: a numbered draft, or a pending payment reopened first in the same transaction
  // (decision 31). Its plan stays as history; the database freezes it.
  cancel(id: string, version: number): Promise<SupplierPayment> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft' && row.status !== 'pending') {
        throw new AppError(
          409,
          'purchase_cannot_cancel',
          'A posted payment is not cancelled. Void it instead.',
        );
      }
      if (row.number === null) {
        throw new AppError(
          409,
          'purchase_delete_instead',
          'This payment was never submitted. Delete it instead.',
        );
      }
      if (row.status === 'pending') {
        await this.approvals.reopen(tx, 'supplier_payment', id, 'pending');
      }
      await tx
        .update(supplierPayments)
        .set({
          status: 'cancelled',
          version: sql`${supplierPayments.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
      await audit(tx, {
        action: 'supplier_payment.cancelled',
        entityType: 'supplier_payment',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'cancelled' }),
      });
      return this.read(tx, id);
    });
  }

  // A posted payment's money on other bills: an advance applied to the bill that came, or moved
  // from one bill to another (decision 23). No approval: the money left already, and only which
  // bill it settles changes. Nothing in the books changes either: the payable is one number per
  // supplier.
  async allocate(
    id: string,
    input: { version: number; allocations: readonly Allocation[] },
  ): Promise<SupplierPayment> {
    try {
      return await this.withTenant(async (tx) => {
        const row = await this.lock(tx, id, input.version);
        if (row.status !== 'posted') throw notPosted();
        if (overAllocated(row.amount, input.allocations)) throw overAllocatedError();
        const before = await this.allocationsOf(tx, id);
        await checkBillAllocations(tx, {
          supplierId: row.supplierId,
          current: before,
          wanted: input.allocations,
        });
        await this.replaceAllocations(tx, row, input.allocations);
        await tx
          .update(supplierPayments)
          .set({
            version: sql`${supplierPayments.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
        await audit(tx, {
          action: 'supplier_payment.allocated',
          entityType: 'supplier_payment',
          entityId: id,
          changes: allocationChanges(
            before.map(asInvoiceNumber),
            (await this.allocationsOf(tx, id)).map(asInvoiceNumber),
          ),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw paymentRace(error);
    }
  }

  // A bounced cheque or a payment typed by mistake: its money comes off the bills, and its entry is
  // reversed on the void date. The payment stays, voided, with its number.
  void(id: string, input: VoidSupplierPaymentInput): Promise<SupplierPayment> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, input.version);
      if (row.status !== 'posted') throw notPosted();
      if (input.date < row.date) {
        throw new AppError(
          409,
          'payment_void_date',
          'A payment cannot be voided before the day it was paid.',
          { fieldErrors: { date: ['payment_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id, 'purchase_payment');
      if (entry === null) throw new Error(`Supplier payment ${id} has no entry`);
      // The allocations first: the database lets a payment be voided only once nothing of it is
      // applied (supplier_payments_void_check). Their trigger takes the money off the bills.
      const before = await this.allocationsOf(tx, id);
      await checkBillAllocations(tx, { supplierId: row.supplierId, current: before, wanted: [] });
      await this.replaceAllocations(tx, row, []);
      await tx
        .update(supplierPayments)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${supplierPayments.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Payment ${row.number ?? ''} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'supplier_payment.voided',
        entityType: 'supplier_payment',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }

  // Numbered the first time, checked again as it stands now, then handed to the engine with its
  // amount. With no level for it, the engine posts it at once (post() below).
  private async submitLocked(tx: Transaction, row: PaymentRow): Promise<void> {
    await this.recheck(tx, row);
    if (row.number === null) {
      await tx
        .update(supplierPayments)
        .set({ number: await this.numbering.next(tx, 'purchase.payment', row.date) })
        .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, row.id)));
    }
    await this.approvals.submit(tx, 'supplier_payment', row.id, row.amount);
  }

  // The stored payment against what is true now: an active supplier, branch and money account,
  // and a plan that still fits what each bill owes. The bills are locked (checkBillAllocations),
  // so at posting a second payment for the same bills waits, then sees what this one paid.
  private async recheck(tx: Transaction, row: PaymentRow): Promise<void> {
    await assertSupplier(tx, row.supplierId);
    await assertBranch(tx, row.branchId, 'purchase_branch_invalid');
    await assertMoneyAccount(tx, row.accountId, 'payment_account_invalid');
    // A draft's plan is not on the bills yet, so nothing of it counts as owed again
    await checkBillAllocations(tx, {
      supplierId: row.supplierId,
      current: [],
      wanted: await this.allocationsOf(tx, row.id),
    });
  }

  // Posting (decision 7), called by the approvals engine. The payment is locked and pending, its
  // round approved. The entry first (a closed period refuses there), then the status: posting adds
  // the plan to the bills in one trigger (supplier_payments_post), in bill id order.
  private async post(tx: Transaction, id: string): Promise<void> {
    try {
      const [row] = await tx
        .select()
        .from(supplierPayments)
        .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
      if (row?.status !== 'pending' || row.number === null) {
        throw new Error(`Supplier payment ${id} is not a numbered pending payment`);
      }
      await this.recheck(tx, row);
      const entry = await this.books.payment(
        tx,
        { id, number: row.number, date: row.date },
        {
          supplierId: row.supplierId,
          branchId: row.branchId,
          accountId: row.accountId,
          amount: row.amount,
        },
      );
      await tx
        .update(supplierPayments)
        .set({
          status: 'posted',
          postedAt: new Date(),
          postedBy: currentPrincipal().userId,
          version: sql`${supplierPayments.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
      await audit(tx, {
        action: 'supplier_payment.posted',
        entityType: 'supplier_payment',
        entityId: id,
        changes: created({ number: row.number, entry: entry.number }),
      });
    } catch (error) {
      throw paymentRace(error);
    }
  }

  // Every rule of a save the contract cannot check: the branch, the money account, the supplier's
  // own bank account, the order an advance names, and a plan of the supplier's posted bills that
  // fits what each still owes. The plan holds nothing (decision 23): it is checked again when the
  // payment is submitted and posted.
  private async check(
    tx: Transaction,
    supplierId: string,
    input: SupplierPaymentInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    await assertBranch(tx, input.branchId, 'purchase_branch_invalid');
    await assertMoneyAccount(tx, input.accountId, 'payment_account_invalid');
    if (input.supplierBankAccountId !== null) {
      // FOR SHARE: the supplier's form removing this account waits until we commit (and then the
      // database clears our link, decision 33)
      const [account] = await tx
        .select({ id: partyBankAccounts.id })
        .from(partyBankAccounts)
        .where(
          and(
            eq(partyBankAccounts.tenantId, tenantId),
            eq(partyBankAccounts.id, input.supplierBankAccountId),
            eq(partyBankAccounts.partyId, supplierId),
          ),
        )
        .for('share');
      if (!account) {
        throw new AppError(
          409,
          'payment_bank_account_invalid',
          "Pick one of this supplier's bank accounts.",
          { fieldErrors: { supplierBankAccountId: ['payment_bank_account_invalid'] } },
        );
      }
    }
    if (input.orderId !== null) {
      // An advance is paid against an order the company agreed to (decision 12)
      const [order] = await tx
        .select({ status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, tenantId),
            eq(purchaseOrders.id, input.orderId),
            eq(purchaseOrders.supplierId, supplierId),
          ),
        );
      if (!order || !['approved', 'received', 'closed'].includes(order.status)) {
        throw new AppError(
          409,
          'payment_order_invalid',
          'Pick an approved purchase order of this supplier.',
          { fieldErrors: { orderId: ['payment_order_invalid'] } },
        );
      }
    }
    await checkBillAllocations(tx, { supplierId, current: [], wanted: input.allocations });
  }

  private fields(supplierId: string, input: SupplierPaymentInput) {
    return {
      date: input.date,
      supplierId,
      amount: input.amount,
      accountId: input.accountId,
      method: input.method,
      reference: input.reference,
      supplierBankAccountId: input.supplierBankAccountId,
      branchId: input.branchId,
      orderId: input.orderId,
      note: input.note,
    };
  }

  // Replaces the payment's rows: a draft's plan on every save, a posted payment's money when it is
  // applied again or voided. amount_paid and applied are not written here: the allocations'
  // trigger keeps them, and moves a bill only for a posted payment (migration 0040).
  private async replaceAllocations(
    tx: Transaction,
    payment: PaymentRow,
    wanted: readonly Allocation[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(supplierPaymentAllocations)
      .where(
        and(
          eq(supplierPaymentAllocations.tenantId, tenantId),
          eq(supplierPaymentAllocations.paymentId, payment.id),
        ),
      );
    if (wanted.length === 0) return;
    await tx.insert(supplierPaymentAllocations).values(
      wanted.map((allocation) => ({
        tenantId,
        paymentId: payment.id,
        supplierId: payment.supplierId,
        billId: allocation.billId,
        amount: allocation.amount,
      })),
    );
  }

  // FOR UPDATE: every change to a payment takes turns with the others and with an approval
  private async lock(tx: Transaction, id: string, version: number): Promise<PaymentRow> {
    const [row] = await tx
      .select()
      .from(supplierPayments)
      .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)))
      .for('update');
    if (!row) throw notFound('Supplier payment');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<PaymentRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'draft') throw notDraft();
    return row;
  }

  // The bills it pays (or plans to), oldest due date first: the order the form suggested them in
  private allocationsOf(tx: Transaction, paymentId: string) {
    return tx
      .select({
        billId: bills.id,
        billNumber: bills.number,
        supplierBillNumber: bills.supplierBillNumber,
        billDate: bills.date,
        dueDate: bills.dueDate,
        billTotal: bills.total,
        amount: supplierPaymentAllocations.amount,
      })
      .from(supplierPaymentAllocations)
      .innerJoin(
        bills,
        and(
          eq(bills.tenantId, supplierPaymentAllocations.tenantId),
          eq(bills.id, supplierPaymentAllocations.billId),
        ),
      )
      .where(
        and(
          eq(supplierPaymentAllocations.tenantId, getTenantId()),
          eq(supplierPaymentAllocations.paymentId, paymentId),
        ),
      )
      .orderBy(asc(bills.dueDate), asc(bills.id));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        payment: supplierPayments,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        order: { id: purchaseOrders.id, number: purchaseOrders.number },
      })
      .from(supplierPayments)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, supplierPayments.tenantId),
          eq(parties.id, supplierPayments.supplierId),
        ),
      )
      .leftJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, supplierPayments.tenantId),
          eq(purchaseOrders.id, supplierPayments.orderId),
        ),
      )
      .where(and(eq(supplierPayments.tenantId, getTenantId()), where))
      .orderBy(desc(supplierPayments.date), desc(supplierPayments.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<SupplierPayment> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(supplierPayments.id, id), 1);
    if (!found) throw notFound('Supplier payment');
    const { payment: row } = found;
    const [allocations, bankAccount, entry, approval] = await Promise.all([
      this.allocationsOf(tx, id),
      row.supplierBankAccountId === null
        ? []
        : tx
            .select({
              id: partyBankAccounts.id,
              bankName: partyBankAccounts.bankName,
              branchName: partyBankAccounts.branchName,
              accountName: partyBankAccounts.accountName,
              accountNumber: partyBankAccounts.accountNumber,
              routingNumber: partyBankAccounts.routingNumber,
            })
            .from(partyBankAccounts)
            .where(
              and(
                eq(partyBankAccounts.tenantId, tenantId),
                eq(partyBankAccounts.id, row.supplierBankAccountId),
              ),
            ),
      row.status === 'posted' || row.status === 'voided'
        ? this.books.entryOf(tx, id, 'purchase_payment')
        : null,
      this.approvals.history(tx, 'supplier_payment', id),
    ]);
    const voidEntry =
      row.status === 'voided' && entry !== null ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(row, found.supplier, found.order),
      note: row.note,
      supplierBankAccount: bankAccount[0] ?? null,
      // Money is applied only to posted bills, so each has a number
      allocations: allocations.flatMap((allocation) =>
        allocation.billNumber === null
          ? []
          : [{ ...allocation, billNumber: allocation.billNumber }],
      ),
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
      approval,
    };
  }

  private async supplierOf(tx: Transaction, supplierId: string): Promise<PartyRef> {
    const supplier = (await customerRefs(tx, [supplierId])).get(supplierId);
    if (!supplier) throw new Error(`Supplier ${supplierId} is missing`);
    return supplier;
  }

  // What the audit log shows
  private snapshot(row: PaymentRow, supplier: PartyRef, bills: number) {
    return {
      number: row.number,
      date: row.date,
      supplier: supplier.code,
      amount: row.amount,
      method: row.method,
      reference: row.reference,
      bills,
    };
  }
}

// allocationChanges() (step 15c) names each row by its invoice number; a bill's number takes that
// place in the audit log
function asInvoiceNumber(allocation: { billNumber: string | null; amount: string }) {
  return { invoiceNumber: allocation.billNumber, amount: allocation.amount };
}

// Checks `wanted` before it replaces `current` (the payment's rows that bills count now: a posted
// payment's; a draft's plan counts on no bill, so it passes none). Every bill of both lists is
// locked FOR NO KEY UPDATE in id order before anything is read, like the invoices of a receipt
// (allocations.ts): two payments for one bill take turns, and the second sees what the first paid.
// Each wanted row must name a posted bill of the supplier and fit what it still owes, where this
// payment's own current row counts as owed again. All problems at once, each under its row.
async function checkBillAllocations(
  tx: Transaction,
  input: {
    supplierId: string;
    current: readonly Allocation[];
    wanted: readonly Allocation[];
  },
): Promise<void> {
  const billIds = [
    ...new Set([...input.current, ...input.wanted].map((allocation) => allocation.billId)),
  ];
  const rows =
    billIds.length === 0
      ? []
      : await tx
          .select({
            id: bills.id,
            supplierId: bills.supplierId,
            status: bills.status,
            total: bills.total,
            amountPaid: bills.amountPaid,
          })
          .from(bills)
          .where(and(eq(bills.tenantId, getTenantId()), inArray(bills.id, billIds)))
          .orderBy(asc(bills.id))
          .for('no key update');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const had = new Map(input.current.map((allocation) => [allocation.billId, allocation.amount]));
  const issues: LineIssue[] = [];
  input.wanted.forEach((allocation, index) => {
    const bill = byId.get(allocation.billId);
    if (bill?.supplierId !== input.supplierId || bill.status !== 'posted') {
      issues.push({ path: allocationPath(index, 'billId'), code: 'payment_bill_invalid' });
      return;
    }
    const due = sumMoney([billAmountDueOf(bill), had.get(allocation.billId) ?? '0']);
    if (compareMoney(allocation.amount, due) > 0) {
      issues.push({ path: allocationPath(index, 'amount'), code: 'payment_over_bill' });
    }
  });
  if (issues.length > 0) throw linesError(issues);
}
