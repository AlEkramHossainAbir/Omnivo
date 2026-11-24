import { describe, expect, it } from 'vitest';

import {
  createStorefrontPaymentGatewayInputSchema,
  storefrontPaymentGatewaySchema,
  storefrontPaymentRoutes,
  updateStorefrontPaymentGatewayInputSchema,
  type StorefrontPaymentGatewayFormValues,
} from './storefront-payments.js';

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

const MONEY = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const FEE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

// A sandbox store, as SSLCommerz's sign-up email sends it. FIRST is the first save, FORM a later one
const FIRST = {
  storeId: 'nirvo67412bc0d9f1e',
  password: 'nirvo67412bc0d9f1e@ssl',
  mode: 'sandbox',
  moneyAccountId: MONEY,
  feeAccountId: FEE,
} as const;
const FORM: StorefrontPaymentGatewayFormValues = { ...FIRST, version: 3 };

describe('the payment gateway form', () => {
  it('needs a password the first time, and keeps the saved one when the box is empty later', () => {
    expect(createStorefrontPaymentGatewayInputSchema.parse(FIRST)).toEqual(FIRST);
    expect(
      errorsOf(createStorefrontPaymentGatewayInputSchema.safeParse({ ...FIRST, password: '' })),
    ).toEqual({ password: ['storefront_gateway_password_required'] });
    expect(updateStorefrontPaymentGatewayInputSchema.parse({ ...FORM, password: '' })).toEqual({
      ...FORM,
      password: '',
    });
  });

  it('trims the store id but never the password', () => {
    const parsed = updateStorefrontPaymentGatewayInputSchema.parse({
      ...FORM,
      storeId: '  nirvo67412bc0d9f1e ',
      password: ' secret with spaces ',
    });
    expect(parsed.storeId).toBe('nirvo67412bc0d9f1e');
    expect(parsed.password).toBe(' secret with spaces ');
  });

  it('refuses a store id with other characters, and an empty one', () => {
    expect(
      errorsOf(updateStorefrontPaymentGatewayInputSchema.safeParse({ ...FORM, storeId: 'nir vo' })),
    ).toEqual({ storeId: ['storefront_gateway_store_id_format'] });
    expect(
      errorsOf(updateStorefrontPaymentGatewayInputSchema.safeParse({ ...FORM, storeId: ' ' })),
    ).toEqual({ storeId: ['required'] });
  });

  it("says which account to pick when a select is left on 'Pick an account'", () => {
    expect(
      errorsOf(
        updateStorefrontPaymentGatewayInputSchema.safeParse({
          ...FORM,
          moneyAccountId: '',
          feeAccountId: '',
        }),
      ),
    ).toEqual({
      moneyAccountId: ['storefront_gateway_money_account_invalid'],
      feeAccountId: ['storefront_gateway_fee_account_invalid'],
    });
  });

  it('takes sandbox or live only, and a later save needs its version', () => {
    expect(
      updateStorefrontPaymentGatewayInputSchema.safeParse({ ...FORM, mode: 'test' }).success,
    ).toBe(false);
    expect(updateStorefrontPaymentGatewayInputSchema.safeParse(FIRST).success).toBe(false);
  });
});

describe('the saved gateway', () => {
  it('never has a password field', () => {
    expect(Object.keys(storefrontPaymentGatewaySchema.shape)).not.toContain('password');
    const parsed = storefrontPaymentGatewaySchema.parse({
      provider: 'sslcommerz',
      storeId: 'nirvo67412bc0d9f1e',
      mode: 'live',
      moneyAccountId: MONEY,
      feeAccountId: FEE,
      ready: true,
      lastTest: { at: '2026-11-22T04:00:00.000Z', problem: null },
      version: 4,
      updatedAt: '2026-11-22T04:00:00.000Z',
      // A server that sent one by mistake: the parse drops it, so no page ever shows it
      password: 'leaked',
    });
    expect(parsed).not.toHaveProperty('password');
  });
});

describe('the routes', () => {
  it('all need storefront.manage, under /storefront/payment-gateway', () => {
    for (const route of Object.values(storefrontPaymentRoutes)) {
      expect(route.auth).toBe('bearer');
      expect(route.permission).toBe('storefront.manage');
      expect(route.path.startsWith('/storefront/payment-gateway')).toBe(true);
    }
  });

  it('tests what is saved, so the test sends no password', () => {
    expect('body' in storefrontPaymentRoutes.testPaymentGateway).toBe(false);
  });
});
