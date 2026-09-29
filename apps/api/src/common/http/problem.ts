import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import type { ErrorCode, Problem } from '@omnivo/contracts';

import { AppError } from './app-error.js';

// Nest বা Fastify নিজে যে HttpException ছোড়ে (অচেনা রুট, ভাঙা JSON) — তার status থেকে code
function codeForStatus(status: number): ErrorCode {
  if (status === 404) return 'not_found';
  if (status === 400 || status === 413 || status === 415) return 'malformed_request';
  if (status === 401) return 'sign_in_required';
  if (status >= 500) return 'internal_error';
  return 'request_failed';
}

function problem(status: number, code: ErrorCode, detail: string, requestId: string): Problem {
  // title = HTTP status-এর নাম: RFC 9457-এ type না থাকলে ("about:blank") এটাই নিয়ম
  return { title: STATUS_CODES[status] ?? 'Error', status, detail, code, requestId };
}

// যেকোনো ছোড়া জিনিস → RFC 9457 problem। অচেনা error-এর মেসেজ কখনো বাইরে যায় না —
// তাতে SQL, ফাইলের পাথ বা stack থাকতে পারে
export function toProblem(error: unknown, requestId: string): Problem {
  if (error instanceof AppError) {
    return {
      ...problem(error.status, error.code, error.message, requestId),
      ...error.options,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return problem(status, codeForStatus(status), error.message, requestId);
  }
  // Fastify-র নিজের error (যেমন ভাঙা JSON body): statusCode থাকে, HttpException না
  if (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return problem(error.statusCode, codeForStatus(error.statusCode), error.message, requestId);
  }
  return problem(500, 'internal_error', 'Something went wrong on our side.', requestId);
}
