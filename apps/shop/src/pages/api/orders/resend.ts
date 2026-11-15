import type { APIRoute } from 'astro';

import { answerResendCode } from '../../../server/orders';

// Step 26c: "Resend code". POST, not GET: it sends an SMS, and a GET could be fired by a link
// preview, a prefetch or an <img> on another site
export const POST: APIRoute = ({ request, locals }) =>
  answerResendCode(request, locals.source, { secure: import.meta.env.PROD });
