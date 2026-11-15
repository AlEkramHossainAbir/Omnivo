import type { APIRoute } from 'astro';

import { answerVerifyCode } from '../../../server/orders';

// Step 26c: the phone code from /checkout/verify. The order comes from the cookie, never the body
export const POST: APIRoute = ({ request, locals }) =>
  answerVerifyCode(request, locals.source, { secure: import.meta.env.PROD });
