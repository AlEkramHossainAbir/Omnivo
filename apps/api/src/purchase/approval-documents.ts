import type { ApprovalDocument, AuditEntityType } from '@omnivo/contracts';
import {
  bills,
  parties,
  purchaseOrders,
  requisitions,
  supplierPayments,
  warehouses,
} from '@omnivo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What the approvals engine needs from each kind of document, so one engine serves them all
// (decision 16). The engine never writes a document's own columns except its status, and only
// through setStatus(). The purchase order is the second kind (17b); the bill and the supplier
// payment are the third and fourth (17c). The `satisfies` below does not compile until every kind
// in APPROVAL_DOCUMENTS has its entry.

// The statuses the engine moves a document between. Every kind has these three, whatever it calls
// its others (a requisition's cancelled, an order's received).
export type ApprovalStatus = 'draft' | 'pending' | 'approved';

// A document as the waiting list and the bell show it
export interface ApprovalSubject {
  number: string;
  date: string;
  // The warehouse of a requisition, the supplier of an order, a bill or a payment
  subject: string;
}

export interface ApprovalTarget {
  entityType: AuditEntityType;
  // Step 17c: true = the last approval posts the document (decision 7). The engine then calls the
  // poster its service registered (ApprovalsService.onApproved), never setStatus(…, 'approved'):
  // posting books an entry, which needs the document's own services.
  postsOnApproval: boolean;
  // FOR UPDATE: the document first, then its round. Every path that changes a round (submit,
  // reopen, approve, reject) locks in this order, so two of them never deadlock.
  lock(tx: Transaction, id: string): Promise<{ status: string } | null>;
  setStatus(tx: Transaction, id: string, status: ApprovalStatus): Promise<void>;
  describe(tx: Transaction, ids: readonly string[]): Promise<Map<string, ApprovalSubject>>;
}

const requisition: ApprovalTarget = {
  entityType: 'requisition',
  postsOnApproval: false,
  async lock(tx, id) {
    const [row] = await tx
      .select({ status: requisitions.status })
      .from(requisitions)
      .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)))
      .for('update');
    return row ?? null;
  },
  // A status change is a change of the document: its version moves, so a page opened before an
  // approval cannot then save or reopen it from what it showed
  async setStatus(tx, id, status) {
    await tx
      .update(requisitions)
      .set({
        status,
        version: sql`${requisitions.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(requisitions.tenantId, getTenantId()), eq(requisitions.id, id)));
  },
  async describe(tx, ids) {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: requisitions.id,
        number: requisitions.number,
        date: requisitions.date,
        subject: warehouses.name,
      })
      .from(requisitions)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, requisitions.tenantId),
          eq(warehouses.id, requisitions.warehouseId),
        ),
      )
      .where(and(eq(requisitions.tenantId, getTenantId()), inArray(requisitions.id, [...ids])));
    return new Map(rows.map(({ id, ...row }) => [id, row]));
  },
};

// Step 17b: a purchase order is the requisition's twin, with its supplier as the subject: the
// approver asks "from whom?" before "for which warehouse?"
const purchaseOrder: ApprovalTarget = {
  entityType: 'purchase_order',
  postsOnApproval: false,
  async lock(tx, id) {
    const [row] = await tx
      .select({ status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)))
      .for('update');
    return row ?? null;
  },
  async setStatus(tx, id, status) {
    await tx
      .update(purchaseOrders)
      .set({
        status,
        version: sql`${purchaseOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
  },
  async describe(tx, ids) {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        date: purchaseOrders.date,
        subject: parties.name,
      })
      .from(purchaseOrders)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, purchaseOrders.tenantId),
          eq(parties.id, purchaseOrders.supplierId),
        ),
      )
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), inArray(purchaseOrders.id, [...ids])));
    // An order is numbered before its first round (PurchaseOrdersService.submit), so every order
    // the engine asks about has one; flatMap only satisfies the nullable column
    return new Map(
      rows.flatMap(({ id, number, ...row }) => (number === null ? [] : [[id, { number, ...row }]])),
    );
  },
};

// Step 17c: "approved" is never a bill's or a payment's status: the last approval posts it
function postedByItsService(document: string): never {
  throw new Error(
    `A ${document} is posted by its own service when it is approved, not set approved`,
  );
}

// Step 17c: a supplier's bill, with its supplier as the subject, like an order
const bill: ApprovalTarget = {
  entityType: 'bill',
  postsOnApproval: true,
  async lock(tx, id) {
    const [row] = await tx
      .select({ status: bills.status })
      .from(bills)
      .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, id)))
      .for('update');
    return row ?? null;
  },
  async setStatus(tx, id, status) {
    if (status === 'approved') postedByItsService('bill');
    await tx
      .update(bills)
      .set({ status, version: sql`${bills.version} + 1`, updatedBy: currentPrincipal().userId })
      .where(and(eq(bills.tenantId, getTenantId()), eq(bills.id, id)));
  },
  async describe(tx, ids) {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: bills.id, number: bills.number, date: bills.date, subject: parties.name })
      .from(bills)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, bills.tenantId), eq(parties.id, bills.supplierId)),
      )
      .where(and(eq(bills.tenantId, getTenantId()), inArray(bills.id, [...ids])));
    // Numbered before its first round (BillsService.submit), like an order
    return new Map(
      rows.flatMap(({ id, number, ...row }) => (number === null ? [] : [[id, { number, ...row }]])),
    );
  },
};

// Step 17c: a supplier payment, the bill's twin
const supplierPayment: ApprovalTarget = {
  entityType: 'supplier_payment',
  postsOnApproval: true,
  async lock(tx, id) {
    const [row] = await tx
      .select({ status: supplierPayments.status })
      .from(supplierPayments)
      .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)))
      .for('update');
    return row ?? null;
  },
  async setStatus(tx, id, status) {
    if (status === 'approved') postedByItsService('supplier payment');
    await tx
      .update(supplierPayments)
      .set({
        status,
        version: sql`${supplierPayments.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)));
  },
  async describe(tx, ids) {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: supplierPayments.id,
        number: supplierPayments.number,
        date: supplierPayments.date,
        subject: parties.name,
      })
      .from(supplierPayments)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, supplierPayments.tenantId),
          eq(parties.id, supplierPayments.supplierId),
        ),
      )
      .where(
        and(eq(supplierPayments.tenantId, getTenantId()), inArray(supplierPayments.id, [...ids])),
      );
    return new Map(
      rows.flatMap(({ id, number, ...row }) => (number === null ? [] : [[id, { number, ...row }]])),
    );
  },
};

export const APPROVAL_TARGETS = {
  requisition,
  purchase_order: purchaseOrder,
  bill,
  supplier_payment: supplierPayment,
} satisfies Record<ApprovalDocument, ApprovalTarget>;
