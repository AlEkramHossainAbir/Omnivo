import type { APIRoute } from 'astro';

import { answerGatewayNotice } from '../../../server/payments';

// Step 27d: SHOP_PAYMENT_NOTICE_PATH, SSLCommerz's IPN: its server posts the outcome here too, so
// a payment is recorded even when the shopper closes the tab before coming back
export const POST: APIRoute = ({ request, locals }) => answerGatewayNotice(request, locals.source);
