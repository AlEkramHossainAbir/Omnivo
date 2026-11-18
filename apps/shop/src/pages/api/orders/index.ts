import type { APIRoute } from 'astro';

import { answerPlaceOrder } from '../../../server/orders';

// Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
// plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
// exception for localhost, Safari does not). Step 27a: clientAddress is the shopper's address (the
// proxy's X-Forwarded-For, astro.config.ts → security), for the API's orders-per-connection limit
export const POST: APIRoute = ({ request, locals, clientAddress }) =>
  answerPlaceOrder(request, locals.source, clientAddress, { secure: import.meta.env.PROD });
