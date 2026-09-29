import type { ErrorCode, HttpMethod, Problem, RouteDef, RouteResponse } from '@omnivo/contracts';
import { http, type HttpHandler, type HttpResponseResolver } from 'msw';
import type { z } from 'zod';

import { API_URL } from '../lib/api';

const ON = {
  GET: http.get,
  POST: http.post,
  PUT: http.put,
  PATCH: http.patch,
  DELETE: http.delete,
} satisfies Record<HttpMethod, typeof http.get>;

// চুক্তির method আর path থেকেই MSW-এর handler — URL হাতে লেখা হয় না, তাই চুক্তির path বদলালে
// mock-ও সাথে সাথে বদলায়। MSW-ও Nest-এর মতো ":id" লেখে, রূপান্তর লাগে না
export function mock(route: RouteDef, resolver: HttpResponseResolver): HttpHandler {
  return ON[route.method](`${API_URL}${route.path}`, resolver);
}

// data-র টাইপ চুক্তির response থেকে (ভুল ফিল্ড = compile error), আর runtime-এ schema দিয়ে
// যাচাই — fixture কখনো আসল API-র আকার থেকে সরে যেতে পারে না
export function reply<R extends RouteDef>(route: R, data: RouteResponse<R>): Response {
  route.response.parse(data);
  if (route.status === 204) return new Response(null, { status: 204 });
  return Response.json(data, { status: route.status });
}

// আসল API-র মতোই RFC 9457 problem — UI-র error-পথ mock দিয়েও দেখা যায়
export function problem(
  status: number,
  code: ErrorCode,
  fieldErrors?: Record<string, ErrorCode[]>,
): Response {
  const body: Problem = {
    title: 'Mocked error',
    status,
    detail: `Mocked ${code}`,
    code,
    requestId: crypto.randomUUID(),
    ...(fieldErrors && { fieldErrors }),
  };
  return Response.json(body, { status, headers: { 'content-type': 'application/problem+json' } });
}

// ক্লায়েন্ট যা পাঠাল তা চুক্তির schema দিয়ে পড়া — আসল সার্ভারের মতোই parse করা মান
export function readQuery<S extends z.ZodObject>(schema: S, request: Request): z.output<S> {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}

export async function readBody<S extends z.ZodType>(
  schema: S,
  request: Request,
): Promise<z.output<S>> {
  return schema.parse(await request.json());
}
