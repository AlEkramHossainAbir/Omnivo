import {
  compareMoney,
  maskPhone,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_SENDS,
  SHOP_CODE_TRIES,
  SHOP_CODE_VALID_MINUTES,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopCartQuote,
  type ShopCheckoutSettings,
  type ShopCodeResent,
  type ShopCodeWait,
  type ShopCouponRule,
  type ShopOrder,
  type ShopOrderConfirmed,
  type ShopOrderLine,
  type ShopOrderRequest,
  type ShopShipment,
  type ShopTracking,
  type ShopTrackRequest,
} from '@omnivo/contracts';

import type { PlacedOrder, SourceResult } from '../types';

// Step 26c: the mock's orders, kept in memory (decision 3). Everything here is what step 26's API
// will do with tables; the shape of the answers is the same, so the pages never change.
// Step 27a: the API does it now (apps/api/src/storefront/orders/). The mock stays for `pnpm dev`,
// the Playwright tests and the staging demo, and keeps the API's rules for the phone code, so the
// pages are tested against the same answers. It has no order limits: a test places many orders
// from one address, and the API's tests check those limits.

// The code the mock takes. It sends no SMS, so the verify page shows it (ShopSource.testCode)
export const MOCK_CODE = '123456';

// How long an order waits for its code: the system design's stock hold (60 minutes, §14.4). After
// that it is dropped, and the checkout cookie with the same life is gone too. Step 27a: the API's
// numbers, from the contracts, so the mock and the API cannot drift apart
const WAIT_MS = SHOP_ORDER_HOLD_MINUTES * 60 * 1000;
const CODE_MS = SHOP_CODE_VALID_MINUTES * 60 * 1000;

interface MockOrder {
  token: string;
  order: ShopOrder;
  // Step 26e: the parcels the shop booked for it, oldest first. Nothing in the mock books a
  // courier, so only the demo orders have any
  shipments: ShopShipment[];
  // Only while it waits for the code
  wrongCodes: number;
  resendAt: number;
  expiresAt: number;
  // Step 27a: the API's rules for the code (27a's decision 17): each code works 10 minutes, and an
  // order gets 3 at most
  codeExpiresAt: number;
  codeSends: number;
}

// Step 26e: an order the mock starts with (demo-orders.ts), so a tracking link and the /track form
// have something to show right after a restart, when the book is otherwise empty
export interface MockDemoOrder {
  order: ShopOrder;
  shipments: ShopShipment[];
  // Its tracking link's token. Fixed, so the link the /track page shows works after every restart
  trackingToken: string;
}

// Step 26e: what tracking shows of an order. Each field is picked by name, never `...order`: the
// order has the buyer's name, phone and address, and a tracking link gets forwarded (decision 12).
// Copies, like find(): the page must not be able to change the book
function trackingOf({ order, shipments }: MockOrder): ShopTracking {
  return {
    orderNo: order.orderNo,
    placedAt: order.placedAt,
    status: order.status,
    history: structuredClone(order.history),
    // Pieces, not lines: two face washes and a tea are 3 items
    itemCount: order.lines.reduce((count, line) => count + line.quantity, 0),
    total: order.total,
    paymentMethod: order.paymentMethod,
    shipments: structuredClone(shipments),
  };
}

// A token nobody can guess. Step 27a: the API's shape (shopOrderTokenSchema): 16 random bytes (128
// bits) as 22 base64url characters, so the cookies check one shape for both sources. Web Crypto
// and btoa, not node:crypto or Buffer, so it runs wherever the shop's server runs
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  // base64 → base64url: no "+" or "/" (they would need escaping in a cookie), no "=" padding
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// W-000123: W for web, so a shop order is never mistaken for an ERP sales order (decision 3)
function orderNumber(sequence: number): string {
  return `W-${String(sequence).padStart(6, '0')}`;
}

// One order book per mock source. `now` is passed in so the tests can move time; the real clock
// otherwise. Step 26e: `demo` are the orders it starts with; none unless the source passes them
export function createOrderBook(
  now: () => Date = () => new Date(),
  demo: readonly MockDemoOrder[] = [],
) {
  const byToken = new Map<string, MockOrder>();
  // Step 26e: a tracking link's token → the order's key in byToken. Only the demo orders have one.
  // The real API makes a token when an order is placed, keeps only its hash, and sends the link by
  // SMS (step 27). The mock sends no SMS, so a token for its own orders would reach nobody: they
  // are tracked with the /track form. Nor does it hash: its tokens are printed on the /track page
  // anyway, and nothing here outlives the process
  const byTrackingToken = new Map<string, string>();
  for (const { order, shipments, trackingToken } of demo) {
    const key = newToken();
    byToken.set(key, {
      token: key,
      // Copies, so a test that changes its fixture cannot change the book
      order: structuredClone(order),
      shipments: structuredClone(shipments),
      // Read only while an order waits for its code, and a demo order never does
      wrongCodes: 0,
      resendAt: 0,
      expiresAt: 0,
      codeExpiresAt: 0,
      codeSends: 0,
    });
    byTrackingToken.set(trackingToken, key);
  }
  // New orders count on from the last demo order, so the two never share a number. "W-000123" →
  // 123; 0 with no demo orders, so the first order is still W-000001
  let sequence = Math.max(0, ...demo.map(({ order }) => Number(order.orderNo.slice(2))));

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

  // Step 27c: an order that holds a use of its coupon now (27c's decision 3): every order but a
  // cancelled one, and one that waits for its phone code only inside its hour. The API's
  // storefront_coupon_uses() counts the same orders. A dropped order (five wrong codes, or its hour
  // over) is no longer in the book, so it gives its use back too
  function holdsUse(entry: MockOrder, code: string): boolean {
    const { order } = entry;
    if (order.couponCode !== code || order.status === 'cancelled') return false;
    return order.status !== 'pending' || entry.expiresAt > now().getTime();
  }

  function couponUses(code: string): number {
    let uses = 0;
    for (const entry of byToken.values()) if (holdsUse(entry, code)) uses += 1;
    return uses;
  }

  function confirm(entry: MockOrder): ShopOrderConfirmed {
    const at = now().toISOString();
    entry.order.status = 'confirmed';
    entry.order.history.push({ status: 'confirmed', at });
    return { orderNo: entry.order.orderNo, phone: entry.order.phone };
  }

  return {
    // Step 27c: what the quote's `used` reads (mock-source.ts)
    couponUses,

    // Confirm Order. `quote` is the cart priced again on the server from the request's own lines,
    // zone and coupon; this only decides whether the order may be placed with it.
    // Step 27c: `coupons` are the shop's, for the rule of the code the quote applied
    place(
      request: ShopOrderRequest,
      quote: ShopCartQuote,
      settings: ShopCheckoutSettings,
      coupons: readonly ShopCouponRule[],
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
      // Step 27c: a coupon whose last use went to another order since the shopper's quote shows
      // here too: the quote above says "used up" and takes nothing off, so its total is not the
      // one the shopper saw. The checkout prices the cart again and the promo box says why
      if (compareMoney(quote.total, request.expectedTotal) !== 0) {
        return { ok: false, code: 'shop_order_changed' };
      }
      // Step 27c: once per mobile number, now that the phone is known, after the total as in the
      // API. Only for a code that took money off: a refused one is not kept on the order anyway
      const applied = quote.coupon.status === 'applied' ? quote.coupon.code : null;
      const rule = coupons.find((candidate) => candidate.code === applied);
      if (
        applied !== null &&
        rule?.onePerPhone === true &&
        [...byToken.values()].some(
          (entry) => entry.order.phone === request.phone && holdsUse(entry, applied),
        )
      ) {
        return { ok: false, code: 'shop_coupon_used_by_phone' };
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
        // The shop books a courier later (step 28); until then the order has no parcel
        shipments: [],
        wrongCodes: 0,
        // The first code was "sent" just now, so a new one waits the same 45 seconds
        resendAt: placedAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000,
        expiresAt: placedAt.getTime() + WAIT_MS,
        codeExpiresAt: placedAt.getTime() + CODE_MS,
        codeSends: 1,
      };
      byToken.set(token, entry);

      // Mobile Banking needs no code in the mock (decision 4): confirmed at once. Its number is in
      // the answer; a Cash on Delivery order's is not, as in the API, where it has none yet. (The
      // mock numbers an order when it is placed, which the shopper never sees: a dropped order
      // only leaves a gap in a book that is forgotten at the next restart)
      if (request.paymentMethod === 'online') {
        const confirmed = confirm(entry);
        return { ok: true, value: { answer: { next: 'confirmed', ...confirmed }, token } };
      }
      return {
        ok: true,
        value: {
          answer: {
            next: 'verify',
            maskedPhone: maskPhone(order.phone),
            resendInSeconds: SHOP_CODE_RESEND_SECONDS,
          },
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
      // Step 27a: a code past its 10 minutes is refused before it is compared, as the API does: it
      // cannot be right any more, so it costs no try
      if (entry.codeExpiresAt <= now().getTime()) return { ok: false, code: 'shop_code_expired' };
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
      // Step 27a: the third code was the last, before any wait: waiting would not help
      if (entry.codeSends >= SHOP_CODE_SENDS) return { ok: false, code: 'shop_code_sends_used' };
      const wait = secondsUntil(entry.resendAt);
      // Every SMS costs the shop money, and a page that resends on every click could be used to
      // flood someone's phone. The wait is the server's; the button's countdown only shows it
      if (wait > 0) return { ok: false, code: 'shop_code_resend_wait', params: { seconds: wait } };
      entry.resendAt = now().getTime() + SHOP_CODE_RESEND_SECONDS * 1000;
      // The new code works its own 10 minutes. The mock's code is always MOCK_CODE, so "the newest
      // replaces the older one" cannot be seen here; the API's tests check it
      entry.codeSends += 1;
      entry.codeExpiresAt = now().getTime() + CODE_MS;
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

    // Step 26e: what a tracking link shows. null for a token no order has. An order waiting for its
    // code is not one yet (as in find()); no demo order waits, so this only keeps the rule in one
    // place for when the real tokens come
    trackByLink(trackingToken: string): ShopTracking | null {
      const key = byTrackingToken.get(trackingToken);
      const entry = key === undefined ? undefined : byToken.get(key);
      if (!entry || entry.order.status === 'pending') return null;
      return trackingOf(entry);
    },

    // Step 26e: the /track form. The number finds the order and the phone must be the one it was
    // placed with. Both were made plain by shopTrackRequestSchema, as the order's phone was by
    // shopOrderRequestSchema, so a plain === compares them
    track({ phone, orderNo }: ShopTrackRequest): ShopTracking | null {
      for (const entry of byToken.values()) {
        if (entry.order.orderNo !== orderNo) continue;
        // One number is one order, so the search ends here, matched or not
        if (entry.order.phone !== phone || entry.order.status === 'pending') return null;
        return trackingOf(entry);
      }
      return null;
    },
  };
}
