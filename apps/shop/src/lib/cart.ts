import { atom, computed, onMount } from 'nanostores';

// Step 26a: the cart, kept in this browser. Only the listing and how many: never a price or a
// name. Step 26b asks the server for the prices (system design §14.4: the browser never sends
// money), and a price kept here would go stale the day the shop changes it.
const STORAGE_KEY = 'omnivo.shop.cart';
export const MAX_QUANTITY = 99;
// Step 26b: the server's other limits on a quote request (packages/contracts → storefront.ts).
// A stored cart outside them would make every quote fail, and the drawer would show "Try again"
// forever, so the cart never holds one.
export const MAX_LINES = 50;
const MAX_ID_LENGTH = 64;

export interface CartLine {
  listingId: string;
  quantity: number;
}

// Anything can be in localStorage: an older version's format, a hand edit, another script on the
// same domain. A hand-written guard instead of a Zod schema: Zod would add 25 KB gz to every page
// for this one check.
function isCartLine(value: unknown): value is CartLine {
  if (typeof value !== 'object' || value === null) return false;
  const { listingId, quantity } = value as Record<string, unknown>;
  return (
    typeof listingId === 'string' &&
    listingId !== '' &&
    listingId.length <= MAX_ID_LENGTH &&
    typeof quantity === 'number' &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_QUANTITY
  );
}

export function parseCart(raw: string | null): CartLine[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    // All or nothing: one bad line means the stored cart is not ours, so start empty
    if (!Array.isArray(value) || value.length > MAX_LINES || !value.every(isCartLine)) return [];
    // Our cart has one line per listing (addLine adds to it); the server refuses two
    const ids = new Set(value.map((line) => line.listingId));
    return ids.size === value.length ? value : [];
  } catch {
    return [];
  }
}

function readStored(): CartLine[] {
  try {
    return parseCart(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode or blocked storage: an empty cart that still works for this page view
    return [];
  }
}

function writeStored(lines: CartLine[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    // Not saved: the cart lives until the tab closes, which is still better than an error
  }
}

export const $cart = atom<CartLine[]>([]);

export const $cartCount = computed($cart, (lines) =>
  lines.reduce((count, line) => count + line.quantity, 0),
);

let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  $cart.set(readStored());
}

// The first subscriber (the header's cart count) loads the stored cart and follows other tabs:
// adding in one tab updates the count in every tab of the shop.
onMount($cart, () => {
  load();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) $cart.set(readStored());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
  };
});

// Every change goes through here: it loads the stored cart first (a click can come before anything
// has subscribed; without this it would write a cart of one line over the stored one), and a
// change that changes nothing returns the same array, so nothing is stored and the header's count
// does not say "Added to cart".
function update(change: (lines: CartLine[]) => CartLine[]): void {
  load();
  const current = $cart.get();
  const next = change(current);
  if (next === current) return;
  $cart.set(next);
  writeStored(next);
}

export function addLine(lines: CartLine[], listingId: string): CartLine[] {
  const existing = lines.find((line) => line.listingId === listingId);
  if (!existing) {
    // Step 26b: a 51st product is not added; the server would refuse the whole cart
    return lines.length < MAX_LINES ? [...lines, { listingId, quantity: 1 }] : lines;
  }
  if (existing.quantity >= MAX_QUANTITY) return lines;
  return lines.map((line) =>
    line.listingId === listingId ? { ...line, quantity: line.quantity + 1 } : line,
  );
}

export function addToCart(listingId: string): void {
  update((lines) => addLine(lines, listingId));
}

// Step 26b: "Place Order" on a product page buys this product now. It puts the product in the cart
// once: a second click (or a shopper who added it already) keeps the count as it is, because
// checkout shows the stepper to change it. Checkout then opens with the whole cart, as one order.
export function withLine(lines: CartLine[], listingId: string): CartLine[] {
  if (lines.some((line) => line.listingId === listingId) || lines.length >= MAX_LINES) {
    return lines;
  }
  return [...lines, { listingId, quantity: 1 }];
}

export function ensureInCart(listingId: string): void {
  update((lines) => withLine(lines, listingId));
}

// Step 26b: the drawer's stepper and its typed quantity. Kept between 1 and the limit: 0 is not a
// quantity (the delete button removes a line), and a typed 500 becomes 99, not an error.
export function withQuantity(lines: CartLine[], listingId: string, quantity: number): CartLine[] {
  const wanted = Math.min(Math.max(Math.trunc(quantity), 1), MAX_QUANTITY);
  const existing = lines.find((line) => line.listingId === listingId);
  // A line another tab removed a moment ago is not brought back by a click in this one
  if (!existing || existing.quantity === wanted) return lines;
  return lines.map((line) => (line.listingId === listingId ? { ...line, quantity: wanted } : line));
}

export function withoutLines(lines: CartLine[], listingIds: ReadonlySet<string>): CartLine[] {
  const kept = lines.filter((line) => !listingIds.has(line.listingId));
  return kept.length === lines.length ? lines : kept;
}

export function setQuantity(listingId: string, quantity: number): void {
  update((lines) => withQuantity(lines, listingId, quantity));
}

// The delete button, and the listings a quote says the shop no longer sells
export function removeFromCart(listingIds: ReadonlySet<string>): void {
  update((lines) => withoutLines(lines, listingIds));
}
