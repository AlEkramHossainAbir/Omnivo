import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import {
  customerPage,
  customerSummaryOf,
  findCustomers,
  findProducts,
  productPage,
  productSummaryOf,
} from './queries.js';
import {
  customer,
  newDatabase,
  page,
  product,
  upsertCustomer,
  upsertProduct,
} from './test-fixtures.js';

const MEDICINE = '01928c4e-5555-7000-8000-000000000001';
const SYRUP = '01928c4e-5555-7000-8000-000000000002';

const napa = product({
  name: 'Napa 500 mg tablet',
  code: 'MED-0002',
  categoryId: MEDICINE,
  units: [{ unitId: MEDICINE, factor: '10', barcode: '8941100500017' }],
});
const ace = product({ name: 'ace Plus tablet', code: 'MED-0001', categoryId: MEDICINE });
const tusca = product({ name: 'Tusca syrup 100 ml', code: 'MED-0003', categoryId: SYRUP });
const polo = product({
  name: 'Polo shirt',
  code: 'FG-0001',
  options: [{ name: 'Size', values: ['M', 'L'] }],
  variants: [
    {
      id: SYRUP,
      sku: 'POLO-NVY-M',
      optionValues: ['M'],
      barcode: '2000000000015',
      salePrice: '650.0000',
      archivedAt: null,
    },
    {
      id: MEDICINE,
      sku: 'POLO-NVY-L',
      optionValues: ['L'],
      barcode: null,
      salePrice: '700.0000',
      archivedAt: null,
    },
    {
      id: napa.id,
      sku: 'POLO-NVY-XXL',
      optionValues: ['XXL'],
      barcode: null,
      salePrice: '900.0000',
      archivedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
});

async function loaded() {
  const db = newDatabase();
  await applyPage(
    db,
    page({
      full: true,
      changes: [napa, ace, tusca, polo].map(upsertProduct).concat(
        [
          customer({
            name: 'Rahman Traders',
            code: 'C-00001',
            phone: '01711-234567',
            groupId: MEDICINE,
          }),
          customer({ name: 'Bismillah Store', code: 'C-00002', contactPerson: 'Karim Mia' }),
          customer({ name: 'Anwar Pharmacy', code: 'C-00003', groupId: MEDICINE }),
        ].map(upsertCustomer),
      ),
    }),
    null,
  );
  return db;
}

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);

describe('productPage', () => {
  it('sorts by name without case, like the server, and says when there is more', async () => {
    const db = await loaded();
    const first = await productPage(db, { search: '', categoryIds: null, sort: 'name', limit: 3 });
    expect(names(first.rows)).toEqual(['ace Plus tablet', 'Napa 500 mg tablet', 'Polo shirt']);
    expect(first.more).toBe(true);
    const all = await productPage(db, { search: '', categoryIds: null, sort: '-name', limit: 10 });
    expect(names(all.rows)).toEqual([
      'Tusca syrup 100 ml',
      'Polo shirt',
      'Napa 500 mg tablet',
      'ace Plus tablet',
    ]);
    expect(all.more).toBe(false);
  });

  it('sorts by code', async () => {
    const db = await loaded();
    const rows = (await productPage(db, { search: '', categoryIds: null, sort: 'code', limit: 10 }))
      .rows;
    expect(rows.map((row) => row.code)).toEqual(['FG-0001', 'MED-0001', 'MED-0002', 'MED-0003']);
  });

  it('finds by part of the name, the code or a SKU, and by a whole barcode', async () => {
    const db = await loaded();
    expect(names(await findProducts(db, 'TABLET'))).toEqual([
      'ace Plus tablet',
      'Napa 500 mg tablet',
    ]);
    expect(names(await findProducts(db, 'med-0003'))).toEqual(['Tusca syrup 100 ml']);
    // An archived variant's SKU still finds its product, like the server
    expect(names(await findProducts(db, 'nvy-xxl'))).toEqual(['Polo shirt']);
    // A pack's barcode and a variant's barcode, whole only
    expect(names(await findProducts(db, '8941100500017'))).toEqual(['Napa 500 mg tablet']);
    expect(names(await findProducts(db, '2000000000015'))).toEqual(['Polo shirt']);
    expect(await findProducts(db, '89411005')).toEqual([]);
  });

  it('filters by the categories it is given', async () => {
    const db = await loaded();
    const rows = (
      await productPage(db, { search: '', categoryIds: new Set([SYRUP]), sort: 'name', limit: 10 })
    ).rows;
    expect(names(rows)).toEqual(['Tusca syrup 100 ml']);
  });
});

describe('productSummaryOf', () => {
  it('counts and prices the active variants only, like the server list', () => {
    expect(productSummaryOf(polo)).toMatchObject({
      hasVariants: true,
      variantCount: 2,
      minPrice: '650.0000',
      maxPrice: '700.0000',
    });
    expect(productSummaryOf(napa)).toMatchObject({
      hasVariants: false,
      minPrice: null,
      maxPrice: null,
    });
  });
});

describe('customerPage', () => {
  it('sorts by name, filters by group and searches the phone and contact person', async () => {
    const db = await loaded();
    const all = await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 10 });
    expect(names(all.rows)).toEqual(['Anwar Pharmacy', 'Bismillah Store', 'Rahman Traders']);
    const group = await customerPage(db, {
      search: '',
      groupId: MEDICINE,
      sort: '-name',
      limit: 10,
    });
    expect(names(group.rows)).toEqual(['Rahman Traders', 'Anwar Pharmacy']);
    expect(names(await findCustomers(db, '1711'))).toEqual(['Rahman Traders']);
    expect(names(await findCustomers(db, 'karim'))).toEqual(['Bismillah Store']);
    expect(names(await findCustomers(db, 'c-0000'))).toHaveLength(3);
  });

  it('has no balance on the device', async () => {
    const db = await loaded();
    const [first] = (await customerPage(db, { search: '', groupId: '', sort: 'name', limit: 1 }))
      .rows;
    expect(first && customerSummaryOf(first).balance).toBeNull();
  });
});
