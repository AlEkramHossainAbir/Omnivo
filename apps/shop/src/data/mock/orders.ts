import {
  compareMoney,
  maskPhone,
  readFakeValId,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_SENDS,
  SHOP_CODE_TRIES,
  SHOP_CODE_VALID_MINUTES,
  SHOP_FAKE_GATEWAY_PATH,
  SHOP_ORDER_HOLD_MINUTES,
  SHOP_PAYMENT_TRIES,
  type ShopCartQuote,
  type ShopCheckoutSettings,
  type ShopCodeResent,
  type ShopCodeWait,
  type ShopCouponRule,
  type ShopOrder,
  type ShopOrderConfirmed,
  type ShopOrderLine,
  type ShopOrderRequest,
  type ShopPaymentRetry,
  type ShopPaymentSettled,
  type ShopPaymentSettleRequest,
  type ShopPaymentStatus,
  type ShopPaymentWait,
  type ShopShipment,
  type ShopTracking,
  type ShopTrackRequest,
} from '@omnivo/contracts';

import type {
  PlacedOrder,
  ShopPayOnDeliveryRefusal,
  ShopRetryRefusal,
  SourceResult,
} from '../types';

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

// Step 27d: one visit to the payment page of an online order, as the API's storefront_payments row
// keeps it. The mock's gateway is the fake one (decision 8): its page is the shop's own
// (SHOP_FAKE_GATEWAY_PATH), and the val_id it posts back says what happened, so the mock keeps no
// more than this
interface MockPayment {
  tranId: string;
  status: ShopPaymentStatus;
  amount: string;
}

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
  // Step 27d: an online order's tries, oldest first. Empty for Cash on Delivery
  payments: MockPayment[];
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

// Step 27d: a try's transaction id, in the API's shape (shopPaymentTranIdSchema): 20 upper-case
// letters and digits. 2^32 is not a multiple of 36, so the first letters come up a little more
// often than the last; for a mock id nobody pays with, that does not matter
const TRAN_ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function newTranId(): string {
  const numbers = crypto.getRandomValues(new Uint32Array(20));
  return Array.from(numbers, (value) => TRAN_ID_LETTERS[value % 36] ?? 'A').join('');
}

// Step 27d: the fake gateway's page for one try, on the shop the browser is on (`origin`, from the
// route), as the API's FakeGateway puts it on the shop's own address. A whole address, because the
// contract wants one (shopPaymentUrlSchema), and the checkout checks the answer with it
function fakePage(origin: string, tranId: string, amount: string): string {
  const url = new URL(SHOP_FAKE_GATEWAY_PATH, origin);
  url.search = new URLSearchParams({ tranId, amount }).toString();
  return url.toString();
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
      payments: [],
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

  // Step 27d: a waiting order that has a phone code: Cash on Delivery only. An online order waits
  // for its payment and has no code, so the code's routes do not know it, as in the API (where its
  // code columns are empty, 27d.2). Without this, the mock's 123456 would confirm an unpaid order
  function waitingForCode(token: string): MockOrder | null {
    const entry = waiting(token);
    return entry?.order.paymentMethod === 'cod' ? entry : null;
  }

  // Step 27d: the order and try a transaction id names, in any status. Not through waiting(): a
  // payment that arrives after the hour still confirms the order (decision 5)
  function byTranId(tranId: string): { entry: MockOrder; payment: MockPayment } | null {
    for (const entry of byToken.values()) {
      const payment = entry.payments.find((candidate) => candidate.tranId === tranId);
      if (payment !== undefined) return { entry, payment };
    }
    return null;
  }

  // The verify page's answer for an order that has its code
  function codeWaitOf(entry: MockOrder): ShopCodeWait {
    return {
      next: 'verify',
      maskedPhone: maskPhone(entry.order.phone),
      resendInSeconds: secondsUntil(entry.resendAt),
      listingIds: entry.order.lines.map((line) => line.listingId),
    };
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
      origin: string,
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
        payments: [],
      };
      byToken.set(token, entry);

      // Step 27d: Pay online waits for its payment, with no code (27c's decision 8), as in the API.
      // Its first try starts now, and the browser goes to the fake gateway's page. 26c's "confirmed
      // at once" is gone: an unpaid order is never confirmed. (The mock numbers an order when it
      // is placed, which the shopper never sees: a dropped order only leaves a gap in a book that
      // is forgotten at the next restart)
      if (request.paymentMethod === 'online') {
        entry.codeSends = 0;
        const tranId = newTranId();
        entry.payments.push({ tranId, status: 'started', amount: order.total });
        return {
          ok: true,
          value: {
            answer: { next: 'pay', paymentUrl: fakePage(origin, tranId, order.total) },
            token,
          },
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
          token,
        },
      };
    },

    codeWait(token: string): ShopCodeWait | null {
      const entry = waitingForCode(token);
      return entry === null ? null : codeWaitOf(entry);
    },

    verify(token: string, code: string): SourceResult<ShopOrderConfirmed> {
      const entry = waitingForCode(token);
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
      const entry = waitingForCode(token);
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

    // Step 27d: the gateway came back. The fake gateway's val_id says what happened, so this is
    // what the API's FakeGateway and settleLocked do together (apps/api/src/storefront/orders/
    // payment-settle.ts): paid is final, a paid answer for another try or another amount is not
    // believed, and "no val_id" is "the gateway knows no payment", which changes nothing
    settle({ tranId, valId }: ShopPaymentSettleRequest): ShopPaymentSettled | null {
      const found = byTranId(tranId);
      if (found === null) return null;
      const { entry, payment } = found;
      if (payment.status === 'paid') return { status: 'paid' };
      const answer = valId === null ? null : readFakeValId(valId);
      // No answer, or one for another try
      if (answer?.tranId !== tranId) return { status: payment.status };
      if (answer.outcome !== 'paid') {
        payment.status = answer.outcome;
        return { status: payment.status };
      }
      if (compareMoney(answer.amount, payment.amount) !== 0) return { status: payment.status };
      payment.status = 'paid';
      // Still waiting: this payment confirms it, as an online order, even when the shopper had
      // switched to Cash on Delivery in the meantime. An order confirmed already keeps its status:
      // the money is one more payment, which the ERP's order page says to refund
      if (entry.order.status === 'pending') {
        entry.order.paymentMethod = 'online';
        confirm(entry);
      }
      return { status: 'paid' };
    },

    // Step 27d: /checkout/paid. The fake gateway answers at once, so the mock is never "checking"
    paymentWait(token: string, settings: ShopCheckoutSettings): ShopPaymentWait | null {
      const entry = byToken.get(token);
      if (entry === undefined) return null;
      const { order } = entry;
      if (order.status !== 'pending') {
        // Confirmed by a payment: "Order Confirmed". One confirmed by its phone code is the verify
        // page's
        if (!entry.payments.some((payment) => payment.status === 'paid')) return null;
        return {
          state: 'paid',
          orderNo: order.orderNo,
          phone: order.phone,
          listingIds: order.lines.map((line) => line.listingId),
        };
      }
      // Cash on Delivery now, or past its hour (waiting() drops it then)
      if (order.paymentMethod !== 'online' || waiting(token) === null) return null;
      const last = entry.payments.at(-1)?.status ?? 'started';
      return {
        state: 'unpaid',
        // A try that is still started has no answer from the fake gateway: the shopper came back
        // without pressing a button there
        problem: last === 'started' || last === 'paid' ? 'not_finished' : last,
        triesLeft: Math.max(0, SHOP_PAYMENT_TRIES - entry.payments.length),
        payOnDelivery: settings.paymentMethods.includes('cod'),
        total: order.total,
      };
    },

    // Step 27d: "Try again", with the API's refusals in the API's order
    retry(
      token: string,
      settings: ShopCheckoutSettings,
      origin: string,
    ): SourceResult<ShopPaymentRetry, ShopRetryRefusal> {
      const entry = waiting(token);
      if (entry === null) return { ok: false, code: 'shop_payment_no_order' };
      if (entry.order.paymentMethod !== 'online')
        return { ok: false, code: 'shop_payment_settled' };
      if (entry.payments.length >= SHOP_PAYMENT_TRIES) {
        return { ok: false, code: 'shop_payment_tries_used' };
      }
      if (!settings.paymentMethods.includes('online')) {
        return { ok: false, code: 'shop_payment_unavailable' };
      }
      const tranId = newTranId();
      entry.payments.push({ tranId, status: 'started', amount: entry.order.total });
      return { ok: true, value: { paymentUrl: fakePage(origin, tranId, entry.order.total) } };
    },

    // Step 27d: "Pay on delivery instead". A second press (a double click, the Back button) gets
    // the verify page's answer again, with no new code, as in the API
    payOnDelivery(
      token: string,
      settings: ShopCheckoutSettings,
    ): SourceResult<ShopCodeWait, ShopPayOnDeliveryRefusal> {
      const entry = waiting(token);
      if (entry === null) return { ok: false, code: 'shop_payment_no_order' };
      if (entry.order.paymentMethod === 'cod') return { ok: true, value: codeWaitOf(entry) };
      if (!settings.paymentMethods.includes('cod')) {
        return { ok: false, code: 'shop_payment_unavailable' };
      }
      // The code is "sent" now: its 45 seconds, its 10 minutes, its five tries start here
      const at = now().getTime();
      entry.order.paymentMethod = 'cod';
      entry.codeSends = 1;
      entry.wrongCodes = 0;
      entry.resendAt = at + SHOP_CODE_RESEND_SECONDS * 1000;
      entry.codeExpiresAt = at + CODE_MS;
      return { ok: true, value: codeWaitOf(entry) };
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
