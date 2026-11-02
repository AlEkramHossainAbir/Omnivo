import {
  addMoney,
  defaultLineDescription,
  formatReturnNumber,
  POS_SALES_ON_DEVICE_DAYS,
  type PosReturnableLine,
  type PosReturnableSale,
  type PosReturnInput,
  type PosSaleInput,
  posSaleAmounts,
  shiftIsoDate,
  sumMoney,
  sumQuantity,
  type SyncCommand,
  type SyncPosSale,
  type TaxRate,
  toBaseQuantity,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { LocalCopy } from './copy.js';
import type { OutboxEntry, PosSaleRow, SyncDatabase } from './database.js';
import { productsOfVariants } from './prices.js';
import { localCustomer } from './queries.js';
import { openEntries, openRows, sealEntry } from './sealed.js';
import { type ReturnEffect, shiftAfter, shiftAfterReturn } from './shift.js';
import { readPullState } from './state.js';

// Step 20c: returns at the counter, on the device. The sales a return can come from are rows of
// the posSales table: the register's recent sales from the server, and each sale this device makes,
// written when it is saved (pos.ts), so the goods of a sale sold offline can come back before it
// syncs. A return goes into the outbox like a sale, with the next number of the register's return
// series, and takes its cash out of the shift. No Dexie import, like pos.ts.

type Unstamped<R> = Omit<R, 'gen'>;

// The id of a return the screen starts. Made before the save: an exchange's sale names it in its
// payment while the cart is still on the screen.
export function newReturnId(): string {
  return uuidv7();
}

// ---------------------------------------------------------------------------------------------
// The sales on the device

export async function sealSale(copy: LocalCopy, sale: SyncPosSale): Promise<Unstamped<PosSaleRow>> {
  return {
    key: sale.id,
    number: sale.number,
    date: sale.date,
    box: await copy.seal('posSales', sale.id, sale),
  };
}

// The sale as the server would send it, made from what the device saved: the products' names and
// the VAT rates from the copy, the money from the same arithmetic as the server's (posSaleAmounts).
// null when the copy cannot say it all (a product archived since the cart was made, a line saved
// before 20c without an id): that sale comes back only once the server has it.
export async function localSaleOf(
  copy: LocalCopy,
  sale: { id: string; number: string; input: Omit<PosSaleInput, 'sequence'> },
): Promise<SyncPosSale | null> {
  const { input } = sale;
  const rateIds = [...new Set(input.lines.map((line) => line.taxRateId))];
  const [products, rateRows, customer] = await Promise.all([
    productsOfVariants(
      copy,
      input.lines.map((line) => line.variantId),
    ),
    copy.db.taxRates.where('key').anyOf(rateIds).toArray(),
    input.customerId === null ? null : localCustomer(copy, input.customerId),
  ]);
  const rates = await openRows<TaxRate>(copy, 'taxRates', rateRows);
  const { lines: amounts, totals } = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const lines: PosReturnableLine[] = [];
  for (const [index, line] of input.lines.entries()) {
    const product = products.get(line.variantId);
    const variant = product?.variants.find((one) => one.id === line.variantId);
    const rate = rates.find((one) => one.id === line.taxRateId);
    const amount = amounts[index];
    const factor =
      line.unitId === product?.baseUnitId
        ? '1'
        : product?.units.find((pack) => pack.unitId === line.unitId)?.factor;
    if (!product || !variant || !rate || !amount || factor === undefined || line.id === null) {
      return null;
    }
    const ref = { productName: product.name, optionValues: variant.optionValues };
    lines.push({
      id: line.id,
      variantId: variant.id,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      optionValues: variant.optionValues,
      sku: variant.sku,
      baseUnitId: product.baseUnitId,
      tracking: product.tracking,
      unitId: line.unitId,
      // 4 decimals, like the server's rows: the screen compares them with the return's
      quantity: sumQuantity([line.quantity]),
      baseQuantity: toBaseQuantity(line.quantity, factor, 4),
      description: line.description ?? defaultLineDescription(ref),
      unitPrice: sumMoney([line.unitPrice]),
      // The rate the sale used, with the name the copy has for it
      taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: line.rate },
      net: amount.net,
      vat: amount.vat,
      total: amount.total,
      serialNumbers: line.serialNumbers,
      returnedSerialNumbers: [],
      returnedQuantity: '0.0000',
    });
  }
  return {
    id: sale.id,
    number: sale.number,
    registerId: input.registerId,
    date: input.date,
    soldAt: input.soldAt,
    customer: customer && { id: customer.id, code: customer.code, name: customer.name },
    pricesIncludeVat: input.pricesIncludeVat,
    total: totals.total,
    lines,
    payments: input.payments.map((payment) => ({
      method: payment.method,
      amount: sumMoney([payment.amount]),
    })),
  };
}

// A receipt of this register by its number (the screen trims it and makes it upper case, like the
// route). null = not on the device: older than POS_SALES_ON_DEVICE_DAYS, another register's, or a
// typing mistake.
export async function localSale(
  copy: LocalCopy,
  number: string,
): Promise<PosReturnableSale | null> {
  const row = await copy.db.posSales.where('number').equals(number).first();
  return row ? copy.open('posSales', row.key, row.box) : null;
}

// What earlier returns took back, with the returns still on this device: the server's row (or its
// answer online) counts only the returns it has posted. A return refused by the server counts too:
// the goods came back and the money went out all the same, like a refused sale's stock (pos.ts).
export function withReturns(
  sale: PosReturnableSale,
  returns: readonly Pick<PosReturnInput, 'lines'>[],
): PosReturnableSale {
  const back = returns.flatMap((item) => item.lines);
  if (back.length === 0) return sale;
  return {
    ...sale,
    lines: sale.lines.map((line) => {
      const mine = back.filter((item) => item.saleLineId === line.id);
      if (mine.length === 0) return line;
      return {
        ...line,
        returnedQuantity: sumQuantity([
          line.returnedQuantity,
          ...mine.map((item) => item.quantity),
        ]),
        returnedSerialNumbers: [
          ...line.returnedSerialNumbers,
          ...mine.flatMap((item) => item.serialNumbers),
        ],
      };
    }),
  };
}

// The returns of one sale still in the outbox: each waits for its sale (`after`), so the clear
// field finds them, and only those are opened. `fromServer`: the sale is the server's answer of
// just now, which counts every return the server has. A return sent already (`sent`) may be one of
// them, its answer still on the way, so only the ones never sent are added: counted twice, the
// screen would say less is left than is (step 20c.7 found it, a second return right after the
// first). One sent that the server has not run yet then counts nowhere; the server takes that
// over-return and writes the audit log (decision 20). The device's own row (a sale from the copy)
// leaves the outbox in the same transaction that writes its returns, so it counts every one.
export async function withWaitingReturns(
  copy: LocalCopy,
  sale: PosReturnableSale,
  fromServer = false,
): Promise<PosReturnableSale> {
  const rows = await copy.db.outbox
    .filter(
      (row) =>
        row.type === 'pos_return.create' && row.after === sale.id && !(fromServer && row.sent),
    )
    .toArray();
  const returns = (await openEntries(copy, rows)).flatMap(({ command }) =>
    command.type === 'pos_return.create' ? [command.input] : [],
  );
  return withReturns(sale, returns);
}

// One page of the register's recent sales (routes.posReturns.registerSales)
export interface RegisterSalesPage {
  items: SyncPosSale[];
  nextCursor: string | null;
}

// The register's recent sales, right after the device took it (decision 45), page after page.
// Each page is written in its own transaction, at the generation of the pull, and only while the
// claim is still this register's: Change register in another tab stops it. The last page marks the
// claim, so the screen does not read them again. The app runs this inside the sync lock (engine.ts
// → exclusive): a pull writes the same rows, and the older of two answers must not win.
export async function loadRegisterSales(
  copy: LocalCopy,
  registerId: string,
  fetchPage: (cursor: string | null) => Promise<RegisterSalesPage>,
): Promise<'loaded' | 'not-held'> {
  const { db } = copy;
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    const rows = await Promise.all(page.items.map((sale) => sealSale(copy, sale)));
    const last = page.nextCursor === null;
    const held = await db.transaction('rw', [db.registerClaim, db.posSales, db.meta], async () => {
      const claim = await db.registerClaim.get('claim');
      if (claim?.registerId !== registerId) return false;
      const { generation } = await readPullState(db);
      await db.posSales.bulkPut(rows.map((row) => ({ ...row, gen: generation })));
      if (last) await db.registerClaim.put({ ...claim, salesLoaded: true });
      return true;
    });
    if (!held) return 'not-held';
    if (last) return 'loaded';
    cursor = page.nextCursor;
  }
}

// The first day the device keeps: like the server's posSalesFrom, but from the server's clock in
// UTC, which is never after the workspace's own day, so the device keeps a day more at most
export function keptSalesFrom(serverTime: string): string {
  return shiftIsoDate(serverTime.slice(0, 10), -POS_SALES_ON_DEVICE_DAYS);
}

// Nothing on the server changes when a sale turns 31 days old, so no pull deletes it: the device
// drops it itself, at the end of each pull (apply.ts). Inside that pull's transaction.
export async function dropOldSales(db: SyncDatabase, serverTime: string): Promise<void> {
  await db.posSales.where('date').below(keptSalesFrom(serverTime)).delete();
}

// ---------------------------------------------------------------------------------------------
// Saving a return

export interface PosReturnSave {
  // newReturnId()
  returnId: string;
  // posReturnInputSchema's output, less the number the save gives
  input: Omit<PosReturnInput, 'sequence'>;
  // For the number (POS1-R000012), which the Sync page and the slip show
  registerCode: string;
  // This device's clock, for the Sync page only
  savedAt: string;
}

// saved: in the outbox with this number. not-held / no-shift: as for a sale (pos.ts).
export type PosReturnResult =
  { kind: 'saved'; sequence: number; number: string } | { kind: 'not-held' } | { kind: 'no-shift' };

// What a return takes out of its shift (shift.ts): the cash refunds, and its sums for the X report
export function returnEffectOf(input: Pick<PosReturnInput, 'lines' | 'refunds'>): ReturnEffect {
  return {
    cashRefunded: sumMoney(
      input.refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
    ),
    total: sumMoney(input.lines.map((line) => addMoney(line.net, line.vat))),
    vat: sumMoney(input.lines.map((line) => line.vat)),
    refunds: input.refunds.map(({ method, amount }) => ({ method, amount })),
  };
}

// The return as the outbox keeps it. Its own chain (its id): it waits for its sale through `after`,
// not through the customer, so a refused change to the sale's customer holds no return back. The
// Sync page names it by its number and counts its lines, with no money (decision 61).
export function returnEntry(save: PosReturnSave, sequence: number, number: string): OutboxEntry {
  const command: SyncCommand = {
    id: uuidv7(),
    type: 'pos_return.create',
    returnId: save.returnId,
    input: { ...save.input, sequence },
  };
  return {
    command,
    status: 'waiting',
    sent: false,
    error: null,
    customerId: save.returnId,
    key: save.returnId,
    base: null,
    name: number,
    lines: save.input.lines.length,
    total: null,
    savedAt: save.savedAt,
    shiftId: save.input.shiftId,
    after: save.input.saleId,
  };
}

// The next return number of the claim: 0 on a claim from before 20c (no return was made then)
export function nextReturnSequence(claim: { lastReturn?: number }): number {
  return (claim.lastReturn ?? 0) + 1;
}

const SAVE_ATTEMPTS = 3;

// The number, the shift and the outbox in one transaction, like a sale's (pos.ts): sealed first,
// written only if the claim's return number and the shift are still the ones read, else again. A
// return with an exchange is saved by savePosSale, with its sale.
export async function savePosReturn(
  copy: LocalCopy,
  save: PosReturnSave,
): Promise<PosReturnResult> {
  const { db } = copy;
  const { input } = save;
  const effect = returnEffectOf(input);
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== input.registerId) return { kind: 'not-held' };
    const shift = await shiftAfter(copy, input.shiftId, (open) => shiftAfterReturn(open, effect));
    if (!shift) return { kind: 'no-shift' };
    const sequence = nextReturnSequence(claim);
    const number = formatReturnNumber(save.registerCode, sequence);
    const row = await sealEntry(copy, returnEntry(save, sequence, number));
    const saved = await db.transaction(
      'rw',
      [db.registerClaim, db.outbox, db.posShift],
      async () => {
        const now = await db.registerClaim.get('claim');
        if (now?.registerId !== claim.registerId || now.lastReturn !== claim.lastReturn) {
          return false;
        }
        if ((await db.posShift.get('shift'))?.rev !== shift.before.rev) return false;
        await db.registerClaim.put({ ...now, lastReturn: sequence });
        await db.outbox.add(row);
        await db.posShift.put(shift.row);
        return true;
      },
    );
    if (saved) return { kind: 'saved', sequence, number };
  }
  throw new Error('The register kept changing during the save');
}
