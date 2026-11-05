import 'fake-indexeddb/auto';

import type { SyncChange, TaxRate } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import { lookUpPrices } from './prices.js';
import { newCopy, page, product, upsertProduct } from './test-fixtures.js';

const PCS = '01928c4e-0000-7000-8000-000000000001';
const CASE = '01928c4e-0000-7000-8000-000000000002';
const DOZEN = '01928c4e-0000-7000-8000-000000000003';
const LIST = '01928c4e-6666-7000-8000-000000000001';
const OLD_LIST = '01928c4e-6666-7000-8000-000000000002';
const VAT_15 = '01928c4e-6666-7000-8000-000000000003';
const VAT_5 = '01928c4e-6666-7000-8000-000000000004';
const UPDATED = '2026-10-21T04:00:00.000Z';

function rate(id: string, fields: Partial<TaxRate>): SyncChange {
  return {
    op: 'upsert',
    entity: 'tax_rate',
    key: id,
    data: {
      id,
      name: 'VAT 15%',
      kind: 'standard',
      rate: '15.00',
      isDefault: false,
      archivedAt: null,
      version: 1,
      updatedAt: UPDATED,
      ...fields,
    },
  };
}

function list(id: string, archivedAt: string | null): SyncChange {
  return {
    op: 'upsert',
    entity: 'price_list',
    key: id,
    data: {
      id,
      name: 'Dealer prices',
      description: null,
      archivedAt,
      version: 1,
      updatedAt: UPDATED,
    },
  };
}

const juice = product({
  name: 'Mango juice 250 ml',
  taxRateId: VAT_5,
  units: [{ unitId: CASE, factor: '24', barcode: null }],
});
const variant = juice.variants[0];
if (!variant) throw new Error('no variant');
const pricedJuice = { ...juice, variants: [{ ...variant, salePrice: '21.0000' }] };

function item(priceListId: string, unitId: string, price: string): SyncChange {
  const data = {
    priceListId,
    productId: juice.id,
    variantId: variant?.id ?? '',
    unitId,
    price,
    updatedAt: UPDATED,
  };
  return {
    op: 'upsert',
    entity: 'price_list_item',
    key: `${priceListId}:${data.variantId}:${unitId}`,
    data,
  };
}

async function loaded() {
  const copy = await newCopy();
  await applyPage(
    copy,
    page({
      full: true,
      changes: [
        rate(VAT_15, { isDefault: true }),
        rate(VAT_5, { name: 'VAT 5%', rate: '5.00' }),
        list(LIST, null),
        list(OLD_LIST, '2026-09-01T00:00:00.000Z'),
        upsertProduct(pricedJuice),
        item(LIST, CASE, '480.0000'),
        item(OLD_LIST, CASE, '450.0000'),
      ],
    }),
    null,
  );
  return copy;
}

describe('lookUpPrices', () => {
  it('starts a line like the server: the price list, else the product price in the unit', async () => {
    const copy = await loaded();
    const variantId = variant.id;
    expect(
      await lookUpPrices(copy, LIST, [
        { variantId, unitId: CASE },
        { variantId, unitId: PCS },
      ]),
    ).toEqual([
      { variantId, unitId: CASE, price: '480.0000', source: 'price_list', taxRateId: VAT_5 },
      { variantId, unitId: PCS, price: '21.0000', source: 'product', taxRateId: VAT_5 },
    ]);
    // An archived list counts for nothing: a case is 24 × ৳21
    expect(await lookUpPrices(copy, OLD_LIST, [{ variantId, unitId: CASE }])).toEqual([
      { variantId, unitId: CASE, price: '504.0000', source: 'product', taxRateId: VAT_5 },
    ]);
    // A unit the product does not have drops out, like on the server
    expect(await lookUpPrices(copy, null, [{ variantId, unitId: DOZEN }])).toEqual([]);
  });

  it('falls back to the default rate when the product’s own is archived', async () => {
    const copy = await loaded();
    await applyPage(
      copy,
      page({ changes: [rate(VAT_5, { archivedAt: '2026-10-01T00:00:00.000Z' })] }),
      'cursor',
    );
    const [found] = await lookUpPrices(copy, null, [{ variantId: variant.id, unitId: PCS }]);
    expect(found?.taxRateId).toBe(VAT_15);
  });
});
