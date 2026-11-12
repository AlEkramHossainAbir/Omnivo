import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerVerifyCode } from '../../../server/orders';

// Step 26c: the phone code from /checkout/verify. The order comes from the cookie, never the body
export const POST: APIRoute = ({ request }) =>
  answerVerifyCode(request, shopSource, { secure: import.meta.env.PROD });
