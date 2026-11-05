import {
  applyDecorators,
  createParamDecorator,
  Delete,
  type ExecutionContext,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  contractErrorMap,
  type ErrorCode,
  type HttpMethod,
  isErrorCode,
  type RouteDef,
  type RouteInput,
  type RouteResponse,
} from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

import { Public } from '../../auth/public.decorator.js';
import { AppError } from './app-error.js';

export const ROUTE_KEY = 'omnivo:route';

const reflector = new Reflector();

// handler-এর উপরে বসানো চুক্তি — ContractInterceptor আর ইনপুট-পার্সার দুজনেই এখান থেকে পড়ে
export function routeOf(context: ExecutionContext): RouteDef | undefined {
  return reflector.get<RouteDef | undefined>(ROUTE_KEY, context.getHandler());
}

const METHOD = {
  GET: Get,
  POST: Post,
  PUT: Put,
  PATCH: Patch,
  DELETE: Delete,
} satisfies Record<HttpMethod, (path?: string) => MethodDecorator>;

const PARTS = ['params', 'query', 'body'] as const;

// request-এর params/query/body চুক্তির schema দিয়ে parse। সব অংশের ভুল একসাথে জমিয়ে একটাই
// 400 — ফর্মে প্রথম ভুল ঠিক করে আবার জমা দিয়ে পরেরটা জানার দরকার পড়ে না
function parseInput(route: RouteDef, request: FastifyRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const part of PARTS) {
    const schema = route[part];
    if (!schema) continue;
    const result = schema.safeParse(request[part], { error: contractErrorMap });
    if (result.success) {
      input[part] = result.data;
      continue;
    }
    for (const issue of result.error.issues) {
      // react-hook-form-এর মতো পাথ: "items.0.qty"; পুরো অংশটাই ভুল হলে (body নেই) অংশের নাম
      const field = issue.path.map(String).join('.') || part;
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      (fieldErrors[field] ??= []).push(code);
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError(400, 'invalid_input', 'Check the highlighted fields and try again.', {
      fieldErrors,
    });
  }
  return input;
}

const ContractInput = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const route = routeOf(context);
  if (!route) throw new Error('ContractInput used on a handler without @Endpoint()');
  return parseInput(route, context.switchToHttp().getRequest<FastifyRequest>());
});

type Awaitable<T> = T | Promise<T>;

// চুক্তিতে ইনপুট থাকলে handler-এর প্রথম প্যারামিটার সেই ইনপুট; না থাকলে প্যারামিটার স্বাধীন।
// ফেরত মান চুক্তির response-এর টাইপ — না মিললে compile error
type Handler<R extends RouteDef> = [keyof RouteInput<R>] extends [never]
  ? (...rest: never[]) => Awaitable<RouteResponse<R>>
  : (input: RouteInput<R>, ...rest: never[]) => Awaitable<RouteResponse<R>>;

// @Endpoint(routes.members.list): method, path, status code, public কি না — সব চুক্তি থেকে।
// Controller-এ path আলাদা করে লেখা হয় না, তাই চুক্তি আর আসল রুট কখনো আলাদা হতে পারে না
export function Endpoint<R extends RouteDef>(route: R) {
  return <T extends Handler<R>>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const decorators: MethodDecorator[] = [
      METHOD[route.method](route.path),
      HttpCode(route.status),
      SetMetadata(ROUTE_KEY, route),
    ];
    if (route.auth === 'public') decorators.push(Public());
    applyDecorators(...decorators)(target, key, descriptor);

    // ইনপুট থাকলে প্রথম প্যারামিটারে parse করা ইনপুট বসানো — Handler টাইপ আগেই নিশ্চিত করেছে যে
    // প্রথম প্যারামিটারের টাইপ ঠিক এটাই, তাই আলাদা করে @Body() লেখার (আর ভুল schema দেওয়ার) সুযোগ নেই
    if (route.params ?? route.query ?? route.body) ContractInput()(target, key, 0);
  };
}
