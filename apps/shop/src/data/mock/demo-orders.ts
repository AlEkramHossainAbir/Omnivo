import type { ShopOrder, ShopOrderLine, ShopPaymentMethod, ShopShipment } from '@omnivo/contracts';

import { mockCheckoutSettings } from './checkout';
import type { MockDemoOrder } from './orders';
import { mockCatalog } from './products';
import { quoteCart } from './quote';
import { mockShop } from './shop';

// Step 26e: the orders the mock shop starts with. A tracking link needs an order that a courier has
// moved, and nothing in the mock books a courier, so these three are written out: one the shop has
// not handed over yet, one on its way and on hold, and one delivered after a second booking. They
// are the cases the tracking view has words for (shop.track.*), so the page can be seen with each.

interface DemoInput {
  orderNo: string;
  history: ShopOrder['history'];
  name: string;
  phone: string;
  address: string;
  zoneId: (typeof mockCheckoutSettings.zones)[number]['id'];
  paymentMethod: ShopPaymentMethod;
  // [slug, quantity]: the listing as the catalog has it today
  items: readonly (readonly [string, number])[];
  shipments: ShopShipment[];
  trackingToken: string;
}

// The order is priced by quoteCart, the same code that prices a real one, so its subtotal, delivery
// charge and total add up the way the checkout's do, and a price changed in the catalog changes the
// demo order with it
function demoOrder(input: DemoInput): MockDemoOrder {
  const first = input.history[0];
  const last = input.history.at(-1);
  if (!first || !last) throw new Error(`${input.orderNo}: no history`);
  const zone = mockCheckoutSettings.zones.find((candidate) => candidate.id === input.zoneId);
  if (!zone) throw new Error(`${input.orderNo}: no zone ${input.zoneId}`);

  const quote = quoteCart(
    {
      lines: input.items.map(([slug, quantity]) => ({ listingId: `lst-${slug}`, quantity })),
      zoneId: input.zoneId,
    },
    {
      catalog: mockCatalog,
      settings: mockCheckoutSettings,
      coupons: [],
      timeZone: mockShop.timeZone,
      now: new Date(first.at),
    },
  );
  // A slug that is not in the catalog, or a listing out of stock, is a mistake in this file: it
  // fails here, when the module loads, and every test fails with it. The fields are the ones
  // orders.ts's place() copies from a quote line
  const lines = quote.lines.map((line): ShopOrderLine => {
    if (line.status !== 'available') throw new Error(`${input.orderNo}: ${line.listingId}`);
    return {
      listingId: line.listingId,
      slug: line.slug,
      name: line.name,
      packSize: line.packSize,
      image: line.image,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    };
  });

  return {
    order: {
      orderNo: input.orderNo,
      placedAt: first.at,
      // Where it is now: the last step of its history
      status: last.status,
      history: input.history,
      name: input.name,
      phone: input.phone,
      address: input.address,
      zoneName: zone.name,
      paymentMethod: input.paymentMethod,
      lines,
      subtotal: quote.subtotal,
      discount: quote.discount,
      couponCode: null,
      // The zone was given, so the quote has its charge; `?? '0'` only satisfies the type
      deliveryCharge: quote.deliveryCharge ?? '0',
      total: quote.total,
    },
    shipments: input.shipments,
    trackingToken: input.trackingToken,
  };
}

export const mockDemoOrders: readonly MockDemoOrder[] = [
  // Delivered in Dhaka, paid with Mobile Banking. The first booking (RedX) was cancelled before its
  // rider came, and the shop booked Pathao instead: the page's "Earlier parcel". Over ৳1,000, so
  // the delivery was free
  demoOrder({
    orderNo: 'W-000121',
    history: [
      { status: 'pending', at: '2026-11-08T11:02:00+06:00' },
      { status: 'confirmed', at: '2026-11-08T11:02:00+06:00' },
      { status: 'packed', at: '2026-11-08T15:30:00+06:00' },
      { status: 'shipped', at: '2026-11-09T10:15:00+06:00' },
      { status: 'delivered', at: '2026-11-09T17:40:00+06:00' },
    ],
    name: 'Nusrat Jahan',
    phone: '01711284519',
    address: 'House 7, Road 3, Block C, Mirpur 10, Dhaka',
    zoneId: 'inside_dhaka',
    paymentMethod: 'online',
    items: [
      ['davidoff-espresso-coffee', 1],
      ['sprite-cold-drink-500ml', 2],
    ],
    shipments: [
      {
        courier: 'redx',
        trackingCode: 'RX2611080317',
        trackingUrl: null,
        events: [
          { status: 'booked', at: '2026-11-08T15:35:00+06:00', note: null },
          { status: 'cancelled', at: '2026-11-08T18:10:00+06:00', note: 'Cancelled by merchant' },
        ],
      },
      {
        courier: 'pathao',
        trackingCode: 'DH0811259QKP7',
        trackingUrl: null,
        events: [
          { status: 'booked', at: '2026-11-08T18:20:00+06:00', note: null },
          {
            status: 'picked_up',
            at: '2026-11-09T10:15:00+06:00',
            note: 'Picked up from merchant',
          },
          { status: 'in_transit', at: '2026-11-09T12:30:00+06:00', note: 'Received at Mirpur hub' },
          { status: 'out_for_delivery', at: '2026-11-09T14:05:00+06:00', note: null },
          { status: 'delivered', at: '2026-11-09T17:40:00+06:00', note: null },
        ],
      },
    ],
    trackingToken: 'MGhXyBcrs_PytWRCRPw-6w',
  }),

  // Confirmed last night in Chattogram, Cash on Delivery, not handed to a courier yet: the page's
  // "The shop has not handed the parcel to a courier yet"
  demoOrder({
    orderNo: 'W-000122',
    history: [
      { status: 'pending', at: '2026-11-14T20:45:00+06:00' },
      { status: 'confirmed', at: '2026-11-14T20:46:10+06:00' },
    ],
    name: 'Tanvir Hasan',
    phone: '01819456723',
    address: 'Flat 4B, Road 2, Nasirabad Housing, Chattogram',
    zoneId: 'outside_dhaka',
    paymentMethod: 'cod',
    items: [
      ['himalaya-anti-hair-fall-shampoo-180ml', 1],
      ['aci-pure-turmeric-200gm', 1],
    ],
    shipments: [],
    trackingToken: '8hFQ10FlQi8U60p2Ct6OEw',
  }),

  // The contracts' fixture (storefront.spec.ts → TRACKING): Sylhet, Cash on Delivery, with
  // Steadfast, and on hold because the rider could not reach the buyer. 3 items, ৳578
  demoOrder({
    orderNo: 'W-000123',
    history: [
      { status: 'pending', at: '2026-11-11T15:20:00+06:00' },
      { status: 'confirmed', at: '2026-11-11T15:21:30+06:00' },
      { status: 'packed', at: '2026-11-12T10:05:00+06:00' },
      { status: 'shipped', at: '2026-11-12T16:40:00+06:00' },
    ],
    name: 'Shamim Ahmed',
    phone: '01786120356',
    address: 'House 12, Road 5, Zindabazar, Sylhet',
    zoneId: 'outside_dhaka',
    paymentMethod: 'cod',
    items: [
      ['himalaya-purifying-neem-face-wash-150ml', 1],
      ['himalaya-purifying-neem-face-wash-50ml', 1],
      ['aci-pure-turmeric-200gm', 1],
    ],
    shipments: [
      {
        courier: 'steadfast',
        trackingCode: 'SFR2611120042',
        trackingUrl: 'https://steadfast.com.bd/t/SFR2611120042',
        events: [
          { status: 'booked', at: '2026-11-12T10:06:00+06:00', note: null },
          {
            status: 'picked_up',
            at: '2026-11-12T16:40:00+06:00',
            note: 'Picked up from the shop',
          },
          { status: 'on_hold', at: '2026-11-13T13:15:00+06:00', note: 'Customer not reachable' },
        ],
      },
    ],
    trackingToken: 'C2etI9zQb8E5ZugpwzVWyA',
  }),
];
