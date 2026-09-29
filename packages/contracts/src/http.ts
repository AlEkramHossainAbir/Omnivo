import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// একটা endpoint-এর পুরো চুক্তি: কোন method আর path, কী পাঠাতে হবে, কী ফেরত আসবে।
// API এটা দিয়ে রুট বানায় আর যাচাই করে, app এটা দিয়ে request পাঠায়, OpenAPI এটা থেকে লেখা হয়
export interface RouteDef {
  method: HttpMethod;
  // Nest আর MSW দুজনেই ":id" লেখে; OpenAPI-তে "{id}" হয়ে যায় (openapi.ts)
  path: `/${string}`;
  // OpenAPI-র এক লাইনের বিবরণ
  summary: string;
  // 'public' = লগইন ছাড়া; বাকি সব Bearer টোকেন চায় (API-র global AuthGuard)
  auth: 'public' | 'bearer';
  status: 200 | 201 | 204;
  params?: z.ZodObject;
  // querystring-এর সব মান string হয়ে আসে — সংখ্যা হলে z.coerce লাগবে
  query?: z.ZodObject;
  body?: z.ZodType;
  // JSON যেমন তারের উপর যায় ঠিক তেমন (transform ছাড়া); 204 হলে z.void()
  response: z.ZodType;
}

// runtime-এ কিছু করে না। R extends RouteDef চুক্তির আকার যাচাই করে, আর `const` literal
// টাইপ ('GET', '/members') ধরে রাখে — নাহলে method হয়ে যেত সাধারণ string
export function defineRoute<const R extends RouteDef>(route: R): R {
  return route;
}

type Part = 'params' | 'query' | 'body';

// সার্ভার যা পায়: parse-এর পরের মান (trim/lowercase/default বসানো) — z.output।
// অংশটা চুক্তিতে না থাকলে unknown: intersection-এ unknown কিছুই যোগ করে না (A & unknown = A)
type ParsedPart<R, K extends Part> =
  R extends Record<K, infer S extends z.ZodType> ? Record<K, z.output<S>> : unknown;

// ক্লায়েন্ট যা পাঠায়: parse-এর আগের মান — z.input। সব key ঐচ্ছিক হলে পুরো অংশটাই ঐচ্ছিক
// (যেমন pagination-এর query: কিছু না দিলেও চলে)। চুক্তিতে অংশটা না থাকলে `?: never` —
// GET /auth/me-তে ভুল করে body পাঠালে compile error
type SentPart<R, K extends Part> =
  R extends Record<K, infer S extends z.ZodType>
    ? Partial<z.input<S>> extends z.input<S>
      ? Partial<Record<K, z.input<S>>>
      : Record<K, z.input<S>>
    : Partial<Record<K, never>>;

export type RouteInput<R> = ParsedPart<R, 'params'> &
  ParsedPart<R, 'query'> &
  ParsedPart<R, 'body'>;

export type RouteRequest<R> = SentPart<R, 'params'> & SentPart<R, 'query'> & SentPart<R, 'body'>;

// handler যা ফেরত দেয় (z.input), আর ক্লায়েন্ট parse করে যা পায় (z.output)
export type RouteResponse<R extends RouteDef> = z.input<R['response']>;
export type RouteResult<R extends RouteDef> = z.output<R['response']>;

// path-এর ":id" জায়গায় মান বসানো; encodeURIComponent — মানে "/" থাকলে অন্য রুটে চলে যেত
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(value);
  });
}
