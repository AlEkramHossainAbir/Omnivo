import { describe, expect, it } from 'vitest';

import { stepStatusOf } from '../storefront/shipping/shipment-news.js';
import { bearerOf } from '../storefront/shipping/courier-webhooks.js';
import { invoiceOf } from '../storefront/shipping/shipments.js';
import { courierId, courierMoney, courierText, eventKeyOf, type ParcelRequest } from './courier.js';
import { FAKE_REFUSED_PHONE, FakeCourier } from './fake-courier.js';
import { SteadfastAdapter, steadfastTime } from './steadfast-adapter.js';

const KEYS = { apiKey: 'k8xvq2m4b1c3d5e6', secretKey: 's9yw3n5c2d4e6f7g' };
const PARCEL: ParcelRequest = {
  invoice: 'W-000123',
  name: 'Sadia Rahman',
  phone: '01786120356',
  address: 'House 12\nRoad 4, Dhanmondi, Inside Dhaka',
  codAmount: '578.00',
  note: '3 items',
};

// A fetch that answers one JSON body and remembers what it was asked, as the gateway's test does
function answering(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetchFn };
}

function failing(): typeof fetch {
  return () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
}

describe('Steadfast adapter (step 28a.3)', () => {
  it('books with the keys in headers, the address on one line and the amount as a number', async () => {
    const { calls, fetchFn } = answering({
      status: 200,
      message: 'Consignment has been created successfully.',
      consignment: {
        consignment_id: 1424107,
        invoice: 'W-000123',
        tracking_code: '15BAEB8A',
        recipient_name: 'Sadia Rahman',
        cod_amount: 578,
        status: 'in_review',
      },
    });
    const answer = await new SteadfastAdapter(fetchFn).book(KEYS, PARCEL);
    expect(answer).toEqual({
      kind: 'booked',
      parcel: {
        consignmentId: '1424107',
        trackingCode: '15BAEB8A',
        trackingUrl: 'https://steadfast.com.bd/t/15BAEB8A',
        status: 'booked',
      },
    });
    const call = calls[0];
    expect(call?.url).toBe('https://portal.packzy.com/api/v1/create_order');
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toMatchObject({
      'Api-Key': KEYS.apiKey,
      'Secret-Key': KEYS.secretKey,
    });
    const body = call?.init?.body;
    const sent: unknown = typeof body === 'string' ? JSON.parse(body) : null;
    expect(sent).toEqual({
      invoice: 'W-000123',
      recipient_name: 'Sadia Rahman',
      recipient_phone: '01786120356',
      recipient_address: 'House 12 Road 4, Dhanmondi, Inside Dhaka',
      cod_amount: 578,
      note: '3 items',
    });
  });

  it("refuses a parcel with Steadfast's own sentence, and knows a taken invoice", async () => {
    const refused = answering(
      { status: 400, errors: { recipient_phone: ['The recipient phone must be 11 digits.'] } },
      422,
    );
    expect(await new SteadfastAdapter(refused.fetchFn).book(KEYS, PARCEL)).toEqual({
      kind: 'refused',
      detail: 'The recipient phone must be 11 digits.',
    });
    const taken = answering({
      status: 400,
      errors: { invoice: ['The invoice has already been taken.'] },
    });
    expect(await new SteadfastAdapter(taken.fetchFn).book(KEYS, PARCEL)).toEqual({ kind: 'taken' });
  });

  it('reads refused keys, no answer and a broken body as problems, never as a booking', async () => {
    expect(
      await new SteadfastAdapter(answering({ message: 'Unauthorized' }, 401).fetchFn).book(
        KEYS,
        PARCEL,
      ),
    ).toEqual({ kind: 'problem', problem: 'rejected' });
    expect(
      await new SteadfastAdapter(answering({ status: 401 }).fetchFn).book(KEYS, PARCEL),
    ).toEqual({ kind: 'problem', problem: 'rejected' });
    expect(await new SteadfastAdapter(failing()).book(KEYS, PARCEL)).toEqual({
      kind: 'problem',
      problem: 'unreachable',
    });
    expect(
      await new SteadfastAdapter(answering({ oops: true }, 502).fetchFn).book(KEYS, PARCEL),
    ).toEqual({ kind: 'problem', problem: 'unreachable' });
    // "200" without a consignment is not a booking either
    expect(
      await new SteadfastAdapter(answering({ status: 200 }).fetchFn).book(KEYS, PARCEL),
    ).toEqual({ kind: 'refused', detail: null });
  });

  it('finds a parcel by its invoice only as "exists": Steadfast does not say its code', async () => {
    const { calls, fetchFn } = answering({ status: 200, delivery_status: 'in_review' });
    expect(await new SteadfastAdapter(fetchFn).find(KEYS, 'W-000123-2')).toEqual({
      kind: 'exists',
    });
    expect(calls[0]?.url).toBe('https://portal.packzy.com/api/v1/status_by_invoice/W-000123-2');
    expect(
      await new SteadfastAdapter(
        answering({ status: 404, message: 'Not found' }, 404).fetchFn,
      ).find(KEYS, 'W-000124'),
    ).toEqual({ kind: 'none' });
  });

  it("maps Steadfast's statuses in one table, and keeps a word it does not know", async () => {
    const status = async (word: string) =>
      new SteadfastAdapter(answering({ status: 200, delivery_status: word }).fetchFn).status(
        KEYS,
        '1424107',
      );
    expect(await status('in_review')).toEqual({
      kind: 'status',
      status: 'booked',
      word: 'in_review',
    });
    expect(await status('pending')).toMatchObject({ status: 'in_transit' });
    expect(await status('hold')).toMatchObject({ status: 'on_hold' });
    // The rider says delivered, the hub has not approved it: not Delivered yet
    expect(await status('delivered_approval_pending')).toMatchObject({
      status: 'out_for_delivery',
    });
    expect(await status('delivered')).toMatchObject({ status: 'delivered' });
    expect(await status('partial_delivered')).toMatchObject({ status: 'partly_delivered' });
    expect(await status('cancelled')).toMatchObject({ status: 'cancelled' });
    expect(await status('Delivered ')).toMatchObject({ status: 'delivered' });
    expect(await status('teleported')).toEqual({
      kind: 'status',
      status: null,
      word: 'teleported',
    });
    expect(await status('__proto__')).toMatchObject({ status: null });
  });

  it('reads both webhook notices, and keeps a body it cannot read', () => {
    const adapter = new SteadfastAdapter(failing());
    expect(
      adapter.readNotice({
        notification_type: 'delivery_status',
        consignment_id: 1424107,
        invoice: 'W-000123',
        cod_amount: 578,
        status: 'delivered',
        delivery_charge: 80,
        tracking_message: '  Delivered to  the customer ',
        updated_at: '2026-11-23 14:05:09',
      }),
    ).toMatchObject({
      kind: 'status',
      consignmentId: '1424107',
      invoice: 'W-000123',
      status: 'delivered',
      note: 'Delivered to the customer',
      at: new Date('2026-11-23T08:05:09.000Z'),
      // Step 28b: what the rider collected and Steadfast's charge, as our money text
      collected: '578.00',
      charge: '80.00',
    });
    // Step 28b: a sum Steadfast sent as a string, and one we cannot read, which is no sum
    expect(
      adapter.readNotice({
        notification_type: 'delivery_status',
        invoice: 'W-000123',
        status: 'partial_delivered',
        cod_amount: '300.5',
        delivery_charge: 'N/A',
      }),
    ).toMatchObject({
      kind: 'status',
      status: 'partly_delivered',
      collected: '300.5',
      charge: null,
    });
    expect(
      adapter.readNotice({
        notification_type: 'tracking_update',
        consignment_id: '1424107',
        tracking_message: 'Received at Sylhet hub',
      }),
    ).toMatchObject({ kind: 'note', note: 'Received at Sylhet hub', at: null });
    expect(
      adapter.readNotice({ notification_type: 'delivery_status', status: 'teleported' }),
    ).toMatchObject({ kind: 'unread' });
    expect(adapter.readNotice({ consignment_id: { nested: true } })).toMatchObject({
      kind: 'unread',
      consignmentId: null,
    });
    expect(adapter.readNotice('not an object')).toMatchObject({
      kind: 'unread',
      raw: { body: 'not an object' },
    });
  });

  it('tests the keys with the balance, which changes nothing', async () => {
    const { calls, fetchFn } = answering({ status: 200, current_balance: 0 });
    expect(await new SteadfastAdapter(fetchFn).test(KEYS)).toBeNull();
    expect(calls[0]?.url).toBe('https://portal.packzy.com/api/v1/get_balance');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(await new SteadfastAdapter(answering({}, 403).fetchFn).test(KEYS)).toBe('rejected');
    expect(await new SteadfastAdapter(failing()).test(KEYS)).toBe('unreachable');
  });

  it("reads Steadfast's time as Bangladesh time, and no time it cannot trust", () => {
    const now = new Date('2026-11-23T10:00:00Z');
    expect(steadfastTime('2026-11-23 14:05:09', now)?.toISOString()).toBe(
      '2026-11-23T08:05:09.000Z',
    );
    expect(steadfastTime('2026-11-23T08:05:09Z', now)?.toISOString()).toBe(
      '2026-11-23T08:05:09.000Z',
    );
    expect(steadfastTime('yesterday', now)).toBeNull();
    expect(steadfastTime('2027-01-01 00:00:00', now)).toBeNull();
    expect(steadfastTime(undefined, now)).toBeNull();
  });
});

describe('fake courier (step 28a.3)', () => {
  it('books the same invoice with the same id and code every time', async () => {
    const fake = new FakeCourier();
    const first = await fake.book(KEYS, PARCEL);
    const again = await fake.book(KEYS, PARCEL);
    expect(first).toEqual(again);
    expect(first).toMatchObject({
      kind: 'booked',
      parcel: { status: 'booked', trackingUrl: null },
    });
    const other = await fake.book(KEYS, { ...PARCEL, invoice: 'W-000123-2' });
    expect(other).not.toEqual(first);
  });

  it('refuses keys, a phone and answers nothing as asked', async () => {
    const fake = new FakeCourier();
    expect(await fake.book({ ...KEYS, apiKey: 'fake_rejected' }, PARCEL)).toEqual({
      kind: 'problem',
      problem: 'rejected',
    });
    expect(await fake.test({ ...KEYS, apiKey: 'fake_unreachable' })).toBe('unreachable');
    expect(await fake.book(KEYS, { ...PARCEL, phone: FAKE_REFUSED_PHONE })).toMatchObject({
      kind: 'refused',
    });
    expect(await fake.find(KEYS)).toEqual({ kind: 'none' });
    expect(await fake.status()).toEqual({ kind: 'problem', problem: 'unreachable' });
    expect(fake.readNotice({ status: 'delivered', consignment_id: 7 })).toMatchObject({
      kind: 'status',
      status: 'delivered',
      consignmentId: '7',
    });
  });
});

describe('courier helpers (step 28a.3)', () => {
  it("cuts a courier's words to the columns, and reads only plain ids", () => {
    expect(courierText(`  ${'a'.repeat(400)} `)).toHaveLength(300);
    expect(courierText('   ')).toBeNull();
    expect(courierText(42)).toBeNull();
    expect(courierId(1424107)).toBe('1424107');
    expect(courierId(' SF-12 ')).toBe('SF-12');
    expect(courierId(1.5)).toBeNull();
    expect(courierId('a b')).toBeNull();
  });

  it('keys one step by its status, time and note', () => {
    const at = new Date('2026-11-23T08:05:09Z');
    expect(eventKeyOf('status', 'delivered', at, null)).toMatch(/^[0-9a-f]{64}$/);
    expect(eventKeyOf('status', 'delivered', at, null)).toBe(
      eventKeyOf('status', 'delivered', at, null),
    );
    expect(eventKeyOf('status', 'delivered', at, 'x')).not.toBe(
      eventKeyOf('status', 'delivered', at, null),
    );
  });

  it('gives a later parcel the order number with its own number', () => {
    expect(invoiceOf('W-000123', 1)).toBe('W-000123');
    expect(invoiceOf('W-000123', 3)).toBe('W-000123-3');
  });

  it('reads a cancel after the pickup as goods coming back', () => {
    expect(stepStatusOf('booked', 'cancelled')).toBe('cancelled');
    expect(stepStatusOf('in_transit', 'cancelled')).toBe('returning');
    expect(stepStatusOf('in_transit', 'delivered')).toBe('delivered');
  });

  it('takes only a bearer token from the Authorization header', () => {
    expect(bearerOf('Bearer abc_DEF-123')).toBe('abc_DEF-123');
    expect(bearerOf('bearer  abc ')).toBe('abc');
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf('Bearer a b')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });
});

describe('courierMoney (step 28b)', () => {
  it('reads a courier’s sum to the paisa, or not at all', () => {
    expect(courierMoney(578)).toBe('578.00');
    expect(courierMoney(1500.5)).toBe('1500.50');
    expect(courierMoney(0)).toBe('0.00');
    // A float's noise is not paisa
    expect(courierMoney(0.1 + 0.2)).toBe('0.30');
    expect(courierMoney(' 578.50 ')).toBe('578.50');
    expect(courierMoney('578')).toBe('578');
    // A minus, a third decimal, words, nothing: no sum
    expect(courierMoney(-1)).toBeNull();
    expect(courierMoney(578.555)).toBeNull();
    expect(courierMoney('578.555')).toBeNull();
    expect(courierMoney('-578')).toBeNull();
    expect(courierMoney('N/A')).toBeNull();
    expect(courierMoney(Number.NaN)).toBeNull();
    expect(courierMoney(Number.POSITIVE_INFINITY)).toBeNull();
    expect(courierMoney(null)).toBeNull();
    expect(courierMoney(undefined)).toBeNull();
    expect(courierMoney({ amount: 578 })).toBeNull();
  });
});
