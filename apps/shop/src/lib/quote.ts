import type { ShopCartQuote, ShopCartQuoteLine } from '@omnivo/contracts';

import type { CartLine } from './cart';

// Step 26b: the cart drawer's one request. The browser sends the cart's ids and counts and gets
// today's prices back (system design §14.4); it never adds money itself.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Hand-written like cart.ts's isCartLine, for the same reason: Zod would add 25 KB gz to every page.
// The answer comes from our own route, so this is not a full check of the contract. It checks what
// the drawer draws and links to, so a broken answer shows "Try again", never "undefined" or a
// link to somewhere else.
const MONEY = /^\d+(\.\d{1,4})?$/;
const LINK = /^(\/(?!\/)|https:\/\/)/;

function isMoney(value: unknown): value is string {
  return typeof value === 'string' && MONEY.test(value);
}

function isQuoteLine(value: unknown): value is ShopCartQuoteLine {
  if (!isRecord(value) || typeof value.listingId !== 'string') return false;
  if (value.status === 'unavailable') return true;
  if (value.status !== 'available' && value.status !== 'out_of_stock') return false;

  const { slug, name, packSize, image, quantity } = value;
  const shown =
    typeof slug === 'string' &&
    typeof name === 'string' &&
    typeof packSize === 'string' &&
    isRecord(image) &&
    typeof image.url === 'string' &&
    LINK.test(image.url) &&
    typeof image.alt === 'string' &&
    typeof quantity === 'number' &&
    Number.isInteger(quantity);
  if (value.status === 'out_of_stock') return shown;
  return shown && isMoney(value.unitPrice) && isMoney(value.lineTotal);
}

export function isCartQuote(value: unknown): value is ShopCartQuote {
  return (
    isRecord(value) &&
    Array.isArray(value.lines) &&
    value.lines.every(isQuoteLine) &&
    typeof value.itemCount === 'number' &&
    isMoney(value.subtotal)
  );
}

// Any answer the drawer cannot draw: no network, a 4xx/5xx problem, or a body that is not a quote.
// The drawer shows one message for all of them with "Try again"; the details are for the console.
export class QuoteFailedError extends Error {
  override name = 'QuoteFailedError';
}

export async function fetchQuote(lines: CartLine[], signal: AbortSignal): Promise<ShopCartQuote> {
  // An AbortError (the shopper changed the cart again, or closed the drawer) is passed on as it
  // is: the drawer ignores it, because a newer request is already on its way or nobody is looking
  const response = await fetch('/api/cart/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ lines }),
    signal,
  });
  if (!response.ok) {
    throw new QuoteFailedError(`quote answered ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (!isCartQuote(body)) throw new QuoteFailedError('quote answer has the wrong shape');
  return body;
}
