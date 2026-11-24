import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  maskPhone,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_TRIES,
  SHOP_CODE_VALID_MINUTES,
  SHOP_ORDER_HOLD_MINUTES,
  SHOP_PAYMENT_TRIES,
  type ShopCodeWait,
  type ShopPaymentProblem,
  type ShopPaymentRetry,
  type ShopPaymentSettled,
  type ShopPaymentSettleRequest,
  type ShopPaymentWait,
} from '@omnivo/contracts';
import { storefrontOrderLines, storefrontOrders, storefrontPayments } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { notFound } from '../../common/http/app-error.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, PAYMENT_GATEWAY } from '../../infra/tokens.js';
import type { GatewayAnswer, PaymentGateway } from '../../payments/gateway.js';
import { codeSms, confirmedSms } from '../../sms/shop-sms.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { GatewayAccounts } from '../gateway-accounts.js';
import { checkoutSettingsOf } from '../public-storefront.service.js';
import { ShopDb, type ShopScope } from '../shop-db.js';
import { shopUrl } from '../shop-url.js';
import { codeHash, newCode, tokenHash } from './order-secrets.js';
import { PaymentPages, tryValues } from './payment-pages.js';
import { type PaymentRow, type SettleResult, settleLocked } from './payment-settle.js';
import { minutesAfter, refused, shopWords, waitingOrder } from './shop-orders.service.js';

type OrderRow = typeof storefrontOrders.$inferSelect;

function noPaymentOrder() {
  return refused(404, 'shop_payment_no_order', 'No online order waits for its payment here.');
}

function settledAlready() {
  return refused(409, 'shop_payment_settled', 'The order is paid, or it is cash on delivery now.');
}

// The words /checkout/paid uses for a try that did not pay
const PROBLEM_OF = {
  not_opened: 'not_opened',
  failed: 'failed',
  cancelled: 'cancelled',
  started: 'not_finished',
} as const satisfies Record<Exclude<PaymentRow['status'], 'paid'>, ShopPaymentProblem>;

// Step 27d: the four 'shop' routes of paying online (27d.1) and the gateway's answers. Like the
// phone code's routes, every write runs inside ShopDb.orders as omnivo_shop, and the gateway is
// asked outside any transaction, so no lock waits for SSLCommerz. The gateway account is read
// as omnivo_app (GatewayAccounts), because the shop's roles may not read it.
@Injectable()
export class ShopPaymentsService {
  private readonly logger = new Logger(ShopPaymentsService.name);

  constructor(
    private readonly shopDb: ShopDb,
    private readonly accounts: GatewayAccounts,
    private readonly pages: PaymentPages,
    private readonly sms: SmsQueue,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  // The return path and the notice (decision 2). Unknown tran_id: 404, as the contract says. The
  // API answers only the status: the shop's return path then sends the browser to /checkout/paid,
  // which asks paymentWait with the cookie
  async settle(
    host: string | undefined,
    { tranId, valId }: ShopPaymentSettleRequest,
  ): Promise<ShopPaymentSettled> {
    const found = await this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [payment] = await tx
          .select()
          .from(storefrontPayments)
          .where(
            and(
              eq(storefrontPayments.tenantId, shop.tenantId),
              eq(storefrontPayments.tranId, tranId),
            ),
          );
        return payment === undefined ? null : { payment, tenantId: shop.tenantId };
      },
      { readOnly: true },
    );
    if (found === null) {
      // The order was dropped (the sweep, five wrong codes after "Pay on delivery") or the id was
      // made up. Logged with the id, so money that arrived for a dropped order can be found in
      // SSLCommerz's panel and paid back (mine)
      this.logger.warn(`The gateway came back for an unknown tran_id ${tranId}`);
      throw notFound('Payment');
    }
    if (found.payment.status === 'paid') return { status: 'paid' };
    const answer = await this.ask(found.tenantId, found.payment, valId);
    const result = await this.record(host, found.payment.id, answer);
    return { status: result?.status ?? found.payment.status };
  }

  // /checkout/paid (27d.1's shopPaymentWaitSchema). A try that is still started is asked about
  // first: the shopper may come back with the Back button, before or instead of the gateway's post
  async wait(host: string | undefined, token: string, asked = false): Promise<ShopPaymentWait> {
    const view = await this.shopDb.orders(host, (tx, shop) => this.view(tx, shop, token), {
      readOnly: true,
    });
    if (view === null) throw noPaymentOrder();
    const { order, payments, listingIds, payOnDelivery, now } = view;
    if (order.status !== 'pending') {
      // Confirmed by a payment: the page shows "Order Confirmed". An order confirmed by its phone
      // code is the verify page's, not this one's
      if (order.orderNo === null || !payments.some((payment) => payment.status === 'paid')) {
        throw noPaymentOrder();
      }
      return { state: 'paid', orderNo: order.orderNo, phone: order.phone, listingIds };
    }
    // An order that became Cash on Delivery waits for its code on /checkout/verify; one past its
    // hold can no longer be paid from here (a payment already on its way still settles it)
    if (
      order.paymentMethod !== 'online' ||
      order.createdAt <= minutesAfter(now, -SHOP_ORDER_HOLD_MINUTES)
    ) {
      throw noPaymentOrder();
    }
    const last = payments.at(-1);
    if (last?.status === 'started' && !asked) {
      const answer = await this.ask(order.tenantId, last, null);
      if (
        answer.kind === 'pending' ||
        (answer.kind === 'problem' && answer.problem === 'unreachable')
      ) {
        return { state: 'checking' };
      }
      const result = await this.record(host, last.id, answer);
      // Something changed: draw the page from the rows again, once
      if (result !== null && result.status !== 'started') return this.wait(host, token, true);
    }
    // A pending order's last try is never paid (a paid try confirms it in the same transaction);
    // an online order always has its first try (place order writes both together)
    const status = last === undefined || last.status === 'paid' ? 'started' : last.status;
    return {
      state: 'unpaid',
      problem: PROBLEM_OF[status],
      triesLeft: Math.max(0, SHOP_PAYMENT_TRIES - payments.length),
      payOnDelivery,
      total: order.total,
    };
  }

  // "Try again" (decision 3): a new try for the same order and hold
  async retry(host: string | undefined, token: string): Promise<ShopPaymentRetry> {
    const scope = await this.shopDb.read(host, (_tx, shop) => Promise.resolve(shop));
    const account = await this.accounts.open(scope.tenantId);
    let made: { payment: PaymentRow; order: OrderRow; items: number; shopName: string };
    try {
      made = await this.shopDb.orders(host, async (tx, shop) => {
        const order = await waitingOrder(tx, shop, token, { lock: true });
        if (order === undefined) throw noPaymentOrder();
        if (order.paymentMethod !== 'online') throw settledAlready();
        const payments = await this.paymentsOf(tx, shop, order.id);
        if (payments.some((payment) => payment.status === 'paid')) throw settledAlready();
        if (payments.length >= SHOP_PAYMENT_TRIES) {
          throw refused(422, 'shop_payment_tries_used', 'This order has used all its tries.');
        }
        // The gateway was removed from the shop, or its password no longer opens: a page could
        // not open, so no try is spent on it
        const settings = await checkoutSettingsOf(tx, shop);
        if (account === null || !settings.paymentMethods.includes('online')) {
          throw refused(
            422,
            'shop_payment_unavailable',
            'The shop does not take this payment now.',
          );
        }
        const [payment] = await tx
          .insert(storefrontPayments)
          .values(
            tryValues(shop.tenantId, order.id, payments.length + 1, order.total, account, shop.now),
          )
          .returning();
        if (payment === undefined) throw new Error('The payment try was not written');
        return {
          payment,
          order,
          items: await this.itemsOf(tx, shop, order.id),
          shopName: (await shopWords(tx, shop)).name,
        };
      });
    } catch (error) {
      // Two "Try again" at once wait for each other on the order's lock, so the second counts the
      // first one's try; the unique key is the database's word on it all the same (27d.2)
      if (isUniqueViolation(error, 'storefront_payments_try_key')) throw settledAlready();
      throw error;
    }
    // account is not null here: the transaction refused the request otherwise
    if (account === null) throw new Error('The gateway account went away');
    const paymentUrl = await this.pages.open(host, scope.subdomain, account, made.payment, {
      customerName: made.order.customerName,
      phone: made.order.phone,
      address: made.order.address,
      zoneName: made.order.zoneName,
      items: made.items,
      shopName: made.shopName,
    });
    return { paymentUrl };
  }

  // "Pay on delivery" (decision 3): the order becomes Cash on Delivery and gets its phone code.
  // A try that is still on its way may pay later all the same; settle then confirms the order as
  // online (payment-settle.ts)
  async payOnDelivery(host: string | undefined, token: string): Promise<ShopCodeWait> {
    const code = newCode();
    const result = await this.shopDb.orders(host, async (tx, shop) => {
      const order = await waitingOrder(tx, shop, token, { lock: true });
      if (order === undefined) throw noPaymentOrder();
      const listingIds = (await this.linesOf(tx, shop, order.id)).map((line) => line.listingId);
      // A second press (a double click, the Back button): it is Cash on Delivery already, and its
      // code went out. The answer is the verify page's again, with no new SMS
      if (order.paymentMethod === 'cod' && order.codeSentAt !== null) {
        return { sent: false as const, order, listingIds, words: null };
      }
      const payments = await this.paymentsOf(tx, shop, order.id);
      if (payments.some((payment) => payment.status === 'paid')) throw settledAlready();
      const settings = await checkoutSettingsOf(tx, shop);
      if (!settings.paymentMethods.includes('cod')) {
        throw refused(422, 'shop_payment_unavailable', 'The shop does not take cash on delivery.');
      }
      // The method and every code column in one UPDATE: storefront_orders_pending_check wants a
      // pending Cash on Delivery order with all five (27d.2)
      await tx
        .update(storefrontOrders)
        .set({
          paymentMethod: 'cod',
          codeHash: codeHash(this.config.storefront.codeKey, order.orderTokenHash, code),
          codeSentAt: shop.now,
          codeExpiresAt: minutesAfter(shop.now, SHOP_CODE_VALID_MINUTES),
          codeSends: 1,
          codeTriesLeft: SHOP_CODE_TRIES,
          version: sql`${storefrontOrders.version} + 1`,
        })
        .where(
          and(eq(storefrontOrders.tenantId, shop.tenantId), eq(storefrontOrders.id, order.id)),
        );
      return { sent: true as const, order, listingIds, words: await shopWords(tx, shop) };
    });
    if (result.sent) {
      await this.sms.send({
        to: result.order.phone,
        text: codeSms(result.words.language, result.words.name, code),
      });
    }
    return {
      next: 'verify',
      maskedPhone: maskPhone(result.order.phone),
      resendInSeconds: SHOP_CODE_RESEND_SECONDS,
      listingIds: result.listingIds,
    };
  }

  // What the gateway says about a try: by the val_id when the post brought one (the paid case),
  // else by our tran_id (a failed or cancelled try, or none). A val_id that is not a payment
  // (INVALID_TRANSACTION) is asked about by tran_id too. No account to ask with (the password does
  // not open): a problem the gateway's refusal stands for, so the shopper is not left "checking"
  async ask(tenantId: string, payment: PaymentRow, valId: string | null): Promise<GatewayAnswer> {
    const account = await this.accounts.open(tenantId, payment.mode);
    if (account === null) return { kind: 'problem', problem: 'rejected' };
    if (valId !== null) {
      const answer = await this.gateway.validate(account, valId);
      if (answer.kind !== 'none') return answer;
    }
    return this.gateway.find(account, payment.tranId);
  }

  // Records the answer as omnivo_shop, then sends the confirm SMS when this call confirmed the
  // order, after the commit (as a right phone code does)
  private async record(
    host: string | undefined,
    paymentId: string,
    answer: GatewayAnswer,
  ): Promise<SettleResult | null> {
    const result = await this.shopDb.orders(host, async (tx, shop) => {
      const settled = await settleLocked(
        tx,
        shop.tenantId,
        paymentId,
        answer,
        shop.now,
        this.logger,
      );
      return settled === null
        ? null
        : { settled, words: settled.confirmed === null ? null : await shopWords(tx, shop), shop };
    });
    if (result === null) return null;
    const { settled, words, shop } = result;
    if (settled.confirmed !== null && words !== null) {
      const link = shopUrl(
        this.config.storefront,
        shop.subdomain,
        `/t/${settled.confirmed.trackingToken}`,
      );
      await this.sms.send({
        to: settled.confirmed.phone,
        text: confirmedSms(words.language, words.name, settled.confirmed.orderNo, link),
      });
    }
    return settled;
  }

  // The order this browser's cookie names, in any status, with its tries, its listings and
  // whether the shop takes cash on delivery now
  private async view(tx: Transaction, shop: ShopScope, token: string) {
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(
        and(
          eq(storefrontOrders.tenantId, shop.tenantId),
          eq(storefrontOrders.orderTokenHash, tokenHash(token)),
        ),
      );
    if (order === undefined) return null;
    const settings = await checkoutSettingsOf(tx, shop);
    return {
      order,
      payments: await this.paymentsOf(tx, shop, order.id),
      listingIds: (await this.linesOf(tx, shop, order.id)).map((line) => line.listingId),
      payOnDelivery: settings.paymentMethods.includes('cod'),
      now: shop.now,
    };
  }

  private paymentsOf(tx: Transaction, shop: ShopScope, orderId: string) {
    return tx
      .select()
      .from(storefrontPayments)
      .where(
        and(
          eq(storefrontPayments.tenantId, shop.tenantId),
          eq(storefrontPayments.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontPayments.tryNo));
  }

  private linesOf(tx: Transaction, shop: ShopScope, orderId: string) {
    return tx
      .select({
        listingId: storefrontOrderLines.listingId,
        quantity: storefrontOrderLines.quantity,
      })
      .from(storefrontOrderLines)
      .where(
        and(
          eq(storefrontOrderLines.tenantId, shop.tenantId),
          eq(storefrontOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
  }

  // The pieces in the order, for the gateway's num_of_item
  private async itemsOf(tx: Transaction, shop: ShopScope, orderId: string): Promise<number> {
    const lines = await this.linesOf(tx, shop, orderId);
    return lines.reduce((sum, line) => sum + line.quantity, 0);
  }
}
