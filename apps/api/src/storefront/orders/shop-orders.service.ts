import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  type ErrorCode,
  type LanguageCode,
  maskPhone,
  type PublicOrderPlaced,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_SENDS,
  SHOP_CODE_TRIES,
  SHOP_CODE_VALID_MINUTES,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopCodeResent,
  type ShopCodeWait,
  type ShopOrder,
  type ShopOrderConfirmed,
  type ShopOrderRequest,
  type ShopTracking,
  type ShopTrackRequest,
} from '@omnivo/contracts';
import {
  storefrontOrderLines,
  storefrontOrders,
  storefrontPayments,
  storefrontSettings,
  storefrontStockHolds,
  storefrontListings,
} from '@omnivo/db';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../../common/http/app-error.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG } from '../../infra/tokens.js';
import { codeSms, confirmedSms } from '../../sms/shop-sms.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { lockedCoupon, markOrdered, usedByPhone } from '../coupon-sql.js';
import { GatewayAccounts } from '../gateway-accounts.js';
import { checkoutSettingsOf, quotedListings } from '../public-storefront.service.js';
import { quoteCart } from '../quote.js';
import { shopShipmentsOf } from '../shipping/shop-shipments.js';
import { ShopDb, type ShopScope } from '../shop-db.js';
import { shopUrl } from '../shop-url.js';
import { confirmPendingOrder } from './confirm-order.js';
import { codeHash, codeMatches, newCode, newToken, tokenHash } from './order-secrets.js';
import { orderOf, type OrderRow, trackingOf } from './order-view.js';
import { PaymentPages, tryValues } from './payment-pages.js';
import { ShopLimits } from './shop-limits.js';

const MINUTE_MS = 60 * 1000;

const uuidSchema = z.uuid();

export function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

// Whole seconds from now until `at`, 0 once it has passed. Rounded up: "wait 0 seconds" would let
// the next try in a moment too early
export function secondsUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

// The answers a shopper can get wrong. Each status as the shop's mock answered it (26c's
// server/orders.ts), so the shop's pages need no change: 409 for "look again, something
// changed", 422 for "this cannot be done", 429 for "wait"
export function refused(
  status: 404 | 409 | 422 | 429,
  code: ErrorCode,
  detail: string,
  params?: Record<string, string | number>,
): AppError {
  return new AppError(status, code, detail, params === undefined ? {} : { params });
}

function noOrder(): AppError {
  return refused(404, 'shop_code_no_order', 'No order waits for a code under this token.');
}

// What the shop's SMS need to know about the shop: its name and language
export interface ShopWords {
  name: string;
  language: LanguageCode;
}

export async function shopWords(tx: Transaction, shop: ShopScope): Promise<ShopWords> {
  const [settings] = await tx
    .select({ name: storefrontSettings.name, language: storefrontSettings.language })
    .from(storefrontSettings)
    .where(eq(storefrontSettings.tenantId, shop.tenantId));
  // ShopDb found the shop through this row a moment ago, in the same transaction
  if (settings === undefined) throw new Error(`storefront_settings missing for ${shop.tenantId}`);
  return settings;
}

// The order that waits for its code under this token, or none. One older than its hold
// (SHOP_ORDER_HOLD_MINUTES) is none, even before the worker's sweep deletes it: its stock is free
// again by then (the holds' expires_at), so it can no longer be confirmed. `lock` takes the row for
// this transaction (FOR UPDATE), so two codes typed at once are checked one after the other, and
// five wrong ones cannot become six
export async function waitingOrder(
  tx: Transaction,
  shop: ShopScope,
  token: string,
  { lock }: { lock: boolean },
): Promise<OrderRow | undefined> {
  const query = tx
    .select()
    .from(storefrontOrders)
    .where(
      and(
        eq(storefrontOrders.tenantId, shop.tenantId),
        eq(storefrontOrders.orderTokenHash, tokenHash(token)),
        eq(storefrontOrders.status, 'pending'),
        gt(storefrontOrders.createdAt, minutesAfter(shop.now, -SHOP_ORDER_HOLD_MINUTES)),
      ),
    );
  const [order] = lock ? await query.for('update') : await query;
  return order;
}

// One variant's lock, for placing an order (27a's decision 6). Two shoppers who order the last
// piece at the same moment are put in a line here: the second one reads the stock only after the
// first one's hold is committed, and finds it gone. A transaction lock: it ends with the
// transaction, so nothing can leave one behind. The key names the workspace and the variant, so
// two shops never wait for each other
async function lockVariant(tx: Transaction, tenantId: string, variantId: string): Promise<void> {
  const key = `storefront-hold:${tenantId}:${variantId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The result of checking a code. A wrong code is written down (one try less, or the order deleted)
// and then refused, so its transaction must commit before the refusal is thrown: a refusal thrown
// inside would roll the count back, and a guesser would get unlimited tries
type CodeCheck =
  | { ok: false; error: AppError }
  | {
      ok: true;
      orderNo: string;
      phone: string;
      trackingToken: string;
      shop: ShopWords;
      subdomain: string;
    };

// Step 27a: the shop's orders, the phone code and tracking (the seven 'shop' routes). Every one
// runs inside ShopDb.orders, as omnivo_shop in the shop's workspace. The SMS go out only after the
// transaction commits (SmsQueue), and only an order's hashes are stored.
@Injectable()
export class ShopOrdersService {
  private readonly mediaUrl: string;

  constructor(
    private readonly shopDb: ShopDb,
    private readonly sms: SmsQueue,
    private readonly limits: ShopLimits,
    private readonly accounts: GatewayAccounts,
    private readonly pages: PaymentPages,
    @Inject(CONFIG) private readonly config: Config,
  ) {
    this.mediaUrl = config.storefront.mediaUrl;
  }

  // Confirm Order (27a's decision 2: Cash on Delivery waits for the phone code). Step 27d: Pay
  // online waits for its payment instead, on the gateway's page
  async place(
    host: string | undefined,
    client: string,
    request: ShopOrderRequest,
  ): Promise<PublicOrderPlaced> {
    // The limits first, before any database work: a script that is over them costs one Redis read
    const wait = await this.limits.orderWait(request.phone, client);
    if (wait > 0) {
      throw refused(429, 'shop_order_limit', 'Too many orders from this phone or connection.', {
        minutes: wait,
      });
    }

    const token = newToken();
    const orderTokenHash = tokenHash(token);
    const code = newCode();
    const online = request.paymentMethod === 'online';
    // Step 27d: the gateway account, before the order's transaction. It is read as omnivo_app (the
    // shop's role may not), and the try's row copies its provider and mode. null: online payment
    // cannot be taken now, which the transaction below refuses
    const account = online
      ? await this.shopDb
          .read(host, (_tx, scope) => Promise.resolve(scope.tenantId))
          .then((tenantId) => this.accounts.open(tenantId))
      : null;

    const placed = await this.shopDb.orders(host, async (tx, scope) => {
      const settings = await checkoutSettingsOf(tx, scope);
      const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
      if (!zone)
        throw refused(422, 'shop_zone_unknown', 'The delivery zone is not one the shop has.');
      // Step 27d: Pay online once the gateway is ready (offeredMethods) and its password opens.
      // checkoutSettingsOf may still list it for a shop that ticked only that
      if (
        !settings.paymentMethods.includes(request.paymentMethod) ||
        (online && account === null)
      ) {
        throw refused(
          422,
          'shop_payment_unavailable',
          'The shop does not take this payment method.',
        );
      }

      // Lock the cart's variants, in one order for everyone (by id), so two orders that share two
      // variants can never each hold one lock and wait for the other's. The listings are read
      // again after the locks, so the free stock below counts every hold committed before them
      const ids = request.lines
        .map((line) => line.listingId)
        .filter((id) => uuidSchema.safeParse(id).success);
      const variants =
        ids.length === 0
          ? []
          : await tx
              .selectDistinct({ variantId: storefrontListings.variantId })
              .from(storefrontListings)
              .where(
                and(
                  eq(storefrontListings.tenantId, scope.tenantId),
                  inArray(storefrontListings.id, ids),
                ),
              )
              .orderBy(asc(storefrontListings.variantId));
      for (const { variantId } of variants) await lockVariant(tx, scope.tenantId, variantId);
      // Step 27c: then the coupon's row, and its uses counted after the lock (lockedCoupon says
      // why in two statements). A second shopper with the same code waits here for the first
      const found = await lockedCoupon(tx, scope, request.couponCode);

      // The order is priced by the quote's own function from the rows a quote reads, so it is
      // exactly what the checkout showed, or it is refused
      const listings = await quotedListings(tx, scope, request.lines, this.mediaUrl);
      const quote = quoteCart(request, listings, settings, found);
      // Every line as it is in the cart: one out of stock or gone since the last quote would leave
      // the shopper with less than they chose (26c's decision 10). The checkout quotes again and
      // shows what changed
      const sold = quote.lines.flatMap((line) => (line.status === 'available' ? [line] : []));
      if (sold.length !== quote.lines.length) {
        throw refused(409, 'shop_order_changed', "The cart's prices or stock changed.");
      }
      if (quote.belowMinimum && settings.minimumOrder !== null) {
        throw refused(422, 'shop_order_below_minimum', "The order is under the shop's minimum.", {
          minimum: settings.minimumOrder,
        });
      }
      // The total the shopper saw. A price or a sale that changed since the last quote shows here
      // Step 27c: so is a coupon the last use of which went to another order a moment ago: the
      // total without it is not the one the shopper saw, and the checkout's new quote says "used
      // up". A code that was refused already in the checkout takes nothing off either way, and the
      // order goes ahead without it (the promo box said why)
      if (compareMoney(quote.total, request.expectedTotal) !== 0) {
        throw refused(409, 'shop_order_changed', "The cart's prices or stock changed.");
      }
      // The coupon the order keeps: only an applied one
      const coupon = quote.coupon.status === 'applied' ? found.coupon : undefined;
      // Once per mobile number, now that the phone is known. A thrown refusal rolls the whole
      // transaction back, so no lock or mark outlives it
      if (
        coupon?.rule.onePerPhone === true &&
        (await usedByPhone(tx, scope, coupon.id, request.phone))
      ) {
        throw refused(
          422,
          'shop_coupon_used_by_phone',
          'This mobile number has an order with this coupon already.',
        );
      }
      if (coupon !== undefined) await markOrdered(tx, scope, coupon.id);

      const [order] = await tx
        .insert(storefrontOrders)
        .values({
          tenantId: scope.tenantId,
          // One clock for the order: ShopDb's. The holds and the code are counted from it too
          createdAt: scope.now,
          updatedAt: scope.now,
          status: 'pending',
          customerName: request.name,
          phone: request.phone,
          address: request.address,
          zoneId: zone.id,
          zoneName: zone.name,
          paymentMethod: request.paymentMethod,
          subtotal: quote.subtotal,
          discount: quote.discount,
          // Step 27c: the id and the code together; the foreign key checks that they are one
          // coupon's, so the order's page and its documents always say the coupon's own code
          couponId: coupon?.id ?? null,
          couponCode: coupon?.rule.code ?? null,
          // The zone was found, so the quote has its charge; `?? '0'` only satisfies the type
          deliveryCharge: quote.deliveryCharge ?? '0',
          total: quote.total,
          orderTokenHash,
          // Step 27d: an online order waits for its payment, not for a code, so it has none of the
          // five code columns (storefront_orders_pending_check, 27d.2)
          ...(online
            ? {}
            : {
                codeHash: codeHash(this.config.storefront.codeKey, orderTokenHash, code),
                codeSentAt: scope.now,
                codeExpiresAt: minutesAfter(scope.now, SHOP_CODE_VALID_MINUTES),
                codeSends: 1,
                codeTriesLeft: SHOP_CODE_TRIES,
              }),
        })
        .returning({ id: storefrontOrders.id });
      // INSERT … RETURNING always gives the row it wrote; the check is for TypeScript
      if (order === undefined) throw new Error('The order was not written');

      const until = minutesAfter(scope.now, SHOP_ORDER_HOLD_MINUTES);
      const rows = sold.map((line, index) => {
        // Every sold line came from a row of `listings` (quoteCart reads nothing else), and every
        // shown listing has a photo (listingRowSchema); the checks are for TypeScript
        const row = listings.get(line.listingId)?.row;
        const image = row?.images[0];
        if (row === undefined || image === undefined) {
          throw new Error(`Listing ${line.listingId} has no row or photo`);
        }
        return { line, row, image, position: index + 1 };
      });
      await tx.insert(storefrontOrderLines).values(
        rows.map(({ line, row, image, position }) => ({
          tenantId: scope.tenantId,
          orderId: order.id,
          position,
          listingId: line.listingId,
          productId: row.product_id,
          variantId: row.variant_id,
          slug: line.slug,
          name: line.name,
          packSize: line.packSize,
          // The listing's first photo as the database keeps it (id and alt), not its address: the
          // address is made when the order is shown, so it follows a later move of the storage
          image,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
      );
      // One hold per line: a listing is one variant (storefront_listings_variant_idx), and a cart
      // has each listing once. In the base unit, like the stock it is taken from
      await tx.insert(storefrontStockHolds).values(
        rows.map(({ line, row }) => ({
          tenantId: scope.tenantId,
          orderId: order.id,
          productId: row.product_id,
          variantId: row.variant_id,
          warehouseId: scope.warehouseId,
          quantity: String(line.quantity),
          expiresAt: until,
        })),
      );
      // Step 27d: the first payment try, in the same transaction as its order: an online order
      // without one could never be paid
      const [payment] =
        account === null
          ? []
          : await tx
              .insert(storefrontPayments)
              .values(tryValues(scope.tenantId, order.id, 1, quote.total, account, scope.now))
              .returning();
      return {
        words: await shopWords(tx, scope),
        payment,
        subdomain: scope.subdomain,
        items: sold.reduce((sum, line) => sum + line.quantity, 0),
        zoneName: zone.name,
      };
    });
    const shop = placed.words;

    // Committed: now it counts
    await this.limits.countOrder(request.phone, client);
    if (placed.payment !== undefined && account !== null) {
      // Pay online: the gateway's page, asked for only now (decision 1). null when it did not
      // open: the shop sends the browser to /checkout/paid, which offers "Try again"
      const paymentUrl = await this.pages.open(host, placed.subdomain, account, placed.payment, {
        customerName: request.name,
        phone: request.phone,
        address: request.address,
        zoneName: placed.zoneName,
        items: placed.items,
        shopName: shop.name,
      });
      return { answer: { next: 'pay', paymentUrl }, token };
    }
    // Cash on Delivery: now the code goes out
    await this.sms.send({ to: request.phone, text: codeSms(shop.language, shop.name, code) });
    return {
      answer: {
        next: 'verify',
        maskedPhone: maskPhone(request.phone),
        resendInSeconds: SHOP_CODE_RESEND_SECONDS,
      },
      token,
    };
  }

  // The verify page's order, by the cookie's token
  codeWait(host: string | undefined, token: string): Promise<ShopCodeWait> {
    return this.shopDb.orders(
      host,
      async (tx, shop) => {
        const order = await waitingOrder(tx, shop, token, { lock: false });
        if (order?.codeSentAt == null) throw noOrder();
        const lines = await tx
          .select({ listingId: storefrontOrderLines.listingId })
          .from(storefrontOrderLines)
          .where(
            and(
              eq(storefrontOrderLines.tenantId, shop.tenantId),
              eq(storefrontOrderLines.orderId, order.id),
            ),
          )
          .orderBy(asc(storefrontOrderLines.position));
        return {
          next: 'verify',
          maskedPhone: maskPhone(order.phone),
          resendInSeconds: secondsUntil(
            new Date(order.codeSentAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000),
            shop.now,
          ),
          listingIds: lines.map((line) => line.listingId),
        };
      },
      { readOnly: true },
    );
  }

  // The six digits (27a's decisions 2 and 7). A right code confirms the order at once
  async verify(host: string | undefined, token: string, code: string): Promise<ShopOrderConfirmed> {
    const result = await this.shopDb.orders(host, (tx, shop) =>
      this.checkCode(tx, shop, token, code),
    );
    if (!result.ok) throw result.error;

    // Committed: the order is confirmed whether or not this SMS goes out. The buyer still has the
    // dialog, and /track with the number and the phone
    const link = shopUrl(this.config.storefront, result.subdomain, `/t/${result.trackingToken}`);
    await this.sms.send({
      to: result.phone,
      text: confirmedSms(result.shop.language, result.shop.name, result.orderNo, link),
    });
    return { orderNo: result.orderNo, phone: result.phone };
  }

  private async checkCode(
    tx: Transaction,
    shop: ShopScope,
    token: string,
    code: string,
  ): Promise<CodeCheck> {
    const order = await waitingOrder(tx, shop, token, { lock: true });
    if (order?.codeHash == null || order.codeExpiresAt === null || order.codeTriesLeft === null) {
      return { ok: false, error: noOrder() };
    }
    const where = and(
      eq(storefrontOrders.tenantId, shop.tenantId),
      eq(storefrontOrders.id, order.id),
    );

    // A code past its 10 minutes is refused before it is compared: it cannot be right any more,
    // so it costs no try. The shopper asks for a new one, which the verify page offers below
    if (order.codeExpiresAt <= shop.now) {
      return {
        ok: false,
        error: refused(422, 'shop_code_expired', 'The code has expired. Ask for a new one.'),
      };
    }

    if (!codeMatches(this.config.storefront.codeKey, order.orderTokenHash, code, order.codeHash)) {
      const triesLeft = order.codeTriesLeft - 1;
      // The fifth wrong code drops the order (27a's decision 19): five guesses at six digits have
      // a 1 in 200,000 chance. Its lines and holds go with it (ON DELETE CASCADE), so its stock is
      // free again in this same statement
      if (triesLeft === 0) {
        await tx.delete(storefrontOrders).where(where);
        return {
          ok: false,
          error: refused(422, 'shop_code_too_many', 'Too many wrong codes; the order was dropped.'),
        };
      }
      await tx
        .update(storefrontOrders)
        .set({ codeTriesLeft: triesLeft, version: sql`${storefrontOrders.version} + 1` })
        .where(where);
      return {
        ok: false,
        error: refused(422, 'shop_code_wrong', 'The code is wrong.', { triesLeft }),
      };
    }

    const { orderNo, trackingToken } = await confirmPendingOrder(
      tx,
      shop.tenantId,
      order.id,
      shop.now,
    );

    return {
      ok: true,
      orderNo,
      phone: order.phone,
      trackingToken,
      shop: await shopWords(tx, shop),
      subdomain: shop.subdomain,
    };
  }

  // "Resend code" (27a's decision 7): after SHOP_CODE_RESEND_SECONDS, at most SHOP_CODE_SENDS in
  // all. The wrong codes are not forgiven: a new SMS must not give a guesser five more tries
  async resend(host: string | undefined, token: string): Promise<ShopCodeResent> {
    const code = newCode();
    const sent = await this.shopDb.orders(host, async (tx, shop) => {
      const order = await waitingOrder(tx, shop, token, { lock: true });
      if (order?.codeSentAt == null || order.codeSends === null) throw noOrder();
      // All codes used: no wait would help, so this comes before the wait
      if (order.codeSends >= SHOP_CODE_SENDS) {
        throw refused(422, 'shop_code_sends_used', 'This order has had all its codes.');
      }
      const wait = secondsUntil(
        new Date(order.codeSentAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000),
        shop.now,
      );
      if (wait > 0) {
        throw refused(429, 'shop_code_resend_wait', 'A new code cannot be sent yet.', {
          seconds: wait,
        });
      }
      // The new code replaces the old one: only the last SMS works
      await tx
        .update(storefrontOrders)
        .set({
          codeHash: codeHash(this.config.storefront.codeKey, order.orderTokenHash, code),
          codeSentAt: shop.now,
          codeExpiresAt: minutesAfter(shop.now, SHOP_CODE_VALID_MINUTES),
          codeSends: order.codeSends + 1,
          version: sql`${storefrontOrders.version} + 1`,
        })
        .where(
          and(eq(storefrontOrders.tenantId, shop.tenantId), eq(storefrontOrders.id, order.id)),
        );
      return { phone: order.phone, shop: await shopWords(tx, shop) };
    });
    await this.sms.send({
      to: sent.phone,
      text: codeSms(sent.shop.language, sent.shop.name, code),
    });
    return { resendInSeconds: SHOP_CODE_RESEND_SECONDS };
  }

  // /order/<no>: the number and the cookie's token must belong to one confirmed order (26c's
  // decision 5). Anything else is the same 404, so a guess learns nothing
  find(host: string | undefined, orderNo: string, token: string): Promise<ShopOrder> {
    return this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(
            and(
              eq(storefrontOrders.tenantId, shop.tenantId),
              eq(storefrontOrders.orderNo, orderNo),
              eq(storefrontOrders.orderTokenHash, tokenHash(token)),
              ne(storefrontOrders.status, 'pending'),
            ),
          );
        if (order === undefined) throw notFound('Order');
        return orderOf(order, await this.linesOf(tx, shop, order.id), this.mediaUrl);
      },
      { readOnly: true },
    );
  }

  // A tracking link. Only a confirmed order has a tracking hash (storefront_orders_pending_check)
  tracking(host: string | undefined, token: string): Promise<ShopTracking> {
    return this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(
            and(
              eq(storefrontOrders.tenantId, shop.tenantId),
              eq(storefrontOrders.trackingTokenHash, tokenHash(token)),
            ),
          );
        if (order === undefined) throw notFound('Order');
        return trackingOf(
          order,
          await this.linesOf(tx, shop, order.id),
          await shopShipmentsOf(tx, shop.tenantId, order.id),
        );
      },
      { readOnly: true },
    );
  }

  // The /track form (26e). The limit first: once it is reached nothing is looked up, so a guesser
  // learns nothing more until the window ends. Only a miss counts (26e's decision 3)
  async track(
    host: string | undefined,
    client: string,
    { phone, orderNo }: ShopTrackRequest,
  ): Promise<ShopTracking> {
    const wait = await this.limits.trackWait(client);
    if (wait > 0) {
      throw refused(429, 'shop_track_too_many', 'Too many tries from this connection.', {
        minutes: wait,
      });
    }
    const tracking = await this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(
            and(
              eq(storefrontOrders.tenantId, shop.tenantId),
              eq(storefrontOrders.orderNo, orderNo),
              eq(storefrontOrders.phone, phone),
              ne(storefrontOrders.status, 'pending'),
            ),
          );
        return order === undefined
          ? null
          : trackingOf(
              order,
              await this.linesOf(tx, shop, order.id),
              await shopShipmentsOf(tx, shop.tenantId, order.id),
            );
      },
      { readOnly: true },
    );
    if (tracking === null) {
      await this.limits.trackMiss(client);
      // One answer for a wrong number and a wrong phone: the form never says which
      throw refused(404, 'shop_track_not_found', 'No order has this number and mobile number.');
    }
    return tracking;
  }

  private linesOf(tx: Transaction, shop: ShopScope, orderId: string) {
    return tx
      .select()
      .from(storefrontOrderLines)
      .where(
        and(
          eq(storefrontOrderLines.tenantId, shop.tenantId),
          eq(storefrontOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
  }
}
