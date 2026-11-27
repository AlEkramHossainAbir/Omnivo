import type { PermissionKey } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { landingFor, moduleById, moduleOf, visibleModules, waitingIn } from './nav';

// The person who may do nothing at all: every link with a `show` is hidden, every link without
// one stays. A role in the app always has more than this, so it is the hardest case for the rail
const nobody = () => false;
const allowing =
  (...allowed: PermissionKey[]) =>
  (permission: PermissionKey) =>
    allowed.includes(permission);

describe('moduleOf', () => {
  it('matches a link exactly', () => {
    expect(moduleOf('/')).toBe('home');
    expect(moduleOf('/customers')).toBe('sell');
    expect(moduleOf('/bills')).toBe('buy');
    expect(moduleOf('/settings')).toBe('setup');
  });

  it('matches a page under a link by its longest prefix', () => {
    expect(moduleOf('/customers/0f8e/edit')).toBe('sell');
    expect(moduleOf('/invoices/new')).toBe('sell');
    expect(moduleOf('/stock/adjustments/new')).toBe('stock');
    expect(moduleOf('/reports/ar-aging/0f8e')).toBe('reports');
    expect(moduleOf('/storefront/appearance/collections/new')).toBe('shop');
  });

  it('keeps the two sides of /pos apart', () => {
    // The counter and what it sold are Sell; the register and its cash reasons are a setting. An
    // exact match has to win over the prefix, or all four would land in the same module
    expect(moduleOf('/pos')).toBe('sell');
    expect(moduleOf('/pos/sales')).toBe('sell');
    expect(moduleOf('/pos/sales/0f8e')).toBe('sell');
    expect(moduleOf('/pos/shifts')).toBe('sell');
    expect(moduleOf('/pos/registers')).toBe('setup');
    expect(moduleOf('/pos/cash-reasons')).toBe('setup');
  });

  it('tells the two kinds of categories apart', () => {
    expect(moduleOf('/products/categories')).toBe('stock');
    expect(moduleOf('/storefront/categories')).toBe('shop');
  });

  it('ignores a trailing slash', () => {
    expect(moduleOf('/customers/')).toBe('sell');
    expect(moduleOf('/')).toBe('home');
  });

  it('gives null for a page that belongs to no module', () => {
    // The sync line and My devices are reached from every module, so the rail marks nothing
    expect(moduleOf('/sync')).toBeNull();
    expect(moduleOf('/my-devices')).toBeNull();
    expect(moduleOf('/nothing-here')).toBeNull();
  });
});

describe('visibleModules', () => {
  it('leaves out a module whose every link needs a permission', () => {
    const ids = visibleModules(nobody).map((module) => module.id);
    // Every shop link needs one of the three storefront permissions, and every report link needs
    // a report one, so neither module is in this person's rail at all
    expect(ids).toEqual(['home', 'sell', 'buy', 'stock', 'accounts', 'setup']);
  });

  it('brings Reports back for one kind of report', () => {
    const ids = visibleModules(allowing('sales.report.read')).map((module) => module.id);
    expect(ids).toContain('reports');
  });

  it('brings the shop back for an accountant who only records payouts', () => {
    const ids = visibleModules(allowing('storefront.payout.manage')).map((module) => module.id);
    expect(ids).toContain('shop');
  });

  it('keeps the rail in the table order', () => {
    const ids = visibleModules(allowing('storefront.manage', 'accounting.report.read')).map(
      (module) => module.id,
    );
    expect(ids).toEqual(['home', 'sell', 'buy', 'stock', 'accounts', 'shop', 'reports', 'setup']);
  });
});

describe('landingFor', () => {
  it('opens the module at its own landing page', () => {
    expect(landingFor(moduleById('home'), nobody)).toBe('/');
    expect(landingFor(moduleById('sell'), nobody)).toBe('/sales-orders');
    expect(landingFor(moduleById('buy'), nobody)).toBe('/purchase-orders');
    expect(landingFor(moduleById('stock'), nobody)).toBe('/stock');
    expect(landingFor(moduleById('accounts'), nobody)).toBe('/accounts');
    expect(landingFor(moduleById('setup'), nobody)).toBe('/settings');
  });

  it('never lands on the POS screen, which has no shell', () => {
    // Sell's first link is the counter. A landing page is the first link that is not `bare`
    expect(landingFor(moduleById('sell'), allowing('pos.sale.create'))).not.toBe('/pos');
  });

  it('falls back to the first link the person may open', () => {
    // No accounting reports: Reports opens at the sales report instead of the trial balance
    expect(landingFor(moduleById('reports'), allowing('sales.report.read'))).toBe('/reports/sales');
    // The shop's landing is its orders; an accountant with only payouts gets those
    expect(landingFor(moduleById('shop'), allowing('storefront.payout.manage'))).toBe(
      '/storefront/payouts',
    );
    expect(landingFor(moduleById('shop'), allowing('storefront.order.read'))).toBe(
      '/storefront/orders',
    );
  });
});

describe('waitingIn', () => {
  const counts = { approvals: 3, shopOrders: 5 };

  it('adds up the counts of the links the person can see', () => {
    expect(waitingIn(moduleById('buy'), nobody, counts)).toBe(3);
    expect(waitingIn(moduleById('shop'), allowing('storefront.order.read'), counts)).toBe(5);
  });

  it('counts nothing for a link the person may not open', () => {
    // No storefront.order.read: the orders are not in this person's menu, so the rail is quiet
    expect(waitingIn(moduleById('shop'), allowing('storefront.manage'), counts)).toBe(0);
  });

  it('is zero for a module with no badge', () => {
    expect(waitingIn(moduleById('stock'), nobody, counts)).toBe(0);
  });
});
