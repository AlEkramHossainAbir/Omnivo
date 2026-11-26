import { Injectable, Logger } from '@nestjs/common';
import { compareMoney, type ShipmentStatus, type ShopShipmentStatus } from '@omnivo/contracts';
import { storefrontSettings, storefrontShipmentEvents, storefrontShipments } from '@omnivo/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { type CourierNotice, eventKeyOf } from '../../shipping/courier.js';
import { pickedUpSms } from '../../sms/shop-sms.js';
import type { SmsJob } from '../../sms/sms-job.js';
import { lockOrder, ShopOrderMoves } from '../orders/order-moves.js';

type ParcelRow = typeof storefrontShipments.$inferSelect;

// Where a parcel is after the courier took it: any of these means the goods have left the shop, so
// a packed order is Shipped (decision 5). Not booked (nobody came yet) and not cancelled
const LEFT_THE_SHOP = new Set<ShipmentStatus>([
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'partly_delivered',
  'on_hold',
  'returning',
  'returned',
]);

// A parcel whose status the news no longer changes: the courier never answered a code for one in
// booking or booking_failed (it is the booking job's), and 0078's guard keeps a cancelled or
// returned one where it is
const SETTLED = new Set<ShipmentStatus>(['booking', 'booking_failed', 'cancelled', 'returned']);

// What a courier's status means for a parcel that is where `current` says. The courier cancelling
// the consignment before anyone picked it up is a cancelled booking; once the goods left, they are
// coming back (the Steadfast adapter's note). The webhook and the poll both read a status this way,
// so the poll's "is this news?" and the step the webhook writes agree
export function stepStatusOf(
  current: ShipmentStatus,
  said: ShopShipmentStatus,
): ShopShipmentStatus {
  if (said !== 'cancelled') return said;
  return current === 'booking' ||
    current === 'booking_failed' ||
    current === 'booked' ||
    current === 'cancelled'
    ? 'cancelled'
    : 'returning';
}

function between(at: Date, from: Date, to: Date): Date {
  return new Date(Math.min(Math.max(at.getTime(), from.getTime()), to.getTime()));
}

// 28a.2's raw column holds at most 8 KB. A courier's notice is a few hundred bytes; a body over the
// limit is kept as a marker, so it is still seen as one we could not read
function keptRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return Buffer.byteLength(JSON.stringify(raw), 'utf8') <= 8000 ? raw : { tooLarge: true };
}

// Step 28b (decision 5): the money a status notice names, as the parcel keeps it.
// - The courier's charge from any status notice that names one: it is the courier's own figure
//   for the parcel, known from the booking on, and 28c's payout checks it.
// - What the rider collected only from a delivered or partly delivered step: on the other steps
//   Steadfast's cod_amount is what is still to collect. Never more than the parcel's codAmount
//   (mine 21: the raw body keeps what the courier said), and never once the parcel has its COD
//   receipt (0081's receipt_kept): the receipt was made for the amount known then
// A parcel the courier never booked has no money (0080's check); stepOf keeps its notices raw,
// with no status, so they never reach here
function moneyOf(
  parcel: ParcelRow,
  money: { collectedAmount: string | null; courierCharge: string | null },
  status: ShopShipmentStatus,
  notice: Extract<CourierNotice, { kind: 'status' }>,
): { collectedAmount: string | null; courierCharge: string | null } {
  const atDoor = status === 'delivered' || status === 'partly_delivered';
  const collected =
    !atDoor || notice.collected === null || parcel.receiptId !== null
      ? money.collectedAmount
      : compareMoney(notice.collected, parcel.codAmount) > 0
        ? parcel.codAmount
        : notice.collected;
  return { collectedAmount: collected, courierCharge: notice.charge ?? money.courierCharge };
}

// Step 28a: what the courier said about one parcel, from its webhook (in the API) or the 15-minute
// poll (in the worker), written the same way:
// 1. the order, then the parcel, are locked (the buttons' order, so the two take turns)
// 2. each step is a row of the parcel's events, with the API's own key: the same step twice is
//    one row (28a.2's mine 26)
// 3. the parcel's status is its newest step's, by the courier's clock (kept between the booking
//    and now): a webhook that comes late does not take the parcel back
// 4. the order follows: Shipped once the goods have left, then Delivered, which posts the invoice
//    (decision 5, the buttons' own code in order-moves.ts). Step 28b: and the rider's COD receipt,
//    from the collected amount step 3 kept on the parcel. A partly delivered or returned parcel
//    moves only itself: the goods that came back are recorded by a member (decisions 6 and 7)
// It answers the SMS to send once the caller's transaction has committed (decision 11), never
// before: an SMS for news that rolled back would tell the shopper something that did not happen.
@Injectable()
export class ShipmentNews {
  private readonly logger = new Logger(ShipmentNews.name);

  constructor(private readonly moves: ShopOrderMoves) {}

  async apply(
    tx: Transaction,
    shipmentId: string,
    notices: readonly CourierNotice[],
    source: 'webhook' | 'poll',
    now: Date = new Date(),
  ): Promise<SmsJob | null> {
    const tenantId = getTenantId();
    const [found] = await tx
      .select({ orderId: storefrontShipments.orderId })
      .from(storefrontShipments)
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
      );
    if (found === undefined) return null;
    const order = await lockOrder(tx, found.orderId);
    const [parcel] = await tx
      .select()
      .from(storefrontShipments)
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
      )
      .for('update');
    if (parcel === undefined) return null;

    let current: ShipmentStatus = parcel.status;
    let money = { collectedAmount: parcel.collectedAmount, courierCharge: parcel.courierCharge };
    for (const notice of notices) {
      const step = this.stepOf(parcel, current, notice, now);
      await tx
        .insert(storefrontShipmentEvents)
        .values({ tenantId, shipmentId, ...step, source, receivedAt: now })
        .onConflictDoNothing();
      if (step.status !== null) current = step.status;
      if (step.status !== null && notice.kind === 'status') {
        money = moneyOf(parcel, money, step.status, notice);
      }
    }

    const status = SETTLED.has(parcel.status) ? parcel.status : await this.newest(tx, parcel);
    await tx
      .update(storefrontShipments)
      .set({ status, ...money, lastSyncedAt: now, updatedAt: now })
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
      );

    let sms: SmsJob | null = null;
    if (LEFT_THE_SHOP.has(status) && order.status === 'packed') {
      await this.moves.ship(tx, order);
      sms = await this.pickedUp(tx, order.phone, order.orderNo, parcel);
    }
    if (status === 'delivered') await this.deliver(tx, order.id);
    return sms;
  }

  // One notice as an event row. A parcel the courier has not given a code to yet (still booking,
  // or failed) keeps any news about it raw: it cannot have a step before it has a code
  private stepOf(
    parcel: ParcelRow,
    current: ShipmentStatus,
    notice: CourierNotice,
    now: Date,
  ): {
    status: ShopShipmentStatus | null;
    note: string | null;
    occurredAt: Date;
    eventKey: string;
    raw: Record<string, unknown> | null;
  } {
    const booked = !(parcel.status === 'booking' || parcel.status === 'booking_failed');
    if (
      notice.kind === 'unread' ||
      !booked ||
      (notice.kind === 'status' && notice.status === null)
    ) {
      const raw = keptRaw(notice.raw);
      // Its key from the body itself: the same body sent twice is one row
      return {
        status: null,
        note: null,
        occurredAt: now,
        eventKey: eventKeyOf('unread', null, null, JSON.stringify(raw)),
        raw,
      };
    }
    // The courier's clock, kept between the booking and the moment the notice reached us: a step
    // cannot happen before the parcel was booked, nor after we heard of it. A courier clock a few
    // minutes off (or a time in the wrong zone) would otherwise put a new step before the booking
    // and take the parcel back to booked
    const at = between(notice.at ?? now, parcel.bookedAt ?? now, now);
    let status: ShopShipmentStatus;
    if (notice.kind === 'note') {
      // Words with no new status: the step is where the parcel is now (booked, in transit …)
      status = current === 'booking' || current === 'booking_failed' ? 'booked' : current;
    } else {
      status = stepStatusOf(current, notice.status ?? 'booked');
    }
    return {
      status,
      note: notice.note,
      occurredAt: at,
      eventKey: eventKeyOf(notice.kind, status, notice.at, notice.note),
      // Step 28b (mine 21): a notice that names money keeps its body, so the courier's own
      // figure is still there when the parcel keeps less (moneyOf cuts it to the COD amount)
      raw:
        notice.kind === 'status' && (notice.collected !== null || notice.charge !== null)
          ? keptRaw(notice.raw)
          : null,
    };
  }

  // The parcel's newest step by the courier's clock (then by when it reached us), the status it
  // takes. 0078's guard never lets it leave cancelled or returned, which SETTLED already keeps
  private async newest(tx: Transaction, parcel: ParcelRow): Promise<ShipmentStatus> {
    const [step] = await tx
      .select({ status: storefrontShipmentEvents.status })
      .from(storefrontShipmentEvents)
      .where(
        and(
          eq(storefrontShipmentEvents.tenantId, getTenantId()),
          eq(storefrontShipmentEvents.shipmentId, parcel.id),
          isNotNull(storefrontShipmentEvents.status),
        ),
      )
      .orderBy(desc(storefrontShipmentEvents.occurredAt), desc(storefrontShipmentEvents.receivedAt))
      .limit(1);
    return step?.status ?? parcel.status;
  }

  // Delivered posts the invoice, in a savepoint: an invoice the sales rules refuse (a product
  // archived since, a lock date) must not lose the courier's news with it. The order stays
  // Shipped, and Mark delivered on its page shows the reason to the member who can fix it. Step
  // 28b: the COD receipt is made inside it with no typed amount (the parcel's collected amount,
  // written above, else its codAmount), and has a savepoint of its own (cod-receipts.ts)
  private async deliver(tx: Transaction, orderId: string): Promise<void> {
    const order = await lockOrder(tx, orderId);
    if (order.status !== 'shipped') return;
    try {
      await tx.transaction((inner) => this.moves.deliver(inner, order));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.logger.warn(`Shop order ${orderId} was delivered, but its invoice: ${error.code}`);
    }
  }

  // The shopper's SMS: the courier and its code (decision 11). None before the shop is set up
  // (there is no name to sign it with), which a shop with orders always is
  private async pickedUp(
    tx: Transaction,
    phone: string,
    orderNo: string | null,
    parcel: ParcelRow,
  ): Promise<SmsJob | null> {
    if (orderNo === null || parcel.trackingCode === null) return null;
    const [shop] = await tx
      .select({ language: storefrontSettings.language, name: storefrontSettings.name })
      .from(storefrontSettings)
      .where(eq(storefrontSettings.tenantId, getTenantId()));
    if (shop === undefined) return null;
    return {
      to: phone,
      text: pickedUpSms(shop.language, shop.name, orderNo, parcel.courier, parcel.trackingCode),
    };
  }
}
