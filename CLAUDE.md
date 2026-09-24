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
once and used everywhere). **The chosen variant is Stroke Rounded** (the free
`@hugeicons/core-free-icons` set, 1.5px stroke, `currentColor`). Sizes: 18px default,
17px inside inputs and buttons, 16px in list/table rows, 13–14px inside pills.

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

## App UI design system (approved 2026-09-24)

Every screen in the ERP app, Admin console and auth flows (login, sign-up) uses this
system. Reference mockups: login, sign-up, admin (Omnivo artifacts, v3). Treat the
values below as the source of truth. Do not invent new colors, sizes or radii. If
something is missing, extend this section first, then use it.

**Character:** minimal, light, corporate, still attractive. The audience is garments,
pharmaceutical, distribution and manufacturing companies in Bangladesh, so the UI has
to feel like trustworthy business software. Attractiveness comes from spacing, crisp
type, soft shadows and real, industry-specific content, never from decoration.

**Never in the app UI:** WebGL/3D, glassmorphism, tilt or parallax, gradients as
decoration, glow, dark-luxury themes, security-print or ornamental patterns, emoji,
more than one accent color. (Both directions were tried and rejected.) Heavy 3D and
motion belong only on the marketing website, per the section below.

### Color tokens

Define these as CSS variables and map them into Tailwind (see "Tailwind wiring"). Use
only the tokens in components, never raw hex values.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#F6F7F9` | `#0B0F17` | Page background |
| `surface` | `#FFFFFF` | `#111722` | Cards, inputs, sidebar, table |
| `subtle` | `#F1F3F6` | `#171E2B` | Table header, hover rows, KPI wells, secondary fills |
| `line` | `#E4E7EC` | `#212938` | Card borders, dividers, table rules |
| `line-strong` | `#D0D5DD` | `#2F394B` | Input and secondary-button borders |
| `ink` | `#0F1728` | `#EEF1F6` | Primary text, headings, numbers |
| `ink-2` | `#475467` | `#A3ADBD` | Body/secondary text, nav items |
| `ink-3` | `#8A94A6` | `#6B768A` | Labels, hints, placeholders, axis text, icons at rest |
| `brand` | `#1F47B5` | `#7C9CF2` | The single accent: primary buttons, links, active nav, focus, chart line |
| `brand-hover` | `#193B97` | `#95AFF5` | Primary button hover |
| `brand-soft` | `#EDF1FB` | `#16203A` | Active nav background, selected card, brand pill, auth side panel |
| `brand-line` | `#C9D5F3` | `#2A3A66` | Borders on brand-soft areas, secondary bars |
| `brand-ink` | `#FFFFFF` | `#0B0F17` | Text/icons on `brand` |
| `good` / `good-bg` | `#0A7A4B` / `#ECF8F1` | `#4CC98F` / `#0E2A1E` | Success, active, synced, positive change |
| `warn` / `warn-bg` | `#B25E09` / `#FEF6E7` | `#F2B35A` / `#2C2211` | Pending, delayed sync, attention |
| `crit` / `crit-bg` | `#B42318` / `#FEF1F0` | `#F4837A` / `#321614` | Errors, failed payment, overdue, destructive |

Rules:
- Status colors (`good`/`warn`/`crit`) are semantic only. Never use them as a second
  accent or a chart series color. Always pair them with an icon and a label, never
  color alone.
- The dark theme follows `prefers-color-scheme` plus a `[data-theme="dark"]` override
  (`[data-theme="light"]` must beat a dark OS). Set `color-scheme: dark` on the dark
  palette.
- Focus ring: `0 0 0 4px` of `brand` at 14% opacity (dark: 20%), plus a `brand` border
  on inputs. Error inputs use a `crit` border and a `crit-bg` ring.

### Typography

- **Family:** `Geist` (400, 500, 600) for everything, and `Geist Mono` (400, 500) only
  for code-like values: workspace URLs in monospace contexts, IDs, keyboard hints.
  Fallback stack: `"Geist", "Noto Sans Bengali", "Segoe UI", system-ui, sans-serif`.
  `Noto Sans Bengali` is in the stack for the `৳` glyph and Bangla text. Self-host the
  fonts (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`,
  `@fontsource/noto-sans-bengali`) rather than calling Google Fonts at runtime (the app
  is offline-first).
- **No other families.** No serif display faces. Hierarchy comes from size and weight
  only.
- Headings use weight 600, `letter-spacing: -0.02em` and `text-wrap: balance`. Large
  numbers use `-0.03em`.
- Every number that lines up or updates (money, counts, tables, KPIs) uses
  `font-variant-numeric: tabular-nums` (Tailwind `tabular-nums`).

| Role | Size / line-height | Weight | Where |
|---|---|---|---|
| `display` | 34px / 1.15 | 600 | Auth side-panel headline only |
| `h1` page title | 26px / 1.2 (auth form: 28px) | 600 | Page headers ("Overview", "Sign in") |
| `h2` section | 24px / 1.25 | 600 | Wizard step titles |
| `kpi` | 26px / 1.1 | 600 | KPI values |
| `h3` card title | 15px / 1.4 | 600 | Card and panel titles |
| `body` | 14.5px / 1.5 | 400 | Default body, inputs, buttons |
| `body-sm` | 13.5px / 1.45 | 400–500 | Table cells, nav items, list rows, secondary buttons |
| `label` | 13px / 1.4 | 500 | Form labels, card subtitles (`ink-3`) |
| `caption` | 12px / 1.35 | 500 | Pills, KPI labels, table headers, footnotes |
| `micro` | 11px / 1.3 | 400 | Chart axes only |

### Shape, spacing, elevation

- **Radius:** `10px` for controls (inputs, buttons, list rows, industry cards). `14px`
  for cards and panels. `8px` for small items (nav items, chips, table avatars, icon
  tiles). `999px` for pills. `20px` only for the large auth side panel.
- **Spacing:** 4px base. Common steps are 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32.
  Card padding is 20px (32px for wizard panels, 22px/18px on mobile). Gaps between
  cards are 20px. Form field stacks use an 18–20px gap. Label-to-input gap is 6px.
- **Page gutters:** content padding is 32px on desktop and 16px on phones. Never let
  the page body scroll sideways; wide tables scroll inside their own container.
- **Shadows (light):**
  - `shadow-sm`: `0 1px 2px rgba(16,24,40,.05)` on inputs, buttons and cards at rest.
  - `shadow`: `0 1px 2px rgba(16,24,40,.04), 0 8px 24px -6px rgba(16,24,40,.10)` on
    wizard panels and tooltips.
  - `shadow-lg`: `0 2px 4px rgba(16,24,40,.04), 0 24px 48px -12px rgba(16,24,40,.16)`
    on floating previews, popovers and toasts.
  - The dark theme uses the same offsets with black at 30–60%.
- **Borders:** 1px `line` on every card. Lift with a shadow only when an element
  floats. Not everything needs to be a card.
- **Layout:** the app shell is a 244px sidebar plus fluid content. Below 860px the
  sidebar collapses to a top bar with horizontal nav. Grids collapse to one column on
  phones.

### Components

- **Primary button:** `brand` background, `brand-ink` text, weight 500, 14.5px, height
  42px (36px for `sm`), radius 10px, padding 0 16px, `shadow-sm`, hover `brand-hover`.
  Use one primary button per view.
- **Secondary button:** `surface` background, 1px `line-strong` border, `ink` text,
  hover `subtle`.
- **Text link / inline action:** `brand` text, weight 500, underline on hover (3px
  offset).
- **Input:** height 42px, `surface` background, 1px `line-strong` border, radius 10px,
  17px leading icon in `ink-3` (it stays `ink-3` on focus), `shadow-sm`. Hover border is `ink-3`. Focus uses a `brand` border plus the ring.
  Suffixes/prefixes (`.omnivo.app`, `+880`) sit inside the control in `ink-3`/`ink-2`.
- **Form label:** sits above the input, 13px/500 `ink`. Optional fields say
  "(optional)" in `ink-3`. Errors show below the input as `crit` text with an
  `Alert02` icon, and the message says what to fix.
- **Checkbox:** 17px, radius 5px, checked fill `brand`.
- **Pill / status badge:** 12px/500, radius 999px, padding 2px 8px 2px 6px, soft
  background plus a matching icon. Variants: `good` (Active, Synced), `warn` (Sync
  delayed), `crit` (Payment due), `brand` (Trial, Recommended), neutral (`subtle` +
  `ink-3`, e.g. Suspended).
- **Card:** `surface`, 1px `line`, radius 14px, `shadow-sm`. The header is a 15px/600
  title plus a 13px `ink-3` subtitle, padded 18px 20px 0.
- **KPI strip:** one card split into equal cells by 1px `line` dividers (not separate
  cards). Each cell has a caption label, a 26px/600 value and a 12.5px change line
  (`good`/`crit` with an arrow icon).
- **Table:** header row on `subtle` with 12px/500 `ink-3` text. Cells are 13.5px with
  12px 20px padding and 1px `line` rules. Row hover is `subtle`. Numbers are
  right-aligned and `tabular-nums`. The first column is a 30px avatar tile
  (`brand-soft`/`brand` initials) plus the name and an `ink-3` sub-line. Wrap tables
  in an `overflow-x-auto` container.
- **Filter chips / segmented control:** radius 8px, 1px `line-strong` border. The
  selected chip is inverted (`ink` background, `bg` text). The selected segment uses a
  `subtle` background.
- **Sidebar nav:** 14px/500 `ink-2` items with `ink-3` icons, radius 8px, hover
  `subtle`. The active item uses a `brand-soft` background with `brand` text and icon.
  Group labels are 11.5px/500 `ink-3`. Counts are right-aligned (`crit` when they need
  action).
- **Stepper (wizards):** numbered 26px circles, which is valid because the steps are a
  real sequence. The current step has a `brand` border and ring. Done steps are filled
  `brand` with a `Tick02` icon.
- **Selectable card (industry, module):** 1px `line-strong` border. When selected it
  gets a `brand` border, a `brand-soft` background and a `brand` icon tile.
- **Toast:** `ink` background with `bg` text, radius 10px, `shadow-lg`, bottom-center,
  about 3s. The copy names what happened ("Workspace created").
- **Charts:** a single series uses a 2px `brand` line, a `brand` area fill fading from
  14% to 0, dashed `line` gridlines, 11px `ink-3` axis labels and an emphasized end
  point. Every chart gets a hover crosshair and tooltip (`surface`, `line` border,
  `shadow`). Magnitude bars use `brand`, with `brand-line` for de-emphasized bars.
  Never use dual axes.
- **Logo:** two offset rounded squares, a filled `brand` square and an outlined
  `brand` square (debit/credit columns), next to "Omnivo" in 17px/600.

### Content and formatting

- **Money:** BDT with lakh/crore grouping via `Intl.NumberFormat('en-IN')`, prefixed
  `৳` (e.g. `৳18,42,600`). No decimals unless the value is a unit price. Chart axes
  may abbreviate as `৳18L`.
- **Dates:** `23 Sep 2026` in UI, `September 2026` for periods. The fiscal year
  defaults to July – June.
- **Copy:** sentence case everywhere and active voice. Buttons say exactly what happens
  ("Create workspace", "Retry", "Export"). Errors say how to fix the problem, without
  apologies.
- Use industry-real examples in empty states and demos: buyer PO, LC, cutting/sewing,
  batch and expiry, depots, Mushak 6.3, bKash/SSLCommerz. Never use lorem ipsum.

### Interaction

- **Every clickable element shows `cursor: pointer`.** Tailwind v4's preflight resets
  `<button>` to `cursor: default`, so restore it once in the global stylesheet's base
  layer instead of adding it per component:

  ```css
  @layer base {
    /* সব clickable element-এ pointer cursor */
    button:not(:disabled),
    [role="button"]:not([aria-disabled="true"]),
    a[href],
    label[for],
    summary,
    select:not(:disabled),
    input[type="checkbox"]:not(:disabled),
    input[type="radio"]:not(:disabled),
    input[type="file"]:not(:disabled) {
      cursor: pointer;
    }
    /* disabled হলে not-allowed */
    :disabled,
    [aria-disabled="true"] {
      cursor: not-allowed;
    }
  }
  ```

  Any other custom clickable element (a table row that opens a detail view, a card
  that selects something) must add Tailwind's `cursor-pointer` class. Prefer a real
  `<button>` or `<a>` over a clickable `<div>`. shadcn/ui components copied into the
  repo must follow this too, so check their class strings.
- **Transitions:** 150ms for color, border and shadow only. No bounce and no scale.
  Respect `prefers-reduced-motion`.
- **Focus:** every interactive element shows a visible focus state, either the `brand`
  ring or a 2px `brand` outline with 2px offset.

### Tailwind wiring

Tokens live as CSS variables in the global stylesheet. Map them with Tailwind v4
`@theme inline` so utilities like `bg-surface`, `text-ink-2`, `border-line` and
`bg-brand-soft` exist. Shape of the mapping:

```css
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
  /* good / warn / crit এবং তাদের -bg একই ভাবে */
  --font-sans: "Geist", "Noto Sans Bengali", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --radius-control: 10px;
  --radius-card: 14px;
}
```

shadcn/ui's own variables (`--primary`, `--border`, `--ring`, `--muted` and so on)
must point at these tokens (`--primary: var(--brand)`, `--border: var(--line)`,
`--ring: var(--brand)`, `--muted: var(--subtle)`, `--muted-foreground: var(--ink-3)`)
so generated components match without per-component overrides.

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
