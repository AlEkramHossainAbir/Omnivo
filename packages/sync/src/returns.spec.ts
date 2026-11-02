import 'fake-indexeddb/auto';

import {
  type PosReturnableLine,
  type PosSaleInput,
  posReturnAmounts,
  syncCommandSchema,
  type SyncPosSale,
  type TaxRate,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import type { LocalCopy } from './copy.js';
import type { StoredShift } from './database.js';
import { dropClaim, keepClaim, readClaim, savePosSale } from './pos.js';
import { pickBatch } from './push.js';
import { outboxEntries } from './queries.js';
import {
  loadRegisterSales,
  localSale,
  newReturnId,
  type PosReturnSave,
  savePosReturn,
  withReturns,
  withWaitingReturns,
} from './returns.js';
import { closeShift, openShift, readShift, shiftReportOf } from './shift.js';
import { newCopy, page, posRegister, product, upsertProduct, VAT_15 } from './test-fixtures.js';

const DAY = '2026-10-29';
const AT = '2026-10-29T05:00:00.000Z';

const vat15: TaxRate = {
  id: VAT_15,
  name: 'VAT 15%',
  kind: 'standard',
  rate: '15.00',
  isDefault: true,
  archivedAt: null,
  version: 1,
  updatedAt: AT,
};
const polo = product({ name: 'Polo shirt', code: 'POLO-M' });
const POLO = polo.variants[0]?.id ?? '';

// A copy that holds POS1, with the shirt and the rate in it and a shift open
async function counter() {
  const copy = await newCopy();
  const register = posRegister({ code: 'POS1', exchangeAccountId: uuidv7() });
  await applyPage(
    copy,
    page({
      changes: [
        upsertProduct(polo),
        { op: 'upsert', entity: 'tax_rate', key: vat15.id, data: vat15 },
      ],
      serverTime: AT,
    }),
    null,
  );
  await keepClaim(copy, { id: register.id, lastNumber: 0, lastReturnNumber: 0 });
  const opened = await openShift(copy, {
    register,
    input: {
      date: DAY,
      openedAt: AT,
      opening: { notes: null, total: '5000' },
      floatReasonId: null,
    },
    savedAt: AT,
  });
  if (opened.kind !== 'opened') throw new Error(`The shift did not open: ${opened.kind}`);
  return { copy, register, shiftId: opened.shift.id };
}

// Shirts at ৳420 with VAT, paid in cash
function sale(
  registerId: string,
  shiftId: string,
  quantity = '2',
  payments: PosSaleInput['payments'] = [
    { method: 'cash', amount: '1000', reference: null, returnId: null },
  ],
): Omit<PosSaleInput, 'sequence'> {
  return {
    registerId,
    shiftId,
    date: DAY,
    soldAt: AT,
    customerId: null,
    pricesIncludeVat: true,
    lines: [
      {
        id: null,
        variantId: POLO,
        unitId: polo.baseUnitId,
        quantity,
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
    payments,
  };
}

async function sold(copy: LocalCopy, input: Omit<PosSaleInput, 'sequence'>) {
  const saved = await savePosSale(copy, {
    input,
    registerCode: 'POS1',
    total: '840.0000',
    savedAt: AT,
  });
  if (saved.kind !== 'saved') throw new Error(`The sale was not saved: ${saved.kind}`);
  const found = await localSale(copy, saved.number);
  if (!found) throw new Error('The sale is not on the device');
  return found;
}

// One shirt of the sale's first line back, paid back by `refunds`
function giveBack(
  sale: SyncPosSale,
  shiftId: string,
  refunds: (amount: string) => PosReturnSave['input']['refunds'] = (amount) => [
    { method: 'cash', amount, reference: null },
  ],
): PosReturnSave {
  const line = sale.lines[0];
  if (!line) throw new Error('The sale has no line');
  const amounts = posReturnAmounts(line, '1');
  return {
    returnId: newReturnId(),
    registerCode: 'POS1',
    savedAt: AT,
    input: {
      registerId: sale.registerId,
      shiftId,
      date: DAY,
      returnedAt: AT,
      saleId: sale.id,
      lines: [
        {
          saleLineId: line.id,
          quantity: '1',
          net: amounts.net,
          vat: amounts.vat,
          serialNumbers: [],
        },
      ],
      refunds: refunds(amounts.total),
      note: 'Wrong size',
    },
  };
}

// A sale as the server sends it (the pull, the register's recent sales)
function serverSale(number: string, date: string, registerId: string): SyncPosSale {
  return {
    id: uuidv7(),
    number,
    registerId,
    date,
    soldAt: `${date}T05:00:00.000Z`,
    customer: { id: uuidv7(), code: 'C-00042', name: 'Farhana Akter' },
    pricesIncludeVat: true,
    total: '420.0000',
    lines: [],
    payments: [{ method: 'cash', amount: '420.0000' }],
  };
}

describe('a sale on the device', () => {
  it('is kept with the ids of its lines, so its goods can come back before it syncs', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    expect(found).toMatchObject({
      number: 'POS1-000001',
      date: DAY,
      customer: null,
      total: '840.0000',
      payments: [{ method: 'cash', amount: '1000.0000' }],
    });
    expect(found.lines).toMatchObject([
      {
        productName: 'Polo shirt',
        sku: 'POLO-M',
        description: 'Polo shirt',
        quantity: '2.0000',
        baseQuantity: '2.0000',
        unitPrice: '420.0000',
        taxRate: { id: VAT_15, name: 'VAT 15%', rate: '15.00' },
        total: '840.0000',
        returnedQuantity: '0.0000',
      },
    ]);
    // The command names the same line: the server keeps the device's id
    const [, saleEntry] = await outboxEntries(copy);
    const command = syncCommandSchema.parse(saleEntry?.command);
    expect(command.type === 'pos_sale.create' && command.input.lines[0]?.id).toBe(
      found.lines[0]?.id,
    );
    // The number is clear for the search, the rest sealed
    const [row] = await copy.db.posSales.toArray();
    expect(row?.number).toBe('POS1-000001');
    expect(JSON.stringify(row)).not.toContain('Polo shirt');
  });
});

describe('a return on the device', () => {
  it('takes the next return number, its cash out of the drawer, and less is left to return', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    const first = giveBack(found, shiftId);
    expect(await savePosReturn(copy, first)).toEqual({
      kind: 'saved',
      sequence: 1,
      number: 'POS1-R000001',
    });
    const [, , entry] = await outboxEntries(copy);
    expect(entry).toMatchObject({
      key: first.returnId,
      customerId: first.returnId,
      name: 'POS1-R000001',
      lines: 1,
      total: null,
      shiftId,
      after: found.id,
    });
    expect(syncCommandSchema.parse(entry?.command)).toMatchObject({
      type: 'pos_return.create',
      returnId: first.returnId,
      input: { sequence: 1, saleId: found.id },
    });
    expect((await readClaim(copy))?.lastReturn).toBe(1);
    // ৳420 back in cash: out of the drawer, and in the X report's sums
    const shift = await readShift(copy);
    expect(shift?.cash.cashRefunded).toBe('420.0000');
    expect(shift?.tally).toMatchObject({
      returnCount: 1,
      returnsTotal: '420.0000',
      refunded: [{ method: 'cash', amount: '420.0000' }],
    });

    // The sale's row still says nothing came back (the server's word); the outbox says one did
    const left = await withWaitingReturns(copy, found);
    expect(left.lines[0]?.returnedQuantity).toBe('1.0000');
    const second = giveBack(left, shiftId);
    expect(await savePosReturn(copy, second)).toMatchObject({ number: 'POS1-R000002' });
    // The second shirt takes the rest of the line, to the paisa
    expect(second.input.lines[0]).toMatchObject({ net: '365.2200', vat: '54.7800' });
  });

  it("adds only the returns never sent to the server's answer, which counted the others", async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    await savePosReturn(copy, giveBack(found, shiftId));
    // The server's answer counts the return once it ran it; the device's copy still says none
    const server = withReturns(found, [
      {
        lines: [
          {
            saleLineId: found.lines[0]?.id ?? '',
            quantity: '1',
            net: '0',
            vat: '0',
            serialNumbers: [],
          },
        ],
      },
    ]);
    // Not sent yet: the server cannot have it, so it is added
    expect((await withWaitingReturns(copy, found, true)).lines[0]?.returnedQuantity).toBe('1.0000');
    // Sent, its answer on the way: the server's own count has it already
    await copy.db.outbox.toCollection().modify({ sent: true, status: 'sending' });
    expect((await withWaitingReturns(copy, server, true)).lines[0]?.returnedQuantity).toBe(
      '1.0000',
    );
    // The device's own row still counts it, sent or not
    expect((await withWaitingReturns(copy, found)).lines[0]?.returnedQuantity).toBe('1.0000');
  });

  it('needs the register and its open shift', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    const other = giveBack({ ...found, registerId: uuidv7() }, shiftId);
    expect(await savePosReturn(copy, other)).toEqual({ kind: 'not-held' });
    expect(await savePosReturn(copy, giveBack(found, uuidv7()))).toEqual({ kind: 'no-shift' });
  });

  it('counts the serial numbers and quantities of every return of a line', () => {
    const line: PosReturnableLine = {
      id: uuidv7(),
      variantId: POLO,
      productId: polo.id,
      productCode: 'POLO-M',
      productName: 'Polo shirt',
      optionValues: [],
      sku: 'POLO-M',
      baseUnitId: polo.baseUnitId,
      tracking: 'serial',
      unitId: polo.baseUnitId,
      quantity: '3.0000',
      baseQuantity: '3.0000',
      description: 'Polo shirt',
      unitPrice: '420.0000',
      taxRate: { id: VAT_15, name: 'VAT 15%', kind: 'standard', rate: '15.00' },
      net: '1095.6522',
      vat: '164.3478',
      total: '1260.0000',
      serialNumbers: ['A1', 'A2', 'A3'],
      returnedSerialNumbers: ['A1'],
      returnedQuantity: '1.0000',
    };
    const back = withReturns({ ...serverSale('POS1-000009', DAY, uuidv7()), lines: [line] }, [
      {
        lines: [{ saleLineId: line.id, quantity: '1', net: '0', vat: '0', serialNumbers: ['A2'] }],
      },
    ]);
    expect(back.lines[0]).toMatchObject({
      returnedQuantity: '2.0000',
      returnedSerialNumbers: ['A1', 'A2'],
    });
  });
});

describe('an exchange', () => {
  it('is saved with its sale: the return first, the sale waiting for it, no cash out', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    // One shirt back (৳420), two new ones (৳840): the return's money and ৳500 in cash, ৳80 change
    const back = giveBack(found, shiftId, (amount) => [
      { method: 'exchange', amount, reference: null },
    ]);
    const saved = await savePosSale(copy, {
      input: sale(register.id, shiftId, '2', [
        { method: 'exchange', amount: '420', reference: null, returnId: back.returnId },
        { method: 'cash', amount: '500', reference: null, returnId: null },
      ]),
      registerCode: 'POS1',
      total: '840.0000',
      savedAt: AT,
      exchange: back,
    });
    expect(saved).toMatchObject({
      kind: 'saved',
      number: 'POS1-000002',
      returnNumber: 'POS1-R000001',
    });
    const entries = await outboxEntries(copy);
    expect(entries.map((entry) => [entry.name, entry.after ?? null])).toEqual([
      ['POS1-S0001', null],
      ['POS1-000001', null],
      ['POS1-R000001', found.id],
      ['POS1-000002', back.returnId],
    ]);
    expect(await readClaim(copy)).toMatchObject({ last: 2, lastReturn: 1 });
    const shift = await readShift(copy);
    // The exchange never touches the drawer: ৳1,000 and ৳500 in cash, ৳160 and ৳80 change, nothing
    // refunded
    expect(shift?.cash).toMatchObject({
      cashTaken: '1500.0000',
      changeGiven: '240.0000',
      cashRefunded: '0.0000',
    });
    expect(shift?.tally).toMatchObject({
      saleCount: 2,
      returnCount: 1,
      taken: [
        { method: 'cash', amount: '1500.0000' },
        { method: 'exchange', amount: '420.0000' },
      ],
      refunded: [{ method: 'exchange', amount: '420.0000' }],
    });
  });

  it('goes to the server in its order: the sale, its return, the exchange sale', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    const back = giveBack(found, shiftId, (amount) => [
      { method: 'exchange', amount, reference: null },
    ]);
    await savePosSale(copy, {
      input: sale(register.id, shiftId, '1', [
        { method: 'exchange', amount: '420', reference: null, returnId: back.returnId },
      ]),
      registerCode: 'POS1',
      total: '420.0000',
      savedAt: AT,
      exchange: back,
    });
    // Each batch as the push would take it, its commands then accepted (gone from the outbox)
    const batches: string[][] = [];
    for (let round = 0; round < 5; round += 1) {
      const rows = await copy.db.outbox.toArray();
      const batch = pickBatch(rows);
      if (batch.length === 0) break;
      batches.push(batch.map((row) => row.type));
      await copy.db.outbox.bulkDelete(batch.flatMap((row) => row.seq ?? []));
    }
    expect(batches).toEqual([
      ['pos_shift.open'],
      ['pos_sale.create'],
      ['pos_return.create'],
      ['pos_sale.create'],
    ]);
  });
});

describe("the register's recent sales", () => {
  it('are read page by page once after the claim, and leave with the claim', async () => {
    const { copy, register } = await counter();
    const pages = [
      { items: [serverSale('POS1-000117', '2026-10-02', register.id)], nextCursor: 'next' },
      { items: [serverSale('POS1-000118', '2026-10-28', register.id)], nextCursor: null },
    ];
    const asked: (string | null)[] = [];
    const loaded = await loadRegisterSales(copy, register.id, (cursor) => {
      asked.push(cursor);
      return Promise.resolve(pages[asked.length - 1] ?? { items: [], nextCursor: null });
    });
    expect(loaded).toBe('loaded');
    expect(asked).toEqual([null, 'next']);
    expect((await readClaim(copy))?.salesLoaded).toBe(true);
    expect((await localSale(copy, 'POS1-000117'))?.customer?.name).toBe('Farhana Akter');
    // The same claim again keeps them; a sign-out or Change register takes them away
    await keepClaim(copy, { id: register.id, lastNumber: 118, lastReturnNumber: 0 });
    expect((await readClaim(copy))?.salesLoaded).toBe(true);
    await dropClaim(copy);
    expect(await copy.db.posSales.count()).toBe(0);
  });

  it('are not written once another register is held', async () => {
    const { copy, register } = await counter();
    const loaded = await loadRegisterSales(copy, uuidv7(), () =>
      Promise.resolve({
        items: [serverSale('POS2-000001', DAY, register.id)],
        nextCursor: null,
      }),
    );
    expect(loaded).toBe('not-held');
    expect(await copy.db.posSales.count()).toBe(0);
  });

  it('come with the pull, sealed, and go after 30 days at the end of a pull', async () => {
    const { copy, register } = await counter();
    const old = serverSale('POS1-000001', '2026-09-20', register.id);
    const recent = serverSale('POS1-000090', '2026-10-27', register.id);
    await applyPage(
      copy,
      page({
        changes: [old, recent].map((data) => ({
          op: 'upsert' as const,
          entity: 'pos_sale' as const,
          key: data.id,
          data,
        })),
        serverTime: '2026-10-29T18:30:00.000Z',
      }),
      null,
    );
    const rows = await copy.db.posSales.toArray();
    expect(rows.map((row) => row.number)).toEqual(['POS1-000090']);
    expect(JSON.stringify(rows)).not.toContain('Farhana Akter');
  });
});

describe('the shift reports', () => {
  it('are blind while the shift is open, and have the drawer once it is closed', async () => {
    const { copy, register, shiftId } = await counter();
    const found = await sold(copy, sale(register.id, shiftId));
    await savePosReturn(copy, giveBack(found, shiftId));
    const fields = { register, cashierName: 'Sumi Akter', printedAt: AT };
    const open = await readShift(copy);
    if (!open) throw new Error('no shift');
    const x = shiftReportOf(open, { ...fields, kind: 'x' });
    expect(x).toMatchObject({
      kind: 'x',
      shiftNumber: 'POS1-S0001',
      closedAt: null,
      saleCount: 1,
      salesTotal: '840.0000',
      returnCount: 1,
      returnsTotal: '420.0000',
      drawer: null,
    });
    const closed = await closeShift(copy, {
      shiftId,
      input: { date: DAY, closedAt: AT, counted: { notes: null, total: '5420' } },
      savedAt: AT,
    });
    if (closed.kind !== 'closed') throw new Error('not closed');
    // 5,000 + 1,000 − 160 change − 420 back = ৳5,420
    expect(shiftReportOf(closed.shift, { ...fields, kind: 'z' }).drawer).toMatchObject({
      cashRefunded: '420.0000',
      expected: '5420.0000',
      counted: '5420',
      difference: '0.0000',
    });
  });

  it('read a shift opened before 20c as one with no returns yet', async () => {
    const { copy, shiftId } = await counter();
    const row = await copy.db.posShift.get('shift');
    if (!row) throw new Error('no shift');
    const shift = await copy.open('posShift', 'shift', row.box);
    // What 20b's app saved: no cash refunded, no tally
    const old: StoredShift = {
      ...shift,
      cash: {
        opening: shift.cash.opening,
        cashTaken: '0',
        changeGiven: '0',
        paidIn: '0',
        paidOut: '0',
      },
    };
    delete old.tally;
    await copy.db.posShift.put({ ...row, box: await copy.seal('posShift', 'shift', old) });
    expect(await readShift(copy)).toMatchObject({
      id: shiftId,
      cash: { cashRefunded: '0' },
      tally: { saleCount: 0, returnCount: 0, taken: [] },
    });
  });
});
