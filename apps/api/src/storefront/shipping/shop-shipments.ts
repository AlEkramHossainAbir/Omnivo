import type { ShopShipment } from '@omnivo/contracts';
import { storefrontShipmentEvents, storefrontShipments } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Transaction } from '../../common/tenant/with-tenant.js';

// Step 28a: an order's parcels as the tracking page shows them (26e's shopShipmentSchema), read
// inside ShopDb.orders as omnivo_shop. Only the columns 0078 (and 0079) grant that role, named one by one: a
// select() of the whole row would ask for the COD amount and the courier's errors and fail. The
// restrictive policies leave out a parcel still booking or failed, and a notice we could not read,
// whatever this query asks (28a.2's mine 27). The tenant comes from the shop's host (ShopScope)
export async function shopShipmentsOf(
  tx: Transaction,
  tenantId: string,
  orderId: string,
): Promise<ShopShipment[]> {
  const parcels = await tx
    .select({
      id: storefrontShipments.id,
      courier: storefrontShipments.courier,
      trackingCode: storefrontShipments.trackingCode,
      trackingUrl: storefrontShipments.trackingUrl,
    })
    .from(storefrontShipments)
    .where(
      and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.orderId, orderId)),
    )
    .orderBy(asc(storefrontShipments.parcelNo));
  if (parcels.length === 0) return [];
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
          parcels.map((parcel) => parcel.id),
        ),
      ),
    )
    // Steps of one courier second in the order they reached us (0079 grants received_at for it),
    // as the order page sorts them. Without it, ties came back in whatever order Postgres read them
    .orderBy(asc(storefrontShipmentEvents.occurredAt), asc(storefrontShipmentEvents.receivedAt));
  return parcels.flatMap((parcel) => {
    const steps = events
      .filter((event) => event.shipmentId === parcel.id)
      .flatMap((event) =>
        event.status === null
          ? []
          : [{ status: event.status, at: event.at.toISOString(), note: event.note }],
      )
      // The newest 100, as the contract allows
      .slice(-100);
    // A booked parcel always has its booking's step; one without (cannot happen) is not shown
    // rather than breaking the contract's "at least one event"
    return parcel.trackingCode === null || steps.length === 0
      ? []
      : [
          {
            courier: parcel.courier,
            trackingCode: parcel.trackingCode,
            trackingUrl: parcel.trackingUrl,
            events: steps,
          },
        ];
  });
}
