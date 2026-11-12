import {
  problemSchema,
  shopCartQuoteSchema,
  shopOrderPlacedSchema,
  type Problem,
  type ShopCartQuote,
  type ShopCartQuoteRequest,
  type ShopOrderPlaced,
  type ShopOrderRequestInput,
} from '@omnivo/contracts';

// Step 26c: the checkout's two requests. Unlike the cart drawer (lib/quote.ts, a hand-written
// guard to keep Zod off every page), the checkout already has Zod in its chunk, so each answer is
// checked against its contract: a broken answer is a failure, never a total of "undefined".

function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    // The order routes refuse anything else (server/problem.ts → readBody)
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export class CheckoutQuoteError extends Error {
  override name = 'CheckoutQuoteError';
}

// The cart priced with the zone and the coupon. An AbortError passes through as it is: the island
// ignores it, because a newer request replaced this one
export async function fetchCheckoutQuote(
  request: ShopCartQuoteRequest,
  signal: AbortSignal,
): Promise<ShopCartQuote> {
  const response = await postJson('/api/cart/quote', request, signal);
  if (!response.ok) throw new CheckoutQuoteError(`quote answered ${String(response.status)}`);
  const parsed = shopCartQuoteSchema.safeParse(await response.json());
  if (!parsed.success) throw new CheckoutQuoteError('quote answer has the wrong shape');
  return parsed.data;
}

// What Confirm Order can end in. `refused` is the server saying no with a code (a field, a changed
// price); `failed` is no usable answer at all (no network, a proxy's HTML page), where the order
// may or may not have reached the server
export type PlaceOrderResult =
  | { kind: 'placed'; answer: ShopOrderPlaced }
  | { kind: 'refused'; problem: Problem }
  | { kind: 'failed' };

export async function placeOrder(request: ShopOrderRequestInput): Promise<PlaceOrderResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await postJson('/api/orders', request);
    body = await response.json();
  } catch (error) {
    console.error(error);
    return { kind: 'failed' };
  }
  if (response.ok) {
    const placed = shopOrderPlacedSchema.safeParse(body);
    return placed.success ? { kind: 'placed', answer: placed.data } : { kind: 'failed' };
  }
  const problem = problemSchema.safeParse(body);
  return problem.success ? { kind: 'refused', problem: problem.data } : { kind: 'failed' };
}
