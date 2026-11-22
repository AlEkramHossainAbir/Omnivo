import type { APIRoute } from 'astro';

import { answerGatewayReturn, PAYMENT_PAGE } from '../../../server/payments';

// Step 27d: SHOP_PAYMENT_RETURN_PATH. SSLCommerz posts the shopper's browser here after its page:
// paid, failed and cancelled all come to this one path (27d.1). The middleware lets this path take
// a post from another site (server/origin-check.ts)
export const POST: APIRoute = ({ request, locals }) => answerGatewayReturn(request, locals.source);

// A GET here is a reload of the address bar, or a gateway that sends the browser back without a
// form: nothing to settle, so the page that reads the cookie answers
export const GET: APIRoute = () =>
  new Response(null, { status: 303, headers: { Location: PAYMENT_PAGE } });
