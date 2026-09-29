# ধাপ ৬: সেটিংস ও ভিত্তি — কোম্পানির সেটিংস, ব্রাঞ্চ, নম্বরিং, audit log, ফাইল আপলোড, ইউজারের পছন্দ, Playwright

> [build-plan.bn.md](build-plan.bn.md)-এর "পর্ব ২ → ধাপ ৬"-এর ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী লিখতে
> হবে, কোন কমান্ড কোথায় চালাতে হবে।
>
> এই গাইডের প্রতিটা ফাইল রিপোর একটা আলাদা কপিতে (ধাপ ৫-এর পরের commit `2928e49`-এর উপর) বসিয়ে যাচাই করা
> (২০২৬-০৯-২৯): `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (৯০টা — নতুন
> ১৭টা), `pnpm test:integration` (৫৪টা — নতুন ২৯টা), `pnpm test:tenant-leak` (১৪টা — নতুন ৫টা), `pnpm build`,
> `pnpm test:bundle-size` (প্রথম লোড 165.2 KB gz, বাজেট 200), `pnpm test:openapi`, `pnpm boundaries` আর নতুন
> `pnpm test:e2e` (Playwright, ১৬টা — ডেস্কটপ আর ৩৯০px, পরপর তিনবার) — সব পাস, turbo cache মুছে।
>
> এবার Docker চালু ছিল, তাই ধাপ ৫-এর অযাচাইকৃত অংশও চলেছে: **ধাপ ৫-এর কোডেই** (এই ধাপের কিছু বসানোর আগে)
> `pnpm test:integration` ২৫টা আর `pnpm test:tenant-leak` ৯টা পাস। ধাপ ৫-এর শেষের "সবার আগে" কাজটা তাই শেষ।
>
> আরও যা করে দেখা:
>
> - **migration আপনার DB-র মতো অবস্থায়:** একটা DB-কে ধাপ ৫-এর অবস্থায় আনা (পুরনো সাতটা migration + পুরনো
>   seed-এর Acme), তারপর এই ধাপের দুটো migration। ফল: Acme-এর Owner ৩ → ৬ permission, settings রো আর
>   "Head office" ব্রাঞ্চ বসেছে, পাঁচটা নতুন টেবিলে FORCE RLS; দ্বিতীয়বার চালালে কিছু বদলায় না।
> - **আসল স্ট্যাক headless Chrome-এ** (API + app + Postgres + Valkey + MinIO): সাইনআপ → সেটিংস সেভ (switcher-এ
>   নতুন নাম) → লোগো সরাসরি MinIO-তে আপলোড, ব্রাউজারে লোড → দুই ট্যাবে একই সেটিংস খোলা, দ্বিতীয়টা 409 →
>   "Reload" → প্রথমটার বদল অক্ষত রেখে সেভ → ব্রাঞ্চ যোগ, একই কোড আবার → API-র 409 → নম্বরিং বদল → audit
>   log-এ সব ঘটনা, শুধু বদলানো ঘর সহ → dark + বাংলা বেছে "নতুন ডিভাইসে" (৩৯০px) খোলা: সার্ভার থেকে একই থিম
>   আর ভাষা, আড়াআড়ি scroll শূন্য।
> - **প্রতিটা পাহারা-টেস্ট ইচ্ছা করে ভেঙে দেখা:** lock মুছলে ব্রাঞ্চের race টেস্ট fail করে; নম্বরের কাউন্টার
>   "পড়ো তারপর +১" করলে ২০টা নম্বরের বেশিরভাগ একই; audit-এর cursor `Date` হলে ৫টা রো-র ২টা আসে; CORS-এ
>   method না দিলে preflight টেস্ট fail; RLS-coverage টেস্ট FORCE বন্ধ করা টেবিল ধরে ফেলে।
>
> ⚠️ **যা যাচাই হয়নি:** (১) Cloudflare R2 বা AWS S3 — ফাইল আপলোড শুধু MinIO-তে চলেছে; checksum আর
> Content-Type-এর আচরণ কোথায় আলাদা হতে পারে তা ৬.৩-এ লেখা। (২) GitHub Actions-এ নতুন দুটো CI ধাপ
> (`playwright install --with-deps`, `pnpm test:e2e`) একবারও চলেনি। (৩) আপনার নিজের `.env` আর dev DB-তে
> `pnpm dev` — `.env`-এ নতুন চারটা লাইন না দিলে API চালুই হবে না (৬.১৩)।

## লক্ষ্য

🏢 **প্রতিটা workspace-এর নিজের পরিচয় আর নিয়ম — আর প্রতিটা বদলের পাকা রেকর্ড।** পেছনে যা তৈরি হবে:

- **কোম্পানির সেটিংস:** নাম, আইনি নাম, BIN (VAT), ফোন, ইমেইল, ঠিকানা, লোগো; আর আঞ্চলিক — মূল মুদ্রা,
  অর্থবছরের শুরু (ডিফল্ট জুলাই), টাইমজোন (ডিফল্ট Asia/Dhaka)। দুজন একসাথে বদলালে দ্বিতীয়জন "কেউ বদলেছে"
  জানতে পারে — চুপচাপ অন্যের বদল মুছে দেওয়া না (optimistic locking)।
- **ব্রাঞ্চ:** অফিস, কারখানা, ডিপো। যোগ, বদল, archive (মোছা না), আবার চালু। অন্তত একটা চালু থাকবেই।
- **নম্বরিং:** `INV-2026-27-0001` — প্রতিটা ডকুমেন্ট টাইপের prefix, বছর, অঙ্ক। নম্বর দেওয়ার ইঞ্জিন তৈরি থাকবে
  (ফাঁকহীন, একসাথে ২০টা চাইলেও ডুপ্লিকেট নেই), যদিও প্রথম ব্যবহারকারী আসবে ধাপ ১০ (journal) আর ১৫ (ইনভয়েস)-এ।
- **audit log:** কে, কখন, কোন IP থেকে, কী বদলাল — পুরনো আর নতুন মান সহ। বদল আর তার রেকর্ড একই transaction-এ।
  সাইনআপ, লগইন আর workspace বদলানোও লেখা হয় (ধাপ ৩-এর নোট)। viewer-এ keyset pagination আর ফিল্টার।
- **ফাইল আপলোড (attachments):** ব্রাউজার ফাইল পাঠায় সরাসরি storage-এ (MinIO, পরে R2) — API শুধু সই করা
  ঠিকানা দেয় আর পরে যাচাই করে। প্রথম ব্যবহার: কোম্পানির লোগো।
- **ইউজারের পছন্দ:** ভাষা আর থিম অ্যাকাউন্টে সেভ — অন্য ডিভাইসে লগইন করলেও একই (ধাপ ৪-এর নোট)।
- **Playwright:** প্রথম end-to-end টেস্ট, MSW-এর mock API-র উপর — Docker ছাড়া, ডেস্কটপ আর ৩৯০px দুই আকারে।

## পুরো ছবিটা এক নজরে

```
packages/contracts   settings · branches · numbering · audit · attachments · preferences (+ নতুন error code)
      │                formatDocumentNumber / periodOf / todayIn — সার্ভার আর UI-প্রিভিউ একই ফাংশন
      ▼
packages/db          tenant_settings (১ রো/টেন্যান্ট) · branches · number_series (+ _counters) · attachments
                     users.language/theme · audit_logs + request_id/ip/user_agent
                     migration 0007 (drizzle) + 0008 (backfill → RLS) · grantOwnerPermissions()
      │
      ▼
apps/api             RequestContextMiddleware ─┐   (id, IP, user agent — ALS-এ)
                     AuthMiddleware ───────────┤   (principal — ধাপ ৩)
                                               ▼
                     service: withTenant(tx) → SELECT … FOR UPDATE → version মেলানো → UPDATE
                                            → audit(tx, { action, entity, diff(before, after) })  ← একই tx
                     StorageService (S3 SDK) → presigned PUT/GET, HEAD দিয়ে যাচাই
                     NumberingService.next(tx, type, date) → counter upsert (পরের ধাপগুলোর জন্য)
      │
      ▼
apps/app             /settings  /numbering  /branches  /audit-log   (প্রতিটা আলাদা lazy chunk)
                     user মেনু: ভাষা + থিম → savePreference() → এই ডিভাইস, তারপর সার্ভার
                     mocks/: প্রতিটা নতুন রুটের mock, আসল API-র নিয়ম সহ (version, কোড, শেষ ব্রাঞ্চ)
                     e2e/: Playwright → vite --mode mock (৪১৭৩) → ডেস্কটপ + ফোন

লোগো আপলোড:
  ব্রাউজার ──POST /attachments──► API: রো (pending) + সই করা PUT ঠিকানা
  ব্রাউজার ──PUT ফাইল──────────► MinIO/R2 (API-র মধ্য দিয়ে না)
  ব্রাউজার ──POST …/complete───► API: HEAD দিয়ে আকার আর ধরন মেলানো → ready
  ব্রাউজার ──PUT /settings/logo─► API: লোগো বসানো + audit
```

## এই ধাপের ভিত্তি-সিদ্ধান্ত

1. **audit লেখা হয় বদলের সাথে একই transaction-এ, interceptor দিয়ে না। build-plan-এর একটা শব্দ বদলাচ্ছে।**
   build-plan বলে "audit log interceptor"। কিন্তু Nest-এর interceptor চলে handler শেষ হওয়ার পরে — ততক্ষণে
   transaction commit হয়ে গেছে। তাতে দুটো সমস্যা: (ক) পুরনো মান জানার উপায় নেই, অথচ system-design §৯.২
   বলে "পুরনো ও নতুন মান সহ"; (খ) commit আর audit-এর মাঝে process পড়ে গেলে বদল থাকে কিন্তু রেকর্ড থাকে না —
   audit-এর মূল প্রতিশ্রুতিটাই ভাঙে। তাই প্রতিটা service নিজের transaction-এর ভেতরে
   `audit(tx, { action, entityType, entityId, changes })` ডাকে: বদল commit হলে audit থাকবেই, rollback হলে
   দুটোই যায়। "interceptor"-এর যে সুবিধা (প্রতিটা জায়গায় request-এর তথ্য হাতে না দেওয়া) সেটা থাকছে: কে, কোন
   request, কোন IP — `audit()` নিজেই ALS থেকে নেয়। (এই পথটা আপনি বেছে নিয়েছেন, ২০২৬-০৯-২৯।)
2. **request-এর পরিচয় আলাদা ALS-এ।** লগইন public রুট — টেন্যান্ট জানার আগে চলে, principal নেই। তবু তার audit-এ
   IP আর request id লাগে। তাই ধাপ ২-এর tenant ALS-এর পাশে আরেকটা ছোট ALS (`RequestContextMiddleware`), যা
   **প্রতিটা** request-এ বসে। background job-এ (ধাপ ৮) এটা থাকবে না — তখন audit-এর এই কলামগুলো NULL, আর কিছু
   ভাঙে না।
3. **optimistic locking: `version` কলাম, `SELECT … FOR UPDATE`, না মিললে 409 `version_conflict`।** ধাপ ১
   থেকেই প্রতিটা টেবিলে `version` আছে (system-design §১০); এবার প্রথম ব্যবহার। ফর্ম যে version দেখে খোলা হয়েছিল
   সেটাই সেভে যায়। সার্ভার আগে রো-টা lock করে পড়ে (audit-এর "আগের মান"ও এখান থেকে), version মেলায়, তারপর
   লেখে আর version এক বাড়ায়। UI-তে "কেউ বদলেছে — Reload" আর ফর্ম সার্ভারের সর্বশেষ মানে ফেরে।
4. **নম্বর আসে একটা কাউন্টার-টেবিল থেকে, Postgres `SEQUENCE` থেকে না।** sequence rollback মানে না: ইনভয়েস
   সেভ ব্যর্থ হলেও নম্বরটা খরচ হয়ে যেত, আর VAT অডিটে `INV-0041`-এর পরে `INV-0043` মানে "০০৪২ কোথায়?"। কাউন্টারের
   রো ডকুমেন্টের একই transaction-এ বাড়ে (`INSERT … ON CONFLICT DO UPDATE SET last_value = last_value + 1`),
   তাই rollback হলে নম্বরও ফেরত আসে, আর দুজন একসাথে চাইলে রো-lock তাদের একটার পর একটা চালায়। দাম: একই
   টেন্যান্টের একই ডকুমেন্ট টাইপের নম্বর নেওয়া একসাথে না, সারি ধরে হয় — SME-র জন্য এটা সমস্যা না।
5. **নম্বরের ছাঁচ টেন্যান্ট বদলালে তবেই DB-তে।** না থাকলে contracts-এর `defaultNumberFormat()` (INV, SO, PO…
   অর্থবছর সহ, ৪ অঙ্ক)। তাই পরে নতুন ডকুমেন্ট টাইপ যোগ করলে পুরনো হাজার টেন্যান্টের জন্য backfill লাগে না।
   বছরের অংশটা ছাঁচেরই অংশ (`2026-27`) — কাউন্টারের সময়কাল আর নম্বরের লেখা একই স্ট্রিং, তাই ছাঁচ বদলালেও
   (যেমন অর্থবছর → ক্যালেন্ডার বছর) দুটো আলাদা ডকুমেন্ট কখনো একই নম্বর পায় না।
6. **ব্রাঞ্চ মোছা হয় না, archive হয়।** পরে ইনভয়েস আর স্টক ব্রাঞ্চকে রেফার করবে (system-design §১০: "লেনদেনে
   ব্যবহৃত master ডেটা মোছা যাবে না")। নিয়ম: অন্তত একটা চালু ব্রাঞ্চ। এখানে একটা সূক্ষ্ম race আছে (write skew)
   — দুজন একসাথে শেষ দুটো ব্রাঞ্চ archive করলে দুজনেই "আরেকটা চালু আছে" দেখত। সমাধান: archive-এর আগে
   টেন্যান্টের **সব** চালু ব্রাঞ্চ lock (৬.৪-এ কোড, ৬.৫-এ প্রমাণ)।
7. **ফাইল API-র মধ্য দিয়ে যায় না।** system-design §৩.৭: ব্রাউজার সরাসরি storage-এ PUT করে, সই করা ঠিকানায়।
   তিন ধাপ: বর্ণনা পাঠাও → ঠিকানা নাও (রো `pending`) → ফাইল পাঠাও → "হয়েছে" বলো, আর সার্ভার storage-কে
   জিজ্ঞেস করে আকার আর ধরন মেলায় (`ready`)। presigned PUT ফাইলের আকার বাঁধতে পারে না (S3-এর POST policy পারে,
   কিন্তু R2 সেটা সমর্থন করে না) — তাই আকারের পাহারা এই শেষ যাচাইয়ে। ফাইলের নাম storage-এর পাথে বসে না।
8. **সেটিংস পড়া সবার, বদলানো `core.settings.manage`-এর।** টাইমজোন, অর্থবছর আর মুদ্রা প্রতিটা স্ক্রিনেই লাগে
   (audit log-এর সময়, পরে টাকার অঙ্ক)। একই কারণে ব্রাঞ্চের তালিকাও সবাই পড়ে — পরে প্রায় প্রতিটা ফর্মের
   drop-down-এ লাগবে। নতুন তিনটা permission: `core.settings.manage`, `core.branch.manage`, `core.audit.read`।
9. **ভাষা আর থিম ইউজারের, workspace-এর না।** একই মানুষ দুই কোম্পানিতে থাকলেও তার ভাষা একটাই; তাই `users`-এ
   (global টেবিল), `tenant_settings`-এ না। workspace-এর "ডিফল্ট ভাষা" রাখা হয়নি ইচ্ছা করে: ইউজার লগইন পেজে
   বাংলা বেছে ঢুকল আর workspace-এর ডিফল্ট ইংরেজি বলে জোর করে ফেরানো — সেটা অবাক করা আচরণ। ছাপা ডকুমেন্টের
   ভাষা (বাংলা ইনভয়েস) আলাদা সেটিং হবে, ইনভয়েসের সাথে (ধাপ ১৭)। (আপনি বেছে নিয়েছেন: এই ধাপেই।)
10. **নতুন permission পুরনো Owner-কেও।** Owner মানে "সব অনুমতি" — কিন্তু সেটা ডেটায় (`role_permissions`) লেখা,
    কোডে না। signup শুধু নতুন workspace-কে সব দেয়; আপনার dev DB-র বিদ্যমান workspace নতুন তিনটা পেত না, আর
    মালিক নিজেই সেটিংস খুলতে পারত না। তাই `pnpm db:migrate` এখন প্রতিবার `grantOwnerPermissions()` চালায় —
    idempotent, যা আছে তা থাকে।
11. **ছোট তালিকা একবারে, অসীম তালিকা পাতায় পাতায়।** ব্রাঞ্চ (কয়েক ডজন) আর নম্বরিং (ছয়টা) পুরো তালিকা একবারে
    `{ items }`; audit log (অসীম) ধাপ ৫-এর keyset কনভেনশনে `{ items, nextCursor }`। নিয়মটা এখন থেকে লেখা থাকল।
12. **Playwright চলে MSW-এর mock API-র উপর।** (আপনি বেছে নিয়েছেন।) তাই Docker ছাড়া, CI-র সাধারণ runner-এ,
    ~২০ সেকেন্ডে। দাম: e2e আসল API-র বাগ ধরে না — সেটা integration টেস্টের কাজ। এই ধাপেই তার একটা উদাহরণ
    পাওয়া গেছে (CORS, ৬.৩): MSW আর `app.inject` দুটোই CORS-এর বাইরে দিয়ে যায়, ধরা পড়েছে শুধু আসল ব্রাউজারে —
    তাই এখন সেটার জন্য আলাদা টেস্ট আছে।
13. **`@omnivo/db` এখন `@omnivo/contracts` চেনে।** কলামের enum-তালিকা (`YEAR_STYLES`, `THEMES`,
    `DOCUMENT_TYPES`…) contracts-এ একবার লেখা; DB-র কলাম টাইপ সেখান থেকে। নাহলে একই তালিকা দুই জায়গায়
    থাকত (CLAUDE.md rule ২)। দিক একটাই: contracts কখনো db import করে না (`contracts-only-zod` নিয়ম সেটা
    পাহারা দেয়)।

## এই ধাপে যা ইচ্ছাকৃতভাবে নেই

| জিনিস | কেন এখন না / কখন আসবে |
|---|---|
| নম্বরের আসল ব্যবহার | `NumberingService.next()` তৈরি আর টেস্ট করা; প্রথম ডাক আসবে journal (ধাপ ১০) আর ইনভয়েস (ধাপ ১৫) থেকে |
| মূল মুদ্রা আর অর্থবছর "তালাবদ্ধ" | প্রথম journal পোস্ট হওয়ার পরে এগুলো বদলানো যাবে না — সেই নিয়ম journal-এর সাথে (ধাপ ১০) |
| `pending` ফাইল মোছা | আপলোড শুরু করে ফেলে রাখা ফাইল জমবে; দৈনিক cleanup job আসবে worker-এর সাথে (ধাপ ৮) |
| ছবি ছোট করা, ভাইরাস স্ক্যান | লোগো ২ MB-তে সীমিত; বড় ফাইল (রসিদ, PDF) এলে worker-এ |
| লোগো সাইডবারে বা PDF-এ | শুধু সেটিংসে দেখায়; ইনভয়েস PDF-এ ধাপ ১৭-তে (`StorageService.downloadUrl` তৈরি আছে) |
| refresh token reuse-এর audit | reuse ধরা পড়ে `packages/auth`-এর ভেতরে, টেন্যান্টের বাইরে — নিরাপত্তা-লগ হিসেবে beta-র আগে (ধাপ ২৫) |
| পছন্দ বদলের audit | পছন্দ ইউজারের, কোনো টেন্যান্টের না — audit log টেন্যান্টের |
| audit log export, মেয়াদ, partition | টেবিল ছোট; মাসভিত্তিক partition আর আর্কাইভ বড় হলে (system-design §১১: আলাদা storage-এ ব্যাকআপ) |
| ব্রাঞ্চভিত্তিক অনুমতি ("শুধু গাজীপুরের ইনভয়েস") | রোল আর permission matrix-এর সাথে (ধাপ ৭) |
| `PermissionKey` contracts-এ | UI-র `'core.settings.manage'` এখনো সাধারণ string; ধাপ ৭-এ সরবে (ধাপ ৫-এর নোট) |
| Playwright আসল API-র সাথে | Docker-নির্ভর আর ধীর; আসল flow integration টেস্ট আর হাতে-কলমে যাচাই |
| workspace-এর ডিফল্ট ভাষা | ভিত্তি-সিদ্ধান্ত ৯ |

## আগের কোড থেকে যা বাদ বা বদল হচ্ছে

- **`.env`-এ চারটা নতুন লাইন বাধ্যতামূলক** (`S3_ENDPOINT` ইত্যাদি, ৬.১১)। না দিলে API চালু হওয়ার সময়ই
  "Invalid environment" বলে থামবে — ইচ্ছা করে, ধাপ ৩-এর `config.ts`-এর নিয়মে।
- `auth.service.ts`-এর `isUniqueViolation()` → সরে যাচ্ছে `common/db/pg-errors.ts`-এ (ব্রাঞ্চের কোডেও লাগে)।
- `GET /auth/me`-এর উত্তরে নতুন `preferences` — তাই `mocks/fixtures.ts`-এর `meIn()` এখন তিনটা প্যারামিটার নেয়।
- user মেনুর ভাষা বদল: `setLanguage()` → `savePreference({ language })` (এই ডিভাইস + সার্ভার)।
- `kitchen-sink.tsx`-এর নিজের `applyTheme()` → `lib/theme.ts`-এর শেয়ার করা ফাংশন।
- `auth.int.spec.ts`: Owner-এর permission-এর হাতে লেখা তালিকা → catalog থেকে (নাহলে প্রতিটা নতুন permission-এ
  এই টেস্ট ভাঙত — যাচাইয়ের সময় ঠিক তাই হয়েছিল)।
- `app.module.ts`: `consumer.apply(AuthMiddleware)` → `consumer.apply(RequestContextMiddleware, AuthMiddleware)`।
- `configure-app.ts`: CORS-এ `methods` এখন স্পষ্ট — ডিফল্ট শুধু GET/HEAD/POST ছিল (৬.৩)।
- `audit_logs`-এর index `audit_logs_tenant_created_idx` → বাদ, জায়গায় `(tenant_id, created_at, id)` আর
  entity-র index (migration 0007)।

---

## ৬.১ — `packages/contracts`: চুক্তি

সবার আগে, আগের ধাপের মতোই: API, app, mock আর DB-র কলাম — সবাই এখান থেকে টাইপ নেয়।

### নতুন error code

**ফাইল: `packages/contracts/src/errors.ts`** (আপডেট — `ERROR_CODES`-এ দুই জায়গায়)

`'slug_taken',`-এর পরে:

```ts
  'bin_format',
  'timezone_invalid',
  'branch_code_format',
  'branch_code_taken',
  'branch_name_required',
  'branch_last_active',
  'prefix_format',
  'file_type_not_allowed',
  'file_too_large',
```

`'invalid_cursor',`-এর পরে:

```ts
  'version_conflict',
  'upload_incomplete',
  'attachment_not_ready',
```

- এগুলো যোগ করার সাথে সাথে `packages/i18n`-এর build ভাঙবে (`en.ts`-এর `satisfies Record<ErrorCode, string>`):
  "missing the following properties: bin_format, timezone_invalid, …"। এটাই চাওয়া — অনুবাদ ছাড়া code UI-তে
  পৌঁছাতে পারে না। লেখা ৬.৬-এ।
- `version_conflict` "HTTP ও সার্ভার" দলে, কোনো নির্দিষ্ট ফিল্ডের না — যেকোনো রিসোর্সের যেকোনো সেভে আসতে পারে।

### শেয়ার করা ফিল্ড

**ফাইল: `packages/contracts/src/fields.ts`** (নতুন)

```ts
import { z } from 'zod';

// optimistic locking: ক্লায়েন্ট যে version দেখে ফর্ম খুলেছিল সেটাই ফেরত পাঠায়। সার্ভারে তার মধ্যে কেউ
// বদলালে version বেড়ে গেছে — তখন 409 version_conflict, চুপচাপ অন্যের বদল মুছে দেওয়া না
export const versionSchema = z.number().int().min(1);

// ঐচ্ছিক লেখা: ফর্মের ফাঁকা ঘর '' পাঠায়, API-র বাইরের ক্লায়েন্ট null। দুটোকেই null বানানো —
// নাহলে DB-তে "নেই" দুই রকম ('' আর NULL) থাকত, আর "BIN নেই এমন কোম্পানি" খুঁজতে দুটোই মেলাতে হতো
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();
}
```

- `versionSchema` — `min(1)`: DB-তে version ১ থেকে শুরু (`baseColumns()`), তাই ০ পাঠানো মানে ভুল ডেটা।
  (নম্বরিং ব্যতিক্রম — সেখানে ০ মানে "কখনো সেভ হয়নি", নিজের schema।)
- `optionalText` — `.transform()` ইনপুট schema-য় ঠিক আছে; ধাপ ৫-এর সতর্কতা শুধু **response** schema-র জন্য
  (দুবার parse হয়)। ইনপুট একবারই parse হয় — সার্ভারে, আর ফর্মে।
- `.nullable()` সবার শেষে: তাহলে input টাইপ `string | null`, output-ও `string | null`। ফর্ম '' পাঠায়, বাইরের
  API ব্যবহারকারী null — দুটোই চলে।

### পছন্দ আর `/auth/me`

**ফাইল: `packages/contracts/src/preferences.ts`** (নতুন)

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';

// UI-র ভাষা — i18n-এর LANGUAGES এই তালিকা মানতে বাধ্য (i18n.ts-এর satisfies)
export const LANGUAGE_CODES = ['en', 'bn'] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

// 'system' = OS-এর prefers-color-scheme মেনে চলা (CLAUDE.md → Color tokens)
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

// ইউজারের নিজের পছন্দ, workspace-এর না — একই মানুষ দুই কোম্পানিতে থাকলেও ভাষা একটাই।
// language null = এখনো বাছেনি; তখন এই ডিভাইসে যা চলছে (লগইন পেজে বাছা ভাষা) সেটাই থাকে
export const preferencesSchema = z.object({
  language: z.enum(LANGUAGE_CODES).nullable(),
  theme: z.enum(THEMES),
});
export type Preferences = z.infer<typeof preferencesSchema>;

// PATCH: যেটা বদলাল শুধু সেটা — ভাষা বদলানো থিমের পুরনো মান ফেরত পাঠিয়ে মুছে দিতে পারে না
export const updatePreferencesInputSchema = z.object({
  language: z.enum(LANGUAGE_CODES).optional(),
  theme: z.enum(THEMES).optional(),
});
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesInputSchema>;

export const meRoutes = {
  updatePreferences: defineRoute({
    method: 'PATCH',
    path: '/me/preferences',
    summary: "Save the signed-in user's language and theme, for every device",
    auth: 'bearer',
    status: 200,
    body: updatePreferencesInputSchema,
    response: preferencesSchema,
  }),
};
```

- `PATCH`, `PUT` না: ভাষার মেনু থেকে শুধু ভাষা আসে, থিমের মেনু থেকে শুধু থিম। PUT হলে ভাষা বদলাতে গিয়ে
  ক্লায়েন্টকে থিমের পুরনো মানও পাঠাতে হতো — আর অন্য ডিভাইসে এর মধ্যে বদলানো থিম চুপচাপ মুছে যেত।
- `LANGUAGE_CODES` এখানে, `packages/i18n`-এ না: contracts শুধু zod নিতে পারে (`contracts-only-zod`), আর সার্ভারকে
  জানতে হবে কোন ভাষা বৈধ। i18n উল্টো দিক থেকে মিলিয়ে নেয় (৬.৬-এর `satisfies`)।

**ফাইল: `packages/contracts/src/auth.ts`** (আপডেট)

import-এ:

```ts
import { preferencesSchema } from './preferences.js';
```

`newPasswordSchema`-র পরে, আর `signUpInputSchema`-তে সেটা ব্যবহার:

```ts
// সাইনআপ আর সেটিংস দুই জায়গায় একই নিয়ম — কোম্পানির নাম tenants.name-এ বসে
export const companyNameSchema = z
  .string()
  .trim()
  .min(2, errorCode('company_name_required'))
  .max(120);

export const signUpInputSchema = z.object({
  companyName: companyNameSchema,
```

`meResponseSchema`-র শেষে এক লাইন:

```ts
  preferences: preferencesSchema,
```

- `companyNameSchema` বের করে আনা — সেটিংসের কোম্পানির নামও একই ঘর (`tenants.name`)। দুই জায়গায় আলাদা নিয়ম
  থাকলে সাইনআপে যা চলে সেটিংসে তা fail করত, বা উল্টো।
- `preferences` যোগ করার সাথে সাথে API-র `auth.service.ts`-এর `me()` আর app-এর `mocks/fixtures.ts`-এ লাল দাগ
  ("Property 'preferences' is missing") — ধাপ ৫-এর চুক্তি-ব্যবস্থা ঠিক যেভাবে কাজ করার কথা।

### সেটিংস

**ফাইল: `packages/contracts/src/settings.ts`** (নতুন)

```ts
import { z } from 'zod';

import { companyNameSchema } from './auth.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// base currency — হিসাবের বই কোন মুদ্রায়। বাংলাদেশের কোম্পানির জন্য আইনত BDT; বাকিগুলো পরে বিদেশি
// টেন্যান্টের জন্য খোলা। ধাপ ১০-এ প্রথম journal পোস্ট হলে এটা আর বদলানো যাবে না
export const CURRENCIES = ['BDT', 'USD', 'EUR', 'GBP', 'INR'] as const;
export type Currency = (typeof CURRENCIES)[number];

// নতুন workspace-এর শুরুর মান: বাংলাদেশের অর্থবছর জুলাই–জুন (CLAUDE.md → Dates)
export const DEFAULT_SETTINGS = {
  baseCurrency: 'BDT',
  fiscalYearStartMonth: 7,
  timezone: 'Asia/Dhaka',
} as const satisfies {
  baseCurrency: Currency;
  fiscalYearStartMonth: number;
  timezone: string;
};

// IANA নাম ('Asia/Dhaka') সত্যিই আছে কি না — Intl নিজেই জানে, আলাদা তালিকা রাখতে হয় না।
// ব্রাউজার আর Node দুজনেরই Intl আছে, তাই ফর্ম আর সার্ভার একই যাচাই চালায়
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// BIN (NBR-এর VAT নিবন্ধন নম্বর) ১৩ অঙ্কের, প্রায়ই "000123456-0101" লেখা হয়। হাইফেন আর স্পেস
// ফেলে শুধু অঙ্ক রাখা — তাহলে একই BIN দুই রকম লেখায় দুবার ঢোকে না, আর Mushak 6.3-এ একই ছাঁদে ছাপা হয়
const binSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((value) => value === '' || /^\d{13}$/.test(value), errorCode('bin_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

// ফাঁকা চলে; লিখলে ঠিক ইমেইল হতে হবে
const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => value === '' || z.email().safeParse(value).success, errorCode('email_invalid'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const settingsSchema = z.object({
  companyName: z.string(),
  legalName: z.string().nullable(),
  bin: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  baseCurrency: z.enum(CURRENCIES),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  timezone: z.string(),
  // url: কিছুক্ষণের জন্য সই করা (presigned) ঠিকানা — <img src>-এ সরাসরি বসে
  logo: z.object({ attachmentId: z.uuid(), url: z.url() }).nullable(),
  version: z.number().int(),
});
export type Settings = z.infer<typeof settingsSchema>;

// PUT: পুরো ফর্ম একসাথে। version = ফর্ম খোলার সময়ের version (optimistic locking)
export const updateSettingsInputSchema = z.object({
  version: versionSchema,
  companyName: companyNameSchema,
  legalName: optionalText(160),
  bin: binSchema,
  phone: optionalText(30),
  email: optionalEmailSchema,
  address: optionalText(300),
  baseCurrency: z.enum(CURRENCIES),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  timezone: z.string().refine(isTimeZone, errorCode('timezone_invalid')),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;

// null = লোগো সরানো
export const setLogoInputSchema = z.object({ attachmentId: z.uuid().nullable() });

export const settingsRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/settings',
    summary: "The active workspace's company profile and regional settings",
    auth: 'bearer',
    status: 200,
    response: settingsSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/settings',
    summary: 'Save the company profile and regional settings',
    auth: 'bearer',
    status: 200,
    body: updateSettingsInputSchema,
    response: settingsSchema,
  }),
  setLogo: defineRoute({
    method: 'PUT',
    path: '/settings/logo',
    summary: 'Set or remove the company logo (an uploaded attachment)',
    auth: 'bearer',
    status: 200,
    body: setLogoInputSchema,
    response: settingsSchema,
  }),
};
```

**কোন লাইন কেন:**

- `CURRENCIES` ছোট তালিকা: বাংলাদেশের কোম্পানির বই আইনত BDT-তে; বাকিগুলো পরে বিদেশি টেন্যান্টের জন্য। পুরো
  ISO 4217 (১৮০টা) drop-down-এ দিলে ভুল করে "BTN" বাছার সুযোগ বাড়ত, লাভ কিছু না।
- `DEFAULT_SETTINGS` — `satisfies`, টাইপ-annotation না: তাহলে `baseCurrency`-র টাইপ থাকে `'BDT'` (literal), আর
  DB-র কলাম-default (৬.২) আর mock দুজনেই একই মান পায়।
- `isTimeZone` — `new Intl.DateTimeFormat(..., { timeZone })` অচেনা নামে `RangeError` দেয়। নিজের তালিকা রাখলে
  IANA-র প্রতিটা হালনাগাদে (নতুন zone, নাম বদল) কোড বদলাতে হতো; Intl ব্রাউজার আর Node-এর সাথেই হালনাগাদ হয়।
  `Intl.supportedValuesOf('timeZone')` দিয়ে যাচাই করা হয়নি: কিছু engine সেই তালিকায় `UTC` রাখে না, অথচ UTC বৈধ।
- `binSchema`-র ক্রম: trim → হাইফেন/স্পেস ফেলা → যাচাই → '' থেকে null। যাচাই আগে হলে `000123456-0101`
  (সবচেয়ে প্রচলিত লেখা) ভুল ধরা পড়ত।
- `refine(..., errorCode('bin_format'))` — pipe-এর পরে refine চলে; ভুল হলে issue-এর `path` `['bin']`, তাই ফর্মে
  ঠিক BIN-এর ঘরের নিচে দেখায় (৬.১-এর টেস্ট সেটা ধরে রাখে)।
- `optionalEmailSchema` — `z.email()` নিজে '' মানে না; তাই refine-এর ভেতরে "ফাঁকা অথবা ঠিক ইমেইল"।
- `logo.url` — presigned GET ঠিকানা (৬.৩)। URL-টাই উত্তরে, attachment id শুধু না: তাহলে `<img>` দেখাতে আরেকটা
  request লাগে না।
- `setLogoInputSchema` আলাদা route, version ছাড়া — কেন, সেটা ৬.৪-এর service-এ (ফর্মের optimistic lock আর
  লোগোর এক-ক্লিক কাজ আলাদা রাখা)।

### ব্রাঞ্চ

**ফাইল: `packages/contracts/src/branches.ts`** (নতুন)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

export const branchSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  // null = চালু। archive করা ব্রাঞ্চ মোছা হয় না: পরে ইনভয়েস আর স্টক তাকে রেফার করবে
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Branch = z.infer<typeof branchSchema>;

// ছোট কোড (HO, GZP, CTG1) — রিপোর্টের কলামে আর পরে ডকুমেন্ট নম্বরে বসার মতো। বড় হাতের অক্ষরে
// রাখা: "gzp" আর "GZP" আলাদা ব্রাঞ্চ হয়ে unique index এড়িয়ে যেত
const branchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, errorCode('branch_code_format'));

export const branchInputSchema = z.object({
  code: branchCodeSchema,
  name: z.string().trim().min(2, errorCode('branch_name_required')).max(120),
  phone: optionalText(30),
  address: optionalText(300),
});
export type BranchInput = z.infer<typeof branchInputSchema>;

export const updateBranchInputSchema = branchInputSchema.extend({ version: versionSchema });

// archive/restore-ও version চায়: কেউ নাম বদলানোর সাথে সাথে অন্যজন পুরনো পাতা থেকে archive চাপলে
// সে জানুক যে ব্রাঞ্চটা বদলে গেছে
export const branchVersionInputSchema = z.object({ version: versionSchema });

export const BRANCH_STATUSES = ['active', 'archived'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export const branchListQuerySchema = z.object({
  status: z.enum(BRANCH_STATUSES).default('active'),
});

// ব্রাঞ্চ গোনা কয়েকটা (বড় কোম্পানিতেও কয়েক ডজন) — তাই keyset পাতা না, পুরো তালিকা একবারে।
// নিয়ম: অসীম তালিকা (সদস্য, audit log, প্রোডাক্ট) পাতায় পাতায়; ছোট master তালিকা একবারে
export const branchListSchema = z.object({ items: z.array(branchSchema) });

const branchParamsSchema = z.object({ id: z.uuid() });

export const branchRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/branches',
    summary: 'Branches and locations of the active workspace',
    auth: 'bearer',
    status: 200,
    query: branchListQuerySchema,
    response: branchListSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/branches/:id',
    summary: 'One branch',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    response: branchSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/branches',
    summary: 'Add a branch',
    auth: 'bearer',
    status: 201,
    body: branchInputSchema,
    response: branchSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/branches/:id',
    summary: 'Edit a branch',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    body: updateBranchInputSchema,
    response: branchSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/branches/:id/archive',
    summary: 'Archive a branch; at least one branch stays active',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    body: branchVersionInputSchema,
    response: branchSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/branches/:id/restore',
    summary: 'Bring an archived branch back',
    auth: 'bearer',
    status: 200,
    params: branchParamsSchema,
    body: branchVersionInputSchema,
    response: branchSchema,
  }),
};
```

- `branchCodeSchema` — `toUpperCase()` যাচাইয়ের আগে: ইউজার `gzp` লিখলে সেটা `GZP` হয়ে unique index-এ মেলে। না হলে
  DB-তে "gzp" আর "GZP" দুটো আলাদা ব্রাঞ্চ হয়ে থাকত, আর রিপোর্টে দুটো একই দেখাত।
- `/^[A-Z0-9]{2,10}$/` — হাইফেন নেই: পরে কোডটা ডকুমেন্ট নম্বরের অংশ হতে পারে (`INV-GZP-…`), যেখানে হাইফেন
  বিভাজক।
- `archivedAt` null/তারিখ, `status: 'active' | 'archived'` কলাম না: কখন archive হয়েছিল সেটাও জানা যায়, আর দুটো
  কলাম (status + তারিখ) একে অন্যের সাথে অমিল হওয়ার সুযোগ নেই।
- `updateBranchInputSchema = branchInputSchema.extend({ version })` — তৈরির ইনপুটে version নেই (নতুন রো-র কোনো
  "পুরনো" অবস্থা নেই), বদলের ইনপুটে বাধ্যতামূলক।
- archive/restore আলাদা route, `PATCH { archivedAt }` না: "archive" একটা ব্যবসার কাজ যার নিজের নিয়ম আছে (শেষ
  চালু ব্রাঞ্চ), আর audit-এ আলাদা action। সাধারণ ফিল্ড-বদলে লুকালে নিয়মটা বদলের কোডের ভেতরে হারাত।
- `params: z.object({ id: z.uuid() })` — প্রথম path parameter। ভাঙা id (`/branches/abc`) 400 পায়
  (`fieldErrors: { id: ['invalid_format'] }`), Postgres-এর uuid-cast error → 500 না।

### নম্বরিং

**ফাইল: `packages/contracts/src/numbering.ts`** (নতুন)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// যেসব ডকুমেন্ট নম্বর পায়। এখনো কোনোটা তৈরি হয়নি (ইনভয়েস ধাপ ১৫, journal ধাপ ১০) — কিন্তু
// নম্বরের ছাঁচ আগে থেকে ঠিক করে রাখা যায়। নতুন ডকুমেন্ট = এখানে এক লাইন + i18n-এ তার নাম
export const DOCUMENT_TYPES = [
  'sales.invoice',
  'sales.order',
  'purchase.order',
  'purchase.bill',
  'inventory.receipt',
  'accounting.journal',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// none: INV-0001 · calendar: INV-2026-0001 · fiscal: INV-2026-27-0001 (অর্থবছর জুলাই থেকে)
export const YEAR_STYLES = ['none', 'calendar', 'fiscal'] as const;
export type YearStyle = (typeof YEAR_STYLES)[number];

export interface NumberFormat {
  prefix: string;
  yearStyle: YearStyle;
  padding: number;
}

const DEFAULT_PREFIXES = {
  'sales.invoice': 'INV',
  'sales.order': 'SO',
  'purchase.order': 'PO',
  'purchase.bill': 'BILL',
  'inventory.receipt': 'GRN',
  'accounting.journal': 'JV',
} satisfies Record<DocumentType, string>;

// টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়
export function defaultNumberFormat(documentType: DocumentType): NumberFormat {
  return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'fiscal', padding: 4 };
}

// ডকুমেন্টের তারিখ কোন সময়কালে পড়ে: '' (কখনো রিসেট না), '2026', বা '2026-27'।
// তারিখ ISO string ('2026-09-23') — ব্যবসার তারিখ, সময় বা টাইমজোন নেই (system-design §১০)।
// Date না নেওয়ার কারণ: new Date('2026-07-01') UTC মধ্যরাত, ঢাকায় সেটা ১ জুলাই সকাল ৬টা, কিন্তু
// UTC-র পশ্চিমের কোনো মেশিনে getMonth() ৩০ জুন দিত — অর্থবছরের ভুল দিকে
export function periodOf(isoDate: string, yearStyle: YearStyle, fiscalYearStartMonth: number) {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (yearStyle === 'none') return '';
  if (yearStyle === 'calendar' || fiscalYearStartMonth === 1) return String(year);
  // জুলাই–জুন: সেপ্টেম্বর ২০২৬ → 2026-27, মার্চ ২০২৭ → 2026-27 (শুরুর বছর আগে)
  const startYear = month >= fiscalYearStartMonth ? year : year - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// INV + 2026-27 + 42 → INV-2026-27-0042। সার্ভার নম্বর দেওয়ার সময় আর UI প্রিভিউয়ে একই ফাংশন —
// দুই জায়গায় আলাদা লিখলে প্রিভিউ আর আসল নম্বর একদিন আলাদা হয়ে যেত
export function formatDocumentNumber(format: NumberFormat, period: string, sequence: number) {
  const number = String(sequence).padStart(format.padding, '0');
  return [format.prefix, period, number].filter((part) => part !== '').join('-');
}

// "আজ" টেন্যান্টের টাইমজোনে: ঢাকায় রাত ১টা মানে UTC-তে এখনো আগের দিন।
// en-CA-র তারিখের ছাঁদ হুবহু ISO: 2026-09-23
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export const numberSeriesSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  prefix: z.string(),
  yearStyle: z.enum(YEAR_STYLES),
  padding: z.number().int(),
  // 0 = টেন্যান্ট কখনো বদলায়নি (ডিফল্ট ছাঁচ, DB-তে রো নেই)
  version: z.number().int().min(0),
  // আজ একটা ডকুমেন্ট হলে কোন নম্বর পেত — কিন্তু নম্বরটা খরচ হয় না (শুধু দেখা)
  nextNumber: z.string(),
});
export type NumberSeries = z.infer<typeof numberSeriesSchema>;

export const numberSeriesListSchema = z.object({ items: z.array(numberSeriesSchema) });

// বড় হাতের অক্ষর দিয়ে শুরু, ৮ অক্ষর পর্যন্ত — হাইফেন নেই, কারণ হাইফেন অংশগুলোর বিভাজক
export const updateNumberSeriesInputSchema = z.object({
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{0,7}$/, errorCode('prefix_format')),
  yearStyle: z.enum(YEAR_STYLES),
  padding: z.number().int().min(3).max(8),
  version: z.number().int().min(0),
});
export type UpdateNumberSeriesInput = z.infer<typeof updateNumberSeriesInputSchema>;

export const numberSeriesRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/number-series',
    summary: 'The numbering format of every document type, with the next number',
    auth: 'bearer',
    status: 200,
    response: numberSeriesListSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/number-series/:documentType',
    summary: "Change a document type's numbering format",
    auth: 'bearer',
    status: 200,
    params: z.object({ documentType: z.enum(DOCUMENT_TYPES) }),
    body: updateNumberSeriesInputSchema,
    response: numberSeriesSchema,
  }),
};
```

**কোন লাইন কেন:**

- `DOCUMENT_TYPES`-এর নামে বিন্দু (`sales.invoice`) — মডিউল.ডকুমেন্ট, permission-এর নামের মতো। URL-এ বিন্দু
  নিরাপদ (`/number-series/sales.invoice`), আর i18n-এ বিন্দু মানে nested key — যেটা ৬.৬-এ কাজে লাগানো হয়েছে।
- `defaultNumberFormat` — `yearStyle: 'fiscal'`: বাংলাদেশে ইনভয়েস নম্বর সাধারণত অর্থবছরে আবার ১ থেকে শুরু হয়।
- `periodOf` ISO string নেয়, `Date` না — মন্তব্যে কারণ: `new Date('2026-07-01')` UTC মধ্যরাত; UTC-র পশ্চিমের
  মেশিনে `getMonth()` দিত জুন। অর্থবছরের সীমানায় এক দিনের ভুল মানে ভুল বছরের নম্বর।
- `(startYear + 1) % 100` আর `padStart(2, '0')` — ২০৯৯-এর পরের বছর `00`, `100` না (টেস্টে ধরা)।
- `fiscalYearStartMonth === 1` হলে শুধু বছর — জানুয়ারি–ডিসেম্বর অর্থবছর আর ক্যালেন্ডার বছর একই সময়কাল, তাই একই
  লেবেল আর একই কাউন্টার।
- `formatDocumentNumber` — `filter(part => part !== '')`: বছর ছাড়া ছাঁচে `INV--0001` (দুটো হাইফেন) হতো না।
  `padStart` ছোট সংখ্যা ভরায়, কিন্তু বড় সংখ্যা কাটে না (`JV-12345`, padding ৩) — নম্বর কখনো হারায় না।
- `todayIn` — `en-CA`-র তারিখের ছাঁদ হুবহু `YYYY-MM-DD`; parts জোড়া দেওয়ার কোড লাগে না। `now` প্যারামিটার শুধু
  টেস্টের জন্য (নির্দিষ্ট মুহূর্তে কোন তারিখ)।
- `version: z.number().int().min(0)` — এখানে ০ বৈধ: "কখনো সেভ হয়নি"। প্রথম সেভ `version: 0` পাঠায় (৬.৪)।
- `prefix`-এ হাইফেন নেই আর প্রথমে অক্ষর: `2026-INV` বা `IN-V` দিলে নম্বর পড়ে কোন অংশ কী বোঝা যেত না।

### audit

**ফাইল: `packages/contracts/src/audit.ts`** (নতুন)

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// audit log-এ যত রকম ঘটনা লেখা হয়। সার্ভার শুধু এগুলোই লিখতে পারে (টাইপ-চেকড), আর UI প্রতিটার
// লেখা i18n-এর audit.actions.*-এ রাখে (en.ts-এর satisfies নতুন action-এর অনুবাদ ভুলতে দেয় না)
export const AUDIT_ACTIONS = [
  'workspace.created',
  'auth.signed_in',
  'auth.switched_in',
  'settings.updated',
  'settings.logo_changed',
  'branch.created',
  'branch.updated',
  'branch.archived',
  'branch.restored',
  'number_series.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTIONS.some((action) => action === value);
}

// settings-এর entity = workspace নিজে (entityId = tenant id)
export const AUDIT_ENTITY_TYPES = ['workspace', 'user', 'branch', 'number_series'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// পুরনো আর নতুন মান শুধু সরল মান — পুরো object না। তাতে viewer-এ "নাম: X → Y" সোজা দেখানো যায়,
// আর কেউ ভুল করে গোটা রো (পাসওয়ার্ড hash সহ) audit-এ ঢুকিয়ে দিতে পারে না
export const auditValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AuditValue = z.infer<typeof auditValueSchema>;

export const auditChangesSchema = z.record(
  z.string(),
  z.object({ from: auditValueSchema, to: auditValueSchema }),
);
export type AuditChanges = z.infer<typeof auditChangesSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  // z.string(), enum না: নতুন সার্ভারের নতুন action পুরনো অফলাইন ক্লায়েন্টে parse ভাঙে না
  // (error code-এর মতোই, ধাপ ৫); UI isAuditAction() দিয়ে চেনে, অচেনা হলে কাঁচা নাম দেখায়
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid(),
  // null = সিস্টেম নিজে (পরে ধাপ ৮-এর background job)
  actor: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  changes: auditChangesSchema,
  ipAddress: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListQuerySchema = pageQuerySchema.extend({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  // একটা নির্দিষ্ট ব্রাঞ্চের ইতিহাস — entityType-এর সাথে
  entityId: z.uuid().optional(),
});

export const auditPageSchema = pageOf(auditEntrySchema);
export type AuditPage = z.infer<typeof auditPageSchema>;

export const auditRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/audit-logs',
    summary: 'Who changed what in the workspace, newest first',
    auth: 'bearer',
    status: 200,
    query: auditListQuerySchema,
    response: auditPageSchema,
  }),
};
```

- `AUDIT_ACTIONS` চুক্তিতে, আর সার্ভারের `audit()` শুধু এই union নেয় (৬.৩) — বানান ভুল করা action ("brach.created")
  compile error। UI-র প্রতিটা action-এর লেখা আছে কি না, সেটা i18n-এর key-টাইপ ধরে (৬.৮)।
- `auditValueSchema` — সরল মান মাত্র। ইচ্ছা করে কড়া: কেউ `diff(before, after)`-এ পুরো DB রো পাঠালে (hash, Date
  সহ) টাইপ-চেক ভাঙে। (৬.৪-এ দেখবেন TypeScript-এর একটা ফাঁক দিয়ে ঠিক এটা ঢুকতে যাচ্ছিল।)
- `action: z.string()` — উত্তরে enum না: নতুন সার্ভার নতুন action লিখলে পুরনো অফলাইন PWA parse-এ ভেঙে না পড়ে
  কাঁচা নামটা দেখায় (ধাপ ৫-এর error code-এর একই যুক্তি)।
- `ipAddress`, `requestId` nullable — background job-এর audit-এ (ধাপ ৮) এগুলো থাকবে না।
- `entityType` আর `entityId` দুটোই ফিল্টার: "এই ব্রাঞ্চের পুরো ইতিহাস" — ধাপ ৭-এর পরে প্রতিটা রিসোর্সের পাতায়
  একটা "ইতিহাস" ট্যাব এই query দিয়েই হবে।

### attachments

**ফাইল: `packages/contracts/src/attachments.ts`** (নতুন)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// ফাইল কী কাজে লাগবে — প্রতিটার নিজের আকার আর ধরনের সীমা। নতুন কাজ (ইনভয়েস PDF, খরচের রসিদ)
// = এখানে এক লাইন
export const ATTACHMENT_PURPOSES = ['company_logo'] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

interface AttachmentRule {
  maxBytes: number;
  contentTypes: readonly string[];
}

// SVG নেই ইচ্ছা করে: SVG-র ভেতরে <script> থাকতে পারে। ছবির ঠিকানা সরাসরি খুললে সেই script চলত
export const ATTACHMENT_RULES = {
  company_logo: {
    maxBytes: 2 * 1024 * 1024,
    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
  },
} satisfies Record<AttachmentPurpose, AttachmentRule>;

// ফাইল পাঠানোর আগে শুধু তার বর্ণনা — ফাইল নিজে API-তে আসে না, সরাসরি storage-এ যায়।
// ব্রাউজারও আগে থেকে একই schema দিয়ে যাচাই করে: ৩০ MB-র ছবি বাছলে আপলোড শুরুর আগেই error
export const createUploadInputSchema = z
  .object({
    purpose: z.enum(ATTACHMENT_PURPOSES),
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().max(100),
    sizeBytes: z.number().int().positive(),
  })
  .superRefine((input, ctx) => {
    const rule: AttachmentRule = ATTACHMENT_RULES[input.purpose];
    if (!rule.contentTypes.includes(input.contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: errorCode('file_type_not_allowed'),
      });
    }
    if (input.sizeBytes > rule.maxBytes) {
      ctx.addIssue({ code: 'custom', path: ['sizeBytes'], message: errorCode('file_too_large') });
    }
  });
export type CreateUploadInput = z.infer<typeof createUploadInputSchema>;

export const attachmentSchema = z.object({
  id: z.uuid(),
  purpose: z.enum(ATTACHMENT_PURPOSES),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  // pending = ঠিকানা দেওয়া হয়েছে, ফাইল এখনো যাচাই হয়নি; ready = storage-এ আছে, আকার-ধরন মিলেছে
  status: z.enum(['pending', 'ready']),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const uploadTicketSchema = z.object({
  attachment: attachmentSchema,
  // ব্রাউজার ঠিক এই method, ঠিকানা আর header দিয়ে ফাইল পাঠাবে — header না মিললে storage সই
  // মানবে না (Content-Type সইয়ের অংশ)
  upload: z.object({
    method: z.literal('PUT'),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  }),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

export const signedUrlSchema = z.object({ url: z.url(), expiresAt: z.iso.datetime() });

const attachmentParamsSchema = z.object({ id: z.uuid() });

export const attachmentRoutes = {
  createUpload: defineRoute({
    method: 'POST',
    path: '/attachments',
    summary: 'Describe a file and get a short-lived URL to upload it to storage',
    auth: 'bearer',
    status: 201,
    body: createUploadInputSchema,
    response: uploadTicketSchema,
  }),
  complete: defineRoute({
    method: 'POST',
    path: '/attachments/:id/complete',
    summary: 'Confirm the upload; the server checks the stored file matches',
    auth: 'bearer',
    status: 200,
    params: attachmentParamsSchema,
    response: attachmentSchema,
  }),
  download: defineRoute({
    method: 'GET',
    path: '/attachments/:id/download',
    summary: 'A short-lived URL to read the file',
    auth: 'bearer',
    status: 200,
    params: attachmentParamsSchema,
    response: signedUrlSchema,
  }),
};
```

- `ATTACHMENT_RULES` চুক্তিতে: ব্রাউজার আপলোডের **আগেই** একই নিয়মে যাচাই করে (৩০ MB-র ছবি বাছলে এক মুহূর্তে
  error, আপলোড শুরুই হয় না), আর ফাইল বাছার জানালার `accept` এখান থেকে। সার্ভারও একই schema-য় parse করে — দুই
  জায়গার নিয়ম কখনো আলাদা হয় না।
- `const rule: AttachmentRule = …` — টাইপ চওড়া করা। নাহলে `contentTypes`-এর টাইপ থাকত literal-এর tuple
  (`'image/png' | …`), আর `.includes(input.contentType)` (string) compile error দিত।
- `superRefine` — দুটো ভুল একসাথে, প্রতিটা নিজের ঘরে (`contentType`, `sizeBytes`)। `.refine()` একটা বার্তাই
  দেয় আর প্রথম ভুলে থামে।
- `upload.headers` উত্তরে: ব্রাউজারকে ঠিক কোন header পাঠাতে হবে তা সার্ভার বলে দেয়। Content-Type সইয়ের অংশ
  (৬.৩) — ক্লায়েন্ট নিজে অনুমান করলে একদিন অমিল হয়ে 403 হতো।
- `complete`-এর body নেই: কী আপলোড হওয়ার কথা তা সার্ভার নিজের রো থেকে জানে। ক্লায়েন্টের "আকার ১০ বাইট"
  বিশ্বাস করার কিছু নেই।

### রেজিস্ট্রি আর export

**ফাইল: `packages/contracts/src/routes.ts`** (আপডেট)

```ts
import { z } from 'zod';

import { attachmentRoutes } from './attachments.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { branchRoutes } from './branches.js';
import { defineRoute } from './http.js';
import { memberRoutes } from './members.js';
import { numberSeriesRoutes } from './numbering.js';
import { meRoutes } from './preferences.js';
import { settingsRoutes } from './settings.js';

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
  me: meRoutes,
  members: memberRoutes,
  settings: settingsRoutes,
  branches: branchRoutes,
  numberSeries: numberSeriesRoutes,
  audit: auditRoutes,
  attachments: attachmentRoutes,
};
```

**ফাইল: `packages/contracts/src/index.ts`** (পুরো ফাইল)

```ts
export * from './attachments.js';
export * from './audit.js';
export * from './auth.js';
export * from './branches.js';
export * from './errors.js';
export * from './fields.js';
export * from './http.js';
export * from './members.js';
export * from './numbering.js';
export * from './pagination.js';
export * from './preferences.js';
export * from './routes.js';
export * from './settings.js';
```

- `routes`-এ গ্রুপের ক্রম OpenAPI-র tag আর Scalar-এর বাঁ দিকের তালিকার ক্রম।
- এই মুহূর্তে API-র `contract.spec.ts` fail করবে ("serves exactly the routes…") — রেজিস্ট্রিতে ১৩টা নতুন রুট,
  Nest-এ একটাও না। ৬.৪ শেষে আবার সবুজ।

### টেস্ট

**ফাইল: `packages/contracts/src/numbering.spec.ts`** (নতুন)

```ts
import { describe, expect, it } from 'vitest';

import {
  formatDocumentNumber,
  periodOf,
  todayIn,
  updateNumberSeriesInputSchema,
} from './numbering.js';

describe('periodOf', () => {
  it('splits a July–June fiscal year at the start month', () => {
    expect(periodOf('2026-06-30', 'fiscal', 7)).toBe('2025-26');
    expect(periodOf('2026-07-01', 'fiscal', 7)).toBe('2026-27');
    expect(periodOf('2027-03-15', 'fiscal', 7)).toBe('2026-27');
  });

  it('uses the plain year for calendar years and January fiscal years', () => {
    expect(periodOf('2026-09-23', 'calendar', 7)).toBe('2026');
    expect(periodOf('2026-09-23', 'fiscal', 1)).toBe('2026');
  });

  it('never resets when the year is left out', () => {
    expect(periodOf('2026-09-23', 'none', 7)).toBe('');
  });

  it('writes the century boundary as two digits', () => {
    expect(periodOf('2099-12-01', 'fiscal', 7)).toBe('2099-00');
  });
});

describe('formatDocumentNumber', () => {
  it('joins prefix, period and the padded sequence with hyphens', () => {
    const format = { prefix: 'INV', yearStyle: 'fiscal', padding: 4 } as const;
    expect(formatDocumentNumber(format, '2026-27', 42)).toBe('INV-2026-27-0042');
    expect(formatDocumentNumber({ ...format, yearStyle: 'none' }, '', 7)).toBe('INV-0007');
  });

  it('lets the sequence grow past the padding instead of cutting it', () => {
    expect(formatDocumentNumber({ prefix: 'JV', yearStyle: 'none', padding: 3 }, '', 12345)).toBe(
      'JV-12345',
    );
  });
});

describe('todayIn', () => {
  it("gives the tenant's date, not the server's", () => {
    // 23 Sep 19:30 UTC = 24 Sep 01:30 in Dhaka (UTC+6)
    const instant = new Date('2026-09-23T19:30:00Z');
    expect(todayIn('Asia/Dhaka', instant)).toBe('2026-09-24');
    expect(todayIn('UTC', instant)).toBe('2026-09-23');
  });
});

describe('number series input', () => {
  it('upper-cases the prefix and refuses hyphens inside it', () => {
    const base = { yearStyle: 'fiscal', padding: 4, version: 0 } as const;
    expect(updateNumberSeriesInputSchema.parse({ ...base, prefix: ' inv ' }).prefix).toBe('INV');
    const result = updateNumberSeriesInputSchema.safeParse({ ...base, prefix: 'IN-V' });
    expect(result.error?.issues[0]?.message).toBe('prefix_format');
  });
});
```

**ফাইল: `packages/contracts/src/settings.spec.ts`** (নতুন)

```ts
import { describe, expect, it } from 'vitest';

import { createUploadInputSchema } from './attachments.js';
import { branchInputSchema } from './branches.js';
import { isTimeZone, updateSettingsInputSchema } from './settings.js';

const valid = {
  version: 1,
  companyName: 'Rahman Garments Ltd.',
  legalName: '',
  bin: '',
  phone: '',
  email: '',
  address: '',
  baseCurrency: 'BDT',
  fiscalYearStartMonth: 7,
  timezone: 'Asia/Dhaka',
} as const;

describe('settings input', () => {
  it('stores empty optional fields as null, not as empty strings', () => {
    const parsed = updateSettingsInputSchema.parse(valid);
    expect(parsed).toMatchObject({ legalName: null, bin: null, phone: null, email: null });
  });

  it('keeps only the digits of a BIN written with a hyphen', () => {
    const parsed = updateSettingsInputSchema.parse({ ...valid, bin: '000123456-0101' });
    expect(parsed.bin).toBe('0001234560101');
  });

  it('refuses a BIN that is not 13 digits, with a field code', () => {
    const result = updateSettingsInputSchema.safeParse({ ...valid, bin: '12345' });
    expect(result.error?.issues[0]).toMatchObject({ path: ['bin'], message: 'bin_format' });
  });

  it('checks the time zone against Intl', () => {
    expect(isTimeZone('Asia/Dhaka')).toBe(true);
    expect(isTimeZone('Asia/Gazipur')).toBe(false);
  });
});

describe('branch input', () => {
  it('upper-cases the code so gzp and GZP are the same branch', () => {
    const parsed = branchInputSchema.parse({
      code: 'gzp',
      name: 'Gazipur factory',
      phone: '',
      address: '',
    });
    expect(parsed.code).toBe('GZP');
  });
});

describe('upload input', () => {
  it('refuses an SVG logo and an oversized one, on the right fields', () => {
    const result = createUploadInputSchema.safeParse({
      purpose: 'company_logo',
      fileName: 'logo.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 3 * 1024 * 1024,
    });
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['contentType', 'file_type_not_allowed'],
      ['sizeBytes', 'file_too_large'],
    ]);
  });
});
```

- অর্থবছরের সীমানা দুই দিক থেকে: ৩০ জুন (আগের বছর) আর ১ জুলাই (নতুন) — এক দিনের ভুল ঠিক এখানেই হয়।
- `todayIn`-এর টেস্ট একটা নির্দিষ্ট মুহূর্ত নেয় (ঢাকায় পরের দিন, UTC-তে আগের দিন) — "আজ" দিয়ে লিখলে টেস্ট
  দিনের কোন সময়ে চলছে তার উপর নির্ভর করত।
- `error?.issues[0]` — `safeParse`-এর ফল union; সফল হলে `error` undefined, তাই optional chaining-এ narrow। cast
  লাগে না।

---

## ৬.২ — `packages/db`: টেবিল, migration, permission

### dependency

**ফাইল: `packages/db/package.json`** (আপডেট — `dependencies`-এ, বর্ণানুক্রমে প্রথমে)

```json
    "@omnivo/contracts": "workspace:*",
```

তারপর root-এ `pnpm install`। turbo-র `^build` নিজেই ক্রম ঠিক রাখে: contracts আগে build হয়, তারপর db।

### নতুন টেবিল

**ফাইল: `packages/db/src/schema/tenant-settings.ts`** (নতুন)

```ts
import { CURRENCIES, DEFAULT_SETTINGS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { attachments } from './attachments.js';
import { tenants } from './tenants.js';

// প্রতি টেন্যান্টে ঠিক একটা রো, তাই tenant_id নিজেই primary key — আলাদা id লাগে না, আর "একটার বেশি
// settings রো" অবস্থা DB-লেভেলেই অসম্ভব। কোম্পানির নাম এখানে না: সেটা tenants.name-এ, কারণ লগইন আর
// workspace switcher সেটা tenant context ছাড়াই পড়ে
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    legalName: text('legal_name'),
    bin: text('bin'),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    baseCurrency: text('base_currency', { enum: CURRENCIES })
      .notNull()
      .default(DEFAULT_SETTINGS.baseCurrency),
    fiscalYearStartMonth: smallint('fiscal_year_start_month')
      .notNull()
      .default(DEFAULT_SETTINGS.fiscalYearStartMonth),
    timezone: text('timezone').notNull().default(DEFAULT_SETTINGS.timezone),
    logoAttachmentId: uuid('logo_attachment_id'),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    check(
      'tenant_settings_fiscal_month_check',
      sql`${table.fiscalYearStartMonth} BETWEEN 1 AND 12`,
    ),
    // composite FK: লোগো হিসেবে অন্য টেন্যান্টের ফাইল বসানো DB-লেভেলেই অসম্ভব। NULL হলে চেক হয় না
    foreignKey({
      name: 'tenant_settings_logo_fk',
      columns: [table.tenantId, table.logoAttachmentId],
      foreignColumns: [attachments.tenantId, attachments.id],
    }),
  ],
);
```

**কোন লাইন কেন:**

- `tenantId: uuid('tenant_id').primaryKey()` — `baseColumns()`-এর `id` নেওয়া হয়নি। একটা টেন্যান্টের একাধিক
  settings রো থাকলে কোনটা আসল? PK নিজেই সেই প্রশ্ন অসম্ভব করে। RLS-এর নিয়ম (index `tenant_id` দিয়ে শুরু) PK
  নিজেই মানে।
- কোম্পানির নাম এখানে না — `tenants.name`-এ থেকে যায়। লগইন (`findTenantBySlug`) আর switcher (`withUser`) tenant
  context ছাড়া চলে; এই টেবিলে FORCE RLS, তাই তারা এখান থেকে পড়তে পারত না।
- `.default(DEFAULT_SETTINGS.…)` — DB-র default আর contracts-এর default একই উৎস থেকে; migration 0008-এর backfill
  শুধু `tenant_id` দেয়, বাকিটা এই default থেকে আসে।
- `smallint` — ১–১২-এর জন্য `integer` অপচয়; আর `check()` DB-লেভেলে ১৩ মাস ঠেকায় (কেউ সরাসরি SQL-এ লিখলেও)।
- `logoAttachmentId`-এর composite FK `(tenant_id, logo_attachment_id)` → `attachments(tenant_id, id)`: FK চেক RLS
  মানে না (ধাপ ৩-এর role_permissions-এর মতো) — সাধারণ FK দিলে অন্য টেন্যান্টের ফাইলের id বসানো DB-র চোখে বৈধ হতো।
  কলাম NULL হলে FK চেকই হয় না (MATCH SIMPLE), তাই "লোগো নেই" চলে।
- `updatedBy`, `version` আছে, `createdBy`/`deletedAt` নেই — settings তৈরি হয় সাইনআপের সাথে (কে তা workspace.created-এর
  audit-এ) আর কখনো মোছা হয় না।

**ফাইল: `packages/db/src/schema/branches.ts`** (নতুন)

```ts
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const branches = pgTable(
  'branches',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    address: text('address'),
    // deleted_at না, archived_at: পরে ইনভয়েস আর স্টক ব্রাঞ্চকে রেফার করবে, তাই মোছা যায় না —
    // শুধু নতুন কাজে আর দেখানো হয় না। deleted_at (baseColumns-এর) এই টেবিলে ব্যবহার হয় না
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // archive করা ব্রাঞ্চের কোডও ধরা থাকে — পুরনো রিপোর্টে "GZP" যেন দুটো আলাদা ব্রাঞ্চ না বোঝায়
    uniqueIndex('branches_tenant_code_idx').on(table.tenantId, table.code),
    // পরের ধাপের composite FK-এর target (ইনভয়েস → একই টেন্যান্টের ব্রাঞ্চ)
    uniqueIndex('branches_tenant_id_idx').on(table.tenantId, table.id),
  ],
);
```

- `branches_tenant_code_idx` archive করা রো-সহ অনন্য — partial index (`WHERE archived_at IS NULL`) দিলে বন্ধ
  "GZP"-এর কোড নতুন ব্রাঞ্চ নিতে পারত, আর তিন বছর পুরনো রিপোর্টে "GZP" কোনটা বোঝা যেত না।
- `branches_tenant_id_idx` এখন কেউ ব্যবহার করে না — কিন্তু ইনভয়েস (ধাপ ১৫) যখন `(tenant_id, branch_id)` দিয়ে
  composite FK দেবে, target-টা তৈরি থাকবে। তখন যোগ করলে বড় টেবিলে index বানাতে lock লাগত।
- তালিকা `ORDER BY code` — `(tenant_id, code)` unique index সেটাই ঢেকে দেয়, আলাদা index লাগে না।

**ফাইল: `packages/db/src/schema/number-series.ts`** (নতুন)

```ts
import { DOCUMENT_TYPES, YEAR_STYLES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// টেন্যান্ট নিজের মতো বদলালে তবেই রো — না থাকলে contracts-এর defaultNumberFormat()। তাই নতুন
// ডকুমেন্ট টাইপ যোগ করলে পুরনো সব টেন্যান্টের জন্য backfill migration লাগে না
export const numberSeries = pgTable(
  'number_series',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentType: text('document_type', { enum: DOCUMENT_TYPES }).notNull(),
    prefix: text('prefix').notNull(),
    yearStyle: text('year_style', { enum: YEAR_STYLES }).notNull(),
    padding: smallint('padding').notNull(),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    uniqueIndex('number_series_tenant_type_idx').on(table.tenantId, table.documentType),
    check('number_series_padding_check', sql`${table.padding} BETWEEN 3 AND 8`),
  ],
);

// কোন সময়কালে শেষ কোন নম্বর দেওয়া হয়েছে। Postgres SEQUENCE না, কারণ sequence rollback মানে না:
// ইনভয়েস সেভ ব্যর্থ হলেও নম্বর খরচ হয়ে যেত, আর VAT অডিটে INV-0041-এর পরে INV-0043 মানে
// "০০৪২ কোথায়?" প্রশ্ন। এই রো একই transaction-এ বাড়ে, তাই rollback হলে নম্বরও ফেরত আসে
export const numberSeriesCounters = pgTable(
  'number_series_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentType: text('document_type', { enum: DOCUMENT_TYPES }).notNull(),
    // periodOf()-এর মান ('2026-27', '2026'); বছর ছাড়া ছাঁচে 'all'
    period: text('period').notNull(),
    // mode 'number': ২^৫৩ পর্যন্ত নির্ভুল — এক টেন্যান্টের এক বছরের ইনভয়েস তার ধারেকাছেও যাবে না
    lastValue: bigint('last_value', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.documentType, table.period] })],
);
```

- `number_series`-এ `id` আছে (uuid) যদিও লোকে খোঁজে `(tenant_id, document_type)` দিয়ে: audit-এর `entity_id` uuid
  কলাম (ধাপ ১ থেকে)। সেই কারণেই রো-র একটা স্থির uuid লাগে।
- কাউন্টারের PK `(tenant_id, document_type, period)` — আলাদা id নেই, কারণ এই তিনটাই রো-র পরিচয়, আর
  `ON CONFLICT (…)`-এর target এই PK।
- কাউন্টারে `number_series`-এর FK নেই: ছাঁচ সেভ না করা টেন্যান্টেরও নম্বর লাগবে (ডিফল্ট ছাঁচে), তখন
  `number_series`-এ রো-ই নেই।
- `bigint` `mode: 'number'` — `'bigint'` মোডে JS-এ `BigInt` আসত, যা JSON-এ যায় না আর প্রতিটা হিসাবে রূপান্তর লাগত।
  ২^৫৩ ≈ ৯ কোয়াড্রিলিয়ন — এক অর্থবছরে এক টেন্যান্টের ইনভয়েস সেখানে পৌঁছাবে না।

**ফাইল: `packages/db/src/schema/attachments.ts`** (নতুন)

```ts
import { ATTACHMENT_PURPOSES } from '@omnivo/contracts';
import { integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// ফাইলের বর্ণনা — ফাইল নিজে S3/MinIO-তে। storage_key-এ ফাইলের নাম নেই ইচ্ছা করে: ইউজারের দেওয়া নাম
// ("../../x" বা বাংলা অক্ষর) পাথে বসালে পাথ ভাঙার ঝুঁকি; নাম শুধু এই টেবিলে দেখানোর জন্য
export const attachments = pgTable(
  'attachments',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    purpose: text('purpose', { enum: ATTACHMENT_PURPOSES }).notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status', { enum: ['pending', 'ready'] })
      .notNull()
      .default('pending'),
  },
  (table) => [
    uniqueIndex('attachments_storage_key_idx').on(table.storageKey),
    // tenant_settings-এর লোগোর composite FK-এর target
    uniqueIndex('attachments_tenant_id_idx').on(table.tenantId, table.id),
  ],
);
```

- `storage_key` unique — দুটো রো একই ফাইলকে দেখালে একটা মুছলে অন্যটা ভাঙত।
- `status` default `'pending'`: রো তৈরি হয় ফাইল আসার **আগে** (সই করা ঠিকানা দেওয়ার সময়)।
- `size_bytes` `integer` — ২ GB-র উপরে ফাইল এই অ্যাপে আসবে না; আসলে `bigint`-এ বদলানো সহজ migration।

### বদলানো টেবিল

**ফাইল: `packages/db/src/schema/audit-logs.ts`** (পুরো ফাইল)

```ts
import type { AuditAction, AuditChanges, AuditEntityType } from '@omnivo/contracts';
import { pgTable, uuid, text, jsonb, timestamp, index, inet } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// JSON-এ কী থাকে: বদলানো ফিল্ডগুলোর পুরনো আর নতুন মান (সরল মান, পুরো রো না)
export interface AuditPayload {
  changes: AuditChanges;
}

// append-only: omnivo_app-এর UPDATE/DELETE অধিকার migration-এ REVOKE করা,
// তাই version/updated_*/deleted_at কলামের দরকার নেই
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorUserId: uuid('actor_user_id'),
    // $type: DB-তে সাধারণ text (পুরনো রো-র action পরে নাম বদলালেও টিকে থাকে), কিন্তু কোড শুধু
    // contracts-এর তালিকার মান লিখতে পারে
    action: text('action').$type<AuditAction>().notNull(),
    entityType: text('entity_type').$type<AuditEntityType>().notNull(),
    entityId: uuid('entity_id').notNull(),
    payload: jsonb('payload').$type<AuditPayload>(),
    // কোন request থেকে — সাপোর্টে "এই বদলটা কোন ডিভাইস থেকে?" প্রশ্নের উত্তর, আর error লগের সাথে মেলানো
    requestId: text('request_id'),
    // inet: Postgres নিজেই IP-র আকার যাচাই করে, আর পরে "এই subnet থেকে" খোঁজা যায়
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // viewer: নতুন আগে, keyset (created_at, id) — id একই মুহূর্তের রো-গুলোর টাই ভাঙে
    index('audit_logs_tenant_created_id_idx').on(table.tenantId, table.createdAt, table.id),
    // একটা জিনিসের ইতিহাস ("এই ব্রাঞ্চে কে কী বদলাল")
    index('audit_logs_tenant_entity_idx').on(
      table.tenantId,
      table.entityType,
      table.entityId,
      table.createdAt,
      table.id,
    ),
  ],
);
```

- `$type<AuditAction>()` — DB-তে সাধারণ `text` থাকে (CHECK নেই): action-এর নাম কোনোদিন বদলালে পুরনো লক্ষ লক্ষ রো
  migrate করতে হতো। শুধু **লেখার** সময় টাইপ-চেক — পুরনো রো যেমন ছিল তেমন।
- `payload` কলাম পুনর্ব্যবহার, নতুন `changes` কলাম না: কলামের নাম বদলাতে গেলে drizzle-kit জিজ্ঞেস করে
  "rename না drop+create?" (ধাপ ৩-এর দুই-ধাপ migration-এর গল্প)। `{ changes }` অবজেক্টে মোড়ানো — পরে অন্য তথ্য
  (যেমন "কোন ডিভাইস") ঢোকানো যায় আকার না ভেঙে।
- পুরনো `(tenant_id, created_at)` index বাদ, জায়গায় `(tenant_id, created_at, id)`: viewer `ORDER BY created_at
  DESC, id DESC` — index-এ id না থাকলে একই মুহূর্তের রো-গুলো Postgres-কে আলাদা করে sort করতে হতো।
- `audit_logs_tenant_entity_idx` — "এই ব্রাঞ্চের ইতিহাস" query `entity_type`, `entity_id` দিয়ে filter আর
  created_at দিয়ে sort — কলামের ক্রম ঠিক সেটাই।

**ফাইল: `packages/db/src/schema/users.ts`** (আপডেট)

import-এ:

```ts
import { LANGUAGE_CODES, THEMES } from '@omnivo/contracts';
```

`image`-এর পরে:

```ts
    // ইউজারের পছন্দ — টেন্যান্টের না, তাই এখানে (users-এ RLS নেই, প্রতিটা workspace-এ একই)।
    // language NULL = এখনো বাছেনি; তখন ডিভাইসে যা চলছে তাই থাকে
    language: text('language', { enum: LANGUAGE_CODES }),
    theme: text('theme', { enum: THEMES }).notNull().default('system'),
```

- `text(..., { enum })` — drizzle-এর enum শুধু TypeScript-এ (DB-তে সাধারণ text); Postgres-এর `CREATE TYPE … AS
  ENUM` না, কারণ enum-এ মান যোগ করা migration-এ ঝামেলার (transaction-এর ভেতরে `ALTER TYPE ADD VALUE` চলে না)।
- `language` nullable, `theme`-এর default আছে — "থিম না বাছা" মানে সবসময় "ডিভাইসের মতো", কিন্তু "ভাষা না বাছা"
  মানে "এই ডিভাইসে যা চলছে" — সেটা সার্ভার জানে না।

**ফাইল: `packages/db/src/schema/index.ts`** (আপডেট — শেষে)

```ts
export * from './attachments.js';
export * from './tenant-settings.js';
export * from './branches.js';
export * from './number-series.js';
```

- `attachments` আগে: `tenant-settings.ts` তাকে import করে (FK)। ESM-এ ক্রম আসলে সমস্যা না, কিন্তু পড়তে সুবিধা।

### permission আর Owner

**ফাইল: `packages/db/src/permission-catalog.ts`** (পুরো ফাইল)

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions, rolePermissions, roles, tenants } from './schema/index.js';

// সিস্টেম-জোড়া permission-এর একমাত্র উৎস। নতুন permission এলে শুধু এখানে যোগ হবে —
// DB-তে তোলে syncPermissions(), আর @RequirePermission() এই তালিকা থেকেই টাইপ পায়
export const PERMISSIONS = [
  { key: 'core.user.read', description: 'View users in the workspace' },
  { key: 'core.user.invite', description: 'Invite users to the workspace' },
  { key: 'core.role.manage', description: 'Create roles and assign permissions' },
  {
    key: 'core.settings.manage',
    description: 'Edit the company profile, regional settings and numbering',
  },
  { key: 'core.branch.manage', description: 'Add, edit and archive branches' },
  { key: 'core.audit.read', description: 'View the audit log' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

// signup-এ যে রোল তৈরি হয় আর সব permission পায়
export const OWNER_ROLE_NAME = 'Owner';

// Pick<..., 'insert'>: migrate-এর plain db, createDb()-এর Db, বা transaction-এর tx — সবই চলে
// idempotent: নতুন key যোগ হয়, পুরনো key-এর description আপডেট হয়; কিছু মোছে না
export async function syncPermissions(db: Pick<PostgresJsDatabase, 'insert'>): Promise<void> {
  await db
    .insert(permissions)
    .values([...PERMISSIONS])
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sql`excluded.description` },
    });
}

// Owner মানে "সব অনুমতি" — কিন্তু সেটা ডেটায় লেখা, কোডে না। তাই নতুন permission যোগ হলে (এই ধাপে
// settings, branch, audit) পুরনো workspace-এর Owner আপনা-আপনি পায় না; signup শুধু নতুনদের দেয়।
// migrate প্রতিবার এটা চালায়: idempotent, যা আছে তা থাকে। role_permissions-এ FORCE RLS, তাই
// প্রতিটা টেন্যান্টের জন্য আলাদা transaction-এ tenant context বসিয়ে
export async function grantOwnerPermissions(db: PostgresJsDatabase): Promise<void> {
  const allPermissions = await db.select({ id: permissions.id }).from(permissions);
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(isNull(tenants.deletedAt));
  for (const tenant of tenantRows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);
      const [owner] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(
          and(
            eq(roles.tenantId, tenant.id),
            eq(roles.name, OWNER_ROLE_NAME),
            isNull(roles.deletedAt),
          ),
        );
      if (!owner || allPermissions.length === 0) return;
      await tx
        .insert(rolePermissions)
        .values(
          allPermissions.map((permission) => ({
            tenantId: tenant.id,
            roleId: owner.id,
            permissionId: permission.id,
          })),
        )
        .onConflictDoNothing();
    });
  }
}
```

**কোন লাইন কেন:**

- তিনটা নতুন permission — নাম `মডিউল.রিসোর্স.কাজ`, আগের তিনটার মতো। `core.audit.read` আলাদা: audit-এ IP আর
  কে-কখন-লগইন আছে; হিসাবরক্ষক সেটিংস বদলাতে পারলেও সবার লগইনের ইতিহাস দেখা তার দরকার নাও হতে পারে।
- `grantOwnerPermissions` — প্রতিটা টেন্যান্টে আলাদা transaction আর `set_config(..., true)`: `role_permissions`-এ
  FORCE RLS; migrator টেবিলের মালিক হলেও tenant context ছাড়া লিখতে পারে না (ধাপ ১-এর নিয়ম, ইচ্ছাকৃত)।
- `onConflictDoNothing()` — unique index `(tenant_id, role_id, permission_id)` আছে; যা আছে তা থাকে, নতুনটা বসে।
  বারবার চালানো নিরাপদ।
- `isNull(tenants.deletedAt)` — মুছে ফেলা টেন্যান্টকে নতুন অধিকার দেওয়ার মানে নেই।
- দাম: প্রতিটা deploy-এ টেন্যান্টপ্রতি একটা ছোট transaction। ১০০০ টেন্যান্টে কয়েক সেকেন্ড; লাখে পৌঁছালে "Owner
  = কোডে সব অধিকার" বা শুধু নতুন permission যোগ হলে চালানো — ধাপ ৭-এর রোল-ডিজাইনের সাথে ভাবার জিনিস (শেষের নোট)।

**ফাইল: `packages/db/src/migrate.ts`** (আপডেট)

```ts
import { grantOwnerPermissions, syncPermissions } from './permission-catalog.js';
```

`await syncPermissions(db);`-এর পরে:

```ts
  // নতুন permission পুরনো workspace-এর Owner-কেও — নাহলে এই ধাপের স্ক্রিনগুলো মালিক নিজেই খুলতে পারত না
  await grantOwnerPermissions(db);
```

- ক্রম: আগে sync (নতুন permission রো তৈরি), তারপর grant (সেগুলো Owner-কে)। উল্টো হলে নতুনগুলো পরের deploy
  পর্যন্ত বাদ থাকত।

### migration

প্রথমটা drizzle-kit জেনারেট করে:

```bash
pnpm db:generate --name core-platform
```

→ `packages/db/migrations/0007_core-platform.sql`। টেবিল আর কলাম যোগ, index বদল — কোনো কলাম মোছা বা নাম বদল
নেই, তাই drizzle-kit কোনো প্রশ্ন করে না।

⚠️ **একটা লাইন হাতে সরাতে হবে** — ধাপ ৩-এর 0003-এর একই সমস্যা। drizzle-kit সব FK আগে লেখে, index পরে। কিন্তু
`tenant_settings_logo_fk` যে `(tenant_id, id)`-কে দেখায়, সেখানে unique index না থাকলে Postgres FK বানাতেই দেয় না
("there is no unique constraint matching given keys")। জেনারেট করা ফাইলে
`CREATE UNIQUE INDEX "attachments_tenant_id_idx" …` লাইনটা খুঁজে কেটে `tenant_settings_logo_fk`-এর ঠিক আগে বসান,
উপরে একটা মন্তব্য সহ। ফলাফল এমন দেখাবে:

```sql
-- composite FK-এর target index আগে লাগবে, তাই drizzle-kit-এর ক্রম হাতে বদলানো (0003-এর মতো)
CREATE UNIQUE INDEX "attachments_tenant_id_idx" ON "attachments" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_logo_fk" FOREIGN KEY ("tenant_id","logo_attachment_id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
```

ফাইলের বাকিটা drizzle-kit যা লিখেছে তা-ই — হাতে আর কিছু বদলাবেন না। (মিলিয়ে দেখার জন্য: পাঁচটা `CREATE TABLE`,
`DROP INDEX "audit_logs_tenant_created_idx"`, `users`-এ দুটো আর `audit_logs`-এ তিনটা `ADD COLUMN`, ছয়টা FK, সাতটা index।)

দ্বিতীয়টা নিজের লেখা SQL — drizzle-kit ফাঁকা ফাইল বানায়:

```bash
pnpm --filter @omnivo/db exec drizzle-kit generate --custom --name core-platform-rls
```

**ফাইল: `packages/db/migrations/0008_core-platform-rls.sql`**

```sql
-- Custom SQL migration file, put your code below! --

-- ১) আগে থেকে থাকা workspace-এর জন্য settings রো আর একটা "Head office" ব্রাঞ্চ। RLS চালু করার
--    আগে: migrator টেবিলের মালিক, কিন্তু FORCE RLS মালিককেও আটকায় — পরে লিখলে tenant context লাগত।
--    নতুন workspace এগুলো signup-এর provisioning-এ পায় (auth.service.ts)
INSERT INTO tenant_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT DO NOTHING;

-- gen_random_uuid() = UUIDv4 (Postgres 17-এ uuidv7() নেই, ১৮-এ আসছে)। শুধু এই কয়েকটা পুরনো রো-র
-- জন্য; ক্রমের সুবিধা হারানো এখানে কিছু না
INSERT INTO branches (id, tenant_id, code, name)
SELECT gen_random_uuid(), id, 'HO', 'Head office' FROM tenants
ON CONFLICT DO NOTHING;

-- ২) নতুন tenant-টেবিলে ENABLE + FORCE RLS + tenant_isolation (0002-এর মতো NULLIF সহ)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'tenant_settings', 'branches', 'number_series', 'number_series_counters', 'attachments'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- ৩) নম্বরের কাউন্টার শুধু বাড়ে: মুছে ফেললে পরের ডকুমেন্ট আবার ০০০১ পেত — দুটো INV-2026-27-0001
REVOKE DELETE ON number_series_counters FROM omnivo_app;
```

**কোন লাইন কেন:**

- **backfill আগে, RLS পরে** — এই migration-এর সবচেয়ে গুরুত্বপূর্ণ ক্রম। FORCE RLS টেবিলের মালিককেও (migrator)
  আটকায়; RLS চালুর পরে backfill লিখলে প্রতিটা টেন্যান্টের জন্য `set_config` লাগত (একটা loop)। RLS চালুর আগে
  টেবিলটা সাধারণ টেবিল — এক `INSERT … SELECT`-এ সব। drizzle সব pending migration একটা transaction-এ চালায়,
  তাই মাঝপথে ব্যর্থ হলে কিছুই থাকে না।
- `ON CONFLICT DO NOTHING` — migration একবারই চলে, তবু: কেউ হাতে আগে রো বসিয়ে থাকলে (dev DB-তে পরীক্ষা) পুরো
  migration ভাঙত না।
- `gen_random_uuid()` = UUIDv4 — Postgres ১৭-এ `uuidv7()` নেই। শুধু পুরনো কয়েকটা "Head office" রো; নতুন সব রো অ্যাপ
  থেকে UUIDv7 পায়।
- policy-র ছাঁচ 0002-এর হুবহু: `NULLIF(current_setting(…, true), '')` — pool-এর ফেরত আসা connection-এ setting ''
  থাকে, `''::uuid` error দিত (ধাপ ২-এর বাগ)।
- `REVOKE DELETE` কাউন্টারে — `audit_logs`-এর মতো (0004)। অ্যাপের কোনো কোড কাউন্টার মোছে না, আর ভুল করে মুছলে
  পরের ইনভয়েস আবার ০০০১ পেত — একই নম্বরের দুটো VAT চালান।

### seed

**ফাইল: `packages/db/src/seed.ts`** (আপডেট)

import-এর তালিকায় `branches` আর `tenantSettings` যোগ; transaction-এর শেষে, `membershipRoles`-এর insert-এর পরে:

```ts
    // signup-এর provisioning যা দেয় seed-ও তা-ই দেয়: settings রো (ডিফল্ট মান) আর একটা ব্রাঞ্চ
    await tx.insert(tenantSettings).values({ tenantId: tenant.id }).onConflictDoNothing();
    await tx
      .insert(branches)
      .values({ tenantId: tenant.id, code: 'HO', name: 'Head office' })
      .onConflictDoNothing({ target: [branches.tenantId, branches.code] });
```

- নতুন খালি DB-তে ক্রম হলো migrate → seed; তখন 0008-এর backfill-এর সময় কোনো টেন্যান্ট ছিল না। তাই seed নিজেই
  বসায় — নাহলে seed-এর Acme-এর settings রো থাকত না, আর `/settings` 500 দিত।
- `onConflictDoNothing({ target: [branches.tenantId, branches.code] })` — seed বারবার চালানো যায় (ধাপ ১-এর নিয়ম)।

---

## ৬.৩ — API-র ভিত্তি: request context, `audit()`, storage, CORS

মডিউলগুলো (৬.৪) এই টুকরোগুলোর উপর দাঁড়ায়, তাই আগে এগুলো।

### request-এর পরিচয়

**ফাইল: `apps/api/src/common/request/request-context.ts`** (নতুন)

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';

// একটা HTTP request-এর পরিচয় — audit log আর error লগ এটা দিয়ে একে অন্যের সাথে মেলে।
// tenant-এর ALS থেকে আলাদা: লগইন (public রুট) টেন্যান্ট জানার আগেই চলে, কিন্তু তার audit-এও
// IP আর request id লাগে
export interface RequestMeta {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
}

const requestStorage = new AsyncLocalStorage<RequestMeta>();

// background job-এ (ধাপ ৮) request নেই — তখন undefined, audit-এ এই কলামগুলো NULL
export function currentRequest(): RequestMeta | undefined {
  return requestStorage.getStore();
}

// Nest-এর Fastify adapter middleware-কে Node-এর কাঁচা request দেয়; @fastify/middie তাতে Fastify-র
// id (genReqId, configure-app.ts) আর ip বসিয়ে দেয়। Node-এর টাইপে এরা নেই — তাই `in` দিয়ে narrow,
// cast না। middie ছাড়া চললেও (ভবিষ্যতে অন্য adapter) request ভাঙবে না, নিজের id বানাবে
function metaOf(req: IncomingMessage): RequestMeta {
  const id = 'id' in req && typeof req.id === 'string' ? req.id : randomUUID();
  const ip = 'ip' in req && typeof req.ip === 'string' ? req.ip : req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  return {
    id,
    ipAddress: ip ?? null,
    // header ক্লায়েন্টের হাতে — অসীম লম্বা string DB-তে না
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 512),
  };
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    requestStorage.run(metaOf(req), next);
  }
}
```

**কোন লাইন কেন:**

- আলাদা `AsyncLocalStorage`, tenant-এর `TenantStore`-এ নতুন ঘর না: লগইনের সময় কোনো tenant store-ই তৈরি হয় না
  (principal নেই), অথচ লগইনের audit-এ IP লাগে। দুটো ALS একে অন্যের ভেতরে চলে, কেউ কাউকে ঢাকে না।
- `requestStorage` export হয় না — শুধু `currentRequest()`। বাইরের কেউ `run()` ডেকে নকল পরিচয় বসাতে পারে না।
- `'id' in req` — Nest-এর Fastify adapter middleware-কে Node-এর কাঁচা `IncomingMessage` দেয়, যার টাইপে `id` নেই।
  `@fastify/middie` (Nest-এর ভেতরের middleware-চালক) চালানোর আগে `req.raw.id = req.id` আর `req.raw.ip = req.ip`
  বসায় — যাচাই করা: `node_modules/@fastify/middie/index.js`। `in` দিয়ে narrow করলে TypeScript `req.id`-কে
  `unknown` ধরে, তারপর `typeof … === 'string'`। cast (`as FastifyRequest`) লাগে না।
- `req.ip` নেওয়া, `x-forwarded-for` না: header ক্লায়েন্টের হাতে, যে কেউ যেকোনো IP লিখে পাঠাতে পারে। Cloudflare-এর
  পেছনে গেলে (ধাপ ২৫) Fastify-র `trustProxy` চালু করতে হবে, তখন `req.ip` নিজেই আসল ক্লায়েন্টের IP দেবে — শেষের নোট।
- `slice(0, 512)` — user agent-এর দৈর্ঘ্য ক্লায়েন্ট ঠিক করে; ১০ KB-র header প্রতিটা audit রো-তে জমার দরকার নেই।

**ফাইল: `apps/api/src/app.module.ts`** (পুরো ফাইল)

```ts
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AttachmentsModule } from './attachments/attachments.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { AuthModule } from './auth/auth.module.js';
import { BranchesModule } from './branches/branches.module.js';
import { ContractInterceptor } from './common/http/contract.interceptor.js';
import { ProblemFilter } from './common/http/problem.filter.js';
import { RequestContextMiddleware } from './common/request/request-context.js';
import type { Config } from './config.js';
import { DocsController } from './docs/docs.controller.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { MembersModule } from './members/members.module.js';
import { NumberingModule } from './numbering/numbering.module.js';
import { PermissionGuard } from './rbac/permission.guard.js';
import { RbacModule } from './rbac/rbac.module.js';
import { SettingsModule } from './settings/settings.module.js';

@Module({})
export class AppModule implements NestModule {
  // config বাইরে থেকে আসে: main.ts-এ process.env থেকে, টেস্টে Testcontainers-এর URL থেকে
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.register(config),
        RbacModule,
        AuthModule,
        MembersModule,
        SettingsModule,
        BranchesModule,
        NumberingModule,
        AuditModule,
        AttachmentsModule,
      ],
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
    // ক্রম: আগে request-এর পরিচয় (id, IP) — তারপর টোকেন। দুটোই সব রুটে, public-এও (লগইনের audit)
    consumer.apply(RequestContextMiddleware, AuthMiddleware).forRoutes('{*splat}');
  }
}
```

- `consumer.apply(RequestContextMiddleware, AuthMiddleware)` — ক্রম অনুযায়ী চলে, আর দ্বিতীয়টা চলে প্রথমটার
  `run()`-এর ভেতরে। তাই AuthMiddleware-এর `runWithPrincipal()` আর তার পরের guard, handler — সবাই দুটো ALS-ই দেখে।
- পাঁচটা নতুন মডিউল `imports`-এ; না দিলে `contract.spec.ts` ধরে ফেলে (রেজিস্ট্রিতে আছে, Nest-এ নেই)।

### error-এর দুটো ছোট সাহায্যকারী

**ফাইল: `apps/api/src/common/http/app-error.ts`** (আপডেট — শেষে)

```ts
// id দিয়ে খোঁজা রো নেই — অথবা অন্য টেন্যান্টের (RLS সেটা লুকায়)। দুটোই একই 404: "অন্য কোম্পানির এই id
// আছে" সেটুকুও বাইরে জানানো হয় না
export function notFound(what: string): AppError {
  return new AppError(404, 'not_found', `${what} not found.`);
}
```

```ts
// optimistic locking: ফর্ম খোলার পরে কেউ রো-টা বদলেছে
export function versionConflict(): AppError {
  return new AppError(
    409,
    'version_conflict',
    'The record changed after it was loaded. Reload it and try again.',
  );
}
```

- `notFound` — অন্য টেন্যান্টের id দিলেও ঠিক এই 404, একই লেখা। 403 ("আছে কিন্তু তোমার না") দিলে সেটাও তথ্য ফাঁস:
  অন্য কোম্পানির ব্রাঞ্চের id সত্যিই আছে কি না, সেটা জানা যেত। (tenant-leak টেস্ট এটা পাহারা দেয়, ৬.৫।)

**ফাইল: `apps/api/src/common/db/pg-errors.ts`** (নতুন — `auth.service.ts` থেকে সরানো)

```ts
// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}
```

`apps/api/src/auth/auth.service.ts` থেকে একই ফাংশনটা মুছে ফেলুন, আর import-এ যোগ করুন:

```ts
import { isUniqueViolation } from '../common/db/pg-errors.js';
```

- ব্রাঞ্চের কোড অনন্য কি না সেটাও unique index দেখে (৬.৪) — একই ফাংশন দুই জায়গায় কপি না।

### `audit()`

**ফাইল: `apps/api/src/common/audit/audit.ts`** (নতুন)

```ts
import type { AuditAction, AuditChanges, AuditEntityType, AuditValue } from '@omnivo/contracts';
import { auditLogs } from '@omnivo/db';
import { sql } from 'drizzle-orm';

import { currentRequest } from '../request/request-context.js';
import { tenantStorage } from '../tenant/tenant-context.js';
import type { Transaction } from '../tenant/with-tenant.js';

export interface AuditEvent {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  changes?: AuditChanges;
  // লগইন আর সাইনআপ public রুট — principal নেই, তাই কে করল সেটা caller বলে দেয়
  actorUserId?: string;
}

// বদলের সাথে একই transaction-এ audit রো: বদল commit হলে audit থাকবেই, rollback হলে দুটোই যায়।
// interceptor দিয়ে response-এর পরে লিখলে দুটো সমস্যা ছিল — পুরনো মান জানা যেত না, আর commit আর
// audit-এর মাঝে process পড়ে গেলে বদল থাকত কিন্তু তার কোনো রেকর্ড থাকত না
export async function audit(tx: Transaction, event: AuditEvent): Promise<void> {
  const request = currentRequest();
  await tx.insert(auditLogs).values({
    // টেন্যান্ট আসে transaction-এর নিজের context থেকে, ALS থেকে না: যে টেন্যান্টে বদলটা হচ্ছে ঠিক
    // সেখানেই audit — ভুল হওয়ার উপায় নেই। context ছাড়া ডাকলে NULL → NOT NULL-এ জোরে ভাঙে
    tenantId: sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    actorUserId: event.actorUserId ?? tenantStorage.getStore()?.principal?.userId ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: { changes: event.changes ?? {} },
    requestId: request?.id ?? null,
    ipAddress: request?.ipAddress ?? null,
    userAgent: request?.userAgent ?? null,
  });
}

type Snapshot = Record<string, AuditValue>;

// শুধু যা সত্যিই বদলেছে: নাম একই রেখে "Save" চাপলে audit-এ খালি changes, ভুয়া "বদল" না
export function diff(before: Snapshot, after: Snapshot): AuditChanges {
  const changes: AuditChanges = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

// নতুন কিছু তৈরি: আগে কিছু ছিল না
export function created(after: Snapshot): AuditChanges {
  return diff({}, after);
}
```

**কোন লাইন কেন:**

- প্রথম প্যারামিটার `tx` — `Transaction`, `Db` না। টাইপ নিজেই নিশ্চিত করে যে audit কোনো একটা transaction-এর
  ভেতরে লেখা হচ্ছে; ভুল করে transaction-এর বাইরে (আলাদা connection-এ) লিখলে compile error — ঠিক যে সমস্যা
  interceptor-এর ছিল।
- `tenantId`-এর মান SQL-এর `current_setting('app.tenant_id', true)` থেকে — ALS-এর `getTenantId()` না।
  দুটো কারণ: (ক) সাইনআপের provisioning `db.transaction` + `setTenantContext` দিয়ে চলে (টেন্যান্ট তখনই তৈরি হচ্ছে,
  ALS-এ তার id থাকার উপায় নেই); (খ) যে transaction যে টেন্যান্টে বাঁধা, audit ঠিক সেখানেই — অমিল হওয়াই অসম্ভব।
  RLS-এর `WITH CHECK`-ও একই শর্ত দেখে; context ছাড়া ডাকলে NULL → `NOT NULL` ভাঙে, চুপচাপ ভুল টেন্যান্টে না।
- `actorUserId: event.actorUserId ?? principal?.userId ?? null` — লগইন আর সাইনআপে principal থাকে না (public
  রুট), caller বলে দেয়; বাকি সবখানে টোকেনের ইউজার। background job-এ (ধাপ ৮) দুটোই নেই → null = "সিস্টেম"।
- `diff` শুধু `after`-এর key ধরে ঘোরে — `before`-এ বাড়তি ঘর থাকলে সেগুলো উপেক্ষা হয়। আর `from !== to` তুলনা
  সরল মানে (string/number/boolean/null) ঠিক কাজ করে — সেই কারণেই `AuditValue` object নিতে দেয় না।
- `before[field] ?? null` — `before`-এ ঘরটাই না থাকলে (নতুন তৈরি) undefined না, null — JSON-এ undefined হারিয়ে যায়।

### config আর storage

**ফাইল: `apps/api/src/config.ts`** (আপডেট)

`envSchema`-র শেষে, `JWT_SECRET`-এর পরে:

```ts
  // S3-এর মতো storage: dev-এ MinIO (docker-compose), production-এ Cloudflare R2 (system-design §৩.৭)
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('omnivo'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
```

ফেরত object-এ `secureCookies`-এর পরে:

```ts
    storage: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      // dev আর test-এ bucket না থাকলে API নিজে বানায়; production-এ bucket IaC-র কাজ (ধাপ ২৫),
      // সেখানে API-র bucket বানানোর অধিকারই থাকবে না
      createBucket: e.NODE_ENV !== 'production',
    },
```

- `S3_REGION` default `us-east-1` — MinIO region মানে না, কিন্তু SDK সই করতে একটা region চায়; R2-র জন্য `auto`।
- `createBucket: NODE_ENV !== 'production'` — production-এর চাবির bucket বানানোর অধিকারই থাকা উচিত না (least
  privilege); সেখানে bucket IaC-র (OpenTofu) কাজ।

**ফাইল: `apps/api/src/storage/storage.service.ts`** (নতুন)

```ts
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;

// storage-এর সাথে কথা বলার একমাত্র জায়গা — AWS SDK এর বাইরে কেউ দেখে না। MinIO, R2 আর S3 একই
// API বলে, তাই dev থেকে production-এ শুধু env বদলায়
@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    const storage = config.storage;
    this.bucket = storage.bucket;
    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      // MinIO bucket-কে সাবডোমেইন (omnivo.localhost) না, পাথ (localhost:9000/omnivo) হিসেবে চেনে
      forcePathStyle: true,
      // SDK-র নতুন ডিফল্ট presigned PUT-এর URL-এ একটা CRC32 checksum বসায় — ফাঁকা body-র, কারণ সই করার
      // সময় ফাইল নেই। AWS S3 আসল ফাইলের সাথে সেটা মিলিয়ে আপলোড ফিরিয়ে দেয়। MinIO checksum দেখেই না
      // (যাচাই করা: ডিফল্টেও 200), তাই dev-এ সব ঠিক দেখাত আর production-এ ভাঙত — বন্ধ রাখা
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  // শুধু dev/test: `pnpm db:up`-এর পরে বাড়তি কোনো ধাপ ছাড়াই আপলোড চলে। storage বন্ধ থাকলে API
  // তবু চালু হয় (Redis-এর মতো) — শুধু আপলোড ব্যর্থ হবে, লগে কারণ
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.storage.createBucket) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!(error instanceof NotFound)) {
        this.logger.warn(`Can't reach storage (${String(error)}). Start it with pnpm db:up.`);
        return;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket ${this.bucket}`);
    }
  }

  // ব্রাউজার সরাসরি storage-এ PUT করে — ফাইল API সার্ভারের memory বা ব্যান্ডউইথ দিয়ে যায় না।
  // signableHeaders: ডিফল্টে SDK শুধু `host` সই করে — ContentType দিলেও! তখন ব্রাউজার image/png ঘোষণা
  // করে text/html পাঠাতে পারত (যাচাই করা: 200)। content-type সইয়ে ঢোকালে অন্য ধরন = 403
  async uploadUrl(key: string, contentType: string, expiresInSeconds: number): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  // পড়ার ঠিকানা এক ঘণ্টার "জানালায়" একই থাকে: সই করার সময় ঘণ্টার শুরুতে বাঁধা, মেয়াদ দুই ঘণ্টা।
  // প্রতিবার নতুন সময়ে সই করলে প্রতিটা request-এ URL বদলাত, আর ব্রাউজার একই লোগো বারবার নামাত —
  // এখন ঘণ্টাজুড়ে একই URL, তাই ব্রাউজারের cache কাজে লাগে। মেয়াদের অন্তত এক ঘণ্টা সবসময় বাকি থাকে
  async downloadUrl(key: string, contentType: string): Promise<SignedUrl> {
    const signingDate = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const url = await getSignedUrl(
      this.client,
      // ResponseContentType: storage যা-ই ভাবুক, ব্রাউজার ফাইলটাকে ঠিক এই ধরন হিসেবে পায়
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: contentType }),
      { expiresIn: 2 * 60 * 60, signingDate },
    );
    return { url, expiresAt: new Date(signingDate.getTime() + 2 * HOUR_MS) };
  }

  // আপলোড সত্যিই হয়েছে কি না, আর ঘোষণার সাথে মেলে কি না — null = ফাইল নেই
  async head(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? '' };
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
```

**কোন লাইন কেন — এই ফাইলের তিনটা লাইন যাচাইয়ের সময় ধরা পড়া ভুল থেকে এসেছে:**

- `signableHeaders: new Set(['content-type'])` — **সবচেয়ে গুরুত্বপূর্ণ।** `PutObjectCommand`-এ `ContentType` দিলেও SDK
  ডিফল্টে শুধু `host` সই করে (URL-এর `X-Amz-SignedHeaders=host`)। যাচাই করা: `image/png`-এর সই করা ঠিকানায়
  `text/html` পাঠালে MinIO 200 দিল। অর্থাৎ কেউ লোগোর নামে HTML ফাইল রাখতে পারত। এই লাইনের পরে
  `X-Amz-SignedHeaders=content-type;host`, আর অন্য ধরন → `403 SignatureDoesNotMatch` (টেস্টে ধরা, ৬.৫)।
- `requestChecksumCalculation: 'WHEN_REQUIRED'` — নতুন SDK presigned PUT-এর URL-এ একটা CRC32 checksum বসায় —
  ফাঁকা body-র, কারণ সই করার সময় ফাইল নেই। যাচাই করা: MinIO সেই checksum দেখেই না (ডিফল্ট SDK-তেও আপলোড 200)।
  AWS S3 query-র checksum আসল ফাইলের সাথে মেলায় — তাই এই লাইন ছাড়া dev-এ সব ঠিক দেখাত আর production-এ আপলোড
  ভাঙত। S3/R2-এ নিজে চালিয়ে দেখা হয়নি (উপরের ⚠️); লাইনটা থাকলে দুই জায়গায় আচরণ এক।
- `forcePathStyle: true` — MinIO bucket-কে পাথ হিসেবে চেনে (`localhost:9000/omnivo/…`); না দিলে SDK
  `omnivo.localhost:9000` বানাত, যেটা resolve হয় না। R2-ও পাথ-স্টাইল মানে।
- `onApplicationBootstrap` — `HeadBucket` → না থাকলে `CreateBucket`। `NotFound` ছাড়া অন্য error (MinIO বন্ধ) হলে শুধু
  সতর্কবার্তা, API তবু চালু: `contract.spec.ts` DB/storage ছাড়াই অ্যাপ তোলে, আর dev-এ MinIO ছাড়াও বাকি সব স্ক্রিন
  চলা উচিত (Redis-এর একই নিয়ম, ধাপ ৩)।
- `downloadUrl`-এর `signingDate` ঘণ্টার শুরুতে বাঁধা — এই "জানালা"র ভেতরে প্রতিটা সই হুবহু একই URL দেয়। প্রতিবার
  এখনকার সময়ে সই করলে প্রতিটা `GET /settings` নতুন URL দিত, আর ব্রাউজার একই লোগো বারবার নামাত (URL-ই cache-এর
  key)। মেয়াদ দুই ঘণ্টা: ঘণ্টার শেষ মিনিটে সই হলেও অন্তত এক ঘণ্টা চলে। (টেস্টে: পরপর দুই পড়ায় একই URL।)
- `ResponseContentType` — storage ফাইলের সাথে যা-ই রাখুক, ব্রাউজার পায় ঠিক রো-তে লেখা ধরন (`image/png`)। HTML
  হিসেবে খোলার কোনো সুযোগ থাকে না।
- `head()` `NotFound` হলে null, অন্য error হলে ছুড়ে দেয় — "ফাইল নেই" (ব্যবহারকারীর দোষ, 409) আর "storage বন্ধ"
  (আমাদের, 500) আলাদা থাকে।

**ফাইল: `apps/api/src/infra/infra.module.ts`** (আপডেট)

import-এ:

```ts
import { StorageService } from '../storage/storage.service.js';
```

`providers`-এর শেষে `StorageService,` আর `exports`-এর শেষে `StorageService`:

```ts
        { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
        StorageService,
      ],
      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService],
```

- `StorageService` একটা class, তাই token (`Symbol`) লাগে না — Nest টাইপ দেখেই inject করে। `InfraModule` global,
  তাই settings আর attachments দুজনেই পায়, আলাদা করে import না করে।

### CORS — আসল ব্রাউজারে ধরা পড়া বাগ

**ফাইল: `apps/api/src/configure-app.ts`** (পুরো ফাইল)

```ts
import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { HttpMethod } from '@omnivo/contracts';

import type { Config } from './config.js';

// চুক্তির প্রতিটা method। @fastify/cors-এর ডিফল্ট শুধু GET, HEAD, POST — ধাপ ৫ পর্যন্ত সব রুট তা-ই
// ছিল, তাই চোখে পড়েনি। ধাপ ৬-এর প্রথম PUT (সেটিংস সেভ) ব্রাউজারের preflight-এ আটকে গিয়েছিল: API-র
// integration টেস্ট আর MSW দুটোই CORS-এর বাইরে দিয়ে যায়, ধরা পড়েছে শুধু আসল ব্রাউজারে।
// satisfies: চুক্তিতে নেই এমন method লিখলে compile error
const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] satisfies (
  HttpMethod | 'HEAD'
)[];

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
    methods: CORS_METHODS,
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

**কেন:** যাচাইয়ের সময় আসল ব্রাউজারে সেটিংস সেভ কিছুই করছিল না — API-র লগে কোনো request-ই নেই। Chrome-এর console:
"Method PUT is not allowed by Access-Control-Allow-Methods in preflight response"। `@fastify/cors` ১১-এর ডিফল্ট
`methods: 'GET,HEAD,POST'` (যাচাই করা: `node_modules/@fastify/cors/index.js`)। ধাপ ৫ পর্যন্ত সব রুট GET/POST ছিল,
তাই কখনো চোখে পড়েনি। integration টেস্ট (`app.inject`) আর MSW — দুটোই ব্রাউজারের CORS-ধাপ এড়িয়ে যায়; তাই
`contract.spec.ts`-এ এখন একটা preflight টেস্ট (৬.৫) যা চুক্তির প্রতিটা method মিলিয়ে দেখে।

- `satisfies (HttpMethod | 'HEAD')[]` — চুক্তিতে নেই এমন method (`'PATCHH'`) লিখলে compile error। `HEAD` চুক্তিতে
  নেই, কিন্তু Fastify প্রতিটা GET-এর জন্য বানায়।

---

## ৬.৪ — API-র মডিউল

প্রতিটা মডিউলের ছাঁদ একই: `*.service.ts` (নিয়ম, transaction, audit) + `*.controller.ts` (শুধু চুক্তি আর permission)
+ `*.module.ts`। members-এর মতো সব কিছু controller-এ না, কারণ এবার নিয়ম আছে (version, শেষ ব্রাঞ্চ) — controller
পাতলা থাকলে পরে একই নিয়ম worker বা অন্য মডিউল থেকেও ডাকা যায়।

### auth: পছন্দ, provisioning আর তিনটা audit ঘটনা

**ফাইল: `apps/api/src/auth/auth.service.ts`** (আপডেট — ছয় জায়গায়)

১) import — contracts আর db-র তালিকা বড় হলো, আর audit:

```ts
import type {
  LoginInput,
  MeResponse,
  Preferences,
  SignUpInput,
  UpdatePreferencesInput,
} from '@omnivo/contracts';
import {
  type Db,
  OWNER_ROLE_NAME,
  branches,
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  tenantSettings,
  tenants,
  users,
} from '@omnivo/db';

import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
```

২) `login()`-এ, membership পাওয়ার পরে আর `issueTokens`-এর আগে:

```ts
    await this.recordInTenant(tenant.id, {
      action: 'auth.signed_in',
      entityType: 'user',
      entityId: identity.userId,
      actorUserId: identity.userId,
    });
```

৩) `switchTenant()`-এ, `rotate()` আর userId-মেলানোর পরে:

```ts
    // যে workspace-এ ঢুকল তার audit-এ — সেই কোম্পানির মালিক দেখবে কে কখন এসেছিল
    await this.recordInTenant(tenantId, {
      action: 'auth.switched_in',
      entityType: 'user',
      entityId: principal.userId,
      actorUserId: principal.userId,
    });
```

৪) `me()`-এ `users` থেকে দুটো কলাম বেশি পড়া, আর ফেরত মানে `preferences` (বাকি ফাংশন আগের মতো):

```ts
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        language: users.language,
        theme: users.theme,
      })
      .from(users)
      .where(eq(users.id, principal.userId));
```

```ts
    return {
      user: { id: user.id, email: user.email, fullName: user.fullName },
      tenant,
      roles: [...principal.roles],
      permissions: [...granted].sort(),
      memberships: workspaces,
      preferences: { language: user.language, theme: user.theme },
    };
```

৫) `me()`-এর পরে দুটো নতুন method:

```ts
  // users-এ RLS নেই (global টেবিল) — তাই শুধু টোকেনের userId-র রো, body থেকে কোনো id নেওয়া হয় না
  async updatePreferences(
    principal: Principal,
    input: UpdatePreferencesInput,
  ): Promise<Preferences> {
    const [row] = await this.db
      .update(users)
      .set({
        // exactOptionalPropertyTypes: না পাঠানো ফিল্ড undefined-ও না, একেবারে নেই — তাই drizzle
        // সেই কলাম ছোঁয় না। ভাষা বদলালে থিম অক্ষত থাকে
        ...(input.language !== undefined && { language: input.language }),
        ...(input.theme !== undefined && { theme: input.theme }),
        updatedBy: principal.userId,
      })
      .where(eq(users.id, principal.userId))
      .returning({ language: users.language, theme: users.theme });
    if (!row) throw sessionEnded();
    return row;
  }

  // public রুট (লগইন) বা অন্য টেন্যান্টে (switch) — তখনো ALS-এ ঠিক টেন্যান্ট বসিয়ে audit
  private recordInTenant(tenantId: string, event: Parameters<typeof audit>[1]): Promise<void> {
    return runWithTenant(tenantId, () => this.withTenant((tx) => audit(tx, event)));
```

```ts
  }
```

৬) `provisionWorkspace()`-এ, `membershipRoles`-এর insert-এর পরে আর `return`-এর আগে:

```ts
      // settings রো (বাকি সব DB-র ডিফল্ট: BDT, জুলাই, Asia/Dhaka) আর একটা ব্রাঞ্চ — প্রতিটা
      // workspace-এ অন্তত একটা চালু ব্রাঞ্চ থাকে, archive-এর নিয়ম সেটা ধরে রাখে (branches.service.ts)
      await tx.insert(tenantSettings).values({ tenantId: tenant.id, updatedBy: userId });
      await tx
        .insert(branches)
        .values({ tenantId: tenant.id, code: 'HO', name: 'Head office', createdBy: userId });

      await audit(tx, {
        action: 'workspace.created',
        entityType: 'workspace',
        entityId: tenant.id,
        actorUserId: userId,
        changes: created({ name: input.companyName, slug: input.workspaceSlug }),
      });
```

**কোন লাইন কেন:**

- `user: { id, email, fullName }` আলাদা করে লেখা — `...user` দিলে `language`/`theme`-ও `user`-এর ভেতরে যেত।
  `ContractInterceptor` চুক্তির বাইরের ঘর কেটে দিত ঠিকই, কিন্তু টাইপ-লেভেলে উত্তরটা চুক্তির সাথে মিলুক, অন্যের
  ছাঁটাইয়ের ভরসায় না।
- `updatePreferences`-এর `...(input.language !== undefined && { … })` — `exactOptionalPropertyTypes`-এ
  `{ language: input.language }` (যার মান undefined হতে পারে) drizzle-এর `set()`-এ বসে না; আর বসলেও "undefined
  মানে ছুঁয়ো না" কথাটা কোডে স্পষ্ট থাকা ভালো।
- `where(eq(users.id, principal.userId))` — body-তে কোনো id নেই। `users`-এ RLS নেই (global), তাই এখানে id-র একমাত্র
  উৎস যাচাই করা টোকেন।
- `recordInTenant` — লগইন public রুট: ALS-এ কোনো টেন্যান্ট নেই, আর switch-এ ALS-এ **পুরনো** টেন্যান্ট। দুই ক্ষেত্রেই
  `runWithTenant(যে-টেন্যান্টে-ঘটনা)`। audit আলাদা ছোট transaction-এ — টোকেন ইস্যু আর audit একই transaction-এ
  রাখার উপায় নেই (Better Auth নিজের connection ব্যবহার করে), তাই এখানে ক্রমটা: আগে audit, তারপর টোকেন। audit
  ব্যর্থ হলে লগইনও ব্যর্থ — "রেকর্ড ছাড়া লগইন" হয় না।
- provisioning-এ settings + "Head office" + `workspace.created` — সবই সেই একই transaction-এ, যেখানে টেন্যান্ট তৈরি
  হচ্ছে। কিছু ব্যর্থ হলে পুরো সাইনআপ rollback (ধাপ ৩-এর হাতে-মোছা Better Auth ইউজার সহ)।
- `audit()` এখানে কাজ করে কারণ ৬.৩-এর `current_setting('app.tenant_id')` — ঠিক আগের লাইনগুলোতে `setTenantContext`
  বসানো; ALS-এ টেন্যান্ট নেই, দরকারও নেই।

**ফাইল: `apps/api/src/auth/me.controller.ts`** (নতুন)

```ts
import { Controller } from '@nestjs/common';
import { type Preferences, type RouteInput, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { AuthService } from './auth.service.js';

// নিজের জিনিস বদলানো (ধাপ ৭-এ প্রোফাইল, পাসওয়ার্ড) — কোনো permission লাগে না, শুধু লগইন
@Controller()
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @Endpoint(routes.me.updatePreferences)
  updatePreferences({
    body,
  }: RouteInput<typeof routes.me.updatePreferences>): Promise<Preferences> {
    return this.authService.updatePreferences(currentPrincipal(), body);
  }
}
```

**ফাইল: `apps/api/src/auth/auth.module.ts`** (আপডেট)

```ts
import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MeController } from './me.controller.js';

@Module({
  imports: [RbacModule],
  controllers: [AuthController, MeController],
  providers: [AuthService],
})
export class AuthModule {}
```

- `/me/…` আলাদা controller, `AuthController`-এ না: auth-এর রুটগুলো session নিয়ে (cookie, টোকেন); "আমার জিনিস"
  (পছন্দ, পরে প্রোফাইল আর পাসওয়ার্ড) আলাদা দায়িত্ব। একই service ব্যবহার করে — `users` টেবিল এখন auth-এর দখলে।

### সেটিংস

**ফাইল: `apps/api/src/settings/settings.service.ts`** (নতুন)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Settings, UpdateSettingsInput } from '@omnivo/contracts';
import { attachments, tenantSettings, tenants } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { audit, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  get(): Promise<Settings> {
    return this.withTenant((tx) => this.read(tx));
  }

  update(input: UpdateSettingsInput): Promise<Settings> {
    const tenantId = getTenantId();
    const { version, companyName, ...fields } = input;
    return this.withTenant(async (tx) => {
      // FOR UPDATE: পড়া থেকে লেখা পর্যন্ত রো-টা এই transaction-এর — মাঝখানে আরেকজন বদলাতে পারে না।
      // আগে পড়তেই হয়: audit-এর পুরনো মান এখান থেকে, আর version মেলানোও এখানে
      const [current] = await tx
        .select({ settings: tenantSettings, companyName: tenants.name })
        .from(tenantSettings)
        .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
        .where(eq(tenantSettings.tenantId, tenantId))
        .for('update', { of: tenantSettings });
      if (!current) throw notFound('Settings');
      if (current.settings.version !== version) throw versionConflict();

      await tx
        .update(tenantSettings)
        .set({
          ...fields,
          version: sql`${tenantSettings.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(tenantSettings.tenantId, tenantId));
      // কোম্পানির নাম tenants-এ (লগইন আর switcher পড়ে)। tenants-এ RLS নেই, তাই id নিজে বেঁধে দেওয়া —
      // টোকেনের টেন্যান্ট, body থেকে কিছু না
      await tx.update(tenants).set({ name: companyName }).where(eq(tenants.id, tenantId));

      const before = current.settings;
      await audit(tx, {
        action: 'settings.updated',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff(
          { companyName: current.companyName, ...pickEditable(before) },
          { companyName, ...fields },
        ),
      });
      return this.read(tx);
    });
  }

  // লোগো ফর্মের বাইরে, এক ক্লিকের কাজ — তাই version চায় না আর বাড়ায়ও না। নাহলে লোগো বদলানোর পরে
  // একই পাতায় খোলা ফর্ম "কেউ বদলেছে" বলে সেভ হতো না, যদিও ফর্মের কোনো ঘর কেউ ছোঁয়নি
  setLogo(attachmentId: string | null): Promise<Settings> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      let newFileName: string | null = null;
      if (attachmentId !== null) {
        // purpose শর্তে, আলাদা if-এ না: এখন একটাই purpose, তাই `file.purpose !== 'company_logo'` টাইপের
        // হিসেবে সবসময় false (lint-এর no-unnecessary-condition সেটাই বলে)। ইনভয়েসের PDF-এর মতো নতুন
        // purpose এলে এই শর্তই সেটাকে লোগো হতে দেয় না — কোডে কিছু মনে রাখতে হয় না
        const [file] = await tx
          .select({ status: attachments.status, fileName: attachments.fileName })
          .from(attachments)
          .where(
            and(
              eq(attachments.tenantId, tenantId),
              eq(attachments.id, attachmentId),
              eq(attachments.purpose, 'company_logo'),
            ),
          );
        if (!file) throw notFound('Attachment');
        if (file.status !== 'ready') {
          throw new AppError(409, 'attachment_not_ready', 'Upload the logo before using it.');
        }
        newFileName = file.fileName;
      }
      // আগের লোগোর ফাইলের নাম — audit-এ id-র বদলে নাম ("rahman-logo.png"), মানুষ যা চেনে
      const [before] = await tx
        .select({ fileName: attachments.fileName })
        .from(tenantSettings)
        .leftJoin(
          attachments,
          and(
            eq(attachments.tenantId, tenantSettings.tenantId),
            eq(attachments.id, tenantSettings.logoAttachmentId),
          ),
        )
        .where(eq(tenantSettings.tenantId, tenantId))
        .for('update', { of: tenantSettings });
      if (!before) throw notFound('Settings');
      await tx
        .update(tenantSettings)
        .set({ logoAttachmentId: attachmentId, updatedBy: currentPrincipal().userId })
        .where(eq(tenantSettings.tenantId, tenantId));
      await audit(tx, {
        action: 'settings.logo_changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff({ logo: before.fileName }, { logo: newFileName }),
      });
      return this.read(tx);
    });
  }

  private async read(tx: Transaction): Promise<Settings> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select({
        settings: tenantSettings,
        companyName: tenants.name,
        logoKey: attachments.storageKey,
        logoType: attachments.contentType,
      })
      .from(tenantSettings)
      .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
      .leftJoin(
        attachments,
        and(
          eq(attachments.tenantId, tenantSettings.tenantId),
          eq(attachments.id, tenantSettings.logoAttachmentId),
        ),
      )
      .where(eq(tenantSettings.tenantId, tenantId));
    // signup আর migration 0008 প্রতিটা টেন্যান্টে রো বানায় — না থাকা মানে ডেটার গোলমাল, 500 না 404
    if (!row) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);

    const { settings } = row;
    const logoId = settings.logoAttachmentId;
    const logo =
      logoId !== null && row.logoKey !== null && row.logoType !== null
        ? {
            attachmentId: logoId,
            url: (await this.storage.downloadUrl(row.logoKey, row.logoType)).url,
          }
        : null;

    return {
      companyName: row.companyName,
      ...pickEditable(settings),
      logo,
      version: settings.version,
    };
  }
}

// ফর্মের ঘরগুলো — read আর audit-এর "আগের মান" একই তালিকা থেকে
function pickEditable(settings: typeof tenantSettings.$inferSelect) {
  return {
    legalName: settings.legalName,
    bin: settings.bin,
    phone: settings.phone,
    email: settings.email,
    address: settings.address,
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}
```

**কোন লাইন কেন:**

- `const { version, companyName, ...fields } = input;` — rest দিয়ে বাকি ঘর: নতুন ঘর (যেমন ধাপ ১৫-এ "ইনভয়েসের
  footer") contracts-এ যোগ করলে এখানে আলাদা করে লিখতে হয় না, DB-র কলামের নাম একই থাকলে সরাসরি বসে। `version` আর
  `companyName` আলাদা কারণ প্রথমটা কলাম না (শর্ত), দ্বিতীয়টা অন্য টেবিলে।
- `.for('update', { of: tenantSettings })` — `of` দিয়ে শুধু settings-এর রো lock। `tenants` lock করার দরকার নেই, আর
  `setLogo`-এর LEFT JOIN-এ `of` বাধ্যতামূলক: Postgres outer join-এর nullable দিক lock করতে দেয় না
  ("FOR UPDATE cannot be applied to the nullable side of an outer join")।
- নতুন version SQL-এর ভেতরে (`version = version + 1`) — DB নিজে বাড়ায়, কোডে হিসাব করা মান না। lock থাকায় দুটো একই ফল দিত,
  কিন্তু SQL-এর ভেতরে থাকলে কেউ ভবিষ্যতে lock সরালেও হারানো-আপডেট হয় না।
- `update(tenants)…where(eq(tenants.id, tenantId))` — `tenants`-এ RLS নেই (লগইনের আগে পড়তে হয়)। তাই id নিজে বাঁধা,
  শুধু টোকেনের টেন্যান্ট — এটাই সেই জায়গা যেখানে RLS-এর "দ্বিতীয় দেয়াল" নেই, কোডই একমাত্র পাহারা।
- `diff({ companyName: current.companyName, ...pickEditable(before) }, { companyName, ...fields })` — audit-এ
  শুধু বদলানো ঘর। "Save" চাপলে কিছু না বদলালেও রো লেখা হয় (version বাড়ে), কিন্তু audit-এর `changes` খালি —
  viewer-এ "কোনো ঘর বদলায়নি"।
- `return this.read(tx)` — একই transaction-এর ভেতরে: সদ্য লেখা মানই ফেরত যায়, আলাদা request-এ আরেকজনের পরের বদল না।
- `setLogo`-এ version নেই আর বাড়েও না — মন্তব্যে কারণ। বিকল্প ছিল লোগোও version বাড়াক আর UI ফর্মের version হালনাগাদ
  করুক; তখন লোগোর ঠিক আগে কেউ অন্য ট্যাবে সেটিংস বদলালে সেই পরিবর্তনও ফর্ম চুপচাপ "মেনে নিত" — optimistic
  locking-এর মানেই থাকত না।
- `eq(attachments.purpose, 'company_logo')` শর্তে — মন্তব্যে কারণ; এটা lint-এর `no-unnecessary-condition` থেকে এসেছে
  (আলাদা `if (file.purpose !== …)` "সবসময় false" বলে error দিয়েছিল)।
- audit-এ ফাইলের নাম, attachment-এর uuid না — আসল ব্রাউজারে দেখা গেছে "Logo: — → 01a0ebc4-…" কারো কাজে লাগে না।
- `read()`-এ রো না পেলে `Error` (500), `notFound` (404) না: signup আর migration 0008 প্রতিটা টেন্যান্টে রো বানায়;
  না থাকা মানে ডেটার গোলমাল — সেটা ক্লায়েন্টের দোষ না, লগে stack দরকার।
- `pickEditable` return type লেখা নেই — inferred object type, তাই `diff()`-এর `Record<string, AuditValue>`-এ বসে
  (নিচে নম্বরিং-এ কারণ বিস্তারিত)।

**ফাইল: `apps/api/src/settings/settings.controller.ts`** (নতুন)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, routes, type Settings } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // পড়তে কোনো permission লাগে না: টাইমজোন, অর্থবছর আর মুদ্রা সবার স্ক্রিনেই লাগে (তারিখ, টাকা দেখানো)
  @Endpoint(routes.settings.get)
  get(): Promise<Settings> {
    return this.settings.get();
  }

  @Endpoint(routes.settings.update)
  @RequirePermission('core.settings.manage')
  update({ body }: RouteInput<typeof routes.settings.update>): Promise<Settings> {
    return this.settings.update(body);
  }

  @Endpoint(routes.settings.setLogo)
  @RequirePermission('core.settings.manage')
  setLogo({ body }: RouteInput<typeof routes.settings.setLogo>): Promise<Settings> {
    return this.settings.setLogo(body.attachmentId);
  }
}
```

**ফাইল: `apps/api/src/settings/settings.module.ts`** (নতুন)

```ts
import { Module } from '@nestjs/common';

import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
```

### ব্রাঞ্চ

**ফাইল: `apps/api/src/branches/branches.service.ts`** (নতুন)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Branch, BranchInput, BranchStatus } from '@omnivo/contracts';
import { branches } from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type BranchRow = typeof branches.$inferSelect;

// DB-র রো → চুক্তির আকার: তারিখ ISO string, আর চুক্তির বাইরের কলাম (tenant_id, created_by) বাদ
function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    address: row.address,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// audit-এ যা দেখা যায় — ফর্মের ঘরগুলো
function snapshot(row: Pick<BranchRow, 'code' | 'name' | 'phone' | 'address'>) {
  return { code: row.code, name: row.name, phone: row.phone, address: row.address };
}

function codeTaken(code: string): AppError {
  return new AppError(409, 'branch_code_taken', `Branch code ${code} is already used.`, {
    fieldErrors: { code: ['branch_code_taken'] },
  });
}

@Injectable()
export class BranchesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(status: BranchStatus): Promise<Branch[]> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(branches)
        .where(
          and(
            eq(branches.tenantId, tenantId),
            status === 'active' ? isNull(branches.archivedAt) : isNotNull(branches.archivedAt),
          ),
        )
        .orderBy(asc(branches.code));
      return rows.map(toBranch);
    });
  }

  get(id: string): Promise<Branch> {
    return this.withTenant(async (tx) => toBranch(await this.lock(tx, id, false)));
  }

  async create(input: BranchInput): Promise<Branch> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(branches)
          .values({ tenantId, ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Branch insert returned no row');
        await audit(tx, {
          action: 'branch.created',
          entityType: 'branch',
          entityId: row.id,
          changes: created(snapshot(row)),
        });
        return toBranch(row);
      });
    } catch (error) {
      // unique index-এর error transaction-কে অচল করে দেয় — তাই ধরা হয় withTenant-এর বাইরে, rollback
      // হয়ে যাওয়ার পরে। আগে SELECT করে দেখে নিলে দুজন একসাথে একই কোড দিলে দুজনেই পার পেত
      if (isUniqueViolation(error, 'branches_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  async update(id: string, input: BranchInput & { version: number }): Promise<Branch> {
    try {
      return await this.withTenant(async (tx) => {
        const { version, ...fields } = input;
        const before = await this.lock(tx, id, true);
        if (before.version !== version) throw versionConflict();
        const after = await this.write(tx, id, fields);
        await audit(tx, {
          action: 'branch.updated',
          entityType: 'branch',
          entityId: id,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return toBranch(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'branches_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  archive(id: string, version: number): Promise<Branch> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // টেন্যান্টের সব চালু ব্রাঞ্চ lock — শুধু নিজেরটা না। নাহলে দুজন একসাথে শেষ দুটো ব্রাঞ্চ archive
      // করলে দুজনেই "আরেকটা তো চালু আছে" দেখত, দুজনেই পার পেত, আর চালু ব্রাঞ্চ থাকত শূন্য (write skew)।
      // ORDER BY id: সবাই একই ক্রমে lock নেয়, তাই দুই transaction একে অন্যের জন্য আটকে deadlock হয় না
      const active = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.tenantId, tenantId), isNull(branches.archivedAt)))
        .orderBy(asc(branches.id))
        .for('update');

      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt !== null) return toBranch(before);
      if (active.every((branch) => branch.id === id)) {
        throw new AppError(
          409,
          'branch_last_active',
          'A workspace needs at least one active branch.',
        );
      }

      const after = await this.write(tx, id, { archivedAt: new Date() });
      await audit(tx, { action: 'branch.archived', entityType: 'branch', entityId: id });
      return toBranch(after);
    });
  }

  restore(id: string, version: number): Promise<Branch> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, true);
      if (before.version !== version) throw versionConflict();
      if (before.archivedAt === null) return toBranch(before);
      const after = await this.write(tx, id, { archivedAt: null });
      await audit(tx, { action: 'branch.restored', entityType: 'branch', entityId: id });
      return toBranch(after);
    });
  }

  // id দিয়ে একটা রো; forUpdate হলে transaction শেষ না হওয়া পর্যন্ত আর কেউ বদলাতে পারে না।
  // tenant filter + RLS: অন্য টেন্যান্টের id দিলে "নেই" — 404, 403 না
  private async lock(tx: Transaction, id: string, forUpdate: boolean): Promise<BranchRow> {
    const query = tx
      .select()
      .from(branches)
      .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Branch');
    return row;
  }

  // প্রতিটা লেখায় version এক বাড়ে — পুরনো version হাতে থাকা যে কারো পরের লেখা 409 পাবে
  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<BranchRow, 'code' | 'name' | 'phone' | 'address' | 'archivedAt'>>,
  ): Promise<BranchRow> {
    const [row] = await tx
      .update(branches)
      .set({
        ...fields,
        version: sql`${branches.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, id)))
      .returning();
    if (!row) throw notFound('Branch');
    return row;
  }
}
```

**কোন লাইন কেন:**

- `create`-এ আগে `SELECT … WHERE code = ?` করে "আছে কি না" দেখা হয়নি: দুজন একসাথে একই কোড দিলে দুজনেই "নেই" দেখত।
  unique index-ই আসল পাহারা; তার error-কে সুন্দর 409 বানানো। `try` withTenant-এর **বাইরে** — unique violation-এর
  পরে transaction অচল ("current transaction is aborted"), তার ভেতরে আর কিছু চালানো যায় না।
- `codeTaken` — `fieldErrors: { code: [...] }`: ফর্মে ঠিক কোডের ঘরের নিচে দেখায় (ধাপ ৫-এর `applyApiError`)।
- `archive`-এ আগে সব চালু ব্রাঞ্চ `FOR UPDATE`, তারপর নিজেরটা — এটাই write skew-এর সমাধান (ভিত্তি-সিদ্ধান্ত ৬)।
  READ COMMITTED-এ Postgres lock পাওয়ার পরে রো **আবার যাচাই করে**: অন্যজন সদ্য archive করে commit করলে সেই রো
  `archived_at IS NULL` শর্তে আর মেলে না, ফলে বাদ পড়ে — `active` তালিকায় থাকে শুধু যা সত্যিই চালু। (৬.৫-এর টেস্ট
  দেখায়: `.for('update')` মুছলে ঠিক এই পথে শূন্য চালু ব্রাঞ্চ হয়।)
- `.orderBy(asc(branches.id))` lock-এর আগে — সবাই একই ক্রমে lock নেয়। না হলে A নেয় ১ তারপর ২, B নেয় ২ তারপর ১ —
  দুজন দুজনের জন্য অপেক্ষা (deadlock), Postgres একজনকে মেরে ফেলত।
- ইতিমধ্যে archive করা ব্রাঞ্চে আবার archive → কিছু না করে ফেরত (idempotent)। দুটো ট্যাব থেকে দুবার চাপলে
  দ্বিতীয়টা error দেখানোর কারণ নেই — তবে version আগে মেলে, তাই পুরনো পাতা থেকে এলে 409।
- `lock(…, forUpdate)` — `get()` lock নেয় না (শুধু পড়া), বাকিরা নেয়।
- `write()` প্রতিবার `version + 1` আর `updatedBy` — কোনো লেখার পথ version বাড়াতে ভুলতে পারে না।
- `toBranch` — DB-র `Date` → ISO string (চুক্তি `z.iso.datetime()`); চুক্তির বাইরের কলাম (`tenant_id`,
  `created_by`) এখানেই বাদ, interceptor-এর ছাঁটাইয়ের আগেই।

**ফাইল: `apps/api/src/branches/branches.controller.ts`** (নতুন)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { BranchesService } from './branches.service.js';

type Routes = typeof routes.branches;

// পড়তে permission লাগে না: ব্রাঞ্চের তালিকা পরে প্রায় প্রতিটা ফর্মের drop-down-এ (কোন ব্রাঞ্চের ইনভয়েস)
@Controller()
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Endpoint(routes.branches.list)
  async list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.branches.list(query.status) };
  }

  @Endpoint(routes.branches.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.branches.get(params.id);
  }

  @Endpoint(routes.branches.create)
  @RequirePermission('core.branch.manage')
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.branches.create(body);
  }

  @Endpoint(routes.branches.update)
  @RequirePermission('core.branch.manage')
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.branches.update(params.id, body);
  }

  @Endpoint(routes.branches.archive)
  @RequirePermission('core.branch.manage')
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.branches.archive(params.id, body.version);
  }

  @Endpoint(routes.branches.restore)
  @RequirePermission('core.branch.manage')
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.branches.restore(params.id, body.version);
  }
}
```

- `type Routes = typeof routes.branches` — প্রতিটা handler-এর টাইপ `RouteInput<Routes['update']>`; রুটের নাম একবার।
- handler-এর return type লেখা (`Promise<RouteResponse<…>>`) — ধাপ ৫-এর `@Endpoint` টাইপও এটা মেলায়, কিন্তু লিখে রাখলে
  ভুল হলে error আসে ঠিক এই লাইনে, decorator-এর জটিল টাইপের ভেতরে না।

**ফাইল: `apps/api/src/branches/branches.module.ts`** (নতুন)

```ts
import { Module } from '@nestjs/common';

import { BranchesController } from './branches.controller.js';
import { BranchesService } from './branches.service.js';

@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
})
export class BranchesModule {}
```

### নম্বরিং

**ফাইল: `apps/api/src/numbering/numbering.service.ts`** (নতুন)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  defaultNumberFormat,
  DOCUMENT_TYPES,
  type DocumentType,
  formatDocumentNumber,
  type NumberFormat,
  type NumberSeries,
  periodOf,
  todayIn,
  type UpdateNumberSeriesInput,
} from '@omnivo/contracts';
import { numberSeries, numberSeriesCounters, tenantSettings } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { audit, diff } from '../common/audit/audit.js';
import { versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// audit আর উত্তরের জন্য শুধু ছাঁচের তিনটা ঘর। পুরো রো spread করা যেত না: `{ ...(row ?? default) }`-এ
// TypeScript union-এর index-signature চেক ফসকে যায় (interface থাকলে), আর createdAt-এর Date চুপচাপ
// audit-এ ঢুকত — যাচাইয়ের সময় ঠিক এটাই ধরা পড়েছে। ফেরত টাইপ ইচ্ছা করে লেখা নেই: inferred object
// type-এর implicit index signature আছে (diff()-এ বসে), NumberFormat interface-এর নেই
function pickFormat(format: NumberFormat) {
  return { prefix: format.prefix, yearStyle: format.yearStyle, padding: format.padding };
}

// '' (বছর ছাড়া ছাঁচ) PK-র কলামে রাখা যায়, কিন্তু 'all' পড়তে পরিষ্কার
function periodKey(period: string): string {
  return period === '' ? 'all' : period;
}

@Injectable()
export class NumberingService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // পরের ধাপের ডকুমেন্ট (ইনভয়েস, journal) নিজের transaction-এর ভেতর থেকে এটা ডাকবে:
  //   const number = await numbering.next(tx, 'sales.invoice', invoice.date);
  // কাউন্টার সেই transaction-এর অংশ — ইনভয়েস rollback হলে নম্বরও ফেরত যায়, ফাঁক থাকে না। দুজন একসাথে
  // চাইলে ON CONFLICT DO UPDATE রো-টা lock করে: দ্বিতীয়জন প্রথমজনের commit পর্যন্ত অপেক্ষা করে পরেরটা পায়
  async next(tx: Transaction, documentType: DocumentType, isoDate: string): Promise<string> {
    const tenantId = getTenantId();
    const { format, fiscalYearStartMonth } = await this.formatOf(tx, documentType);
    const period = periodOf(isoDate, format.yearStyle, fiscalYearStartMonth);
    const [counter] = await tx
      .insert(numberSeriesCounters)
      .values({ tenantId, documentType, period: periodKey(period), lastValue: 1 })
      .onConflictDoUpdate({
        target: [
          numberSeriesCounters.tenantId,
          numberSeriesCounters.documentType,
          numberSeriesCounters.period,
        ],
        set: { lastValue: sql`${numberSeriesCounters.lastValue} + 1` },
      })
      .returning({ lastValue: numberSeriesCounters.lastValue });
    if (!counter) throw new Error('Counter upsert returned no row');
    return formatDocumentNumber(format, period, counter.lastValue);
  }

  list(): Promise<NumberSeries[]> {
    return this.withTenant(async (tx) => {
      const settings = await this.settingsOf(tx);
      const rows = await tx
        .select()
        .from(numberSeries)
        .where(eq(numberSeries.tenantId, getTenantId()));
      const saved = new Map(rows.map((row) => [row.documentType, row]));
      return Promise.all(
        DOCUMENT_TYPES.map(async (documentType) => {
          const row = saved.get(documentType);
          const format = row ?? defaultNumberFormat(documentType);
          return this.describe(tx, documentType, format, row?.version ?? 0, settings);
        }),
      );
    });
  }

  update(documentType: DocumentType, input: UpdateNumberSeriesInput): Promise<NumberSeries> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const { version, ...format } = input;
      const [current] = await tx
        .select()
        .from(numberSeries)
        .where(
          and(eq(numberSeries.tenantId, tenantId), eq(numberSeries.documentType, documentType)),
        )
        .for('update');
      if ((current?.version ?? 0) !== version) throw versionConflict();

      const userId = currentPrincipal().userId;
      // প্রথম বদল = নতুন রো। ON CONFLICT DO NOTHING: দুজন একসাথে প্রথমবার সেভ করলে দ্বিতীয়জন রো পায়
      // না (returning খালি) — unique error-এর 500-এর বদলে সাধারণ version_conflict
      const [row] = current
        ? await tx
            .update(numberSeries)
            .set({ ...format, version: sql`${numberSeries.version} + 1`, updatedBy: userId })
            .where(eq(numberSeries.id, current.id))
            .returning()
        : await tx
            .insert(numberSeries)
            .values({ tenantId, documentType, ...format, createdBy: userId, updatedBy: userId })
            .onConflictDoNothing()
            .returning();
      if (!row) throw versionConflict();

      await audit(tx, {
        action: 'number_series.updated',
        entityType: 'number_series',
        entityId: row.id,
        changes: diff(pickFormat(current ?? defaultNumberFormat(documentType)), pickFormat(format)),
      });
      return this.describe(
        tx,
        documentType,
        pickFormat(row),
        row.version,
        await this.settingsOf(tx),
      );
    });
  }

  // "আজ একটা হলে কোন নম্বর" — কাউন্টার শুধু পড়া হয়, বাড়ানো না
  private async describe(
    tx: Transaction,
    documentType: DocumentType,
    format: NumberFormat,
    version: number,
    settings: { fiscalYearStartMonth: number; timezone: string },
  ): Promise<NumberSeries> {
    const period = periodOf(
      todayIn(settings.timezone),
      format.yearStyle,
      settings.fiscalYearStartMonth,
    );
    const [counter] = await tx
      .select({ lastValue: numberSeriesCounters.lastValue })
      .from(numberSeriesCounters)
      .where(
        and(
          eq(numberSeriesCounters.tenantId, getTenantId()),
          eq(numberSeriesCounters.documentType, documentType),
          eq(numberSeriesCounters.period, periodKey(period)),
        ),
      );
    return {
      documentType,
      prefix: format.prefix,
      yearStyle: format.yearStyle,
      padding: format.padding,
      version,
      nextNumber: formatDocumentNumber(format, period, (counter?.lastValue ?? 0) + 1),
    };
  }

  private async formatOf(tx: Transaction, documentType: DocumentType) {
    const settings = await this.settingsOf(tx);
    const [row] = await tx
      .select()
      .from(numberSeries)
      .where(
        and(eq(numberSeries.tenantId, getTenantId()), eq(numberSeries.documentType, documentType)),
      );
    return {
      format: row ?? defaultNumberFormat(documentType),
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
    };
  }

  private async settingsOf(tx: Transaction) {
    const [settings] = await tx
      .select({
        fiscalYearStartMonth: tenantSettings.fiscalYearStartMonth,
        timezone: tenantSettings.timezone,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
    return settings;
  }
}
```

**কোন লাইন কেন:**

- `next()`-এর `ON CONFLICT … DO UPDATE SET last_value = last_value + 1 … RETURNING` — এক statement-এ "নেই হলে ১,
  আছে হলে +১" আর নতুন মান। দুজন একসাথে: প্রথমজন রো lock করে, দ্বিতীয়জন তার commit পর্যন্ত অপেক্ষা করে তারপর নতুন মান
  থেকে +১। নতুন সময়কালের প্রথম নম্বরে দুজন একসাথে INSERT করলে একজন unique index-এ আটকে UPDATE-এর পথে যায় — Postgres
  এটা নিজেই সামলায়। (৬.৫: ২০টা একসাথে → ০০০১…০০২০, "পড়ো তারপর +১" লিখলে একই নম্বর বহুবার।)
- `next(tx, …)` — নিজে `withTenant` খোলে না, caller-এর `tx` নেয়। এটাই পুরো ব্যাপার: ইনভয়েসের insert আর নম্বর একই
  transaction-এ, তাই ইনভয়েস rollback = নম্বর ফেরত।
- `periodKey('')` → `'all'`: PK-র কলামে '' রাখা যেত, কিন্তু psql-এ রো দেখে বোঝা কঠিন।
- **`pickFormat` — যাচাইয়ের সময় পাওয়া TypeScript-এর ফাঁক।** প্রথমে লেখা ছিল
  `diff({ ...(current ?? defaultNumberFormat(type)) }, { ...format })`। `current` DB-র পুরো রো (`createdAt: Date`
  সহ) — `Date` তো `AuditValue` না, তবু **typecheck পাস করল**। ছোট করে পরীক্ষা: `{ ...row }` একা দিলে TypeScript ঠিকই
  error দেয়; কিন্তু `{ ...(row ?? interfaceValue) }` — union-এ একটা interface থাকলে — index-signature চেক ফসকে যায়।
  ফল হতো: audit-এ `createdAt`-এর মতো ঘর চুপচাপ ঢুকত। তাই তিনটা ঘর স্পষ্ট করে বাছা। আর `pickFormat`-এর return type
  ইচ্ছা করে লেখা নেই: `NumberFormat` (interface)-এর implicit index signature নেই, `diff()`-এ বসে না; inferred object
  type-এর আছে। শিক্ষা: audit-এ কখনো পুরো রো spread না — ঘর বেছে।
- `update`-এ `version: 0` মানে "প্রথম সেভ": `current?.version ?? 0` দিয়ে একই তুলনা দুই ক্ষেত্রে। প্রথম সেভে
  `onConflictDoNothing().returning()` — দুজন একসাথে প্রথমবার সেভ করলে দ্বিতীয়জন খালি ফল পায় → `versionConflict()`,
  unique-violation-এর 500 না।
- `describe()` কাউন্টার শুধু পড়ে — তালিকার "পরের নম্বর" দেখতে দেখতে নম্বর খরচ হয়ে যায় না (টেস্ট: দুবার GET, একই
  উত্তর)। "আজ" = টেন্যান্টের টাইমজোনে (`todayIn(settings.timezone)`) — ঢাকায় ১ জুলাই রাত ১টা মানে নতুন অর্থবছর,
  সার্ভারের UTC ঘড়িতে তখনো ৩০ জুন।
- `list()`-এ `Promise.all` একই `tx`-এ — postgres.js একই connection-এ query সারিতে রাখে, তাই নিরাপদ; ছয়টা ছোট query।

**ফাইল: `apps/api/src/numbering/numbering.controller.ts`** (নতুন)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { NumberingService } from './numbering.service.js';

type Routes = typeof routes.numberSeries;

@Controller()
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @Endpoint(routes.numberSeries.list)
  @RequirePermission('core.settings.manage')
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.numbering.list() };
  }

  @Endpoint(routes.numberSeries.update)
  @RequirePermission('core.settings.manage')
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.numbering.update(params.documentType, body);
  }
}
```

**ফাইল: `apps/api/src/numbering/numbering.module.ts`** (নতুন)

```ts
import { Module } from '@nestjs/common';

import { NumberingController } from './numbering.controller.js';
import { NumberingService } from './numbering.service.js';

// NumberingService export: ধাপ ১০ (journal) আর ১৫ (ইনভয়েস)-এর মডিউল এটা import করে next() ডাকবে
@Module({
  controllers: [NumberingController],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
```

- তালিকা দেখতেও `core.settings.manage`: নম্বরের ছাঁচ কনফিগারেশন; সাধারণ ইউজারের কাজে লাগে শুধু ডকুমেন্টে বসা নম্বর।

### audit log পড়া

**ফাইল: `apps/api/src/audit/audit.controller.ts`** (নতুন)

```ts
import { Controller, Inject } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
import { auditLogs, users } from '@omnivo/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { Endpoint } from '../common/http/endpoint.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';

type ListRoute = typeof routes.audit.list;

@Controller()
export class AuditController {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  @Endpoint(routes.audit.list)
  @RequirePermission('core.audit.read')
  list({ query }: RouteInput<ListRoute>): Promise<RouteResponse<ListRoute>> {
    const tenantId = getTenantId();
    // cursor = [শেষ রো-র created_at, টেক্সট হিসেবে; তার id]। Date না: Postgres মাইক্রোসেকেন্ড রাখে, JS-এর
    // Date মিলিসেকেন্ড। Date-এ গোল করলে একই মিলিসেকেন্ডের পরের রো-গুলো (.123456 > .123000) "আগের পাতায়"
    // পড়ে বাদ যেত
    const after = decodeCursor(query.cursor, z.tuple([z.string().max(64), z.uuid()]));

    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          payload: auditLogs.payload,
          ipAddress: auditLogs.ipAddress,
          requestId: auditLogs.requestId,
          createdAt: auditLogs.createdAt,
          createdAtText: sql<string>`${auditLogs.createdAt}::text`,
          actorId: users.id,
          actorName: users.fullName,
        })
        .from(auditLogs)
        // users-এ RLS নেই — কিন্তু join শুধু এই টেন্যান্টের audit রো-র actor-এ, তাই বাইরের কেউ আসে না
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            eq(auditLogs.tenantId, tenantId),
            // `&&` না: entityId-র টাইপ string, আর '' && … মানে '' — SQL না। and() undefined বাদ দেয়
            query.entityType === undefined ? undefined : eq(auditLogs.entityType, query.entityType),
            query.entityId === undefined ? undefined : eq(auditLogs.entityId, query.entityId),
            // নতুন আগে: (created_at, id) জোড়া দিয়ে "এর চেয়ে পুরনো"; index-এর কলাম-ক্রম হুবহু এটাই।
            // ::text::timestamptz: প্যারামিটার text হয়ে হুবহু পৌঁছায়, রূপান্তর Postgres-এর ভেতরে। শুধু
            // ::timestamptz লিখলে Postgres প্যারামিটারকে timestamptz ধরে, আর খালি postgres.js সেটা JS Date
            // হয়ে পাঠায় — মাইক্রোসেকেন্ড কাটে (যাচাই করা: .123400 → .123)। drizzle নিজের driver-এ সেই
            // serializer বদলে দেয় বলে এখানে দুটোই চলে; text-cast driver-এর এই খুঁটিনাটির উপর নির্ভর করে না
            after &&
              sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${after[0]}::text::timestamptz, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.limit + 1);

      const page = toPage(rows, query.limit, (last) => [last.createdAtText, last.id]);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          actor:
            row.actorId !== null && row.actorName !== null
              ? { id: row.actorId, fullName: row.actorName }
              : null,
          changes: row.payload?.changes ?? {},
          ipAddress: row.ipAddress,
          requestId: row.requestId,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}
```

**ফাইল: `apps/api/src/audit/audit.module.ts`** (নতুন)

```ts
import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';

// লেখার দিক (audit()) module না, একটা ফাংশন (common/audit) — প্রতিটা মডিউল নিজের transaction-এ ডাকে।
// এই module শুধু পড়ার দিক: viewer-এর endpoint
@Module({
  controllers: [AuditController],
})
export class AuditModule {}
```

**কোন লাইন কেন — cursor-এর দুটো ফাঁদ:**

- **cursor-এ `created_at` টেক্সট হিসেবে, `Date` না।** Postgres মাইক্রোসেকেন্ড রাখে (`.123456`), JS-এর `Date`
  মিলিসেকেন্ড (`.123`)। শেষ রো-র সময় `Date` হয়ে cursor-এ গেলে `.123000` হয়; পরের পাতার শর্ত
  `(created_at, id) < ('.123000', id)` — অথচ একই মিলিসেকেন্ডের বাকি রো `.123300`, `.123200` সেই শর্তে পড়ে না, বাদ
  যায়। যাচাই: একই মিলিসেকেন্ডে পাঁচটা রো, পাতা ২টা করে — `Date`-cursor-এ ২টা আসে, টেক্সট-cursor-এ ৫টা।
  `::text` Postgres-এর নিজের পূর্ণ-নির্ভুল লেখা দেয়, আর cursor সেটা হুবহু ফেরত আনে।
- **ফেরত আনার সময় `::text::timestamptz`।** শুধু `${x}::timestamptz` লিখলে Postgres প্যারামিটারের টাইপ timestamptz
  ধরে, আর খালি postgres.js সেই টাইপের মান JS `Date` বানিয়ে পাঠায় — মাইক্রোসেকেন্ড আবার কাটে (যাচাই: `.123400` →
  `.123`)। drizzle নিজের driver-এ postgres.js-এর timestamp serializer বদলে দেয় (`drizzle-orm/postgres-js/driver.js`),
  তাই এই API-তে একক cast-ও কাজ করত (যাচাই করা) — কিন্তু text-cast driver-এর খুঁটিনাটির উপর নির্ভর করে না। টেস্টের
  superuser (খালি postgres.js) ঠিক এই ফাঁদে পড়েছিল: প্রথমবার টেস্টের insert-ই মাইক্রোসেকেন্ড হারিয়েছিল, তাই টেস্ট
  কিছু যাচাই করছিল না (৬.৫)।
- `query.entityId === undefined ? undefined : eq(…)` — `&&` দিলে `entityId`-র টাইপ string, তাই `'' && …` মানে `''`,
  আর `and()` SQL চায় — typecheck ধরেছিল।
- `leftJoin(users, …)` — actor মুছে যাওয়া ইউজার বা null (সিস্টেম) হলেও audit রো আসে; inner join হলে সেই রো
  হারাত।
- ধাপ ৫-এর members-এর মতো sort বিকল্প নেই — audit সবসময় নতুন আগে। ফিল্টার cursor-এ বাঁধা না: ফিল্টার বদলালে UI
  নতুন query key দিয়ে প্রথম পাতা থেকে শুরু করে (৬.৮)।

### attachments

**ফাইল: `apps/api/src/attachments/attachments.service.ts`** (নতুন)

```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Attachment, CreateUploadInput, UploadTicket } from '@omnivo/contracts';
import { attachments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { AppError, notFound } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService, type SignedUrl } from '../storage/storage.service.js';

// আপলোডের ঠিকানা ১০ মিনিট চলে — ধীর নেটওয়ার্কে ২ MB-র জন্য যথেষ্ট, আর ফাঁস হলেও বেশিক্ষণ কাজে লাগে না
const UPLOAD_TTL_SECONDS = 10 * 60;

type AttachmentRow = typeof attachments.$inferSelect;

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    purpose: row.purpose,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function uploadIncomplete(): AppError {
  return new AppError(409, 'upload_incomplete', "The file wasn't uploaded, or it doesn't match.");
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  // ধাপ ১: রো (pending) + সই করা PUT ঠিকানা। ফাইল নিজে কখনো API-তে আসে না
  createUpload(input: CreateUploadInput): Promise<UploadTicket> {
    const tenantId = getTenantId();
    const now = new Date();
    // system-design §৩.৭-এর পাথ। টেন্যান্ট দিয়ে শুরু: একটা টেন্যান্টের সব ফাইল এক prefix-এ — export,
    // মুছে ফেলা বা অন্য region-এ সরানো এক কমান্ডে। UTC মাস: পাথ শুধু সাজানোর জন্য, কারো চোখে পড়ে না
    const key = [
      'tenants',
      tenantId,
      input.purpose,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      randomUUID(),
    ].join('/');

    return this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(attachments)
        .values({ tenantId, ...input, storageKey: key, createdBy: currentPrincipal().userId })
        .returning();
      if (!row) throw new Error('Attachment insert returned no row');
      const upload = await this.storage.uploadUrl(key, input.contentType, UPLOAD_TTL_SECONDS);
      return {
        attachment: toAttachment(row),
        upload: {
          method: 'PUT',
          url: upload.url,
          headers: { 'content-type': input.contentType },
          expiresAt: upload.expiresAt.toISOString(),
        },
      };
    });
  }

  // ধাপ ২: ব্রাউজার বলে "পাঠিয়েছি" — কিন্তু বিশ্বাস না করে storage-কে জিজ্ঞেস করা হয়। presigned PUT
  // আকার বাঁধতে পারে না (S3-এর POST policy পারে, R2 সেটা সমর্থন করে না) — তাই ২ MB ঘোষণা করে ২০০ MB
  // পাঠানো ঠেকানোর জায়গা এটাই: না মিললে ফাইল মুছে 409
  complete(id: string): Promise<Attachment> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, id, true);
      if (row.status === 'ready') return toAttachment(row);

      const stored = await this.storage.head(row.storageKey);
      if (!stored) throw uploadIncomplete();
      if (stored.sizeBytes !== row.sizeBytes || stored.contentType !== row.contentType) {
        await this.storage.delete(row.storageKey);
        throw uploadIncomplete();
      }

      const [ready] = await tx
        .update(attachments)
        .set({ status: 'ready', updatedBy: currentPrincipal().userId })
        .where(eq(attachments.id, id))
        .returning();
      if (!ready) throw notFound('Attachment');
      return toAttachment(ready);
    });
  }

  download(id: string): Promise<SignedUrl> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, id, false);
      if (row.status !== 'ready') {
        throw new AppError(409, 'attachment_not_ready', 'The file has not finished uploading.');
      }
      return this.storage.downloadUrl(row.storageKey, row.contentType);
    });
  }

  private async find(tx: Transaction, id: string, forUpdate: boolean): Promise<AttachmentRow> {
    const query = tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.tenantId, getTenantId()), eq(attachments.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Attachment');
    return row;
  }
}
```

**ফাইল: `apps/api/src/attachments/attachments.controller.ts`** (নতুন)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { AttachmentsService } from './attachments.service.js';

type Routes = typeof routes.attachments;

@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // এখন একটাই কাজ (লোগো), তাই সেটার permission। ইনভয়েসের PDF-এর মতো নতুন কাজ এলে permission আসবে
  // purpose থেকে (ATTACHMENT_RULES-এ) — তখন এই decorator-এর জায়গায় service-এ চেক
  @Endpoint(routes.attachments.createUpload)
  @RequirePermission('core.settings.manage')
  async createUpload({
    body,
  }: RouteInput<Routes['createUpload']>): Promise<RouteResponse<Routes['createUpload']>> {
    return this.attachments.createUpload(body);
  }

  @Endpoint(routes.attachments.complete)
  @RequirePermission('core.settings.manage')
  complete({ params }: RouteInput<Routes['complete']>): Promise<RouteResponse<Routes['complete']>> {
    return this.attachments.complete(params.id);
  }

  @Endpoint(routes.attachments.download)
  async download({
    params,
  }: RouteInput<Routes['download']>): Promise<RouteResponse<Routes['download']>> {
    const signed = await this.attachments.download(params.id);
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
```

**ফাইল: `apps/api/src/attachments/attachments.module.ts`** (নতুন)

```ts
import { Module } from '@nestjs/common';

import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
```

**কোন লাইন কেন:**

- storage key-তে `randomUUID()`, রো-র id না: রো insert হওয়ার আগেই key লাগে (insert-এর মান), আর আলাদা থাকলে key দেখে
  DB-র id অনুমান করা যায় না।
- key-এর মাস UTC-তে — পাথ শুধু storage-এ সাজানোর জন্য (lifecycle rule, "২০২৬/০৯-এর সব"), কোনো মানুষ দেখে না; টেন্যান্টের
  টাইমজোন আনতে DB-তে আরেকটা query-র মানে নেই।
- `complete`-এ `head()`-এর ফল না মিললে **ফাইল মুছে** তারপর 409: ২ MB ঘোষণা করে ২০০ MB পাঠানো ফাইল storage-এ পড়ে থাকলে
  কারো কোটা আর খরচ খেত। (টেস্ট: ১০ বাইট ঘোষণা, আসল ফাইল বড় → 409, তারপর আবার confirm → "ফাইল নেই"।)
- `complete` idempotent — `ready` হলে সোজা ফেরত। নেটওয়ার্কে উত্তর হারিয়ে ব্রাউজার আবার চাইলে error না।
- `download` `pending` ফাইলে 409 — আপলোড শেষ না হওয়া ফাইলের ঠিকানা দেওয়া মানে 404-ওয়ালা লিংক।
- controller-এ `createUpload`/`complete`-এ `core.settings.manage`: এখন একটাই কাজ (লোগো)। দ্বিতীয় purpose এলে
  permission আসবে `ATTACHMENT_RULES` থেকে, service-এ — মন্তব্যে লেখা।
- `download`-এ permission নেই: attachment id জানা মানেই সেই টেন্যান্টের ভেতরের কেউ (RLS), আর লোগো সবাই দেখে।

---

## ৬.৫ — API-র টেস্ট

নতুন ২৯টা integration আর ৫টা tenant-leak টেস্ট, একটা নতুন unit (CORS)। প্রতিটা "পাহারা"-টেস্ট ইচ্ছা করে কোড ভেঙে
দেখা হয়েছে যে সত্যিই fail করে — নিচের টেবিলে। যে টেস্ট ভাঙা কোডেও পাস করে, সে কিছুই পাহারা দেয় না — যাচাইয়ের
সময় দুটো টেস্ট ঠিক এমন ছিল, আর সেগুলো আবার লেখা হয়েছে।

| টেস্ট | কী ভাঙলে | ভাঙা কোডে ফল |
|---|---|---|
| `branches.int.spec.ts` — "two archives race" | `archive()`-এর চালু-ব্রাঞ্চ lock (`.for('update')`) মুছলে | `expected 200 to be 409` — চালু ব্রাঞ্চ শূন্য |
| `numbering.int.spec.ts` — "20 concurrent numbers" | `next()`-এ "আগে SELECT, তারপর +১ লেখো" | `INV-2026-27-0002` বহুবার |
| `audit.int.spec.ts` — "share a millisecond" | cursor-এ `createdAtText`-এর জায়গায় `createdAt.toISOString()` | ৫টার জায়গায় ২টা রো |
| `contract.spec.ts` — CORS | `configure-app.ts`-এর `methods: CORS_METHODS` মুছলে | `expected [ 'GET', 'HEAD', 'POST' ] to include 'PATCH'` |
| `rls-coverage` | কোনো tenant-টেবিলে `NO FORCE ROW LEVEL SECURITY` | টেবিলের নাম সহ fail (psql-এ query চালিয়ে দেখা) |

### টেস্টের সাহায্যকারী

**ফাইল: `apps/api/src/testing/containers.ts`** (আপডেট)

import-এ `grantOwnerPermissions` যোগ, আর `syncPermissions(migratorDb)`-এর পরে:

```ts
  await grantOwnerPermissions(migratorDb);
```

ফাইলের শেষে:

```ts
export interface TestStorage {
  container: StartedTestContainer;
  url: string;
}

// docker-compose-এর storage সার্ভিসের একই image আর চাবি। bucket বানায় API নিজেই
// (StorageService.onApplicationBootstrap), ঠিক `pnpm dev`-এর মতো
export async function startStorage(): Promise<TestStorage> {
  const container = await new GenericContainer('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: 'omnivo', MINIO_ROOT_PASSWORD: 'omnivo-dev-secret' })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();
  return {
    container,
    url: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
  };
}
```

- টেস্টেও `migrate.ts`-এর একই ক্রম (sync → grant) — production-এর পথ যা, টেস্টের পথও তা।
- `Wait.forHttp('/minio/health/ready', 9000)` — MinIO-র নিজের readiness endpoint; পোর্ট খোলা মানেই তৈরি না।
- `@testcontainers/minio` প্যাকেজ না নিয়ে `GenericContainer`: সেই প্যাকেজের সংস্করণ `testcontainers`-এর সাথে বাঁধা
  (১২.২ বনাম আমাদের ১২.১), নিলে lockfile-এ দুটো কপি আর `pnpm dedupe --check` fail। আমাদের যা লাগে তা পাঁচ লাইন।

**ফাইল: `apps/api/src/testing/app.ts`** (পুরো ফাইল)

```ts
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../app.module.js';
import { type Config, loadConfig } from '../config.js';
import { configureApp, createAdapter } from '../configure-app.js';

// .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
// storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
export function testConfig(urls: {
  databaseUrl: string;
  redisUrl: string;
  storageUrl?: string;
}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.databaseUrl,
    REDIS_URL: urls.redisUrl,
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
  });
}

export async function createTestApp(config: Config): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    createAdapter(),
    { logger: false },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
```

- `storageUrl` ঐচ্ছিক — branches, numbering, audit-এর টেস্ট ফাইল ছোঁয় না; তাদের জন্য MinIO container তোলা মানে
  প্রতিটা ফাইলে অকারণে কয়েক সেকেন্ড। অচল ঠিকানায় `StorageService`-এর bootstrap শুধু সতর্ক করে (৬.৩)।

**ফাইল: `apps/api/src/testing/http.ts`** (আপডেট — import-এ `type LoginInput`, আর শেষে)

```ts
export async function logIn(app: NestFastifyApplication, input: LoginInput): Promise<SignedIn> {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: input });
  expect(response.statusCode).toBe(200);
  return sessionOf(response);
}
```

**ফাইল: `apps/api/src/testing/workspace.ts`** (নতুন)

```ts
import postgres from 'postgres';

// ধাপ ৭-এর invite আসার আগে: একজন বিদ্যমান ইউজারকে আরেকটা workspace-এ ঢোকানো, কোনো রোল ছাড়া —
// তাহলে সে লগইন করতে পারে কিন্তু কোনো permission নেই। সরাসরি SQL (superuser, RLS-এর বাইরে)
export async function joinWithoutRoles(
  superuserUrl: string,
  { email, workspace }: { email: string; workspace: string },
): Promise<void> {
  const sql = postgres(superuserUrl, { max: 1 });
  try {
    await sql`
      INSERT INTO memberships (id, tenant_id, user_id)
      SELECT gen_random_uuid(), t.id, u.id
      FROM tenants t, users u
      WHERE t.slug = ${workspace} AND u.email = ${email}`;
  } finally {
    await sql.end();
  }
}
```

- "permission ছাড়া সদস্য" দরকার (403-এর টেস্ট), কিন্তু invite আসবে ধাপ ৭-এ। পথটা: দ্বিতীয় ইউজার নিজের workspace
  বানায় (তাই তার পাসওয়ার্ড আছে, লগইন করা যায়), তারপর SQL দিয়ে প্রথম workspace-এ রোল ছাড়া membership। members-এর
  টেস্টের (ধাপ ৫) মতো সরাসরি `users`-এ insert করলে পাসওয়ার্ড থাকত না।

### `contract.spec.ts` — CORS

**ফাইল: `apps/api/src/contract.spec.ts`** (আপডেট — `describe('docs', …)`-এর আগে)

```ts
describe('CORS', () => {
  it('lets the app send every method the contract uses, not only GET and POST', async () => {
    // ব্রাউজার PUT/PATCH-এর আগে এই preflight পাঠায়; উত্তরে method না থাকলে আসল request যায়ই না
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/settings',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PUT',
      },
    });
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers['access-control-allow-methods']).split(/,\s*/);
    const registry: Record<string, Record<string, RouteDef>> = routes;
    const used = new Set(
      Object.values(registry).flatMap((group) => Object.values(group).map((route) => route.method)),
    );
    for (const method of used) expect(allowed).toContain(method);
  });
});
```

- ব্রাউজারের preflight হুবহু: `OPTIONS` + `origin` + `access-control-request-method`। Docker লাগে না (এই ফাইলের বাকি
  টেস্টের মতো), তাই সাধারণ `pnpm test`-এ চলে।
- প্রত্যাশিত method-এর তালিকা **রেজিস্ট্রি থেকে** — হাতে লেখা `['GET', 'PUT']` না। ধাপ ২৯-এ কেউ প্রথম `DELETE` রুট
  যোগ করে `CORS_METHODS` ভুলে গেলে এই টেস্ট নিজেই ধরবে।

### `auth.int.spec.ts`

**ফাইল: `apps/api/src/auth/auth.int.spec.ts`** (আপডেট)

import-এ `import { PERMISSIONS } from '@omnivo/db';`, আর sign-up টেস্টের permission-লাইনটা:

```ts
    // Owner = catalog-এর সব permission; তালিকা হাতে লিখলে প্রতিটা নতুন permission-এ এই টেস্ট ভাঙত
    expect(me.permissions).toEqual(PERMISSIONS.map((permission) => permission.key).sort());
```

- যাচাইয়ের সময় এই টেস্টই প্রথম ভেঙেছিল — "expected [ 'core.audit.read', …(5) ] to deeply equal
  [ 'core.role.manage', …(2) ]"। নতুন permission-এ Owner ঠিক কাজ করছিল; টেস্টটা পুরনো তালিকা মুখস্থ রেখেছিল।

### integration টেস্ট

**ফাইল: `apps/api/src/branches/branches.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Branch,
  branchListSchema,
  branchSchema,
  problemSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let owner: SignedIn;
let viewer: SignedIn;

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
  // দ্বিতীয় জন: নিজের workspace আছে, আর Rahman Garments-এ কোনো রোল ছাড়া সদস্য
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function create(code: string, name: string): Promise<Branch> {
  const res = await send('POST', '/branches', { code, name, phone: '', address: '' });
  expect(res.statusCode).toBe(201);
  return branchSchema.parse(res.json());
}

async function activeCodes(): Promise<string[]> {
  const { items } = branchListSchema.parse((await send('GET', '/branches')).json());
  return items.map((branch) => branch.code);
}

describe('branches', () => {
  it('starts every workspace with a head office', async () => {
    expect(await activeCodes()).toEqual(['HO']);
  });

  it('creates a branch and refuses the same code in another case', async () => {
    const gazipur = await create('gzp', 'Gazipur factory');
    expect(gazipur).toMatchObject({ code: 'GZP', version: 1, archivedAt: null });

    const res = await send('POST', '/branches', {
      code: 'GZP',
      name: 'Again',
      phone: '',
      address: '',
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ code: ['branch_code_taken'] });
  });

  it('saves an edit once, then refuses the same stale version', async () => {
    const ctg = await create('CTG', 'Chattogram depot');
    const edit = { code: 'CTG', name: 'Chattogram port depot', phone: '', address: '', version: 1 };

    const first = await send('PUT', `/branches/${ctg.id}`, edit);
    expect(branchSchema.parse(first.json())).toMatchObject({ name: edit.name, version: 2 });

    const second = await send('PUT', `/branches/${ctg.id}`, { ...edit, name: 'Someone else' });
    expect(second.statusCode).toBe(409);
    expect(problemSchema.parse(second.json()).code).toBe('version_conflict');
  });

  it('answers an unknown id with 404 and a malformed one with 400', async () => {
    expect((await send('GET', '/branches/01939d1c-0000-7000-8000-000000000000')).statusCode).toBe(
      404,
    );
    const malformed = await send('GET', '/branches/not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(problemSchema.parse(malformed.json()).fieldErrors).toEqual({ id: ['invalid_format'] });
  });

  it('keeps at least one branch active, even when two archives race', async () => {
    // এখন চালু: CTG, GZP, HO। CTG আগে archive — বাকি দুটো নিয়ে দৌড়
    const { items } = branchListSchema.parse((await send('GET', '/branches')).json());
    const byCode = new Map(items.map((branch) => [branch.code, branch]));
    const ctg = byCode.get('CTG');
    const gzp = byCode.get('GZP');
    const ho = byCode.get('HO');
    if (!ctg || !gzp || !ho) throw new Error('setup: branches missing');
    expect(
      (await send('POST', `/branches/${ctg.id}/archive`, { version: ctg.version })).statusCode,
    ).toBe(200);

    // দৌড়টা নিশ্চিতভাবে ঘটানো: আরেকটা transaction GZP archive করে commit না করে ধরে রাখে, আর সেই
    // ফাঁকে API HO archive করতে চায়। দুটো request একসাথে পাঠালে (Promise.all) প্রায়ই একটা আরেকটার
    // আগে শেষ হয়ে যেত — lock মুছে দিলেও টেস্ট পাস করত (যাচাই করা), মানে কিছুই প্রমাণ করত না
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`UPDATE branches SET archived_at = now(), version = version + 1 WHERE id = ${gzp.id}`;
      pending = send('POST', `/branches/${ho.id}/archive`, { version: ho.version });
      // lock থাকলে API এখানে GZP-র রো-তে আটকে থাকে; না থাকলে এর মধ্যেই 200 দিয়ে শেষ
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await superuser.end();

    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(problemSchema.parse(res?.json()).code).toBe('branch_last_active');
    expect(await activeCodes()).toEqual(['HO']);
  });

  it('writes who changed what to the audit log', async () => {
    const res = await send('GET', '/audit-logs?entityType=branch&limit=100');
    const { items } = auditPageSchema.parse(res.json());
    const edit = items.find((entry) => entry.action === 'branch.updated');
    expect(edit).toMatchObject({
      actor: { fullName: 'Farhana Rahman' },
      // শুধু বদলানো ঘর — কোড, ফোন, ঠিকানা একই ছিল
      changes: { name: { from: 'Chattogram depot', to: 'Chattogram port depot' } },
      ipAddress: '127.0.0.1',
    });
    expect(items.filter((entry) => entry.action === 'branch.created')).toHaveLength(2);
    // CTG API দিয়ে; GZP টেস্টের SQL দিয়ে (audit ছাড়া) — তাই একটাই
    expect(items.filter((entry) => entry.action === 'branch.archived')).toHaveLength(1);
  });

  it('lets a member without the permission read branches but not change them', async () => {
    expect((await send('GET', '/branches', undefined, viewer)).statusCode).toBe(200);
    const res = await send(
      'POST',
      '/branches',
      { code: 'MYM', name: 'Mymensingh', phone: '', address: '' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'core.branch.manage' },
    });
  });
});
```

**race টেস্টটা কেন এভাবে লেখা:** প্রথম সংস্করণে দুটো archive একসাথে পাঠানো হয়েছিল (`Promise.all`)। টেস্ট পাস
করল — তারপর `archive()`-এর lock মুছে তিনবার চালানো হলো, **তিনবারই পাস**। অর্থাৎ দুটো request আসলে একসাথে
চলছিল না (একটার transaction আরেকটা শুরুর আগেই শেষ), আর টেস্টটা কিছুই প্রমাণ করছিল না। এখনকার সংস্করণ দৌড়টা
নিশ্চিতভাবে ঘটায়: superuser-এর একটা transaction GZP archive করে commit না করে ধরে রাখে, সেই ফাঁকে API HO archive
করতে চায়।

- lock থাকলে: API-র `SELECT … FOR UPDATE` GZP-র রো-তে আটকে যায় (superuser-এর transaction সেটা বদলাচ্ছে)। ৩০০ ms
  পরে superuser commit করে; Postgres রো-টা আবার যাচাই করে — GZP এখন archived, শর্তে মেলে না — চালু শুধু HO →
  `409 branch_last_active`।
- lock না থাকলে: API GZP-কে চালু দেখে (অন্যের uncommitted বদল দেখা যায় না), HO archive করে 200 দেয় — superuser
  commit-এর পরে চালু ব্রাঞ্চ শূন্য। (যাচাই করা: দুবার চালিয়ে দুবারই "expected 200 to be 409"।)
- ৩০০ ms-এর উপর টেস্টের ফল নির্ভর করে না: lock থাকলে request commit-এর আগে ফিরতেই পারে না; অপেক্ষাটা শুধু "যদি lock
  না থাকে" অবস্থাকে নিজেকে দেখানোর সময় দেয়।
- superuser RLS মানে না — তাই এই একটা লেখার জন্য tenant context লাগে না। এই পথে audit লেখা হয় না, তাই audit-এর
  টেস্ট দুটো archive না, একটা গোনে।

**ফাইল: `apps/api/src/numbering/numbering.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  meResponseSchema,
  numberSeriesListSchema,
  numberSeriesSchema,
  periodOf,
  problemSchema,
  todayIn,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { NumberingService } from './numbering.service.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let owner: SignedIn;
let tenantId: string;
let numbering: NumberingService;
let withTenant: WithTenant;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  owner = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: bearer(owner.accessToken),
  });
  tenantId = meResponseSchema.parse(me.json()).tenant.id;
  // পরের ধাপের মডিউল যেভাবে ডাকবে ঠিক সেভাবে: নিজের transaction-এর ভেতর থেকে next()
  numbering = app.get(NumberingService);
  withTenant = app.get<WithTenant>(WITH_TENANT);
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function allocate(date: string): Promise<string> {
  return runWithTenant(tenantId, () =>
    withTenant((tx) => numbering.next(tx, 'sales.invoice', date)),
  );
}

describe('numbering allocation', () => {
  it('hands out 20 concurrent numbers without a duplicate or a gap', async () => {
    const numbers = await Promise.all(Array.from({ length: 20 }, () => allocate('2026-09-23')));
    expect(numbers.toSorted()).toEqual(
      Array.from({ length: 20 }, (_, i) => `INV-2026-27-${String(i + 1).padStart(4, '0')}`),
    );
  });

  it('gives a rolled-back number to the next document, so no gap appears', async () => {
    await expect(
      runWithTenant(tenantId, () =>
        withTenant(async (tx) => {
          expect(await numbering.next(tx, 'sales.invoice', '2026-09-23')).toBe('INV-2026-27-0021');
          throw new Error('invoice failed to save');
        }),
      ),
    ).rejects.toThrow('invoice failed to save');
    expect(await allocate('2026-09-23')).toBe('INV-2026-27-0021');
  });

  it('starts again at 0001 when the fiscal year turns', async () => {
    expect(await allocate('2027-06-30')).toBe('INV-2026-27-0022');
    expect(await allocate('2027-07-01')).toBe('INV-2027-28-0001');
  });
});

describe('number series endpoints', () => {
  function send(method: 'GET' | 'PUT', url: string, payload?: object) {
    return app.inject({
      method,
      url,
      headers: bearer(owner.accessToken),
      ...(payload && { payload }),
    });
  }

  it('lists every document type with its next number, without using it up', async () => {
    const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
    const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
    expect(items.map((series) => series.documentType)).toHaveLength(6);
    expect(items.find((series) => series.documentType === 'purchase.order')).toMatchObject({
      prefix: 'PO',
      version: 0,
      nextNumber: `PO-${today}-0001`,
    });
    // দুবার দেখলেও একই — প্রিভিউ কাউন্টার বাড়ায় না
    const again = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
    expect(again.items).toEqual(items);
  });

  it('saves a new format on version 0, then refuses a second version-0 save', async () => {
    const change = { prefix: 'jv', yearStyle: 'calendar', padding: 5, version: 0 };
    const res = await send('PUT', '/number-series/accounting.journal', change);
    expect(numberSeriesSchema.parse(res.json())).toMatchObject({
      prefix: 'JV',
      version: 1,
      nextNumber: `JV-${todayIn('Asia/Dhaka').slice(0, 4)}-00001`,
    });

    const stale = await send('PUT', '/number-series/accounting.journal', change);
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');
  });

  it('refuses a document type that does not exist', async () => {
    const res = await send('PUT', '/number-series/sales.quote', {
      prefix: 'QT',
      yearStyle: 'none',
      padding: 4,
      version: 0,
    });
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toHaveProperty('documentType');
  });
});
```

- `app.get(NumberingService)` আর `app.get(WITH_TENANT)` — HTTP-র endpoint নেই (নম্বর নেয় পরের মডিউল), তাই পরের
  মডিউল যেভাবে ডাকবে ঠিক সেভাবে: `runWithTenant` → `withTenant` → `next(tx, …)`।
- ২০টা একসাথে, pool-এ ১০টা connection (postgres.js-এর ডিফল্ট) — বাকিরা সারিতে দাঁড়ায়, তবু প্রতিটা আলাদা
  transaction; ডুপ্লিকেট হলে এখানেই ধরা পড়ে।
- rollback-এর টেস্ট: `next()` ০০২১ দেয়, তারপর transaction ভাঙে — পরের ডাক আবার ০০২১। SEQUENCE হলে ০০২২ হতো।
- endpoint-এর টেস্টে বছর হাতে লেখা নেই (`periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7)`) — জুলাই মাসে টেস্ট fail
  করবে না।
- `sales.quote` → 400 `documentType` ঘরে: চুক্তির `z.enum` path parameter-ও যাচাই করে।

**ফাইল: `apps/api/src/settings/settings.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  attachmentSchema,
  auditPageSchema,
  meResponseSchema,
  problemSchema,
  type Settings,
  settingsSchema,
  uploadTicketSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let owner: SignedIn;
let viewer: SignedIn;

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, as = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function current(): Promise<Settings> {
  return settingsSchema.parse((await send('GET', '/settings')).json());
}

function form(settings: Settings) {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}

describe('settings', () => {
  it('starts with Bangladesh defaults', async () => {
    expect(await current()).toMatchObject({
      companyName: 'Rahman Garments Ltd.',
      baseCurrency: 'BDT',
      fiscalYearStartMonth: 7,
      timezone: 'Asia/Dhaka',
      logo: null,
      version: 1,
    });
  });

  it('saves the company profile, renames the workspace and audits only what changed', async () => {
    const res = await send('PUT', '/settings', {
      ...form(await current()),
      companyName: 'Rahman Knit Garments Ltd.',
      bin: '000123456-0101',
    });
    expect(res.statusCode).toBe(200);
    expect(settingsSchema.parse(res.json())).toMatchObject({ bin: '0001234560101', version: 2 });

    // switcher আর লগইন যা পড়ে (tenants.name) সেটাও বদলেছে
    const me = await send('GET', '/auth/me');
    expect(meResponseSchema.parse(me.json()).tenant.name).toBe('Rahman Knit Garments Ltd.');

    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    const entry = audit.items.find((item) => item.action === 'settings.updated');
    expect(entry?.changes).toEqual({
      companyName: { from: 'Rahman Garments Ltd.', to: 'Rahman Knit Garments Ltd.' },
      bin: { from: null, to: '0001234560101' },
    });
    // audit-এর request id আর response header-এর id একই — সাপোর্টে লগ মেলানোর সূত্র
    expect(entry?.requestId).toBe(res.headers['x-request-id']);
  });

  it('refuses a save based on an old version', async () => {
    const res = await send('PUT', '/settings', { ...form(await current()), version: 1 });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('version_conflict');
  });

  it('checks the BIN and the time zone on the server too', async () => {
    const res = await send('PUT', '/settings', {
      ...form(await current()),
      bin: '12345',
      timezone: 'Asia/Gazipur',
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      bin: ['bin_format'],
      timezone: ['timezone_invalid'],
    });
  });

  it('lets any member read the settings but only managers change them', async () => {
    expect((await send('GET', '/settings', undefined, viewer)).statusCode).toBe(200);
    const res = await send('PUT', '/settings', form(await current()), viewer);
    expect(res.statusCode).toBe(403);
  });
});

// ১×১ px PNG — আসল ছবির বাইট, যাতে storage-এর Content-Type আর আকার সত্যিই মেলানো যায়
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function ticket(sizeBytes = PNG.length) {
  const res = await send('POST', '/attachments', {
    purpose: 'company_logo',
    fileName: 'rahman-logo.png',
    contentType: 'image/png',
    sizeBytes,
  });
  expect(res.statusCode).toBe(201);
  return uploadTicketSchema.parse(res.json());
}

describe('company logo', () => {
  it('uploads straight to storage, confirms it and shows it in the settings', async () => {
    const { attachment, upload } = await ticket();
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PNG });
    expect(put.status).toBe(200);

    const done = await send('POST', `/attachments/${attachment.id}/complete`);
    expect(attachmentSchema.parse(done.json()).status).toBe('ready');

    const settings = settingsSchema.parse(
      (await send('PUT', '/settings/logo', { attachmentId: attachment.id })).json(),
    );
    // লোগো বদলানো version বাড়ায় না — খোলা ফর্ম এতে অচল হয় না
    expect(settings.version).toBe(2);
    if (!settings.logo) throw new Error('logo missing');
    const image = await fetch(settings.logo.url);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

    // একই ঘণ্টায় আবার পড়লে একই ঠিকানা — ব্রাউজারের cache কাজে লাগে
    expect((await current()).logo?.url).toBe(settings.logo.url);
  });

  it('rejects an upload sent with a different Content-Type than the one signed', async () => {
    const { upload } = await ticket();
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: PNG,
    });
    expect(put.status).toBe(403);
  });

  it('refuses to confirm a file bigger than declared, and deletes it', async () => {
    const { attachment, upload } = await ticket(10);
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: PNG });
    const res = await send('POST', `/attachments/${attachment.id}/complete`);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('upload_incomplete');
    // মুছে ফেলা হয়েছে: আবার confirm করলে "ফাইল নেই"
    expect((await send('POST', `/attachments/${attachment.id}/complete`)).statusCode).toBe(409);
  });

  it('will not use a file that was never uploaded as the logo', async () => {
    const { attachment } = await ticket();
    const res = await send('PUT', '/settings/logo', { attachmentId: attachment.id });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('attachment_not_ready');
  });

  it('refuses an SVG before any URL is signed', async () => {
    const res = await send('POST', '/attachments', {
      purpose: 'company_logo',
      fileName: 'logo.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 900,
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      contentType: ['file_type_not_allowed'],
    });
  });
});
```

- `ticket()`-এর `sizeBytes = PNG.length` — আসল বাইট, তাই `complete`-এর আকার-মেলানো সত্যিই চলে। `ticket(10)` দিয়ে
  মিথ্যা ঘোষণা।
- "different Content-Type" টেস্ট — `signableHeaders` ছাড়া এটা fail করে (MinIO 200 দেয়); যাচাইয়ের সময় ঠিক এভাবেই
  ধরা পড়েছিল যে SDK ডিফল্টে Content-Type সই করে না।
- `expect(entry?.requestId).toBe(res.headers['x-request-id'])` — audit-এর request id আর response-এর header একই:
  middleware-এর ALS সত্যিই handler আর service পর্যন্ত পৌঁছায়।
- লোগো বদলের পরে `version` এখনো ২ — ভিত্তি-সিদ্ধান্ত অনুযায়ী লোগো ফর্মের lock ছোঁয় না।
- একই ঘণ্টায় দুবার পড়লে একই URL — `downloadUrl`-এর স্থির জানালা (৬.৩)।

**ফাইল: `apps/api/src/audit/audit.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuditEntry,
  auditPageSchema,
  meResponseSchema,
  preferencesSchema,
  problemSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let owner: SignedIn;
let viewer: SignedIn;
let tenantId: string;

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
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  viewer = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: bearer(owner.accessToken),
  });
  tenantId = meResponseSchema.parse(me.json()).tenant.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function list(query: string, as = owner) {
  return app.inject({
    method: 'GET',
    url: `/audit-logs?${query}`,
    headers: bearer(as.accessToken),
  });
}

async function everyPage(query: string, limit: number): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let cursor: string | null = null;
  do {
    const page = auditPageSchema.parse(
      (await list(`${query}&limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`)).json(),
    );
    entries.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

describe('audit log', () => {
  it('records the workspace creation and every sign-in, newest first', async () => {
    const { items } = auditPageSchema.parse((await list('limit=50')).json());
    expect(items.map((entry) => [entry.action, entry.actor?.fullName])).toEqual([
      ['auth.signed_in', 'Nasrin Akter'],
      ['workspace.created', 'Farhana Rahman'],
    ]);
    expect(items[1]?.changes).toEqual({
      name: { from: null, to: 'Rahman Garments Ltd.' },
      slug: { from: null, to: 'rahman-garments' },
    });
  });

  it('pages through rows that share a millisecond without skipping any', async () => {
    // একই মিলিসেকেন্ডে পাঁচটা রো, মাইক্রোসেকেন্ডে আলাদা — Date-এর cursor এখানে রো হারাত।
    // ::text::timestamptz: শুধু ::timestamptz লিখলে postgres.js মানটা Date বানিয়ে পাঠাত, মাইক্রোসেকেন্ড
    // insert-এর সময়েই হারাত, আর টেস্টটা কিছুই যাচাই করত না (প্রথমবার ঠিক এটাই হয়েছিল)
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    for (const micro of ['100', '200', '300', '400', '500']) {
      await superuser`
        INSERT INTO audit_logs (id, tenant_id, action, entity_type, entity_id, created_at)
        VALUES (gen_random_uuid(), ${tenantId}, 'branch.updated', 'branch', gen_random_uuid(),
                ${`2026-09-23 10:15:30.123${micro}+00`}::text::timestamptz)`;
    }
    await superuser.end();

    const all = await everyPage('entityType=branch', 2);
    expect(all).toHaveLength(5);
    expect(new Set(all.map((entry) => entry.id)).size).toBe(5);
  });

  it('filters one entity type', async () => {
    const all = await everyPage('entityType=workspace', 10);
    expect(all.map((entry) => entry.action)).toEqual(['workspace.created']);
  });

  it('is only for members with core.audit.read', async () => {
    const res = await list('limit=10', viewer);
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).params).toEqual({ permissions: 'core.audit.read' });
  });
});

describe('preferences', () => {
  function patch(payload: object) {
    return app.inject({
      method: 'PATCH',
      url: '/me/preferences',
      headers: bearer(viewer.accessToken),
      payload,
    });
  }

  it('saves language and theme separately, and returns them with /auth/me', async () => {
    expect(preferencesSchema.parse((await patch({ language: 'bn' })).json())).toEqual({
      language: 'bn',
      theme: 'system',
    });
    // শুধু থিম পাঠালে ভাষা অক্ষত থাকে
    expect(preferencesSchema.parse((await patch({ theme: 'dark' })).json())).toEqual({
      language: 'bn',
      theme: 'dark',
    });
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(viewer.accessToken),
    });
    expect(meResponseSchema.parse(me.json()).preferences).toEqual({
      language: 'bn',
      theme: 'dark',
    });
  });

  it('refuses a language the app does not have', async () => {
    const res = await patch({ language: 'fr' });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ language: ['invalid_value'] });
  });
});
```

- **প্রথম সংস্করণ কিছু যাচাই করছিল না।** superuser-এর insert-এ লেখা ছিল `${…}::timestamptz` — খালি postgres.js সেই
  মানকে `Date` হয়ে পাঠায়, তাই পাঁচটা রো-ই `.123000` পেয়েছিল, মাইক্রোসেকেন্ড insert-এর সময়েই হারিয়েছিল। ফল:
  API-র cursor `Date` করে দিলেও টেস্ট পাস। পাতাগুলো ফাইলে লিখে দেখা গেল রো আসছে id-ক্রমে (সময় সবার সমান)।
  `::text::timestamptz` দেওয়ার পরে: `Date`-cursor → ২টা রো (fail), টেক্সট-cursor → ৫টা (পাস)।
- প্রথম টেস্টে "নতুন আগে": Nasrin-এর লগইন (পরে ঘটেছে) Farhana-র workspace তৈরির আগে। `workspace.created`-এর
  `changes`-এ `from: null` — আগে কিছু ছিল না।
- পছন্দের টেস্ট এখানে (আলাদা ফাইল না): দুটো ছোট টেস্টের জন্য আলাদা Postgres container তোলার মানে নেই।
- `language: 'fr'` → `invalid_value` — চুক্তির `z.enum` আর `contractErrorMap`-এর সাধারণ code।

### tenant-leak

**ফাইল: `apps/api/src/common/tenant/rls-coverage.tenant-leak.int.spec.ts`** (নতুন)

```ts
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPostgres, type TestPostgres } from '../../testing/containers.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  await pg.container.stop();
});

// build-plan §৬-এর ঝুঁকি "নতুন টেবিলে RLS ভুলে যাওয়া"-র পাহারা: tenant_id কলাম আছে এমন প্রতিটা টেবিলে
// ENABLE + FORCE RLS আর অন্তত একটা policy। নতুন টেবিলের migration-এ RLS লিখতে ভুলে গেলে এই টেস্ট
// টেবিলের নাম ধরে fail করে — leak হওয়ার আগে, PR-এই
describe('row-level security coverage', () => {
  it('protects every table that has a tenant_id column', async () => {
    const sql = postgres(pg.superuserUrl, { max: 1 });
    const rows = await sql<
      { table: string; enabled: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS table,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r'
      ORDER BY c.relname`;
    await sql.end();

    expect(rows.length).toBeGreaterThanOrEqual(10);
    const unprotected = rows
      .filter((row) => !row.enabled || !row.forced || row.policies === 0)
      .map((row) => row.table);
    expect(unprotected).toEqual([]);
  });
});
```

- build-plan §৬-এর ঝুঁকির তালিকায় "নতুন টেবিলে RLS ভুলে যাওয়া" — প্রশমন হিসেবে লেখা ছিল "migration লিন্ট"। এটাই
  সেটা, আর লিন্টের চেয়ে ভালো: migration-এর SQL পড়ে না, আসল DB-র অবস্থা দেখে (সব migration চালানোর পরে)।
- `pg_attribute`-এ `tenant_id` নামের কলাম — নিয়মটা নামের উপর দাঁড়ানো। `refresh_tokens.active_tenant_id` ইচ্ছা করে
  অন্য নামে (ধাপ ৩), তাই এই পরীক্ষায় পড়ে না।
- `>= 10` — এখন ঠিক ১০টা টেবিল; query ভুল হয়ে শূন্য টেবিল ফেরত দিলে `[]` দেখে টেস্ট মিথ্যা পাস করত, এই লাইন সেটা ঠেকায়।

**ফাইল: `apps/api/src/settings/core-platform.tenant-leak.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  branchListSchema,
  branchSchema,
  meResponseSchema,
  settingsSchema,
  uploadTicketSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// ধাপ ৬-এর প্রতিটা নতুন endpoint-এ: টেন্যান্ট A-র টোকেন নিয়ে B-র id চাওয়া। উত্তর সবসময় 404 —
// 403 না, কারণ 403 মানে "আছে, কিন্তু তোমার না", সেটাও একটা ফাঁস
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let tenantA: SignedIn;
let tenantB: SignedIn;
let branchOfB: string;
let fileOfB: string;
let tenantBId: string;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  // storage container লাগে না: নিচের কোনো request ফাইল পর্যন্ত পৌঁছায় না (সই করা স্থানীয় হিসাব)
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });

  const asB = bearer(tenantB.accessToken);
  const branch = await app.inject({
    method: 'POST',
    url: '/branches',
    headers: asB,
    payload: { code: 'DEPOT', name: 'Tejgaon depot', phone: '', address: '' },
  });
  branchOfB = branchSchema.parse(branch.json()).id;
  const upload = await app.inject({
    method: 'POST',
    url: '/attachments',
    headers: asB,
    payload: {
      purpose: 'company_logo',
      fileName: 'k.png',
      contentType: 'image/png',
      sizeBytes: 10,
    },
  });
  fileOfB = uploadTicketSchema.parse(upload.json()).attachment.id;
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: asB });
  tenantBId = meResponseSchema.parse(me.json()).tenant.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function asA(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(tenantA.accessToken),
    ...(payload && { payload }),
  });
}

describe('core platform isolation over HTTP', () => {
  it("never shows tenant B's branch to tenant A", async () => {
    const { items } = branchListSchema.parse((await asA('GET', '/branches')).json());
    expect(items.map((branch) => branch.code)).toEqual(['HO']);
    expect((await asA('GET', `/branches/${branchOfB}`)).statusCode).toBe(404);
  });

  it("cannot edit, archive or restore tenant B's branch", async () => {
    const edit = { code: 'DEPOT', name: 'Taken over', phone: '', address: '', version: 1 };
    expect((await asA('PUT', `/branches/${branchOfB}`, edit)).statusCode).toBe(404);
    expect((await asA('POST', `/branches/${branchOfB}/archive`, { version: 1 })).statusCode).toBe(
      404,
    );
    expect((await asA('POST', `/branches/${branchOfB}/restore`, { version: 1 })).statusCode).toBe(
      404,
    );
    const stillThere = await app.inject({
      method: 'GET',
      url: `/branches/${branchOfB}`,
      headers: bearer(tenantB.accessToken),
    });
    expect(branchSchema.parse(stillThere.json())).toMatchObject({
      name: 'Tejgaon depot',
      version: 1,
    });
  });

  it("cannot touch tenant B's files or use them as a logo", async () => {
    expect((await asA('POST', `/attachments/${fileOfB}/complete`)).statusCode).toBe(404);
    expect((await asA('GET', `/attachments/${fileOfB}/download`)).statusCode).toBe(404);
    expect((await asA('PUT', '/settings/logo', { attachmentId: fileOfB })).statusCode).toBe(404);
  });

  it('reads only its own settings and audit log', async () => {
    const settings = settingsSchema.parse((await asA('GET', '/settings')).json());
    expect(settings.companyName).toBe('Rahman Garments Ltd.');
    const { items } = auditPageSchema.parse((await asA('GET', '/audit-logs?limit=100')).json());
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.some((entry) => entry.entityId === tenantBId || entry.entityId === branchOfB),
    ).toBe(false);
  });
});
```

- ফাইলের নাম `*.tenant-leak.int.spec.ts` — ধাপ ২-এর নিয়মে `pnpm test:tenant-leak` এটাকে ধরে, সাধারণ integration না।
- প্রতিটা লেখার endpoint-এ অন্য টেন্যান্টের id → 404, আর শেষে B-র টোকেনে দেখা যে ব্রাঞ্চটা অক্ষত (`version: 1`)।
  শুধু status দেখলে "404 দিয়েছে কিন্তু বদলে দিয়েছে" ধরা পড়ত না।
- storage container লাগে না — `createUpload`-এর সই স্থানীয় হিসাব (নেটওয়ার্ক না), আর A-র প্রতিটা request storage-এ
  পৌঁছানোর আগেই 404।

---

## ৬.৬ — `packages/i18n`: লেখা আর দুটো formatter

### ইংরেজি

**ফাইল: `packages/i18n/src/locales/en.ts`** (আপডেট)

`common`, `shell` আর `nav` পুরো (নতুন ঘর সহ):

```ts
  common: {
    signOut: 'Sign out',
    language: 'Language',
    optional: '(optional)',
    retry: 'Retry',
    save: 'Save changes',
    saving: 'Saving…',
    cancel: 'Cancel',
    close: 'Close',
    reload: 'Reload',
    loadingMore: 'Loading more…',
  },
```

```ts
  shell: {
    mainNav: 'Main',
    workspaces: 'Workspaces',
    switchWorkspace: 'Switch workspace',
    switchFailed: "Couldn't switch workspace. Try again.",
    switched: 'Switched to {{name}}',
    account: 'Account',
    theme: 'Theme',
    themes: {
      system: 'Match device',
      light: 'Light',
      dark: 'Dark',
    },
    preferenceNotSaved: "Couldn't save this to your account. It applies on this device for now.",
  },
```

```ts
  nav: {
    overview: 'Overview',
    kitchenSink: 'Kitchen sink',
    workspace: 'Workspace',
    settings: 'Settings',
    numbering: 'Numbering',
    branches: 'Branches',
    auditLog: 'Audit log',
  },
```

`dashboard`-এর পরে, `errors`-এর আগে চারটা নতুন অংশ:

```ts
  settings: {
    title: 'Settings',
    description: 'Company details and regional settings for the whole workspace',
    companyTitle: 'Company profile',
    companySubtitle: 'Printed on invoices, Mushak 6.3 and reports',
    companyName: 'Company name',
    legalName: 'Legal name',
    legalNameHint: 'As registered with RJSC, if different from the company name',
    bin: 'BIN',
    binHint: '13-digit VAT registration number from NBR',
    phone: 'Phone',
    email: 'Email',
    address: 'Address',
    regionalTitle: 'Regional',
    regionalSubtitle: 'How money, dates and periods work in this workspace',
    baseCurrency: 'Base currency',
    baseCurrencyHint: 'Your books are kept in this currency.',
    fiscalYearStart: 'Fiscal year starts in',
    fiscalYearHint: 'July to June is the standard in Bangladesh.',
    timezone: 'Time zone',
    logoTitle: 'Logo',
    logoSubtitle: 'PNG, JPG or WebP, up to 2 MB. Printed on invoices and other documents.',
    logoAlt: '{{name}} logo',
    noLogo: 'No logo yet',
    uploadLogo: 'Upload logo',
    replaceLogo: 'Replace',
    removeLogo: 'Remove',
    uploading: 'Uploading…',
    logoSaved: 'Logo updated',
    logoRemoved: 'Logo removed',
    saved: 'Settings saved',
    readOnly:
      'You can view these settings. Ask a workspace owner for the core.settings.manage permission to change them.',
    loadFailed: "Couldn't load the settings. Refresh the page to try again.",
  },
```

```ts
  numbering: {
    title: 'Numbering',
    description: 'How document numbers are built. A change applies from the next document.',
    columns: {
      document: 'Document',
      format: 'Format',
      next: 'Next number',
    },
    documents: {
      sales: { invoice: 'Sales invoice', order: 'Sales order' },
      purchase: { order: 'Purchase order', bill: 'Supplier bill' },
      inventory: { receipt: 'Goods receipt (GRN)' },
      accounting: { journal: 'Journal voucher' },
    },
    yearStyles: {
      none: 'No year',
      calendar: 'Calendar year',
      fiscal: 'Fiscal year',
    },
    editTitle: 'Edit {{document}} numbering',
    prefix: 'Prefix',
    prefixHint: 'Up to 8 capital letters or digits, like INV',
    yearStyle: 'Year in the number',
    yearStyleHint: 'Numbering restarts at 1 when the year changes.',
    padding: 'Digits',
    preview: 'Example',
    saved: '{{document}} numbering saved',
    loadFailed: "Couldn't load the numbering formats. Refresh the page to try again.",
  },
```

```ts
  branches: {
    title: 'Branches',
    description: 'Offices, factories, depots and shops of this workspace',
    add: 'Add branch',
    show: 'Show',
    statuses: {
      active: 'Active',
      archived: 'Archived',
    },
    columns: {
      branch: 'Branch',
      phone: 'Phone',
      status: 'Status',
    },
    emptyArchivedTitle: 'No archived branches',
    emptyArchivedBody:
      'Archive a branch you no longer use, like a closed depot. Its old invoices and stock records stay intact.',
    newTitle: 'Add branch',
    editTitle: 'Edit {{code}}',
    code: 'Code',
    codeHint: '2–10 capital letters or digits, like GZP',
    name: 'Name',
    phone: 'Phone',
    address: 'Address',
    archive: 'Archive',
    restore: 'Restore',
    created: '{{name}} added',
    updated: 'Changes to {{name}} saved',
    archivedToast: '{{name}} archived',
    restoredToast: '{{name}} restored',
    readOnly:
      'Ask a workspace owner for the core.branch.manage permission to add or change branches.',
    loadFailed: "Couldn't load the branches. Refresh the page to try again.",
  },
```

```ts
  audit: {
    title: 'Audit log',
    description: 'Who changed what in this workspace, and when',
    show: 'Show',
    everything: 'Everything',
    entityTypes: {
      workspace: 'Workspace and settings',
      user: 'Sign-ins',
      branch: 'Branches',
      number_series: 'Numbering',
    },
    columns: {
      when: 'When',
      who: 'Who',
      what: 'What happened',
      changes: 'Changes',
    },
    system: 'System',
    noChanges: 'No field changed',
    emptyTitle: 'Nothing here yet',
    emptyBody: 'Changes to settings, branches and numbering show up here, with who made them.',
    actions: {
      workspace: { created: 'Created the workspace' },
      auth: { signed_in: 'Signed in', switched_in: 'Switched into this workspace' },
      settings: { updated: 'Changed the settings', logo_changed: 'Changed the logo' },
      branch: {
        created: 'Added a branch',
        updated: 'Edited a branch',
        archived: 'Archived a branch',
        restored: 'Restored a branch',
      },
      number_series: { updated: 'Changed a numbering format' },
    },
    // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
    fields: {
      name: 'Name',
      slug: 'Workspace address',
      companyName: 'Company name',
      legalName: 'Legal name',
      bin: 'BIN',
      phone: 'Phone',
      email: 'Email',
      address: 'Address',
      baseCurrency: 'Base currency',
      fiscalYearStartMonth: 'Fiscal year start',
      timezone: 'Time zone',
      logo: 'Logo',
      code: 'Code',
      prefix: 'Prefix',
      yearStyle: 'Year',
      padding: 'Digits',
    },
    loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
  },
```

`errors`-এ, `slug_taken`-এর পরে:

```ts
    bin_format: 'Enter the 13-digit BIN, like 000123456-0101.',
    timezone_invalid: 'Pick a time zone from the list.',
    branch_code_format: 'Use 2–10 capital letters or digits, like GZP.',
    branch_code_taken: 'Another branch already uses this code. Pick a different one.',
    branch_name_required: 'Enter the branch name.',
    branch_last_active: 'Keep at least one branch active. Add or restore another branch first.',
    prefix_format: 'Start with a letter and use up to 8 capital letters or digits, like INV.',
    file_type_not_allowed: 'Use a PNG, JPG or WebP image.',
    file_too_large: 'This file is too large. Pick one under 2 MB.',
```

আর `invalid_cursor`-এর পরে:

```ts
    version_conflict:
      'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
    upload_incomplete: "The file didn't finish uploading. Try again.",
    attachment_not_ready: 'Wait for the upload to finish, then try again.',
```

**কোন লাইন কেন:**

- `numbering.documents` আর `audit.actions` **nested** — `sales: { invoice: … }`, `'sales.invoice': …` না। i18next
  বিন্দুকে key-র বিভাজক ধরে; `t('numbering.documents.sales.invoice')` খোঁজে `documents → sales → invoice`। ফ্ল্যাট key-তে
  বিন্দু রাখলে অনুবাদ খুঁজেই পেত না। সুবিধাও আছে: `` t(`numbering.documents.${type}`) `` — `type` যেহেতু
  `DocumentType` union, TypeScript প্রতিটা সম্ভাব্য key যাচাই করে; নতুন ডকুমেন্ট টাইপের অনুবাদ ভুলে গেলে compile error।
- `audit.fields` — `changes`-এর ঘরের নাম (`legalName`) → মানুষের লেখা। `slug` → "Workspace address", শুধু "Address"
  না: আসল ব্রাউজারে দেখা গেল workspace-তৈরির ঘটনায় "Address: — → rahman-garments", আর পাশের সেটিংস-বদলে "Address"
  মানে অফিসের ঠিকানা — একই শব্দ, দুই মানে।
- `settings.readOnly` আর `branches.readOnly` কোন permission লাগবে তা নাম ধরে বলে — "অনুমতি নেই" বলে থেমে গেলে ইউজার
  মালিককে কী চাইবে জানত না।
- `errors.version_conflict` — কী হয়েছে আর কী করতে হবে (রিলোড, তারপর আবার বদল); "Error 409" না (CLAUDE.md → Copy)।

### বাংলা

**ফাইল: `packages/i18n/src/locales/bn.ts`** (আপডেট — একই জায়গাগুলো)

```ts
  common: {
    signOut: 'সাইন আউট',
    language: 'ভাষা',
    optional: '(ঐচ্ছিক)',
    retry: 'আবার চেষ্টা করুন',
    save: 'পরিবর্তন সেভ করুন',
    saving: 'সেভ হচ্ছে…',
    cancel: 'বাতিল',
    close: 'বন্ধ করুন',
    reload: 'রিলোড করুন',
    loadingMore: 'আরও আনা হচ্ছে…',
  },
```

```ts
  shell: {
    mainNav: 'প্রধান',
    workspaces: 'ওয়ার্কস্পেস',
    switchWorkspace: 'ওয়ার্কস্পেস বদলান',
    switchFailed: 'ওয়ার্কস্পেস বদলানো যায়নি। আবার চেষ্টা করুন।',
    switched: '{{name}}-এ চলে এসেছেন',
    account: 'অ্যাকাউন্ট',
    theme: 'থিম',
    themes: {
      system: 'ডিভাইসের মতো',
      light: 'লাইট',
      dark: 'ডার্ক',
    },
    preferenceNotSaved: 'আপনার অ্যাকাউন্টে সেভ করা যায়নি। আপাতত শুধু এই ডিভাইসে থাকবে।',
  },
```

```ts
  nav: {
    overview: 'সারসংক্ষেপ',
    kitchenSink: 'কিচেন সিঙ্ক',
    workspace: 'ওয়ার্কস্পেস',
    settings: 'সেটিংস',
    numbering: 'নম্বরিং',
    branches: 'ব্রাঞ্চ',
    auditLog: 'অডিট লগ',
  },
```

```ts
  settings: {
    title: 'সেটিংস',
    description: 'পুরো ওয়ার্কস্পেসের কোম্পানির তথ্য আর আঞ্চলিক সেটিংস',
    companyTitle: 'কোম্পানির প্রোফাইল',
    companySubtitle: 'ইনভয়েস, মূসক ৬.৩ আর রিপোর্টে ছাপা হয়',
    companyName: 'কোম্পানির নাম',
    legalName: 'আইনি নাম',
    legalNameHint: 'RJSC-তে নিবন্ধিত নাম, যদি কোম্পানির নাম থেকে আলাদা হয়',
    bin: 'BIN',
    binHint: 'NBR-এর ১৩ অঙ্কের VAT নিবন্ধন নম্বর',
    phone: 'ফোন',
    email: 'ইমেইল',
    address: 'ঠিকানা',
    regionalTitle: 'আঞ্চলিক',
    regionalSubtitle: 'এই ওয়ার্কস্পেসে টাকা, তারিখ আর সময়কাল কীভাবে চলে',
    baseCurrency: 'মূল মুদ্রা',
    baseCurrencyHint: 'আপনার হিসাবের বই এই মুদ্রায় রাখা হয়।',
    fiscalYearStart: 'অর্থবছর শুরু হয়',
    fiscalYearHint: 'বাংলাদেশে জুলাই থেকে জুন প্রচলিত।',
    timezone: 'টাইমজোন',
    logoTitle: 'লোগো',
    logoSubtitle: 'PNG, JPG বা WebP, ২ MB পর্যন্ত। ইনভয়েস আর অন্যান্য ডকুমেন্টে ছাপা হয়।',
    logoAlt: '{{name}}-এর লোগো',
    noLogo: 'এখনো লোগো নেই',
    uploadLogo: 'লোগো আপলোড করুন',
    replaceLogo: 'বদলান',
    removeLogo: 'সরান',
    uploading: 'আপলোড হচ্ছে…',
    logoSaved: 'লোগো বদলানো হয়েছে',
    logoRemoved: 'লোগো সরানো হয়েছে',
    saved: 'সেটিংস সেভ হয়েছে',
    readOnly:
      'আপনি সেটিংস দেখতে পারবেন। বদলাতে ওয়ার্কস্পেস মালিকের কাছে core.settings.manage অনুমতি চান।',
    loadFailed: 'সেটিংস আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
  },
```

```ts
  numbering: {
    title: 'নম্বরিং',
    description: 'ডকুমেন্টের নম্বর কীভাবে তৈরি হবে। বদলালে পরের ডকুমেন্ট থেকে কার্যকর।',
    columns: {
      document: 'ডকুমেন্ট',
      format: 'ফরম্যাট',
      next: 'পরের নম্বর',
    },
    documents: {
      sales: { invoice: 'বিক্রয় ইনভয়েস', order: 'সেলস অর্ডার' },
      purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
      inventory: { receipt: 'মাল গ্রহণ (GRN)' },
      accounting: { journal: 'জার্নাল ভাউচার' },
    },
    yearStyles: {
      none: 'বছর ছাড়া',
      calendar: 'ক্যালেন্ডার বছর',
      fiscal: 'অর্থবছর',
    },
    editTitle: '{{document}}-এর নম্বরিং বদলান',
    prefix: 'প্রিফিক্স',
    prefixHint: '৮টা পর্যন্ত বড় হাতের ইংরেজি অক্ষর বা সংখ্যা, যেমন INV',
    yearStyle: 'নম্বরে বছর',
    yearStyleHint: 'বছর বদলালে নম্বর আবার ১ থেকে শুরু হয়।',
    padding: 'অঙ্ক',
    preview: 'উদাহরণ',
    saved: '{{document}}-এর নম্বরিং সেভ হয়েছে',
    loadFailed: 'নম্বরিং আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
  },
```

```ts
  branches: {
    title: 'ব্রাঞ্চ',
    description: 'এই ওয়ার্কস্পেসের অফিস, কারখানা, ডিপো আর দোকান',
    add: 'ব্রাঞ্চ যোগ করুন',
    show: 'দেখান',
    statuses: {
      active: 'চালু',
      archived: 'আর্কাইভ করা',
    },
    columns: {
      branch: 'ব্রাঞ্চ',
      phone: 'ফোন',
      status: 'অবস্থা',
    },
    emptyArchivedTitle: 'কোনো আর্কাইভ করা ব্রাঞ্চ নেই',
    emptyArchivedBody:
      'যে ব্রাঞ্চ আর ব্যবহার হয় না (যেমন বন্ধ ডিপো) সেটা আর্কাইভ করুন। তার পুরনো ইনভয়েস আর স্টকের রেকর্ড অক্ষত থাকে।',
    newTitle: 'ব্রাঞ্চ যোগ করুন',
    editTitle: '{{code}} বদলান',
    code: 'কোড',
    codeHint: '২–১০টা বড় হাতের ইংরেজি অক্ষর বা সংখ্যা, যেমন GZP',
    name: 'নাম',
    phone: 'ফোন',
    address: 'ঠিকানা',
    archive: 'আর্কাইভ করুন',
    restore: 'ফিরিয়ে আনুন',
    created: '{{name}} যোগ হয়েছে',
    updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
    archivedToast: '{{name}} আর্কাইভ হয়েছে',
    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
    readOnly: 'ব্রাঞ্চ যোগ বা বদল করতে ওয়ার্কস্পেস মালিকের কাছে core.branch.manage অনুমতি চান।',
    loadFailed: 'ব্রাঞ্চের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
  },
```

```ts
  audit: {
    title: 'অডিট লগ',
    description: 'এই ওয়ার্কস্পেসে কে কখন কী বদলেছে',
    show: 'দেখান',
    everything: 'সব',
    entityTypes: {
      workspace: 'ওয়ার্কস্পেস ও সেটিংস',
      user: 'সাইন ইন',
      branch: 'ব্রাঞ্চ',
      number_series: 'নম্বরিং',
    },
    columns: {
      when: 'কখন',
      who: 'কে',
      what: 'কী হয়েছে',
      changes: 'পরিবর্তন',
    },
    system: 'সিস্টেম',
    noChanges: 'কোনো ঘর বদলায়নি',
    emptyTitle: 'এখনো কিছু নেই',
    emptyBody: 'সেটিংস, ব্রাঞ্চ আর নম্বরিংয়ের পরিবর্তন এখানে দেখা যাবে, কে করেছেন সহ।',
    actions: {
      workspace: { created: 'ওয়ার্কস্পেস তৈরি করেছেন' },
      auth: { signed_in: 'সাইন ইন করেছেন', switched_in: 'এই ওয়ার্কস্পেসে এসেছেন' },
      settings: { updated: 'সেটিংস বদলেছেন', logo_changed: 'লোগো বদলেছেন' },
      branch: {
        created: 'ব্রাঞ্চ যোগ করেছেন',
        updated: 'ব্রাঞ্চ বদলেছেন',
        archived: 'ব্রাঞ্চ আর্কাইভ করেছেন',
        restored: 'ব্রাঞ্চ ফিরিয়ে এনেছেন',
      },
      number_series: { updated: 'নম্বরিং বদলেছেন' },
    },
    fields: {
      name: 'নাম',
      slug: 'ওয়ার্কস্পেসের ঠিকানা',
      companyName: 'কোম্পানির নাম',
      legalName: 'আইনি নাম',
      bin: 'BIN',
      phone: 'ফোন',
      email: 'ইমেইল',
      address: 'ঠিকানা',
      baseCurrency: 'মূল মুদ্রা',
      fiscalYearStartMonth: 'অর্থবছরের শুরু',
      timezone: 'টাইমজোন',
      logo: 'লোগো',
      code: 'কোড',
      prefix: 'প্রিফিক্স',
      yearStyle: 'বছর',
      padding: 'অঙ্ক',
    },
    loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
  },
```

```ts
    bin_format: '১৩ অঙ্কের BIN দিন, যেমন 000123456-0101।',
    timezone_invalid: 'তালিকা থেকে একটা টাইমজোন বাছুন।',
    branch_code_format: '২–১০টা বড় হাতের ইংরেজি অক্ষর বা সংখ্যা দিন, যেমন GZP।',
    branch_code_taken: 'এই কোড আরেকটা ব্রাঞ্চে আছে। অন্য কোড দিন।',
    branch_name_required: 'ব্রাঞ্চের নাম লিখুন।',
    branch_last_active:
      'অন্তত একটা ব্রাঞ্চ চালু রাখতে হবে। আগে আরেকটা ব্রাঞ্চ যোগ করুন বা ফিরিয়ে আনুন।',
    prefix_format:
      'ইংরেজি অক্ষর দিয়ে শুরু করে ৮টা পর্যন্ত বড় হাতের অক্ষর বা সংখ্যা দিন, যেমন INV।',
    file_type_not_allowed: 'PNG, JPG বা WebP ছবি দিন।',
    file_too_large: 'ফাইলটা খুব বড়। ২ MB-র ছোট একটা বাছুন।',
```

```ts
    version_conflict:
      'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
    upload_incomplete: 'ফাইলটা পুরো আপলোড হয়নি। আবার চেষ্টা করুন।',
    attachment_not_ready: 'আপলোড শেষ হওয়া পর্যন্ত অপেক্ষা করে আবার চেষ্টা করুন।',
```

- `bn: Messages` — `en`-এর কোনো key বাদ পড়লে compile error, আর বাড়তি key থাকলেও। `en.ts` আগে লেখার পরে `pnpm
  typecheck` ঠিক কোন কোন key বাকি তার তালিকা দেয়।
- BIN, RJSC, NBR, PO, GRN, PNG — ইংরেজিতেই (CLAUDE.md → Language: অফিসের প্রচলিত শব্দ)। "মূসক ৬.৩" বাংলায়, কারণ
  NBR-এর বাংলা ফর্মে সেটাই নাম।

### formatter

**ফাইল: `packages/i18n/src/format.ts`** (আপডেট — শেষে)

```ts
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

// audit log-এর "কখন": টেন্যান্টের টাইমজোনে, ব্রাউজারের না — ঢাকার অফিসের ঘটনা দুবাই থেকে দেখলেও
// ঢাকার সময় দেখায়, যাতে ফোনে "৪টার সময় কে বদলেছিল" কথাটা সবার কাছে একই মানে রাখে
function dateTimeFormat(language: Language, timeZone: string): Intl.DateTimeFormat {
  const key = `${language}:${timeZone}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(language === 'bn' ? 'bn-BD' : 'en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormats.set(key, format);
  }
  return format;
}

// "23 Sep 2026, 16:05" / "২৩ সেপ, ২০২৬, ১৬:০৫" — formatDate-এর একই ছাঁদ, পেছনে ২৪ ঘণ্টার সময়
export function formatDateTime(date: Date, language: Language, timeZone: string): string {
  const parts = dateTimeFormat(language, timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const day =
    language === 'bn' ? `${part('day')} ${part('month')},` : `${part('day')} ${part('month')}`;
  return `${day} ${part('year')}, ${part('hour')}:${part('minute')}`;
}

const MONTH_NAME = {
  en: new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }),
  bn: new Intl.DateTimeFormat('bn-BD', { month: 'long', timeZone: 'UTC' }),
} satisfies Record<Language, Intl.DateTimeFormat>;

// ১–১২ → "July" / "জুলাই" (অর্থবছরের শুরু বাছার তালিকা)। UTC-তে: ১ তারিখ মধ্যরাত স্থানীয় সময়ে
// আগের মাসে পড়ে যেতে পারত (UTC-র পশ্চিমে)
export function formatMonthName(month: number, language: Language): string {
  return MONTH_NAME[language].format(Date.UTC(2026, month - 1, 1));
}
```

- `timeZone` প্যারামিটার বাধ্যতামূলক — ডিফল্ট দিলে (ব্রাউজারের টাইমজোন) কেউ একদিন ভুলে যেত, আর দুবাইয়ে বসা
  মালিক ঢাকার অফিসের ঘটনা দুই ঘণ্টা আগে-পিছে দেখত।
- `hourCycle: 'h23'` — `hour12: false` না: কিছু engine `hour12: false`-এ মধ্যরাতকে "24:05" লেখে; `h23` সবসময় 00–23।
- cache-এর key-তে টাইমজোনও — এক ট্যাবে দুই workspace (switcher) দুই টাইমজোনে হতে পারে।
- `formatMonthName` — `Date.UTC(2026, month - 1, 1)` আর `timeZone: 'UTC'`: বছরটা কিছু না, শুধু মাস দরকার; দুই দিকেই
  UTC, তাই কোনো মেশিনে আগের মাসে পড়ে না।

**ফাইল: `packages/i18n/src/use-locale.ts`** (আপডেট)

import-এ `formatDateTime` আর `formatMonthName`, আর `format`-এর object-এ `month`-এর পরে:

```ts
      dateTime: (date: Date, timeZone: string) => formatDateTime(date, language, timeZone),
      monthName: (month: number) => formatMonthName(month, language),
```

**ফাইল: `packages/i18n/src/index.ts`** (আপডেট — format-এর export-এ)

```ts
  formatDate,
  formatDateTime,
  formatMoney,
  formatMonth,
  formatMonthName,
  formatNumber,
```

**ফাইল: `packages/i18n/src/i18n.ts`** (আপডেট)

প্রথম লাইনে:

```ts
import type { LanguageCode } from '@omnivo/contracts';
```

আর `LANGUAGES`:

```ts
// satisfies: সার্ভারে সেভ হওয়া ভাষা (contracts-এর LANGUAGE_CODES) আর এই তালিকা একই — চুক্তিতে নেই এমন
// ভাষা এখানে যোগ করলে compile error। import type: runtime-এ contracts লাগে না
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'bn', label: 'বাংলা' },
] as const satisfies readonly { code: LanguageCode; label: string }[];
```

- `import type` — i18n-এর package.json-এ contracts শুধু devDependency (ধাপ ৫), আর runtime-এ কিছু লাগে না; টাইপ
  compile-এর পরে মুছে যায়। `browser-packages-not-to-server` নিয়মও ভাঙে না (contracts সার্ভারের প্যাকেজ না)।
- `as const satisfies …` — `as const` literal টাইপ রাখে (`'en' | 'bn'`), `satisfies` যাচাই করে। শুধু annotation দিলে
  literal হারাত আর `Language` টাইপ হয়ে যেত সাধারণ `LanguageCode`।

**ফাইল: `packages/i18n/src/format.spec.ts`** (আপডেট — import-এ দুটো নাম, আর শেষে)

```ts
describe('formatDateTime', () => {
  it("shows the moment in the workspace's time zone, not the browser's", () => {
    const moment = new Date('2026-09-23T10:05:00Z');
    expect(formatDateTime(moment, 'en', 'Asia/Dhaka')).toBe('23 Sep 2026, 16:05');
    expect(formatDateTime(moment, 'en', 'UTC')).toBe('23 Sep 2026, 10:05');
    expect(formatDateTime(moment, 'bn', 'Asia/Dhaka')).toBe('২৩ সেপ, ২০২৬, ১৬:০৫');
  });
});

describe('formatMonthName', () => {
  it('names the month in both languages', () => {
    expect(formatMonthName(7, 'en')).toBe('July');
    expect(formatMonthName(7, 'bn')).toBe('জুলাই');
  });
});
```

---

## ৬.৭ — `packages/ui`: Dialog, Select, TextArea আর overlay token

CLAUDE.md-এর নিয়ম: design system-এ যা নেই তা বানানোর আগে CLAUDE.md-এ যোগ করতে হয়। এই ধাপে তিনটা component আর একটা
token আসছে — CLAUDE.md-এর লেখা ৬.১২-এ। আগে সেটা লিখে তারপর কোড।

### overlay token

**ফাইল: `packages/ui/src/styles.css`** (আপডেট — তিন জায়গায় একই token, আর Tailwind-এ map)

light `:root`-এর শেষে (`--focus-ring`-এর পরে):

```css
  /* dialog-এর পেছনের পর্দা: ink-এর রঙে ৪৫% — পেজ দেখা যায় কিন্তু মনোযোগ dialog-এ */
  --overlay: rgb(15 23 40 / 0.45);
```

dark-এর দুই জায়গায় (`@media (prefers-color-scheme: dark)`-এর ভেতরে আর `:root[data-theme='dark']`-এ), `--focus-ring`-এর পরে:

```css
  --overlay: rgb(0 0 0 / 0.6);
```

`@theme inline`-এ `--color-crit-bg`-এর পরে:

```css
  --color-overlay: var(--overlay);
```

- আলাদা token, `bg-ink/40` না: dark থিমে `ink` প্রায় সাদা — পর্দা সাদাটে হয়ে যেত। dark-এ কালো ৬০%, কারণ কালো পটভূমির
  উপর ৪৫% কালো চোখেই পড়ে না।
- blur নেই — CLAUDE.md: glassmorphism নিষেধ।

### Dialog

**ফাইল: `packages/ui/src/components/dialog.tsx`** (নতুন)

```tsx
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { IconButton } from './button.js';

// Radix: খোলার সময় focus ভেতরে যায় আর Tab ভেতরেই ঘোরে, Esc-এ বন্ধ, বন্ধ হলে focus আবার trigger-এ,
// পেছনের পেজ scroll হয় না আর স্ক্রিন রিডারের কাছে লুকানো — এগুলো হাতে লিখলে প্রতিটাই আলাদা bug
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface DialogContentProps {
  title: string;
  description?: string | undefined;
  children: ReactNode;
  // নিচের বাটনের সারি (বাতিল + একটা primary)
  footer?: ReactNode;
  className?: string | undefined;
}

// CLAUDE.md → Dialog: surface, ১px line, ১৪px কোণ, shadow-lg, সর্বোচ্চ ৫২০px; শিরোনাম কার্ডের মতো
// ১৫px/600। ফোনে দুই পাশে ১৬px ফাঁক রেখে পুরো চওড়া, লম্বা হলে ভেতরে scroll — পেজ আড়াআড়ি নড়ে না
export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: DialogContentProps) {
  const { t } = useLocale();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        // description না থাকলে Radix console-এ সতর্ক করে; undefined দিলে বোঝে ইচ্ছাকৃত
        {...(description === undefined && { 'aria-describedby': undefined })}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-card border border-line bg-surface p-[18px] shadow-lg outline-none sm:p-6',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-h3">{title}</DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="text-label text-ink-3">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton icon={Cancel01Icon} label={t('common.close')} className="-m-2 shrink-0" />
          </DialogPrimitive.Close>
        </header>
        {children}
        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            {footer}
          </footer>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
```

**কোন লাইন কেন:**

- Radix-এর Dialog — `radix-ui` প্যাকেজ আগে থেকেই আছে (DropdownMenu, Popover), নতুন dependency না।
- `title` prop বাধ্যতামূলক আর ভেতরে `DialogPrimitive.Title` — স্ক্রিন রিডার dialog খোলার সময় এটাই পড়ে; Radix শিরোনাম
  না পেলে console-এ error দেয়। prop-এ রাখায় ভুলে যাওয়ার উপায় নেই।
- `aria-describedby: undefined` শুধু description না থাকলে — Radix-এর নিয়ম: "ইচ্ছা করেই বিবরণ নেই" বোঝাতে undefined।
- `max-h-[calc(100dvh-32px)] overflow-y-auto` — ফোনে কীবোর্ড খুললে বা ফর্ম লম্বা হলে dialog-এর ভেতরে scroll; পেজ নড়ে না।
  `dvh`, `vh` না: মোবাইল ব্রাউজারের ঠিকানা-বার ওঠানামায় `vh` মিথ্যা বলে।
- `w-[calc(100%-32px)]` — ৩৯০px-এ দুই পাশে ১৬px (CLAUDE.md → Page gutters)।
- কোনো animation নেই — CLAUDE.md: scale/bounce নিষেধ; আর reduced-motion আলাদা করে সামলানোর কিছু থাকে না।
- বন্ধের বোতাম `IconButton` — `label` বাধ্যতামূলক (অনুবাদ করা "Close")।

### Select আর TextArea

**ফাইল: `packages/ui/src/components/field.tsx`** (আপডেট)

প্রথম লাইনের import-এ `ArrowDown01Icon`:

```ts
import { Alert02Icon, ArrowDown01Icon } from '@hugeicons/core-free-icons';
```

ফাইলের শেষে:

```tsx
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends Omit<ComponentProps<'select'>, 'className' | 'id'> {
  label: string;
  id?: string;
  options: readonly SelectOption[];
  icon?: IconSvgElement | undefined;
  optional?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}

// আসল <select>, Radix-এর বানানো না: ফোনে OS-এর নিজের চাকা/তালিকা খোলে (বড়, আঙুলে সহজ), কীবোর্ড আর
// স্ক্রিন রিডার বিনা খরচে, আর bundle-এ এক লাইনও JS যোগ হয় না। দেখতে Input-এর মতোই বাক্স।
// register('x', { valueAsNumber: true }) সরাসরি spread করা যায় — সংখ্যার ঘরে string আসে না
export function SelectField({
  id,
  label,
  options,
  icon,
  optional,
  hint,
  error,
  ...select
}: SelectFieldProps) {
  const autoId = useId();
  const fieldId = id ?? select.name ?? autoId;
  return (
    <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
      <div className={controlBoxClass(Boolean(error))}>
        {icon && (
          <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        )}
        <select
          id={fieldId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          // appearance-none: ব্রাউজারের নিজের তীর মুছে আমাদের আইকন; bg-transparent: dark mode-এ
          // Windows-এর সাদা বাক্স না
          className="min-w-0 flex-1 appearance-none bg-transparent py-2.5 text-body outline-none"
          {...select}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={16}
          strokeWidth={1.5}
          // pointer-events-none: তীরে ক্লিক করলেও নিচের select খোলে
          className="pointer-events-none shrink-0 text-ink-3"
        />
      </div>
    </Field>
  );
}

export interface TextAreaFieldProps extends Omit<ComponentProps<'textarea'>, 'className' | 'id'> {
  label: string;
  id?: string;
  optional?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
}

// ঠিকানার মতো কয়েক লাইনের লেখা — Input-এর একই বাক্স, উচ্চতা ৩ লাইন, নিচে টেনে বড় করা যায়
export function TextAreaField({
  id,
  label,
  optional,
  hint,
  error,
  ...textarea
}: TextAreaFieldProps) {
  const autoId = useId();
  const fieldId = id ?? textarea.name ?? autoId;
  return (
    <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
      <div className={cn(controlBoxClass(Boolean(error)), 'items-stretch')}>
        <textarea
          id={fieldId}
          rows={3}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          className="min-w-0 flex-1 resize-y bg-transparent py-2.5 text-body outline-none placeholder:text-ink-3"
          {...textarea}
        />
      </div>
    </Field>
  );
}
```

**কোন লাইন কেন:**

- **native `<select>`, Radix Select না** — টাইমজোনের তালিকায় ~৪০০টা মান; ফোনে OS-এর নিজের তালিকা খোলে, টাইপ করে খোঁজা
  যায়, আর bundle-এ এক লাইনও JS যোগ হয় না। দেখতে হুবহু Input-এর বাক্স (`controlBoxClass`), তাই ডিজাইনে আলাদা লাগে না।
- `appearance-none` — ব্রাউজারের নিজের তীর মুছে HugeIcons-এর তীর (CLAUDE.md rule ৪)। তীরটা `pointer-events-none`:
  তাতে ক্লিক করলে নিচের select খোলে।
- `bg-transparent` — Windows-এ dark থিমে না দিলে select সাদা বাক্স দেখাত।
- `{...select}` শেষে — `register()`-এর `name`, `ref`, `onChange`, `onBlur` সরাসরি বসে; `valueAsNumber` register-এর
  option, তাই সংখ্যার ঘরেও (`fiscalYearStartMonth`) string আসে না।
- `TextAreaField` — `cn(controlBoxClass(...), 'items-stretch')`: Input-এর বাক্স `items-center`, কিন্তু textarea বাক্সের
  পুরো উচ্চতা নেয়। `cn()` (tailwind-merge) তাই `items-center`-কে সরিয়ে দেয় — string জোড়া দিলে দুটোই থাকত, আর কোনটা
  জিতবে তা CSS-এর ক্রমের উপর নির্ভর করত।
- `resize-y` — ঠিকানা লম্বা হলে ইউজার নিচে টেনে বড় করতে পারে; আড়াআড়ি না (layout ভাঙত)।

**ফাইল: `packages/ui/src/index.ts`** (আপডেট)

`DatePicker`-এর পরে:

```ts
export { Dialog, DialogClose, DialogContent, DialogTrigger } from './components/dialog.js';
```

field-এর export:

```ts
export {
  Field,
  Input,
  SelectField,
  TextAreaField,
  TextField,
  type InputProps,
  type SelectFieldProps,
  type SelectOption,
  type TextAreaFieldProps,
  type TextFieldProps,
} from './components/field.js';
```

---

## ৬.৮ — `apps/app`: স্ক্রিন

### থিম আর পছন্দ

**ফাইল: `apps/app/src/lib/theme.ts`** (নতুন)

```ts
import { THEMES, type Theme } from '@omnivo/contracts';

// index.html-এর inline script-ও এই key পড়ে — প্রথম রং আঁকার আগে, React লোড হওয়ারও আগে
const STORAGE_KEY = 'omnivo.theme';

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

// CLAUDE.md: data-theme OS-এর পছন্দকে দুই দিকেই হারায়; 'system' হলে attribute নেই, তখন
// prefers-color-scheme। localStorage-এ রাখা শুধু পরের বার প্রথম ঝলকের জন্য — আসল উৎস সার্ভার
export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // প্রাইভেট মোড: পরের বার প্রথম ঝলকে OS-এর থিম, তারপর সার্ভারেরটা — ক্ষতি নেই
  }
}

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return isTheme(value) ? value : 'system';
}
```

**ফাইল: `apps/app/index.html`** (আপডেট — `<title>`-এর পরে)

```html
    <!-- প্রথম রং আঁকার আগেই থিম: React লোড হতে কয়েকশো ms লাগে, ততক্ষণ dark বাছাই করা ইউজার সাদা পেজ
         দেখত। key আর মান src/lib/theme.ts-এর সাথে এক -->
    <script>
      try {
        var theme = localStorage.getItem('omnivo.theme');
        if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
      } catch (error) {}
    </script>
```

- inline script, module না: `<script type="module">` HTML parse শেষ হওয়ার পরে চলে — ততক্ষণে সাদা পেজ আঁকা হয়ে গেছে।
  সাধারণ script `<head>`-এ সাথে সাথে চলে।
- `var`, `try` — এই কোড TypeScript-ও না, build-ও হয় না; পুরনো ব্রাউজারেও চলে। প্রাইভেট মোডে `localStorage` throw করতে
  পারে — তখন OS-এর থিম, ক্ষতি নেই।
- শুধু `light`/`dark` মানলে বসে; অন্য কিছু (ভাঙা মান) উপেক্ষা।
- ধাপ ২৫-এ Content-Security-Policy আসলে এই script-এর hash সেখানে লিখতে হবে (শেষের নোট)।

**ফাইল: `apps/app/src/lib/preferences.ts`** (নতুন)

```ts
import { type Preferences, routes, type UpdatePreferencesInput } from '@omnivo/contracts';
import { i18n, setLanguage } from '@omnivo/i18n';
import { toast } from '@omnivo/ui';

import { call } from './api';
import { sessionStore } from './session-store';
import { applyTheme } from './theme';

// লগইনের পরে: সার্ভারে সেভ করা পছন্দ এই ডিভাইসে। language null = ইউজার কখনো বাছেনি — তখন লগইন পেজে
// যে ভাষা চলছিল সেটাই থাকে, জোর করে ইংরেজিতে ফেরানো হয় না
export async function applyPreferences(preferences: Preferences): Promise<void> {
  applyTheme(preferences.theme);
  if (preferences.language !== null) await setLanguage(preferences.language);
}

// আগে এই ডিভাইসে (সাথে সাথে দেখা যায়), তারপর সার্ভারে। সার্ভার ব্যর্থ হলে ডিভাইসের বদল থাকে, শুধু
// জানানো হয় যে অন্য ডিভাইসে যাবে না — ভাষা বদলানোর মতো কাজ নেটওয়ার্কের জন্য আটকে থাকে না
export async function savePreference(input: UpdatePreferencesInput): Promise<void> {
  if (input.theme !== undefined) applyTheme(input.theme);
  if (input.language !== undefined) await setLanguage(input.language);
  try {
    const preferences = await call(routes.me.updatePreferences, { body: input });
    const me = sessionStore.getState().me;
    if (me) sessionStore.getState().setMe({ ...me, preferences });
  } catch {
    // React-এর বাইরে, তাই hook-এর t() না, i18n instance-এর t — বর্তমান ভাষাতেই
    toast(i18n.t('shell.preferenceNotSaved'));
  }
}
```

- ক্রম: আগে এই ডিভাইসে, তারপর সার্ভারে — ভাষা বদল সাথে সাথে দেখা যায়, নেটওয়ার্কের জন্য অপেক্ষা না। সার্ভার ব্যর্থ হলে
  বদল ফেরত নেওয়া হয় না (ইউজার তো সেটাই চেয়েছে), শুধু জানানো হয় যে অন্য ডিভাইসে যাবে না।
- `i18n.t(...)`, hook-এর `t` না — এই ফাংশন React-এর বাইরে; `i18n` instance বর্তমান ভাষাতেই লেখে।
- `setMe({ ...me, preferences })` — user মেনুর থিম-টিক `me.preferences.theme` থেকে পড়ে; store না বদলালে টিক পুরনো থিমে থাকত।

**ফাইল: `apps/app/src/lib/queries.ts`** (নতুন)

```ts
import { routes } from '@omnivo/contracts';
import { queryOptions } from '@tanstack/react-query';

import { call } from './api';

// কয়েকটা পেজ একই settings চায় (টাইমজোন, অর্থবছর) — key আর আনার নিয়ম এক জায়গায়, তাই একবার আনা
// ডেটা সবাই ক্যাশ থেকে পায়, আর সেভের পরে এক জায়গায় হালনাগাদ করলেই সব পেজে নতুন মান
export function settingsQuery(tenantId: string) {
  return queryOptions({
    // tenantId key-তে: workspace বদলালে আগের কোম্পানির settings এই key-তে কখনো মেলে না
    queryKey: ['settings', tenantId],
    queryFn: () => call(routes.settings.get),
  });
}
```

**ফাইল: `apps/app/src/lib/session-store.ts`** (আপডেট — interface-এ আর store-এ `setMe`)

```ts
  // লগইনের পরে me-র অংশ বদলালে (কোম্পানির নাম, পছন্দ) — status না ছুঁয়ে
  setMe: (me: MeResponse) => void;
```

```ts
  setMe: (me) => {
    set({ me });
  },
```

- `signIn(me)` আবার ডাকা যেত, কিন্তু নামটা মিথ্যা হতো — লগইন হয়নি, শুধু তথ্য বদলেছে।

**ফাইল: `apps/app/src/lib/session.ts`** (আপডেট)

import-এ `import { applyPreferences } from './preferences';`, `startSession`-এ `queryClient.clear()`-এর পরে, আর নতুন
`refreshMe`:

```ts
  // signIn-এর আগে: প্রথম পেজটাই ইউজারের ভাষা আর থিমে আঁকা হয়, এক ঝলক ভুল ভাষায় না
  await applyPreferences(me.preferences);
  sessionStore.getState().signIn(me);
}

// কোম্পানির নাম বদলানোর পরে switcher আর সাইডবারে নতুন নাম
export async function refreshMe(): Promise<void> {
  sessionStore.getState().setMe(await call(routes.auth.me));
```

```ts
}
```

- `applyPreferences` **`signIn`-এর আগে** — `signIn` store-এ `signed-in` বসায়, আর router সাথে সাথে ড্যাশবোর্ড আঁকে। পরে
  দিলে এক ঝলক ইংরেজি, তারপর বাংলা।

### shell, router, kitchen sink

**ফাইল: `apps/app/src/routes/app-shell.tsx`** (আপডেট)

import:

```tsx
import {
  DashboardSquare01Icon,
  LayoutGridIcon,
  LeftToRightListNumberIcon,
  Logout01Icon,
  Settings02Icon,
  Store01Icon,
  UnfoldMoreIcon,
  UserCircleIcon,
  WorkHistoryIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { THEMES } from '@omnivo/contracts';
import { isLanguage, LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  AppShell as Shell,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Logo,
  NavGroup,
  NavItem,
  SidebarNav,
  toast,
} from '@omnivo/ui';
import { createLink, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { savePreference } from '../lib/preferences';
import { logout, switchTenant } from '../lib/session';
import { useSession } from '../lib/session-store';
import { isTheme } from '../lib/theme';
```

`UserMenuContent`:

```tsx
function UserMenuContent({ align }: { align: 'start' | 'end' }) {
  const { t, language } = useLocale();
  const theme = useSession((state) => state.me?.preferences.theme ?? 'system');
  return (
    <DropdownMenuContent align={align}>
      <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={language}
        onValueChange={(value) => {
          // Radix মান দেয় string হিসেবে — type guard দিয়ে Language-এ নামানো, cast না।
          // এই ডিভাইসে সাথে সাথে, আর অ্যাকাউন্টে সেভ — অন্য ফোন/ল্যাপটপে লগইন করলেও একই ভাষা
          if (isLanguage(value)) void savePreference({ language: value });
        }}
      >
        {LANGUAGES.map((option) => (
          // lang: স্ক্রিন রিডার "বাংলা" বাংলা উচ্চারণে পড়ে
          <DropdownMenuRadioItem key={option.code} value={option.code} lang={option.code}>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => {
          if (isTheme(value)) void savePreference({ theme: value });
        }}
      >
        {THEMES.map((option) => (
          <DropdownMenuRadioItem key={option} value={option}>
            {t(`shell.themes.${option}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        icon={Logout01Icon}
        onSelect={() => {
          void logout();
        }}
      >
        {t('common.signOut')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
```

`AppShell`-এ `me`-র পরে:

```ts
  // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
  const can = (permission: string) => me?.permissions.includes(permission) ?? false;
```

আর `nav`-এ প্রথম `NavGroup`-এর পরে:

```tsx
          <NavGroup label={t('nav.workspace')}>
            <NavLink to="/branches" icon={Store01Icon}>
              {t('nav.branches')}
            </NavLink>
            {can('core.settings.manage') && (
              <NavLink to="/numbering" icon={LeftToRightListNumberIcon}>
                {t('nav.numbering')}
              </NavLink>
            )}
            {can('core.audit.read') && (
              <NavLink to="/audit-log" icon={WorkHistoryIcon}>
                {t('nav.auditLog')}
              </NavLink>
            )}
            <NavLink to="/settings" icon={Settings02Icon}>
              {t('nav.settings')}
            </NavLink>
          </NavGroup>
```

- থিমের মান আসে `me.preferences.theme` থেকে (সার্ভারের সত্য), `data-theme` attribute থেকে না — মেনু আর সার্ভার একই কথা বলে।
- Branches আর Settings সবার জন্য (পড়া সবার); Numbering আর Audit log শুধু যার অনুমতি আছে — খুললেই 403 এমন লিংক না দেখানো।
- `THEMES.map` — contracts-এর তালিকা; `` t(`shell.themes.${option}`) `` টাইপ-চেকড (তিনটা key-ই আছে কি না)।

**ফাইল: `apps/app/src/router.tsx`** (আপডেট)

`dashboardRoute`-এর পরে:

```tsx
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('./routes/settings'), 'SettingsPage'),
});

const numberingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/numbering',
  component: lazyRouteComponent(() => import('./routes/numbering'), 'NumberingPage'),
});

const branchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/branches',
  component: lazyRouteComponent(() => import('./routes/branches'), 'BranchesPage'),
});

const auditLogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/audit-log',
  component: lazyRouteComponent(() => import('./routes/audit-log'), 'AuditLogPage'),
```

```ts
});
```

আর route tree:

```ts
  appRoute.addChildren([
    dashboardRoute,
    settingsRoute,
    numberingRoute,
    branchesRoute,
    auditLogRoute,
    ...devRoutes,
  ]),
```

- প্রতিটা lazy — আলাদা chunk। `branches` (Dialog + ফর্ম + DataTable) 66.8 KB gz, বাজেট ১০০; প্রথম লোড বেড়েছে ~৯ KB
  (নতুন চুক্তি আর অনুবাদ, যা শুরুতেই লাগে) — 165.2 KB।
- `/numbering` আর `/audit-log`-এ route-লেভেলে permission guard নেই: লিংক লুকানো, আর কেউ ঠিকানা টাইপ করে এলে পেজ
  নিজেই "অনুমতি লাগবে" বলে — API তো 403 দিতই।

**ফাইল: `apps/app/src/routes/kitchen-sink.tsx`** (আপডেট)

নিজের `type Theme`, `THEMES` আর `applyTheme()` মুছে ফেলুন; import-এ:

```ts
import type { Theme } from '@omnivo/contracts';
```

```ts
import { applyTheme, currentTheme } from '../lib/theme';
```

তালিকার নাম `THEME_OPTIONS` (contracts-এর `THEMES`-এর সাথে নাম মেলানো এড়াতে), আর state:

```ts
  // শুধু এই ডিভাইসে দেখার জন্য — অ্যাকাউন্টে সেভ হয় user মেনু থেকে (savePreference)
  const [theme, setTheme] = useState<Theme>(currentTheme);
```

- `useState(currentTheme)` — ফাংশন দিলে React একবারই ডাকে; kitchen sink খুললে এখন বর্তমান থিম দেখায়, আগের মতো সবসময়
  "System" না।

### সেটিংস পেজ

**ফাইল: `apps/app/src/routes/settings.tsx`** (নতুন)

```tsx
import {
  Building03Icon,
  Calendar03Icon,
  Call02Icon,
  Globe02Icon,
  IdentityCardIcon,
  Image01Icon,
  Mail01Icon,
  Money03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ATTACHMENT_RULES,
  contractErrorMap,
  createUploadInputSchema,
  CURRENCIES,
  type ErrorCode,
  isErrorCode,
  routes,
  type Settings,
  updateSettingsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { settingsQuery } from '../lib/queries';
import { refreshMe } from '../lib/session';
import { useSession } from '../lib/session-store';

// ফর্মে যা থাকে: parse-এর আগের মান (z.input) — ফাঁকা ঘর '' (null না, <input>-এ null বসানো যায় না)
type FormValues = z.input<typeof updateSettingsInputSchema>;

// version ফর্মের লুকানো মান: ফর্ম যে version দেখে খোলা হয়েছিল, সেভে সেটাই যায়। সেভের মুহূর্তে ক্যাশ
// থেকে সর্বশেষ version নিলে optimistic locking-এর মানেই থাকত না — ব্যাকগ্রাউন্ডে refetch হয়ে নতুন
// version এলে অন্যের বদল চুপচাপ মুছে যেত
function toForm(settings: Settings): FormValues {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
  };
}

const FIELD_NAMES = updateSettingsInputSchema.keyof().options;
const CURRENCY_OPTIONS = CURRENCIES.map((currency) => ({ value: currency, label: currency }));
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

// ব্রাউজারের জানা সব IANA টাইমজোন (~৪০০) — আলাদা তালিকা রাখতে হয় না। বর্তমান মান তালিকায় না থাকলে
// (যেমন "UTC" কিছু ব্রাউজারে নেই) সেটাও রাখা, নাহলে select চুপচাপ প্রথম মানে সরে যেত
function timeZoneOptions(current: string) {
  const zones = Intl.supportedValuesOf('timeZone');
  return (zones.includes(current) ? zones : [current, ...zones]).map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
  }));
}

function SettingsForm({ settings, canManage }: { settings: Settings; canManage: boolean }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateSettingsInputSchema, { error: contractErrorMap }),
    defaultValues: toForm(settings),
  });

  const monthOptions = useMemo(
    () => MONTHS.map((month) => ({ value: String(month), label: format.monthName(month) })),
    [format],
  );
  const zoneOptions = useMemo(() => timeZoneOptions(settings.timezone), [settings.timezone]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.settings.update, { body: values });
      queryClient.setQueryData(settingsQuery(tenantId).queryKey, saved);
      // নতুন version সহ ফর্ম নতুন করে — পরের সেভ এই version থেকে
      reset(toForm(saved));
      toast(t('settings.saved'));
      // কোম্পানির নাম বদলালে switcher-এও নতুন নাম
      await refreshMe();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // conflict-এর পরে: সার্ভারের সর্বশেষ মান এনে ফর্ম সেখান থেকে। staleTime 0 — ক্যাশের পুরনো মান না।
  // query(): TanStack v5.104-এ fetchQuery-র নতুন নাম (পুরনোটা deprecated)
  const reload = async () => {
    const fresh = await queryClient.query({ ...settingsQuery(tenantId), staleTime: 0 });
    reset(toForm(fresh));
  };

  const serverError = errors.root?.server?.message;

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5">
      {serverError && (
        <div className="grid gap-2">
          <FormAlert message={serverError} />
          {serverError === 'version_conflict' && (
            <div>
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                {t('common.reload')}
              </Button>
            </div>
          )}
        </div>
      )}
      {/* disabled fieldset: ভেতরের সব ঘর একসাথে শুধু-পড়া — প্রতিটা ইনপুটে আলাদা prop লাগে না */}
      <fieldset disabled={!canManage} className="grid min-w-0 gap-5">
        <Card>
          <CardHeader title={t('settings.companyTitle')} subtitle={t('settings.companySubtitle')} />
          <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
            <TextField
              label={t('settings.companyName')}
              icon={Building03Icon}
              autoComplete="organization"
              {...register('companyName')}
              error={errors.companyName?.message}
            />
            <TextField
              label={t('settings.legalName')}
              optional
              hint={t('settings.legalNameHint')}
              placeholder="Rahman Knit Garments Limited"
              {...register('legalName')}
              error={errors.legalName?.message}
            />
            <TextField
              label={t('settings.bin')}
              icon={IdentityCardIcon}
              optional
              inputMode="numeric"
              hint={t('settings.binHint')}
              placeholder="000123456-0101"
              {...register('bin')}
              error={errors.bin?.message}
            />
            <TextField
              label={t('settings.phone')}
              icon={Call02Icon}
              optional
              type="tel"
              placeholder="+880 1711-000000"
              {...register('phone')}
              error={errors.phone?.message}
            />
            <TextField
              label={t('settings.email')}
              icon={Mail01Icon}
              optional
              type="email"
              placeholder="accounts@rahmangarments.com"
              {...register('email')}
              error={errors.email?.message}
            />
            <div className="sm:col-span-2">
              <TextAreaField
                label={t('settings.address')}
                optional
                placeholder="Plot 12, BSCIC Industrial Area, Konabari, Gazipur 1751"
                {...register('address')}
                error={errors.address?.message}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.regionalTitle')}
            subtitle={t('settings.regionalSubtitle')}
          />
          <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
            <SelectField
              label={t('settings.baseCurrency')}
              icon={Money03Icon}
              hint={t('settings.baseCurrencyHint')}
              options={CURRENCY_OPTIONS}
              {...register('baseCurrency')}
              error={errors.baseCurrency?.message}
            />
            <SelectField
              label={t('settings.fiscalYearStart')}
              icon={Calendar03Icon}
              hint={t('settings.fiscalYearHint')}
              options={monthOptions}
              // select-এর মান সবসময় string; valueAsNumber ছাড়া schema "7"-কে সংখ্যা মানত না
              {...register('fiscalYearStartMonth', { valueAsNumber: true })}
              error={errors.fiscalYearStartMonth?.message}
            />
            <SelectField
              label={t('settings.timezone')}
              icon={Globe02Icon}
              options={zoneOptions}
              {...register('timezone')}
              error={errors.timezone?.message}
            />
          </div>
        </Card>
      </fieldset>

      {canManage ? (
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={isSubmitting || !isDirty}
            className="w-full sm:w-auto sm:min-w-40"
          >
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      ) : (
        <p className="text-body-sm text-ink-3">{t('settings.readOnly')}</p>
      )}
    </form>
  );
}

// ব্রাউজারের নিজের ব্যর্থতাও (ভুল ধরনের ফাইল, storage-এ PUT ব্যর্থ) API-র error-এর একই আকারে —
// তাহলে দেখানোর কোড একটাই: error.code → বর্তমান ভাষায় লেখা
function uploadError(code: ErrorCode): ApiRequestError {
  return new ApiRequestError({ title: 'Upload failed', status: 0, detail: code, code });
}

// চার ধাপ: (১) ফাইলের বর্ণনা যাচাই → সই করা ঠিকানা, (২) ফাইল সরাসরি storage-এ, (৩) সার্ভার যাচাই
// করে "ready", (৪) লোগো হিসেবে বসানো। ফাইল কখনো API সার্ভার দিয়ে যায় না
async function uploadLogo(file: File): Promise<Settings> {
  const described = createUploadInputSchema.safeParse(
    { purpose: 'company_logo', fileName: file.name, contentType: file.type, sizeBytes: file.size },
    { error: contractErrorMap },
  );
  if (!described.success) {
    const message = described.error.issues[0]?.message;
    throw uploadError(isErrorCode(message) ? message : 'invalid_value');
  }
  const ticket = await call(routes.attachments.createUpload, { body: described.data });
  // আমাদের API না, storage — তাই call() না, সাধারণ fetch। সই করা header হুবহু পাঠাতে হয়
  const put = await fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body: file,
  }).catch(() => null);
  if (!put?.ok) throw uploadError('upload_incomplete');
  await call(routes.attachments.complete, { params: { id: ticket.attachment.id } });
  return call(routes.settings.setLogo, { body: { attachmentId: ticket.attachment.id } });
}

function LogoCard({ settings, canManage }: { settings: Settings; canManage: boolean }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const saved = (next: Settings, message: string) => {
    queryClient.setQueryData(settingsQuery(tenantId).queryKey, next);
    toast(message);
  };
  const upload = useMutation({
    mutationFn: uploadLogo,
    onSuccess: (next) => {
      saved(next, t('settings.logoSaved'));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(routes.settings.setLogo, { body: { attachmentId: null } }),
    onSuccess: (next) => {
      saved(next, t('settings.logoRemoved'));
    },
  });
  const failure = upload.error ?? remove.error;
  const busy = upload.isPending || remove.isPending;

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // খালি করা: একই ফাইল আবার বাছলেও change ঘটে (যেমন ব্যর্থ আপলোডের পরে আবার চেষ্টা)
    event.target.value = '';
    if (file) upload.mutate(file);
  };

  return (
    <Card>
      <CardHeader title={t('settings.logoTitle')} subtitle={t('settings.logoSubtitle')} />
      <div className="flex flex-wrap items-center gap-4 p-5">
        <div className="grid h-20 w-40 shrink-0 place-items-center rounded-control border border-line bg-subtle p-2">
          {settings.logo ? (
            <img
              src={settings.logo.url}
              alt={t('settings.logoAlt', { name: settings.companyName })}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="grid justify-items-center gap-1 text-caption text-ink-3">
              <HugeiconsIcon icon={Image01Icon} size={18} strokeWidth={1.5} />
              {t('settings.noLogo')}
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              // ফাইল বাছার জানালায় শুধু অনুমোদিত ধরন দেখায় — নিয়ম contracts থেকে, সার্ভারও একই নিয়ম মানে
              accept={ATTACHMENT_RULES.company_logo.contentTypes.join(',')}
              className="sr-only"
              tabIndex={-1}
              onChange={choose}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending
                ? t('settings.uploading')
                : settings.logo
                  ? t('settings.replaceLogo')
                  : t('settings.uploadLogo')}
            </Button>
            {settings.logo && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {t('settings.removeLogo')}
              </Button>
            )}
          </div>
        )}
        {failure && (
          <div className="basis-full">
            <FormAlert
              message={failure instanceof ApiRequestError ? failure.code : 'unknown_error'}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const { data, isError } = useQuery({ ...settingsQuery(tenantId), enabled: me !== null });
  if (!me) return null;

  const canManage = me.permissions.includes('core.settings.manage');

  return (
    <div className="grid max-w-3xl gap-5">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      {isError && <p className="text-body-sm text-crit">{t('settings.loadFailed')}</p>}
      {data && (
        <>
          <LogoCard settings={data} canManage={canManage} />
          {/* key: workspace বদলালে নতুন টেন্যান্টের মান দিয়ে ফর্ম নতুন করে তৈরি; একই টেন্যান্টের
              refetch-এ না — তাহলে লেখার মাঝে ফর্ম মুছে যেত */}
          <SettingsForm key={tenantId} settings={data} canManage={canManage} />
        </>
      )}
    </div>
  );
}
```

**কোন লাইন কেন:**

- `type FormValues = z.input<…>` — ফর্মে থাকে parse-এর **আগের** মান ('' ঘর), পরে না (null)। `<input value={null}>`
  React-এ সতর্কবার্তা দেয় আর uncontrolled হয়ে যায়; তাই `toForm()` null → ''।
- `version` ফর্মের মানে, কোনো ঘরে না — react-hook-form `defaultValues`-এর সব মান submit-এ পাঠায়, register না করলেও।
  সেভের পরে `reset(toForm(saved))` নতুন version বসায়। মন্তব্যে কারণ — সেভের মুহূর্তে ক্যাশ থেকে version নিলে পুরো
  optimistic locking অর্থহীন হয়ে যেত।
- `isDirty` না হলে "Save" বন্ধ — কিছু না বদলে বারবার সেভ = বারবার version বাড়া আর খালি audit।
- conflict-এ "Reload" — `queryClient.query({ ...settingsQuery, staleTime: 0 })`: ক্যাশ যত টাটকাই হোক, সার্ভারে যায়।
  `fetchQuery` না — TanStack v5.104-এ deprecated (lint-এর `no-deprecated` ধরেছিল)। আসল ব্রাউজারে যাচাই: দুই ট্যাব, প্রথমটা
  আইনি নাম বদলায়, দ্বিতীয়টা ফোন — দ্বিতীয়টা 409 → Reload → আইনি নাম দেখা যায় → ফোন আবার লিখে সেভ → audit-এ শুধু ফোন।
- `<fieldset disabled>` — অনুমতি না থাকলে সব ঘর একসাথে বন্ধ; প্রতিটা input-এ `disabled` লিখতে হয় না। `min-w-0` — fieldset-এর
  ডিফল্ট `min-width: min-content` ছোট স্ক্রিনে পেজকে আড়াআড়ি ঠেলে দিত।
- `key={tenantId}` — workspace বদলালে ফর্ম নতুন টেন্যান্টের মানে নতুন করে; একই টেন্যান্টের refetch-এ না (তাহলে লেখার
  মাঝে ফর্ম মুছে যেত)। `key={version}` দিলে ঠিক সেটাই হতো।
- `refreshMe()` সেভের পরে — কোম্পানির নাম বদলালে বাঁ দিকের switcher-এও নতুন নাম (যাচাই করা)।
- `uploadLogo` — চার ধাপ; প্রথম ধাপে contracts-এর একই schema দিয়ে যাচাই, তাই SVG বা বড় ফাইল নেটওয়ার্কে যাওয়ার আগেই
  ধরা পড়ে। storage-এ `fetch`, `call()` না — ঠিকানাটা আমাদের API না, Bearer টোকেন সেখানে পাঠানো উচিতও না।
- `uploadError()` — ব্রাউজারের নিজের ব্যর্থতাও `ApiRequestError` বানিয়ে: দেখানোর কোড একটাই (`error.code` →
  `FormAlert`), দুই রকম error-এর জন্য দুই পথ না।
- `event.target.value = ''` — একই ফাইল আবার বাছলে ব্রাউজার `change` দেয় না; ব্যর্থ আপলোডের পরে "আবার চেষ্টা" তখন কিছুই
  করত না।
- `timeZoneOptions` — `Intl.supportedValuesOf('timeZone')`; বর্তমান মান তালিকায় না থাকলে (কিছু engine-এ "UTC") সামনে
  যোগ — নাহলে native select চুপচাপ প্রথম মানে ("Africa/Abidjan") সরে যেত, আর পরের সেভে সেটাই সেভ হতো।

### নম্বরিং পেজ

**ফাইল: `apps/app/src/routes/numbering.tsx`** (নতুন)

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  DEFAULT_SETTINGS,
  formatDocumentNumber,
  type NumberSeries,
  periodOf,
  routes,
  todayIn,
  updateNumberSeriesInputSchema,
  YEAR_STYLES,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<NumberSeries>();
const FIELD_NAMES = updateNumberSeriesInputSchema.keyof().options;
const PADDINGS = [3, 4, 5, 6, 7, 8].map((digits) => ({
  value: String(digits),
  label: String(digits),
}));

function numberSeriesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['number-series', tenantId],
    queryFn: async () => (await call(routes.numberSeries.list)).items,
  });
}

// ফর্ম খোলা অবস্থায় টাইপ করতে করতেই উদাহরণ বদলায়। সার্ভারের নম্বর বানানোর ঠিক একই ফাংশন
// (contracts-এর formatDocumentNumber, periodOf) — তাই প্রিভিউ আর আসল নম্বর কখনো আলাদা হয় না
function SeriesForm({ series, onDone }: { series: NumberSeries; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery(tenantId)).data;
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateNumberSeriesInputSchema, { error: contractErrorMap }),
    defaultValues: {
      prefix: series.prefix,
      yearStyle: series.yearStyle,
      padding: series.padding,
      version: series.version,
    },
  });
  const [prefix, yearStyle, padding] = useWatch({
    control,
    name: ['prefix', 'yearStyle', 'padding'],
  });
  const document = t(`numbering.documents.${series.documentType}`);

  // settings এখনো না এলে বাংলাদেশের ডিফল্ট দিয়ে উদাহরণ — ফাঁকা জায়গার চেয়ে ভালো
  const example = formatDocumentNumber(
    { prefix: prefix.trim().toUpperCase(), yearStyle, padding },
    periodOf(
      todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
      yearStyle,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    1,
  );

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.numberSeries.update, {
        params: { documentType: series.documentType },
        body: values,
      });
      // পুরো তালিকা আবার না এনে শুধু এই রো বদলানো
      queryClient.setQueryData(numberSeriesQuery(tenantId).queryKey, (items) =>
        items?.map((item) => (item.documentType === saved.documentType ? saved : item)),
      );
      toast(t('numbering.saved', { document }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={t('numbering.editTitle', { document })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="series-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="series-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('numbering.prefix')}
          hint={t('numbering.prefixHint')}
          autoCapitalize="characters"
          spellCheck={false}
          {...register('prefix')}
          error={errors.prefix?.message}
        />
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
          <SelectField
            label={t('numbering.yearStyle')}
            hint={t('numbering.yearStyleHint')}
            options={YEAR_STYLES.map((style) => ({
              value: style,
              label: t(`numbering.yearStyles.${style}`),
            }))}
            {...register('yearStyle')}
            error={errors.yearStyle?.message}
          />
          <SelectField
            label={t('numbering.padding')}
            options={PADDINGS}
            {...register('padding', { valueAsNumber: true })}
            error={errors.padding?.message}
          />
        </div>
        <p className="rounded-control bg-subtle px-3 py-2.5 text-body-sm text-ink-2">
          {t('numbering.preview')}:{' '}
          <span className="font-mono font-medium text-ink tabular-nums">{example}</span>
        </p>
      </form>
    </DialogContent>
  );
}

export function NumberingPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = me?.permissions.includes('core.settings.manage') ?? false;
  const { data, isError } = useQuery({ ...numberSeriesQuery(tenantId), enabled: canManage });
  const [editing, setEditing] = useState<NumberSeries | null>(null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('documentType', {
          header: t('numbering.columns.document'),
          meta: { card: 'title' },
          cell: ({ getValue }) => (
            <span className="font-medium">{t(`numbering.documents.${getValue()}`)}</span>
          ),
        }),
        column.accessor('yearStyle', {
          header: t('numbering.columns.format'),
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            `${row.original.prefix} · ${t(`numbering.yearStyles.${row.original.yearStyle}`)}`,
        }),
        column.accessor('nextNumber', {
          header: t('numbering.columns.next'),
          meta: { card: 'trailing', align: 'end' },
          cell: ({ getValue }) => <span className="font-mono tabular-nums">{getValue()}</span>,
        }),
      ]),
    [t],
  );

  return (
    <div className="grid max-w-4xl gap-5">
      <PageHeader title={t('numbering.title')} description={t('numbering.description')} />
      {!canManage && <p className="text-body-sm text-ink-3">{t('settings.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('numbering.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('numbering.title')}
          data={data}
          columns={columns}
          getRowId={(series) => series.documentType}
          onRowClick={setEditing}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing && (
          <SeriesForm
            key={editing.documentType}
            series={editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- `useWatch` দিয়ে প্রিভিউ — `watch()`-এর মতো পুরো ফর্ম আবার আঁকে না, শুধু এই তিনটা মান বদলালে।
- `prefix.trim().toUpperCase()` প্রিভিউয়ে — schema সেভের সময় যা করবে, প্রিভিউ আগেই তা দেখায় ("si" লিখলে "SI-…")।
- উদাহরণে sequence ১ — "উদাহরণ"; আসল পরের নম্বর টেবিলের "Next number" কলামে, সার্ভার থেকে।
- বাটন `form="series-form"` — footer (বাটনের সারি) dialog-এর `<form>`-এর বাইরে, তবু Enter আর ক্লিক দুটোই এই ফর্ম জমা দেয়।
- `setQueryData(…, items => items?.map(…))` — পুরো তালিকা আবার আনার দরকার নেই, সার্ভার বদলানো সারিটাই ফেরত দিয়েছে।
- `useQuery({ ..., enabled: canManage })` — অনুমতি না থাকলে request-ই যায় না (নিশ্চিত 403)।
- `getRowId={(series) => series.documentType}` — ছয়টা টাইপই অনন্য, আলাদা id লাগে না।

### ব্রাঞ্চ পেজ

**ফাইল: `apps/app/src/routes/branches.tsx`** (নতুন)

```tsx
import {
  Archive02Icon,
  Call02Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Branch,
  BRANCH_STATUSES,
  type BranchStatus,
  contractErrorMap,
  routes,
  updateBranchInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  PageHeader,
  Pill,
  SegmentedControl,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<Branch>();
const FIELD_NAMES = updateBranchInputSchema.keyof().options;

function branchesQuery(tenantId: string, status: BranchStatus) {
  return queryOptions({
    queryKey: ['branches', tenantId, status],
    queryFn: async () => (await call(routes.branches.list, { query: { status } })).items,
  });
}

// একটা ফর্ম দুই কাজে: নতুন (branch নেই) আর বদল। নতুনের version 1 — schema-র min(1) পার হয়,
// আর তৈরির route version পড়েই না (branchInputSchema-তে ঘরটা নেই, z.object বাড়তি key ফেলে দেয়)
function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateBranchInputSchema, { error: contractErrorMap }),
    defaultValues: {
      code: branch?.code ?? '',
      name: branch?.name ?? '',
      phone: branch?.phone ?? '',
      address: branch?.address ?? '',
      version: branch?.version ?? 1,
    },
  });

  // সেভ, archive বা restore — যা-ই হোক, দুই তালিকাই (চালু আর আর্কাইভ) পুরনো। prefix key দিয়ে
  // দুটোকেই একসাথে: ['branches', tenantId] দিয়ে শুরু হওয়া সব query
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['branches', tenantId] });

  const toggle = useMutation({
    mutationFn: (current: Branch) =>
      call(current.archivedAt === null ? routes.branches.archive : routes.branches.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'branches.restoredToast' : 'branches.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = branch
        ? await call(routes.branches.update, {
            params: { id: branch.id },
            body: { ...fields, version },
          })
        : await call(routes.branches.create, { body: fields });
      await refresh();
      toast(t(branch ? 'branches.updated' : 'branches.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  const failure = errors.root?.server?.message ?? toggleFailure(toggle.error);

  return (
    <DialogContent
      title={branch ? t('branches.editTitle', { code: branch.code }) : t('branches.newTitle')}
      footer={
        <>
          {branch && (
            // বাঁয়ে সরানো: মূল কাজ (সেভ) থেকে দূরে, ভুল করে চাপার সম্ভাবনা কম
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(branch);
              }}
            >
              {branch.archivedAt === null ? t('branches.archive') : t('branches.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="branch-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : branch ? t('common.save') : t('branches.add')}
          </Button>
        </>
      }
    >
      <form
        id="branch-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('branches.code')}
            hint={t('branches.codeHint')}
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="GZP"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('branches.name')}
            icon={Store01Icon}
            placeholder="Gazipur factory"
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <TextField
          label={t('branches.phone')}
          icon={Call02Icon}
          optional
          type="tel"
          placeholder="+880 1711-000000"
          {...register('phone')}
          error={errors.phone?.message}
        />
        <TextAreaField
          label={t('branches.address')}
          optional
          placeholder="Plot 12, BSCIC Industrial Area, Konabari, Gazipur 1751"
          {...register('address')}
          error={errors.address?.message}
        />
      </form>
    </DialogContent>
  );
}

// archive/restore-এর error (branch_last_active, version_conflict) ফর্মের ঘরের না — উপরে alert-এ
function toggleFailure(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// null = dialog বন্ধ, 'new' = নতুন ব্রাঞ্চ, Branch = সেটা বদলানো
type Editing = null | 'new' | Branch;

export function BranchesPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = me?.permissions.includes('core.branch.manage') ?? false;
  const [status, setStatus] = useState<BranchStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({ ...branchesQuery(tenantId, status), enabled: me !== null });

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('branches.columns.branch'),
          meta: { card: 'title' },
          // CLAUDE.md → Table: প্রথম কলামে ৩০px tile + নাম + ink-3 সাব-লাইন। tile-এ কোড — রিপোর্টে
          // যে ছোট নামে ব্রাঞ্চ চেনা যায়
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid h-[30px] min-w-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft px-1 text-[11px] font-semibold text-brand">
                {row.original.code}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{row.original.name}</span>
                {row.original.address && (
                  <span className="block truncate text-caption text-ink-3">
                    {row.original.address}
                  </span>
                )}
              </span>
            </span>
          ),
        }),
        column.accessor('phone', {
          header: t('branches.columns.phone'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => getValue() ?? '—',
        }),
        column.accessor('archivedAt', {
          header: t('branches.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          // রং একা না — আইকন আর লেখা সহ (CLAUDE.md → Status colors)
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('branches.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('branches.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t],
  );

  const statusOptions = useMemo(
    () => BRANCH_STATUSES.map((value) => ({ value, label: t(`branches.statuses.${value}`) })),
    [t],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('branches.title')}
        description={t('branches.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('branches.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('branches.show')}
          value={status}
          options={statusOptions}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('branches.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('branches.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('branches.title')}
          data={data}
          columns={columns}
          getRowId={(branch) => branch.id}
          // বদলানোর অনুমতি না থাকলে রো ক্লিক করা যায় না — খুলে "অনুমতি নেই" দেখানোর চেয়ে ভালো
          onRowClick={canManage ? setEditing : undefined}
          // চালু তালিকা কখনো খালি হয় না (অন্তত একটা চালু ব্রাঞ্চ থাকে) — খালি শুধু আর্কাইভ
          empty={
            status === 'archived' && (
              <EmptyState
                icon={Archive02Icon}
                title={t('branches.emptyArchivedTitle')}
                description={t('branches.emptyArchivedBody')}
              />
            )
          }
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <BranchForm
            key={editing === 'new' ? 'new' : editing.id}
            branch={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- এক ফর্ম দুই কাজে — `branch === null` নতুন। তৈরিতে version ১ বসানো কারণ ফর্মের schema একটাই (`updateBranchInputSchema`,
  যার `min(1)`); তৈরির request-এ `fields` যায়, version না।
- `invalidateQueries({ queryKey: ['branches', tenantId] })` — prefix মেলানো: চালু আর আর্কাইভ দুই তালিকাই পুরনো হয়ে যায়
  (archive মানে একটা থেকে সরে আরেকটায়)। ধাপ ৫-এর নোটে যা বলা ছিল — প্রথম mutation-এর ছাঁদ।
- `await refresh()` তারপর toast আর বন্ধ — নতুন তালিকা আসার আগে dialog বন্ধ হলে এক মুহূর্ত পুরনো তালিকা দেখা যেত।
- Archive বাটন footer-এর বাঁয়ে (`mr-auto`) — "Save"-এর পাশে থাকলে ভুল করে চাপা সহজ।
- `onRowClick={canManage ? setEditing : undefined}` — অনুমতি না থাকলে রো ক্লিকযোগ্যই না (DataTable তখন `role="button"`
  বা pointer বসায় না)।
- প্রথম কলাম — CLAUDE.md-এর ৩০px tile, এখানে ব্রাঞ্চের কোড (`GZP`), কারণ রিপোর্টে লোকে কোড দিয়েই চেনে। `min-w-[30px]`
  আর `px-1` — ১০ অক্ষরের কোডেও tile ভাঙে না।
- Pill-এ আইকন আর লেখা দুটোই — CLAUDE.md: status রঙ কখনো একা না।
- `empty` শুধু আর্কাইভে — চালু তালিকা খালি হওয়া অসম্ভব (শেষ ব্রাঞ্চের নিয়ম)।

### audit log পেজ

**ফাইল: `apps/app/src/routes/audit-log.tsx`** (নতুন)

```tsx
import { FilterHorizontalIcon, WorkHistoryIcon } from '@hugeicons/core-free-icons';
import {
  AUDIT_ENTITY_TYPES,
  type AuditEntityType,
  type AuditEntry,
  type AuditValue,
  DEFAULT_SETTINGS,
  isAuditAction,
  routes,
} from '@omnivo/contracts';
import { i18n, type Messages, useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, SelectField } from '@omnivo/ui';
import {
  infiniteQueryOptions,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { call } from '../lib/api';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<AuditEntry>();

type Filter = AuditEntityType | 'all';
type AuditField = keyof Messages['audit']['fields'];

function isFilter(value: string): value is Filter {
  return value === 'all' || AUDIT_ENTITY_TYPES.some((type) => type === value);
}

// changes-এর ঘরের নাম অনুবাদে আছে কি না — runtime-এ i18n নিজেই জানে। নতুন সার্ভারের অচেনা ঘর হলে
// কাঁচা নামটাই দেখায়, ভাঙে না (action-এর মতোই, contracts/audit.ts)
function isAuditField(field: string): field is AuditField {
  return i18n.exists(`audit.fields.${field}`);
}

function auditQuery(tenantId: string, filter: Filter) {
  return infiniteQueryOptions({
    queryKey: ['audit-logs', tenantId, filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.audit.list, {
        query: {
          limit: 50,
          ...(filter !== 'all' && { entityType: filter }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

export function AuditLogPage() {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canRead = me?.permissions.includes('core.audit.read') ?? false;
  const [filter, setFilter] = useState<Filter>('all');
  // "কখন" টেন্যান্টের টাইমজোনে — settings না আসা পর্যন্ত বাংলাদেশের ডিফল্ট
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...auditQuery(tenantId, filter),
    enabled: canRead,
  });
  const entries = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const show = (value: AuditValue) => (value === null || value === '' ? '—' : String(value));
    return column.columns([
      column.accessor((entry) => entry.actor?.fullName ?? t('audit.system'), {
        id: 'who',
        header: t('audit.columns.who'),
        // পাতায় পাতায় আসা তালিকা ক্লায়েন্টে sort করলে শুধু আনা রো সাজাত — ভুল ফল (ধাপ ৫)। সার্ভার
        // সবসময় নতুন আগে দেয়, তাই হেডারে sort বাটনই নেই
        enableSorting: false,
        meta: { card: 'title' },
        // CLAUDE.md → Table: প্রথম কলাম ৩০px tile + নাম + ink-3 সাব-লাইন (এখানে সময়)
        cell: ({ getValue, row }) => (
          <span className="flex items-center gap-3">
            <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
              {initials(getValue())}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{getValue()}</span>
              <span className="block truncate text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(row.original.createdAt), timeZone)}
              </span>
            </span>
          </span>
        ),
      }),
      column.accessor('action', {
        header: t('audit.columns.what'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => {
          const action = getValue();
          return isAuditAction(action) ? t(`audit.actions.${action}`) : action;
        },
      }),
      column.accessor('changes', {
        header: t('audit.columns.changes'),
        enableSorting: false,
        meta: { card: 'detail' },
        // "নাম: Chattogram depot → Chattogram port depot" — প্রতিটা বদলানো ঘর আলাদা লাইনে
        cell: ({ getValue }) => {
          const changes = Object.entries(getValue());
          if (changes.length === 0) return <span className="text-ink-3">—</span>;
          return (
            <ul className="grid gap-0.5">
              {changes.map(([field, change]) => (
                <li key={field} className="truncate">
                  <span className="text-ink-3">
                    {isAuditField(field) ? t(`audit.fields.${field}`) : field}:
                  </span>{' '}
                  {show(change.from)} → {show(change.to)}
                </li>
              ))}
            </ul>
          );
        },
      }),
    ]);
  }, [t, format, timeZone]);

  const filterOptions = useMemo(
    () => [
      { value: 'all', label: t('audit.everything') },
      ...AUDIT_ENTITY_TYPES.map((type) => ({ value: type, label: t(`audit.entityTypes.${type}`) })),
    ],
    [t],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'core.audit.read' })}
        </p>
      ) : (
        <>
          <div className="max-w-xs">
            <SelectField
              label={t('audit.show')}
              icon={FilterHorizontalIcon}
              options={filterOptions}
              value={filter}
              onChange={(event) => {
                if (isFilter(event.target.value)) setFilter(event.target.value);
              }}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('audit.loadFailed')}</p>}
          {entries && (
            <DataTable
              label={t('audit.title')}
              data={entries}
              columns={columns}
              getRowId={(entry) => entry.id}
              onEndReached={loadMore}
              empty={
                <EmptyState
                  icon={WorkHistoryIcon}
                  title={t('audit.emptyTitle')}
                  description={t('audit.emptyBody')}
                />
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}
```

- `enableSorting: false` প্রতিটা কলামে — প্রথম সংস্করণে ভুলে যাওয়া হয়েছিল, আসল ব্রাউজারের screenshot-এ হেডারে ↑↓ দেখা
  গেল। পাতায় পাতায় আসা তালিকা ক্লায়েন্টে sort করা মানে শুধু আনা রো সাজানো — ভুল ফল (ধাপ ৫)।
- `` isAuditAction(action) ? t(`audit.actions.${action}`) : action `` — চেনা action টাইপ-চেকড অনুবাদে; অচেনা (নতুন সার্ভার)
  কাঁচা নামে।
- `isAuditField` — `i18n.exists()` দিয়ে runtime-এ দেখা, আর type guard-এ `field is AuditField` (`Messages`-এর key)।
  তাই `` t(`audit.fields.${field}`) `` cast ছাড়াই টাইপ-চেকড।
- `'—'` খালি মানের জন্য — প্রথমে অনুবাদ করা "empty" ছিল; "Name: empty → Rahman Garments" পড়তে অদ্ভুত লাগল, ড্যাশ সব
  ভাষায় একই।
- প্রথম কলাম "Who" — tile + নাম + নিচে সময় (CLAUDE.md-এর table নিয়ম)। সময় টেন্যান্টের টাইমজোনে (`format.dateTime`)।
- ফিল্টার `SelectField` `value`/`onChange` দিয়ে (controlled) — ফর্ম না, react-hook-form লাগে না। নতুন ফিল্টার = নতুন
  query key = প্রথম পাতা থেকে।
- `placeholderData: keepPreviousData` — ফিল্টার বদলালে নতুন তালিকা আসা পর্যন্ত আগেরটা থাকে, টেবিল ঝলকায় না।

---

## ৬.৯ — MSW: নতুন রুটের mock

`pnpm dev:mock` আর Playwright দুটোই এই mock-এর উপর চলে, তাই এগুলো শুধু "ডেটা ফেরত দেওয়া" না — আসল API-র নিয়মগুলো
(version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) মানে। নাহলে UI-র error-পথ mock-এ কখনো দেখা যেত না।

**ফাইল: `apps/app/src/mocks/fixtures.ts`** (আপডেট)

import-এ `Preferences`; আর `meIn()`-এর জায়গায়:

```ts
export const OWNER = owner;

// Owner = সব permission (আসল API-র মতো)
export const OWNER_PERMISSIONS = [
  'core.audit.read',
  'core.branch.manage',
  'core.role.manage',
  'core.settings.manage',
  'core.user.invite',
  'core.user.read',
];

export function meIn(
  workspace: Workspace,
  companyName: string,
  preferences: Preferences,
): MeResponse {
  return {
    user: owner,
    tenant: { id: workspace.tenantId, name: companyName, slug: workspace.slug },
    roles: ['Owner'],
    permissions: OWNER_PERMISSIONS,
    memberships: [...WORKSPACES],
    preferences,
  };
}
```

- `meIn` এখন কোম্পানির নাম আর পছন্দ নেয় — mock-এ সেটিংস থেকে নাম বদলালে switcher-এও নতুন নাম, আসল API-র মতো।
- Owner-এর ছয়টা permission — না হলে mock-এ Numbering আর Audit log-এর লিংকই দেখা যেত না।

**ফাইল: `apps/app/src/mocks/workspace-data.ts`** (নতুন)

```ts
import {
  type AuditAction,
  type AuditChanges,
  type AuditEntityType,
  type AuditEntry,
  type AuditValue,
  type Branch,
  DEFAULT_SETTINGS,
  defaultNumberFormat,
  DOCUMENT_TYPES,
  type DocumentType,
  type ErrorCode,
  formatDocumentNumber,
  type NumberFormat,
  type NumberSeries,
  periodOf,
  type Settings,
  todayIn,
} from '@omnivo/contracts';

import { OWNER, type Workspace } from './fixtures';

// mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
// নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
export interface WorkspaceData {
  settings: Settings;
  branches: Branch[];
  series: Map<DocumentType, NumberFormat & { version: number }>;
  audit: AuditEntry[];
}

// handler যা ছুড়ে দেয় আর problem() যা পাঠায় — status + code (+ ঘর)
export class MockProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly fieldErrors?: Record<string, ErrorCode[]>,
  ) {
    super(code);
  }
}

function now(): string {
  return new Date().toISOString();
}

function branch(code: string, name: string, address: string, archived = false): Branch {
  return {
    id: crypto.randomUUID(),
    code,
    name,
    phone: '+880 1711-000000',
    address,
    archivedAt: archived ? now() : null,
    version: 1,
    updatedAt: now(),
  };
}

// আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): গার্মেন্টসের কারখানা আর ডিপো, ফার্মার ডিপো
function seed(workspace: Workspace): WorkspaceData {
  const garments = workspace.slug === 'rahman-garments';
  const data: WorkspaceData = {
    settings: {
      companyName: workspace.name,
      legalName: null,
      bin: garments ? '0001234560101' : null,
      phone: null,
      email: null,
      address: null,
      ...DEFAULT_SETTINGS,
      logo: null,
      version: 1,
    },
    branches: garments
      ? [
          branch('HO', 'Head office', 'House 42, Road 11, Banani, Dhaka 1213'),
          branch('GZP', 'Gazipur factory', 'BSCIC Industrial Area, Konabari, Gazipur 1751'),
          branch('CTG', 'Chattogram depot', 'Port Connecting Road, Chattogram 4100'),
          branch('NGJ', 'Narayanganj dyeing unit', 'Fatullah, Narayanganj 1421', true),
        ]
      : [branch('HO', 'Head office', 'Tejgaon Industrial Area, Dhaka 1208')],
    series: new Map(),
    audit: [],
  };
  record(data, 'workspace.created', 'workspace', workspace.tenantId, {
    name: { from: null, to: workspace.name },
  });
  return data;
}

const store = new Map<string, WorkspaceData>();

export function dataOf(workspace: Workspace): WorkspaceData {
  let data = store.get(workspace.tenantId);
  if (!data) {
    data = seed(workspace);
    store.set(workspace.tenantId, data);
  }
  return data;
}

export function record(
  data: WorkspaceData,
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: string,
  changes: AuditChanges = {},
): void {
  // নতুন আগে — আসল API-র ক্রম
  data.audit.unshift({
    id: crypto.randomUUID(),
    action,
    entityType,
    entityId,
    actor: { id: OWNER.id, fullName: OWNER.fullName },
    changes,
    ipAddress: '103.4.145.2',
    requestId: crypto.randomUUID(),
    createdAt: now(),
  });
}

type Snapshot = Record<string, AuditValue>;

// API-র common/audit/audit.ts-এর মতো: শুধু যা বদলেছে
export function diff(before: Snapshot, after: Snapshot): AuditChanges {
  const changes: AuditChanges = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function checkVersion(actual: number, sent: number): void {
  if (actual !== sent) throw new MockProblem(409, 'version_conflict');
}

export function findBranch(data: WorkspaceData, id: string): Branch {
  const found = data.branches.find((candidate) => candidate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertCodeFree(data: WorkspaceData, code: string, except?: string): void {
  if (data.branches.some((other) => other.code === code && other.id !== except)) {
    throw new MockProblem(409, 'branch_code_taken', { code: ['branch_code_taken'] });
  }
}

export function seriesList(data: WorkspaceData): NumberSeries[] {
  const period = (format: NumberFormat) =>
    periodOf(todayIn(data.settings.timezone), format.yearStyle, data.settings.fiscalYearStartMonth);
  return DOCUMENT_TYPES.map((documentType) => {
    const saved = data.series.get(documentType);
    const format = saved ?? defaultNumberFormat(documentType);
    return {
      documentType,
      ...format,
      version: saved?.version ?? 0,
      // mock-এ কোনো ডকুমেন্ট তৈরি হয় না, তাই পরের নম্বর সবসময় ১
      nextNumber: formatDocumentNumber(format, period(format), 1),
    };
  });
}
```

- প্রতিটা workspace-এর নিজের ডেটা (`Map`, `tenantId` দিয়ে) — switcher দিয়ে Karim Pharma-য় গেলে অন্য ব্রাঞ্চ দেখায়।
- `MockProblem` ছুড়ে দেওয়া — handler-এ প্রতিটা নিয়মের জন্য `if (…) return problem(…)` না লিখে নিয়ম-ফাংশন
  (`checkVersion`, `assertCodeFree`) নিজেই থামায়; `guarded()` (নিচে) সেটা response বানায়।
- `diff` API-র একই নিয়ম — mock-এর audit log-এও শুধু বদলানো ঘর।
- seed-এ একটা আর্কাইভ করা ব্রাঞ্চ (Narayanganj) — "Archived" ট্যাব খুললেই ফাঁকা না, আসল চেহারা দেখা যায়।

**ফাইল: `apps/app/src/mocks/handlers.ts`** (আপডেট)

উপরের অংশ (import আর mock-এর অবস্থা):

```ts
import { type AuthSession, type Preferences, routes, type Settings } from '@omnivo/contracts';
import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';

import { API_URL } from '../lib/api';
import { MEMBERS, meIn, WORKSPACES, type Workspace } from './fixtures';
import { mock, problem, readBody, readQuery, reply } from './mock';
import {
  assertCodeFree,
  checkVersion,
  dataOf,
  diff,
  findBranch,
  MockProblem,
  record,
  seriesList,
} from './workspace-data';

// mock সার্ভারের অবস্থা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে
let signedIn = true;
let workspace: Workspace = WORKSPACES[0];
let preferences: Preferences = { language: null, theme: 'system' };

// আপলোড হওয়া ফাইল: storage-এর বদলে ব্রাউজারের blob URL — <img src>-এ সরাসরি বসে
const uploads = new Map<string, { contentType: string; sizeBytes: number; url?: string }>();
const MOCK_STORAGE = `${API_URL}/mock-storage`;

function current() {
  return dataOf(workspace);
}

function me() {
  return meIn(workspace, current().settings.companyName, preferences);
}

// handler-এর ভেতরে MockProblem ছুড়লেই আসল API-র মতো problem response — প্রতিটা নিয়মে আলাদা
// if/return লিখতে হয় না
function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
  return async (info) => {
    try {
      return await resolver(info);
    } catch (error) {
      if (error instanceof MockProblem) return problem(error.status, error.code, error.fieldErrors);
      throw error;
    }
  };
}

// audit-এর "আগের মান" — ফর্মের ঘরগুলো
function editable(settings: Settings) {
  return {
    companyName: settings.companyName,
    legalName: settings.legalName,
    bin: settings.bin,
    phone: settings.phone,
    email: settings.email,
    address: settings.address,
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
```

```ts
  };
}
```

(তার পরে `session()` আর বাকিটা আগের মতো।)

`routes.auth.me`-র handler আর তার পরে নতুনটা:

```ts
  mock(routes.auth.me, () => reply(routes.auth.me, me())),

  mock(routes.me.updatePreferences, async ({ request }) => {
    const body = await readBody(routes.me.updatePreferences.body, request);
    preferences = {
      language: body.language ?? preferences.language,
      theme: body.theme ?? preferences.theme,
    };
    return reply(routes.me.updatePreferences, preferences);
  }),
```

`handlers` array-এর শেষে (members-এর handler-এর পরে) — নতুন সব রুট:

```ts
  mock(routes.settings.get, () => reply(routes.settings.get, current().settings)),

  mock(
    routes.settings.update,
    guarded(async ({ request }) => {
      const { version, ...fields } = await readBody(routes.settings.update.body, request);
      const data = current();
      checkVersion(data.settings.version, version);
      const before = editable(data.settings);
      data.settings = { ...data.settings, ...fields, version: version + 1 };
      record(data, 'settings.updated', 'workspace', workspace.tenantId, diff(before, fields));
      await delay();
      return reply(routes.settings.update, data.settings);
    }),
  ),

  mock(
    routes.settings.setLogo,
    guarded(async ({ request }) => {
      const { attachmentId } = await readBody(routes.settings.setLogo.body, request);
      const data = current();
      const file = attachmentId === null ? undefined : uploads.get(attachmentId);
      if (attachmentId !== null && !file?.url) throw new MockProblem(409, 'attachment_not_ready');
      data.settings = {
        ...data.settings,
        logo: attachmentId !== null && file?.url ? { attachmentId, url: file.url } : null,
      };
      record(data, 'settings.logo_changed', 'workspace', workspace.tenantId);
      return reply(routes.settings.setLogo, data.settings);
    }),
  ),

  mock(routes.branches.list, ({ request }) => {
    const { status } = readQuery(routes.branches.list.query, request);
    const items = current()
      .branches.filter((branch) => (status === 'active') === (branch.archivedAt === null))
      .toSorted((a, b) => a.code.localeCompare(b.code));
    return reply(routes.branches.list, { items });
  }),

  mock(
    routes.branches.create,
    guarded(async ({ request }) => {
      const body = await readBody(routes.branches.create.body, request);
      const data = current();
      assertCodeFree(data, body.code);
      const created = {
        id: crypto.randomUUID(),
        ...body,
        archivedAt: null,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data.branches.push(created);
      record(data, 'branch.created', 'branch', created.id, diff({}, body));
      await delay();
      return reply(routes.branches.create, created);
    }),
  ),

  mock(
    routes.branches.update,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.update.params.parse(params);
      const { version, ...fields } = await readBody(routes.branches.update.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      assertCodeFree(data, fields.code, id);
      const before = {
        code: target.code,
        name: target.name,
        phone: target.phone,
        address: target.address,
      };
      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
      record(data, 'branch.updated', 'branch', id, diff(before, fields));
      await delay();
      return reply(routes.branches.update, target);
    }),
  ),

  mock(
    routes.branches.archive,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.archive.params.parse(params);
      const { version } = await readBody(routes.branches.archive.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      const othersActive = data.branches.some((b) => b.id !== id && b.archivedAt === null);
      if (!othersActive) throw new MockProblem(409, 'branch_last_active');
      Object.assign(target, { archivedAt: new Date().toISOString(), version: version + 1 });
      record(data, 'branch.archived', 'branch', id);
      return reply(routes.branches.archive, target);
    }),
  ),

  mock(
    routes.branches.restore,
    guarded(async ({ request, params }) => {
      const { id } = routes.branches.restore.params.parse(params);
      const { version } = await readBody(routes.branches.restore.body, request);
      const data = current();
      const target = findBranch(data, id);
      checkVersion(target.version, version);
      Object.assign(target, { archivedAt: null, version: version + 1 });
      record(data, 'branch.restored', 'branch', id);
      return reply(routes.branches.restore, target);
    }),
  ),

  mock(routes.numberSeries.list, () =>
    reply(routes.numberSeries.list, { items: seriesList(current()) }),
  ),

  mock(
    routes.numberSeries.update,
    guarded(async ({ request, params }) => {
      const { documentType } = routes.numberSeries.update.params.parse(params);
      const { version, ...format } = await readBody(routes.numberSeries.update.body, request);
      const data = current();
      checkVersion(data.series.get(documentType)?.version ?? 0, version);
      data.series.set(documentType, { ...format, version: version + 1 });
      record(data, 'number_series.updated', 'number_series', crypto.randomUUID(), {});
      const saved = seriesList(data).find((series) => series.documentType === documentType);
      if (!saved) throw new MockProblem(404, 'not_found');
      return reply(routes.numberSeries.update, saved);
    }),
  ),

  mock(routes.audit.list, ({ request }) => {
    const query = readQuery(routes.audit.list.query, request);
    // mock-এ cursor শুধু offset (members-এর মতো) — ক্লায়েন্টের কাছে অস্বচ্ছ string
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const all = current().audit.filter(
      (entry) => query.entityType === undefined || entry.entityType === query.entityType,
    );
    const items = all.slice(start, start + query.limit);
    const end = start + items.length;
    return reply(routes.audit.list, { items, nextCursor: end < all.length ? String(end) : null });
  }),

  mock(routes.attachments.createUpload, async ({ request }) => {
    const body = await readBody(routes.attachments.createUpload.body, request);
    const id = crypto.randomUUID();
    uploads.set(id, { contentType: body.contentType, sizeBytes: body.sizeBytes });
    return reply(routes.attachments.createUpload, {
      attachment: { id, ...body, status: 'pending', createdAt: new Date().toISOString() },
      upload: {
        method: 'PUT',
        url: `${MOCK_STORAGE}/${id}`,
        headers: { 'content-type': body.contentType },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
  }),

  // storage-এর জায়গায়: চুক্তির রুট না, তাই mock() না — সাধারণ MSW handler
  http.put(`${MOCK_STORAGE}/:id`, async ({ request, params }) => {
    const file = typeof params.id === 'string' ? uploads.get(params.id) : undefined;
    if (!file) return new HttpResponse(null, { status: 404 });
    file.url = URL.createObjectURL(await request.blob());
    await delay(600);
    return new HttpResponse(null, { status: 200 });
  }),

  mock(
    routes.attachments.complete,
    guarded(({ params }) => {
      const { id } = routes.attachments.complete.params.parse(params);
      const file = uploads.get(id);
      if (!file?.url) throw new MockProblem(409, 'upload_incomplete');
      return reply(routes.attachments.complete, {
        id,
        purpose: 'company_logo',
        fileName: 'logo',
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        status: 'ready',
        createdAt: new Date().toISOString(),
      });
    }),
  ),

  mock(
    routes.attachments.download,
    guarded(({ params }) => {
      const { id } = routes.attachments.download.params.parse(params);
      const url = uploads.get(id)?.url;
      if (!url) throw new MockProblem(409, 'attachment_not_ready');
      return reply(routes.attachments.download, {
        url,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }),
  ),
];
```

**কোন লাইন কেন:**

- `` http.put(`${MOCK_STORAGE}/:id`, …) `` — চুক্তির রুট না (storage), তাই `mock()` না, সাধারণ MSW handler। ঠিকানা
  `API_URL`-এর নিচে রাখা: `main.tsx`-এর `onUnhandledRequest` শুধু `API_URL`-এর request-এ error দেখায় — mock ভুলে গেলে
  সেটাও চোখে পড়বে।
- `URL.createObjectURL(await request.blob())` — "storage" মানে ব্রাউজারের memory; `<img src="blob:…">` সরাসরি চলে, আর
  চুক্তির `z.url()` blob URL মানে (যাচাই করা)।
- `routes.branches.update.params.parse(params)` — MSW-এর `params` ঢিলা টাইপের (`string | string[]`); চুক্তির schema-য়
  parse করলে `id` string (uuid) — cast না।
- archive-এর নিয়ম আসল API-র চেয়ে সরল (lock নেই) — mock একটা ট্যাবের memory, দুটো request একসাথে চলার প্রশ্নই নেই।
- নম্বরিংয়ের audit-এর `entityId` এলোমেলো uuid — mock-এ series-এর নিজের id নেই; viewer-এ entityId দেখানো হয় না।

---

## ৬.১০ — Playwright: প্রথম end-to-end টেস্ট

ধাপ ৪ আর ৫ দুটোই এটাকে "প্রথম আসল ফিচার-ফর্মের সাথে" পিছিয়েছিল — সেটা এই ধাপ। আট রকম flow, ডেস্কটপ (১২৮০px) আর
ফোন (৩৯০px) দুই আকারে = ১৬টা টেস্ট, MSW-এর mock API-র উপর।

**ফাইল: `apps/app/package.json`** (আপডেট)

`scripts`-এ:

```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts && tsc --noEmit -p e2e",
    "test:e2e": "playwright test --config e2e/playwright.config.ts"
```

`devDependencies`-এ (বর্ণানুক্রমে, `@omnivo/config`-এর পরে):

```json
    "@playwright/test": "^1.63.0",
```

তারপর ব্রাউজার একবার নামাতে হয় (রিপোর বাইরে, `~/Library/Caches/ms-playwright`-এ):

```bash
pnpm --filter @omnivo/app exec playwright install chromium
```

- `-p e2e` typecheck-এ — e2e ফাইলগুলো app-এর `tsconfig.json`-এ নেই (সেটা `src/` আর ব্রাউজারের `lib`); Node-এর টাইপে
  আলাদা tsconfig। না দিলে e2e-র টাইপের ভুল কেউ দেখত না, আর ESLint-এর `projectService` ফাইলগুলো চিনত না।

**ফাইল: `apps/app/e2e/tsconfig.json`** (নতুন)

```json
{
  "extends": "../../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["*.ts"]
}
```

**ফাইল: `apps/app/e2e/playwright.config.ts`** (নতুন)

```ts
import { defineConfig, devices } from '@playwright/test';

// আলাদা port: `pnpm dev` (5173) চালু থাকলেও e2e নিজের সার্ভার তোলে, একে অন্যের পথে পড়ে না
const PORT = 4173;

export default defineConfig({
  testDir: '.',
  // *.e2e.ts, *.spec.ts না: vitest-এর ডিফল্ট pattern *.spec.ts ধরে — নাম আলাদা না হলে `pnpm test`
  // Playwright-এর ফাইল চালাতে গিয়ে ভাঙত
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  // CI-তে ভুলে থাকা test.only পুরো স্যুট চুপচাপ ছোট করে দিত
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    // fail করলে পুরো রেকর্ড (DOM, network, screenshot) — `pnpm exec playwright show-trace` দিয়ে দেখা
    trace: 'retain-on-failure',
  },
  // CLAUDE.md-এর দুই আকার: ডেস্কটপ আর ৩৯০px ফোন (৮৬০px-এর নিচে টেবিল কার্ড হয়ে যায়)
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  // MSW-এর mock API-র উপর অ্যাপ (`pnpm dev:mock`-এর মতো) — API, Postgres বা Docker লাগে না, তাই CI-র
  // সাধারণ runner-এ চলে। আসল API-র সাথে flow integration টেস্টে পাহারা দেওয়া
  webServer: {
    command: `pnpm exec vite --mode mock --port ${String(PORT)} --strictPort`,
    cwd: '..',
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: !process.env.CI,
  },
});
```

**কোন লাইন কেন:**

- config `e2e/`-এর ভেতরে, app-এর root-এ না — root-এ রাখলে সেটা কোনো tsconfig-এর আওতায় পড়ত না, আর ESLint ("file not
  found in any project") fail করত। `scripts/`-এর (bundle-size) একই ছাঁদ।
- `webServer.command` — `vite --mode mock` সরাসরি, `pnpm dev:mock` না: আলাদা port (`--port 4173 --strictPort`) দিতে হয়,
  যাতে আপনার চালু `pnpm dev` (৫১৭৩) থাকলেও e2e নিজের সার্ভার তোলে। `reuseExistingServer: !CI` — লোকালে ৪১৭৩-এ আগে থেকে
  চালু থাকলে সেটাই, CI-তে সবসময় নতুন।
- `devices['Pixel 7']` + ৩৯০px — `isMobile` আর touch সহ; ৮৬০px-এর নিচে AppShell-এর টপ বার আর DataTable-এর কার্ড চলে।
- `retries: 1` শুধু CI-তে — লোকালে অস্থির টেস্ট লুকানো উচিত না, চোখে পড়ুক।

**ফাইল: `apps/app/e2e/helpers.ts`** (নতুন)

```ts
import { expect, type Locator, type Page } from '@playwright/test';

// ডেস্কটপে টেবিলের রো, ফোনে কার্ড (role="button") — একই টেস্ট দুই আকারেই
export function listItem(page: Page, name: string | RegExp): Locator {
  return page.getByRole('row', { name }).or(page.getByRole('button', { name }));
}

// শুধু-পড়ার তালিকা (audit log): ডেস্কটপে রো, ফোনে কার্ড — কিন্তু কার্ড ক্লিক করা যায় না বলে
// role="button" নেই, সাধারণ <li>। listitem-এর নাম লেখা থেকে আসে না (ARIA), তাই নাম না, hasText
export function readOnlyItem(page: Page, text: string | RegExp): Locator {
  return page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: text });
}

// পেজ reload করলে MSW-এর mock ডেটা শুরুতে ফেরে — তাই পেজ বদলানো সবসময় nav-এর লিংকে ক্লিক করে
// (client-side), page.goto দিয়ে না। ফোনে nav একটা আড়াআড়ি scroll-এর সারি; Playwright নিজেই scroll করে
export async function openFromNav(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

// পেজ আড়াআড়ি scroll হয় না (CLAUDE.md → Page gutters) — চওড়া টেবিল শুধু নিজের বাক্সে
export async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
```

- `listItem` আর `readOnlyItem` আলাদা — প্রথমে একটাই ছিল (`row` অথবা `button`), আর ফোনে audit log-এর টেস্ট fail করল:
  audit-এর কার্ড ক্লিক করা যায় না, তাই `role="button"` নেই, সাধারণ `<li>`। Playwright-এর error-context-এ পেজের
  accessibility tree দেখে ধরা পড়েছিল।
- `openFromNav` — **কখনো `page.goto('/settings')` দিয়ে পেজ বদলানো না** (প্রথম পেজ ছাড়া)। MSW-এর mock ডেটা শুধু ট্যাবের
  memory-তে; reload মানে সব শুরু থেকে — ব্রাঞ্চ যোগ করে `goto('/audit-log')` করলে audit-এ সেটা থাকত না।
- `expectNoSideScroll` — CLAUDE.md-এর "পেজ কখনো আড়াআড়ি scroll হবে না" এখন টেস্টে বাঁধা।

**ফাইল: `apps/app/e2e/settings.e2e.ts`** (নতুন)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav } from './helpers.js';

// ১×১ px PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Settings');
});

test('checks the BIN, then saves the company profile', async ({ page }) => {
  const bin = page.getByLabel('BIN');
  await bin.fill('12345');
  await page.getByRole('button', { name: 'Save changes' }).click();
  // ফর্মের নিজের যাচাই (contracts-এর একই schema) — সার্ভারে যাওয়ার আগেই
  await expect(page.getByText('Enter the 13-digit BIN, like 000123456-0101.')).toBeVisible();

  await bin.fill('000123456-0202');
  await page.getByLabel('Legal name').fill('Rahman Knit Garments Limited');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  // সেভের পরে ফর্ম আবার "অপরিবর্তিত" — বাটন বন্ধ, দুবার চাপা যায় না
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expectNoSideScroll(page);
});

test('uploads a logo and refuses an SVG before sending it anywhere', async ({ page }) => {
  const file = page.locator('input[type="file"]');
  await file.setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  });
  await expect(page.getByText('Use a PNG, JPG or WebP image.')).toBeVisible();

  await file.setInputFiles({ name: 'rahman-logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('Logo updated')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Rahman Garments Ltd. logo' })).toBeVisible();
});

test('shows the regional defaults for Bangladesh', async ({ page }) => {
  await expect(page.getByLabel('Base currency')).toHaveValue('BDT');
  await expect(page.getByLabel('Fiscal year starts in')).toHaveValue('7');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Dhaka');
});
```

**ফাইল: `apps/app/e2e/branches.e2e.ts`** (নতুন)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Branches');
});

test('adds a branch, refuses a code already in use, then archives it', async ({ page }) => {
  await page.getByRole('button', { name: 'Add branch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add branch' });
  // ছোট হাতে লিখলেও GZP — আগে থেকেই আছে, সার্ভারের 409 ঘরের নিচে
  await dialog.getByLabel('Code').fill('gzp');
  await dialog.getByLabel('Name').fill('Second Gazipur unit');
  await dialog.getByRole('button', { name: 'Add branch' }).click();
  await expect(dialog.getByText('Another branch already uses this code.')).toBeVisible();

  await dialog.getByLabel('Code').fill('MYM');
  await dialog.getByLabel('Name').fill('Mymensingh sales office');
  await dialog.getByRole('button', { name: 'Add branch' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Mymensingh sales office added')).toBeVisible();

  await listItem(page, /Mymensingh sales office/).click();
  await page
    .getByRole('dialog', { name: 'Edit MYM' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByText('Mymensingh sales office archived')).toBeVisible();
  await expect(listItem(page, /Mymensingh sales office/)).toBeHidden();

  await page.getByText('Archived', { exact: true }).click();
  await expect(listItem(page, /Mymensingh sales office/)).toBeVisible();
  await expectNoSideScroll(page);
});

test('keeps the last active branch', async ({ page }) => {
  for (const [name, code] of [
    [/Chattogram depot/, 'CTG'],
    [/Gazipur factory/, 'GZP'],
  ] as const) {
    await listItem(page, name).click();
    await page
      .getByRole('dialog', { name: `Edit ${code}` })
      .getByRole('button', { name: 'Archive' })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();
  }
  await listItem(page, /Head office/).click();
  const dialog = page.getByRole('dialog', { name: 'Edit HO' });
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(/Keep at least one branch active/);
});
```

**ফাইল: `apps/app/e2e/numbering.e2e.ts`** (নতুন)

```ts
import { periodOf, todayIn } from '@omnivo/contracts';
import { expect, test } from '@playwright/test';

import { listItem, openFromNav } from './helpers.js';

// তারিখ-নির্ভর: আজ কোন অর্থবছর, সেটা অ্যাপের একই ফাংশন দিয়ে হিসাব — কোনো বছর হাতে লেখা নেই
const today = todayIn('Asia/Dhaka');

test('previews the format while typing and saves it', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Numbering');
  await listItem(page, /Sales invoice/).click();

  const dialog = page.getByRole('dialog', { name: 'Edit Sales invoice numbering' });
  await expect(dialog.getByText(`INV-${periodOf(today, 'fiscal', 7)}-0001`)).toBeVisible();

  await dialog.getByLabel('Prefix').fill('si');
  await dialog.getByLabel('Year in the number').selectOption('calendar');
  await dialog.getByLabel('Digits').selectOption('5');
  await expect(dialog.getByText(`SI-${today.slice(0, 4)}-00001`)).toBeVisible();

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Sales invoice numbering saved')).toBeVisible();
  await expect(listItem(page, /Sales invoice/)).toContainText(`SI-${today.slice(0, 4)}-00001`);
});
```

**ফাইল: `apps/app/e2e/audit-and-preferences.e2e.ts`** (নতুন)

```ts
import { expect, type Page, test } from '@playwright/test';

import { listItem, openFromNav, readOnlyItem } from './helpers.js';

// ডেস্কটপে সাইডবারের নিচে নিজের নাম, ফোনে টপ বারের "Account" আইকন — একই মেনু। কোনটা, সেটা
// viewport-এর চওড়া দেখে (৮৬০px-এর নিচে ফোনের layout), isVisible() দিয়ে না: পেজ আঁকা শেষ হওয়ার আগে
// সেটা false দেয়, আর টেস্ট ভুল বাটনে অপেক্ষা করে আটকে থাকত (যাচাইয়ের সময় ঠিক এটাই হয়েছিল)
async function openUserMenu(page: Page): Promise<void> {
  const phone = (page.viewportSize()?.width ?? 1280) < 860;
  await page.getByRole('button', { name: phone ? 'Account' : /Farhana Rahman/ }).click();
}

test('records a branch change in the audit log, with who and what changed', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Branches');
  await listItem(page, /Chattogram depot/).click();
  const dialog = page.getByRole('dialog', { name: 'Edit CTG' });
  await dialog.getByLabel('Name').fill('Chattogram port depot');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();

  await openFromNav(page, 'Audit log');
  const entry = readOnlyItem(page, 'Edited a branch');
  await expect(entry).toContainText('Farhana Rahman');
  await expect(entry).toContainText('Chattogram depot → Chattogram port depot');
});

test('switches to the dark theme and to Bangla from the user menu', async ({ page }) => {
  await page.goto('/');
  await openUserMenu(page);
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await openUserMenu(page);
  await page.getByRole('menuitemradio', { name: 'বাংলা' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'সারসংক্ষেপ' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
});
```

**কোন লাইন কেন:**

- locator সব role আর লেখা দিয়ে (`getByRole('button', { name: 'Save changes' })`, `getByLabel('BIN')`) — CSS class বা
  `data-testid` না। টেস্ট ইউজারের মতো পেজ দেখে, আর accessibility ভাঙলে (label ছাড়া input) টেস্টও ভাঙে। ব্যতিক্রম একটাই:
  লুকানো `input[type="file"]` — তার কোনো দৃশ্যমান role নেই, আর `setInputFiles` সেটাই চায়।
- `import … from './helpers.js'` — `.js`, যদিও ফাইলটা `.ts`: e2e-র tsconfig `nodenext`, যেখানে relative import-এ
  extension বাধ্যতামূলক; Playwright-এর loader `.js`-কে `.ts`-এ মেলায়।
- `numbering.e2e.ts` contracts থেকে `periodOf`/`todayIn` নেয় — প্রত্যাশিত নম্বর অ্যাপের একই হিসাবে, কোনো বছর হাতে লেখা নেই।
- `openUserMenu` — viewport-এর চওড়া দেখে বাটন বাছে। প্রথম সংস্করণ `isVisible()` দিয়ে দেখত ফোনের "Account" বাটন আছে কি না
  — পেজ আঁকা শেষ হওয়ার আগে সেটা `false` দিত, টেস্ট ডেস্কটপের বাটনের জন্য ৩০ সেকেন্ড অপেক্ষা করে fail। প্রথম রানে পাস,
  দ্বিতীয়তে fail — অস্থির টেস্টের ক্লাসিক রূপ। `isVisible()` অপেক্ষা করে না; সিদ্ধান্তের জন্য কখনো ব্যবহার না।
- "keeps the last active branch" — `dialog.getByRole('alert')`: `FormAlert`-এর `role="alert"`; লেখার সাথে মেলানো
  `toHaveText(/Keep at least one/)`, পুরো বাক্য না — লেখা সামান্য বদলালে টেস্ট ভাঙার কারণ নেই।

---

## ৬.১১ — root: script, turbo, CI, env

**ফাইল: `turbo.json`** (আপডেট — `tasks`-এর শেষে)

```json
    "test:e2e": {
      "dependsOn": ["^build"],
      "cache": false
    }
```

- `^build` — e2e app-এর প্যাকেজগুলোর `dist` পড়ে (contracts, ui, i18n)।
- `cache: false` — ফল রিপোর বাইরের জিনিসের উপরও নির্ভর করে (নামানো Chromium-এর সংস্করণ); cache hit হলে ব্রাউজার আপডেটের
  পরে টেস্ট আসলে চলতই না।

**ফাইল: root `package.json`** (আপডেট — `test:tenant-leak`-এর পরে)

```json
    "test:e2e": "turbo run test:e2e",
```

**ফাইল: `.github/workflows/ci.yml`** (আপডেট — `Tenant leak tests`-এর পরে)

```yaml
      - name: Install Playwright browser
        run: pnpm --filter @omnivo/app exec playwright install --with-deps chromium

      - name: E2E (Playwright on MSW mocks)
        run: pnpm test:e2e
```

- `--with-deps` — Ubuntu runner-এ Chromium-এর লাইব্রেরি (libnss ইত্যাদি) নেই; এটা apt দিয়ে বসায়। শুধু chromium — firefox
  আর webkit নামালে প্রতিটা CI-রানে কয়েকশো MB বেশি।
- `Build`-এর আগে — e2e dev সার্ভারে চলে, production build লাগে না; আগে fail হলে build-এর সময় বাঁচে।
- ⚠️ এই দুই ধাপ GitHub Actions-এ চালিয়ে দেখা হয়নি (উপরে বলা)। প্রথম PR-এ দেখে নিন।

**ফাইল: `.gitignore`** (আপডেট — `.DS_Store`-এর পরে)

```gitignore
# Playwright-এর fail-এর রেকর্ড (trace, screenshot) — প্রতিটা রানে নতুন
test-results/
playwright-report/
```

- Prettier ৩ `.gitignore` মানে — তাই fail-এর পরে `test-results/`-এর ফাইল `pnpm format`-কেও বিরক্ত করে না।

**ফাইল: `.env.example`** (আপডেট — শেষে)

```
# ফাইল storage (S3-এর মতো API) — dev-এ docker-compose-এর MinIO, production-এ Cloudflare R2।
# bucket না থাকলে dev-এ API নিজেই বানায়
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=omnivo
S3_ACCESS_KEY_ID=omnivo
S3_SECRET_ACCESS_KEY=omnivo-dev-secret
```

- `.env.example`-এর আগের শেষ লাইনের পরে newline ছিল না — এর শিক্ষা ৬.১৩-এ (আপনার নিজের `.env`)।
- docker-compose বদলায়নি: MinIO আগে থেকেই আছে (ধাপ ০), আর bucket API নিজে বানায়। MinIO-র CORS ডিফল্টে সব origin
  মানে — আসল ব্রাউজার থেকে সরাসরি PUT যাচাই করা, আলাদা কনফিগ লাগেনি। production-এ R2-র bucket-এ CORS rule (শুধু app-এর
  origin, PUT আর GET) IaC-তে লিখতে হবে (ধাপ ২৫)।

**pnpm-এর supply-chain নিয়ম — AWS SDK-র সংস্করণ:** pnpm ১২ ডিফল্টে একদিনের কম পুরনো প্যাকেজ নিতে চায় না
(`minimumReleaseAge`)। যাচাইয়ের দিন `@aws-sdk/client-s3`-এর সর্বশেষ 3.1142.0 বেরিয়েছিল ১২ ঘণ্টা আগে। `pnpm add
@aws-sdk/client-s3` তখন চুপচাপ `pnpm-workspace.yaml`-এ `minimumReleaseAgeExclude`-এ দুটো লাইন লিখে দিয়েছিল — মানে
নিরাপত্তা-নিয়ম দুর্বল করে। সেটা ফেলে দিয়ে `^3.1141.0` লেখা হয়েছে; pnpm তখন নিয়ম মেনে সবচেয়ে নতুন "অন্তত একদিন পুরনো"
সংস্করণ নেয়। আপনি যেদিন বসাবেন সেদিন নতুন কিছু বের হতে পারে — `pnpm add` যদি `pnpm-workspace.yaml` বদলায়, সেই বদল
ফেলে দিয়ে `package.json`-এ আগের কোনো সংস্করণ লিখুন। `apps/api/package.json`-এর `dependencies`-এ:

```json
    "@aws-sdk/client-s3": "^3.1141.0",
    "@aws-sdk/s3-request-presigner": "^3.1141.0",
```

---

## ৬.১২ — ডকুমেন্ট হালনাগাদ

ইমপ্লিমেন্ট শেষে (আমাকে বললে আমি করে দিতে পারি):

**CLAUDE.md** — "Color tokens"-এর টেবিলে `crit`-এর পরে এক সারি:

```
| `overlay` | `rgb(15 23 40 / .45)` | `rgb(0 0 0 / .6)` | Dialog backdrop only |
```

"Components"-এ, Dropdown menu-র পরে:

> - **Dialog:** `surface`, 1px `line`, radius 14px, `shadow-lg`, max-width 520px, padding 24px (18px on phones),
>   16px from the screen edges on phones and scrolls inside when tall. The backdrop is `overlay`, no blur. Header is
>   the card header (15px/600 title, 13px `ink-3` description) with a Close icon button; the footer is a right-aligned
>   button row above a 1px `line` rule, destructive or secondary actions pushed left. No animation.
> - **Select:** a native `<select>` inside the input box (same height, border, radius, focus), with an `ArrowDown01`
>   icon in `ink-3` on the right. Use it for fixed lists (currency, month, time zone); use a dropdown menu for actions.
> - **Text area:** the input box, three rows tall, resizes vertically only.

**build-plan.bn.md** — পর্ব ২-এর টেবিলে ধাপ ৬-এর "ব্যাকএন্ড" ঘরে `**audit log interceptor**` → `**audit()** (বদলের সাথে
একই transaction-এ, request-এর id/IP নিজে থেকে)`; "ফ্রন্টএন্ড" ঘরে যোগ: `ইউজারের ভাষা/থিম, Playwright e2e (MSW)`।
§৬-এর টেবিলে "নতুন টেবিলে RLS ভুলে যাওয়া"-র প্রশমন: `migration লিন্ট: …` → `rls-coverage টেস্ট (tenant-leak স্যুট): tenant_id-ওয়ালা
প্রতিটা টেবিলে FORCE RLS না থাকলে CI fail`। §১-এর Definition of Done-এ "Audit log-এ লেখা হচ্ছে" → "`audit()` একই
transaction-এ লিখছে, শুধু বদলানো ঘর"। §৯-এর অগ্রগতিতে এখনো টিক না — পর্ব ২ শেষ হবে ধাপ ৮-এ।

**COMMANDS.md** — "Checks"-এ:

```sh
pnpm test:e2e     # Playwright on the MSW mocks, desktop + 390px — no API or Docker needed
pnpm --filter @omnivo/app exec playwright install chromium   # once per machine, before the first test:e2e
```

আর "Run the full stack"-এর URL তালিকায়: `MinIO console: http://localhost:9001 (omnivo / omnivo-dev-secret) — uploaded
files are under the omnivo bucket, tenants/<tenant-id>/…`।

**README.md** — "Once `pnpm dev` is running" টেবিলে MinIO console-এর সারি, আর Getting started-এর নিচে এক লাইন:
"`.env` needs the `S3_*` lines from `.env.example` (step 6)"।

---

## ৬.১৩ — রান করুন

**১) `.env`-এ চারটা লাইন** (`.env.example`-এর শেষ অংশ)। এডিটরে খুলে ফাইলের শেষে বসান:

```sh
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=omnivo
S3_ACCESS_KEY_ID=omnivo
S3_SECRET_ACCESS_KEY=omnivo-dev-secret
```

⚠️ `echo '…' >> .env` দিয়ে যোগ করলে সাবধান: আপনার `.env` যদি `.env.example` থেকে কপি করা হয়ে থাকে, তার শেষ লাইনের পরে
newline নেই — নতুন লাইন আগের লাইনের সাথে জুড়ে যায় (`JWT_SECRET=…S3_ENDPOINT=…`), আর API বলবে `S3_ENDPOINT` নেই। যাচাইয়ের
সময় ঠিক এটাই হয়েছিল।

**২) বাকিটা:**

```bash
pnpm install                                  # AWS SDK, Playwright; lockfile আপডেট
pnpm dedupe --check
pnpm db:up                                    # MinIO আগে থেকেই compose-এ আছে
pnpm db:migrate                               # 0007 + 0008, তারপর নতুন permission Owner-দের
pnpm gen:openapi                              # openapi.json — ২১টা path, commit করুন
pnpm --filter @omnivo/app exec playwright install chromium   # একবারই
pnpm dev                                      # আগে থেকে চালু থাকলে বন্ধ করে আবার — নতুন env পড়তে
```

`pnpm db:migrate`-এর পরে psql-এ নিশ্চিত হওয়া (`pnpm db:psql`):

```sql
SELECT t.slug, count(rp.*) FROM tenants t
JOIN roles r ON r.tenant_id = t.id AND r.name = 'Owner'
JOIN role_permissions rp ON rp.role_id = r.id
GROUP BY 1;                                   -- প্রতিটা workspace-এ ৬
SELECT tenant_id, fiscal_year_start_month, timezone FROM tenant_settings;
SELECT code, name FROM branches;              -- প্রতিটা workspace-এ HO
```

### যা দেখবেন

1. ধাপ ৩–৫-এ বানানো **পুরনো** workspace দিয়ে লগইন → সাইডবারে নতুন "Workspace" দল: Branches, Numbering, Audit log,
   Settings। (Numbering আর Audit log দেখা মানে `grantOwnerPermissions` কাজ করেছে — না করলে এই দুটো লিংক থাকত না।)
   Branches-এ "HO · Head office" — migration 0008-এর backfill।
2. **Settings** → BIN-এ `12345` → "Save changes" → ঘরের নিচে "Enter the 13-digit BIN…", আর DevTools-এর Network-এ কোনো
   request নেই (ফর্মের নিজের যাচাই, একই চুক্তি)। `000123456-0101` আর কোম্পানির নাম বদলে সেভ → toast "Settings saved",
   সাইডবারের switcher-এ নতুন নাম; বাটন আবার বন্ধ (ফর্ম "অপরিবর্তিত")।
3. **দুই ট্যাব, একই সেটিংস:** প্রথমটায় আইনি নাম বদলে সেভ; দ্বিতীয়টায় (রিলোড না করে) ফোন বদলে সেভ → লাল বাক্স "Someone
   else saved changes while you were editing…" আর "Reload"। Reload → প্রথম ট্যাবের আইনি নাম দেখা যায়; ফোন আবার লিখে সেভ →
   সফল। Network-এ দ্বিতীয় ট্যাবের প্রথম `PUT /settings` = 409।
4. **লোগো:** একটা PNG → Network-এ ক্রম: `POST /attachments` (API) → `PUT http://localhost:9000/omnivo/tenants/…` (সরাসরি
   MinIO, API না) → `POST /attachments/…/complete` → `PUT /settings/logo`। লোগো কার্ডে ছবি। `http://localhost:9001`-এ
   (omnivo / omnivo-dev-secret) bucket `omnivo`-র ভেতরে `tenants/<আপনার-tenant-id>/company_logo/2026/09/<uuid>` — নামে
   ফাইলের নাম নেই। এবার একটা SVG বাছুন → "Use a PNG, JPG or WebP image." আর Network-এ কিছুই যায়নি।
5. **Branches** → "Add branch" → কোড `gzp`, নাম "Gazipur factory" → toast, তালিকায় `GZP` (বড় হাতে)। আবার `GZP` দিয়ে যোগ
   → কোডের ঘরের নিচে "Another branch already uses this code…" (সার্ভারের 409)। "Archived"-এ Gazipur; Head office archive
   করতে চাইলে (একমাত্র চালু) → dialog-এ "Keep at least one branch active…"।
6. **Numbering** → "Sales invoice" → dialog-এ উদাহরণ `INV-2026-27-0001`; prefix `si`, বছর "Calendar year", অঙ্ক ৫ →
   টাইপ করতে করতে `SI-2026-00001`। সেভ → টেবিলের "Next number"-এ সেটাই।
7. **Audit log** → উপরের প্রতিটা কাজ, নতুন আগে: কে, কখন (ঢাকার সময়), কী, আর শুধু বদলানো ঘর — "Company name: X → Y",
   "Logo: — → your-logo.png"। "Show" → "Sign-ins" → শুধু লগইন আর workspace-বদল। ভাষা বাংলা করলে "বিক্রয় ইনভয়েস",
   "ব্রাঞ্চ যোগ করেছেন", সময় বাংলা অঙ্কে।
8. user মেনু → Theme → Dark; Language → বাংলা। এবার অন্য ব্রাউজার বা incognito-তে একই অ্যাকাউন্টে লগইন → প্রথম পেজই dark
   আর বাংলায় (সার্ভার থেকে)। পেজ রিলোড করলে এক ঝলক সাদাও না (`index.html`-এর script)।
9. psql-এ (`pnpm db:psql`):
   ```sql
   SELECT action, entity_type, payload, request_id, ip_address, created_at
   FROM audit_logs ORDER BY created_at DESC LIMIT 5;
   ```
   `request_id` = সেই response-এর `x-request-id` header (DevTools → Network → Headers)।
10. `pnpm test:e2e` → "16 passed" (API বা Docker ছাড়া; আপনার চালু `pnpm dev` থাকলেও — আলাদা port)।
11. DevTools-এর device toolbar-এ ৩৯০px + dark → Branches কার্ডে, dialog দুই পাশে ১৬px ফাঁক রেখে, আড়াআড়ি scroll নেই।
12. `http://localhost:3000/docs` → Scalar-এ নতুন ছয়টা গ্রুপ: me, settings, branches, numberSeries, audit, attachments।

---

## যাচাইয়ের তালিকা

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # ৯০টা: contracts ২৮ + api ১৮ + ui ১৬ + i18n ১১ + app ১০ + auth ৭
pnpm test:integration        # ৫৪টা (Docker): auth ২০ + settings ১০ + branches ৭ + numbering ৬ + audit ৬ + members ৫
pnpm test:tenant-leak        # ১৪টা: RLS ৬ + members ৩ + core-platform ৪ + rls-coverage ১
pnpm test:e2e                # ১৬টা: ৮টা flow × ডেস্কটপ আর ৩৯০px
pnpm build
pnpm test:bundle-size        # প্রথম লোড 165.2 KB gz; branches 66.8, numbering 62.1, audit-log 36.1, settings 34.8
pnpm test:openapi
pnpm boundaries
```

## যাচাইয়ের পথে যা ধরা পড়েছিল

গাইডে সবগুলো ঠিক করা আছে — আপনার হাতে একই জায়গায় আটকে গেলে চিনতে পারবেন:

- **CORS-এ PUT আটকে** — `@fastify/cors`-এর ডিফল্ট শুধু GET/HEAD/POST; শুধু আসল ব্রাউজারে ধরা পড়ে (৬.৩)।
- **presigned PUT Content-Type সই করে না** — `image/png`-এর ঠিকানায় `text/html` গিয়েছিল; `signableHeaders` (৬.৩)।
- **SDK-র checksum** — MinIO দেখে না, S3 দেখে; `WHEN_REQUIRED` (৬.৩)।
- **migration 0007-এ FK index-এর আগে** — Postgres FK বানাতে দেয় না; একটা লাইন হাতে সরানো (৬.২)।
- **TypeScript-এর union-spread ফাঁক** — DB-র পুরো রো (Date সহ) audit-এর `diff()`-এ টাইপ-চেক পেরিয়ে গিয়েছিল (৬.৪)।
- **race টেস্ট কিছু প্রমাণ করছিল না** — lock মুছলেও পাস; superuser-এর খোলা transaction দিয়ে নতুন করে লেখা (৬.৫)।
- **মাইক্রোসেকেন্ড দুই জায়গায় হারায়** — `Date`-cursor-এ, আর খালি postgres.js-এর `::timestamptz` প্যারামিটারে (৬.৪, ৬.৫)।
- **`auth.int.spec.ts`-এর হাতে লেখা permission-তালিকা** — নতুন permission-এ ভাঙে; catalog থেকে (৬.৫)।
- **i18n build ভাঙা** ("missing … bin_format…") — ইচ্ছাকৃত; contracts-এর নতুন code-এর অনুবাদ চায় (৬.১, ৬.৬)।
- **ESLint:** rest-destructuring-এর অব্যবহৃত `_version` (`no-unused-vars`) — `version` নিজেই শর্তে ব্যবহার; এক purpose-এর
  `if` "সবসময় false" (`no-unnecessary-condition`) — শর্ত query-তে; `fetchQuery` deprecated → `query()` (৬.৪, ৬.৮)।
- **audit টেবিলে ক্লায়েন্ট-sort** — হেডারে ↑↓ দেখা গিয়েছিল; `enableSorting: false` (৬.৮)।
- **audit-এ uuid আর "Address"** — লোগোর বদলে ফাইলের নাম, slug-এর লেবেল "Workspace address" (৬.৪, ৬.৬)।
- **ফোনে audit-এর কার্ড `<li>`, button না** — e2e helper আলাদা (৬.১০)।
- **অস্থির e2e** — `isVisible()` দিয়ে সিদ্ধান্ত; viewport দেখে (৬.১০)।
- **pnpm-এর `minimumReleaseAge`** — AWS SDK-র নতুনতম সংস্করণে নিজে থেকে exclude লিখেছিল; `^3.1141.0` (৬.১১)।
- **`.env`-এ newline নেই** — জুড়ে যাওয়া লাইন (৬.১৩)।

---

## পরের ধাপগুলোর জন্য রেখে যাওয়া নোট

**প্রতিটা নতুন লেখার কাজে (ধাপ ৭ থেকে সবসময়):** service-এর transaction-এর ভেতরে `audit(tx, …)`, আর `AUDIT_ACTIONS`-এ
নতুন action + `en.ts`/`bn.ts`-এর `audit.actions`-এ লেখা। `diff()`-এ ঘর বেছে পাঠান, কখনো পুরো রো spread না (৬.৪-এর ফাঁক)।
নতুন tenant-টেবিলের migration-এ RLS ভুলে গেলে `rls-coverage` টেস্ট ধরবে। master ডেটায় `version` + `FOR UPDATE` +
`versionConflict()` — ব্রাঞ্চের ছাঁদ।

**ধাপ ৭ (users, roles):**

- `PermissionKey` contracts-এ সরানো — UI-র `me.permissions.includes('core.settings.manage')` তখন টাইপ-চেকড।
- invite, রোল বদল, সদস্য বাদ — প্রতিটায় audit (`member.invited`, `role.updated`…) আর `PermissionService.invalidate()`।
- **Owner-এর নকশা:** এখন "সব permission" ডেটায় লেখা, আর `grantOwnerPermissions` প্রতিটা deploy-এ টেন্যান্টপ্রতি একটা
  transaction চালায়। কাস্টম রোল আসার সময় ঠিক করুন: Owner একটা "system role" (কোডে সব অধিকার, মোছা যায় না) হবে কি না —
  তাহলে এই loop আর লাগবে না।
- ব্রাঞ্চভিত্তিক অধিকার ("শুধু Gazipur") — `membership_branches` টেবিল, আর ব্রাঞ্চের composite FK তৈরি আছে।

**ধাপ ৮ (worker, outbox):**

- `pending` attachment মোছার দৈনিক job — ২৪ ঘণ্টার পুরনো `pending` রো আর তার storage-ফাইল (`StorageService.delete`)।
- worker-এর audit: `currentRequest()` undefined → request-এর কলাম NULL, principal নেই → `actorUserId` null ("সিস্টেম") —
  কোড বদলাতে হবে না। টেন্যান্ট আসবে job-এর `set_config` থেকে (`audit()` সেটাই পড়ে)।
- provisioning job-এ সরলে `tenant_settings` আর "Head office"-এর insert সাথে যাবে — idempotent (`ON CONFLICT DO NOTHING`)।
- onboarding wizard-এর "Fiscal year" ধাপ এই ধাপের `PUT /settings`-ই ডাকবে।

**ধাপ ১০ (journal):** নম্বর `numbering.next(tx, 'accounting.journal', entry.date)`, journal-এর নিজের transaction-এ।
প্রথম পোস্টিংয়ের পরে `baseCurrency` আর `fiscalYearStartMonth` বদলানো বন্ধ — `SettingsService.update`-এ চেক আর নতুন code
(`settings_locked`)।

**ধাপ ১৫ (ইনভয়েস):** নম্বর `numbering.next(tx, 'sales.invoice', invoice.date)`; ইনভয়েসের টেবিলে `UNIQUE (tenant_id,
number)` — কাউন্টারের পরেও শেষ পাহারা। `branch_id` composite FK `(tenant_id, branch_id)` → `branches_tenant_id_idx`।

**ধাপ ১৭ (PDF):** লোগো `StorageService` দিয়ে সরাসরি পড়া (worker-এ), presigned URL না।

**ধাপ ১৯ (PWA):** `index.html`-এর inline script আর service worker — precache-এ HTML নতুন হলে script-ও নতুন।

**ধাপ ২৫ (লঞ্চের আগে):**

- **Cloudflare-এর পেছনে IP:** Fastify-র `trustProxy` (শুধু Cloudflare-এর IP রেঞ্জ) — নাহলে audit-এ প্রতিটা IP Cloudflare-এর।
  কখনো সরাসরি `x-forwarded-for` পড়বেন না।
- R2-এ আপলোড চালিয়ে দেখা (checksum, Content-Type-এর সই); bucket IaC-তে, CORS rule শুধু app-এর origin; API-র চাবি শুধু
  সেই bucket-এ, bucket বানানোর অধিকার ছাড়া।
- CSP: `index.html`-এর inline থিম-script-এর hash `script-src`-এ।
- audit log-এর মেয়াদ আর partition (মাসভিত্তিক), আর আলাদা storage-এ রপ্তানি (system-design §১১)।

**সতর্কতা:** audit লিখতে কখনো `db` (transaction-এর বাইরে) না — `audit()`-এর প্রথম প্যারামিটার `Transaction` ইচ্ছা করে। আর
storage-এর ঠিকানা (presigned URL) কখনো লগে লিখবেন না — সই করা URL মানে সেই সময়ের জন্য ফাইলের চাবি।
