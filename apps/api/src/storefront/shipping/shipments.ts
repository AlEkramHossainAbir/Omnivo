import {
  COURIER_EXPORT_MAX_ROWS,
  type CourierChoices,
  type CourierExport,
  isErrorCode,
  isOpenShipment,
  OPEN_SHIPMENT_STATUSES,
  type ShopShipmentStatus,
  type StorefrontShipment,
} from '@omnivo/contracts';
import {
  courierAccounts,
  storefrontOrders,
  storefrontPayments,
  storefrontShipmentEvents,
  storefrontShipments,
} from '@omnivo/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created } from '../../common/audit/audit.js';
import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound } from '../../common/http/app-error.js';
import { emit } from '../../common/outbox/outbox.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { eventKeyOf } from '../../shipping/courier.js';
import { codAmountOf, type OrderRow } from '../orders/order-view.js';

// Step 28a: a shop order's parcels (decisions 2 to 5, 17, 20 and 21), as the order routes use
// them. Plain functions over the caller's transaction: every one runs inside a move of the order,
// after StorefrontOrdersService has locked the order (FOR UPDATE), so two moves of one order take
// turns, and the parcel's change and the order's commit or roll back together. The worker's half
// (calling the courier) is booking.handler.ts; the courier's news is shipment-news.ts.

type ParcelRow = typeof storefrontShipments.$inferSelect;

// A parcel's invoice (28a.2's mine 25): the order number for the first, then "W-000123-2". 0078's
// trigger checks the same rule, so a mistake here is a 500, never a parcel the courier cannot match
export function invoiceOf(orderNo: string, parcelNo: number): string {
  return parcelNo === 1 ? orderNo : `${orderNo}-${String(parcelNo)}`;
}

function notBookable(): AppError {
  return new AppError(
    409,
    'storefront_order_not_bookable',
    'Only a packed order goes to a courier. Mark it packed first.',
  );
}

function hasParcel(): AppError {
  return new AppError(
    409,
    'storefront_order_has_parcel',
    'This order has a parcel on its way already. Reload the page.',
  );
}

// What the rider collects for this order now: the total less what its paid tries took (decision
// 20). Read here, in the order's transaction, so a payment that lands meanwhile is counted
export async function codAmountFor(tx: Transaction, order: OrderRow): Promise<string> {
  const paid = await tx
    .select({ amount: storefrontPayments.amount })
    .from(storefrontPayments)
    .where(
      and(
        eq(storefrontPayments.tenantId, getTenantId()),
        eq(storefrontPayments.orderId, order.id),
        eq(storefrontPayments.status, 'paid'),
      ),
    );
  return codAmountOf(
    order.total,
    paid.map((row) => row.amount),
  );
}

async function parcelsOf(tx: Transaction, orderId: string, lock: boolean): Promise<ParcelRow[]> {
  const query = tx
    .select()
    .from(storefrontShipments)
    .where(
      and(
        eq(storefrontShipments.tenantId, getTenantId()),
        eq(storefrontShipments.orderId, orderId),
      ),
    )
    .orderBy(asc(storefrontShipments.parcelNo));
  return lock ? query.for('update') : query;
}

// One step a member took for a parcel (a manual parcel's booking, a cancel): the same row the
// courier's news writes, so the order page and the tracking page draw it the same way
async function memberEvent(
  tx: Transaction,
  shipmentId: string,
  status: ShopShipmentStatus,
  at: Date,
): Promise<void> {
  await tx
    .insert(storefrontShipmentEvents)
    .values({
      tenantId: getTenantId(),
      shipmentId,
      status,
      note: null,
      occurredAt: at,
      source: 'member',
      eventKey: eventKeyOf('member', status, at, null),
    })
    .onConflictDoNothing();
}

// Packed with a courier, or "Book courier" later (decision 2). The order must be packed and have
// no parcel on its way. An API account's parcel starts in `booking` and the worker books it
// (emit, in this transaction: a Packed that rolls back books nothing); a manual account's parcel
// is booked at once with the code the member typed from the courier's panel
export async function startShipment(
  tx: Transaction,
  order: OrderRow,
  input: { accountId: string; trackingCode: string },
): Promise<void> {
  if (order.status !== 'packed' || order.orderNo === null) throw notBookable();
  const tenantId = getTenantId();
  // FOR SHARE: an archive of this account waits until the parcel is made, so a parcel never
  // starts with an account archived a moment before
  const [account] = await tx
    .select()
    .from(courierAccounts)
    .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.id, input.accountId)))
    .for('share');
  if (account === undefined) throw notFound('Courier account');
  if (account.archivedAt !== null) {
    throw new AppError(409, 'courier_account_archived', 'This courier account is archived.', {
      fieldErrors: { accountId: ['courier_account_archived'] },
    });
  }
  const manual = account.provider === 'manual';
  if (manual && input.trackingCode === '') {
    throw new AppError(422, 'courier_tracking_code_required', 'Type the courier’s tracking code.', {
      fieldErrors: { trackingCode: ['courier_tracking_code_required'] },
    });
  }
  const parcels = await parcelsOf(tx, order.id, false);
  if (parcels.some((parcel) => isOpenShipment(parcel.status))) throw hasParcel();
  // A sixth has no number (28a.2's parcel check): five tries of one order is a case for a person
  if (parcels.length >= 5) throw notBookable();
  const parcelNo = parcels.length + 1;
  const now = new Date();
  let row: ParcelRow | undefined;
  try {
    [row] = await tx
      .insert(storefrontShipments)
      .values({
        tenantId,
        orderId: order.id,
        courierAccountId: account.id,
        parcelNo,
        invoice: invoiceOf(order.orderNo, parcelNo),
        courier: account.courier,
        codAmount: await codAmountFor(tx, order),
        // Only the order routes reach this, so there is always a member
        createdBy: currentPrincipal().userId,
        ...(manual
          ? { status: 'booked' as const, trackingCode: input.trackingCode, bookedAt: now }
          : { status: 'booking' as const }),
      })
      .returning();
  } catch (error) {
    // Two Packed or Book courier at the same moment: the second waits for the first's commit and
    // fails on one of these (28a.2's race check). The same answer as the check above
    if (
      isUniqueViolation(error, 'storefront_shipments_open_idx') ||
      isUniqueViolation(error, 'storefront_shipments_parcel_key')
    ) {
      throw hasParcel();
    }
    throw error;
  }
  if (row === undefined) throw new Error('Parcel insert returned no row');
  if (manual) await memberEvent(tx, row.id, 'booked', now);
  else await emit(tx, 'storefront.shipment_requested', { shipmentId: row.id });
  await audit(tx, {
    action: 'storefront_order.shipment_booked',
    entityType: 'storefront_order',
    entityId: order.id,
    changes: created({
      order: order.orderNo,
      courier: account.name,
      ...(manual ? { trackingCode: input.trackingCode } : {}),
    }),
  });
}

// "Book again" (decision 4): the same row, so the courier is asked with the same invoice (decision
// 3). Only the order's last parcel, only after it failed, and only while nothing else is on its
// way. The last error stays on the row while it books again: the page says what went wrong last
// time (28a.2's status check allows it)
export async function retryShipment(
  tx: Transaction,
  order: OrderRow,
  shipmentId: string,
): Promise<void> {
  if (order.status !== 'packed') throw notBookable();
  const parcels = await parcelsOf(tx, order.id, true);
  const parcel = parcels.find((row) => row.id === shipmentId);
  if (parcel === undefined) throw notFound('Parcel');
  if (parcel.status !== 'booking_failed') {
    throw new AppError(
      409,
      'storefront_shipment_not_failed',
      'This parcel did not fail. Reload the page.',
    );
  }
  if (parcels.some((row) => row.parcelNo > parcel.parcelNo || isOpenShipment(row.status))) {
    throw hasParcel();
  }
  const [account] = await tx
    .select({ name: courierAccounts.name, archivedAt: courierAccounts.archivedAt })
    .from(courierAccounts)
    .where(
      and(
        eq(courierAccounts.tenantId, getTenantId()),
        eq(courierAccounts.id, parcel.courierAccountId),
      ),
    )
    .for('share');
  if (account?.archivedAt !== null) {
    throw new AppError(
      409,
      'courier_account_archived',
      'This parcel’s courier account is archived. Restore it, or book with another account.',
    );
  }
  await tx
    .update(storefrontShipments)
    .set({ status: 'booking', updatedAt: new Date() })
    .where(
      and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, parcel.id)),
    );
  await emit(tx, 'storefront.shipment_requested', { shipmentId: parcel.id });
  await audit(tx, {
    action: 'storefront_order.shipment_retried',
    entityType: 'storefront_order',
    entityId: order.id,
    changes: created({ order: order.orderNo, courier: account.name, invoice: parcel.invoice }),
  });
}

// Cancel (decision 21): a parcel only booked is cancelled with the order, and a failed one stays as
// it was (it is not on its way). Refused while the worker is still booking (it might reach the
// courier after the cancel) and once the courier has the parcel (that is a return, step 28b).
// Steadfast has no cancel call, so the order page says to cancel it on the courier's panel too
export async function cancelShipments(tx: Transaction, order: OrderRow): Promise<void> {
  const parcels = await parcelsOf(tx, order.id, true);
  const open = parcels.find((parcel) => isOpenShipment(parcel.status));
  if (open === undefined) return;
  if (open.status === 'booking') {
    throw new AppError(
      409,
      'storefront_order_parcel_booking',
      'The parcel is being booked. Cancel once it is booked or its booking failed.',
    );
  }
  if (open.status !== 'booked') {
    throw new AppError(
      409,
      'storefront_order_parcel_on_its_way',
      'The courier has the parcel now, so the order cannot be cancelled.',
    );
  }
  const now = new Date();
  await tx
    .update(storefrontShipments)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, open.id)),
    );
  await memberEvent(tx, open.id, 'cancelled', now);
}

// Mark shipped and Mark delivered on an order whose parcel was booked by hand (decision 5: a
// manual parcel keeps the buttons): the parcel follows, so the tracking page shows the step too.
// An API parcel is moved by its courier only; the buttons still move its order (a courier whose
// news stopped), and the courier's later news adds its own steps
export async function followOrder(
  tx: Transaction,
  orderId: string,
  status: 'picked_up' | 'delivered',
): Promise<void> {
  const [open] = await tx
    .select({ id: storefrontShipments.id })
    .from(storefrontShipments)
    .innerJoin(
      courierAccounts,
      and(
        eq(courierAccounts.tenantId, storefrontShipments.tenantId),
        eq(courierAccounts.id, storefrontShipments.courierAccountId),
      ),
    )
    .where(
      and(
        eq(storefrontShipments.tenantId, getTenantId()),
        eq(storefrontShipments.orderId, orderId),
        eq(courierAccounts.provider, 'manual'),
        inArray(storefrontShipments.status, [...OPEN_SHIPMENT_STATUSES]),
      ),
    )
    .for('update', { of: storefrontShipments });
  if (open === undefined) return;
  const now = new Date();
  await tx
    .update(storefrontShipments)
    .set({ status, updatedAt: now })
    .where(
      and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, open.id)),
    );
  await memberEvent(tx, open.id, status, now);
}

// The order page's parcels, oldest first, each with its steps oldest first (a notice we could not
// read is left out: it has no status). Stored error codes are read like the order's documentError:
// one this API no longer knows reads as none
export async function shipmentsOf(tx: Transaction, orderId: string): Promise<StorefrontShipment[]> {
  const tenantId = getTenantId();
  const rows = await tx
    .select({
      parcel: storefrontShipments,
      accountName: courierAccounts.name,
      provider: courierAccounts.provider,
    })
    .from(storefrontShipments)
    .innerJoin(
      courierAccounts,
      and(
        eq(courierAccounts.tenantId, storefrontShipments.tenantId),
        eq(courierAccounts.id, storefrontShipments.courierAccountId),
      ),
    )
    .where(
      and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.orderId, orderId)),
    )
    .orderBy(asc(storefrontShipments.parcelNo));
  if (rows.length === 0) return [];
  const events = await tx
    .select({
      shipmentId: storefrontShipmentEvents.shipmentId,
      status: storefrontShipmentEvents.status,
      note: storefrontShipmentEvents.note,
      at: storefrontShipmentEvents.occurredAt,
    })
    .from(storefrontShipmentEvents)
    .where(
      and(
        eq(storefrontShipmentEvents.tenantId, tenantId),
        inArray(
          storefrontShipmentEvents.shipmentId,
          rows.map((row) => row.parcel.id),
        ),
        isNotNull(storefrontShipmentEvents.status),
      ),
    )
    .orderBy(asc(storefrontShipmentEvents.occurredAt), asc(storefrontShipmentEvents.receivedAt));
  return rows.map(({ parcel, accountName, provider }) => ({
    id: parcel.id,
    account: { id: parcel.courierAccountId, name: accountName, provider },
    courier: parcel.courier,
    status: parcel.status,
    consignmentId: parcel.consignmentId,
    trackingCode: parcel.trackingCode,
    codAmount: parcel.codAmount,
    bookedAt: parcel.bookedAt?.toISOString() ?? null,
    attempts: parcel.attempts,
    error: parcel.error !== null && isErrorCode(parcel.error) ? parcel.error : null,
    errorDetail: parcel.errorDetail,
    // The contract's 100 (the tracking page's too): the newest are the ones that matter
    events: events
      .filter((event) => event.shipmentId === parcel.id)
      .flatMap((event) =>
        event.status === null
          ? []
          : [{ status: event.status, at: event.at.toISOString(), note: event.note }],
      )
      .slice(-100),
    lastSyncedAt: parcel.lastSyncedAt?.toISOString() ?? null,
  }));
}

// The list's "Needs attention" (28a.1): a packed order whose last parcel failed to book. A
// correlated EXISTS over the order's few parcels (storefront_shipments_parcel_key finds them).
// storefront_orders is written out, as 27b's itemCount does: in a select's fields Drizzle writes a
// column without its table, and an unqualified "tenant_id" in the subquery would be its own row's
export const parcelNeedsAttention = sql<boolean>`(storefront_orders.status = 'packed' AND EXISTS (
  SELECT 1 FROM storefront_shipments s
  WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id
    AND s.status = 'booking_failed'
    AND NOT EXISTS (
      SELECT 1 FROM storefront_shipments t
      WHERE t.tenant_id = s.tenant_id AND t.order_id = s.order_id AND t.parcel_no > s.parcel_no
    )
))`;

// Step 28a.6: what the Packed dialog and Book courier offer (courierChoicesSchema). Active
// accounts only, by name. The default comes from the same rows: 28a.2's check keeps it an active
// API account, so it is always one of them
export async function courierChoicesOf(tx: Transaction): Promise<CourierChoices> {
  const rows = await tx
    .select({
      id: courierAccounts.id,
      provider: courierAccounts.provider,
      name: courierAccounts.name,
      courier: courierAccounts.courier,
      isDefault: courierAccounts.isDefault,
    })
    .from(courierAccounts)
    .where(and(eq(courierAccounts.tenantId, getTenantId()), isNull(courierAccounts.archivedAt)))
    .orderBy(asc(courierAccounts.name), asc(courierAccounts.id));
  return {
    accounts: rows.map(({ id, provider, name, courier }) => ({ id, provider, name, courier })),
    defaultAccountId: rows.find((row) => row.isDefault)?.id ?? null,
  };
}

// The export for a courier's bulk upload (decision 19): the packed orders with no parcel on its
// way, oldest packed first, at most COURIER_EXPORT_MAX_ROWS. The invoice is the one the order's
// next parcel gets, so the code typed back into "Book courier" matches what the courier's panel
// was given
export async function courierExportRows(tx: Transaction): Promise<CourierExport> {
  const tenantId = getTenantId();
  const orders = await tx
    .select({
      order: storefrontOrders,
      // storefront_orders written out, for parcelNeedsAttention's reason
      parcels: sql<number>`(SELECT count(*)::int FROM storefront_shipments s
        WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id)`,
      items: sql<number>`(SELECT coalesce(sum(l.quantity), 0)::int FROM storefront_order_lines l
        WHERE l.tenant_id = storefront_orders.tenant_id AND l.order_id = storefront_orders.id)`,
    })
    .from(storefrontOrders)
    .where(
      and(
        eq(storefrontOrders.tenantId, tenantId),
        eq(storefrontOrders.status, 'packed'),
        sql`NOT EXISTS (SELECT 1 FROM storefront_shipments s
          WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id
            AND s.status IN (${sql.join(
              OPEN_SHIPMENT_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )}))`,
      ),
    )
    .orderBy(asc(storefrontOrders.packedAt), asc(storefrontOrders.id))
    .limit(COURIER_EXPORT_MAX_ROWS + 1);
  const page = orders.slice(0, COURIER_EXPORT_MAX_ROWS);
  const paid =
    page.length === 0
      ? []
      : await tx
          .select({ orderId: storefrontPayments.orderId, amount: storefrontPayments.amount })
          .from(storefrontPayments)
          .where(
            and(
              eq(storefrontPayments.tenantId, tenantId),
              inArray(
                storefrontPayments.orderId,
                page.map((row) => row.order.id),
              ),
              eq(storefrontPayments.status, 'paid'),
            ),
          );
  return {
    rows: page.flatMap(({ order, parcels, items }) =>
      // A packed order always has its number; one without is a broken row, left out
      order.orderNo === null || parcels >= 5
        ? []
        : [
            {
              orderId: order.id,
              invoice: invoiceOf(order.orderNo, parcels + 1),
              name: order.customerName,
              // On one line: a CSV cell with line breaks is read wrong by some courier panels
              address: order.address.replace(/\s+/g, ' ').trim(),
              phone: order.phone,
              amount: codAmountOf(
                order.total,
                paid.filter((row) => row.orderId === order.id).map((row) => row.amount),
              ),
              itemCount: Math.max(items, 1),
            },
          ],
    ),
    more: orders.length > COURIER_EXPORT_MAX_ROWS,
  };
}
