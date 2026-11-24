import type { APIRoute } from 'astro';

import { answerPayOnDelivery } from '../../../server/payments';

// Step 27d: "Pay on delivery instead" on /checkout/paid. POST: it changes the order and sends an SMS
export const POST: APIRoute = ({ request, locals }) => answerPayOnDelivery(request, locals.source);
