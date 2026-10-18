import type { ApprovalDocument, AuditEntityType } from '@omnivo/contracts';
import { requisitions, warehouses } from '@omnivo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What the approvals engine needs from each kind of document, so one engine serves them all
// (decision 16). The engine never writes a document's own columns except its status, and only
// through setStatus(). 17b adds the purchase order here, 17c the bill and the payment; the
// `satisfies` below does not compile until every kind in APPROVAL_DOCUMENTS has its entry.

// The statuses the engine moves a document between. Every kind has these three, whatever it calls
// its others (a requisition's cancelled, an order's received).
export type ApprovalStatus = 'draft' | 'pending' | 'approved';

// A document as the waiting list and the bell show it
export interface ApprovalSubject {
  number: string;
  date: string;
  // The warehouse of a requisition, the supplier of an order
  subject: string;
}

export interface ApprovalTarget {
  entityType: AuditEntityType;
  // FOR UPDATE: the document first, then its round. Every path that changes a round (submit,
  // reopen, approve, reject) locks in this order, so two of them never deadlock.
  lock(tx: Transaction, id: string): Promise<{ status: string } | null>;
  setStatus(tx: Transaction, id: string, status: ApprovalStatus): Promise<void>;
  describe(tx: Transaction, ids: readonly string[]): Promise<Map<string, ApprovalSubject>>;
}

const requisition: ApprovalTarget = {
  entityType: 'requisition',
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

export const APPROVAL_TARGETS = { requisition } satisfies Record<ApprovalDocument, ApprovalTarget>;
