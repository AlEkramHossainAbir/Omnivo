import { shopCartQuoteRequestSchema } from '@omnivo/contracts';

import type { ShopSource } from '../data/types';
import { readBody, sourceFailed } from './problem';

// Step 26b: POST /api/cart/quote, without Astro around it. The route file only passes the request
// and the source in, so this can be tested with a plain Request and the mock source, no server.
export async function answerCartQuote(request: Request, source: ShopSource): Promise<Response> {
  // Step 26c: the reading and checking moved to readBody, which the order routes share
  const body = await readBody(request, shopCartQuoteRequestSchema);
  if (!body.ok) return body.response;

  try {
    const quote = await source.quote(body.data);
    // Prices change and the answer belongs to one cart: no browser or proxy may keep it
    return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return sourceFailed('cart quote', error);
  }
}
