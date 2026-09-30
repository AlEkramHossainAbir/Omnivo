# ধাপ ৭: ইউজার ও রোল — invite (ইমেইলে), কাস্টম রোল, permission matrix, সদস্য ব্যবস্থাপনা

> [build-plan.bn.md](build-plan.bn.md)-এর "পর্ব ২ → ধাপ ৭"-এর ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী লিখতে
> হবে, কোন কমান্ড কোথায় চালাতে হবে।
>
> এই গাইডের প্রতিটা ফাইল রিপোর একটা আলাদা কপিতে (ধাপ ৬-এর পরের commit `16c6567`-এর উপর) বসিয়ে যাচাই করা
> (২০২৬-০৯-৩০): `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (৯৫টা — নতুন ৫টা), `pnpm test:integration`
> (৭৮টা — নতুন ২৪টা), `pnpm test:tenant-leak` (১৮টা — নতুন ৪টা), `pnpm build`, `pnpm test:bundle-size` (প্রথম লোড 169.2 KB gz,
> বাজেট 200), `pnpm gen:openapi` (৩১টা path), `pnpm boundaries` আর `pnpm test:e2e` (Playwright, ৩০টা — নতুন ১৪টা,
> ডেস্কটপ আর ৩৯০px, পরপর তিনবার) — সব পাস, turbo cache মুছে।
>
> আরও যা করে দেখা:
>
> - **আসল ইমেইল:** integration টেস্ট Mailpit-এর container তোলে, invite পাঠায়, Mailpit-এর HTTP API থেকে চিঠি পড়ে
>   লিংকের token বের করে, আর সেই লিংক দিয়েই অ্যাকাউন্ট খুলে workspace-এ ঢোকে। SMTP বন্ধ থাকলে কী হয় সেটাও আলাদা
>   টেস্ট।
> - **প্রতিটা পাহারা-টেস্ট ইচ্ছা করে ভেঙে দেখা:** "শেষ owner"-এর lock মুছলে race টেস্ট fail করে; রোল বদলের পরে cache
>   না মুছলে "পরের request-এই নতুন অধিকার" টেস্ট fail করে; guard বাদ পড়া সদস্যকে না আটকালে "টোকেন থাকলেও 401"
>   টেস্ট fail করে; escalation-এর নিয়ম তুলে দিলে দুটো টেস্ট fail করে; ইমেইলের HTML escape তুলে দিলে phishing টেস্ট
>   fail করে; matrix সেভের পরে cache না মুছলে টেস্ট fail করে।
>
> ⚠️ **যা যাচাই হয়নি:** (১) আপনার নিজের `.env` আর dev DB-তে `pnpm dev` — `.env`-এ নতুন `SMTP_URL` লাইন না দিলে API
> চালুই হবে না (৭.১৩)। (২) আসল SMTP সার্ভার (Gmail, SES, Mailgun) — শুধু Mailpit। (৩) GitHub Actions-এ নতুন টেস্টগুলো।
> (৪) আপনার dev DB-তে migration 0010-এর backfill — Testcontainers-এর নতুন DB-তে চলেছে, যেখানে আগে থেকে কোনো
> workspace ছিল না; পুরনো workspace-এর "Owner" রোল `kind = 'owner'` হচ্ছে কি না সেটা ৭.১৩-এর SQL দিয়ে দেখে নিন।

## লক্ষ্য

👥 **একা মালিক থেকে একটা টিম।** পেছনে যা তৈরি হবে:

- **ইমেইলে invite:** "Invite people" → ইমেইল আর রোল → চিঠি যায় (dev-এ Mailpit, `http://localhost:8025`)। লিংক
  ৭ দিন কাজ করে, একবারই। নতুন মানুষ নাম আর পাসওয়ার্ড দিয়ে অ্যাকাউন্ট খোলে; যার আগে থেকে Omnivo অ্যাকাউন্ট আছে
  (যেমন একজন অ্যাকাউন্ট্যান্ট যিনি পাঁচটা কোম্পানির হিসাব দেখেন) সে শুধু পাসওয়ার্ড দেয়। খোলা invitation-এর
  তালিকা, আবার পাঠানো (নতুন লিংক, পুরনোটা অচল), বাতিল।
- **কাস্টম রোল:** Accountant, Merchandiser, Store keeper — workspace নিজে বানায়, নাম বদলায়, মোছে (কারো না থাকলে)।
- **permission matrix:** রোল × permission-এর চেকবক্সের ছক। কয়েকটা রোলের টিক একসাথে বদলে একবারে সেভ — হয় সব, নয়
  কিছুই না।
- **সদস্য ব্যবস্থাপনা:** টিমের পেজ, সদস্যের রোল বদল, workspace থেকে সরানো — সরানো মানুষ **পরের request-এই**
  আটকে যায়, টোকেনের বাকি ১৫ মিনিট অপেক্ষা না করে।
- **নিরাপত্তার তিন নিয়ম:** নিজের চেয়ে বেশি অধিকার কাউকে দেওয়া যায় না; নিজের রোল নিজে বদলানো যায় না; অন্তত একজন
  owner থাকবেই (দুজন owner একসাথে একে অন্যকে সরালেও)।
- **Owner = system role:** তার অধিকার কোডে লেখা, ডেটায় না — নতুন permission এলে কোনো backfill লাগে না।

## পুরো ছবিটা এক নজরে

```
packages/contracts   permissions (PERMISSION_KEYS — এখন এখানে, db-তে না) · roles · invitations · members (+ রোল বদল)
      │                RouteDef.permission — চুক্তিতেই "কোন permission লাগে"; OpenAPI-তে x-permission
      ▼
packages/db          roles.kind ('owner' | 'custom') + description · invitations · invitation_roles
                     migration 0009 (drizzle) + 0010 (পুরনো Owner → kind, RLS, invitation_by_token policy)
      │              grantOwnerPermissions() বাদ
      ▼
apps/api             PermissionGuard ── প্রতিটা লগইন-করা request: সদস্যপদ আছে? (না থাকলে 401) → চুক্তির permission
                     PermissionService.forPrincipal → { roles, permissions, owner } (Redis, ১০ মিনিট)
                     grants.ts: assertCanGrant — নিজের সীমার বাইরে কিছু দেওয়া/কাড়া যায় না
                     roles/  members/  invitations/  mail/ (nodemailer → Mailpit)
      │
      ▼
apps/app             /team (সদস্য + খোলা invitation + invite মডাল)   /roles (permission matrix)
                     /invite#<token> (public join পেজ)   useCan('core.user.invite') — টাইপ-চেকড

invite:
  admin ──POST /invitations──► API: invitation + invitation_roles + audit (এক tx) → commit → SMTP → sent_at
  ইমেইল: {APP_ORIGIN}/invite#<token>          (token # -এর পরে — কোনো সার্ভারের লগে যায় না)
  invitee ──POST /invitations/lookup {token}──► কোন workspace, কে ডেকেছে, অ্যাকাউন্ট আছে কি না
  invitee ──POST /invitations/accept──► অ্যাকাউন্ট (নতুন/পুরনো) → সদস্যপদ + রোল → session (লগইনের মতো)
```

## এই ধাপের ভিত্তি-সিদ্ধান্ত

1. **invite যায় ইমেইলে, এখনই — SMTP দিয়ে, commit-এর পরে।** (আপনি বেছে নিয়েছেন, ২০২৬-০৯-২৯।) লিংক কপি করে দেওয়ার
   বিকল্পে দুর্বলতা ছিল: লিংক যার হাতে সে-ই সেই ইমেইলের মালিক সেজে অ্যাকাউন্ট খুলতে পারত। ইমেইলে পাঠালে লিংক পাওয়াই
   ইমেইলের মালিকানার প্রমাণ। পাঠানো হয় transaction commit হওয়ার **পরে** — ভেতরে পাঠালে চিঠি চলে গিয়ে পরে rollback
   হতে পারত (অচল লিংক), আর ধীর SMTP পুরো সময় DB-র lock ধরে রাখত। পাঠানো ব্যর্থ হলে invitation থাকে, `sent_at` NULL
   থাকে, UI "Email not sent" দেখায়, "Resend" নতুন লিংক পাঠায়। ধাপ ৮-এর outbox এটাকে পাকা করবে (worker আবার চেষ্টা
   করবে) — তখনো `MailService` একই থাকবে, শুধু ডাকবে worker।
2. **Owner একটা system role: `roles.kind = 'owner'`, অধিকার কোডে।** (আপনি বেছে নিয়েছেন।) ধাপ ৬ পর্যন্ত owner-এর
   "সব permission" `role_permissions`-এ লেখা ছিল, আর প্রতিটা deploy-এ `grantOwnerPermissions()` টেন্যান্টপ্রতি একটা
   transaction চালাত। এখন `PermissionService` owner দেখলে catalog-এর সব key নিজেই দেয় — loop বাদ, backfill বাদ, আর
   matrix-এ owner-এর কলাম টিক-দেওয়া ও বন্ধ। নাম, permission আর মোছা — তিনটাই বন্ধ (`owner_role_locked`)। প্রতিটা
   workspace-এ ঠিক একটা owner রোল — partial unique index পাহারা দেয়।
3. **একজনের একাধিক রোল, অধিকার = যোগফল।** (আপনি বেছে নিয়েছেন।) DB আগে থেকেই many-to-many (`membership_roles`)।
   "Accountant + Store keeper" — নতুন রোল বানাতে হয় না।
4. **ব্রাঞ্চভিত্তিক অধিকার এই ধাপে না।** (আপনি বেছে নিয়েছেন।) এখনো কোনো ইনভয়েস বা স্টক নেই যা ব্রাঞ্চ দিয়ে ছাঁকা হবে —
   নিয়মটা পরীক্ষা করার কিছু নেই। প্রথম ব্রাঞ্চ-ডেটার সাথে (ধাপ ১৩/১৫) `membership_branches`।
5. **কোন permission লাগবে সেটা চুক্তিতে (`RouteDef.permission`), decorator-এ না।** ধাপ ৫-এর নোট অনুযায়ী
   `PermissionKey` এখন `packages/contracts`-এ। `@RequirePermission` decorator বাদ: `PermissionGuard` নিজেই
   `routeOf(context).permission` পড়ে। তাই চুক্তি, OpenAPI (`x-permission`) আর আসল পাহারা — তিনটা কখনো আলাদা হতে
   পারে না, আর UI-র `useCan('core.user.invite')`-ও টাইপ-চেকড।
6. **বাদ পড়া সদস্য পরের request-এই আটকায়।** access token ১৫ মিনিট বৈধ — ধাপ ৬ পর্যন্ত বাদ পড়া মানুষ সেই সময়টুকু
   permission ছাড়া রুটগুলো (ব্রাঞ্চের তালিকা, সেটিংস পড়া) চালাতে পারত। এখন `PermissionGuard` **প্রতিটা** লগইন-করা
   request-এ `forPrincipal()` ডাকে; সদস্যপদ না থাকলে `null` → 401 `access_revoked` → app-এর refresh-ও ব্যর্থ →
   লগইন পেজ। দাম: প্রতি request-এ একটা Redis GET (permission-ওয়ালা রুটে আগেও ছিল)।
7. **cache মোছা commit-এর পরে।** রোল বদলানোর কোড `PermissionService.invalidate()` ডাকে transaction শেষ হওয়ার পরে।
   আগে মুছলে commit-এর আগের মুহূর্তে আসা আরেকটা request পুরনো অধিকার DB থেকে পড়ে আবার ১০ মিনিটের জন্য cache করে
   ফেলত।
8. **escalation বন্ধ — "নিজের যা আছে তার বেশি দেওয়া যায় না"।** invite, সদস্যের রোল বদল আর matrix-এর টিক — তিন জায়গাতেই
   একই নিয়ম (`grants.ts`): যে রোল দেওয়া বা কেড়ে নেওয়া হচ্ছে তার সব permission তোমার থাকতে হবে; owner রোল দেওয়া বা
   কেড়ে নেওয়া শুধু owner পারে। নাহলে `core.user.manage` পাওয়া একজন store keeper নিজের আরেকটা অ্যাকাউন্টকে Accountant
   বানিয়ে নিত।
9. **নিজের রোল নিজে বদলানো বা নিজেকে সরানো যায় না** (`own_membership`)। এক জায়গায় দুটো ঝুঁকি বন্ধ: ভুল করে নিজেকে
   লক-আউট, আর নিজেকে বড় রোল দেওয়া। "workspace ছেড়ে যাওয়া" পরে আলাদা কাজ।
10. **"অন্তত একজন owner" — সব owner-এর রো lock করে।** ধাপ ৬-এর ব্রাঞ্চের write skew-এর একই ছাঁদ: দুই owner একসাথে
    একে অন্যকে সরালে দুজনেই "আরেকজন তো আছে" দেখত। তাই owner-দের `membership_roles` রো `FOR UPDATE`, id-র ক্রমে —
    দ্বিতীয়জন অপেক্ষা করে, তারপর Postgres রো আবার দেখে, আর মোছা রো আর পায় না (৭.৪, ৭.৫-এ প্রমাণ)।
11. **invitation-এর token URL-এর `#`-এর পরে, আর API-তে POST body-তে।** fragment ব্রাউজার কখনো সার্ভারে পাঠায় না, তাই
    app-এর CDN/hosting-এর access log বা `Referer`-এ token লেখা হয় না। lookup-ও `GET /invitations/:token` না, `POST`
    body — API-র access log-এও না। DB-তে শুধু SHA-256 (refresh token-এর মতো)।
12. **token দিয়ে খোঁজা RLS ভেঙে না — নতুন policy দিয়ে।** লিংক খোলা মানুষ এখনো কোনো টেন্যান্টে নেই, তাই tenant context
    নেই, আর `invitations`-এ FORCE RLS। ধাপ ৩-এর `own_memberships`-এর ছাঁদে `invitation_by_token`: শুধু SELECT, শুধু
    সেই রো যার hash এই transaction-এ বসানো। লেখা (গ্রহণ) হয় টেন্যান্ট জেনে, সাধারণ `tenant_isolation` দিয়ে।
13. **সদস্যপদ মোছা হয় না, বন্ধ হয় (`deleted_at`), আর আবার invite করলে একই রো ফেরে।** `(tenant_id, user_id)` unique
    index-এর কারণে নতুন রো হতেও পারে না; ফেরানো সদস্যের পুরনো audit একই সদস্যপদে জোড়া থাকে। তার পুরনো রোল ফেরে না —
    শুধু নতুন invitation-এর রোল।
14. **রোল মোছা যায় শুধু কারো না থাকলে, আর কোনো খোলা invitation সেটা না দিলে** (`role_in_use`)। চুপচাপ মুছলে কারো
    অধিকার হঠাৎ চলে যেত। গোনা আর মোছার মাঝে আরেকজন কাউকে রোলটা দিয়ে ফেললে FK-ই শেষ পাহারা।

## এই ধাপে যা ইচ্ছাকৃতভাবে নেই

| জিনিস | কেন এখন না / কখন আসবে |
|---|---|
| ব্রাঞ্চভিত্তিক অধিকার | ভিত্তি-সিদ্ধান্ত ৪ — প্রথম ব্রাঞ্চ-ডেটার সাথে (ধাপ ১৩/১৫) |
| ইমেইল outbox আর আবার চেষ্টা | ধাপ ৮-এর worker। এখন ব্যর্থ হলে "Email not sent" + হাতে "Resend" |
| workspace ছেড়ে যাওয়া ("Leave") | নিজেকে সরানো এখন বন্ধ (ভিত্তি-সিদ্ধান্ত ৯); শেষ owner-এর নিয়ম সহ আলাদা endpoint পরে |
| সদস্যকে সাময়িক বন্ধ (suspend) | এখন "সব রোল তুলে নেওয়া" দিয়ে একই ফল — সদস্য লগইন করে কিন্তু কিছু পারে না |
| invite-এর মাধ্যমে ইমেইল যাচাই (`email_verified`) | লিংক ইমেইলে গেছে, তাই যাচাই হয়েই আছে — কিন্তু কলামটা এখনো কেউ পড়ে না; পাসওয়ার্ড রিসেটের সাথে (ধাপ ২৫) |
| invitation-এর rate limit | token 256-bit, অনুমান অসম্ভব; সাধারণ rate limiting ধাপ ২৫-এ |
| bulk invite (CSV) | SME-তে একসাথে ৫–১০ জন; পরে দরকার দেখে |
| রোলের "কপি থেকে তৈরি" | matrix-এ টিক দেওয়াই যথেষ্ট দ্রুত |
| owner transfer (একমাত্র owner সরে যাওয়া) | এখন: আরেকজনকে owner বানিয়ে তারপর — আলাদা flow লাগে না |
| ইমেইলের টেমপ্লেট-সিস্টেম | একটাই চিঠি; ধাপ ৮-এর notification-এর সাথে (এখন দুই ভাষার লেখা `invitation-email.ts`-এ) |

## আগের কোড থেকে যা বাদ বা বদল হচ্ছে

- **`.env`-এ নতুন লাইন বাধ্যতামূলক:** `SMTP_URL` (আর ঐচ্ছিক `MAIL_FROM`)। না দিলে API চালু হওয়ার সময়ই "Invalid
  environment" বলে থামবে — ধাপ ৬-এর S3-এর মতো ইচ্ছা করে।
- `apps/api/src/rbac/require-permission.decorator.ts` → **মুছে ফেলুন।** কোন permission লাগবে সেটা এখন চুক্তিতে
  (`permission: 'core.branch.manage'`)। settings, branches, numbering, audit, members, attachments — প্রতিটা controller
  থেকে `@RequirePermission(...)` লাইন আর তার import বাদ।
- `PermissionKey` আর permission-এর তালিকা `packages/db` থেকে `packages/contracts/src/permissions.ts`-এ। db-র
  `PERMISSIONS` এখন contracts-এর key থেকে বানানো (শুধু বিবরণ db-তে)।
- `grantOwnerPermissions()` → **বাদ** (`permission-catalog.ts`, `migrate.ts`, `testing/containers.ts`)। Owner-এর পুরনো
  `role_permissions` রো migration 0010 মুছে দেয়।
- `auth.service.ts`: signup আর owner রোলে `role_permissions` লেখে না, `kind: 'owner'` দেয়; `me()`-র roles/permissions
  টোকেন থেকে না, এখনকার অবস্থা থেকে; নতুন তিনটা public method (`createAccount`, `verifyPassword`, `startSessionIn`) —
  invitation গ্রহণ লগইনের একই কোড ব্যবহার করে।
- `PermissionService.forPrincipal()` এখন `Set<string>` না, `Access | null` ফেরায়; `invalidate(tenantId, userIds[])` —
  একটা না, তালিকা।
- `GET /members`-এর উত্তরে `roles` এখন `{ id, name }[]` (আগে `string[]`), আর নতুন `version`, `joinedAt`। list-এর কোড
  controller থেকে `members.service.ts`-এ।
- টিমের তালিকা **ড্যাশবোর্ড থেকে `/team`-এ।** `dashboard.tsx`-এর `MembersSection` আর `en.ts`/`bn.ts`-এর
  `dashboard.team*`, `dashboard.columns`, `dashboard.noRole`, `dashboard.loadingMore` বাদ।
- UI-র `me.permissions.includes('…')` (৬ জায়গায়) → `useCan()('…')` — টাইপ-চেকড।
- `auth.int.spec.ts`: permission cache-এর টেস্ট owner-এর `role_permissions` মুছে দেখাত — owner-এর অধিকার এখন কোডে,
  তাই সেই টেস্ট একটা কাস্টম রোল দিয়ে নতুন করে লেখা।
- mock: `MockProblem` `workspace-data.ts` থেকে `mock.ts`-এ (নতুন `people-data.ts`-এর সাথে circular import এড়াতে);
  `fixtures.ts`-এর `MEMBERS` → `people-data.ts`-এর `seedPeople()`।
- `Checkbox`-এর বাইরের `div`-এ `relative` (ফোনে পেজ চওড়া হওয়ার বাগ, ৭.৭)।

---

## ৭.১ — `packages/contracts`: চুক্তি

সবার আগে, আগের ধাপের মতোই: API, app, mock আর DB — সবাই এখান থেকে টাইপ নেয়।

### permission-এর তালিকা

**ফাইল: `packages/contracts/src/permissions.ts`** (নতুন)

```ts
// সিস্টেম-জোড়া permission-এর একমাত্র তালিকা। API-র guard, DB-র catalog, UI-র matrix আর অনুবাদ —
// সবাই এখান থেকে টাইপ পায়। নতুন permission = এখানে এক লাইন + en.ts/bn.ts-এ তার লেখা (না লিখলে
// typecheck fail) + packages/db-র বিবরণ। নাম: module.resource.action (system-design §৩.১০)
export const PERMISSION_KEYS = [
  'core.user.read',
  'core.user.invite',
  'core.user.manage',
  'core.role.manage',
  'core.settings.manage',
  'core.branch.manage',
  'core.audit.read',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// me.permissions আর role.permissions তারে z.string() (নতুন সার্ভারের নতুন key পুরনো অফলাইন ক্লায়েন্টে
// parse ভাঙে না) — UI এই guard দিয়ে চেনা key-তে নামায়, cast ছাড়া
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEYS.some((key) => key === value);
}

// matrix-এর সারি কোন দলে: key-র মাঝের অংশ (resource) দিয়ে না, হাতে বাছা — "Team" দলে user আর role
// দুটোই থাকে, কারণ মানুষ দুটোকে একই কাজ ভাবে। Record<PermissionKey, …>: নতুন key দল ছাড়া থাকতে পারে না
export const PERMISSION_GROUPS = ['team', 'workspace'] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const PERMISSION_GROUP_OF = {
  'core.user.read': 'team',
  'core.user.invite': 'team',
  'core.user.manage': 'team',
  'core.role.manage': 'team',
  'core.settings.manage': 'workspace',
  'core.branch.manage': 'workspace',
  'core.audit.read': 'workspace',
} as const satisfies Record<PermissionKey, PermissionGroup>;
```

- `PERMISSION_KEYS` `as const` — `PermissionKey` এর থেকেই union টাইপ। ধাপ ৩ থেকে এটা `packages/db`-তে ছিল; সেখানে থাকলে
  UI (যে db import করতে পারে না — `browser-packages-not-to-server` নিয়ম) টাইপটা পেত না।
- নতুন key একটাই: `core.user.manage` — "সদস্যের রোল বদলানো আর সরানো"। `core.user.invite` (শুধু ডাকা) থেকে আলাদা
  রাখা হলো, কারণ একজন HR assistant নতুন লোক ডাকতে পারে কিন্তু কাউকে সরাতে পারবে না — এটা বাস্তব ভাগ।
- `isPermissionKey` — তারে permission `z.string()` (নতুন সার্ভারের নতুন key পুরনো অফলাইন ক্লায়েন্টে parse না ভাঙুক,
  error code-এর মতোই); UI এই type guard দিয়ে চেনা key-তে নামায়, `as` ছাড়া।
- `PERMISSION_GROUP_OF` — `satisfies Record<PermissionKey, PermissionGroup>`: নতুন key যোগ করে দল না লিখলে compile
  error। দল key-র মাঝের অংশ থেকে না নিয়ে হাতে লেখা, কারণ "user" আর "role" মানুষের চোখে একটাই কাজ ("টিম")।

### চুক্তিতে permission

**ফাইল: `packages/contracts/src/http.ts`** (আপডেট)

```diff
--- a/packages/contracts/src/http.ts
+++ b/packages/contracts/src/http.ts
@@ -1,5 +1,7 @@
 import type { z } from 'zod';
 
+import type { PermissionKey } from './permissions.js';
+
 export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
 
 // একটা endpoint-এর পুরো চুক্তি: কোন method আর path, কী পাঠাতে হবে, কী ফেরত আসবে।
@@ -12,6 +14,9 @@ export interface RouteDef {
   summary: string;
   // 'public' = লগইন ছাড়া; বাকি সব Bearer টোকেন চায় (API-র global AuthGuard)
   auth: 'public' | 'bearer';
+  // এই কাজে কোন permission লাগে। API-র @Endpoint এখান থেকেই guard বসায় (আলাদা decorator নেই, তাই
+  // চুক্তি আর পাহারা কখনো আলাদা হয় না), আর OpenAPI-তে x-permission হয়ে দেখায়। না থাকলে = শুধু লগইন
+  permission?: PermissionKey;
   status: 200 | 201 | 204;
   params?: z.ZodObject;
   // querystring-এর সব মান string হয়ে আসে — সংখ্যা হলে z.coerce লাগবে
```

- `import type` — শুধু টাইপ, runtime-এ কিছু আনে না।
- `permission?` ঐচ্ছিক: না থাকা মানে "লগইন থাকলেই চলে" (যেমন ব্রাঞ্চের তালিকা)। একটাই key, array না — এখন পর্যন্ত
  প্রতিটা কাজে একটাই permission লাগে; দুটো লাগলে সেটা নকশার গন্ধ।

এরপর প্রতিটা বিদ্যমান চুক্তিতে `auth: 'bearer',`-এর ঠিক নিচে `permission`। controller-এর `@RequirePermission`-এ যা ছিল
হুবহু তাই:

| ফাইল | route | permission |
|---|---|---|
| `settings.ts` | `update`, `setLogo` | `core.settings.manage` |
| `branches.ts` | `create`, `update`, `archive`, `restore` | `core.branch.manage` |
| `numbering.ts` | `list`, `update` | `core.settings.manage` |
| `audit.ts` | `list` | `core.audit.read` |
| `attachments.ts` | `createUpload`, `complete` | `core.settings.manage` |
| `members.ts` | `list` | `core.user.read` (নিচের পুরো ফাইলে) |

যেমন `branches.ts`-এ:

```diff
--- a/packages/contracts/src/branches.ts
+++ b/packages/contracts/src/branches.ts
@@ -76,6 +76,7 @@ export const branchRoutes = {
     path: '/branches',
     summary: 'Add a branch',
     auth: 'bearer',
+    permission: 'core.branch.manage',
     status: 201,
     body: branchInputSchema,
     response: branchSchema,
@@ -85,6 +86,7 @@ export const branchRoutes = {
     path: '/branches/:id',
     summary: 'Edit a branch',
     auth: 'bearer',
+    permission: 'core.branch.manage',
     status: 200,
     params: branchParamsSchema,
     body: updateBranchInputSchema,
@@ -95,6 +97,7 @@ export const branchRoutes = {
     path: '/branches/:id/archive',
     summary: 'Archive a branch; at least one branch stays active',
     auth: 'bearer',
+    permission: 'core.branch.manage',
     status: 200,
     params: branchParamsSchema,
     body: branchVersionInputSchema,
@@ -105,6 +108,7 @@ export const branchRoutes = {
     path: '/branches/:id/restore',
     summary: 'Bring an archived branch back',
     auth: 'bearer',
+    permission: 'core.branch.manage',
     status: 200,
     params: branchParamsSchema,
     body: branchVersionInputSchema,
```

⚠️ একটাও বাদ পড়লে সেই রুট **পাহারাহীন** হয়ে যায় (guard আর decorator পড়ে না)। তাই বসানোর পরে
`grep -n "permission:" packages/contracts/src/*.ts` দিয়ে উপরের ১২টা গুনে নিন, আর ৭.৫-এর পুরনো টেস্টগুলো (viewer 403
পায়) এটা ধরবে।

### OpenAPI-তে permission

**ফাইল: `packages/contracts/src/openapi.ts`** (আপডেট)

```diff
--- a/packages/contracts/src/openapi.ts
+++ b/packages/contracts/src/openapi.ts
@@ -44,6 +44,12 @@ function operation(tag: string, name: string, route: RouteDef) {
     summary: route.summary,
     // খালি array = লগইন লাগে না; নাহলে global Bearer
     security: route.auth === 'public' ? [] : [{ bearer: [] }],
+    // OpenAPI-র নিজের "কোন permission" ঘর নেই; x- দিয়ে শুরু হওয়া extension যেকোনো tool মেনে নেয়।
+    // description-এও লেখা, কারণ Scalar-এর মতো viewer extension দেখায় না
+    ...(route.permission !== undefined && {
+      description: `Requires the \`${route.permission}\` permission.`,
+      'x-permission': route.permission,
+    }),
     parameters: [...parameters(route.params, 'path'), ...parameters(route.query, 'query')],
     ...(route.body && {
       requestBody: {
```

- `x-permission` — OpenAPI-র নিজের "authorization scope" ঘর OAuth-এর জন্য; `x-` দিয়ে শুরু হওয়া extension যেকোনো tool
  মেনে নেয় আর বাদ দেয় না।
- `description`-এও — Scalar (`/docs`) extension দেখায় না, কিন্তু description দেখায়। পার্টনার-ডেভেলপার (ধাপ ২৯) দেখবে কোন
  কাজে কী অনুমতি লাগে।

### নতুন error code

**ফাইল: `packages/contracts/src/errors.ts`** (আপডেট)

```diff
--- a/packages/contracts/src/errors.ts
+++ b/packages/contracts/src/errors.ts
@@ -34,6 +34,11 @@ export const ERROR_CODES = [
   'prefix_format',
   'file_type_not_allowed',
   'file_too_large',
+  'role_name_required',
+  'role_name_taken',
+  'role_required',
+  'already_member',
+  'already_invited',
   // auth ও অনুমতি
   'workspace_not_found',
   'invalid_credentials',
@@ -43,6 +48,12 @@ export const ERROR_CODES = [
   'access_revoked',
   'switch_denied',
   'permission_missing',
+  'invitation_invalid',
+  'cannot_grant',
+  'owner_role_locked',
+  'last_owner',
+  'own_membership',
+  'role_in_use',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- প্রথম পাঁচটা ফর্মের কোনো ঘরের (নাম, রোল, ইমেইল) — তাই "নির্দিষ্ট ফিল্ড" দলে; বাকিগুলো পুরো কাজের নিয়ম।
- যোগ করার সাথে সাথে `packages/i18n` ভাঙবে ("missing the following properties: role_name_required…") — ইচ্ছাকৃত,
  অনুবাদ ৭.৬-এ।

### audit-এর নতুন ঘটনা

**ফাইল: `packages/contracts/src/audit.ts`** (আপডেট)

```diff
--- a/packages/contracts/src/audit.ts
+++ b/packages/contracts/src/audit.ts
@@ -16,6 +16,16 @@ export const AUDIT_ACTIONS = [
   'branch.archived',
   'branch.restored',
   'number_series.updated',
+  'member.invited',
+  'member.invitation_resent',
+  'member.invitation_revoked',
+  'member.joined',
+  'member.roles_changed',
+  'member.removed',
+  'role.created',
+  'role.updated',
+  'role.deleted',
+  'role.permissions_changed',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -23,8 +33,17 @@ export function isAuditAction(value: string): value is AuditAction {
   return AUDIT_ACTIONS.some((action) => action === value);
 }
 
-// settings-এর entity = workspace নিজে (entityId = tenant id)
-export const AUDIT_ENTITY_TYPES = ['workspace', 'user', 'branch', 'number_series'] as const;
+// settings-এর entity = workspace নিজে (entityId = tenant id)। member = একজনের এই workspace-এর
+// সদস্যপদ (entityId = membership id), user = মানুষটা নিজে (লগইন) — একই মানুষ অন্য workspace-এও থাকে
+export const AUDIT_ENTITY_TYPES = [
+  'workspace',
+  'user',
+  'branch',
+  'number_series',
+  'member',
+  'invitation',
+  'role',
+] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
 // পুরনো আর নতুন মান শুধু সরল মান — পুরো object না। তাতে viewer-এ "নাম: X → Y" সোজা দেখানো যায়,
@@ -69,6 +88,7 @@ export const auditRoutes = {
     path: '/audit-logs',
     summary: 'Who changed what in the workspace, newest first',
     auth: 'bearer',
+    permission: 'core.audit.read',
     status: 200,
     query: auditListQuerySchema,
     response: auditPageSchema,
```

- `member` আর `user` আলাদা entity: `user` = মানুষটা (লগইন — একই মানুষ পাঁচটা workspace-এ), `member` = এই workspace-এ
  তার সদস্যপদ (রোল, সরানো)। audit-এর ফিল্টারে "Team" মানে এই workspace-এর টিমের বদল।
- `invitation` আলাদা: গ্রহণের আগে কোনো সদস্যপদ নেই, তাই invite, resend, বাতিল invitation-এর id-তে।

### রোল

**ফাইল: `packages/contracts/src/roles.ts`** (নতুন)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { PERMISSION_KEYS } from './permissions.js';

// owner = প্রতিটা workspace-এ ঠিক একটা, signup-এ তৈরি। তার অধিকার কোডে লেখা ("সব permission"),
// ডেটায় না — তাই নতুন permission এলে কোনো backfill লাগে না, আর নাম, permission বা মোছা বদলানো যায় না।
// custom = workspace নিজে বানায়, matrix-এ যা টিক দেওয়া ঠিক ততটুকু
export const ROLE_KINDS = ['owner', 'custom'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(ROLE_KINDS),
  // z.string(), enum না: নতুন সার্ভারের নতুন permission পুরনো অফলাইন ক্লায়েন্টে parse ভাঙে না
  // (audit action-এর মতোই); UI isPermissionKey() দিয়ে চেনে। owner-এর ক্ষেত্রে এখন চালু সব key
  permissions: z.array(z.string()),
  // কতজন সদস্যের এই রোল — মোছার আগে UI জানায়, আর matrix-এর কলামের নিচে দেখায়
  memberCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Role = z.infer<typeof roleSchema>;

// ছোট তালিকা (একটা কোম্পানিতে কয়েকটা রোল) — ব্রাঞ্চের মতো একবারে, পাতা ছাড়া (ধাপ ৬-এর নিয়ম)
export const roleListSchema = z.object({ items: z.array(roleSchema) });

export const roleInputSchema = z.object({
  name: z.string().trim().min(2, errorCode('role_name_required')).max(60),
  description: optionalText(200),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const updateRoleInputSchema = roleInputSchema.extend({ version: versionSchema });

// DELETE-এর body অনেক proxy ফেলে দেয় — তাই version query-তে। querystring-এ সব string, তাই coerce
export const deleteRoleQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// matrix একসাথে সেভ: যতগুলো রোলের টিক বদলেছে, সবগুলো এক transaction-এ — অর্ধেক সেভ হয়ে বাকিটা
// version_conflict-এ আটকে থাকার অবস্থা নেই। প্রতিটার পুরো নতুন তালিকা (যোগ/বাদ আলাদা না): সার্ভার
// নিজেই আগের সাথে মিলিয়ে বদলটা বের করে, আর audit-এ শুধু সেটুকু লেখে
export const permissionMatrixInputSchema = z.object({
  roles: z
    .array(
      z.object({
        id: z.uuid(),
        version: versionSchema,
        permissions: z.array(z.enum(PERMISSION_KEYS)).max(PERMISSION_KEYS.length),
      }),
    )
    .min(1)
    .max(50),
});
export type PermissionMatrixInput = z.infer<typeof permissionMatrixInputSchema>;

const roleParamsSchema = z.object({ id: z.uuid() });

export const roleRoutes = {
  // পড়তে শুধু সদস্য হলেই চলে: invite আর সদস্যের রোল বদলানোর ফর্মে রোলের তালিকা লাগে, আর কোন রোল কী
  // পারে সেটা কোম্পানির ভেতরে গোপন কিছু না (ব্রাঞ্চের তালিকার মতো)
  list: defineRoute({
    method: 'GET',
    path: '/roles',
    summary: 'Roles of the active workspace, with their permissions',
    auth: 'bearer',
    status: 200,
    response: roleListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/roles',
    summary: 'Create a custom role, with no permissions yet',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 201,
    body: roleInputSchema,
    response: roleSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/roles/:id',
    summary: 'Rename a custom role or change its description',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 200,
    params: roleParamsSchema,
    body: updateRoleInputSchema,
    response: roleSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/roles/:id',
    summary: 'Delete a custom role that nobody has and no open invitation uses',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 204,
    params: roleParamsSchema,
    query: deleteRoleQuerySchema,
    response: z.void(),
  }),
  // build-plan-এর "permission matrix API": রোল × permission-এর ছক একবারে
  updateMatrix: defineRoute({
    method: 'PUT',
    path: '/permission-matrix',
    summary: 'Save the permissions of several roles at once',
    auth: 'bearer',
    permission: 'core.role.manage',
    status: 200,
    body: permissionMatrixInputSchema,
    response: roleListSchema,
  }),
};
```

- `memberCount` — matrix-এর কলামের নিচে "12 people", আর মোছার আগে বোঝা যায় কেন `role_in_use`।
- `name` `.max(60)`, lower-case-এ অনন্য (DB-র index, ৭.২)।
- `deleteRoleQuerySchema` — DELETE-এর body অনেক proxy আর কিছু HTTP client ফেলে দেয়; তাই version query-তে, আর
  querystring সবসময় string বলে `z.coerce.number<number>()` (ধাপ ৫-এর pagination-এর একই কৌশল: `<number>` দিলে input
  টাইপ `number`, `unknown` না)।
- `permissionMatrixInputSchema` — প্রতিটা রোলের **পুরো** নতুন তালিকা, "যোগ/বাদ" না। কারণ: ক্লায়েন্ট যা দেখছে সেটাই পাঠায়;
  সার্ভার আগের সাথে মিলিয়ে বদলটা নিজে বের করে। "যোগ করো X" পাঠালে দুই ট্যাব থেকে একই X দুবার যোগ, বা ইতিমধ্যে মোছা Y
  আবার "বাদ" — এসব আলাদা করে সামলাতে হতো; version থাকায় পুরো তালিকা নিরাপদ।
- `max(50)` রোল একবারে — সীমাহীন array দিয়ে কেউ বড় transaction চাপিয়ে দিতে পারে না।
- path `/permission-matrix`, `/roles/permissions` না: `PUT /roles/:id`-এর পাশে `PUT /roles/permissions` Fastify চালাত
  (static আগে), কিন্তু পড়তে গোলমেলে, আর কোনো দিন id-এর জায়গায় "permissions" গিয়ে পড়ার ঝুঁকি।

### সদস্য

**ফাইল: `packages/contracts/src/members.ts`** (পুরো ফাইল বদল)

```ts
import { z } from 'zod';

import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// রোলের নাম আর id দুটোই: তালিকায় নাম দেখায়, আর সদস্যের রোল বদলানোর ফর্ম id দিয়ে টিক বসায়
export const roleRefSchema = z.object({ id: z.uuid(), name: z.string() });
export type RoleRef = z.infer<typeof roleRefSchema>;

export const memberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  roles: z.array(roleRefSchema),
  // সদস্যপদের version — দুজন একসাথে একই সদস্যের রোল বদলালে দ্বিতীয়জন 409 পায়
  version: z.number().int(),
  joinedAt: z.iso.datetime(),
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

// রোলের পুরো নতুন তালিকা। ফাঁকা চলে — তখন সদস্য লগইন করতে পারে কিন্তু কিছুই করতে পারে না (যেমন কেউ
// ছুটিতে গেলে অধিকার তুলে রাখা, সদস্যপদ না মুছে)। max: একজনের দশটার বেশি রোল মানে রোলের নকশা ভুল
export const memberRolesInputSchema = z.object({
  roleIds: z.array(z.uuid()).max(10),
  version: versionSchema,
});
export type MemberRolesInput = z.infer<typeof memberRolesInputSchema>;

export const removeMemberQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

const memberParamsSchema = z.object({ id: z.uuid() });

export const memberRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/members',
    summary: 'People with access to the active workspace, one page at a time',
    auth: 'bearer',
    permission: 'core.user.read',
    status: 200,
    query: memberListQuerySchema,
    response: memberPageSchema,
  }),
  updateRoles: defineRoute({
    method: 'PUT',
    path: '/members/:id/roles',
    summary: "Replace a member's roles",
    auth: 'bearer',
    permission: 'core.user.manage',
    status: 200,
    params: memberParamsSchema,
    body: memberRolesInputSchema,
    response: memberSchema,
  }),
  // সদস্যপদ মোছা হয় না, বন্ধ হয় (deleted_at) — তার আগের কাজের audit আর created_by অক্ষত থাকে,
  // আর আবার invite করলে একই সদস্যপদ ফিরে আসে
  remove: defineRoute({
    method: 'DELETE',
    path: '/members/:id',
    summary: 'Remove someone from the workspace; their account stays',
    auth: 'bearer',
    permission: 'core.user.manage',
    status: 204,
    params: memberParamsSchema,
    query: removeMemberQuerySchema,
    response: z.void(),
  }),
};
```

- `roleRefSchema` — `{ id, name }`: তালিকায় নাম, আর রোল বদলানোর ফর্মে id দিয়ে টিক। invitation-ও একই আকার নেয়।
- `version` সদস্যপদের — দুজন admin একসাথে একই মানুষের রোল বদলালে দ্বিতীয়জন 409।
- `roleIds` ফাঁকা চলে (`max(10)`, `min` নেই) — "সব রোল তুলে নেওয়া" = সাময়িক বন্ধ, সদস্যপদ না মুছে।
- `remove` — `deleted_at`-এর কথা summary-তেই: "their account stays" (Better Auth-এর ইউজার অক্ষত, অন্য workspace-এ
  কাজ চলে)।

### invitation

`auth.ts`-এ তিনটা schema এখন `export` — invitation-ও ঠিক একই নিয়মে যাচাই করে:

**ফাইল: `packages/contracts/src/auth.ts`** (আপডেট)

```diff
--- a/packages/contracts/src/auth.ts
+++ b/packages/contracts/src/auth.ts
@@ -33,15 +33,16 @@ export const newWorkspaceSlugSchema = workspaceSlugFormat.refine(
   errorCode('slug_reserved'),
 );
 
-// trim/lowercase আগে, তারপর email যাচাই — ক্রম উল্টালে " A@b.com" ভুল হিসেবে ধরা পড়ত
-const emailSchema = z
+// trim/lowercase আগে, তারপর email যাচাই — ক্রম উল্টালে " A@b.com" ভুল হিসেবে ধরা পড়ত।
+// export: invite-এর ইমেইলও ঠিক এই নিয়মে — নাহলে "Nasrin@…" invite হয়ে "nasrin@…" অ্যাকাউন্টে মিলত না
+export const emailSchema = z
   .string()
   .trim()
   .toLowerCase()
   .pipe(z.email(errorCode('email_invalid')));
 
-// Better Auth-এর maxPasswordLength ডিফল্ট 128 — দুই জায়গায় একই সীমা
-const newPasswordSchema = z
+// Better Auth-এর maxPasswordLength ডিফল্ট 128 — দুই জায়গায় একই সীমা। invite নিয়ে নতুন অ্যাকাউন্টেও একই
+export const newPasswordSchema = z
   .string()
   .min(8, errorCode('password_too_short'))
   .max(128, errorCode('password_too_long'));
@@ -53,10 +54,12 @@ export const companyNameSchema = z
   .min(2, errorCode('company_name_required'))
   .max(120);
 
+export const fullNameSchema = z.string().trim().min(2, errorCode('full_name_required')).max(120);
+
 export const signUpInputSchema = z.object({
   companyName: companyNameSchema,
   workspaceSlug: newWorkspaceSlugSchema,
-  fullName: z.string().trim().min(2, errorCode('full_name_required')).max(120),
+  fullName: fullNameSchema,
   email: emailSchema,
   password: newPasswordSchema,
 });
```

- `emailSchema` export: invite-এর ইমেইল আর সাইনআপের ইমেইল একই trim/lowercase-এ — নাহলে "Nasrin@…" invite হয়ে
  "nasrin@…" অ্যাকাউন্টের সাথে মিলত না, আর "already_member" ধরা পড়ত না।
- `fullNameSchema` আলাদা করা — invitation-এ নতুন অ্যাকাউন্টের নাম একই নিয়মে (`full_name_required`)।

**ফাইল: `packages/contracts/src/invitations.ts`** (নতুন)

```ts
import { z } from 'zod';

import { authSessionSchema, emailSchema, fullNameSchema, newPasswordSchema } from './auth.js';
import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { roleRefSchema } from './members.js';

// ইমেইলের লিংক: {APP_ORIGIN}/invite#<token>। token path বা query-তে না, # (fragment)-এর পরে — ব্রাউজার
// fragment কখনো সার্ভারে পাঠায় না, তাই app-এর hosting/CDN-এর access log-এ বা Referer header-এ token
// লেখা হয় না। API (ইমেইল লেখে) আর app (পেজ পড়ে) দুজনেই এই ফাংশন থেকে, তাই path কখনো আলাদা হয় না
export const INVITE_PATH = '/invite';

export function invitationLink(appOrigin: string, token: string): string {
  return `${appOrigin}${INVITE_PATH}#${token}`;
}

// এক সপ্তাহ: সাপ্তাহিক ছুটি পেরিয়েও কাজ করে, আবার পুরনো ইমেইলে পড়ে থাকা লিংক চিরকাল খোলা থাকে না
export const INVITATION_TTL_DAYS = 7;

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  roles: z.array(roleRefSchema),
  // null = যিনি পাঠিয়েছিলেন তাঁর অ্যাকাউন্ট আর নেই
  invitedBy: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  // null = ইমেইল যায়নি (mail server বন্ধ ছিল) — UI "Not sent" দেখায়, "Resend" নতুন লিংক পাঠায়
  sentAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type Invitation = z.infer<typeof invitationSchema>;

// শুধু খোলা invitation (গৃহীত বা বাতিল না) — মেয়াদ পেরোনোগুলোও, যাতে "Expired · Resend" দেখা যায়
export const invitationListSchema = z.object({ items: z.array(invitationSchema) });

export const createInvitationInputSchema = z.object({
  email: emailSchema,
  // রোল ছাড়া invite মানে লোকটা ঢুকে কিছুই দেখবে না — সেটা প্রায় সবসময় ভুল, তাই অন্তত একটা
  roleIds: z.array(z.uuid()).min(1, errorCode('role_required')).max(10),
});
export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>;

export const invitationVersionInputSchema = z.object({ version: versionSchema });

export const revokeInvitationQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// 32 random byte-এর base64url = ৪৩ অক্ষর। সীমা ঢিলা রাখা, কিন্তু ১ MB-র "token" parse করতে দেওয়া না
const invitationTokenSchema = z.string().min(32).max(128);

export const invitationLookupInputSchema = z.object({ token: invitationTokenSchema });

// লিংক খুললে দেখানোর মতো যা লাগে, তার বেশি না
export const invitationPreviewSchema = z.object({
  workspace: z.object({ name: z.string(), slug: z.string() }),
  email: z.string(),
  invitedBy: z.string().nullable(),
  // এই ইমেইলে আগে থেকেই Omnivo অ্যাকাউন্ট আছে কি না — থাকলে শুধু পাসওয়ার্ড, না থাকলে নাম + নতুন
  // পাসওয়ার্ড। token-এর মালিক শুধু নিজের ইমেইলের কথাই জানে, অন্য কারো না
  accountExists: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

// দুই রকম গ্রহণ, 'account' দিয়ে আলাদা। ইমেইল কোনোটাতেই নেই ইচ্ছা করে: সেটা invitation থেকে আসে —
// ক্লায়েন্ট অন্য ইমেইল পাঠিয়ে অন্য কারো অ্যাকাউন্টে invitation বসাতে পারে না
export const acceptInvitationInputSchema = z.discriminatedUnion('account', [
  z.object({
    account: z.literal('new'),
    token: invitationTokenSchema,
    fullName: fullNameSchema,
    password: newPasswordSchema,
  }),
  z.object({
    account: z.literal('existing'),
    token: invitationTokenSchema,
    password: z.string().min(1, errorCode('password_required')).max(128),
  }),
]);
export type AcceptInvitationInput = z.infer<typeof acceptInvitationInputSchema>;

const invitationParamsSchema = z.object({ id: z.uuid() });

export const invitationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/invitations',
    summary: 'Open invitations of the active workspace, newest first',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 200,
    response: invitationListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/invitations',
    summary: 'Invite someone by email, with the roles they get on joining',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 201,
    body: createInvitationInputSchema,
    response: invitationSchema,
  }),
  resend: defineRoute({
    method: 'POST',
    path: '/invitations/:id/resend',
    summary: 'Send a fresh link; the old one stops working',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 200,
    params: invitationParamsSchema,
    body: invitationVersionInputSchema,
    response: invitationSchema,
  }),
  revoke: defineRoute({
    method: 'DELETE',
    path: '/invitations/:id',
    summary: 'Cancel an invitation before it is accepted',
    auth: 'bearer',
    permission: 'core.user.invite',
    status: 204,
    params: invitationParamsSchema,
    query: revokeInvitationQuerySchema,
    response: z.void(),
  }),
  // public, আর GET না: token URL-এ গেলে API-র access log-এ লেখা হতো। POST body log হয় না
  lookup: defineRoute({
    method: 'POST',
    path: '/invitations/lookup',
    summary: 'Show which workspace an invitation link is for',
    auth: 'public',
    status: 200,
    body: invitationLookupInputSchema,
    response: invitationPreviewSchema,
  }),
  // সফল হলে লগইনের মতোই session শুরু — refresh cookie + access token
  accept: defineRoute({
    method: 'POST',
    path: '/invitations/accept',
    summary: 'Join the workspace, creating an account if needed, and start a session',
    auth: 'public',
    status: 200,
    body: acceptInvitationInputSchema,
    response: authSessionSchema,
  }),
};
```

- `invitationLink()` contracts-এ: API লিংক লেখে (ইমেইলে), app `/invite` পেজ বানায় — দুজনই `INVITE_PATH` থেকে। একজন path
  বদলালে অন্যজন compile-এই জানে।
- `#`-এর পরে token — ভিত্তি-সিদ্ধান্ত ১১।
- `sentAt: nullable` — ভিত্তি-সিদ্ধান্ত ১: চিঠি না গেলে সেটা লুকানো হয় না।
- `roleIds.min(1, errorCode('role_required'))` — রোল ছাড়া invite মানে লোকটা ঢুকে কিছুই পায় না; প্রায় সবসময় ভুল।
  (সদস্যের রোল বদলে ফাঁকা চলে — সেখানে ইচ্ছাকৃত।)
- `invitationTokenSchema` `.min(32).max(128)` — আসল token ৪৩ অক্ষর; সীমা ঢিলা, কিন্তু কেউ ১ MB-র "token" পাঠিয়ে hash
  করাতে পারে না।
- `accountExists` — lookup-এর উত্তরে। এটা কি "এই ইমেইলে অ্যাকাউন্ট আছে কি না" ফাঁস? token ছাড়া প্রশ্নই করা যায় না, আর
  token-এর মালিক শুধু নিজের ইমেইলের কথাই জানে।
- `acceptInvitationInputSchema` — `z.discriminatedUnion('account', …)`: নতুন অ্যাকাউন্টে নাম + নতুন পাসওয়ার্ডের নিয়ম
  (৮–১২৮), পুরনোতে শুধু পাসওয়ার্ড (যেকোনো দৈর্ঘ্য — লগইনের মতো, পুরনো পাসওয়ার্ড নতুন নিয়ম না মানতেও পারে)।
  `z.union` দিলে Zod দুটোই চেষ্টা করে দুই সেট error দিত; discriminated union `account` দেখে একটাই বাছে। **ইমেইল
  কোনোটাতেই নেই** — সেটা invitation থেকে আসে, নাহলে ক্লায়েন্ট অন্য ইমেইল পাঠিয়ে অন্যের অ্যাকাউন্টে invitation বসাত।
- `lookup` আর `accept` — `auth: 'public'`, তাই guard ছেড়ে দেয়; `POST`, কারণ token body-তে (ভিত্তি-সিদ্ধান্ত ১১)।

### রেজিস্ট্রি আর export

**ফাইল: `packages/contracts/src/routes.ts`** আর **`index.ts`** (আপডেট)

```diff
--- a/packages/contracts/src/routes.ts
+++ b/packages/contracts/src/routes.ts
@@ -5,9 +5,11 @@ import { auditRoutes } from './audit.js';
 import { authRoutes } from './auth.js';
 import { branchRoutes } from './branches.js';
 import { defineRoute } from './http.js';
+import { invitationRoutes } from './invitations.js';
 import { memberRoutes } from './members.js';
 import { numberSeriesRoutes } from './numbering.js';
 import { meRoutes } from './preferences.js';
+import { roleRoutes } from './roles.js';
 import { settingsRoutes } from './settings.js';
 
 export const healthRoutes = {
@@ -28,6 +30,8 @@ export const routes = {
   auth: authRoutes,
   me: meRoutes,
   members: memberRoutes,
+  invitations: invitationRoutes,
+  roles: roleRoutes,
   settings: settingsRoutes,
   branches: branchRoutes,
   numberSeries: numberSeriesRoutes,
```

```diff
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -5,9 +5,12 @@ export * from './branches.js';
 export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
+export * from './invitations.js';
 export * from './members.js';
 export * from './numbering.js';
 export * from './pagination.js';
+export * from './permissions.js';
 export * from './preferences.js';
+export * from './roles.js';
 export * from './routes.js';
 export * from './settings.js';
```

- `routes`-এ দুই লাইন যোগ করলেই API-র `contract.spec.ts` দাবি করে Nest-এ ঠিক এই রুটগুলো থাকুক, আর OpenAPI-তে নতুন
  দুটো group আসে।

### টেস্ট

**ফাইল: `packages/contracts/src/invitations.spec.ts`** (নতুন)

```ts
import { describe, expect, it } from 'vitest';

import {
  acceptInvitationInputSchema,
  createInvitationInputSchema,
  invitationLink,
} from './invitations.js';
import { isPermissionKey, PERMISSION_GROUP_OF, PERMISSION_KEYS } from './permissions.js';

describe('invitation contracts', () => {
  it('puts the token after #, so it never reaches a server log', () => {
    expect(invitationLink('https://app.omnivo.app', 'abc')).toBe(
      'https://app.omnivo.app/invite#abc',
    );
  });

  it('normalizes the email like sign-up does, and needs at least one role', () => {
    const parsed = createInvitationInputSchema.safeParse({
      email: ' Tanvir@RahmanGarments.com ',
      roleIds: [],
    });
    expect(parsed.success).toBe(false);
    expect(
      createInvitationInputSchema.parse({
        email: ' Tanvir@RahmanGarments.com ',
        roleIds: ['01920000-0000-7000-8000-000000000000'],
      }).email,
    ).toBe('tanvir@rahmangarments.com');
  });

  it('asks a new account for a name and a strong password, an existing one only for its password', () => {
    const token = 'x'.repeat(43);
    expect(
      acceptInvitationInputSchema.safeParse({ account: 'new', token, password: 'Konabari-2026' })
        .success,
    ).toBe(false);
    expect(
      acceptInvitationInputSchema.safeParse({
        account: 'new',
        token,
        fullName: 'Tanvir Hossain',
        password: 'short',
      }).success,
    ).toBe(false);
    expect(
      acceptInvitationInputSchema.safeParse({ account: 'existing', token, password: 'x' }).success,
    ).toBe(true);
  });
});

describe('permission catalog', () => {
  it('knows its own keys and puts every key in a group', () => {
    expect(isPermissionKey('core.user.read')).toBe(true);
    expect(isPermissionKey('core.user.delete')).toBe(false);
    expect(Object.keys(PERMISSION_GROUP_OF).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});
```

**ফাইল: `packages/contracts/src/openapi.spec.ts`** (আপডেট — একটা টেস্ট যোগ)

```diff
--- a/packages/contracts/src/openapi.spec.ts
+++ b/packages/contracts/src/openapi.spec.ts
@@ -33,6 +33,15 @@ describe('OpenAPI document', () => {
     expect(logout?.responses['204']).toEqual({ description: 'No content' });
   });
 
+  it('names the permission a route needs, for tools and for people', () => {
+    const invite = document.paths['/invitations']?.post;
+    expect(invite).toMatchObject({
+      'x-permission': 'core.user.invite',
+      description: 'Requires the `core.user.invite` permission.',
+    });
+    expect(document.paths['/roles']?.get).not.toHaveProperty('x-permission');
+  });
+
   it('has no environment-specific server unless asked for one', () => {
     expect('servers' in document).toBe(false);
     expect(buildOpenApiDocument(routes, { version: '1', serverUrl: 'http://x' }).servers).toEqual([
```

- `not.toHaveProperty('x-permission')` — `/roles`-এর GET-এ permission নেই (ইচ্ছাকৃত, ৭.১-এর roles.ts দেখুন); উল্টোটা
  ভুল করে সব রুটে বসে গেলে ধরা পড়ে।

---

## ৭.২ — `packages/db`: টেবিল, migration, catalog

### permission catalog

**ফাইল: `packages/db/src/permission-catalog.ts`** (পুরো ফাইল বদল)

```ts
import { PERMISSION_KEYS, type PermissionKey } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions } from './schema/index.js';

// key-এর তালিকা contracts-এ (API, UI, অনুবাদ সবাই সেখান থেকে); এখানে শুধু DB-র permissions টেবিলের
// ইংরেজি বিবরণ — psql বা Drizzle Studio-তে দেখার জন্য। satisfies: নতুন key-র বিবরণ ভুলে গেলে compile error
const DESCRIPTIONS = {
  'core.user.read': 'View people in the workspace',
  'core.user.invite': 'Invite people and manage open invitations',
  'core.user.manage': "Change members' roles and remove members",
  'core.role.manage': 'Create roles and choose their permissions',
  'core.settings.manage': 'Edit the company profile, regional settings and numbering',
  'core.branch.manage': 'Add, edit and archive branches',
  'core.audit.read': 'View the audit log',
} satisfies Record<PermissionKey, string>;

export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));

// signup-এ তৈরি owner রোলের নাম। নামটা শুধু দেখানোর — কোড owner চেনে roles.kind দিয়ে, নাম দিয়ে না
export const OWNER_ROLE_NAME = 'Owner';

// Pick<..., 'insert'>: migrate-এর plain db, createDb()-এর Db, বা transaction-এর tx — সবই চলে
// idempotent: নতুন key যোগ হয়, পুরনো key-এর description আপডেট হয়; কিছু মোছে না
export async function syncPermissions(db: Pick<PostgresJsDatabase, 'insert'>): Promise<void> {
  await db
    .insert(permissions)
    .values(PERMISSIONS)
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sql`excluded.description` },
    });
}
```

- `DESCRIPTIONS … satisfies Record<PermissionKey, string>` — নতুন key-র বিবরণ ভুলে গেলে compile error; বাড়তি key থাকলেও।
- `PERMISSIONS` এখন `PERMISSION_KEYS.map(...)` — তালিকা একবারই লেখা (contracts-এ)।
- `OWNER_ROLE_NAME` থাকল, কিন্তু শুধু signup-এ দেখানোর নাম। কোড owner চেনে `kind` দিয়ে।
- `grantOwnerPermissions()` মুছে দিন — `roles`, `rolePermissions`, `tenants`, `and`, `eq`, `isNull` import-ও আর লাগে না।
- `.values(PERMISSIONS)` — আগে `[...PERMISSIONS]` ছিল (readonly tuple থেকে mutable array); `map()` নিজেই নতুন array দেয়।

**ফাইল: `packages/db/src/migrate.ts`** (আপডেট)

```diff
--- a/packages/db/src/migrate.ts
+++ b/packages/db/src/migrate.ts
@@ -4,7 +4,7 @@ import { drizzle } from 'drizzle-orm/postgres-js';
 import { migrate } from 'drizzle-orm/postgres-js/migrator';
 import postgres from 'postgres';
 import { loadRootEnv, requireEnv } from './env.js';
-import { grantOwnerPermissions, syncPermissions } from './permission-catalog.js';
+import { syncPermissions } from './permission-catalog.js';
 
 loadRootEnv();
 
@@ -19,8 +19,6 @@ async function main() {
   await migrate(db, { migrationsFolder });
   // permissions সিস্টেম ডেটা — schema-র মতোই প্রতিটা deploy-এ কোডের তালিকার সাথে মেলানো
   await syncPermissions(db);
-  // নতুন permission পুরনো workspace-এর Owner-কেও — নাহলে এই ধাপের স্ক্রিনগুলো মালিক নিজেই খুলতে পারত না
-  await grantOwnerPermissions(db);
   await migrationClient.end();
   console.log('migrations done');
 }
```

### বদলানো টেবিল: `roles`

**ফাইল: `packages/db/src/schema/roles.ts`** (পুরো ফাইল বদল)

```ts
import { ROLE_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const roles = pgTable(
  'roles',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    // owner-এর অধিকার কোডে (PermissionService: owner = catalog-এর সব key), role_permissions-এ তার
    // কোনো রো নেই। custom-এর অধিকার শুধু role_permissions-এ
    kind: text('kind', { enum: ROLE_KINDS }).notNull().default('custom'),
  },
  (table) => [
    // lower(): "Accountant" আর "accountant" দুটো আলাদা রোল হলে invite-এর তালিকায় কোনটা কী বোঝা যেত না
    uniqueIndex('roles_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    // role_permissions / membership_roles / invitation_roles-এর composite FK-এর target
    uniqueIndex('roles_tenant_id_idx').on(table.tenantId, table.id),
    // প্রতিটা workspace-এ owner রোল ঠিক একটা — কোডের "owner রোলটা খোঁজো" সবসময় একটাই রো পায়
    uniqueIndex('roles_tenant_owner_idx')
      .on(table.tenantId)
      .where(sql`${table.kind} = 'owner'`),
  ],
);
```

- `kind` — contracts-এর `ROLE_KINDS` থেকে enum (ধাপ ৬-এর সিদ্ধান্ত ১৩: কলামের তালিকা contracts-এ একবার)।
  ডিফল্ট `'custom'` — migration-এ বিদ্যমান সব রোল আগে custom হয়, তারপর 0010 "Owner"-গুলোকে owner বানায়।
- `roles_tenant_name_idx` এখন `lower(name)`-এ — expression index; drizzle `sql\`lower(${table.name})\`` নেয়। পুরনো
  index-এর একই নাম রাখা হলো, তাই migration-এ drizzle-kit সেটা DROP করে নতুন করে বানায়।
- `roles_tenant_owner_idx` — partial unique index (`WHERE kind = 'owner'`): একটা টেন্যান্টে দ্বিতীয় owner রোল
  insert করা DB-তেই অসম্ভব। কোডের "owner রোলটা খোঁজো" সবসময় ০ বা ১ রো পায়।

### নতুন টেবিল: `invitations`, `invitation_roles`

**ফাইল: `packages/db/src/schema/invitations.ts`** (নতুন)

```ts
import { sql } from 'drizzle-orm';
import { foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { roles } from './roles.js';
import { tenants } from './tenants.js';

// কাউকে workspace-এ ডাকা। কে ডেকেছে = created_by (baseColumns)। লিংকের token নিজে কোথাও রাখা হয় না,
// শুধু তার SHA-256 — refresh token-এর মতোই (ধাপ ৩): DB dump লিক হলেও কেউ সেখান থেকে লিংক বানাতে পারে না
export const invitations = pgTable(
  'invitations',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // contracts-এর emailSchema-র পরে — ছোট হাতে, তাই users.email-এর সাথে সরাসরি মেলে
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // null = ইমেইল পাঠানো যায়নি (SMTP বন্ধ) — commit-এর পরে পাঠানো সফল হলে তবেই বসে
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // public lookup/accept token দিয়ে খোঁজে (টেন্যান্ট জানার আগে) — অনন্য, আর index ছাড়া পুরো টেবিল পড়ত
    uniqueIndex('invitations_token_hash_idx').on(table.tokenHash),
    // invitation_roles-এর composite FK-এর target
    uniqueIndex('invitations_tenant_id_idx').on(table.tenantId, table.id),
    // একটা ইমেইলে একসাথে একটাই খোলা invitation: দুজন admin একসাথে একই লোককে ডাকলে দুটো লিংক আর
    // দুই রকম রোল তৈরি হতো। গৃহীত বা বাতিল হলে আবার ডাকা যায়
    uniqueIndex('invitations_tenant_email_open_idx')
      .on(table.tenantId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  ],
);

// invitation গ্রহণ করলে যে রোলগুলো পাবে। uuid[] কলামের বদলে আলাদা টেবিল: FK দিয়ে DB নিজেই নিশ্চিত
// করে যে রোলগুলো একই টেন্যান্টের আর সত্যিই আছে (array-র ভেতরের মানে FK হয় না)
export const invitationRoles = pgTable(
  'invitation_roles',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    invitationId: uuid('invitation_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (table) => [
    uniqueIndex('invitation_roles_tenant_invitation_role_idx').on(
      table.tenantId,
      table.invitationId,
      table.roleId,
    ),
    // cascade দুই দিকেই: রোল মোছার আগে service দেখে নেয় কোনো খোলা invitation সেটা চায় কি না;
    // পুরনো (গৃহীত/বাতিল) invitation-এর রো রোলটাকে চিরকাল আটকে রাখবে না
    foreignKey({
      name: 'invitation_roles_invitation_fk',
      columns: [table.tenantId, table.invitationId],
      foreignColumns: [invitations.tenantId, invitations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invitation_roles_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }).onDelete('cascade'),
  ],
);
```

- `invited_by` কলাম নেই — `created_by` (baseColumns) ঠিক সেটাই।
- `token_hash` unique index — lookup token দিয়ে খোঁজে, আর দুটো invitation-এর একই hash হওয়া মানে বাগ।
- `accepted_at`, `revoked_at` আলাদা কলাম, একটা `status` enum না: কখন হলো সেটাও জানা যায়, আর "মেয়াদ শেষ" অবস্থাটা
  লেখা হয় না — `expires_at < now()` থেকে হিসাব হয় (লেখা থাকলে একটা job রোজ সেটা বদলাতে হতো)।
- `invitations_tenant_email_open_idx` — partial unique: একই ইমেইলে একসাথে একটাই **খোলা** invitation; গৃহীত বা বাতিল
  হলে আবার ডাকা যায়। মেয়াদ পেরোনো খোলাটা service নিজে বন্ধ করে নতুনটার জায়গা করে (৭.৪)।
- `invitation_roles` — uuid[]-এর বদলে টেবিল, composite FK দিয়ে "একই টেন্যান্টের রোল" DB নিজে নিশ্চিত করে (ধাপ ১-এর
  `membership_roles`-এর মতো)।
- দুই FK-তেই `onDelete('cascade')`: রোল মোছার আগে service দেখে কোনো **খোলা** invitation সেটা চায় কি না; গৃহীত/বাতিল
  invitation-এর পুরনো রো রোলটাকে চিরকাল আটকে রাখবে না।

**ফাইল: `packages/db/src/schema/index.ts`** — শেষে এক লাইন:

```ts
export * from './invitations.js';
```

### seed

**ফাইল: `packages/db/src/seed.ts`** (আপডেট)

```diff
--- a/packages/db/src/seed.ts
+++ b/packages/db/src/seed.ts
@@ -1,15 +1,13 @@
-import { and, eq, inArray, sql } from 'drizzle-orm';
+import { and, eq, sql } from 'drizzle-orm';
 import { drizzle } from 'drizzle-orm/postgres-js';
 import postgres from 'postgres';
 import { loadRootEnv, requireEnv } from './env.js';
-import { OWNER_ROLE_NAME, PERMISSIONS, syncPermissions } from './permission-catalog.js';
+import { OWNER_ROLE_NAME, syncPermissions } from './permission-catalog.js';
 import {
   tenants,
   users,
   memberships,
   roles,
-  permissions,
-  rolePermissions,
   membershipRoles,
   branches,
   tenantSettings,
@@ -33,15 +31,6 @@ async function main() {
   // সব insert idempotent — বারবার চালালেও একই অবস্থা থাকবে
   await db.transaction(async (tx) => {
     await syncPermissions(tx);
-    const permissionRows = await tx
-      .select({ id: permissions.id })
-      .from(permissions)
-      .where(
-        inArray(
-          permissions.key,
-          PERMISSIONS.map((p) => p.key),
-        ),
-      );
 
     const tenant = one(
       await tx
@@ -78,25 +67,20 @@ async function main() {
       'membership',
     );
 
+    // owner রোলের অধিকার কোডে — role_permissions-এ কিছু লেখার নেই। conflict-এর target partial index
+    // (roles_tenant_owner_idx), তাই where-ও দিতে হয়: Postgres index-এর শর্ত মিলিয়ে তবেই সেটা চেনে
     await tx
       .insert(roles)
-      .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME })
-      .onConflictDoNothing({ target: [roles.tenantId, roles.name] });
+      .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, kind: 'owner' })
+      .onConflictDoNothing({ target: roles.tenantId, where: sql`kind = 'owner'` });
     const owner = one(
       await tx
         .select({ id: roles.id })
         .from(roles)
-        .where(and(eq(roles.tenantId, tenant.id), eq(roles.name, OWNER_ROLE_NAME))),
+        .where(and(eq(roles.tenantId, tenant.id), eq(roles.kind, 'owner'))),
       'Owner role',
     );
 
-    await tx
-      .insert(rolePermissions)
-      .values(
-        permissionRows.map((p) => ({ tenantId: tenant.id, roleId: owner.id, permissionId: p.id })),
-      )
-      .onConflictDoNothing();
-
     await tx
       .insert(membershipRoles)
       .values({ tenantId: tenant.id, membershipId: membership.id, roleId: owner.id })
```

- `onConflictDoNothing({ target: roles.tenantId, where: sql\`kind = 'owner'\` })` — conflict-এর target partial index হলে
  Postgres index-এর শর্তও চায় (`ON CONFLICT (tenant_id) WHERE kind = 'owner'`); শুধু `target` দিলে "there is no unique
  or exclusion constraint matching the ON CONFLICT specification"। আগের `[roles.tenantId, roles.name]` target আর নেই —
  নামের index এখন `lower(name)` expression।

### migration

```bash
pnpm db:generate --name team-and-roles
```

⚠️ `pnpm db:generate -- --name …` লিখবেন না (মাঝে `--`) — pnpm সেটা drizzle-kit-এ পাঠায় না, generate fail করে। যাচাইয়ের
সময় ঠিক এটাই হয়েছিল।

drizzle-kit `0009_team-and-roles.sql` লেখে। **একটা লাইন হাতে সরাতে হবে** — ধাপ ৩-এর 0003 আর ধাপ ৬-এর 0007-এর একই
সমস্যা: drizzle-kit `invitation_roles_invitation_fk` (composite FK → `invitations(tenant_id, id)`) বানায় তার target
unique index-এর **আগে**, আর Postgres বলে "there is no unique constraint matching given keys for referenced table". হাতে
বদলানোর পরে ফাইলটা এমন:

**ফাইল: `packages/db/migrations/0009_team-and-roles.sql`** (drizzle-kit, একটা লাইন হাতে সরানো)

```sql
CREATE TABLE "invitation_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"role_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
-- composite FK-এর target index আগে লাগবে (0003, 0007-এর মতো), তাই drizzle-kit-এর ক্রম হাতে বদলানো
CREATE UNIQUE INDEX "invitations_tenant_id_idx" ON "invitations" USING btree ("tenant_id","id");--> statement-breakpoint
DROP INDEX "roles_tenant_name_idx";--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "kind" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_invitation_fk" FOREIGN KEY ("tenant_id","invitation_id") REFERENCES "public"."invitations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_roles" ADD CONSTRAINT "invitation_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_roles_tenant_invitation_role_idx" ON "invitation_roles" USING btree ("tenant_id","invitation_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_tenant_email_open_idx" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."accepted_at" IS NULL AND "invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_owner_idx" ON "roles" USING btree ("tenant_id") WHERE "roles"."kind" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" USING btree ("tenant_id",lower("name"));
```

এরপর custom migration:

```bash
pnpm --filter @omnivo/db exec drizzle-kit generate --custom --name team-and-roles-rls
```

**ফাইল: `packages/db/migrations/0010_team-and-roles-rls.sql`** (নতুন, হাতে লেখা)

```sql
-- Custom SQL migration file, put your code below! --

-- ১) আগে থেকে থাকা workspace-এর "Owner" রোল → kind = 'owner', আর তার role_permissions-এর রো মুছে
--    ফেলা (owner-এর অধিকার এখন কোডে)। roles আর role_permissions-এ FORCE RLS আছে (0001), তাই migrator-ও
--    tenant context ছাড়া একটা রো-ও দেখে না — UPDATE চুপচাপ ০ রো বদলাত। RLS বন্ধ না করে, অ্যাপের মতোই
--    প্রতিটা টেন্যান্টের context বসিয়ে। set_config(..., true) = এই transaction-এর ভেতরেই
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE roles SET kind = 'owner' WHERE tenant_id = t AND name = 'Owner';
    DELETE FROM role_permissions rp
      USING roles r
      WHERE rp.tenant_id = t AND r.tenant_id = t AND r.id = rp.role_id AND r.kind = 'owner';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ২) নতুন tenant-টেবিলে ENABLE + FORCE RLS + tenant_isolation (0002-এর মতো NULLIF সহ)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['invitations', 'invitation_roles'])
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

-- ৩) invitation-এর লিংক খোলা লোকটা এখনো কোনো টেন্যান্টে নেই (লগইনই করেনি), তাই tenant context নেই।
--    0004-এর own_memberships-এর ছাঁচে: শুধু SELECT, আর শুধু সেই রো যার token_hash ঠিক এই মান —
--    token না জানলে কোনো রো দেখা যায় না। লেখা (গ্রহণ) হয় এর পরে, টেন্যান্ট জেনে tenant_isolation দিয়ে
CREATE POLICY invitation_by_token ON invitations
  FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.invitation_token_hash', true), ''));
```

- **অংশ ১ — কেন RLS বন্ধ করে না:** `roles`-এ FORCE RLS (0001), আর migrator টেবিলের মালিক হলেও FORCE তাকেও আটকায় —
  tenant context ছাড়া `UPDATE roles …` চুপচাপ **০ রো** বদলাত, কোনো error ছাড়া। সহজ পথ ছিল `ALTER TABLE roles NO
  FORCE ROW LEVEL SECURITY`, UPDATE, আবার FORCE — কিন্তু তাতে এক মুহূর্তের জন্যও পাহারা নামানো হয়। তার বদলে অ্যাপের
  নিজের পদ্ধতি: প্রতিটা টেন্যান্টের জন্য `set_config('app.tenant_id', …, true)`। migration একটা transaction-এ চলে,
  তাই `true` (transaction-local) প্রতিটা loop-এ আগেরটার উপরে বসে, আর শেষে খালি করে দেওয়া।
- `name = 'Owner'` দিয়ে চেনা নিরাপদ: ধাপ ৭-এর আগে রোলের নাম বদলানোর কোনো উপায় ছিল না, আর signup শুধু "Owner"
  বানাত।
- **অংশ ২** — ধাপ ৬-এর 0008-এর একই loop। `rls-coverage` টেস্ট (tenant-leak স্যুট) না বসালে ধরত।
- **অংশ ৩ — `invitation_by_token`:** permissive policy, তাই `tenant_isolation`-এর সাথে OR হয়: tenant মেলে **অথবা**
  hash মেলে। শুধু `FOR SELECT` — token জেনেও UPDATE/DELETE করা যায় না (৭.৫-এর tenant-leak টেস্ট এটা প্রমাণ করে)।
  `NULLIF(…, '')` — ধাপ ১-এর 0002-এর শিক্ষা: transaction শেষে setting `''` হয়ে যায়, NULL না; `''`-এর সাথে তুলনা
  এমনিতে false, তবু একই ছাঁদ রাখা।
- `invitation_roles`-এ এমন policy নেই — lookup শুধু invitation-এর রো পড়ে; রোল লাগে গ্রহণের সময়, তখন টেন্যান্ট জানা।

---

## ৭.৩ — API-র ভিত্তি: কে কী পারে, আর কী দিতে পারে

### নতুন error helper

**ফাইল: `apps/api/src/common/http/app-error.ts`** (আপডেট — শেষে যোগ)

```diff
--- a/apps/api/src/common/http/app-error.ts
+++ b/apps/api/src/common/http/app-error.ts
@@ -40,3 +40,8 @@ export function versionConflict(): AppError {
     'The record changed after it was loaded. Reload it and try again.',
   );
 }
+
+// টোকেন বৈধ, কিন্তু মানুষটা আর এই workspace-এ নেই (বাদ দেওয়া হয়েছে)
+export function accessRevoked(): AppError {
+  return new AppError(401, 'access_revoked', 'The user is no longer a member of this workspace.');
+}
```

- আগে একই `new AppError(401, 'access_revoked', …)` auth.service-এ হাতে লেখা ছিল; এখন guard, `me()`, refresh আর
  invitation-এর session — চার জায়গায় লাগে।

**ফাইল: `apps/api/src/common/db/pg-errors.ts`** (পুরো ফাইল বদল)

```ts
// drizzle Postgres error-কে DrizzleQueryError-এ মুড়ে দেয়; আসল কোড থাকে .cause-এ
function hasPgError(error: unknown, code: string, constraint: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === code &&
      'constraint_name' in current &&
      current.constraint_name === constraint
    ) {
      return true;
    }
  }
  return false;
}

// 23505 = unique_violation
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return hasPgError(error, '23505', constraint);
}

// 23503 = foreign_key_violation: যে রো-কে আরেকটা রো এখনো রেফার করছে সেটা মোছার চেষ্টা (বা উল্টোটা)
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return hasPgError(error, '23503', constraint);
}
```

- `isForeignKeyViolation` — রোল মোছার শেষ পাহারা (৭.৪)। একই "cause-এর শিকল ধরে খোঁজা" দুটো কোডের জন্য একবার লেখা।

### `PermissionService`

**ফাইল: `apps/api/src/rbac/permission.service.ts`** (পুরো ফাইল বদল)

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Principal } from '@omnivo/auth';
import { isPermissionKey, PERMISSION_KEYS, type PermissionKey } from '@omnivo/contracts';
import { membershipRoles, memberships, permissions, rolePermissions, roles } from '@omnivo/db';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { accessRevoked } from '../common/http/app-error.js';
import { currentPrincipal, runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { REDIS, WITH_TENANT } from '../infra/tokens.js';

// invalidation ভুলে গেলেও ১০ মিনিটের বেশি পুরনো permission থাকবে না
const CACHE_TTL_SECONDS = 600;

// একজন সদস্য এই মুহূর্তে কী পারে। roles = নাম (UI-তে দেখানো), owner = owner রোল আছে কি না
// (শুধু owner-ই আরেকজনকে owner বানাতে বা owner থেকে সরাতে পারে)
export interface Access {
  roles: string[];
  permissions: PermissionKey[];
  owner: boolean;
}

// cache-এ যা থাকে তা বাইরের ডেটা (Redis) — পড়ার সময় schema দিয়ে যাচাই, cast না। আকার বদলালে
// (যেমন ধাপ ৬-এর শুধু string[]) parse ব্যর্থ হয় আর DB থেকে নতুন করে পড়া হয়
const cachedAccessSchema = z.object({
  roles: z.array(z.string()),
  permissions: z.array(z.enum(PERMISSION_KEYS)),
  owner: z.boolean(),
});

// system-design §৪.৫-এর key ফরম্যাট: প্রতিটা Redis key টেন্যান্ট দিয়ে শুরু
export function permissionCacheKey(tenantId: string, userId: string): string {
  return `t:${tenantId}:perm:${userId}`;
}

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  // null = সদস্যপদ আর নেই (বাদ দেওয়া হয়েছে)। টোকেন তখনো ১৫ মিনিট বৈধ থাকতে পারে — তাই প্রতিটা
  // request-এ PermissionGuard এটা দেখে 401 দেয়, টোকেনের মেয়াদের ভরসায় বসে থাকে না
  async forPrincipal(principal: Principal): Promise<Access | null> {
    const key = permissionCacheKey(principal.tenantId, principal.userId);

    const cached = await this.readCache(key);
    if (cached) return cached;

    const access = await this.loadFromDb(principal.tenantId, principal.membershipId);
    // null cache করা হয় না: বাদ পড়া সদস্যের প্রতিটা request DB-তে যায়, কিন্তু সে ১৫ মিনিটের মধ্যে
    // লগআউট হয়ে যায়। আর আবার invite হয়ে ফিরলে পুরনো "নেই" ১০ মিনিট তাকে আটকে রাখত না
    if (access) await this.writeCache(key, access);
    return access;
  }

  // service-এর ভেতরে "যে ডাকছে সে কী পারে" (কাকে কোন রোল দিতে পারবে)। guard একটু আগেই একই জিনিস
  // পড়েছে, তাই এটা প্রায় সবসময় cache থেকে আসে
  async ofCurrentUser(): Promise<Access> {
    const access = await this.forPrincipal(currentPrincipal());
    if (!access) throw accessRevoked();
    return access;
  }

  // রোল বা permission বদলানোর প্রতিটা কোড এটা ডাকে — transaction commit হওয়ার পরে, আগে না। আগে মুছলে
  // commit-এর আগের মুহূর্তে আসা আরেকটা request পুরনো অধিকার আবার পড়ে ১০ মিনিটের জন্য cache করে ফেলত
  async invalidate(tenantId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.redis.del(...userIds.map((userId) => permissionCacheKey(tenantId, userId)));
    } catch (error) {
      // Redis বন্ধ = cache-ও পড়া যাচ্ছে না; ফিরলে TTL-এর মধ্যে পুরনো মান মুছে যাবে
      this.logger.warn(`permission cache invalidation failed: ${String(error)}`);
    }
  }

  private async loadFromDb(tenantId: string, membershipId: string): Promise<Access | null> {
    return runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const [membership] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(memberships.id, membershipId),
              isNull(memberships.deletedAt),
            ),
          );
        if (!membership) return null;

        const roleRows = await tx
          .select({ id: roles.id, name: roles.name, kind: roles.kind })
          .from(membershipRoles)
          .innerJoin(
            roles,
            and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
          )
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.membershipId, membershipId),
              isNull(membershipRoles.deletedAt),
              isNull(roles.deletedAt),
            ),
          )
          .orderBy(asc(roles.name));

        const owner = roleRows.some((role) => role.kind === 'owner');
        // owner = catalog-এর সব key, কোড থেকে। তাই নতুন permission যোগ হলে কোনো backfill লাগে না
        if (owner) {
          return {
            roles: roleRows.map((role) => role.name),
            permissions: [...PERMISSION_KEYS].sort(),
            owner,
          };
        }

        const customIds = roleRows.map((role) => role.id);
        const keyRows =
          customIds.length === 0
            ? []
            : await tx
                .selectDistinct({ key: permissions.key })
                .from(rolePermissions)
                .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
                .where(
                  and(
                    eq(rolePermissions.tenantId, tenantId),
                    inArray(rolePermissions.roleId, customIds),
                    isNull(rolePermissions.deletedAt),
                  ),
                );
        return {
          roles: roleRows.map((role) => role.name),
          // DB-তে এমন key থাকতে পারে যা catalog থেকে সরে গেছে — সেটা আর কোনো guard চেনে না, বাদ
          permissions: keyRows
            .map((row) => row.key)
            .filter(isPermissionKey)
            .sort(),
          owner,
        };
      }),
    );
  }

  // Redis নষ্ট হলে request ব্যর্থ করার বদলে DB থেকে পড়া — cache শুধু গতি, সত্যের উৎস না
  private async readCache(key: string): Promise<Access | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const parsed = cachedAccessSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.logger.warn(`permission cache read failed: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(key: string, access: Access): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(access), 'EX', CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`permission cache write failed: ${String(error)}`);
    }
  }
}
```

- `Access | null` — `null` মানে "সদস্যপদ আর নেই"। আগে শুধু permission-এর Set ফিরত; সদস্যপদ মুছলেও (বা রোল থেকে)
  টোকেন ১৫ মিনিট চলত।
- প্রথম query-টা সদস্যপদ — `deleted_at IS NULL`। বাদ পড়া মানুষের `membership_roles` মোছা হয় (৭.৪), তাই শুধু
  রোল-join দেখলে "কোনো permission নেই" আসত, "সদস্যই নেই" না — প্রথমটা 403, দ্বিতীয়টা 401 + লগআউট।
- owner → `[...PERMISSION_KEYS].sort()` — ভিত্তি-সিদ্ধান্ত ২; `.sort()` কারণ custom রোলের তালিকাও সাজানো, আর `/auth/me`-
  র উত্তর স্থির থাকে (টেস্ট তুলনা করে)।
- custom রোলের permission একটা query-তে, সব রোল মিলিয়ে (`inArray`) + `selectDistinct` — দুটো রোলে একই permission
  থাকলে দুবার না।
- `.filter(isPermissionKey)` — catalog থেকে কোনো key সরালে DB-তে তার রো থেকে যায় (syncPermissions কিছু মোছে না); সেটা
  cache-এ বা `me`-তে গেলে UI অচেনা string পেত।
- `cachedAccessSchema` — Redis-এর মান বাইরের ডেটা: schema দিয়ে পড়া। ধাপ ৬-এর cache-এ শুধু `string[]` ছিল — deploy-এর
  পরে পুরনো মান parse-এ ব্যর্থ হয়ে DB থেকে নতুন করে পড়া হয়; আলাদা migration লাগে না।
- `null` cache করা হয় না — কারণ মন্তব্যে। আবার invite হয়ে ফেরা মানুষ ১০ মিনিট আটকে থাকত।
- `ofCurrentUser()` — service-এর ভেতরে "যে ডাকছে সে কী পারে" (escalation-এর নিয়মের জন্য)। guard একটু আগেই পড়েছে, তাই
  প্রায় সবসময় cache।
- `invalidate(tenantId, userIds)` — তালিকা: একটা রোলের permission বদলালে সেই রোলের সবার cache একটা `DEL`-এ। try/catch:
  Redis বন্ধ থাকলে request ব্যর্থ করার কারণ নেই — cache-ও তখন পড়া যাচ্ছে না, আর TTL পুরনো মান মুছে দেবে।

### `PermissionGuard`

**ফাইল: `apps/api/src/rbac/permission.guard.ts`** (পুরো ফাইল বদল)

```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { accessRevoked, AppError } from '../common/http/app-error.js';
import { routeOf } from '../common/http/endpoint.js';
import { currentPrincipal } from '../common/tenant/tenant-context.js';
import { PermissionService } from './permission.service.js';

// AuthGuard-এর পরে চলে (app.module.ts-এর ক্রম): সেখানে "টোকেন আছে কি না", এখানে "এই workspace-এ এখনো
// আছে কি না, আর এই কাজের অনুমতি আছে কি না"। কোন permission লাগবে সেটা চুক্তিতে (route.permission) —
// আলাদা decorator নেই, তাই চুক্তি, OpenAPI আর আসল পাহারা কখনো আলাদা হতে পারে না
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly permissions: PermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = routeOf(context);
    // চুক্তির বাইরের রুট (/docs) আর public রুট (লগইন) — এখানে দেখার কিছু নেই
    if (!route || route.auth === 'public') return true;

    // প্রতিটা লগইন-করা request-এ, permission চাক বা না চাক: বাদ পড়া সদস্যের টোকেন আরও ১৫ মিনিট বৈধ,
    // কিন্তু সে সেই সময়ে ব্রাঞ্চের তালিকাও পড়তে পারবে না। দাম: প্রতি request-এ একটা Redis GET
    const access = await this.permissions.forPrincipal(currentPrincipal());
    if (!access) throw accessRevoked();

    if (route.permission !== undefined && !access.permissions.includes(route.permission)) {
      // params: UI অনুবাদের ভেতরে কোন অনুমতি লাগবে সেটা বসায় ("You need the {{permissions}} …")
      throw new AppError(403, 'permission_missing', `Missing permission: ${route.permission}.`, {
        params: { permissions: route.permission },
      });
    }
    return true;
  }
}
```

- `Reflector` আর `REQUIRED_PERMISSIONS_KEY` বাদ — `routeOf(context)` (ধাপ ৫-এর `endpoint.ts`) চুক্তিটাই দেয়, তাতে
  `permission` আছে।
- `route.auth === 'public'` → ছেড়ে দেওয়া: লগইন, lookup, accept-এ principal নেই, `currentPrincipal()` throw করত।
- `!route` — চুক্তির বাইরের রুট (`/docs`, `/openapi.json`); সেগুলো `@Public()`।
- `forPrincipal` **প্রতিটা** লগইন-করা request-এ — ভিত্তি-সিদ্ধান্ত ৬।
- `app.module.ts`-এর guard-এর ক্রম (AuthGuard আগে) বদলায়নি: টোকেন নেই → 401 `sign_in_required`; টোকেন আছে, সদস্য নেই →
  401 `access_revoked`; সদস্য, অনুমতি নেই → 403।

**ফাইল: `apps/api/src/rbac/require-permission.decorator.ts`** → **মুছে ফেলুন।**

### কী দেওয়া যায়: `grants.ts`

**ফাইল: `apps/api/src/rbac/grants.ts`** (নতুন)

```ts
import {
  isPermissionKey,
  PERMISSION_KEYS,
  type PermissionKey,
  type RoleKind,
} from '@omnivo/contracts';
import { permissions, rolePermissions, roles } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import type { Access } from './permission.service.js';

// একটা রোল আর সে যা দেয় — invite, সদস্যের রোল বদল আর matrix, তিন জায়গাতেই "এটা দেওয়ার অধিকার
// তোমার আছে কি না" মাপতে লাগে
export interface RoleGrant {
  id: string;
  name: string;
  kind: RoleKind;
  permissions: PermissionKey[];
}

// ids-এর রোলগুলো, permission সহ, নাম অনুযায়ী সাজানো। tenant filter + RLS: অন্য টেন্যান্টের রোলের id
// "নেই"-এর মতোই। একটাও না মিললে 400 — ফর্মের সেই ঘরে (roleIds), কারণ ভুলটা ক্লায়েন্টের পাঠানো তালিকায়
export async function loadRoles(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<RoleGrant[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await tx
    .select({ id: roles.id, name: roles.name, kind: roles.kind })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), inArray(roles.id, unique), isNull(roles.deletedAt)))
    .orderBy(asc(roles.name));
  if (rows.length !== unique.length) {
    throw new AppError(400, 'invalid_input', 'One of the roles does not exist.', {
      fieldErrors: { roleIds: ['invalid_value'] },
    });
  }

  const keyRows = await tx
    .select({ roleId: rolePermissions.roleId, key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(rolePermissions.tenantId, tenantId),
        inArray(rolePermissions.roleId, unique),
        isNull(rolePermissions.deletedAt),
      ),
    );

  return rows.map((row) => ({
    ...row,
    permissions:
      row.kind === 'owner'
        ? [...PERMISSION_KEYS].sort()
        : keyRows
            .filter((key) => key.roleId === row.id)
            .map((key) => key.key)
            .filter(isPermissionKey)
            .sort(),
  }));
}

// "নিজের চেয়ে বেশি অধিকার কাউকে দেওয়া যায় না" (privilege escalation বন্ধ)। নাহলে core.user.manage
// পাওয়া একজন store keeper নিজের বন্ধুকে — বা আরেকটা অ্যাকাউন্ট খুলে নিজেকেই — Accountant বানাত।
// owner রোল দেওয়া বা কেড়ে নেওয়া শুধু owner-ই পারে: সব permission থাকা custom রোলের কেউও না, কারণ
// owner-এর বাড়তি ক্ষমতা ("শেষ owner সরানো যায় না") permission-এ লেখা নেই
export function assertCanGrant(access: Access, granted: readonly RoleGrant[]): void {
  if (access.owner) return;
  for (const role of granted) {
    const allowed =
      role.kind !== 'owner' && role.permissions.every((key) => access.permissions.includes(key));
    if (!allowed) {
      throw new AppError(403, 'cannot_grant', `You can't give or take away the ${role.name} role.`);
    }
  }
}

// matrix-এ একটা টিক বসানো বা তোলা — শুধু নিজের আছে এমন permission-এর ঘরে
export function assertCanChangePermissions(access: Access, keys: readonly PermissionKey[]): void {
  if (access.owner) return;
  const missing = keys.filter((key) => !access.permissions.includes(key));
  if (missing.length > 0) {
    throw new AppError(403, 'cannot_grant', `You don't have ${missing.join(', ')} yourself.`);
  }
}
```

- DI ছাড়া সাধারণ ফাংশন — transaction (`tx`) হাতে নিয়ে চলে, তিনটা module (roles, members, invitations) import করে;
  আলাদা provider লাগে না।
- `loadRoles` — `[...new Set(ids)]`: ক্লায়েন্ট একই id দুবার পাঠালে "২টা চাইলাম, ১টা পেলাম" ভুল 400 দিত না। পাওয়া
  সংখ্যা না মিললে 400 `roleIds` — অন্য টেন্যান্টের রোলের id-ও এখানে পড়ে (tenant filter + RLS), তাই tenant-leak-এ
  404/403-এর বদলে "এমন রোল নেই"।
- owner-এর permission এখানেও কোড থেকে — `assertCanGrant` owner রোলের "সব" দেখে।
- `assertCanGrant` — `access.owner` হলে সব চলে। নাহলে: owner রোল কখনো না, আর custom রোলের **প্রতিটা** permission নিজের
  থাকতে হবে। "কেড়ে নেওয়া"-তেও একই নিয়ম (caller `[...added, ...removed]` পাঠায়): নাহলে store keeper একজন
  Accountant-এর রোল তুলে দিয়ে তাকে অকেজো করতে পারত।
- `assertCanChangePermissions` — matrix-এর জন্য: বদলানো **প্রতিটা** টিক নিজের থাকতে হবে।
- দুটোর error-ই `cannot_grant` 403, params ছাড়া — UI-র লেখা একটাই ("নিজের যা আছে শুধু সেটাই দিতে পারবেন")।

### config আর ইমেইল

**ফাইল: `apps/api/src/config.ts`** (আপডেট)

```diff
--- a/apps/api/src/config.ts
+++ b/apps/api/src/config.ts
@@ -16,6 +16,10 @@ const envSchema = z.object({
   S3_BUCKET: z.string().min(3).default('omnivo'),
   S3_ACCESS_KEY_ID: z.string().min(1),
   S3_SECRET_ACCESS_KEY: z.string().min(1),
+  // ইমেইল: dev-এ docker-compose-এর Mailpit (smtp://localhost:1025, সব চিঠি http://localhost:8025-এ),
+  // production-এ আসল SMTP (smtps://user:pass@host:465)। পাসওয়ার্ড URL-এর ভেতরেই — একটাই secret
+  SMTP_URL: z.url(),
+  MAIL_FROM: z.string().min(3).default('Omnivo <no-reply@omnivo.app>'),
 });
 
 const DAY = 24 * 60 * 60;
@@ -48,6 +52,10 @@ export function loadConfig(env: Record<string, string | undefined>) {
       // সেখানে API-র bucket বানানোর অধিকারই থাকবে না
       createBucket: e.NODE_ENV !== 'production',
     },
+    mail: {
+      url: e.SMTP_URL,
+      from: e.MAIL_FROM,
+    },
     auth: {
       betterAuthSecret: e.BETTER_AUTH_SECRET,
       baseURL: e.API_BASE_URL,
```

- `SMTP_URL` বাধ্যতামূলক, ডিফল্ট নেই — production-এ ভুলে গেলে চুপচাপ localhost-এ পাঠানোর চেষ্টা না করে চালুর সময়েই
  থামে। `z.url()` `smtp://` আর `smtps://` মেনে নেয় (যাচাই করা)।
- একটা URL-এ host, port, user, password — `smtps://user:pass@host:465`। একটাই secret সামলাতে হয়।

নতুন dependency (শুধু `apps/api`):

```bash
pnpm --filter @omnivo/api add nodemailer
```

⚠️ `@types/nodemailer` **লাগবে না** — nodemailer 10 নিজের `.d.ts` নিয়ে আসে (`dist/esm/nodemailer.d.ts`)। যাচাইয়ের সময়
দুটোই যোগ করা হয়েছিল; `@types/nodemailer` 8.x পুরনো API বর্ণনা করে, দুটো একসাথে থাকলে কোনটা জেতে সেটা resolution-এর
উপর নির্ভর — মুছে দেওয়া হয়েছে।

**ফাইল: `apps/api/src/mail/mail.service.ts`** (নতুন)

```ts
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

export interface MailMessage {
  to: string;
  subject: string;
  // দুটোই: HTML না দেখানো মেইল-অ্যাপ (আর স্প্যাম ফিল্টার) শুধু-লেখার অংশ পড়ে
  text: string;
  html: string;
}

// SMTP-র একমাত্র জায়গা। dev-এ Mailpit, production-এ আসল SMTP — কোড একই, শুধু SMTP_URL আলাদা।
// ধাপ ৮-এ পাঠানো সরবে worker-এ (outbox থেকে); তখনো এই service-ই পাঠাবে, শুধু ডাকবে worker
@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: ReturnType<typeof createTransport>;
  private readonly from: string;

  constructor(@Inject(CONFIG) config: Config) {
    this.from = config.mail.from;
    // nodemailer-এর ডিফল্ট connectionTimeout ২ মিনিট — mail server বন্ধ থাকলে "Invite" বাটন দুই মিনিট
    // ঘুরত। এখন request-এর ভেতরে পাঠানো হয়, তাই কয়েক সেকেন্ডেই হার মানা
    this.transport = createTransport({
      url: config.mail.url,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  // true = SMTP সার্ভার চিঠিটা নিয়েছে। false = নেয়নি — throw না: চিঠি না গেলেও invitation তৈরি হয়ে গেছে
  // (commit), caller সেটা "পাঠানো হয়নি" হিসেবে জানায়। লগে ঠিকানা বা লিংক না — লিংকে token থাকে
  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.transport.sendMail({ from: this.from, ...message });
      return true;
    } catch (error) {
      this.logger.warn(`sending "${message.subject}" failed: ${String(error)}`);
      return false;
    }
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
```

- `ReturnType<typeof createTransport>` — nodemailer-এর overload থেকে সঠিক `Mail<SMTPSentMessageInfo, …>`; হাতে জেনেরিক
  লিখতে হয় না।
- timeout তিনটা: nodemailer-এর ডিফল্ট `connectionTimeout` ২ মিনিট, `socketTimeout` ১০ মিনিট — mail server বন্ধ থাকলে
  "Send invitation" বাটন ততক্ষণ ঘুরত।
- `send()` throw করে না, `boolean` ফেরায়: caller-এর কাছে "পাঠানো যায়নি" একটা স্বাভাবিক ফল (UI-তে দেখায়), exception না।
- লগে subject আর error — ঠিকানা (ব্যক্তিগত তথ্য) আর লিংক (token!) না।
- `onApplicationShutdown` — pool-এর খোলা connection বন্ধ; নাহলে টেস্টে `app.close()`-এর পরে process ঝুলে থাকত।

**ফাইল: `apps/api/src/mail/invitation-email.ts`** (নতুন)

```ts
import { INVITATION_TTL_DAYS, type LanguageCode } from '@omnivo/contracts';

import type { MailMessage } from './mail.service.js';

interface InvitationEmailInput {
  to: string;
  workspaceName: string;
  inviterName: string;
  link: string;
  // যিনি ডাকছেন তাঁর ভাষা — একই কোম্পানির লোক সাধারণত একই ভাষায় কাজ করে। তিনি না বাছলে ইংরেজি
  language: LanguageCode;
}

interface Copy {
  subject: string;
  intro: string;
  button: string;
  expiry: string;
  ignore: string;
}

// ইমেইলের লেখা সার্ভারে, i18n-এ না: @omnivo/i18n ব্রাউজারের জন্য (React hook, i18next) — API-তে সেটা
// টানলে সার্ভারে React আসত। দুই ভাষার লেখা এখানে পাশাপাশি; satisfies দুটোকেই একই আকারে বাঁধে
function copy(input: InvitationEmailInput): Record<LanguageCode, Copy> {
  const { workspaceName: workspace, inviterName: inviter } = input;
  return {
    en: {
      subject: `${inviter} invited you to ${workspace} on Omnivo`,
      intro: `${inviter} invited you to join ${workspace} on Omnivo.`,
      button: `Join ${workspace}`,
      expiry: `The link works for ${String(INVITATION_TTL_DAYS)} days and only once.`,
      ignore: "If you weren't expecting this, you can ignore this email.",
    },
    bn: {
      subject: `${inviter} আপনাকে Omnivo-তে ${workspace}-এ যোগ দিতে ডেকেছেন`,
      intro: `${inviter} আপনাকে Omnivo-তে ${workspace}-এ যোগ দিতে ডেকেছেন।`,
      button: `${workspace}-এ যোগ দিন`,
      expiry: `লিংকটা ${new Intl.NumberFormat('bn-BD').format(INVITATION_TTL_DAYS)} দিন কাজ করবে, একবারই।`,
      ignore: 'এই ইমেইল আশা না করে থাকলে এটা এড়িয়ে যান।',
    },
  } satisfies Record<LanguageCode, Copy>;
}

// HTML-এ বসানোর আগে: কোম্পানির নাম আর মানুষের নাম ইউজারের লেখা — "<a href=…>" নামে কোম্পানি খুললে
// escape ছাড়া সেটা ইমেইলে সত্যিকারের লিংক হয়ে যেত (phishing-এর সহজ পথ)
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function invitationEmail(input: InvitationEmailInput): MailMessage {
  const text = copy(input)[input.language];
  const html = `<!doctype html>
<html lang="${input.language}">
  <body style="margin:0;padding:32px 16px;background:#F6F7F9;font-family:'Segoe UI',system-ui,sans-serif;color:#0F1728">
    <div style="max-width:480px;margin:0 auto;padding:32px;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:14px">
      <p style="margin:0 0 24px;font-size:17px;font-weight:600">Omnivo</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(text.intro)}</p>
      <a href="${escapeHtml(input.link)}" style="display:inline-block;padding:11px 16px;background:#1F47B5;color:#FFFFFF;border-radius:10px;font-weight:500;text-decoration:none">${escapeHtml(text.button)}</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.45;color:#475467">${escapeHtml(text.expiry)}<br>${escapeHtml(text.ignore)}</p>
    </div>
  </body>
</html>
`;
  return {
    to: input.to,
    subject: text.subject,
    text: `${text.intro}\n\n${text.button}: ${input.link}\n\n${text.expiry}\n${text.ignore}\n`,
    html,
  };
}
```

- ইমেইলের লেখা API-তে, `@omnivo/i18n`-এ না — কারণ মন্তব্যে। `Record<LanguageCode, Copy>` + `satisfies`: তৃতীয় ভাষা
  যোগ হলে (contracts-এর `LANGUAGE_CODES`) এখানে compile error।
- ভাষা = যিনি ডাকছেন তাঁর (`users.language`) — invitee-র ভাষা আমরা জানি না।
- `escapeHtml` — কোম্পানির নাম আর মানুষের নাম ইউজারের লেখা। ৭.৫-এর টেস্ট কোম্পানির নাম `<a href="https://evil…">`
  বানিয়ে দেখে যে চিঠিতে সেটা লেখা হিসেবে যায়, লিংক হিসেবে না। `href`-এর মানও escape — token-এ `"` থাকে না, তবু
  নিয়মটা এক জায়গায় সব মানের জন্য।
- রং hex-এ (`#1F47B5`) — ইমেইল ক্লায়েন্ট CSS variable বোঝে না; এটা app-এর UI না, তাই CLAUDE.md-এর "শুধু token" নিয়মের
  বাইরে। মানগুলো token টেবিলের light মান।
- শুধু-লেখার (`text`) অংশেও পুরো লিংক — HTML না দেখানো ক্লায়েন্ট আর স্প্যাম ফিল্টার এটা পড়ে।

**ফাইল: `apps/api/src/infra/infra.module.ts`** (আপডেট)

```diff
--- a/apps/api/src/infra/infra.module.ts
+++ b/apps/api/src/infra/infra.module.ts
@@ -12,6 +12,7 @@ import { Redis } from 'ioredis';
 import { createWithTenant } from '../common/tenant/with-tenant.js';
 import { createWithUser } from '../common/tenant/with-user.js';
 import type { Config } from '../config.js';
+import { MailService } from '../mail/mail.service.js';
 import { StorageService } from '../storage/storage.service.js';
 import { AUTH, CONFIG, DB, REDIS, WITH_TENANT, WITH_USER } from './tokens.js';
 
@@ -51,8 +52,9 @@ export class InfraModule implements OnApplicationShutdown {
         { provide: REDIS, useFactory: () => createRedis(config.redisUrl) },
         { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
         StorageService,
+        MailService,
       ],
-      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService],
+      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService, MailService],
     };
   }
 
```

- `StorageService`-এর মতো global — কয়েকটা module-এ লাগবে (ধাপ ৮-এর notification, worker)।

### session-এর উত্তর এক জায়গায়

**ফাইল: `apps/api/src/auth/refresh-cookie.ts`** (আপডেট — শেষে যোগ)

```diff
--- a/apps/api/src/auth/refresh-cookie.ts
+++ b/apps/api/src/auth/refresh-cookie.ts
@@ -1,3 +1,5 @@
+import type { IssuedTokens } from '@omnivo/auth';
+import type { AuthSession } from '@omnivo/contracts';
 import type { FastifyReply } from 'fastify';
 
 export const REFRESH_COOKIE = 'omnivo_rt';
@@ -28,3 +30,17 @@ export function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
     path: COOKIE_PATH,
   });
 }
+
+// session শুরুর উত্তর — সাইনআপ, লগইন, refresh, switch আর invitation গ্রহণ, সবগুলোর একই আকার।
+// refresh token শুধু httpOnly cookie-তে; JSON-এ শুধু access token — JS কখনো refresh token দেখে না
+export function sessionResponse(
+  reply: FastifyReply,
+  tokens: IssuedTokens,
+  secure: boolean,
+): AuthSession {
+  setRefreshCookie(reply, tokens.refreshToken, tokens.refreshTokenExpiresAt, secure);
+  return {
+    accessToken: tokens.accessToken,
+    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
+  };
+}
```

**ফাইল: `apps/api/src/auth/auth.controller.ts`** (আপডেট)

```diff
--- a/apps/api/src/auth/auth.controller.ts
+++ b/apps/api/src/auth/auth.controller.ts
@@ -9,7 +9,7 @@ import { currentPrincipal } from '../common/tenant/tenant-context.js';
 import type { Config } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
 import { AuthService } from './auth.service.js';
-import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from './refresh-cookie.js';
+import { clearRefreshCookie, REFRESH_COOKIE, sessionResponse } from './refresh-cookie.js';
 
 // path আর status চুক্তিতে (routes.auth.*), তাই @Controller()-এ prefix নেই
 @Controller()
@@ -87,17 +87,7 @@ export class AuthController {
     return this.authService.me(currentPrincipal());
   }
 
-  // refresh token শুধু httpOnly cookie-তে; JSON-এ শুধু access token — JS কখনো refresh token দেখে না
   private startSession(reply: FastifyReply, tokens: IssuedTokens): AuthSession {
-    setRefreshCookie(
-      reply,
-      tokens.refreshToken,
-      tokens.refreshTokenExpiresAt,
-      this.config.secureCookies,
-    );
-    return {
-      accessToken: tokens.accessToken,
-      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
-    };
+    return sessionResponse(reply, tokens, this.config.secureCookies);
   }
 }
```

- invitation গ্রহণও session শুরু করে — cookie বসানোর কোড দুই controller-এ দুবার লেখা না, একটা ফাংশনে।
- cookie-র `path: '/auth'` বদলায়নি: `/invitations/accept`-এর উত্তরে বসানো cookie-ও শুধু `/auth/*`-এ যায় (Set-Cookie-র
  Path যেকোনো path হতে পারে, request-এর path-এর সাথে মিলতে হয় না)।

---

## ৭.৪ — API-র মডিউল

### auth: owner-এর kind, এখনকার অধিকার, আর invitation-এর জন্য তিনটা method

**ফাইল: `apps/api/src/auth/auth.service.ts`** (আপডেট)

```diff
--- a/apps/api/src/auth/auth.service.ts
+++ b/apps/api/src/auth/auth.service.ts
@@ -21,8 +21,6 @@ import {
   branches,
   membershipRoles,
   memberships,
-  permissions,
-  rolePermissions,
   roles,
   tenantSettings,
   tenants,
@@ -31,7 +29,7 @@ import {
 
 import { audit, created } from '../common/audit/audit.js';
 import { isUniqueViolation } from '../common/db/pg-errors.js';
-import { AppError } from '../common/http/app-error.js';
+import { accessRevoked, AppError } from '../common/http/app-error.js';
 import { runWithTenant } from '../common/tenant/tenant-context.js';
 import { setTenantContext, type WithTenant } from '../common/tenant/with-tenant.js';
 import type { WithUser } from '../common/tenant/with-user.js';
@@ -69,21 +67,11 @@ export class AuthService {
       throw workspaceTaken(input.workspaceSlug);
     }
 
-    let identity: Identity;
-    try {
-      identity = await this.auth.signUp({
-        email: input.email,
-        password: input.password,
-        fullName: input.fullName,
-      });
-    } catch (error) {
-      if (error instanceof AuthError && error.code === 'EMAIL_TAKEN') {
-        throw new AppError(409, 'email_taken', 'An account with this email already exists.', {
-          fieldErrors: { email: ['email_taken'] },
-        });
-      }
-      throw error;
-    }
+    const identity = await this.createAccount({
+      email: input.email,
+      password: input.password,
+      fullName: input.fullName,
+    });
 
     let workspace: { tenantId: string } & MembershipGrant;
     try {
@@ -117,19 +105,11 @@ export class AuthService {
       );
     }
 
-    let identity: Identity;
-    try {
-      identity = await this.auth.signIn({
-        email: input.email,
-        password: input.password,
-        keepSignedIn: input.keepSignedIn,
-      });
-    } catch (error) {
-      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
-        throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
-      }
-      throw error;
-    }
+    const identity = await this.verifyPassword({
+      email: input.email,
+      password: input.password,
+      keepSignedIn: input.keepSignedIn,
+    });
 
     const membership = await this.findMembership(tenant.id, identity.userId);
     if (!membership) {
@@ -156,17 +136,63 @@ export class AuthService {
     });
   }
 
+  // invitation গ্রহণ (invitations.service.ts) আর সাইনআপ — নতুন Better Auth ইউজার + session।
+  // Better Auth-এর নিজের error এখানেই আমাদের code-এ বদলায়; facade-এর বাইরে কেউ AuthError দেখে না
+  async createAccount(input: {
+    email: string;
+    password: string;
+    fullName: string;
+  }): Promise<Identity> {
+    try {
+      return await this.auth.signUp(input);
+    } catch (error) {
+      if (error instanceof AuthError && error.code === 'EMAIL_TAKEN') {
+        throw new AppError(409, 'email_taken', 'An account with this email already exists.', {
+          fieldErrors: { email: ['email_taken'] },
+        });
+      }
+      throw error;
+    }
+  }
+
+  // লগইন আর বিদ্যমান অ্যাকাউন্টে invitation গ্রহণ — পাসওয়ার্ড যাচাই + নতুন session
+  async verifyPassword(input: {
+    email: string;
+    password: string;
+    keepSignedIn: boolean;
+  }): Promise<Identity> {
+    try {
+      return await this.auth.signIn(input);
+    } catch (error) {
+      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
+        throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
+      }
+      throw error;
+    }
+  }
+
+  // সদস্যপদ তৈরি হয়ে যাওয়ার পরে: সেই workspace-এর টোকেন। লগইনের শেষ ধাপের মতোই, শুধু membership
+  // আগে থেকে জানা নেই বলে এখানে আবার পড়া (রোলের নাম টোকেনের claim-এ যায়)
+  async startSessionIn(identity: Identity, tenantId: string): Promise<IssuedTokens> {
+    const membership = await this.findMembership(tenantId, identity.userId);
+    if (!membership) {
+      await this.auth.revokeSession(identity.sessionId);
+      throw accessRevoked();
+    }
+    return this.auth.issueTokens({
+      sessionId: identity.sessionId,
+      sessionExpiresAt: identity.sessionExpiresAt,
+      claims: { userId: identity.userId, tenantId, ...membership },
+    });
+  }
+
   async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
     const grant = await this.rotate(refreshToken);
     // টোকেনের রোল ১৫ মিনিট পর্যন্ত পুরনো থাকতে পারে; প্রতিটা refresh-এ DB থেকে নতুন করে
     const membership = await this.findMembership(grant.activeTenantId, grant.userId);
     if (!membership) {
       await this.auth.revokeSession(grant.sessionId);
-      throw new AppError(
-        401,
-        'access_revoked',
-        'The user is no longer a member of this workspace.',
-      );
+      throw accessRevoked();
     }
     return this.reissue({
       sessionId: grant.sessionId,
@@ -245,13 +271,16 @@ export class AuthService {
         .orderBy(asc(tenants.name)),
     );
 
-    const granted = await this.permissionService.forPrincipal(principal);
+    // রোল আর permission টোকেন থেকে না, এখনকার অবস্থা থেকে: টোকেনের roles ১৫ মিনিট পুরনো হতে পারে
+    // (কেউ রোল বদলালে বা রোলের নাম বদলালে), UI-র মেনু তখন ভুল জিনিস দেখাত
+    const access = await this.permissionService.forPrincipal(principal);
+    if (!access) throw accessRevoked();
 
     return {
       user: { id: user.id, email: user.email, fullName: user.fullName },
       tenant,
-      roles: [...principal.roles],
-      permissions: [...granted].sort(),
+      roles: access.roles,
+      permissions: access.permissions,
       memberships: workspaces,
       preferences: { language: user.language, theme: user.theme },
     };
@@ -351,7 +380,7 @@ export class AuthService {
     );
   }
 
-  // একটা transaction: tenant → (context বসিয়ে) membership → Owner রোল → সব permission → রোল বরাদ্দ
+  // একটা transaction: tenant → (context বসিয়ে) membership → owner রোল → রোল বরাদ্দ
   private async provisionWorkspace(
     userId: string,
     input: SignUpInput,
@@ -370,24 +399,14 @@ export class AuthService {
         .insert(memberships)
         .values({ tenantId: tenant.id, userId, createdBy: userId })
         .returning({ id: memberships.id });
+      // kind: 'owner' — অধিকার কোডে (PermissionService), তাই role_permissions-এ কিছু লেখা লাগে না,
+      // আর পরে নতুন permission এলে এই workspace আপনা-আপনি পায়
       const [owner] = await tx
         .insert(roles)
-        .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, createdBy: userId })
+        .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, kind: 'owner', createdBy: userId })
         .returning({ id: roles.id });
       if (!membership || !owner) throw new Error('Membership or role insert returned no row');
 
-      const allPermissions = await tx.select({ id: permissions.id }).from(permissions);
-      if (allPermissions.length === 0) {
-        throw new Error('The permissions table is empty — run `pnpm db:migrate`');
-      }
-      await tx.insert(rolePermissions).values(
-        allPermissions.map((permission) => ({
-          tenantId: tenant.id,
-          roleId: owner.id,
-          permissionId: permission.id,
-          createdBy: userId,
-        })),
-      );
       await tx.insert(membershipRoles).values({
         tenantId: tenant.id,
         membershipId: membership.id,
```

- `createAccount`, `verifyPassword` — Better Auth-এর `AuthError` থেকে আমাদের `AppError`-এ বদল এখন এক জায়গায়;
  signup/login আর invitation একই কোড চালায়। ADR 0002-এর নিয়ম বজায়: `AuthError` facade-এর বাইরে যায় না।
- `startSessionIn` — invitation গ্রহণের শেষ ধাপ। membership না পেলে (খুবই বিরল race: join আর এর মাঝে কেউ সরিয়ে দিল)
  Better Auth-এর session ফেলে দিয়ে 401।
- `me()` — `roles` আগে টোকেনের claim থেকে (`principal.roles`) আসত: কেউ রোল বদলালে বা রোলের নাম বদলালে ১৫ মিনিট পুরনো নাম
  সাইডবারে। এখন `Access` থেকে, যা invalidate হয়।
- provisioning-এ `permissions` পড়া আর `role_permissions` insert বাদ — "permissions table is empty" error-টাও আর লাগে না
  (owner-এর অধিকার টেবিলের উপর নির্ভর করে না)।

**ফাইল: `apps/api/src/auth/auth.module.ts`** (আপডেট)

```diff
--- a/apps/api/src/auth/auth.module.ts
+++ b/apps/api/src/auth/auth.module.ts
@@ -9,5 +9,6 @@ import { MeController } from './me.controller.js';
   imports: [RbacModule],
   controllers: [AuthController, MeController],
   providers: [AuthService],
+  exports: [AuthService],
 })
 export class AuthModule {}
```

### রোল

**ফাইল: `apps/api/src/roles/roles.service.ts`** (নতুন)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditChanges,
  PermissionKey,
  PermissionMatrixInput,
  Role,
  RoleInput,
} from '@omnivo/contracts';
import {
  invitationRoles,
  invitations,
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
} from '@omnivo/db';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { assertCanChangePermissions, loadRoles } from '../rbac/grants.js';
import { PermissionService } from '../rbac/permission.service.js';

type RoleRow = typeof roles.$inferSelect;

function snapshot(row: Pick<RoleRow, 'name' | 'description'>) {
  return { name: row.name, description: row.description };
}

function nameTaken(): AppError {
  return new AppError(409, 'role_name_taken', 'Another role already has this name.', {
    fieldErrors: { name: ['role_name_taken'] },
  });
}

// owner রোলের নাম, permission আর অস্তিত্ব — কোডের নিয়ম, ডেটার না (roles.kind দেখুন)
function ownerLocked(): AppError {
  return new AppError(409, 'owner_role_locked', 'The Owner role cannot be changed or deleted.');
}

function roleInUse(): AppError {
  return new AppError(
    409,
    'role_in_use',
    'Someone has this role or an open invitation gives it. Change that first.',
  );
}

@Injectable()
export class RolesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissionService: PermissionService,
  ) {}

  list(): Promise<Role[]> {
    return this.withTenant((tx) => this.readAll(tx));
  }

  async create(input: RoleInput): Promise<Role> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        // নতুন রোল ফাঁকা — কোন permission পাবে সেটা matrix-এ টিক দিয়ে, যেখানে পাশাপাশি অন্য রোলগুলোও দেখা যায়
        const [row] = await tx
          .insert(roles)
          .values({ tenantId, ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Role insert returned no row');
        await audit(tx, {
          action: 'role.created',
          entityType: 'role',
          entityId: row.id,
          changes: created(snapshot(row)),
        });
        return this.readOne(tx, row.id);
      });
    } catch (error) {
      // branches-এর মতো: unique index-ই শেষ কথা, আগে SELECT করে দেখা না (দুজন একসাথে একই নাম দিলে)
      if (isUniqueViolation(error, 'roles_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: RoleInput & { version: number }): Promise<Role> {
    const tenantId = getTenantId();
    try {
      const { role, holders } = await this.withTenant(async (tx) => {
        const { version, ...fields } = input;
        const before = await this.lock(tx, id);
        if (before.kind === 'owner') throw ownerLocked();
        if (before.version !== version) throw versionConflict();
        await tx
          .update(roles)
          .set({
            ...fields,
            version: sql`${roles.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(roles.tenantId, tenantId), eq(roles.id, id)));
        await audit(tx, {
          action: 'role.updated',
          entityType: 'role',
          entityId: id,
          changes: diff(snapshot(before), snapshot(fields)),
        });
        return { role: await this.readOne(tx, id), holders: await this.holders(tx, [id]) };
      });
      // নাম বদলালে /auth/me-র roles-এ নতুন নাম — cache-এ পুরনোটা থাকলে ১০ মিনিট পুরনো নাম দেখাত
      await this.permissionService.invalidate(tenantId, holders);
      return role;
    } catch (error) {
      if (isUniqueViolation(error, 'roles_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.kind === 'owner') throw ownerLocked();
        if (before.version !== version) throw versionConflict();

        // কারো কাছে থাকলে বা খোলা invitation দিলে মোছা না — চুপচাপ মুছলে সেই লোকগুলোর অধিকার হঠাৎ
        // চলে যেত, আর invitation গ্রহণ করা লোক ঢুকে দেখত সে কিছুই পারে না
        const [members] = await tx
          .select({ total: count() })
          .from(membershipRoles)
          .innerJoin(
            memberships,
            and(
              eq(memberships.tenantId, membershipRoles.tenantId),
              eq(memberships.id, membershipRoles.membershipId),
            ),
          )
          .where(
            and(
              eq(membershipRoles.tenantId, tenantId),
              eq(membershipRoles.roleId, id),
              isNull(memberships.deletedAt),
            ),
          );
        const [open] = await tx
          .select({ total: count() })
          .from(invitationRoles)
          .innerJoin(
            invitations,
            and(
              eq(invitations.tenantId, invitationRoles.tenantId),
              eq(invitations.id, invitationRoles.invitationId),
            ),
          )
          .where(
            and(
              eq(invitationRoles.tenantId, tenantId),
              eq(invitationRoles.roleId, id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          );
        if ((members?.total ?? 0) + (open?.total ?? 0) > 0) throw roleInUse();

        await tx
          .delete(rolePermissions)
          .where(and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.roleId, id)));
        // পুরনো (গৃহীত/বাতিল) invitation-এর invitation_roles রো FK-এর cascade-এ যায়
        await tx.delete(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.id, id)));
        await audit(tx, {
          action: 'role.deleted',
          entityType: 'role',
          entityId: id,
          changes: diff(snapshot(before), { name: null, description: null }),
        });
      });
    } catch (error) {
      // গোনার পরে, মোছার আগে আরেকজন কাউকে এই রোল দিয়ে ফেলল — তার insert এই রোলের রো-তে FK-র lock
      // নেয়, তাই আমাদের DELETE তার commit পর্যন্ত অপেক্ষা করে তারপর FK-তে ভাঙে। শেষ পাহারা DB নিজে
      if (isForeignKeyViolation(error, 'membership_roles_role_fk')) throw roleInUse();
      throw error;
    }
  }

  async updateMatrix(input: PermissionMatrixInput): Promise<Role[]> {
    const tenantId = getTenantId();
    const access = await this.permissionService.ofCurrentUser();
    const ids = input.roles.map((change) => change.id);
    if (new Set(ids).size !== ids.length) {
      throw new AppError(400, 'invalid_input', 'Each role may appear only once.', {
        fieldErrors: { roles: ['invalid_value'] },
      });
    }

    const { list, holders } = await this.withTenant(async (tx) => {
      // সব রোল একসাথে lock, id-র ক্রমে — দুজন একসাথে দুটো ওভারল্যাপ করা matrix সেভ করলে একই ক্রমে
      // অপেক্ষা করে, একে অন্যকে আটকে deadlock হয় না (branches.archive-এর মতো)
      const locked = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.tenantId, tenantId), inArray(roles.id, ids)))
        .orderBy(asc(roles.id))
        .for('update');
      if (locked.length !== ids.length) throw notFound('Role');
      const current = await loadRoles(tx, tenantId, ids);
      const catalog = await tx
        .select({ id: permissions.id, key: permissions.key })
        .from(permissions);
      const idOf = new Map(catalog.map((row) => [row.key, row.id]));
      const permissionIds = (keys: PermissionKey[]) =>
        keys.flatMap((key) => {
          const permissionId = idOf.get(key);
          return permissionId === undefined ? [] : [permissionId];
        });

      const changed: string[] = [];
      for (const change of input.roles) {
        const row = locked.find((candidate) => candidate.id === change.id);
        const before = current.find((candidate) => candidate.id === change.id);
        if (!row || !before) throw notFound('Role');
        if (row.kind === 'owner') throw ownerLocked();
        if (row.version !== change.version) throw versionConflict();

        const next = new Set(change.permissions);
        const added = [...next].filter((key) => !before.permissions.includes(key));
        const removed = before.permissions.filter((key) => !next.has(key));
        // পাঠানো তালিকা আগেরটাই — version বাড়ানো বা audit-এ খালি "বদল" লেখার কারণ নেই
        if (added.length === 0 && removed.length === 0) continue;
        assertCanChangePermissions(access, [...added, ...removed]);

        if (removed.length > 0) {
          await tx
            .delete(rolePermissions)
            .where(
              and(
                eq(rolePermissions.tenantId, tenantId),
                eq(rolePermissions.roleId, row.id),
                inArray(rolePermissions.permissionId, permissionIds(removed)),
              ),
            );
        }
        if (added.length > 0) {
          await tx.insert(rolePermissions).values(
            permissionIds(added).map((permissionId) => ({
              tenantId,
              roleId: row.id,
              permissionId,
              createdBy: currentPrincipal().userId,
            })),
          );
        }
        await tx
          .update(roles)
          .set({ version: sql`${roles.version} + 1`, updatedBy: currentPrincipal().userId })
          .where(and(eq(roles.tenantId, tenantId), eq(roles.id, row.id)));

        // audit-এর ঘর = permission key, মান = আগে/পরে আছে কি না। viewer key-টা অনুবাদ করে দেখায়
        const changes: AuditChanges = {};
        for (const key of added) changes[key] = { from: false, to: true };
        for (const key of removed) changes[key] = { from: true, to: false };
        await audit(tx, {
          action: 'role.permissions_changed',
          entityType: 'role',
          entityId: row.id,
          changes,
        });
        changed.push(row.id);
      }

      return { list: await this.readAll(tx), holders: await this.holders(tx, changed) };
    });

    // commit-এর পরে: এই রোলগুলো যাদের আছে, তাদের পরের request-এই নতুন অধিকার
    await this.permissionService.invalidate(tenantId, holders);
    return list;
  }

  // এই রোলগুলো যাদের আছে (চালু সদস্য) — cache মোছার তালিকা
  private async holders(tx: Transaction, roleIds: readonly string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ userId: memberships.userId })
      .from(membershipRoles)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, membershipRoles.tenantId),
          eq(memberships.id, membershipRoles.membershipId),
        ),
      )
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          inArray(membershipRoles.roleId, [...roleIds]),
          isNull(memberships.deletedAt),
        ),
      );
    return rows.map((row) => row.userId);
  }

  private async readOne(tx: Transaction, id: string): Promise<Role> {
    const role = (await this.readAll(tx)).find((candidate) => candidate.id === id);
    if (!role) throw notFound('Role');
    return role;
  }

  // পুরো তালিকা: রোল, প্রত্যেকের permission আর সদস্য-সংখ্যা। তিনটা query, রোলের সংখ্যা যা-ই হোক —
  // রোলপ্রতি আলাদা query (N+1) না
  private async readAll(tx: Transaction): Promise<Role[]> {
    const tenantId = getTenantId();
    const rows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), isNull(roles.deletedAt)))
      // owner সবার আগে (matrix-এর প্রথম কলাম), বাকিগুলো নাম অনুযায়ী
      .orderBy(desc(sql`${roles.kind} = 'owner'`), asc(roles.name));
    const loaded = await loadRoles(
      tx,
      tenantId,
      rows.map((row) => row.id),
    );
    const counts = await tx
      .select({ roleId: membershipRoles.roleId, total: count() })
      .from(membershipRoles)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, membershipRoles.tenantId),
          eq(memberships.id, membershipRoles.membershipId),
        ),
      )
      .where(and(eq(membershipRoles.tenantId, tenantId), isNull(memberships.deletedAt)))
      .groupBy(membershipRoles.roleId);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind,
      permissions: loaded.find((role) => role.id === row.id)?.permissions ?? [],
      memberCount: counts.find((entry) => entry.roleId === row.id)?.total ?? 0,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  // tenant filter + RLS: অন্য টেন্যান্টের id দিলে "নেই" — 404, 403 না (branches-এর মতো)
  private async lock(tx: Transaction, id: string): Promise<RoleRow> {
    const [row] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, getTenantId()), eq(roles.id, id), isNull(roles.deletedAt)))
      .for('update');
    if (!row) throw notFound('Role');
    return row;
  }
}
```

- `create` — নতুন রোল ফাঁকা: কোন permission পাবে সেটা matrix-এ ঠিক হয়, যেখানে অন্য রোলগুলো পাশাপাশি দেখা যায়।
  `readOne(tx, row.id)` — `Role`-এর আকার (memberCount, permissions) একটাই জায়গা থেকে বানানো।
- `update` — `holders` (যাদের রোলটা আছে) transaction-এর ভেতরে পড়া, invalidate commit-এর পরে (ভিত্তি-সিদ্ধান্ত ৭)।
- `remove` — দুটো গোনা, তারপর মোছা। `role_permissions` আগে মোছা (FK NO ACTION), তারপর রোল; `invitation_roles`-এর পুরনো
  রো cascade-এ যায়। catch-এ `isForeignKeyViolation(..., 'membership_roles_role_fk')` — race-এর শেষ পাহারা: গোনার পরে
  আরেকজন কাউকে রোলটা দিলে তার insert রোলের রো-তে FK-র `FOR KEY SHARE` lock নেয়, আমাদের DELETE অপেক্ষা করে, তারপর FK-তে
  ভাঙে — 500 না, `role_in_use`।
- `role.deleted`-এর audit: `diff(snapshot(before), { name: null, description: null })` — viewer-এ "Name: Accountant → —"।
- `updateMatrix`:
  - একই id দুবার → 400, কারণ দুবার এলে কোনটা মানা হবে বলা যায় না।
  - `.orderBy(asc(roles.id)).for('update')` — সব রোল একসাথে, একই ক্রমে lock (deadlock এড়ানো — ধাপ ৬-এর branch-এর মতো)।
  - লুপের ভেতরে প্রথম error-ই পুরো transaction rollback করে — "সব, নয় কিছুই না" (৭.৫-এ প্রমাণ: দ্বিতীয় রোলের version
    পুরনো, প্রথমটাও সেভ হয়নি)।
  - owner-এর চেক version-এর আগে — owner-কে বদলানোর চেষ্টায় "version_conflict" দেখানো ভুল দিকনির্দেশ।
  - কিছু না বদলালে `continue` — version বাড়ে না, audit-এ খালি ঘটনা লেখা হয় না।
  - `permissionIds()` — key → `permissions.id`; catalog-এ নেই এমন key (হতে পারে না, schema enum) নিঃশব্দে বাদ, `!` ছাড়া।
  - audit-এর ঘর = permission key, মান `true/false` — viewer সেটা অনুবাদ করে (৭.৮)।
  - উত্তরে পুরো নতুন তালিকা — app আরেকটা GET না করে ক্যাশ হালনাগাদ করে।
- `readAll` — তিনটা query যত রোলই থাকুক (N+1 না)। `desc(sql\`kind = 'owner'\`)` — boolean-এ `true` আগে: owner সবসময়
  matrix-এর প্রথম কলাম।
- `roleInUse()` class-এর **আগে** — পরে লিখলেও চলে (function hoisting), কিন্তু পড়তে গিয়ে "এটা কোথায়?" খুঁজতে হয়।

**ফাইল: `apps/api/src/roles/roles.controller.ts`** আর **`roles.module.ts`** (নতুন)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { RolesService } from './roles.service.js';

type Routes = typeof routes.roles;

// permission চুক্তিতে (routes.roles.*.permission) — এখানে শুধু ইনপুট থেকে service-এ
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Endpoint(routes.roles.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.roles.list() };
  }

  @Endpoint(routes.roles.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.roles.create(body);
  }

  @Endpoint(routes.roles.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.roles.update(params.id, body);
  }

  @Endpoint(routes.roles.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.roles.remove(params.id, query.version);
  }

  @Endpoint(routes.roles.updateMatrix)
  async updateMatrix({
    body,
  }: RouteInput<Routes['updateMatrix']>): Promise<RouteResponse<Routes['updateMatrix']>> {
    return { items: await this.roles.updateMatrix(body) };
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';

@Module({
  imports: [RbacModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
```

- controller-এ কোনো permission নেই — চুক্তিতে। `remove` ফেরায় `Promise<void>`: চুক্তির response `z.void()`, status 204।
- `RbacModule` import — `PermissionService` একই instance (Nest module singleton), তাই cache-এর নিয়ম এক।

### সদস্য

list-এর কোড controller থেকে service-এ সরছে (বাকি সব module-এর মতো), আর যোগ হচ্ছে রোল বদল আর সরানো।

**ফাইল: `apps/api/src/members/members.service.ts`** (নতুন)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Member, MemberPage, MemberSort, RoleRef } from '@omnivo/contracts';
import { membershipRoles, memberships, roles, users } from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { assertCanGrant, loadRoles, type RoleGrant } from '../rbac/grants.js';
import { PermissionService } from '../rbac/permission.service.js';

interface MemberRow {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  version: number;
  joinedAt: Date;
}

const memberColumns = {
  membershipId: memberships.id,
  userId: users.id,
  fullName: users.fullName,
  email: users.email,
  version: memberships.version,
  joinedAt: memberships.createdAt,
};

// audit-এ রোলের তালিকা একটা লেখা হিসেবে ("Accountant, Store keeper") — audit-এর মান সরল হতেই হবে
function names(list: readonly { name: string }[]): string | null {
  return list.length === 0 ? null : list.map((role) => role.name).join(', ');
}

// নিজের রোল বদলানো বা নিজেকে বাদ দেওয়া বন্ধ: ভুল করে নিজেকে লক-আউট করা, আর "নিজেকে বড় রোল দেওয়া"
// — দুটোর পথই এক জায়গায় বন্ধ। নিজের অধিকার বদলাতে আরেকজন অ্যাডমিন লাগে
function ownMembership(): AppError {
  return new AppError(
    409,
    'own_membership',
    "You can't change your own roles or remove yourself. Ask another admin.",
  );
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissionService: PermissionService,
  ) {}

  list(query: {
    sort: MemberSort;
    limit: number;
    cursor?: string | undefined;
  }): Promise<MemberPage> {
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
        .select(memberColumns)
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
      return { items: await this.withRoles(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  async updateRoles(membershipId: string, roleIds: string[], version: number): Promise<Member> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();

    const member = await this.withTenant(async (tx) => {
      const before = await this.lock(tx, membershipId);
      if (before.userId === actor.userId) throw ownMembership();
      if (before.version !== version) throw versionConflict();

      const current = await this.rolesOf(tx, membershipId);
      const next = await loadRoles(tx, tenantId, roleIds);
      const added = next.filter((role) => !current.some((had) => had.id === role.id));
      const removed = current.filter((had) => !next.some((role) => role.id === had.id));
      // যা দেওয়া হচ্ছে আর যা কেড়ে নেওয়া হচ্ছে — দুটোই নিজের সীমার ভেতরে হতে হবে
      assertCanGrant(access, [...added, ...removed]);
      if (removed.some((role) => role.kind === 'owner')) {
        await this.assertAnotherOwner(tx, membershipId);
      }

      if (removed.length > 0) {
        await tx.delete(membershipRoles).where(
          and(
            eq(membershipRoles.tenantId, tenantId),
            eq(membershipRoles.membershipId, membershipId),
            inArray(
              membershipRoles.roleId,
              removed.map((role) => role.id),
            ),
          ),
        );
      }
      if (added.length > 0) {
        await tx.insert(membershipRoles).values(
          added.map((role) => ({
            tenantId,
            membershipId,
            roleId: role.id,
            createdBy: actor.userId,
          })),
        );
      }
      // রোল আলাদা টেবিলে, কিন্তু version সদস্যপদের — "এই মানুষের অধিকার" একটা জিনিস হিসেবে বদলায়
      await this.bump(tx, membershipId);
      if (added.length > 0 || removed.length > 0) {
        await audit(tx, {
          action: 'member.roles_changed',
          entityType: 'member',
          entityId: membershipId,
          changes: { roles: { from: names(current), to: names(next) } },
        });
      }
      const [row] = await this.withRoles(tx, [await this.lock(tx, membershipId)]);
      if (!row) throw notFound('Member');
      return row;
    });

    // commit-এর পরে (PermissionService.invalidate দেখুন) — তার পরের request-এই নতুন অধিকার
    await this.permissionService.invalidate(tenantId, [member.userId]);
    return member;
  }

  async remove(membershipId: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();

    const userId = await this.withTenant(async (tx) => {
      const before = await this.lock(tx, membershipId);
      if (before.userId === actor.userId) throw ownMembership();
      if (before.version !== version) throw versionConflict();

      const current = await this.rolesOf(tx, membershipId);
      // বাদ দেওয়া মানে তার সব রোল কেড়ে নেওয়া — তাই রোল বদলানোর একই নিয়ম: store keeper একজন
      // Accountant-কে বাদ দিতে পারে না, আর owner-কে বাদ দিতে পারে শুধু আরেকজন owner
      assertCanGrant(access, current);
      if (current.some((role) => role.kind === 'owner')) {
        await this.assertAnotherOwner(tx, membershipId);
      }

      await tx
        .delete(membershipRoles)
        .where(
          and(
            eq(membershipRoles.tenantId, tenantId),
            eq(membershipRoles.membershipId, membershipId),
          ),
        );
      // সদস্যপদ মোছা না, বন্ধ: তার আগের কাজের audit আর created_by অক্ষত থাকে, আর unique
      // (tenant_id, user_id) index-এর কারণে আবার invite করলে এই রো-টাই ফিরে আসে (invitations.service.ts)
      await tx
        .update(memberships)
        .set({
          deletedAt: new Date(),
          version: sql`${memberships.version} + 1`,
          updatedBy: actor.userId,
        })
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
      await audit(tx, {
        action: 'member.removed',
        entityType: 'member',
        entityId: membershipId,
        changes: {
          email: { from: before.email, to: null },
          roles: { from: names(current), to: null },
        },
      });
      return before.userId;
    });

    // cache মুছলে তার পরের request-এ PermissionGuard DB থেকে পড়ে দেখে সদস্যপদ নেই → 401 access_revoked।
    // টোকেনের বাকি ১৫ মিনিটের অপেক্ষা নেই
    await this.permissionService.invalidate(tenantId, [userId]);
  }

  // "অন্তত একজন owner থাকবে"। শুধু গুনে দেখা যথেষ্ট না (write skew — branches.archive-এর মতো): দুই
  // owner একসাথে একে অন্যকে সরালে দুজনেই "আরেকজন তো আছে" দেখত, আর owner থাকত শূন্য। তাই সব owner-এর
  // membership_roles রো lock, id-র ক্রমে। দ্বিতীয়জন প্রথমজনের commit পর্যন্ত অপেক্ষা করে, তারপর Postgres
  // রো-গুলো আবার দেখে — প্রথমজনের মোছা রো আর থাকে না, তাই সে ঠিক হিসাবটা পায়
  private async assertAnotherOwner(tx: Transaction, excluding: string): Promise<void> {
    const owners = await tx
      .select({ membershipId: membershipRoles.membershipId })
      .from(membershipRoles)
      .innerJoin(
        roles,
        and(eq(roles.tenantId, membershipRoles.tenantId), eq(roles.id, membershipRoles.roleId)),
      )
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, membershipRoles.tenantId),
          eq(memberships.id, membershipRoles.membershipId),
        ),
      )
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          eq(roles.kind, 'owner'),
          isNull(memberships.deletedAt),
        ),
      )
      .orderBy(asc(membershipRoles.id))
      .for('update', { of: membershipRoles });
    if (!owners.some((owner) => owner.membershipId !== excluding)) {
      throw new AppError(409, 'last_owner', 'A workspace needs at least one owner.');
    }
  }

  private async rolesOf(tx: Transaction, membershipId: string): Promise<RoleGrant[]> {
    const rows = await tx
      .select({ roleId: membershipRoles.roleId })
      .from(membershipRoles)
      .where(
        and(
          eq(membershipRoles.tenantId, getTenantId()),
          eq(membershipRoles.membershipId, membershipId),
          isNull(membershipRoles.deletedAt),
        ),
      );
    return loadRoles(
      tx,
      getTenantId(),
      rows.map((row) => row.roleId),
    );
  }

  // শুধু চালু সদস্য। FOR UPDATE শুধু memberships-এর রো-তে — users global টেবিল, সেটা আটকানোর কারণ নেই
  private async lock(tx: Transaction, membershipId: string): Promise<MemberRow> {
    const [row] = await tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, getTenantId()),
          eq(memberships.id, membershipId),
          isNull(memberships.deletedAt),
        ),
      )
      .for('update', { of: memberships });
    if (!row) throw notFound('Member');
    return row;
  }

  private async bump(tx: Transaction, membershipId: string): Promise<void> {
    await tx
      .update(memberships)
      .set({ version: sql`${memberships.version} + 1`, updatedBy: currentPrincipal().userId })
      .where(and(eq(memberships.tenantId, getTenantId()), eq(memberships.id, membershipId)));
  }

  // রোল শুধু এই সদস্যদের — পুরো টেন্যান্টের না
  private async withRoles(tx: Transaction, rows: readonly MemberRow[]): Promise<Member[]> {
    const ids = rows.map((row) => row.membershipId);
    const roleRows =
      ids.length === 0
        ? []
        : await tx
            .select({
              membershipId: membershipRoles.membershipId,
              id: roles.id,
              name: roles.name,
            })
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
                eq(membershipRoles.tenantId, getTenantId()),
                inArray(membershipRoles.membershipId, ids),
                isNull(membershipRoles.deletedAt),
                isNull(roles.deletedAt),
              ),
            )
            .orderBy(asc(roles.name));

    const rolesByMembership = new Map<string, RoleRef[]>();
    for (const { membershipId, ...role } of roleRows) {
      rolesByMembership.set(membershipId, [...(rolesByMembership.get(membershipId) ?? []), role]);
    }
    return rows.map((row) => ({
      ...row,
      roles: rolesByMembership.get(row.membershipId) ?? [],
      joinedAt: row.joinedAt.toISOString(),
    }));
  }
}
```

- `memberColumns` একবার লেখা — list আর lock একই আকার পড়ে।
- `updateRoles`:
  - `ownMembership()` version-এর আগে — নিজের রো-তে version মিলুক বা না মিলুক উত্তর একই।
  - `added`/`removed` — পুরো তালিকা থেকে diff; শুধু বদলানো রোলই `assertCanGrant`-এ যায়: Nasrin (Team lead) Rahim-এর
    বিদ্যমান Owner রোল না ছুঁয়ে তাকে Store keeper দিতে পারলে? না — Rahim-এর Owner রোল `current`-এ আছে, নতুন তালিকায়
    না থাকলে সেটা `removed`, আর owner-রোল কেড়ে নেওয়া শুধু owner-এর কাজ। UI তাই Owner বাক্সটা বন্ধ রাখে।
  - `bump()` সবসময় (কিছু না বদলালেও) — কারণ ফর্ম সেভ মানে "আমি এই version দেখে এই অবস্থা চাই"; তবে audit শুধু বদল হলে।
  - শেষে আবার `lock` + `withRoles` — উত্তরে নতুন version আর রোল।
- `remove` — `assertCanGrant(access, current)`: সরানো = সব রোল কেড়ে নেওয়া। `membership_roles` **মোছা** (soft না) —
  `PermissionService` আর রোলের সদস্য-সংখ্যা দুটোই সহজ থাকে; ইতিহাস audit-এ।
- `assertAnotherOwner` — ভিত্তি-সিদ্ধান্ত ১০। `.for('update', { of: membershipRoles })` — `FOR UPDATE OF membership_roles`:
  join-এর roles আর memberships রো lock হয় না (অকারণে অন্য কাজ আটকাত), শুধু owner-দের রোল-রো। Postgres READ COMMITTED-এ
  lock পাওয়ার পরে রো-টা আবার দেখে (EvalPlanQual) — প্রথম transaction যে রো মুছেছে সেটা দ্বিতীয়জনের ফলে আসে না।
- `lock` — `for('update', { of: memberships })`: `users` global টেবিল, সেটা আটকানোর কারণ নেই।

**ফাইল: `apps/api/src/members/members.controller.ts`** আর **`members.module.ts`** (পুরো ফাইল বদল)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { MembersService } from './members.service.js';

type Routes = typeof routes.members;

@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Endpoint(routes.members.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.members.list(query);
  }

  @Endpoint(routes.members.updateRoles)
  updateRoles({
    params,
    body,
  }: RouteInput<Routes['updateRoles']>): Promise<RouteResponse<Routes['updateRoles']>> {
    return this.members.updateRoles(params.id, body.roleIds, body.version);
  }

  @Endpoint(routes.members.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.members.remove(params.id, query.version);
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [RbacModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
```

### invitation

**ফাইল: `apps/api/src/invitations/invitation-token.ts`** (নতুন)

```ts
import { createHash, randomBytes } from 'node:crypto';

// refresh token-এর মতোই (packages/auth/refresh-token.ts): ৩২ random byte, DB-তে শুধু SHA-256। token নিজে
// 256-bit random, তাই অনুমান করা অসম্ভব — bcrypt-এর মতো ধীর hash লাগে না
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInvitationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInvitationToken(token) };
}
```

**ফাইল: `apps/api/src/invitations/invitations.service.ts`** (নতুন)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Auth, IssuedTokens } from '@omnivo/auth';
import {
  type AcceptInvitationInput,
  type CreateInvitationInput,
  type Invitation,
  INVITATION_TTL_DAYS,
  invitationLink,
  type InvitationPreview,
  type RoleRef,
} from '@omnivo/contracts';
import {
  type Db,
  invitationRoles,
  invitations,
  membershipRoles,
  memberships,
  roles,
  tenants,
  users,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { AuthService } from '../auth/auth.service.js';
import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { AUTH, CONFIG, DB, WITH_TENANT } from '../infra/tokens.js';
import { invitationEmail } from '../mail/invitation-email.js';
import { MailService } from '../mail/mail.service.js';
import { assertCanGrant, loadRoles } from '../rbac/grants.js';
import { PermissionService } from '../rbac/permission.service.js';
import { hashInvitationToken, newInvitationToken } from './invitation-token.js';

type InvitationRow = typeof invitations.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

function expiry(): Date {
  return new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS);
}

// খোলা = গৃহীত বা বাতিল না, আর মেয়াদও আছে
function isUsable(row: InvitationRow): boolean {
  return row.acceptedAt === null && row.revokedAt === null && row.expiresAt > new Date();
}

function names(list: readonly { name: string }[]): string | null {
  return list.length === 0 ? null : list.map((role) => role.name).join(', ');
}

// লিংক ভুল, পুরনো, বাতিল বা আগেই ব্যবহার করা — সবগুলো একই উত্তর। কোনটা হয়েছে বলে দিলে অনুমান করা
// token-এর অবস্থা জানা যেত; আসল মানুষের জন্য সমাধান একটাই: নতুন লিংক চাওয়া
function invitationInvalid(): AppError {
  return new AppError(
    404,
    'invitation_invalid',
    'This invitation link is not valid any more. Ask for a new one.',
  );
}

function alreadyMember(): AppError {
  return new AppError(409, 'already_member', 'This person is already a member.', {
    fieldErrors: { email: ['already_member'] },
  });
}

function alreadyInvited(): AppError {
  return new AppError(409, 'already_invited', 'This person already has an open invitation.', {
    fieldErrors: { email: ['already_invited'] },
  });
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: Config,
    private readonly authService: AuthService,
    private readonly permissionService: PermissionService,
    private readonly mail: MailService,
  ) {}

  list(): Promise<Invitation[]> {
    return this.withTenant((tx) => this.readOpen(tx));
  }

  async create(input: CreateInvitationInput): Promise<Invitation> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();
    const { token, hash } = newInvitationToken();

    let invitationId: string;
    try {
      invitationId = await this.withTenant(async (tx) => {
        const granted = await loadRoles(tx, tenantId, input.roleIds);
        // invite = ভবিষ্যতে রোল দেওয়া — তাই এখনই একই নিয়ম (grants.ts)
        assertCanGrant(access, granted);

        const [member] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              eq(users.email, input.email),
              isNull(memberships.deletedAt),
            ),
          );
        if (member) throw alreadyMember();

        // একই ইমেইলের মেয়াদ পেরোনো খোলা invitation বন্ধ করা — নাহলে partial unique index নতুনটা আটকাত,
        // আর admin-কে আগে পুরনোটা হাতে বাতিল করতে হতো। মেয়াদ আছে এমনটা থাকলে index-ই 409 দেয়
        await tx
          .update(invitations)
          .set({
            revokedAt: new Date(),
            version: sql`${invitations.version} + 1`,
            updatedBy: actor.userId,
          })
          .where(
            and(
              eq(invitations.tenantId, tenantId),
              eq(invitations.email, input.email),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              lte(invitations.expiresAt, new Date()),
            ),
          );

        const [row] = await tx
          .insert(invitations)
          .values({
            tenantId,
            email: input.email,
            tokenHash: hash,
            expiresAt: expiry(),
            createdBy: actor.userId,
          })
          .returning({ id: invitations.id });
        if (!row) throw new Error('Invitation insert returned no row');
        await tx.insert(invitationRoles).values(
          granted.map((role) => ({
            tenantId,
            invitationId: row.id,
            roleId: role.id,
            createdBy: actor.userId,
          })),
        );
        await audit(tx, {
          action: 'member.invited',
          entityType: 'invitation',
          entityId: row.id,
          changes: created({ email: input.email, roles: names(granted) }),
        });
        return row.id;
      });
    } catch (error) {
      // দুজন admin একসাথে একই ইমেইল — partial unique index একজনকে আটকায় (আগে SELECT করে দেখা না)
      if (isUniqueViolation(error, 'invitations_tenant_email_open_idx')) throw alreadyInvited();
      throw error;
    }

    return this.deliver(invitationId, token, hash);
  }

  // নতুন token (পুরনো লিংক সাথে সাথে অচল), নতুন মেয়াদ, আবার ইমেইল। ইমেইল হারানো, মেয়াদ পেরোনো বা
  // "পাঠানো হয়নি" — তিনটারই এক সমাধান
  async resend(id: string, version: number): Promise<Invitation> {
    const tenantId = getTenantId();
    const actor = currentPrincipal();
    const access = await this.permissionService.ofCurrentUser();
    const { token, hash } = newInvitationToken();

    await this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id);
      if (before.version !== version) throw versionConflict();
      // আবার পাঠানো = আবার রোল দেওয়ার প্রস্তাব; যে পাঠাচ্ছে তার সীমায় থাকতে হবে
      assertCanGrant(access, await loadRoles(tx, tenantId, await this.roleIdsOf(tx, id)));
      await tx
        .update(invitations)
        .set({
          tokenHash: hash,
          expiresAt: expiry(),
          sentAt: null,
          version: sql`${invitations.version} + 1`,
          updatedBy: actor.userId,
        })
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id)));
      await audit(tx, {
        action: 'member.invitation_resent',
        entityType: 'invitation',
        entityId: id,
        // নতুন লিংক কাকে গেল — viewer-এ "Email: — → nasrin@…"
        changes: created({ email: before.email }),
      });
    });

    return this.deliver(id, token, hash);
  }

  async revoke(id: string, version: number): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id);
      if (before.version !== version) throw versionConflict();
      await tx
        .update(invitations)
        .set({
          revokedAt: new Date(),
          version: sql`${invitations.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id)));
      await audit(tx, {
        action: 'member.invitation_revoked',
        entityType: 'invitation',
        entityId: id,
        changes: { email: { from: before.email, to: null } },
      });
    });
  }

  // public: লিংক খুললে "কোন workspace, কে ডেকেছে"
  async lookup(token: string): Promise<InvitationPreview> {
    const invitation = await this.findByToken(token);
    // tenants আর users-এ RLS নেই (global টেবিল) — টেন্যান্ট জানার আগেই পড়া যায়
    const [tenant] = await this.db
      .select({ name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.id, invitation.tenantId), isNull(tenants.deletedAt)));
    if (!tenant) throw invitationInvalid();
    const [inviter] =
      invitation.createdBy === null
        ? []
        : await this.db
            .select({ fullName: users.fullName })
            .from(users)
            .where(eq(users.id, invitation.createdBy));
    const [account] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invitation.email));

    return {
      workspace: tenant,
      email: invitation.email,
      invitedBy: inviter?.fullName ?? null,
      accountExists: account !== undefined,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  // public: অ্যাকাউন্ট (নতুন বা পুরনো) → সদস্যপদ → session। Better Auth-এর ইউজার আর আমাদের সদস্যপদ আলাদা
  // transaction-এ (সাইনআপের মতোই), তাই মাঝপথে ব্যর্থ হলে হাতে ফেরানো
  async accept(input: AcceptInvitationInput): Promise<IssuedTokens> {
    const invitation = await this.findByToken(input.token);

    // ইমেইল invitation থেকে, ক্লায়েন্ট থেকে না — অন্য কারো অ্যাকাউন্টে invitation বসানোর উপায় নেই
    const identity =
      input.account === 'new'
        ? await this.authService.createAccount({
            email: invitation.email,
            fullName: input.fullName,
            password: input.password,
          })
        : await this.authService.verifyPassword({
            email: invitation.email,
            password: input.password,
            keepSignedIn: true,
          });

    try {
      await runWithTenant(invitation.tenantId, () =>
        this.withTenant((tx) => this.join(tx, invitation.id, identity.userId)),
      );
    } catch (error) {
      // যেমন: লিংক খোলা আর "Join" চাপার মাঝে admin invitation বাতিল করেছে। নতুন অ্যাকাউন্ট সদস্যপদ
      // ছাড়া পড়ে থাকলে ওই ইমেইলে আর সাইনআপও করা যেত না ("email taken"); পুরনো অ্যাকাউন্টের session শুধু বন্ধ
      if (input.account === 'new') await this.auth.deleteUser(identity.userId);
      else await this.auth.revokeSession(identity.sessionId);
      throw error;
    }

    await this.permissionService.invalidate(invitation.tenantId, [identity.userId]);
    return this.authService.startSessionIn(identity, invitation.tenantId);
  }

  // সদস্যপদ তৈরি বা ফেরানো, রোল বসানো, invitation বন্ধ — এক transaction-এ, টেন্যান্টের context-এ
  private async join(tx: Transaction, invitationId: string, userId: string): Promise<void> {
    const tenantId = getTenantId();
    // FOR UPDATE: একই লিংকে দুবার একসাথে "Join" (দুই ট্যাব) — দ্বিতীয়টা প্রথমটার commit পর্যন্ত অপেক্ষা
    // করে, তারপর acceptedAt দেখে থামে; দুটো সদস্যপদ বা দুবার রোল না
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitationId)))
      .for('update');
    if (!invitation || !isUsable(invitation)) throw invitationInvalid();

    const [existing] = await tx
      .select({ id: memberships.id, deletedAt: memberships.deletedAt })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .for('update');

    let membershipId: string;
    if (!existing) {
      const [row] = await tx
        .insert(memberships)
        .values({ tenantId, userId, createdBy: userId })
        .returning({ id: memberships.id });
      if (!row) throw new Error('Membership insert returned no row');
      membershipId = row.id;
    } else {
      membershipId = existing.id;
      // আগে বাদ দেওয়া মানুষ ফিরছে: unique (tenant_id, user_id) index-এর কারণে নতুন রো হয় না, পুরনোটাই
      // চালু — তার পুরনো audit আর কাজের ইতিহাস একই সদস্যপদে জোড়া থাকে
      if (existing.deletedAt !== null) {
        await tx
          .update(memberships)
          .set({ deletedAt: null, version: sql`${memberships.version} + 1`, updatedBy: userId })
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
      }
    }

    const granted = await tx
      .select({ id: roles.id, name: roles.name })
      .from(invitationRoles)
      .innerJoin(
        roles,
        and(eq(roles.tenantId, invitationRoles.tenantId), eq(roles.id, invitationRoles.roleId)),
      )
      .where(
        and(eq(invitationRoles.tenantId, tenantId), eq(invitationRoles.invitationId, invitationId)),
      )
      .orderBy(asc(roles.name));
    if (granted.length > 0) {
      await tx
        .insert(membershipRoles)
        .values(
          granted.map((role) => ({ tenantId, membershipId, roleId: role.id, createdBy: userId })),
        )
        // ইতিমধ্যে সদস্য (অন্য পথে ঢুকেছে) আর একই রোল আছে — দুবার না
        .onConflictDoNothing();
    }

    await tx
      .update(invitations)
      .set({
        acceptedAt: new Date(),
        version: sql`${invitations.version} + 1`,
        updatedBy: userId,
      })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitationId)));
    await audit(tx, {
      action: 'member.joined',
      entityType: 'member',
      entityId: membershipId,
      // public রুট — principal নেই, তাই কে করল সেটা বলে দেওয়া (লগইনের audit-এর মতো)
      actorUserId: userId,
      changes: created({ email: invitation.email, roles: names(granted) }),
    });
  }

  // token দিয়ে খোঁজা, টেন্যান্ট জানার আগে। invitations-এ FORCE RLS; migration 0010-এর invitation_by_token
  // policy শুধু সেই রো দেখায় যার hash এই transaction-এ বসানো — token না জানলে কিছুই দেখা যায় না
  private async findByToken(token: string): Promise<InvitationRow> {
    const hash = hashInvitationToken(token);
    const [row] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invitation_token_hash', ${hash}, true)`);
      return tx.select().from(invitations).where(eq(invitations.tokenHash, hash));
    });
    if (!row || !isUsable(row)) throw invitationInvalid();
    return row;
  }

  // commit-এর পরে ইমেইল — transaction-এর ভেতরে পাঠালে দুটো ভুল হতে পারত: চিঠি চলে গেল কিন্তু পরে
  // rollback (লিংক অচল), অথবা ধীর SMTP পুরো সময় DB-র lock ধরে রাখল। ধাপ ৮-এর outbox এটাকে পাকা করবে
  private async deliver(id: string, token: string, hash: string): Promise<Invitation> {
    const tenantId = getTenantId();
    const [context] = await this.withTenant((tx) =>
      tx
        .select({
          email: invitations.email,
          workspaceName: tenants.name,
          inviterName: users.fullName,
          language: users.language,
        })
        .from(invitations)
        .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
        .innerJoin(users, eq(users.id, currentPrincipal().userId))
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, id))),
    );
    if (!context) throw notFound('Invitation');

    const sent = await this.mail.send(
      invitationEmail({
        to: context.email,
        workspaceName: context.workspaceName,
        inviterName: context.inviterName,
        link: invitationLink(this.config.appOrigin, token),
        language: context.language ?? 'en',
      }),
    );

    return this.withTenant(async (tx) => {
      if (sent) {
        // token_hash-ও শর্তে: পাঠানোর মাঝে আরেকজন "Resend" করলে সেটা নতুন token — আমাদের পাঠানো পুরনো
        // লিংকের "পাঠানো হয়েছে" নতুনটার গায়ে বসত না
        await tx
          .update(invitations)
          .set({ sentAt: new Date() })
          .where(
            and(
              eq(invitations.tenantId, tenantId),
              eq(invitations.id, id),
              eq(invitations.tokenHash, hash),
            ),
          );
      }
      const [invitation] = await this.readOpen(tx, [id]);
      if (!invitation) throw notFound('Invitation');
      return invitation;
    });
  }

  private async lockOpen(tx: Transaction, id: string): Promise<InvitationRow> {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, getTenantId()),
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .for('update');
    if (!row) throw notFound('Invitation');
    return row;
  }

  private async roleIdsOf(tx: Transaction, invitationId: string): Promise<string[]> {
    const rows = await tx
      .select({ roleId: invitationRoles.roleId })
      .from(invitationRoles)
      .where(
        and(
          eq(invitationRoles.tenantId, getTenantId()),
          eq(invitationRoles.invitationId, invitationId),
        ),
      );
    return rows.map((row) => row.roleId);
  }

  // খোলা invitation-গুলো (বা শুধু ids), নতুন আগে, রোল আর কে ডেকেছে সহ
  private async readOpen(tx: Transaction, ids?: readonly string[]): Promise<Invitation[]> {
    const tenantId = getTenantId();
    const rows = await tx
      .select({ invitation: invitations, inviterName: users.fullName })
      .from(invitations)
      // left join: ডেকেছিলেন এমন কারো অ্যাকাউন্ট না থাকলেও invitation দেখা যায় (invitedBy: null)
      .leftJoin(users, eq(users.id, invitations.createdBy))
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          ids && inArray(invitations.id, [...ids]),
        ),
      )
      .orderBy(desc(invitations.createdAt));

    const invitationIds = rows.map((row) => row.invitation.id);
    const roleRows =
      invitationIds.length === 0
        ? []
        : await tx
            .select({ invitationId: invitationRoles.invitationId, id: roles.id, name: roles.name })
            .from(invitationRoles)
            .innerJoin(
              roles,
              and(
                eq(roles.tenantId, invitationRoles.tenantId),
                eq(roles.id, invitationRoles.roleId),
              ),
            )
            .where(
              and(
                eq(invitationRoles.tenantId, tenantId),
                inArray(invitationRoles.invitationId, invitationIds),
              ),
            )
            .orderBy(asc(roles.name));

    const rolesByInvitation = new Map<string, RoleRef[]>();
    for (const { invitationId, ...role } of roleRows) {
      rolesByInvitation.set(invitationId, [...(rolesByInvitation.get(invitationId) ?? []), role]);
    }

    return rows.map(({ invitation, inviterName }) => ({
      id: invitation.id,
      email: invitation.email,
      roles: rolesByInvitation.get(invitation.id) ?? [],
      invitedBy:
        invitation.createdBy !== null && inviterName !== null
          ? { id: invitation.createdBy, fullName: inviterName }
          : null,
      sentAt: invitation.sentAt?.toISOString() ?? null,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
      version: invitation.version,
    }));
  }
}
```

- `isUsable` — মেয়াদ JS-এর ঘড়িতে; lookup আর join দুটোতেই একই ফাংশন, তাই "lookup-এ ঠিক, join-এ মেয়াদ শেষ"-এর ফাঁক শুধু
  সত্যিকারের সময় পেরোলে।
- `invitationInvalid()` — ভুল, পুরনো, বাতিল, ব্যবহৃত — একই 404 (মন্তব্যে কেন)।
- `create`:
  - `loadRoles` + `assertCanGrant` আগে — ভুল রোলে বাকি কাজ শুরুই হয় না।
  - `already_member` — `users.email`-এ join; ইমেইল দুই জায়গাতেই lowercase (৭.১)।
  - মেয়াদ পেরোনো খোলা invitation আগে বন্ধ, তারপর insert — একই transaction-এ, তাই partial index নতুনটা মেনে নেয়।
  - `already_invited` catch-এ, withTenant-এর **বাইরে** — ধাপ ৬-এর branch-এর মতো: unique violation transaction-কে অচল
    করে, ভেতরে ধরে আর কিছু করা যায় না।
  - `token` শুধু memory-তে — `deliver()`-এ ইমেইলে যায়, তারপর হারিয়ে যায়। DB-তে শুধু hash।
- `resend` — নতুন `tokenHash` মানে পুরনো লিংক সাথে সাথে অচল (পুরনো hash আর কোনো রো-তে নেই)। `sentAt: null` — নতুন
  লিংক এখনো পাঠানো হয়নি।
- `lookup` — `tenants`, `users`-এ RLS নেই, তাই `this.db` সরাসরি।
- `accept`:
  - নতুন অ্যাকাউন্টে `email_taken` — এই ইমেইলে আগে থেকে অ্যাকাউন্ট থাকলে "new" দিয়ে দখল করা যায় না (৭.৫-এর "hijack"
    টেস্ট)। উল্টো: "existing"-এ ভুল পাসওয়ার্ড → `invalid_credentials`, invitation খোলাই থাকে।
  - compensating action — signup-এর মতো। ক্রম গুরুত্বপূর্ণ: আগে অ্যাকাউন্ট/পাসওয়ার্ড (টেন্যান্টের বাইরে), তারপর
    টেন্যান্টের transaction; উল্টো ক্রমে পাসওয়ার্ড ভুল হলে সদস্যপদ তৈরি হয়ে যেত।
  - `invalidate` — ফিরে আসা সদস্যের পুরনো cache (খুবই বিরল) মুছে দেওয়া।
- `join`:
  - invitation-এর রো `FOR UPDATE` — দুই ট্যাবে একসাথে "Join" (মন্তব্যে)।
  - সদস্যপদ `FOR UPDATE` — একই মানুষ একই মুহূর্তে দুটো আলাদা invitation গ্রহণ করলে (দুই admin দুটো পাঠিয়েছিল? partial
    index সেটা আটকায়; তবু) দুটো insert unique index-এ ভাঙত।
  - `onConflictDoNothing()` — target ছাড়া: যেকোনো unique-এ চুপ। এখানে একটাই unique (`tenant, membership, role`)।
  - audit-এ `actorUserId: userId` — public রুটে principal নেই; `audit()` নিজে পেত না।
- `findByToken` — `this.db.transaction(...)`: `set_config(..., true)` transaction-local, তাই transaction লাগেই; শেষে
  setting নিজে মুছে যায়, pool-এর পরের request পায় না।
- `deliver` — তিনটা ধাপ, তিনটা আলাদা ছোট transaction: context পড়া → (DB ছাড়া) SMTP → `sent_at`। SMTP-র ৫ সেকেন্ড
  কোনো DB connection আটকে রাখে না।
- `readOpen` — `ids && inArray(...)`: `ids` না দিলে `undefined`, আর drizzle-এর `and()` `undefined` ফেলে দেয়।
  `leftJoin(users)` — ডেকেছিলেন এমন অ্যাকাউন্ট মুছে গেলেও তালিকা ভাঙে না।

**ফাইল: `apps/api/src/invitations/invitations.controller.ts`** আর **`invitations.module.ts`** (নতুন)

```ts
import { Controller, Header, Inject, Res } from '@nestjs/common';
import { type AuthSession, type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
import type { FastifyReply } from 'fastify';

import { sessionResponse } from '../auth/refresh-cookie.js';
import { Endpoint } from '../common/http/endpoint.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { InvitationsService } from './invitations.service.js';

type Routes = typeof routes.invitations;

@Controller()
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Endpoint(routes.invitations.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.invitations.list() };
  }

  @Endpoint(routes.invitations.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.invitations.create(body);
  }

  @Endpoint(routes.invitations.resend)
  resend({ params, body }: RouteInput<Routes['resend']>): Promise<RouteResponse<Routes['resend']>> {
    return this.invitations.resend(params.id, body.version);
  }

  @Endpoint(routes.invitations.revoke)
  revoke({ params, query }: RouteInput<Routes['revoke']>): Promise<void> {
    return this.invitations.revoke(params.id, query.version);
  }

  @Endpoint(routes.invitations.lookup)
  @Header('Cache-Control', 'no-store')
  lookup({ body }: RouteInput<Routes['lookup']>): Promise<RouteResponse<Routes['lookup']>> {
    return this.invitations.lookup(body.token);
  }

  // লগইনের মতোই: cookie-তে refresh token, JSON-এ access token
  @Endpoint(routes.invitations.accept)
  @Header('Cache-Control', 'no-store')
  async accept(
    { body }: RouteInput<Routes['accept']>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    return sessionResponse(reply, await this.invitations.accept(body), this.config.secureCookies);
  }
}
```

```ts
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  // AuthModule: গ্রহণের সময় অ্যাকাউন্ট তৈরি/পাসওয়ার্ড যাচাই আর session — লগইনের একই কোড
  imports: [AuthModule, RbacModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
```

- `Cache-Control: no-store` — lookup-এর উত্তরে ইমেইল, accept-এ access token; কোনো proxy বা ব্রাউজার ক্যাশে রাখবে না
  (লগইনের মতো)।
- `AuthModule` import — তাই ৭.৪-এর শুরুতে `auth.module.ts`-এ `exports: [AuthService]`।

### app module আর বাকি controller

**ফাইল: `apps/api/src/app.module.ts`** (আপডেট)

```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -19,10 +19,12 @@ import type { Config } from './config.js';
 import { DocsController } from './docs/docs.controller.js';
 import { HealthController } from './health/health.controller.js';
 import { InfraModule } from './infra/infra.module.js';
+import { InvitationsModule } from './invitations/invitations.module.js';
 import { MembersModule } from './members/members.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
 import { PermissionGuard } from './rbac/permission.guard.js';
 import { RbacModule } from './rbac/rbac.module.js';
+import { RolesModule } from './roles/roles.module.js';
 import { SettingsModule } from './settings/settings.module.js';
 
 @Module({})
@@ -36,6 +38,8 @@ export class AppModule implements NestModule {
         RbacModule,
         AuthModule,
         MembersModule,
+        InvitationsModule,
+        RolesModule,
         SettingsModule,
         BranchesModule,
         NumberingModule,
```

**settings, branches, numbering, audit, attachments-এর controller** — প্রতিটা থেকে `@RequirePermission(...)` লাইন আর
`import { RequirePermission } …` বাদ, আর কিছু না। যেমন:

```diff
--- a/apps/api/src/branches/branches.controller.ts
+++ b/apps/api/src/branches/branches.controller.ts
@@ -2,7 +2,6 @@ import { Controller } from '@nestjs/common';
 import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
 
 import { Endpoint } from '../common/http/endpoint.js';
-import { RequirePermission } from '../rbac/require-permission.decorator.js';
 import { BranchesService } from './branches.service.js';
 
 type Routes = typeof routes.branches;
@@ -23,19 +22,16 @@ export class BranchesController {
   }
 
   @Endpoint(routes.branches.create)
-  @RequirePermission('core.branch.manage')
   create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
     return this.branches.create(body);
   }
 
   @Endpoint(routes.branches.update)
-  @RequirePermission('core.branch.manage')
   update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
     return this.branches.update(params.id, body);
   }
 
   @Endpoint(routes.branches.archive)
-  @RequirePermission('core.branch.manage')
   archive({
     params,
     body,
@@ -44,7 +40,6 @@ export class BranchesController {
   }
 
   @Endpoint(routes.branches.restore)
-  @RequirePermission('core.branch.manage')
   restore({
     params,
     body,
```

`attachments.controller.ts`-এর মন্তব্যটাও:

```diff
--- a/apps/api/src/attachments/attachments.controller.ts
+++ b/apps/api/src/attachments/attachments.controller.ts
@@ -2,7 +2,6 @@ import { Controller } from '@nestjs/common';
 import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';
 
 import { Endpoint } from '../common/http/endpoint.js';
-import { RequirePermission } from '../rbac/require-permission.decorator.js';
 import { AttachmentsService } from './attachments.service.js';
 
 type Routes = typeof routes.attachments;
@@ -11,10 +10,9 @@ type Routes = typeof routes.attachments;
 export class AttachmentsController {
   constructor(private readonly attachments: AttachmentsService) {}
 
-  // এখন একটাই কাজ (লোগো), তাই সেটার permission। ইনভয়েসের PDF-এর মতো নতুন কাজ এলে permission আসবে
-  // purpose থেকে (ATTACHMENT_RULES-এ) — তখন এই decorator-এর জায়গায় service-এ চেক
+  // এখন একটাই কাজ (লোগো), তাই চুক্তিতে সেটার permission। ইনভয়েসের PDF-এর মতো নতুন কাজ এলে permission
+  // আসবে purpose থেকে (ATTACHMENT_RULES-এ) — তখন চুক্তির permission-এর জায়গায় service-এ চেক
   @Endpoint(routes.attachments.createUpload)
-  @RequirePermission('core.settings.manage')
   async createUpload({
     body,
   }: RouteInput<Routes['createUpload']>): Promise<RouteResponse<Routes['createUpload']>> {
@@ -22,7 +20,6 @@ export class AttachmentsController {
   }
 
   @Endpoint(routes.attachments.complete)
-  @RequirePermission('core.settings.manage')
   complete({ params }: RouteInput<Routes['complete']>): Promise<RouteResponse<Routes['complete']>> {
     return this.attachments.complete(params.id);
   }
```

---

## ৭.৫ — API-র টেস্ট

### সাহায্যকারী

**ফাইল: `apps/api/src/testing/app.ts`** (আপডেট)

```diff
--- a/apps/api/src/testing/app.ts
+++ b/apps/api/src/testing/app.ts
@@ -6,11 +6,13 @@ import { type Config, loadConfig } from '../config.js';
 import { configureApp, createAdapter } from '../configure-app.js';
 
 // .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
-// storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
+// storageUrl/mailUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল বা ইমেইল ছোঁয় না তার জন্য MinIO বা Mailpit
+// container তুলতে হয় না। অচল SMTP-তে পাঠানো সাথে সাথে ব্যর্থ হয় (port 1, connection refused)
 export function testConfig(urls: {
   databaseUrl: string;
   redisUrl: string;
   storageUrl?: string;
+  mailUrl?: string;
 }): Config {
   return loadConfig({
     NODE_ENV: 'test',
@@ -23,6 +25,7 @@ export function testConfig(urls: {
     S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
     S3_ACCESS_KEY_ID: 'omnivo',
     S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
+    SMTP_URL: urls.mailUrl ?? 'smtp://127.0.0.1:1',
   });
 }
 
```

- ডিফল্ট `smtp://127.0.0.1:1` — port 1-এ কেউ শোনে না, connection সাথে সাথে refused; যে টেস্ট ইমেইল দেখে না তার জন্য
  Mailpit তুলতে হয় না, আর invitation তৈরি হয় `sentAt: null` নিয়ে।

**ফাইল: `apps/api/src/testing/containers.ts`** (আপডেট)

```diff
--- a/apps/api/src/testing/containers.ts
+++ b/apps/api/src/testing/containers.ts
@@ -6,7 +6,7 @@ import { drizzle } from 'drizzle-orm/postgres-js';
 import { migrate } from 'drizzle-orm/postgres-js/migrator';
 import postgres from 'postgres';
 import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
-import { grantOwnerPermissions, syncPermissions } from '@omnivo/db';
+import { syncPermissions } from '@omnivo/db';
 
 // src/testing → src → api → apps → repo root
 const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
@@ -42,7 +42,6 @@ export async function startPostgres(): Promise<TestPostgres> {
   const migratorDb = drizzle(migratorClient);
   await migrate(migratorDb, { migrationsFolder: path.join(repoRoot, 'packages/db/migrations') });
   await syncPermissions(migratorDb);
-  await grantOwnerPermissions(migratorDb);
   await migratorClient.end();
 
   return {
@@ -88,3 +87,24 @@ export async function startStorage(): Promise<TestStorage> {
     url: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
   };
 }
+
+export interface TestMail {
+  container: StartedTestContainer;
+  smtpUrl: string;
+  // Mailpit-এর HTTP API — টেস্ট এখান থেকে পাঠানো চিঠি পড়ে (লিংক বের করে)
+  apiUrl: string;
+}
+
+// docker-compose-এর mail সার্ভিসের একই image
+export async function startMail(): Promise<TestMail> {
+  const container = await new GenericContainer('axllent/mailpit:v1.31.2')
+    .withExposedPorts(1025, 8025)
+    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
+    .start();
+  const host = container.getHost();
+  return {
+    container,
+    smtpUrl: `smtp://${host}:${String(container.getMappedPort(1025))}`,
+    apiUrl: `http://${host}:${String(container.getMappedPort(8025))}`,
+  };
+}
```

- `/readyz` — Mailpit-এর health endpoint; SMTP port খোলার আগে টেস্ট চিঠি পাঠালে ব্যর্থ হতো।
- `grantOwnerPermissions` বাদ — owner-এর অধিকার এখন কোডে।

### বদলানো পুরনো টেস্ট

**ফাইল: `apps/api/src/auth/auth.int.spec.ts`** (আপডেট)

```diff
--- a/apps/api/src/auth/auth.int.spec.ts
+++ b/apps/api/src/auth/auth.int.spec.ts
@@ -1,8 +1,12 @@
 import { randomUUID } from 'node:crypto';
 import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import type { Auth } from '@omnivo/auth';
-import { meResponseSchema, problemSchema, type SignUpInput } from '@omnivo/contracts';
-import { PERMISSIONS } from '@omnivo/db';
+import {
+  meResponseSchema,
+  PERMISSION_KEYS,
+  problemSchema,
+  type SignUpInput,
+} from '@omnivo/contracts';
 import postgres from 'postgres';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 
@@ -87,7 +91,7 @@ describe('sign-up', () => {
     expect(me.tenant.slug).toBe(rahman.workspaceSlug);
     expect(me.roles).toEqual(['Owner']);
     // Owner = catalog-এর সব permission; তালিকা হাতে লিখলে প্রতিটা নতুন permission-এ এই টেস্ট ভাঙত
-    expect(me.permissions).toEqual(PERMISSIONS.map((permission) => permission.key).sort());
+    expect(me.permissions).toEqual([...PERMISSION_KEYS].sort());
     expect(me.memberships).toHaveLength(1);
   });
 
@@ -416,29 +420,38 @@ describe('permissions', () => {
   });
 
   it('serves permissions from the Redis cache until they are invalidated', async () => {
-    const owner = sessionOf(
+    const nabil = sessionOf(
       await login({
         workspace: rahman.workspaceSlug,
-        email: rahman.email,
-        password: rahman.password,
+        email: 'nabil@example.com',
+        password: 'Depot-route-2026',
       }),
     );
     const call = () =>
-      app.inject({ method: 'GET', url: '/members', headers: bearer(owner.accessToken) });
-    expect((await call()).statusCode).toBe(200);
-
-    // Owner রোল থেকে core.user.read সরানো — DB বদলেছে, cache এখনো পুরনো
-    const [ids] = await superuser<{ tenant_id: string; user_id: string }[]>`
-      SELECT t.id AS tenant_id, u.id AS user_id FROM tenants t, users u
-      WHERE t.slug = ${rahman.workspaceSlug} AND u.email = ${rahman.email}`;
-    if (!ids) throw new Error('setup: tenant or user missing');
-    await superuser`
-      DELETE FROM role_permissions
-      WHERE tenant_id = ${ids.tenant_id}
-        AND permission_id = (SELECT id FROM permissions WHERE key = 'core.user.read')`;
-    expect((await call()).statusCode).toBe(200);
+      app.inject({ method: 'GET', url: '/members', headers: bearer(nabil.accessToken) });
+    expect((await call()).statusCode).toBe(403);
 
-    await app.get(PermissionService).invalidate(ids.tenant_id, ids.user_id);
+    // Nabil-কে core.user.read-ওয়ালা একটা রোল — DB বদলেছে, cache এখনো পুরনো ("কিছুই না")
+    const [ids] = await superuser<{ tenant_id: string; user_id: string; membership_id: string }[]>`
+      SELECT m.tenant_id, m.user_id, m.id AS membership_id
+      FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id
+      WHERE t.slug = ${rahman.workspaceSlug} AND u.email = 'nabil@example.com'`;
+    if (!ids) throw new Error('setup: membership missing');
+    await superuser.begin(async (sql) => {
+      const [role] = await sql<{ id: string }[]>`
+        INSERT INTO roles (id, tenant_id, name) VALUES (gen_random_uuid(), ${ids.tenant_id}, 'Depot supervisor')
+        RETURNING id`;
+      if (!role) throw new Error('setup: role insert failed');
+      await sql`
+        INSERT INTO role_permissions (id, tenant_id, role_id, permission_id)
+        SELECT gen_random_uuid(), ${ids.tenant_id}, ${role.id}, id FROM permissions WHERE key = 'core.user.read'`;
+      await sql`
+        INSERT INTO membership_roles (id, tenant_id, membership_id, role_id)
+        VALUES (gen_random_uuid(), ${ids.tenant_id}, ${ids.membership_id}, ${role.id})`;
+    });
     expect((await call()).statusCode).toBe(403);
+
+    await app.get(PermissionService).invalidate(ids.tenant_id, [ids.user_id]);
+    expect((await call()).statusCode).toBe(200);
   });
 });
```

- cache-এর টেস্ট আগে owner-এর `role_permissions` মুছে দেখাত। owner-এর অধিকার এখন কোডে, তাই সেটা মুছলে কিছুই বদলায় না —
  টেস্টটা কিছুই প্রমাণ করত না। নতুন রূপ: রোল-ছাড়া Nabil-কে SQL দিয়ে রোল দেওয়া → cache-এর কারণে এখনো 403 → invalidate →
  200।

**ফাইল: `apps/api/src/members/members.int.spec.ts`** (আপডেট)

```diff
--- a/apps/api/src/members/members.int.spec.ts
+++ b/apps/api/src/members/members.int.spec.ts
@@ -91,7 +91,9 @@ describe('keyset pagination', () => {
     ]);
     expect(new Set(everyone.map((m) => m.membershipId)).size).toBe(5);
     // শুধু সেই পাতার রোল — মালিকের Owner রোল ঠিক জায়গায়
-    expect(everyone.find((m) => m.fullName === 'Farhana Rahman')?.roles).toEqual(['Owner']);
+    expect(everyone.find((m) => m.fullName === 'Farhana Rahman')?.roles.map((r) => r.name)).toEqual(
+      ['Owner'],
+    );
   });
 
   it('pages the same way in reverse order', async () => {
```

### রোল আর matrix

**ফাইল: `apps/api/src/roles/roles.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Member,
  memberPageSchema,
  meResponseSchema,
  PERMISSION_KEYS,
  problemSchema,
  type Role,
  roleListSchema,
  roleSchema,
} from '@omnivo/contracts';
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
// Nasrin: নিজের workspace আছে, আর Rahman Garments-এ রোল ছাড়া সদস্য — এই ফাইলে তার অধিকার বদলায়
let nasrin: SignedIn;

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
  nasrin = await logIn(app, {
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

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function roleList(): Promise<Role[]> {
  return roleListSchema.parse((await send('GET', '/roles')).json()).items;
}

async function roleNamed(name: string): Promise<Role> {
  const role = (await roleList()).find((candidate) => candidate.name === name);
  if (!role) throw new Error(`no role ${name}`);
  return role;
}

async function memberByEmail(email: string): Promise<Member> {
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const member = items.find((candidate) => candidate.email === email);
  if (!member) throw new Error(`no member ${email}`);
  return member;
}

async function setMatrix(role: Role, permissions: string[], as = owner) {
  return send(
    'PUT',
    '/permission-matrix',
    { roles: [{ id: role.id, version: role.version, permissions }] },
    as,
  );
}

describe('roles', () => {
  it('starts with the Owner role, holding every permission from code', async () => {
    const [ownerRole, ...rest] = await roleList();
    expect(rest).toEqual([]);
    expect(ownerRole).toMatchObject({
      name: 'Owner',
      kind: 'owner',
      permissions: [...PERMISSION_KEYS].sort(),
      memberCount: 1,
    });
  });

  it('creates an empty custom role and refuses the same name in another case', async () => {
    const res = await send('POST', '/roles', { name: 'Accountant', description: '' });
    expect(res.statusCode).toBe(201);
    expect(roleSchema.parse(res.json())).toMatchObject({
      name: 'Accountant',
      description: null,
      kind: 'custom',
      permissions: [],
      memberCount: 0,
    });

    const twin = await send('POST', '/roles', { name: 'accountant', description: '' });
    expect(twin.statusCode).toBe(409);
    expect(problemSchema.parse(twin.json())).toMatchObject({
      code: 'role_name_taken',
      fieldErrors: { name: ['role_name_taken'] },
    });
  });

  it('never lets the Owner role be renamed, deleted or given a different set', async () => {
    const ownerRole = await roleNamed('Owner');
    const rename = await send('PUT', `/roles/${ownerRole.id}`, {
      name: 'Boss',
      description: '',
      version: ownerRole.version,
    });
    const remove = await send(
      'DELETE',
      `/roles/${ownerRole.id}?version=${String(ownerRole.version)}`,
    );
    const matrix = await setMatrix(ownerRole, ['core.user.read']);
    for (const res of [rename, remove, matrix]) {
      expect(res.statusCode).toBe(409);
      expect(problemSchema.parse(res.json()).code).toBe('owner_role_locked');
    }
  });
});

describe('permission matrix', () => {
  it("changes a member's access on their very next request, without waiting for the cache", async () => {
    // আগে একবার ডাকা — Nasrin-এর "কিছুই না" এখন Redis-এ
    expect((await send('GET', '/members', undefined, nasrin)).statusCode).toBe(403);

    const accountant = await roleNamed('Accountant');
    expect((await setMatrix(accountant, ['core.user.read', 'core.audit.read'])).statusCode).toBe(
      200,
    );
    const member = await memberByEmail('nasrin@rahmangarments.com');
    const assign = await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds: [accountant.id],
      version: member.version,
    });
    expect(assign.statusCode).toBe(200);
    expect((await send('GET', '/members', undefined, nasrin)).statusCode).toBe(200);

    // রোল থেকে permission তোলা — যাদের রোলটা আছে তাদের cache-ও মোছে
    const updated = await roleNamed('Accountant');
    expect((await setMatrix(updated, ['core.audit.read'])).statusCode).toBe(200);
    expect((await send('GET', '/members', undefined, nasrin)).statusCode).toBe(403);

    const me = meResponseSchema.parse((await send('GET', '/auth/me', undefined, nasrin)).json());
    expect(me.roles).toEqual(['Accountant']);
    expect(me.permissions).toEqual(['core.audit.read']);
  });

  it('saves every role or none: one stale version rolls the whole matrix back', async () => {
    await send('POST', '/roles', { name: 'Store keeper', description: 'Receives stock at depots' });
    const storeKeeper = await roleNamed('Store keeper');
    const accountant = await roleNamed('Accountant');
    const res = await send('PUT', '/permission-matrix', {
      roles: [
        { id: storeKeeper.id, version: storeKeeper.version, permissions: ['core.branch.manage'] },
        // পুরনো version — কেউ এর মধ্যে এই রোল বদলেছে
        { id: accountant.id, version: accountant.version - 1, permissions: [] },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('version_conflict');
    expect((await roleNamed('Store keeper')).permissions).toEqual([]);
  });

  it('writes one audit entry per changed role, with only the ticks that moved', async () => {
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=role&limit=100')).json(),
    );
    const changes = items
      .filter((entry) => entry.action === 'role.permissions_changed')
      .map((entry) => entry.changes);
    // নতুন আগে: শেষ বদল আগে
    expect(changes).toEqual([
      { 'core.user.read': { from: true, to: false } },
      {
        'core.user.read': { from: false, to: true },
        'core.audit.read': { from: false, to: true },
      },
    ]);
  });
});

describe('no escalation', () => {
  it('lets a role manager tick only the permissions they have themselves', async () => {
    // Nasrin-কে "Team lead": রোল সামলাতে পারে, আর সদস্য দেখতে পারে — কিন্তু সেটিংস না
    const created = roleSchema.parse(
      (await send('POST', '/roles', { name: 'Team lead', description: '' })).json(),
    );
    await setMatrix(created, ['core.role.manage', 'core.user.read', 'core.user.manage']);
    const member = await memberByEmail('nasrin@rahmangarments.com');
    const accountant = await roleNamed('Accountant');
    await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds: [accountant.id, created.id],
      version: member.version,
    });

    const storeKeeper = await roleNamed('Store keeper');
    const tooMuch = await setMatrix(storeKeeper, ['core.settings.manage'], nasrin);
    expect(tooMuch.statusCode).toBe(403);
    expect(problemSchema.parse(tooMuch.json()).code).toBe('cannot_grant');

    expect((await setMatrix(storeKeeper, ['core.user.read'], nasrin)).statusCode).toBe(200);
  });

  it('stops a manager from handing out or taking away the Owner role', async () => {
    // Rahim: আরেকজন, Rahman Garments-এ রোল ছাড়া
    await signUp(app, {
      companyName: 'Rahim Knitwear',
      workspaceSlug: 'rahim-knitwear',
      fullName: 'Rahim Uddin',
      email: 'rahim@rahmangarments.com',
      password: 'Ashulia-knit-2026',
    });
    await joinWithoutRoles(pg.superuserUrl, {
      email: 'rahim@rahmangarments.com',
      workspace: 'rahman-garments',
    });
    const rahim = await memberByEmail('rahim@rahmangarments.com');
    const ownerRole = await roleNamed('Owner');
    const teamLead = await roleNamed('Team lead');

    const makeOwner = await send(
      'PUT',
      `/members/${rahim.membershipId}/roles`,
      { roleIds: [ownerRole.id], version: rahim.version },
      nasrin,
    );
    expect(makeOwner.statusCode).toBe(403);
    expect(problemSchema.parse(makeOwner.json()).code).toBe('cannot_grant');

    // নিজের সমান রোল দেওয়া চলে — Team lead-এর সবই Nasrin-এর আছে
    const makeLead = await send(
      'PUT',
      `/members/${rahim.membershipId}/roles`,
      { roleIds: [teamLead.id], version: rahim.version },
      nasrin,
    );
    expect(makeLead.statusCode).toBe(200);

    // owner-কে বাদ দেওয়া = তার Owner রোল কেড়ে নেওয়া — শুধু আরেকজন owner পারে
    const farhana = await memberByEmail('farhana@rahmangarments.com');
    const removeOwner = await send(
      'DELETE',
      `/members/${farhana.membershipId}?version=${String(farhana.version)}`,
      undefined,
      nasrin,
    );
    expect(removeOwner.statusCode).toBe(403);
    expect(problemSchema.parse(removeOwner.json()).code).toBe('cannot_grant');
  });
});

describe('deleting a role', () => {
  it('refuses while someone has it, and allows it once nobody does', async () => {
    const accountant = await roleNamed('Accountant');
    const blocked = await send(
      'DELETE',
      `/roles/${accountant.id}?version=${String(accountant.version)}`,
    );
    expect(blocked.statusCode).toBe(409);
    expect(problemSchema.parse(blocked.json()).code).toBe('role_in_use');

    const member = await memberByEmail('nasrin@rahmangarments.com');
    const teamLead = await roleNamed('Team lead');
    await send('PUT', `/members/${member.membershipId}/roles`, {
      roleIds: [teamLead.id],
      version: member.version,
    });
    const fresh = await roleNamed('Accountant');
    expect(
      (await send('DELETE', `/roles/${fresh.id}?version=${String(fresh.version)}`)).statusCode,
    ).toBe(204);
    expect((await roleList()).map((role) => role.name)).toEqual([
      'Owner',
      'Store keeper',
      'Team lead',
    ]);
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=role&limit=100')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'role.deleted',
      changes: { name: { from: 'Accountant', to: null } },
    });
  });
});
```

- টেস্টগুলো ক্রমে চলে আর অবস্থা ভাগ করে (Accountant, Team lead…) — ধাপ ৬-এর branches-এর মতো। একটা একা চালালে
  (`-t`) আগেরগুলোর ডেটা পাবে না।
- "very next request" — প্রথমে ইচ্ছা করে একবার ডাকা, যাতে Nasrin-এর "কিছুই না" cache-এ বসে; নাহলে invalidate না করলেও
  টেস্ট পাস করত (cache-এ কিছু ছিলই না)।
- "Owner দেওয়া যায় না" টেস্ট **তৃতীয়** একজনকে (Rahim) লক্ষ্য করে। যাচাইয়ের প্রথম খসড়ায় Nasrin Farhana-কে Owner দিচ্ছিল —
  Farhana-র আগে থেকেই Owner, তাই `added` আর `removed` দুটোই ফাঁকা, নিয়ম চলেইনি, আর টেস্ট "পাস" করছিল কিছু প্রমাণ না করে।

### সদস্য ব্যবস্থাপনা আর শেষ owner

**ফাইল: `apps/api/src/members/members-admin.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  type Member,
  memberPageSchema,
  memberSchema,
  meResponseSchema,
  problemSchema,
  type Role,
  roleListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PermissionService } from '../rbac/permission.service.js';
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
let farhana: SignedIn;
let rahim: SignedIn;
let nasrin: SignedIn;

// তিনজন: Farhana (সাইনআপ করা owner), Rahim (পরে দ্বিতীয় owner), Nasrin (সাধারণ সদস্য)
const PEOPLE = [
  { fullName: 'Rahim Uddin', email: 'rahim@rahmangarments.com', password: 'Ashulia-knit-2026' },
  { fullName: 'Nasrin Akter', email: 'nasrin@rahmangarments.com', password: 'Tongi-store-2026' },
] as const;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  farhana = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  const sessions: SignedIn[] = [];
  for (const [index, person] of PEOPLE.entries()) {
    await signUp(app, {
      companyName: `${person.fullName} Traders`,
      workspaceSlug: `own-workspace-${String(index)}`,
      ...person,
    });
    await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'rahman-garments' });
    sessions.push(
      await logIn(app, {
        workspace: 'rahman-garments',
        email: person.email,
        password: person.password,
        keepSignedIn: false,
      }),
    );
  }
  [rahim, nasrin] = sessions as [SignedIn, SignedIn];
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

function send(method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object, as = farhana) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function member(email: string, as = farhana): Promise<Member> {
  const { items } = memberPageSchema.parse((await send('GET', '/members', undefined, as)).json());
  const found = items.find((candidate) => candidate.email === email);
  if (!found) throw new Error(`no member ${email}`);
  return found;
}

async function ownerRole(): Promise<Role> {
  const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
  const found = items.find((role) => role.kind === 'owner');
  if (!found) throw new Error('no owner role');
  return found;
}

describe('changing roles', () => {
  it('never lets someone change their own roles, even an owner', async () => {
    const me = await member('farhana@rahmangarments.com');
    const res = await send('PUT', `/members/${me.membershipId}/roles`, {
      roleIds: [],
      version: me.version,
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('own_membership');
  });

  it('makes Rahim a second owner, and refuses a save based on an old version', async () => {
    const target = await member('rahim@rahmangarments.com');
    const owner = await ownerRole();
    const res = await send('PUT', `/members/${target.membershipId}/roles`, {
      roleIds: [owner.id],
      version: target.version,
    });
    expect(res.statusCode).toBe(200);
    expect(memberSchema.parse(res.json())).toMatchObject({
      roles: [{ id: owner.id, name: 'Owner' }],
      version: target.version + 1,
    });

    const stale = await send('PUT', `/members/${target.membershipId}/roles`, {
      roleIds: [],
      version: target.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');
  });

  it('keeps one owner, even when two owners demote each other at the same moment', async () => {
    const farhanaRow = await member('farhana@rahmangarments.com');
    const rahimRow = await member('rahim@rahmangarments.com');
    const owner = await ownerRole();

    // দৌড়টা নিশ্চিতভাবে ঘটানো (branches-এর race টেস্টের মতো): আরেকটা transaction "Rahim Farhana-কে
    // সরাল" করে commit না করে ধরে রাখে, আর সেই ফাঁকে API-তে Farhana Rahim-কে সরাতে চায়। lock থাকলে
    // API অপেক্ষা করে, তারপর দেখে Farhana আর owner না → Rahim-ই শেষ owner → 409
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    let pending: ReturnType<typeof send> | undefined;
    await superuser.begin(async (tx) => {
      await tx`
        DELETE FROM membership_roles
        WHERE membership_id = ${farhanaRow.membershipId} AND role_id = ${owner.id}`;
      pending = send('PUT', `/members/${rahimRow.membershipId}/roles`, {
        roleIds: [],
        version: rahimRow.version,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await superuser.end();

    const res = await pending;
    expect(res?.statusCode).toBe(409);
    expect(problemSchema.parse(res?.json()).code).toBe('last_owner');
    const after = await member('rahim@rahmangarments.com');
    expect(after.roles.map((role) => role.name)).toEqual(['Owner']);

    // টেস্টের SQL (superuser) cache মোছে না — Farhana-র পুরনো "owner" মুছে দেওয়া, যাতে পরের টেস্ট
    // তার আসল অবস্থা (কোনো রোল নেই) দেখে
    const me = meResponseSchema.parse((await send('GET', '/auth/me', undefined, rahim)).json());
    await app.get(PermissionService).invalidate(me.tenant.id, [farhanaRow.userId]);
    expect((await send('GET', '/members')).statusCode).toBe(403);
  });
});

describe('removing a member', () => {
  it('locks them out on their next request, although their token has minutes left', async () => {
    // এখন owner শুধু Rahim (আগের টেস্ট) — তাই এখান থেকে সব কাজ Rahim-এর
    expect((await send('GET', '/branches', undefined, nasrin)).statusCode).toBe(200);
    const target = await member('nasrin@rahmangarments.com', rahim);
    const res = await send(
      'DELETE',
      `/members/${target.membershipId}?version=${String(target.version)}`,
      undefined,
      rahim,
    );
    expect(res.statusCode).toBe(204);

    const after = await send('GET', '/branches', undefined, nasrin);
    expect(after.statusCode).toBe(401);
    expect(problemSchema.parse(after.json()).code).toBe('access_revoked');
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { omnivo_rt: nasrin.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);

    // তালিকা থেকে গেছে, audit-এ কে কাকে সরাল
    const { items } = memberPageSchema.parse(
      (await send('GET', '/members', undefined, rahim)).json(),
    );
    expect(items.map((m) => m.email)).not.toContain('nasrin@rahmangarments.com');
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=member', undefined, rahim)).json(),
    );
    expect(audit.items[0]).toMatchObject({
      action: 'member.removed',
      actor: { fullName: 'Rahim Uddin' },
      changes: { email: { from: 'nasrin@rahmangarments.com', to: null } },
    });
  });
});
```

- race টেস্ট ধাপ ৬-এর branches-এর কৌশলে: superuser-এর খোলা transaction "Rahim Farhana-কে সরাল" করে ধরে রাখে, সেই ফাঁকে
  API-তে Farhana Rahim-কে সরাতে চায়। lock থাকলে API অপেক্ষা করে → 409। `assertAnotherOwner`-এর `.for('update', …)` মুছে
  চালালে টেস্ট fail করে (যাচাই করা) — মানে টেস্টটা সত্যিই lock-কে পাহারা দেয়।
- race-এর পরে `invalidate` — টেস্টের SQL cache মোছে না; নাহলে পরের টেস্টে Farhana ১০ মিনিট পুরনো "owner" নিয়ে কাজ করত আর
  টেস্ট ভুল কারণে পাস করত।
- "token থাকলেও 401" — PermissionGuard-এর `if (!access) throw accessRevoked()` বদলে `return true` করে চালালে fail করে।

### invitation, আসল ইমেইল সহ

**ফাইল: `apps/api/src/invitations/invitations.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
  memberPageSchema,
  meResponseSchema,
  problemSchema,
  type Role,
  roleSchema,
  settingsSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createTestApp, testConfig } from '../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, refreshCookieOf, type SignedIn, sessionOf, signUp } from '../testing/http.js';
import { hashInvitationToken } from './invitation-token.js';

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let owner: SignedIn;
let accountant: Role;
let merchandiser: Role;

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, mailUrl: mail.smtpUrl }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  // বিদ্যমান অ্যাকাউন্ট: Karim-এর নিজের workspace আছে, পরে Rahman Garments-এ invite হবে
  await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });

  accountant = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Accountant', description: '' })).json(),
  );
  merchandiser = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Merchandiser', description: '' })).json(),
  );
  await send('PUT', '/permission-matrix', {
    roles: [{ id: accountant.id, version: accountant.version, permissions: ['core.user.read'] }],
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn | null = owner,
) {
  return app.inject({
    method,
    url,
    ...(as && { headers: bearer(as.accessToken) }),
    ...(payload && { payload }),
  });
}

async function invite(email: string, roleIds: string[]) {
  const res = await send('POST', '/invitations', { email, roleIds });
  expect(res.statusCode).toBe(201);
  return invitationSchema.parse(res.json());
}

// Mailpit-এর HTTP API — বাইরের ডেটা, তাই schema দিয়ে পড়া (cast না)
const mailboxSchema = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
});
const messageSchema = z.object({ Text: z.string(), HTML: z.string() });

// এই ঠিকানায় সবশেষ চিঠি আর তার লিংকের token (Mailpit নতুন আগে দেয়)
async function lastMailTo(address: string) {
  const mailbox = mailboxSchema.parse(await (await fetch(`${mail.apiUrl}/api/v1/messages`)).json());
  const found = mailbox.messages.find((message) => message.To.some((to) => to.Address === address));
  if (!found) throw new Error(`no mail to ${address}`);
  const message = messageSchema.parse(
    await (await fetch(`${mail.apiUrl}/api/v1/message/${found.ID}`)).json(),
  );
  const token = /http:\/\/localhost:5173\/invite#([\w-]+)/.exec(message.Text)?.[1];
  if (!token) throw new Error('no invitation link in the mail');
  return { subject: found.Subject, html: message.HTML, token };
}

function lookup(token: string) {
  return send('POST', '/invitations/lookup', { token }, null);
}

function accept(payload: object) {
  return send('POST', '/invitations/accept', payload, null);
}

describe('inviting', () => {
  it('emails a one-time link and lists the invitation as sent', async () => {
    const invitation = await invite(' Tanvir@RahmanGarments.com ', [accountant.id]);
    expect(invitation).toMatchObject({
      email: 'tanvir@rahmangarments.com',
      roles: [{ id: accountant.id, name: 'Accountant' }],
      invitedBy: { fullName: 'Farhana Rahman' },
    });
    expect(invitation.sentAt).not.toBeNull();

    const sent = await lastMailTo('tanvir@rahmangarments.com');
    expect(sent.subject).toBe('Farhana Rahman invited you to Rahman Garments Ltd. on Omnivo');

    // DB-তে token নিজে নেই, শুধু তার hash
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    const [row] = await superuser<{ token_hash: string }[]>`
      SELECT token_hash FROM invitations WHERE email = 'tanvir@rahmangarments.com'`;
    await superuser.end();
    expect(row?.token_hash).toBe(hashInvitationToken(sent.token));
    expect(row?.token_hash).not.toContain(sent.token);

    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    expect(items.map((item) => item.email)).toEqual(['tanvir@rahmangarments.com']);
  });

  it('escapes names in the HTML mail, so a company name cannot become a link', async () => {
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: '<a href="https://evil.example">Rahman</a>',
    });
    await invite('rupa@rahmangarments.com', [merchandiser.id]);
    const sent = await lastMailTo('rupa@rahmangarments.com');
    expect(sent.html).not.toContain('<a href="https://evil.example">');
    expect(sent.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    await send('PUT', '/settings', {
      ...(await currentSettings()),
      companyName: 'Rahman Garments Ltd.',
    });
  });

  it('refuses a second open invitation, and someone already in the workspace', async () => {
    const twice = await send('POST', '/invitations', {
      email: 'tanvir@rahmangarments.com',
      roleIds: [merchandiser.id],
    });
    expect(twice.statusCode).toBe(409);
    expect(problemSchema.parse(twice.json()).fieldErrors).toEqual({ email: ['already_invited'] });

    const member = await send('POST', '/invitations', {
      email: 'farhana@rahmangarments.com',
      roleIds: [merchandiser.id],
    });
    expect(member.statusCode).toBe(409);
    expect(problemSchema.parse(member.json()).fieldErrors).toEqual({ email: ['already_member'] });

    const noRole = await send('POST', '/invitations', {
      email: 'shafiq@rahmangarments.com',
      roleIds: [],
    });
    expect(problemSchema.parse(noRole.json()).fieldErrors).toEqual({ roleIds: ['role_required'] });
  });
});

describe('accepting', () => {
  it('shows who invited whom, then creates the account and signs in', async () => {
    const { token } = await lastMailTo('tanvir@rahmangarments.com');
    const preview = invitationPreviewSchema.parse((await lookup(token)).json());
    expect(preview).toMatchObject({
      workspace: { name: 'Rahman Garments Ltd.', slug: 'rahman-garments' },
      email: 'tanvir@rahmangarments.com',
      invitedBy: 'Farhana Rahman',
      accountExists: false,
    });

    const res = await accept({
      account: 'new',
      token,
      fullName: 'Tanvir Hossain',
      password: 'Konabari-cut-2026',
    });
    expect(res.statusCode).toBe(200);
    // লগইনের মতোই: refresh token শুধু cookie-তে
    expect(refreshCookieOf(res)).toBeTruthy();
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, sessionOf(res))).json(),
    );
    expect(me).toMatchObject({
      user: { fullName: 'Tanvir Hossain', email: 'tanvir@rahmangarments.com' },
      tenant: { slug: 'rahman-garments' },
      roles: ['Accountant'],
      permissions: ['core.user.read'],
    });

    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    expect(items.map((item) => item.email)).not.toContain('tanvir@rahmangarments.com');
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=member')).json(),
    );
    expect(audit.items[0]).toMatchObject({
      action: 'member.joined',
      actor: { fullName: 'Tanvir Hossain' },
      changes: { roles: { from: null, to: 'Accountant' } },
    });
  });

  it('works only once', async () => {
    const { token } = await lastMailTo('tanvir@rahmangarments.com');
    const res = await lookup(token);
    expect(res.statusCode).toBe(404);
    expect(problemSchema.parse(res.json()).code).toBe('invitation_invalid');
  });

  it('adds an existing account only after checking its password', async () => {
    await invite('karim@karimpharma.com', [merchandiser.id]);
    const { token } = await lastMailTo('karim@karimpharma.com');
    expect(invitationPreviewSchema.parse((await lookup(token)).json()).accountExists).toBe(true);

    const wrong = await accept({ account: 'existing', token, password: 'not-his-password' });
    expect(wrong.statusCode).toBe(401);
    expect(problemSchema.parse(wrong.json()).code).toBe('invalid_credentials');
    // "নতুন অ্যাকাউন্ট" দিয়ে অন্যের ইমেইল দখল করা যায় না
    const hijack = await accept({
      account: 'new',
      token,
      fullName: 'Someone Else',
      password: 'Takeover-2026',
    });
    expect(hijack.statusCode).toBe(409);
    expect(problemSchema.parse(hijack.json()).code).toBe('email_taken');

    const res = await accept({ account: 'existing', token, password: 'Batch-expiry-2026' });
    expect(res.statusCode).toBe(200);
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, sessionOf(res))).json(),
    );
    expect(me.tenant.slug).toBe('rahman-garments');
    expect(me.memberships.map((membership) => membership.slug)).toEqual([
      'karim-pharma',
      'rahman-garments',
    ]);
  });

  it('brings a removed member back on the same membership, with only the new roles', async () => {
    const before = memberPageSchema
      .parse((await send('GET', '/members')).json())
      .items.find((member) => member.email === 'tanvir@rahmangarments.com');
    if (!before) throw new Error('setup: Tanvir missing');
    const removed = await send(
      'DELETE',
      `/members/${before.membershipId}?version=${String(before.version)}`,
    );
    expect(removed.statusCode).toBe(204);

    await invite('tanvir@rahmangarments.com', [merchandiser.id]);
    const { token } = await lastMailTo('tanvir@rahmangarments.com');
    const res = await accept({ account: 'existing', token, password: 'Konabari-cut-2026' });
    expect(res.statusCode).toBe(200);

    const after = memberPageSchema
      .parse((await send('GET', '/members')).json())
      .items.find((member) => member.email === 'tanvir@rahmangarments.com');
    expect(after?.membershipId).toBe(before.membershipId);
    expect(after?.roles.map((role) => role.name)).toEqual(['Merchandiser']);
  });
});

describe('resending and revoking', () => {
  it('sends a fresh link on resend; the old one stops working', async () => {
    const first = await lastMailTo('rupa@rahmangarments.com');
    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    const rupa = items.find((item) => item.email === 'rupa@rahmangarments.com');
    if (!rupa) throw new Error('setup: Rupa missing');

    const res = await send('POST', `/invitations/${rupa.id}/resend`, { version: rupa.version });
    expect(res.statusCode).toBe(200);
    expect(invitationSchema.parse(res.json()).version).toBe(rupa.version + 1);

    const second = await lastMailTo('rupa@rahmangarments.com');
    expect(second.token).not.toBe(first.token);
    expect((await lookup(first.token)).statusCode).toBe(404);
    expect((await lookup(second.token)).statusCode).toBe(200);
  });

  it('closes the link on revoke', async () => {
    const { token } = await lastMailTo('rupa@rahmangarments.com');
    const { items } = invitationListSchema.parse((await send('GET', '/invitations')).json());
    const rupa = items.find((item) => item.email === 'rupa@rahmangarments.com');
    if (!rupa) throw new Error('setup: Rupa missing');
    const res = await send('DELETE', `/invitations/${rupa.id}?version=${String(rupa.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await lookup(token)).statusCode).toBe(404);
    expect(
      invitationListSchema.parse((await send('GET', '/invitations')).json()).items,
    ).toHaveLength(0);
  });

  it('replaces an expired invitation instead of blocking a new one', async () => {
    await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    const { token } = await lastMailTo('mahbub@rahmangarments.com');
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    await superuser`
      UPDATE invitations SET expires_at = now() - interval '1 day'
      WHERE email = 'mahbub@rahmangarments.com'`;
    await superuser.end();
    expect((await lookup(token)).statusCode).toBe(404);

    const again = await invite('mahbub@rahmangarments.com', [merchandiser.id]);
    expect(again.sentAt).not.toBeNull();
  });
});

describe('when the mail server is down', () => {
  it('still creates the invitation, and says it was not sent', async () => {
    // একই DB আর Redis, কিন্তু অচল SMTP (testConfig-এর ডিফল্ট)
    const offline = await createTestApp(
      testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }),
    );
    try {
      const res = await offline.inject({
        method: 'POST',
        url: '/invitations',
        headers: bearer(owner.accessToken),
        payload: { email: 'sharmin@rahmangarments.com', roleIds: [merchandiser.id] },
      });
      expect(res.statusCode).toBe(201);
      expect(invitationSchema.parse(res.json()).sentAt).toBeNull();
    } finally {
      await offline.close();
    }
  });
});

// PUT /settings-এর body = GET-এর উত্তর (version সহ); বাড়তি logo ঘর চুক্তির schema নিজেই ফেলে দেয়
async function currentSettings() {
  return settingsSchema.parse((await send('GET', '/settings')).json());
}
```

- `mailboxSchema`/`messageSchema` — Mailpit-এর JSON বাইরের ডেটা; `any` না, schema।
- লিংকের regex `http://localhost:5173/invite#…` — `testConfig`-এর `APP_ORIGIN`; লিংক ঠিক জায়গায় যাচ্ছে সেটাও প্রমাণ।
- "escapes names" টেস্ট শেষে কোম্পানির নাম ফেরত দেয় — পরের টেস্টগুলো "Rahman Garments Ltd." দেখে।
- "mail server is down" — একই DB আর Redis-এ দ্বিতীয় app, অচল SMTP নিয়ে; `finally`-তে বন্ধ।

### tenant-leak

**ফাইল: `apps/api/src/invitations/team.tenant-leak.int.spec.ts`** (নতুন)

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  invitationListSchema,
  memberPageSchema,
  problemSchema,
  roleListSchema,
  roleSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { hashInvitationToken } from './invitation-token.js';

// ধাপ ৭-এর প্রতিটা নতুন endpoint-এ: টেন্যান্ট A-র টোকেন নিয়ে B-র id। উত্তর 404 (বা ইনপুটের 400) —
// কখনো 403 না, কারণ 403 মানে "আছে, কিন্তু তোমার না", সেটাও একটা ফাঁস
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let tenantA: SignedIn;
let tenantB: SignedIn;
let memberOfB: { id: string; version: number };
let roleOfB: { id: string; version: number };
let invitationOfB: { id: string; version: number };

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  as: SignedIn,
  payload?: object,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  // অচল SMTP (ডিফল্ট): invitation তৈরি হয়, ইমেইল যায় না — এখানে লিংক লাগে না
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

  const role = roleSchema.parse(
    (await send('POST', '/roles', tenantB, { name: 'Depot manager', description: '' })).json(),
  );
  roleOfB = { id: role.id, version: role.version };
  await send('POST', '/invitations', tenantB, {
    email: 'rupa@karimpharma.com',
    roleIds: [role.id],
  });
  const [invitation] = invitationListSchema.parse(
    (await send('GET', '/invitations', tenantB)).json(),
  ).items;
  if (!invitation) throw new Error('setup: invitation missing');
  invitationOfB = { id: invitation.id, version: invitation.version };

  const [bMember] = memberPageSchema.parse((await send('GET', '/members', tenantB)).json()).items;
  if (!bMember) throw new Error('setup: member missing');
  memberOfB = { id: bMember.membershipId, version: bMember.version };
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("tenant A can't reach tenant B's team", () => {
  it("answers 404 for B's member, role and invitation ids", async () => {
    const attempts = [
      send('PUT', `/members/${memberOfB.id}/roles`, tenantA, {
        roleIds: [],
        version: memberOfB.version,
      }),
      send('DELETE', `/members/${memberOfB.id}?version=${String(memberOfB.version)}`, tenantA),
      send('PUT', `/roles/${roleOfB.id}`, tenantA, {
        name: 'Taken over',
        description: '',
        version: roleOfB.version,
      }),
      send('DELETE', `/roles/${roleOfB.id}?version=${String(roleOfB.version)}`, tenantA),
      send('PUT', '/permission-matrix', tenantA, {
        roles: [{ id: roleOfB.id, version: roleOfB.version, permissions: ['core.audit.read'] }],
      }),
      send('POST', `/invitations/${invitationOfB.id}/resend`, tenantA, {
        version: invitationOfB.version,
      }),
      send(
        'DELETE',
        `/invitations/${invitationOfB.id}?version=${String(invitationOfB.version)}`,
        tenantA,
      ),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(404);
    }
  });

  it("won't let A invite someone into B's role", async () => {
    // B-র রোলের id — loadRoles-এর tenant filter + RLS সেটা খুঁজে পায় না, তাই "এমন রোল নেই" (ইনপুটের 400)
    const invite = await send('POST', '/invitations', tenantA, {
      email: 'someone@rahmangarments.com',
      roleIds: [roleOfB.id],
    });
    expect(invite.statusCode).toBe(400);
    expect(problemSchema.parse(invite.json()).fieldErrors).toEqual({ roleIds: ['invalid_value'] });
  });

  it("shows A only A's roles and invitations", async () => {
    const roles = roleListSchema.parse((await send('GET', '/roles', tenantA)).json()).items;
    expect(roles.map((role) => role.name)).toEqual(['Owner']);
    const invitations = invitationListSchema.parse(
      (await send('GET', '/invitations', tenantA)).json(),
    ).items;
    expect(invitations).toEqual([]);
  });
});

describe('the invitation_by_token policy', () => {
  it('shows one invitation, and only to someone who holds its token, and never for writing', async () => {
    // omnivo_app হিসেবে (NOBYPASSRLS), টেন্যান্ট context ছাড়া — ঠিক public lookup-এর অবস্থা
    const token = 'a-known-token-for-this-test-0123456789abcdef';
    const superuser = postgres(pg.superuserUrl, { max: 1 });
    await superuser`UPDATE invitations SET token_hash = ${hashInvitationToken(token)} WHERE id = ${invitationOfB.id}`;
    await superuser.end();

    const appDb = postgres(pg.appUrl, { max: 1 });
    try {
      const withoutToken = await appDb`SELECT id FROM invitations`;
      expect(withoutToken).toHaveLength(0);

      await appDb.begin(async (tx) => {
        await tx`SELECT set_config('app.invitation_token_hash', ${hashInvitationToken(token)}, true)`;
        const visible = await tx<{ id: string }[]>`SELECT id FROM invitations`;
        expect(visible.map((row) => row.id)).toEqual([invitationOfB.id]);
        // policy শুধু SELECT-এর — token জেনেও লেখা যায় না (গ্রহণ হয় টেন্যান্ট context-এ)
        const updated = await tx`UPDATE invitations SET revoked_at = now()`;
        expect(updated.count).toBe(0);
        // রোলগুলো দেখা যায় না — policy শুধু invitations-এ
        expect(await tx`SELECT id FROM invitation_roles`).toHaveLength(0);
      });
    } finally {
      await appDb.end();
    }
  });
});
```

- শেষ টেস্ট SQL স্তরে, `omnivo_app` হিসেবে (NOBYPASSRLS) — policy নিজেই প্রমাণ: token ছাড়া ০ রো; token দিলে ঠিক একটা; UPDATE
  ০ রো; `invitation_roles` ০ রো।
- `rls-coverage` টেস্ট (ধাপ ৬) কোনো বদল ছাড়াই দুটো নতুন টেবিল দেখে — 0010-এর অংশ ২ না বসালে এটা fail করে।

---

## ৭.৬ — `packages/i18n`: লেখা

**ফাইল: `packages/i18n/src/locales/en.ts`** (আপডেট)

```diff
--- a/packages/i18n/src/locales/en.ts
+++ b/packages/i18n/src/locales/en.ts
@@ -37,6 +37,8 @@ export const en = {
     numbering: 'Numbering',
     branches: 'Branches',
     auditLog: 'Audit log',
+    team: 'Team',
+    roles: 'Roles',
   },
   auth: {
     workspace: 'Workspace',
@@ -84,16 +86,7 @@ export const en = {
     readyTitle: 'Your workspace is ready',
     readyBody:
       'Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock will show up here once you start recording them.',
-    teamTitle: 'Team',
-    teamSubtitle: 'People with access to this workspace',
-    teamLoadFailed: "Couldn't load your team. Refresh the page to try again.",
-    loadingMore: 'Loading more…',
-    noRole: 'No role',
-    columns: {
-      member: 'Member',
-      roles: 'Roles',
-    },
-    teamPermissionHint: 'Ask a workspace owner for the core.user.read permission to see your team.',
+    invite: 'Invite your team',
   },
   settings: {
     title: 'Settings',
@@ -193,6 +186,133 @@ export const en = {
       'Ask a workspace owner for the core.branch.manage permission to add or change branches.',
     loadFailed: "Couldn't load the branches. Refresh the page to try again.",
   },
+  team: {
+    title: 'Team',
+    description: 'People with access to this workspace, and the roles they have',
+    invite: 'Invite people',
+    membersTitle: 'Members',
+    membersSubtitle: 'Everyone who can sign in to this workspace',
+    columns: {
+      member: 'Member',
+      roles: 'Roles',
+      joined: 'Joined',
+    },
+    noRole: 'No role',
+    you: 'You',
+    loadFailed: "Couldn't load your team. Refresh the page to try again.",
+    readOnly: 'Ask a workspace owner for the core.user.read permission to see your team.',
+    invitationsTitle: 'Open invitations',
+    invitationsSubtitle: 'A link works for 7 days and only once. Resend to send a fresh one.',
+    invitationColumns: {
+      email: 'Email',
+      roles: 'Roles',
+      status: 'Status',
+    },
+    statuses: {
+      sent: 'Sent',
+      notSent: 'Email not sent',
+      expired: 'Expired',
+    },
+    invitedBy: 'Invited by {{name}}, {{date}}',
+    actionsFor: 'Actions for {{email}}',
+    resend: 'Resend',
+    revoke: 'Cancel invitation',
+    resent: 'New link sent to {{email}}',
+    revoked: 'Invitation to {{email}} cancelled',
+    inviteTitle: 'Invite people',
+    inviteDescription: 'They get an email with a link to join {{workspace}}.',
+    email: 'Email',
+    roles: 'Roles',
+    rolesHint: 'They can do everything these roles allow. You can change this later.',
+    ownerOnly: 'Only an owner can give this role',
+    cantGrant: "Includes permissions you don't have",
+    send: 'Send invitation',
+    sending: 'Sending…',
+    invited: 'Invitation sent to {{email}}',
+    notSent:
+      "The invitation is saved, but the email didn't go out. Use Resend in the list to try again.",
+    permissionCount_one: '{{count}} permission',
+    permissionCount_other: '{{count}} permissions',
+    allPermissions: 'Every permission',
+    memberDescription: '{{email}} · joined {{date}}',
+    remove: 'Remove from workspace',
+    confirmRemove: 'Remove {{name}}',
+    removeWarning:
+      'They lose access right away, on every device. Their past work stays in the audit log.',
+    rolesSaved: 'Roles of {{name}} saved',
+    removed: '{{name}} removed from the workspace',
+  },
+  roles: {
+    title: 'Roles',
+    description: 'What each role can do. Tick a box to allow it, then save.',
+    add: 'New role',
+    matrixLabel: 'Permissions by role',
+    permission: 'Permission',
+    groups: {
+      team: 'Team',
+      workspace: 'Workspace',
+    },
+    members_one: '{{count}} person',
+    members_other: '{{count}} people',
+    ownerLocked: 'Owners can always do everything',
+    cell: '{{role}}: {{permission}}',
+    edit: 'Edit {{role}}',
+    unsaved_one: '{{count}} role has unsaved changes',
+    unsaved_other: '{{count}} roles have unsaved changes',
+    discard: 'Discard',
+    saved: 'Permissions saved',
+    newTitle: 'New role',
+    newDescription: 'Give it a name now, then tick its permissions in the grid.',
+    editTitle: 'Edit {{name}}',
+    name: 'Name',
+    namePlaceholder: 'Store keeper',
+    about: 'Description',
+    aboutPlaceholder: 'Receives goods at the Gazipur depot and records GRNs',
+    create: 'Create role',
+    created: '{{name}} created',
+    updated: 'Changes to {{name}} saved',
+    delete: 'Delete role',
+    confirmDelete: 'Delete {{name}}',
+    deleteWarning: 'This cannot be undone. Only a role that nobody has can be deleted.',
+    deleted: '{{name}} deleted',
+    readOnly: 'Ask a workspace owner for the core.role.manage permission to change roles.',
+    loadFailed: "Couldn't load the roles. Refresh the page to try again.",
+  },
+  // matrix-এর সারি আর audit-এর ঘর: permission key → লেখা। key-র বিন্দু i18next-এ নেস্টিং, তাই
+  // t(`permissions.${key}`) সরাসরি এখানে পৌঁছায়; নতুন key-র লেখা না থাকলে typecheck fail
+  permissions: {
+    core: {
+      user: {
+        read: 'See the team',
+        invite: 'Invite people',
+        manage: "Change members' roles and remove members",
+      },
+      role: { manage: 'Create roles and choose their permissions' },
+      settings: { manage: 'Edit company settings and numbering' },
+      branch: { manage: 'Add, edit and archive branches' },
+      audit: { read: 'See the audit log' },
+    },
+  },
+  invite: {
+    checking: 'Checking your invitation…',
+    title: 'Join {{workspace}}',
+    invitedBy: '{{name}} invited you as {{email}}.',
+    invitedAs: 'You were invited as {{email}}.',
+    newAccount: 'Create your account to join.',
+    existingAccount: 'You already have an Omnivo account. Enter its password to join.',
+    fullName: 'Full name',
+    password: 'Password',
+    newPasswordPlaceholder: 'At least 8 characters',
+    existingPasswordPlaceholder: 'Your Omnivo password',
+    submit: 'Join {{workspace}}',
+    submitting: 'Joining…',
+    expires: 'This link works until {{date}}.',
+    invalidTitle: 'This invitation link has expired',
+    invalidBody:
+      'A link works for 7 days and only once. Ask the person who invited you to send a new one.',
+    toSignIn: 'Go to sign in',
+    joined: 'Welcome to {{workspace}}',
+  },
   audit: {
     title: 'Audit log',
     description: 'Who changed what in this workspace, and when',
@@ -203,6 +323,9 @@ export const en = {
       user: 'Sign-ins',
       branch: 'Branches',
       number_series: 'Numbering',
+      member: 'Team',
+      invitation: 'Invitations',
+      role: 'Roles',
     },
     columns: {
       when: 'When',
@@ -213,7 +336,11 @@ export const en = {
     system: 'System',
     noChanges: 'No field changed',
     emptyTitle: 'Nothing here yet',
-    emptyBody: 'Changes to settings, branches and numbering show up here, with who made them.',
+    emptyBody:
+      'Changes to settings, branches, numbering and your team show up here, with who made them.',
+    // permission-এর ঘরের মান (true/false) — "true → false"-এর বদলে
+    allowed: 'Allowed',
+    notAllowed: 'Not allowed',
     actions: {
       workspace: { created: 'Created the workspace' },
       auth: { signed_in: 'Signed in', switched_in: 'Switched into this workspace' },
@@ -225,6 +352,20 @@ export const en = {
         restored: 'Restored a branch',
       },
       number_series: { updated: 'Changed a numbering format' },
+      member: {
+        invited: 'Invited someone',
+        invitation_resent: 'Resent an invitation',
+        invitation_revoked: 'Cancelled an invitation',
+        joined: 'Joined the workspace',
+        roles_changed: "Changed someone's roles",
+        removed: 'Removed someone from the workspace',
+      },
+      role: {
+        created: 'Created a role',
+        updated: 'Edited a role',
+        deleted: 'Deleted a role',
+        permissions_changed: "Changed a role's permissions",
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -244,6 +385,8 @@ export const en = {
       prefix: 'Prefix',
       yearStyle: 'Year',
       padding: 'Digits',
+      roles: 'Roles',
+      description: 'Description',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -279,6 +422,12 @@ export const en = {
     prefix_format: 'Start with a letter and use up to 8 capital letters or digits, like INV.',
     file_type_not_allowed: 'Use a PNG, JPG or WebP image.',
     file_too_large: 'This file is too large. Pick one under 2 MB.',
+    role_name_required: 'Enter the role name.',
+    role_name_taken: 'Another role already has this name. Pick a different one.',
+    role_required: 'Pick at least one role.',
+    already_member:
+      'This person is already in the workspace. Change their roles from the team list.',
+    already_invited: 'This person already has an open invitation. Resend it from the list instead.',
     workspace_not_found: "We couldn't find this workspace. Check the address.",
     invalid_credentials: 'Email or password is incorrect. Check them and try again.',
     not_a_member:
@@ -289,6 +438,14 @@ export const en = {
     switch_denied: "You aren't a member of that workspace.",
     permission_missing:
       'You need the {{permissions}} permission. Ask a workspace owner to grant it.',
+    invitation_invalid: 'This invitation link has expired or was already used. Ask for a new one.',
+    cannot_grant:
+      'You can only give roles and permissions you have yourself. Ask a workspace owner.',
+    owner_role_locked: "The Owner role always has every permission and can't be changed.",
+    last_owner: 'Keep at least one owner. Make someone else an owner first.',
+    own_membership: "You can't change your own roles or remove yourself. Ask another admin.",
+    role_in_use:
+      'Someone has this role or an open invitation gives it. Change their roles or cancel the invitation first.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- `permissions` — key-র বিন্দু (`core.user.read`) i18next-এ নেস্টিং, তাই `t(\`permissions.${key}\`)` সরাসরি
  `permissions.core.user.read`-এ পৌঁছায়; audit-এর `actions`-এর একই কৌশল। নতুন key-র লেখা না থাকলে template-literal টাইপ
  মেলে না → compile error।
- `_one`/`_other` — i18next-এর plural; `t('roles.members', { count })` নিজে বাছে।
- `audit.allowed`/`notAllowed` — matrix-এর audit-এ মান `true/false`, "true → false" না দেখিয়ে।
- `dashboard.team*` বাদ — টিম এখন `/team`-এ।

**ফাইল: `packages/i18n/src/locales/bn.ts`** (আপডেট — একই key)

```diff
--- a/packages/i18n/src/locales/bn.ts
+++ b/packages/i18n/src/locales/bn.ts
@@ -37,6 +37,8 @@ export const bn: Messages = {
     numbering: 'নম্বরিং',
     branches: 'ব্রাঞ্চ',
     auditLog: 'অডিট লগ',
+    team: 'টিম',
+    roles: 'রোল',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -84,16 +86,7 @@ export const bn: Messages = {
     readyTitle: 'আপনার ওয়ার্কস্পেস তৈরি',
     readyBody:
       'এবার চার্ট অব অ্যাকাউন্টস সাজান আর আপনার হিসাবরক্ষককে আমন্ত্রণ জানান। বায়ার PO, LC আর স্টক রেকর্ড শুরু করলে এখানে দেখা যাবে।',
-    teamTitle: 'টিম',
-    teamSubtitle: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে',
-    teamLoadFailed: 'টিমের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
-    loadingMore: 'আরও আনা হচ্ছে…',
-    noRole: 'কোনো রোল নেই',
-    columns: {
-      member: 'সদস্য',
-      roles: 'রোল',
-    },
-    teamPermissionHint: 'টিম দেখতে ওয়ার্কস্পেস মালিকের কাছে core.user.read অনুমতি চান।',
+    invite: 'টিমকে আমন্ত্রণ জানান',
   },
   settings: {
     title: 'সেটিংস',
@@ -192,6 +185,130 @@ export const bn: Messages = {
     readOnly: 'ব্রাঞ্চ যোগ বা বদল করতে ওয়ার্কস্পেস মালিকের কাছে core.branch.manage অনুমতি চান।',
     loadFailed: 'ব্রাঞ্চের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  team: {
+    title: 'টিম',
+    description: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে, আর তাঁদের রোল',
+    invite: 'আমন্ত্রণ পাঠান',
+    membersTitle: 'সদস্য',
+    membersSubtitle: 'এই ওয়ার্কস্পেসে যাঁরা সাইন ইন করতে পারেন',
+    columns: {
+      member: 'সদস্য',
+      roles: 'রোল',
+      joined: 'যোগ দিয়েছেন',
+    },
+    noRole: 'কোনো রোল নেই',
+    you: 'আপনি',
+    loadFailed: 'টিমের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'টিম দেখতে ওয়ার্কস্পেস মালিকের কাছে core.user.read অনুমতি চান।',
+    invitationsTitle: 'খোলা আমন্ত্রণ',
+    invitationsSubtitle: 'লিংক ৭ দিন কাজ করে, একবারই। নতুন লিংক পাঠাতে আবার পাঠান।',
+    invitationColumns: {
+      email: 'ইমেইল',
+      roles: 'রোল',
+      status: 'অবস্থা',
+    },
+    statuses: {
+      sent: 'পাঠানো হয়েছে',
+      notSent: 'ইমেইল যায়নি',
+      expired: 'মেয়াদ শেষ',
+    },
+    invitedBy: '{{name}} পাঠিয়েছেন, {{date}}',
+    actionsFor: '{{email}}-এর কাজ',
+    resend: 'আবার পাঠান',
+    revoke: 'আমন্ত্রণ বাতিল করুন',
+    resent: '{{email}}-এ নতুন লিংক পাঠানো হয়েছে',
+    revoked: '{{email}}-এর আমন্ত্রণ বাতিল হয়েছে',
+    inviteTitle: 'আমন্ত্রণ পাঠান',
+    inviteDescription: '{{workspace}}-এ যোগ দেওয়ার লিংকসহ একটা ইমেইল যাবে।',
+    email: 'ইমেইল',
+    roles: 'রোল',
+    rolesHint: 'এই রোলগুলো যা পারে, তিনিও তা পারবেন। পরে বদলানো যায়।',
+    ownerOnly: 'শুধু একজন owner এই রোল দিতে পারেন',
+    cantGrant: 'এতে এমন অনুমতি আছে যা আপনার নেই',
+    send: 'আমন্ত্রণ পাঠান',
+    sending: 'পাঠানো হচ্ছে…',
+    invited: '{{email}}-এ আমন্ত্রণ পাঠানো হয়েছে',
+    notSent: 'আমন্ত্রণ সেভ হয়েছে, কিন্তু ইমেইল যায়নি। তালিকা থেকে আবার পাঠান।',
+    permissionCount_one: '{{count}}টা অনুমতি',
+    permissionCount_other: '{{count}}টা অনুমতি',
+    allPermissions: 'সব অনুমতি',
+    memberDescription: '{{email}} · যোগ দিয়েছেন {{date}}',
+    remove: 'ওয়ার্কস্পেস থেকে সরান',
+    confirmRemove: '{{name}}-কে সরান',
+    removeWarning:
+      'সব ডিভাইসে সাথে সাথে তাঁর অ্যাক্সেস চলে যাবে। তাঁর আগের কাজ অডিট লগে থেকে যাবে।',
+    rolesSaved: '{{name}}-এর রোল সেভ হয়েছে',
+    removed: '{{name}}-কে ওয়ার্কস্পেস থেকে সরানো হয়েছে',
+  },
+  roles: {
+    title: 'রোল',
+    description: 'কোন রোল কী করতে পারে। ঘরে টিক দিয়ে অনুমতি দিন, তারপর সেভ করুন।',
+    add: 'নতুন রোল',
+    matrixLabel: 'রোল অনুযায়ী অনুমতি',
+    permission: 'অনুমতি',
+    groups: {
+      team: 'টিম',
+      workspace: 'ওয়ার্কস্পেস',
+    },
+    members_one: '{{count}} জন',
+    members_other: '{{count}} জন',
+    ownerLocked: 'Owner সবসময় সব পারেন',
+    cell: '{{role}}: {{permission}}',
+    edit: '{{role}} বদলান',
+    unsaved_one: '{{count}}টা রোলের পরিবর্তন সেভ হয়নি',
+    unsaved_other: '{{count}}টা রোলের পরিবর্তন সেভ হয়নি',
+    discard: 'বাদ দিন',
+    saved: 'অনুমতি সেভ হয়েছে',
+    newTitle: 'নতুন রোল',
+    newDescription: 'এখন নাম দিন, তারপর ছকে টিক দিয়ে অনুমতি বাছুন।',
+    editTitle: '{{name}} বদলান',
+    name: 'নাম',
+    namePlaceholder: 'Store keeper',
+    about: 'বিবরণ',
+    aboutPlaceholder: 'গাজীপুর ডিপোতে মাল গ্রহণ করেন আর GRN লেখেন',
+    create: 'রোল তৈরি করুন',
+    created: '{{name}} তৈরি হয়েছে',
+    updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
+    delete: 'রোল মুছুন',
+    confirmDelete: '{{name}} মুছুন',
+    deleteWarning: 'এটা আর ফেরানো যাবে না। শুধু যে রোল কারো নেই সেটাই মোছা যায়।',
+    deleted: '{{name}} মোছা হয়েছে',
+    readOnly: 'রোল বদলাতে ওয়ার্কস্পেস মালিকের কাছে core.role.manage অনুমতি চান।',
+    loadFailed: 'রোলের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  permissions: {
+    core: {
+      user: {
+        read: 'টিম দেখা',
+        invite: 'আমন্ত্রণ পাঠানো',
+        manage: 'সদস্যের রোল বদলানো আর সদস্য সরানো',
+      },
+      role: { manage: 'রোল তৈরি আর তার অনুমতি বাছা' },
+      settings: { manage: 'কোম্পানির সেটিংস আর নম্বরিং বদলানো' },
+      branch: { manage: 'ব্রাঞ্চ যোগ, বদল আর আর্কাইভ' },
+      audit: { read: 'অডিট লগ দেখা' },
+    },
+  },
+  invite: {
+    checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
+    title: '{{workspace}}-এ যোগ দিন',
+    invitedBy: '{{name}} আপনাকে {{email}} হিসেবে আমন্ত্রণ জানিয়েছেন।',
+    invitedAs: 'আপনাকে {{email}} হিসেবে আমন্ত্রণ জানানো হয়েছে।',
+    newAccount: 'যোগ দিতে আপনার অ্যাকাউন্ট তৈরি করুন।',
+    existingAccount: 'আপনার আগে থেকেই Omnivo অ্যাকাউন্ট আছে। যোগ দিতে তার পাসওয়ার্ড দিন।',
+    fullName: 'পুরো নাম',
+    password: 'পাসওয়ার্ড',
+    newPasswordPlaceholder: 'অন্তত ৮ অক্ষর',
+    existingPasswordPlaceholder: 'আপনার Omnivo পাসওয়ার্ড',
+    submit: '{{workspace}}-এ যোগ দিন',
+    submitting: 'যোগ দেওয়া হচ্ছে…',
+    expires: 'লিংকটা {{date}} পর্যন্ত কাজ করবে।',
+    invalidTitle: 'এই আমন্ত্রণের লিংকের মেয়াদ শেষ',
+    invalidBody:
+      'লিংক ৭ দিন কাজ করে, একবারই। যিনি আমন্ত্রণ জানিয়েছেন তাঁকে নতুন একটা পাঠাতে বলুন।',
+    toSignIn: 'সাইন ইনে যান',
+    joined: '{{workspace}}-এ স্বাগতম',
+  },
   audit: {
     title: 'অডিট লগ',
     description: 'এই ওয়ার্কস্পেসে কে কখন কী বদলেছে',
@@ -202,6 +319,9 @@ export const bn: Messages = {
       user: 'সাইন ইন',
       branch: 'ব্রাঞ্চ',
       number_series: 'নম্বরিং',
+      member: 'টিম',
+      invitation: 'আমন্ত্রণ',
+      role: 'রোল',
     },
     columns: {
       when: 'কখন',
@@ -212,7 +332,9 @@ export const bn: Messages = {
     system: 'সিস্টেম',
     noChanges: 'কোনো ঘর বদলায়নি',
     emptyTitle: 'এখনো কিছু নেই',
-    emptyBody: 'সেটিংস, ব্রাঞ্চ আর নম্বরিংয়ের পরিবর্তন এখানে দেখা যাবে, কে করেছেন সহ।',
+    emptyBody: 'সেটিংস, ব্রাঞ্চ, নম্বরিং আর টিমের পরিবর্তন এখানে দেখা যাবে, কে করেছেন সহ।',
+    allowed: 'অনুমতি আছে',
+    notAllowed: 'অনুমতি নেই',
     actions: {
       workspace: { created: 'ওয়ার্কস্পেস তৈরি করেছেন' },
       auth: { signed_in: 'সাইন ইন করেছেন', switched_in: 'এই ওয়ার্কস্পেসে এসেছেন' },
@@ -224,6 +346,20 @@ export const bn: Messages = {
         restored: 'ব্রাঞ্চ ফিরিয়ে এনেছেন',
       },
       number_series: { updated: 'নম্বরিং বদলেছেন' },
+      member: {
+        invited: 'আমন্ত্রণ পাঠিয়েছেন',
+        invitation_resent: 'আমন্ত্রণ আবার পাঠিয়েছেন',
+        invitation_revoked: 'আমন্ত্রণ বাতিল করেছেন',
+        joined: 'ওয়ার্কস্পেসে যোগ দিয়েছেন',
+        roles_changed: 'একজনের রোল বদলেছেন',
+        removed: 'একজনকে ওয়ার্কস্পেস থেকে সরিয়েছেন',
+      },
+      role: {
+        created: 'রোল তৈরি করেছেন',
+        updated: 'রোল বদলেছেন',
+        deleted: 'রোল মুছেছেন',
+        permissions_changed: 'রোলের অনুমতি বদলেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -242,6 +378,8 @@ export const bn: Messages = {
       prefix: 'প্রিফিক্স',
       yearStyle: 'বছর',
       padding: 'অঙ্ক',
+      roles: 'রোল',
+      description: 'বিবরণ',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -277,6 +415,11 @@ export const bn: Messages = {
       'ইংরেজি অক্ষর দিয়ে শুরু করে ৮টা পর্যন্ত বড় হাতের অক্ষর বা সংখ্যা দিন, যেমন INV।',
     file_type_not_allowed: 'PNG, JPG বা WebP ছবি দিন।',
     file_too_large: 'ফাইলটা খুব বড়। ২ MB-র ছোট একটা বাছুন।',
+    role_name_required: 'রোলের নাম লিখুন।',
+    role_name_taken: 'এই নামে আরেকটা রোল আছে। অন্য নাম দিন।',
+    role_required: 'অন্তত একটা রোল বাছুন।',
+    already_member: 'ইনি আগে থেকেই এই ওয়ার্কস্পেসে আছেন। টিমের তালিকা থেকে তাঁর রোল বদলান।',
+    already_invited: 'এঁর একটা আমন্ত্রণ আগে থেকেই খোলা আছে। তালিকা থেকে সেটা আবার পাঠান।',
     workspace_not_found: 'এই ওয়ার্কস্পেস খুঁজে পাওয়া যায়নি। ঠিকানাটা আবার দেখুন।',
     invalid_credentials: 'ইমেইল বা পাসওয়ার্ড ভুল। দেখে আবার চেষ্টা করুন।',
     not_a_member:
@@ -286,6 +429,14 @@ export const bn: Messages = {
     access_revoked: 'এই ওয়ার্কস্পেসে আপনার অ্যাক্সেস আর নেই। আবার সাইন ইন করুন।',
     switch_denied: 'আপনি ওই ওয়ার্কস্পেসের সদস্য নন।',
     permission_missing: 'এর জন্য {{permissions}} অনুমতি লাগবে। ওয়ার্কস্পেস মালিকের কাছে চান।',
+    invitation_invalid: 'এই আমন্ত্রণের লিংকের মেয়াদ শেষ বা আগেই ব্যবহার হয়েছে। নতুন একটা চান।',
+    cannot_grant:
+      'আপনার নিজের যে রোল আর অনুমতি আছে শুধু সেগুলোই দিতে পারবেন। ওয়ার্কস্পেস মালিকের কাছে চান।',
+    owner_role_locked: 'Owner রোলের সবসময় সব অনুমতি থাকে, এটা বদলানো যায় না।',
+    last_owner: 'অন্তত একজন owner রাখতে হবে। আগে আরেকজনকে owner বানান।',
+    own_membership: 'নিজের রোল বদলানো বা নিজেকে সরানো যায় না। আরেকজন অ্যাডমিনকে বলুন।',
+    role_in_use:
+      'এই রোল কারো আছে, বা কোনো খোলা আমন্ত্রণে আছে। আগে তাঁদের রোল বদলান বা আমন্ত্রণ বাতিল করুন।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

- "Owner", "role", "workspace" — CLAUDE.md অনুযায়ী অফিসের প্রচলিত শব্দ; বিদ্যমান `bn.ts` যেমন "রোল", "ওয়ার্কস্পেস"
  লেখে, তেমনই। `owner` রোলের নাম (ডেটা) ইংরেজিতেই থাকে।
- বাংলায় `_one` আর `_other` একই লেখা — i18next-এর `bn` plural নিয়মে দুটো রূপই চায়।

---

## ৭.৭ — `packages/ui`: চেকবক্সের দল আর লুকানো লেবেল

**ফাইল: `packages/ui/src/components/checkbox.tsx`** (পুরো ফাইল বদল)

```tsx
import { Alert02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '../lib/cn.js';

interface CheckboxProps extends Omit<
  ComponentProps<typeof CheckboxPrimitive.Root>,
  'className' | 'children' | 'id'
> {
  id: string;
  label: ReactNode;
  // লেখা শুধু স্ক্রিন রিডারের জন্য — যেমন permission matrix-এর ঘর, যেখানে সারি আর কলামের শিরোনামই
  // চোখের লেবেল। label তবু বাধ্যতামূলক: লেখা ছাড়া চেকবক্স স্ক্রিন রিডারে শুধু "checkbox"
  hideLabel?: boolean | undefined;
}

// CLAUDE.md → Checkbox: ১৭px, ৫px কোণ, checked-এ brand ভরাট। native checkbox-এর রং আর
// কোণ সব ব্রাউজারে বদলানো যায় না, তাই Radix (ভেতরে button role="checkbox", কীবোর্ডে Space)
export function Checkbox({ id, label, hideLabel = false, ...props }: CheckboxProps) {
  return (
    // relative: লুকানো লেখা (sr-only = position: absolute) এই বাক্সের ভেতরেই থাকে। না থাকলে সেটা
    // সবচেয়ে কাছের positioned পূর্বপুরুষে — প্রায়ই পুরো পেজে — বসে, আড়াআড়ি scroll-এর বাক্স থেকে বেরিয়ে
    // পেজকেই চওড়া করত (permission matrix-এ ফোনে ৩৯০ → ৬৬১px, ধরা পড়েছে Playwright-এ)
    <div className="relative flex items-start gap-2.5">
      <CheckboxPrimitive.Root
        id={id}
        // disabled: ৬০% — বাটনের মতোই; cursor: not-allowed আসে global base layer থেকে
        className="mt-px grid size-[17px] shrink-0 place-items-center rounded-[5px] border border-line-strong bg-surface shadow-sm transition-colors duration-150 hover:border-ink-3 disabled:opacity-60 data-[state=checked]:border-brand data-[state=checked]:bg-brand"
        {...props}
      >
        <CheckboxPrimitive.Indicator className="text-brand-ink">
          <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={1.5} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className={cn('text-body-sm text-ink-2', hideLabel && 'sr-only')}>
        {label}
      </label>
    </div>
  );
}

export interface CheckboxOption {
  value: string;
  label: ReactNode;
  disabled?: boolean | undefined;
}

interface CheckboxGroupProps {
  legend: string;
  options: readonly CheckboxOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  hint?: string | undefined;
  // error code, Field-এর মতোই — বর্তমান ভাষায় লেখা এখানে
  error?: string | undefined;
}

// কয়েকটা থেকে একাধিক বাছা (invite-এর রোল, পরে onboarding-এর মডিউল)। fieldset + legend: স্ক্রিন
// রিডার প্রতিটা চেকবক্সের আগে দলের নাম পড়ে ("Roles, Accountant, checkbox")। দেখতে Field-এর মতো:
// উপরে লেবেল, নিচে hint বা error
export function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
  hint,
  error,
}: CheckboxGroupProps) {
  const { errorText } = useLocale();
  const id = useId();
  return (
    <fieldset
      className="grid gap-1.5"
      aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
    >
      <legend className="mb-1.5 text-label font-medium text-ink">{legend}</legend>
      <div className="grid gap-2.5 rounded-control border border-line p-3">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            id={`${id}-${option.value}`}
            label={option.label}
            disabled={option.disabled}
            checked={value.includes(option.value)}
            onCheckedChange={(checked) => {
              onChange(
                checked === true
                  ? [...value, option.value]
                  : value.filter((selected) => selected !== option.value),
              );
            }}
          />
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(error)}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-label text-ink-3">
            {hint}
          </p>
        )
      )}
    </fieldset>
  );
}
```

- `hideLabel` — matrix-এর ঘরে সারি আর কলামের শিরোনামই চোখের লেবেল; তবু স্ক্রিন রিডারের জন্য "Accountant: See the audit log"।
- **`relative`** — এই ধাপের সবচেয়ে সূক্ষ্ম বাগ। `sr-only` মানে `position: absolute`; কোনো positioned পূর্বপুরুষ না থাকলে
  লেখাটা পুরো পেজের সাপেক্ষে বসে — matrix-এর আড়াআড়ি scroll-এর বাক্স থেকে বেরিয়ে। ফোনে (৩৯০px) matrix-এর ডানের কলামগুলোর
  লুকানো লেখা পেজকে ৬৬১px চওড়া করেছিল; ফলে dialog-এর বাটন পর্দার বাইরে, আর Playwright "overlay intercepts pointer
  events"-এ আটকে। ডেস্কটপে সব ঠিক দেখাত। `min-w-0` (৭.৮) দিয়ে সারেনি — সেটা আলাদা সমস্যা।
- `disabled:opacity-60` — বাটনের মতো; `cursor: not-allowed` global base layer থেকে (CLAUDE.md → Interaction)।
- `CheckboxGroup` — `fieldset` + `legend`: স্ক্রিন রিডার প্রতিটা চেকবক্সের আগে দলের নাম পড়ে। `Field`-এর label `htmlFor`
  একটা control চায়; দলের জন্য fieldset-ই সঠিক HTML। error-এর রূপ `Field`-এর হুবহু।
- `onChange`-এ নতুন array — react-hook-form-এর `Controller` তুলনা করে বদল ধরে; একই array mutate করলে ধরত না।

**ফাইল: `packages/ui/src/index.ts`** (আপডেট)

```diff
--- a/packages/ui/src/index.ts
+++ b/packages/ui/src/index.ts
@@ -5,7 +5,7 @@ export { parseIsoDate, toIsoDate } from './lib/iso-date.js';
 export { AppShell, NavGroup, NavItem, SidebarNav } from './components/app-shell.js';
 export { Button, IconButton } from './components/button.js';
 export { Card, CardHeader } from './components/card.js';
-export { Checkbox } from './components/checkbox.js';
+export { Checkbox, CheckboxGroup, type CheckboxOption } from './components/checkbox.js';
 export {
   DataTable,
   dataTableColumns,
```

---

## ৭.৮ — `apps/app`: স্ক্রিন

### টাইপ-চেকড `can()`

**ফাইল: `apps/app/src/lib/permissions.ts`** (নতুন)

```ts
import type { PermissionKey } from '@omnivo/contracts';
import { useCallback } from 'react';

import { useSession } from './session-store';

// can('core.branch.manage') — key টাইপ-চেকড (contracts-এর PermissionKey): বানান ভুল হলে compile error,
// আর catalog থেকে কোনো permission সরালে যেখানে যেখানে সেটা দেখা হয় সব জায়গায় লাল দাগ।
// UI-তে লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard
export function useCan(): (permission: PermissionKey) => boolean {
  const permissions = useSession((state) => state.me?.permissions);
  return useCallback(
    (permission: PermissionKey) => permissions?.includes(permission) ?? false,
    [permissions],
  );
}
```

এরপর ছয় জায়গায় `me.permissions.includes('…')` → `useCan()`। যেমন:

```diff
--- a/apps/app/src/routes/settings.tsx
+++ b/apps/app/src/routes/settings.tsx
@@ -42,6 +42,7 @@ import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { settingsQuery } from '../lib/queries';
 import { refreshMe } from '../lib/session';
+import { useCan } from '../lib/permissions';
 import { useSession } from '../lib/session-store';
 
 // ফর্মে যা থাকে: parse-এর আগের মান (z.input) — ফাঁকা ঘর '' (null না, <input>-এ null বসানো যায় না)
@@ -378,12 +379,13 @@ function LogoCard({ settings, canManage }: { settings: Settings; canManage: bool
 
 export function SettingsPage() {
   const { t } = useLocale();
+  const can = useCan();
   const me = useSession((state) => state.me);
   const tenantId = me?.tenant.id ?? '';
   const { data, isError } = useQuery({ ...settingsQuery(tenantId), enabled: me !== null });
   if (!me) return null;
 
-  const canManage = me.permissions.includes('core.settings.manage');
+  const canManage = can('core.settings.manage');
 
   return (
     <div className="grid max-w-3xl gap-5">
```

```diff
--- a/apps/app/src/routes/branches.tsx
+++ b/apps/app/src/routes/branches.tsx
@@ -38,6 +38,7 @@ import { useForm } from 'react-hook-form';
 
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
+import { useCan } from '../lib/permissions';
 import { useSession } from '../lib/session-store';
 
 const column = dataTableColumns<Branch>();
@@ -197,7 +198,7 @@ export function BranchesPage() {
   const { t } = useLocale();
   const me = useSession((state) => state.me);
   const tenantId = me?.tenant.id ?? '';
-  const canManage = me?.permissions.includes('core.branch.manage') ?? false;
+  const canManage = useCan()('core.branch.manage');
   const [status, setStatus] = useState<BranchStatus>('active');
   const [editing, setEditing] = useState<Editing>(null);
   const { data, isError } = useQuery({ ...branchesQuery(tenantId, status), enabled: me !== null });
```

`numbering.tsx` আর `audit-log.tsx`-এ হুবহু branches-এর মতো (`useCan()('core.settings.manage')`, `useCan()('core.audit.read')`)।

### query আর session

**ফাইল: `apps/app/src/lib/queries.ts`** (পুরো ফাইল বদল)

```ts
import { type MemberSort, routes } from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

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

// রোলের তালিকা তিন জায়গায়: রোলের পেজ (matrix), invite-এর ফর্ম আর সদস্যের রোল বদলানোর ফর্ম।
// একই key — matrix সেভ করলে invite-এর ফর্মও নতুন permission-সংখ্যা দেখায়
export function rolesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['roles', tenantId],
    queryFn: async () => (await call(routes.roles.list)).items,
  });
}

export function invitationsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['invitations', tenantId],
    queryFn: async () => (await call(routes.invitations.list)).items,
  });
}

// ধাপ ৫-এ ড্যাশবোর্ডে ছিল; এখন টিমের পেজে, আর সদস্য বদলালে এই key-র সব পাতা invalidate
export function membersQuery(tenantId: string, sort: MemberSort) {
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
```

**ফাইল: `apps/app/src/lib/session.ts`** (আপডেট)

```diff
--- a/apps/app/src/lib/session.ts
+++ b/apps/app/src/lib/session.ts
@@ -1,4 +1,10 @@
-import { type AuthSession, type LoginInput, routes, type SignUpInput } from '@omnivo/contracts';
+import {
+  type AcceptInvitationInput,
+  type AuthSession,
+  type LoginInput,
+  routes,
+  type SignUpInput,
+} from '@omnivo/contracts';
 
 import { call, refreshSession } from './api';
 import { applyPreferences } from './preferences';
@@ -50,6 +56,12 @@ export async function signUp(input: SignUpInput): Promise<void> {
   await startSession(await call(routes.auth.signUp, { body: input }));
 }
 
+// invitation গ্রহণ = লগইন: উত্তরে একই session, আর সেই workspace-এ। আগে অন্য অ্যাকাউন্টে লগইন থাকলে
+// startSession সেটার ক্যাশ মুছে নতুনটা বসায়
+export async function acceptInvitation(input: AcceptInvitationInput): Promise<void> {
+  await startSession(await call(routes.invitations.accept, { body: input }));
+}
+
 export async function switchTenant(tenantId: string): Promise<void> {
   await startSession(await call(routes.auth.switchTenant, { body: { tenantId } }));
 }
```

### ড্যাশবোর্ড

**ফাইল: `apps/app/src/routes/dashboard.tsx`** (পুরো ফাইল বদল)

```tsx
import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';

// টিমের তালিকা ধাপ ৭-এ নিজের পেজে (/team) সরেছে — ড্যাশবোর্ডে এখন শুধু শুরুর কার্ড, আর আসল সংখ্যা
// আসবে ধাপ ২১-এ
export function DashboardPage() {
  const { t, format } = useLocale();
  const can = useCan();
  const me = useSession((state) => state.me);
  if (!me) return null;

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
        {can('core.user.invite') && (
          <Link
            to="/team"
            className="mt-4 inline-block font-medium text-brand underline-offset-[3px] hover:underline"
          >
            {t('dashboard.invite')}
          </Link>
        )}
      </Card>
    </div>
  );
}
```

- টিম-কার্ডের জায়গায় একটা text link (CLAUDE.md → Text link) — primary বাটন না, কারণ এই পেজের কাজ ওটা না।

### টিমের পেজ

**ফাইল: `apps/app/src/routes/team.tsx`** (নতুন)

```tsx
import {
  Alert02Icon,
  Clock01Icon,
  Mail01Icon,
  MailSend01Icon,
  UserAdd01Icon,
  UserMultipleIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createInvitationInputSchema,
  type Invitation,
  type Member,
  type MemberSort,
  type MeResponse,
  type Role,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  CheckboxGroup,
  type CheckboxOption,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  Pill,
  SectionHeader,
  type SortingState,
  TextField,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { invitationsQuery, membersQuery, rolesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const memberColumn = dataTableColumns<Member>();
const invitationColumn = dataTableColumns<Invitation>();
const INVITE_FIELDS = createInvitationInputSchema.keyof().options;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

// mutation-এর error (last_owner, cannot_grant, version_conflict) কোনো ঘরের না — ফর্মের উপরে alert-এ
function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// এই রোল আমি দিতে (বা কেড়ে নিতে) পারি কি না — API-র grants.ts-এর একই নিয়ম, শুধু আগেভাগে বাক্সটা বন্ধ
// রাখার জন্য। owner-কে owner চেনা যায় me.roles-এ owner রোলের নাম দেখে (সেই নাম বদলানো যায় না)
function useGrantable(roles: readonly Role[] | undefined, me: MeResponse | null) {
  return useCallback(
    (role: Role): 'ok' | 'ownerOnly' | 'cantGrant' => {
      if (!me || !roles) return 'cantGrant';
      const ownerName = roles.find((candidate) => candidate.kind === 'owner')?.name;
      if (ownerName !== undefined && me.roles.includes(ownerName)) return 'ok';
      if (role.kind === 'owner') return 'ownerOnly';
      return role.permissions.every((key) => me.permissions.includes(key)) ? 'ok' : 'cantGrant';
    },
    [roles, me],
  );
}

// invite আর সদস্যের ফর্ম — দুটোতেই একই রোলের তালিকা: নাম, নিচে কী দেয়, আর দিতে না পারলে কেন
function useRoleOptions(roles: readonly Role[] | undefined): CheckboxOption[] {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const grantable = useGrantable(roles, me);
  return useMemo(
    () =>
      (roles ?? []).map((role) => {
        const verdict = grantable(role);
        const detail =
          verdict === 'ownerOnly'
            ? t('team.ownerOnly')
            : verdict === 'cantGrant'
              ? t('team.cantGrant')
              : role.kind === 'owner'
                ? t('team.allPermissions')
                : t('team.permissionCount', { count: role.permissions.length });
        return {
          value: role.id,
          disabled: verdict !== 'ok',
          label: (
            <span className="grid">
              <span className="font-medium text-ink">{role.name}</span>
              <span className="text-caption text-ink-3">{detail}</span>
            </span>
          ),
        };
      }),
    [roles, grantable, t],
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const { data: roles } = useQuery(rolesQuery(tenantId));
  const options = useRoleOptions(roles);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createInvitationInputSchema, { error: contractErrorMap }),
    defaultValues: { email: '', roleIds: [] },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const invitation = await call(routes.invitations.create, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['invitations', tenantId] });
      // চিঠি না গেলেও invitation তৈরি — সেটা স্পষ্ট করে বলা, "পাঠানো হয়েছে" বলে ভুল ধারণা না দেওয়া
      toast(
        invitation.sentAt === null
          ? t('team.notSent')
          : t('team.invited', { email: invitation.email }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, INVITE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('team.inviteTitle')}
      description={t('team.inviteDescription', { workspace: me?.tenant.name ?? '' })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="invite-form" disabled={isSubmitting}>
            {isSubmitting ? t('team.sending') : t('team.send')}
          </Button>
        </>
      }
    >
      <form
        id="invite-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('team.email')}
          icon={Mail01Icon}
          type="email"
          autoComplete="off"
          placeholder="tanvir@rahmangarments.com"
          {...register('email')}
          error={errors.email?.message}
        />
        {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
        <Controller
          control={control}
          name="roleIds"
          render={({ field }) => (
            <CheckboxGroup
              legend={t('team.roles')}
              hint={t('team.rolesHint')}
              options={options}
              value={field.value}
              onChange={field.onChange}
              error={errors.roleIds?.message}
            />
          )}
        />
      </form>
    </DialogContent>
  );
}

function InvitationPanel({ invitation, onDone }: { invitation: Invitation; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['invitations', tenantId] });

  const resend = useMutation({
    mutationFn: () =>
      call(routes.invitations.resend, {
        params: { id: invitation.id },
        body: { version: invitation.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(saved.sentAt === null ? t('team.notSent') : t('team.resent', { email: saved.email }));
      onDone();
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      call(routes.invitations.revoke, {
        params: { id: invitation.id },
        query: { version: invitation.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('team.revoked', { email: invitation.email }));
      onDone();
    },
  });
  const failure = failureOf(resend.error) ?? failureOf(revoke.error);
  const busy = resend.isPending || revoke.isPending;

  return (
    <DialogContent
      title={invitation.email}
      description={
        invitation.invitedBy
          ? t('team.invitedBy', {
              name: invitation.invitedBy.fullName,
              date: format.date(new Date(invitation.createdAt)),
            })
          : undefined
      }
      footer={
        <>
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              revoke.mutate();
            }}
          >
            {t('team.revoke')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.close')}</Button>
          </DialogClose>
          <Button
            disabled={busy}
            onClick={() => {
              resend.mutate();
            }}
          >
            <HugeiconsIcon icon={MailSend01Icon} size={17} strokeWidth={1.5} />
            {t('team.resend')}
          </Button>
        </>
      }
    >
      {failure && <FormAlert message={failure} />}
      <InvitationStatus invitation={invitation} />
      <p className="text-body-sm text-ink-2">
        {invitation.roles.map((role) => role.name).join(', ')}
      </p>
    </DialogContent>
  );
}

// রং একা না — আইকন আর লেখা সহ (CLAUDE.md → Status colors)
function InvitationStatus({ invitation }: { invitation: Invitation }) {
  const { t } = useLocale();
  if (new Date(invitation.expiresAt) <= new Date()) {
    return (
      <Pill tone="neutral" icon={Clock01Icon}>
        {t('team.statuses.expired')}
      </Pill>
    );
  }
  if (invitation.sentAt === null) {
    return (
      <Pill tone="warn" icon={Alert02Icon}>
        {t('team.statuses.notSent')}
      </Pill>
    );
  }
  return (
    <Pill tone="brand" icon={MailSend01Icon}>
      {t('team.statuses.sent')}
    </Pill>
  );
}

function MemberForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const { data: roles } = useQuery(rolesQuery(tenantId));
  const options = useRoleOptions(roles);
  const [roleIds, setRoleIds] = useState(() => member.roles.map((role) => role.id));
  const [confirming, setConfirming] = useState(false);

  // সদস্য বদলালে তালিকা আর রোলের সদস্য-সংখ্যা (matrix-এর কলামের নিচে) দুটোই পুরনো
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['members', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['roles', tenantId] }),
    ]);

  const save = useMutation({
    mutationFn: () =>
      call(routes.members.updateRoles, {
        params: { id: member.membershipId },
        body: { roleIds, version: member.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('team.rolesSaved', { name: member.fullName }));
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.members.remove, {
        params: { id: member.membershipId },
        query: { version: member.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('team.removed', { name: member.fullName }));
      onDone();
    },
  });
  const failure = failureOf(save.error) ?? failureOf(remove.error);
  const busy = save.isPending || remove.isPending;

  return (
    <DialogContent
      title={member.fullName}
      description={t('team.memberDescription', {
        email: member.email,
        date: format.date(new Date(member.joinedAt)),
      })}
      footer={
        <>
          {/* বাঁয়ে, আর দুই ধাপে: প্রথম চাপে সতর্কবার্তা আর নাম সহ বাটন, দ্বিতীয় চাপে সত্যিই সরানো */}
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={busy}
            onClick={() => {
              if (confirming) remove.mutate();
              else setConfirming(true);
            }}
          >
            {confirming ? t('team.confirmRemove', { name: member.fullName }) : t('team.remove')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={busy}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      {failure && <FormAlert message={failure} />}
      {confirming && <p className="text-body-sm text-ink-2">{t('team.removeWarning')}</p>}
      <CheckboxGroup
        legend={t('team.roles')}
        options={options}
        value={roleIds}
        onChange={setRoleIds}
      />
    </DialogContent>
  );
}

function MembersSection({ onOpen }: { onOpen: ((member: Member) => void) | undefined }) {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const [sort, setSort] = useState<MemberSort>('name');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    membersQuery(tenantId, sort),
  );
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

  const columns = useMemo(
    () =>
      memberColumn.columns([
        memberColumn.accessor('fullName', {
          header: t('team.columns.member'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
                {initials(row.original.fullName)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {row.original.fullName}
                  {row.original.userId === me?.user.id && (
                    <span className="font-normal text-ink-3"> · {t('team.you')}</span>
                  )}
                </span>
                <span className="block truncate text-caption text-ink-3">{row.original.email}</span>
              </span>
            </span>
          ),
        }),
        memberColumn.accessor((member) => member.roles.map((role) => role.name).join(', '), {
          id: 'roles',
          header: t('team.columns.roles'),
          // সার্ভার রোল দিয়ে সাজাতে পারে না (চুক্তিতে শুধু name) — তাই হেডারে sort বাটনই নেই
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => getValue() || t('team.noRole'),
        }),
        memberColumn.accessor('joinedAt', {
          header: t('team.columns.joined'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="tabular-nums">{format.date(new Date(getValue()))}</span>
          ),
        }),
      ]),
    [t, format, me?.user.id],
  );

  return (
    // DataTable নিজেই কার্ড — তাই Card-এ না মুড়ে শুধু শিরোনাম + টেবিল
    <section className="grid gap-3">
      <SectionHeader title={t('team.membersTitle')} subtitle={t('team.membersSubtitle')} />
      {isError ? (
        <p className="text-body-sm text-crit">{t('team.loadFailed')}</p>
      ) : (
        members && (
          <DataTable
            label={t('team.membersTitle')}
            data={members}
            columns={columns}
            getRowId={(member) => member.membershipId}
            sorting={sorting}
            onEndReached={loadMore}
            // নিজের রো খোলে না: নিজের রোল বদলানো API-তেও বন্ধ (own_membership) — খুলে "পারবেন না"
            // দেখানোর চেয়ে ক্লিকই না করা ভালো
            onRowClick={
              onOpen &&
              ((member) => {
                if (member.userId !== me?.user.id) onOpen(member);
              })
            }
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
              )
            }
          />
        )
      )}
    </section>
  );
}

function InvitationsSection({ onOpen }: { onOpen: (invitation: Invitation) => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data } = useQuery(invitationsQuery(tenantId));

  const columns = useMemo(
    () =>
      invitationColumn.columns([
        invitationColumn.accessor('email', {
          header: t('team.invitationColumns.email'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-subtle text-ink-3">
                <HugeiconsIcon icon={Mail01Icon} size={16} strokeWidth={1.5} />
              </span>
              <span className="min-w-0 truncate font-medium">{row.original.email}</span>
            </span>
          ),
        }),
        invitationColumn.accessor((invitation) => invitation.roles.map((r) => r.name).join(', '), {
          id: 'roles',
          header: t('team.invitationColumns.roles'),
          enableSorting: false,
          meta: { card: 'detail' },
        }),
        invitationColumn.display({
          id: 'status',
          header: t('team.invitationColumns.status'),
          meta: { card: 'trailing' },
          cell: ({ row }) => <InvitationStatus invitation={row.original} />,
        }),
      ]),
    [t],
  );

  // খোলা invitation না থাকলে পুরো অংশটাই না — খালি টেবিল দেখিয়ে জায়গা নষ্ট করার কিছু নেই
  if (!data || data.length === 0) return null;
  return (
    <section className="grid gap-3">
      <SectionHeader title={t('team.invitationsTitle')} subtitle={t('team.invitationsSubtitle')} />
      <DataTable
        label={t('team.invitationsTitle')}
        data={data}
        columns={columns}
        getRowId={(invitation) => invitation.id}
        onRowClick={onOpen}
      />
    </section>
  );
}

// null = কিছু খোলা নেই; বাকিগুলো কোন dialog
type Open =
  | null
  | { kind: 'invite' }
  | { kind: 'member'; member: Member }
  | { kind: 'invitation'; invitation: Invitation };

export function TeamPage() {
  const { t } = useLocale();
  const can = useCan();
  const [open, setOpen] = useState<Open>(null);
  const close = () => {
    setOpen(null);
  };

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader
        title={t('team.title')}
        description={t('team.description')}
        actions={
          can('core.user.invite') && (
            <Button
              onClick={() => {
                setOpen({ kind: 'invite' });
              }}
            >
              <HugeiconsIcon icon={UserAdd01Icon} size={17} strokeWidth={1.5} />
              {t('team.invite')}
            </Button>
          )
        }
      />
      {can('core.user.invite') && (
        <InvitationsSection
          onOpen={(invitation) => {
            setOpen({ kind: 'invitation', invitation });
          }}
        />
      )}
      {can('core.user.read') ? (
        <MembersSection
          onOpen={
            can('core.user.manage')
              ? (member) => {
                  setOpen({ kind: 'member', member });
                }
              : undefined
          }
        />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          {t('team.readOnly')}
        </p>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        {open?.kind === 'invite' && <InviteForm onDone={close} />}
        {open?.kind === 'member' && (
          <MemberForm key={open.member.membershipId} member={open.member} onDone={close} />
        )}
        {open?.kind === 'invitation' && (
          <InvitationPanel key={open.invitation.id} invitation={open.invitation} onDone={close} />
        )}
      </Dialog>
    </div>
  );
}
```

- `useGrantable` — API-র নিয়মের আগাম ছায়া; বন্ধ বাক্সের নিচে কারণ ("Only an owner can give this role")। আসল পাহারা API —
  UI ভুল করলে `cannot_grant` alert-এ আসে।
- invite-এর ফর্ম react-hook-form + চুক্তির `createInvitationInputSchema` — রোল না বেছে পাঠালে সার্ভারে যায়ই না।
- সদস্যের ফর্ম react-hook-form ছাড়া (`useState`) — একটাই ঘর (রোলের তালিকা), কোনো লেখা-যাচাই নেই; `useMutation` যথেষ্ট।
- "Remove" দুই ধাপে, বাঁয়ে (CLAUDE.md → Dialog: destructive বাঁয়ে)। লাল বাটন নেই — design system-এ danger variant নেই,
  আর "একটাই accent" নিয়মে বানানোও হয়নি; নিরাপত্তা আসে দ্বিতীয় চাপ আর নাম-সহ লেখা থেকে।
- নিজের রো ক্লিক করলে কিছু খোলে না — API-তেও বন্ধ (`own_membership`)।
- invitation-এর তালিকা ফাঁকা হলে পুরো অংশটাই লুকানো।
- `Open` discriminated union — তিনটা dialog, একটা `Dialog` root; ধাপ ৬-এর `Editing`-এর ছাঁদ।

### রোলের পেজ: permission matrix

**ফাইল: `apps/app/src/routes/roles.tsx`** (নতুন)

```tsx
import { PlusSignIcon, SecurityCheckIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  isPermissionKey,
  PERMISSION_GROUP_OF,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  type PermissionKey,
  type Role,
  routes,
  updateRoleInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { rolesQuery } from '../lib/queries';
import { refreshMe } from '../lib/session';
import { useSession } from '../lib/session-store';

const ROLE_FIELDS = updateRoleInputSchema.keyof().options;

// তারে permission z.string() (নতুন সার্ভারের নতুন key) — ছকে শুধু এই app যেগুলো চেনে
function knownKeys(role: Role): PermissionKey[] {
  return role.permissions.filter(isPermissionKey);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// একটা ফর্ম দুই কাজে: নতুন রোল (role নেই) আর নাম/বিবরণ বদল। নতুনের version 1 — schema-র min(1) পার
// হয়, আর তৈরির route version পড়েই না (branches.tsx-এর একই কৌশল)
function RoleForm({ role, onDone }: { role: Role | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateRoleInputSchema, { error: contractErrorMap }),
    defaultValues: {
      name: role?.name ?? '',
      description: role?.description ?? '',
      version: role?.version ?? 1,
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['roles', tenantId] });

  const remove = useMutation({
    mutationFn: (current: Role) =>
      call(routes.roles.remove, {
        params: { id: current.id },
        query: { version: current.version },
      }),
    onSuccess: async (_, current) => {
      await refresh();
      toast(t('roles.deleted', { name: current.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = role
        ? await call(routes.roles.update, { params: { id: role.id }, body: { ...fields, version } })
        : await call(routes.roles.create, { body: fields });
      await refresh();
      // রোলের নাম me.roles-এ — নিজের রোলের নাম বদলালে সাইডবারের নিচেও নতুন নাম
      if (role) await refreshMe();
      toast(t(role ? 'roles.updated' : 'roles.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, ROLE_FIELDS, setError);
    }
  });

  const failure = errors.root?.server?.message ?? failureOf(remove.error);

  return (
    <DialogContent
      title={role ? t('roles.editTitle', { name: role.name }) : t('roles.newTitle')}
      description={role ? undefined : t('roles.newDescription')}
      footer={
        <>
          {role && (
            // বাঁয়ে আর দুই ধাপে — মুছে ফেলা ফেরানো যায় না
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming) remove.mutate(role);
                else setConfirming(true);
              }}
            >
              {confirming ? t('roles.confirmDelete', { name: role.name }) : t('roles.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="role-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : role ? t('common.save') : t('roles.create')}
          </Button>
        </>
      }
    >
      <form
        id="role-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('roles.deleteWarning')}</p>}
        <TextField
          label={t('roles.name')}
          icon={SecurityCheckIcon}
          placeholder={t('roles.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <TextAreaField
          label={t('roles.about')}
          optional
          placeholder={t('roles.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}

export function RolesPage() {
  const { t } = useLocale();
  const can = useCan();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const canManage = can('core.role.manage');
  const { data: roles, isError } = useQuery({ ...rolesQuery(tenantId), enabled: me !== null });
  // শুধু বদলানো রোলগুলো: রোলের id → নতুন পুরো তালিকা। সেভ না হওয়া পর্যন্ত সার্ভারের ডেটা অক্ষত, তাই
  // "Discard" মানে শুধু এই object খালি করা
  const [draft, setDraft] = useState<Record<string, PermissionKey[]>>({});
  const [editing, setEditing] = useState<null | 'new' | Role>(null);

  const ownerName = roles?.find((role) => role.kind === 'owner')?.name;
  const iAmOwner = ownerName !== undefined && (me?.roles.includes(ownerName) ?? false);
  // API-র নিয়মের আগাম ছায়া (grants.ts): নিজের যা আছে শুধু সেই ঘরে টিক বদলানো যায়
  const canTick = (key: PermissionKey) =>
    canManage && (iAmOwner || (me?.permissions.includes(key) ?? false));

  const current = (role: Role) => draft[role.id] ?? knownKeys(role);
  const changed = Object.keys(draft);

  const toggle = (role: Role, key: PermissionKey, on: boolean) => {
    setDraft((previous) => {
      const base = previous[role.id] ?? knownKeys(role);
      const next = on ? [...base, key] : base.filter((existing) => existing !== key);
      const rest = Object.fromEntries(Object.entries(previous).filter(([id]) => id !== role.id));
      // আগের অবস্থায় ফিরে এলে "বদলানো" তালিকা থেকেও বাদ — না হলে কিছু না বদলেও সেভ-বার দেখাত
      return sameSet(next, knownKeys(role)) ? rest : { ...rest, [role.id]: next };
    });
  };

  const save = useMutation({
    mutationFn: () =>
      call(routes.roles.updateMatrix, {
        body: {
          roles: changed.flatMap((id) => {
            const role = roles?.find((candidate) => candidate.id === id);
            const permissions = draft[id];
            return role && permissions ? [{ id, version: role.version, permissions }] : [];
          }),
        },
      }),
    onSuccess: async (result) => {
      // উত্তরেই পুরো নতুন তালিকা — আরেকটা GET লাগে না
      queryClient.setQueryData(rolesQuery(tenantId).queryKey, result.items);
      setDraft({});
      // আমার নিজের কোনো রোল বদলে থাকলে মেনুর লিংকও বদলায় (me.permissions)
      await refreshMe();
      toast(t('roles.saved'));
    },
  });

  return (
    <div className="grid max-w-6xl gap-5">
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('roles.add')}
            </Button>
          )
        }
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('roles.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('roles.loadFailed')}</p>}
      {save.error && <FormAlert message={failureOf(save.error) ?? 'unknown_error'} />}

      {roles && (
        // চওড়া ছক নিজের বাক্সে আড়াআড়ি scroll করে, পেজ না (CLAUDE.md → Page gutters)। min-w-0 বাধ্যতামূলক:
        // grid-এর সন্তানের ডিফল্ট min-width: auto = ভেতরের জিনিসের চওড়া, তাই এটা ছাড়া বাক্স ছকের সমান চওড়া
        // হয়ে পুরো পেজকে ফোনে আড়াআড়ি ঠেলত। প্রথম কলাম sticky — ডানে scroll করলেও সারির নাম চোখে থাকে
        <div className="min-w-0 overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
          <table className="w-full border-collapse text-body-sm">
            <caption className="sr-only">{t('roles.matrixLabel')}</caption>
            <thead>
              <tr className="bg-subtle">
                <th
                  scope="col"
                  className="sticky left-0 z-10 min-w-[220px] bg-subtle px-5 py-3 text-left text-caption font-medium text-ink-3"
                >
                  {t('roles.permission')}
                </th>
                {roles.map((role) => (
                  <th
                    key={role.id}
                    scope="col"
                    className="min-w-[120px] px-4 py-3 text-center align-bottom font-normal"
                  >
                    {canManage && role.kind === 'custom' ? (
                      <button
                        type="button"
                        aria-label={t('roles.edit', { role: role.name })}
                        onClick={() => {
                          setEditing(role);
                        }}
                        className="rounded-lg px-1.5 py-0.5 font-semibold text-ink transition-colors duration-150 hover:bg-surface hover:text-brand"
                      >
                        {role.name}
                      </button>
                    ) : (
                      <span className="font-semibold text-ink">{role.name}</span>
                    )}
                    <span className="block text-caption text-ink-3 tabular-nums">
                      {t('roles.members', { count: role.memberCount })}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {PERMISSION_GROUPS.map((group) => (
              <tbody key={group}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={roles.length + 1}
                    className="sticky left-0 bg-surface px-5 pt-4 pb-1 text-left text-caption font-medium text-ink-3"
                  >
                    {t(`roles.groups.${group}`)}
                  </th>
                </tr>
                {PERMISSION_KEYS.filter((key) => PERMISSION_GROUP_OF[key] === group).map((key) => (
                  <tr key={key} className="border-t border-line">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-surface px-5 py-3 text-left font-normal"
                    >
                      <span className="block text-ink">{t(`permissions.${key}`)}</span>
                      {/* key-টাও: permission_missing-এর লেখা ("core.audit.read লাগবে") এখানে মেলানো যায় */}
                      <span className="block font-mono text-caption text-ink-3">{key}</span>
                    </th>
                    {roles.map((role) => (
                      <td key={role.id} className="px-4 py-3">
                        <div className="grid place-items-center">
                          <Checkbox
                            id={`${role.id}-${key}`}
                            hideLabel
                            label={t('roles.cell', {
                              role: role.name,
                              permission: t(`permissions.${key}`),
                            })}
                            // owner-এর ঘর সবসময় টিক আর বন্ধ — অধিকার কোডে, ছকে বদলানোর কিছু নেই
                            checked={role.kind === 'owner' || current(role).includes(key)}
                            disabled={role.kind === 'owner' || !canTick(key) || save.isPending}
                            onCheckedChange={(checked) => {
                              toggle(role, key, checked === true);
                            }}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <p className="text-label text-ink-3">{t('roles.ownerLocked')}</p>

      {changed.length > 0 && (
        // সেভ-বার পেজের নিচে লেগে থাকে (sticky) — লম্বা ছকের যেখানেই থাকুন, বাটন হাতের কাছে
        <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-5 py-3 shadow-md">
          <p className="text-body-sm text-ink-2">{t('roles.unsaved', { count: changed.length })}</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                setDraft({});
                save.reset();
                // version_conflict-এর পরে এটাই "Reload": আরেকজনের সেভ করা ছক সার্ভার থেকে আবার আনা
                void queryClient.invalidateQueries({ queryKey: rolesQuery(tenantId).queryKey });
              }}
            >
              {t('roles.discard')}
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <RoleForm
            key={editing === 'new' ? 'new' : editing.id}
            role={editing === 'new' ? null : editing}
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

- `draft` — শুধু বদলানো রোল; "Discard" = খালি করা + সার্ভার থেকে আবার আনা (version_conflict-এর পরে এটাই "Reload")।
- `toggle` — আগের অবস্থায় ফিরলে draft থেকেও বাদ (`sameSet`), তাই অকারণে সেভ-বার দেখায় না।
- `min-w-0` scroll-বাক্সে — CSS grid-এর সন্তানের ডিফল্ট `min-width: auto`; না দিলে বাক্স ছকের সমান চওড়া হয়ে যেত। (যাচাইয়ে
  এটা ছাড়াও ৭.৭-এর `relative` লেগেছিল — দুটো আলাদা কারণ, দুটোই লাগে।)
- সারির শিরোনাম `sticky left-0` + `bg-surface` — পেছনের ঘর ঢাকা পড়ে; `z-10` যাতে scroll-এর সময় চেকবক্স উপরে না ওঠে।
- `<th scope="row">`/`scope="col"`/`scope="colgroup"` — স্ক্রিন রিডার প্রতিটা ঘরে "কোন রোল, কোন permission" পড়ে।
- `setQueryData` — উত্তরে পুরো তালিকা, আরেকটা GET না। `refreshMe()` — নিজের রোল বদলালে সাইডবারের লিংকও বদলায়।
- owner-এর ঘর `checked` আর `disabled` — draft-এ কখনো যায় না, তাই চুক্তির "owner বদলানো যায় না"-এর সাথে UI মেলে।

### join পেজ

**ফাইল: `apps/app/src/routes/invite.tsx`** (নতুন)

```tsx
import { LinkBackwardIcon, LockPasswordIcon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  acceptInvitationInputSchema,
  contractErrorMap,
  type InvitationPreview,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, FormAlert, Logo, TextField, toast } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import { LanguageSwitch } from '../components/language-switch';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { acceptInvitation } from '../lib/session';

// discriminated union-এর দুই রূপ আলাদা ফর্মে — একটা useForm-এ union রাখলে প্রতিটা ঘরের টাইপ
// "হয় এটা, নয় ওটা" হয়ে যেত। options-এর ক্রম চুক্তিতে: [0] = নতুন, [1] = পুরনো অ্যাকাউন্ট
const [newAccountSchema, existingAccountSchema] = acceptInvitationInputSchema.options;
const NEW_FIELDS = newAccountSchema.keyof().options;
const EXISTING_FIELDS = existingAccountSchema.keyof().options;

interface FormProps {
  token: string;
  preview: InvitationPreview;
}

function useJoined(preview: InvitationPreview) {
  const { t } = useLocale();
  const navigate = useNavigate();
  return async () => {
    toast(t('invite.joined', { workspace: preview.workspace.name }));
    await navigate({ to: '/' });
  };
}

function NewAccountForm({ token, preview }: FormProps) {
  const { t } = useLocale();
  const joined = useJoined(preview);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(newAccountSchema, { error: contractErrorMap }),
    defaultValues: { account: 'new' as const, token, fullName: '', password: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      await acceptInvitation(values);
      await joined();
    } catch (error) {
      applyApiError(error, NEW_FIELDS, setError);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-8 grid gap-[18px]">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      <TextField
        label={t('invite.fullName')}
        icon={UserIcon}
        autoComplete="name"
        placeholder="Tanvir Hossain"
        {...register('fullName')}
        error={errors.fullName?.message}
      />
      <TextField
        label={t('invite.password')}
        icon={LockPasswordIcon}
        type="password"
        autoComplete="new-password"
        placeholder={t('invite.newPasswordPlaceholder')}
        {...register('password')}
        error={errors.password?.message}
      />
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting
          ? t('invite.submitting')
          : t('invite.submit', { workspace: preview.workspace.name })}
      </Button>
    </form>
  );
}

function ExistingAccountForm({ token, preview }: FormProps) {
  const { t } = useLocale();
  const joined = useJoined(preview);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(existingAccountSchema, { error: contractErrorMap }),
    defaultValues: { account: 'existing' as const, token, password: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      await acceptInvitation(values);
      await joined();
    } catch (error) {
      applyApiError(error, EXISTING_FIELDS, setError);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-8 grid gap-[18px]">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      <TextField
        label={t('invite.password')}
        icon={LockPasswordIcon}
        type="password"
        autoComplete="current-password"
        placeholder={t('invite.existingPasswordPlaceholder')}
        {...register('password')}
        error={errors.password?.message}
      />
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting
          ? t('invite.submitting')
          : t('invite.submit', { workspace: preview.workspace.name })}
      </Button>
    </form>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg px-4 py-8 sm:px-16">
      <Logo />
      <div className="grid flex-1 place-items-center py-10">
        <div className="w-full max-w-[420px]">{children}</div>
      </div>
      <div className="flex justify-end">
        <LanguageSwitch />
      </div>
    </div>
  );
}

// ইমেইলের লিংক: /invite#<token>। token # (fragment)-এর পরে — ব্রাউজার সেটা কখনো সার্ভারে পাঠায় না
// (contracts/invitations.ts)। লগইন ছাড়াই খোলে; আগে অন্য অ্যাকাউন্টে লগইন থাকলেও চলে — গ্রহণ করলে
// নতুন session সেটার জায়গা নেয়
export function InvitePage() {
  const { t, format } = useLocale();
  const token = useLocation({ select: (location) => location.hash });
  const { data: preview, isError } = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => call(routes.invitations.lookup, { body: { token } }),
    // ভুল/পুরনো লিংকে ৩ বার আবার চেষ্টা করার কিছু নেই — উত্তর বদলাবে না
    retry: false,
    enabled: token.length > 0,
  });

  if (token.length === 0 || isError) {
    return (
      <Frame>
        <Card className="p-8 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={LinkBackwardIcon} size={18} strokeWidth={1.5} />
          </span>
          <h1 className="mt-3 text-h3">{t('invite.invalidTitle')}</h1>
          <p className="mt-1 text-body-sm text-ink-2">{t('invite.invalidBody')}</p>
          <Link
            to="/login"
            className="mt-4 inline-block font-medium text-brand underline-offset-[3px] hover:underline"
          >
            {t('invite.toSignIn')}
          </Link>
        </Card>
      </Frame>
    );
  }

  if (!preview) {
    return (
      <Frame>
        <p className="text-center text-body-sm text-ink-3">{t('invite.checking')}</p>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="text-[28px] leading-[1.2]">
        {t('invite.title', { workspace: preview.workspace.name })}
      </h1>
      <p className="mt-2 text-ink-2">
        {preview.invitedBy
          ? t('invite.invitedBy', { name: preview.invitedBy, email: preview.email })
          : t('invite.invitedAs', { email: preview.email })}{' '}
        {preview.accountExists ? t('invite.existingAccount') : t('invite.newAccount')}
      </p>
      {preview.accountExists ? (
        <ExistingAccountForm token={token} preview={preview} />
      ) : (
        <NewAccountForm token={token} preview={preview} />
      )}
      <p className="mt-6 text-center text-label text-ink-3">
        {t('invite.expires', { date: format.date(new Date(preview.expiresAt)) })}
      </p>
    </Frame>
  );
}
```

- `useLocation({ select: (location) => location.hash })` — TanStack Router `#` ছাড়া দেয়। `window.location` না পড়ে router
  থেকে: hash বদলালে (আরেকটা লিংক) পেজ নিজেই আবার আঁকে।
- hash URL থেকে মোছা হয় না — মুছলে reload করলেই লিংক হারাত; এটা শুধু ইউজারের নিজের ব্রাউজারের history।
- `retry: false` — ভুল লিংকে TanStack-এর ডিফল্ট ৩ বার চেষ্টা মানে ৩টা অকারণ request আর দেরি।
- দুই ফর্ম দুই schema-য় (`options[0]`/`[1]`) — মন্তব্যে কেন। `defaultValues`-এ `account: 'new' as const` — literal টাইপ
  না দিলে `string` হয়ে schema-র `z.literal('new')`-এর সাথে মিলত না (এটা cast না, literal-কে literal রাখা)।
- ভুল লিংকের পাতায় EmptyState-এর ছাঁদ (৪০px tile + শিরোনাম + কী করতে হবে)।

### router আর মেনু

**ফাইল: `apps/app/src/router.tsx`** (আপডেট)

```diff
--- a/apps/app/src/router.tsx
+++ b/apps/app/src/router.tsx
@@ -6,6 +6,7 @@ import {
   Outlet,
   redirect,
 } from '@tanstack/react-router';
+import { INVITE_PATH } from '@omnivo/contracts';
 
 import { restoreSession } from './lib/session';
 import { sessionStore } from './lib/session-store';
@@ -30,6 +31,14 @@ const loginRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/login'), 'LoginPage'),
 });
 
+// ইমেইলের লিংক। লগইন ছাড়াই খোলে, আর লগইন থাকলেও /-এ ফেরায় না (redirectIfSignedIn নেই): অন্য
+// অ্যাকাউন্টে বসে থাকা কেউও আমন্ত্রণটা দেখে গ্রহণ করতে পারবে
+const inviteRoute = createRoute({
+  getParentRoute: () => rootRoute,
+  path: INVITE_PATH,
+  component: lazyRouteComponent(() => import('./routes/invite'), 'InvitePage'),
+});
+
 const signUpRoute = createRoute({
   getParentRoute: () => rootRoute,
   path: '/sign-up',
@@ -75,6 +84,18 @@ const branchesRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/branches'), 'BranchesPage'),
 });
 
+const teamRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/team',
+  component: lazyRouteComponent(() => import('./routes/team'), 'TeamPage'),
+});
+
+const rolesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/roles',
+  component: lazyRouteComponent(() => import('./routes/roles'), 'RolesPage'),
+});
+
 const auditLogRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/audit-log',
@@ -96,11 +117,14 @@ const devRoutes = import.meta.env.DEV
 const routeTree = rootRoute.addChildren([
   loginRoute,
   signUpRoute,
+  inviteRoute,
   appRoute.addChildren([
     dashboardRoute,
     settingsRoute,
     numberingRoute,
     branchesRoute,
+    teamRoute,
+    rolesRoute,
     auditLogRoute,
     ...devRoutes,
   ]),
```

- `/invite`-এ `redirectIfSignedIn` নেই — অন্য অ্যাকাউন্টে লগইন থাকা কেউও আমন্ত্রণটা দেখে গ্রহণ করতে পারে; `startSession`
  আগের ক্যাশ মুছে নতুনটা বসায়।
- `path: INVITE_PATH` — contracts-এর `'/invite'` literal, তাই `<Link to="/invite">`-ও টাইপ-চেকড থাকে।

**ফাইল: `apps/app/src/routes/app-shell.tsx`** (আপডেট)

```diff
--- a/apps/app/src/routes/app-shell.tsx
+++ b/apps/app/src/routes/app-shell.tsx
@@ -3,10 +3,12 @@ import {
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
+  SecurityCheckIcon,
   Settings02Icon,
   Store01Icon,
   UnfoldMoreIcon,
   UserCircleIcon,
+  UserGroupIcon,
   WorkHistoryIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
@@ -34,6 +36,7 @@ import { useEffect, useState } from 'react';
 
 import { savePreference } from '../lib/preferences';
 import { logout, switchTenant } from '../lib/session';
+import { useCan } from '../lib/permissions';
 import { useSession } from '../lib/session-store';
 import { isTheme } from '../lib/theme';
 
@@ -192,7 +195,7 @@ export function AppShell() {
   const status = useSession((state) => state.status);
   const me = useSession((state) => state.me);
   // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
-  const can = (permission: string) => me?.permissions.includes(permission) ?? false;
+  const can = useCan();
 
   // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
   useEffect(() => {
@@ -225,6 +228,16 @@ export function AppShell() {
             )}
           </NavGroup>
           <NavGroup label={t('nav.workspace')}>
+            {(can('core.user.read') || can('core.user.invite')) && (
+              <NavLink to="/team" icon={UserGroupIcon}>
+                {t('nav.team')}
+              </NavLink>
+            )}
+            {(can('core.user.read') || can('core.role.manage')) && (
+              <NavLink to="/roles" icon={SecurityCheckIcon}>
+                {t('nav.roles')}
+              </NavLink>
+            )}
             <NavLink to="/branches" icon={Store01Icon}>
               {t('nav.branches')}
             </NavLink>
```

- Team দেখায় `core.user.read` **বা** `core.user.invite` থাকলে — শুধু invite পারা HR assistant-ও পেজটা পায় (সেখানে শুধু
  invitation-এর অংশ দেখে)।

---

## ৭.৯ — MSW: নতুন রুটের mock

**ফাইল: `apps/app/src/mocks/mock.ts`** (আপডেট — `MockProblem` এখানে সরল)

```diff
--- a/apps/app/src/mocks/mock.ts
+++ b/apps/app/src/mocks/mock.ts
@@ -26,6 +26,17 @@ export function reply<R extends RouteDef>(route: R, data: RouteResponse<R>): Res
   return Response.json(data, { status: route.status });
 }
 
+// handler যা ছুড়ে দেয় আর problem() যা পাঠায় — status + code (+ ঘর)
+export class MockProblem extends Error {
+  constructor(
+    readonly status: number,
+    readonly code: ErrorCode,
+    readonly fieldErrors?: Record<string, ErrorCode[]>,
+  ) {
+    super(code);
+  }
+}
+
 // আসল API-র মতোই RFC 9457 problem — UI-র error-পথ mock দিয়েও দেখা যায়
 export function problem(
   status: number,
```

- কেন সরানো: নতুন `people-data.ts` `MockProblem` চায়, আর `workspace-data.ts` `people-data.ts`-এর `seedPeople` চায় —
  একে অন্যকে import করলে `pnpm boundaries`-এর `no-circular` fail। `mock.ts` দুজনেরই নিচে।

**ফাইল: `apps/app/src/mocks/workspace-data.ts`** (আপডেট)

```diff
--- a/apps/app/src/mocks/workspace-data.ts
+++ b/apps/app/src/mocks/workspace-data.ts
@@ -9,7 +9,6 @@ import {
   defaultNumberFormat,
   DOCUMENT_TYPES,
   type DocumentType,
-  type ErrorCode,
   formatDocumentNumber,
   type NumberFormat,
   type NumberSeries,
@@ -19,6 +18,8 @@ import {
 } from '@omnivo/contracts';
 
 import { OWNER, type Workspace } from './fixtures';
+import { MockProblem } from './mock';
+import { type People, seedPeople } from './people-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -27,17 +28,7 @@ export interface WorkspaceData {
   branches: Branch[];
   series: Map<DocumentType, NumberFormat & { version: number }>;
   audit: AuditEntry[];
-}
-
-// handler যা ছুড়ে দেয় আর problem() যা পাঠায় — status + code (+ ঘর)
-export class MockProblem extends Error {
-  constructor(
-    readonly status: number,
-    readonly code: ErrorCode,
-    readonly fieldErrors?: Record<string, ErrorCode[]>,
-  ) {
-    super(code);
-  }
+  people: People;
 }
 
 function now(): string {
@@ -82,6 +73,7 @@ function seed(workspace: Workspace): WorkspaceData {
       : [branch('HO', 'Head office', 'Tejgaon Industrial Area, Dhaka 1208')],
     series: new Map(),
     audit: [],
+    people: seedPeople(workspace),
   };
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
```

**ফাইল: `apps/app/src/mocks/fixtures.ts`** (আপডেট)

```diff
--- a/apps/app/src/mocks/fixtures.ts
+++ b/apps/app/src/mocks/fixtures.ts
@@ -1,4 +1,4 @@
-import type { Member, MeResponse, Preferences } from '@omnivo/contracts';
+import { type MeResponse, PERMISSION_KEYS, type Preferences } from '@omnivo/contracts';
 
 // আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে
 export const WORKSPACES = [
@@ -16,15 +16,8 @@ const owner = {
 
 export const OWNER = owner;
 
-// Owner = সব permission (আসল API-র মতো)
-export const OWNER_PERMISSIONS = [
-  'core.audit.read',
-  'core.branch.manage',
-  'core.role.manage',
-  'core.settings.manage',
-  'core.user.invite',
-  'core.user.read',
-];
+// Owner = catalog-এর সব permission (আসল API-র মতো, কোড থেকে)
+export const OWNER_PERMISSIONS = [...PERMISSION_KEYS].sort();
 
 export function meIn(
   workspace: Workspace,
@@ -40,20 +33,3 @@ export function meIn(
     preferences,
   };
 }
-
-const FIRST = ['Abdul', 'Nasrin', 'Shafiq', 'Rupa', 'Tanvir', 'Sharmin', 'Mahbub', 'Farzana'];
-const LAST = ['Karim', 'Akter', 'Islam', 'Hossain', 'Rahman', 'Chowdhury', 'Sarkar', 'Begum'];
-const ROLES = [['Accountant'], ['Merchandiser'], ['Store keeper'], [], ['Production manager']];
-
-// ২৪০ জন: এক পাতায় ৫০, তাই ড্যাশবোর্ডে scroll করলে পরের পাতাগুলো আসতে দেখা যায়
-export const MEMBERS: Member[] = Array.from({ length: 240 }, (_, index) => {
-  const first = FIRST[index % FIRST.length] ?? 'Abdul';
-  const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Karim';
-  return {
-    membershipId: crypto.randomUUID(),
-    userId: crypto.randomUUID(),
-    fullName: `${first} ${last}`,
-    email: `${first}.${last}${String(index)}@rahmangarments.com`.toLowerCase(),
-    roles: ROLES[index % ROLES.length] ?? [],
-  };
-});
```

**ফাইল: `apps/app/src/mocks/people-data.ts`** (নতুন)

```ts
import {
  INVITATION_TTL_DAYS,
  type Invitation,
  type InvitationPreview,
  type Member,
  PERMISSION_KEYS,
  type PermissionKey,
  type Role,
} from '@omnivo/contracts';

import { OWNER, type Workspace } from './fixtures';
import { MockProblem } from './mock';

// mock সার্ভারের টিম — রোল, সদস্য, invitation। নিয়মগুলো আসল API-র মতো (owner বদলানো যায় না, শেষ owner,
// নিজের রোল না, একই ইমেইলে দুটো খোলা invitation না), যাতে UI-র প্রতিটা error-পথ mock-এও দেখা যায়
export interface MockRole {
  id: string;
  name: string;
  description: string | null;
  kind: Role['kind'];
  permissions: PermissionKey[];
  version: number;
  updatedAt: string;
}

export interface MockInvitation extends Invitation {
  token: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface People {
  roles: MockRole[];
  members: Member[];
  invitations: MockInvitation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function role(name: string, permissions: PermissionKey[], description: string | null): MockRole {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    kind: 'custom',
    permissions,
    version: 1,
    updatedAt: now(),
  };
}

const FIRST = ['Abdul', 'Nasrin', 'Shafiq', 'Rupa', 'Tanvir', 'Sharmin', 'Mahbub', 'Farzana'];
const LAST = ['Karim', 'Akter', 'Islam', 'Hossain', 'Rahman', 'Chowdhury', 'Sarkar', 'Begum'];

// আসল ইন্ডাস্ট্রির রোল (CLAUDE.md → Content)। গার্মেন্টসে ২৪০ জন — এক পাতায় ৫০, তাই টিমের পেজে scroll
// করলে পরের পাতাগুলো আসতে দেখা যায়
export function seedPeople(workspace: Workspace): People {
  const owner: MockRole = {
    id: crypto.randomUUID(),
    name: 'Owner',
    description: null,
    kind: 'owner',
    permissions: [...PERMISSION_KEYS],
    version: 1,
    updatedAt: now(),
  };
  const roles = [
    owner,
    role('Accountant', ['core.user.read', 'core.audit.read'], 'Books, VAT returns and Mushak 6.3'),
    role('Merchandiser', ['core.user.read'], 'Buyer POs and LCs'),
    role('Store keeper', ['core.branch.manage'], 'Receives goods at depots and writes GRNs'),
  ];
  const custom = roles.slice(1);
  const count = workspace.slug === 'rahman-garments' ? 240 : 12;
  const members: Member[] = [
    {
      membershipId: crypto.randomUUID(),
      userId: OWNER.id,
      fullName: OWNER.fullName,
      email: OWNER.email,
      roles: [{ id: owner.id, name: owner.name }],
      version: 1,
      joinedAt: new Date(Date.now() - 400 * DAY_MS).toISOString(),
    },
    ...Array.from({ length: count }, (_, index): Member => {
      const first = FIRST[index % FIRST.length] ?? 'Abdul';
      const last = LAST[Math.floor(index / FIRST.length) % LAST.length] ?? 'Karim';
      // প্রতি পাঁচজনের একজনের কোনো রোল নেই — "No role" দেখার জন্য
      const assigned = index % 5 === 3 ? undefined : custom[index % custom.length];
      return {
        membershipId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        fullName: `${first} ${last}`,
        email: `${first}.${last}${String(index)}@${workspace.slug}.com`.toLowerCase(),
        roles: assigned ? [{ id: assigned.id, name: assigned.name }] : [],
        version: 1,
        joinedAt: new Date(Date.now() - (index + 1) * DAY_MS).toISOString(),
      };
    }),
  ];
  return { roles, members, invitations: [] };
}

export function toRole(people: People, entry: MockRole): Role {
  return {
    ...entry,
    // owner = সব key (আসল API কোড থেকে দেয়)
    permissions:
      entry.kind === 'owner' ? [...PERMISSION_KEYS].sort() : [...entry.permissions].sort(),
    memberCount: people.members.filter((member) =>
      member.roles.some((held) => held.id === entry.id),
    ).length,
  };
}

// owner আগে, তারপর নাম — আসল API-র ক্রম
export function roleList(people: People): Role[] {
  return people.roles
    .map((entry) => toRole(people, entry))
    .toSorted((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'owner' ? -1 : 1,
    );
}

export function findRole(people: People, id: string): MockRole {
  const found = people.roles.find((candidate) => candidate.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function findMember(people: People, id: string): Member {
  const found = people.members.find((candidate) => candidate.membershipId === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function assertRoleNameFree(people: People, name: string, except?: string): void {
  const taken = people.roles.some(
    (other) => other.id !== except && other.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new MockProblem(409, 'role_name_taken', { name: ['role_name_taken'] });
}

// mock-এ আমি সবসময় OWNER — নিজের সদস্যপদ বদলানো বন্ধ, আর owner সরালে অন্তত একজন থাকবে
export function assertCanChange(people: People, member: Member, nextRoleIds: string[]): void {
  if (member.userId === OWNER.id) throw new MockProblem(409, 'own_membership');
  const ownerRole = people.roles.find((candidate) => candidate.kind === 'owner');
  const losesOwner =
    ownerRole !== undefined &&
    member.roles.some((held) => held.id === ownerRole.id) &&
    !nextRoleIds.includes(ownerRole.id);
  const otherOwners = people.members.filter(
    (other) =>
      other.membershipId !== member.membershipId &&
      other.roles.some((held) => held.id === ownerRole?.id),
  );
  if (losesOwner && otherOwners.length === 0) throw new MockProblem(409, 'last_owner');
}

export function isOpen(invitation: MockInvitation): boolean {
  return invitation.acceptedAt === null && invitation.revokedAt === null;
}

// তারে যায় শুধু চুক্তির আকার — token আর অবস্থার ঘর বাদ
export function toInvitation(invitation: MockInvitation): Invitation {
  return {
    id: invitation.id,
    email: invitation.email,
    roles: invitation.roles,
    invitedBy: invitation.invitedBy,
    sentAt: invitation.sentAt,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    version: invitation.version,
  };
}

export function newToken(): string {
  // আসল API-র মতোই ৪৩ অক্ষরের base64url-এর মতো লম্বা, চুক্তির min(32) পেরোয়
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '').slice(0, 43);
}

export function expiry(): string {
  return new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS).toISOString();
}

// ইমেইল ছাড়াই join পেজ দেখার দুটো লিংক (`pnpm dev:mock` আর Playwright):
// /invite#<NEW> = নতুন অ্যাকাউন্ট, /invite#<EXISTING> = আগে থেকে অ্যাকাউন্ট আছে (পাসওয়ার্ড চায়)
export const DEMO_TOKENS = {
  newAccount: 'mock-new-account-invitation-token-0001',
  existingAccount: 'mock-existing-account-invitation-token-01',
} as const;

export function demoPreview(token: string, workspace: Workspace): InvitationPreview | null {
  const accountExists =
    token === DEMO_TOKENS.existingAccount ? true : token === DEMO_TOKENS.newAccount ? false : null;
  if (accountExists === null) return null;
  return {
    workspace: { name: workspace.name, slug: workspace.slug },
    email: accountExists ? 'karim@karimpharma.com' : 'tanvir@rahmangarments.com',
    invitedBy: OWNER.fullName,
    accountExists,
    expiresAt: expiry(),
  };
}
```

- `DEMO_TOKENS` — `pnpm dev:mock`-এ ইমেইল নেই; এই দুই লিংকে join পেজের দুই রূপ দেখা যায়, আর Playwright এগুলো ব্যবহার করে।
  দৈর্ঘ্য ৩২+ — চুক্তির `min(32)`; ছোট দিলে mock-এর `readBody` নিজেই parse-এ ভাঙত।
- ইমেইলে "bounce" থাকলে `sentAt: null` — "Email not sent" পিল দেখার উপায়।

**ফাইল: `apps/app/src/mocks/handlers.ts`** (আপডেট)

```diff
--- a/apps/app/src/mocks/handlers.ts
+++ b/apps/app/src/mocks/handlers.ts
@@ -2,15 +2,27 @@ import { type AuthSession, type Preferences, routes, type Settings } from '@omni
 import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';
 
 import { API_URL } from '../lib/api';
-import { MEMBERS, meIn, WORKSPACES, type Workspace } from './fixtures';
-import { mock, problem, readBody, readQuery, reply } from './mock';
+import { meIn, OWNER, WORKSPACES, type Workspace } from './fixtures';
+import { mock, MockProblem, problem, readBody, readQuery, reply } from './mock';
+import {
+  assertCanChange,
+  assertRoleNameFree,
+  demoPreview,
+  expiry,
+  findMember,
+  findRole,
+  isOpen,
+  newToken,
+  roleList,
+  toInvitation,
+  toRole,
+} from './people-data';
 import {
   assertCodeFree,
   checkVersion,
   dataOf,
   diff,
   findBranch,
-  MockProblem,
   record,
   seriesList,
 } from './workspace-data';
@@ -122,7 +134,9 @@ export const handlers = [
     const query = readQuery(routes.members.list.query, request);
     // আসল API keyset ব্যবহার করে; mock-এ cursor শুধু একটা offset — ক্লায়েন্টের কাছে দুটোই অস্বচ্ছ
     const start = query.cursor === undefined ? 0 : Number(query.cursor);
-    const sorted = MEMBERS.toSorted((a, b) => a.fullName.localeCompare(b.fullName));
+    const sorted = current().people.members.toSorted((a, b) =>
+      a.fullName.localeCompare(b.fullName),
+    );
     if (query.sort === '-name') sorted.reverse();
     const items = sorted.slice(start, start + query.limit);
     const end = start + items.length;
@@ -134,6 +148,261 @@ export const handlers = [
     });
   }),
 
+  mock(
+    routes.members.updateRoles,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.members.updateRoles.params.parse(params);
+      const { roleIds, version } = await readBody(routes.members.updateRoles.body, request);
+      const data = current();
+      const member = findMember(data.people, id);
+      checkVersion(member.version, version);
+      assertCanChange(data.people, member, roleIds);
+      const before = member.roles.map((role) => role.name).join(', ') || null;
+      member.roles = roleIds
+        .map((roleId) => findRole(data.people, roleId))
+        .map((role) => ({ id: role.id, name: role.name }))
+        .toSorted((a, b) => a.name.localeCompare(b.name));
+      member.version += 1;
+      const after = member.roles.map((role) => role.name).join(', ') || null;
+      record(data, 'member.roles_changed', 'member', id, { roles: { from: before, to: after } });
+      await delay();
+      return reply(routes.members.updateRoles, member);
+    }),
+  ),
+
+  mock(
+    routes.members.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.members.remove.params.parse(params);
+      const { version } = readQuery(routes.members.remove.query, request);
+      const data = current();
+      const member = findMember(data.people, id);
+      checkVersion(member.version, version);
+      assertCanChange(data.people, member, []);
+      data.people.members = data.people.members.filter((other) => other.membershipId !== id);
+      record(data, 'member.removed', 'member', id, { email: { from: member.email, to: null } });
+      return reply(routes.members.remove, undefined);
+    }),
+  ),
+
+  mock(routes.roles.list, () => reply(routes.roles.list, { items: roleList(current().people) })),
+
+  mock(
+    routes.roles.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.roles.create.body, request);
+      const data = current();
+      assertRoleNameFree(data.people, body.name);
+      const created = {
+        id: crypto.randomUUID(),
+        ...body,
+        kind: 'custom' as const,
+        permissions: [],
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.people.roles.push(created);
+      record(data, 'role.created', 'role', created.id, diff({}, body));
+      await delay();
+      return reply(routes.roles.create, toRole(data.people, created));
+    }),
+  ),
+
+  mock(
+    routes.roles.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.roles.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.roles.update.body, request);
+      const data = current();
+      const target = findRole(data.people, id);
+      if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
+      checkVersion(target.version, version);
+      assertRoleNameFree(data.people, fields.name, id);
+      const before = { name: target.name, description: target.description };
+      Object.assign(target, fields, { version: version + 1 });
+      // সদস্যের তালিকায় রোলের নামও নতুন
+      for (const member of data.people.members) {
+        for (const held of member.roles) if (held.id === id) held.name = fields.name;
+      }
+      record(data, 'role.updated', 'role', id, diff(before, fields));
+      return reply(routes.roles.update, toRole(data.people, target));
+    }),
+  ),
+
+  mock(
+    routes.roles.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.roles.remove.params.parse(params);
+      const { version } = readQuery(routes.roles.remove.query, request);
+      const data = current();
+      const target = findRole(data.people, id);
+      if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
+      checkVersion(target.version, version);
+      const inUse =
+        data.people.members.some((member) => member.roles.some((held) => held.id === id)) ||
+        data.people.invitations.some(
+          (invitation) => isOpen(invitation) && invitation.roles.some((held) => held.id === id),
+        );
+      if (inUse) throw new MockProblem(409, 'role_in_use');
+      data.people.roles = data.people.roles.filter((other) => other.id !== id);
+      record(data, 'role.deleted', 'role', id, { name: { from: target.name, to: null } });
+      return reply(routes.roles.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.roles.updateMatrix,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.roles.updateMatrix.body, request);
+      const data = current();
+      // আসল API-র মতো সব-নয়-কিছুই-না: আগে সব যাচাই, তারপর লেখা
+      const targets = body.roles.map((change) => {
+        const target = findRole(data.people, change.id);
+        if (target.kind === 'owner') throw new MockProblem(409, 'owner_role_locked');
+        checkVersion(target.version, change.version);
+        return { target, change };
+      });
+      for (const { target, change } of targets) {
+        const changes = diff(
+          Object.fromEntries(target.permissions.map((key) => [key, true])),
+          Object.fromEntries(change.permissions.map((key) => [key, true])),
+        );
+        for (const key of target.permissions) {
+          if (!change.permissions.includes(key)) changes[key] = { from: true, to: false };
+        }
+        target.permissions = change.permissions;
+        target.version += 1;
+        record(data, 'role.permissions_changed', 'role', target.id, changes);
+      }
+      await delay();
+      return reply(routes.roles.updateMatrix, { items: roleList(data.people) });
+    }),
+  ),
+
+  mock(routes.invitations.list, () =>
+    reply(routes.invitations.list, {
+      items: current().people.invitations.filter(isOpen).map(toInvitation),
+    }),
+  ),
+
+  mock(
+    routes.invitations.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.invitations.create.body, request);
+      const data = current();
+      if (data.people.members.some((member) => member.email === body.email)) {
+        throw new MockProblem(409, 'already_member', { email: ['already_member'] });
+      }
+      if (data.people.invitations.some((other) => isOpen(other) && other.email === body.email)) {
+        throw new MockProblem(409, 'already_invited', { email: ['already_invited'] });
+      }
+      const invitation = {
+        id: crypto.randomUUID(),
+        email: body.email,
+        roles: body.roleIds.map((roleId) => {
+          const held = findRole(data.people, roleId);
+          return { id: held.id, name: held.name };
+        }),
+        invitedBy: { id: OWNER.id, fullName: OWNER.fullName },
+        // "bounce" থাকা ঠিকানায় চিঠি "যায় না" — UI-র "Email not sent" পথ দেখার জন্য
+        sentAt: body.email.includes('bounce') ? null : new Date().toISOString(),
+        expiresAt: expiry(),
+        createdAt: new Date().toISOString(),
+        version: 1,
+        token: newToken(),
+        acceptedAt: null,
+        revokedAt: null,
+      };
+      data.people.invitations.unshift(invitation);
+      record(data, 'member.invited', 'invitation', invitation.id, {
+        email: { from: null, to: invitation.email },
+      });
+      // ইমেইলের বদলে console — `pnpm dev:mock`-এ লিংকটা খুলে join পেজ দেখা যায়
+      console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
+      await delay();
+      return reply(routes.invitations.create, toInvitation(invitation));
+    }),
+  ),
+
+  mock(
+    routes.invitations.resend,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.invitations.resend.params.parse(params);
+      const { version } = await readBody(routes.invitations.resend.body, request);
+      const invitation = current().people.invitations.find(
+        (candidate) => candidate.id === id && isOpen(candidate),
+      );
+      if (!invitation) throw new MockProblem(404, 'not_found');
+      checkVersion(invitation.version, version);
+      Object.assign(invitation, {
+        token: newToken(),
+        expiresAt: expiry(),
+        sentAt: new Date().toISOString(),
+        version: version + 1,
+      });
+      console.info(`[mock] invitation link: ${window.location.origin}/invite#${invitation.token}`);
+      return reply(routes.invitations.resend, toInvitation(invitation));
+    }),
+  ),
+
+  mock(
+    routes.invitations.revoke,
+    guarded(({ request, params }) => {
+      const { id } = routes.invitations.revoke.params.parse(params);
+      const { version } = readQuery(routes.invitations.revoke.query, request);
+      const invitation = current().people.invitations.find(
+        (candidate) => candidate.id === id && isOpen(candidate),
+      );
+      if (!invitation) throw new MockProblem(404, 'not_found');
+      checkVersion(invitation.version, version);
+      Object.assign(invitation, { revokedAt: new Date().toISOString(), version: version + 1 });
+      return reply(routes.invitations.revoke, undefined);
+    }),
+  ),
+
+  mock(
+    routes.invitations.lookup,
+    guarded(async ({ request }) => {
+      const { token } = await readBody(routes.invitations.lookup.body, request);
+      const invitation = current().people.invitations.find(
+        (candidate) => candidate.token === token && isOpen(candidate),
+      );
+      const preview = invitation
+        ? {
+            workspace: { name: workspace.name, slug: workspace.slug },
+            email: invitation.email,
+            invitedBy: invitation.invitedBy?.fullName ?? null,
+            accountExists: false,
+            expiresAt: invitation.expiresAt,
+          }
+        : demoPreview(token, workspace);
+      if (!preview) throw new MockProblem(404, 'invitation_invalid');
+      await delay();
+      return reply(routes.invitations.lookup, preview);
+    }),
+  ),
+
+  mock(
+    routes.invitations.accept,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.invitations.accept.body, request);
+      const invitation = current().people.invitations.find(
+        (candidate) => candidate.token === body.token && isOpen(candidate),
+      );
+      if (!invitation && !demoPreview(body.token, workspace)) {
+        throw new MockProblem(404, 'invitation_invalid');
+      }
+      if (body.account === 'existing' && body.password === 'wrong-password') {
+        throw new MockProblem(401, 'invalid_credentials');
+      }
+      if (invitation) invitation.acceptedAt = new Date().toISOString();
+      await delay();
+      // mock-এ "আমি" সবসময় OWNER — গ্রহণের পরে একই ড্যাশবোর্ড, শুধু পথটা দেখার জন্য
+      signedIn = true;
+      return reply(routes.invitations.accept, session());
+    }),
+  ),
+
   mock(routes.settings.get, () => reply(routes.settings.get, current().settings)),
 
   mock(
```

- invite তৈরি হলে `console.info`-তে লিংক — DevTools থেকে খুলে join পেজ দেখা যায়।
- mock-এ "আমি" সবসময় Farhana (owner) — accept-এর পরে একই ড্যাশবোর্ড; উদ্দেশ্য শুধু পথটা দেখা।

**ফাইল: `apps/app/src/lib/api.spec.ts`** (আপডেট)

```diff
--- a/apps/app/src/lib/api.spec.ts
+++ b/apps/app/src/lib/api.spec.ts
@@ -3,8 +3,9 @@ import { http, HttpResponse } from 'msw';
 import { setupServer } from 'msw/node';
 import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
 
-import { MEMBERS } from '../mocks/fixtures';
+import { WORKSPACES } from '../mocks/fixtures';
 import { mock, problem, reply } from '../mocks/mock';
+import { seedPeople } from '../mocks/people-data';
 import { API_URL, ApiRequestError, call } from './api';
 import { sessionStore } from './session-store';
 
@@ -24,7 +25,7 @@ beforeEach(() => {
   sessionStore.getState().signOut();
 });
 
-const page = { items: MEMBERS.slice(0, 2), nextCursor: 'next' };
+const page = { items: seedPeople(WORKSPACES[0]).members.slice(0, 2), nextCursor: 'next' };
 
 describe('call', () => {
   it('builds the URL from the contract and returns the parsed response', async () => {
```

---

## ৭.১০ — Playwright

**ফাইল: `apps/app/e2e/team.e2e.ts`** (নতুন)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Team');
});

test('invites someone, refuses a second invitation, then cancels it', async ({ page }) => {
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite people' });
  await dialog.getByLabel('Email').fill('Tanvir@RahmanGarments.com');
  // রোল না বেছে পাঠানো — ফর্মের নিজের যাচাই, সার্ভারে যায় না
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog.getByText('Pick at least one role.')).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Accountant/ }).click();
  // Owner বাক্স owner-এর জন্য খোলা (mock-এ আমি owner)
  await expect(dialog.getByRole('checkbox', { name: /Owner/ })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Invitation sent to tanvir@rahmangarments.com')).toBeVisible();

  await page.getByRole('button', { name: 'Invite people' }).click();
  await dialog.getByLabel('Email').fill('tanvir@rahmangarments.com');
  await dialog.getByRole('checkbox', { name: /Merchandiser/ }).click();
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog.getByText(/already has an open invitation/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await listItem(page, /tanvir@rahmangarments.com/).click();
  await page.getByRole('button', { name: 'Cancel invitation' }).click();
  await expect(page.getByText('Invitation to tanvir@rahmangarments.com cancelled')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open invitations' })).toBeHidden();
  await expectNoSideScroll(page);
});

test("changes a member's roles", async ({ page }) => {
  // নামের ক্রমে প্রথম জন — ২৪১ জনের তালিকা virtualized, ফোনে নিচের কার্ড DOM-এই থাকে না
  await listItem(page, /abdul\.akter8@/).click();
  const dialog = page.getByRole('dialog', { name: 'Abdul Akter' });
  await dialog.getByRole('checkbox', { name: /Merchandiser/ }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Roles of Abdul Akter saved')).toBeVisible();
  await expect(listItem(page, /abdul\.akter8@.*Merchandiser/)).toBeVisible();
});
```

- `abdul.akter8@` — নামের ক্রমে প্রথম জন। যাচাইয়ের প্রথম খসড়া "Farhana Rahman" আর "abdul.karim0" খুঁজত — ২৪১ জনের তালিকা
  virtualized, ফোনে নিচের কার্ড DOM-এই থাকে না; ডেস্কটপে পাস, ফোনে ৩০ সেকেন্ড অপেক্ষা করে fail।

**ফাইল: `apps/app/e2e/roles.e2e.ts`** (নতুন)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Roles');
});

test('creates a role and gives it permissions in the grid', async ({ page }) => {
  await page.getByRole('button', { name: 'New role' }).click();
  const dialog = page.getByRole('dialog', { name: 'New role' });
  // নামের বড়-ছোট হাত আলাদা হলেও একই — সার্ভারের 409 ঘরের নিচে
  await dialog.getByLabel('Name').fill('accountant');
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(dialog.getByText('Another role already has this name.')).toBeVisible();
  await dialog.getByLabel('Name').fill('Quality inspector');
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('Quality inspector created')).toBeVisible();

  const cell = page.getByRole('checkbox', { name: 'Quality inspector: See the audit log' });
  await cell.click();
  await expect(page.getByText('1 role has unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();
  await expect(cell).toBeChecked();
  await expectNoSideScroll(page);
});

test('keeps the Owner column ticked and locked', async ({ page }) => {
  const cell = page.getByRole('checkbox', { name: 'Owner: Edit company settings and numbering' });
  await expect(cell).toBeChecked();
  await expect(cell).toBeDisabled();
});
```

- `expectNoSideScroll` — এই টেস্টই ৭.৭-এর `relative` বাগ ধরেছিল (আসলে তার আগের ধাপে dialog-এর বাটন আটকে)।

**ফাইল: `apps/app/e2e/invite.e2e.ts`** (নতুন)

```ts
import { expect, test } from '@playwright/test';

// mocks/people-data.ts-এর DEMO_TOKENS — ইমেইল ছাড়াই join পেজ
test('joins with a new account from the email link', async ({ page }) => {
  await page.goto('/invite#mock-new-account-invitation-token-0001');
  await expect(page.getByRole('heading', { name: 'Join Rahman Garments Ltd.' })).toBeVisible();
  await page.getByLabel('Full name').fill('Tanvir Hossain');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Join Rahman Garments Ltd.' }).click();
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
  await page.getByLabel('Password').fill('Konabari-cut-2026');
  await page.getByRole('button', { name: 'Join Rahman Garments Ltd.' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('asks an existing account only for its password', async ({ page }) => {
  await page.goto('/invite#mock-existing-account-invitation-token-01');
  await expect(page.getByLabel('Full name')).toBeHidden();
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Join Rahman Garments Ltd.' }).click();
  await expect(page.getByRole('alert')).toHaveText(/Email or password is incorrect/);
});

test('explains an expired or made-up link', async ({ page }) => {
  await page.goto('/invite#this-link-was-never-sent-by-anyone-at-all');
  await expect(
    page.getByRole('heading', { name: 'This invitation link has expired' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
});
```

- `page.goto` এখানে ঠিক আছে (helpers.ts-এর সতর্কতা ভাঙে না): join পেজ প্রথম পেজ, আগের mock অবস্থার দরকার নেই।

---

## ৭.১১ — root: env, openapi

**ফাইল: `.env.example`** (শেষে যোগ)

```sh
# ইমেইল (invite) — dev-এ docker-compose-এর Mailpit; পাঠানো সব চিঠি http://localhost:8025-এ
SMTP_URL=smtp://localhost:1025
MAIL_FROM=Omnivo <no-reply@omnivo.app>
```

docker-compose-এ Mailpit ধাপ ০ থেকেই আছে (`mail` সার্ভিস, 1025/8025) — কিছু বদলাতে হবে না।

```bash
pnpm gen:openapi     # openapi.json — ৩১টা path (আগে ২১), commit করুন
```

---

## ৭.১২ — ডকুমেন্ট হালনাগাদ

ইমপ্লিমেন্ট শেষে (আমাকে বললে আমি করে দিতে পারি):

**CLAUDE.md** — "Components"-এ, Checkbox-এর পরে:

> - **Checkbox group:** a `fieldset` with a 13px/500 `legend`, the checkboxes in a 1px `line` box (radius 10px, 12px
>   padding), and the hint or error below like a form field. Use it for picking several of a few (roles, modules).
> - **Permission matrix:** a table card with the permission names as sticky row headers (label plus the key in
>   `Geist Mono` `ink-3`), one column per role, group rows in `ink-3` caption text, and a sticky save bar (card,
>   `shadow-md`) that appears only when something changed. Locked cells are checked and disabled.

আর Checkbox-এর লাইনে: "A checkbox with a hidden label (`hideLabel`) still needs a label for screen readers."

**build-plan.bn.md** — পর্ব ২-এর টেবিলে ধাপ ৭-এর "ব্যাকএন্ড" ঘর: `invite flow (ইমেইল, Mailpit), কাস্টম রোল, permission matrix
API, owner = system role, escalation বন্ধ, বাদ পড়া সদস্য সাথে সাথে 401`; "ফ্রন্টএন্ড": `টিমের পেজ, ইনভাইট মডাল, join পেজ,
permission matrix গ্রিড`।

**COMMANDS.md** — "Run the full stack"-এর URL তালিকায়: `Mailpit (every email the API sends): http://localhost:8025`।

**README.md** — Getting started-এর নিচে: "`.env` needs the `SMTP_URL` line from `.env.example` (step 7)"।

---

## ৭.১৩ — রান করুন

**১) `.env`-এ দুটো লাইন** (`.env.example`-এর শেষ অংশ) — এডিটরে খুলে শেষে বসান (ধাপ ৬-এর newline-সতর্কতা মনে রাখুন):

```sh
SMTP_URL=smtp://localhost:1025
MAIL_FROM=Omnivo <no-reply@omnivo.app>
```

**২) বাকিটা:**

```bash
pnpm install                                  # nodemailer; lockfile আপডেট
pnpm db:up                                    # Mailpit আগে থেকেই compose-এ
pnpm db:migrate                               # 0009 + 0010
pnpm gen:openapi                              # commit করুন
pnpm dev                                      # চালু থাকলে বন্ধ করে আবার — নতুন env পড়তে
```

`pnpm db:migrate`-এর পরে psql-এ (`pnpm db:psql`):

```sql
SELECT t.slug, r.name, r.kind FROM roles r JOIN tenants t ON t.id = r.tenant_id;   -- প্রতিটা workspace-এ Owner = owner
SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.kind = 'owner';  -- 0
SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('invitations', 'invitation_roles');  -- t, t
```

### যা দেখবেন

1. পুরনো workspace দিয়ে লগইন → সাইডবারে নতুন **Team** আর **Roles**। ড্যাশবোর্ডে টিমের তালিকা নেই, "Invite your team" লিংক।
2. **Roles** → প্রথম কলাম Owner, সব টিক ধূসর (বন্ধ)। "New role" → `accountant` → পরে `Accountant` নামে আরেকটা → "Another role
   already has this name." "Accountant"-এর কলামে "See the team" আর "See the audit log" টিক → নিচে "1 role has unsaved changes" →
   Save → "Permissions saved"।
3. **Team** → "Invite people" → আপনার একটা দ্বিতীয় ইমেইল, রোল Accountant → "Invitation sent to …"। উপরে "Open invitations"-এ
   "Sent"।
4. **`http://localhost:8025`** (Mailpit) → চিঠি: "Farhana Rahman invited you to …", বাটন "Join …"। বাটনের লিংক
   `http://localhost:5173/invite#…`।
5. লিংকটা **incognito**-তে খুলুন → "Join …", নাম আর পাসওয়ার্ড → ড্যাশবোর্ড, সেই workspace-এ। সাইডবারে শুধু Team আর Roles
   (Accountant যা পারে), Branches — Numbering বা Settings-এর বদলের বাটন নেই। একই লিংক আবার খুললে "This invitation link
   has expired"।
6. প্রথম ব্রাউজারে (owner) **Roles** → Accountant থেকে "See the team" তুলে Save → incognito-তে পেজ রিলোড ছাড়াই Team-এ
   যান → "Ask a workspace owner for the core.user.read permission…" — ১০ মিনিট অপেক্ষা ছাড়া।
7. **Team** → নতুন সদস্যের রো → "Remove from workspace" → "Remove …" (নাম সহ) → toast। incognito-তে যেকোনো কাজ → সাথে সাথে
   লগইন পেজ (401 `access_revoked` → refresh-ও ব্যর্থ)।
8. একই ইমেইলে আবার invite → এবার লিংক খুললে শুধু পাসওয়ার্ড চায় ("You already have an Omnivo account") → ঢুকলে Team-এ একই
   মানুষ, audit log-এ তার আগের ঘটনাও একই সদস্যপদে।
9. **Audit log** → "Show" → "Team" / "Roles" / "Invitations": "Invited someone", "Joined the workspace", "Changed a role's
   permissions" — পরিবর্তনে "See the team: Allowed → Not allowed"।
10. Mailpit বন্ধ করে (`docker compose -f infra/docker/docker-compose.yml stop mail`) invite → toast "The invitation is saved,
    but the email didn't go out…", তালিকায় "Email not sent"। Mailpit চালু করে রো → "Resend" → এবার চিঠি আসে।
11. DevTools-এর ৩৯০px → Roles-এর ছক নিজের বাক্সে আড়াআড়ি scroll, প্রথম কলাম জায়গায় থাকে, পেজ নড়ে না।
12. `http://localhost:3000/docs` → নতুন invitations আর roles; প্রতিটা পাহারা-দেওয়া operation-এ "Requires the `…`
    permission."
13. `pnpm test:e2e` → "30 passed"।

---

## যাচাইয়ের তালিকা

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # ৯৫টা: contracts ৩৩ + api ১৮ + ui ১৬ + i18n ১১ + app ১০ + auth ৭
pnpm test:integration        # ৭৮টা — নতুন ২৪টা
pnpm test:tenant-leak        # ১৮টা — নতুন ৪টা
pnpm test:e2e                # ৩০টা: ১৫টা flow × ডেস্কটপ আর ৩৯০px
pnpm build
pnpm test:bundle-size        # প্রথম লোড 169.2 KB gz; team 69.9, roles 48.8, invite 31.3
pnpm test:openapi
pnpm boundaries
```

## যাচাইয়ের পথে যা ধরা পড়েছিল

গাইডে সবগুলো ঠিক করা আছে — আপনার হাতে একই জায়গায় আটকে গেলে চিনতে পারবেন:

- **migration 0009-এ FK index-এর আগে** — তৃতীয়বার একই drizzle-kit সমস্যা; একটা লাইন হাতে সরানো (৭.২)।
- **`pnpm db:generate -- --name`** — মাঝের `--` drizzle-kit পর্যন্ত যায় না; `pnpm db:generate --name` (৭.২)।
- **FORCE RLS-এ backfill চুপচাপ ০ রো** — migrator মালিক হলেও; টেন্যান্টপ্রতি `set_config` loop (৭.২)।
- **partial unique index-এ `ON CONFLICT`** — `where` না দিলে Postgres index চেনে না (seed, ৭.২)।
- **`@types/nodemailer`** — nodemailer 10 নিজের টাইপ আনে; বাড়তি প্যাকেজ মোছা (৭.৩)।
- **owner-এর permission-তালিকা অসাজানো** — `[...PERMISSION_KEYS]` catalog-এর ক্রমে, custom রোল সাজানো; `/auth/me`-এর টেস্ট
  ভাঙল; দুই জায়গাতেই `.sort()` (৭.৩)।
- **cache-এর পুরনো টেস্ট কিছু প্রমাণ করছিল না** — owner-এর `role_permissions` মোছা এখন অর্থহীন; কাস্টম রোল দিয়ে নতুন (৭.৫)।
- **escalation টেস্ট কিছু প্রমাণ করছিল না** — যাকে Owner দেওয়া হচ্ছিল তার আগেই Owner ছিল; তৃতীয় একজন (৭.৫)।
- **race-এর পরে stale cache** — টেস্টের SQL cache মোছে না; পরের টেস্ট ভুল কারণে পাস করত (৭.৫)।
- **ফোনে পেজ ৩৯০ → ৬৬১px** — `sr-only` লেবেল absolute, scroll-বাক্সের বাইরে; `Checkbox`-এ `relative` (৭.৭), আর scroll-বাক্সে
  `min-w-0` (৭.৮)। ডেস্কটপে অদৃশ্য; ধরা পড়েছে Playwright-এর ফোন-project-এ ("overlay intercepts pointer events")।
- **virtualized তালিকায় e2e** — ফোনে নিচের কার্ড DOM-এ থাকে না; প্রথম দিকের সদস্য বাছা (৭.১০)।
- **mock-এ circular import** — `MockProblem` `mock.ts`-এ (৭.৯)।
- **টেস্টের মাঝে Docker বন্ধ** — Testcontainers "Could not find a working container runtime strategy"; কোডের দোষ না, Docker
  Desktop চালু করে আবার।

---

## পরের ধাপগুলোর জন্য রেখে যাওয়া নোট

**প্রতিটা নতুন endpoint-এ (এখন থেকে সবসময়):** permission চুক্তিতে (`permission: 'module.resource.action'`), decorator
না। নতুন permission = `PERMISSION_KEYS` + `PERMISSION_GROUP_OF` + db-র `DESCRIPTIONS` + `en.ts`/`bn.ts`-এর `permissions.*`
— চারটাই না লিখলে typecheck fail। owner আপনা-আপনি পায়; custom রোলকে matrix-এ টিক দিয়ে দিতে হয়।

**রোল বা সদস্যপদ ছোঁয়া প্রতিটা কোড:** `PermissionService.invalidate()` — transaction commit-এর **পরে**।

**ধাপ ৮ (worker, outbox):**

- invitation-এর ইমেইল outbox-এ: `create`/`resend`-এর transaction-এর ভেতরে outbox-এর রো (token সহ — **এনক্রিপ্ট করে**,
  কারণ outbox-এ token থাকা মানে DB dump-এ লিংক), worker পাঠায়, সফল হলে `sent_at`। `MailService` বদলায় না।
- মেয়াদ পেরোনো invitation-এর পরিষ্কার — দরকার নেই (partial index শুধু খোলাগুলো দেখে), তবে ৯০ দিনের পুরনো বন্ধগুলো
  archive করা যায়।
- onboarding wizard-এর "টিমকে ডাকুন" ধাপ এই ধাপের `POST /invitations`।
- provisioning job-এ owner রোল `kind: 'owner'` সহ — `ON CONFLICT (tenant_id) WHERE kind = 'owner' DO NOTHING` (seed-এর মতো)।

**ধাপ ১৩/১৫ (ব্রাঞ্চভিত্তিক অধিকার):** `membership_branches (tenant_id, membership_id, branch_id)` composite FK সহ;
`Access`-এ `branchIds: string[] | 'all'`; owner সবসময় `'all'`। invite-এর ফর্মে ব্রাঞ্চ বাছা।

**ধাপ ২৫ (লঞ্চের আগে):**

- আসল SMTP (SES/Mailgun) — SPF, DKIM, DMARC; `MAIL_FROM`-এর ডোমেইন যাচাই। নাহলে invite স্প্যামে যাবে।
- `/invitations/lookup` আর `/accept`-এ rate limit (IP-প্রতি) — token অনুমান করা যায় না, কিন্তু accept-এ পাসওয়ার্ড
  যাচাই হয় (existing account) — লগইনের একই brute-force সুরক্ষা লাগবে।
- invite থেকে খোলা অ্যাকাউন্টে `email_verified = true` — পাসওয়ার্ড রিসেট চালু হওয়ার আগে।

**সতর্কতা:** invitation-এর লিংক (বা token) কখনো লগে, audit-এ বা error-এর `detail`-এ না — লিংক মানে সেই workspace-এ ঢোকার
চাবি। আর `invitation_by_token` policy-তে কখনো `FOR ALL` লিখবেন না — token দিয়ে শুধু পড়া, লেখা সবসময় টেন্যান্টের context-এ।
