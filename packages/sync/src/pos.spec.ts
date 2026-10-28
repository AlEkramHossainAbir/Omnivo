import 'fake-indexeddb/auto';

import {
  type PosSaleInput,
  stockKey,
  type SyncPosRegister,
  type SyncStock,
  syncCommandSchema,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import type { LocalCopy } from './copy.js';
import { discardEntry } from './outbox.js';
import {
  dropClaim,
  keepClaim,
  localRegisters,
  productByBarcode,
  readClaim,
  savePosSale,
  stockOf,
  waitingSales,
} from './pos.js';
import { outboxEntries } from './queries.js';
import { sealEntry } from './sealed.js';
import { newCopy, page, product, upsertProduct, VAT_15, WAREHOUSE } from './test-fixtures.js';

const SAVED = '2026-10-27T10:15:00.000Z';
const OTHER_WAREHOUSE = '01928c4e-7777-7000-8000-000000000009';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';
const BASE_UNIT = '01928c4e-0000-7000-8000-000000000001';
const BOX = '01928c4e-0000-7000-8000-000000000002';

function register(fields: Partial<SyncPosRegister> & Pick<SyncPosRegister, 'code'>) {
  return {
    id: uuidv7(),
    name: 'Front counter',
    branchId: '01928c4e-6666-7000-8000-000000000001',
    warehouseId: WAREHOUSE,
    accounts: { cash: uuidv7(), card: null, bkash: null, nagad: null },
    maxDiscountPercent: '10.00',
    paperWidth: '80',
    receiptFooter: null,
    deviceId: null,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-10-27T04:00:00.000Z',
    ...fields,
  } satisfies SyncPosRegister;
}

function stock(fields: Partial<SyncStock>): SyncStock {
  return {
    warehouseId: WAREHOUSE,
    productId: uuidv7(),
    variantId: VARIANT,
    batchId: null,
    lotNumber: null,
    manufacturedOn: null,
    expiresOn: null,
    quantity: '38.0000',
    updatedAt: '2026-10-27T04:00:00.000Z',
    ...fields,
  };
}

// A walk-in sale of 2 bags at ৳420, paid ৳1,000 in cash: what the POS screen saves
function sale(
  registerId: string,
  customerId: string | null = null,
): Omit<PosSaleInput, 'sequence'> {
  return {
    registerId,
    date: '2026-10-27',
    soldAt: SAVED,
    customerId,
    pricesIncludeVat: true,
    lines: [
      {
        variantId: VARIANT,
        unitId: BASE_UNIT,
        quantity: '2',
        description: null,
        unitPrice: '420',
        discountType: 'percent',
        discount: '0',
        taxRateId: VAT_15,
        rate: '15.00',
        startingPrice: '420.0000',
        batchId: null,
        serialNumbers: [],
      },
    ],
    billDiscountType: 'amount',
    billDiscount: '0',
    payments: [{ method: 'cash', amount: '1000', reference: null }],
  };
}

async function save(copy: LocalCopy, registerId: string, customerId: string | null = null) {
  return savePosSale(copy, {
    input: sale(registerId, customerId),
    registerCode: 'POS1',
    total: '840.0000',
    savedAt: SAVED,
  });
}

describe('the registers on the device', () => {
  it('keeps the registers the pull sends, sealed, and lists them by code', async () => {
    const copy = await newCopy();
    const second = register({ code: 'POS2', name: 'Pharmacy counter' });
    const first = register({ code: 'POS1' });
    await applyPage(
      copy,
      page({
        changes: [second, first].map((row) => ({
          op: 'upsert' as const,
          entity: 'pos_register' as const,
          key: row.id,
          data: row,
        })),
      }),
      null,
    );
    expect((await localRegisters(copy)).map((row) => row.code)).toEqual(['POS1', 'POS2']);
    // The box holds the name: it is not readable on the disk
    const [stored] = await copy.db.posRegisters.toArray();
    expect(JSON.stringify(stored)).not.toContain('Pharmacy counter');
  });
});

describe('keepClaim', () => {
  it('starts from the server’s last number, and keeps the device’s own when it is ahead', async () => {
    const copy = await newCopy();
    const pos1 = register({ code: 'POS1' });
    expect(await keepClaim(copy, { id: pos1.id, lastNumber: 123 })).toMatchObject({ last: 123 });
    await save(copy, pos1.id);
    await save(copy, pos1.id);
    // A claim again of the register it holds: the server has not received 124 and 125 yet
    expect(await keepClaim(copy, { id: pos1.id, lastNumber: 123 })).toMatchObject({ last: 125 });
  });

  it('starts another register from the server’s number alone', async () => {
    const copy = await newCopy();
    await keepClaim(copy, { id: uuidv7(), lastNumber: 900 });
    const pos2 = uuidv7();
    expect(await keepClaim(copy, { id: pos2, lastNumber: 7 })).toEqual({
      key: 'claim',
      registerId: pos2,
      last: 7,
    });
    await dropClaim(copy);
    expect(await readClaim(copy)).toBeNull();
  });
});

describe('savePosSale', () => {
  it('gives the next number and puts a command in the outbox that the server reads as it is', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 123 });
    const result = await save(copy, registerId);
    expect(result).toMatchObject({ kind: 'saved', sequence: 124, number: 'POS1-000124' });
    const [entry] = await outboxEntries(copy);
    if (entry?.command.type !== 'pos_sale.create') throw new Error('not a POS sale');
    expect(result.kind === 'saved' && result.saleId).toBe(entry.command.saleId);
    expect(entry.command.input.sequence).toBe(124);
    expect(entry).toMatchObject({ name: 'POS1-000124', lines: 1, total: '840.0000' });
    // A walk-in sale waits for nothing: its own id stands in for the customer (push.ts)
    expect(entry.customerId).toBe(entry.command.saleId);
    expect(entry.key).toBe(entry.command.saleId);
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
    expect(await readClaim(copy)).toMatchObject({ last: 124 });
  });

  it('waits for a customer made on the device, like an order', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    const customerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 0 });
    await save(copy, registerId, customerId);
    const [entry] = await outboxEntries(copy);
    expect(entry?.customerId).toBe(customerId);
  });

  it('gives two sales saved at the same moment two numbers', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 41 });
    const results = await Promise.all([save(copy, registerId), save(copy, registerId)]);
    expect(results.map((result) => result.kind === 'saved' && result.sequence).sort()).toEqual([
      42, 43,
    ]);
    expect(await waitingSales(copy)).toBe(2);
  });

  it('saves nothing without the claim of that register', async () => {
    const copy = await newCopy();
    expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
    await keepClaim(copy, { id: uuidv7(), lastNumber: 3 });
    expect(await save(copy, uuidv7())).toEqual({ kind: 'not-held' });
    expect(await waitingSales(copy)).toBe(0);
  });
});

describe('discarding a POS sale', () => {
  it('keeps a sale the server has not refused, and lets a refused one go', async () => {
    const copy = await newCopy();
    const registerId = uuidv7();
    await keepClaim(copy, { id: registerId, lastNumber: 0 });
    await save(copy, registerId);
    const [entry] = await outboxEntries(copy);
    if (entry?.seq === undefined) throw new Error('no entry');
    // Never sent: its number is on a paper receipt, and the server does not know it yet
    expect(await discardEntry(copy, entry.seq)).toBe('busy');
    await copy.db.outbox.put(
      await sealEntry(copy, {
        ...entry,
        status: 'failed',
        sent: true,
        error: { code: 'pos_register_not_held', fieldErrors: {} },
      }),
    );
    expect(await discardEntry(copy, entry.seq)).toBe('saved');
    expect(await waitingSales(copy)).toBe(0);
  });
});

describe('the stock and the scanner', () => {
  it('reads one warehouse’s stock of the variants asked for, every batch', async () => {
    const copy = await newCopy();
    const rows = [
      stock({ batchId: uuidv7(), lotNumber: 'PCM-2611', quantity: '120.0000' }),
      stock({ batchId: uuidv7(), lotNumber: 'PCM-2702', quantity: '40.0000' }),
      stock({ warehouseId: OTHER_WAREHOUSE }),
      stock({ variantId: uuidv7() }),
    ];
    await applyPage(
      copy,
      page({
        changes: rows.map((row) => ({
          op: 'upsert' as const,
          entity: 'stock' as const,
          key: stockKey(row),
          data: row,
        })),
      }),
      null,
    );
    const found = await stockOf(copy, WAREHOUSE, [VARIANT]);
    expect(found.map((row) => row.lotNumber).sort()).toEqual(['PCM-2611', 'PCM-2702']);
    expect(await stockOf(copy, WAREHOUSE, [])).toEqual([]);
  });

  it('takes off what the device’s own unsynced sales took, at the register’s warehouse only', async () => {
    const copy = await newCopy();
    const pos1 = register({ code: 'POS1' });
    const pos2 = register({ code: 'POS2', warehouseId: OTHER_WAREHOUSE });
    const rice = product({
      name: 'Miniket rice 25 kg',
      variants: [
        {
          id: VARIANT,
          sku: 'RC-MIN-25',
          optionValues: [],
          barcode: null,
          salePrice: '420',
          archivedAt: null,
        },
      ],
      units: [{ unitId: BOX, factor: '5', barcode: null }],
    });
    const row = stock({ productId: rice.id });
    await applyPage(
      copy,
      page({
        changes: [
          upsertProduct(rice),
          ...[pos1, pos2].map((item) => ({
            op: 'upsert' as const,
            entity: 'pos_register' as const,
            key: item.id,
            data: item,
          })),
          { op: 'upsert' as const, entity: 'stock' as const, key: stockKey(row), data: row },
        ],
      }),
      null,
    );
    await keepClaim(copy, { id: pos1.id, lastNumber: 0 });
    // 2 bags, then a pack of 5: 7 of the 38 left the counter
    await save(copy, pos1.id);
    const pack = sale(pos1.id);
    await savePosSale(copy, {
      input: {
        ...pack,
        lines: pack.lines.map((line) => ({ ...line, unitId: BOX, quantity: '1' })),
      },
      registerCode: 'POS1',
      total: '2100.0000',
      savedAt: SAVED,
    });
    expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
      '31.0000',
    ]);
    // A sale of a register on another warehouse takes nothing from this one
    await keepClaim(copy, { id: pos2.id, lastNumber: 0 });
    await save(copy, pos2.id);
    expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
      '31.0000',
    ]);
    // Once the sales leave the outbox, the copy's stock counts alone (the pull brings the rest)
    await copy.db.outbox.clear();
    expect((await stockOf(copy, WAREHOUSE, [VARIANT])).map((one) => one.quantity)).toEqual([
      '38.0000',
    ]);
  });

  it('finds a product by a variant’s barcode or a pack’s', async () => {
    const copy = await newCopy();
    const strip = product({
      name: 'Paracetamol 500 mg strip',
      variants: [
        {
          id: VARIANT,
          sku: 'PH-PCM-500',
          optionValues: [],
          barcode: '8941100500017',
          salePrice: '12',
          archivedAt: null,
        },
      ],
      units: [{ unitId: BOX, factor: '10', barcode: '8941100500024' }],
    });
    await applyPage(copy, page({ changes: [upsertProduct(strip)] }), null);
    expect((await productByBarcode(copy, '8941100500017'))?.name).toBe(strip.name);
    expect((await productByBarcode(copy, '8941100500024'))?.id).toBe(strip.id);
    expect(await productByBarcode(copy, '0000000000000')).toBeNull();
  });
});
