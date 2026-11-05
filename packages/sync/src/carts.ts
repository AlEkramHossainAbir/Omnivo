import {
  type DiscountType,
  MAX_HELD_CARTS,
  type PosReturnableSale,
  type PosReturnLineInput,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { LocalCopy } from './copy.js';
import type { CartRow, HeldCart } from './database.js';

// Step 20b: the carts of the POS screen that wait on the device (decision 10): held bills, and the
// cart on the screen itself, so a reload or the idle lock does not lose a sale half scanned. They
// are never sent: a held cart holds no stock and has no number. Each belongs to a shift, and the
// close drops them all. No Dexie import, like pos.ts.

// One line of the cart, as the screen keeps it (apps/app/src/lib/pos.ts works it out). Here, not
// in the app, because the device stores it: the box and the screen must agree on its shape.
// Everything the receipt and the sale need is copied in when the line is added (the product may
// change in the copy while the cart waits; the line keeps what the cashier saw).
export interface PosCartLine {
  // For React and for picking a line; never sent
  key: string;
  productId: string;
  variantId: string;
  // The base unit, the product's sales unit or the pack a barcode named, and its size in the base
  // unit ("1", "10"): stock is counted in base units
  unitId: string;
  factor: string;
  name: string;
  sku: string;
  unitCode: string;
  // The unit's decimals (0 for pcs, 3 for kg): quantities show with them
  decimals: number;
  // 'none' | 'batch' | 'serial' (a string in the contract, so a newer server's mode does not break)
  tracking: string;
  // A service has no stock: no check, no batch
  goods: boolean;
  // As the cashier types them: they may be half typed ("1.") until the sale is paid
  quantity: string;
  // '' while there is no price (a product without one); the cashier types it
  unitPrice: string;
  // The price the line started with (posOverridesOf); null = there was none
  startingPrice: string | null;
  discountType: DiscountType;
  discount: string;
  taxRateId: string;
  // The rate in percent ("15.00"), kept with the line: the receipt is printed with it
  rate: string;
  batchId: string | null;
  serialNumbers: string[];
}

export interface PosCartCustomer {
  id: string;
  name: string;
  priceListId: string | null;
}

// Step 20c: a return whose money pays for the cart (an exchange, decision 1). Nothing is saved yet:
// the return is saved with the sale, before it, at "Complete sale" (pos.ts), so dropping the cart
// drops the return too and no money moved. Kept in the cart, so a reload does not lose it.
export interface PosCartExchange {
  // Made when the exchange starts: the sale's exchange payment names it
  returnId: string;
  // The sale the goods came from, as the return screen read it (the slip and the refund's methods)
  sale: PosReturnableSale;
  // What came back, as posReturnInputSchema reads it
  lines: PosReturnLineInput[];
  note: string | null;
  // The return's money: what the lines pay back, with VAT
  total: string;
}

export interface PosCart {
  // null = walk-in
  customer: PosCartCustomer | null;
  lines: PosCartLine[];
  billDiscountType: DiscountType;
  billDiscount: string;
  // Step 20c: missing on a cart saved before 20c, and on one without an exchange
  exchange?: PosCartExchange;
}

// The key of the cart on the screen. Held carts have a UUIDv7 each. A sale deletes it in its own
// transaction (pos.ts), and a close with the shift's other carts (shift.ts).
export const SCREEN_CART = 'current';

// A held cart as the list shows it
export interface HeldCartItem extends HeldCart {
  id: string;
}

function rowsOf(copy: LocalCopy, shiftId: string): Promise<CartRow[]> {
  return copy.db.posCarts.where('shiftId').equals(shiftId).toArray();
}

function held(rows: readonly CartRow[]): CartRow[] {
  return rows.filter((row) => row.key !== SCREEN_CART);
}

async function sealCart(
  copy: LocalCopy,
  key: string,
  shiftId: string,
  cart: HeldCart,
): Promise<CartRow> {
  return { key, shiftId, heldAt: cart.heldAt, box: await copy.seal('posCarts', key, cart) };
}

// The held carts of a shift, the oldest first: the one waiting longest is at the top. Two held in
// the same millisecond keep the order they were held in (a UUIDv7 key sorts by time too).
export async function heldCarts(copy: LocalCopy, shiftId: string): Promise<HeldCartItem[]> {
  const rows = held(await rowsOf(copy, shiftId)).sort(
    (a, b) => a.heldAt.localeCompare(b.heldAt) || a.key.localeCompare(b.key),
  );
  return Promise.all(
    rows.map(async (row) => ({ id: row.key, ...(await copy.open('posCarts', row.key, row.box)) })),
  );
}

// How many, from the clear fields alone: the "Held (2)" button and the close's notice
export async function heldCount(copy: LocalCopy, shiftId: string): Promise<number> {
  return held(await rowsOf(copy, shiftId)).length;
}

// Hold the cart on the screen. It leaves the screen's row in the same moment, so a reload brings
// back an empty cart and the held one, never both. full = MAX_HELD_CARTS wait already (decision
// 23: the close's count has a limit too); counted inside the transaction, so two tabs that hold at
// once cannot pass it.
export async function holdCart(
  copy: LocalCopy,
  shiftId: string,
  cart: HeldCart,
): Promise<'held' | 'full'> {
  const { db } = copy;
  const row = await sealCart(copy, uuidv7(), shiftId, cart);
  return db.transaction('rw', db.posCarts, async () => {
    if (held(await rowsOf(copy, shiftId)).length >= MAX_HELD_CARTS) return 'full';
    await db.posCarts.add(row);
    await db.posCarts.delete(SCREEN_CART);
    return 'held';
  });
}

// Resume a held cart. The cart on the screen, if it has lines, is held in its place ("The cart on
// the screen is held first, so nothing is lost"), in the same transaction: the count stays the
// same, so a full list can still swap. null = the held cart is gone (another tab resumed or dropped
// it); nothing changes then.
export async function resumeCart(
  copy: LocalCopy,
  shiftId: string,
  id: string,
  screen: HeldCart | null,
): Promise<HeldCart | null> {
  const { db } = copy;
  const chosen = await db.posCarts.get(id);
  if (chosen?.shiftId !== shiftId) return null;
  const cart = await copy.open('posCarts', chosen.key, chosen.box);
  const swapped = screen && (await sealCart(copy, uuidv7(), shiftId, screen));
  const resumed = await sealCart(copy, SCREEN_CART, shiftId, cart);
  return db.transaction('rw', db.posCarts, async () => {
    if (!(await db.posCarts.get(id))) return null;
    await db.posCarts.delete(id);
    if (swapped) await db.posCarts.add(swapped);
    // The resumed cart is the screen's now: a reload right after brings it back
    await db.posCarts.put(resumed);
    return cart;
  });
}

export async function dropCart(copy: LocalCopy, id: string): Promise<void> {
  await copy.db.posCarts.delete(id);
}

// The cart on the screen, saved as it changes; null or no lines = nothing to keep, unless an
// exchange waits for its lines (step 20c: the goods came back, and the customer is still choosing).
// Last write wins: only the screen writes it, and a second tab on /pos shows the same shift's cart
// from its reload.
export async function saveScreenCart(
  copy: LocalCopy,
  shiftId: string,
  cart: HeldCart | null,
): Promise<void> {
  if (!cart || (cart.cart.lines.length === 0 && !cart.cart.exchange)) {
    await copy.db.posCarts.delete(SCREEN_CART);
    return;
  }
  await copy.db.posCarts.put(await sealCart(copy, SCREEN_CART, shiftId, cart));
}

// The cart the screen left, if it is this shift's. One of a closed shift is dropped with it.
export async function screenCart(copy: LocalCopy, shiftId: string): Promise<PosCart | null> {
  const row = await copy.db.posCarts.get(SCREEN_CART);
  if (row?.shiftId !== shiftId) return null;
  return (await copy.open('posCarts', row.key, row.box)).cart;
}
