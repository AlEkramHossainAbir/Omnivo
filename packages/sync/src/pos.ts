import {
  addMoney,
  addQuantity,
  formatPosNumber,
  formatReturnNumber,
  type PosRegister,
  posChangeOf,
  posSaleAmounts,
  type PosSaleInput,
  type Product,
  subtractQuantity,
  sumMoney,
  type SyncCommand,
  type SyncPosRegister,
  type SyncStock,
  toBaseQuantity,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import { SCREEN_CART } from './carts.js';
import type { LocalCopy } from './copy.js';
import type { RegisterClaim } from './database.js';
import { isCounterCommand } from './outbox.js';
import {
  localSaleOf,
  nextReturnSequence,
  type PosReturnSave,
  returnEffectOf,
  returnEntry,
  sealSale,
} from './returns.js';
import { openEntries, openRows, sealEntry } from './sealed.js';
import { type SaleEffect, shiftAfter, shiftAfterReturn, shiftAfterSale } from './shift.js';
import { readPullState } from './state.js';

// Step 20a: the POS on the device. The registers of the branch come with the pull; the claim says
// which one this device holds and the last number it gave; a sale goes into the outbox with the
// next number. No Dexie import, like outbox.ts: the POS screen's chunk calls these with the copy
// the session opened, and carries no Dexie of its own.

// The registers of the device's branch, by code: the choose dialog lists them, and the screen
// finds the one it sells on. The codes are capital letters and digits, so `<` sorts them as a
// person reads them.
export async function localRegisters(copy: LocalCopy): Promise<SyncPosRegister[]> {
  const registers = await openRows(copy, 'posRegisters', await copy.db.posRegisters.toArray());
  return registers.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export async function readClaim(copy: LocalCopy): Promise<RegisterClaim | null> {
  return (await copy.db.registerClaim.get('claim')) ?? null;
}

// The server answered a claim: this device holds `register` now. It counts on from the server's
// last number, or from its own when its own is ahead: claiming the register it already holds
// (a reload that lost nothing, the claim is idempotent) answers the last number the server has
// received, and the sales still in the outbox are past it. A claim of another register starts
// from the server's number alone: the device let the old one go only with no sale of it waiting.
// Step 20c: the return numbers the same way, and the register's recent sales are still to read
// (returns.ts → loadRegisterSales) unless the claim is the one the device had.
export async function keepClaim(
  copy: LocalCopy,
  register: Pick<PosRegister, 'id' | 'lastNumber' | 'lastReturnNumber'>,
): Promise<RegisterClaim> {
  const { db } = copy;
  return db.transaction('rw', db.registerClaim, async () => {
    const old = await db.registerClaim.get('claim');
    const same = old?.registerId === register.id ? old : null;
    const claim: RegisterClaim = {
      key: 'claim',
      registerId: register.id,
      last: Math.max(same?.last ?? 0, register.lastNumber),
      lastReturn: Math.max(same?.lastReturn ?? 0, register.lastReturnNumber),
      salesLoaded: same?.salesLoaded ?? false,
    };
    await db.registerClaim.put(claim);
    return claim;
  });
}

// After the server let the register go (Change register, sign-out). Step 20c: its sales go with
// it, in the same transaction: the device keeps only the sales of the register it holds, and no
// pull would delete them (the server sends a register's sales to its holder only).
export async function dropClaim(copy: LocalCopy): Promise<void> {
  const { db } = copy;
  await db.transaction('rw', [db.registerClaim, db.posSales], async () => {
    await db.registerClaim.delete('claim');
    await db.posSales.clear();
  });
}

// The POS commands still on the device. A device holds one register at a time and lets it go only
// when this is 0 (decision 14), so they are all of the register it holds. The command's type is a
// clear field of the row: nothing is opened. Step 20b: a shift's commands count too: the server
// lets the register go only once the shift's close has arrived.
export async function waitingAtCounter(copy: LocalCopy): Promise<number> {
  return copy.db.outbox.filter((row) => isCounterCommand(row.type)).count();
}

// What the POS screen saves. The sale is complete and checked (posSaleInputSchema's output),
// except its number: the save gives it the next one.
export interface PosSaleSave {
  input: Omit<PosSaleInput, 'sequence'>;
  // For the number (POS1-000124), which the Sync page and the receipt show
  registerCode: string;
  total: string;
  // This device's clock, for the Sync page only
  savedAt: string;
  // Step 20c: the return whose money pays for this sale (an exchange), saved with it and before it.
  // The sale's exchange payment names its returnId. Missing = no exchange.
  exchange?: PosReturnSave;
}

// saved: in the outbox, with this number and the sale's id (a UUIDv7 made here, like every id the
// device makes; step 20c's return points at it), and the number of its exchange's return (null =
// none). not-held: the claim is gone or is another register's (another tab changed the register
// meanwhile); the screen asks for a register again. no-shift (step 20b): the sale's shift is not
// open on the device any more (closed in another tab).
export type PosSaveResult =
  | { kind: 'saved'; saleId: string; sequence: number; number: string; returnNumber: string | null }
  | { kind: 'not-held' }
  | { kind: 'no-shift' };

// Step 20c: what a sale brings into its shift, for the cash and the X report. Change is given in
// cash, whatever the methods.
function saleEffectOf(input: Omit<PosSaleInput, 'sequence'>, total: string): SaleEffect {
  const { totals } = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const { payments } = input;
  return {
    cashTaken: sumMoney(
      payments.filter((payment) => payment.method === 'cash').map((payment) => payment.amount),
    ),
    changeGiven: posChangeOf(payments, total),
    total: totals.total,
    discount: addMoney(totals.discount, totals.billDiscount),
    vat: totals.vat,
    payments: payments.map(({ method, amount }) => ({ method, amount })),
  };
}

const SAVE_ATTEMPTS = 3;

// The number and the outbox in one transaction: the claim counts up only when the sale is in the
// outbox, so a number is never used twice and never skipped. The command is sealed first, with the
// number the claim gives now (a transaction cannot wait for Web Crypto), and written only if the
// claim still says the same; else another tab sold meanwhile, and the save starts again with the
// next number. Three times in a row would take three tabs selling at the same moment.
// Step 20b: the shift's cash goes in the same transaction (the cash the sale took, the change it
// gave), checked the same way, so the close's expected cash counts every sale exactly once.
//
// Step 20c: every line gets its id here (decision 64), and the sale goes into the device's own
// sales (posSales) in the same transaction, so its goods can come back before it syncs. An
// exchange's return is saved first in the same transaction, with the next return number: the two
// are in the outbox together or not at all, and the return's cash and the sale's go into the shift
// together.
export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<PosSaveResult> {
  const { db } = copy;
  const saleId = uuidv7();
  const input = {
    ...save.input,
    lines: save.input.lines.map((line) => ({ ...line, id: line.id ?? uuidv7() })),
  };
  const sale = saleEffectOf(input, save.total);
  const exchange = save.exchange ?? null;
  const given = exchange && returnEffectOf(exchange.input);
  // Made once, without its number: the number is added at each attempt
  const local = await localSaleOf(copy, { id: saleId, number: '', input });
  for (let attempt = 1; ; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== input.registerId) return { kind: 'not-held' };
    // A sale saved before 20b's screen has no shift; every new one has. An exchange's return is in
    // the same shift: it is the same cart.
    const shift =
      input.shiftId === null
        ? null
        : await shiftAfter(copy, input.shiftId, (open) =>
            shiftAfterSale(given ? shiftAfterReturn(open, given) : open, sale),
          );
    if (input.shiftId !== null && !shift) return { kind: 'no-shift' };
    const sequence = claim.last + 1;
    const number = formatPosNumber(save.registerCode, sequence);
    const returnSequence = nextReturnSequence(claim);
    const returnNumber = exchange && formatReturnNumber(exchange.registerCode, returnSequence);
    const returnRow =
      exchange &&
      returnNumber !== null &&
      (await sealEntry(copy, returnEntry(exchange, returnSequence, returnNumber)));
    const saleRow = local && (await sealSale(copy, { ...local, number }));
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_sale.create',
      saleId,
      input: { ...input, sequence },
    };
    const row = await sealEntry(copy, {
      command,
      status: 'waiting',
      sent: false,
      error: null,
      // The push holds a command back while an earlier one on the same customer waits (push.ts).
      // A sale to a customer made on this device waits for that customer, like an order. A walk-in
      // sale waits for nothing: its own id here, so a hundred walk-in sales go in one push, and a
      // refused one holds back no other.
      customerId: input.customerId ?? saleId,
      key: saleId,
      base: null,
      // The Sync page says "Sale POS1-000124" (sync.commands.pos_sale.create)
      name: number,
      lines: input.lines.length,
      total: save.total,
      savedAt: save.savedAt,
      ...(input.shiftId !== null && { shiftId: input.shiftId }),
      // Step 20c: an exchange's sale waits for its return, which the server must have first
      ...(exchange && { after: exchange.returnId }),
    });
    const tables = [db.registerClaim, db.outbox, db.posShift, db.posCarts, db.posSales, db.meta];
    const saved = await db.transaction('rw', tables, async () => {
      const now = await db.registerClaim.get('claim');
      if (
        now?.registerId !== claim.registerId ||
        now.last !== claim.last ||
        now.lastReturn !== claim.lastReturn
      ) {
        return false;
      }
      if (shift && (await db.posShift.get('shift'))?.rev !== shift.before.rev) return false;
      await db.registerClaim.put({
        ...now,
        last: sequence,
        ...(exchange && { lastReturn: returnSequence }),
      });
      // The return first: the outbox sends in this order, and the sale's payment names it
      if (returnRow) await db.outbox.add(returnRow);
      await db.outbox.add(row);
      if (shift) await db.posShift.put(shift.row);
      // The cart on the screen is this sale now: a reload must not bring it back to be sold twice
      await db.posCarts.delete(SCREEN_CART);
      // At the generation of the pull, like a row the pull wrote: a full pull under way keeps it
      if (saleRow) {
        const { generation } = await readPullState(db);
        await db.posSales.put({ ...saleRow, gen: generation });
      }
      return true;
    });
    if (saved) return { kind: 'saved', saleId, sequence, number, returnNumber };
    if (attempt === SAVE_ATTEMPTS) throw new Error('The register kept changing during the save');
  }
}

// What this device's own POS sales took from a warehouse that its copy does not show yet: every sale
// still in the outbox, by variant and batch (`${variantId}|${batchId}`), in the base unit. Waiting,
// sending or refused: the goods left the counter all the same, and the server's stock (which the
// next pull brings) has none of them until the sale is posted. Without this, the last T-shirt could
// be sold twice offline, and the second sale would go below zero when it syncs. A sale of a
// register on another warehouse does not count (a device sells on one register, but the manager
// may have moved the register meanwhile; the server posts it at the register's warehouse).
async function takenByWaitingSales(
  copy: LocalCopy,
  warehouseId: string,
  variantIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const taken = new Map<string, string>();
  const rows = await copy.db.outbox.filter((row) => row.type === 'pos_sale.create').toArray();
  if (rows.length === 0) return taken;
  const registers = new Set(
    (await localRegisters(copy))
      .filter((register) => register.warehouseId === warehouseId)
      .map((register) => register.id),
  );
  const lines = (await openEntries(copy, rows)).flatMap(({ command }) =>
    command.type === 'pos_sale.create' && registers.has(command.input.registerId)
      ? command.input.lines.filter((line) => variantIds.has(line.variantId))
      : [],
  );
  if (lines.length === 0) return taken;
  // The products of those lines, by the variant index: the unit's factor and whether it is goods
  const products = await openRows<Product>(
    copy,
    'products',
    await copy.db.products
      .where('variantIds')
      .anyOf([...new Set(lines.map((line) => line.variantId))])
      .toArray(),
  );
  for (const line of lines) {
    const product = products.find((one) =>
      one.variants.some((variant) => variant.id === line.variantId),
    );
    // An archived product left the copy; a service moves no stock
    if (product?.type !== 'goods') continue;
    const factor =
      line.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === line.unitId)?.factor;
    if (factor === undefined) continue;
    // 4 decimals, like the cart's own baseQuantity() (apps/app/src/lib/pos.ts)
    const key = `${line.variantId}|${line.batchId ?? ''}`;
    taken.set(key, addQuantity(taken.get(key) ?? '0', toBaseQuantity(line.quantity, factor, 4)));
  }
  return taken;
}

// The stock of some variants in one warehouse, every batch of them: the tiles' "38 in stock", the
// cart's check (decision 7) and the batch a line takes (FEFO). By the variant index, then the
// warehouse: a device keeps the stock of every warehouse of its branch. Less what this device's
// own unsynced sales took (above), so the screen counts a sale the moment it is saved. It reads
// the outbox, so the screen's live read runs again when a sale is saved or leaves the outbox.
// Between a sale's accepted answer and the pull right after it (engine.ts), the copy shows it
// once more: the push and the pull are one sync, so that lasts one request.
export async function stockOf(
  copy: LocalCopy,
  warehouseId: string,
  variantIds: readonly string[],
): Promise<SyncStock[]> {
  if (variantIds.length === 0) return [];
  const rows = await copy.db.stock
    .where('variantId')
    .anyOf(variantIds)
    .filter((row) => row.warehouseId === warehouseId)
    .toArray();
  const [stock, taken] = await Promise.all([
    openRows<SyncStock>(copy, 'stock', rows),
    takenByWaitingSales(copy, warehouseId, new Set(variantIds)),
  ]);
  if (taken.size === 0) return stock;
  // Only rows the copy has: a variant with no row has none here, and less than none changes
  // nothing the screen decides (it stops the sale either way, or the workspace sells below zero)
  return stock.map((row) => {
    const less = taken.get(`${row.variantId}|${row.batchId ?? ''}`);
    return less === undefined ? row : { ...row, quantity: subtractQuantity(row.quantity, less) };
  });
}

// The product a scanned barcode belongs to: a variant's or a pack's. By the multi-entry index, so
// a scan costs one read however many products the shop has. null = no active product has it.
export async function productByBarcode(copy: LocalCopy, code: string): Promise<Product | null> {
  const row = await copy.db.products.where('barcodes').equals(code).first();
  return row ? copy.open('products', row.key, row.box) : null;
}
