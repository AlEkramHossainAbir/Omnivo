import { shopOrderSchema, shopTrackingSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  codAmountOf,
  historyOf,
  type OrderLineRow,
  orderOf,
  type OrderRow,
  trackingOf,
} from './order-view.js';

const TENANT = '0193a000-0000-7000-8000-000000000001';
const ORDER = '0193a000-0000-7000-8000-000000000002';
const MEDIA = 'https://media.example.com';

const PLACED = new Date('2026-11-17T04:00:00.000Z');
const CONFIRMED = new Date('2026-11-17T04:02:10.000Z');

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER,
    createdAt: PLACED,
    updatedAt: CONFIRMED,
    updatedBy: null,
    version: 2,
    tenantId: TENANT,
    orderNo: 'W-000123',
    status: 'confirmed',
    customerName: 'Nusrat Jahan',
    phone: '01786120356',
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    zoneId: 'inside_dhaka',
    zoneName: 'Inside Dhaka',
    paymentMethod: 'cod',
    subtotal: '498.0000',
    discount: '0.0000',
    couponId: null,
    couponCode: null,
    deliveryCharge: '80.0000',
    total: '578.0000',
    orderTokenHash: 'a'.repeat(64),
    trackingTokenHash: 'b'.repeat(64),
    codeHash: null,
    codeExpiresAt: null,
    codeSentAt: null,
    codeSends: null,
    codeTriesLeft: null,
    confirmedAt: CONFIRMED,
    packedAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    returnedAt: null,
    // Step 27b: the ERP documents and their notes; the shop's views read none of them
    salesOrderId: null,
    deliveryId: null,
    invoiceId: null,
    salesReturnId: null,
    documentError: null,
    cancelReason: null,
    ...overrides,
  };
}

function line(position: number, quantity: number, name: string): OrderLineRow {
  return {
    tenantId: TENANT,
    orderId: ORDER,
    position,
    listingId: `0193a000-0000-7000-8000-00000000010${String(position)}`,
    productId: '0193a000-0000-7000-8000-000000000201',
    variantId: '0193a000-0000-7000-8000-000000000301',
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    packSize: '150ml',
    image: { id: '0193a000-0000-7000-8000-000000000401', alt: name },
    quantity,
    unitPrice: '229.0000',
    lineTotal: (229 * quantity).toFixed(4),
  };
}

// Out of their order on purpose: the page lists them as the cart did
const LINES = [line(2, 1, 'Stevia'), line(1, 2, 'Neem face wash')];

describe('order view', () => {
  it('reads the timeline from the step columns, oldest first', () => {
    expect(historyOf(order())).toEqual([
      { status: 'pending', at: PLACED.toISOString() },
      { status: 'confirmed', at: CONFIRMED.toISOString() },
    ]);
    // A return before the delivery (a parcel refused at the door): by time, not by the list
    const returned = order({
      status: 'returned',
      shippedAt: new Date('2026-11-18T05:00:00.000Z'),
      returnedAt: new Date('2026-11-19T09:00:00.000Z'),
    });
    expect(historyOf(returned).map((step) => step.status)).toEqual([
      'pending',
      'confirmed',
      'shipped',
      'returned',
    ]);
  });

  it('gives the browser that placed it the whole order, lines in the cart order', () => {
    const answer = shopOrderSchema.parse(orderOf(order(), LINES, MEDIA));
    expect(answer).toMatchObject({ orderNo: 'W-000123', phone: '01786120356', total: '578.0000' });
    expect(answer.lines.map((item) => item.name)).toEqual(['Neem face wash', 'Stevia']);
    expect(answer.lines[0]?.image.url).toBe(
      `${MEDIA}/storefront/0193a000-0000-7000-8000-000000000401/small.webp`,
    );
  });

  it('gives a tracking link no name, phone, address or line', () => {
    const answer = shopTrackingSchema.parse(trackingOf(order(), LINES, []));
    expect(answer).toEqual({
      orderNo: 'W-000123',
      placedAt: PLACED.toISOString(),
      status: 'confirmed',
      history: historyOf(order()),
      itemCount: 3,
      total: '578.0000',
      paymentMethod: 'cod',
      shipments: [],
    });
  });

  it('refuses to show an order without a number', () => {
    expect(() => trackingOf(order({ orderNo: null }), LINES, [])).toThrow(/no number/);
  });

  // Step 28a: the parcels the caller read, as they came
  it('gives a tracking link its parcels', () => {
    const parcel = {
      courier: 'steadfast' as const,
      trackingCode: 'SFR2611230042',
      trackingUrl: 'https://steadfast.com.bd/t/SFR2611230042',
      events: [{ status: 'booked' as const, at: PLACED.toISOString(), note: null }],
    };
    const answer = shopTrackingSchema.parse(trackingOf(order(), LINES, [parcel]));
    expect(answer.shipments).toEqual([parcel]);
  });
});

describe('what the rider collects (step 28a.3)', () => {
  it('is the total less what was paid, never below zero', () => {
    expect(codAmountOf('578.0000', [])).toBe('578.0000');
    expect(codAmountOf('578.0000', ['578.0000'])).toBe('0.0000');
    // Paid twice (a second tab): nothing at the door, the second payment is a refund
    expect(codAmountOf('578.0000', ['578.0000', '578.0000'])).toBe('0.0000');
    expect(codAmountOf('578.5000', ['100.0000'])).toBe('478.5000');
  });
});
