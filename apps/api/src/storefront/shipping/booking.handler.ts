import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ErrorCode } from '@omnivo/contracts';
import {
  courierAccounts,
  storefrontOrderLines,
  storefrontOrders,
  storefrontShipmentEvents,
  storefrontShipments,
} from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import {
  type EventHandler,
  type OutboxEvent,
  PermanentJobError,
} from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import type { ShippingConfig } from '../../config.js';
import { COURIERS, SHIPPING_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { notify } from '../../notifications/notify.js';
import { membersWhoMay } from '../../notifications/recipients.js';
import {
  type CourierAdapter,
  type CourierAdapters,
  type CourierKeys,
  type CourierParcel,
  courierText,
  eventKeyOf,
  isApiProvider,
  type ParcelRequest,
} from '../../shipping/courier.js';
import { openKeys } from './courier-keys.js';

// What one try ended with: booked, or a failure with our code and the courier's sentence. A
// permanent one (the courier said no, or the keys cannot be opened) is not tried again: the next
// try would get the same answer (decision 4)
type Outcome =
  | { kind: 'booked'; parcel: CourierParcel }
  | { kind: 'failed'; error: ErrorCode; detail: string | null; permanent: boolean };

// Everything a try needs, read before the courier is called
interface Booking {
  shipmentId: string;
  orderId: string;
  attemptsBefore: number;
  adapter: CourierAdapter;
  keys: CourierKeys | null;
  request: ParcelRequest;
}

// Step 28a (decisions 3 and 4): the worker's half of a booking, for one parcel in `booking`. On
// the couriers queue (worker/queues.ts), five tries over about 15 minutes. Three transactions and
// no lock held while the courier thinks, as 27d's gateway calls:
// 1. count the try (attempts + 1) and read what the courier is told. Counted first: a worker that
//    dies during the call leaves the count, so the next try knows the courier may have it
// 2. call the courier, outside any transaction. A try after the first asks by the invoice before
//    booking (decision 3), so a lost answer never makes a second parcel
// 3. write the answer: booked, with its first step; or the error, kept on the row while it still
//    books, and thrown so the queue tries again (or, for a permanent one, gives up at once)
// onGiveUp then fails the parcel and rings the bell. Every step reads the parcel's status first:
// a second run of a job (the queue's at-least-once) finds it booked and does nothing.
@Injectable()
export class ShipmentBookingHandler implements EventHandler<'storefront.shipment_requested'> {
  private readonly logger = new Logger(ShipmentBookingHandler.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(SHIPPING_CONFIG) private readonly shipping: ShippingConfig,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
  ) {}

  async handle(event: OutboxEvent<'storefront.shipment_requested'>): Promise<void> {
    const booking = await this.start(event.payload.shipmentId);
    if (booking === null) return;
    const outcome = await this.call(booking);
    await this.finish(booking, outcome);
    if (outcome.kind === 'failed') {
      const message = `parcel ${booking.shipmentId}: ${outcome.error}`;
      throw outcome.permanent ? new PermanentJobError(message) : new Error(message);
    }
  }

  // After the last try, or at once for a permanent failure: the parcel fails, keeping the last
  // try's reason (courier_unreachable when none was written: the worker died before it could),
  // and the bell rings for the people who can book again (decision 4)
  async onGiveUp(event: OutboxEvent<'storefront.shipment_requested'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(storefrontShipments)
        .set({
          status: 'booking_failed',
          error: sql`coalesce(${storefrontShipments.error}, 'courier_unreachable')`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            eq(storefrontShipments.id, event.payload.shipmentId),
            eq(storefrontShipments.status, 'booking'),
          ),
        )
        .returning({
          orderId: storefrontShipments.orderId,
          accountId: storefrontShipments.courierAccountId,
        });
      // Booked meanwhile (a second job), or not this job's to fail
      if (failed === undefined) return;
      const [order] = await tx
        .select({ orderNo: storefrontOrders.orderNo, accountName: courierAccounts.name })
        .from(storefrontOrders)
        .innerJoin(
          courierAccounts,
          and(
            eq(courierAccounts.tenantId, storefrontOrders.tenantId),
            eq(courierAccounts.id, failed.accountId),
          ),
        )
        .where(
          and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, failed.orderId)),
        );
      if (order?.orderNo == null) return;
      for (const member of await membersWhoMay(tx, 'storefront.order.manage')) {
        await notify(tx, {
          userId: member.userId,
          type: 'storefront.shipment_failed',
          // The number and the account's name; never the buyer's name or phone (a bell is seen
          // over a shoulder)
          params: { id: failed.orderId, number: order.orderNo, courier: order.accountName },
          eventId: event.id,
        });
      }
    });
  }

  private start(shipmentId: string): Promise<Booking | null> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ parcel: storefrontShipments, account: courierAccounts, order: storefrontOrders })
        .from(storefrontShipments)
        .innerJoin(
          courierAccounts,
          and(
            eq(courierAccounts.tenantId, storefrontShipments.tenantId),
            eq(courierAccounts.id, storefrontShipments.courierAccountId),
          ),
        )
        .innerJoin(
          storefrontOrders,
          and(
            eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
            eq(storefrontOrders.id, storefrontShipments.orderId),
          ),
        )
        .where(
          and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
        )
        .for('update', { of: storefrontShipments });
      // Booked already (a second run), failed and not asked again, or gone
      if (row?.parcel.status !== 'booking') return null;
      const { parcel, account, order } = row;
      if (!isApiProvider(account.provider)) {
        throw new PermanentJobError(`parcel ${shipmentId} has a manual account`);
      }
      await tx
        .update(storefrontShipments)
        .set({ attempts: sql`${storefrontShipments.attempts} + 1`, updatedAt: new Date() })
        .where(
          and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
        );
      const [items] = await tx
        .select({ count: sql<number>`coalesce(sum(${storefrontOrderLines.quantity}), 0)::int` })
        .from(storefrontOrderLines)
        .where(
          and(
            eq(storefrontOrderLines.tenantId, tenantId),
            eq(storefrontOrderLines.orderId, order.id),
          ),
        );
      const keys = openKeys(this.shipping.credentialsKey, account);
      if (keys === null) {
        // The workspace and the account, never a value
        this.logger.error(
          `The keys of courier account ${account.id} (tenant ${tenantId}) cannot be opened`,
        );
      }
      const count = items?.count ?? 0;
      return {
        shipmentId,
        orderId: order.id,
        attemptsBefore: parcel.attempts,
        adapter: this.couriers[account.provider],
        keys,
        request: {
          invoice: parcel.invoice,
          name: order.customerName,
          phone: order.phone,
          address: `${order.address}, ${order.zoneName}`,
          // Postgres's "578.0000" as the courier's two decimals; the amount is to the paisa
          // already (28a.2's amounts check)
          codAmount: parcel.codAmount.replace(/^(\d+)\.(\d{2})\d*$/, '$1.$2'),
          note: `${String(count)} ${count === 1 ? 'item' : 'items'}`,
        },
      };
    });
  }

  private async call(booking: Booking): Promise<Outcome> {
    const { adapter, keys, request } = booking;
    // Keys this server cannot open: no CREDENTIALS_KEY, or sealed by another key. Trying again
    // cannot help until someone types them again on Shop couriers
    if (keys === null) {
      return { kind: 'failed', error: 'courier_key_missing', detail: null, permanent: true };
    }
    // A try after the first: the courier may have the parcel from a call whose answer was lost
    if (booking.attemptsBefore > 0) {
      const found = await this.found(adapter, keys, request.invoice);
      if (found !== null) return found;
    }
    const answer = await adapter.book(keys, request);
    switch (answer.kind) {
      case 'booked':
        return { kind: 'booked', parcel: answer.parcel };
      case 'refused':
        return {
          kind: 'failed',
          error: 'courier_rejected_parcel',
          detail: answer.detail,
          permanent: true,
        };
      case 'taken':
        return (
          (await this.found(adapter, keys, request.invoice)) ?? {
            kind: 'failed',
            error: 'courier_unreachable',
            detail: null,
            permanent: false,
          }
        );
      case 'problem':
        return problemOutcome(answer.problem);
    }
  }

  // The parcel by its invoice: the booking it is (found), a failure (exists without a code, or
  // the courier could not be asked), or null when nothing has the invoice and booking is safe
  private async found(
    adapter: CourierAdapter,
    keys: CourierKeys,
    invoice: string,
  ): Promise<Outcome | null> {
    const answer = await adapter.find(keys, invoice);
    switch (answer.kind) {
      case 'found':
        return { kind: 'booked', parcel: answer.parcel };
      case 'exists':
        return { kind: 'failed', error: 'courier_invoice_taken', detail: null, permanent: true };
      case 'none':
        return null;
      case 'problem':
        return problemOutcome(answer.problem);
    }
  }

  private finish(booking: Booking, outcome: Outcome): Promise<void> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [parcel] = await tx
        .select({ status: storefrontShipments.status })
        .from(storefrontShipments)
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            eq(storefrontShipments.id, booking.shipmentId),
          ),
        )
        .for('update');
      if (parcel?.status !== 'booking') return;
      const now = new Date();
      if (outcome.kind === 'failed') {
        await tx
          .update(storefrontShipments)
          .set({ error: outcome.error, errorDetail: courierText(outcome.detail), updatedAt: now })
          .where(
            and(
              eq(storefrontShipments.tenantId, tenantId),
              eq(storefrontShipments.id, booking.shipmentId),
            ),
          );
        return;
      }
      const { parcel: booked } = outcome;
      await tx
        .update(storefrontShipments)
        .set({
          status: booked.status,
          consignmentId: booked.consignmentId,
          trackingCode: booked.trackingCode,
          trackingUrl: booked.trackingUrl,
          bookedAt: now,
          error: null,
          errorDetail: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            eq(storefrontShipments.id, booking.shipmentId),
          ),
        );
      // The first step: booked, by the booking itself. The tracking page shows a parcel from here
      await tx
        .insert(storefrontShipmentEvents)
        .values({
          tenantId,
          shipmentId: booking.shipmentId,
          status: 'booked',
          note: null,
          occurredAt: now,
          receivedAt: now,
          source: 'booking',
          eventKey: eventKeyOf('booking', 'booked', now, null),
        })
        .onConflictDoNothing();
    });
  }
}

// The keys refused: the tenant's account, not our bug (§14.6 rule 5), and the same next time.
// No answer: maybe next time
function problemOutcome(problem: 'rejected' | 'unreachable'): Outcome {
  return problem === 'rejected'
    ? { kind: 'failed', error: 'courier_rejected_keys', detail: null, permanent: true }
    : { kind: 'failed', error: 'courier_unreachable', detail: null, permanent: false };
}
