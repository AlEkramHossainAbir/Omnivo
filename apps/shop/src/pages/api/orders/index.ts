import type { APIRoute } from 'astro';

import { answerPlaceOrder } from '../../../server/orders';

// Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
// plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
// exception for localhost, Safari does not). Step 27a: clientAddress is the shopper's address (the
// proxy's X-Forwarded-For, astro.config.ts → security), for the API's orders-per-connection limit.
// Step 27d: url.origin is the shop's address as the browser sees it (the proxy's X-Forwarded-Host
// and -Proto, the same setting), for the mock's fake gateway page
export const POST: APIRoute = ({ request, locals, clientAddress, url }) =>
  answerPlaceOrder(request, locals.source, clientAddress, url.origin, {
    secure: import.meta.env.PROD,
  });
