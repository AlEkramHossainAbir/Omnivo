import {
  compareMoney,
  SHOP_TEXT_PAGES,
  shopOrderSchema,
  shopShipmentSchema,
  shopTextPageSchema,
  shopTrackingSchema,
  shopTrackingTokenSchema,
  shopTrackRequestSchema,
  type ShopOrderRequest,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockDemoOrders } from './demo-orders';
import { payPlaced } from './fake-payment';
import { createMockSource } from './mock-source';

// Step 26e: the demo orders, tracking by link and by the form, and the text pages

const SYLHET_LINK = 'C2etI9zQb8E5ZugpwzVWyA'; // W-000123, on hold with Steadfast

// A source that starts with the demo orders, as the shop's does
function demoSource() {
  return createMockSource(() => new Date('2026-11-15T10:00:00+06:00'), mockDemoOrders);
}

// The form's request after shopTrackRequestSchema, as the route hands it over
const asked = (phone: string, orderNo: string) => shopTrackRequestSchema.parse({ phone, orderNo });

// Step 27a: the shopper's address, which the mock counts misses under
const ADDRESS = '203.0.113.7';
// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
const ORIGIN = 'http://shop.test';

// Two face washes, inside Dhaka: ৳458 + ৳80, over the shop's ৳300 minimum
function order(paymentMethod: ShopOrderRequest['paymentMethod']): ShopOrderRequest {
  return {
    lines: [{ listingId: 'lst-himalaya-purifying-neem-face-wash-150ml', quantity: 2 }],
    zoneId: 'inside_dhaka',
    name: 'Nusrat Jahan',
    phone: '01786120356',
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    paymentMethod,
    termsAccepted: true,
    expectedTotal: '538',
  };
}

describe('the mock’s demo orders', () => {
  it('are orders and parcels the contracts accept', () => {
    for (const { order: demo, shipments } of mockDemoOrders) {
      expect(shopOrderSchema.parse(demo)).toEqual(demo);
      for (const shipment of shipments)
        expect(shopShipmentSchema.parse(shipment)).toEqual(shipment);
    }
  });

  it('are priced like the checkout prices an order', () => {
    const [dhaka, chattogram, sylhet] = mockDemoOrders.map(({ order: demo }) => demo);
    // Over ৳1,000 of items, so its delivery was free. Step 27c: less EID100's ৳100. The free
    // delivery still looks at the items before the coupon (26c's decision 8)
    expect(compareMoney(dhaka?.deliveryCharge ?? '', '0')).toBe(0);
    expect(dhaka).toMatchObject({ couponCode: 'EID100', discount: '100.0000' });
    expect(compareMoney(dhaka?.total ?? '', '1199')).toBe(0);
    expect(compareMoney(chattogram?.total ?? '', '520')).toBe(0);
    // The contracts' fixture: ৳458 of items and ৳120 outside Dhaka
    expect(compareMoney(sylhet?.total ?? '', '578')).toBe(0);
  });

  it('have links with the shape a tracking link has, each its own', () => {
    const tokens = mockDemoOrders.map(({ trackingToken }) => trackingToken);
    for (const token of tokens) expect(shopTrackingTokenSchema.safeParse(token).success).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('tracking in the mock', () => {
  it('shows the order a link names, and not who bought it', async () => {
    const tracking = await demoSource().tracking(SYLHET_LINK);
    expect(tracking).not.toBeNull();
    expect(shopTrackingSchema.parse(tracking)).toEqual(tracking);
    expect(tracking?.orderNo).toBe('W-000123');
    // Three pieces of three lines, and the rider's last try
    expect(tracking?.itemCount).toBe(3);
    expect(tracking?.shipments[0]?.events.at(-1)?.note).toBe('Customer not reachable');
    // Decision 12: nothing in the answer names the buyer or the address
    const text = JSON.stringify(tracking);
    for (const secret of ['01786120356', 'Shamim', 'Zindabazar']) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers null for a link no order has', async () => {
    expect(await demoSource().tracking('AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('tracks with the number and the phone the order was placed with, however they are typed', async () => {
    const tracked = await demoSource().track(asked('01786 120356', 'w-000123'), ADDRESS);
    expect(tracked).toMatchObject({ ok: true, value: { orderNo: 'W-000123' } });
  });

  it('refuses the right number with another order’s phone', async () => {
    // 01711284519 placed W-000121: a real buyer's phone, but not this order's
    expect(await demoSource().track(asked('01711284519', 'W-000123'), ADDRESS)).toEqual({
      ok: false,
      code: 'shop_track_not_found',
    });
  });

  it('refuses a number no order has', async () => {
    expect(await demoSource().track(asked('01786120356', 'W-000999'), ADDRESS)).toEqual({
      ok: false,
      code: 'shop_track_not_found',
    });
  });

  it('numbers new orders after the demo ones, and tracks them with no parcel', async () => {
    const source = demoSource();
    const placed = await source.placeOrder(order('online'), ADDRESS, ORIGIN);
    if (!placed.ok) throw new Error(placed.code);
    // Step 27d: confirmed once it is paid on the fake gateway's page
    expect(await payPlaced(source, placed.value)).toBe('W-000124');

    const tracked = await source.track(asked('01786120356', 'W-000124'), ADDRESS);
    expect(tracked).toMatchObject({ ok: true, value: { status: 'confirmed', shipments: [] } });
  });

  it('does not track an order that waits for its code', async () => {
    const source = demoSource();
    const placed = await source.placeOrder(order('cod'), ADDRESS, ORIGIN);
    if (!placed.ok) throw new Error(placed.code);
    // The mock numbers its orders as they are placed: the next one after the demo orders
    expect(await source.track(asked('01786120356', 'W-000124'), ADDRESS)).toMatchObject({
      ok: false,
      code: 'shop_track_not_found',
    });
  });

  // Step 27a: the limit moved here from the /track form's server code (server/track.spec.ts tests
  // the form with it)
  it('stops an address after ten misses, for the window’s 15 minutes', async () => {
    let now = new Date('2026-11-15T10:00:00+06:00');
    const source = createMockSource(() => now, mockDemoOrders);
    for (let miss = 0; miss < 10; miss += 1) {
      await source.track(asked('01711284519', 'W-000123'), ADDRESS);
    }
    expect(await source.track(asked('01786120356', 'W-000123'), ADDRESS)).toEqual({
      ok: false,
      code: 'shop_track_too_many',
      params: { minutes: 15 },
    });
    now = new Date(now.getTime() + 15 * 60 * 1000);
    expect(await source.track(asked('01786120356', 'W-000123'), ADDRESS)).toMatchObject({
      ok: true,
    });
  });

  it('cannot be changed through what it answers', async () => {
    const source = demoSource();
    const first = await source.tracking(SYLHET_LINK);
    first?.shipments.splice(0);
    first?.history.splice(0);
    const again = await source.tracking(SYLHET_LINK);
    expect(again?.shipments).toHaveLength(1);
    expect(again?.history).toHaveLength(4);
  });

  it('offers the demo orders to a tester, and nothing without them', () => {
    expect(demoSource().testTracking).toEqual(
      mockDemoOrders.map(({ order: demo, trackingToken }) => ({
        orderNo: demo.orderNo,
        phone: demo.phone,
        token: trackingToken,
      })),
    );
    // The checkout's tests make a source with no demo orders: no links to offer
    expect(createMockSource().testTracking).toBeNull();
  });
});

describe('the mock’s text pages', () => {
  it('has every footer page, in the public contract', async () => {
    const source = demoSource();
    for (const slug of SHOP_TEXT_PAGES) {
      const page = await source.textPage(slug);
      expect(page).not.toBeNull();
      expect(shopTextPageSchema.parse(page)).toEqual(page);
      expect(page?.slug).toBe(slug);
    }
  });

  it('says the checkout’s own delivery charges', async () => {
    const terms = await demoSource().textPage('terms');
    for (const amount of ['৳80', '৳120', '৳1,000']) expect(terms?.html).toContain(amount);
  });
});
