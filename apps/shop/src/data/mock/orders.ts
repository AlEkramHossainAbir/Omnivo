import {
  compareMoney,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_TRIES,
  type ShopCartQuote,
  type ShopCheckoutSettings,
  type ShopCodeResent,
  type ShopOrder,
  type ShopOrderConfirmed,
  type ShopOrderLine,
  type ShopOrderRequest,
} from '@omnivo/contracts';

import type { PlacedOrder, ShopCodeWait, SourceResult } from '../types';

// Step 26c: the mock's orders, kept in memory (decision 3). Everything here is what step 26's API
// will do with tables; the shape of the answers is the same, so the pages never change.

// The code the mock takes. It sends no SMS, so the verify page shows it (ShopSource.testCode)
export const MOCK_CODE = '123456';

// How long an order waits for its code: the system design's stock hold (60 minutes, §14.4). After
// that it is dropped, and the checkout cookie with the same life is gone too
const WAIT_MS = 60 * 60 * 1000;

interface MockOrder {
  token: string;
  order: ShopOrder;
  // Only while it waits for the code
  wrongCodes: number;
  resendAt: number;
  expiresAt: number;
}

// A token nobody can guess: 32 random bytes as 64 hex digits. Web Crypto, not node:crypto, so it
// runs wherever the shop's server runs (Node today, a worker runtime maybe later)
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// "01786120356" → "+880 17•• ••• 356". The first two digits say the operator and the last three
// let the shopper see it is their number; the rest stays off a screenshot
export function maskPhone(phone: string): string {
  return `+880 ${phone.slice(1, 3)}•• ••• ${phone.slice(-3)}`;
}

// W-000123: W for web, so a shop order is never mistaken for an ERP sales order (decision 3)
function orderNumber(sequence: number): string {
  return `W-${String(sequence).padStart(6, '0')}`;
}

// One order book per mock source. `now` is passed in so the tests can move time; the real clock
// otherwise
export function createOrderBook(now: () => Date = () => new Date()) {
  const byToken = new Map<string, MockOrder>();
  let sequence = 0;

  function secondsUntil(at: number): number {
    return Math.max(0, Math.ceil((at - now().getTime()) / 1000));
  }

  // The order that waits for a code under this token, or nothing. One past its hour is dropped
  // here, when someone asks for it, so the mock needs no timer
  function waiting(token: string): MockOrder | null {
    const entry = byToken.get(token);
    // A confirmed order, or none under this token: nothing waits
    if (entry?.order.status !== 'pending') return null;
    if (entry.expiresAt <= now().getTime()) {
      byToken.delete(token);
      return null;
    }
    return entry;
  }

  function confirm(entry: MockOrder): ShopOrderConfirmed {
    const at = now().toISOString();
    entry.order.status = 'confirmed';
    entry.order.history.push({ status: 'confirmed', at });
    return { orderNo: entry.order.orderNo, phone: entry.order.phone };
  }

  return {
    // Confirm Order. `quote` is the cart priced again on the server from the request's own lines,
    // zone and coupon; this only decides whether the order may be placed with it
    place(
      request: ShopOrderRequest,
      quote: ShopCartQuote,
      settings: ShopCheckoutSettings,
    ): SourceResult<PlacedOrder> {
      const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
      if (!zone) return { ok: false, code: 'shop_zone_unknown' };
      if (!settings.paymentMethods.includes(request.paymentMethod)) {
        return { ok: false, code: 'shop_payment_unavailable' };
      }

      // Every line must be sold as it is in the cart. A line out of stock or gone since the last
      // quote would leave the shopper with less than they chose, so the order is refused, and the
      // checkout prices the cart again and shows what changed (decision 10)
      const lines: ShopOrderLine[] = [];
      for (const line of quote.lines) {
        if (line.status !== 'available') return { ok: false, code: 'shop_order_changed' };
        lines.push({
          listingId: line.listingId,
          slug: line.slug,
          name: line.name,
          packSize: line.packSize,
          image: line.image,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        });
      }
      if (quote.belowMinimum && settings.minimumOrder !== null) {
        return {
          ok: false,
          code: 'shop_order_below_minimum',
          params: { minimum: settings.minimumOrder },
        };
      }
      // The zone was found, so the quote has its charge; `?? '0'` only satisfies the type
      const deliveryCharge = quote.deliveryCharge ?? '0';
      if (compareMoney(quote.total, request.expectedTotal) !== 0) {
        return { ok: false, code: 'shop_order_changed' };
      }

      // Orders that never got their code are dropped once their hour is over. Done here, on the
      // way in, so a script that places orders all day cannot fill the server's memory with them
      for (const [key, waitingEntry] of byToken) {
        if (waitingEntry.order.status === 'pending' && waitingEntry.expiresAt <= now().getTime()) {
          byToken.delete(key);
        }
      }

      sequence += 1;
      const placedAt = now();
      const token = newToken();
      const order: ShopOrder = {
        orderNo: orderNumber(sequence),
        placedAt: placedAt.toISOString(),
        status: 'pending',
        history: [{ status: 'pending', at: placedAt.toISOString() }],
        name: request.name,
        phone: request.phone,
        address: request.address,
        zoneName: zone.name,
        paymentMethod: request.paymentMethod,
        lines,
        subtotal: quote.subtotal,
        discount: quote.discount,
        // A refused code is not kept: the order says only what took money off
        couponCode: quote.coupon.status === 'applied' ? quote.coupon.code : null,
        deliveryCharge,
        total: quote.total,
      };
      const entry: MockOrder = {
        token,
        order,
        wrongCodes: 0,
        // The first code was "sent" just now, so a new one waits the same 45 seconds
        resendAt: placedAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000,
        expiresAt: placedAt.getTime() + WAIT_MS,
      };
      byToken.set(token, entry);

      // Mobile Banking needs no code in the mock (decision 4): confirmed at once
      if (request.paymentMethod === 'online') {
        const confirmed = confirm(entry);
        return {
          ok: true,
          value: { answer: { next: 'confirmed', ...confirmed }, orderNo: order.orderNo, token },
        };
      }
      return {
        ok: true,
        value: {
          answer: {
            next: 'verify',
            maskedPhone: maskPhone(order.phone),
            resendInSeconds: SHOP_CODE_RESEND_SECONDS,
          },
          orderNo: order.orderNo,
          token,
        },
      };
    },

    codeWait(token: string): ShopCodeWait | null {
      const entry = waiting(token);
      if (!entry) return null;
      return {
        next: 'verify',
        maskedPhone: maskPhone(entry.order.phone),
        resendInSeconds: secondsUntil(entry.resendAt),
        listingIds: entry.order.lines.map((line) => line.listingId),
      };
    },

    verify(token: string, code: string): SourceResult<ShopOrderConfirmed> {
      const entry = waiting(token);
      if (!entry) return { ok: false, code: 'shop_code_no_order' };
      if (code === MOCK_CODE) return { ok: true, value: confirm(entry) };

      entry.wrongCodes += 1;
      // The fifth wrong code drops the order: guessing six digits five times has a 1 in 200,000
      // chance, and the shopper starts again with a new order and a new code (decision 4)
      if (entry.wrongCodes >= SHOP_CODE_TRIES) {
        byToken.delete(token);
        return { ok: false, code: 'shop_code_too_many' };
      }
      return {
        ok: false,
        code: 'shop_code_wrong',
        params: { triesLeft: SHOP_CODE_TRIES - entry.wrongCodes },
      };
    },

    resend(token: string): SourceResult<ShopCodeResent> {
      const entry = waiting(token);
      if (!entry) return { ok: false, code: 'shop_code_no_order' };
      const wait = secondsUntil(entry.resendAt);
      // Every SMS costs the shop money, and a page that resends on every click could be used to
      // flood someone's phone. The wait is the server's; the button's countdown only shows it
      if (wait > 0) return { ok: false, code: 'shop_code_resend_wait', params: { seconds: wait } };
      entry.resendAt = now().getTime() + SHOP_CODE_RESEND_SECONDS * 1000;
      // The wrong codes are not forgiven: a new SMS must not give a guesser five more tries
      return { ok: true, value: { resendInSeconds: SHOP_CODE_RESEND_SECONDS } };
    },

    // Decision 5: the number and the token must belong together, and only a confirmed order is
    // shown. An order still waiting for its code is not one yet
    find(orderNo: string, token: string): ShopOrder | null {
      const entry = byToken.get(token);
      if (entry?.order.orderNo !== orderNo || entry.order.status === 'pending') return null;
      // A copy: the page that draws it must not be able to change the book
      return structuredClone(entry.order);
    },
  };
}

export type MockOrderBook = ReturnType<typeof createOrderBook>;
