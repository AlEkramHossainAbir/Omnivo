import { contractErrorMap, isErrorCode, type ErrorCode, type Problem } from '@omnivo/contracts';

// Step 26b: the shop's API routes answer errors the way the ERP's API does (RFC 9457 problem
// details, apps/api/src/common/http/problem.ts): a code the browser translates with
// t('errors.<code>'), never English text it would show. One shape, so one client reads both.

const TITLES = { 400: 'Bad Request', 500: 'Internal Server Error' } as const;

export function problemResponse(
  status: keyof typeof TITLES,
  code: ErrorCode,
  detail: string,
  fieldErrors?: Record<string, ErrorCode[]>,
): Response {
  const body: Problem = {
    title: TITLES[status],
    status,
    detail,
    code,
    // Left out, not `undefined`, when there are none (exactOptionalPropertyTypes)
    ...(fieldErrors ? { fieldErrors } : {}),
  };
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
  });
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
  return problemResponse(400, 'invalid_input', 'Check the request and try again.', fieldErrors);
}

// Parse with this, so Zod's own issues carry our codes ('too_large') instead of English
export const parseOptions = { error: contractErrorMap };
