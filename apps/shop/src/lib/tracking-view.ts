import type {
  ShopShipment,
  ShopShipmentEvent,
  ShopShipmentStatus,
  ShopTracking,
} from '@omnivo/contracts';

import type { TimelineState } from './order-timeline';

// Step 26e: the rules of the tracking view (components/TrackingView.astro), apart from the markup
// and tested once, like 26c's order-timeline.ts. A tracking link and the /track form draw the
// same view, so the rules are written here and nowhere else.

// The order statuses in which Cash on Delivery money is still to be paid at the door. Delivered is
// paid; cancelled and returned will never be
const PAY_AT_THE_DOOR: ReadonlySet<ShopTracking['status']> = new Set([
  'pending',
  'confirmed',
  'packed',
  'shipped',
]);

// The line under the total: what the person at the door has to do about money, or null when there
// is nothing to say (a Cash on Delivery order that is delivered, cancelled or returned)
export type PaymentLine = 'payOnDelivery' | 'paidOnline' | null;

export function paymentLine(tracking: Pick<ShopTracking, 'paymentMethod' | 'status'>): PaymentLine {
  if (tracking.paymentMethod === 'online') return 'paidOnline';
  return PAY_AT_THE_DOOR.has(tracking.status) ? 'payOnDelivery' : null;
}

// Where a parcel's way ends. Its newest event is then a done step, not the current one: nothing
// more will happen to that parcel
const PARCEL_ENDS: ReadonlySet<ShopShipmentStatus> = new Set([
  'delivered',
  'partly_delivered',
  'returned',
  'cancelled',
]);

// One courier event with its dot, in the order timeline's three states (order-timeline.ts). A
// parcel's events have all happened, so none is "later"
export interface ParcelEventView {
  event: ShopShipmentEvent;
  state: Exclude<TimelineState, 'later'>;
}

// One parcel as the view draws it: its events newest first, and whether it is the one the order
// is with now. The contract keeps both lists oldest first, as they happened
export interface ParcelView {
  shipment: ShopShipment;
  events: ParcelEventView[];
  current: boolean;
}

// Newest first, for parcels and for their events: the shopper's question is "where is it now?",
// and the answer must be the first thing on a phone's screen, not at the end of a long list.
// Couriers' own tracking pages show their events this way too. `toReversed` makes a copy, so the
// tracking that came from the source is never changed
export function parcelViews(shipments: readonly ShopShipment[]): ParcelView[] {
  return shipments.toReversed().map((shipment, index) => {
    const current = index === 0;
    return {
      shipment,
      current,
      events: shipment.events.toReversed().map((event, at) => ({
        event,
        // Only the newest event of the parcel the order is with now is "current", and only while
        // its way has not ended. An earlier parcel is over, whatever its last event says
        state: current && at === 0 && !PARCEL_ENDS.has(event.status) ? 'current' : 'done',
      })),
    };
  });
}
