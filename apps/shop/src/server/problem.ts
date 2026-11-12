import { contractErrorMap, isErrorCode, type ErrorCode, type Problem } from '@omnivo/contracts';

// Step 26b: the shop's API routes answer errors the way the ERP's API does (RFC 9457 problem
// details, apps/api/src/common/http/problem.ts): a code the browser translates with
// t('errors.<code>'), never English text it would show. One shape, so one client reads both.

// Step 26c: the order routes also refuse with 404, 409, 422 and 429 (server/orders.ts says which)
const TITLES = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
} as const;

export type ProblemStatus = keyof typeof TITLES;

// Step 26c: what else a problem may carry. `params` go into the words ("2 tries left"); `headers`
// are added to the response (Set-Cookie when a refusal also ends the order, Retry-After)
interface ProblemOptions {
  fieldErrors?: Record<string, ErrorCode[]>;
  params?: Record<string, string | number>;
  headers?: HeadersInit;
}

export function problemResponse(
  status: ProblemStatus,
  code: ErrorCode,
  detail: string,
  options: ProblemOptions = {},
): Response {
  const body: Problem = {
    title: TITLES[status],
    status,
    detail,
    code,
    // Left out, not `undefined`, when there are none (exactOptionalPropertyTypes)
    ...(options.params ? { params: options.params } : {}),
    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
  };
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/problem+json');
  headers.set('Cache-Control', 'no-store');
  return Response.json(body, { status, headers });
}

// Only what invalidInput reads from a ZodError. Written out so the shop needs no direct `zod`
// dependency just for a type
interface ParseError {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}

// A failed parse → 400 invalid_input with each field's codes, keyed like the ERP's API does
// ("lines.2.quantity"), so the same client code can point at the line
export function invalidInput(error: ParseError): Response {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    // The schema's own code ('invalid_input' for a repeated line) or the error map's; anything
    // else (Zod's English) becomes invalid_value
    const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
    (fieldErrors[field] ??= []).push(code);
  }
  return problemResponse(400, 'invalid_input', 'Check the request and try again.', {
    fieldErrors,
  });
}

// Parse with this, so Zod's own issues carry our codes ('too_large') instead of English
export const parseOptions = { error: contractErrorMap };

// Step 26c: what readBody needs from a schema. Zod's safeParse fits it; written out for the same
// reason as ParseError
interface BodySchema<T> {
  safeParse(
    input: unknown,
    options: typeof parseOptions,
  ): { success: true; data: T } | { success: false; error: ParseError };
}

// Step 26c: the first lines of every POST route, in one place. The body must say it is JSON, be
// JSON, and pass the schema; anything else is the response to send back as it is.
// The Content-Type check matters for the routes that read cookies: a form on another site can post
// text/plain to this server, and Astro's origin check (security.checkOrigin, on by default) is the
// only thing that refuses it. JSON can only come from a script, which the browser stops from
// another site unless the server allows it (CORS), and this server allows no one.
export async function readBody<T>(
  request: Request,
  schema: BodySchema<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return {
      ok: false,
      response: problemResponse(400, 'malformed_request', 'The body must be JSON.'),
    };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Not JSON, or bigger than the adapter's bodySizeLimit (reading it throws then): the same
    // code the ERP's API sends for a body it cannot read
    return {
      ok: false,
      response: problemResponse(400, 'malformed_request', 'The body must be JSON.'),
    };
  }
  const parsed = schema.safeParse(body, parseOptions);
  if (!parsed.success) return { ok: false, response: invalidInput(parsed.error) };
  return { ok: true, data: parsed.data };
}

// The source threw: the real one calls the API, which can be down. Logged here with its details;
// the shopper gets a code the page turns into "Try again", never the error's text
export function sourceFailed(what: string, error: unknown): Response {
  console.error(`${what} failed`, error);
  return problemResponse(500, 'internal_error', 'Something went wrong on our side.');
}
