import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerPlaceOrder } from '../../../server/orders';

// Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
// plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
// exception for localhost, Safari does not)
export const POST: APIRoute = ({ request }) =>
  answerPlaceOrder(request, shopSource, { secure: import.meta.env.PROD });
