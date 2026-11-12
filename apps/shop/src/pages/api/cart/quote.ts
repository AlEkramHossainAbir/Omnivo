import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerCartQuote } from '../../../server/cart-quote';

// Step 26b: the cart drawer sends the stored cart's ids and counts here and draws what comes back.
// POST, not GET: a cart of 50 lines does not fit well in a URL, and a quote is never cached.
// Another site can post here too (a JSON body is not a "simple" form, but text/plain is), which is
// harmless: the answer is public prices, and the shop has no session cookie to misuse.
export const POST: APIRoute = ({ request }) => answerCartQuote(request, shopSource);
