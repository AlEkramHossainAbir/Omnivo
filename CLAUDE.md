# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Omnivo — a multi-tenant, offline-first cloud ERP. See [README.md](README.md) for the
product overview and tech stack, [docs/system-design.bn.md](docs/system-design.bn.md)
for the architecture, and [docs/adr/](docs/adr/) for decision records.

## Working agreement

### 1. I write the code, you tell me what to do

I prefer to write the code myself. Do **not** write or edit any line of code until I
explicitly tell you to.

By default, your output is guidance, not code:

- Explain what to do and why, step by step.
- Name the exact files and locations to touch (`path/to/file.ts:42`).
- Describe the approach, the data flow, the edge cases and the trade-offs.
- Point out what will break and what needs to change alongside it.

Short illustrative snippets inside your explanation are fine when they make the
instruction clearer, but do not apply them to files. Never call Edit, Write or
`sed`-style file mutations on source files until I say "write it", "implement it",
"apply it" or something equally explicit.

Non-source files I asked you to maintain (this file, notes, docs I requested) are
excluded from this rule.

Reading, searching, running type checks, tests and other read-only commands are
always allowed without asking.

### 2. Type check every line

TypeScript is end to end here. Everything you propose must type check.

- After I implement something, run the type checker before declaring it done.
- Reason about types as you explain: what the inferred type is, where it narrows,
  where it can be `null` or `undefined`.
- Prefer types inferred from the source of truth — Zod schemas (`z.infer`), Drizzle
  table types (`InferSelectModel` / `InferInsertModel`) — over hand-written duplicates.

### 3. Never use `any`

`any` is banned. No `any`, no implicit `any`, no silent `as any` escape hatch.

When the type is genuinely unknown, use `unknown` and narrow it with a type guard or
a Zod `parse`. Prefer generics, discriminated unions and `satisfies` over casts. If a
third-party library forces a cast, say so explicitly and keep it in one isolated,
commented place instead of spreading it.

`@ts-ignore` and `@ts-expect-error` need the same justification.

### 4. HugeIcons for all icons

Every icon comes from [HugeIcons](https://hugeicons.com) (`hugeicons-react`). Do not
introduce lucide-react, react-icons, heroicons, Font Awesome or inline SVG icon sets,
and do not mix icon libraries — even if a shadcn/ui snippet ships with lucide by
default; swap it for the HugeIcons equivalent.

Keep the icon style consistent across the app (one variant — stroke/solid — chosen
once and used everywhere).

### 5. ফিচার নিয়ে আলোচনা বাংলায় করতে হবে

আমি যখনই কোনো ফিচার তৈরি করতে চাই, চেষ্টা করি বা জিজ্ঞেস করি, তখন কোড না লিখে
(নিয়ম ১ অনুযায়ী) নিচের কাঠামোতে বাংলায় পরামর্শ দাও:

- **কী করতে হবে** — approach/পদ্ধতিটা কী, ধাপে ধাপে।
- **কেন** — এই পদ্ধতিই কেন উপযুক্ত, অন্য অপশনের তুলনায় trade-off কী।
- **কোথায়** — ঠিক কোন ফাইল, কোন লোকেশনে যোগ/তৈরি/সরাতে হবে
  (`path/to/file.ts:42` ফরম্যাটে)।
- **কী বাদ দিতে/সরাতে হবে** — পুরনো কোনো কোড, ফাইল বা dependency বাদ দেওয়া লাগলে
  সেটা স্পষ্ট করে বলো।

ব্যাখ্যা/আলোচনার পুরো অংশ বাংলায় লিখতে হবে। ফাইলের পাথ, ভেরিয়েবল নাম, ফাংশন নাম,
টাইপ নাম ইত্যাদি টেকনিক্যাল টার্ম যেমন আছে তেমনই (ইংরেজিতে) থাকবে — শুধু অনুবাদ
করার দরকার নেই। ছোট illustrative কোড স্নিপেট ব্যাখ্যার ভেতরে দেখানো যাবে, কিন্তু
তার comment/description বাংলাতেই হবে।

## Website / Landing page

কখনো marketing website বা landing page তৈরির দরকার হলে, সেটা plain/static স্ক্রলের
বদলে **3D scroll animation** কেন্দ্রিক (scroll position-এর সাথে sync করা 3D/parallax
মোশন, Awwwards-ঘরানার scroll-triggered ইন্টারঅ্যাকশন) হতে হবে — এটা ডিফল্ট প্রত্যাশা।

- ইমপ্লিমেন্টেশন শুরুর আগে stack confirm করে নিতে হবে: scroll-driven animation-এর
  জন্য GSAP (ScrollTrigger) বা Framer Motion, আর আসল 3D-এর জন্য Three.js /
  React Three Fiber — এগুলোর মধ্যে কোনটা নেওয়া হবে সেটা প্রতিটা landing page শুরুর
  আগে আলাদা করে ঠিক করতে হবে (rule 1 অনুযায়ী guidance আগে, কোড পরে)।
- performance trade-off মাথায় রাখতে হবে — ভারী 3D/scroll effect মোবাইল বা লো-এন্ড
  ডিভাইসে স্লো হতে পারে, তাই lazy-load এবং reduced-motion fallback বিবেচনা করা উচিত।
