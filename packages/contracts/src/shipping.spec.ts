import { describe, expect, it } from 'vitest';

import {
  bookShipmentInputSchema,
  courierAccountSchema,
  createCourierAccountInputSchema,
  isOpenShipment,
  OPEN_SHIPMENT_STATUSES,
  SHIPMENT_STATUSES,
  shippingRoutes,
  steadfastWebhookSchema,
  updateCourierAccountInputSchema,
} from './shipping.js';
import { SHOP_SHIPMENT_STATUSES } from './storefront.js';
import { storefrontOrderRoutes } from './storefront-orders.js';

// The field paths and codes of a failed parse, the way the forms show them
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    const key = issue.path.map(String).join('.');
    errors[key] = [...(errors[key] ?? []), issue.message];
  }
  return errors;
}

const ACCOUNT = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';

// Keys as Steadfast's panel shows them (made up, the same shape)
const STEADFAST = {
  provider: 'steadfast',
  name: 'Steadfast',
  apiKey: 'xk2j9tqlm4n8vbc0r7pd',
  secretKey: 'h6s1w3fz9ye2u5ia8og0',
} as const;

describe('the courier account form', () => {
  it('needs both keys the first time, and keeps a saved one when its box is empty later', () => {
    expect(
      errorsOf(createCourierAccountInputSchema.safeParse({ ...STEADFAST, apiKey: '' })),
    ).toEqual({ apiKey: ['courier_key_required'] });
    const later = updateCourierAccountInputSchema.parse({
      ...STEADFAST,
      apiKey: '',
      secretKey: '',
      version: 2,
    });
    expect(later).toMatchObject({ apiKey: '', secretKey: '' });
  });

  it('trims a pasted key, and refuses one with other characters', () => {
    const parsed = createCourierAccountInputSchema.parse({ ...STEADFAST, apiKey: ' abc123 ' });
    expect(parsed.provider === 'steadfast' && parsed.apiKey).toBe('abc123');
    expect(
      errorsOf(createCourierAccountInputSchema.safeParse({ ...STEADFAST, secretKey: 'a b' })),
    ).toEqual({ secretKey: ['courier_key_format'] });
  });

  it('asks a manual account for its courier, never for keys', () => {
    const manual = { provider: 'manual', name: 'Pathao (by hand)' };
    expect(errorsOf(createCourierAccountInputSchema.safeParse({ ...manual, courier: '' }))).toEqual(
      { courier: ['courier_pick_one'] },
    );
    const parsed = createCourierAccountInputSchema.parse({
      ...manual,
      courier: 'pathao',
      apiKey: 'ignored',
    });
    expect(parsed).not.toHaveProperty('apiKey');
  });

  it('refuses a provider it does not know', () => {
    expect(
      createCourierAccountInputSchema.safeParse({ ...STEADFAST, provider: 'redx' }).success,
    ).toBe(false);
  });
});

describe('the saved account', () => {
  it('never has a key or the webhook token', () => {
    const parsed = courierAccountSchema.parse({
      id: ACCOUNT,
      provider: 'steadfast',
      name: 'Steadfast',
      courier: 'steadfast',
      status: 'active',
      webhookUrl: `https://api.omnivosoft.com/public/v1/couriers/steadfast/${ACCOUNT}`,
      hasWebhookToken: true,
      lastWebhookAt: null,
      lastTest: null,
      version: 1,
      updatedAt: '2026-11-22T10:00:00.000Z',
      apiKey: 'leaked',
      webhookToken: 'leaked',
    });
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed).not.toHaveProperty('webhookToken');
  });
});

describe('a parcel', () => {
  it("has the shop's ten statuses and two of the ERP's own before them", () => {
    expect(SHIPMENT_STATUSES).toEqual(['booking', 'booking_failed', ...SHOP_SHIPMENT_STATUSES]);
  });

  it('is on its way until it is delivered, returned, cancelled or failed', () => {
    expect(OPEN_SHIPMENT_STATUSES).toContain('on_hold');
    const closed = SHIPMENT_STATUSES.filter((status) => !isOpenShipment(status));
    expect(closed).toEqual([
      'booking_failed',
      'delivered',
      'partly_delivered',
      'returned',
      'cancelled',
    ]);
  });

  it('upper-cases a typed tracking code, and refuses one with a space', () => {
    const base = { version: 3, accountId: ACCOUNT };
    expect(
      bookShipmentInputSchema.parse({ ...base, trackingCode: ' sfr-2611 ' }).trackingCode,
    ).toBe('SFR-2611');
    expect(
      errorsOf(bookShipmentInputSchema.safeParse({ ...base, trackingCode: 'SFR 26' })),
    ).toEqual({ trackingCode: ['courier_tracking_code_format'] });
    expect(
      errorsOf(bookShipmentInputSchema.safeParse({ ...base, accountId: '', trackingCode: '' })),
    ).toEqual({ accountId: ['courier_pick_account'] });
  });
});

describe("Steadfast's webhook", () => {
  it('keeps the fields it does not know, and takes the consignment id as a number', () => {
    const parsed = steadfastWebhookSchema.parse({
      notification_type: 'delivery_status',
      consignment_id: 1424107,
      invoice: 'W-000123',
      status: 'delivered',
      cod_amount: 578,
    });
    expect(parsed.consignment_id).toBe(1424107);
    expect(parsed).toHaveProperty('cod_amount', 578);
  });

  it('never refuses a notice for its shape: the handler keeps an unknown one raw', () => {
    expect(steadfastWebhookSchema.safeParse({}).success).toBe(true);
    expect(steadfastWebhookSchema.safeParse({ status: 7 }).success).toBe(false);
  });
});

describe('the routes', () => {
  it('set up the accounts with storefront.manage, under /storefront/couriers', () => {
    const { steadfastWebhook, ...accountRoutes } = shippingRoutes;
    for (const route of Object.values(accountRoutes)) {
      expect(route.auth).toBe('bearer');
      expect(route.permission).toBe('storefront.manage');
      expect(route.path.startsWith('/storefront/couriers')).toBe(true);
    }
    expect(steadfastWebhook).toMatchObject({ auth: 'public', method: 'POST' });
    expect('permission' in steadfastWebhook).toBe(false);
  });

  it('tests what is saved, so the test sends no key', () => {
    expect('body' in shippingRoutes.testCourier).toBe(false);
  });

  it('book with storefront.order.manage, like every other move of an order', () => {
    const { bookShipment, retryShipment, courierExport, courierChoices } = storefrontOrderRoutes;
    for (const route of [bookShipment, retryShipment, courierExport, courierChoices]) {
      expect(route.permission).toBe('storefront.order.manage');
    }
  });
});
