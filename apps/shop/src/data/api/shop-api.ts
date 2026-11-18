import {
  buildPath,
  type ErrorCode,
  isErrorCode,
  problemSchema,
  type RouteDef,
  SHOP_CLIENT_ADDRESS_HEADER,
  SHOP_HOST_HEADER,
  SHOP_KEY_HEADER,
} from '@omnivo/contracts';
import type { z } from 'zod';

import type { AnswerCache, ApiAnswer } from './answer-cache';

// Step 26f.5: how the shop's server calls the ERP's public API (/public/v1) for one shop. Server
// only: it runs in the pages' frontmatter and the API routes, never in a browser script.

// The API did not answer the question: it is down, too slow, failed (5xx), or sent a body that
// breaks the contract. The page fails (Astro's 500), and the next request asks again: none of
// these answers is kept (answer-cache.ts)
export class ShopApiError extends Error {
  // 0: no answer reached the shop's server at all
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ShopApiError';
    this.status = status;
  }
}

// The host is not a launched shop (404 storefront_not_found). Its own class, because the answer
// is the same for every route: the middleware draws "No shop has this address" (src/middleware.ts)
export class ShopMissingError extends Error {
  constructor(host: string) {
    super(`No launched shop has the host ${host}`);
    this.name = 'ShopMissingError';
  }
}

// What a route may answer: its value, or a refusal the caller decides about ("no such product"
// is a normal answer for product(), a mistake for shop()). `code` is null for a code this shop
// does not know, from an API newer than the shop. Step 27a: `params` are the problem's own
// ("triesLeft", "seconds", "minutes"), for the words the shopper reads; {} when it has none
export type ShopApiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      code: ErrorCode | null;
      params: Record<string, string | number>;
    };

// The query as the API reads it: every value a string, the ones not set left out
type Query = Record<string, string | undefined>;

export interface ShopApi {
  get<S extends z.ZodType>(
    route: RouteDef & { method: 'GET'; response: S },
    input?: { params?: Record<string, string>; query?: Query },
  ): Promise<ShopApiResult<z.output<S>>>;
  // Step 27a: `clientAddress` is the shopper's address, for the routes that count a shopper
  // (placeOrder, track). It is sent only on a route with auth 'shop', next to the key
  post<S extends z.ZodType, B extends z.ZodType>(
    route: RouteDef & { method: 'POST'; response: S; body: B },
    body: z.input<B>,
    options?: { clientAddress?: string },
  ): Promise<ShopApiResult<z.output<S>>>;
}

export interface ShopApiOptions {
  apiUrl: string;
  // The shop's host, as the shopper's browser asked for it (acme.omnivosoft.com)
  host: string;
  // Step 27a: SHOP_API_KEY, sent on the order routes only (auth: 'shop')
  key: string;
  cache: AnswerCache;
  // How long a page waits for the API. Long enough for a slow query, short enough that a shopper
  // sees an error page instead of a browser that spins forever
  timeoutMs?: number;
  // For the tests, which answer without a network
  fetch?: typeof fetch;
}

export function createShopApi({
  apiUrl,
  host,
  key,
  cache,
  timeoutMs = 8_000,
  fetch: send = fetch,
}: ShopApiOptions): ShopApi {
  // One request, read to the end: the status and the JSON body (null when it is not JSON, such as
  // a proxy's own HTML error page). A network failure or the timeout is a ShopApiError.
  // `extra` are the order routes' own headers (the key and the shopper's address)
  async function ask(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<ApiAnswer> {
    const headers = new Headers({ accept: 'application/json', [SHOP_HOST_HEADER]: host, ...extra });
    if (body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await send(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ShopApiError(0, `${method} ${path} for ${host} got no answer: ${String(error)}`);
    }
    const json: unknown = await response.json().catch(() => null);
    return { status: response.status, body: json };
  }

  // The answer as the route's value, or a refusal. A 2xx body is parsed with the route's own
  // schema, so a page gets exactly the contract's type, and an API that broke the contract is
  // found here rather than as "undefined" deep in a component
  function readAnswer<S extends z.ZodType>(
    route: RouteDef & { response: S },
    path: string,
    answer: ApiAnswer,
  ): ShopApiResult<z.output<S>> {
    if (answer.status >= 200 && answer.status < 300) {
      const parsed = route.response.safeParse(answer.body);
      if (!parsed.success) {
        throw new ShopApiError(answer.status, `${route.method} ${path} broke its contract`);
      }
      return { ok: true, value: parsed.data };
    }
    const problem = problemSchema.safeParse(answer.body);
    // A 5xx, or a refusal with no problem body (a proxy's page): the API did not answer
    if (answer.status >= 500 || !problem.success) {
      throw new ShopApiError(
        answer.status,
        `${route.method} ${path} failed (${String(answer.status)})`,
      );
    }
    if (problem.data.code === 'storefront_not_found') throw new ShopMissingError(host);
    // Step 27a: a wrong key is a setup mistake, never a shopper's. The message names both settings,
    // because the log is the only place anyone reads it: the shopper sees the checkout's "try again"
    if (problem.data.code === 'storefront_shop_key_invalid') {
      throw new ShopApiError(
        answer.status,
        `${route.method} ${path}: the API refused the shop's key. SHOP_API_KEY must be the API's STOREFRONT_SHOP_KEY`,
      );
    }
    return {
      ok: false,
      status: answer.status,
      code: isErrorCode(problem.data.code) ? problem.data.code : null,
      params: problem.data.params ?? {},
    };
  }

  // Step 27a: what an order route sends besides the host. Decided by the route's own `auth`, so a
  // read route never carries the key (it would end up in the read routes' logs and cache for no
  // reason) and an order route never goes without it
  function shopHeaders(route: RouteDef, clientAddress: string | undefined): Record<string, string> {
    if (route.auth !== 'shop') return {};
    const headers: Record<string, string> = { [SHOP_KEY_HEADER]: key };
    if (clientAddress !== undefined) headers[SHOP_CLIENT_ADDRESS_HEADER] = clientAddress;
    return headers;
  }

  return {
    async get(route, input = {}) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) search.set(key, value);
      }
      const query = search.size === 0 ? '' : `?${search.toString()}`;
      const path = `${buildPath(route.path, input.params)}${query}`;
      // The host is part of the key (decision 24): two shops ask for the same "/public/v1/home"
      const answer = await cache.read(`${host} ${path}`, () => ask('GET', path));
      return readAnswer(route, path, answer);
    },
    async post(route, body, options = {}) {
      // Never kept: a POST asks about one cart or one order, and its answer is for now only
      const path = buildPath(route.path);
      const headers = shopHeaders(route, options.clientAddress);
      return readAnswer(route, path, await ask('POST', path, body, headers));
    },
  };
}
