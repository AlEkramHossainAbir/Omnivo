import type { APIRoute } from 'astro';

import { answerRetryPayment } from '../../../server/payments';

// Step 27d: "Try again" on /checkout/paid. POST, not GET: it opens a payment page at the gateway
// and uses up one of the order's three tries
export const POST: APIRoute = ({ request, locals, url }) =>
  answerRetryPayment(request, locals.source, url.origin);
