import { describe, expect, it } from 'vitest';

import { SHOP_ORDER_STATUSES } from './storefront.js';
import {
  cancelStorefrontOrderInputSchema,
  packStorefrontOrderInputSchema,
  STOREFRONT_ORDER_STATUSES,
  storefrontOrderQuerySchema,
  storefrontOrderRoutes,
  type PackStorefrontOrderFormValues,
} from './storefront-orders.js';

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

const BATCH_A = '7d0c1e2f-3a4b-4c5d-8e6f-0a1b2c3d4e5f';
const BATCH_B = '8e1d2f30-4b5c-4d6e-9f70-1b2c3d4e5f60';

// Two lines: 3 pieces of a batch product split over two batches, and one phone with its IMEI
const PACK: PackStorefrontOrderFormValues = {
  version: 4,
  lines: [
    {
      position: 1,
      picks: [
        { batchId: BATCH_A, quantity: '2', serialNumbers: [] },
        { batchId: BATCH_B, quantity: '1', serialNumbers: [] },
      ],
    },
    {
      position: 2,
      picks: [{ batchId: '', quantity: '1', serialNumbers: ['356938035643809'] }],
    },
  ],
};

describe('the statuses the ERP shows', () => {
  it('are every status of a shop order but pending, in the same order', () => {
    expect(STOREFRONT_ORDER_STATUSES).toEqual(
      SHOP_ORDER_STATUSES.filter((status) => status !== 'pending'),
    );
    expect(STOREFRONT_ORDER_STATUSES).not.toContain('pending');
  });

  it('opens the list on the new orders, newest first', () => {
    expect(storefrontOrderQuerySchema.parse({})).toMatchObject({
      view: 'confirmed',
      sort: '-confirmed',
    });
  });

  it('has no tab for orders that wait for their code', () => {
    expect(storefrontOrderQuerySchema.safeParse({ view: 'pending' }).success).toBe(false);
  });
});

describe('Packed', () => {
  it('takes a line split over two batches, and no batch as null', () => {
    const parsed = packStorefrontOrderInputSchema.parse(PACK);
    expect(parsed.lines[0]?.picks.map((pick) => pick.batchId)).toEqual([BATCH_A, BATCH_B]);
    expect(parsed.lines[1]?.picks[0]?.batchId).toBeNull();
  });

  it('refuses a line twice, on the second one', () => {
    const second = PACK.lines[1];
    if (second === undefined) throw new Error('PACK has two lines');
    const result = packStorefrontOrderInputSchema.safeParse({
      ...PACK,
      lines: [
        ...PACK.lines,
        { ...second, picks: [{ batchId: '', quantity: '1', serialNumbers: [] }] },
      ],
    });
    expect(errorsOf(result)).toEqual({ 'lines.2.position': ['storefront_order_line_twice'] });
  });

  it('refuses one serial number scanned on two lines, on the second box', () => {
    const result = packStorefrontOrderInputSchema.safeParse({
      ...PACK,
      lines: [
        PACK.lines[1],
        {
          position: 3,
          picks: [{ batchId: '', quantity: '1', serialNumbers: ['356938035643809'] }],
        },
      ],
    });
    expect(errorsOf(result)).toEqual({
      'lines.1.picks.0.serialNumbers.0': ['stock_serial_twice'],
    });
  });

  it('refuses a pick of nothing, and a line with no pick', () => {
    const result = packStorefrontOrderInputSchema.safeParse({
      version: 4,
      lines: [
        { position: 1, picks: [{ batchId: BATCH_A, quantity: '0', serialNumbers: [] }] },
        { position: 2, picks: [] },
      ],
    });
    expect(Object.keys(errorsOf(result)).sort()).toEqual([
      'lines.0.picks.0.quantity',
      'lines.1.picks',
    ]);
  });
});

describe('Cancel', () => {
  it('keeps no reason as null, and refuses a long one', () => {
    expect(cancelStorefrontOrderInputSchema.parse({ version: 2, reason: '  ' }).reason).toBeNull();
    expect(
      cancelStorefrontOrderInputSchema.safeParse({ version: 2, reason: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('the routes', () => {
  const routes = Object.values(storefrontOrderRoutes);

  it('are all behind the ERP login, under /storefront/orders', () => {
    for (const route of routes) {
      expect(route.auth).toBe('bearer');
      expect(route.path.startsWith('/storefront/orders')).toBe(true);
    }
  });

  // Decision 9: a packer reads and moves orders without storefront.manage (the shop's prices and
  // pages), and every move is .manage, never .read
  it('read with storefront.order.read and change with storefront.order.manage', () => {
    for (const route of routes) {
      const changes = route.method !== 'GET' || route.path.endsWith('/pack-plan');
      expect([route.path, route.permission]).toEqual([
        route.path,
        changes ? 'storefront.order.manage' : 'storefront.order.read',
      ]);
    }
  });
});
