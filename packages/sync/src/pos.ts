import {
  addQuantity,
  formatPosNumber,
  type PosRegister,
  type PosSaleInput,
  type Product,
  subtractQuantity,
  type SyncCommand,
  type SyncPosRegister,
  type SyncStock,
  toBaseQuantity,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { LocalCopy } from './copy.js';
import type { RegisterClaim } from './database.js';
import { openEntries, openRows, sealEntry } from './sealed.js';

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
export async function keepClaim(
  copy: LocalCopy,
  register: Pick<PosRegister, 'id' | 'lastNumber'>,
): Promise<RegisterClaim> {
  const { db } = copy;
  return db.transaction('rw', db.registerClaim, async () => {
    const old = await db.registerClaim.get('claim');
    const own = old?.registerId === register.id ? old.last : 0;
    const claim: RegisterClaim = {
      key: 'claim',
      registerId: register.id,
      last: Math.max(own, register.lastNumber),
    };
    await db.registerClaim.put(claim);
    return claim;
  });
}

// After the server let the register go (Change register, sign-out)
export async function dropClaim(copy: LocalCopy): Promise<void> {
  await copy.db.registerClaim.delete('claim');
}

// The POS sales still on the device. A device holds one register at a time and lets it go only
// when this is 0 (decision 14), so they are all sales of the register it holds. The command's type
// is a clear field of the row: nothing is opened.
export async function waitingSales(copy: LocalCopy): Promise<number> {
  return copy.db.outbox.filter((row) => row.type === 'pos_sale.create').count();
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
}

// saved: in the outbox, with this number and the sale's id (a UUIDv7 made here, like every id the
// device makes; step 20c's return points at it). not-held: the claim is gone or is another
// register's (another tab changed the register meanwhile); the screen asks for a register again.
export type PosSaveResult =
  { kind: 'saved'; saleId: string; sequence: number; number: string } | { kind: 'not-held' };

const SAVE_ATTEMPTS = 3;

// The number and the outbox in one transaction: the claim counts up only when the sale is in the
// outbox, so a number is never used twice and never skipped. The command is sealed first, with the
// number the claim gives now (a transaction cannot wait for Web Crypto), and written only if the
// claim still says the same; else another tab sold meanwhile, and the save starts again with the
// next number. Three times in a row would take three tabs selling at the same moment.
export async function savePosSale(copy: LocalCopy, save: PosSaleSave): Promise<PosSaveResult> {
  const { db } = copy;
  const saleId = uuidv7();
  for (let attempt = 1; ; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== save.input.registerId) return { kind: 'not-held' };
    const sequence = claim.last + 1;
    const number = formatPosNumber(save.registerCode, sequence);
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_sale.create',
      saleId,
      input: { ...save.input, sequence },
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
      customerId: save.input.customerId ?? saleId,
      key: saleId,
      base: null,
      // The Sync page says "Sale POS1-000124" (sync.commands.pos_sale.create)
      name: number,
      lines: save.input.lines.length,
      total: save.total,
      savedAt: save.savedAt,
    });
    const saved = await db.transaction('rw', [db.registerClaim, db.outbox], async () => {
      const now = await db.registerClaim.get('claim');
      if (now?.registerId !== claim.registerId || now.last !== claim.last) return false;
      await db.registerClaim.put({ ...claim, last: sequence });
      await db.outbox.add(row);
      return true;
    });
    if (saved) return { kind: 'saved', saleId, sequence, number };
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
