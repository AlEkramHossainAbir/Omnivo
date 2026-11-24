import { Inject, Injectable } from '@nestjs/common';
import { isZeroMoney, type PaymentMethod, subtractMoney } from '@omnivo/contracts';
import {
  ledgerAccounts,
  salesOrders,
  storefrontOrders,
  storefrontPaymentGateways,
  storefrontPayments,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';

import { workspaceToday } from '../../common/db/applied-on.js';
import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { ReceiptsService } from '../../sales/receipts.service.js';
import type { PaymentRow } from './payment-settle.js';

type OrderRow = typeof storefrontOrders.$inferSelect;

// SSLCommerz's card_type says how the shopper paid ("BKASH-BKash", "VISA-Dutch Bangla",
// "DBBLMOBILEB-Dbbl Mobile Banking"). The receipt's method is the nearest of ours: a wallet, a
// card, or else the bank (internet banking). Only the words before the dash are read
const WALLETS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'MCASH', 'TCASH', 'DBBLMOBILEB', 'OKWALLET'];
const CARDS = ['VISA', 'MASTER', 'AMEX', 'UNIONPAY', 'NEXUS', 'DBBL', 'QCASH'];

export function receiptMethodOf(cardType: string | null): PaymentMethod {
  const brand = (cardType ?? '').split('-')[0]?.toUpperCase().replace(/\s+/g, '') ?? '';
  if (WALLETS.some((wallet) => brand.startsWith(wallet))) return 'mobile_wallet';
  if (CARDS.some((card) => brand.startsWith(card))) return 'card';
  return 'bank_transfer';
}

// Step 27d (decision 6): a paid try's posted money receipt, with the gateway's fee in its entry,
// made by the worker (payment_paid, and the order's confirm after its sales order) and by "Make
// the receipt" on the order's page. Like 27b's sales order: a refusal by the receipt's own rules
// is kept on the try as its code, and the page's button is the retry.
@Injectable()
export class ShopPaymentReceipts {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly receipts: ReceiptsService,
  ) {}

  // Every paid try of the order that has no receipt and no error yet. Called once the order has
  // its sales order, which names the customer the receipt is for
  async makeAll(orderId: string): Promise<void> {
    const tenantId = getTenantId();
    const waiting = await this.withTenant((tx) =>
      tx
        .select({ id: storefrontPayments.id })
        .from(storefrontPayments)
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontPayments.orderId, orderId),
            eq(storefrontPayments.status, 'paid'),
            isNull(storefrontPayments.receiptId),
            isNull(storefrontPayments.receiptError),
          ),
        )
        .orderBy(asc(storefrontPayments.tryNo)),
    );
    // One transaction each: a second payment's refusal must not take the first one's receipt
    for (const { id } of waiting) await this.makeOne(orderId, id);
  }

  // One try's receipt, in its own transaction, the error kept when the receipt's rules refuse it.
  // Anything else (the database went away) is thrown, and the queue runs the job again
  async makeOne(orderId: string, paymentId: string): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const locked = await this.lock(tx, orderId, paymentId);
        if (locked === null) return;
        const { order, payment } = locked;
        // A second run, a try that is not paid, one whose receipt failed (the page's button makes
        // it), or an order whose sales order is not made yet (its confirm job comes back here)
        if (payment.status !== 'paid' || payment.receiptId !== null) return;
        if (payment.receiptError !== null || order.salesOrderId === null) return;
        await this.makeIn(tx, order, payment);
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.keepError(paymentId, error.code);
    }
  }

  // The order and the try, both locked: the order first, as every writer of its tries does
  // (payment-settle.ts says why)
  async lock(
    tx: Transaction,
    orderId: string,
    paymentId: string,
  ): Promise<{ order: OrderRow; payment: PaymentRow } | null> {
    const tenantId = getTenantId();
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, orderId)))
      .for('update');
    const [payment] = await tx
      .select()
      .from(storefrontPayments)
      .where(
        and(
          eq(storefrontPayments.tenantId, tenantId),
          eq(storefrontPayments.id, paymentId),
          eq(storefrontPayments.orderId, orderId),
        ),
      )
      .for('update');
    return order === undefined || payment === undefined ? null : { order, payment };
  }

  // The receipt itself, in the caller's transaction. The caller holds both locks and has checked
  // that the try is paid with no receipt, and that the order has its sales order. Throws the
  // receipt's own AppError when its rules refuse
  async makeIn(tx: Transaction, order: OrderRow, payment: PaymentRow): Promise<string> {
    const tenantId = getTenantId();
    if (order.salesOrderId === null || payment.storeAmount === null) {
      throw new Error(`Payment ${payment.id} has no sales order or no payout to receive`);
    }
    const [gateway] = await tx
      .select({
        moneyAccountId: storefrontPaymentGateways.moneyAccountId,
        feeAccountId: storefrontPaymentGateways.feeAccountId,
      })
      .from(storefrontPaymentGateways)
      .where(eq(storefrontPaymentGateways.tenantId, tenantId));
    // A paid try always had a gateway (it opened the page), and nothing deletes one (27d.1)
    if (gateway === undefined) {
      throw new AppError(409, 'storefront_gateway_not_set_up', 'Save the payment gateway first.');
    }
    const fee = subtractMoney(payment.amount, payment.storeAmount);
    if (!isZeroMoney(fee)) await this.checkFeeAccount(tx, gateway.feeAccountId);
    // The customer and the branch of the sales order: the invoice at Delivered is for the same
    // customer, so it can take this advance
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
        // The day it is made, in the workspace's time zone: usually the payment's own day (the
        // job runs seconds later), and a retry after a closed period lands in an open one
        date: await workspaceToday(tx),
        amount: payment.amount,
        accountId: gateway.moneyAccountId,
        method: receiptMethodOf(payment.cardType),
        // The bank's or wallet's own number, which the shopper's SMS from bKash shows, and how
        // they paid; the receipt's box holds 60 characters
        reference: [payment.bankTranId ?? payment.tranId, payment.cardType]
          .filter((part) => part !== null)
          .join(' · ')
          .slice(0, 60),
        branchId: salesOrder.branchId,
        note: `Paid online for shop order ${order.orderNo ?? ''} (SSLCommerz ${payment.tranId})`,
        allocations: [],
      },
      isZeroMoney(fee) ? null : { accountId: gateway.feeAccountId, amount: fee },
    );
    await tx
      .update(storefrontPayments)
      .set({ receiptId, receiptError: null })
      .where(and(eq(storefrontPayments.tenantId, tenantId), eq(storefrontPayments.id, payment.id)));
    // Paid after it was delivered (a second payment, or one that came very late): the invoice is
    // there already, so the money goes to it now, as much as it still owes
    if (order.invoiceId !== null) await this.receipts.applyIn(tx, receiptId, order.invoiceId);
    return receiptId;
  }

  // Decision 6: the invoice posted at Delivered takes the advances of the order's paid tries, the
  // oldest first. A second payment (the shopper paid twice) finds nothing left to pay and stays an
  // advance, which the order page says to refund
  async applyToInvoice(tx: Transaction, orderId: string, invoiceId: string): Promise<void> {
    const paid = await tx
      .select({ receiptId: storefrontPayments.receiptId })
      .from(storefrontPayments)
      .where(
        and(
          eq(storefrontPayments.tenantId, getTenantId()),
          eq(storefrontPayments.orderId, orderId),
          isNotNull(storefrontPayments.receiptId),
        ),
      )
      .orderBy(asc(storefrontPayments.tryNo));
    for (const { receiptId } of paid) {
      if (receiptId !== null) await this.receipts.applyIn(tx, receiptId, invoiceId);
    }
  }

  // Kept only while the try has no receipt: the page's retry may have made it in the meantime
  async keepError(paymentId: string, code: string): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      await tx
        .update(storefrontPayments)
        .set({ receiptError: code })
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontPayments.id, paymentId),
            isNull(storefrontPayments.receiptId),
          ),
        );
    });
  }

  // The fee account as storefront_online_ready() wants it: an active expense posting account. One
  // archived after the payment refuses the receipt with the Payment card's own code
  private async checkFeeAccount(tx: Transaction, accountId: string): Promise<void> {
    const [account] = await tx
      .select({
        type: ledgerAccounts.type,
        isGroup: ledgerAccounts.isGroup,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, accountId)))
      .for('share');
    if (account?.type !== 'expense' || account.isGroup || account.archivedAt !== null) {
      throw new AppError(
        409,
        'storefront_gateway_fee_account_invalid',
        'The gateway fee account is no longer an active expense account.',
      );
    }
  }
}
