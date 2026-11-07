import { atom, computed, onMount } from 'nanostores';

// Step 26a: the cart, kept in this browser. Only the listing and how many: never a price or a
// name. Step 26b asks the server for the prices (system design §14.4: the browser never sends
// money), and a price kept here would go stale the day the shop changes it.
const STORAGE_KEY = 'omnivo.shop.cart';
export const MAX_QUANTITY = 99;

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
    return Array.isArray(value) && value.every(isCartLine) ? value : [];
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

export function addLine(lines: CartLine[], listingId: string): CartLine[] {
  const existing = lines.find((line) => line.listingId === listingId);
  if (!existing) return [...lines, { listingId, quantity: 1 }];
  return lines.map((line) =>
    line.listingId === listingId
      ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QUANTITY) }
      : line,
  );
}

export function addToCart(listingId: string): void {
  // A click can come before anything has subscribed; without this it would write a cart of one
  // line over the stored one
  load();
  const next = addLine($cart.get(), listingId);
  $cart.set(next);
  writeStored(next);
}
