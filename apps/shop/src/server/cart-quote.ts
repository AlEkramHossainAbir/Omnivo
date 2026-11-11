import { shopCartQuoteRequestSchema } from '@omnivo/contracts';

import type { ShopSource } from '../data/types';
import { invalidInput, parseOptions, problemResponse } from './problem';

// Step 26b: POST /api/cart/quote, without Astro around it. The route file only passes the request
// and the source in, so this can be tested with a plain Request and the mock source, no server.
export async function answerCartQuote(request: Request, source: ShopSource): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Not JSON, or bigger than the adapter's bodySizeLimit (reading it throws then): the same
    // code the ERP's API sends for a body it cannot read
    return problemResponse(400, 'malformed_request', 'The body must be JSON.');
  }

  const parsed = shopCartQuoteRequestSchema.safeParse(body, parseOptions);
  if (!parsed.success) return invalidInput(parsed.error);

  try {
    const quote = await source.quote(parsed.data);
    // Prices change and the answer belongs to one cart: no browser or proxy may keep it
    return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // The real source calls the API, which can be down. Logged here with its details; the
    // shopper gets a code the drawer turns into "Retry", never the error's text
    console.error('cart quote failed', error);
    return problemResponse(500, 'internal_error', 'Something went wrong on our side.');
  }
}
