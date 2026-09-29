# ধাপ ৫: API কন্ট্র্যাক্ট — route রেজিস্ট্রি, error envelope, keyset pagination, OpenAPI, MSW

> [build-plan.bn.md](build-plan.bn.md)-এর "ধাপ ৫" অংশের ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী
> লিখতে হবে, কোন কমান্ড কোথায় চালাতে হবে।
>
> এই গাইডের প্রতিটা ফাইল রিপোর একটা আলাদা কপিতে (ধাপ ৪-এর commit `c3f8312`-এর উপর) বসিয়ে যাচাই করা
> (২০২৬-০৯-২৮): `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`
> (৭৩টা — নতুন ৩২টা সহ), `pnpm build`, `pnpm test:bundle-size` (প্রথম লোড 156.3 KB gz, বাজেট 200),
> `pnpm test:openapi`, `pnpm boundaries` — সব পাস। নতুন দুটো boundary নিয়ম ইচ্ছা করে ভাঙা import দিয়ে,
> আর টাইপের পাহারা ইচ্ছা করে ভুল কোড লিখে যাচাই করা (৫.৯)। তারপর headless Chrome-এ `pnpm dev:mock`
> (MSW, আসল API ছাড়া): ড্যাশবোর্ডে টেবিল scroll করে ২৪০ জনের সব পাতা (৫০ করে) → হেডারে ক্লিক করে
> সার্ভার-sort → সাইন আউট → লগইন পেজ বাংলায় → ফাঁকা ফর্মে বাংলা error → ভুল পাসওয়ার্ডে সার্ভারের error
> বাংলায়, ভাষা বদলালে সেই error-ও সাথে সাথে ইংরেজিতে → সাইনআপে নেওয়া ঠিকানা → ৩৯০px dark-এ কার্ডে
> সব পাতা, আড়াআড়ি scroll নেই। শেষে contracts-এ `fullName` → `name` বদলে দেখা হয়েছে কোথায় কোথায় লাল
> দাগ পড়ে (৫.১৩)।
>
> ⚠️ **যা যাচাই হয়নি:** `pnpm test:integration` আর `pnpm test:tenant-leak` — যাচাইয়ের সময় Docker
> Desktop বন্ধ ছিল। তাই নতুন `members.int.spec.ts` (আসল Postgres-এ keyset pagination), বদলানো
> `auth.int.spec.ts` আর tenant-leak স্যুট এই ধাপের কোডের উপর একবারও চলেনি; আসল API-র সাথে (`pnpm dev`)
> ব্রাউজারের flow-ও না। ইমপ্লিমেন্টের পরে সবার আগে এগুলো চালান — কোথায় ঝুঁকি তা ৫.৭-এর শেষে লেখা।

## লক্ষ্য

🔗 **API-র প্রতিটা endpoint এক জায়গায় লেখা একটা চুক্তি — সেখানে একটা ফিল্ডের নাম বদলালে API আর app
দুই জায়গাতেই সাথে সাথে লাল দাগ।** পেছনে যা তৈরি হবে:

- `packages/contracts`-এ **route রেজিস্ট্রি**: প্রতিটা endpoint-এর method, path, ইনপুট আর উত্তরের Zod
  schema। API-র controller path লেখে না — `@Endpoint(routes.members.list)`। app URL লেখে না —
  `call(routes.members.list, { query })`।
- **error envelope**: প্রতিটা error RFC 9457 "problem details" আকারে, সাথে একটা `code` (`slug_taken`)।
  UI code দেখে নিজের ভাষায় লেখে — লগইন আর সাইনআপ এবার বাংলায়।
- **keyset pagination কনভেনশন**: `?limit=&cursor=` → `{ items, nextCursor }`। টিম-তালিকায় প্রথম
  ব্যবহার; DataTable-এ infinite scroll আর সার্ভার-sort।
- **OpenAPI 3.1**: রেজিস্ট্রি থেকে জেনারেট, `packages/contracts/openapi.json`-এ commit, CI পাহারা দেয়;
  dev-এ `http://localhost:3000/docs`।
- **MSW**: `pnpm dev:mock` — আসল API ছাড়াই পুরো UI; একই handler app-এর টেস্টেও।
- app-এ **TanStack Query** — ড্যাশবোর্ডের হাতে লেখা `useEffect` + `cancelled` ফ্ল্যাগ বাদ।

## পুরো ছবিটা এক নজরে

```
packages/contracts   (শুধু zod — ব্রাউজার আর সার্ভার দুজনেই নেয়)
  routes = { health, auth, members }       ← প্রতিটা endpoint: method, path, query/body, response
  errors.ts    ERROR_CODES, problemSchema, contractErrorMap
  openapi.ts   buildOpenApiDocument(routes) ← আলাদা subpath: @omnivo/contracts/openapi
      │
      ├──► apps/api      @Endpoint(route) → Nest-এর @Get/@Post + HttpCode + public
      │                  ইনপুট parse (ভুল হলে 400 + fieldErrors) → handler → ContractInterceptor
      │                  যেকোনো error → ProblemFilter → application/problem+json
      │                  contract.spec.ts: Nest-এর আসল রুট == রেজিস্ট্রি (বেশি বা কম হলে fail)
      │
      ├──► apps/app      call(route, input) → fetch → উত্তর parse → টাইপ চুক্তি থেকে
      │                  useInfiniteQuery → DataTable (sorting, onEndReached)
      │                  mocks/ (MSW): handler-এর URL আর fixture-এর টাইপ চুক্তি থেকে
      │
      ├──► packages/i18n errors.* = ERROR_CODES-এর প্রতিটার লেখা (en/bn); useLocale().errorText
      │
      └──► openapi.json  `pnpm gen:openapi` লেখে; `pnpm test:openapi` (CI) পুরনো হলে fail

contracts-এ একটা ফিল্ডের নাম বদলালে:
  ├─ API-র handler-এ compile error  (ফেরত মান চুক্তির response-এর সাথে মেলে না)
  ├─ app-এর পেজ, mock, টেস্টে compile error  (member.fullName আর নেই)
  └─ `pnpm test:openapi` fail  (PR-এ openapi.json-এর diff-এ বদলটা চোখে পড়ে)
```

## এই ধাপের ভিত্তি-সিদ্ধান্ত

1. **orval/codegen না — Zod রেজিস্ট্রি থেকে সরাসরি টাইপ। build-plan-এর একটা লাইন বদলাচ্ছে।** build-plan
   আর system-design §৩.২ বলে "OpenAPI → orval/openapi-typescript দিয়ে typed client"। সেটা সঠিক যখন
   ক্লায়েন্ট আর সার্ভার আলাদা ভাষায় বা আলাদা রিপোতে। আমাদের দুটোই TypeScript, একই মনোরেপো, আর চুক্তি
   আগে থেকেই Zod-এ (ধাপ ৩)। codegen নিলে:
   - একই আকারের টাইপ দুবার থাকত — Zod থেকে infer করা আর OpenAPI থেকে জেনারেট করা। CLAUDE.md rule ২
     ঠিক এর উল্টো বলে: "Zod schema-ই উৎস, নকল না"।
   - Zod-এর `refine` (reserved slug), নিজস্ব error code আর `trim`/`toLowerCase` OpenAPI-তে হারায়। তাই
     ফর্মকে আবার আসল Zod schema-ই নিতে হতো — দুই উৎস পাশাপাশি।
   - লাল দাগ দেখতে প্রতিবার `pnpm gen:client` মনে রাখতে হতো। এখন `pnpm dev`-এর `tsc --watch` সাথে
     সাথেই দেখায়।

   OpenAPI তবু তৈরি হয় — টাইপের **উৎস** হিসেবে না, **ফলাফল** হিসেবে: docs, ধাপ ২৯-এর public API,
   বাইরের কেউ client বানাতে চাইলে, আর PR-এ চুক্তির diff। (এই পথটা আপনি বেছে নিয়েছেন, ২০২৬-০৯-২৮।)
2. **OpenAPI Nest থেকে না, রেজিস্ট্রি থেকে — কিন্তু Nest-এর সাথে মিল টেস্টে বাঁধা।** `@nestjs/swagger`
   DTO class আর decorator চায়; Zod-এর সাথে জুড়তে `nestjs-zod`-এর মতো তৃতীয় লাইব্রেরি লাগত, যার Nest 12
   সমর্থনের ভরসা নেই। Zod 4 নিজেই `z.toJSONSchema()` দেয়, আর OpenAPI 3.1-এর schema মানেই JSON Schema
   2020-12 — তাই ১০০ লাইনের নিজের builder যথেষ্ট। ঝুঁকি একটাই: রেজিস্ট্রিতে আছে কিন্তু API-তে নেই (বা
   উল্টো)। সেটা দুই দিক থেকে বন্ধ: controller নিজে path লেখেই না (`@Endpoint` চুক্তি থেকে নেয়), আর
   `contract.spec.ts` আসল Nest অ্যাপ চালিয়ে দেখে Fastify-তে নিবন্ধিত রুট আর রেজিস্ট্রি হুবহু এক।
3. **error envelope = RFC 9457 (Problem Details).** HTTP API-র error-এর IETF মানদণ্ড:
   `application/problem+json` আর `title`, `status`, `detail` ফিল্ড। নিজের আকার বানানোর চেয়ে মানদণ্ড
   নিলে বাইরের টুল (API gateway, Scalar, ভবিষ্যতের SDK) এটা চেনে। আমাদের যোগ (RFC-র ভাষায় "extension
   member"): `code`, `params`, `fieldErrors`, `requestId`। `type` দেওয়া হয় না — RFC অনুযায়ী তখন মানে
   `about:blank`, আর `title` হয় HTTP status-এর নাম।
4. **মেসেজ না, code।** সার্ভার আর Zod schema পাঠায় `slug_taken`, "This address is taken…" না। লেখা থাকে
   `packages/i18n`-এর `errors.*`-এ (en + bn)। ফলে (ক) লগইন/সাইনআপ বাংলায় যায় — ধাপ ৪-এর CLAUDE.md
   ব্যতিক্রম এবার উঠে যাচ্ছে; (খ) ফর্মে code থাকে, লেখা না — তাই error দেখানোর পরে ভাষা বদলালে error-ও
   সাথে সাথে বদলায় (যাচাই করা)। `detail`-এ ইংরেজি থাকে লগ আর API-র বাইরের ব্যবহারকারীর জন্য।
5. **code-এর তালিকা একটাই, টাইপ-চেকড।** `ERROR_CODES` থাকে contracts-এ (সার্ভার ছোড়ে, ক্লায়েন্ট চেনে)।
   `en.ts`-এর `errors` হলো `satisfies Record<ErrorCode, string>` — নতুন code যোগ করে অনুবাদ ভুলে গেলে
   compile error; আর `bn.ts` তো `Messages` মানতে বাধ্যই। কিন্তু তারের উপর (wire) code `z.string()`, enum
   না: অফলাইন PWA-র পুরনো কপি নতুন সার্ভারের অচেনা code পেলে parse-এ ভেঙে না পড়ে `unknown_error`
   দেখায়।
6. **keyset pagination, OFFSET না** (system-design §৫.৬)। `?limit=50&cursor=…` → `{ items, nextCursor }`।
   cursor ক্লায়েন্টের কাছে অস্বচ্ছ string (ভেতরে শেষ রো-র sort-কলাম + id, base64url JSON)। মোট সংখ্যা
   (`total`) নেই — `COUNT(*)` বড় টেবিলে পুরো টেবিল পড়ে। sort হয় সার্ভারে (`sort=name` / `sort=-name`),
   কারণ পাতায় পাতায় আসা তালিকা ক্লায়েন্টে sort করলে শুধু আনা রো-গুলো সাজাত — ভুল ফল।
7. **উত্তরও চুক্তি দিয়ে যাচাই — দুই পাশে।** API-তে `ContractInterceptor` handler-এর ফেরত মান response
   schema দিয়ে parse করে: চুক্তিতে নেই এমন ফিল্ড (ভুল করে যোগ হওয়া hash, অন্য টেন্যান্টের id) কেটে বাদ
   পড়ে, আর না মিললে 500 + লগ। app-এ `call()` আবার parse করে — সার্ভারের নতুন সংস্করণ চুক্তি ভাঙলে ভাঙা
   ডেটা UI-তে ঢোকে না, `unexpected_response` আসে।
8. **MSW = চুক্তির আরেকজন ভোক্তা।** handler-এর URL আসে চুক্তি থেকে, fixture-এর টাইপ চুক্তি থেকে, আর
   runtime-এ `route.response.parse()` — mock কখনো আসল API থেকে সরে যেতে পারে না। একই handler ব্রাউজারে
   (`pnpm dev:mock`) আর Node-এ (vitest)।
9. **TanStack Query এখন, কারণ pagination এখন।** `useInfiniteQuery` পাতা জোড়া দেয়, পরের cursor রাখে, একই
   পাতা দুবার চায় না, পুরনো request-এর দেরিতে আসা উত্তর ফেলে দেয়। workspace বদলালে আর লগআউটে পুরো ক্যাশ
   মোছা হয় — এক টেন্যান্টের ডেটা অন্যটায় এক মুহূর্তের জন্যও না।

## এই ধাপে যা ইচ্ছাকৃতভাবে নেই

| জিনিস | কেন এখন না / কখন আসবে |
|---|---|
| orval / openapi-typescript | ভিত্তি-সিদ্ধান্ত ১। বাইরের কেউ (মোবাইল টিম, পার্টনার) client চাইলে commit করা `openapi.json` থেকেই জেনারেট করতে পারবে |
| চুক্তিতে permission (`core.user.read`) | `PermissionKey` এখন `packages/db`-তে (সার্ভারের)। contracts-এ সরালে ড্যাশবোর্ডের `'core.user.read'` string-ও টাইপ-চেকড হতো — permission matrix-এর সাথে (ধাপ ৭) |
| OpenAPI-তে endpoint-প্রতি সম্ভাব্য error code | এখন সব operation-এ একটা `default` problem। কোন endpoint কোন code দেয় সেটা চুক্তিতে লিখে টেস্টে পাহারা — public API-র আগে (ধাপ ২৯) |
| শেয়ার করা schema-র `$ref` (`components.schemas`) | `Problem` ছাড়া সব inline। নাম লাগলে Zod-এর `.meta({ id })` — কিন্তু global registry-তে id বসালে Vite HMR-এ module আবার চললে "already exists" হয়, তাই আলাদা registry লাগবে |
| API versioning (`/v1`) | অ্যাপ আর API একসাথে deploy হয়। public API আলাদা prefix নেবে (`/public/v1`, system-design §১৪) |
| request-এ `AbortSignal` | `signal` fetch-এ গেলে TanStack Query unmount-এ request বাতিল করতে পারে। `call()`-এ একটা option — ভারী রিপোর্ট পেজের সাথে (ধাপ ১১) |
| Playwright e2e | ধাপ ৪-এর মতোই ধাপ ৬-এ; এই ধাপের browser flow MSW দিয়ে হাতে-কলমে যাচাই |
| mock-এ আসল keyset | MSW-এর cursor শুধু offset — ক্লায়েন্টের কাছে দুটোই অস্বচ্ছ string, UI-র জন্য যথেষ্ট। আসল keyset-এর পাহারা integration টেস্টে |
| `auth-preview.tsx` অনুবাদ | লগইন পেজের ডানের ছবিটা আসল UI-র ছোট ছবি (CLAUDE.md-এ এই ফাইলের ব্যতিক্রম); বাকি পুরো লগইন পেজ অনুবাদ হয় |
| production-এ `mockServiceWorker.js` বাদ | `public/`-এর ফাইল হুবহু `dist`-এ যায়। কেউ register না করলে এটা কিছুই করে না (MSW-এর নির্দেশিত পথ)। ধাপ ১৯-এর PWA-র সময় Workbox-এর precache তালিকা থেকে বাদ দিতে হবে |

## আগের কোড থেকে যা বাদ বা বদল হচ্ছে

- `apps/api/src/common/zod-validation.pipe.ts` — **মুছে ফেলুন।** ইনপুট parse এখন `@Endpoint()` নিজেই করে
  (৫.৬)।
- `@omnivo/contracts`-এর `apiErrorSchema` / `ApiError` — **বাদ**, জায়গায় `problemSchema` / `Problem`।
  `memberListResponseSchema` → `memberPageSchema` (উত্তর এখন `{ items, nextCursor }`, আগে `{ members }`)।
- auth service আর দুই guard-এর সব `ConflictException` / `NotFoundException` / `UnauthorizedException` /
  `ForbiddenException` → `AppError(status, code, detail)`।
- controller: `@Controller('auth')` + `@Post('sign-up')` + `@Body(new ZodValidationPipe(...))` →
  `@Controller()` + `@Endpoint(routes.auth.signUp)`। `@Public()` আর `@HttpCode` আসে চুক্তি থেকে।
- `apps/app/src/lib/api.ts`: `apiFetch(path, schema, options)` আর `logoutRequest()` → `call(route, input)`।
- `apps/app/src/routes/dashboard.tsx`: `useEffect` + `useState` + `cancelled` → `useInfiniteQuery`।
- লগইন আর সাইনআপ: সব লেখা `t()`-তে; ভাষা বদলানোর বোতাম।
- ui-র `Field` আর `FormAlert`: error-এ code পেলে বর্তমান ভাষায় লেখে।
- CLAUDE.md-এর Language নিয়মের "Exceptions until step 5 … the login and sign-up pages" — ধাপ শেষে মুছবেন
  (৫.১২)।

---

## ৫.১ — `packages/contracts`: error code আর problem envelope

সবার আগে এটা, কারণ route, i18n, API আর app — সবাই এই তালিকা চেনে।

**ফাইল: `packages/contracts/src/errors.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';

// API যত রকম error পাঠায় (আর ক্লায়েন্ট নিজে যত বানায়) তার পুরো তালিকা। UI-র লেখা থাকে
// i18n-এর errors.*-এ — এখানে নতুন code যোগ করে en.ts-এ অনুবাদ না লিখলে typecheck fail করে
export const ERROR_CODES = [
  // সাধারণ যাচাই: schema নিজে code না দিলে Zod-এর issue থেকে আসে (contractErrorMap)
  'invalid_input',
  'required',
  'too_short',
  'too_long',
  'too_small',
  'too_large',
  'invalid_format',
  'invalid_value',
  // নির্দিষ্ট ফিল্ডের যাচাই
  'company_name_required',
  'full_name_required',
  'email_invalid',
  'email_taken',
  'password_required',
  'password_too_short',
  'password_too_long',
  'slug_too_short',
  'slug_too_long',
  'slug_format',
  'slug_reserved',
  'slug_taken',
  // auth ও অনুমতি
  'workspace_not_found',
  'invalid_credentials',
  'not_a_member',
  'sign_in_required',
  'session_ended',
  'access_revoked',
  'switch_denied',
  'permission_missing',
  // HTTP ও সার্ভার
  'invalid_cursor',
  'malformed_request',
  'not_found',
  'request_failed',
  'internal_error',
  // শুধু ক্লায়েন্ট বানায়, সার্ভার কখনো পাঠায় না
  'network_error',
  'unexpected_response',
  'unknown_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

// schema-র ভেতরে মেসেজের জায়গায় code: .min(3, errorCode('slug_too_short'))।
// সাধারণ string লিখলে বানান ভুল ধরা পড়ত না — এই ফাংশন শুধু ErrorCode নেয়
export function errorCode(code: ErrorCode): ErrorCode {
  return code;
}

// schema যেখানে নিজে code দেয়নি (যেমন .max(120)), সেখানে Zod-এর issue দেখে সাধারণ code।
// Zod-এর ক্রম: schema-র নিজের মেসেজ > parse-এর সময় দেওয়া এই map > Zod-এর ইংরেজি মেসেজ
export const contractErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'required' : 'invalid_value';
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array' ? 'too_short' : 'too_small';
    case 'too_big':
      return issue.origin === 'string' || issue.origin === 'array' ? 'too_long' : 'too_large';
    case 'invalid_format':
      return 'invalid_format';
    default:
      return 'invalid_value';
  }
};

// RFC 9457 "Problem Details" — HTTP API-র error-এর প্রচলিত আকার (Content-Type:
// application/problem+json)। title/status/detail RFC-র নিজের ফিল্ড; code, params, fieldErrors,
// requestId আমাদের extension। type নেই = RFC অনুযায়ী "about:blank" (title = HTTP status-এর নাম)
export const problemSchema = z.object({
  title: z.string(),
  status: z.number().int(),
  // ইংরেজি, ডেভেলপার আর লগের জন্য — UI এটা দেখায় না, code অনুবাদ করে দেখায়
  detail: z.string(),
  // z.string(), enum না: নতুন সার্ভার নতুন code পাঠালে পুরনো ক্লায়েন্ট (অফলাইন PWA-র ক্যাশ)
  // parse-এ ভেঙে পড়বে না; isErrorCode() দিয়ে চেনা code-এ নামানো হয়
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  // ফিল্ডের পাথ (react-hook-form-এর মতো: "items.0.qty") → সেই ফিল্ডের error code
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  requestId: z.string().optional(),
});

export type Problem = z.infer<typeof problemSchema>;
```

**কোন লাইন কেন:**

- `ERROR_CODES ... as const` → `ErrorCode` একটা string literal union। flat `snake_case` (`slug_taken`),
  বিন্দু দেওয়া (`workspace.slug.taken`) না: i18next বিন্দুকে key-এর স্তর ভাবে, তখন `errors.workspace.slug.taken`
  খুঁজত আর `errors`-এর আকার code-তালিকার সাথে এক-এক মেলানো যেত না।
- তালিকার শেষ তিনটা (`network_error` …) শুধু ক্লায়েন্ট বানায় — তবু এই তালিকায়, কারণ তাদের লেখাও i18n-এ
  লাগে, আর UI-র কাছে সব error একই রকম।
- `isErrorCode(value: unknown): value is ErrorCode` — type guard। সার্ভার থেকে বা react-hook-form থেকে
  আসে সাধারণ `string`; cast (`as ErrorCode`) না করে এটা দিয়ে নামানো (rule ৩)।
- `errorCode()` — কিছুই করে না, শুধু টাইপ পাহারা দেয়। Zod-এর `.min(3, 'slug_too_shrot')` সাধারণ string
  নেয়, বানান ভুল কেউ ধরত না; `errorCode('slug_too_shrot')` compile error।
- `contractErrorMap` — Zod 4-এর "per-parse error map": `schema.safeParse(value, { error: contractErrorMap })`।
  Zod-এর নিয়মে schema-তে লেখা মেসেজ (আমাদের `errorCode(...)`) আগে জেতে; যেখানে কিছু লেখা নেই
  (`.max(120)`, `z.boolean()`), সেখানে এই map — নাহলে Zod-এর ইংরেজি "Too big: expected string to have
  <=120 characters" ফর্মে দেখাত।
- `issue.input === undefined ? 'required'` — ফিল্ডটাই আসেনি বনাম ভুল টাইপ এসেছে, দুটো আলাদা বার্তা।
  Zod 4 error map-এ `input` দেয় (ডিফল্টে issue-তে রাখে না, কিন্তু map-এ পাওয়া যায়)।
- `issue.origin === 'string' || 'array'` — `too_small` string-এ মানে "ছোট লেখা", সংখ্যায় মানে "ছোট সংখ্যা";
  একই code দুটোর জন্য হলে বাংলা বাক্য ঠিক হতো না।
- `problemSchema`-র `requestId` optional — ক্লায়েন্ট নিজে যে problem বানায় (নেটওয়ার্ক বন্ধ) তার কোনো
  সার্ভার-id নেই।
- `params` — অনুবাদের ভেতরে বসানোর মান: `permission_missing` পাঠায় `{ permissions: 'core.user.read' }`,
  লেখা "You need the {{permissions}} permission"।
- `fieldErrors`-এর key "items.0.qty" রূপে — react-hook-form-এর নিজের পাথ-লেখা একই, তাই ভবিষ্যতের লাইন-আইটেম
  ফর্মে (ইনভয়েস) সার্ভারের error সরাসরি সেই লাইনের নিচে বসবে।

---

## ৫.২ — `packages/contracts`: route-এর আকার আর pagination

**ফাইল: `packages/contracts/src/http.ts`** (নতুন ফাইল)

```ts
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
```

**কোন লাইন কেন:**

- `import type { z }` — এই ফাইলে Zod শুধু টাইপে; runtime-এ কিছু import হয় না।
- `path: \`/${string}\`` — template literal টাইপ: `'members'` (শুরুতে `/` ছাড়া) লিখলে compile error।
- `status` বাধ্যতামূলক — POST মানেই 201 না (লগইন POST কিন্তু কিছু তৈরি করে না, তাই 200)। চুক্তিতে স্পষ্ট
  লিখলে API (`HttpCode`), OpenAPI আর MSW তিনজনই একই সংখ্যা নেয়।
- `response` বাধ্যতামূলক, 204-এর জন্যও (`z.void()`) — এতে `RouteResult<R>` সবসময় `z.output<R['response']>`,
  "response আছে কি না" দেখার conditional type লাগে না। `z.void()` parse করে `undefined`, টাইপে `void`।
- `defineRoute<const R extends RouteDef>` — দুটো কাজ একসাথে: `extends RouteDef` বানান পাহারা দেয় (`methd`,
  `status: 202` compile error), আর TypeScript 5-এর `const` type parameter literal ধরে রাখে। `const` ছাড়া
  `method` হতো `string`, তখন Nest-এর decorator বাছা বা `RouteInput`-এর হিসাব কোনোটাই চলত না।
- `ParsedPart`/`SentPart` — দুই দিকের টাইপ আলাদা, কারণ Zod-এর schema-র input আর output আলাদা হতে পারে:
  `limit: z.coerce.number().default(50)` — ক্লায়েন্ট দিতে পারে বা না-ও দিতে পারে (input: `number | undefined`),
  কিন্তু সার্ভার সবসময় পায় (output: `number`)। `email`-এর `trim().toLowerCase()`-এর পরে সার্ভার পায় ছোট হাতের।
- `R extends Record<K, infer S extends z.ZodType>` — চুক্তিতে `query` আছে কি না দেখা, আর থাকলে তার schema-টা
  `S`-এ তুলে আনা। শুধু `R['query']` লিখলে ঐচ্ছিক property-র টাইপ হতো `ZodObject | undefined`, আর তার
  input/output বের করা যেত না।
- অংশ না থাকলে `unknown` (সার্ভারে) — `unknown`-এর সাথে intersection কিছুই বদলায় না, তাই শুধু যে অংশগুলো
  আছে সেগুলো থাকে। `Record<never, never>` (মানে `{}`) লিখলে typescript-eslint-এর
  `no-generated-empty-object-type` আপত্তি তোলে — `{}` TypeScript-এ "null ছাড়া যেকোনো কিছু", খালি object না।
- `Partial<z.input<S>> extends z.input<S>` — "এই অংশের সব key কি ঐচ্ছিক?" প্রশ্নের উত্তর। হ্যাঁ হলে পুরো
  অংশটাই ঐচ্ছিক: `call(routes.members.list)` চলে, `{ query: {} }` লিখতে হয় না।
- অংশ না থাকলে ক্লায়েন্টে `?: never` — ক্লায়েন্টের `call()`-এর ভেতরের আকার সব অংশ নিতে পারে (৫.৯), তাই
  এখানে স্পষ্ট করে "এটা পাঠানো যাবে না" না বললে `call(routes.auth.me, { body: … })` চুপচাপ compile হতো।
  ইচ্ছা করে লিখে যাচাই করা: `Type '{ x: number; }' is not assignable to type 'undefined'`।
- `RouteResponse` (z.input) বনাম `RouteResult` (z.output) — handler ফেরত দেয় schema-র input (সার্ভার সেটা
  parse করে পাঠায়), ক্লায়েন্ট parse করে পায় output। response schema-য় transform রাখা নিষেধ (মন্তব্যে),
  তাই বাস্তবে দুটো একই — কিন্তু নামে আলাদা রাখলে কোন পাশের টাইপ কোথায়, সেটা পড়েই বোঝা যায়।
- `buildPath` — এখনকার কোনো route-এ path parameter নেই, কিন্তু ধাপ ৬-এর `/branches/:id` থেকেই লাগবে।
  `encodeURIComponent` না করলে `id`-তে `/` বা `?` থাকলে URL অন্য রুটে চলে যেত।

**ফাইল: `packages/contracts/src/pagination.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';

// keyset pagination-এর query: কয়টা, আর কোথা থেকে। OFFSET নেই — বড় টেবিলে OFFSET ১০,০০০ মানে
// Postgres ১০,০০০ রো পড়ে ফেলে দেয়; cursor দিলে index থেকে সোজা সেই জায়গায় যায় (system-design §৫.৬)
export const pageQuerySchema = z.object({
  // <number>: input টাইপ unknown-এর বদলে number — ক্লায়েন্ট { limit: 50 } লেখে, আর
  // querystring-এর "50" সার্ভারে coerce হয়ে 50
  limit: z.coerce.number<number>().int().min(1).max(100).default(50),
  // ক্লায়েন্টের কাছে অস্বচ্ছ string — ভেতরে কী আছে সেটা শুধু সার্ভার জানে
  cursor: z.string().min(1).max(512).optional(),
});

// প্রতিটা তালিকার উত্তর একই আকারে: items + পরের পাতার cursor (শেষ পাতায় null)।
// মোট সংখ্যা (total) নেই ইচ্ছা করে — COUNT(*) বড় টেবিলে পুরো টেবিল পড়ে
export function pageOf<TItem extends z.ZodType>(item: TItem) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
```

**কোন লাইন কেন:**

- `z.coerce.number<number>()` — querystring-এ সব মান string (`?limit=50` → `"50"`), তাই সার্ভারে coerce
  লাগে। কিন্তু Zod 4-এ coerce-এর input টাইপ ডিফল্টে `unknown`, তখন ক্লায়েন্ট `{ limit: 'abc' }`-ও লিখতে
  পারত। `<number>` generic দিয়ে input টাইপ বেঁধে দেওয়া — Zod 4-এর নিজস্ব সুবিধা।
- `.max(100)` — কেউ `?limit=100000` দিয়ে এক request-এ পুরো টেবিল টানতে পারবে না। বেশি দিলে 400
  `{ limit: ['too_large'] }` (৫.৭-এর টেস্ট)।
- `cursor.max(512)` — cursor ক্লায়েন্টের পাঠানো, তাই সার্ভারে অবিশ্বাস্য। বিশাল string decode করতে দেওয়ার
  কারণ নেই।
- `nextCursor: z.string().nullable()` — `null` মানে "আর পাতা নেই"; TanStack Query-র `getNextPageParam`
  `null` পেলে নিজেই `hasNextPage = false` করে। ঐচ্ছিক (`undefined`) না, কারণ JSON-এ `undefined` হারিয়ে যায়,
  `null` যায় না।
- `pageOf(item)` — প্রতিটা তালিকা (প্রোডাক্ট, ইনভয়েস) একই আকারে; DataTable আর `useInfiniteQuery`-এর কোড
  তাই প্রতিটা নতুন তালিকায় একই।

---

## ৫.৩ — `packages/contracts`: route রেজিস্ট্রি

**ফাইল: `packages/contracts/src/auth.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// workspace-এর ঠিকানা হবে `{slug}.omnivo.app` — তাই DNS label-এর নিয়ম মানতে হবে
const workspaceSlugFormat = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, errorCode('slug_too_short'))
  .max(32, errorCode('slug_too_long'))
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, errorCode('slug_format'));

// আমাদের নিজের সাবডোমেইনের জন্য রাখা নাম — কোনো টেন্যান্ট এগুলো নিতে পারবে না
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'blog',
  'docs',
  'help',
  'mail',
  'omnivo',
  'shop',
  'status',
  'www',
]);

export const newWorkspaceSlugSchema = workspaceSlugFormat.refine(
  (slug) => !RESERVED_SLUGS.has(slug),
  errorCode('slug_reserved'),
);

// trim/lowercase আগে, তারপর email যাচাই — ক্রম উল্টালে " A@b.com" ভুল হিসেবে ধরা পড়ত
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email(errorCode('email_invalid')));

// Better Auth-এর maxPasswordLength ডিফল্ট 128 — দুই জায়গায় একই সীমা
const newPasswordSchema = z
  .string()
  .min(8, errorCode('password_too_short'))
  .max(128, errorCode('password_too_long'));

export const signUpInputSchema = z.object({
  companyName: z.string().trim().min(2, errorCode('company_name_required')).max(120),
  workspaceSlug: newWorkspaceSlugSchema,
  fullName: z.string().trim().min(2, errorCode('full_name_required')).max(120),
  email: emailSchema,
  password: newPasswordSchema,
});
export type SignUpInput = z.infer<typeof signUpInputSchema>;

export const loginInputSchema = z.object({
  workspace: workspaceSlugFormat,
  email: emailSchema,
  password: z.string().min(1, errorCode('password_required')).max(128),
  keepSignedIn: z.boolean(),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const switchTenantInputSchema = z.object({
  tenantId: z.uuid(),
});
export type SwitchTenantInput = z.infer<typeof switchTenantInputSchema>;

// sign-up/login/refresh/switch-tenant সবগুলোর response — refresh token এখানে নেই, সেটা শুধু cookie-তে
export const authSessionSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const meResponseSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), fullName: z.string() }),
  tenant: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  memberships: z.array(z.object({ tenantId: z.uuid(), name: z.string(), slug: z.string() })),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const authRoutes = {
  signUp: defineRoute({
    method: 'POST',
    path: '/auth/sign-up',
    summary: 'Create a workspace and its owner, and start a session',
    auth: 'public',
    status: 201,
    body: signUpInputSchema,
    response: authSessionSchema,
  }),
  login: defineRoute({
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in to a workspace',
    auth: 'public',
    status: 200,
    body: loginInputSchema,
    response: authSessionSchema,
  }),
  // access token-এর মেয়াদ শেষ হতে পারে, তাই public — প্রমাণ শুধু httpOnly refresh cookie
  refresh: defineRoute({
    method: 'POST',
    path: '/auth/refresh',
    summary: 'Rotate the refresh cookie and issue a new access token',
    auth: 'public',
    status: 200,
    response: authSessionSchema,
  }),
  switchTenant: defineRoute({
    method: 'POST',
    path: '/auth/switch-tenant',
    summary: 'Move the session into another workspace the user belongs to',
    auth: 'bearer',
    status: 200,
    body: switchTenantInputSchema,
    response: authSessionSchema,
  }),
  logout: defineRoute({
    method: 'POST',
    path: '/auth/logout',
    summary: 'End the session behind the refresh cookie',
    auth: 'public',
    status: 204,
    response: z.void(),
  }),
  me: defineRoute({
    method: 'GET',
    path: '/auth/me',
    summary: 'The signed-in user, the active workspace and its permissions',
    auth: 'bearer',
    status: 200,
    response: meResponseSchema,
  }),
};
```

**কী বদলাল, আর কেন:**

- প্রতিটা ইংরেজি মেসেজ (`'Use at least 3 letters or numbers.'`) → `errorCode('slug_too_short')`। লেখাটা হুবহু
  `en.ts`-এ চলে গেছে (৫.৫), বাংলাটা `bn.ts`-এ।
- `companyName`-এর `.max(120)`-এ কোনো code নেই ইচ্ছা করে — ফর্মে ১২০ অক্ষর পেরোনো বিরল; সেখানে
  `contractErrorMap`-এর সাধারণ `too_long` যথেষ্ট। প্রতিটা নিয়মে আলাদা code বানালে তালিকা অকারণে বড় হতো।
- `authRoutes` — ধাপ ৩-এর controller-এ যা `@Post('sign-up')`, `@HttpCode(200)`, `@Public()` হিসেবে ছড়ানো
  ছিল, এখন এক জায়গায়। `refresh` আর `logout`-এর body নেই — প্রমাণ httpOnly cookie, যা চুক্তির অংশ না।
- `logout`: `status: 204`, `response: z.void()` — ধাপ ৩-এর `HttpStatus.NO_CONTENT` এর সমান।

**ফাইল: `packages/contracts/src/members.ts`** (নতুন ফাইল — `memberListResponseSchema` এখান থেকে নতুন রূপে)

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

export const memberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
});
export type Member = z.infer<typeof memberSchema>;

// সার্ভার যেভাবে সাজাতে পারে শুধু সেগুলো — "-" মানে উল্টো ক্রম (JSON:API-র প্রচলিত রূপ)
export const MEMBER_SORTS = ['name', '-name'] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

export const memberListQuerySchema = pageQuerySchema.extend({
  sort: z.enum(MEMBER_SORTS).default('name'),
});

export const memberPageSchema = pageOf(memberSchema);
export type MemberPage = z.infer<typeof memberPageSchema>;

export const memberRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/members',
    summary: 'People with access to the active workspace, one page at a time',
    auth: 'bearer',
    status: 200,
    query: memberListQuerySchema,
    response: memberPageSchema,
  }),
};
```

**কোন লাইন কেন:**

- আলাদা ফাইল — `auth.ts`-এ ছিল কারণ ধাপ ৩-এ একটাই মডিউল। এখন প্রতিটা API মডিউলের চুক্তি নিজের ফাইলে
  (ধাপ ৬-এ `branches.ts`, `settings.ts`), Nest-এর মডিউলের সাথে মিলিয়ে।
- `MEMBER_SORTS` — সার্ভার যে কলামে সাজাতে পারে (আর যার জন্য keyset-এর cursor বানাতে জানে) শুধু সেগুলো।
  `?sort=email` দিলে 400, চুপচাপ ডিফল্ট না। `-name` — JSON:API-র প্রচলিত লেখা, এক প্যারামিটারে কলাম আর দিক।
- `pageQuerySchema.extend({...})` — `limit`/`cursor` প্রতিটা তালিকায় একই, শুধু `sort`-এর বিকল্প আলাদা।
- `memberSchema` আলাদা export — app-এর টেবিলের সারির টাইপ (`Member`) সরাসরি এটা থেকে; ধাপ ৪-এর
  `MemberListResponse['members'][number]`-এর মতো ঘুরপথ লাগে না।

**ফাইল: `packages/contracts/src/routes.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';

import { authRoutes } from './auth.js';
import { defineRoute } from './http.js';
import { memberRoutes } from './members.js';

export const healthRoutes = {
  check: defineRoute({
    method: 'GET',
    path: '/health',
    summary: 'Liveness check',
    auth: 'public',
    status: 200,
    response: z.object({ status: z.literal('ok') }),
  }),
};

// API-র প্রতিটা endpoint এখানে। নতুন মডিউল = এখানে এক লাইন; API-র টেস্ট দেখে যে Nest-এর রুট আর
// এই তালিকা হুবহু মেলে, আর OpenAPI স্পেক এই তালিকা থেকেই লেখা হয়
export const routes = {
  health: healthRoutes,
  auth: authRoutes,
  members: memberRoutes,
};
```

- দুই স্তর (`routes.auth.login`) — প্রথম স্তর মডিউল, OpenAPI-তে সেটাই `tag` (Scalar-এ বাঁদিকের গ্রুপ), আর
  `operationId` হয় `auth.login`।
- `/health`-ও চুক্তিতে — `contract.spec.ts` "প্রতিটা রুট চুক্তিতে" নিয়ম কড়া রাখে, ব্যতিক্রম কম।

**ফাইল: `packages/contracts/src/index.ts`** (আপডেট — পুরোটা এভাবে)

```ts
export * from './auth.js';
export * from './errors.js';
export * from './http.js';
export * from './members.js';
export * from './pagination.js';
export * from './routes.js';
```

- `openapi.ts` ইচ্ছা করে এখানে নেই — সেটা আলাদা subpath (নিচে)।

**ফাইল: `packages/contracts/package.json`** (আপডেট — `sideEffects`, `exports`, `scripts`; dependency গুলো
নিচের কমান্ড বসাবে)

```json
{
  "name": "@omnivo/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./openapi": {
      "types": "./dist/openapi.d.ts",
      "default": "./dist/openapi.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts",
    "test": "vitest run --passWithNoTests",
    "gen:openapi": "node scripts/gen-openapi.ts",
    "test:openapi": "node scripts/gen-openapi.ts --check"
  },
  "dependencies": {
    "zod": "^4.6.5"
  }
}
```

```bash
pnpm --filter @omnivo/contracts add -D '@types/node@^26.6.2' '@apidevtools/swagger-parser@^13.1.0'
```

**কোন লাইন কেন:**

- `"sideEffects": false` — contracts এখন app-এর প্রথম লোডে যায় (`call()` রেজিস্ট্রি নেয়)। কোনো module
  import-এর সময় বাইরের কিছু বদলায় না (শুধু Zod schema বানায়), তাই bundler যা ব্যবহার হয়নি তা ফেলে দিতে
  পারে। ui-র মতোই (ধাপ ৪.২)।
- `"./openapi"` আলাদা subpath — OpenAPI builder শুধু API আর স্ক্রিপ্টের কাজে। app কখনো
  `@omnivo/contracts/openapi` import করে না, তাই builder আর `z.toJSONSchema`-র কোড browser bundle-এ যাওয়ার
  কোনো পথই নেই — tree-shaking-এর ভরসায় থাকতে হয় না।
- `typecheck`-এ দ্বিতীয় `tsc -p scripts` — app-এর bundle-size স্ক্রিপ্টের মতো (ধাপ ৪.১০): স্ক্রিপ্ট Node কোড,
  তার tsconfig আলাদা।
- `@types/node` আর `@apidevtools/swagger-parser` শুধু dev — স্ক্রিপ্টের জন্য। swagger-parser জেনারেট করা
  ফাইলটাকে OpenAPI 3.1-এর আসল নিয়ম দিয়ে যাচাই করে (৫.৪)।

**ফাইল: `packages/contracts/tsconfig.json`** (আপডেট — `"types": []` যোগ)

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "types": [],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- **`"types": []` — এটা বাদ দিলে সূক্ষ্ম ফাঁক।** `types` না লিখলে TypeScript `node_modules/@types`-এর সব
  প্যাকেজ নিজে থেকে নেয়। উপরে `@types/node` যোগ হয়েছে (স্ক্রিপ্টের জন্য) — তখন `src/`-এ `process.env` বা
  `Buffer` লিখলেও compile হতো, অথচ এই কোড ব্রাউজারেও চলে। খালি তালিকা মানে `src` শুধু `lib`-এর গ্লোবাল পায়।

### টেস্ট

**ফাইল: `packages/contracts/src/errors.spec.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { signUpInputSchema } from './auth.js';
import { contractErrorMap, ERROR_CODES, isErrorCode } from './errors.js';

// ফিল্ডের নাম → প্রথম issue-এর মেসেজ (যা এখন একটা code)
function codesOf(schema: z.ZodType, value: unknown): Record<string, string | undefined> {
  const result = schema.safeParse(value, { error: contractErrorMap });
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
}

describe('error codes', () => {
  it('turns every sign-up rule into a known code instead of English text', () => {
    const codes = codesOf(signUpInputSchema, {
      companyName: 'R',
      workspaceSlug: 'admin',
      fullName: 'x'.repeat(121),
      email: 'not-an-email',
      password: 'short',
    });
    expect(codes).toEqual({
      companyName: 'company_name_required',
      workspaceSlug: 'slug_reserved',
      // .max(120)-এ নিজস্ব code নেই — contractErrorMap সাধারণ code দেয়
      fullName: 'too_long',
      email: 'email_invalid',
      password: 'password_too_short',
    });
    for (const code of Object.values(codes)) expect(isErrorCode(code)).toBe(true);
  });

  it('reports a missing field as required and a wrong type as invalid', () => {
    const schema = z.object({ qty: z.number() });
    expect(codesOf(schema, {})).toEqual({ qty: 'required' });
    expect(codesOf(schema, { qty: 'ten' })).toEqual({ qty: 'invalid_value' });
  });

  it('has no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});
```

- প্রথম টেস্টটা আসল পাহারা: schema-র কোথাও ইংরেজি মেসেজ রয়ে গেলে (`isErrorCode` false) বা Zod-এর ক্রম
  (schema-র code > error map) কখনো বদলালে এটা fail করে। `fullName`-এর লাইন দেখায় fallback-ও code।

**ফাইল: `packages/contracts/src/http.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { buildPath } from './http.js';
import { memberListQuerySchema } from './members.js';

describe('buildPath', () => {
  it('fills and encodes path parameters', () => {
    expect(buildPath('/branches/:id', { id: 'a/b c' })).toBe('/branches/a%2Fb%20c');
  });

  it('refuses to build a path with a missing parameter', () => {
    expect(() => buildPath('/branches/:id')).toThrow(/Missing path parameter "id"/);
  });
});

describe('page query', () => {
  it('turns querystring text into typed values with defaults', () => {
    expect(memberListQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20, sort: 'name' });
    expect(memberListQuerySchema.parse({})).toEqual({ limit: 50, sort: 'name' });
  });

  it('caps the page size', () => {
    expect(memberListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});
```

- `{ limit: '20' }` — সার্ভার querystring থেকে ঠিক এটাই পায় (string)। coerce না থাকলে এই টেস্ট fail করত।

---

## ৫.৪ — OpenAPI: রেজিস্ট্রি থেকে স্পেক

**ফাইল: `packages/contracts/src/openapi.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';

import { problemSchema } from './errors.js';
import type { RouteDef } from './http.js';

type JsonSchema = z.core.JSONSchema.BaseSchema;

// Zod 4 নিজেই JSON Schema (draft 2020-12) লেখে — OpenAPI 3.1-এর schema হুবহু এটাই।
// io: request-এ 'input' (ক্লায়েন্ট যা পাঠায়, default-ওয়ালা ফিল্ড ঐচ্ছিক), response-এ 'output'।
// unrepresentable: 'any' — refine()-এর মতো যা JSON Schema-য় লেখা যায় না তা বাদ, throw না
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    // output-এ Zod প্রতিটা object-এ additionalProperties: false লেখে। তাহলে response-এ নতুন
    // ফিল্ড যোগ করা (যা আসলে নিরাপদ বদল) কড়া client-এর কাছে "ভাঙা" হয়ে যেত
    override: ({ jsonSchema: node }) => {
      if (io === 'output' && node.additionalProperties === false) delete node.additionalProperties;
    },
  });
  // "$schema" (কোন JSON Schema সংস্করণ) প্রতিটা schema-য় লাগে না — OpenAPI 3.1 নিজেই 2020-12
  delete json.$schema;
  return json;
}

// query-র object schema → OpenAPI-র আলাদা আলাদা parameter (?limit=50&cursor=...)
function parameters(schema: z.ZodObject | undefined, location: 'query' | 'path') {
  if (!schema) return [];
  const object = jsonSchema(schema, 'input');
  const required = new Set(object.required ?? []);
  return Object.entries(object.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    // path parameter সবসময় বাধ্যতামূলক (OpenAPI-র নিয়ম)
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

function operation(tag: string, name: string, route: RouteDef) {
  return {
    operationId: `${tag}.${name}`,
    tags: [tag],
    summary: route.summary,
    // খালি array = লগইন লাগে না; নাহলে global Bearer
    security: route.auth === 'public' ? [] : [{ bearer: [] }],
    parameters: [...parameters(route.params, 'path'), ...parameters(route.query, 'query')],
    ...(route.body && {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: jsonSchema(route.body, 'input') } },
      },
    }),
    responses: {
      [String(route.status)]:
        route.status === 204
          ? { description: 'No content' }
          : {
              description: 'Success',
              content: { 'application/json': { schema: jsonSchema(route.response, 'output') } },
            },
      // প্রতিটা error একই আকারে — তাই প্রতি status আলাদা করে না লিখে একটা default
      default: { $ref: '#/components/responses/Problem' },
    },
  };
}

export interface OpenApiOptions {
  version: string;
  // চলমান API যে ঠিকানায় আছে; commit করা ফাইলে থাকে না, কারণ সেটা পরিবেশ-নির্ভর
  serverUrl?: string;
}

type RouteRegistry = Readonly<Record<string, Readonly<Record<string, RouteDef>>>>;

export function buildOpenApiDocument(registry: RouteRegistry, options: OpenApiOptions) {
  const paths: Record<string, Record<string, ReturnType<typeof operation>>> = {};
  for (const [tag, group] of Object.entries(registry)) {
    for (const [name, route] of Object.entries(group)) {
      // Nest/MSW-এর ":id" → OpenAPI-র "{id}"
      const path = route.path.replace(/:(\w+)/g, '{$1}');
      paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(tag, name, route) };
    }
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Omnivo API', version: options.version },
    ...(options.serverUrl !== undefined && { servers: [{ url: options.serverUrl }] }),
    tags: Object.keys(registry).map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: { Problem: jsonSchema(problemSchema, 'output') },
      responses: {
        Problem: {
          description: 'Error, as RFC 9457 problem details',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      },
    },
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
```

**কোন লাইন কেন:**

- `z.toJSONSchema` — Zod 4-এর নিজের ফাংশন; বাইরের `zod-to-json-schema` আর লাগে না। OpenAPI 3.1 JSON Schema
  2020-12-কে হুবহু নেয় (3.0 নিত না — সেখানে `nullable`-এর মতো নিজস্ব শব্দ), তাই কোনো রূপান্তর নেই।
- `io: 'input'` request-এ — ক্লায়েন্ট কী পাঠাতে পারে সেটাই বলার কথা: `limit`-এর default আছে বলে input-এ
  ঐচ্ছিক (`required: false`, `default: 50`)। `'output'` দিলে `limit` বাধ্যতামূলক দেখাত।
- `unrepresentable: 'any'` — `newWorkspaceSlugSchema`-র `refine()` (reserved নাম) JSON Schema-য় লেখা যায় না।
  ডিফল্টে Zod throw করে; `'any'` মানে সেই অংশ বাদ, বাকিটা (min, max, pattern) থাকে।
- `override`-এ `additionalProperties` মোছা — output-এ Zod `z.object()`-কে "এর বাইরে কোনো key নেই" হিসেবে
  লেখে। তখন আমরা response-এ একটা নতুন ফিল্ড যোগ করলে (যা API-র জগতে নিরাপদ বদল) কড়া validator-ওয়ালা
  বাইরের client ভাঙত। request-এ (`input`) Zod এটা লেখেই না, কারণ অচেনা key সেখানে শুধু ছাঁটা হয়।
- `delete json.$schema` — Zod প্রতিটা schema-র মাথায় `"$schema": "https://json-schema.org/draft/2020-12/schema"`
  লেখে; ডকুমেন্টের ভেতরে ৩০ বার একই লাইন অকারণ।
- `parameters()` — OpenAPI-তে query একটা object না, প্রতিটা key আলাদা parameter। object-এর JSON Schema থেকে
  `properties` আর `required` পড়ে ভাগ করা।
- `security: []` — OpenAPI-তে খালি array মানে "এই operation-এ কোনো auth লাগে না"; বাদ দিলে ডকুমেন্টের
  global নিয়ম খাটত।
- `default: { $ref: ... }` — প্রতিটা operation-এ ৪০০/৪০১/৪০৩/৪০৪/৪০৯ আলাদা লিখলে প্রতিটায় একই schema;
  RFC 9457 সবার জন্য একটাই আকার।
- `...(route.body && {...})` — body না থাকলে `requestBody` key-টাই থাকে না (`undefined` মান রাখলে
  `exactOptionalPropertyTypes`-এ টাইপ ঝামেলা আর JSON-এ অকারণ ফাঁক)।
- `serverUrl` ঐচ্ছিক — commit করা ফাইলে থাকে না (localhost না production?), চলমান API-র `/openapi.json`-এ
  থাকে (৫.৬-এর docs controller)।
- `OpenApiDocument` টাইপ export — API-র controller-এ return টাইপ লিখতে লাগে (৫.৬-এ কারণ)।
- `RouteRegistry` চওড়া টাইপ — `routes` object-এর প্রতিটা route আলাদা literal টাইপ; builder-এর সেগুলো
  জানার দরকার নেই, শুধু `RouteDef` হলেই চলে।

**ফাইল: `packages/contracts/scripts/gen-openapi.ts`** (নতুন ফাইল)

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import SwaggerParser from '@apidevtools/swagger-parser';
import { routes } from '@omnivo/contracts';
import { buildOpenApiDocument } from '@omnivo/contracts/openapi';

// routes রেজিস্ট্রি → openapi.json (commit করা হয়)। PR-এ API-র চুক্তির বদল এই ফাইলের diff-এ
// চোখে পড়ে। --check (CI): ফাইল পুরনো হলে fail, লেখে না
const file = path.resolve(import.meta.dirname, '../openapi.json');
const json = `${JSON.stringify(buildOpenApiDocument(routes, { version: '0.0.0' }), null, 2)}\n`;
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // ফাইল নেই = পুরনো, নিচে fail
  }
  if (current !== json) {
    console.error('openapi.json is out of date. Run `pnpm gen:openapi` and commit the result.');
    process.exit(1);
  }
} else {
  writeFileSync(file, json);
}

// আমাদের builder ভুল কিছু লিখলে (বাধ্যতামূলক ফিল্ড বাদ, ভুল $ref) এখানেই ধরা পড়ে —
// Swagger UI বা কোনো বাইরের client-generator ব্যবহারের দিনে না
await SwaggerParser.validate(file);
console.log(
  `${path.relative(process.cwd(), file)} is ${check ? 'up to date' : 'written'} and valid.`,
);
```

**কোন লাইন কেন:**

- `import { routes } from '@omnivo/contracts'` — প্যাকেজ নিজেকেই নাম ধরে import করছে (Node-এর "self-reference",
  `package.json`-এর `name` + `exports` থাকলে চলে)। এতে স্ক্রিপ্ট **build করা `dist`** পড়ে। কেন `../src/...`
  না: Node সরাসরি `.ts` চালায় (type stripping), কিন্তু `src`-এর ভেতরের `import './auth.js'`-কে `.ts`-এ বদলায়
  না — ফাইল খুঁজে পেত না। তাই turbo-তে এই task-এর আগে `build` (৫.১১)।
- `JSON.stringify(..., null, 2)` + শেষে `\n` — প্রতিবার হুবহু একই লেখা, তাই `--check` string মিলিয়ে দেখতে
  পারে, আর git diff-এ শুধু আসল বদল।
- `--check` মোডে লেখে না — CI-তে ফাইল বদলে দিয়ে সবুজ দেখানো অর্থহীন; উদ্দেশ্য হলো "PR-এ চুক্তি বদলেছে কিন্তু
  স্পেক আপডেট হয়নি" ধরা।
- `SwaggerParser.validate(file)` — OpenAPI 3.1-এর আনুষ্ঠানিক schema দিয়ে যাচাই, আর সব `$ref` খুঁজে পাওয়া যায়
  কি না। path (string) দেওয়া হয়েছে, object না — তার টাইপ (`openapi-types`) আমাদের object-এর সাথে হুবহু
  মেলে না, আর মেলাতে cast লাগত।
- top-level `await` — `"type": "module"` প্যাকেজে Node সরাসরি চালায়।

**ফাইল: `packages/contracts/scripts/tsconfig.json`** (নতুন ফাইল — app-এর `scripts/tsconfig.json`-এর হুবহু)

```json
{
  "extends": "../../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "lib": ["ES2023"],
    "types": ["node"],
    "noEmit": true,
    "erasableSyntaxOnly": true
  },
  "include": ["*.ts"]
}
```

- ধাপ ৪.১০-এর একই কারণ: Node কোড আলাদা tsconfig-এ, `erasableSyntaxOnly` যাতে type stripping-এ না ভাঙে, আর
  নাম `tsconfig.json` যাতে ESLint-এর `projectService` খুঁজে পায়।

**ফাইল: `packages/contracts/src/openapi.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi.js';
import { routes } from './routes.js';

const document = buildOpenApiDocument(routes, { version: '0.0.0' });

describe('OpenAPI document', () => {
  it('has one operation per route, named after its place in the registry', () => {
    const ids = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    const expected = Object.entries(routes).flatMap(([tag, group]) =>
      Object.keys(group).map((name) => `${tag}.${name}`),
    );
    expect(ids.sort()).toEqual(expected.sort());
  });

  it('describes query parameters one by one, with their defaults', () => {
    const list = document.paths['/members']?.get;
    expect(list?.parameters.map((parameter) => parameter.name)).toEqual([
      'limit',
      'cursor',
      'sort',
    ]);
    expect(list?.parameters.every((parameter) => !parameter.required)).toBe(true);
    expect(list?.security).toEqual([{ bearer: [] }]);
  });

  it('marks public routes as needing no token and documents 204 without a body', () => {
    const logout = document.paths['/auth/logout']?.post;
    expect(logout?.security).toEqual([]);
    expect(logout?.responses['204']).toEqual({ description: 'No content' });
  });

  it('has no environment-specific server unless asked for one', () => {
    expect('servers' in document).toBe(false);
    expect(buildOpenApiDocument(routes, { version: '1', serverUrl: 'http://x' }).servers).toEqual([
      { url: 'http://x' },
    ]);
  });
});
```

- প্রথম টেস্ট: একই method + path দুটো route-এ দিলে (একটা আরেকটাকে চাপা দিত) operation সংখ্যা কমে যায় — fail।

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test        # ১৪টা পাস
pnpm --filter @omnivo/contracts gen:openapi # packages/contracts/openapi.json লেখে — commit করুন
```

---

## ৫.৫ — `packages/i18n`: error-এর লেখা আর লগইন/সাইনআপ

```bash
pnpm --filter @omnivo/i18n add -D '@omnivo/contracts@workspace:*'
```

- dev dependency, কারণ i18n contracts থেকে শুধু **টাইপ** নেয় (`import type { ErrorCode }`)। runtime-এ কিছু
  import হয় না। তবু workspace dependency হিসেবে লিখতে হয়: turbo-র `^build` তখন i18n-এর আগে contracts build
  করে, নাহলে `dist/index.d.ts` না থাকায় typecheck ভাঙত।

**ফাইল: `packages/i18n/src/locales/en.ts`** (আপডেট — ফাইলের মাথায় import, `nav`-এর পরে নতুন `auth`,
`dashboard`-এ `loadingMore`, আর `ui`-র আগে নতুন `errors`)

```ts
import type { ErrorCode } from '@omnivo/contracts';

// ইংরেজি = উৎস ভাষা। Messages টাইপ এখান থেকে আসে, তাই নতুন key প্রথমে এখানে যোগ হবে
export const en = {
  // common, shell, nav — আগের মতোই
  auth: {
    workspace: 'Workspace',
    email: 'Email',
    password: 'Password',
    login: {
      title: 'Sign in',
      subtitle: 'Welcome back. Enter your details to continue.',
      passwordPlaceholder: 'Enter your password',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      keepSignedIn: 'Keep me signed in on this device',
      submit: 'Sign in',
      submitting: 'Signing in…',
      newHere: 'New to Omnivo?',
      createWorkspace: 'Create a workspace',
      panelLabel: 'What Omnivo does',
      panelTitle: 'Production, stock and accounts. One system.',
      panelBody:
        'From buyer orders to payroll, every department works from the same numbers, even when the internet is down.',
      industries: {
        garments: 'Garments & textiles',
        pharma: 'Pharmaceuticals',
        distribution: 'Distribution',
        manufacturing: 'Manufacturing',
      },
    },
    signUp: {
      haveWorkspace: 'Already have a workspace?',
      signIn: 'Sign in',
      title: 'Create your workspace',
      subtitle:
        "You'll be the workspace owner. You can invite your accountants, managers and store staff after setup.",
      companyName: 'Company name',
      workspaceAddress: 'Workspace address',
      fullName: 'Full name',
      workEmail: 'Work email',
      passwordPlaceholder: 'At least 8 characters',
      submit: 'Create workspace',
      submitting: 'Creating workspace…',
    },
  },
  dashboard: {
    // আগের সব key একই, শুধু teamLoadFailed-এর পরে:
    loadingMore: 'Loading more…',
  },
  // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
  // পর্যন্ত compile error, আর তালিকায় নেই এমন key লিখলেও error
  errors: {
    invalid_input: 'Check the highlighted fields and try again.',
    required: 'Fill in this field.',
    too_short: 'This is too short.',
    too_long: 'This is too long. Shorten it and try again.',
    too_small: 'Enter a larger number.',
    too_large: 'Enter a smaller number.',
    invalid_format: 'Check the format and try again.',
    invalid_value: 'Enter a valid value.',
    company_name_required: 'Enter your company name.',
    full_name_required: 'Enter your full name.',
    email_invalid: 'Enter an email like name@company.com.',
    email_taken: 'An account with this email already exists. Sign in instead.',
    password_required: 'Enter your password.',
    password_too_short: 'Use at least 8 characters.',
    password_too_long: 'Use 128 characters or fewer.',
    slug_too_short: 'Use at least 3 letters or numbers.',
    slug_too_long: 'Use 32 characters or fewer.',
    slug_format: 'Use lowercase letters, numbers and single hyphens, like rahman-garments.',
    slug_reserved: 'This address is reserved. Try adding your city, like rahman-gazipur.',
    slug_taken: 'This address is taken. Try adding your city, like rahman-gazipur.',
    workspace_not_found: "We couldn't find this workspace. Check the address.",
    invalid_credentials: 'Email or password is incorrect. Check them and try again.',
    not_a_member:
      "This account isn't a member of this workspace. Ask a workspace owner to invite you.",
    sign_in_required: 'Sign in to continue.',
    session_ended: 'Your session has ended. Sign in again.',
    access_revoked: 'You no longer have access to this workspace. Sign in again.',
    switch_denied: "You aren't a member of that workspace.",
    permission_missing:
      'You need the {{permissions}} permission. Ask a workspace owner to grant it.',
    invalid_cursor: 'This list has changed. Reload the page and try again.',
    malformed_request: "The server couldn't read this request. Reload the page and try again.",
    not_found: "We couldn't find what you were looking for.",
    request_failed: "The server couldn't complete this request. Try again.",
    internal_error: 'Something went wrong on our side. Try again in a moment.',
    network_error: 'Could not reach the server. Check your connection and try again.',
    unexpected_response:
      "The server sent a reply this version of the app can't read. Reload the page.",
    unknown_error: 'Something went wrong. Try again in a moment.',
  } satisfies Record<ErrorCode, string>,
  // ui — আগের মতোই
};
```

(উপরে `// … আগের মতোই` লেখা অংশগুলো ফাইলে যেমন আছে তেমন থাকবে — শুধু নতুন অংশ দেখানো।)

**কোন লাইন কেন:**

- `satisfies Record<ErrorCode, string>` — দুই দিকের পাহারা: `ERROR_CODES`-এর কোনো code বাদ পড়লে "Property
  'slug_taken' is missing", আর তালিকায় নেই এমন key (বানান ভুল) লিখলে object literal-এর excess property error।
  `satisfies`, টাইপ annotation (`: Record<…>`) না — annotation দিলে `en`-এর টাইপ চওড়া হয়ে যেত আর বাকি
  ফাইলের literal key-র তথ্য (`Messages` টাইপ, `t()`-এর autocomplete) হারাত।
- লেখাগুলো ধাপ ৩-এর সার্ভার/Zod মেসেজের হুবহু, দুটো বদল সহ: `slug_taken` আর `workspace_not_found` আগে
  ঠিকানাটা বাক্যে বসাত (`rahman-garments.omnivo.app is taken`) — এখন বসায় না, কারণ ফর্মে ঠিকানাটা ঠিক উপরেই
  লেখা, আর params ছাড়া ফর্মের error সহজ থাকে (৫.৯-এর `applyApiError`)।
- CLAUDE.md → Copy: error বলে কী করতে হবে, ক্ষমা চায় না — "Something went wrong on our side. Try again in a
  moment." (কী হয়েছে + কী করবেন)।
- `auth.workspace`/`email`/`password` এক স্তর উপরে — লগইন আর সাইনআপ দুজনেই নেয়।
- placeholder-এর উদাহরণ ডেটা (`rahman-garments`, `name@company.com`, `Rahman Garments Ltd.`) এখানে নেই — দুই
  ভাষায় একই, আর ঠিকানা/ইমেইল সবসময় ইংরেজি অক্ষরে। পেজের কোডে মন্তব্যে সেটা লেখা (৫.৯)।

**ফাইল: `packages/i18n/src/locales/bn.ts`** (আপডেট — `en.ts`-এর একই জায়গায় একই key)

```ts
  auth: {
    workspace: 'ওয়ার্কস্পেস',
    email: 'ইমেইল',
    password: 'পাসওয়ার্ড',
    login: {
      title: 'সাইন ইন',
      subtitle: 'আবার স্বাগতম। চালিয়ে যেতে আপনার তথ্য দিন।',
      passwordPlaceholder: 'পাসওয়ার্ড লিখুন',
      showPassword: 'পাসওয়ার্ড দেখান',
      hidePassword: 'পাসওয়ার্ড লুকান',
      keepSignedIn: 'এই ডিভাইসে সাইন ইন করে রাখুন',
      submit: 'সাইন ইন',
      submitting: 'সাইন ইন হচ্ছে…',
      newHere: 'Omnivo-তে নতুন?',
      createWorkspace: 'ওয়ার্কস্পেস তৈরি করুন',
      panelLabel: 'Omnivo কী করে',
      panelTitle: 'উৎপাদন, স্টক আর হিসাব। এক সিস্টেমে।',
      panelBody:
        'বায়ারের অর্ডার থেকে বেতন পর্যন্ত, প্রতিটা বিভাগ একই হিসাব থেকে কাজ করে — ইন্টারনেট না থাকলেও।',
      industries: {
        garments: 'গার্মেন্টস ও টেক্সটাইল',
        pharma: 'ফার্মাসিউটিক্যালস',
        distribution: 'ডিস্ট্রিবিউশন',
        manufacturing: 'ম্যানুফ্যাকচারিং',
      },
    },
    signUp: {
      haveWorkspace: 'আগে থেকেই ওয়ার্কস্পেস আছে?',
      signIn: 'সাইন ইন করুন',
      title: 'আপনার ওয়ার্কস্পেস তৈরি করুন',
      subtitle:
        'আপনি হবেন ওয়ার্কস্পেসের মালিক। সেটআপের পরে হিসাবরক্ষক, ম্যানেজার আর স্টোরের কর্মীদের আমন্ত্রণ জানাতে পারবেন।',
      companyName: 'কোম্পানির নাম',
      workspaceAddress: 'ওয়ার্কস্পেসের ঠিকানা',
      fullName: 'পুরো নাম',
      workEmail: 'অফিসের ইমেইল',
      passwordPlaceholder: 'অন্তত ৮ অক্ষর',
      submit: 'ওয়ার্কস্পেস তৈরি করুন',
      submitting: 'ওয়ার্কস্পেস তৈরি হচ্ছে…',
    },
  },
  dashboard: {
    // teamLoadFailed-এর পরে:
    loadingMore: 'আরও আনা হচ্ছে…',
  },
  errors: {
    invalid_input: 'চিহ্নিত ঘরগুলো ঠিক করে আবার চেষ্টা করুন।',
    required: 'এই ঘরটা পূরণ করুন।',
    too_short: 'লেখাটা খুব ছোট।',
    too_long: 'লেখাটা খুব বড়। ছোট করে আবার চেষ্টা করুন।',
    too_small: 'আরও বড় সংখ্যা দিন।',
    too_large: 'আরও ছোট সংখ্যা দিন।',
    invalid_format: 'ফরম্যাটটা দেখে আবার চেষ্টা করুন।',
    invalid_value: 'সঠিক মান দিন।',
    company_name_required: 'কোম্পানির নাম লিখুন।',
    full_name_required: 'আপনার পুরো নাম লিখুন।',
    email_invalid: 'name@company.com-এর মতো একটা ইমেইল দিন।',
    email_taken: 'এই ইমেইলে আগে থেকেই অ্যাকাউন্ট আছে। সাইন ইন করুন।',
    password_required: 'পাসওয়ার্ড লিখুন।',
    password_too_short: 'অন্তত ৮ অক্ষরের পাসওয়ার্ড দিন।',
    password_too_long: '১২৮ অক্ষরের মধ্যে রাখুন।',
    slug_too_short: 'অন্তত ৩টা অক্ষর বা সংখ্যা দিন।',
    slug_too_long: '৩২ অক্ষরের মধ্যে রাখুন।',
    slug_format: 'ছোট হাতের ইংরেজি অক্ষর, সংখ্যা আর একটা করে হাইফেন দিন, যেমন rahman-garments।',
    slug_reserved: 'এই ঠিকানাটা সংরক্ষিত। শহরের নাম যোগ করে দেখুন, যেমন rahman-gazipur।',
    slug_taken: 'এই ঠিকানাটা আগেই নেওয়া হয়েছে। শহরের নাম যোগ করে দেখুন, যেমন rahman-gazipur।',
    workspace_not_found: 'এই ওয়ার্কস্পেস খুঁজে পাওয়া যায়নি। ঠিকানাটা আবার দেখুন।',
    invalid_credentials: 'ইমেইল বা পাসওয়ার্ড ভুল। দেখে আবার চেষ্টা করুন।',
    not_a_member:
      'এই অ্যাকাউন্ট এই ওয়ার্কস্পেসের সদস্য নয়। ওয়ার্কস্পেস মালিককে আমন্ত্রণ পাঠাতে বলুন।',
    sign_in_required: 'চালিয়ে যেতে সাইন ইন করুন।',
    session_ended: 'আপনার সেশন শেষ হয়েছে। আবার সাইন ইন করুন।',
    access_revoked: 'এই ওয়ার্কস্পেসে আপনার অ্যাক্সেস আর নেই। আবার সাইন ইন করুন।',
    switch_denied: 'আপনি ওই ওয়ার্কস্পেসের সদস্য নন।',
    permission_missing: 'এর জন্য {{permissions}} অনুমতি লাগবে। ওয়ার্কস্পেস মালিকের কাছে চান।',
    invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
    malformed_request: 'সার্ভার অনুরোধটা পড়তে পারেনি। পেজটা রিলোড করে আবার চেষ্টা করুন।',
    not_found: 'যা খুঁজছেন তা পাওয়া যায়নি।',
    request_failed: 'সার্ভার কাজটা শেষ করতে পারেনি। আবার চেষ্টা করুন।',
    internal_error: 'আমাদের দিকে একটা সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।',
    network_error: 'সার্ভারে পৌঁছানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    unexpected_response: 'সার্ভারের উত্তর অ্যাপের এই সংস্করণ পড়তে পারেনি। পেজটা রিলোড করুন।',
    unknown_error: 'কিছু একটা সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।',
  },
```

- `bn: Messages` আগে থেকেই আছে — `en`-এ `errors` যোগ হলে এখানে না লেখা পর্যন্ত compile error। `satisfies`
  এখানে লাগে না।
- `ওয়ার্কস্পেস`, `সাইন ইন`, `সেশন` — ধাপ ৪-এর `bn.ts`-এর রীতি: অফিসে যে ইংরেজি শব্দ চলে সেটা বাংলা হরফে
  (CLAUDE.md → Language)। `slug_format`-এ "ইংরেজি অক্ষর" স্পষ্ট করে বলা — বাংলা কীবোর্ডে থাকা ব্যবহারকারী
  নইলে বাংলায় ঠিকানা লিখতে চাইতেন।
- `'এই অ্যাকাউন্ট এই ওয়ার্কস্পেসের সদস্য নয়'` — "নয়" (লিখিত রূপ), "না" না — বাকি error-এর মতো আনুষ্ঠানিক সুর।

**ফাইল: `packages/i18n/src/use-locale.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatDate,
  formatMoney,
  formatMonth,
  formatNumber,
  type MoneyFormatOptions,
} from './format.js';
import { isLanguage, type Language } from './i18n.js';
import { en } from './locales/en.js';

type ErrorKey = keyof typeof en.errors;

// en.errors-এর key আর contracts-এর ErrorCode একই তালিকা (en.ts-এর satisfies সেটা নিশ্চিত করে),
// তাই runtime-এ contracts import না করেই চেনা যায় কোনটা error code
function isErrorKey(value: string): value is ErrorKey {
  return Object.hasOwn(en.errors, value);
}

// component-এ ভাষা + ভাষা-অনুযায়ী formatter একসাথে। useTranslation ভাষা বদলের event-এ
// subscribe করে, তাই ভাষা বদলালে এই hook-ওয়ালা সব component নিজে থেকেই আবার render হয়
export function useLocale() {
  const { t, i18n } = useTranslation();
  const language: Language = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en';

  // language না বদলালে একই object — এটা dependency হিসেবে দিলে অকারণে effect চলে না
  const format = useMemo(
    () => ({
      money: (value: number | string, options?: MoneyFormatOptions) =>
        formatMoney(value, language, options),
      number: (value: number | string, decimals?: number) =>
        formatNumber(value, language, decimals),
      date: (date: Date) => formatDate(date, language),
      month: (date: Date) => formatMonth(date, language),
    }),
    [language],
  );

  // ফর্মের error-এ থাকে একটা code ('slug_taken') — সেটা বর্তমান ভাষায়। code না হলে (যেমন
  // kitchen sink-এর নিজের ইংরেজি মেসেজ) যেমন আছে তেমন, যাতে পুরনো ফর্ম না ভাঙে
  const errorText = useCallback(
    (message: string, params?: Record<string, string | number>): string =>
      isErrorKey(message) ? t(`errors.${message}`, { ...params }) : message,
    [t],
  );

  return { t, language, format, errorText };
}
```

**কোন লাইন কেন:**

- `errorText` এখানে, ui বা app-এ না — ui-র `Field` আর `FormAlert` দুজনেই এটা নেয় (৫.৮), আর ui-র নিয়ম
  "i18n থেকে নেয়, contracts চেনে না" ঠিক থাকে। app-এও যেকোনো জায়গায় একই hook।
- `isErrorKey` — `en.errors`-এর key দেখে; contracts-এর `isErrorCode` runtime-এ import করতে হয় না (i18n-এর
  contracts dependency শুধু টাইপের, ভিত্তি উপরে)। দুই তালিকা যে এক, সেটা `satisfies` নিশ্চিত করে।
- `Object.hasOwn`, `in` না — `'toString' in en.errors` true দিত (prototype থেকে), তখন `t('errors.toString')`।
- `` t(`errors.${message}`) `` — `message` narrow হয়ে `ErrorKey` union, তাই template-টাও বৈধ key-এর union; i18next-এর
  টাইপ-চেকড `t()` সেটা নেয় (যাচাই করা: বানান-ভুল key এখনো compile error)।
- code না হলে যেমন আছে তেমন — kitchen sink-এর ফর্মের Zod schema ইংরেজি মেসেজ দেয় (`'Enter the LC
  number.'`)। সব ফর্ম একসাথে code-এ যাওয়ার দরকার নেই; পুরনোগুলো যেমন ছিল তেমন দেখায়।
- `{ ...params }` — `params` না দিলে `undefined` না পাঠিয়ে খালি object; i18next-এর option টাইপ
  `exactOptionalPropertyTypes`-এ `undefined` নেয় না।
- `useCallback(..., [t])` — `t` শুধু ভাষা বদলালে নতুন হয়; `errorText` কোনো `useMemo`-র dependency হলে অকারণে
  আবার হিসাব হয় না।

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n test     # ৯টা পাস (বদল নেই)
```

---

## ৫.৬ — API: problem, `@Endpoint`, চুক্তি-যাচাই

### Error: `AppError` আর `ProblemFilter`

**ফাইল: `apps/api/src/common/http/app-error.ts`** (নতুন ফাইল)

```ts
import type { ErrorCode } from '@omnivo/contracts';

// যে status গুলো আমরা ইচ্ছা করে পাঠাই — 500 এখানে নেই, সেটা শুধু অপ্রত্যাশিত error থেকে আসে
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

export interface AppErrorOptions {
  // অনুবাদের ভেতরে বসানোর মান: "You need the {{permissions}} permission"
  params?: Record<string, string | number>;
  // ফিল্ডের পাথ → code; ক্লায়েন্ট সেই ফিল্ডের নিচে দেখায়
  fieldErrors?: Record<string, ErrorCode[]>;
}

// ব্যবসার নিয়মে ভাঙা যেকোনো অনুরোধ: status + code। detail ইংরেজি, লগ আর API-র বাইরের
// ব্যবহারকারীর জন্য; UI code দেখে নিজের ভাষায় লেখে (ProblemFilter এটাকে RFC 9457-এ বদলায়)
export class AppError extends Error {
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  readonly options: AppErrorOptions;

  constructor(status: ErrorStatus, code: ErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(detail);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.options = options;
  }
}
```

**কোন লাইন কেন:**

- Nest-এর `HttpException` না বাড়িয়ে নিজের class — `HttpException`-এর body যেকোনো আকারের object নিত (ধাপ ৩-এ
  তাই `{ statusCode, message, fieldErrors }` হাতে লেখা হতো, প্রতিবার)। এখানে টাইপই বাধ্য করে: code ছাড়া
  error ছোড়া যায় না, আর code তালিকার বাইরে হতে পারে না।
- `ErrorStatus` union — `new AppError(500, ...)` compile error। 500 মানে "আমাদের bug", সেটা কেউ ইচ্ছা করে
  ছোড়ে না; ফিল্টার অচেনা error-কে নিজেই 500 বানায়।
- `super(detail)` — `error.message` = ইংরেজি detail, তাই লগ আর stack trace-এ পড়া যায়।
- `fieldErrors: Record<string, ErrorCode[]>` — সার্ভারও কেবল তালিকার code বসাতে পারে।

**ফাইল: `apps/api/src/common/http/problem.ts`** (নতুন ফাইল)

```ts
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
```

**কোন লাইন কেন:**

- ফিল্টার থেকে আলাদা ফাইল — শুধু ফাংশন, Nest ছাড়াই টেস্ট করা যায়, আর পরে worker-এ (ধাপ ৮) job-এর error
  লগ করতেও একই রূপান্তর।
- `STATUS_CODES[status]` — Node-এর নিজের তালিকা (`404` → `'Not Found'`)। RFC 9457: `type` না থাকলে `title`
  হবে HTTP status-এর বর্ণনা।
- `HttpException` শাখা — আমাদের কোড আর `HttpException` ছোড়ে না, কিন্তু Nest নিজে ছোড়ে: অচেনা রুটে
  `NotFoundException("Cannot GET /x")`। সেটাকেও একই আকারে আনা।
- Fastify-র শাখা — ভাঙা JSON body (`{"workspace":`) Fastify-র content-type parser-এই আটকায়, Nest-এর handler
  পর্যন্ত যায় না। যাচাই করা: সেই error-ও Nest-এর ফিল্টারে পৌঁছায়, কিন্তু `HttpException` হিসেবে না — একটা
  সাধারণ `Error` যার `statusCode: 400`। এই শাখা না থাকলে ভাঙা JSON হতো 500 `internal_error`, আর 5xx-এর লগে
  অকারণ stack। `'statusCode' in error && typeof … === 'number'` — cast ছাড়া narrow করা।
- শেষ লাইন — অচেনা error-এর `message` কখনো response-এ না। Postgres-এর error-এ table/কলামের নাম, ফাইলের পাথ
  থাকতে পারে; বাইরে যায় শুধু সাধারণ বাক্য, আসলটা লগে।

**ফাইল: `apps/api/src/common/http/problem.filter.ts`** (নতুন ফাইল)

```ts
import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { toProblem } from './problem.js';

// @Catch() খালি = সব কিছু ধরে: AppError, Nest-এর HttpException, আর অপ্রত্যাশিত bug।
// প্রতিটা error response একই আকারে (RFC 9457), তাই ক্লায়েন্টের একটাই parser
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const body = toProblem(error, request.id);

    // 4xx = ক্লায়েন্টের ভুল, স্বাভাবিক; 5xx = আমাদের bug — পুরো stack লগে, requestId দিয়ে খোঁজা যায়
    if (body.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed [${body.requestId ?? '-'}]`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    void reply.status(body.status).type('application/problem+json').send(body);
  }
}
```

**কোন লাইন কেন:**

- `@Catch()` কোনো class ছাড়া — Nest-এর ভাষায় "সব exception"। একটা নির্দিষ্ট class দিলে (`@Catch(AppError)`)
  বাকিগুলো Nest-এর নিজের `{ statusCode, message }` আকারে যেত — দুই আকার, ক্লায়েন্টে দুই parser।
- `request.id` — Fastify প্রতিটা request-এ id দেয় (UUID, ৫.৬-এর `createAdapter`)। response header-এর
  `x-request-id` আর লগের লাইন একই id — "সাপোর্টে স্ক্রিনশট পাঠালাম" থেকে সোজা লগের সেই লাইনে।
- শুধু 5xx লগ — ভুল পাসওয়ার্ড (401) প্রতিদিন হাজারবার হয়; সেগুলো লগ করলে আসল bug হারিয়ে যেত।
- `.type('application/problem+json')` — RFC 9457-এর media type; ব্রাউজারের DevTools আর gateway দেখেই চেনে এটা
  error-বর্ণনা। ক্লায়েন্টের `response.json()` তবু চলে।
- `void reply...send()` — Fastify-র `send` একটা thenable ফেরত দেয়; `void` না লিখলে typescript-eslint-এর
  `no-floating-promises`।

### প্রতিটা response-এ request id

**ফাইল: `apps/api/src/configure-app.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import type { Config } from './config.js';

// প্রতিটা request-এর আলাদা id (UUID) — error response-এর requestId আর লগের লাইন এটা দিয়েই মেলে।
// Fastify-র ডিফল্ট "req-1, req-2" প্রতিটা process-এ আবার ১ থেকে শুরু হয়, একাধিক pod-এ মেলে না।
// ক্লায়েন্টের পাঠানো x-request-id নেওয়া হয় না (Fastify 5-এর ডিফল্ট) — বাইরের মান বিশ্বাস করা হয় না
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({ genReqId: () => randomUUID() });
}

// main.ts আর integration test দুজনেই এটা ডাকে — টেস্টে ঠিক production-এর setup চলে
export async function configureApp(app: NestFastifyApplication, config: Config): Promise<void> {
  await app.register(fastifyCookie);
  app.enableCors({
    origin: config.appOrigin,
    // cross-origin fetch-এ cookie পাঠাতে/নিতে দুই দিকেই credentials লাগে
    credentials: true,
    // CORS-এ ব্রাউজার JS শুধু গোনা কয়েকটা header দেখে; এটা না দিলে app requestId পড়তে পারত না
    exposedHeaders: ['x-request-id'],
  });
  // সফল হোক বা ব্যর্থ, প্রতিটা response-এ id — সাপোর্টে "কোন request?" প্রশ্নের উত্তর
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header('x-request-id', request.id);
      done();
    });
}
```

**কোন লাইন কেন:**

- `createAdapter()` আলাদা ফাংশন — adapter-এর option (`genReqId`) constructor-এ দিতে হয়, `configureApp`-এ দেরি
  হয়ে যায়। main.ts, টেস্টের app আর `contract.spec.ts` তিনজনই এটা ডাকে, তাই id সব জায়গায় একই রকম।
- `randomUUID()` — Node-এর নিজের, dependency ছাড়া। ধাপ ২৫-এর observability-তে (Loki) এই id দিয়ে সব লাইন
  খোঁজা হবে (system-design §১২.৫: প্রতি লাইনে `request_id`)।
- ক্লায়েন্টের `x-request-id` নেওয়া হয় না — কেউ সব request-এ একই id পাঠিয়ে লগ গুলিয়ে দিতে পারত। Cloudflare-এর
  পেছনে গেলে (ধাপ ২৫) তার `cf-ray` নেওয়ার কথা ভাবা যায়।
- `exposedHeaders` — CORS-এ অন্য origin-এর JS response-এর মাত্র কয়েকটা "safe" header পড়তে পারে; বাকিগুলো
  স্পষ্ট করে খুলে দিতে হয়।
- `onRequest` hook-এ header বসানো, response পাঠানোর সময় না — error হোক বা সফল, header আগেই বসে আছে।
  callback-ধরনের hook (`done`) — `async` দিলে ভেতরে `await` নেই বলে ESLint-এর `require-await` আপত্তি করত।

**ফাইল: `apps/api/src/main.ts`** (আপডেট — দুই লাইন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
// ...
import { configureApp, createAdapter } from './configure-app.js';
// ...
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    createAdapter(),
  );
```

**ফাইল: `apps/api/src/testing/app.ts`** (আপডেট — একই দুই বদল: `FastifyAdapter`-এর import সরিয়ে
`import type { NestFastifyApplication }`, `configureApp`-এর সাথে `createAdapter` import, আর
`new FastifyAdapter()` → `createAdapter()`)

### `@Endpoint()`: চুক্তি থেকে রুট

**ফাইল: `apps/api/src/common/http/endpoint.ts`** (নতুন ফাইল)

```ts
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
```

**কোন লাইন কেন — decorator:**

- `METHOD[route.method](route.path)` — চুক্তির `'POST'` থেকে Nest-এর `@Post('/auth/sign-up')`। `satisfies
  Record<HttpMethod, …>`: চুক্তিতে নতুন method (`HEAD`) যোগ হলে এখানে না লেখা পর্যন্ত compile error।
- `HttpCode(route.status)` — Nest-এর ডিফল্ট POST = 201। লগইন চুক্তিতে 200, তাই ধাপ ৩-এর `@HttpCode(HttpStatus.OK)`
  এখন চুক্তি থেকে।
- `SetMetadata(ROUTE_KEY, route)` — পুরো চুক্তিটা handler-এর গায়ে: ইনপুট-পার্সার আর ContractInterceptor
  runtime-এ এখান থেকে schema পড়ে।
- `Public()` — `auth: 'public'` থাকলে আগের `@Public()` decorator-ই বসে; `AuthGuard` কিছুই জানে না, আগের মতোই
  `IS_PUBLIC_KEY` দেখে। তাই guard-এ হাত দিতে হয়নি, আর চুক্তির বাইরের রুটে (docs) `@Public()` আগের মতোই চলে।
- `applyDecorators(...)` — Nest-এর নিজের helper; কয়েকটা decorator একসাথে একটায়।

**কোন লাইন কেন — টাইপ:**

- `<T extends Handler<R>>(…, descriptor: TypedPropertyDescriptor<T>)` — **এই ধাপের সবচেয়ে কাজের লাইন।**
  পুরনো ধাঁচের (`experimentalDecorators`) method decorator-কে TypeScript handler-এর আসল টাইপ দিয়ে ডাকে। `T`
  সেই টাইপ; `extends Handler<R>` বলে "handler-এর ফেরত মান চুক্তির response মানবে, আর ইনপুট থাকলে প্রথম
  প্যারামিটার চুক্তির ইনপুট"। না মানলে decorator-এর লাইনেই compile error (TS1241 "Unable to resolve signature
  of method decorator" — বার্তাটা অস্পষ্ট, কিন্তু জায়গা ঠিক; নিচের কারণ-বার্তায় আসল অমিলটা লেখা থাকে)।
  যাচাই করা: `/health` handler-এ `{ status: 'okk' }` আর members-এর handler-এ লগইনের ইনপুট টাইপ — দুটোই ধরা পড়ে।
- `T extends ...`, সরাসরি `TypedPropertyDescriptor<Handler<R>>` না — `TypedPropertyDescriptor`-এ `set?: (value:
  T) => void` আছে, তাই টাইপটা "হুবহু সমান" চায়। handler-এ বাড়তি প্যারামিটার (`@Res() reply`) থাকলে কখনোই হুবহু
  মিলত না। generic `T` আর `extends` দিয়ে শুধু "মানানসই" দেখা হয়।
- `...rest: never[]` — বাকি প্যারামিটার যেকোনো কিছু হতে পারে (`FastifyReply`, `FastifyRequest`): TypeScript-এর
  নিয়মে `never` যেকোনো টাইপে বসে।
- `[keyof RouteInput<R>] extends [never]` — ইনপুট নেই (refresh, logout, me) হলে প্রথম প্যারামিটারও স্বাধীন
  (`@Req() request`)। বর্গবন্ধনী — conditional type-এ `never` একা থাকলে "খালি union" হিসেবে পুরো শর্তটাই
  গিলে ফেলত (distributive conditional)।

**কোন লাইন কেন — ইনপুট:**

- `ContractInput()(target, key, 0)` — Nest-এর param decorator আসলে একটা সাধারণ ফাংশন `(target, key, index)`;
  হাতে ডেকে প্রথম প্যারামিটারে বসানো। কেন handler-এ `@Body(new ZodValidationPipe(schema))` আর না: তাতে schema
  দুই জায়গায় (চুক্তি আর controller), আর ভুল schema দিলেও কেউ ধরত না। এখন schema একটাই, আর উপরের টাইপ
  নিশ্চিত করে প্রথম প্যারামিটারের টাইপ সেই schema-র output।
- `createParamDecorator` param-এ `routeOf(context)` — decorator-এর মুহূর্তে না, প্রতিটা request-এ handler-এর
  metadata পড়ে। Nest যে ক্রমে decorator বসায় তার উপর নির্ভরতা নেই।
- সব অংশ (`params`, `query`, `body`) একসাথে parse, প্রথম ভুলে থেমে না — ফর্মে সব ভুল একবারে দেখায় (৫.৭-এর
  টেস্ট: চারটা ফিল্ডের চারটা code একসাথে)।
- `issue.path.map(String)` — Zod-এর পাথে `symbol`-ও থাকতে পারে (টাইপে `PropertyKey`), আর `symbol`-এর
  `join` throw করে।
- `|| part` — পাথ খালি মানে পুরো অংশটাই ভুল (POST-এ body নেই): `{ body: ['required'] }`।
- guard-এর পরে চলে — Nest-এর ক্রমে guard (401/403) আগে, param decorator পরে। তাই লগইন ছাড়া ভুল query দিলে
  400 না, 401 (৫.৭-এর টেস্ট সেটা দেখে): যে জানেই না সে কে, তাকে ইনপুটের নিয়ম জানানোর দরকার নেই।

**ফাইল: `apps/api/src/common/http/contract.interceptor.ts`** (নতুন ফাইল)

```ts
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

import { routeOf } from './endpoint.js';

// handler যা ফেরত দেয় তা বাইরে যাওয়ার আগে চুক্তির response schema দিয়ে parse:
// ১) চুক্তিতে নেই এমন ফিল্ড (ভুল করে যোগ হওয়া password hash, অন্য টেন্যান্টের id) কেটে বাদ পড়ে —
//    z.object() অচেনা key রাখে না;
// ২) চুক্তির সাথে না মিললে ক্লায়েন্টের কাছে ভাঙা ডেটা না গিয়ে 500 + লগে ঠিক কোন ফিল্ড
@Injectable()
export class ContractInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = routeOf(context);
    if (!route || route.status === 204) return next.handle();

    return next.handle().pipe(
      map((value: unknown) => {
        const result = route.response.safeParse(value);
        if (!result.success) {
          throw new Error(
            `${route.method} ${route.path} returned a body that breaks its contract:\n${z.prettifyError(result.error)}`,
          );
        }
        return result.data;
      }),
    );
  }
}
```

**কোন লাইন কেন:**

- টাইপ তো compile-time-এ আগেই মেলে (`@Endpoint`-এর `Handler`) — তবু runtime-এ কেন? TypeScript-এর টাইপে
  "বাড়তি ফিল্ড" নিষেধ না: `{ ...user }` ছড়িয়ে দিলে `passwordHash`-ও চলে যেত, আর টাইপ-চেকার খুশি থাকত।
  `z.object()`-এর parse অচেনা key ছেঁটে দেয় — ডেটা ফাঁসের বিরুদ্ধে শেষ দেয়াল (RLS-এর মতোই "কোডে ভুল হলেও")।
- `route.status === 204` — উত্তরে কিছুই নেই, parse করার কিছু নেই।
- `throw new Error(...)` → ProblemFilter-এ 500, আর লগে `z.prettifyError`: ঠিক কোন পাথে কী ভুল। ক্লায়েন্টের কাছে
  শুধু `internal_error` — চুক্তির বিবরণ বাইরে যায় না।
- `map` (rxjs) — Nest-এর interceptor handler-এর ফলকে Observable হিসেবে দেয়; `@Res({ passthrough: true })`-এর
  handler-এর ফেরত মানও এখান দিয়েই যায়।
- খরচ — প্রতি response-এ একবার parse। ৫০ রো-র পাতায় মাইক্রোসেকেন্ডের কাজ; ধাপ ২১-এর বড় রিপোর্টে মেপে দেখতে
  হবে (নোট শেষে)।

**ফাইল: `apps/api/src/app.module.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthGuard } from './auth/auth.guard.js';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { ContractInterceptor } from './common/http/contract.interceptor.js';
import { ProblemFilter } from './common/http/problem.filter.js';
import type { Config } from './config.js';
import { DocsController } from './docs/docs.controller.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { MembersModule } from './members/members.module.js';
import { PermissionGuard } from './rbac/permission.guard.js';
import { RbacModule } from './rbac/rbac.module.js';

@Module({})
export class AppModule implements NestModule {
  // config বাইরে থেকে আসে: main.ts-এ process.env থেকে, টেস্টে Testcontainers-এর URL থেকে
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.register(config), RbacModule, AuthModule, MembersModule],
      controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
      providers: [
        // ক্রম গুরুত্বপূর্ণ: আগে "কে" (AuthGuard → 401), তারপর "কী করতে পারে" (PermissionGuard → 403)
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        // প্রতিটা response চুক্তির schema দিয়ে যাচাই আর অচেনা ফিল্ড ছাঁটাই
        { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
        // প্রতিটা error একই আকারে: RFC 9457 problem + আমাদের code
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes('{*splat}');
  }
}
```

- `APP_INTERCEPTOR` / `APP_FILTER` provider হিসেবে, `app.useGlobalFilters()` না — guard-এর মতোই AppModule-এর
  ভেতরে; তাই `main.ts`, টেস্টের app আর `contract.spec.ts` সবাই কোনো আলাদা লাইন ছাড়াই পায়। (useGlobal… main.ts-এ
  লিখলে টেস্টের app-এ ভুলে যাওয়ার সুযোগ থাকত।)
- `...(config.exposeDocs ? [DocsController] : [])` — production-এ docs-এর রুট তৈরিই হয় না।

**ফাইল: `apps/api/src/config.ts`** (আপডেট — `return`-এর object-এ `port`-এর পরে দুই লাইন)

```ts
    port: e.PORT,
    apiBaseUrl: e.API_BASE_URL,
    // /openapi.json আর /docs — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না
    exposeDocs: e.NODE_ENV !== 'production',
```

- `apiBaseUrl` — `API_BASE_URL` আগে থেকেই পড়া হয় (JWT-এর issuer), শুধু বাইরে দেওয়া; OpenAPI-র `servers`-এ লাগে।
- `exposeDocs` — `NODE_ENV` থেকে, আলাদা env variable না: `development` আর `test`-এ চালু (টেস্ট তাই `/openapi.json`
  দেখতে পায়), `production`-এ বন্ধ। security-র মূল ভরসা এটা না (RLS, guard), কিন্তু আক্রমণকারীকে পুরো মানচিত্র
  হাতে দেওয়ার কারণও নেই।

**ফাইল: `apps/api/src/docs/docs.controller.ts`** (নতুন ফাইল)

```ts
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { routes } from '@omnivo/contracts';
import { buildOpenApiDocument, type OpenApiDocument } from '@omnivo/contracts/openapi';

import { Public } from '../auth/public.decorator.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

// Scalar-এর version বাঁধা: CDN-এর "latest" একদিন বদলে গিয়ে পেজ ভাঙতে পারত
const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Omnivo API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.json' });
    </script>
  </body>
</html>
`;

// শুধু development/test-এ চালু (app.module.ts) — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না।
// চুক্তির বাইরের রুট, তাই @Endpoint না; contract.spec.ts এই দুটোকে আলাদা করে চেনে
@Public()
@Controller()
export class DocsController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  @Get('openapi.json')
  spec(): OpenApiDocument {
    return buildOpenApiDocument(routes, { version: '0.0.0', serverUrl: this.config.apiBaseUrl });
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs(): string {
    return DOCS_HTML;
  }
}
```

**কোন লাইন কেন:**

- Scalar (Swagger UI-র আধুনিক বিকল্প) CDN থেকে — কোনো npm dependency না, API-র bundle-এ কিছু যোগ হয় না।
  "অফলাইন-ফার্স্ট"-এর নিয়ম (CLAUDE.md-এ Google Fonts না) app-এর জন্য; এটা শুধু ডেভেলপারের dev পেজ।
- `@1.72.1` বাঁধা — CDN-এর `latest` নতুন major-এ গেলে `createApiReference`-এর নাম বদলাতে পারে।
- `spec(): OpenApiDocument` — return টাইপ না লিখলে `tsc` error দিত (TS2883: "inferred type cannot be named
  without a reference to … zod/v4/core/json-schema"): api-র `declaration: true`, আর অনুমিত টাইপের ভেতরে Zod-এর
  গভীরের টাইপ যা এই প্যাকেজ থেকে নাম ধরে পৌঁছানো যায় না। contracts-এর export করা alias সেটা সমাধান করে।
- `@Public()` class-এ — চুক্তির বাইরের রুট, তাই `@Endpoint`-এর `auth: 'public'` এখানে খাটে না।
- JSON প্রতি request-এ নতুন বানানো — dev-এ ক্যাশ করার কিছু নেই; চুক্তি বদলে API restart হলেই নতুনটা।

### Guard, service, controller

**ফাইল: `apps/api/src/auth/auth.guard.ts`** (আপডেট — import আর throw)

```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/http/app-error.js';
import { tenantStorage } from '../common/tenant/tenant-context.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
// ...
    if (!tenantStorage.getStore()?.principal) {
      throw new AppError(401, 'sign_in_required', 'This route needs a valid access token.');
    }
```

**ফাইল: `apps/api/src/rbac/permission.guard.ts`** (আপডেট — import আর throw)

```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@omnivo/db';

import { AppError } from '../common/http/app-error.js';
// ...
    if (missing.length > 0) {
      const permissions = missing.join(', ');
      // params: UI অনুবাদের ভেতরে কোন অনুমতি লাগবে সেটা বসায় ("You need the {{permissions}} …")
      throw new AppError(403, 'permission_missing', `Missing permission: ${permissions}.`, {
        params: { permissions },
      });
    }
```

- `params` — এই ধাপে একমাত্র code যার লেখায় বাইরের মান বসে। ফর্মে দেখানো হয় না, কিন্তু যেকোনো জায়গায়
  `errorText(error.code, error.problem.params)` দিলে পুরো বাক্য।

**ফাইল: `apps/api/src/auth/auth.service.ts`** (আপডেট — import আর প্রতিটা throw)

import:

```ts
import { Inject, Injectable } from '@nestjs/common';
// ...
import { AppError } from '../common/http/app-error.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
```

ফাইলের মাথার helper:

```ts
function workspaceTaken(slug: string): AppError {
  return new AppError(409, 'slug_taken', `${slug}.omnivo.app is taken.`, {
    fieldErrors: { workspaceSlug: ['slug_taken'] },
  });
}

function sessionEnded(): AppError {
  return new AppError(401, 'session_ended', 'The session has ended. Sign in again.');
}
```

আর প্রতিটা throw এক-এক করে:

| জায়গা | আগে | এখন |
|---|---|---|
| `signUp` — `EMAIL_TAKEN` | `ConflictException({ … fieldErrors: { email: [...] } })` | `new AppError(409, 'email_taken', 'An account with this email already exists.', { fieldErrors: { email: ['email_taken'] } })` |
| `login` — tenant নেই | `NotFoundException({ … fieldErrors: { workspace: [...] } })` | `new AppError(404, 'workspace_not_found', `No workspace at ${input.workspace}.omnivo.app.`, { fieldErrors: { workspace: ['workspace_not_found'] } })` |
| `login` — `INVALID_CREDENTIALS` | `UnauthorizedException('Email or password…')` | `new AppError(401, 'invalid_credentials', 'Email or password is incorrect.')` |
| `login` — membership নেই | `ForbiddenException(\`This account isn't…\`)` | `new AppError(403, 'not_a_member', \`This account isn't a member of ${tenant.slug}.omnivo.app.\`)` |
| `refresh` — membership নেই | `UnauthorizedException('You no longer have access…')` | `new AppError(401, 'access_revoked', 'The user is no longer a member of this workspace.')` |
| `switchTenant` — membership নেই | `ForbiddenException("You aren't a member…")` | `new AppError(403, 'switch_denied', 'The user is not a member of that workspace.')` |
| বাকি পাঁচটা `UnauthorizedException('Your session has ended. Sign in again.')` (`switchTenant`, `me`, `rotate` দুটো, `reissue`) | — | `throw sessionEnded();` |

- ধাপ ৩-এর দুটো নিয়ম অপরিবর্তিত: `login`-এ ভুল ঠিকানা আর ভুল পাসওয়ার্ড আলাদা code (ঠিকানাটা গোপন কিছু না,
  সাবডোমেইন হিসেবে সবার দেখা), কিন্তু ইমেইল নেই আর পাসওয়ার্ড ভুল একই `invalid_credentials` — নাহলে কোন ইমেইলে
  অ্যাকাউন্ট আছে সেটা বাইরে থেকে জানা যেত।
- detail-এ slug থাকতে পারে (লগে কাজের), UI-র লেখায় নেই (৫.৫)।

**ফাইল: `apps/api/src/auth/auth.controller.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { Controller, Header, Inject, Req, Res } from '@nestjs/common';
import type { IssuedTokens } from '@omnivo/auth';
import { type AuthSession, type MeResponse, type RouteInput, routes } from '@omnivo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../common/http/app-error.js';
import { Endpoint } from '../common/http/endpoint.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { AuthService } from './auth.service.js';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie.js';

// path আর status চুক্তিতে (routes.auth.*), তাই @Controller()-এ prefix নেই
@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Endpoint(routes.auth.signUp)
  @Header('Cache-Control', 'no-store')
  async signUp(
    { body }: RouteInput<typeof routes.auth.signUp>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.signUp(body));
  }

  @Endpoint(routes.auth.login)
  @Header('Cache-Control', 'no-store')
  async login(
    { body }: RouteInput<typeof routes.auth.login>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return this.startSession(reply, await this.authService.login(body));
  }

  @Endpoint(routes.auth.refresh)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    try {
      return this.startSession(
        reply,
        await this.authService.refresh(request.cookies[REFRESH_COOKIE]),
      );
    } catch (error) {
      // অচল cookie ব্রাউজারে রেখে লাভ নেই; কিন্তু DB down-এর মতো 5xx-এ cookie রেখে দেওয়া
      if (error instanceof AppError && error.status === 401) {
        clearRefreshCookie(reply, this.config.secureCookies);
      }
      throw error;
    }
  }

  // bearer: কে switch করছে সেটা access token বলে, আর cookie দিয়ে session rotate হয়
  @Endpoint(routes.auth.switchTenant)
  @Header('Cache-Control', 'no-store')
  async switchTenant(
    { body }: RouteInput<typeof routes.auth.switchTenant>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const tokens = await this.authService.switchTenant(
      currentPrincipal(),
      request.cookies[REFRESH_COOKIE],
      body.tenantId,
    );
    return this.startSession(reply, tokens);
  }

  @Endpoint(routes.auth.logout)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logout(request.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, this.config.secureCookies);
  }

  @Endpoint(routes.auth.me)
  me(): Promise<MeResponse> {
    return this.authService.me(currentPrincipal());
  }

  // refresh token শুধু httpOnly cookie-তে; JSON-এ শুধু access token — JS কখনো refresh token দেখে না
  private startSession(reply: FastifyReply, tokens: IssuedTokens): AuthSession {
    setRefreshCookie(
      reply,
      tokens.refreshToken,
      tokens.refreshTokenExpiresAt,
      this.config.secureCookies,
    );
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    };
  }
}
```

**কী বদলাল, আর কেন:**

- `@Controller('auth')` → `@Controller()` — path পুরোটা চুক্তিতে (`/auth/sign-up`); prefix থাকলে Nest দুটো জুড়ে
  `/auth/auth/sign-up` বানাত।
- `{ body }: RouteInput<typeof routes.auth.signUp>` — প্রথম প্যারামিটারে কোনো decorator নেই: `@Endpoint` নিজে বসায়
  (উপরে)। টাইপটা হাতে লেখা, কিন্তু `Handler<R>` মিলিয়ে দেখে — অন্য route-এর টাইপ লিখলে compile error।
- `@Public()`, `@HttpCode(...)`, `@Post(...)` সব গেছে — চুক্তি থেকে আসে।
- `@Header('Cache-Control', 'no-store')` থাকল — এটা HTTP-র ক্যাশ নীতি, চুক্তির অংশ না (টোকেনওয়ালা উত্তর কোনো
  প্রক্সি যেন জমিয়ে না রাখে)।
- `refresh`-এ `error instanceof AppError && error.status === 401` — আগে `UnauthorizedException`; service এখন সেটা
  ছোড়ে না।
- `me(): Promise<MeResponse>` — ফেরত টাইপ চুক্তির `meResponseSchema`-র input-এর সাথে মেলে কি না `@Endpoint` দেখে।

**ফাইল: `apps/api/src/health/health.controller.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { Controller } from '@nestjs/common';
import { type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';

@Controller()
export class HealthController {
  // public চুক্তি থেকে — আলাদা @Public() লাগে না
  @Endpoint(routes.health.check)
  check(): RouteResponse<typeof routes.health.check> {
    return { status: 'ok' };
  }
}
```

### keyset pagination

**ফাইল: `apps/api/src/common/pagination/cursor.ts`** (নতুন ফাইল)

```ts
import type { z } from 'zod';

import { AppError } from '../http/app-error.js';

// cursor = শেষ রো-র sort-কলামগুলোর মান, JSON → base64url। ক্লায়েন্টের কাছে অস্বচ্ছ; ভেতরের আকার
// বদলালেও (নতুন sort কলাম) ক্লায়েন্টের কোড বদলাতে হয় না
export function encodeCursor(values: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

// ক্লায়েন্টের পাঠানো cursor বিশ্বাস করা হয় না: schema দিয়ে যাচাই। নাহলে ভাঙা uuid সোজা SQL-এ
// গিয়ে Postgres-এর cast error → 500 হতো, 400 না
export function decodeCursor<TSchema extends z.ZodType>(
  cursor: string | undefined,
  schema: TSchema,
): z.output<TSchema> | undefined {
  if (cursor === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(json);
  if (!result.success) throw invalidCursor();
  return result.data;
}

// limit + 1টা রো আনা হয়: একটা বেশি পেলে বোঝা যায় পরের পাতা আছে — আলাদা COUNT(*) লাগে না
export function toPage<TRow>(
  rows: TRow[],
  limit: number,
  cursorOf: (last: TRow) => readonly unknown[],
): { items: TRow[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
```

**কোন লাইন কেন:**

- `base64url` — সাধারণ base64-এ `+`, `/`, `=` থাকে যা URL-এ escape লাগে; base64url সরাসরি querystring-এ বসে।
- cursor-এ সই (HMAC) নেই, ইচ্ছা করে — কেউ cursor বানিয়ে পাঠালে পায় শুধু নিজের টেন্যান্টের তালিকার অন্য জায়গা
  থেকে শুরু; RLS আর `tenant_id` filter আগের মতোই। গোপন কিছু ফাঁস হয় না, তাই সই-এর জটিলতা অকারণ।
- `JSON.parse` `any` ফেরত দেয় — `let json: unknown`-এ রাখা, তারপর Zod দিয়ে নামানো (rule ৩)। বাইরের জিনিস তাই
  কখনো `any` হয়ে কোডে ছড়ায় না।
- `decodeCursor`-এর generic — প্রতিটা তালিকার cursor-এর আকার আলাদা (members: `[sort, নাম, id]`, ইনভয়েস:
  `[তারিখ, id]`); ফেরত টাইপ schema থেকে।
- `limit + 1` কৌশল — `COUNT(*)` ছাড়াই "আরও আছে কি না"। একটা বাড়তি রো পড়া প্রায় বিনা খরচে।

**ফাইল: `apps/api/src/common/pagination/cursor.spec.ts`** (নতুন ফাইল)

```ts
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { AppError } from '../http/app-error.js';
import { decodeCursor, encodeCursor, toPage } from './cursor.js';

const position = z.tuple([z.string(), z.uuid()]);
const id = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c3d';

describe('cursor', () => {
  it('round-trips the position of the last row', () => {
    const cursor = encodeCursor(['Farhana Rahman', id]);
    expect(decodeCursor(cursor, position)).toEqual(['Farhana Rahman', id]);
  });

  it('means "first page" when there is no cursor', () => {
    expect(decodeCursor(undefined, position)).toBeUndefined();
  });

  it('rejects a tampered cursor with a 400, never letting it reach SQL', () => {
    for (const cursor of ['not-base64-json', encodeCursor(['Farhana', 'not-a-uuid'])]) {
      expect(() => decodeCursor(cursor, position)).toThrow(AppError);
    }
  });
});

describe('toPage', () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];

  it('uses the extra row only to know that another page exists', () => {
    const page = toPage(rows, 2, (last) => [last.n]);
    expect(page.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decodeCursor(page.nextCursor ?? undefined, z.tuple([z.number()]))).toEqual([2]);
  });

  it('ends the list with a null cursor', () => {
    expect(toPage(rows, 3, (last) => [last.n]).nextCursor).toBeNull();
  });
});
```

**ফাইল: `apps/api/src/members/members.controller.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { Controller, Inject } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
import { membershipRoles, memberships, roles, users } from '@omnivo/db';
import { z } from 'zod';

import { Endpoint } from '../common/http/endpoint.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';

type ListRoute = typeof routes.members.list;

@Controller()
export class MembersController {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  @Endpoint(routes.members.list)
  @RequirePermission('core.user.read')
  list({ query }: RouteInput<ListRoute>): Promise<RouteResponse<ListRoute>> {
    const tenantId = getTenantId();
    // cursor = [sort, শেষ রো-র নাম, শেষ রো-র id]। sort-টা literal দিয়ে যাচাই: "name"-এর cursor
    // "-name"-এ চালালে ভুল জায়গা থেকে পাতা শুরু হতো — চুপচাপ ভুল তালিকা না দিয়ে 400
    const after = decodeCursor(
      query.cursor,
      z.tuple([z.literal(query.sort), z.string(), z.uuid()]),
    );
    const descending = query.sort === '-name';
    const direction = descending ? desc : asc;

    return this.withTenant(async (tx) => {
      // keyset: (নাম, id) জোড়া দিয়ে তুলনা — শুধু নাম দিলে একই নামের দুজনের একজন বাদ পড়ত বা দুবার
      // আসত; id (uuidv7, অনন্য) টাই ভাঙে। ORDER BY-এর কলাম আর তুলনার কলাম হুবহু এক
      const position =
        after &&
        (descending
          ? sql`(${users.fullName}, ${memberships.id}) < (${after[1]}, ${after[2]})`
          : sql`(${users.fullName}, ${memberships.id}) > (${after[1]}, ${after[2]})`);

      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          fullName: users.fullName,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        // explicit tenant filter + RLS: কোডে filter ভুলে গেলেও RLS আটকাবে, আর উল্টোটাও
        .where(and(eq(memberships.tenantId, tenantId), isNull(memberships.deletedAt), position))
        .orderBy(direction(users.fullName), direction(memberships.id))
        .limit(query.limit + 1);

      const page = toPage(rows, query.limit, (last) => [
        query.sort,
        last.fullName,
        last.membershipId,
      ]);

      // রোল শুধু এই পাতার সদস্যদের — পুরো টেন্যান্টের না
      const ids = page.items.map((row) => row.membershipId);
      const roleRows =
        ids.length === 0
          ? []
          : await tx
              .select({ membershipId: membershipRoles.membershipId, name: roles.name })
              .from(membershipRoles)
              .innerJoin(
                roles,
                and(
                  eq(roles.tenantId, membershipRoles.tenantId),
                  eq(roles.id, membershipRoles.roleId),
                ),
              )
              .where(
                and(
                  eq(membershipRoles.tenantId, tenantId),
                  inArray(membershipRoles.membershipId, ids),
                  isNull(membershipRoles.deletedAt),
                  isNull(roles.deletedAt),
                ),
              )
              .orderBy(asc(roles.name));

      const rolesByMembership = new Map<string, string[]>();
      for (const row of roleRows) {
        rolesByMembership.set(row.membershipId, [
          ...(rolesByMembership.get(row.membershipId) ?? []),
          row.name,
        ]);
      }

      return {
        items: page.items.map((row) => ({
          ...row,
          roles: rolesByMembership.get(row.membershipId) ?? [],
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}
```

**কোন লাইন কেন:**

- `z.literal(query.sort)` — cursor-এর schema প্রতি request-এ বানানো, এই request-এর sort দিয়ে। নাম-ক্রমের
  পাতার cursor উল্টো-ক্রমে দিলে schema মেলে না → 400 `invalid_cursor` (টেস্ট আছে)। আলাদা `if` লাগে না।
- `(full_name, id) > ($1, $2)` — Postgres-এর "row value comparison": প্রথমে নাম মেলায়, নাম সমান হলে id।
  `WHERE full_name > $1 OR (full_name = $1 AND id > $2)`-এর ছোট রূপ, আর Postgres এটা index দিয়ে চালাতে জানে।
  Drizzle-এ এর builder নেই, তাই `sql` template — কিন্তু কলাম (`${users.fullName}`) Drizzle-এর object, তাই নামের
  বানান ভুল compile error, আর মান (`${after[1]}`) parameter হিসেবে যায়, SQL-এ জোড়া হয় না (injection নেই)।
- তুলনা আর `ORDER BY` একই কলাম, একই দিকে — না মিললে (যেমন ORDER BY নাম, তুলনা id) পাতার মাঝে রো বাদ পড়ত।
- `direction(memberships.id)` — টাই-ভাঙা কলামও একই দিকে; উল্টো-ক্রমে দুটোই `DESC`, তুলনা `<`।
- `after && (…)` — প্রথম পাতায় `after` নেই → `undefined`; Drizzle-এর `and()` `undefined` শর্ত বাদ দেয়।
- `limit(query.limit + 1)` আর `toPage` — উপরের `limit + 1` কৌশল।
- রোল এখন `inArray(..., ids)` — আগে পুরো টেন্যান্টের সব রোল আনা হতো। হাজার জনের টেন্যান্টে ৫০ জনের পাতার
  জন্য হাজার রো-র রোল পড়া অকারণ। `ids.length === 0` — খালি `IN ()` SQL-এ ভুল; তাই query-ই চালানো হয় না।
- index: `users.full_name`-এ (join-এর অন্য টেবিলে) index নেই, আর এই তালিকা ছোট (টেন্যান্টের সদস্য)। বড় টেবিলের
  নিয়ম — `(tenant_id, sort_col, id)` index — ধাপ ১২-র প্রোডাক্ট তালিকায় (নোট শেষে)।

---

## ৫.৭ — API-র টেস্ট

**ফাইল: `apps/api/src/contract.spec.ts`** (নতুন ফাইল — Docker লাগে না, `pnpm test`-এ চলে)

```ts
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { problemSchema, type RouteDef, routes } from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './configure-app.js';
import { testConfig } from './testing/app.js';

// DB/Redis ছাড়াই (Docker লাগে না): নিচের কোনো request DB পর্যন্ত পৌঁছায় না — পুরনো ঠিকানা
// দেওয়া হলেও postgres.js প্রথম query-র আগে সংযোগই করে না
let app: NestFastifyApplication;
const registered: string[] = [];

beforeAll(async () => {
  const adapter = createAdapter();
  // Nest রুট বসানোর আগেই hook — Fastify প্রতিটা নতুন রুটে এটা ডাকে
  adapter.getInstance().addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      // HEAD Fastify নিজে GET-এর জন্য বানায়, OPTIONS CORS-এর — আমাদের চুক্তির অংশ না
      if (method !== 'HEAD' && method !== 'OPTIONS') registered.push(`${method} ${route.url}`);
    }
  });
  const config = testConfig({
    databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
    redisUrl: 'redis://127.0.0.1:1',
  });
  app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config), adapter, {
    logger: false,
  });
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('routes match the contract registry', () => {
  it('serves exactly the routes in @omnivo/contracts, plus the dev-only docs', () => {
    // চওড়া টাইপে রাখা: প্রতিটা group-এর আলাদা object টাইপে Object.values any দিত
    const registry: Record<string, Record<string, RouteDef>> = routes;
    const contract = Object.values(registry).flatMap((group) =>
      Object.values(group).map((route) => `${route.method} ${route.path}`),
    );
    expect(registered.sort()).toEqual([...contract, 'GET /docs', 'GET /openapi.json'].sort());
  });
});

describe('error envelope', () => {
  it('answers an unknown route with a not_found problem and a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemSchema.parse(res.json());
    expect(problem).toMatchObject({ status: 404, title: 'Not Found', code: 'not_found' });
    expect(problem.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(problem.requestId);
  });

  it('answers a body that is not JSON with malformed_request, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"workspace":',
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).code).toBe('malformed_request');
  });

  it('collects every invalid field into one 400, as codes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { workspace: 'A', email: 'nope', password: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'invalid_input',
      fieldErrors: {
        workspace: ['slug_too_short'],
        email: ['email_invalid'],
        password: ['password_required'],
        keepSignedIn: ['required'],
      },
    });
  });

  it('rejects a query value outside the contract before the handler runs', async () => {
    // টোকেন নেই, তাই আগে AuthGuard: 401 — ইনপুট যাচাই guard-এর পরে চলে
    const res = await app.inject({ method: 'GET', url: '/members?limit=1000' });
    expect(res.statusCode).toBe(401);
  });
});

describe('docs', () => {
  it('serves the OpenAPI document with this server as its base URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      openapi: '3.1.0',
      servers: [{ url: 'http://localhost:3000' }],
    });
  });
});
```

**কোন লাইন কেন:**

- `.int.spec.ts` না — ফাইলের নাম `contract.spec.ts`, তাই `pnpm test`-এ চলে (Docker ছাড়া), CI-র প্রথম দিকেই।
  চুক্তি আর রুটের অমিল ধরতে DB লাগে না।
- ভুয়া DB/Redis ঠিকানা — postgres.js প্রথম query-র আগে সংযোগ করে না; ioredis সংযোগের চেষ্টা করে ব্যর্থ হয়, আর
  `enableOfflineQueue: false` (ধাপ ৩) থাকায় কিছু আটকে থাকে না। কোনো request DB-তে পৌঁছায় না: 404, ভাঙা JSON,
  ইনপুট-error আর 401 সবই handler-এর আগে থামে।
- `onRoute` hook `NestFactory.create`-এর **আগে** — Nest `app.init()`-এ রুট বসায়; পরে hook দিলে কিছুই ধরা পড়ত না।
- `[route.method].flat()` — Fastify-তে একটা রুট একাধিক method নিতে পারে (`string | string[]`)।
- `registered.sort()` আর চুক্তি `toEqual` — বেশি হলেও fail (চুক্তি ছাড়া কেউ `@Get()` লিখেছে), কম হলেও fail
  (চুক্তিতে আছে কিন্তু controller নেই, বা module AppModule-এ যোগ হয়নি)।
- `const registry: Record<…> = routes` — চওড়া টাইপে বসানো, cast না। `routes`-এর তিনটা group-এর টাইপ আলাদা;
  সেই union-এর উপর `Object.values` TypeScript-এ `any` দিত আর ESLint ধরত।
- ভাঙা JSON-এর টেস্ট — এটাই দেখায় যে Fastify-র parser-এর error-ও ফিল্টারে আসে (৫.৬-এর `toProblem`-এর তৃতীয় শাখা)।
- `keepSignedIn: ['required']` — schema-য় code নেই (`z.boolean()`), তাই `contractErrorMap`-এর fallback।

**ফাইল: `apps/api/src/auth/auth.middleware.spec.ts`** (আপডেট — ProbeModule-এ ফিল্টার)

```ts
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
// ...
import { ProblemFilter } from '../common/http/problem.filter.js';
// ...
@Module({
  controllers: [ProbeController],
  providers: [
    { provide: AUTH, useValue: { getPrincipal: tokens.verify } },
    { provide: APP_GUARD, useClass: AuthGuard },
    // AuthGuard AppError ছোড়ে — ফিল্টার ছাড়া Nest সেটাকে অচেনা error ভেবে 500 দিত
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
```

- এই টেস্ট AppModule ছাড়া ছোট একটা module বানায়। যাচাইয়ের সময় প্রথমবার এখানে তিনটা টেস্ট 401-এর বদলে 500
  পেয়েছিল — `AppError` Nest-এর `HttpException` না, তাই Nest-এর নিজের handler সেটাকে অজানা bug ভাবে। এটাই দেখায়
  কেন ফিল্টার `APP_FILTER` হিসেবে AppModule-এ (উপরে): আসল অ্যাপে এমন ফাঁক থাকে না।

**ফাইল: `apps/api/src/auth/auth.int.spec.ts`** (আপডেট — `apiErrorSchema` → `problemSchema`, আর code যাচাই)

```ts
import { meResponseSchema, problemSchema, type SignUpInput } from '@omnivo/contracts';
```

আর assertion গুলো এভাবে (বাকি টেস্ট অপরিবর্তিত):

```ts
  // 'rejects a taken workspace address without creating the user'
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemSchema.parse(res.json());
    expect(problem.code).toBe('slug_taken');
    expect(problem.fieldErrors).toEqual({ workspaceSlug: ['slug_taken'] });
    expect(problem.requestId).toBe(res.headers['x-request-id']);

  // 'rejects an email that already has an account'
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ email: ['email_taken'] });

  // 'returns field errors for invalid input'
    const problem = problemSchema.parse(res.json());
    expect(problem.code).toBe('invalid_input');
    expect(problem.fieldErrors).toEqual({
      email: ['email_invalid'],
      password: ['password_too_short'],
    });

  // 'rejects a wrong password with 401' — statusCode-এর পরে
    expect(problemSchema.parse(res.json()).code).toBe('invalid_credentials');

  // 'rejects an unknown workspace with 404' — statusCode-এর পরে
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      workspace: ['workspace_not_found'],
    });

  // 'rejects a real user who is not a member of that workspace with 403' — statusCode-এর পরে
    expect(problemSchema.parse(res.json()).code).toBe('not_a_member');

  // 'asks for a sign-in (401) before it checks permissions (403)' — statusCode-এর পরে
    expect(problemSchema.parse(res.json()).code).toBe('sign_in_required');

  // 'lets the owner list members and blocks a member without the permission' — শেষে
    expect(problemSchema.parse(denied.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'core.user.read' },
    });
```

**ফাইল: `apps/api/src/members/members.tenant-leak.int.spec.ts`** (আপডেট — উত্তরের নতুন আকার)

```ts
import { memberPageSchema, meResponseSchema } from '@omnivo/contracts';
// ...প্রথম টেস্টে:
    const { items } = memberPageSchema.parse(res.json());
    expect(items.map((m) => m.email)).toEqual(['farhana@rahmangarments.com']);
```

- দ্বিতীয় টেস্টে (`x-tenant-id` header) একই দুই লাইন বদল — `memberListResponseSchema` → `memberPageSchema`,
  `members` → `items`।

**ফাইল: `apps/api/src/members/members.int.spec.ts`** (নতুন ফাইল — Testcontainers, `pnpm test:integration`-এ)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Member, memberPageSchema, problemSchema } from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let owner: SignedIn;

// দুজন "Abdul Karim" ইচ্ছা করে: শুধু নাম দিয়ে cursor বানালে একজন বাদ পড়ত বা দুবার আসত
const TEAM = ['Abdul Karim', 'Abdul Karim', 'Nasrin Akter', 'Shafiq Islam'];

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });

  // ধাপ ৭-এর invite আসার আগে পর্যন্ত সদস্য যোগ সরাসরি SQL-এ (RLS-এর বাইরে, superuser)
  const superuser = postgres(pg.superuserUrl, { max: 1 });
  await superuser.begin(async (sql) => {
    const [tenant] = await sql<
      { id: string }[]
    >`SELECT id FROM tenants WHERE slug = 'rahman-garments'`;
    if (!tenant) throw new Error('setup: tenant missing');
    for (const [index, fullName] of TEAM.entries()) {
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO users (id, email, full_name)
        VALUES (gen_random_uuid(), ${`member${String(index)}@rahmangarments.com`}, ${fullName})
        RETURNING id`;
      if (!user) throw new Error('setup: user insert failed');
      await sql`INSERT INTO memberships (id, tenant_id, user_id) VALUES (gen_random_uuid(), ${tenant.id}, ${user.id})`;
    }
  });
  await superuser.end();
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function list(query: string) {
  return app.inject({
    method: 'GET',
    url: `/members?${query}`,
    headers: bearer(owner.accessToken),
  });
}

// cursor ধরে ধরে শেষ পাতা পর্যন্ত
async function everyPage(sort: string, limit: number): Promise<Member[][]> {
  const pages: Member[][] = [];
  let cursor: string | null = null;
  do {
    const query = `sort=${sort}&limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`;
    const page = memberPageSchema.parse((await list(query)).json());
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

describe('keyset pagination', () => {
  it('walks the whole list in pages without skipping or repeating anyone', async () => {
    const pages = await everyPage('name', 2);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);

    const everyone = pages.flat();
    expect(everyone.map((m) => m.fullName)).toEqual([
      'Abdul Karim',
      'Abdul Karim',
      'Farhana Rahman',
      'Nasrin Akter',
      'Shafiq Islam',
    ]);
    expect(new Set(everyone.map((m) => m.membershipId)).size).toBe(5);
    // শুধু সেই পাতার রোল — মালিকের Owner রোল ঠিক জায়গায়
    expect(everyone.find((m) => m.fullName === 'Farhana Rahman')?.roles).toEqual(['Owner']);
  });

  it('pages the same way in reverse order', async () => {
    const names = (await everyPage('-name', 2)).flat().map((m) => m.fullName);
    expect(names).toEqual([
      'Shafiq Islam',
      'Nasrin Akter',
      'Farhana Rahman',
      'Abdul Karim',
      'Abdul Karim',
    ]);
  });

  it('refuses a cursor from one sort order in another, instead of returning the wrong page', async () => {
    const first = memberPageSchema.parse((await list('sort=name&limit=2')).json());
    const res = await list(`sort=-name&limit=2&cursor=${first.nextCursor ?? ''}`);
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).code).toBe('invalid_cursor');
  });

  it('rejects a made-up cursor with 400, not a database error', async () => {
    const res = await list('cursor=bm90LWEtY3Vyc29y');
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).code).toBe('invalid_cursor');
  });

  it('rejects a page size over the limit with a field error', async () => {
    const res = await list('limit=1000');
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ limit: ['too_large'] });
  });
});
```

**কোন লাইন কেন:**

- দুজন একই নামের সদস্য, আর `limit=2` — প্রথম পাতা ঠিক দুই "Abdul Karim"-এ শেষ হয়। cursor-এ শুধু নাম থাকলে
  (`full_name > 'Abdul Karim'`) দ্বিতীয় পাতা দুজনকেই বাদ দিত; `>=` দিলে দুজনই আবার আসত। `(নাম, id)` জোড়া-ই
  একমাত্র সঠিক রূপ — এই টেস্ট সেটা পাহারা দেয়।
- `new Set(ids).size === 5` — কেউ দুবার আসেনি।
- `'bm90LWEtY3Vyc29y'` = base64url-এ "not-a-cursor" — বৈধ base64, কিন্তু ভেতরে JSON না: `JSON.parse` fail → 400।
- ⚠️ **যা যাচাই হয়নি (Docker বন্ধ ছিল), চালিয়ে যা দেখবেন:**
  - row comparison-এ parameter-এর টাইপ: `(text, uuid) > ($1, $2)` — Postgres parameter-এর টাইপ তুলনার পাশের কলাম
    থেকে অনুমান করে (`$2` → `uuid`), তাই কাজ করার কথা। "operator does not exist: uuid > text" এলে `sql`-এ
    `${after[2]}::uuid` লিখুন।
  - `INSERT INTO users (id, email, full_name)` — `baseColumns`-এর বাকি কলামে (created_at …) default থাকার কথা;
    `auth.int.spec.ts` membership একইভাবে বসায়, কিন্তু users এভাবে বসানো এই প্রথম। not-null error এলে সেই কলামটা
    যোগ করুন।
  - নামের ক্রম (`Abdul` < `Farhana` < `Nasrin` < `Shafiq`) Postgres-এর collation-এ — ইংরেজি নামে `C` বা
    `en_US`-এ একই।

```bash
pnpm --filter @omnivo/api test                # ১৭টা পাস (আগের ৬ + contract ৬ + cursor ৫) — Docker লাগে না
pnpm --filter @omnivo/api test:integration    # Docker লাগে — এই ধাপে যাচাই হয়নি
pnpm --filter @omnivo/api test:tenant-leak
```

---

## ৫.৮ — `packages/ui`: error-এর লেখা আর DataTable

**ফাইল: `packages/ui/src/components/field.tsx`** (আপডেট — `Field`-এর দুই লাইন)

```tsx
export function Field({ id, label, optional = false, hint, error, children }: FieldProps) {
  const { t, errorText } = useLocale();
  // ...
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {/* ফর্মের error এখন code ('slug_taken') — বর্তমান ভাষায় লেখা এখানেই */}
          {errorText(error)}
        </p>
      ) : (
```

**ফাইল: `packages/ui/src/components/form-alert.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';

// ফিল্ডে বসানো যায় না এমন error (ভুল পাসওয়ার্ড, নেটওয়ার্ক) — রঙের সাথে আইকন আর লেখা।
// message একটা error code হলে ('invalid_credentials') বর্তমান ভাষায়, নাহলে যেমন আছে
export function FormAlert({ message }: { message: string }) {
  const { errorText } = useLocale();
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control border border-crit/30 bg-crit-bg px-3 py-2.5 text-body-sm text-crit"
    >
      <HugeiconsIcon icon={Alert02Icon} size={17} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(message)}
    </p>
  );
}
```

**কেন ui-তে, app-এ না:** `TextField`, `FormField` (MoneyInput, DatePicker) — সবাই `Field` দিয়ে error দেখায়। এখানে
একবার অনুবাদ করলে প্রতিটা ফর্ম, প্রতিটা ফিল্ড বিনা কোডে পায়; ফর্মের কোডে শুধু `error={errors.email?.message}`,
আগের মতোই। আর যেহেতু render-এর সময় অনুবাদ হয় (জমা দেওয়ার সময় না), ভাষা বদলালে দেখানো error-ও বদলায়।

**ফাইল: `packages/ui/src/components/data-table.tsx`** (আপডেট — চার জায়গায়)

১. import — `@tanstack/react-table` থেকে আরও দুটো, আর React থেকে `useEffect`:

```tsx
import {
  // ...আগের সব
  functionalUpdate,
  // ...
  type SortingState,
  // ...
} from '@tanstack/react-table';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
```

২. `type Features = typeof dataTableFeatures;`-এর ঠিক পরে:

```tsx
// app-কে TanStack Table সরাসরি import করতে হয় না — sort-এর অবস্থা [{ id, desc }]
export type { SortingState };
```

৩. `DataTableProps`-এর শেষে তিনটা prop, আর interface-এর পরে একটা constant:

```tsx
  // সার্ভার সাজায়: পাতায় পাতায় আসা তালিকার পুরোটা ক্লায়েন্টে নেই, তাই নিজে sort করলে শুধু আনা
  // রো-গুলো সাজাত — ভুল ফল। দিলে টেবিল নিজে sort করে না, শুধু হেডারের ক্লিক জানায়
  sorting?: { state: SortingState; onChange: (next: SortingState) => void } | undefined;
  // শেষ রো-র কাছে scroll পৌঁছালে — পরের পাতা আনার সংকেত (infinite scroll)
  onEndReached?: (() => void) | undefined;
  // তালিকার নিচে, যেমন "Loading more…"
  footer?: ReactNode;
}

// শেষ রো-র এতগুলো আগে থেকেই পরের পাতা চাওয়া — ব্যবহারকারী তলায় পৌঁছানোর আগেই ডেটা এসে যায়
const END_THRESHOLD = 10;
```

৪. `DataTable`-এর ভেতরে — props-এ `sorting, onEndReached, footer`, `useTable`-এ manual sort, আর দুই view-এ
`onEndReached`:

```tsx
export function DataTable<TData extends RowData>({
  label,
  data,
  columns,
  getRowId,
  empty,
  onRowClick,
  maxHeight = 560,
  showCount = false,
  sorting,
  onEndReached,
  footer,
}: DataTableProps<TData>) {
  const { t, format } = useLocale();
  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    getRowId: (row) => getRowId(row),
    ...(sorting && {
      manualSorting: true,
      // সার্ভার সবসময় কোনো না কোনো ক্রমে দেয়, তাই তৃতীয় ক্লিকে "sort নেই" অবস্থা মিথ্যা হতো
      enableSortingRemoval: false,
      state: { sorting: sorting.state },
      // TanStack মান বা updater-ফাংশন দুটোই পাঠাতে পারে — functionalUpdate দুটোকেই মান বানায়
      onSortingChange: (updater) => {
        sorting.onChange(functionalUpdate(updater, sorting.state));
      },
    }),
  });
  // ...isDesktop, rows, empty — আগের মতো

  return (
    <div className="grid gap-2">
      {isDesktop ? (
        <DesktopTable
          table={table}
          rows={rows}
          label={label}
          maxHeight={maxHeight}
          onRowClick={onRowClick}
          onEndReached={onEndReached}
        />
      ) : (
        <MobileCards
          rows={rows}
          table={table}
          label={label}
          onRowClick={onRowClick}
          onEndReached={onEndReached}
        />
      )}
      {footer}
      {/* showCount — আগের মতো */}
    </div>
  );
}
```

`ViewProps`-এ `onEndReached` আর তার ঠিক নিচে ছোট hook:

```tsx
interface ViewProps<TData extends RowData> {
  table: ReactTable<Features, TData>;
  rows: Row<Features, TData>[];
  label: string;
  onRowClick: ((row: TData) => void) | undefined;
  onEndReached: (() => void) | undefined;
}

// virtualizer যে শেষ রো-টা আঁকছে সেটা তালিকার শেষের কাছে হলে onEndReached। scroll event না শুনে
// virtual item-এর index দেখা — virtualizer এটা এমনিতেই হিসাব করে, আর প্রথম পাতা পর্দার চেয়ে ছোট
// হলে scroll ছাড়াই পরের পাতা চায়
function useEndReached(
  lastIndex: number | undefined,
  rowCount: number,
  onEndReached: (() => void) | undefined,
): void {
  useEffect(() => {
    if (onEndReached && lastIndex !== undefined && lastIndex >= rowCount - 1 - END_THRESHOLD) {
      onEndReached();
    }
  }, [lastIndex, rowCount, onEndReached]);
}
```

`DesktopTable`-এর props-এ `onEndReached`, আর `const items = virtualizer.getVirtualItems();`-এর ঠিক পরে:

```tsx
  useEndReached(items.at(-1)?.index, rows.length, onEndReached);
```

`MobileCards`-এর props-এ `onEndReached`, আর `useWindowVirtualizer({...})`-এর ঠিক পরে:

```tsx
  useEndReached(virtualizer.getVirtualItems().at(-1)?.index, rows.length, onEndReached);
```

**কোন লাইন কেন:**

- `manualSorting: true` — TanStack Table v9-এ "sort-এর হিসাব আমি করব না, `data` আগে থেকেই সাজানো"। হেডারের বাটন,
  `aria-sort`, আইকন সব আগের মতো কাজ করে; শুধু সারি নিজে সাজায় না। (v9-এর নিজের নির্দেশিকা
  `node_modules/@tanstack/react-table/skills/with-tanstack-query/SKILL.md`: server-owned অবস্থা query key-তে।)
- `state` + `onSortingChange` জোড়ায় — v9-এর নিয়ম: callback দিলে মানটাও বাইরে থেকে দিতে হয় (নির্দেশিকার "HIGH:
  Supplying only the change callback")। টেবিলের নিজের state আর বাইরের state দুটো থাকলে আলাদা হয়ে যেত।
- `functionalUpdate(updater, sorting.state)` — TanStack `onSortingChange`-এ কখনো মান, কখনো `(old) => new` ফাংশন
  পাঠায়। দুটোকেই মান বানায় লাইব্রেরির নিজের helper।
- `enableSortingRemoval: false` — ডিফল্টে তিন ধাপ: asc → desc → sort নেই। সার্ভার "sort নেই" জানে না (সবসময়
  নাম-ক্রমে দেয়), তাই তৃতীয় ক্লিকে হেডার বলত "sort নেই" অথচ তালিকা সাজানো — মিথ্যা অবস্থা।
- `...(sorting && {...})` — `sorting` না দিলে টেবিল আগের মতোই নিজে sort করে (kitchen sink-এর ১০,০০০ রো);
  কোনো পুরনো ব্যবহার বদলায় না।
- `useEndReached` — scroll event শুনে নিজে হিসাব করার বদলে virtualizer-এর শেষ আঁকা item-এর index দেখা।
  virtualizer সেটা প্রতি scroll-এ এমনিতেই হিসাব করে, আর `overscan`-এর কারণে শেষ index দৃশ্যমানের কয়েকটা
  নিচে — `END_THRESHOLD` মিলে পরের পাতা তলায় পৌঁছানোর আগেই আসে। প্রথম পাতা পর্দার চেয়ে ছোট হলে প্রথম
  render-এই শেষ index তালিকার শেষে, তাই scroll ছাড়াই পরের পাতা আসে।
- effect বারবার চললেও নিরাপদ — `onEndReached` একই পাতা দুবার চায় না (ড্যাশবোর্ডের `isFetchingNextPage`
  পাহারা, ৫.৯)। আর `onEndReached` পরিবর্তিত reference হলে effect আবার চলে — তাই caller-এর দিকে `useCallback`।
- desktop আর mobile দুটোতেই — ফোনে পুরো পেজ scroll করে (window virtualizer), ডেস্কটপে টেবিলের বাক্স; hook
  দুটোতে একই।
- `rowPaginationFeature` নেই — ধাপ ৪-এর নোট সেটা বলেছিল, কিন্তু সেটা "পাতা ১, ২, ৩" ধরনের pagination-এর জন্য
  (pageIndex, pageSize)। keyset-এ পাতার নম্বরই নেই, শুধু "পরেরটা" — তাই feature লাগে না, bundle-ও বাড়ে না।

**ফাইল: `packages/ui/src/index.ts`** (আপডেট — DataTable-এর export-এ এক শব্দ)

```ts
export {
  DataTable,
  dataTableColumns,
  dataTableFeatures,
  type DataTableColumnMeta,
  type SortingState,
} from './components/data-table.js';
```

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/ui test       # ১৬টা পাস (বদল নেই)
```

---

## ৫.৯ — `apps/app`: `call()`, TanStack Query, অনুবাদ করা ফর্ম

```bash
pnpm --filter @omnivo/app add '@tanstack/react-query@^5.104.0'
pnpm --filter @omnivo/app add -D 'msw@^2.15.0'
pnpm dedupe
```

- `@tanstack/react-query` — প্রথম লোডে ~১১ KB gz যোগ হয় (প্রথম লোড 144.6 → 156.3 KB; contracts-এর রেজিস্ট্রি সহ)।
  বাজেট 200 — যথেষ্ট জায়গা।
- `msw` dev dependency — production bundle-এ কখনো যায় না (৫.১০-এ কারণ, আর boundary নিয়ম ৫.১১-এ)।
- `pnpm dedupe` — `vitest` `msw`-কে optional peer হিসেবে চেনে; msw আসার পর pnpm সব প্যাকেজের vitest একই কপিতে
  আনতে চায়। না চালালে CI-র `pnpm dedupe --check` fail করে (যাচাইয়ের সময় ঠিক এটাই হয়েছিল)।
- pnpm-এর allow-list-এ msw-এর postinstall বন্ধ — ৫.১১-এর `pnpm-workspace.yaml`। না দিলে `pnpm install` থামে
  `ERR_PNPM_IGNORED_BUILDS` দিয়ে।

**ফাইল: `apps/app/src/lib/api.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import {
  type AuthSession,
  buildPath,
  type ErrorCode,
  isErrorCode,
  type Problem,
  problemSchema,
  type RouteDef,
  type RouteRequest,
  type RouteResult,
  routes,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { sessionStore } from './session-store';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// API-র যেকোনো ব্যর্থতা এই এক আকারে — সার্ভারের problem, নেটওয়ার্ক বন্ধ, বা চুক্তি-ভাঙা উত্তর
export class ApiRequestError extends Error {
  readonly status: number;
  // চেনা code; নতুন সার্ভারের অচেনা code হলে 'unknown_error' (তার লেখা i18n-এ আছে)
  readonly code: ErrorCode;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail);
    this.name = 'ApiRequestError';
    this.status = problem.status;
    this.code = isErrorCode(problem.code) ? problem.code : 'unknown_error';
    this.problem = problem;
  }
}

// সার্ভার problem পাঠায়নি এমন ব্যর্থতা: status 0 = request সার্ভারেই পৌঁছায়নি
function clientError(status: number, code: ErrorCode, detail: string): ApiRequestError {
  return new ApiRequestError({ title: 'Client error', status, detail, code });
}

async function toError(response: Response): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = problemSchema.safeParse(body);
  if (parsed.success) return new ApiRequestError(parsed.data);
  // প্রক্সি/লোড-ব্যালান্সারের নিজের HTML error পেজ (502, 504) — আমাদের আকারে না
  return clientError(
    response.status,
    response.status >= 500 ? 'internal_error' : 'unknown_error',
    `HTTP ${String(response.status)} without a problem body`,
  );
}

// implementation-এর ঢিলা আকার — টাইপ-চেক হয় call()-এর overload-এ, যেখানে R থেকে আসল টাইপ
interface RequestParts {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

async function send(
  route: RouteDef,
  input: RequestParts,
  accessToken: string | null,
): Promise<Response> {
  const url = new URL(`${API_URL}${buildPath(route.path, input.params)}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = new Headers();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (input.body !== undefined) headers.set('content-type', 'application/json');
  try {
    return await fetch(url, {
      method: route.method,
      headers,
      credentials: 'include',
      body: input.body === undefined ? null : JSON.stringify(input.body),
    });
  } catch {
    // fetch শুধু তখনই throw করে যখন উত্তরই আসেনি (অফলাইন, DNS, CORS)
    throw clientError(0, 'network_error', `${route.method} ${route.path} did not reach the server`);
  }
}

// উত্তর চুক্তির schema দিয়ে parse — টাইপ আসে চুক্তি থেকে, আর সার্ভার চুক্তি ভাঙলে এখানেই ধরা পড়ে।
// S = route-এর response schema-র নিজের টাইপ; R['response'] লিখলে TypeScript তার output
// বের করতে পারত না (unknown দিত), আলাদা generic প্যারামিটার হলে z.output<S> পায়
async function read<S extends z.ZodType>(
  route: RouteDef & { response: S },
  response: Response,
): Promise<z.output<S>> {
  if (!response.ok) throw await toError(response);
  const body: unknown = response.status === 204 ? undefined : await response.json();
  const parsed = route.response.safeParse(body);
  if (!parsed.success) {
    throw clientError(
      response.status,
      'unexpected_response',
      `${route.method} ${route.path} returned a body that breaks its contract`,
    );
  }
  return parsed.data;
}

// একই সময়ে যত request-ই 401 পাক, refresh একবারই যাবে — rotation-এ দ্বিতীয় refresh
// পুরনো cookie পাঠাত আর সার্ভার সেটাকে চুরি ভেবে পুরো session মুছে দিত
let refreshInFlight: Promise<AuthSession | null> | null = null;

export function refreshSession(): Promise<AuthSession | null> {
  refreshInFlight ??= navigator.locks
    // Web Locks: একই ব্রাউজারের একাধিক ট্যাবও একটার পর একটা refresh করবে, একসাথে না।
    // call() না, send() — call() নিজেই 401-এ refresh ডাকে, lock-এর ভেতর থেকে সেটা আটকে যেত
    .request('omnivo-refresh', async () => {
      const response = await send(routes.auth.refresh, {}, null);
      if (!response.ok) return null;
      return read(routes.auth.refresh, response);
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

// চুক্তিতে ইনপুট না থাকলে (বা সব ঐচ্ছিক হলে) দ্বিতীয় argument বাদ দেওয়া যায়।
// `& RequestParts`: caller-এর কাছে কিছু বদলায় না (চুক্তির টাইপ আরও কড়া), কিন্তু TypeScript এতে
// দেখতে পায় যে overload-এর ইনপুট implementation-এর RequestParts-এ বসে — cast ছাড়াই
type CallArgs<R extends RouteDef> =
  Partial<RouteRequest<R>> extends RouteRequest<R>
    ? [input?: RouteRequest<R> & RequestParts]
    : [input: RouteRequest<R> & RequestParts];

// প্রতিটা API call: call(routes.members.list, { query: { sort: '-name' } })।
// path, method, ইনপুট আর উত্তরের টাইপ — সব চুক্তি থেকে; হাতে লেখা URL বা টাইপ নেই।
// Bearer বসানো, 401 হলে একবার refresh করে আবার চেষ্টা
export function call<R extends RouteDef>(route: R, ...args: CallArgs<R>): Promise<RouteResult<R>>;
export async function call(route: RouteDef, input: RequestParts = {}): Promise<unknown> {
  const tokenBefore = sessionStore.getState().accessToken;
  let response = await send(route, input, tokenBefore);

  // টোকেন ছিল কিন্তু 401 = মেয়াদ শেষ; টোকেন ছাড়া 401 (যেমন ভুল পাসওয়ার্ড) refresh দিয়ে সারে না
  if (response.status === 401 && tokenBefore) {
    const session = await refreshSession();
    if (!session) {
      sessionStore.getState().signOut();
      throw await toError(response);
    }
    sessionStore.getState().setAccessToken(session.accessToken);
    response = await send(route, input, session.accessToken);
  }

  return read(route, response);
}
```

**কোন লাইন কেন — টাইপ:**

- **overload** (`export function call<R>(…): Promise<RouteResult<R>>;` তারপর আসল ফাংশন) — বাইরে থেকে যে ডাকে সে
  দেখে শুধু প্রথম লাইনটা: চুক্তি থেকে পুরো টাইপ। ভেতরের কোড চলে ঢিলা `RouteDef` আর `RequestParts`-এ, যেখানে
  `input.body`, `input.query` সরাসরি পড়া যায়। generic conditional টাইপের (`RouteRequest<R>`) property ভেতর থেকে
  পড়া যায় না — overload ছাড়া পথ ছিল `as` cast, যা rule ৩ নিরুৎসাহিত করে।
- `& RequestParts` — যাচাইয়ের সময় প্রথমে "This overload signature is not compatible with its implementation
  signature" (TS2394) এসেছিল: TypeScript প্রমাণ করতে পারছিল না যে `RouteRequest<R>` (যেকোনো R-এর জন্য)
  `RequestParts`-এ বসে। intersection সেটা সরাসরি সত্য বানায়; caller-এর জন্য টাইপ বদলায় না, কারণ চুক্তির টাইপ
  `RequestParts`-এর চেয়ে কড়া।
- `read<S extends z.ZodType>(route: RouteDef & { response: S })` — দ্বিতীয় বাধা: `route.response.safeParse()` যখন
  `route: R` (generic), TypeScript output-এর টাইপ দিত `unknown`। schema-টাকে আলাদা type parameter `S` বানালে
  `z.output<S>` পাওয়া যায় — ধাপ ৩-এর `apiFetch<TSchema>`-ও ঠিক এই কারণে schema আলাদা নিত।
- `CallArgs` — `Partial<X> extends X` = "সব ঐচ্ছিক"। তখন `call(routes.auth.me)` দ্বিতীয় argument ছাড়াই চলে; লগইনে
  body বাধ্যতামূলক, না দিলে "Expected 2 arguments"।

**যাচাই করা — এগুলো সব compile error** (একটা ফাঁকা ফাইলে লিখে দেখা, তারপর মোছা):

```ts
await call(routes.members.list, { query: { sort: 'nme' } }); // '"nme"' is not assignable … Did you mean '"name"'?
await call(routes.auth.login); // Expected 2 arguments, but got 1
const page = await call(routes.members.list);
page.items[0]?.fullname; // Property 'fullname' does not exist … Did you mean 'fullName'?
await call(routes.auth.me, { body: { x: 1 } }); // Type '{ x: number; }' is not assignable to type 'undefined'
```

**কোন লাইন কেন — আচরণ:**

- `ApiRequestError.code` — `isErrorCode` দিয়ে narrow; অচেনা হলে `'unknown_error'`। UI কখনো কাঁচা
  `'brand_new_code'` দেখায় না (টেস্ট আছে)।
- `clientError(0, 'network_error', …)` — ধাপ ৩-এ নেটওয়ার্ক বন্ধ মানে `fetch`-এর `TypeError`, আর
  `applyApiError`-কে আলাদা করে সেটা চিনতে হতো। এখন সব ব্যর্থতা একই class-এ, status 0 = সার্ভারে পৌঁছায়নি।
- `toError`-এর fallback — Cloudflare বা nginx-এর 502 HTML পেজ `problemSchema`-য় মেলে না; তখনও একটা
  `ApiRequestError`, বাকি কোড একই পথে চলে।
- `new URL(\`${API_URL}${…}\`)`, `new URL(path, API_URL)` না — base-এ path থাকলে (`https://x.com/api`) দ্বিতীয় রূপ
  `/api` মুছে দিত।
- `value !== undefined` বাদ — `{ cursor: undefined }` পাঠালে `?cursor=undefined` যেত (সার্ভারে সেটা একটা
  "cursor", 400 `invalid_cursor`)।
- 204-এ `response.json()` না — খালি body-তে সেটা throw করে। `undefined` দিয়ে `z.void()` parse — টাইপ `void`।
- `refreshSession`-এ `send()`, `call()` না — `call()` 401 পেলে `refreshSession()` ডাকে; lock-এর ভেতর থেকে ডাকলে
  নিজের শেষ হওয়ার অপেক্ষায় নিজেই আটকে থাকত (`refreshInFlight` একই promise)।
- বাকিটা (Web Locks, একবারই refresh, ব্যর্থ হলে signOut) ধাপ ৩ থেকে অপরিবর্তিত।

**ফাইল: `apps/app/src/lib/query-client.ts`** (নতুন ফাইল)

```ts
import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError } from './api';

// 4xx আবার চেষ্টা করলেও একই উত্তর (অনুমতি নেই, ভুল cursor) — শুধু নেটওয়ার্ক আর 5xx-এ আবার
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

// একটাই client, module-level: React-এর বাইরে (session.ts) থেকেও ক্যাশ মোছা যায়
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // ৩০ সেকেন্ড "টাটকা": পেজ বদলে ফিরে এলে সাথে সাথে ক্যাশ থেকে, পেছনে আবার আনে না
      staleTime: 30_000,
      retry: shouldRetry,
    },
  },
});
```

**কোন লাইন কেন:**

- `shouldRetry` — TanStack-এর ডিফল্ট: যেকোনো error-এ ৩ বার আবার চেষ্টা, ক্রমশ দেরিতে। 403 `permission_missing`
  তিনবার চাইলেও 403, মাঝে ৭ সেকেন্ড spinner। নেটওয়ার্ক (status 0) আর 5xx সাময়িক হতে পারে — সেখানে আবার।
- `staleTime: 30_000` — ডিফল্ট ০: প্রতিটা mount-এ পেছনে আবার আনে। টিম-তালিকা ৩০ সেকেন্ডে বদলায় না; ERP-র
  বেশিরভাগ তালিকার জন্য যুক্তিসঙ্গত। দরকারি পেজ (POS-এর স্টক) নিজের query-তে কম দেবে।
- module-level singleton — `session.ts` React component না, তবু লগআউটে ক্যাশ মুছতে হয়। `sessionStore`-এর মতো
  একই ধাঁচ (ধাপ ৩)।
- `refetchOnWindowFocus` ডিফল্টে চালু রাখা — ট্যাবে ফিরে এলে পুরনো (stale) তালিকা নিজে থেকেই হালনাগাদ।

**ফাইল: `apps/app/src/lib/session.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { type AuthSession, type LoginInput, routes, type SignUpInput } from '@omnivo/contracts';

import { call, refreshSession } from './api';
import { queryClient } from './query-client';
import { sessionStore } from './session-store';

async function startSession(session: AuthSession): Promise<void> {
  sessionStore.getState().setAccessToken(session.accessToken);
  const me = await call(routes.auth.me);
  // আগের ইউজার বা workspace-এর ক্যাশ করা ডেটা (টিম, ইনভয়েস) নতুন session-এ এক মুহূর্তের জন্যও
  // দেখা যাবে না — signIn-এর আগে মোছা, তাই নতুন পেজ খালি ক্যাশ থেকে আনে
  queryClient.clear();
  sessionStore.getState().signIn(me);
}

// পেজ reload-এ memory-র টোকেন হারায়; httpOnly cookie দিয়ে নতুন টোকেন আনা।
// module-level promise: React StrictMode বা একাধিক route একসাথে ডাকলেও refresh একবারই যায়
let restoring: Promise<void> | null = null;

export function restoreSession(): Promise<void> {
  restoring ??= (async () => {
    try {
      const session = await refreshSession();
      if (session) {
        await startSession(session);
        return;
      }
    } catch {
      // API বন্ধ বা নেটওয়ার্ক নেই — reject হলে প্রতিটা route চিরতরে ভাঙত; লগইন পেজ দেখানোই নিরাপদ,
      // সেখানে চেষ্টা করলে network_error-এর লেখা দেখাবে
    }
    sessionStore.getState().signOut();
  })();
  return restoring;
}

export async function login(input: LoginInput): Promise<void> {
  await startSession(await call(routes.auth.login, { body: input }));
}

export async function signUp(input: SignUpInput): Promise<void> {
  await startSession(await call(routes.auth.signUp, { body: input }));
}

export async function switchTenant(tenantId: string): Promise<void> {
  await startSession(await call(routes.auth.switchTenant, { body: { tenantId } }));
}

export async function logout(): Promise<void> {
  try {
    await call(routes.auth.logout);
  } finally {
    // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
    queryClient.clear();
    sessionStore.getState().signOut();
  }
}
```

**কোন লাইন কেন:**

- `queryClient.clear()` `startSession`-এ — লগইন, সাইনআপ, **workspace বদল** তিনটাই এখান দিয়ে যায়। সবচেয়ে জরুরি
  workspace বদল: ক্যাশে Rahman Garments-এর টিম; Karim Pharma-তে গেলে পুরনো তালিকা এক ঝলকও দেখা গেলে সেটা
  টেন্যান্ট-ফাঁস (system-design §৪-এর মূল নিয়ম)। query key-তেও `tenantId` আছে (ড্যাশবোর্ড) — দুই স্তরের পাহারা।
- `signIn`-এর **আগে** clear — `signIn` store বদলায়, React নতুন workspace নিয়ে render করে; তখন ক্যাশ ইতিমধ্যে
  খালি। উল্টো ক্রমে একটা render পুরনো ক্যাশ দেখতে পেত।
- লগআউটের `finally`-তে clear — পরের জন আগের জনের ডেটা পায় না, একই ব্রাউজারে (দোকানের শেয়ার করা কম্পিউটার)।
- `call(routes.auth.logout)` — ধাপ ৩-এর আলাদা `logoutRequest()` আর লাগে না।

**ফাইল: `apps/app/src/lib/field-errors.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import { isErrorCode } from '@omnivo/contracts';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiRequestError } from './api';

// সার্ভারের error → react-hook-form: fieldErrors থাকলে সেই ফিল্ডের নিচে, নয়তো ফর্মের উপরে
// ('root.server' — পরের submit-এ react-hook-form নিজেই মুছে দেয়)। message-এ code রাখা হয়,
// লেখা না: ui-র Field/FormAlert সেটা বর্তমান ভাষায় দেখায়, ভাষা বদলালে সাথে সাথে বদলায়
export function applyApiError<TValues extends FieldValues>(
  error: unknown,
  // schema.keyof().options থেকে — সার্ভারের পাঠানো string নামকে টাইপ-চেকড ফিল্ড নামে মেলাতে
  fieldNames: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): void {
  // ApiRequestError না = আমাদের নিজের কোডের bug (নেটওয়ার্কও ApiRequestError হয়ে আসে)
  if (!(error instanceof ApiRequestError)) {
    setError('root.server', { message: 'unknown_error' });
    return;
  }
  let placed = false;
  for (const [field, codes] of Object.entries(error.problem.fieldErrors ?? {})) {
    // find: cast ছাড়াই string → Path<TValues>; ফর্মে নেই এমন নাম বাদ পড়ে
    const name = fieldNames.find((candidate) => candidate === field);
    const code = codes[0];
    if (name && code !== undefined) {
      setError(name, { message: isErrorCode(code) ? code : 'invalid_value' });
      placed = true;
    }
  }
  if (!placed) setError('root.server', { message: error.code });
}
```

**কী বদলাল, আর কেন:**

- `message`-এ এখন code — react-hook-form-এর error-এর জায়গা একটাই (`message: string`), আর আমরা সেখানে লেখা না
  রেখে code রাখছি। লেখা হয় render-এর সময় (৫.৮)। যাচাই করা: ভুল পাসওয়ার্ডের বাংলা error দেখানো অবস্থায় "English"
  চাপলে সেই মুহূর্তেই "Email or password is incorrect…"।
- ধাপ ৪-এর `'Could not reach the server…'` গেছে — নেটওয়ার্ক এখন `ApiRequestError` (`network_error`), তাই বাকি
  সব error-এর মতো একই পথে।
- ফিল্ডের code-ও `isErrorCode` দিয়ে যাচাই — সার্ভার ফিল্ডে অচেনা code পাঠালে `invalid_value` ("সঠিক মান দিন"),
  কাঁচা code না।

**ফাইল: `apps/app/src/routes/dashboard.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import { CheckmarkCircle02Icon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Member, type MemberSort, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  DataTable,
  dataTableColumns,
  PageHeader,
  SectionHeader,
  type SortingState,
} from '@omnivo/ui';
import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { call } from '../lib/api';
import { useSession } from '../lib/session-store';

// module-level: প্রতি render-এ নতুন helper বানানোর দরকার নেই
const column = dataTableColumns<Member>();

// query-র key আর কীভাবে আনবে এক জায়গায় — অন্য পেজও (যেমন ধাপ ৭-এর invite মডাল) একই key দিয়ে
// ক্যাশ মুছতে বা আগে থেকে আনতে পারবে
function membersQuery(tenantId: string, sort: MemberSort) {
  return infiniteQueryOptions({
    // tenantId key-তে: workspace বদলালে আগের টেন্যান্টের পাতা এই key-তে কখনো মিলবে না
    queryKey: ['members', tenantId, sort],
    // pageParam-এর টাইপ লেখা: শুধু initialPageParam: null থেকে TanStack ভাবত পাতার cursor সবসময়
    // null, আর getNextPageParam-এর string মেলাত না। এখান থেকে সে string | null শেখে — cast ছাড়া
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.members.list, {
        query: { sort, limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    // null = শেষ পাতা; TanStack তখন hasNextPage = false
    getNextPageParam: (page) => page.nextCursor,
    // sort বদলালে নতুন key — নতুন পাতা আসা পর্যন্ত আগেরটা দেখানো, টেবিল ফাঁকা হয়ে ঝলকায় না
    placeholderData: keepPreviousData,
  });
}

function MembersSection({ tenantId }: { tenantId: string }) {
  const { t } = useLocale();
  const [sort, setSort] = useState<MemberSort>('name');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    membersQuery(tenantId, sort),
  );

  // সব পাতা জোড়া একটা তালিকা; data না বদলালে একই array, তাই টেবিল অকারণে আবার হিসাব করে না
  const members = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    // চলতি request শেষ না হলে আবার না — নাহলে একই cursor দুবার চাওয়া হতো
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // টেবিলের sort অবস্থা ↔ API-র sort প্যারামিটার। শুধু নাম-কলাম সার্ভারে sort হয়
  const sorting = useMemo(
    () => ({
      state: [{ id: 'fullName', desc: sort === '-name' }],
      onChange: (next: SortingState) => {
        setSort(next[0]?.desc ? '-name' : 'name');
      },
    }),
    [sort],
  );

  // header-এ অনুবাদ আছে, তাই ভাষা (t) বদলালে column নতুন করে; নাহলে একই array — টেবিল আবার হিসাব করে না
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('fullName', {
          header: t('dashboard.columns.member'),
          meta: { card: 'title' },
          // CLAUDE.md → Table: প্রথম কলামে ৩০px avatar tile + নাম + ink-3 সাব-লাইন
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
                {row.original.fullName.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{row.original.fullName}</span>
                <span className="block truncate text-caption text-ink-3">{row.original.email}</span>
              </span>
            </span>
          ),
        }),
        column.accessor((member) => member.roles.join(', '), {
          id: 'roles',
          header: t('dashboard.columns.roles'),
          // সার্ভার রোল দিয়ে সাজাতে পারে না (চুক্তিতে শুধু name) — তাই হেডারে sort বাটনই নেই
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => getValue() || t('dashboard.noRole'),
        }),
      ]),
    [t],
  );

  return (
    // DataTable নিজেই কার্ড — তাই Card-এ না মুড়ে শুধু শিরোনাম + টেবিল
    <section className="grid gap-3">
      <SectionHeader title={t('dashboard.teamTitle')} subtitle={t('dashboard.teamSubtitle')} />
      {isError ? (
        <p className="text-body-sm text-crit">{t('dashboard.teamLoadFailed')}</p>
      ) : (
        members && (
          <DataTable
            label={t('dashboard.teamTitle')}
            data={members}
            columns={columns}
            getRowId={(member) => member.membershipId}
            sorting={sorting}
            onEndReached={loadMore}
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('dashboard.loadingMore')}</p>
              )
            }
          />
        )
      )}
    </section>
  );
}

export function DashboardPage() {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  if (!me) return null;

  // UI-তে permission দেখে লুকানো শুধু সুবিধা; আসল পাহারা API-র PermissionGuard
  const canSeeTeam = me.permissions.includes('core.user.read');

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('dashboard.title')}
        description={`${me.tenant.name} · ${format.date(new Date())}`}
      />

      <Card className="p-8 text-center">
        <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-good-bg text-good">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={26} strokeWidth={1.5} />
        </span>
        <h2 className="mt-4 text-h2">{t('dashboard.readyTitle')}</h2>
        <p className="mx-auto mt-2 max-w-md text-ink-2">{t('dashboard.readyBody')}</p>
      </Card>

      {canSeeTeam ? (
        <MembersSection tenantId={me.tenant.id} />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          {t('dashboard.teamPermissionHint')}
        </p>
      )}
    </div>
  );
}
```

**কী বদলাল, আর কেন:**

- `useEffect` + `useState` + `cancelled` ফ্ল্যাগ মুছে `useInfiniteQuery` — race (পুরনো উত্তর দেরিতে আসা), একই পাতা
  দুবার না চাওয়া, retry, ক্যাশ — সব লাইব্রেরি সামলায়। ধাপ ৪-এর নোটে এটাই বলা ছিল।
- `infiniteQueryOptions(...)` আলাদা ফাংশনে — key আর `queryFn` এক জায়গায়, টাইপ-সহ। ধাপ ৭-এ কাউকে invite করার পর
  `queryClient.invalidateQueries({ queryKey: ['members'] })` দিয়ে এই তালিকা নতুন করে আনা হবে।
- `queryKey: ['members', tenantId, sort]` — TanStack-এর নিয়ম: যা বদলালে উত্তর বদলায় তা key-তে (v9-এর নির্দেশিকার
  "HIGH: Omitting state from the query key")। `sort` না থাকলে sort বদলালেও পুরনো ক্যাশ দেখাত।
- `({ pageParam }: { pageParam: string | null })` — যাচাইয়ের সময় `initialPageParam: null` থেকে TanStack
  `TPageParam`-কে শুধু `null` ধরেছিল, আর `getNextPageParam` string ফেরত দেওয়ায় "Type 'string' is not assignable
  to type 'null'"। প্যারামিটারের টাইপ লিখে দিলে inference সেখান থেকে `string | null` শেখে — `null as string | null`
  cast ছাড়া।
- `...(pageParam !== null && { cursor: pageParam })` — প্রথম পাতায় `cursor` key-টাই যায় না।
- `placeholderData: keepPreviousData` — `infiniteQueryOptions`-এর **ভেতরে**। বাইরে (`useInfiniteQuery({ ...options,
  placeholderData })`) spread করলে `exactOptionalPropertyTypes`-এ `initialData`-র টাইপে error এসেছিল।
- `members` `useMemo`-তে — DataTable-এর নিয়ম (ধাপ ৪.৭): `data`-র reference স্থির। প্রতি render-এ নতুন
  `flatMap` দিলে প্রতিবার টেবিল নতুন করে হিসাব করত।
- `loadMore`-এ `useCallback` — DataTable-এর `useEndReached` effect-এর dependency; স্থির না হলে প্রতি render-এ effect।
- `sorting.state: [{ id: 'fullName', desc }]` — `id` = column-এর accessor-এর নাম। `next[0]?.desc` — উল্টো-ক্রম
  চাইলে `-name`; `enableSortingRemoval: false` থাকায় খালি array আসে না, তবু আসলে `'name'`।
- `enableSorting: false` রোল-কলামে — চুক্তিতে সার্ভার-sort শুধু নাম। বাটন দেখালে ক্লিক করলে কিছুই হতো না।
- `footer` — পরের পাতা আসার সময় টেবিলের নিচে "Loading more…"।

**ফাইল: `apps/app/src/components/language-switch.tsx`** (নতুন ফাইল)

```tsx
import { LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
import { SegmentedControl } from '@omnivo/ui';

const OPTIONS = LANGUAGES.map((language) => ({ value: language.code, label: language.label }));

// লগইনের আগে user মেনু নেই — তাই লগইন আর সাইনআপ পেজে সরাসরি দুই ভাষার বোতাম।
// value-র টাইপ LANGUAGES থেকে ('en' | 'bn'), তাই setLanguage-এ cast লাগে না
export function LanguageSwitch() {
  const { t, language } = useLocale();
  return (
    <SegmentedControl
      label={t('common.language')}
      value={language}
      options={OPTIONS}
      onChange={(next) => {
        void setLanguage(next);
      }}
    />
  );
}
```

- `SegmentedControl` (ধাপ ৪), `DropdownMenu` না — দুটো মাত্র বিকল্প, এক ক্লিকে বদল; আর Radix মেনু (~৩১ KB gz) লগইন
  পেজের chunk-এ ঢুকত না।
- `OPTIONS` module-level — প্রতি render-এ নতুন array না।
- generic `SegmentedControl<TValue>` `OPTIONS` থেকে `'en' | 'bn'` শেখে, তাই `onChange`-এর `next` সরাসরি
  `setLanguage`-এ যায়।

**ফাইল: `apps/app/src/routes/login.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import {
  Building03Icon,
  DeliveryTruck01Icon,
  FactoryIcon,
  LockPasswordIcon,
  Mail01Icon,
  Medicine02Icon,
  TShirtIcon,
  ViewIcon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, loginInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Checkbox, FormAlert, Logo, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { AuthPreview } from '../components/auth-preview';
import { LanguageSwitch } from '../components/language-switch';
import { applyApiError } from '../lib/field-errors';
import { login } from '../lib/session';

// key-টা অনুবাদের, লেখা না — ভাষা বদলালে সাথে সাথে বদলায়
const INDUSTRIES = [
  { icon: TShirtIcon, key: 'garments' },
  { icon: Medicine02Icon, key: 'pharma' },
  { icon: DeliveryTruck01Icon, key: 'distribution' },
  { icon: FactoryIcon, key: 'manufacturing' },
] as const;

export function LoginPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই নিয়ম, একই code।
  // contractErrorMap: schema যেখানে নিজে code দেয়নি সেখানে Zod-এর ইংরেজি মেসেজের বদলে code
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginInputSchema, { error: contractErrorMap }),
    defaultValues: { workspace: '', email: '', password: '', keepSignedIn: true },
  });

  // handleSubmit: আগে Zod যাচাই, পাস করলে তবেই এই ফাংশন — values-এর টাইপ LoginInput
  // (trim/lowercase হয়ে গেছে)। চলার সময় isSubmitting নিজে থেকেই true
  const onSubmit = handleSubmit(async (values) => {
    try {
      await login(values);
      await navigate({ to: '/' });
    } catch (error) {
      applyApiError(error, loginInputSchema.keyof().options, setError);
    }
  });

  return (
    <div className="grid min-h-dvh bg-surface min-[1040px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className="flex flex-col px-4 py-8 sm:px-16">
        <Logo />
        <div className="grid flex-1 place-items-center py-10">
          <div className="w-full max-w-[380px]">
            <h1 className="text-[28px] leading-[1.2]">{t('auth.login.title')}</h1>
            <p className="mt-2 text-ink-2">{t('auth.login.subtitle')}</p>

            <form
              noValidate
              onSubmit={(event) => void onSubmit(event)}
              className="mt-8 grid gap-[18px]"
            >
              {/* message-এ code; FormAlert আর TextField নিজেরাই বর্তমান ভাষায় লেখে */}
              {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
              <TextField
                label={t('auth.workspace')}
                icon={Building03Icon}
                suffix=".omnivo.app"
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                // উদাহরণ ঠিকানা — ঠিকানা সবসময় ইংরেজি অক্ষরে, তাই অনুবাদ নেই
                placeholder="rahman-garments"
                {...register('workspace')}
                error={errors.workspace?.message}
              />
              <TextField
                label={t('auth.email')}
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label={t('auth.password')}
                icon={LockPasswordIcon}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder={t('auth.login.passwordPlaceholder')}
                {...register('password')}
                error={errors.password?.message}
                trailing={
                  <button
                    type="button"
                    aria-label={
                      showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
                    }
                    onClick={() => {
                      setShowPassword(!showPassword);
                    }}
                    className="-mr-1.5 grid place-items-center rounded-md p-1.5 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
                  >
                    <HugeiconsIcon
                      icon={showPassword ? ViewOffIcon : ViewIcon}
                      size={17}
                      strokeWidth={1.5}
                    />
                  </button>
                }
              />
              {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
              <Controller
                control={control}
                name="keepSignedIn"
                render={({ field }) => (
                  <Checkbox
                    id="keepSignedIn"
                    label={t('auth.login.keepSignedIn')}
                    checked={field.value}
                    // Radix-এর মান true | false | 'indeterminate' — আমাদের schema শুধু boolean
                    onCheckedChange={(checked) => {
                      field.onChange(checked === true);
                    }}
                  />
                )}
              />
              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? t('auth.login.submitting') : t('auth.login.submit')}
              </Button>
            </form>

            <p className="mt-7 text-center text-body-sm text-ink-2">
              {t('auth.login.newHere')}{' '}
              <Link
                to="/sign-up"
                className="font-medium text-brand underline-offset-[3px] hover:underline"
              >
                {t('auth.login.createWorkspace')}
              </Link>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12.5px] text-ink-3">© 2026 Omnivo Technologies</p>
          <LanguageSwitch />
        </div>
      </section>

      <aside
        aria-label={t('auth.login.panelLabel')}
        className="relative m-3 ml-0 hidden flex-col justify-center gap-10 overflow-hidden rounded-panel border border-brand-line bg-brand-soft px-[clamp(24px,5vw,72px)] py-14 min-[1040px]:flex"
      >
        <div aria-hidden="true" className="auth-grid pointer-events-none absolute inset-0" />
        {/* গ্রিড absolute, তাই লেখাকেও relative না দিলে লাইন লেখার উপরে আঁকা হতো */}
        <div className="relative max-w-lg">
          <h2 className="text-display tracking-[-0.03em]">{t('auth.login.panelTitle')}</h2>
          <p className="mt-3 max-w-md text-[15px] text-ink-2">{t('auth.login.panelBody')}</p>
          <ul className="mt-[18px] flex flex-wrap gap-2">
            {INDUSTRIES.map((industry) => (
              <li
                key={industry.key}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2"
              >
                <HugeiconsIcon
                  icon={industry.icon}
                  size={14}
                  strokeWidth={1.5}
                  className="text-brand"
                />
                {t(`auth.login.industries.${industry.key}`)}
              </li>
            ))}
          </ul>
        </div>
        <AuthPreview />
      </aside>
    </div>
  );
}
```

**কী বদলাল, আর কেন:**

- `zodResolver(loginInputSchema, { error: contractErrorMap })` — দ্বিতীয় argument Zod-এর parse option হিসেবে যায়।
  schema-য় নিজের code থাকলে সেটাই (`slug_too_short`), না থাকলে map-এর (`keepSignedIn` → `required`)। সার্ভারের
  `parseInput` একই map নেয় — তাই ব্রাউজার আর সার্ভার একই ভুলে **হুবহু একই code** দেয়।
- সব লেখা `t()`-তে; placeholder-এর উদাহরণ (`rahman-garments`, `name@company.com`) ছাড়া — মন্তব্যে কারণ।
- `INDUSTRIES` — আগে `label: 'Garments & textiles'`, এখন অনুবাদের key। `as const` — `industry.key`-এর টাইপ
  `'garments' | …`, তাই `` t(`auth.login.industries.${industry.key}`) `` টাইপ-চেকড (বানান ভুল compile error)।
- নিচের সারিতে `LanguageSwitch` — © লেখার পাশে, `flex-wrap`: ফোনে জায়গা না থাকলে নিচে নামে।
- `h1`-এর `text-[28px]` — CLAUDE.md-এর "auth form: 28px" ব্যতিক্রম; ধাপ ৪ থেকে অপরিবর্তিত।

**ফাইল: `apps/app/src/routes/sign-up.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import {
  Building03Icon,
  Globe02Icon,
  LockPasswordIcon,
  Mail01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, signUpInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, FormAlert, Logo, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';

import { LanguageSwitch } from '../components/language-switch';
import { applyApiError } from '../lib/field-errors';
import { signUp } from '../lib/session';

// "Rahman Garments Ltd." → "rahman-garments" (Workspace Setup mockup-এর নিয়ম)
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function SignUpPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getFieldState,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(signUpInputSchema, { error: contractErrorMap }),
    defaultValues: { companyName: '', workspaceSlug: '', fullName: '', email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await signUp(values);
      await navigate({ to: '/' });
    } catch (error) {
      applyApiError(error, signUpInputSchema.keyof().options, setError);
    }
  });

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-5 sm:px-10">
        <Logo />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <p className="text-body-sm text-ink-2">
            {t('auth.signUp.haveWorkspace')}{' '}
            <Link
              to="/login"
              className="font-medium text-brand underline-offset-[3px] hover:underline"
            >
              {t('auth.signUp.signIn')}
            </Link>
          </p>
          <LanguageSwitch />
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-4 pt-10 pb-16">
        <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
          <h1 className="text-h2">{t('auth.signUp.title')}</h1>
          <p className="mt-1.5 text-ink-2">{t('auth.signUp.subtitle')}</p>

          <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-7 grid gap-5">
            {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
            <TextField
              label={t('auth.signUp.companyName')}
              icon={Building03Icon}
              autoComplete="organization"
              // উদাহরণ ডেটা (নাম, ঠিকানা, ইমেইল) — দুই ভাষাতেই একই, তাই অনুবাদের ফাইলে না
              placeholder="Rahman Garments Ltd."
              {...register('companyName', {
                // ইউজার নিজে ঠিকানায় হাত দিলে (isDirty) আর অটো-বসানো হবে না — আলাদা
                // "slugTouched" state লাগে না। setValue ডিফল্টে dirty বানায় না, তাই অটো-বসানো
                // মান পরের অক্ষরে আবার বদলাতে পারে
                onChange: (event: ChangeEvent<HTMLInputElement>) => {
                  if (!getFieldState('workspaceSlug').isDirty) {
                    setValue('workspaceSlug', slugify(event.target.value));
                  }
                },
              })}
              error={errors.companyName?.message}
            />
            <TextField
              label={t('auth.signUp.workspaceAddress')}
              icon={Globe02Icon}
              suffix=".omnivo.app"
              // ফোনের কীবোর্ড প্রথম অক্ষর বড় হাতের না করে; বাকিটা schema-র toLowerCase() সামলায়
              autoCapitalize="none"
              spellCheck={false}
              placeholder="rahman-garments"
              {...register('workspaceSlug')}
              error={errors.workspaceSlug?.message}
            />
            <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
              <TextField
                label={t('auth.signUp.fullName')}
                icon={UserIcon}
                autoComplete="name"
                placeholder="Farhana Rahman"
                {...register('fullName')}
                error={errors.fullName?.message}
              />
              <TextField
                label={t('auth.signUp.workEmail')}
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                {...register('email')}
                error={errors.email?.message}
              />
            </div>
            <TextField
              label={t('auth.password')}
              icon={LockPasswordIcon}
              type="password"
              autoComplete="new-password"
              placeholder={t('auth.signUp.passwordPlaceholder')}
              {...register('password')}
              error={errors.password?.message}
            />

            <div className="mt-2 flex justify-end border-t border-line pt-6">
              <Button
                type="submit"
                disabled={isSubmitting}
                className="w-full sm:w-auto sm:min-w-40"
              >
                {isSubmitting ? t('auth.signUp.submitting') : t('auth.signUp.submit')}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
```

- লগইনের মতোই: `contractErrorMap`, সব লেখা `t()`-তে, `LanguageSwitch` হেডারে "Already have a workspace?"-এর পাশে
  (`flex-wrap`: ফোনে নিচে নামে)।
- `slugify` আর dirty-নিয়ম ধাপ ৪ থেকে অপরিবর্তিত।

**ফাইল: `apps/app/src/main.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import './styles.css';
// প্রথম render-এর আগে i18n init — নাহলে প্রথম ঝলকে key ("nav.overview") দেখা যেত
import '@omnivo/i18n';

import { Toaster } from '@omnivo/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { API_URL } from './lib/api';
import { queryClient } from './lib/query-client';
import { router } from './router';

// `pnpm dev:mock` (vite --mode mock): আসল API ছাড়াই, MSW-এর বানানো উত্তরে পুরো UI।
// production build-এ DEV = false বসে, minifier পুরো শাখা আর import() মুছে দেয় — msw bundle-এ যায় না
async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.MODE !== 'mock') return;
  const { worker } = await import('./mocks/browser');
  await worker.start({
    // API-র যে request-এর mock নেই সেটা console-এ error; font, Vite-এর HMR ইত্যাদি চুপচাপ যেতে দেওয়া
    onUnhandledRequest(request, print) {
      if (request.url.startsWith(API_URL)) print.error();
    },
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

// worker চালু হওয়ার পরে render — নাহলে প্রথম request (session ফেরানো) mock-এর আগেই বেরিয়ে যেত
void enableMocking().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
      {/* রুটের বাইরে: পেজ বদলালেও চলতি toast মুছে যায় না */}
      <Toaster />
    </StrictMode>,
  );
});
```

**কোন লাইন কেন:**

- `QueryClientProvider` `RouterProvider`-এর বাইরে — প্রতিটা পেজ (router-এর ভেতরে) একই ক্যাশ দেখে।
- `import.meta.env.DEV && MODE === 'mock'` — দুই শর্ত: `vite build --mode mock` কেউ ভুল করে চালালেও `DEV` false,
  তাই production bundle-এ কখনো না। build-এ Vite `DEV`-কে `false` বসায়, শর্ত `if (true) return` হয়ে যায়, আর
  minifier বাকিটা (`import()` সহ) মুছে দেয়। যাচাই করা: production `dist`-এর কোনো JS-এ msw-এর কোড নেই, manifest-এ
  `mocks/` নেই।
- `await worker.start()`-এর পরে render — service worker চালু হতে সময় লাগে; আগে render করলে `restoreSession()`-এর
  প্রথম request আসল নেটওয়ার্কে (বন্ধ API-তে) চলে যেত।
- `onUnhandledRequest` — MSW ডিফল্টে সব অচেনা request-এ সতর্ক করে, font আর Vite-এর নিজের ফাইলসহ। শুধু API-র
  ঠিকানায় যা mock-হীন তা error — নতুন endpoint যোগ করে handler ভুলে গেলে সাথে সাথে চোখে পড়ে।

---

## ৫.১০ — MSW: চুক্তি থেকে mock

**ফাইল: `apps/app/src/mocks/mock.ts`** (নতুন ফাইল)

```ts
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
```

**কোন লাইন কেন:**

- `mock(route, resolver)` — URL আর method চুক্তি থেকে। চুক্তিতে `/members` → `/team` হলে mock নিজে থেকেই নতুন
  ঠিকানায়; হাতে লেখা URL-এর mock চুপচাপ পুরনো ঠিকানায় থেকে যেত, আর `onUnhandledRequest` error দিত।
- `reply(route, data)` — `data: RouteResponse<R>` মানে fixture-এ ভুল ফিল্ড compile error; তার উপর
  `route.response.parse(data)` runtime-এ। `Response.json` (web-standard) — MSW-এর `HttpResponse`-এর টাইপ generic
  `data` নিতে ঝামেলা করত, আর MSW সাধারণ `Response`-ও নেয়।
- `problem()` — mock-এর error-ও আসল API-র আকারে, তাই `pnpm dev:mock`-এ UI-র error-পথ (ফিল্ডের নিচে, ফর্মের উপরে)
  আসল API ছাড়াই দেখা যায়।
- `readQuery`/`readBody` — `readQuery(routes.members.list.query, request)` দেয় `{ limit: number, sort: 'name' |
  '-name', cursor?: string }`, আসল সার্ভারের মতো coerce আর default সহ। schema generic `S` — `read()`-এর মতোই
  (৫.৯) output টাইপ পেতে।

**ফাইল: `apps/app/src/mocks/fixtures.ts`** (নতুন ফাইল)

```ts
import type { Member, MeResponse } from '@omnivo/contracts';

// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে
export const WORKSPACES = [
  { tenantId: crypto.randomUUID(), name: 'Rahman Garments Ltd.', slug: 'rahman-garments' },
  { tenantId: crypto.randomUUID(), name: 'Karim Pharma', slug: 'karim-pharma' },
] as const;

export type Workspace = (typeof WORKSPACES)[number];

const owner = {
  id: crypto.randomUUID(),
  email: 'farhana@rahmangarments.com',
  fullName: 'Farhana Rahman',
};

export function meIn(workspace: Workspace): MeResponse {
  return {
    user: owner,
    tenant: { id: workspace.tenantId, name: workspace.name, slug: workspace.slug },
    roles: ['Owner'],
    permissions: ['core.role.manage', 'core.user.invite', 'core.user.read'],
    memberships: [...WORKSPACES],
  };
}

const FIRST = ['Abdul', 'Nasrin', 'Shafiq', 'Rupa', 'Tanvir', 'Sharmin', 'Mahbub', 'Farzana'];
const LAST = ['Karim', 'Akter', 'Islam', 'Hossain', 'Rahman', 'Chowdhury', 'Sarkar', 'Begum'];
const ROLES = [['Accountant'], ['Merchandiser'], ['Store keeper'], [], ['Production manager']];

// ২৪০ জন: এক পাতায় ৫০, তাই ড্যাশবোর্ডে scroll করলে পরের পাতাগুলো আসতে দেখা যায়
export const MEMBERS: Member[] = Array.from({ length: 240 }, (_, index) => {
  const first = FIRST[index % FIRST.length] ?? 'Abdul';
  const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Karim';
  return {
    membershipId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    fullName: `${first} ${last}`,
    email: `${first}.${last}${String(index)}@rahmangarments.com`.toLowerCase(),
    roles: ROLES[index % ROLES.length] ?? [],
  };
});
```

- `crypto.randomUUID()` — চুক্তিতে id গুলো `z.uuid()`, তাই fixture-এও আসল UUID (নাহলে `reply()`-এর parse fail)।
  প্রতি page load-এ নতুন, কিন্তু এক session-এ স্থির — mock-এর জন্য যথেষ্ট।
- ২৪০ জন আর দুই workspace — আসল API-তে (সাইনআপের পরে একজন) infinite scroll আর workspace switcher দেখাই যায় না।
- `?? 'Abdul'` — `noUncheckedIndexedAccess`-এ array-র index `string | undefined`; modulo দিয়ে কখনো বাইরে যায় না,
  কিন্তু TypeScript সেটা জানে না — `!` (non-null assertion) না লিখে নিরাপদ default।

**ফাইল: `apps/app/src/mocks/handlers.ts`** (নতুন ফাইল)

```ts
import { type AuthSession, routes } from '@omnivo/contracts';
import { delay } from 'msw';

import { MEMBERS, meIn, WORKSPACES, type Workspace } from './fixtures';
import { mock, problem, readBody, readQuery, reply } from './mock';

// mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
let signedIn = true;
let workspace: Workspace = WORKSPACES[0];

function session(): AuthSession {
  return {
    accessToken: `mock-${crypto.randomUUID()}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
// সাইনআপে ঠিকানা "rahman-garments" → slug_taken
export const handlers = [
  mock(routes.health.check, () => reply(routes.health.check, { status: 'ok' })),

  mock(routes.auth.refresh, () =>
    signedIn ? reply(routes.auth.refresh, session()) : problem(401, 'session_ended'),
  ),

  mock(routes.auth.me, () => reply(routes.auth.me, meIn(workspace))),

  mock(routes.auth.login, async ({ request }) => {
    const body = await readBody(routes.auth.login.body, request);
    await delay();
    if (body.password === 'wrong-password') return problem(401, 'invalid_credentials');
    signedIn = true;
    return reply(routes.auth.login, session());
  }),

  mock(routes.auth.signUp, async ({ request }) => {
    const body = await readBody(routes.auth.signUp.body, request);
    await delay();
    if (body.workspaceSlug === WORKSPACES[0].slug) {
      return problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] });
    }
    signedIn = true;
    return reply(routes.auth.signUp, session());
  }),

  mock(routes.auth.switchTenant, async ({ request }) => {
    const { tenantId } = await readBody(routes.auth.switchTenant.body, request);
    const target = WORKSPACES.find((candidate) => candidate.tenantId === tenantId);
    if (!target) return problem(403, 'switch_denied');
    workspace = target;
    return reply(routes.auth.switchTenant, session());
  }),

  mock(routes.auth.logout, () => {
    signedIn = false;
    return reply(routes.auth.logout, undefined);
  }),

  mock(routes.members.list, async ({ request }) => {
    const query = readQuery(routes.members.list.query, request);
    // আসল API keyset ব্যবহার করে; mock-এ cursor শুধু একটা offset — ক্লায়েন্টের কাছে দুটোই অস্বচ্ছ
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const sorted = MEMBERS.toSorted((a, b) => a.fullName.localeCompare(b.fullName));
    if (query.sort === '-name') sorted.reverse();
    const items = sorted.slice(start, start + query.limit);
    const end = start + items.length;
    // পাতার মাঝে একটু দেরি — "Loading more…" চোখে দেখা যায়
    await delay(400);
    return reply(routes.members.list, {
      items,
      nextCursor: end < sorted.length ? String(end) : null,
    });
  }),
];
```

**কোন লাইন কেন:**

- `signedIn = true` শুরুতে — `pnpm dev:mock` খুললেই `restoreSession()`-এর refresh সফল, সোজা ড্যাশবোর্ড।
  সাইন আউট করলে `false`, তখন লগইন পেজ। reload-এ module আবার চলে, তাই আবার সাইন-ইন অবস্থা (যাচাইয়ের সময় এটা
  চোখে পড়েছিল — ইচ্ছাকৃত, মন্তব্যে লেখা)।
- `'wrong-password'`, `'rahman-garments'` — UI-র error-পথ দেখার সহজ দরজা, আসল সার্ভার লাগে না।
- `routes.auth.login.body` — `readBody`-কে একই schema; লগইন ফর্মে যা পাঠানো হয় mock ঠিক সেটা পড়ে (trim করা ইমেইল)।
- `await delay()` — MSW-এর "বাস্তব মতো" দেরি (~১০০–৪০০ms); বাটনের "Signing in…" অবস্থা দেখা যায়।
- `toSorted` — নতুন array ফেরত দেয়, `MEMBERS` বদলায় না (`sort()` আসল array-টাই উল্টে দিত, পরের request ভুল ক্রম
  পেত)। ES2023, app-এর `lib`-এ আছে।
- `reply(routes.auth.logout, undefined)` — চুক্তিতে `z.void()`, তাই `data`-র টাইপ `void`; 204।

**ফাইল: `apps/app/src/mocks/browser.ts`** (নতুন ফাইল)

```ts
import { setupWorker } from 'msw/browser';

import { handlers } from './handlers';

// ব্রাউজারের service worker (public/mockServiceWorker.js) request গুলো মাঝপথে ধরে handler-এর
// উত্তর দেয় — app-এর কোড ভাবে আসল API-র সাথেই কথা বলছে, fetch-এ কিছু বদলাতে হয় না
export const worker = setupWorker(...handlers);
```

**MSW-এর service worker ফাইল:**

```bash
pnpm --filter @omnivo/app exec msw init public --no-save
```

- `apps/app/public/mockServiceWorker.js` তৈরি হয় — MSW-এর নিজের ফাইল, হাতে বদলানো হয় না। commit করুন।
- `--no-save` — ডিফল্টে `msw init` app-এর `package.json`-এ `"msw": { "workerDirectory": … }` লেখে, যাতে msw-এর
  postinstall প্রতি install-এ ফাইলটা হালনাগাদ করে। আমরা সেই postinstall বন্ধ রাখছি (৫.১১), তাই এই key অর্থহীন।
  **msw-এর version বাড়ালে এই কমান্ড আবার চালাবেন** — ফাইল পুরনো হলে ব্রাউজারের console-এ MSW নিজেই সতর্ক করে।
- কেন `public/`-এ: service worker যে path-এ থাকে তার নিচের request-ই ধরতে পারে; `/` থেকে সব ধরতে হলে ফাইলটা
  সাইটের মূলে লাগে। দাম — production `dist`-এও কপি হয় (উপরের "ইচ্ছাকৃতভাবে নেই" টেবিল)।

**ফাইল: `apps/app/package.json`** (আপডেট — `scripts`-এ এক লাইন)

```json
    "dev:mock": "vite --mode mock",
```

- `--mode mock` — Vite-এর `import.meta.env.MODE` হয় `'mock'`; `DEV` তবু `true` (dev server)। আলাদা `.env.mock`
  ফাইল লাগে না — `.gitignore`-এর `.env.*` নিয়মে সেটা commit-ই হতো না।

### app-এর টেস্ট (Node-এ MSW)

**ফাইল: `apps/app/src/lib/api.spec.ts`** (নতুন ফাইল)

```ts
import { routes } from '@omnivo/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MEMBERS } from '../mocks/fixtures';
import { mock, problem, reply } from '../mocks/mock';
import { API_URL, ApiRequestError, call } from './api';
import { sessionStore } from './session-store';

// Node-এ MSW: fetch মাঝপথে ধরে — ব্রাউজারের একই handler, service worker ছাড়া
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  sessionStore.getState().signOut();
});

const page = { items: MEMBERS.slice(0, 2), nextCursor: 'next' };

describe('call', () => {
  it('builds the URL from the contract and returns the parsed response', async () => {
    let url = '';
    server.use(
      mock(routes.members.list, ({ request }) => {
        url = request.url;
        return reply(routes.members.list, page);
      }),
    );
    const result = await call(routes.members.list, { query: { sort: '-name', limit: 2 } });
    expect(url).toBe(`${API_URL}/members?sort=-name&limit=2`);
    expect(result.items.map((member) => member.fullName)).toEqual(
      page.items.map((member) => member.fullName),
    );
  });

  it('turns a problem response into an ApiRequestError with its code and field errors', async () => {
    server.use(
      mock(routes.auth.signUp, () => problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] })),
    );
    const error = await call(routes.auth.signUp, {
      body: {
        companyName: 'Rahman Garments Ltd.',
        workspaceSlug: 'rahman-garments',
        fullName: 'Farhana Rahman',
        email: 'farhana@rahmangarments.com',
        password: 'Gazipur-knit-2026',
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 409,
      code: 'slug_taken',
      problem: { fieldErrors: { workspaceSlug: ['slug_taken'] } },
    });
  });

  it('keeps working when a newer server sends a code this app does not know', async () => {
    server.use(
      http.get(`${API_URL}/auth/me`, () =>
        HttpResponse.json(
          { title: 'Conflict', status: 409, detail: 'x', code: 'brand_new_code' },
          { status: 409 },
        ),
      ),
    );
    await expect(call(routes.auth.me)).rejects.toMatchObject({ code: 'unknown_error' });
  });

  it('reports a body that breaks the contract instead of passing it on', async () => {
    server.use(http.get(`${API_URL}/members`, () => HttpResponse.json({ items: 'nope' })));
    await expect(call(routes.members.list)).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  it('reports a dropped connection as network_error, status 0', async () => {
    server.use(http.get(`${API_URL}/members`, () => HttpResponse.error()));
    await expect(call(routes.members.list)).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('refreshes an expired access token once and retries the request', async () => {
    sessionStore.getState().setAccessToken('expired');
    const seen: (string | null)[] = [];
    server.use(
      mock(routes.members.list, ({ request }) => {
        const token = request.headers.get('authorization');
        seen.push(token);
        return token === 'Bearer fresh'
          ? reply(routes.members.list, page)
          : problem(401, 'sign_in_required');
      }),
      mock(routes.auth.refresh, () =>
        reply(routes.auth.refresh, {
          accessToken: 'fresh',
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
    await expect(call(routes.members.list)).resolves.toMatchObject({ nextCursor: 'next' });
    expect(seen).toEqual(['Bearer expired', 'Bearer fresh']);
    expect(sessionStore.getState().accessToken).toBe('fresh');
  });
});
```

**কোন লাইন কেন:**

- app-এর প্রথম টেস্ট। `apps/app`-এর vitest Node-এ চলে (jsdom নেই) — `fetch` Node-এর নিজের, MSW সেটা মাঝপথে ধরে।
  `navigator.locks` (refresh-এর Web Lock) Node 24-এ আছে (যাচাই করা)।
- `onUnhandledRequest: 'error'` — handler ছাড়া কোনো request বেরোলে টেস্ট fail; ভুল করে আসল নেটওয়ার্কে যাওয়া অসম্ভব।
- `server.use(...)` প্রতি টেস্টে, `resetHandlers()` পরে — প্রতিটা টেস্ট নিজের পরিস্থিতি বানায়, একে অন্যের উপর
  নির্ভর করে না।
- শেষ টেস্ট ধাপ ৩-এর সবচেয়ে সূক্ষ্ম আচরণ পাহারা দেয়: মেয়াদ-শেষ টোকেনে 401 → একবার refresh → নতুন টোকেনে আবার।
  `seen` দেখায় ঠিক দুবার গেছে, তিনবার না।
- "unknown code" আর "breaks the contract" — ভিত্তি-সিদ্ধান্ত ৫ আর ৭-এর পাহারা।

**ফাইল: `apps/app/src/lib/field-errors.spec.ts`** (নতুন ফাইল)

```ts
import type { SignUpInput } from '@omnivo/contracts';
import type { ErrorOption, Path } from 'react-hook-form';
import { describe, expect, it } from 'vitest';

import { ApiRequestError } from './api';
import { applyApiError } from './field-errors';

const FIELDS: Path<SignUpInput>[] = [
  'companyName',
  'workspaceSlug',
  'fullName',
  'email',
  'password',
];

// react-hook-form-এর setError-এর জায়গায় — কোন নামে কোন code বসল শুধু সেটা জমায়
function collect(error: unknown): Record<string, string | undefined> {
  const placed: Record<string, string | undefined> = {};
  applyApiError<SignUpInput>(error, FIELDS, (name: string, option: ErrorOption) => {
    placed[name] = option.message;
  });
  return placed;
}

function apiError(code: string, fieldErrors?: Record<string, string[]>): ApiRequestError {
  return new ApiRequestError({
    title: 'Conflict',
    status: 409,
    detail: 'x',
    code,
    ...(fieldErrors && { fieldErrors }),
  });
}

describe('applyApiError', () => {
  it('puts a field error under its field, as a code', () => {
    expect(collect(apiError('slug_taken', { workspaceSlug: ['slug_taken'] }))).toEqual({
      workspaceSlug: 'slug_taken',
    });
  });

  it('shows errors for fields the form does not have above the form', () => {
    expect(collect(apiError('invalid_input', { internalId: ['invalid_value'] }))).toEqual({
      'root.server': 'invalid_input',
    });
  });

  it('never shows an unknown code from the server as raw text', () => {
    expect(collect(apiError('brand_new_code', { email: ['brand_new_code'] }))).toEqual({
      email: 'invalid_value',
    });
    expect(collect(apiError('brand_new_code'))).toEqual({ 'root.server': 'unknown_error' });
  });

  it('treats anything that is not an API error as unknown', () => {
    expect(collect(new TypeError('boom'))).toEqual({ 'root.server': 'unknown_error' });
  });
});
```

- `setError`-এর জায়গায় সাধারণ ফাংশন — react-hook-form ছাড়াই, কোন ফিল্ডে কী বসল সেটা দেখা।

```bash
pnpm --filter @omnivo/app test      # ১০টা পাস
```

---

## ৫.১১ — root: script, turbo, CI, boundary

**ফাইল: `turbo.json`** (আপডেট — `tasks`-এ শেষে তিনটা)

```json
    "dev:mock": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "gen:openapi": {
      "dependsOn": ["build"],
      "cache": false
    },
    "test:openapi": {
      "dependsOn": ["build"]
    }
```

- `gen:openapi`/`test:openapi`-এ `"build"` (`^` ছাড়া) — স্ক্রিপ্ট **নিজের** প্যাকেজের `dist` পড়ে (৫.৪)।
- `gen:openapi`-এ `cache: false` — এটা একটা ফাইল লেখে যা `outputs`-এ নেই; cache hit হলে turbo স্ক্রিপ্ট চালাতই না,
  আর মোছা ফাইল ফেরতও আসত না।
- `test:openapi` cache-যোগ্য — শুধু পরীক্ষা; contracts-এর উৎস আর `openapi.json` না বদলালে ফল একই।
- `dev:mock` — শুধু app-এর এই script আছে, তাই শুধু app চলে; `^build` প্যাকেজগুলো একবার build করে। প্যাকেজ বদলানোর
  কাজ করলে (watch দরকার) সাধারণ `pnpm dev` চালান।

**ফাইল: root `package.json`** (আপডেট — `scripts`-এ তিন লাইন)

```json
    "dev:mock": "turbo run dev:mock",
    "gen:openapi": "turbo run gen:openapi",
    "test:openapi": "turbo run test:openapi",
```

**ফাইল: `.github/workflows/ci.yml`** (আপডেট — `Bundle size`-এর পরে একটা ধাপ)

```yaml
      - name: OpenAPI spec up to date
        run: pnpm test:openapi
```

- `Build`-এর পরে — ততক্ষণে contracts-এর `dist` তৈরি (turbo cache থেকে তাৎক্ষণিক)।
- fail মানে: কেউ চুক্তি বদলেছে কিন্তু `pnpm gen:openapi` চালিয়ে ফাইল commit করেনি — অর্থাৎ PR-এর reviewer চুক্তির
  বদলটা diff-এ দেখেনি।

**ফাইল: `.prettierignore`** (আপডেট — `packages/db/migrations/meta/`-এর পরে)

```
# জেনারেট করা ফাইল: প্রথমটা `pnpm gen:openapi` লেখে, দ্বিতীয়টা `msw init`
packages/contracts/openapi.json
apps/app/public/mockServiceWorker.js
```

- `openapi.json` — Prettier ছোট array এক লাইনে গুটিয়ে দেয়, আর `JSON.stringify` সব ভেঙে লেখে। দুজনের লেখা কখনো
  মিলত না: হয় `pnpm format` fail, নয় `test:openapi`।

**ফাইল: `packages/config/eslint/index.js`** (আপডেট — প্রথম `ignores`)

```js
  {
    // mockServiceWorker.js: MSW-এর জেনারেট করা ফাইল (`msw init`), হাতে বদলানো হয় না
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/mockServiceWorker.js',
    ],
  },
```

- ফাইলটা service worker-এর কোড (`self`, `clients`) — আমাদের lint নিয়মে (Node globals-এর `.js`) শতখানেক error দিত।

**ফাইল: `pnpm-workspace.yaml`** (আপডেট — `allowBuilds`-এ এক লাইন)

```yaml
  msw: false # postinstall শুধু worker ফাইল কপি করে; আমরা `msw init` নিজে চালিয়ে ফাইলটা commit করি
```

- ধাপ ০ থেকে রিপোর নিয়ম: কোন প্যাকেজের install-script চলবে তা স্পষ্ট করে বলতে হয় (supply-chain নিরাপত্তা)।
  msw-এর postinstall `workerDirectory` না থাকলে কিছুই করে না — `false`। না লিখলে `pnpm install` থামে; আর যাচাইয়ের
  সময় দেখা গেছে pnpm তখন নিজেই ফাইলে `msw: set this to true or false` লাইন বসিয়ে দেয় — সেটা মুছে এই লাইন রাখুন।

**ফাইল: `.dependency-cruiser.cjs`** (আপডেট — `browser-packages-not-to-server`-এর পরে দুটো নিয়ম)

```js
    {
      name: 'contracts-only-zod',
      severity: 'error',
      comment:
        'contracts is loaded by the API and the browser alike. It may use zod and nothing else, so neither side pulls in the other side of the stack.',
      from: { path: '^packages/contracts/src/', pathNot: '\\.spec\\.ts$' },
      to: { pathNot: ['^packages/contracts/src/', 'node_modules/zod/'] },
    },
    {
      name: 'mocks-only-in-dev',
      severity: 'error',
      comment:
        'MSW and the mock handlers are dev tools. App code may load them only through the dynamic import in main.tsx, which a production build removes.',
      from: { path: '^apps/app/src/', pathNot: ['^apps/app/src/mocks/', '\\.spec\\.ts$'] },
      to: {
        path: ['^apps/app/src/mocks/', 'node_modules/msw/'],
        dependencyTypesNot: ['dynamic-import'],
      },
    },
```

**কোন লাইন কেন:**

- `contracts-only-zod` — contracts দুই দুনিয়ার মাঝখানে। কেউ `@omnivo/db` থেকে `PermissionKey` আনলে (লোভনীয়!) সার্ভারের
  কোড ব্রাউজারে যেত; কেউ React আনলে API-র দরকারহীন বোঝা। `to.pathNot` — "এই দুটো ছাড়া যেকোনো কিছু" নিষেধ। spec ফাইল
  বাদ (vitest import করে)। i18n-এর `import type` নিয়মে পড়ে না — dependency-cruiser ডিফল্টে শুধু-টাইপ import দেখে না।
- `mocks-only-in-dev` — app-এর কোনো ফাইল `mocks/` বা `msw` **static** import করলে msw production bundle-এ চলে যেত।
  `dependencyTypesNot: ['dynamic-import']` — main.tsx-এর `await import('./mocks/browser')` বৈধ (build সেটা মুছে দেয়)।
- **ইচ্ছা করে ভেঙে যাচাই করা:** contracts-এ `import '@omnivo/db'` আর router-এ `import { worker } from './mocks/browser'`
  বসিয়ে `pnpm boundaries` → দুটোই `error`; সরালে আবার `no dependency violations found`।

---

## ৫.১২ — ডকুমেন্ট হালনাগাদ

ইমপ্লিমেন্ট শেষে (আমাকে বললে আমি করে দিতে পারি):

**CLAUDE.md** — Content and formatting → Language অনুচ্ছেদের শেষ দুই বাক্য

> Exceptions until step 5 moves errors to codes: the login and sign-up pages. The dev-only kitchen sink stays English.

বদলে লিখুন:

> Error messages are never written in code: the API and the Zod schemas send an error code (`slug_taken`, see
> `ERROR_CODES` in `@omnivo/contracts`), and the text lives in `errors.*` in `en.ts`/`bn.ts`. The dev-only kitchen
> sink stays English.

আর "Components"-এর নিচে Data table-এর অনুচ্ছেদে এক বাক্য: "Paged lists sort on the server (`sorting` prop) and load
the next page with `onEndReached`."

**build-plan.bn.md:**

- ধাপ ৫-এর অনুচ্ছেদ: "`orval`/`openapi-typescript` দিয়ে typed client + TanStack Query hooks" → "Zod route রেজিস্ট্রি
  (টাইপ সরাসরি Zod থেকে, codegen নেই) + রেজিস্ট্রি থেকে OpenAPI 3.1"; "যা দেখবেন"-এ `pnpm gen:client` → "contracts-এ
  ফিল্ডের নাম বদলান → সাথে সাথে লাল দাগ; `pnpm gen:openapi` → স্পেকের diff"।
- §১-এর উল্লম্ব স্লাইসের ৫ নম্বর: "`pnpm gen:client` চালান → typed API client অটো তৈরি" → "`pnpm gen:openapi` চালান →
  openapi.json হালনাগাদ (client-এর টাইপ চুক্তি থেকে নিজেই আসে)"।
- §৯ অগ্রগতি: ধাপ ৪–৫-এ টিক।

**system-design.bn.md §৩.২** — "ফ্রন্টএন্ডের জন্য OpenAPI থেকে typed client জেনারেট করবেন (যেমন orval বা
openapi-typescript)" → "ফ্রন্টএন্ড আর API একই Zod চুক্তি থেকে টাইপ নেয়; OpenAPI সেই চুক্তি থেকে জেনারেট হয় —
বাইরের ইন্টিগ্রেশন আর docs-এর জন্য"।

**README.md** — Roadmap টেবিলে ৪–৫-এর লাইন: "contract and typed-client codegen pipeline" → "API contracts: Zod route
registry, error codes, keyset pagination, OpenAPI"।

**COMMANDS.md** — "Run the full stack"-এর নিচে:

```sh
pnpm dev:mock   # the app alone on MSW mocks — no API, Postgres or Docker needed
```

আর তার নিচে: API docs = `http://localhost:3000/docs` (dev only)। "Checks"-এ:

```sh
pnpm gen:openapi  # rewrite packages/contracts/openapi.json from the route registry — commit it
pnpm test:openapi # fail if openapi.json is out of date, and validate it as OpenAPI 3.1
```

---

## ৫.১৩ — রান করুন

```bash
pnpm install                 # lockfile আপডেট
pnpm dedupe --check          # vitest, react — প্রতিটার একটাই কপি?
pnpm gen:openapi             # openapi.json প্রথমবার লেখা — commit করুন
pnpm dev                     # API :3000, app :5173, প্যাকেজগুলোর tsc --watch
```

DB-তে কোনো migration নেই এই ধাপে।

### যা দেখবেন

1. **লাল দাগ — এই ধাপের আসল দেখার জিনিস।** `pnpm dev` চলাকালীন `packages/contracts/src/members.ts`-এ `memberSchema`-র
   `fullName` → `name` করে সেভ করুন। contracts-এর `tsc --watch` নতুন `dist` লেখে, আর এডিটরে (বা `pnpm typecheck`-এ)
   সাথে সাথে লাল:
   - `apps/api/src/members/members.controller.ts` — handler যা ফেরত দেয় (`fullName`) চুক্তির সাথে মেলে না;
   - `apps/app/src/routes/dashboard.tsx` — `column.accessor('fullName')` আর `row.original.fullName`;
   - `apps/app/src/mocks/fixtures.ts`, `handlers.ts`, আর দুই পাশের টেস্ট;
   - `pnpm test:openapi` → "openapi.json is out of date"।

   (যাচাই করা, ঠিক এই তালিকাই। turbo প্রথম fail-করা প্যাকেজে থামে, তাই app-এর error দেখতে `pnpm --filter @omnivo/app
   typecheck` আলাদা করে।) তারপর বদলটা ফিরিয়ে দিন।
2. `http://localhost:3000/docs` → Scalar-এ তিন গ্রুপ (health, auth, members), আটটা endpoint। `GET /members`-এ query
   প্যারামিটার (`limit` default 50, `cursor`, `sort` = name / -name), উত্তরের আকার, আর `default` → Problem। টোকেন
   ছাড়া "Send" → 401, `application/problem+json`, `code: "sign_in_required"`।
3. `http://localhost:5173/login` → নিচে ডানে "English | বাংলা"। বাংলা বাছুন → পুরো পেজ বাংলায়, ডানের প্যানেলের শিরোনাম
   আর শিল্প-চিপ সহ (শুধু ছোট ছবিটা ইংরেজি — ইচ্ছাকৃত)। ফাঁকা ফর্মে "সাইন ইন" → তিনটা ফিল্ডের নিচে বাংলা error।
4. ভুল পাসওয়ার্ড দিয়ে সাইন ইন → ফর্মের উপরে "ইমেইল বা পাসওয়ার্ড ভুল…"। এবার "English" চাপুন — সেই error-ও
   সাথে সাথে "Email or password is incorrect…"।
5. সাইনআপে আগে থেকে নেওয়া ঠিকানা → ঠিকানার ফিল্ডের নিচে "এই ঠিকানাটা আগেই নেওয়া হয়েছে…" (সার্ভারের 409, code থেকে)।
6. ড্যাশবোর্ড → DevTools → Network: `GET /members?sort=name&limit=50`, response header-এ `x-request-id`। "Member"
   হেডারে ক্লিক → নতুন request `sort=-name`, তালিকা উল্টো, হেডারে ↓। আবার ক্লিক → ↑ (তৃতীয় "sort নেই" অবস্থা নেই)।
   "Roles" হেডারে কোনো বাটন নেই।
7. `pnpm dev:mock` (API, Postgres, Docker ছাড়াই) → সোজা Rahman Garments-এর ড্যাশবোর্ড, ২৪০ জনের টিম। টেবিলটা নিচে
   scroll করুন → তলায় "Loading more…", প্রতি ৫০ জনে নতুন পাতা (console-এ MSW প্রতিটা `GET /members` দেখায়)।
   workspace বাটন → Karim Pharma → টিম-তালিকা খালি ক্যাশ থেকে আবার আসে। সাইন আউট → লগইন পেজ; পাসওয়ার্ড
   `wrong-password` → error; অন্য যেকোনো পাসওয়ার্ড → ভেতরে।
8. DevTools-এর device toolbar-এ ৩৯০px + dark → টিম কার্ডে, পেজ scroll করলে নতুন পাতা আসে, আড়াআড়ি scroll নেই।
9. `pnpm build` তারপর `grep -l setupWorker apps/app/dist/assets/*.js` → কিছুই না: msw production bundle-এ নেই।

---

## যাচাইয়ের তালিকা

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # ৭৩টা: auth ৭ + api ১৭ + contracts ১৪ + i18n ৯ + ui ১৬ + app ১০ — Docker লাগে না
pnpm test:integration        # Docker লাগে — ⚠️ এই ধাপে যাচাই হয়নি (নতুন members.int.spec.ts সহ ২৫টা হওয়ার কথা)
pnpm test:tenant-leak        # ⚠️ যাচাই হয়নি — ৯টা হওয়ার কথা
pnpm build
pnpm test:bundle-size        # প্রথম লোড 156.3 KB gz; dashboard 32.4, login 36.1, sign-up 27.2, app-shell 41.2
pnpm test:openapi
pnpm boundaries
```

যাচাইয়ের পথে যা ধরা পড়েছিল (আর গাইডে ঠিক করা আছে), যাতে আপনি একই জায়গায় আটকে থাকলে চিনতে পারেন:

- `auth.middleware.spec.ts`-এর তিনটা টেস্ট 401-এর বদলে 500 — ছোট test module-এ `ProblemFilter` ছিল না (৫.৭)।
- `docs.controller.ts`-এ TS2883 — `spec()`-এর return টাইপ না লেখায় (৫.৬)।
- `call()`-এর overload-এ TS2394, `read()`-এ `unknown` — `& RequestParts` আর schema-generic `S` (৫.৯)।
- ড্যাশবোর্ডে `pageParam: null` — `queryFn`-এর প্যারামিটারের টাইপ লিখে (৫.৯)।
- ESLint: `http.ts`-এ mapped type-এর বদলে `Record`/`Partial`, আর `Record<never, never>` (= `{}`)-এর বদলে `unknown`
  (৫.২); `contract.spec.ts`-এ `Object.values`-এর `any` (৫.৭)।
- `pnpm dedupe --check` — msw আসার পর vitest-এর peer বদলায়; `pnpm dedupe` (৫.৯)।
- `pnpm install` থামা — msw-এর postinstall, `allowBuilds` (৫.১১)।

---

## পরের ধাপগুলোর জন্য রেখে যাওয়া নোট

**সবার আগে (ধাপ ৫ শেষ করার অংশ):** Docker চালু করে `pnpm test:integration` আর `pnpm test:tenant-leak`। ৫.৭-এর শেষে ঝুঁকির
তালিকা (row comparison-এ uuid, `users`-এ সরাসরি INSERT)।

**নতুন endpoint যোগ করার ছন্দ (ধাপ ৬ থেকে প্রতিবার):**

1. `packages/contracts/src/<module>.ts`-এ schema আর `defineRoute(...)`; `routes.ts`-এ এক লাইন।
2. নতুন error হলে `ERROR_CODES`-এ code → `en.ts` আর `bn.ts`-এ লেখা (না লিখলে typecheck নিজেই মনে করাবে)।
3. API-তে `@Endpoint(routes.x.y)` handler; module AppModule-এ (না দিলে `contract.spec.ts` fail)।
4. app-এ `call(routes.x.y, …)` আর `queryOptions`/`infiniteQueryOptions`।
5. `mocks/handlers.ts`-এ `mock(routes.x.y, …)` (না দিলে `pnpm dev:mock`-এ console error)।
6. `pnpm gen:openapi`, commit।

**ধাপ ৬ (settings, branches):** প্রথম path parameter (`/branches/:id`) — `buildPath` আর OpenAPI-র `{id}` তৈরি আছে;
প্রথম mutation — `useMutation` + সফল হলে `queryClient.invalidateQueries({ queryKey: ['branches'] })`। Playwright
(`pnpm test:e2e`) এই ধাপের browser flow গুলো দিয়ে শুরু করা যায়, আর MSW থাকায় e2e-র একটা অংশ API ছাড়াও চলতে পারে।

**ধাপ ৭ (users, roles):** `PermissionKey` `packages/db` থেকে contracts-এ সরানো — তখন ড্যাশবোর্ডের
`me.permissions.includes('core.user.read')`-এর string টাইপ-চেকড হবে, আর চুক্তিতে `permission: 'core.user.read'` লিখে
`@Endpoint`-ই `RequirePermission` বসাতে পারবে (OpenAPI-তেও দেখাবে)। invite-এর পরে `['members']` invalidate।

**ধাপ ১২ (প্রোডাক্ট তালিকা, ১০,০০০+ রো):** keyset-এর index নিয়ম — sort-এর প্রতিটা বিকল্পে `(tenant_id, sort_col, id)`
index, আর `EXPLAIN ANALYZE`-এ "Index Scan" দেখা। সেখানে sort-কলাম একই টেবিলে থাকবে (members-এর মতো join-এর ওপারে না)।

**ধাপ ১৮ (sync):** `GET /sync/pull?since=…`-ও এই চুক্তি-ব্যবস্থায় — `since` আসলে একটা cursor; `pageOf`-এর একই ধারণা।

**ধাপ ১৯ (PWA):** Workbox-এর precache তালিকা থেকে `mockServiceWorker.js` বাদ দিন (`globIgnores`), নাহলে প্রতিটা
ব্যবহারকারীর ব্রাউজারে অকারণে জমা হবে।

**ধাপ ২১ (রিপোর্ট):** বড় response-এ `ContractInterceptor`-এর parse মেপে দেখুন; ধীর হলে সেই route-এ চুক্তির schema
হালকা করা (বা রিপোর্ট stream করা) — যাচাই পুরো বন্ধ না।

**ধাপ ২৯ (public API):** commit করা `openapi.json` থেকেই পার্টনারের SDK; তখন `$ref`-ওয়ালা `components.schemas`
(আলাদা Zod registry দিয়ে) আর endpoint-প্রতি error code চুক্তিতে। breaking change CI-তে ধরতে `oasdiff`।

**সতর্কতা:** response schema-য় কখনো `.transform()` রাখবেন না — `ContractInterceptor` parse করে output পাঠায়, আর
ক্লায়েন্ট আবার parse করে; transform থাকলে দুবার খাটত (যেমন string → Date → আবার Date-কে string ভাবা)। তারিখ তারে
ISO string-ই থাকবে, `Date`-এ রূপান্তর UI-তে।
