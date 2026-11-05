# ধাপ ৪: `packages/ui` — শেয়ার্ড ডিজাইন সিস্টেম + `packages/i18n`

> [build-plan.bn.md](build-plan.bn.md)-এর "ধাপ ৪" অংশের ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী
> লিখতে হবে, কোন কমান্ড কোথায় চালাতে হবে।
>
> এই গাইডের প্রতিটা ফাইল রিপোর একটা আলাদা কপিতে (ধাপ ৩-এর commit `160219c`-এর উপর) বসিয়ে যাচাই করা
> (২০২৬-০৯-২৮): `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`
> (৪১টা টেস্ট — নতুন ২৫টা সহ), `pnpm test:integration` (২০টা), `pnpm test:tenant-leak` (৯টা),
> `pnpm build`, `pnpm test:bundle-size` (প্রথম লোড 144.6 KB gz, বাজেট 200), `pnpm boundaries` — সব পাস।
> তারপর headless Chrome-এ আসল flow: লগইন পেজ → ফাঁকা ফর্মে error → sign-up (ঠিকানা অটো-বসানো, নিজে
> লিখলে আর বদলায় না) → একই ঠিকানায় দ্বিতীয় sign-up-এ সার্ভারের error ফিল্ডের নিচে → ড্যাশবোর্ডে টিমের
> DataTable → kitchen sink-এ ১০,০০০ রো (DOM-এ মাত্র ২২টা), sort, শেষ রো পর্যন্ত scroll, রো ক্লিকে toast →
> ফর্মে বাংলা অঙ্কে টাকা, ক্যালেন্ডার → বাংলায় বদল (reload-এর পরেও থাকে) → দুই workspace-এর মধ্যে
> মেনু দিয়ে switch → ৩৯০px ফোনে dark mode-এ কার্ড-ভিউ, আড়াআড়ি scroll নেই। নতুন boundary নিয়ম ইচ্ছা করে
> ভাঙা import দিয়েও যাচাই করা (৪.১১)।

## লক্ষ্য

🎨 **একটা `/kitchen-sink` রুটে সব শেয়ার্ড কম্পোনেন্ট, ডেস্কটপ আর মোবাইল দুই সাইজে, দুই থিমে, দুই ভাষায়।**
পেছনে যা তৈরি হবে:

- `packages/ui` — ধাপ ৩-এর `styles.css` আর component এখানে সরে আসবে, সাথে নতুন: `AppShell`,
  **`DataTable`** (TanStack Table + Virtual, ফোনে নিজে থেকে কার্ড), **`FormField`** (react-hook-form + Zod),
  `MoneyInput` (decimal.js), `DatePicker`, `PageHeader`, `EmptyState`, `Checkbox`, `DropdownMenu`, `Toast`।
- `packages/i18n` — i18next দিয়ে ইংরেজি/বাংলা, টাইপ-চেকড key, আর ভাষা-অনুযায়ী টাকা/সংখ্যা/তারিখ
  (`৳18,42,600` / `৳১৮,৪২,৬০০`)।
- অ্যাপের shell, ড্যাশবোর্ড, লগইন আর সাইনআপ নতুন কম্পোনেন্টে; সাইডবারে ভাষা বদলানোর মেনু।
- CI-র bundle-size gate, যেটা ধাপ ০ থেকে `echo 'skipped'` হয়ে ছিল, এবার আসল।

## পুরো ছবিটা এক নজরে

```
packages/i18n  (i18next, en/bn, format)          ← সবচেয়ে নিচে; React ছাড়া কিছু চেনে না
      ▲
packages/ui    (token CSS, component, DataTable)  ← i18n থেকে t() আর formatter নেয়; রাউটার/API চেনে না
      ▲
apps/app       (router, session, পেজ)             ← দুটোই ব্যবহার করে; Tailwind-এর entry এখানে

apps/app/src/styles.css
  @import 'tailwindcss';                ← Tailwind এখানে compile হয়
  @import '@omnivo/ui/styles.css';      ← token, font, base style, আর `@source './'` (ui-র class স্ক্যান)

রুট-ভিত্তিক chunk (production build):
  index (প্রথম লোড) ─ react, router, session, i18n, zod ........ 144.6 KB gz  (বাজেট 200)
  login ────────────── ফর্ম, Checkbox, react-hook-form .......... +35.7 KB
  app-shell ────────── সাইডবার, Radix মেনু ...................... +41.2 KB
  dashboard ────────── DataTable, TanStack Table + Virtual ...... +29.1 KB   (প্রতিটার বাজেট 100)
  kitchen-sink ─────── শুধু `pnpm dev`-এ, production-এ chunk-ই নেই
```

## এই ধাপের ভিত্তি-সিদ্ধান্ত

1. **CLAUDE.md-ই উৎস, build-plan-এর দুটো লাইন বদলাচ্ছে।** build-plan লেখা হয়েছিল ডিজাইন সিস্টেম অনুমোদনের
   (২০২৬-০৯-২৪) আগে। দুই জায়গায় CLAUDE.md অন্য কথা বলে, আর CLAUDE.md-ই জেতে:
   - **বাংলা ফন্ট `Noto Sans Bengali`, Hind Siliguri না।** "subset করা" অংশটা আলাদা কাজ না — fontsource-এর CSS
     প্রতিটা `@font-face`-এ `unicode-range` দেয় (bengali / latin / latin-ext আলাদা ফাইল), তাই ব্রাউজার শুধু সেই
     ফাইল নামায় যার অক্ষর পেজে আছে। ইংরেজি-শুধু পেজে বাংলা ফন্ট ডাউনলোডই হয় না।
   - **ফোনে "বটম ট্যাব" না, টপ বার + আড়াআড়ি nav।** CLAUDE.md → Layout: "Below 860px the sidebar collapses to
     a top bar with horizontal nav"।
2. **shadcn/ui-র CLI না, তার পদ্ধতি।** shadcn মানে "কোড নিজের রিপোতে" — Radix primitive + Tailwind class।
   CLI চালালে প্রতিবার `lucide-react` আর নিজস্ব রং ঢুকত, যা CLAUDE.md rule ৪ আর token-নিয়ম দুটোই ভাঙে।
   তাই component গুলো একই Radix primitive (`radix-ui` প্যাকেজ) দিয়ে হাতে লেখা, শুরু থেকেই আমাদের token আর
   HugeIcons-এ। তবু CLAUDE.md-এর কথামতো shadcn-এর নিজের variable (`--primary`, `--border` …) আমাদের token-এ
   পয়েন্ট করা আছে — ভবিষ্যতে shadcn থেকে কোনো component কপি করলে কোনো বদল ছাড়াই রং মিলবে।
3. **`packages/ui` বাকি প্যাকেজের মতোই `tsc` দিয়ে `dist`-এ build হয়।** ধাপ ৩-এর `contracts`/`auth`-এর মতো একই
   ছাঁচ: `exports` → `dist`, turbo-র `^build`, `pnpm dev`-এ `tsc --watch`। শুধু CSS ব্যতিক্রম — `./styles.css`
   সরাসরি `src` থেকে export, কারণ সেটা compile করে app-এর Tailwind।
4. **Tailwind-এর entry app-এ, token ui-তে।** ui-র CSS-এ `@import 'tailwindcss'` নেই; app লেখে
   `@import 'tailwindcss'; @import '@omnivo/ui/styles.css';`। ফলে Tailwind একবারই compile হয় (দুবার হলে
   preflight আর utility দুবার আসত), আর ধাপ ২২-২৩-এর `apps/web`/`apps/admin` একই দুই লাইন লিখে একই চেহারা পাবে।
5. **ui রাউটার আর API চেনে না।** `AppShell` লিংক, ইউজার, টেন্যান্ট সব slot-এ নেয়; `NavItem` একটা সাধারণ `<a>`,
   app সেটাকে TanStack Router-এর `createLink` দিয়ে টাইপ-চেকড লিংক বানায়। এতে ui অন্য অ্যাপে (admin) বা অন্য
   রাউটারেও চলে, আর `pnpm boundaries` নিয়ম দিয়ে এটা পাহারা দেওয়া হয় (৪.১১)।
6. **i18n-এর একটাই namespace, মালিক `packages/i18n`।** অ্যাপ আর ui দুজনের লেখাই এক জায়গায় (`en.ts`/`bn.ts`)।
   key টাইপ-চেকড: `t('nav.overveiw')` compile error। বাংলা ফাইল `Messages` টাইপ মানতে বাধ্য — ইংরেজিতে key
   যোগ করে বাংলায় ভুলে গেলে `pnpm typecheck` fail।
7. **লগইন/সাইনআপের লেখা এখনো ইংরেজি।** তাদের error মেসেজ আসে `packages/contracts`-এর Zod schema থেকে, যা
   সার্ভার আর ক্লায়েন্ট দুজনেই ব্যবহার করে। এগুলো অনুবাদ করতে error-কে মেসেজ না, **code** হিসেবে পাঠাতে
   হবে (`{ code: 'slug_taken' }` → ক্লায়েন্ট অনুবাদ করে) — সেটা ধাপ ৫-এর "error envelope ফরম্যাট"-এর কাজ।
   এই ধাপে অনুবাদ হচ্ছে shell, ড্যাশবোর্ড আর ui-র নিজের লেখা।
8. **টাকা কখনো `number` না।** ফর্মে, API-তে, DB-তে (`NUMERIC(19,4)`) টাকা `string`। দেখানো হয় `Intl.NumberFormat`
   দিয়ে — যেটা string পেলে number-এ না বদলে পুরো নির্ভুলতায় format করে। গোল করা (`1.005` → `1.01`) হয়
   decimal.js দিয়ে, কারণ JS-এ `(1.005).toFixed(2) === "1.00"`।
9. **প্রতিটা পেজ আলাদা chunk, আর বাজেট CI-তে।** system-design §৬.১-এর নিয়ম: প্রথম লোড < 200 KB gz, প্রতিটা
   lazy chunk < 100 KB gz। মাপা হয় Vite-এর `manifest.json` পড়ে নিজেদের ছোট স্ক্রিপ্টে (৪.১০) —
   `size-limit` না, কারণ "প্রথম লোড" মানে entry আর তার সব static import; hash-ওয়ালা ফাইলের glob দিয়ে সেটা
   ঠিকভাবে ধরা যায় না, manifest-এ import-গাছটাই লেখা থাকে।
10. **TanStack Table v9।** npm-এ এখন `latest` = 9.x, যার API v8-এর চেয়ে আলাদা (`useReactTable` → `useTable`,
    feature স্পষ্ট করে নিবন্ধন, `columnMeta` টাইপ feature slot-এ)। ইন্টারনেটের বেশিরভাগ উদাহরণ এখনো v8-এর —
    সেগুলো হুবহু কপি করবেন না। প্যাকেজের ভেতরেই `node_modules/@tanstack/react-table/skills/*/SKILL.md`-এ v9-এর
    নির্দেশিকা আছে।

## এই ধাপে যা ইচ্ছাকৃতভাবে নেই

| জিনিস | কেন এখন না / কখন আসবে |
|---|---|
| লগইন/সাইনআপ বাংলায় | error মেসেজ contracts-এর Zod থেকে আসে — code-ভিত্তিক error envelope ধাপ ৫-এ (উপরে ৭ নম্বর) |
| `pnpm test:e2e` (Playwright) | build-plan §৭-এ আছে, কিন্তু CI-তে ব্রাউজার নামানো আর চালানোর খরচ আলাদা সিদ্ধান্ত; এই ধাপের browser flow হাতে-কলমে যাচাই করা (উপরে)। প্রথম আসল ফিচার-ফর্মের সাথে (ধাপ ৬) আনা ভালো |
| DataTable-এ pagination, filter, column বাছাই | ধাপ ৫-এ keyset pagination কনভেনশন ঠিক হবে; তখন server-side sort/filter একসাথে। এখন client-side sort আর virtualization |
| Dialog, Select, Tooltip, Tabs | যে ধাপে প্রথম লাগবে তখন (invite মডাল = ধাপ ৭)। প্রতিটা একই ছাঁচে: Radix + token |
| থিম বেছে রাখা (সেটিংসে) | kitchen sink-এ শুধু দেখার জন্য বদলানো যায়; ইউজারের পছন্দ সেভ হবে ধাপ ৬-এর settings-এ |
| চার্ট | ধাপ ২১ (Reports); CLAUDE.md → Charts-এর নিয়ম তখন |
| Storybook | `/kitchen-sink` রুটই সেই কাজ করে — আলাদা টুল, আলাদা build, আলাদা config ছাড়াই |
| MSW mock | ধাপ ৫ (contracts + codegen-এর সাথে) |

## আগের কোড থেকে যা বাদ বা বদল হচ্ছে

- `apps/app/src/components/button.tsx`, `text-field.tsx`, `form-alert.tsx`, `logo.tsx`, `pill.tsx` —
  **মুছে ফেলুন**, `packages/ui`-তে সরছে। `auth-preview.tsx` থাকছে (CLAUDE.md-এ এই ফাইলের পাথ ধরে ব্যতিক্রম
  লেখা আছে, আর এটা শুধু লগইন পেজের ছবি)।
- `apps/app/src/lib/cx.ts` — **মুছে ফেলুন**। জায়গা নেয় ui-র `cn()` (tailwind-merge — কেন লাগল ৪.২-এ)।
- `apps/app/src/lib/format.ts` — **মুছে ফেলুন**। `formatDate` এখন `packages/i18n`-এ, ভাষা-অনুযায়ী।
- `apps/app/src/lib/field-errors.ts` — `validate()` আর `fromApiError()`-এর বদলে একটা `applyApiError()`:
  ফর্ম যাচাই এখন react-hook-form + `zodResolver` করে।
- `apps/app/src/styles.css` — token/font/base সব ui-তে; এখানে থাকে শুধু Tailwind-এর entry আর লগইন পেজের
  `auth-grid`।
- `apps/app` থেকে তিনটা `@fontsource*` dependency বাদ (এখন ui-র)।
- লগইন আর সাইনআপের ফর্ম: হাতে লেখা `useState` + `validate()` → react-hook-form। "Keep me signed in"-এর native
  checkbox → ui-র `Checkbox` (CLAUDE.md-এর ১৭px/৫px/brand ভরাট native checkbox-এ সব ব্রাউজারে হয় না)।
- সাইডবারের tenant switcher: native `<select>` → Radix `DropdownMenu` (ধাপ ৩-এর নোটে এটাই বলা ছিল)। sign-out
  এখন user মেনুর ভেতরে, সাথে ভাষা বদলানো।
- ড্যাশবোর্ডের টিম-তালিকা: হাতে লেখা `<ul>` → `DataTable` (প্রথম আসল ব্যবহার)।
- `router.tsx`: সব পেজ `lazyRouteComponent` দিয়ে — প্রতিটা আলাদা chunk।
- `packages/config/eslint`-এর `globals: { ...globals.node, ...globals.browser }` — ধাপ ০-এর মন্তব্য বলেছিল
  "Split … in step 4"; এখন শুধু JS config ফাইলে Node globals (কেন, ৪.১১-এ)।

---

## ৪.১ — `packages/i18n`: দুই ভাষা আর ভাষা-অনুযায়ী ফরম্যাট

ui-র আগে এটা, কারণ ui এর উপর নির্ভর করে (`Field`-এর "(optional)", `DataTable`-এর sort লেবেল, `DatePicker`-এর
তারিখ — সবই ভাষা বদলালে বদলায়)।

**ফাইল: `packages/i18n/package.json`** (নতুন ফাইল — dependency ছাড়া লিখুন, নিচের কমান্ড যোগ করবে)

```json
{
  "name": "@omnivo/i18n",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  }
}
```

- `contracts`-এর হুবহু ছাঁচ — `dist`-এ build, turbo-র `^build` দিয়ে আগে তৈরি হয়।
- **`"sideEffects"` নেই, ইচ্ছা করে।** এই প্যাকেজ import করলেই i18next init হয় (`i18n.ts`) — এটা আসল side
  effect। `"sideEffects": false` লিখলে bundler ভাবতে পারত "কিছু ব্যবহার হয়নি, বাদ দিই", আর
  `main.tsx`-এর `import '@omnivo/i18n'` মুছে যেত — প্রথম render-এ অনুবাদের বদলে key দেখা যেত।

```bash
pnpm --filter @omnivo/i18n add 'i18next@^26.4.2' 'react-i18next@^17.0.15'
pnpm --filter @omnivo/i18n add -D '@omnivo/config@workspace:*' '@types/react@^19.3.0' 'typescript@^6.0.3' 'vitest@^5.0.1'
pnpm --filter @omnivo/i18n add --save-peer 'react@^19.3.0'
```

- `--save-peer`: React যোগ হয় `peerDependencies` **আর** `devDependencies` দুটোতেই। peer মানে "যে অ্যাপ আমাকে
  ব্যবহার করবে, React সে দেবে" — নাহলে প্যাকেজ নিজের আলাদা React কপি আনতে পারত, আর দুই কপির React-এ hook
  কাজ করে না ("Invalid hook call")। dev-এ থাকে যাতে এই প্যাকেজের নিজের typecheck/test চলে।

**ফাইল: `packages/i18n/tsconfig.json`** (নতুন ফাইল)

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "lib": ["ES2023", "DOM"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- `lib: ["ES2023", "DOM"]` — `localStorage` আর `document` লাগে। `types` খালি রাখা হয়নি কারণ এই প্যাকেজে
  `@types/node` নেই-ই, তাই ভুল করে `process` লেখার সুযোগ নেই।

**ফাইল: `packages/i18n/tsconfig.build.json`** (নতুন ফাইল — `contracts`-এরটার হুবহু কপি)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationMap": true
  },
  "exclude": ["src/**/*.spec.ts"]
}
```

**ফাইল: `packages/i18n/src/locales/en.ts`** (নতুন ফাইল)

```ts
// ইংরেজি = উৎস ভাষা। Messages টাইপ এখান থেকে আসে, তাই নতুন key প্রথমে এখানে যোগ হবে
export const en = {
  common: {
    signOut: 'Sign out',
    language: 'Language',
    optional: '(optional)',
    retry: 'Retry',
  },
  shell: {
    mainNav: 'Main',
    workspaces: 'Workspaces',
    switchWorkspace: 'Switch workspace',
    switchFailed: "Couldn't switch workspace. Try again.",
    switched: 'Switched to {{name}}',
    account: 'Account',
  },
  nav: {
    overview: 'Overview',
    kitchenSink: 'Kitchen sink',
  },
  dashboard: {
    title: 'Overview',
    readyTitle: 'Your workspace is ready',
    readyBody:
      'Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock will show up here once you start recording them.',
    teamTitle: 'Team',
    teamSubtitle: 'People with access to this workspace',
    teamLoadFailed: "Couldn't load your team. Refresh the page to try again.",
    noRole: 'No role',
    columns: {
      member: 'Member',
      roles: 'Roles',
    },
    teamPermissionHint: 'Ask a workspace owner for the core.user.read permission to see your team.',
  },
  ui: {
    dataTable: {
      sortBy: 'Sort by {{column}}',
      // count বাছে এক/বহুবচন; formatted = ভাষা-অনুযায়ী গোছানো সংখ্যা (10,000 / ১০,০০০)
      rowCount_one: '{{formatted}} row',
      rowCount_other: '{{formatted}} rows',
    },
    datePicker: {
      placeholder: 'Pick a date',
    },
  },
};
```

**কোন লাইন কেন:**

- ইংরেজি "উৎস ভাষা": অনুবাদের আকার (`Messages` টাইপ) এখান থেকেই আসে। নতুন লেখা সবসময় আগে এখানে।
- key গুলো জায়গা অনুযায়ী ভাগ (`shell`, `nav`, `dashboard`, `ui`) — `ui.*` হলো `packages/ui`-র নিজের লেখা, তাই
  কোন লেখা কোন প্যাকেজের সেটা নাম দেখেই বোঝা যায়।
- `rowCount_one` / `rowCount_other` — i18next-এর plural নিয়ম: `t('ui.dataTable.rowCount', { count })` ডাকলে
  `Intl.PluralRules` দেখে `_one` বা `_other` বাছে। বাংলাতেও দুটো শ্রেণি আছে (`Intl.PluralRules('bn')` →
  `one`, `other`), তাই বাংলা ফাইলেও দুটো key।
- `{{formatted}}`, `{{count}}` না — i18next `{{count}}`-এ কাঁচা সংখ্যা বসায় (`10000`), গ্রুপিং বা বাংলা অঙ্ক ছাড়া।
  তাই `count` শুধু এক/বহুবচন বাছার জন্য, আর দেখানোর সংখ্যা আলাদা করে গুছিয়ে পাঠানো হয় (`10,000` / `১০,০০০`)।
- `as const` **নেই**, ইচ্ছা করে। যাচাই করে দেখা হয়েছে: i18next v26 literal টাইপ পেলেও interpolation-এর প্যারামিটার
  (`{{column}}` না দিলে error) চেক করে না, কিন্তু literal টাইপ বাংলা ফাইলের জন্য ঝামেলা বাড়াত (সেখানে মান
  `'Sign out'` না)। key-এর চেক এমনিতেই হয়।

**ফাইল: `packages/i18n/src/locales/messages.ts`** (নতুন ফাইল)

```ts
import type { en } from './en.js';

// অনুবাদের আকার ইংরেজি থেকে আসে — অন্য ভাষার ফাইল এই টাইপ মানতে বাধ্য
export type Messages = typeof en;
```

- আলাদা ফাইল কেন: `bn.ts` টাইপটা চায়, `en.ts` থেকে সরাসরি নিলেও চলত। কিন্তু `import type` থাকায় কোনো runtime
  নির্ভরতা নেই, আর ভবিষ্যতে "ইংরেজি থেকে টাইপ" নিয়ম বদলালে (যেমন আলাদা schema) শুধু এই এক লাইন বদলাবে।

**ফাইল: `packages/i18n/src/locales/bn.ts`** (নতুন ফাইল)

```ts
import type { Messages } from './messages.js';

// Messages টাইপ: en-এর কোনো key বাদ পড়লে বা বাড়তি key থাকলে compile error
export const bn: Messages = {
  common: {
    signOut: 'সাইন আউট',
    language: 'ভাষা',
    optional: '(ঐচ্ছিক)',
    retry: 'আবার চেষ্টা করুন',
  },
  shell: {
    mainNav: 'প্রধান',
    workspaces: 'ওয়ার্কস্পেস',
    switchWorkspace: 'ওয়ার্কস্পেস বদলান',
    switchFailed: 'ওয়ার্কস্পেস বদলানো যায়নি। আবার চেষ্টা করুন।',
    switched: '{{name}}-এ চলে এসেছেন',
    account: 'অ্যাকাউন্ট',
  },
  nav: {
    overview: 'সারসংক্ষেপ',
    kitchenSink: 'কিচেন সিঙ্ক',
  },
  dashboard: {
    title: 'সারসংক্ষেপ',
    readyTitle: 'আপনার ওয়ার্কস্পেস তৈরি',
    readyBody:
      'এবার চার্ট অব অ্যাকাউন্টস সাজান আর আপনার হিসাবরক্ষককে আমন্ত্রণ জানান। বায়ার PO, LC আর স্টক রেকর্ড শুরু করলে এখানে দেখা যাবে।',
    teamTitle: 'টিম',
    teamSubtitle: 'এই ওয়ার্কস্পেসে যাঁদের অ্যাক্সেস আছে',
    teamLoadFailed: 'টিমের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
    noRole: 'কোনো রোল নেই',
    columns: {
      member: 'সদস্য',
      roles: 'রোল',
    },
    teamPermissionHint: 'টিম দেখতে ওয়ার্কস্পেস মালিকের কাছে core.user.read অনুমতি চান।',
  },
  ui: {
    dataTable: {
      sortBy: '{{column}} অনুযায়ী সাজান',
      rowCount_one: '{{formatted}}টি সারি',
      rowCount_other: '{{formatted}}টি সারি',
    },
    datePicker: {
      placeholder: 'তারিখ বাছুন',
    },
  },
};
```

**কোন লাইন কেন:**

- `export const bn: Messages` — টাইপ annotation দুই দিকেই পাহারা দেয়: key বাদ পড়লে "Property 'switched' is
  missing", বাড়তি বা বানান-ভুল key থাকলে object literal-এর excess property error। দুটোই যাচাই করা।
- `সারসংক্ষেপ` = Overview; `ওয়ার্কস্পেস`, `রোল`, `LC`, `PO` ইংরেজি শব্দই রাখা — বাংলাদেশের অফিসে এগুলো ইংরেজিতেই
  বলা হয়, জোর করে অনুবাদ ("ঋণপত্র") করলে ব্যবহারকারী চিনত না।
- `'{{name}}-এ চলে এসেছেন'` — বাংলায় শব্দক্রম আলাদা, তাই interpolation-এর জায়গাও আলাদা। এজন্যই বাক্য জোড়া না
  লাগিয়ে পুরো বাক্য অনুবাদ করা হয়।

**ফাইল: `packages/i18n/src/i18n.ts`** (নতুন ফাইল)

```ts
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { bn } from './locales/bn.js';
import { en } from './locales/en.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'bn', label: 'বাংলা' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'omnivo.language';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

// localStorage প্রাইভেট মোডে throw করতে পারে, আর Node-এ (টেস্ট) নেই — দুই ক্ষেত্রেই ইংরেজি
function storedLanguage(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : 'en';
  } catch {
    return 'en';
  }
}

// global singleton-এর বদলে নিজস্ব instance: অন্য কোনো লাইব্রেরি i18next-এর default instance
// init করলেও আমাদের অনুবাদে হাত পড়বে না
export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, bn: { translation: bn } },
  lng: storedLanguage(),
  fallbackLng: 'en',
  supportedLngs: LANGUAGES.map((language) => language.code),
  // resource bundle-এর ভেতরেই আছে, তাই init sync — প্রথম render-এই অনুবাদ তৈরি
  initAsync: false,
  // React নিজেই escape করে; i18next আবার করলে "&amp;" দেখা যেত
  interpolation: { escapeValue: false },
});

// স্ক্রিন রিডার আর ব্রাউজারের hyphenation/ফন্ট নির্বাচন <html lang> দেখে
function syncDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export async function setLanguage(language: Language): Promise<void> {
  await i18n.changeLanguage(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // সেভ না হলে শুধু এই সেশনে ভাষা বদলাবে — ক্ষতি নেই
  }
}
```

**কোন লাইন কেন:**

- `LANGUAGES ... as const` → `Language = 'en' | 'bn'`। নতুন ভাষা মানে এখানে এক লাইন + একটা locale ফাইল; টাইপ
  নিজে বাড়ে।
- `isLanguage(value: unknown): value is Language` — type guard। Radix মেনু, `localStorage`, `i18n.resolvedLanguage`
  সবাই `string` দেয়; cast (`as Language`) না করে এই guard দিয়ে নামানো হয় (rule ৩)।
- `storedLanguage()`-এ `try/catch` — Safari-র প্রাইভেট মোডে বা সাইট-ডেটা ব্লক থাকলে `localStorage` ছুঁলেই
  throw করে; আর vitest (Node)-এ `localStorage` নেই-ই (`ReferenceError`)। দুই ক্ষেত্রেই চুপচাপ ইংরেজি।
- `i18next.createInstance()` — i18next-এর default export একটা global singleton। ভবিষ্যতে কোনো লাইব্রেরি নিজে
  default instance init করলে আমাদের resource মুছে যেতে পারত। নিজস্ব instance-এ সেই ঝুঁকি নেই।
  `.use(initReactI18next)` এই instance-কেই react-i18next-এর `useTranslation()`-এর জন্য নিবন্ধন করে, তাই কোনো
  `<I18nextProvider>` লাগে না।
- `initAsync: false` — resource bundle-এর ভেতরেই (network থেকে আনা হয় না), তাই init তাৎক্ষণিক শেষ হতে পারে।
  ডিফল্ট `true` হলে init একটা `setTimeout`-এ যেত, আর প্রথম render-এ `t()` key ফেরত দিত।
- `escapeValue: false` — React নিজেই সব লেখা escape করে; i18next-ও করলে `Harbor & Pine` দেখাত `Harbor &amp; Pine`।
- `supportedLngs` — `storedLanguage()` আগেই ছেঁকে নেয়, তবু i18next নিজেও জানুক কোন ভাষা বৈধ: কোথাও
  `changeLanguage('en-US')` ডাকা হলে সেটা `en`-এ নামে, অচেনা কিছু হলে `fallbackLng`।
- `syncDocumentLanguage` — `<html lang="bn">` স্ক্রিন রিডারকে বাংলা উচ্চারণে পড়ায়, আর ব্রাউজার ফন্ট-বাছাইয়ে
  `lang` দেখে। শুরুতে একবার আর প্রতিটা `languageChanged`-এ।
- `setLanguage()`-এ আগে `changeLanguage`, পরে সেভ — সেভ ব্যর্থ হলেও (প্রাইভেট মোড) ভাষা এই সেশনে বদলায়।

**ফাইল: `packages/i18n/src/format.ts`** (নতুন ফাইল — `apps/app/src/lib/format.ts`-এর জায়গায়)

```ts
import type { Language } from './i18n.js';

// en-IN = লাখ/কোটি গ্রুপিং (18,42,600); bn-BD = একই গ্রুপিং, বাংলা অঙ্কে (১৮,৪২,৬০০)
const NUMBER_LOCALE = { en: 'en-IN', bn: 'bn-BD' } satisfies Record<Language, string>;

const DECIMAL = /^-?\d+(\.\d+)?$/;

// Intl string পেলে পুরো নির্ভুলতায় format করে (number-এ রূপান্তর করে না), কিন্তু টাইপ চায়
// `${number}` — সাধারণ string না। DB-র NUMERIC মান string হয়ে আসে, তাই এই guard
export function isDecimalString(value: string): value is `${number}` {
  return DECIMAL.test(value);
}

type Numeric = number | string;

const numberFormats = new Map<string, Intl.NumberFormat>();

// Intl.NumberFormat তৈরি ব্যয়বহুল; ১০,০০০ রো-র টেবিলে প্রতি cell-এ নতুন বানানো উচিত না
function numberFormat(language: Language, decimals: number): Intl.NumberFormat {
  const key = `${language}:${String(decimals)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(NUMBER_LOCALE[language], {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      // 'negative': -0.4 শূন্যে গোল হলে "-0" না দেখিয়ে "0"
      signDisplay: 'negative',
    });
    numberFormats.set(key, format);
  }
  return format;
}

export interface MoneyFormatOptions {
  // CLAUDE.md: দশমিক শুধু unit price-এ; বাকি সব টাকার অঙ্ক পূর্ণ সংখ্যায়
  decimals?: number;
}

export function formatNumber(value: Numeric, language: Language, decimals = 0): string {
  if (typeof value === 'string' && !isDecimalString(value)) return value;
  return numberFormat(language, decimals).format(value);
}

// ৳ সবসময় সংখ্যার আগে, মাইনাস তারও আগে: -৳1,200। bn-BD-র currency style ৳ পরে বসায়
// (১,২০০৳), তাই currency style না নিয়ে নিজেরা জোড়া
export function formatMoney(
  value: Numeric,
  language: Language,
  { decimals = 0 }: MoneyFormatOptions = {},
): string {
  if (typeof value === 'string' && !isDecimalString(value)) return value;
  const parts = numberFormat(language, decimals).formatToParts(value);
  const sign = parts.find((part) => part.type === 'minusSign')?.value ?? '';
  const digits = parts
    .filter((part) => part.type !== 'minusSign')
    .map((part) => part.value)
    .join('');
  return `${sign}৳${digits}`;
}

// en-GB নতুন ICU-তে "Sept" লেখে, তাই en-US-এর অংশ নিয়ে নিজেরা সাজানো: "23 Sep 2026"
const EN_DATE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const BN_DATE = new Intl.DateTimeFormat('bn-BD', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatDate(date: Date, language: Language): string {
  if (language === 'bn') return BN_DATE.format(date);
  const parts = EN_DATE.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

// পিরিয়ড (মাস): "September 2026" / "সেপ্টেম্বর ২০২৬"
const MONTH = {
  en: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }),
  bn: new Intl.DateTimeFormat('bn-BD', { month: 'long', year: 'numeric' }),
} satisfies Record<Language, Intl.DateTimeFormat>;

export function formatMonth(date: Date, language: Language): string {
  return MONTH[language].format(date);
}
```

**কোন লাইন কেন:**

- `NUMBER_LOCALE = { en: 'en-IN', bn: 'bn-BD' }` — দুটোই লাখ/কোটি গ্রুপিং দেয় (`18,42,600`); `en-US` দিলে
  `1,842,600` হতো, যা CLAUDE.md → Money-র নিয়ম ভাঙে। `bn-BD` অঙ্কও বাংলায় দেয়। `satisfies Record<Language, …>`:
  নতুন ভাষা যোগ করে এখানে ভুলে গেলে compile error।
- `isDecimalString(value): value is \`${number}\`` — `Intl.NumberFormat.format()` string নিতে পারে (তখন number-এ
  না বদলে পুরো নির্ভুলতায় format করে), কিন্তু TypeScript-এর টাইপে সেটা `` `${number}` ``, সাধারণ `string` না।
  API থেকে NUMERIC আসে `string` হয়ে, তাই regex দিয়ে যাচাই করে টাইপ নামানো — cast ছাড়া।
- `numberFormats` cache — `new Intl.NumberFormat()` তুলনামূলক ব্যয়বহুল (locale data লোড করে)। ১০,০০০ রো-র টেবিলে
  scroll-এর সময় প্রতিটা দৃশ্যমান cell নতুন করে বানালে scroll আটকাত। key = ভাষা + দশমিক ঘর।
- `signDisplay: 'negative'` — ডিফল্ট (`auto`) দিলে `-0.4` গোল হয়ে `-0` দেখাত; `'negative'` শূন্যে চিহ্ন বসায় না।
- `formatMoney` নিজে `৳` বসায়, `style: 'currency'` না: `bn-BD`-র currency style ৳ বসায় সংখ্যার **পরে**
  (`১৮,৪২,৬০০.০০৳`), আর `en-IN` লেখে `BDT 18,42,600.00` — দুটোই CLAUDE.md-এর `৳18,42,600` না। তাই
  `formatToParts` থেকে মাইনাস আলাদা করে `-৳1,200` সাজানো।
- `decimals = 0` ডিফল্ট — CLAUDE.md → Money: "No decimals unless the value is a unit price"।
- অবৈধ string হলে (`'abc'`) সেটাই ফেরত — `NaN` দেখানো বা throw করে পুরো পেজ ভাঙার চেয়ে ভুল মানটা চোখে পড়া ভালো।
- `formatDate`-এর ইংরেজি অংশ ধাপ ৩-এর `format.ts` থেকে হুবহু (`en-GB` নতুন ICU-তে "Sept" লেখে — যাচাই করা)।
  বাংলায় `bn-BD` যা দেয় তাই (`২৩ সেপ, ২০২৬`)।
- `formatMonth` — CLAUDE.md → Dates: পিরিয়ড লেখা হয় "September 2026"।

**ফাইল: `packages/i18n/src/use-locale.ts`** (নতুন ফাইল)

```ts
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatDate,
  formatMoney,
  formatMonth,
  formatNumber,
  type MoneyFormatOptions,
} from './format.js';
import { isLanguage, type Language } from './i18n.js';

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

  return { t, language, format };
}
```

- একটা hook-এ তিনটা জিনিস (`t`, `language`, `format`) — component-কে আলাদা করে ভাষা পড়ে formatter-এ পাঠাতে হয় না।
- `useTranslation()` ভাষা বদলের event-এ subscribe করে; তাই এই hook ব্যবহারকারী প্রতিটা component ভাষা বদলালে
  নিজে থেকেই আবার render হয় — কোনো global store লাগে না।
- `useMemo(..., [language])` — `format` object-টা ভাষা না বদলালে একই থাকে। DataTable-এর column (`useMemo`-র
  dependency হিসেবে `format`) তাই প্রতি render-এ নতুন হয় না; নতুন হলে টেবিল প্রতিবার আবার sort হতো।

**ফাইল: `packages/i18n/src/types.ts`** (নতুন ফাইল)

```ts
import type { en } from './locales/en.js';

// t('nav.overview')-এর key এখন টাইপ-চেকড: ভুল key compile error, আর IDE-তে autocomplete।
// .d.ts না, .ts: tsc src-এর .d.ts ফাইল dist-এ কপি করে না, তখন ui/app এই augmentation দেখত না
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
```

- `declare module 'i18next'` — i18next-এর `CustomTypeOptions` interface-এ আমাদের resource-এর টাইপ জুড়ে দেওয়া
  (declaration merging)। এর পর থেকে `t('...')`-এর key টাইপ-চেকড, IDE-তে autocomplete — **ui আর app-এও**।
- **`.ts`, `.d.ts` না** — এটা কঠিন ভুল: `tsc` `src/`-এর হাতে লেখা `.d.ts` ফাইল `dist`-এ কপি করে না। তখন এই
  প্যাকেজের ভেতরে চেক কাজ করত, কিন্তু ui/app (যারা `dist` পড়ে) কখনো augmentation দেখত না, আর `t()` যেকোনো
  string নিত। `.ts` হলে `dist/types.d.ts` তৈরি হয়, আর `index.ts`-এর `import './types.js'` সেটা টেনে আনে।

**ফাইল: `packages/i18n/src/index.ts`** (নতুন ফাইল)

```ts
import './types.js';

export { i18n, isLanguage, LANGUAGES, setLanguage, type Language } from './i18n.js';
export {
  formatDate,
  formatMoney,
  formatMonth,
  formatNumber,
  isDecimalString,
  type MoneyFormatOptions,
} from './format.js';
export { useLocale } from './use-locale.js';
export type { Messages } from './locales/messages.js';
```

- `import './types.js'` প্রথম লাইনে — উপরের augmentation যেন `dist/index.d.ts` থেকে পৌঁছায়।

**ফাইল: `packages/i18n/src/format.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { formatDate, formatMoney, formatMonth, formatNumber } from './format.js';

describe('formatMoney', () => {
  it('uses lakh/crore grouping with a leading taka sign', () => {
    expect(formatMoney(1842600, 'en')).toBe('৳18,42,600');
  });

  it('writes Bangla digits but keeps the taka sign in front', () => {
    expect(formatMoney(1842600, 'bn')).toBe('৳১৮,৪২,৬০০');
  });

  it('puts the minus before the taka sign and never shows -0', () => {
    expect(formatMoney(-1200, 'en')).toBe('-৳1,200');
    expect(formatMoney(-0.4, 'en')).toBe('৳0');
  });

  it('formats NUMERIC strings exactly, without going through a float', () => {
    // number হিসেবে 9007199254740993 হয়ে যেত 9007199254740992
    expect(formatMoney('9007199254740993.25', 'en', { decimals: 2 })).toBe(
      '৳9,00,71,99,25,47,40,993.25',
    );
  });

  it('returns a non-numeric string unchanged instead of printing NaN', () => {
    expect(formatMoney('abc', 'en')).toBe('abc');
  });
});

describe('formatNumber', () => {
  it('groups counts the same way', () => {
    expect(formatNumber(4800, 'en')).toBe('4,800');
    expect(formatNumber(4800, 'bn')).toBe('৪,৮০০');
  });
});

describe('dates', () => {
  const date = new Date(2026, 8, 23);

  it('writes "23 Sep 2026" in English (not the ICU "Sept")', () => {
    expect(formatDate(date, 'en')).toBe('23 Sep 2026');
  });

  it('writes Bangla dates with Bangla digits', () => {
    expect(formatDate(date, 'bn')).toBe('২৩ সেপ, ২০২৬');
  });

  it('writes periods as month and year', () => {
    expect(formatMonth(date, 'en')).toBe('September 2026');
    expect(formatMonth(date, 'bn')).toBe('সেপ্টেম্বর ২০২৬');
  });
});
```

- প্রতিটা টেস্ট একটা নিয়ম পাহারা দেয় যেটা ভাঙলে টাকা ভুল দেখাত: ৳ আগে, বাংলা অঙ্ক, `-0` না, আর
  `Number.MAX_SAFE_INTEGER`-এর চেয়ে বড় অঙ্ক — number-এ রূপান্তর হলে `9007199254740993` হয়ে যেত `…992`।
- তারিখের টেস্টে `new Date(2026, 8, 23)` (local) — `new Date('2026-09-23')` লিখলে UTC ধরত, আর UTC-র পশ্চিমের
  কোনো CI মেশিনে দিন বদলে টেস্ট ভাঙত।

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n test     # ৯টা পাস
```

---

## ৪.২ — `packages/ui`: কাঠামো, token CSS আর ছোট helper

**ফাইল: `packages/ui/package.json`** (নতুন ফাইল — dependency ছাড়া লিখুন)

```json
{
  "name": "@omnivo/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./styles.css": "./src/styles.css"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  }
}
```

**কোন লাইন কেন:**

- `"sideEffects": false` — **bundle-size-এর সবচেয়ে জরুরি লাইন।** app লেখে `import { Button } from '@omnivo/ui'`, আর
  `index.ts` সব component re-export করে। এই লাইন না থাকলে bundler ধরে নেয় প্রতিটা module import হওয়ামাত্র কিছু
  করে (যেমন `data-table.tsx`-এর module-level `tableFeatures({...})` ডাক), তাই লগইন পেজের chunk-এও পুরো TanStack
  Table ঢুকে যেত। এটা থাকলে যে component ব্যবহার হয়নি তার module পুরোটাই বাদ। নিরাপদ, কারণ ui-র কোনো JS
  module import-এর সময় বাইরের কিছু বদলায় না (CSS JS থেকে import হয় না, আলাদা `@import`-এ আসে)।
- `"./styles.css": "./src/styles.css"` — CSS `dist`-এ কপি হয় না (tsc CSS চেনে না), আর দরকারও নেই: app-এর Tailwind
  এটা source হিসেবেই পড়ে compile করে। string (condition ছাড়া) export তাই Tailwind-এর resolver আর Vite দুজনেই
  খুঁজে পায় — যাচাই করা।

```bash
pnpm --filter @omnivo/ui add '@omnivo/i18n@workspace:*' 'radix-ui@^1.6.7' 'sonner@^2.0.8' 'tailwind-merge@^3.7.0' 'react-hook-form@^7.89.0' '@tanstack/react-table@^9.2.4' '@tanstack/react-virtual@^3.14.13' 'decimal.js@^10.6.0' 'react-day-picker@^10.0.1' '@hugeicons/react@^1.1.10' '@hugeicons/core-free-icons@^4.3.5' '@fontsource-variable/geist@^5.3.0' '@fontsource-variable/geist-mono@^5.3.0' '@fontsource/noto-sans-bengali@^5.3.0'
pnpm --filter @omnivo/ui add -D '@omnivo/config@workspace:*' '@types/react@^19.3.0' '@types/react-dom@^19.3.0' 'typescript@^6.0.3' 'vitest@^5.0.1'
pnpm --filter @omnivo/ui add --save-peer 'react@^19.3.0' 'react-dom@^19.3.0'
```

প্রতিটা dependency কেন, আর gzip-এ কত (esbuild দিয়ে আলাদা করে মাপা):

| প্যাকেজ | কাজ | মাপ (gz) |
|---|---|---|
| `radix-ui` | Checkbox, DropdownMenu, Popover-এর আচরণ (কীবোর্ড, focus, ARIA, কিনারায় সরে যাওয়া) | ~33 KB তিনটা মিলে (মেনু একাই ~31) |
| `sonner` | Toast-এর সারি, সময় ধরে মুছে যাওয়া, swipe | ~9 KB |
| `tailwind-merge` | `cn()` — class সংঘাত মেটানো | ~9 KB |
| `@tanstack/react-table` | টেবিলের মডেল, sort | ~13 KB (যা feature নেওয়া হয়েছে শুধু সেটুকু) |
| `@tanstack/react-virtual` | শুধু দৃশ্যমান রো DOM-এ | ~8 KB |
| `react-day-picker` | ক্যালেন্ডার (date-fns ভেতরে আসে) | ~22 KB, দুই locale সহ |
| `decimal.js` | টাকার নির্ভুল গোল করা | ~13 KB |
| `react-hook-form` | `useController` (FormField) | ~3 KB (ui অংশটুকু) |

এগুলো সব একসাথে প্রথম লোডে আসে না — প্রতিটা শুধু সেই পেজের chunk-এ যায় যেখানে লাগে (৪.১০)।
`react-hook-form` ui আর app দুই জায়গায় একই version range-এ, তাই pnpm একটাই কপি রাখে (`pnpm dedupe --check`
সেটা পাহারা দেয়) — `useForm` (app) আর `useController` (ui) একই লাইব্রেরির হতে হবে।

**ফাইল: `packages/ui/tsconfig.json`** (নতুন ফাইল)

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- `jsx: "react-jsx"` — React 17+-এর নতুন JSX transform: প্রতিটা ফাইলে `import React` লাগে না।
- `module: "nodenext"` — বাকি প্যাকেজের মতো; তাই relative import-এ `.js` extension লিখতে হয়
  (`'./field.js'`, ফাইলটা `.tsx` হলেও) — build-এর পর ঠিক সেই নামেই ফাইল থাকে।

**ফাইল: `packages/ui/tsconfig.build.json`** (নতুন ফাইল — `contracts`-এরটার হুবহু কপি)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationMap": true
  },
  "exclude": ["src/**/*.spec.ts"]
}
```

- `exclude: ["src/**/*.spec.ts"]` — টেস্ট `dist`-এ যায় না।

### স্টাইলশিট সরানো

**ফাইল: `packages/ui/src/styles.css`** (নতুন ফাইল — `apps/app/src/styles.css` থেকে সরানো, তিনটা বদল সহ)

```css
/* self-hosted — অফলাইন-ফার্স্ট অ্যাপ runtime-এ Google Fonts ডাকবে না */
@import '@fontsource-variable/geist';
@import '@fontsource-variable/geist-mono';
@import '@fontsource/noto-sans-bengali/400.css';
@import '@fontsource/noto-sans-bengali/500.css';
@import '@fontsource/noto-sans-bengali/600.css';

/* ui-র class খুঁজতে Tailwind-কে এই ফোল্ডারও স্ক্যান করতে বলা — app-এর node_modules
   Tailwind নিজে থেকে স্ক্যান করে না, তাই এটা না থাকলে ui-র সব class CSS থেকে বাদ পড়ত */
@source './';

/* CLAUDE.md-এর color token — component-এ কখনো raw hex না, শুধু এই নামগুলো */
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --subtle: #f1f3f6;
  --line: #e4e7ec;
  --line-strong: #d0d5dd;
  --ink: #0f1728;
  --ink-2: #475467;
  --ink-3: #8a94a6;
  --brand: #1f47b5;
  --brand-hover: #193b97;
  --brand-soft: #edf1fb;
  --brand-line: #c9d5f3;
  --brand-ink: #ffffff;
  --good: #0a7a4b;
  --good-bg: #ecf8f1;
  --warn: #b25e09;
  --warn-bg: #fef6e7;
  --crit: #b42318;
  --crit-bg: #fef1f0;
  --elev-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --elev: 0 1px 2px rgb(16 24 40 / 0.04), 0 8px 24px -6px rgb(16 24 40 / 0.1);
  --elev-lg: 0 2px 4px rgb(16 24 40 / 0.04), 0 24px 48px -12px rgb(16 24 40 / 0.16);
  --focus-ring: 0 0 0 4px rgb(31 71 181 / 0.14);
}

/* OS dark হলে dark — কিন্তু data-theme="light" থাকলে সেটাই জিতবে */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: #0b0f17;
    --surface: #111722;
    --subtle: #171e2b;
    --line: #212938;
    --line-strong: #2f394b;
    --ink: #eef1f6;
    --ink-2: #a3adbd;
    --ink-3: #6b768a;
    --brand: #7c9cf2;
    --brand-hover: #95aff5;
    --brand-soft: #16203a;
    --brand-line: #2a3a66;
    --brand-ink: #0b0f17;
    --good: #4cc98f;
    --good-bg: #0e2a1e;
    --warn: #f2b35a;
    --warn-bg: #2c2211;
    --crit: #f4837a;
    --crit-bg: #321614;
    --elev-sm: 0 1px 2px rgb(0 0 0 / 0.3);
    --elev: 0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -6px rgb(0 0 0 / 0.5);
    --elev-lg: 0 2px 4px rgb(0 0 0 / 0.3), 0 24px 48px -12px rgb(0 0 0 / 0.6);
    --focus-ring: 0 0 0 4px rgb(124 156 242 / 0.2);
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0b0f17;
  --surface: #111722;
  --subtle: #171e2b;
  --line: #212938;
  --line-strong: #2f394b;
  --ink: #eef1f6;
  --ink-2: #a3adbd;
  --ink-3: #6b768a;
  --brand: #7c9cf2;
  --brand-hover: #95aff5;
  --brand-soft: #16203a;
  --brand-line: #2a3a66;
  --brand-ink: #0b0f17;
  --good: #4cc98f;
  --good-bg: #0e2a1e;
  --warn: #f2b35a;
  --warn-bg: #2c2211;
  --crit: #f4837a;
  --crit-bg: #321614;
  --elev-sm: 0 1px 2px rgb(0 0 0 / 0.3);
  --elev: 0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -6px rgb(0 0 0 / 0.5);
  --elev-lg: 0 2px 4px rgb(0 0 0 / 0.3), 0 24px 48px -12px rgb(0 0 0 / 0.6);
  --focus-ring: 0 0 0 4px rgb(124 156 242 / 0.2);
}

/* shadcn/ui-র নিজের নাম আমাদের token-এ পয়েন্ট করা — shadcn থেকে কপি করা component
   (bg-primary, border-input …) কোনো বদল ছাড়াই একই রং পায়। নিজেদের কোডে brand/ink নামই লিখুন */
:root {
  --background: var(--bg);
  --foreground: var(--ink);
  --card: var(--surface);
  --card-foreground: var(--ink);
  --popover: var(--surface);
  --popover-foreground: var(--ink);
  --primary: var(--brand);
  --primary-foreground: var(--brand-ink);
  --secondary: var(--subtle);
  --secondary-foreground: var(--ink);
  --muted: var(--subtle);
  --muted-foreground: var(--ink-3);
  --accent: var(--subtle);
  --accent-foreground: var(--ink);
  --destructive: var(--crit);
  --border: var(--line);
  --input: var(--line-strong);
  --ring: var(--brand);
}

/* inline: utility-তে var(--x) বসে, তাই theme বদলালে rebuild ছাড়াই রং বদলায় */
@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-subtle: var(--subtle);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-ink: var(--ink);
  --color-ink-2: var(--ink-2);
  --color-ink-3: var(--ink-3);
  --color-brand: var(--brand);
  --color-brand-hover: var(--brand-hover);
  --color-brand-soft: var(--brand-soft);
  --color-brand-line: var(--brand-line);
  --color-brand-ink: var(--brand-ink);
  --color-good: var(--good);
  --color-good-bg: var(--good-bg);
  --color-warn: var(--warn);
  --color-warn-bg: var(--warn-bg);
  --color-crit: var(--crit);
  --color-crit-bg: var(--crit-bg);

  /* shadcn নাম (উপরের :root দেখুন) */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  /* fontsource-variable প্যাকেজ family নাম রেজিস্টার করে "Geist Variable" নামে, "Geist" না */
  --font-sans: 'Geist Variable', 'Noto Sans Bengali', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace;

  --radius-control: 10px;
  --radius-card: 14px;
  --radius-panel: 20px;

  --shadow-sm: var(--elev-sm);
  --shadow-md: var(--elev);
  --shadow-lg: var(--elev-lg);
  --shadow-ring: var(--focus-ring);
  --shadow-ring-crit: 0 0 0 4px var(--crit-bg);
}

/* টাইপ স্কেল (CLAUDE.md-এর টেবিল) — text-body, text-label ইত্যাদি */
@theme {
  --text-display: 34px;
  --text-display--line-height: 1.15;
  --text-h1: 26px;
  --text-h1--line-height: 1.2;
  --text-h2: 24px;
  --text-h2--line-height: 1.25;
  --text-kpi: 26px;
  --text-kpi--line-height: 1.1;
  --text-h3: 15px;
  --text-h3--line-height: 1.4;
  --text-body: 14.5px;
  --text-body--line-height: 1.5;
  --text-body-sm: 13.5px;
  --text-body-sm--line-height: 1.45;
  --text-label: 13px;
  --text-label--line-height: 1.4;
  --text-caption: 12px;
  --text-caption--line-height: 1.35;
  --text-micro: 11px;
  --text-micro--line-height: 1.3;
}

@layer base {
  body {
    background: var(--color-bg);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-size: var(--text-body);
    line-height: var(--text-body--line-height);
    -webkit-font-smoothing: antialiased;
  }

  h1,
  h2,
  h3 {
    font-weight: 600;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  /* সব clickable element-এ pointer cursor (Tailwind v4 preflight button-এ default করে দেয়) */
  button:not(:disabled),
  [role='button']:not([aria-disabled='true']),
  a[href],
  label[for],
  summary,
  select:not(:disabled),
  input[type='checkbox']:not(:disabled),
  input[type='radio']:not(:disabled),
  input[type='file']:not(:disabled) {
    cursor: pointer;
  }
  /* disabled হলে not-allowed */
  :disabled,
  [aria-disabled='true'] {
    cursor: not-allowed;
  }

  :focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition: none !important;
      animation: none !important;
    }
  }
}
```

**ধাপ ৩-এর ফাইলের তুলনায় কী বদলাল:**

- প্রথম লাইনের `@import 'tailwindcss';` **নেই** — সেটা app-এ থাকে (ভিত্তি-সিদ্ধান্ত ৪)।
- `@source './';` **নতুন।** Tailwind v4 class খোঁজে যে ফোল্ডার থেকে build চলছে (apps/app) সেখানে, আর
  `.gitignore`-এ থাকা সব বাদ দেয় — `node_modules`-ও। app-এর কাছে `@omnivo/ui` একটা `node_modules` symlink, তাই
  এটা ছাড়া ui-র `bg-brand`, `rounded-card` ইত্যাদি কোনো class CSS-এ তৈরিই হতো না, আর component গুলো রং ছাড়া
  দেখাত। পাথ CSS ফাইলটার অবস্থান থেকে ধরা হয়, তাই `'./'` = `packages/ui/src`। `@import`-এর **পরে** রাখা:
  CSS-এ `@import` সবার আগে থাকতে হয়।
- shadcn-এর নামের `:root` ব্লক আর `@theme inline`-এ `--color-primary` … **নতুন** (CLAUDE.md → Tailwind wiring-এর
  শেষ অনুচ্ছেদ)। আমাদের নিজের কোডে এগুলো ব্যবহার হয় না; আছে যাতে shadcn থেকে কপি করা কোনো component
  (`bg-primary`, `border-input`) কোনো বদল ছাড়াই আমাদের রং পায়। dark mode-এ আলাদা করে লিখতে হয়নি: `--primary`
  পয়েন্ট করে `var(--brand)`-এ, আর `--brand` নিজেই dark-এ বদলায়।
- `auth-grid` utility **সরানো হয়নি** — সেটা শুধু লগইন পেজের, তাই app-এ থাকছে (৪.৯)।
- font-এর `@import` গুলো এখন ui-র `node_modules` থেকে resolve হয় — তাই fontsource ui-র dependency। Tailwind
  import inline করার সময় font ফাইলের `url()` মূল CSS-এর জায়গা অনুযায়ী ঠিক করে দেয়; build-এ `dist/assets`-এ
  `geist-*.woff2`, `noto-sans-bengali-bengali-*.woff2` আসে — যাচাই করা।

### `lib/` — ছোট helper

**ফাইল: `packages/ui/src/lib/cn.ts`** (নতুন ফাইল — `apps/app/src/lib/cx.ts`-এর জায়গায়)

```ts
import { extendTailwindMerge } from 'tailwind-merge';

// class জোড়া লাগানো + সংঘাত মেটানো: cn('px-4', 'px-6') → 'px-6'। ডাক-দেওয়া কোডের class
// সবসময় জেতে, CSS ফাইলে কোন rule আগে তৈরি হলো তার উপর নির্ভর করে না
export const cn = extendTailwindMerge({
  extend: {
    theme: {
      // এগুলো না জানালে tailwind-merge `text-body`-কে রং ভাবত, আর cn('text-body', 'text-ink')
      // চুপচাপ font-size মুছে দিত
      text: ['display', 'h1', 'h2', 'kpi', 'h3', 'body', 'body-sm', 'label', 'caption', 'micro'],
      radius: ['control', 'card', 'panel'],
      shadow: ['ring', 'ring-crit'],
    },
  },
});
```

**কোন লাইন কেন:**

- ধাপ ৩-এর `cx()` শুধু class জোড়া দিত। component এখন অন্য প্যাকেজে, আর app তাদের উপর `className` দেয়
  (`<Button className="w-full">`)। দুটো class একই জিনিস বদলালে (`px-4` বনাম `px-6`) কোনটা জেতে তা নির্ভর করে
  **CSS ফাইলে কোন rule পরে তৈরি হয়েছে** তার উপর, class লেখার ক্রমে না — অর্থাৎ অনির্দিষ্ট। tailwind-merge সংঘাত
  দেখে আগেরটা মুছে দেয়, ফলে caller-এর class সবসময় জেতে। shadcn-এর `cn()`-ও এটাই।
- `extendTailwindMerge` — **বাদ দিলে সূক্ষ্ম bug:** সাধারণ `twMerge('text-body', 'text-ink')` ফেরত দেয় শুধু
  `'text-ink'` (যাচাই করা)। tailwind-merge আমাদের টাইপ স্কেল চেনে না, তাই `text-body`-কে রং ভাবে, আর দুটো "রং"
  দেখে প্রথমটা মুছে দেয় — font-size চুপচাপ হারিয়ে যেত। `theme.text`-এ স্কেলের নাম দিলে সেগুলো font-size গোষ্ঠীতে
  যায়। `radius` আর `shadow`-ও একই কারণে (আমাদের `rounded-control`, `shadow-ring`)।
- `clsx` লাগেনি — tailwind-merge নিজেই `false`/`undefined`/`null` বাদ দেয়।

**ফাইল: `packages/ui/src/lib/cn.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { cn } from './cn.js';

describe('cn', () => {
  it('lets the caller override a conflicting utility', () => {
    expect(cn('px-4 py-2', 'px-6')).toBe('py-2 px-6');
  });

  it('keeps a type-scale size and a text color together', () => {
    // plain tailwind-merge treats text-body as a color and drops it here
    expect(cn('text-body', 'text-ink')).toBe('text-body text-ink');
    expect(cn('text-label text-ink-3', 'text-caption')).toBe('text-ink-3 text-caption');
  });

  it('treats the custom radius and shadow tokens as their own groups', () => {
    expect(cn('rounded-control', 'rounded-card')).toBe('rounded-card');
    expect(cn('shadow-sm', 'shadow-ring')).toBe('shadow-ring');
  });

  it('drops falsy parts', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
  });
});
```

- দ্বিতীয় টেস্টটাই আসল পাহারা: কেউ কখনো `extendTailwindMerge` সরিয়ে সাধারণ `twMerge` বসালে এটা fail করবে।

**ফাইল: `packages/ui/src/lib/use-media-query.ts`** (নতুন ফাইল)

```ts
import { useSyncExternalStore } from 'react';

// CSS-এর min-[860px] আর JS-এর সিদ্ধান্ত একই জায়গা থেকে — সাইডবার আর টেবিল একসাথে বদলায়
export const DESKTOP_QUERY = '(min-width: 860px)';

// useSyncExternalStore: resize-এ matchMedia-র change event এলে সাথে সাথে নতুন মান,
// আর React-এর concurrent render-এ "tearing" (একই render-এ দুই রকম মান) হয় না
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    () => window.matchMedia(query).matches,
  );
}
```

- `DESKTOP_QUERY` = CSS-এর `min-[860px]:` — সাইডবার (CSS দিয়ে) আর টেবিল↔কার্ড (JS দিয়ে) একই পিক্সেলে বদলায়।
- `useSyncExternalStore` — React-এর বাইরের কোনো মান (এখানে ব্রাউজারের media query) পড়ার সঠিক hook।
  `useState` + `useEffect` দিয়ে লিখলে প্রথম render-এ ভুল মান যেত আর effect-এর পর আবার render হতো; concurrent
  render-এ একই render-এর ভেতরে দুই রকম মানও দেখা যেতে পারত ("tearing")।
- `change` event — জানালা টেনে ছোট-বড় করলে বা ফোন ঘোরালে সাথে সাথে নতুন মান।

**ফাইল: `packages/ui/src/lib/money.ts`** (নতুন ফাইল)

```ts
// named import: decimal.js-এর .d.ts CommonJS হিসেবে পড়া হয় (package-এ "type": "module" নেই),
// তাই nodenext-এ default import মানে পুরো module object — `new` করা যায় না
import { Decimal } from 'decimal.js';

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

// বাংলা কীবোর্ডে (Avro/Bijoy) টাইপ করা "১২৩" → "123"; কপি-পেস্ট করা "18,42,600"-এর কমা আর ফাঁকা বাদ
export function normalizeMoneyInput(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/[,\s]/g, '');
}

// টাইপের মাঝপথের অবস্থাও বৈধ: "", "12", "12.", "12.5" — কিন্তু scale-এর বেশি দশমিক না
export function isMoneyDraft(value: string, scale: number): boolean {
  const decimals = scale > 0 ? `(\\.\\d{0,${String(scale)}})?` : '';
  return new RegExp(`^\\d*${decimals}$`).test(value);
}

// ফর্মে যা যায়: "" অথবা ঠিক scale-ঘর দশমিকের string ("1842600.50")।
// Decimal, JS number না: (1.005).toFixed(2) === "1.00" (binary float), আর ২^৫৩-এর বড়
// অঙ্কে number শেষের অঙ্ক হারায়। Decimal-এর ডিফল্ট rounding ROUND_HALF_UP — হিসাবের নিয়ম
export function toCanonicalMoney(draft: string, scale: number): string {
  if (draft === '' || draft === '.') return '';
  return new Decimal(draft).toFixed(scale);
}
```

**কোন লাইন কেন:**

- `import { Decimal } from 'decimal.js'`, default import না — decimal.js-এর `.d.ts` CommonJS হিসেবে পড়া হয় (তার
  `package.json`-এ `"type": "module"` নেই), তাই `nodenext`-এ `import Decimal from` দিলে পাওয়া যায় পুরো module
  object, আর `new Decimal()` দিলে `TS2351: This expression is not constructable`। ESM build (`decimal.mjs`)
  `Decimal` নামেও export করে, তাই named import runtime-এও ঠিক।
- `normalizeMoneyInput` — বাংলা কীবোর্ডে (Avro/Bijoy) অঙ্ক টাইপ করলে আসে `১২৩`। `[০-৯]` ধরে
  `BANGLA_DIGITS.indexOf()` দিয়ে ইংরেজি অঙ্ক। কমা আর ফাঁকা বাদ — Excel থেকে `18,42,600` পেস্ট করলেও চলে।
- `isMoneyDraft` — টাইপের **মাঝপথের** অবস্থাও বৈধ রাখতে হয়: `12.` অসম্পূর্ণ, কিন্তু এটা আটকালে দশমিক লেখাই যেত না।
  `scale`-এর বেশি দশমিক (`12.505`), দ্বিতীয় বিন্দু, অক্ষর, মাইনাস — আটকানো।
- `toCanonicalMoney` — ফর্মে যায় সবসময় ঠিক `scale` ঘরের string (`"1842600.50"`)। `new Decimal('12.')`-ও বৈধ
  (`"12.00"`), তাই অসম্পূর্ণ লেখাও ঠিক মানে রূপ নেয়। `Decimal`-এর ডিফল্ট rounding `ROUND_HALF_UP` — হিসাবের
  প্রচলিত নিয়ম।

**ফাইল: `packages/ui/src/lib/money.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { isMoneyDraft, normalizeMoneyInput, toCanonicalMoney } from './money.js';

describe('normalizeMoneyInput', () => {
  it('turns Bangla digits into ASCII digits', () => {
    expect(normalizeMoneyInput('১৮৪২৬০০.৫০')).toBe('1842600.50');
  });

  it('removes grouping commas and spaces from pasted amounts', () => {
    expect(normalizeMoneyInput('18,42,600')).toBe('1842600');
    expect(normalizeMoneyInput(' 1 200 ')).toBe('1200');
  });
});

describe('isMoneyDraft', () => {
  it('accepts every half-typed state', () => {
    for (const draft of ['', '12', '12.', '12.5', '12.50', '.5']) {
      expect(isMoneyDraft(draft, 2)).toBe(true);
    }
  });

  it('rejects letters, a second point and too many decimals', () => {
    for (const draft of ['12a', '1.2.3', '12.505', '-12']) {
      expect(isMoneyDraft(draft, 2)).toBe(false);
    }
  });

  it('allows no point at all when the scale is 0', () => {
    expect(isMoneyDraft('12', 0)).toBe(true);
    expect(isMoneyDraft('12.', 0)).toBe(false);
  });
});

describe('toCanonicalMoney', () => {
  it('pads to the scale', () => {
    expect(toCanonicalMoney('1842600.5', 2)).toBe('1842600.50');
    expect(toCanonicalMoney('12.', 2)).toBe('12.00');
  });

  it('rounds half up without binary float errors', () => {
    // (1.005).toFixed(2) === '1.00' in JavaScript
    expect(toCanonicalMoney('1.005', 2)).toBe('1.01');
  });

  it('keeps every digit of amounts beyond Number.MAX_SAFE_INTEGER', () => {
    expect(toCanonicalMoney('9007199254740993', 2)).toBe('9007199254740993.00');
  });

  it('maps an empty draft to an empty value', () => {
    expect(toCanonicalMoney('', 2)).toBe('');
    expect(toCanonicalMoney('.', 2)).toBe('');
  });
});
```

- `'1.005'` → `'1.01'` টেস্ট: কেউ কখনো decimal.js সরিয়ে `Number(x).toFixed(2)` বসালে এটা fail করে (`"1.00"`)।

**ফাইল: `packages/ui/src/lib/iso-date.ts`** (নতুন ফাইল)

```ts
// ফর্ম আর API-তে তারিখ "2026-09-23" (ISO date, সময় নেই)। দুই দিকেই local অংশ দিয়ে:
// new Date('2026-09-23') UTC মধ্যরাত ধরে, আর toISOString() UTC-তে লেখে — ঢাকায় (UTC+6)
// local মধ্যরাত মানে UTC-তে আগের দিন সন্ধ্যা ৬টা, ফলে তারিখ এক দিন পিছিয়ে "2026-09-22" হতো
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): Date | undefined {
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function toIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
```

- ফর্ম আর API-তে তারিখ `"2026-09-23"` — সময় আর timezone ছাড়া। এটা ফাইলের সবচেয়ে জরুরি মন্তব্য: `new Date(string)`
  আর `toISOString()` দুটোই UTC ধরে। ঢাকায় ২৩ সেপ্টেম্বর রাত ১২টা = UTC-তে ২২ সেপ্টেম্বর সন্ধ্যা ৬টা, তাই
  `toISOString().slice(0, 10)` দিত `"2026-09-22"` — ক্যালেন্ডারে যে দিন বেছেছেন তার আগের দিন সেভ হতো।
  local অংশ (`getFullYear/getMonth/getDate`) দিয়ে পড়া-লেখা করলে কোনো timezone-এ দিন সরে না।
- date-fns এখানে ইচ্ছা করে ব্যবহার হয়নি — ছয় লাইনের কাজে import-এর দরকার নেই।

**ফাইল: `packages/ui/src/lib/iso-date.spec.ts`** (নতুন ফাইল)

```ts
import { describe, expect, it } from 'vitest';

import { parseIsoDate, toIsoDate } from './iso-date.js';

describe('ISO dates', () => {
  it('reads a date as local midnight, not UTC', () => {
    const date = parseIsoDate('2026-09-23');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(8);
    expect(date?.getDate()).toBe(23);
    expect(date?.getHours()).toBe(0);
  });

  it('round-trips without shifting a day', () => {
    expect(toIsoDate(new Date(2026, 8, 23))).toBe('2026-09-23');
    expect(toIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(parseIsoDate('')).toBeUndefined();
    expect(parseIsoDate('23/09/2026')).toBeUndefined();
  });
});
```

---

## ৪.৩ — সাধারণ component (ধাপ ৩ থেকে সরানো + নতুন)

`Logo`, `Pill` আর `FormAlert` ধাপ ৩ থেকে হুবহু সরানো — শুধু import-এর পাথ বদলেছে (`'../lib/cx'` →
`'../lib/cn.js'`)। বাকিগুলো নতুন বা বদলানো।

**ফাইল: `packages/ui/src/components/button.tsx`** (`apps/app/src/components/button.tsx` থেকে সরানো, বদল সহ)

```tsx
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

type ButtonVariant = 'primary' | 'secondary';
type ButtonSize = 'md' | 'sm';

// CLAUDE.md → Primary / Secondary button। কোনো variant বাদ পড়লে satisfies ধরবে
const variantClass = {
  primary: 'bg-brand text-brand-ink text-body hover:bg-brand-hover',
  secondary: 'border border-line-strong bg-surface text-ink text-body-sm hover:bg-subtle',
} satisfies Record<ButtonVariant, string>;

const sizeClass = {
  md: 'min-h-[42px] px-4',
  sm: 'min-h-9 px-3',
} satisfies Record<ButtonSize, string>;

// ComponentProps<'button'>-এ React 19-এ ref-ও আছে — Radix-এর asChild ref পাঠাতে পারে
interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      // ডিফল্ট "submit" না: ফর্মের ভেতরের যেকোনো বাটন ভুল করে ফর্ম জমা দিত
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap shadow-sm transition-colors duration-150 disabled:opacity-60',
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...props}
    />
  );
}

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children' | 'aria-label'> {
  icon: IconSvgElement;
  // শুধু আইকনের বাটনে লেখা নেই — স্ক্রিন রিডারের জন্য label বাধ্যতামূলক, টাইপেই
  label: string;
}

export function IconButton({ icon, label, className, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'grid place-items-center rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
        className,
      )}
      {...props}
    >
      <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
    </button>
  );
}
```

**কোন লাইন কেন:**

- `variantClass`/`sizeClass` অবজেক্ট + `satisfies Record<…>` — ধাপ ৩-এর ternary-র বদলে টেবিল। নতুন variant
  (`'danger'`) টাইপে যোগ করে class লিখতে ভুলে গেলে compile error।
- secondary-তে `text-body-sm` — CLAUDE.md → Typography টেবিল: body-sm "secondary buttons"-এর জন্য। primary থাকে
  `text-body` (14.5px)।
- `sm` = `min-h-9` (36px) — CLAUDE.md: "height 42px (36px for sm)"। এটা নতুন; টেবিলের পাশের ছোট কাজে লাগবে।
- `ComponentProps<'button'>` (আগে ছিল `ButtonHTMLAttributes`) — React 19-এ এতে `ref`-ও আছে। Radix-এর `asChild`
  (যেমন `<DropdownMenuTrigger asChild><IconButton …/></DropdownMenuTrigger>`) child-এ ref পাঠায়; ref না নিলে মেনু
  কোথায় খুলবে Radix মাপতে পারত না। React 19-এ `forwardRef` আর লাগে না — ref সাধারণ prop।
- `type = 'button'` ডিফল্ট — HTML-এর ডিফল্ট `submit`; ফর্মের ভেতরে "Show password"-এর মতো যেকোনো বাটন ভুল করে
  ফর্ম জমা দিত।
- `IconButton`-এ `label` **বাধ্যতামূলক** আর `aria-label` Omit করা — শুধু-আইকনের বাটনে কোনো লেখা নেই, স্ক্রিন রিডার
  কিছুই পড়ত না। টাইপই নিশ্চিত করে কেউ label ভুলতে পারবে না, আর `aria-label` দুই জায়গা থেকে আসার সুযোগ নেই।

**ফাইল: `packages/ui/src/components/logo.tsx`** (হুবহু সরানো)

```tsx
// দুটো সরানো বর্গ — ভরাট আর ফাঁকা, খাতার ডেবিট/ক্রেডিট কলাম (CLAUDE.md → Logo)
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">
      <span aria-hidden="true" className="relative size-[26px] shrink-0">
        <span className="absolute top-0 left-0 size-4 rounded-[5px] bg-brand" />
        <span className="absolute right-0 bottom-0 size-4 rounded-[5px] border-2 border-brand bg-surface" />
      </span>
      Omnivo
    </span>
  );
}
```

**ফাইল: `packages/ui/src/components/pill.tsx`** (সরানো — শুধু `cx` → `cn`)

```tsx
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export type PillTone = 'good' | 'warn' | 'crit' | 'brand' | 'neutral';

// CLAUDE.md → Pill: প্রতিটা tone-এর soft background + মিলানো লেখা; কোনো tone বাদ পড়লে satisfies ধরবে
const toneClass = {
  good: 'bg-good-bg text-good',
  warn: 'bg-warn-bg text-warn',
  crit: 'bg-crit-bg text-crit',
  brand: 'bg-brand-soft text-brand',
  neutral: 'bg-subtle text-ink-3',
} satisfies Record<PillTone, string>;

interface PillProps {
  tone: PillTone;
  // status রঙ কখনো একা না — তাই icon বাধ্যতামূলক
  icon: IconSvgElement;
  children: ReactNode;
}

export function Pill({ tone, icon, children }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-full py-0.5 pr-2 pl-1.5 text-caption font-medium whitespace-nowrap',
        toneClass[tone],
      )}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.5} className="shrink-0" />
      {children}
    </span>
  );
}
```

**ফাইল: `packages/ui/src/components/form-alert.tsx`** (হুবহু সরানো)

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

// ফিল্ডে বসানো যায় না এমন error (ভুল পাসওয়ার্ড, নেটওয়ার্ক) — রঙের সাথে আইকন আর লেখা
export function FormAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control border border-crit/30 bg-crit-bg px-3 py-2.5 text-body-sm text-crit"
    >
      <HugeiconsIcon icon={Alert02Icon} size={17} strokeWidth={1.5} className="mt-px shrink-0" />
      {message}
    </p>
  );
}
```

**ফাইল: `packages/ui/src/components/card.tsx`** (নতুন ফাইল)

```tsx
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

// CLAUDE.md → Card: surface, ১px line, ১৪px কোণ, shadow-sm
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('rounded-card border border-line bg-surface shadow-sm', className)}
      {...props}
    />
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
}

// শিরোনাম ১৫px/600 + ১৩px ink-3 সাবটাইটেল, padding 18px 20px 0
export function CardHeader({ title, subtitle, actions }: CardHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4 px-5 pt-[18px]">
      <div className="min-w-0">
        <h3 className="text-h3">{title}</h3>
        {subtitle && <p className="text-label text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
```

- CLAUDE.md → Card-এর মাপ (`rounded-card`, `border-line`, `shadow-sm`, header `18px 20px 0`) এক জায়গায়। ধাপ ৩-এ
  ড্যাশবোর্ডে এই class-এর লম্বা string হাতে লেখা ছিল।
- `<section>` — কার্ড সাধারণত পেজের একটা অংশ; স্ক্রিন রিডার landmark হিসেবে চেনে।
- `className` নেয় (`cn` দিয়ে মেলানো) — `<Card className="p-8 text-center">` চলে।

**ফাইল: `packages/ui/src/components/page-header.tsx`** (নতুন ফাইল)

```tsx
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  // পেজের একমাত্র primary বাটন সাধারণত এখানে (CLAUDE.md: প্রতি view-এ একটা primary)
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    // flex-wrap: ফোনে বাটন শিরোনামের নিচে নেমে যায়, আড়াআড়ি scroll হয় না
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-h1">{title}</h1>
        {description && <p className="mt-1 text-label text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

interface SectionHeaderProps {
  title: string;
  subtitle?: string | undefined;
}

// পেজের ভেতরের অংশের শিরোনাম, কার্ড ছাড়া — যেমন DataTable-এর উপরে (যেটা নিজেই কার্ড)।
// দেখতে CardHeader-এর মতো (১৫px/600 + ১৩px ink-3), কিন্তু padding নেই
export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  return (
    <header>
      <h2 className="text-h3">{title}</h2>
      {subtitle && <p className="text-label text-ink-3">{subtitle}</p>}
    </header>
  );
}
```

- `PageHeader` — প্রতিটা পেজের `h1` + ছোট বিবরণ + ডানে কাজের বাটন। `flex-wrap`: ফোনে বাটন নিচে নামে।
- `SectionHeader` — **কেন আলাদা:** `DataTable` নিজেই কার্ড (border, কোণ, ছায়া)। সেটাকে `Card`-এর ভেতরে বসালে
  কার্ডের ভেতরে কার্ড হয় — যাচাইয়ের screenshot-এ সেটা ভারী দেখাচ্ছিল, আর CLAUDE.md বলে "Not everything needs
  to be a card"। তাই টেবিলের উপরে কার্ড ছাড়া শিরোনাম, দেখতে `CardHeader`-এর মতো।
- `h2` কিন্তু `text-h3` আকারে — পেজে `h1`-এর পরের স্তর `h2` (স্ক্রিন রিডারের শিরোনাম-তালিকা ঠিক থাকে), আর চেহারা
  CLAUDE.md-এর card title (১৫px)।

**ফাইল: `packages/ui/src/components/empty-state.tsx`** (নতুন ফাইল)

```tsx
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: IconSvgElement;
  title: string;
  // কী করলে এখানে ডেটা আসবে — আসল উদাহরণ দিয়ে (buyer PO, LC), lorem ipsum না
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="grid justify-items-center px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
        <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
      </span>
      <h3 className="mt-3 text-h3">{title}</h3>
      <p className="mt-1 max-w-sm text-body-sm text-ink-2">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

- `description` বাধ্যতামূলক — খালি পেজে শুধু "No data" না, **কী করলে** এখানে কিছু আসবে সেটা বলা (CLAUDE.md →
  Content: আসল উদাহরণ, lorem ipsum না)।
- আইকন টাইল `rounded-lg` (8px) — CLAUDE.md → Radius: "8px for small items (… icon tiles)"।

**ফাইল: `packages/ui/src/components/segmented-control.tsx`** (নতুন ফাইল)

```tsx
import { useId } from 'react';

import { cn } from '../lib/cn.js';

interface SegmentedControlProps<TValue extends string> {
  label: string;
  value: TValue;
  options: readonly { value: TValue; label: string }[];
  onChange: (value: TValue) => void;
}

// ভেতরে আসল radio input: তীর-কী দিয়ে বদলানো, স্ক্রিন রিডারে "২টার ১" — সব ব্রাউজার বিনা খরচে দেয়।
// TValue generic: options-এর মানই onChange-এ ফেরত আসে, string-এ চওড়া হয় না
export function SegmentedControl<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedControlProps<TValue>) {
  const name = useId();
  return (
    <fieldset className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'cursor-pointer rounded-md px-3 py-1.5 text-body-sm font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand',
            // CLAUDE.md: বাছাই করা segment-এ subtle পটভূমি
            option.value === value ? 'bg-subtle text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => {
              onChange(option.value);
            }}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
```

**কোন লাইন কেন:**

- ভেতরে আসল `<input type="radio">` (`sr-only` দিয়ে লুকানো), `<fieldset>` + `<legend>` — তীর-কী দিয়ে বদলানো,
  Tab-এ একটাই থামা, স্ক্রিন রিডারে "Theme, radio group, 3 এর 1" — এসব ব্রাউজার বিনা কোডে দেয়। div + onClick
  দিয়ে লিখলে এগুলো সব হাতে লিখতে হতো।
- `name={useId()}` — একই পেজে দুটো SegmentedControl (থিম আর ভাষা) থাকলে radio গুলোর `name` আলাদা হতে হয়,
  নাহলে ব্রাউজার দুটোকে এক গ্রুপ ভেবে একটায় ক্লিক করলে অন্যটা মুছে দিত।
- `<TValue extends string>` generic — `options`-এর মান থেকেই টাইপ: থিমের জন্য `onChange` পায়
  `'system' | 'light' | 'dark'`, সাধারণ `string` না। তাই caller-কে cast করতে হয় না।
- `has-[:focus-visible]:outline-2` — radio লুকানো, তাই কীবোর্ড focus দেখাতে label-এ outline (CLAUDE.md →
  Focus: "2px brand outline")। `:has()` সব আধুনিক ব্রাউজারে আছে।
- বাছাই করা segment `bg-subtle` — CLAUDE.md: "The selected segment uses a subtle background"।

---

## ৪.৪ — Radix-ভিত্তিক component: Checkbox, DropdownMenu, Popover, Toast

এই চারটায় আচরণ (কীবোর্ড, focus কোথায় যাবে, Escape, স্ক্রিনের কিনারায় সরে যাওয়া, ARIA) জটিল, আর ভুল করলে
কীবোর্ড-ব্যবহারকারী আটকে যায়। তাই আচরণ Radix-এর, চেহারা আমাদের token-এর — shadcn/ui-র পদ্ধতি।

**ফাইল: `packages/ui/src/components/checkbox.tsx`** (নতুন ফাইল)

```tsx
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

interface CheckboxProps extends Omit<
  ComponentProps<typeof CheckboxPrimitive.Root>,
  'className' | 'children' | 'id'
> {
  id: string;
  label: ReactNode;
}

// CLAUDE.md → Checkbox: ১৭px, ৫px কোণ, checked-এ brand ভরাট। native checkbox-এর রং আর
// কোণ সব ব্রাউজারে বদলানো যায় না, তাই Radix (ভেতরে button role="checkbox", কীবোর্ডে Space)
export function Checkbox({ id, label, ...props }: CheckboxProps) {
  return (
    <div className="flex items-start gap-2.5">
      <CheckboxPrimitive.Root
        id={id}
        className="mt-px grid size-[17px] shrink-0 place-items-center rounded-[5px] border border-line-strong bg-surface shadow-sm transition-colors duration-150 hover:border-ink-3 data-[state=checked]:border-brand data-[state=checked]:bg-brand"
        {...props}
      >
        <CheckboxPrimitive.Indicator className="text-brand-ink">
          <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={1.5} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="text-body-sm text-ink-2">
        {label}
      </label>
    </div>
  );
}
```

**কোন লাইন কেন:**

- `import { Checkbox as CheckboxPrimitive } from 'radix-ui'` — একক `radix-ui` প্যাকেজ সব primitive-কে namespace
  হিসেবে দেয় (`Checkbox.Root`, `Checkbox.Indicator`)। ব্যবহার-না-হওয়া primitive bundle-এ যায় না — মাপা:
  Checkbox একা ~৬ KB gz।
- native checkbox কেন না: ধাপ ৩ `accent-brand` দিয়েছিল, কিন্তু কোণ (৫px), border-এর রং আর টিকের আকার সব ব্রাউজারে
  বদলানো যায় না — CLAUDE.md-এর মাপ Safari/Firefox-এ মিলত না।
- `data-[state=checked]:` — Radix চেক অবস্থা `data-state` attribute-এ দেয়; Tailwind-এর arbitrary variant দিয়ে
  সরাসরি ধরা যায়, কোনো JS ternary লাগে না।
- `id` বাধ্যতামূলক আর নিজের `<label htmlFor>` — Radix-এর Root একটা `<button role="checkbox">`, আর `<label for>`
  বাটনকেও চেনে: লেখায় ক্লিক করলেও টিক বদলায় (যাচাই করা)।
- `Omit<…, 'className' | 'children' | 'id'>` — চেহারা বাইরে থেকে বদলানো যাবে না (ডিজাইন সিস্টেম), আর `id`-কে
  আবার ঐচ্ছিক থেকে বাধ্যতামূলক করা।

**ফাইল: `packages/ui/src/components/dropdown-menu.tsx`** (নতুন ফাইল)

```tsx
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

// Radix: কীবোর্ড (তীর, Enter, Esc, টাইপ করে খোঁজা), focus ফেরত আনা, স্ক্রিনের কিনারায়
// নিজে থেকে সরে যাওয়া — এগুলো হাতে লিখলে সপ্তাহ লাগত
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    // Portal: সাইডবারের overflow বা stacking context মেনুকে কেটে ফেলতে পারে না
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 min-w-[220px] rounded-control border border-line bg-surface p-1 shadow-lg',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

// menuitem একটা div — global base rule শুধু button/a ধরে, তাই cursor-pointer এখানে নিজে (CLAUDE.md)
const itemClass =
  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-body-sm text-ink-2 outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[highlighted]:bg-subtle data-[highlighted]:text-ink';

interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  icon?: IconSvgElement;
}

export function DropdownMenuItem({ className, icon, children, ...props }: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item className={cn(itemClass, className)} {...props}>
      {icon && (
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} className="shrink-0 text-ink-3" />
      )}
      {children}
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* বাছাই করাটার পাশে টিক — রং একা না, চিহ্নও (CLAUDE.md) */}
      <MenuPrimitive.ItemIndicator className="text-brand">
        <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2.5 pt-2 pb-1 text-caption font-medium text-ink-3', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-line', className)} {...props} />;
}
```

**কোন লাইন কেন:**

- `DropdownMenu = MenuPrimitive.Root` ইত্যাদি সরাসরি re-export — এদের কোনো চেহারা নেই, মোড়ানোর কিছু নেই।
- `<MenuPrimitive.Portal>` — মেনু `<body>`-র শেষে render হয়। সাইডবারে `overflow` বা `position: sticky` আছে; মেনু
  তার ভেতরে থাকলে কেটে যেত বা content-এর নিচে চাপা পড়ত।
- `z-50`, `shadow-lg` — CLAUDE.md → Shadows: popover-এ `shadow-lg`।
- `sideOffset = 6` ডিফল্ট — বাটন আর মেনুর মাঝে ৬px ফাঁক (৪px ভিত্তির spacing স্কেলের ধাপ)।
- `itemClass`-এ `cursor-pointer` নিজে লেখা — Radix-এর item একটা `<div role="menuitem">`। global base rule শুধু
  `button`, `a[href]`, `[role="button"]` ধরে, তাই CLAUDE.md → Interaction অনুযায়ী এখানে class দিতে হয়।
- `data-[highlighted]:` — hover আর কীবোর্ডের তীর দুটোতেই Radix `data-highlighted` বসায়; তাই একটা নিয়মে দুটোই।
  `:hover` দিলে কীবোর্ডে চলার সময় কিছুই আলো হতো না।
- `DropdownMenuRadioItem`-এর টিক — "বাছাই করা" শুধু রঙে না, চিহ্নেও (CLAUDE.md: never color alone)।

**ফাইল: `packages/ui/src/components/popover.tsx`** (নতুন ফাইল)

```tsx
import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 rounded-control border border-line bg-surface p-3 shadow-lg outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
```

- মেনুর মতো একই কারণে Portal আর `shadow-lg`; `p-3` কারণ ভেতরে ক্যালেন্ডার বসে।
- `outline-none` — খোলার পর Radix focus content-এ নেয় (ক্যালেন্ডারের দিন-বাটনে যায়, `autoFocus`), পুরো বাক্যে
  ring দেখানোর দরকার নেই।

**ফাইল: `packages/ui/src/components/toast.tsx`** (নতুন ফাইল)

```tsx
import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';

// CLAUDE.md → Toast: ink পটভূমি, bg লেখা, ১০px কোণ, shadow-lg, নিচে মাঝখানে, ~৩ সেকেন্ড।
// unstyled: sonner-এর নিজের রং/কোণ বাদ, শুধু আমাদের token — dark mode-এ ink নিজেই উল্টে যায়
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-center"
      duration={3000}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-center gap-2.5 rounded-control bg-ink px-4 py-3 text-body-sm font-medium text-bg shadow-lg',
        },
      }}
    />
  );
}

// sonner-এর পুরো API বাইরে না দিয়ে একটাই ফাংশন: পরে লাইব্রেরি বদলালে শুধু এই ফাইল বদলাবে।
// লেখা হবে কী ঘটল তা ("Workspace created") — CLAUDE.md
export function toast(message: string): void {
  sonnerToast(message);
}
```

**কোন লাইন কেন:**

- sonner — shadcn-এর এখনকার ডিফল্ট toast। সারি, তিন সেকেন্ড পরে মুছে যাওয়া, hover-এ থেমে থাকা, swipe করে সরানো,
  `aria-live` — সব তৈরি।
- `unstyled: true` + `classNames.toast` — sonner-এর নিজের সাদা কার্ড বাদ, CLAUDE.md-এর চেহারা: `bg-ink text-bg`
  (হালকা থিমে গাঢ় toast)। dark থিমে `ink` নিজেই হালকা হয়ে যায়, তাই toast উল্টে যায় — আলাদা কোড লাগেনি।
- `position="bottom-center"`, `duration={3000}` — CLAUDE.md → Toast।
- `toast(message: string)` — sonner-এর পুরো API (`toast.success`, `toast.promise` …) বাইরে দেওয়া হয়নি। একটাই
  ফাংশন মানে (১) লাইব্রেরি বদলালে শুধু এই ফাইল বদলাবে, (২) কেউ `toast.error` দিয়ে লাল toast বানাতে পারবে না —
  error-এর জায়গা ফর্মের ভেতরে, আইকন + লেখা সহ।

---

## ৪.৫ — ফর্ম: Field, TextField, FormField, MoneyInput, DatePicker

দুই রকম input, তাই react-hook-form-এর সাথে জোড়ার দুই পথ:

- **সাধারণ `<input>` (লেখা, ইমেইল, পাসওয়ার্ড)** → `TextField` + `register('email')`। react-hook-form DOM-এর
  input সরাসরি পড়ে (uncontrolled) — টাইপ করার সময় React re-render-ই হয় না। ERP-র ৩০-ফিল্ডের ফর্মে এটাই দ্রুত।
- **নিজস্ব control (টাকা, তারিখ)** → `FormField` + `useController`। এদের মান DOM-এ সরাসরি থাকে না (MoneyInput-এ
  দেখানো লেখা `18,42,600.50`, আসল মান `"1842600.50"`), তাই controlled।

**ফাইল: `packages/ui/src/components/field.tsx`** (নতুন ফাইল — ধাপ ৩-এর `text-field.tsx`-এর জায়গায়)

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '../lib/cn.js';

// control-এর aria-describedby: error থাকলে স্ক্রিন রিডার error পড়বে, নাহলে hint
export function describedBy(
  id: string,
  error: string | undefined,
  hint: string | undefined,
): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export interface FieldProps {
  id: string;
  label: string;
  // `| undefined`: exactOptionalPropertyTypes-এ caller নিজের optional prop সরাসরি পাঠাতে পারে
  optional?: boolean | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}

// সব ফর্ম-ফিল্ডের একই কাঠামো: উপরে label, মাঝে control, নিচে error (নয়তো hint)
export function Field({ id, label, optional = false, hint, error, children }: FieldProps) {
  const { t } = useLocale();
  return (
    // content-start: পাশের ফিল্ডে hint থাকলে grid-এর সারি উঁচু হয়; তখন এই ফিল্ডের ভেতরের
    // সারিগুলো টেনে লম্বা না করে উপরে জড়ো থাকে — ইনপুটের উচ্চতা সব জায়গায় ৪২px
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink">
        {label}
        {optional && <span className="font-normal text-ink-3"> {t('common.optional')}</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-label text-ink-3">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

// input আর date picker-এর বাটন — দুটোই দেখতে একই বাক্স, তাই class এক জায়গায়
export function controlBoxClass(invalid: boolean): string {
  return cn(
    'flex min-h-[42px] items-center gap-2.5 rounded-control border bg-surface px-3 shadow-sm transition-[border-color,box-shadow] duration-150',
    invalid
      ? 'border-crit focus-within:shadow-ring-crit'
      : 'border-line-strong hover:border-ink-3 focus-within:border-brand focus-within:shadow-ring',
  );
}

// `prefix` HTML-এর নিজস্ব attribute (RDFa) — এখানে অন্য মানে, তাই Omit করে নতুন করে বলা
export interface InputProps extends Omit<ComponentProps<'input'>, 'className' | 'prefix'> {
  icon?: IconSvgElement | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
  trailing?: ReactNode;
  invalid?: boolean | undefined;
  align?: 'start' | 'end';
}

export function Input({
  icon,
  prefix,
  suffix,
  trailing,
  invalid = false,
  align = 'start',
  ...input
}: InputProps) {
  return (
    <div className={controlBoxClass(invalid)}>
      {icon && (
        <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
      )}
      {prefix && <span className="text-body text-ink-2">{prefix}</span>}
      <input
        aria-invalid={invalid || undefined}
        className={cn(
          'min-w-0 flex-1 bg-transparent py-2.5 text-body outline-none placeholder:text-ink-3',
          // টাকার মতো সংখ্যা ডানে মেলানো, আর প্রতিটা অঙ্ক সমান চওড়া — কলামে সারি মেলে
          align === 'end' && 'text-right tabular-nums',
        )}
        {...input}
      />
      {suffix && <span className="text-body-sm whitespace-nowrap text-ink-3">{suffix}</span>}
      {trailing}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputProps, 'invalid' | 'id'> {
  label: string;
  id?: string;
  optional?: boolean | undefined;
  hint?: string | undefined;
  // exactOptionalPropertyTypes: caller `errors.email?.message` (string | undefined) সরাসরি দিতে পারে
  error?: string | undefined;
}

// react-hook-form-এর register('email') সরাসরি spread করা যায়: name, ref, onChange, onBlur
export function TextField({ id, label, optional, hint, error, ...input }: TextFieldProps) {
  const autoId = useId();
  // register() id দেয় না, name দেয় — label-এর htmlFor-এর জন্য সেটাই যথেষ্ট
  const fieldId = id ?? input.name ?? autoId;
  return (
    <Field id={fieldId} label={label} optional={optional} hint={hint} error={error}>
      <Input
        id={fieldId}
        invalid={Boolean(error)}
        aria-describedby={describedBy(fieldId, error, hint)}
        {...input}
      />
    </Field>
  );
}
```

**কোন লাইন কেন:**

- ধাপ ৩-এর `TextField` তিন ভাগে: `Field` (label + error/hint-এর কাঠামো), `Input` (বাক্স), `TextField` (দুটো একসাথে)।
  কারণ `MoneyInput` আর `DatePicker`-এরও একই label আর error লাগে, কিন্তু বাক্সের ভেতরটা আলাদা।
- `describedBy()` — control-এর `aria-describedby` error থাকলে error-এর id, নাহলে hint-এর id। স্ক্রিন রিডার ফিল্ডে
  ঢুকেই "Enter the LC amount." পড়ে — শুধু লাল border দেখে অন্ধ ব্যবহারকারী কিছু বুঝত না।
- `optional?: boolean | undefined` (শুধু `?:` না) — `exactOptionalPropertyTypes` চালু। `TextField` নিজের
  `optional` (যার টাইপ `boolean | undefined`) সরাসরি `Field`-এ পাঠায়; `| undefined` না থাকলে সেটা compile error।
- `grid content-start` — **যাচাইয়ে পাওয়া bug-এর সমাধান।** দুই-কলামের ফর্মে পাশের ফিল্ডে hint থাকলে grid-এর সারি
  উঁচু হয়; `content-start` ছাড়া এই ফিল্ডের ভেতরের সারিগুলোও টেনে লম্বা হতো, আর input বাক্স ৪২px-এর বদলে ৫৬px
  দেখাত।
- `"(optional)"` `t('common.optional')` দিয়ে — এই কারণেই ui `@omnivo/i18n` ব্যবহার করে।
- `controlBoxClass()` আলাদা ফাংশন — `DatePicker`-এর trigger একটা `<button>`, `<input>` না, কিন্তু দেখতে হুবহু
  এক হতে হবে। hover-এ `border-ink-3`, focus-এ `border-brand` + `shadow-ring`, error-এ `border-crit` +
  `shadow-ring-crit` — CLAUDE.md → Input।
- `focus-within:` — focus আসলে ভেতরের `<input>`-এ, কিন্তু ring আঁকতে হবে বাইরের বাক্সে (আইকন আর suffix সহ)।
- `InputProps`-এ `Omit<…, 'prefix'>` — `prefix` HTML-এর নিজস্ব attribute (RDFa-র), টাইপ `string`। আমরা একই নামে
  "বাক্সের ভেতরে বাঁয়ে লেখা" (`৳`, `+880`) বোঝাচ্ছি; Omit না করলে দুটো মানে মিশে যেত।
- `align === 'end'` → `text-right tabular-nums` — টাকা ডানে, প্রতিটা অঙ্ক সমান চওড়া (CLAUDE.md → Typography)।
- `TextField`-এ `id ?? input.name ?? autoId` — `register('email')` দেয় `name`, `id` না। label-এর `htmlFor`-এর জন্য
  `name`-ই id হিসেবে যথেষ্ট; দুটোই না থাকলে `useId()`। `useId()` শর্ত ছাড়া সবসময় ডাকা (hook-এর নিয়ম),
  ব্যবহার হয় দরকার হলে।
- `{...input}` সবশেষে — `register()`-এর `ref`, `onChange`, `onBlur`, `name` সরাসরি `<input>`-এ পৌঁছায়। React 19-এ
  `ref` সাধারণ prop, তাই `forwardRef` ছাড়াই react-hook-form input-টা ধরতে পারে (error হলে focus দেয়)।

**ফাইল: `packages/ui/src/components/form-field.tsx`** (নতুন ফাইল)

```tsx
import type { ReactNode } from 'react';
import {
  type Control,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  useController,
} from 'react-hook-form';

import { describedBy, Field } from './field.js';

export type FormFieldControlProps<
  TValues extends FieldValues,
  TName extends FieldPath<TValues>,
> = ControllerRenderProps<TValues, TName> & {
  id: string;
  invalid: boolean;
  'aria-describedby': string | undefined;
};

interface FormFieldProps<
  TValues extends FieldValues,
  TName extends FieldPath<TValues>,
  TTransformed,
> {
  // TTransformed: zodResolver-এর output টাইপ (trim/transform-এর পরে) input থেকে আলাদা হতে পারে
  control: Control<TValues, unknown, TTransformed>;
  // FieldPath<TValues>: শুধু ফর্মে আসলেই আছে এমন নাম — 'emial' লিখলে compile error
  name: TName;
  label: string;
  optional?: boolean | undefined;
  hint?: string | undefined;
  children: (control: FormFieldControlProps<TValues, TName>) => ReactNode;
}

// নিজস্ব control (MoneyInput, DatePicker) react-hook-form-এর সাথে জোড়া: মান, error আর
// label-এর id এক জায়গায়। সাধারণ টেক্সট ইনপুটে এটা লাগে না — TextField-এ register() যথেষ্ট
export function FormField<
  TValues extends FieldValues,
  TName extends FieldPath<TValues>,
  TTransformed = TValues,
>({
  control,
  name,
  label,
  optional,
  hint,
  children,
}: FormFieldProps<TValues, TName, TTransformed>) {
  const { field, fieldState } = useController({ control, name });
  const error = fieldState.error?.message;
  // ফর্মের ভেতরে name অনন্য; একই পেজে দুটো ফর্মে একই name থাকলে পরে useId() যোগ করতে হবে
  const id = name;
  return (
    <Field id={id} label={label} optional={optional} hint={hint} error={error}>
      {children({
        ...field,
        id,
        invalid: error !== undefined,
        'aria-describedby': describedBy(id, error, hint),
      })}
    </Field>
  );
}
```

**কোন লাইন কেন:**

- `name: TName` যেখানে `TName extends FieldPath<TValues>` — ফর্মের মানের টাইপ (Zod schema থেকে) জানে কোন নাম বৈধ;
  `name="amout"` compile error।
- `children`-এর প্যারামিটার `ControllerRenderProps<TValues, TName>` — `value`-এর টাইপ সেই ফিল্ডের টাইপ। `MoneyInput`
  চায় `value: string`; schema-তে ফিল্ডটা `number` হলে `{(field) => <MoneyInput {...field} />}` compile error। ভুল
  control ভুল ফিল্ডে বসানো যায় না।
- `TTransformed` generic আর `Control<TValues, unknown, TTransformed>` — `zodResolver` দিয়ে বানানো ফর্মের `control`-এর
  টাইপে তিনটা প্যারামিটার: input-এর আকার, context, আর Zod transform-এর পরের আকার (যেমন `.trim()`)। শুধু
  `Control<TValues>` লিখলে তৃতীয়টা ধরা হতো `TValues`, আর schema-তে transform থাকলে `control={control}` compile
  error দিত।
- render prop (`children` ফাংশন) — FormField জানে না ভেতরে কোন control, শুধু মান/error/id জোড়ে। যেকোনো নতুন
  control (পরে `Select`) কোনো বদল ছাড়াই বসে।
- `id = name` — একই পেজে দুটো ফর্মে একই `name` থাকলে id মিলে যাবে; তখন `useId()` prefix যোগ করতে হবে। এখন
  প্রতি পেজে একটা ফর্ম, তাই পড়তে-সহজ id (`#amount-error`) রাখা।

**ফাইল: `packages/ui/src/components/money-input.tsx`** (নতুন ফাইল)

```tsx
import { formatNumber } from '@omnivo/i18n';
import { useState } from 'react';

import { isMoneyDraft, normalizeMoneyInput, toCanonicalMoney } from '../lib/money.js';
import { Input, type InputProps } from './field.js';

interface MoneyInputProps extends Omit<
  InputProps,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'prefix' | 'align'
> {
  // টাকা কখনো number না — string, যেমন DB-র NUMERIC(19,4) আর contracts-এর schema
  value: string;
  onChange: (value: string) => void;
  // দশমিকের ঘর: টাকা ২, unit price চাইলে ৪
  scale?: number;
}

export function MoneyInput({
  value,
  onChange,
  onFocus,
  onBlur,
  scale = 2,
  ...props
}: MoneyInputProps) {
  // null = এখন লেখা হচ্ছে না, তাই গোছানো রূপ দেখাও; string = ইউজার যা টাইপ করছে হুবহু
  const [draft, setDraft] = useState<string | null>(null);

  // টাইপের সময় কমা বসালে cursor লাফিয়ে যেত — তাই গ্রুপিং শুধু focus ছাড়লে।
  // ইনপুটে সবসময় ইংরেজি অঙ্ক (en): বাংলা অঙ্কে সম্পাদনা অনেক কীবোর্ডে ঝামেলার
  const display = draft ?? (value === '' ? '' : formatNumber(value, 'en', scale));

  return (
    <Input
      {...props}
      type="text"
      // ফোনে সংখ্যার কীবোর্ড, দশমিক বিন্দু সহ (system-design §৮.১)
      inputMode="decimal"
      autoComplete="off"
      prefix="৳"
      align="end"
      value={display}
      onFocus={(event) => {
        // সার্ভারের "1842600.5000" (৪ ঘর) এলেও সম্পাদনা শুরু হয় scale-এর রূপে, নইলে
        // isMoneyDraft প্রতিটা কী চাপ আটকে দিত
        setDraft(value === '' ? '' : toCanonicalMoney(value, scale));
        onFocus?.(event);
      }}
      onChange={(event) => {
        const next = normalizeMoneyInput(event.target.value);
        // অবৈধ কী চাপ (অক্ষর, দ্বিতীয় বিন্দু, তৃতীয় দশমিক) চুপচাপ উপেক্ষা — লেখা বদলায় না
        if (!isMoneyDraft(next, scale)) return;
        setDraft(next);
        // প্রতিটা কী চাপে canonical মান ফর্মে: focus-এ থেকেই Enter চাপলে blur হয় না,
        // তখনও "12." না, "12.00" জমা পড়বে
        onChange(toCanonicalMoney(next, scale));
      }}
      onBlur={(event) => {
        setDraft(null);
        onBlur?.(event);
      }}
    />
  );
}
```

**কোন লাইন কেন:**

- `value: string` — টাকা কখনো `number` না (ভিত্তি-সিদ্ধান্ত ৮)।
- `draft` state: `null` = কেউ লিখছে না → গোছানো রূপ (`18,42,600.50`); `string` = ইউজার যা টাইপ করছে হুবহু।
  টাইপের সময়ই কমা বসালে প্রতিটা কী চাপে লেখার দৈর্ঘ্য বদলাত আর cursor শেষে লাফিয়ে যেত — মাঝখানে একটা অঙ্ক
  ঠিক করা অসম্ভব হতো।
- ইনপুটে সবসময় ইংরেজি অঙ্ক (`formatNumber(value, 'en', …)`), বাংলা ভাষাতেও — বাংলা অঙ্কে cursor-এর মাঝখানে
  সম্পাদনা অনেক কীবোর্ডে ঝামেলার। কিন্তু **লেখা যায় বাংলা অঙ্কে** (`normalizeMoneyInput`), আর টেবিল/রিপোর্টে
  দেখানো হয় ভাষা অনুযায়ী।
- `inputMode="decimal"` — ফোনে দশমিক বিন্দু সহ সংখ্যার কীবোর্ড (system-design §৮.১)। `type="number"` না: সেটা
  কমা নেয় না, স্ক্রল করলে মান বদলে যায়, আর ফাঁকা/অসম্পূর্ণ লেখা `""` হিসেবে দেয়।
- `onFocus`-এ `toCanonicalMoney(value, scale)` — সার্ভার NUMERIC(19,4) থেকে `"1842600.5000"` পাঠালে সম্পাদনা শুরু
  হয় `"1842600.50"` থেকে; নাহলে `isMoneyDraft` (৪ ঘর দশমিক > scale ২) প্রতিটা কী চাপ আটকে দিত।
- `onChange`-এ অবৈধ লেখা হলে `return` — অক্ষর চাপলে কিছুই হয় না (যাচাই করা: `abc` টাইপের পর মান অপরিবর্তিত)।
  controlled input, তাই `setDraft` না ডাকলে DOM-এর লেখাও আগের জায়গায় ফেরে।
- **প্রতিটা কী চাপে** `onChange(toCanonicalMoney(next, scale))`, শুধু blur-এ না — ফিল্ডে থেকেই Enter চাপলে ফর্ম
  জমা পড়ে কিন্তু blur হয় না। শুধু blur-এ canonical করলে তখন `"12."` জমা যেত, আর Zod regex
  ("Enter the LC amount.") ভুল error দিত।
- `onFocus?.(event)`, `onBlur?.(event)` — caller (FormField) নিজের handler দিলে সেটাও চলে; react-hook-form
  "touched" জানে `onBlur` থেকে।

**ফাইল: `packages/ui/src/components/date-picker.tsx`** (নতুন ফাইল)

```tsx
import { ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type Ref, useState } from 'react';
import { type ChevronProps, DayPicker } from 'react-day-picker';
import { bn } from 'react-day-picker/locale/bn';
import { enUS } from 'react-day-picker/locale/en-US';

import { cn } from '../lib/cn.js';
import { parseIsoDate, toIsoDate } from '../lib/iso-date.js';
import { controlBoxClass } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

// react-day-picker-এর নিজের SVG তীরের বদলে HugeIcons (CLAUDE.md rule ৪: আইকন একটাই লাইব্রেরি)
function Chevron({ orientation }: ChevronProps) {
  return (
    <HugeiconsIcon
      icon={orientation === 'left' ? ArrowLeft01Icon : ArrowRight01Icon}
      size={16}
      strokeWidth={1.5}
    />
  );
}

interface DatePickerProps {
  id?: string;
  name?: string;
  // "2026-09-23" অথবা "" (খালি)
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  // FormField-এর field.ref: error হলে react-hook-form এই বাটনে focus নেয়
  ref?: Ref<HTMLButtonElement>;
  invalid?: boolean;
  disabled?: boolean | undefined;
  placeholder?: string;
  'aria-describedby'?: string | undefined;
}

export function DatePicker({
  id,
  name,
  value,
  onChange,
  onBlur,
  ref,
  invalid = false,
  disabled,
  placeholder,
  'aria-describedby': ariaDescribedBy,
}: DatePickerProps) {
  const { t, language, format } = useLocale();
  const [open, setOpen] = useState(false);
  const selected = parseIsoDate(value);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // পপওভার বন্ধ হওয়া = ফিল্ড ছেড়ে যাওয়া; react-hook-form "touched" এখান থেকে জানে
        if (!next) onBlur?.();
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={ref}
          id={id}
          name={name}
          type="button"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={ariaDescribedBy}
          className={cn(controlBoxClass(invalid), 'w-full py-2.5 text-left text-body')}
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            size={17}
            strokeWidth={1.5}
            className="shrink-0 text-ink-3"
          />
          {selected ? (
            <span className="tabular-nums">{format.date(selected)}</span>
          ) : (
            <span className="text-ink-3">{placeholder ?? t('ui.datePicker.placeholder')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <DayPicker
          mode="single"
          selected={selected}
          // খুললে বাছাই করা মাস দেখায়, খালি থাকলে এই মাস। `?? new Date()`: exactOptionalPropertyTypes-এ
          // defaultMonth-এ undefined পাঠানো যায় না
          defaultMonth={selected ?? new Date()}
          onSelect={(date) => {
            onChange(date ? toIsoDate(date) : '');
            setOpen(false);
          }}
          // মাস/দিনের নাম আর aria-label ভাষা অনুযায়ী; numerals='beng' দিনের সংখ্যা বাংলা অঙ্কে
          locale={language === 'bn' ? bn : enUS}
          numerals={language === 'bn' ? 'beng' : 'latn'}
          showOutsideDays
          autoFocus
          components={{ Chevron }}
          // react-day-picker-এর CSS import করা হয়নি — সব চেহারা token দিয়ে এখানে
          classNames={{
            root: 'text-body-sm',
            months: 'relative',
            month_caption: 'flex h-8 items-center justify-center font-medium text-ink',
            nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between',
            button_previous:
              'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
            button_next:
              'grid size-8 place-items-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
            month_grid: 'mt-2 border-collapse',
            weekday: 'size-9 text-caption font-medium text-ink-3',
            day: 'p-0 text-center',
            day_button:
              'grid size-9 place-items-center rounded-lg tabular-nums text-ink transition-colors duration-150 hover:bg-subtle',
            // today/selected/outside বসে td-তে, রং দরকার ভেতরের বাটনে
            today: '[&>button]:font-semibold [&>button]:text-brand',
            selected:
              '[&>button]:bg-brand [&>button]:text-brand-ink [&>button]:hover:bg-brand-hover',
            outside: '[&>button]:text-ink-3',
            disabled: 'opacity-40',
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
```

**কোন লাইন কেন:**

- `Chevron` override — react-day-picker মাস বদলানোর তীর নিজের inline SVG-তে আঁকে। CLAUDE.md rule ৪: আইকন শুধু
  HugeIcons, inline SVG আইকন-সেট না। `components={{ Chevron }}` দিয়ে বদলানো।
- `locale/bn` আর `locale/en-US` আলাদা ফাইল থেকে import — `react-day-picker/locale` (৮০-র বেশি ভাষার barrel)
  থেকে নিলে production-এ tree-shaking-এর ভরসায় থাকতে হতো, আর `pnpm dev`-এ (যেখানে tree-shaking নেই) সব ভাষা
  লোড হতো। এই locale-এ মাস/দিনের নাম **আর** বাটনের aria-label দুটোই অনুবাদ করা থাকে।
- `numerals={language === 'bn' ? 'beng' : 'latn'}` — locale মাসের নাম বাংলা করে, কিন্তু দিনের সংখ্যা ইংরেজি অঙ্কেই
  রাখে; `'beng'` দিলে `২৮` (screenshot-এ যাচাই করা)।
- `value` string (`"2026-09-23"` বা `""`) — `parseIsoDate`/`toIsoDate` দিয়ে `Date`-এ আনা-নেওয়া (৪.২-এ কেন local)।
- trigger একটা `<button>`, দেখতে `controlBoxClass` — `<label htmlFor>` বাটনকেও চেনে, তাই "Latest shipment date"
  লেখায় ক্লিক করলেও ক্যালেন্ডার খোলে।
- `ref?: Ref<HTMLButtonElement>` prop — `FormField` থেকে `field.ref` আসে; submit-এ এই ফিল্ডে error থাকলে
  react-hook-form এই বাটনে focus নেয়। React 19-এ function component-এর `ref` সাধারণ prop।
- `open` নিজে নিয়ন্ত্রণ — দিন বাছলেই (`onSelect`) বন্ধ করতে হয়; Radix নিজে জানে না কখন "বাছাই শেষ"।
- `onOpenChange`-এ বন্ধ হলে `onBlur?.()` — popover বন্ধ = ফিল্ড ছেড়ে যাওয়া। react-hook-form-এর touched/blur-এ
  যাচাই এখান থেকেই চলে।
- `defaultMonth={selected ?? new Date()}` — `exactOptionalPropertyTypes`-এ `defaultMonth`-এ `undefined` পাঠানো যায়
  না (compile error); খালি থাকলে এই মাস।
- `autoFocus` — খুললেই focus ক্যালেন্ডারের দিনে; তীর-কী দিয়ে দিন বদলানো, Enter-এ বাছাই।
- `classNames` — react-day-picker-এর নিজের CSS import করা হয়নি (তার রং আর মাপ আমাদের না)। `today`, `selected`,
  `outside` class বসে `<td>`-তে, কিন্তু রং দরকার ভেতরের `<button>`-এ — তাই `[&>button]:` arbitrary variant।

---

## ৪.৬ — `AppShell`: সাইডবার, টপ বার, nav

**ফাইল: `packages/ui/src/components/app-shell.tsx`** (নতুন ফাইল — ধাপ ৩-এর `routes/app-shell.tsx`-এর লেআউট অংশ)

```tsx
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

interface AppShellProps {
  // সাইডবারের মাথায় (ডেস্কটপ) / টপ বারের বাঁয়ে (ফোন) — সাধারণত <Logo />
  brand: ReactNode;
  // শুধু ফোনে, টপ বারের ডানে (যেমন user menu) — ডেস্কটপে সেই কাজ sidebarFooter-এর
  topBarActions?: ReactNode;
  // workspace switcher
  sidebarHeader?: ReactNode;
  nav: ReactNode;
  // শুধু ডেস্কটপে, সাইডবারের তলায়
  sidebarFooter?: ReactNode;
  children: ReactNode;
}

// CLAUDE.md → Layout: ২৪৪px সাইডবার + বাকিটা content; ৮৬০px-এর নিচে সাইডবার উপরে টপ বার হয়ে
// যায় আর nav আড়াআড়ি। ui রাউটার চেনে না — লিংক, ইউজার, টেন্যান্ট সব app slot-এ পাঠায়
export function AppShell({
  brand,
  topBarActions,
  sidebarHeader,
  nav,
  sidebarFooter,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-dvh min-[860px]:grid min-[860px]:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3 border-b border-line bg-surface px-4 pt-3 min-[860px]:sticky min-[860px]:top-0 min-[860px]:h-dvh min-[860px]:gap-5 min-[860px]:border-r min-[860px]:border-b-0 min-[860px]:px-3 min-[860px]:py-5">
        <div className="flex items-center justify-between gap-3 px-2">
          {brand}
          {topBarActions && <div className="min-[860px]:hidden">{topBarActions}</div>}
        </div>
        {sidebarHeader}
        {nav}
        {sidebarFooter && (
          <div className="mt-auto hidden border-t border-line pt-4 min-[860px]:block">
            {sidebarFooter}
          </div>
        )}
      </aside>
      {/* min-w-0: grid-এর ভেতরে চওড়া টেবিল কলামটাকে ঠেলে বড় করতে না পারে — পেজ আড়াআড়ি scroll হয় না */}
      <main className="min-w-0 px-4 py-6 min-[860px]:px-8 min-[860px]:py-8">{children}</main>
    </div>
  );
}

export function SidebarNav({ label, children }: { label: string; children: ReactNode }) {
  return (
    // ফোনে এক সারিতে, নিজের ভেতরে আড়াআড়ি scroll; -mx-4 px-4: scroll কিনারা পর্যন্ত যায়
    <nav
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 min-[860px]:mx-0 min-[860px]:grid min-[860px]:gap-4 min-[860px]:overflow-visible min-[860px]:px-0 min-[860px]:pb-0"
    >
      {children}
    </nav>
  );
}

export function NavGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    // ফোনে `contents`: group-এর বাক্স মুছে item-গুলো সরাসরি nav-এর সারিতে বসে
    <div className="contents min-[860px]:grid min-[860px]:gap-px">
      {label && (
        <p className="hidden px-2.5 pb-1 text-[11.5px] font-medium text-ink-3 min-[860px]:block">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

interface NavItemProps extends ComponentProps<'a'> {
  icon: IconSvgElement;
  count?: number | undefined;
  // CLAUDE.md: কাজ বাকি থাকলে সংখ্যা crit রঙে
  countTone?: 'neutral' | 'crit';
}

// সাধারণ <a> — app-এ TanStack Router-এর createLink(NavItem) দিয়ে টাইপ-চেকড লিংক বানায়।
// Link সক্রিয় রুটে aria-current="page" বসায়; সেটা দেখেই রং, আলাদা isActive prop লাগে না
export function NavItem({
  icon,
  count,
  countTone = 'neutral',
  className,
  children,
  ...props
}: NavItemProps) {
  return (
    <a
      className={cn(
        'group flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium whitespace-nowrap text-ink-2 transition-colors duration-150 hover:bg-subtle aria-[current=page]:bg-brand-soft aria-[current=page]:text-brand',
        className,
      )}
      {...props}
    >
      <HugeiconsIcon
        icon={icon}
        size={18}
        strokeWidth={1.5}
        className="shrink-0 text-ink-3 group-aria-[current=page]:text-brand"
      />
      <span className="truncate">{children}</span>
      {count !== undefined && (
        <span
          className={cn(
            'ml-auto pl-2 text-caption tabular-nums',
            countTone === 'crit' ? 'text-crit' : 'text-ink-3',
          )}
        >
          {count}
        </span>
      )}
    </a>
  );
}
```

**কোন লাইন কেন:**

- slot (`brand`, `topBarActions`, `sidebarHeader`, `nav`, `sidebarFooter`) — ui জানে **কোথায়** কী বসবে, **কী** বসবে
  জানে app। ধাপ ২৩-এর `apps/admin` একই shell-এ অন্য nav আর অন্য user মেনু বসাবে।
- `min-[860px]:grid-cols-[244px_minmax(0,1fr)]` — CLAUDE.md-এর ২৪৪px সাইডবার। `minmax(0,1fr)`, শুধু `1fr` না:
  `1fr`-এর ন্যূনতম মাপ "content যত চওড়া", তাই চওড়া টেবিল কলামটাকে ঠেলে পেজ আড়াআড়ি scroll করাত।
- `<main className="min-w-0 …">` — একই কারণে দ্বিতীয় পাহারা (grid item-এর ডিফল্ট `min-width: auto`)।
- সাইডবার `sticky top-0 h-dvh` — লম্বা পেজ scroll করলেও সাইডবার জায়গায় থাকে। `dvh`: ফোনের ব্রাউজারে address bar
  লুকালে/দেখালে `vh` ভুল উচ্চতা দেয়, `dvh` দেয় না।
- `topBarActions` শুধু `<860px`-এ, `sidebarFooter` শুধু ডেস্কটপে — ফোনে সাইডবারের তলা নেই, তাই user মেনু টপ বারের
  ডানে সরে যায়।
- `SidebarNav`: ফোনে `flex overflow-x-auto` (CLAUDE.md: horizontal nav), ডেস্কটপে `grid`। `-mx-4 px-4` — scroll
  করা সারি স্ক্রিনের কিনারা পর্যন্ত যায়, কিন্তু প্রথম item ১৬px gutter থেকে শুরু।
- `NavGroup`-এ ফোনে `contents` — CSS `display: contents` গ্রুপের নিজের বাক্স মুছে দেয়, item গুলো সরাসরি nav-এর
  আড়াআড়ি সারিতে বসে; গ্রুপের লেবেল ফোনে লুকানো।
- `NavItem` একটা সাধারণ `<a>` + `ComponentProps<'a'>` — ui রাউটার চেনে না। app `createLink(NavItem)` দিয়ে এটাকে
  TanStack-এর লিংক বানায় (৪.৯)। TanStack Link সক্রিয় রুটে `aria-current="page"` বসায় (সোর্সে যাচাই করা:
  `props["aria-current"] = "page"`), তাই রং বদলায় `aria-[current=page]:` দিয়ে — আলাদা `isActive` prop লাগে না,
  আর স্ক্রিন রিডারও "current page" পড়ে।
- `group` + `group-aria-[current=page]:text-brand` — আইকন সাধারণত `ink-3`, সক্রিয় লিংকে `brand` (CLAUDE.md →
  Sidebar nav)। আইকন নিজে `aria-current` পায় না, তাই parent-এর অবস্থা `group` দিয়ে দেখা।
- `count`/`countTone` — CLAUDE.md: "Counts are right-aligned (crit when they need action)"। এখন ব্যবহার নেই;
  ধাপ ১৫-এ "৩টা বকেয়া ইনভয়েস" এখানে বসবে।

---

## ৪.৭ — `DataTable`: TanStack Table v9 + Virtual, ফোনে কার্ড

ERP-র ৮০% স্ক্রিন টেবিল। এই component-টাই পরের প্রতিটা তালিকা-পেজ (প্রোডাক্ট, ইনভয়েস, স্টক) বানাবে।

**ফাইল: `packages/ui/src/components/data-table.tsx`** (নতুন ফাইল)

```tsx
import { ArrowDown01Icon, ArrowUp01Icon, ArrowUpDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import {
  type Column,
  createColumnHelper,
  createSortedRowModel,
  type Header,
  metaHelper,
  type ReactTable,
  type Row,
  type RowData,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  type TableOptions,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '../lib/cn.js';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/use-media-query.js';

export interface DataTableColumnMeta {
  // CLAUDE.md: সংখ্যা ডানে
  align?: 'start' | 'end';
  // ফোনে কার্ডের কোন জায়গায় বসবে। না দিলে কার্ডে দেখাবে না — ফোনে ২–৩টা জরুরি তথ্যই যথেষ্ট
  card?: 'title' | 'subtitle' | 'trailing' | 'detail';
}

// v9-এ feature গুলো স্পষ্ট করে নিবন্ধন করতে হয় — যেটা নেই তার কোড bundle-এও যায় না।
// columnMeta: শুধু টাইপ (runtime-এ কিছু না), column-এর meta এখন DataTableColumnMeta
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  // sortFn: 'auto' এই তিনটার মধ্যে থেকে বাছে; পুরো registry নিলে সব comparator bundle-এ যেত
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, text: sortFn_text },
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

type Features = typeof dataTableFeatures;

// app-এ column লেখার helper: accessor-এর key আর মানের টাইপ TData থেকে আসে
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<Features, TData>();
}

interface DataTableProps<TData extends RowData> {
  // স্ক্রিন রিডারের জন্য টেবিলের নাম (<caption>)
  label: string;
  // রেফারেন্স স্থির রাখুন (useMemo/state) — প্রতি render-এ নতুন array দিলে প্রতিবার আবার sort হয়
  data: TData[];
  // লাইব্রেরির নিজের option টাইপ — helper.columns([...]) যা ফেরত দেয় তা সরাসরি বসে
  columns: TableOptions<Features, TData>['columns'];
  // index না, আসল id: sort বা ডেটা বদলালেও একই রো একই key পায়
  getRowId: (row: TData) => string;
  // ডেটা খালি হলে (সাধারণত <EmptyState />)
  empty?: ReactNode;
  onRowClick?: ((row: TData) => void) | undefined;
  // ডেস্কটপে scroll বাক্সের সর্বোচ্চ উচ্চতা (px)
  maxHeight?: number;
  // নিচে "10,000 rows" — বড় তালিকায় কাজের, ৩ জনের টিমে শুধু গোলমাল
  showCount?: boolean;
}

// টেবিল নিজেই একটা কার্ড (border, কোণ, ছায়া) — তাই আরেকটা Card-এর ভেতরে না বসিয়ে
// section শিরোনামের নিচে সরাসরি বসান, নাহলে কার্ডের ভেতরে কার্ড হয় (CLAUDE.md: সব কিছু কার্ড না)
export function DataTable<TData extends RowData>({
  label,
  data,
  columns,
  getRowId,
  empty,
  onRowClick,
  maxHeight = 560,
  showCount = false,
}: DataTableProps<TData>) {
  const { t, format } = useLocale();
  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    getRowId: (row) => getRowId(row),
  });
  // দুই রকম DOM (টেবিল আর কার্ড), কারণ virtualizer-কে মাপার জন্য আসল দৃশ্যমান element লাগে —
  // CSS দিয়ে একটা লুকালে লুকানোটার উচ্চতা ০, virtualizer ভুল হিসাব করত
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const rows = table.getRowModel().rows;

  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className="grid gap-2">
      {isDesktop ? (
        <DesktopTable
          table={table}
          rows={rows}
          label={label}
          maxHeight={maxHeight}
          onRowClick={onRowClick}
        />
      ) : (
        <MobileCards rows={rows} table={table} label={label} onRowClick={onRowClick} />
      )}
      {showCount && (
        <p className="text-caption text-ink-3">
          {t('ui.dataTable.rowCount', {
            count: rows.length,
            formatted: format.number(rows.length),
          })}
        </p>
      )}
    </div>
  );
}

// ক্লিক করা যায় এমন রো/কার্ড কীবোর্ডেও খোলা যাবে: Enter বা Space
function activateOnKey(event: KeyboardEvent, activate: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activate();
  }
}

// কলামের নাম লেখায়: header string হলে সেটাই, template (JSX) হলে column id।
// লাগে দুই জায়গায় — sort বাটনের aria-label আর ফোনের কার্ডে "লেবেল: মান"
function columnLabel<TData extends RowData>(column: Column<Features, TData>): string {
  const header = column.columnDef.header;
  return typeof header === 'string' ? header : column.id;
}

interface ViewProps<TData extends RowData> {
  table: ReactTable<Features, TData>;
  rows: Row<Features, TData>[];
  label: string;
  onRowClick: ((row: TData) => void) | undefined;
}

// টেবিলের প্রতিটা রো প্রায় এত উঁচু: 13.5px × 1.45 লাইন + 24px padding + 1px রেখা
const ROW_HEIGHT = 45;

function DesktopTable<TData extends RowData>({
  table,
  rows,
  label,
  maxHeight,
  onRowClick,
}: ViewProps<TData> & { maxHeight: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    // দৃশ্যমানের বাইরেও কয়েকটা রো আগে থেকে — দ্রুত scroll-এ ফাঁকা ঝলক দেখা যায় না
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  // শুধু দৃশ্যমান রো DOM-এ; উপরে-নিচে ফাঁকা রো দিয়ে মোট উচ্চতা ঠিক রাখা, তাই scrollbar সঠিক।
  // <table> রাখা হয়েছে (div-grid না): কলামের চওড়া ব্রাউজার নিজে মেলায়, স্ক্রিন রিডারও টেবিল চেনে
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const columnCount = table.getAllLeafColumns().length;

  return (
    // overflow-auto: চওড়া টেবিল নিজের বাক্সে আড়াআড়ি scroll করে, পুরো পেজ না (CLAUDE.md)
    <div
      ref={scrollRef}
      className="overflow-auto rounded-card border border-line bg-surface shadow-sm"
      style={{ maxHeight }}
    >
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">{label}</caption>
        {/* sticky thead-এর border scroll-এ সরে যায়, তাই নিচের রেখা inset shadow দিয়ে */}
        <thead className="sticky top-0 z-10 bg-subtle shadow-[inset_0_-1px_0_var(--color-line)]">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <HeaderCell key={header.id} header={header} table={table} />
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingTop }} />
            </tr>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const open = onRowClick
              ? () => {
                  onRowClick(row.original);
                }
              : undefined;
            return (
              <tr
                key={row.id}
                // measureElement আসল উচ্চতা মাপে (লম্বা নাম দুই লাইনে গেলেও ঠিক থাকে);
                // data-index না দিলে কোন রো মাপা হলো virtualizer বুঝত না
                data-index={item.index}
                ref={virtualizer.measureElement}
                tabIndex={open ? 0 : undefined}
                onClick={open}
                onKeyDown={
                  open
                    ? (event) => {
                        activateOnKey(event, open);
                      }
                    : undefined
                }
                className={cn(
                  'border-t border-line transition-colors duration-150 first:border-t-0 hover:bg-subtle',
                  open && 'cursor-pointer',
                )}
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-5 py-3 whitespace-nowrap',
                      cell.column.columnDef.meta?.align === 'end' && 'text-right tabular-nums',
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columnCount} style={{ height: paddingBottom }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function HeaderCell<TData extends RowData>({
  header,
  table,
}: {
  header: Header<Features, TData>;
  table: ReactTable<Features, TData>;
}) {
  const { t } = useLocale();
  const column = header.column;
  const end = column.columnDef.meta?.align === 'end';
  const sorted = column.getIsSorted();
  const toggle = column.getToggleSortingHandler();
  const content = header.isPlaceholder ? null : <table.FlexRender header={header} />;

  return (
    <th
      scope="col"
      // স্ক্রিন রিডার এখান থেকে জানে কোন কলামে কোন দিকে সাজানো
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={cn(
        'px-5 py-2.5 text-caption font-medium whitespace-nowrap text-ink-3',
        end ? 'text-right' : 'text-left',
      )}
    >
      {column.getCanSort() && toggle ? (
        <button
          type="button"
          onClick={toggle}
          aria-label={t('ui.dataTable.sortBy', { column: columnLabel(column) })}
          className={cn('inline-flex items-center gap-1 hover:text-ink', end && 'flex-row-reverse')}
        >
          {content}
          <HugeiconsIcon
            icon={
              sorted === 'asc'
                ? ArrowUp01Icon
                : sorted === 'desc'
                  ? ArrowDown01Icon
                  : ArrowUpDownIcon
            }
            size={13}
            strokeWidth={1.5}
            className={sorted ? 'text-ink' : 'text-ink-3'}
          />
        </button>
      ) : (
        content
      )}
    </th>
  );
}

// ফোনের কার্ড-তালিকা পুরো পেজের scroll ব্যবহার করে (window virtualizer): ফোনে বাক্সের ভেতরে
// আলাদা scroll আঙুলে আটকে যায়, আর পেজের scroll-এর সাথে লড়াই করে
function MobileCards<TData extends RowData>({ table, rows, label, onRowClick }: ViewProps<TData>) {
  const listRef = useRef<HTMLUListElement>(null);
  // তালিকার শুরু পেজের উপর থেকে কত নিচে — window scroll থেকে এটা বাদ দিয়ে কোন কার্ড দেখা যাচ্ছে বোঝা যায়
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const top = listRef.current?.getBoundingClientRect().top ?? 0;
    setScrollMargin(top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 96,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 6,
    scrollMargin,
  });

  return (
    <ul
      ref={listRef}
      aria-label={label}
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <li
            key={row.id}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 top-0 pb-2"
            style={{ transform: `translateY(${String(item.start - scrollMargin)}px)` }}
          >
            <RowCard row={row} table={table} onRowClick={onRowClick} />
          </li>
        );
      })}
    </ul>
  );
}

function RowCard<TData extends RowData>({
  row,
  table,
  onRowClick,
}: {
  row: Row<Features, TData>;
  table: ReactTable<Features, TData>;
  onRowClick: ((row: TData) => void) | undefined;
}) {
  const cells = row.getAllCells();
  const slot = (name: DataTableColumnMeta['card']) =>
    cells.filter((cell) => cell.column.columnDef.meta?.card === name);
  const details = slot('detail');
  const open = onRowClick
    ? () => {
        onRowClick(row.original);
      }
    : undefined;

  return (
    <div
      // কার্ডের ভেতরে <dl> আছে, <button>-এর ভেতরে যা বসানো বৈধ না — তাই div + role="button"
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (event) => {
              activateOnKey(event, open);
            }
          : undefined
      }
      className="rounded-card border border-line bg-surface p-4 shadow-sm transition-colors duration-150"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-body-sm">
          {slot('title').map((cell) => (
            <div key={cell.id} className="font-medium text-ink">
              <table.FlexRender cell={cell} />
            </div>
          ))}
          {slot('subtitle').map((cell) => (
            <div key={cell.id} className="text-caption text-ink-3">
              <table.FlexRender cell={cell} />
            </div>
          ))}
        </div>
        <div className="shrink-0 text-right text-body-sm tabular-nums">
          {slot('trailing').map((cell) => (
            <div key={cell.id}>
              <table.FlexRender cell={cell} />
            </div>
          ))}
        </div>
      </div>
      {details.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3">
          {details.map((cell) => (
            <div key={cell.id} className="min-w-0">
              <dt className="text-caption text-ink-3">{columnLabel(cell.column)}</dt>
              <dd className="truncate text-body-sm">
                <table.FlexRender cell={cell} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
```

**কোন লাইন কেন — টেবিলের মডেল:**

- `DataTableColumnMeta` — column-এর সাথে আমাদের নিজের তথ্য: `align: 'end'` (সংখ্যা ডানে), আর `card` (ফোনের কার্ডে কোন
  জায়গায়)। `card` না দিলে কলামটা ফোনে দেখায় না — ১০ কলামের টেবিলের ফোনে ২–৩টা জরুরি তথ্যই যথেষ্ট
  (system-design §৮.১)।
- `tableFeatures({...})` — v9-এ sort, filter, pagination কিছুই ডিফল্টে নেই; যা লাগবে তা নিবন্ধন করতে হয়। ফলে যা
  নেওয়া হয়নি তার কোড bundle-এও যায় না (TanStack Table মাপা ~১৩ KB gz)। ধাপ ৫-এ pagination লাগলে এখানে এক লাইন।
- `sortFns`-এ শুধু তিনটা — `sortFn: 'auto'` string কলামে `alphanumeric`/`text`, সংখ্যায় `basic` বাছে। পুরো registry
  নিলে সব comparator bundle-এ যেত।
- `columnMeta: metaHelper<DataTableColumnMeta>()` — v9-এর নতুন পদ্ধতি: meta-র টাইপ এই feature-সেটের সাথে বাঁধা।
  v8-এর মতো `declare module '@tanstack/react-table' { interface ColumnMeta … }` দিয়ে global টাইপ বদলানোর দরকার নেই।
  runtime-এ এটা কিছুই না (phantom মান), শুধু টাইপ।
- `dataTableColumns<TData>()` — app-এ `column.accessor('value', …)` লিখলে `'value'` যে `TData`-র আসল key, আর
  `getValue()`-এর টাইপ `string`, সেটা এখান থেকেই আসে।
- `columns: TableOptions<Features, TData>['columns']` — লাইব্রেরির নিজের option টাইপ থেকে নেওয়া। `helper.columns([...])`
  যা ফেরত দেয় (ভেতরে লাইব্রেরি নিজে `ColumnDef<…, any>` ব্যবহার করে) তা সরাসরি বসে, আর আমাদের কোডে কোথাও
  `any` লিখতে হয়নি (rule ৩)।
- `getRowId` বাধ্যতামূলক — ডিফল্টে row id = index। sort করলে index বদলায়, তখন React ভুল রো-র DOM পুনর্ব্যবহার
  করত, আর virtualizer-এর মাপা উচ্চতা ভুল রো-তে বসত। আসল id (`membershipId`) দিলে রো যেখানেই যাক, key একই।
- `data` "রেফারেন্স স্থির রাখুন" — TanStack `data` বদলেছে কি না দেখে `===` দিয়ে। প্রতি render-এ নতুন array
  (`members ?? []`) দিলে প্রতি render-এ ১০,০০০ রো আবার sort হতো।
- `useMediaQuery(DESKTOP_QUERY)` দিয়ে **দুই রকম DOM**, CSS দিয়ে একটা লুকানো না — virtualizer scroll-বাক্সের
  আসল উচ্চতা মেপে ঠিক করে কোন রো দেখাবে। `display: none` দিয়ে লুকানো তালিকার উচ্চতা ০, সেটা ভুল হিসাব করত;
  আর দুটো তালিকা একসাথে DOM-এ রাখা মানে দ্বিগুণ কাজ।
- `showCount` (ডিফল্ট `false`) — "১০,০০০টি সারি" বড় তালিকায় কাজের; তিনজনের টিমে "1 row" শুধু গোলমাল
  (screenshot দেখে বন্ধ করা)।

**কোন লাইন কেন — ডেস্কটপ টেবিল (virtualization):**

- `useVirtualizer` — ১০,০০০ রো-র মধ্যে DOM-এ থাকে শুধু যা দেখা যাচ্ছে + `overscan` (যাচাই করা: ২২টা `<tr>`)।
  scroll করলে একই কয়েকটা `<tr>` নতুন ডেটা পায়। ছাড়া ১০,০০০ × ৭ = ৭০,০০০ cell — কম দামি ফোনে পেজ জমে যেত।
- `count: rows.length`, `data.length` না — `rows` sort/filter-এর **পরের** তালিকা। TanStack-এর নিজের নির্দেশিকার
  "HIGH" ভুলের একটা এটা।
- `ROW_HEIGHT = 45` শুধু অনুমান — আসল উচ্চতা মাপে `ref={virtualizer.measureElement}` (লম্বা নাম দুই লাইনে গেলেও ঠিক)।
  `data-index` না দিলে virtualizer জানত না কোন রো মাপা হলো।
- উপরে-নিচে ফাঁকা `<tr>` (`paddingTop`/`paddingBottom`) — না-দেখানো রো-গুলোর মোট উচ্চতা ধরে রাখে, তাই scrollbar-এর
  আকার আর অবস্থান ঠিক থাকে। TanStack-এর উদাহরণ `<tbody style="display:grid">` + absolute রো ব্যবহার করে; তাতে
  `<table>`-এর নিজের কলাম-চওড়া মেলানো ভেঙে যায় আর প্রতিটা কলামের width হাতে দিতে হয়। ফাঁকা-রো পদ্ধতিতে আসল
  টেবিল থাকে — কলাম ব্রাউজার নিজে মেলায়, স্ক্রিন রিডারও টেবিল হিসেবে পড়ে।
- `overflow-auto` + `maxHeight` — টেবিল নিজের বাক্সে দুই দিকেই scroll করে; পুরো পেজ আড়াআড়ি scroll করে না
  (CLAUDE.md → Page gutters)।
- `sticky top-0` thead + `shadow-[inset_0_-1px_0_var(--color-line)]` — `border-collapse` টেবিলে sticky হেডারের
  `border` scroll-এর সাথে সরে যায় (ব্রাউজারের পুরনো আচরণ), তাই নিচের রেখা inset shadow দিয়ে আঁকা।
- `<caption className="sr-only">` — টেবিলের নাম স্ক্রিন রিডারের জন্য; চোখে শিরোনাম তো `SectionHeader`-এ আছেই।
- রো-ক্লিক: `tabIndex={0}` + `onKeyDown` (Enter/Space) + `cursor-pointer` — mouse ছাড়াও খোলা যায়, আর CLAUDE.md-এর
  "clickable row must add cursor-pointer"। `onRowClick` না দিলে এর কিছুই বসে না।
- `first:border-t-0` — প্রথম রো-র উপরের রেখা হেডারের shadow-র সাথে দ্বিগুণ হতো।

**কোন লাইন কেন — হেডার আর sort:**

- sort-এর জন্য হেডারে আসল `<button>` — কীবোর্ডে Tab করে Enter। `aria-label="Sort by Value"` (অনুবাদ সহ)।
- `aria-sort` `<th>`-এ — স্ক্রিন রিডার কলামের নামের সাথে "sorted descending" পড়ে (দুবার ক্লিকের পর
  `aria-sort="descending"` যাচাই করা)।
- `end && 'flex-row-reverse'` — ডানে-মেলানো কলামে sort আইকন লেখার বাঁয়ে, যাতে লেখাটা সংখ্যার সাথে এক রেখায় থাকে।
- তিন রকম আইকন (↕ / ↑ / ↓) — কোন কলামে sort চলছে তা রঙ ছাড়াও আকারে বোঝা যায়।

**কোন লাইন কেন — ফোনের কার্ড:**

- `useWindowVirtualizer` (ডেস্কটপের `useVirtualizer` না) — ফোনে পুরো পেজ scroll করে; পেজের ভেতরে আলাদা scroll-বাক্স
  আঙুলে আটকে যায় আর পেজের scroll-এর সাথে লড়াই করে। যাচাই করা: ১০,০০০ কার্ডে DOM-এ ৮টা, একদম নিচে scroll
  করলে শেষ কার্ড `data-index="9999"`।
- `scrollMargin` — window-এর scroll শুরু পেজের মাথা থেকে, তালিকা শুরু অনেক নিচে (হেডার, ফর্ম …)। virtualizer-কে এই
  দূরত্ব না জানালে ভাবত তালিকা পেজের উপর থেকেই শুরু, আর ভুল কার্ড দেখাত। `useLayoutEffect`-এ একবার মাপা —
  paint-এর আগেই, তাই ভুল অবস্থানের ঝলক দেখা যায় না। `getBoundingClientRect().top + scrollY`, `offsetTop` না:
  `offsetTop` মাপে সবচেয়ে কাছের positioned parent থেকে, পেজের মাথা থেকে না।
- `translateY(item.start - scrollMargin)` — `item.start`-এ scrollMargin যোগ করা থাকে, তালিকার ভেতরে বসাতে বাদ দিতে হয়।
- `RowCard`-এ `slot('title')` ইত্যাদি — column-এর `meta.card` দেখে cell গুলো কার্ডের জায়গায় বসানো; একই
  `table.FlexRender`, তাই টেবিল আর কার্ডে একই রূপ (টাকা, Pill)।
- `role="button"` div, আসল `<button>` না — কার্ডে `<dl>` আছে, আর `<button>`-এর ভেতরে block element (`div`, `dl`)
  HTML-এ বৈধ না। CLAUDE.md "prefer a real button" বলে, কিন্তু এখানে সেটা সম্ভব না; `role="button"` global base
  rule থেকে `cursor: pointer` পায়।
- `columnLabel()` — কার্ডে "Qty (pcs): 4,800"-এর লেবেল আর sort বাটনের aria-label দুটোই column-এর header string
  থেকে। header JSX হলে column id।

---

## ৪.৮ — `packages/ui/src/index.ts` আর build

**ফাইল: `packages/ui/src/index.ts`** (নতুন ফাইল)

```ts
export { cn } from './lib/cn.js';
export { DESKTOP_QUERY, useMediaQuery } from './lib/use-media-query.js';
export { parseIsoDate, toIsoDate } from './lib/iso-date.js';

export { AppShell, NavGroup, NavItem, SidebarNav } from './components/app-shell.js';
export { Button, IconButton } from './components/button.js';
export { Card, CardHeader } from './components/card.js';
export { Checkbox } from './components/checkbox.js';
export {
  DataTable,
  dataTableColumns,
  dataTableFeatures,
  type DataTableColumnMeta,
} from './components/data-table.js';
export { DatePicker } from './components/date-picker.js';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/dropdown-menu.js';
export { EmptyState } from './components/empty-state.js';
export {
  Field,
  Input,
  TextField,
  type InputProps,
  type TextFieldProps,
} from './components/field.js';
export { FormAlert } from './components/form-alert.js';
export { FormField, type FormFieldControlProps } from './components/form-field.js';
export { Logo } from './components/logo.js';
export { MoneyInput } from './components/money-input.js';
export { PageHeader, SectionHeader } from './components/page-header.js';
export { Pill, type PillTone } from './components/pill.js';
export { Popover, PopoverContent, PopoverTrigger } from './components/popover.js';
export { SegmentedControl } from './components/segmented-control.js';
export { Toaster, toast } from './components/toast.js';
```

- একটাই entry (`@omnivo/ui`), উপরে `"sideEffects": false` থাকায় যা import হয়নি তা bundle-এ যায় না।
- `lib/money.ts` export হয়নি — `MoneyInput`-এর ভেতরের কাজ; বাইরে দরকার পড়লে তখন।

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/ui test       # ১৬টা পাস
pnpm dedupe
```

---

## ৪.৯ — `apps/app`: নতুন প্যাকেজে সরানো

```bash
pnpm --filter @omnivo/app add '@omnivo/ui@workspace:*' '@omnivo/i18n@workspace:*' 'react-hook-form@^7.89.0' '@hookform/resolvers@^5.9.1'
pnpm --filter @omnivo/app add -D '@types/node@^26.6.2'
pnpm --filter @omnivo/app remove @fontsource-variable/geist @fontsource-variable/geist-mono @fontsource/noto-sans-bengali
pnpm dedupe
```

- `@hookform/resolvers` app-এ, ui-তে না — `zodResolver(schema)` ফর্ম যে বানায় তার কাজ; ui-র `FormField` শুধু
  `control` নেয়, কোন validator তা জানে না।
- `@types/node` — শুধু ৪.১০-এর bundle-size স্ক্রিপ্টের জন্য। browser কোডে এটা পৌঁছায় না: `apps/app/tsconfig.json`-এ
  `"types": ["vite/client"]` আগে থেকেই আছে, আর `types` লিখে দিলে TypeScript শুধু সেই তালিকাই নেয়, `node_modules/@types`-এ
  যা আছে সব না। তাই `src/`-এ `process.env` লিখলে এখনো compile error — যা হওয়া উচিত।

এবার পুরনো ফাইল মুছুন:

```bash
git rm apps/app/src/components/button.tsx apps/app/src/components/text-field.tsx \
  apps/app/src/components/form-alert.tsx apps/app/src/components/logo.tsx apps/app/src/components/pill.tsx \
  apps/app/src/lib/cx.ts apps/app/src/lib/format.ts
```

**ফাইল: `apps/app/src/styles.css`** (আপডেট — পুরোটা এভাবে)

```css
/* Tailwind-এর entry app-এ: কোন ফাইলে কী class আছে সেটা স্ক্যান আর CSS তৈরি এখানেই।
   token, font, base style আসে packages/ui থেকে — admin/web অ্যাপও একই লাইন লিখবে */
@import 'tailwindcss';
@import '@omnivo/ui/styles.css';

/* auth side panel-এর হালকা খাতার গ্রিড — gradient এখানে শুধু ১px লাইন আঁকে, সাজ না।
   শুধু লগইন পেজের, তাই ui-তে না */
@utility auth-grid {
  background-image:
    linear-gradient(var(--brand-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--brand-line) 1px, transparent 1px);
  background-size: 40px 40px;
  opacity: 0.45;
  /* mask শুধু alpha দেখে, তাই #000 রঙ token না — মাঝখান থেকে কিনারায় মিলিয়ে যায় */
  mask-image: radial-gradient(ellipse 80% 70% at 50% 45%, #000 30%, transparent 80%);
}
```

- `@import 'tailwindcss'` আগে, তারপর ui — Tailwind-এর import শুরুতেই layer-এর ক্রম ঘোষণা করে
  (`theme, base, components, utilities`), আর ui-র `@layer base` তার ভেতরে preflight-এর **পরে** বসে। ক্রম উল্টালে
  ui-র base style preflight-এর আগে পড়ত, আর preflight-এর reset (যেমন বাটনের cursor) আমাদের নিয়মের উপর জিতত।
- `auth-grid` ধাপ ৩ থেকে হুবহু — শুধু লগইন পেজে ব্যবহার, তাই app-এ।

**ফাইল: `apps/app/index.html`** (আপডেট — `<link rel="icon">` যোগ)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Omnivo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**ফাইল: `apps/app/public/favicon.svg`** (নতুন ফাইল)

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26">
  <!-- Logo-র দুই বর্গ। favicon CSS token পড়তে পারে না, তাই brand-এর hex এখানে হাতে — token বদলালে এটাও -->
  <style>
    .fill { fill: #1f47b5; }
    .line { fill: #ffffff; stroke: #1f47b5; }
    @media (prefers-color-scheme: dark) {
      .fill { fill: #7c9cf2; }
      .line { fill: #0b0f17; stroke: #7c9cf2; }
    }
  </style>
  <rect class="fill" x="0" y="0" width="16" height="16" rx="5" />
  <rect class="line" x="11" y="11" width="14" height="14" rx="4" stroke-width="2" />
</svg>
```

- ধাপ ৩-এর নোট: console-এ `/favicon.ico` 404। Vite `public/`-এর ফাইল হুবহু `/`-এ দেয়।
- SVG, PNG না — এক ফাইলে সব আকার ঝকঝকে, আর ভেতরের `@media (prefers-color-scheme: dark)`-এ ব্রাউজারের tab
  গাঢ় হলে favicon-ও dark token-এর রঙে।
- hex হাতে লেখা — favicon আলাদা একটা ছবি, আমাদের CSS variable পড়তে পারে না। CLAUDE.md-এর "never raw hex" নিয়ম
  component-এর জন্য; এখানে ব্যতিক্রম, তাই মন্তব্যে লেখা যে token বদলালে এটাও বদলাতে হবে।
- দুই বর্গের মাপ `Logo`-র সাথে মেলানো: বাক্স ২৬, বর্গ ১৬। দ্বিতীয়টার stroke ২ মাঝখানে আঁকা হয়, তাই `x=11, width=14`
  + stroke = বাইরের কিনারা ১০ থেকে ২৬।

**ফাইল: `apps/app/src/main.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import './styles.css';
// প্রথম render-এর আগে i18n init — নাহলে প্রথম ঝলকে key ("nav.overview") দেখা যেত
import '@omnivo/i18n';

import { Toaster } from '@omnivo/ui';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './router';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
    {/* রুটের বাইরে: পেজ বদলালেও চলতি toast মুছে যায় না */}
    <Toaster />
  </StrictMode>,
);
```

- `import '@omnivo/i18n'` router-এর আগে — প্রথম render-এর আগেই init শেষ (initAsync: false), নাহলে এক ঝলক
  `nav.overview` দেখা যেত। ui-ও i18n import করে, কিন্তু এখানে স্পষ্ট করে লেখা যাতে কেউ ক্রম না বদলায়।
- `<Toaster />` `RouterProvider`-এর বাইরে — পেজ বদলালে চলতি toast মুছে যায় না (যেমন "Switched to …" দেখাতে
  দেখাতে ড্যাশবোর্ড আবার render হয়)।

**ফাইল: `apps/app/src/router.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';

import { restoreSession } from './lib/session';
import { sessionStore } from './lib/session-store';

const rootRoute = createRootRoute({ component: Outlet });

// প্রতিটা পেজ আলাদা chunk (lazyRouteComponent): লগইন পেজ খুলতে ড্যাশবোর্ডের DataTable বা
// সাইডবারের মেনু ডাউনলোড করতে হয় না। বাজেট: প্রথম লোড < 200 KB gz (scripts/check-bundle-size.ts)

// লগইন করা ইউজার /login বা /sign-up-এ এলে সোজা ড্যাশবোর্ডে
async function redirectIfSignedIn(): Promise<void> {
  await restoreSession();
  if (sessionStore.getState().status === 'signed-in') {
    throw redirect({ to: '/' });
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfSignedIn,
  component: lazyRouteComponent(() => import('./routes/login'), 'LoginPage'),
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  beforeLoad: redirectIfSignedIn,
  component: lazyRouteComponent(() => import('./routes/sign-up'), 'SignUpPage'),
});

// pathless layout route: এর নিচের সব পেজ protected, আর সবগুলো AppShell-এর ভেতরে
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async () => {
    await restoreSession();
    if (sessionStore.getState().status !== 'signed-in') {
      throw redirect({ to: '/login' });
    }
  },
  // layout-ও lazy: সাইডবারের Radix মেনু (~৩০ KB gz) লগইনের আগে লাগে না
  component: lazyRouteComponent(() => import('./routes/app-shell'), 'AppShell'),
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/dashboard'), 'DashboardPage'),
});

// শুধু `pnpm dev`-এ। production build-এ Vite import.meta.env.DEV-কে false বসায়, minifier পুরো
// শাখা মুছে দেয় — import() হারায়, তাই kitchen-sink-এর chunk তৈরিই হয় না
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => appRoute,
        path: '/kitchen-sink',
        component: lazyRouteComponent(() => import('./routes/kitchen-sink'), 'KitchenSinkPage'),
      }),
    ]
  : [];

const routeTree = rootRoute.addChildren([
  loginRoute,
  signUpRoute,
  appRoute.addChildren([dashboardRoute, ...devRoutes]),
]);

export const router = createRouter({ routeTree });

// <Link to="…"> আর navigate({ to }) এখন route tree থেকে টাইপ পায় — ভুল path compile error
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
```

**কোন লাইন কেন:**

- পেজের static import (`import { LoginPage } …`) সব মুছে `lazyRouteComponent(() => import('./routes/login'), 'LoginPage')`।
  প্রথম চেষ্টায় সব static রেখে build করলে প্রথম লোড দাঁড়াল **236.1 KB gz** (বাজেট 200) — gate নিজেই fail করল
  (৪.১০)। ধাপ ৩-এর bundle ছিল 132 KB; নতুন ১০৪ KB-র বড় অংশ Radix মেনু (~৩১ KB) আর DataTable/ক্যালেন্ডার, যা
  লগইন পেজে লাগেই না। lazy করার পর প্রথম লোড 144.6 KB।
- দ্বিতীয় প্যারামিটার `'LoginPage'` — export-এর নাম, টাইপ-চেকড (ভুল নাম লিখলে compile error)। তাই পেজ ফাইলগুলো
  `export default`-এ বদলাতে হয়নি।
- layout (`AppShell`)-ও lazy — pathless route-এর component-ও lazy হতে পারে। লগইনের আগে সাইডবারের কোড লাগে না।
- `beforeLoad` আগের মতোই (static) — session যাচাই chunk নামানোর আগেই শুরু হয়।
- `devRoutes` — `import.meta.env.DEV` Vite build-এর সময় `false` বসায়, minifier `false ? [...] : []` থেকে পুরো শাখা
  আর তার `import()` মুছে দেয়, তাই production-এ kitchen-sink-এর chunk তৈরিই হয় না (build-এর manifest-এ নেই —
  যাচাই করা)। kitchen sink ডেভেলপারের টুল, গ্রাহকের না।
- `appRoute.addChildren([dashboardRoute, ...devRoutes])` — `devRoutes`-এর টাইপ array, তাই route tree-র টাইপে
  `/kitchen-sink` থাকে, আর `<NavLink to="/kitchen-sink">` compile হয়। (production-এ লিংকটাও `import.meta.env.DEV`
  দিয়ে লুকানো — ৪.৯-এর shell দেখুন।)

**ফাইল: `apps/app/src/lib/field-errors.ts`** (আপডেট — পুরোটা এভাবে)

```ts
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { ApiRequestError } from './api';

// সার্ভারের error → react-hook-form: fieldErrors থাকলে সেই ফিল্ডের নিচে, নয়তো ফর্মের উপরে
// ('root.server' — পরের submit-এ react-hook-form নিজেই মুছে দেয়)
export function applyApiError<TValues extends FieldValues>(
  error: unknown,
  // schema.keyof().options থেকে — সার্ভারের পাঠানো string নামকে টাইপ-চেকড ফিল্ড নামে মেলাতে
  fieldNames: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): void {
  if (!(error instanceof ApiRequestError)) {
    setError('root.server', {
      message: 'Could not reach the server. Check your connection and try again.',
    });
    return;
  }
  let placed = false;
  for (const [field, messages] of Object.entries(error.body.fieldErrors ?? {})) {
    // find: cast ছাড়াই string → Path<TValues>; ফর্মে নেই এমন নাম বাদ পড়ে
    const name = fieldNames.find((candidate) => candidate === field);
    const message = messages[0];
    if (name && message) {
      setError(name, { message });
      placed = true;
    }
  }
  if (!placed) setError('root.server', { message: error.body.message });
}
```

**কোন লাইন কেন:**

- ধাপ ৩-এর `validate()` আর নেই — ফর্ম যাচাই এখন `zodResolver` করে (একই `@omnivo/contracts` schema)।
- `'root.server'` — react-hook-form-এর "ফর্ম-জোড়া" error-এর জায়গা (কোনো একটা ফিল্ডের না)। পরের `handleSubmit`-এ
  react-hook-form নিজেই এটা মুছে দেয় — ধাপ ৩-এর `setFormError(null)` হাতে লিখতে হয় না।
- `fieldNames: readonly Path<TValues>[]` — সার্ভার error পাঠায় `{ fieldErrors: { workspaceSlug: [...] } }`, key সাধারণ
  `string`। `setError()` চায় `Path<TValues>`। `fieldNames.find(c => c === field)` cast ছাড়াই টাইপ নামায়, আর ফর্মে
  নেই এমন নাম (API-র কোনো অভ্যন্তরীণ ফিল্ড) চুপচাপ বাদ পড়ে, ফলে ফর্মের উপরে সাধারণ মেসেজ দেখায়।
- caller পাঠায় `loginInputSchema.keyof().options` — Zod schema-র key-এর তালিকা, টাইপ সহ
  (`('workspace' | 'email' | …)[]`)। তালিকা আবার হাতে লিখতে হয় না; schema-ই উৎস (rule ২)।

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
import { loginInputSchema } from '@omnivo/contracts';
import { Button, Checkbox, FormAlert, Logo, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { AuthPreview } from '../components/auth-preview';
import { applyApiError } from '../lib/field-errors';
import { login } from '../lib/session';

const INDUSTRIES = [
  { icon: TShirtIcon, label: 'Garments & textiles' },
  { icon: Medicine02Icon, label: 'Pharmaceuticals' },
  { icon: DeliveryTruck01Icon, label: 'Distribution' },
  { icon: FactoryIcon, label: 'Manufacturing' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই মেসেজ, একই নিয়ম
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginInputSchema),
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
            <h1 className="text-[28px] leading-[1.2]">Sign in</h1>
            <p className="mt-2 text-ink-2">Welcome back. Enter your details to continue.</p>

            <form
              noValidate
              onSubmit={(event) => void onSubmit(event)}
              className="mt-8 grid gap-[18px]"
            >
              {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
              <TextField
                label="Workspace"
                icon={Building03Icon}
                suffix=".omnivo.app"
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="rahman-garments"
                {...register('workspace')}
                error={errors.workspace?.message}
              />
              <TextField
                label="Email"
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label="Password"
                icon={LockPasswordIcon}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                {...register('password')}
                error={errors.password?.message}
                trailing={
                  <button
                    type="button"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
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
                    label="Keep me signed in on this device"
                    checked={field.value}
                    // Radix-এর মান true | false | 'indeterminate' — আমাদের schema শুধু boolean
                    onCheckedChange={(checked) => {
                      field.onChange(checked === true);
                    }}
                  />
                )}
              />
              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <p className="mt-7 text-center text-body-sm text-ink-2">
              New to Omnivo?{' '}
              <Link
                to="/sign-up"
                className="font-medium text-brand underline-offset-[3px] hover:underline"
              >
                Create a workspace
              </Link>
            </p>
          </div>
        </div>
        <p className="text-[12.5px] text-ink-3">© 2026 Omnivo Technologies</p>
      </section>

      <aside
        aria-label="What Omnivo does"
        className="relative m-3 ml-0 hidden flex-col justify-center gap-10 overflow-hidden rounded-panel border border-brand-line bg-brand-soft px-[clamp(24px,5vw,72px)] py-14 min-[1040px]:flex"
      >
        <div aria-hidden="true" className="auth-grid pointer-events-none absolute inset-0" />
        {/* গ্রিড absolute, তাই লেখাকেও relative না দিলে লাইন লেখার উপরে আঁকা হতো */}
        <div className="relative max-w-lg">
          <h2 className="text-display tracking-[-0.03em]">
            Production, stock and accounts. One system.
          </h2>
          <p className="mt-3 max-w-md text-[15px] text-ink-2">
            From buyer orders to payroll, every department works from the same numbers, even when
            the internet is down.
          </p>
          <ul className="mt-[18px] flex flex-wrap gap-2">
            {INDUSTRIES.map((industry) => (
              <li
                key={industry.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2.5 pl-2 text-[12.5px] font-medium text-ink-2"
              >
                <HugeiconsIcon
                  icon={industry.icon}
                  size={14}
                  strokeWidth={1.5}
                  className="text-brand"
                />
                {industry.label}
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

- `useState` ফর্ম + `validate()` → `useForm({ resolver: zodResolver(loginInputSchema), defaultValues })`।
  `defaultValues` থেকে ফর্মের টাইপ আসে; `zodResolver` থেকে `handleSubmit`-এর `values`-এর টাইপ = `LoginInput`
  (trim/lowercase করা)।
- `{...register('workspace')}` — `name`, `ref`, `onChange`, `onBlur` একসাথে। input uncontrolled, টাইপের সময় React
  re-render হয় না। `id` দিতে হয়নি: `TextField` `name` থেকেই নেয়।
- `onSubmit={(event) => void onSubmit(event)}` — `handleSubmit` Promise ফেরত দেয়; `void` ছাড়া typescript-eslint-এর
  `no-misused-promises` ধরত (ধাপ ৩-এর মতোই)।
- `isSubmitting` — `handleSubmit`-এর async ফাংশন চলার পুরো সময় react-hook-form নিজে `true` রাখে; আলাদা
  `submitting` state আর `finally` লাগে না।
- `Controller` দিয়ে `Checkbox` — Radix Checkbox আসল `<input>` না, তাই `register` কাজ করে না। `checked === true`:
  Radix-এর মান `true | false | 'indeterminate'`, schema-র `z.boolean()` শুধু দুটো নেয়।
- `autoCapitalize="none"` — ফোনের কীবোর্ড workspace-এর প্রথম অক্ষর বড় হাতের করে দিত।
- পাসওয়ার্ডের দেখা/লুকানো বাটন আগের মতো inline — ১৭px আইকন (CLAUDE.md: input-এর ভেতরে ১৭px), `IconButton`-এর
  ১৮px না।
- ডান প্যানেল (`aside`) অপরিবর্তিত।

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
import { signUpInputSchema } from '@omnivo/contracts';
import { Button, FormAlert, Logo, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';

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
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getFieldState,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(signUpInputSchema),
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
        <p className="text-body-sm text-ink-2">
          Already have a workspace?{' '}
          <Link
            to="/login"
            className="font-medium text-brand underline-offset-[3px] hover:underline"
          >
            Sign in
          </Link>
        </p>
      </header>

      <main className="mx-auto max-w-[640px] px-4 pt-10 pb-16">
        <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
          <h1 className="text-h2">Create your workspace</h1>
          <p className="mt-1.5 text-ink-2">
            You&apos;ll be the workspace owner. You can invite your accountants, managers and store
            staff after setup.
          </p>

          <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-7 grid gap-5">
            {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
            <TextField
              label="Company name"
              icon={Building03Icon}
              autoComplete="organization"
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
              label="Workspace address"
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
                label="Full name"
                icon={UserIcon}
                autoComplete="name"
                placeholder="Farhana Rahman"
                {...register('fullName')}
                error={errors.fullName?.message}
              />
              <TextField
                label="Work email"
                icon={Mail01Icon}
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                {...register('email')}
                error={errors.email?.message}
              />
            </div>
            <TextField
              label="Password"
              icon={LockPasswordIcon}
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              {...register('password')}
              error={errors.password?.message}
            />

            <div className="mt-2 flex justify-end border-t border-line pt-6">
              <Button
                type="submit"
                disabled={isSubmitting}
                className="w-full sm:w-auto sm:min-w-40"
              >
                {isSubmitting ? 'Creating workspace…' : 'Create workspace'}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
```

**কী বদলাল, আর কেন:**

- `slugTouched` state মুছে গেছে — react-hook-form প্রতিটা ফিল্ডের `isDirty` নিজেই রাখে। ইউজার ঠিকানায় নিজে টাইপ
  করলে সেটা dirty; `setValue()` ডিফল্টে dirty বানায় না, তাই অটো-বসানো মান কোম্পানির নামের সাথে বদলাতে থাকে,
  কিন্তু হাতে লেখা মান আর বদলায় না (যাচাই করা: নিজে লেখার পর কোম্পানির নাম বদলালেও ঠিকানা একই থাকে)।
- `register('companyName', { onChange })` — react-hook-form নিজের মান আপডেটের **পরে** এই `onChange` ডাকে।
- ঠিকানায় live `toLowerCase()` আর নেই — uncontrolled input-এ টাইপের মাঝখানে মান বদলালে cursor শেষে লাফায়।
  বড় হাতের অক্ষর আসার আসল কারণ ফোনের auto-capitalize, সেটা `autoCapitalize="none"` বন্ধ করে; বাকিটা schema-র
  `.toLowerCase()` জমা দেওয়ার সময় সামলায়।

**ফাইল: `apps/app/src/components/auth-preview.tsx`** (আপডেট — শুধু import আর `cx` → `cn`)

```ts
import { CheckmarkCircle02Icon, ScissorIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn, Pill } from '@omnivo/ui';
```

ফাইলের বাকি চার জায়গায় `cx(` → `cn(`। এটাই একমাত্র ফাইল যেটা `components/`-এ থেকে গেল।

**ফাইল: `apps/app/src/routes/app-shell.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import {
  DashboardSquare01Icon,
  LayoutGridIcon,
  Logout01Icon,
  UnfoldMoreIcon,
  UserCircleIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isLanguage, LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
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

import { logout, switchTenant } from '../lib/session';
import { useSession } from '../lib/session-store';

// ui-র সাধারণ <a> → TanStack-এর টাইপ-চেকড লিংক: to="/kitchn-sink" লিখলে compile error,
// আর সক্রিয় রুটে Link নিজেই aria-current="page" বসায়
const NavLink = createLink(NavItem);

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

function WorkspaceSwitcher() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!me) return null;

  const summary = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand text-[12.5px] font-semibold text-brand-ink">
        {initials(me.tenant.name)}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-body-sm font-medium">{me.tenant.name}</span>
        <span className="block truncate text-caption text-ink-3">{me.tenant.slug}.omnivo.app</span>
      </span>
    </>
  );

  // একটাই workspace হলে বদলানোর কিছু নেই — মেনুর বদলে শুধু তথ্য
  if (me.memberships.length < 2) {
    return (
      <div className="flex items-center gap-2.5 rounded-control border border-line px-2.5 py-2">
        {summary}
      </div>
    );
  }

  return (
    // grid-cols-1 = minmax(0, 1fr): লম্বা কোম্পানির নাম বাটনকে সাইডবারের বাইরে ঠেলে না, truncate হয়
    <div className="grid grid-cols-1 gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={switching}
            aria-label={t('shell.switchWorkspace')}
            className="flex w-full items-center gap-2.5 rounded-control border border-line-strong px-2.5 py-2 shadow-sm transition-colors duration-150 hover:bg-subtle"
          >
            {summary}
            <HugeiconsIcon
              icon={UnfoldMoreIcon}
              size={16}
              strokeWidth={1.5}
              className="shrink-0 text-ink-3"
            />
          </button>
        </DropdownMenuTrigger>
        {/* Radix trigger-এর চওড়া CSS variable-এ দেয় — মেনু ঠিক বাটনের সমান চওড়া */}
        <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuLabel>{t('shell.workspaces')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={me.tenant.id}
            onValueChange={(tenantId) => {
              const target = me.memberships.find((m) => m.tenantId === tenantId);
              setSwitching(true);
              setFailed(false);
              // ব্যর্থ হলে store বদলায় না, তাই মেনুর টিক আগের workspace-এই থাকে
              switchTenant(tenantId)
                .then(() => {
                  if (target) toast(t('shell.switched', { name: target.name }));
                })
                .catch(() => {
                  setFailed(true);
                })
                .finally(() => {
                  setSwitching(false);
                });
            }}
          >
            {me.memberships.map((membership) => (
              <DropdownMenuRadioItem key={membership.tenantId} value={membership.tenantId}>
                {membership.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {failed && (
        <p role="alert" className="px-1 text-caption text-crit">
          {t('shell.switchFailed')}
        </p>
      )}
    </div>
  );
}

// ডেস্কটপের সাইডবার-তলা আর ফোনের টপ বার — দুই trigger, একই মেনু
function UserMenuContent({ align }: { align: 'start' | 'end' }) {
  const { t, language } = useLocale();
  return (
    <DropdownMenuContent align={align}>
      <DropdownMenuLabel>{t('common.language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={language}
        onValueChange={(value) => {
          // Radix মান দেয় string হিসেবে — type guard দিয়ে Language-এ নামানো, cast না
          if (isLanguage(value)) void setLanguage(value);
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

export function AppShell() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const status = useSession((state) => state.status);
  const me = useSession((state) => state.me);

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  return (
    <Shell
      brand={<Logo />}
      topBarActions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon={UserCircleIcon} label={t('shell.account')} />
          </DropdownMenuTrigger>
          <UserMenuContent align="end" />
        </DropdownMenu>
      }
      sidebarHeader={<WorkspaceSwitcher />}
      nav={
        <SidebarNav label={t('shell.mainNav')}>
          <NavGroup>
            {/* exact: নাহলে "/" সব রুটের পূর্বপুরুষ, তাই সব পেজে Overview-ও সক্রিয় দেখাত */}
            <NavLink to="/" icon={DashboardSquare01Icon} activeOptions={{ exact: true }}>
              {t('nav.overview')}
            </NavLink>
            {import.meta.env.DEV && (
              <NavLink to="/kitchen-sink" icon={LayoutGridIcon}>
                {t('nav.kitchenSink')}
              </NavLink>
            )}
          </NavGroup>
        </SidebarNav>
      }
      sidebarFooter={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-subtle"
            >
              <HugeiconsIcon
                icon={UserCircleIcon}
                size={18}
                strokeWidth={1.5}
                className="shrink-0 text-ink-3"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-sm font-medium">{me?.user.fullName}</span>
                <span className="block truncate text-caption text-ink-3">{me?.user.email}</span>
              </span>
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                size={16}
                strokeWidth={1.5}
                className="shrink-0 text-ink-3"
              />
            </button>
          </DropdownMenuTrigger>
          <UserMenuContent align="start" />
        </DropdownMenu>
      }
    >
      <Outlet />
    </Shell>
  );
}
```

**কোন লাইন কেন:**

- লেআউটের সব class এখন ui-র `AppShell`-এ; এই ফাইল শুধু **কী** বসবে: লোগো, workspace switcher, nav, user মেনু।
  ui-র নামের সাথে সংঘাত এড়াতে `AppShell as Shell` import।
- `const NavLink = createLink(NavItem)` — module-level, component-এর ভেতরে না: প্রতি render-এ নতুন component টাইপ
  বানালে React প্রতিবার পুরো লিংক মুছে নতুন করে বানাত। ফল: `<NavLink to="/" icon={…}>` — `to` route tree থেকে
  টাইপ-চেকড, `icon` NavItem থেকে।
- `activeOptions={{ exact: true }}` Overview-তে — TanStack ডিফল্টে লিংক সক্রিয় ধরে যদি বর্তমান পাথ তার **নিচে**
  থাকে। `/` সব পাথের পূর্বপুরুষ, তাই kitchen sink-এ গেলেও Overview আলো থাকত। যাচাই করা: kitchen sink-এ
  Overview-র `aria-current` নেই।
- `WorkspaceSwitcher`: native `<select>` → Radix `DropdownMenu` + `DropdownMenuRadioGroup`। কীবোর্ড (Enter-এ খোলে,
  তীর, Escape-এ বন্ধ হয়ে focus বাটনে ফেরে — যাচাই করা) Radix দেয়।
- `grid grid-cols-1` — **যাচাইয়ে পাওয়া bug:** দুই workspace-ওয়ালা ইউজারের বাটন লম্বা কোম্পানির নামে ২৪৪px সাইডবারের
  বাইরে বেরিয়ে যাচ্ছিল। `grid`-এর ডিফল্ট কলাম content যত চওড়া ততটা হয়; Tailwind v4-এর `grid-cols-1` =
  `repeat(1, minmax(0, 1fr))`, তাই নাম truncate হয়।
- `w-(--radix-dropdown-menu-trigger-width)` — Radix trigger-এর চওড়া CSS variable-এ দেয়; Tailwind v4-এর
  `w-(--var)` সিনট্যাক্সে মেনু ঠিক বাটনের সমান।
- সফল switch-এ `toast(t('shell.switched', { name }))` — কী ঘটল তা বলা (CLAUDE.md → Toast)। ব্যর্থ হলে toast না,
  ধাপ ৩-এর মতো লাল লেখা বাটনের নিচেই — error-এর জায়গা ঘটনার পাশে।
- `UserMenuContent` — ভাষা (radio) + sign out। ডেস্কটপে সাইডবারের তলা থেকে, ফোনে টপ বারের আইকন থেকে, একই মেনু।
  ধাপ ৩-এ ফোনের জন্য আলাদা sign-out বাটন ছিল; এখন দরকার নেই।
- `isLanguage(value)` guard — Radix `onValueChange` দেয় `string`।
- `lang={option.code}` প্রতিটা ভাষার item-এ — "বাংলা" লেখাটা স্ক্রিন রিডার বাংলা উচ্চারণে পড়ে, ইংরেজি ভয়েসে না।
- `{import.meta.env.DEV && <NavLink to="/kitchen-sink" …>}` — production-এ রুট নেই, লিংকও নেই।

**ফাইল: `apps/app/src/routes/dashboard.tsx`** (আপডেট — পুরোটা এভাবে)

```tsx
import { CheckmarkCircle02Icon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memberListResponseSchema, type MemberListResponse } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, DataTable, dataTableColumns, PageHeader, SectionHeader } from '@omnivo/ui';
import { useEffect, useMemo, useState } from 'react';

import { apiFetch } from '../lib/api';
import { useSession } from '../lib/session-store';

type Member = MemberListResponse['members'][number];

// module-level: প্রতি render-এ নতুন helper বানানোর দরকার নেই
const column = dataTableColumns<Member>();

function MembersCard({ tenantId }: { tenantId: string }) {
  const { t } = useLocale();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [failed, setFailed] = useState(false);

  // tenantId বদলালে (switcher) আবার আনা; পুরনো request-এর উত্তর দেরিতে এলে ফেলে দেওয়া
  useEffect(() => {
    let cancelled = false;
    apiFetch('/members', memberListResponseSchema).then(
      (response) => {
        if (!cancelled) {
          setMembers(response.members);
          setFailed(false);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

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
      {failed ? (
        <p className="text-body-sm text-crit">{t('dashboard.teamLoadFailed')}</p>
      ) : (
        members && (
          <DataTable
            label={t('dashboard.teamTitle')}
            data={members}
            columns={columns}
            getRowId={(member) => member.membershipId}
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
        <MembersCard tenantId={me.tenant.id} />
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

**কোন লাইন কেন:**

- `const column = dataTableColumns<Member>()` module-level — helper-টা শুধু টাইপ বহন করে, প্রতি render-এ বানানোর দরকার নেই।
- `Member = MemberListResponse['members'][number]` — টাইপ contracts-এর Zod schema থেকে (rule ২)।
- `useMemo(..., [t])` — header-এ অনুবাদ আছে, তাই ভাষা বদলালে column নতুন; নাহলে একই array, TanStack আবার হিসাব করে না।
- প্রথম কলাম: ৩০px avatar tile + নাম + ink-3 ইমেইল — CLAUDE.md → Table-এর নিয়ম।
  `meta: { card: 'title' }` — ফোনের কার্ডেও একই cell শিরোনামে।
- roles কলাম `accessor((member) => member.roles.join(', '), { id: 'roles' })` — function accessor-এ `id` বাধ্যতামূলক
  (key থেকে নাম আসে না)। join করা string-ই sort হয়।
- `setFailed(false)` এখন সফল উত্তরের ভেতরে, effect-এর শুরুতে না — **এটা বাধ্যতামূলক বদল।** ধাপ ৩-এর মতো effect
  শুরুতেই `setFailed(false)` রাখলে ৪.১১-এর react-hooks নিয়ম `pnpm lint`-কে **error** দিয়ে থামায় (যাচাই করা:
  "Calling setState synchronously within an effect can trigger cascading renders")। কারণ: effect চলে render-এর
  পরে; সেখানে সাথে সাথে state বদলালে আরেকটা পুরো render হয়, যেটা এড়ানো যেত।
- টিম-তালিকা `Card`-এর ভেতরে না, `SectionHeader` + `DataTable` — টেবিল নিজেই কার্ড (৪.৩)।
- `format.date(new Date())` — তারিখও এখন ভাষা অনুযায়ী (`২৮ সেপ, ২০২৬`)।

### Kitchen sink

**ফাইল: `apps/app/src/routes/kitchen-sink.tsx`** (নতুন ফাইল)

```tsx
import {
  CheckmarkCircle02Icon,
  Clock01Icon,
  InboxIcon,
  PauseCircleIcon,
  PlusSignIcon,
  ScissorIcon,
  Settings01Icon,
  TShirtIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { isLanguage, LANGUAGES, setLanguage, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  parseIsoDate,
  Pill,
  type PillTone,
  SectionHeader,
  SegmentedControl,
  TextField,
  toast,
  toIsoDate,
} from '@omnivo/ui';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

// শুধু dev-এ (router.tsx দেখুন) — তাই এই পেজের নিজের লেখা ইংরেজিতেই; ভাষা বদলালে
// component-এর নিজের লেখা, তারিখ, টাকা আর ক্যালেন্ডার কীভাবে বদলায় সেটা দেখাই উদ্দেশ্য

type Stage = 'cutting' | 'sewing' | 'shipped' | 'delayed' | 'on-hold';

// status রং শুধু অর্থের জন্য, আর প্রতিটার সাথে আইকন + লেখা (CLAUDE.md)
const STAGES = {
  cutting: { label: 'Cutting', tone: 'brand', icon: ScissorIcon },
  sewing: { label: 'Sewing', tone: 'brand', icon: TShirtIcon },
  shipped: { label: 'Shipped', tone: 'good', icon: CheckmarkCircle02Icon },
  delayed: { label: 'Delayed', tone: 'warn', icon: Clock01Icon },
  'on-hold': { label: 'On hold', tone: 'neutral', icon: PauseCircleIcon },
} satisfies Record<Stage, { label: string; tone: PillTone; icon: IconSvgElement }>;

interface BuyerPo {
  id: string;
  po: string;
  buyer: string;
  style: string;
  quantity: number;
  // টাকা string — API থেকে যেমন আসবে
  value: string;
  shipBy: string;
  stage: Stage;
}

const BUYERS = [
  'Nordwind Apparel GmbH',
  'Harbor & Pine Co.',
  'Maison Lune SA',
  'Kaito Retail KK',
  'Blue Anchor Ltd',
  'Stellar Kids Inc.',
] as const;
const STYLES = [
  'Knit polo',
  'Crew-neck tee',
  'Fleece hoodie',
  'Denim jacket',
  'Cargo trousers',
  "Ladies' blouse",
] as const;
const STAGE_KEYS = ['cutting', 'sewing', 'shipped', 'delayed', 'on-hold'] as const;

// seed-ওয়ালা ছোট random: প্রতিবার একই ১০,০০০ রো — reload-এ টেবিল বদলায় না, screenshot মেলে
function makePurchaseOrders(count: number): BuyerPo[] {
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // [T, ...T[]]: অন্তত একটা উপাদান — তাই items[0] টাইপে T, undefined না
  const pick = <T,>(items: readonly [T, ...T[]]): T =>
    items[Math.floor(next() * items.length)] ?? items[0];

  return Array.from({ length: count }, (_, index) => {
    const quantity = 200 + Math.floor(next() * 48) * 100;
    const unitPrice = 180 + Math.floor(next() * 1270);
    return {
      id: String(index),
      po: `PO-${String(10000 + index)}`,
      buyer: pick(BUYERS),
      style: pick(STYLES),
      quantity,
      value: `${String(quantity * unitPrice)}.00`,
      shipBy: toIsoDate(new Date(2026, 9, 1 + Math.floor(next() * 120))),
      stage: pick(STAGE_KEYS),
    };
  });
}

// module-level: chunk লোড হওয়ার সময় একবার — DataTable-এর data রেফারেন্স স্থির থাকে
const PURCHASE_ORDERS = makePurchaseOrders(10_000);

const column = dataTableColumns<BuyerPo>();

function PurchaseOrderTable() {
  const { format } = useLocale();
  // format বদলায় শুধু ভাষা বদলালে — তখনই column নতুন করে
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('po', {
          header: 'PO',
          meta: { card: 'title' },
          // ID তাই monospace (CLAUDE.md → Typography)
          cell: ({ getValue }) => <span className="font-mono font-medium">{getValue()}</span>,
        }),
        column.accessor('buyer', { header: 'Buyer', meta: { card: 'subtitle' } }),
        column.accessor('style', { header: 'Style', meta: { card: 'detail' } }),
        column.accessor('quantity', {
          header: 'Qty (pcs)',
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
        column.accessor('value', {
          header: 'Value',
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor('shipBy', {
          header: 'Ship by',
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = parseIsoDate(getValue());
            return date ? format.date(date) : '';
          },
        }),
        column.accessor('stage', {
          header: 'Status',
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const stage = STAGES[getValue()];
            return (
              <Pill tone={stage.tone} icon={stage.icon}>
                {stage.label}
              </Pill>
            );
          },
        }),
      ]),
    [format],
  );

  return (
    <DataTable
      label="Buyer purchase orders"
      data={PURCHASE_ORDERS}
      columns={columns}
      getRowId={(po) => po.id}
      showCount
      onRowClick={(po) => {
        toast(`${po.po} opened`);
      }}
    />
  );
}

const lcSchema = z.object({
  lcNumber: z.string().trim().min(3, 'Enter the LC number, like LC 0126-2409.'),
  // MoneyInput সবসময় "" অথবা ঠিক ২ ঘর দশমিক দেয়
  amount: z.string().regex(/^\d+\.\d{2}$/, 'Enter the LC amount.'),
  shipBy: z.string().min(1, 'Pick the latest shipment date.'),
  bank: z.string().trim(),
  partialShipment: z.boolean(),
});

function LetterOfCreditForm() {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(lcSchema),
    defaultValues: { lcNumber: '', amount: '', shipBy: '', bank: '', partialShipment: false },
  });

  const onSubmit = handleSubmit((values) => {
    toast(`${values.lcNumber} saved as draft`);
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5 p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="LC number"
          placeholder="LC 0126-2409"
          {...register('lcNumber')}
          error={errors.lcNumber?.message}
        />
        <TextField
          label="Issuing bank"
          optional
          hint="Leave empty if the buyer has not named one yet."
          placeholder="Dutch-Bangla Bank"
          {...register('bank')}
          error={errors.bank?.message}
        />
        <FormField control={control} name="amount" label="LC amount">
          {(field) => <MoneyInput {...field} placeholder="0.00" />}
        </FormField>
        <FormField control={control} name="shipBy" label="Latest shipment date">
          {(field) => <DatePicker {...field} />}
        </FormField>
      </div>
      <Controller
        control={control}
        name="partialShipment"
        render={({ field }) => (
          <Checkbox
            id="partialShipment"
            label="Allow partial shipment"
            checked={field.value}
            onCheckedChange={(checked) => {
              field.onChange(checked === true);
            }}
          />
        )}
      />
      <div className="flex justify-end border-t border-line pt-5">
        <Button type="submit">Save draft</Button>
      </div>
    </form>
  );
}

type Theme = 'system' | 'light' | 'dark';

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

// CLAUDE.md: data-theme OS-এর পছন্দকে দুই দিকেই হারায়; না থাকলে prefers-color-scheme
function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

export function KitchenSinkPage() {
  const { language, format } = useLocale();
  const [theme, setTheme] = useState<Theme>('system');
  const today = new Date();

  return (
    <div className="grid max-w-6xl gap-5">
      <PageHeader
        title="Kitchen sink"
        description="Every shared component, in both themes and both languages."
        actions={
          <>
            <SegmentedControl
              label="Theme"
              value={theme}
              options={THEMES}
              onChange={(next) => {
                setTheme(next);
                applyTheme(next);
              }}
            />
            <SegmentedControl
              label="Language"
              value={language}
              options={LANGUAGES.map((option) => ({ value: option.code, label: option.label }))}
              onChange={(next) => {
                if (isLanguage(next)) void setLanguage(next);
              }}
            />
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Buttons and status" subtitle="One primary button per view" />
          <div className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  toast('Workspace created');
                }}
              >
                Show toast
              </Button>
              <Button variant="secondary">Export</Button>
              <Button variant="secondary" size="sm">
                Retry
              </Button>
              <Button disabled>Disabled</Button>
              <IconButton icon={Settings01Icon} label="Settings" />
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.values(STAGES).map((stage) => (
                <Pill key={stage.label} tone={stage.tone} icon={stage.icon}>
                  {stage.label}
                </Pill>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Formatting" subtitle="Follows the selected language" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5 text-body-sm">
            <dt className="text-ink-3">Money</dt>
            <dd className="tabular-nums">{format.money('1842600')}</dd>
            <dt className="text-ink-3">Unit price</dt>
            <dd className="tabular-nums">{format.money('184.5', { decimals: 2 })}</dd>
            <dt className="text-ink-3">Quantity</dt>
            <dd className="tabular-nums">{format.number(4800)}</dd>
            <dt className="text-ink-3">Date</dt>
            <dd className="tabular-nums">{format.date(today)}</dd>
            <dt className="text-ink-3">Period</dt>
            <dd>{format.month(today)}</dd>
          </dl>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Form"
          subtitle="React Hook Form + Zod, with money, date and checkbox controls"
        />
        <LetterOfCreditForm />
      </Card>

      <Card>
        <CardHeader title="Empty state" />
        <EmptyState
          icon={InboxIcon}
          title="No buyer POs yet"
          description="Record a buyer PO to track cutting, sewing and shipment against the LC."
          action={
            <Button size="sm">
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              Add buyer PO
            </Button>
          }
        />
      </Card>

      <section className="grid gap-3">
        <SectionHeader
          title="Data table"
          subtitle="10,000 buyer POs, virtualized. Cards below 860px. Click a header to sort."
        />
        <PurchaseOrderTable />
      </section>
    </div>
  );
}
```

**কোন লাইন কেন:**

- পেজের নিজের লেখা ইংরেজিতে, ইচ্ছা করে — এটা শুধু `pnpm dev`-এ আসে। ভাষা বদলালে যা বদলানো উচিত (ui-র নিজের লেখা,
  টাকা, তারিখ, ক্যালেন্ডার, সারির সংখ্যা) সেটাই এখানে দেখার জিনিস।
- `STAGES` + `satisfies Record<Stage, …>` — প্রতিটা status-এর লেখা, রং আর আইকন একসাথে; নতুন stage টাইপে যোগ করে
  এখানে ভুলে গেলে compile error। Cutting/Sewing `brand` (উৎপাদনের ধাপ, ভালো-খারাপ না), Delayed `warn`,
  Shipped `good` — CLAUDE.md: status রং শুধু অর্থের জন্য।
- `makePurchaseOrders` — seed-ওয়ালা ছোট random (LCG): প্রতিবার একই ১০,০০০ রো। `Math.random()` দিলে প্রতি reload-এ
  টেবিল বদলাত, আর screenshot তুলনা করা যেত না।
- `pick<T>(items: readonly [T, ...T[]])` — "অন্তত একটা উপাদান"-এর tuple টাইপ। `noUncheckedIndexedAccess`-এ
  `items[i]` হলো `T | undefined`; `?? items[0]` দিলে `items[0]`-এর টাইপ `T` (tuple-এর প্রথম ঘর নিশ্চিত), তাই
  non-null assertion (`!`) ছাড়াই `T`।
- `PURCHASE_ORDERS` module-level — chunk লোড হওয়ার সময় একবার; `DataTable`-এর `data` রেফারেন্স কখনো বদলায় না।
- `value` কলামে (টাকা, string) আলাদা `sortFn` লাগেনি — `sortFn: 'auto'` অঙ্ক-ওয়ালা string-এ `alphanumeric` বাছে,
  যেটা অঙ্কের অংশগুলো সংখ্যা হিসেবে তুলনা করে (`"95000.00"` < `"1842600.00"`)। দশমিক সবসময় ২ ঘর, তাই দশমিকের
  অংশও ঠিক মেলে। দুই দিকে sort করে ক্রম যাচাই করা।
- `enableSorting: false` status কলামে — "Cutting" < "Delayed" বর্ণমালার ক্রম অর্থহীন।
- `useMemo(..., [format])` — `format` শুধু ভাষা বদলালে বদলায় (`useLocale`-এর `useMemo`), তখনই column নতুন।
- `lcSchema` + `zodResolver` — একই পদ্ধতি যা লগইনে; এখানে `FormField` দিয়ে `MoneyInput` আর `DatePicker`,
  `register` দিয়ে সাধারণ ফিল্ড, `Controller` দিয়ে checkbox — তিন পথই এক পেজে।
- `amount: z.string().regex(/^\d+\.\d{2}$/)` — `MoneyInput` সবসময় `""` অথবা ঠিক ২ ঘর দশমিক দেয়; খালি হলে regex
  fail → "Enter the LC amount."।
- `applyTheme` — `data-theme` বসালে CLAUDE.md-এর CSS নিয়মে OS-এর পছন্দ হারে (দুই দিকেই), সরালে আবার
  `prefers-color-scheme`। শুধু এই পেজে, সেভ হয় না (সেটিংস ধাপ ৬)।
- ভাষার `SegmentedControl`-এর `onChange`-এ আবার `isLanguage` — `options` `LANGUAGES` থেকে বানানো, কিন্তু `.map()`
  literal টাইপ হারায় (`string`), তাই guard।

---

## ৪.১০ — bundle-size gate: বাজেট এবার আসল

ধাপ ০ থেকে CI-তে `Bundle size` ধাপ আছে, কিন্তু root `package.json`-এ `"test:bundle-size": "echo 'skipped: lands in step 4'"`।

**ফাইল: `apps/app/vite.config.ts`** (আপডেট — `build` লাইন যোগ)

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  // dist/.vite/manifest.json: কোন chunk কোন chunk-কে import করে — bundle-size চেক এটা পড়ে
  build: { manifest: true },
});
```

- `manifest: true` — build `dist/.vite/manifest.json` লেখে: প্রতিটা chunk-এর ফাইলের নাম, সে entry কি না, lazy entry
  কি না, আর কোন কোন chunk সে static-ভাবে import করে। প্রথম লোডের সঠিক হিসাব এই import-গাছ থেকেই আসে।

**ফাইল: `apps/app/scripts/check-bundle-size.ts`** (নতুন ফাইল)

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { z } from 'zod';

// system-design §৬.১: প্রথম লোডের JS < 200 KB gz, প্রতিটা lazy chunk < 100 KB gz
const INITIAL_BUDGET = 200 * 1024;
const CHUNK_BUDGET = 100 * 1024;

const dist = path.resolve(import.meta.dirname, '../dist');

// JSON.parse ফেরত দেয় any — Zod দিয়ে আকার যাচাই করে টাইপ পাওয়া (rule ৩)
const manifestSchema = z.record(
  z.string(),
  z.object({
    file: z.string(),
    isEntry: z.boolean().optional(),
    isDynamicEntry: z.boolean().optional(),
    imports: z.array(z.string()).optional(),
  }),
);

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8')),
);

function gzipBytes(file: string): number {
  return gzipSync(readFileSync(path.join(dist, file))).length;
}

// "প্রথম লোড" = entry আর যা কিছু সে static import করে (import(), মানে lazy, বাদ)।
// শুধু index-*.js ফাইল মাপলে ভুল হতো: Vite শেয়ার করা কোড আলাদা chunk-এ ভাগ করে
function collect(key: string, seen: Set<string>): void {
  if (seen.has(key)) return;
  seen.add(key);
  for (const child of manifest[key]?.imports ?? []) collect(child, seen);
}

const initial = new Set<string>();
for (const [key, chunk] of Object.entries(manifest)) {
  if (chunk.isEntry) collect(key, initial);
}

const sumBytes = (keys: Iterable<string>) =>
  [...keys].reduce((sum, key) => sum + gzipBytes(manifest[key]?.file ?? ''), 0);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
let failed = false;

const initialBytes = sumBytes(initial);
console.log(`initial JS  ${kb(initialBytes)} gz  (budget ${kb(INITIAL_BUDGET)})`);
if (initialBytes > INITIAL_BUDGET) failed = true;

// একটা রুটে ঢুকলে যা নতুন নামে: তার chunk + সে যেসব শেয়ার করা chunk টানে, যা প্রথম লোডে
// আসেনি। শুধু রুটের নিজের ফাইল মাপলে DataTable-এর মতো শেয়ার করা chunk হিসাবের বাইরে থেকে যেত
for (const [key, chunk] of Object.entries(manifest)) {
  if (!chunk.isDynamicEntry) continue;
  const route = new Set<string>();
  collect(key, route);
  const bytes = sumBytes([...route].filter((child) => !initial.has(child)));
  console.log(`lazy ${key}  ${kb(bytes)} gz  (budget ${kb(CHUNK_BUDGET)})`);
  if (bytes > CHUNK_BUDGET) failed = true;
}

if (failed) {
  console.error('Bundle budget exceeded — lazy-load the heavy part or remove a dependency.');
  process.exit(1);
}
```

**কোন লাইন কেন:**

- `size-limit` না, নিজের ৬০ লাইন — `size-limit` ফাইলের glob মাপে (`dist/assets/index-*.js`)। Vite (Rolldown) শেয়ার
  করা কোড নিজের নামে আলাদা chunk-এ ভাগ করে (`api-*.js`, `HugeiconsIcon-*.js`), যেগুলো প্রথম লোডেই আসে কিন্তু
  glob-এ ধরা পড়ে না। manifest-এর import-গাছ ধরে হাঁটলে ঠিক সেই ফাইলগুলো পাওয়া যায় যা ব্রাউজার প্রথমেই নামায়।
  আর একটা dependency কম।
- `manifestSchema.parse(JSON.parse(...))` — `JSON.parse` ফেরত দেয় `any`। Zod দিয়ে আকার যাচাই করলে টাইপ আসে
  schema থেকে, আর Vite কখনো manifest-এর আকার বদলালে স্ক্রিপ্ট স্পষ্ট error দেয়, ভুল সংখ্যা না (rule ৩)।
- `import.meta.dirname` — Node 20.11+-এর; `fileURLToPath(import.meta.url)`-এর ঝামেলা ছাড়াই স্ক্রিপ্টের ফোল্ডার।
- `gzipSync` — বাজেট gzip-এ (system-design §৬.১), কারণ ব্রাউজার gzip/brotli-তেই নামায়।
- `collect()` শুধু `imports` অনুসরণ করে, `dynamicImports` না — `import()` মানে lazy, প্রথম লোডে আসে না।
- lazy রুটের হিসাব = রুটের chunk + সে যেসব শেয়ার করা chunk টানে **বাদ** যা প্রথম লোডে আগেই এসেছে। শুধু রুটের
  নিজের ফাইল মাপলে (প্রথম সংস্করণ তাই করত) DataTable-এর মতো শেয়ার করা chunk কোনো বাজেটেই পড়ত না।
- `process.exit(1)` — CI-তে ধাপটা লাল হয়। প্রথম build-এ এটা সত্যিই fail করেছিল (236.1 KB), আর সেটাই ৪.৯-এর
  lazy route-এর কারণ।

এটা Node সরাসরি চালায় (`node scripts/check-bundle-size.ts`) — Node 22.18+/24-এ TypeScript-এর টাইপ মুছে দিয়ে চালানো
(type stripping) ডিফল্টে চালু, `tsx` বা build লাগে না। শর্ত: শুধু "মুছে ফেলা যায়" এমন TypeScript (interface, type
annotation) — `enum` বা `namespace` চলে না। নিচের tsconfig সেটা পাহারা দেয়।

**ফাইল: `apps/app/scripts/tsconfig.json`** (নতুন ফাইল)

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

- আলাদা tsconfig কেন: app-এর `src` browser কোড (`lib: DOM`, `types: vite/client`), আর এই স্ক্রিপ্ট Node কোড
  (`node:fs`, `process`)। এক tsconfig-এ দুটো মেশালে browser কোডে `process` লেখা compile হয়ে যেত।
- ফাইলের নাম `tsconfig.json` (`tsconfig.scripts.json` না) — ESLint-এর `projectService` প্রতিটা ফাইলের সবচেয়ে কাছের
  `tsconfig.json` খোঁজে; অন্য নাম দিলে lint "file not in any project" দিয়ে থামত।
- `erasableSyntaxOnly: true` — `enum` ইত্যাদি লিখলে compile error, যাতে Node-এর type stripping-এ স্ক্রিপ্ট না ভাঙে।

**ফাইল: `apps/app/package.json`** (আপডেট — `scripts`; dependency গুলো উপরের কমান্ড বসিয়েছে)

```json
{
  "name": "@omnivo/app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit && tsc --noEmit -p scripts",
    "test": "vitest run --passWithNoTests",
    "test:bundle-size": "node scripts/check-bundle-size.ts"
  },
  "devDependencies": {
    "@omnivo/config": "workspace:*",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^26.6.2",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^6.0.3",
    "vite": "^8.3.0",
    "vitest": "^5.0.1"
  },
  "dependencies": {
    "@hookform/resolvers": "^5.9.1",
    "@hugeicons/core-free-icons": "^4.3.5",
    "@hugeicons/react": "^1.1.10",
    "@omnivo/contracts": "workspace:*",
    "@omnivo/i18n": "workspace:*",
    "@omnivo/ui": "workspace:*",
    "@tanstack/react-router": "^1.170.39",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-hook-form": "^7.89.0",
    "zod": "^4.6.5",
    "zustand": "^5.0.15"
  }
}
```

- `typecheck`-এ দ্বিতীয় `tsc -p scripts` — স্ক্রিপ্টের নিজের tsconfig আলাদা, তাই আলাদা করে চেক।

**ফাইল: `turbo.json`** (আপডেট — `tasks`-এ শেষে যোগ)

```json
    "test:bundle-size": {
      "dependsOn": ["build"]
    }
```

- `"build"` (`^` ছাড়া) — **নিজের** প্যাকেজের build আগে (dist ছাড়া মাপার কিছু নেই); `^build` মানে dependency-দের।
  `outputs` দেওয়া হয়নি — এটা শুধু চেক, কিছু তৈরি করে না, তাই cache হিট হলে turbo আগের ফল দেখায়।
- turbo-র build cache `dist/**` ফেরত আনলে `.vite/manifest.json`-ও আসে (লুকানো ফোল্ডার হলেও) — `dist` মুছে cache
  থেকে build করিয়ে যাচাই করা।

**ফাইল: root `package.json`** (আপডেট — শুধু এক লাইন)

```json
    "test:bundle-size": "turbo run test:bundle-size",
```

CI (`.github/workflows/ci.yml`)-এ বদল লাগে না — `Bundle size` ধাপ আগে থেকেই `pnpm test:bundle-size` চালায়।

```bash
pnpm test:bundle-size
# initial JS  144.6 KB gz  (budget 200.0 KB)
# lazy src/routes/app-shell.tsx  41.2 KB gz  (budget 100.0 KB)
# lazy src/routes/dashboard.tsx  29.1 KB gz  (budget 100.0 KB)
# lazy src/routes/login.tsx  35.7 KB gz  (budget 100.0 KB)
# lazy src/routes/sign-up.tsx  26.8 KB gz  (budget 100.0 KB)
```

---

## ৪.১১ — ESLint আর module boundary

```bash
pnpm --filter @omnivo/config add -D 'eslint-plugin-react-hooks@^7.1.1'
```

**ফাইল: `packages/config/eslint/index.js`** (আপডেট — পুরোটা এভাবে)

```js
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/.turbo/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  // Hooks only at the top level of components/hooks, and effect dependencies stay complete.
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      // Only matters with the React Compiler, which we do not run. It flags every
      // TanStack Virtual/Table hook, so the warning would be permanent noise.
      'react-hooks/incompatible-library': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  {
    // Plain JS here is only Node config files. TS files get their globals from each
    // tsconfig's lib/types (DOM for app/ui/i18n, node for api/db/auth), not from ESLint.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
```

**কোন লাইন কেন:**

- `reactHooks.configs.flat.recommended` — এখন তিনটা প্যাকেজে hook: hook শর্তের ভেতরে ডাকা (`if (x) useState()`)
  বা effect-এর dependency বাদ পড়া — দুটোই চুপচাপ bug, compile হয়। `recommended-latest` না — সেটা experimental
  React Compiler-এর নিয়ম।
- সব ফাইলে লাগানো (শুধু `.tsx`-এ না) — hook `.ts` ফাইলেও থাকে (`use-locale.ts`, `use-media-query.ts`)। নিয়মগুলো শুধু
  `use…` নামের ফাংশন আর component-এ চলে, তাই API-র কোডে কিছু হয় না।
- `'react-hooks/incompatible-library': 'off'` — চালু থাকলে প্রতিটা `useVirtualizer`-এ warning দেয়: "React Compiler
  এই component memoize করবে না"। আমরা React Compiler চালাই না, তাই এটা স্থায়ী গোলমাল হতো।
- এই plugin-এর `set-state-in-effect` নিয়ম **error** — ড্যাশবোর্ডের effect-এর বদল (৪.৯) এর জন্যই।
- `globals` এখন শুধু `*.js/*.cjs/*.mjs`-এ, আর শুধু Node — ধাপ ০-এর মন্তব্য বলেছিল "Split … in step 4"। কেন এটুকুই
  যথেষ্ট: typescript-eslint TS ফাইলে `no-undef` বন্ধ রাখে, কারণ TypeScript নিজেই অচেনা নাম ধরে। TS ফাইলের global
  আসে প্রতিটা tsconfig-এর `lib`/`types` থেকে — app/ui/i18n-এ `DOM`, api/db/auth-এ `node`। আসল সীমানা সেখানেই।
  ESLint-এর globals শুধু plain JS config ফাইলের জন্য লাগে, আর সেগুলো সবই Node-এ চলে।

**ফাইল: `.dependency-cruiser.cjs`** (আপডেট — পুরোটা এভাবে)

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports break module boundaries and tree-shaking.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      comment: 'Shared packages are used by apps, never the other way round.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'browser-packages-not-to-server',
      severity: 'error',
      comment:
        'ui and i18n ship to the browser. Importing db or auth would bundle server code and secrets handling into the app.',
      from: { path: '^packages/(ui|i18n)/' },
      to: { path: ['^packages/(db|auth)/', 'node_modules/(better-auth|drizzle-orm|postgres)/'] },
    },
    // Module boundary rules inside apps/api (accounting must not import inventory internals,
    // etc.) get added as the modular monolith takes shape — steps 6-8.
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|build|coverage)(/|$)' },
  },
};
```

- `packages-not-to-apps` — প্যাকেজ app-কে import করলে নির্ভরতা উল্টো দিকে যায়, আর প্যাকেজ আর আলাদা থাকে না।
- `browser-packages-not-to-server` — ui বা i18n ভুল করে `@omnivo/db` বা `@omnivo/auth` import করলে সার্ভারের কোড (DB
  driver, টোকেন সই করা) browser bundle-এ চলে যেত। TypeScript এটা ধরত না যদি কেউ dependency যোগ করে দেয়।
- **ইচ্ছা করে ভেঙে যাচাই করা:** ui-তে `packages/db/src/client`-এর import আর i18n-এ `apps/app/src/router`-এর import বসিয়ে
  `pnpm boundaries` চালালে দুটোই `error` দেয়; সরালে আবার `no dependency violations found`।

---

## ৪.১২ — ডকুমেন্ট হালনাগাদ

**CLAUDE.md** — ইতিমধ্যে হালনাগাদ করা (২০২৬-০৯-২৮, "If something is missing, extend this section first" নিয়মে),
তাই এই ধাপে হাতে কিছু করতে হবে না। যা যোগ হয়েছে:

- Components: Checkbox-এর টিক আর label, Money input, Date picker, Data table (ফোনে কার্ড, `meta.card`, কার্ডের
  ভেতরে কার্ড না), Page header, Section header, Empty state, Icon button, Dropdown menu / popover; Sidebar nav-এ
  `aria-current` আর ফোনের আড়াআড়ি সারি।
- Content: বাংলায় টাকা আর তারিখের রূপ, টাকা সবসময় decimal string, আর নতুন **Language** নিয়ম (সব লেখা `t()` দিয়ে,
  আগে `en.ts` পরে `bn.ts`; লগইন/সাইনআপ ধাপ ৫ পর্যন্ত ব্যতিক্রম)।
- Interaction: class জোড়া শুধু `cn()` দিয়ে।
- Tailwind wiring: stylesheet-এর জায়গা `packages/ui/src/styles.css` (ধাপ ৪ ইমপ্লিমেন্ট হওয়ার আগে পর্যন্ত
  `apps/app/src/styles.css`), app-এর `@import` ক্রম আর `@source`।

**COMMANDS.md** — "Checks" অংশে:

```sh
pnpm test:bundle-size # build the app, then fail if first-load JS > 200 KB gz or a route chunk > 100 KB gz
```

আর "Run the full stack"-এর নিচে: kitchen sink = `http://localhost:5173/kitchen-sink` (শুধু `pnpm dev`-এ, লগইন লাগে)।

**build-plan.bn.md** — "৯. অগ্রগতি"-তে ধাপ ৪–৫ একসাথে একটা ঘর; ধাপ ৫ শেষে টিক দিন। চাইলে ধাপ ৪-এর অংশে "Hind
Siliguri" → "Noto Sans Bengali" আর "মোবাইলে বটম ট্যাব" → "টপ বার + আড়াআড়ি nav" (ভিত্তি-সিদ্ধান্ত ১)।

---

## ৪.১৩ — রান করুন

```bash
pnpm install                 # lockfile আপডেট
pnpm dedupe --check          # react, react-hook-form, i18next — প্রতিটার একটাই কপি?
pnpm dev                     # API :3000, app :5173, আর পাঁচ প্যাকেজের tsc --watch
```

DB-তে কোনো migration নেই এই ধাপে।

`pnpm dev`-এ ui বা i18n-এর ফাইল বদলালে তাদের `tsc --watch` `dist` আবার লেখে, আর Vite সেটা দেখে পেজ আপডেট করে —
আলাদা কিছু চালাতে হয় না।

### যা দেখবেন

1. `http://localhost:5173` → লগইন পেজ। "Keep me signed in"-এর চেকবক্স এখন ১৭px, brand ভরাট, সাদা টিক; লেখায় ক্লিক
   করলেও বদলায়। ফাঁকা ফর্মে "Sign in" → প্রতিটা ফিল্ডের নিচে লাল লেখা + আইকন।
2. সাইনআপ → "Rahman Garments Ltd." লিখলে ঠিকানায় `rahman-garments`। ঠিকানা নিজে বদলে তারপর কোম্পানির নাম বদলান —
   ঠিকানা আর বদলায় না। অন্য ব্রাউজারে একই ঠিকানায় আবার সাইনআপ → সার্ভারের error ঠিকানা-ফিল্ডের নিচেই।
3. ড্যাশবোর্ড → "Team" শিরোনামের নিচে টেবিল: avatar tile, নাম, ইমেইল, "Owner"। হেডারে ক্লিক করলে sort।
4. সাইডবারের নিচে আপনার নাম → মেনু → "বাংলা" → সব বাংলায়: "সারসংক্ষেপ", তারিখ `২৮ সেপ, ২০২৬`। reload করলেও বাংলা
   থাকে। DevTools → Elements: `<html lang="bn">`।
5. সাইডবারে "Kitchen sink" (শুধু dev-এ):
   - "Formatting" কার্ডে ভাষা বদলালে `৳18,42,600` ↔ `৳১৮,৪২,৬০০`।
   - ফর্ম: কিছু না লিখে "Save draft" → তিনটা error। "LC amount"-এ বাংলা কীবোর্ডে `১৮৪২৬০০.৫` → ফিল্ড ছাড়লে
     `18,42,600.50`। অক্ষর টাইপ করলে কিছুই হয় না। "Latest shipment date" → ক্যালেন্ডার (বাংলায় মাস, দিন, অঙ্ক সব
     বাংলা)। সব পূরণ করে জমা → নিচে কালো toast "LC 0126-2409 saved as draft"।
   - Data table: ১০,০০০ রো মসৃণভাবে scroll হয়। DevTools-এ `<tbody>` খুললে মাত্র ~২০টা `<tr>`। "Value"-তে দুবার
     ক্লিক → বড় থেকে ছোট। রো-তে ক্লিক → toast।
   - উপরের "Dark" → সব dark token-এ (primary বাটন হালকা নীল, লেখা গাঢ়)।
6. DevTools-এর device toolbar-এ ৩৯০px: সাইডবার উপরে বার, nav আড়াআড়ি, user মেনু ডানের আইকনে; টেবিলের জায়গায় কার্ড
   (PO, buyer, টাকা ডানে, নিচে Style/Qty/Ship by/Status)। পেজ আড়াআড়ি scroll করে না।
7. দুই workspace-এর ইউজার হলে (ধাপ ৭-এর invite না আসা পর্যন্ত `pnpm db:psql`-এ membership যোগ করে দেখা যায়)
   workspace-এর বাটন → মেনু → অন্যটা বাছলে টিক সরে, toast "Switched to …", টিম-তালিকা বদলায়।
8. `pnpm test:bundle-size` → তালিকায় `app-shell`, `dashboard`, `login`, `sign-up` আছে, `kitchen-sink` নেই —
   production build-এ সেই chunk তৈরিই হয়নি। `pnpm dev`-এ DevTools → Network (JS ফিল্টার) খুলে লগইন পেজ reload করুন:
   `dashboard.tsx` নামে না; লগইনের পরে নামে।

---

## যাচাইয়ের তালিকা

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # ৪১টা: আগের ১৬ + i18n ৯ + ui ১৬ — Docker লাগে না
pnpm test:integration        # ২০টা — Docker চালু থাকতে হবে (API-তে বদল নেই)
pnpm test:tenant-leak        # ৯টা
pnpm build
pnpm test:bundle-size        # প্রথম লোড < 200 KB gz, প্রতিটা রুট < 100 KB gz
pnpm boundaries
```

একটা সৎ নোট: যাচাইয়ের সময় প্রথমবার `pnpm test:integration` fail করেছিল। কারণ ধরা পড়েনি — সেই রানের error-লগ
রাখা হয়নি; পরপর দুবার (একবার সরাসরি, একবার turbo দিয়ে) চালালে ২০টাই পাস, আর এই ধাপে API-র কোড বদলায়নি।
আপনার মেশিনে আবার fail করলে পুরো লগ রেখে দেখুন — একটা অস্থির (flaky) integration টেস্ট থাকলে সেটা আলাদা
করে ধরা দরকার।

---

## পরের ধাপগুলোর জন্য রেখে যাওয়া নোট

**ধাপ ৫ (contracts + codegen):**

- error envelope-এ মেসেজের সাথে **code** (`slug_taken`, `invalid_credentials`) — তখন লগইন/সাইনআপ আর Zod-এর
  মেসেজ `en.ts`/`bn.ts`-এ অনুবাদ হবে, আর `applyApiError` code থেকে `t()` ডাকবে।
- DataTable-এ keyset pagination: `manualSorting` + সার্ভারের cursor; `tableFeatures`-এ `rowPaginationFeature`।
  client-side sort তখন শুধু ছোট তালিকায়।
- TanStack Query এলে ড্যাশবোর্ডের `useEffect` + `cancelled` ফ্ল্যাগ মুছে `useQuery` — race আর retry সে সামলাবে।

**ধাপ ৬ (settings):**

- থিম আর ভাষার পছন্দ ইউজার-প্রোফাইলে (সার্ভারে) — এখন ভাষা শুধু এই ডিভাইসের `localStorage`-এ, থিম সেভই হয় না।
- প্রথম আসল ফিচার-ফর্মের সাথে Playwright (`pnpm test:e2e`, ডেস্কটপ + ৩৯০px) — এই ধাপের হাতে-কলমে flow গুলোই প্রথম
  টেস্ট।

**ধাপ ৭ (users + roles):** invite মডালের জন্য `Dialog` (Radix + token, একই ছাঁচ); permission matrix-এর চেকবক্সে ui-র
`Checkbox`।

**ধাপ ২২–২৩ (web, admin):** `@import 'tailwindcss'; @import '@omnivo/ui/styles.css';` আর `AppShell`-এ অন্য nav —
আর কিছু লাগবে না। Astro (`apps/web`)-এ React component island হিসেবে চলবে।

**সতর্কতা:** `packages/ui`-তে কখনো module-level side effect (import হলেই কিছু বদলায় এমন কোড) লিখবেন না —
`"sideEffects": false` bundler-কে সেটা মুছে ফেলার অনুমতি দেয়। এমন কিছু লাগলে (যেমন i18n init) আলাদা প্যাকেজে
রাখুন, যেমন `@omnivo/i18n`।
