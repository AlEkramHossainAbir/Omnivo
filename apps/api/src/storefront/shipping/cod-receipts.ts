import { Injectable, Logger } from '@nestjs/common';
import { compareMoney, isOpenShipment, isZeroMoney, type ShipmentStatus } from '@omnivo/contracts';
import {
  courierAccounts,
  salesOrders,
  storefrontShipments,
  storefrontOrders,
  warehouses,
} from '@omnivo/db';
import { and, desc, eq, notInArray } from 'drizzle-orm';

import { workspaceToday } from '../../common/db/applied-on.js';
import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { notify } from '../../notifications/notify.js';
import { membersWhoMay } from '../../notifications/recipients.js';
import { ReceiptsService } from '../../sales/receipts.service.js';
import { memberEvent } from './shipments.js';

type OrderRow = typeof storefrontOrders.$inferSelect;
type ParcelRow = typeof storefrontShipments.$inferSelect;

// Where the rider left the parcel: the two steps that take a COD receipt (0081's receipt_match)
export type DoorStatus = 'delivered' | 'partly_delivered';

// The parcel a Delivered is about, with what its account says about the money
interface DoorParcel {
  parcel: ParcelRow;
  accountName: string;
  codAccountId: string | null;
}

export function collectedOver(codAmount: string): AppError {
  return new AppError(
    422,
    'storefront_order_collected_over',
    'The rider cannot have collected more than the parcel’s COD amount.',
    {
      params: { amount: codAmount },
      fieldErrors: { collectedAmount: ['storefront_order_collected_over'] },
    },
  );
}

function collectedRequired(): AppError {
  return new AppError(
    422,
    'storefront_order_collected_required',
    'Type what the rider collected.',
    { fieldErrors: { collectedAmount: ['storefront_order_collected_required'] } },
  );
}

// Step 28b (decisions 4 and 5, mine 14): a delivered parcel's COD money. At Delivered (the
// member's button, or the courier's news through the same ShopOrderMoves.deliver), after the
// invoice is posted: what the rider collected is written on the parcel, and a posted money receipt
// for it goes into the courier account's COD account, by `courier`, paying the invoice. The
// receipt is made in a savepoint, so a receipt the books refuse (a closed period, a COD account
// archived since) never takes the Delivered and the courier's news with it: its error code stays
// on the parcel, the order needs attention, the bell rings, and "Make the receipt" (retry) makes
// it later. Plain methods over the caller's transaction, which has locked the order first.
@Injectable()
export class ShopCodReceipts {
  private readonly logger = new Logger(ShopCodReceipts.name);

  constructor(private readonly receipts: ReceiptsService) {}

  // `typed`: what the member typed in the Delivered or partly delivered dialog, or null (the
  // courier's news, or an empty box). The amount is, in this order: what was typed, what the
  // courier's notice said (kept on the parcel by shipment-news.ts), and for a whole delivery the
  // parcel's codAmount, the amount the courier was told to collect. A partial delivery has no such
  // fallback: codAmount is for the whole parcel, so with a COD account it must be typed
  async settle(
    tx: Transaction,
    order: OrderRow,
    invoiceId: string,
    typed: string | null,
    at: DoorStatus,
  ): Promise<void> {
    const door = await this.doorParcel(tx, order.id);
    // No courier (the shop's own rider), or a parcel the courier says came back (mine 28): there is
    // no parcel at the door to keep money on. A typed amount says nothing then
    if (door === null) return;
    const { parcel, codAccountId } = door;
    // Delivered once: a parcel with its receipt keeps it and its amount (0081's receipt_kept)
    if (parcel.receiptId !== null) return;
    const collected =
      typed ?? parcel.collectedAmount ?? (at === 'delivered' ? parcel.codAmount : null);
    if (collected === null && codAccountId !== null) throw collectedRequired();
    // Never more than the courier was told to collect (mine 15)
    if (collected !== null && compareMoney(collected, parcel.codAmount) > 0) {
      throw collectedOver(parcel.codAmount);
    }
    // The parcel follows the order (mine 27): a manual parcel always, and an API parcel whose
    // courier's news is late. A receipt links only to a delivered or partly delivered parcel
    const now = new Date();
    const moved = isOpenShipment(parcel.status);
    const status: ShipmentStatus = moved ? at : parcel.status;
    await tx
      .update(storefrontShipments)
      .set({ status, collectedAmount: collected, updatedAt: now })
      .where(
        and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, parcel.id)),
      );
    if (moved) await memberEvent(tx, parcel.id, at, now);
    // No COD account (decision 2: the cash is a receipt typed by hand, as before 28b), or nothing
    // collected (paid online, or the shopper paid nothing at the door): no receipt
    if (codAccountId === null || collected === null || isZeroMoney(collected)) return;

    try {
      await tx.transaction((inner) =>
        this.make(inner, order, { ...parcel, status, collectedAmount: collected }, invoiceId),
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.logger.warn(`Shop order ${order.id}: its COD receipt was refused (${error.code})`);
      await this.keepError(tx, order, door, error.code);
    }
  }

  // "Make the receipt" (StorefrontOrdersService.makeCodReceipt): a delivered parcel whose receipt
  // failed, in the member's transaction. Throws the receipt's own AppError when it is refused
  // again; the caller keeps that code in a transaction of its own, as for a payment's receipt
  async retry(tx: Transaction, order: OrderRow, shipmentId: string): Promise<void> {
    const [parcel] = await tx
      .select()
      .from(storefrontShipments)
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.id, shipmentId),
          eq(storefrontShipments.orderId, order.id),
        ),
      )
      .for('update');
    if (
      parcel?.receiptError == null ||
      parcel.receiptId !== null ||
      parcel.collectedAmount === null ||
      order.invoiceId === null
    ) {
      throw new AppError(
        409,
        'storefront_cod_receipt_not_failed',
        'This parcel’s COD receipt did not fail. Reload the page.',
      );
    }
    await this.make(tx, order, parcel, order.invoiceId);
  }

  // The receipt, linked to the parcel and applied to the invoice. The parcel's collected amount
  // is written already (0081's receipt_match compares it with the receipt's amount)
  private async make(
    tx: Transaction,
    order: OrderRow,
    parcel: ParcelRow,
    invoiceId: string,
  ): Promise<void> {
    const tenantId = getTenantId();
    if (order.salesOrderId === null || parcel.collectedAmount === null) {
      throw new Error(`Parcel ${parcel.id} has no sales order or nothing collected`);
    }
    // The COD account the account names now: one archived since is refused by the receipt's own
    // check (assertMoneyAccount: receipt_account_invalid), which the order page shows
    const [account] = await tx
      .select({ codAccountId: courierAccounts.codAccountId, name: courierAccounts.name })
      .from(courierAccounts)
      .where(
        and(
          eq(courierAccounts.tenantId, tenantId),
          eq(courierAccounts.id, parcel.courierAccountId),
        ),
      )
      .for('share');
    if (account?.codAccountId == null) {
      throw new AppError(
        409,
        'receipt_account_invalid',
        'This courier account has no COD account now. Pick one on Shop couriers.',
      );
    }
    // The customer and the branch of the sales order, as for a payment's receipt (27d)
    const [salesOrder] = await tx
      .select({ customerId: salesOrders.customerId, branchId: warehouses.branchId })
      .from(salesOrders)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, salesOrders.tenantId),
          eq(warehouses.id, salesOrders.warehouseId),
        ),
      )
      .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, order.salesOrderId)));
    if (salesOrder === undefined) throw new Error(`Sales order ${order.salesOrderId} is missing`);
    const receiptId = await this.receipts.createForShop(
      tx,
      {
        customerId: salesOrder.customerId,
        // The day it is made: the delivery's day, or a retry's in an open period
        date: await workspaceToday(tx),
        amount: parcel.collectedAmount,
        accountId: account.codAccountId,
        method: 'courier',
        // The courier's code, which its payout statement lists (step 28c's matching), else ours
        reference: (parcel.trackingCode ?? parcel.invoice).slice(0, 60),
        branchId: salesOrder.branchId,
        note: `COD for shop order ${order.orderNo ?? ''} (${account.name} ${parcel.invoice})`,
        allocations: [],
      },
      null,
    );
    // The receipt and no error, in one UPDATE (0080's check: never both)
    await tx
      .update(storefrontShipments)
      .set({ receiptId, receiptError: null, updatedAt: new Date() })
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, parcel.id)),
      );
    // As much as the invoice still owes, after any payment made online (decision 6): a rider who
    // collected more than is owed leaves an advance, one who collected less leaves the invoice
    // partly paid
    await this.receipts.applyIn(tx, receiptId, invoiceId);
  }

  // The refusal on the parcel, and the bell (mine 19): the courier's news delivered the order with
  // nobody there to see it. One bell per parcel (its id is the event): a retry that fails again is
  // seen by the member who pressed it
  private async keepError(
    tx: Transaction,
    order: OrderRow,
    door: DoorParcel,
    code: string,
  ): Promise<void> {
    await tx
      .update(storefrontShipments)
      .set({ receiptError: code })
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.id, door.parcel.id),
        ),
      );
    if (order.orderNo === null) return;
    for (const member of await membersWhoMay(tx, 'storefront.order.manage')) {
      await notify(tx, {
        userId: member.userId,
        type: 'storefront.cod_receipt_failed',
        params: { id: order.id, number: order.orderNo, courier: door.accountName },
        eventId: door.parcel.id,
      });
    }
  }

  // The order's newest parcel the courier took: not one still booking or failed (the courier never
  // had it), not a cancelled booking, and not one the courier says came back (mine 28). Locked:
  // the order is locked already, so this waits for nobody
  private async doorParcel(tx: Transaction, orderId: string): Promise<DoorParcel | null> {
    const [row] = await tx
      .select({
        parcel: storefrontShipments,
        accountName: courierAccounts.name,
        codAccountId: courierAccounts.codAccountId,
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
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.orderId, orderId),
          notInArray(storefrontShipments.status, [
            'booking',
            'booking_failed',
            'cancelled',
            'returned',
          ]),
        ),
      )
      .orderBy(desc(storefrontShipments.parcelNo))
      .limit(1)
      .for('update', { of: storefrontShipments });
    return row ?? null;
  }
}
