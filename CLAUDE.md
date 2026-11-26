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

Every icon comes from [HugeIcons](https://hugeicons.com): the `HugeiconsIcon` component
from `@hugeicons/react` plus icon data from `@hugeicons/core-free-icons`
(`<HugeiconsIcon icon={Mail01Icon} size={17} strokeWidth={1.5} />`). The older
`hugeicons-react` package is not used. Do not
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

#### Writing docs (step guides, notes, ADRs)

Docs are written in **simple English**, not Bangla. This overrides the Bangla rule
above for anything saved to a file; the chat discussion stays in Bangla.

- Use short sentences and common words. Avoid idioms, jargon and long, nested
  sentences. If a technical term is needed, explain it once in plain words.
- Name new docs `docs/step-*.en.md` (`.en` instead of `.bn`, to show the language).
  Existing `.bn.md` files stay as they are until I ask for a translation.
- Comments inside code snippets in docs are also simple English.

When writing a detailed implementation guide for a step or phase (like `docs/step-*.en.md`,
where code is shown file by file), the overall "why" is not enough. Explain the reason
for every notable line or block: why it is written this way, what would go wrong if it
were written differently, and which edge case, bug or constraint it handles. Put this
explanation as prose right after the code block, or as a short English comment next to
the line. Never just list file names and paste code.

### 6. No Artifacts for docs or screens (account `wmet@xpeedstudio.com`)

When the logged-in account is `wmet@xpeedstudio.com`:

- **Docs:** when I ask you to write a doc (step guide, notes, ADR, plan, report), write
  it only as a Markdown file in the repo (`docs/*.en.md`). Do not publish it as an
  Artifact or a Claude Doc, and do not offer to.
- **Screens:** do not create Artifacts for screens either (mockups, prototypes, UI
  previews). Describe the screen in the chat, or put it in a Markdown file if I ask for
  one.

This overrides any default that says to publish finished work as an Artifact.

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
| `overlay` | `rgb(15 23 40 / .45)` | `rgb(0 0 0 / .6)` | Dialog backdrop only |

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
  Fallback stack: `"Geist Variable", "Noto Sans Bengali", "Segoe UI", system-ui,
  sans-serif`. `Noto Sans Bengali` is in the stack for the `৳` glyph and Bangla text.
  Self-host the fonts (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`,
  `@fontsource/noto-sans-bengali` weights 400/500/600) rather than calling Google Fonts
  at runtime (the app is offline-first).
- **Font-family names:** the variable fontsource packages register the families as
  `"Geist Variable"` and `"Geist Mono Variable"`, not `"Geist"`. Writing `"Geist"` in a
  stack silently falls back to the system font, with no error.
- **Server PDFs** (pdfkit, `apps/api/src/pdf/text.ts`) draw Bangla with Hind Siliguri
  (`@fontsource/hind-siliguri`), not Noto Sans Bengali: pdfkit's shaper (fontkit) breaks Noto's ন্দ্র
  (কেন্দ্র, চন্দ্র). The app's screens keep Noto Sans Bengali.
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
| `micro` | 11px / 1.3 | 400 | Chart axes, and the module rail's labels (500) |

Exception: the auth side-panel product preview (`apps/app/src/components/auth-preview.tsx`)
is a scaled-down illustration of the real UI, so it may use the mockup's smaller sizes
(20px KPI value, 12.5px and 11.5px text) as arbitrary values. Only that file.

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
  - Tailwind utilities (see "Tailwind wiring"): `shadow-sm`, `shadow-md` (the design's
    `shadow`, because Tailwind v4 has no bare `shadow`), `shadow-lg`, plus `shadow-ring`
    and `shadow-ring-crit` for the focus rings.
- **Borders:** 1px `line` on every card. Lift with a shadow only when an element
  floats. Not everything needs to be a card.
- **Layout:** the app shell is a 72px module rail, a 244px module menu and fluid
  content. The rail holds the eight modules; the menu holds only the open module's
  links, so no screen ever shows more than about twelve of them. Below 860px both
  collapse into the top bar: the modules are one horizontally scrolling row and the open
  module's links are the row under it. Grids collapse to one column on phones.

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
  `Alert02` icon, and the message says what to fix. A field never grows wider than its
  grid column (`Field` is `grid-cols-1`).
- **Checkbox:** 17px, radius 5px, checked fill `brand` with a `brand-ink` `Tick02` icon.
  The label sits to the right (13.5px `ink-2`) and clicking it toggles the box. A
  checkbox with a hidden label (`hideLabel`) still needs a label for screen readers.
- **Checkbox group:** a `fieldset` with a 13px/500 `legend`, the checkboxes in a 1px `line`
  box (radius 10px, 12px padding), and the hint or error below like a form field. Use it
  for picking several of a few (roles, modules).
- **Permission matrix:** a table card with the permission names as sticky row headers
  (label plus the key in `Geist Mono` `ink-3`), one column per role, group rows in `ink-3`
  caption text, and a sticky save bar (card, `shadow-md`) that appears only when something
  changed. Locked cells are checked and disabled.
- **Money input:** a `৳` prefix inside the control, the value right-aligned and
  `tabular-nums`, shown grouped (`18,42,600.50`) when not focused. Focusing it (Tab or a
  click) shows the plain digits and selects all of them, so typing replaces the amount. The input always
  shows ASCII digits; Bangla digits typed on a Bangla keyboard are accepted and
  converted. The form value is a decimal string, never a `number`.
- **Discount input:** `DiscountInput` from `@omnivo/ui`, the money input's box with a number (right-aligned,
  `tabular-nums`, 2 decimals) and a native `%` / `৳` select inside it on the right, after a 1px `line` divider,
  13.5px/500 `ink-2` with an `ArrowDown01` icon. The select is the unit, so there is no `৳` prefix. The ring
  shows while either part has the focus. The form value is a decimal string plus a type (`percent` | `amount`).
- **Date picker:** the trigger looks exactly like an input, with a `Calendar03` leading
  icon. The calendar opens in a popover; the selected day is filled `brand` with
  `brand-ink` text, today is `brand` text at weight 600. Form values are ISO date
  strings (`2026-09-23`), read and written with local date parts, never UTC. The
  calendar's code loads the first time the picker opens (`calendar.tsx`); the button is
  there at once.
- **Pill / status badge:** 12px/500, radius 999px, padding 2px 8px 2px 6px, soft
  background plus a matching icon. Variants: `good` (Active, Synced), `warn` (Sync
  delayed), `crit` (Payment due), `brand` (Trial, Recommended), neutral (`subtle` +
  `ink-3`, e.g. Suspended).
- **Card:** `surface`, 1px `line`, radius 14px, `shadow-sm`. The header is a 15px/600
  title plus a 13px `ink-3` subtitle, padded 18px 20px 0.
- **KPI strip:** `KpiStrip` from `@omnivo/ui`, one card split into one to four equal cells by 1px `line` rules (the
  card's `line` background showing through a 1px gap); four cells are two by two on a phone. Each cell has a
  caption label, a 26px/600 value, an optional 12px `ink-3` line under it, and an optional 12px/500 change line:
  `good` with an arrow up, `crit` with an arrow down, or `ink-3` with no arrow when it only compares. The words say
  more or less too, so the color is never the only sign.
- **Statement table (trial balance, profit and loss, balance sheet):** a real `<table>` in a card (`surface`,
  1px `line`, radius 14px, `shadow-sm`), not the DataTable: section headings as `ink-3` caption rows, accounts
  indented 16px per level (code in `Geist Mono` `ink-3`), groups and totals at weight 500, total rows on
  `subtle`, the report's own total in `<tfoot>`. Amounts right-aligned, `tabular-nums`, 2 decimals. It stays a
  table on phones: it scrolls sideways inside its card with the account column sticky. A ledger account's
  name links to its ledger with the report's dates.
- **Balance check pill:** `good` "Balanced" or `crit` "Out by ৳x", next to the report's dates.
- **Table:** header row on `subtle` with 12px/500 `ink-3` text. Cells are 13.5px with
  12px 20px padding and 1px `line` rules. Row hover is `subtle`. Numbers are
  right-aligned and `tabular-nums`. The first column is a 30px avatar tile
  (`brand-soft`/`brand` initials) plus the name and an `ink-3` sub-line. Wrap tables
  in an `overflow-x-auto` container.
- **Data table:** the table is itself a card (`surface`, `line` border, radius 14px,
  `shadow-sm`), so never nest it inside another card; put a section header above it.
  Long lists are virtualized, with a sticky header. Sortable headers show an
  `ArrowUpDown`/`ArrowUp01`/`ArrowDown01` icon and set `aria-sort`. Below 860px every
  table becomes a list of cards: each column opts in with `meta.card` (`title`,
  `subtitle`, `trailing`, `detail`), and columns without it are hidden on phones.
  Paged lists sort on the server (`sorting` prop) and load the next page with
  `onEndReached`. A list whose rows are on the device (the active products and customers) searches, filters and
  sorts in the browser and shows 100 more rows at its end (`onEndReached`); its Archived tab stays a paged server
  list, online only.
- **Tree list:** `TreeList` from `@omnivo/ui`, for lists with a parent (chart of accounts, product categories).
  A card (`surface`, 1px `line`, radius 14px, `shadow-sm`) of nested lists; rows 44px high with a 1px `line`
  rule, hover `subtle`, indented 16px per level. Each group has a 28px show/hide button (`ArrowRight01` closed,
  `ArrowDown01` open, 16px `ink-3`, no rotation) with `aria-expanded`; rows without children get an empty
  28px box so codes line up. The page keeps the open state; while a search is on, every group on the way to a
  match is open. Codes in `Geist Mono` `ink-3` `tabular-nums`, group names `ink`/500, others `ink-2`. A row
  action that would repeat on every row (an "add here" button) shows on row hover or focus with a mouse
  (`pointer-fine:`), always on touch screens.
- **Page header:** the 26px `h1` page title, a 13px `ink-3` description below it, and
  the view's actions on the right (they wrap below the title on phones).
- **Overview (`/`):** the page header ("Overview", the branch select on the right: `Building03`, "All branches"
  first, only with a card it changes and more than one active branch), then the KPI strip (Sales today, Sales this
  month, Gross margin this month, Cash and bank), "Sales, last 30 days" (the line chart, two thirds) beside "Top
  products" (one third), then the cash accounts, the dues ("Customers owe" above "Owed to suppliers" in one card,
  the overdue part in `crit` with `Alert02`, or "Nothing overdue") and "Low stock" (a `warn` count pill,
  `PackageOutOfStock`, "40 of 200 strips", the emptiest first). Each card shows by its own permission, and a card
  alone takes the whole row. A role with no card gets the empty state "No numbers for your role". The branch
  changes the sales, the margin and the top products only. Amounts are whole taka. The page asks again every
  minute. Offline it shows the answer the device kept (sealed), "As of 10:42" in the header's line, a neutral
  document notice, and the branch select disabled; with nothing kept, "Needs a connection".
- **Sales and purchase reports (`/reports/sales`, `/reports/purchases`):** the page header with the Export menu; a
  card of filters (period preset and dates, Group by, branch, customer or supplier group, category); the KPI strip with
  the server's totals, never a total row at the end of a paged table (Sold, Returns, Net sales, and Margin only with
  `inventory.stock.value`; Billed, Debit notes, Net purchases); then a data table, sorted on the server and paged,
  whose columns come from the answer (`withCost`). A row that stands for many things ("Walk-in customers", "No
  category", "Expenses", "Products") has an icon on `subtle` in place of the initials, so it never reads as one more
  party. On the sales report, between the strip and the table, the books' line ("In the books: ৳39,19,000" and a "Books
  agree" or "Out by ৳x" pill, the difference to the paisa); with a customer group or a category, a neutral sentence
  instead. Online only ("Needs a connection").
- **Aging (`/reports/ar-aging`, `/reports/ap-aging`):** the page header with the Export menu; as-of date, customer or
  supplier group, "Everyone / Overdue only" (the day and the filters are in the address, the sort is not); the KPI
  strip (Total due, Overdue with "৳8,000 over 90 days" under it, Advances, Balance); a data table sorted A to Z at
  first: name (a link that keeps the day), Current, 1–30, 31–60, 61–90, Over 90, Total due, Advances, Balance. A zero
  is a dash. The balance reads in words ("৳50,000 in advance", "They owe you ৳50,000"). From 860px a name keeps 192px
  (`min-[860px]:min-w-48`), and the table scrolls inside its own box. The books' line sits between the strip and the
  table, with a neutral sentence under "Overdue only".
- **A party's aging page (`/reports/ar-aging/$customerId`, `/reports/ap-aging/$supplierId`):** a back link that keeps
  the day and the filters, the party's name as the title, the same KPI strip and books' line as its row, then its open
  documents, oldest due date first and not sortable (number as a link, date, due date, total, still open, days overdue,
  age; a bill has "Their bill PSM/2026/0412" under the number), and its advances.
- **VAT report (`/reports/vat`):** the page header with the Export menu; period (last month at first, the month
  presets and dates) and branch; the KPI strip: Output VAT ("৳75 taken off by credit notes and POS returns" under it),
  Input VAT ("taken off by debit notes", and "৳450 on bills with no Mushak 6.3 number"), Net VAT without its sign and
  in words ("To pay", "To carry forward", "Nothing to pay"); the books' line for each side; the rates as a statement
  table in a card (a sticky first column, "VAT 15% · 15%" with its kind under it, zero-rated and exempt each their
  own row, the total in `<tfoot>`); then a section header "Documents" with an Output / Input segmented control and a
  data table in the register's order, not sortable (number as a link with its kind, date, customer or supplier, BIN,
  and on Input the Mushak 6.3 number or a `warn` "No Mushak 6.3" pill, before VAT, VAT; a credit or debit note is a
  minus). Every amount on the page with paisa, because it fills in a return. Online only.
- **Stock movement (`/reports/stock-movement`):** the page header with the Export menu; period (this month at first),
  warehouse, category, "Only what moved / Also what did not move"; the KPI strip (Products, with "In each product's
  base unit, so the quantities have no total", Opening value, Closing value); a data table sorted on the server and
  paged, one row per variant in its base unit: product (a link to its stock card), Opening, Purchased, Sold,
  Transfers, Adjusted, Closing, then Opening value and Closing value. A zero is a dash; a minus in Transfers is stock
  still on the way, and a line under the table says so. Without `inventory.stock.value` the value cells and KPIs are
  left out. Online only.
- **Scheduled emails (`/reports/schedules`, `core.report.schedule`):** the page header with no New button (a schedule
  is made from a report's Export menu, "Email on a schedule"), "5 of 20 scheduled emails", and a data table (cards on a
  phone), not sortable: the report (a `brand-soft` icon tile, its name and its filter lines in 12px `ink-3`), when
  ("Every Sunday at 08:00"), sent to ("3 people", and "1 person gets nothing" in `warn`), the next email and "Last sent
  …" or "Not sent yet", the status (Active `good` `CheckmarkCircle02`, or Paused neutral `PauseCircle` with its
  reason under it) and a row menu: Change, Pause or Resume, Delete (asks first). Only the schedules of reports the
  person may read. Empty state: "Open a report, like the sales report, choose Export, then Email on a schedule."
- **Schedule dialog:** the dialog, "Email the VAT report on a schedule" or "Change the VAT report email". File (Excel
  or PDF); How often, then Day (weekly) or Day of the month (1–28, monthly), and Time (whole hours, in the workspace's
  time zone), with a hint of what each email holds ("Each email has the 7 days up to yesterday."); the filters as
  lines on `subtle`, never boxes (they never change once saved); "Send to", a checkbox group of the members who may
  read the report (up to 10). On a change, someone who may not read it any more is listed unticked and disabled with
  "Gets nothing: may not read this report now", and saving drops them. "Schedule email" / "Save changes".
- **Section header:** a 15px/600 title plus a 13px `ink-3` subtitle with no card and no
  padding, used above content that is already a card (such as a data table).
- **Empty state:** centered, a 40px `brand-soft`/`brand` icon tile (radius 8px), a
  15px/600 title, a 13.5px `ink-2` description that says what to do to fill the view,
  and an optional action button. When something failed to load, the tile is `crit-bg`/`crit` (`tone="crit"`), with
  Retry as the action.
- **Device copy states:** `LocalState` (`apps/app/src/components/local-state.tsx`), what a list read from the
  device shows in its place while the copy is not ready, as an empty state: not set up (`ComputerPhoneSync`, a
  "Choose the branch" button), copying (`CloudDownload`, a 12px `ink-3` `tabular-nums` `role="status"` count, "1,250
  items copied so far"), copy failed (`CloudOff`, Retry), offline with no copy (`WifiDisconnected02`), storage
  refused (`HardDrive`), device removed (`ComputerRemove`). A picker shows only the title, as its status line. A
  problem that needs a reload (`sync_protocol_mismatch`) is a neutral document notice above the list, which still
  shows the copy, with a Reload text link. A server-backed tab offline is the empty state "Needs a connection"
  (`WifiDisconnected02`).
- **Device branch dialog:** after sign-in, when the workspace has more than one active branch: the dialog, "Which
  branch is this device in?", a select that starts empty ("Pick a branch", active branches only), "Not now"
  (secondary) and "Use this branch" (primary), then the toast "This device is set up for Chattogram depot". Closing
  it any way is "Not now".
- **Device lists (My devices, Devices):** a data table (cards on a phone) with no row click; a row's actions are a
  menu (`MoreHorizontal` icon button, "Actions for Front desk PC"): Rename, Change branch (only on this device's
  row, with its copy ready) and Revoke; a revoked device has no menu. The first column is a 30px `brand-soft` tile
  with a `ComputerPhoneSync` icon, the name, a `brand` "This device" pill (`ComputerCheck`) on this browser's row,
  and for a revoked one "Revoked by Nusrat Jahan · " and the date and time in 12px `ink-3`. Columns: device, person
  (workspace list only), branch, last synced ("Never synced"), status. My devices is in the account menu, for
  everyone; Devices is in the Workspace group with `core.device.manage`, with a search (device or person), a
  branch select and an Active / Revoked segmented control, sorted on the server by name or last sync.
- **Device status pills:** Active (`good`, `CheckmarkCircle02`), "Not synced for 3 days" (`warn`, `Time04`, in
  Active's place 24 hours after the last sync), Revoked (neutral, `ComputerRemove`).
- **Device dialogs:** Rename (one name box), Change branch (only on this device: the copy of the old branch is
  deleted and the new one copied; a neutral notice and a disabled button while offline, or while changes wait,
  with a Sync link; the select leaves out the current branch), Revoke (says it stops syncing and signs out at
  once, that changes not synced on it are lost, and that a revoked device cannot be restored; on this device it
  says how many changes wait). Cancel (secondary) and "Revoke device" (primary).
- **Revoked sign-out:** a device that finds out it was revoked deletes its copy and signs out; the sign-in page
  then shows a neutral document notice, "This device was revoked, so its data was deleted and you were signed
  out.", until the next sign-in, which asks the branch again (a new device).
- **Sync line (sidebar):** the last item of the module menu, under a 1px `line` rule, so it shows in every module
  (and in the phone's top bar, after the module's links), linking to `/sync`:
  `Wifi01` and "Online" (or "Syncing…"), `WifiDisconnected02` and "Offline". The count on the right is the changes
  waiting on the device, or, when any was refused, the refused ones in `crit`. 24 hours after the last sync, "Last
  synced 2 days ago" in `warn` takes the place of the words (the icon still says online or offline), unless it is
  syncing. Its accessible name is the whole sentence ("Sync: Offline, Last synced 2 days ago, 2 changes waiting").
- **Outbox pills:** a change on the device is Waiting (`brand`, `Clock01`), Sending (`brand`, `CloudUpload`) or
  Needs attention (`warn`, `Alert02`). A row read from the device that the server has not got yet has a neutral
  "Not synced" pill (`CloudUpload`); a customer without its code yet says "No number yet". A change that waits for
  another stays Waiting, with "Waits for Sylhet Pharmacy to sync first" under it.
- **Device mode on a form:** offline (or online, for a customer with changes still on the device), the customer
  and sales order forms show a neutral document notice that says the work is saved on this device and sent when
  the connection is back, and their primary button says "Save on this device". An order saved this way is a
  draft: no "Confirm order". Then the toast "Saved on this device. It syncs when the connection is back." 7 days
  after the last sync, offline, the notice is `warn` and says the device can't save new work offline, and there is
  no save button. The changes already waiting still go when the connection is back.
- **Sync page (`/sync`):** the page header (title, description, "Sync now" secondary with
  `ArrowReloadHorizontal`, disabled offline), a 13px `ink-3` "Last synced …" line (24 hours after the last sync it
  says "Last synced 2 days ago", with a `warn` document notice under it about what may be out of date; after 7 days
  the notice says that new work stops until the device syncs), then two cards: "Kept from the
  server" (only when there is a notice: the customer's name and "Not changed: Credit limit" in 12px `ink-3`, a
  Dismiss text link per row) and "Changes on this device", a list with 1px `line` rules. A row: what the change is
  ("New customer Sylhet Pharmacy"), when it was saved, its pill, and for a refused one the error in `crit` with an
  `Alert02` icon. On the right, Edit (a text link), Retry (secondary `sm`, refused ones only) and Discard
  (secondary `sm`); none while it is Sending. Discard asks first in a dialog that says how many changes that need
  it go with it. With nothing waiting: the empty state with `CloudSavingDone01`, "Everything is synced".
  A POS sale ("Sale POS1-000124", "3 lines · ৳2,300") has no Edit, and Discard only once the server refused it.
  A shift's open and close are named by the shift's number, a pay in or out by its sentence; none shows an amount.
  A return is "Return POS1-R000012" with its line count under it ("2 lines"), and no amount.
- **Orders on the device:** above the sales orders list, a section header "On this device · not synced" and its
  own table (cards on a phone) of the drafts in the outbox, each with "No number yet" and its pill. Offline, the
  server's list below is the empty state "Needs a connection".
- **Sign-out with changes waiting:** the dialog "Sign out and lose the changes?", which says how many changes have
  not synced; "Sign out anyway" (secondary, pushed left) and "Stay signed in" (primary).
- **Update notice:** `UpdateNotice` (`apps/app/src/components/update-notice.tsx`), outside the router so it stays on
  every page. The toast's look (`ink` background, `bg` text, radius 10px, `shadow-lg`), fixed at the bottom (centered
  on a phone, bottom-right from `sm`), `role="status"`, with a `bg`/`ink` Reload button; it never closes by itself and
  has no close button. "A new version of Omnivo is ready. Save what you are working on, then reload." in the tab
  that may reload; "Omnivo was updated in another tab. Reload this tab to keep working." in the others. The app
  never reloads by itself.
- **Install app:** an item in the account menu after My devices (`Download04`), only where the browser can
  install: Chrome and Edge open their own prompt; Safari opens a dialog with its own steps (iPhone and iPad: Share,
  Add to Home Screen; Mac: File, Add to Dock). Hidden in the installed app. "Omnivo is installed" is the toast.
- **Storage card (Sync page):** the last card: "Storage on this device", a `good` "Kept" pill
  (`CheckmarkCircle02`) or a `warn` "May be cleared" pill (`Alert02`) with "Ask to keep it" (secondary `sm`), and the
  space used in 12px `ink-3` `tabular-nums` ("24.5 MB used. The browser allows up to 1.2 GB.").
- **Opened offline:** a reload with no answer from the server opens the last person's copy. The Sync page then
  shows a neutral document notice ("Omnivo opened without a connection…") until the sign-in is checked. The
  sign-in page shows a neutral notice with `WifiDisconnected02` while the browser is offline, and "You were signed
  out while offline…" when the check was refused. On a device without a PIN, an offline reload shows the sign-in
  page with "This device has no PIN…" in place of the offline notice, and with a PIN it shows the lock screen first.
- **PIN field:** `PinField` (`apps/app/src/components/pin-field.tsx`), the input box with a 17px `LockKeyhole` icon,
  `type="password"`, `inputmode="numeric"` and `autocomplete="off"`, 6 digits. Bangla digits become ASCII ones as
  they are typed, so the value is always ASCII. Easy PINs (`000000`, `123456`) and two different PINs are refused
  under the box, like any field error.
- **Lock screen:** `LockScreen`, in the sign-in page's layout (`AuthLayout`, with the side panel), drawn by
  `AppFrame` in the shell's place: "Omnivo is locked" (the auth form's 28px title), a line that says why it asks
  (after Lock now, after an offline reload, after the server's key changed), the person's name and email in a 1px
  `line` box, one PIN field, Unlock (primary, full width), "Forgot PIN? Sign in with your password" (a text link;
  offline a sentence with `WifiDisconnected02` that says to connect first) and Sign out (a text link, asks first
  when changes wait). A wrong PIN says how many tries are left. After 5 the PIN field goes: a `warn` notice and
  "Sign in with your password" (primary) take its place, or offline a neutral notice that says to connect.
- **PIN dialog:** the dialog, after the device is set up ("Set a PIN for this device", with "Not now"), after
  "Forgot PIN?" or 5 wrong PINs ("Set a new PIN"), and from the Sync page's card ("Change the PIN of this device",
  the current PIN first). PIN and "Type the PIN again", with the hint that the PIN works only on this device;
  "Set PIN" / "Change PIN" (primary), "Setting the PIN…" while it works (up to a second, on purpose). Toasts
  "Device PIN set" and "Device PIN changed".
- **Device PIN card (Sync page):** before the storage card: "Device PIN", a `good` "PIN set" pill
  (`CheckmarkCircle02`), a `warn` "Stopped working" pill (`Alert02`) or a neutral "No PIN" pill
  (`SquareUnlock02`), a 13.5px `ink-2` sentence, and "Set a PIN" / "Change PIN" (secondary `sm`).
- **Lock now:** an item in the account menu after Install app (`SquareLock02`). Without a PIN it is "Set a PIN to
  lock" (`LockKey`) and opens the PIN dialog. Other tabs lock too, and a reload keeps the lock until the PIN or a
  sign-in with the password. The words never say "key" or "encryption".
- **App icon badge:** the installed app's icon shows the changes waiting on the device (the sync line's count),
  where the browser has the badge API.
- **POS screen (`/pos`):** full screen inside `AppFrame` (the lock, the sync and the update notice still work), no
  sidebar. A 56px `surface` top bar with a 1px `line` rule: "Leave the POS" (`ArrowLeft01`), a `brand` register pill
  (`CashierIcon`, "POS1 · Front counter"), the cashier and the next receipt number in `ink-3` `tabular-nums` (hidden
  as the screen narrows), the sync line, Change register (`ArrowLeftRight`) and a shortcuts icon button
  (`Keyboard`). With a shift open, the bar also has the shift's button ("Shift POS1-S0042" and an `ArrowDown01` icon,
  the input's look at 36px; on a phone the number alone, and the `brand` register pill hides so the bar fits 390px).
  Then "Return" (secondary `sm`, `ArrowTurnBackward`, with its `F6` key; on a phone the icon alone).
  Below it, from 860px, the products on the left and a 400px cart on the right, each scrolling inside
  itself (`h-dvh`; the page never scrolls). The search box ("Scan or search") has the focus; a scanner types the
  barcode and Enter. Tiles: radius 10px, 1px `line`, the name (13.5px/500, two lines), the SKU in `Geist Mono` `ink-3`,
  the price (600) and the stock (`ink-2`, or "Out of stock" on a disabled `subtle` tile when the workspace does not
  sell below zero), two columns on a phone. Keys: F2 search, F4 customer, F6 return, F7 bill discount, F8 hold, F9
  held bills, F12 pay, Enter complete and new sale, `?` the shortcuts dialog.
- **POS cart:** the customer box (walk-in by default), then one row per line that opens on a click
  (`aria-expanded`): a quantity stepper that never goes below 1, "× ৳420 · bag", a `brand` "5% off" pill, the batch;
  open, the quantity, price, discount, batch and serial boxes. A price the cashier may not change is read-only with
  a 12px `ink-3` sentence saying why; over the register's limit, the discount says it needs `pos.price.override` and
  Pay waits. The totals block on `subtle`: bill discount (`DiscountInput`), line discounts only when there are any,
  VAT, the total at the KPI size, and "Pay ৳2,300" (primary, full width). On a phone the cart is a bar at the bottom
  (count, total, Pay) that opens it over the products.
- **Pay and done dialogs:** "Take payment": rows of method select, amount and reference (each method's own
  placeholder, "TrxID BK7XQ2M4"), a remove icon button; cash first with the focus; note chips ("Notes the customer
  gave", the filter chip style) and "Exact amount"; "Add another method" starts at what is still to pay; Still to
  pay / Paid / Change on `subtle`; "Complete sale" (primary). Then "POS1-000123 is done": a 40px `good-bg` tile with
  `CheckmarkCircle02`, "Give back ৳200 in cash" at the KPI size (or "No change to give"), "Saved on this device…"
  when offline, "Print again" (secondary, `Printer`) and "New sale" (primary, with the focus).
- **Register chooser ("Which counter is this?"):** a card (max 440px) in the screen's place with a `brand-soft`
  `CashierIcon` tile, a select of the branch's registers that starts empty ("Pick a register"), a register held by
  another device named "POS2 · held by Store office PC", and "Use this register" (primary). Online only; offline a
  sentence with `WifiDisconnected02`. The toast: "This device is POS1 now. The next receipt is POS1-000001."
- **Thermal receipt:** `PosReceipt` (`apps/app/src/components/pos-receipt.tsx`), a print sheet like `PrintSheet`:
  `@page { size: auto; margin: 0 }`, 72mm wide on 80mm paper and 48mm on 58mm, black on white, no fills and no
  logo. The company (legal name, address, BIN, phone), the number, counter, cashier, date and customer, the lines,
  the totals, the payments and change, the register's footer, then "Thank you. Please come again." Amounts always
  with 2 decimals. It prints by itself after a sale, once; a sale's page prints it again from a button. The return
  slip ("Return of POS1-000164", what came back, "Given back", and "Used on sale POS1-000188" for an exchange) and the
  X and Z reports use the same sheet. An exchange prints its slip and the new sale's receipt in one print, the slip
  first.
- **POS sale statuses:** Posted (`good`, `CheckmarkCircle02`), plus a second `warn` "Sold short" pill (`Alert02`)
  when a line went below zero. A sold-short line: Below zero (`warn`, `TimeQuarterPass`) until the stock there is
  back at zero or above, then Put right (`good`, `CheckmarkCircle02`).
- **POS registers (Settings):** a data table (code, name, warehouse, holder "Front counter PC · Sumi Akter" or
  "Free", last number, status) and a dialog form: code (shown, not a box, once saved), name, warehouse (starts
  empty), an account per method (cash required, the others "Not taken here"), the most a cashier may take off (%),
  paper width (58 / 80 mm), the receipt's footer, and a "Shifts" group: the cash over and short account (an income
  or expense account, required), the bell for a difference over (whole taka) and "Lock the POS after". Then a
  "Returns" group: "Returns allowed for (days)" (whole days 0–365, 7 by default, 0 = the same day only) and the
  exchange account (an active liability, not a group; empty = "No exchanges: refunds only"). A held register cannot
  be archived. Read-only without `pos.register.manage`.
- **POS shift (`/pos`):** a register sells only inside a shift. Without one, the screen's place is the "Open a shift"
  card (max 560px, the wizard panel's padding): a "By notes" / "As a total" segmented control, ten note boxes in two
  columns (`৳1,000` … `৳1`, each "= ৳3,000" in `ink-3` `tabular-nums`) with the total on `subtle`, or one money input;
  on a register's first shift a neutral document notice and a "Brought in as" select of the "in" reasons; "Open shift"
  (primary, full width). The count is blind: what the last shift left shows only in the toast after the open. A
  register with no over/short account, or one that locks without the device's PIN, shows an empty state that says
  why (with "Set a PIN" for the second).
- **Shift menu:** the bar's shift button opens a dropdown: "Opened 23 Sep 2026, 09:02 · Sumi Akter" (group label),
  Pay in (`MoneyAdd01`), Pay out (`MoneyRemove01`), Held bills with the count (`Note01`), Close shift (`Lock`).
- **Pay in and pay out dialog:** a reason select (that direction's reasons only, never an account), a money input
  and a note; the primary button says the amount ("Pay out ৳500"). The toast is the Sync page's name for it ("৳500
  paid out for Bank deposit"). The drawer's amount is never shown (the count stays blind).
- **Held bills:** the cart's header has Hold (secondary `sm`, `Pause`, F8) and "Held (2)" (`Note01`, F9). Hold asks
  for an optional name ("Customer in the blue shirt"); the list dialog has rows in a 1px `line` box (the name or "Held
  at 10:42", "2 items · ৳736" in 12px `ink-3`), Resume (secondary `sm`) and a drop icon button (`Cancel01`). At most
  20 on a device; resuming holds the cart on the screen first.
- **Close shift dialog and its result:** the same count as the open, a neutral notice when held bills will be dropped,
  and "The count can’t change after the shift is closed." in 13px `ink-3` on the left of the footer, "Close the
  shift" (primary). Then "POS1-S0042 is closed": a 40px `good-bg` tile with `CheckmarkCircle02`, a KPI strip
  (Counted, Expected, Difference in words: "৳520 short", "৳20 over", "No difference"), a `warn` document notice
  (`Coins01`) only when there is a difference, then Sign out (secondary, pushed left) and "Open the next shift"
  (primary, with the focus).
- **Shift before sign-out:** with a shift open, sign-out shows "Close the shift first" (Cancel, "Close shift"
  primary, which opens the close on `/pos`); on the lock screen the dialog only says why. "Change register" says the
  same.
- **Idle lock:** a register's "Lock the POS after" (Never, 2, 5, 10, 15 minutes) locks `/pos` with the device's PIN
  after that long with no key, click, touch or scroll; the lock screen's line says why.
- **POS shift statuses:** Open (`brand`, `Clock01`), Closed (`good`, `CheckmarkCircle02`), Not counted (neutral,
  `MinusSignCircle`). Not counted is not `warn`: the next shift's opening count finds any missing money.
- **POS shifts (Sales, `pos.shift.manage`):** a data table (shift number in `Geist Mono`, register, cashier,
  opened, closed, expected, counted, difference in words, status), filtered by a register select and a status
  select that starts with "All shifts". A shift's page: the page header with "Close without a count" (secondary,
  open shifts only, a dialog with an optional "Why"), the KPI strip, the opening and closing counts (notes in a
  table, or "Counted as a total"), the cash in the drawer (opening, cash taken, change given, paid in, paid out,
  expected), what each method took, the pay ins and outs, and its journal entries. Every amount with paisa. A
  neutral document notice when the device and the server expected different cash (the books use the server's), and
  for a shift closed without a count.
- **POS cash reasons (Settings, after POS registers):** a data table (reason, kind as a neutral pill with the menu's
  icons, account by code, status), an Active / Archived segmented control, and a dialog form: name, kind (a select
  when new, shown but not offered once saved), account (active, not a group, not receivable, payable or stock).
  Read-only without `pos.register.manage`.
- **POS return (`/pos`, F6):** a dialog in three steps, inside a shift only. "Take goods back": the receipt number
  (any case, a scanner's too) and "Find the sale"; offline a neutral document notice (`WifiDisconnected02`) says the
  device finds only this register's sales of the last 30 days. "Return from POS1-000164": "Goods can come back until
  30 Sep 2026.", the lines in a 1px `line` box, each a checkbox ("Take back …"), "2 of 3 pcs left to return" in 12px
  `ink-3`, the amount on the right, and once ticked a quantity stepper (in the sale line's unit) or serial ticks; a
  line that all came back is a `subtle` row, "All of it came back". "Why it came back (optional)", the money back on
  `subtle` at the KPI size, "Pay back ৳368" (primary). "Pay the money back": refund rows like the pay dialog's (cash
  first, then the ways the sale was paid that the register takes), Still to give back / Given back on `subtle`, then
  the exchange as a button row (`brand-soft` `ArrowLeftRight` tile, "Exchange: use on a new sale", its hint, an
  `ArrowRight01`), Back (secondary, pushed left) and "Complete return" (primary). Then "POS1-R000012 is done": the
  40px `good-bg` tile, "Give back ৳368 in cash" at the KPI size (or "No cash to give back"), "Saved on this device…"
  offline, "Print again" and "New sale" (primary, with the focus). The slip prints by itself.
- **Exchange in the cart:** a `brand-soft` box with a 1px `brand-line` border at the top of the cart
  (`ArrowLeftRight`, "Exchange from POS1-R000012", "৳368 to spend on this sale" in 13px `ink-2`, a "Drop the exchange"
  text link that asks first: "Keep the exchange" / "Drop the exchange"). In the pay dialog, a fixed first row (the
  method's name and the amount read-only on `subtle`, "From return POS1-R000012"); a sale smaller than the return has a
  neutral document notice ("৳120 of the return is left over…") and "Paid back by" rows for the rest. The return and
  the sale are saved together at "Complete sale"; the close waits until the exchange is completed or dropped.
- **X and Z reports:** "Print X report" (`Printer`) in the shift menu before Close shift, offline too, and "Print Z
  report" (secondary, `Printer`) on the close's result and a closed shift's page. The thermal sheet: register, shift,
  cashier, opened (and closed), sales and returns with their counts, sold, given back, taken in the end, discounts,
  VAT on sales and on returns, what each method took and paid back, paid in and out. The X report is blind: no drawer
  total, and a line that says the count at the close shows it. The Z report adds the drawer (expected, counted,
  difference), or "Closed without a count…".
- **POS return statuses:** Posted (`good`, `CheckmarkCircle02`), plus After the window (`warn`, `Hourglass`) when it
  came after the register's days (the books took it, the audit log has it) and "Exchanged for POS1-000188" (neutral,
  `ArrowLeftRight`).
- **POS returns (Sales, after POS sales, everyone):** a data table like POS sales (number in `Geist Mono`, date, sale,
  register, customer, cashier, given back, status) with the register select; from a shift's page "See the returns"
  opens it filtered, "The returns of shift POS1-S0042" with a "Show every return" text link. A return's page: the
  page header with "Print return slip" (secondary, `Printer`), its facts (sale, sold on, shift, taken back at,
  device, cashier, customer, why), the lines (the batch it went back into, its serial numbers), what was paid back
  (an exchange says "Used on POS1-000188" as a link) and its journal entry. A neutral document notice when it came
  after the window or its day was closed in the books. A sale's page says per line "1 pcs came back", lists its
  returns, and its exchange payment links "From return POS1-R000012". A shift's page has "Cash paid back" in the
  drawer's sum, the sales' discounts and VAT, and a refunds card (count, VAT on returns, per method).
- **Storefront menu (`storefront.manage`, `storefront.order.read`, `storefront.payout.manage`):** a sidebar group
  "Storefront", hidden when the person has none of the three (an accountant with only `storefront.payout.manage` sees the
  group with Shop payouts alone): Shop orders first (`ShoppingBag01`, with `storefront.order.read`, and a `crit` count of the new
  orders on the right, asked every 30 seconds like the approvals count), then, with `storefront.manage`, Catalog
  (`Store04`), Shop coupons (`CouponPercent`), Shop categories (`FolderLibrary`), Shop appearance (`PaintBoard`),
  Shop pages (`Files01`), Shop settings (`WebDesign01`), Shop couriers (`ShippingTruck01`), then, with
  `storefront.payout.manage`, Shop payouts (`Bank`, not Money receipts' `MoneyReceive02`: an accountant sees both). The links say "Shop …" because the phone's nav row has no group labels. A page under
  another (a listing, the hero, a collection, a text page) keeps its item marked, because its address starts with
  the item's link. Every page is online only: offline it is the
  empty state "Needs a connection" (`WifiDisconnected02`). Once the shop is set up, each page header has "View
  shop" (a real `<a>` to a new tab that looks like the secondary button, `LinkSquare02`) and, under the description,
  a 13px `ink-3` line with a 14px `Clock01` icon: "Changes show in the shop within a minute". A long form shows a
  sticky save bar while it has changes (a card with `shadow-md`: "Changes not saved yet", "Discard changes"
  secondary, Save primary). A shop price shows its paisa only when it has some (`৳229`, `৳247.50`).
- **Shop settings (`/storefront/settings`):** cards (Name and address: the shop address with `Globe02` and the
  `.omnivo.shop` suffix in the box, the shop name, the language; Contact; Social pages; Stock and delivery: the
  warehouse select, up to 6 delivery zones as rows of a name, a 180px money input and a remove icon button, "Add
  zone" secondary `sm`, then free delivery from and minimum order, empty = none, and the "Delivery charge’s service"
  select (the workspace's active services, "name · SKU"; empty = "Made by the first order with a charge", and it
  can't be emptied again once an order used one); Payment: a checkbox group of Cash on Delivery and Pay online, where
  Pay online is disabled while it is unticked and the Online payment card is not ready, with an `InformationCircle`
  line under the group that says to save that card first; a ticked box stays enabled so it can be unticked) beside a
  340px column, sticky from `lg`. Before the first save the form starts from the company's details under a neutral
  document notice, and "Set up the shop" is the primary button; after it, the save bar. The column is the "Open
  the shop" checklist: three rows with 1px `line` rules, each a 22px circle (`good-bg` with a `good` `Tick02` when
  done, a dashed `line-strong` ring when not), the sentence and a caption "Done" (`good`) or "Not done yet"
  (`ink-3`); then "Open the shop" (`Rocket01`, full width, primary once all three are done, else a disabled
  secondary), disabled with "Save the settings first…" while the form has changes. It asks first and says a shop
  can't be closed again. Once open, the card is "The shop is open": a 40px `good-bg` `StoreVerified01` tile, "Open
  since 16 Nov 2026 at …", a `good` "Open" pill and a full-width "View shop". Changing an open shop's address asks
  first: the old address stops working and nothing sends shoppers on.
- **Online payment card (Shop settings):** `storefront-gateway-card.tsx`, a card of its own with its own form and
  footer under the settings form (never inside it), shown only once the shop is set up. "Online payment", "Your
  SSLCommerz store…", and a pill at the header's right: neutral "Not set up" (`MinusSignCircle`), `good` "Ready"
  (`CheckmarkCircle02`) or `warn` "Needs an account" (`Alert02`, with a `warn` document notice that the checkout does
  not offer Pay online until an account is picked again). Inside, two columns from `sm`: Gateway as a fact ("SSLCommerz",
  not a select), Store as a Sandbox / Live segmented control in a `Field`, Store ID (`Store01`), Store password
  (`LockKeyhole`, `type="password"`, `autocomplete="new-password"`, write-only: it starts empty, "Saved" as the
  placeholder once saved, and empty keeps it), "Account the money goes into" (`Wallet01`, active accounts that hold
  money, `code · name`) and "Gateway fee account" (`Coins01`, active expense accounts). A saved account that is no
  longer offered starts empty with its error shown at once. The footer (1px `line` rule): on the left the last test's
  line (`good` `CheckmarkCircle02` accepted, `crit` `Alert02` refused, `warn` `Alert02` no answer, `ink-3`
  `InformationCircle` "Not tested yet." or, while the form has changes, "Save your changes first…"); on the right
  "Save gateway" alone before the first save, then "Test connection" (secondary, `Plug01`, disabled while the form
  has changes; it tests what is saved), and "Discard changes" and "Save changes" only with changes.
- **Shop couriers (`/storefront/couriers`, `storefront.manage`):** the couriers the shop's parcels go with. Works
  before the shop is set up, with no "Changes show in the shop" line. The page header ("The couriers your parcels go
  with, and the one the Packed dialog books with first") with "View shop" once the shop is set up and "Add courier
  account" (primary, `PlusSign`). Then the
  "Book at Packed" card: a "Book with" select (max 420px, `ShippingTruck01`) of the active API accounts, "Don’t book
  at Packed" first, and Save (secondary, disabled until it changes: the page's one primary is Add); with no API
  account, a neutral line that says to add a Steadfast account. Then an Active / Archived segmented control (it
  filters in the browser) and a data table (cards on a phone), not sortable: Account (a 30px `brand-soft`
  `ShippingTruck01` tile, the name, a `brand` "Books first" pill (`CheckmarkBadge01`) on the default, and "Steadfast ·
  books by its API" or "Pathao · booked by hand" under it), Holds (what the courier holds of the shop's cash: the
  posted COD receipts of its parcels, whole taka, `tabular-nums`, "৳45,200 · 18 parcels"; "Nothing yet" or "No COD
  account" in `ink-3`; a voided receipt drops out, and so does a parcel a posted payout took; the card's detail on a
  phone), Courier’s news ("Last arrived …"; a manual account says
  "Moved by hand"; an API account with none is `warn` `Alert02` "None yet" with the line that says to paste the
  webhook), Last test (`good` "Keys accepted …", `crit` "Keys refused …" or "No answer …", "Not tested", a dash for a
  manual account), Status, and a row menu (`MoreHorizontal`, "Actions for Steadfast Dhaka"): Edit (`Edit02`), Test
  connection (`Plug01`, API only), New webhook token (`Webhook`, API only, asks first: the old token stops at once),
  Record payout (`Bank`, only with `storefront.payout.manage` and on an account with a COD account; it opens the new
  payout page with the account picked) and Archive (`Archive02`, asks first; on the default it says Packed then books with no courier), or on an archived
  row Restore alone (`ArchiveRestore`, no question). A row click opens Edit; an archived row opens nothing. Empty:
  "No courier account yet" (`ShippingTruck01`, "Add courier account") and "No archived courier account". Online only.
- **Courier account dialog:** "Add a courier account" or "Edit Steadfast Dhaka", its own lazy chunk. New: "How it
  books" as two radio cards (`SelectableCardGroup`): "Steadfast, by its API" or "Another courier, by hand", each with
  its hint; on edit the provider is a fact on `subtle` with "An account’s courier can’t change…". Name (`Tag01`, "Only
  your team sees it…"). Steadfast: API key (`Key01`) and Secret key (`LockKeyhole`), both write-only like the store
  password (start empty, "Saved" as the placeholder once saved, an empty box keeps its key, `autocomplete="new-password"`).
  By hand: a Courier select (`ShippingTruck01`) of the five couriers the tracking page knows. Then, for both kinds,
  two native selects of the workspace's active accounts (`code · name`): "COD account" (`Wallet01`, accounts that
  hold money; first "None: record the rider’s cash by hand"; on a saved one the hint says a change counts for the
  next receipts only) and "Courier charges account" (`Coins01`, expense accounts; first "None yet"; the payout's
  charges go there, and without it a payout takes only parcels with no charge). With no account to offer, the hint says where to add one. A saved account that is no longer offered
  starts empty with its error shown at once, like the Online payment card. "Add account" / "Save changes".
- **Webhook dialog:** after an API account is added and after New webhook token: "Paste the webhook into Steadfast",
  the Callback URL and the "Auth token (Bearer)" in read-only boxes that select all on focus, each with Copy
  (secondary `sm`, `Copy01`; when the clipboard refuses, the toast says to select it by hand), the hint that the token
  is shown only this once, a neutral document notice that Omnivo asks Steadfast every 15 minutes until the first news
  arrive, and Done (primary) as the only button.
- **Shop payouts (`/storefront/payouts`, `storefront.payout.manage`):** the courier's transfers of the riders' cash
  to the bank. Works before the shop is set up, with no "View shop" and no "Changes show in the shop" line. The page
  header ("The COD money your couriers send to the bank, with their charges taken off") with "Record payout"
  (primary, `PlusSign`), a courier account select ("All courier accounts" first, an archived one "Steadfast Dhaka
  (archived)") and an All / Posted / Voided segmented control (both in the address), then a data table (cards on a
  phone), newest date first, paged by the server, not sortable: number (`Geist Mono` 500), date, courier account,
  courier's reference, parcels, Collected, Charges, To the bank (500), all right-aligned whole taka, and the status. A
  voided payout stays in the list with its pill. A row click opens the payout. Empty: "No payouts yet" (`Bank`) and
  "No payout matches" with "Show every payout". Online only.
- **New payout (`/storefront/payouts/new`, `?account=<id>` from the row menu):** a "Shop payouts" back link
  (`ArrowLeft01`), "Record a courier payout", then a form card: Courier account (`ShippingTruck01`, across two
  columns; each option says what it holds, "Steadfast Dhaka · holds ৳45,200 in 18 parcels", and an account with no
  COD account is shown disabled, "· no COD account"), Date (the bank statement's day), Paid into (`Wallet01`, the
  active accounts that hold money, never this account's COD account), Courier's reference (`Tag01`,
  "SFC-23618228") and Note (`Note01`). With no charges account, a neutral document notice says only parcels with no
  charge can be paid out. Then the Parcels card ("Match a payout file", secondary `sm`, `FileImport`; Tick all and
  Clear, secondary `sm`): every parcel of the account that no payout has taken, none ticked at first. A row: a checkbox ("Pay out
  W-000123"), the courier's invoice in `Geist Mono` with "Delivered with cash" or "Charge only: no cash came" under
  it, the parcel pill, the COD receipt as a link, Collected (fixed, the receipt's amount), a Charge money input
  (enabled and required only when ticked, starting at the courier's own charge, with "Steadfast said ৳60" or
  "Steadfast has not said its charge" in 12px `ink-3` under it) and To the bank. On a wide card (`@3xl`) one grid
  template with a caption header; on a narrow one each parcel is a card of its own with labels. The totals on
  `subtle` under the table ("3 parcels ticked", Collected, Charges, To the bank), with paisa; after a match, "The file
  says ৳2,040 reached the bank" and a `good` "Agrees" or `crit` "Out by ৳20" pill. "Record payout" (primary) with
  the hint that saving posts it and a mistake is voided. Toast "CPO-2026-27-0001 recorded", then the payout's page.
  Empty: "Nothing to pay out" (`Bank`).
- **Payout file dialog:** "Match the courier’s payout file", its own lazy chunk, at 560px. "Choose CSV file"
  (secondary, `Upload04`), the hint (one payout at a time, up to 1 MB and 5,000 rows, read and never kept), then
  "Reading the file…" / "Matching…". The browser POSTs the file's text; nothing is uploaded. A mapping step ("Which
  column is which?", `Csv01`) only when the saved map or the Steadfast preset names a column the file lacks (it says
  which, in quotes) or there is no map: "Parcels are named by" (Invoice, Tracking code, Courier’s ID), Its column,
  Collected column and Charge column (native selects of the file's header, "Not in the file" for an amount), then
  "Match the file" ("Choose another file" secondary, pushed left). The map is kept on the courier account for the
  next file. The result: the file's name (`Csv01`) with a "Change the columns" text link, a count pill per outcome,
  then one row per line of the file ("Row 4", the number in `Geist Mono`, its pill and a 12px `ink-3` line), the ones
  to look at first (Other amount, Not found, Can’t be read, Twice in the file), then Already paid out, Not ready,
  Found. In the footer the hint on the left, "Choose another file" (secondary) and "Tick 12 parcels" (primary), which
  ticks the Found and Other amount rows with the file's charges, keeping what was ticked before. The toast says how
  many were ticked.
- **Payout match outcomes:** Found (`good`, `CheckmarkCircle02`), Other amount (`warn`, `Alert02`, "The file says
  ৳770 collected, the money receipt ৳730…"), Already paid out (neutral, `TaskDone01`, "Paid out on CPO-…"), Not ready
  (neutral, `Hourglass`), Not found (`warn`, `HelpCircle`), Twice in the file (neutral, `Copy01`), Can’t be read
  (`warn`, `FileNotFound`). `warn` is what the member must look at; neutral only says why nothing was ticked.
- **Payout page (`/storefront/payouts/$payoutId`):** laid out like a money receipt's: the back link, the number with
  the courier account under it, the status pill and "Print voucher" (secondary, `Printer`, posted only); a voided
  payout has a neutral document notice ("Voided on 25 Nov 2026: Recorded twice… Its parcels can be paid out again.").
  A facts card (Courier account, Paid into, Date, Courier’s reference, Out of (the COD account), Charges to, Branch,
  Note) with the Journal entry and Reversal links; then "Parcels paid", a table of the lines (the invoice and its
  order, a link only with `storefront.order.read`, the tracking code, the money receipt, Collected, Charge with
  "Steadfast said ৳60" under a changed one, To the bank) with paisa and the Total in `<tfoot>`. "Void payout"
  (secondary) at the bottom, pushed left, on a posted payout only: the money receipt's void dialog (void date, never
  before the payout's date, and a reason), "Void CPO-…", which says the entry is reversed and the parcels are freed.
- **Payout statuses:** Posted (`good`, `CheckmarkCircle02`), Voided (neutral, `CancelCircle`).
- **Payout voucher:** `PayoutPrint` in `print-documents.tsx`, a `PrintSheet`, "Courier payout": number, date,
  courier, reference, Paid into; the lines (parcel, tracking code, collected, charge); Collected, Courier’s charges and
  "Paid into the bank" under a 1px `ink` rule; "Prepared by" and "Authorised by" signature lines. A voided payout does
  not print.
- **Shop coupons (`/storefront/coupons`):** works before the shop is set up (a coupon can wait for it), so "View shop"
  shows only once it is, and there is no "Changes show in the shop" line (the shop's price check is not cached, so a
  coupon acts at once). The page header with "Add coupon" (primary, `PlusSign`), a search box ("Code", max 320px, in
  the tab only), a Current / Archived segmented control, then a data table (cards on a phone), not sortable, newest
  first, paged: code (`Geist Mono` 500, "Once per mobile number" in caption `ink-3` under it when on), takes off ("10%
  off, up to ৳200", "৳50 off"), minimum order ("From ৳500" or "Any amount"), days ("1 Nov 2026 – 30 Nov 2026", "From …",
  "Until …", "Any day", both days included, in the workspace's time zone), used (right, "12 of 100 used" or "12
  used"), status, and a row menu (`MoreHorizontal`, "Actions for WELCOME10"): Edit (`Edit02`) and Archive
  (`Archive02`, asks first: the shop stops taking it at once, orders keep their discount), or on an archived row
  Restore alone (`ArchiveRestore`, no question, a toast). A row click opens Edit; an archived row opens nothing.
  Empty: "No coupons yet" (`CouponPercent`, "Add coupon"), "No archived coupons" (`Archive02`), "No coupon matches"
  (`Search01`). The used count may be up to 30 seconds old (the app's list cache).
- **Coupon dialog:** "Add a coupon" or "Edit WELCOME10": Code (`CouponPercent`, upper-cased, up to 20 letters,
  digits or hyphens; once an order used it, a read-only `subtle` box with `LockKeyhole` and "An order has used this
  code, so it can’t change."), Discount as a Percent off / Taka off segmented control, the value (the label follows
  the kind: "Percent off (1 to 99)", whole percent, or "Amount off", a money input), "Up to" (a money input, percent
  only: switching to Taka off hides and empties it), Minimum order, First day and Last day (date pickers), Number of
  orders (whole, 1 to 1,000,000) and the checkbox "Once per mobile number"; every box but the code and the value is
  "(optional)" (`Field`'s `optional`, `ink-3`) and empty means no limit. "Add coupon" / "Save changes".
- **Shop coupon statuses:** Active (`good`, `CheckmarkCircle02`), Scheduled (`brand`, `Calendar03`, before its first
  day), Ended (neutral, `Hourglass`, after its last day or used up), Archived (neutral, `Archive02`). The API works
  the status out from the days and the uses.
- **Shop categories (`/storefront/categories`):** the page header with "Add category" (primary, `PlusSign`), a
  search box (max 384px), then a `TreeList`. A row: the name as a button that opens the edit dialog, the link
  (`/c/skin-care`, `Geist Mono` caption `ink-3`, from `sm`), "12 listings" (caption `ink-3` `tabular-nums`), then
  icon buttons: `FolderAdd` (add one inside it, the tree list's hover rule), `ArrowUp01` / `ArrowDown01` (Move up /
  down, disabled at the ends and while a search is on) and a `MoreHorizontal` menu (Edit `Edit02`, Delete
  `Delete02`). The dialog form: Inside (a select, "Top level" first), Name, Link name (empty = made from the name).
  Delete asks first; a category with listings or categories inside is refused with the reason.
- **Catalog (`/storefront/listings`):** "View shop" and "Add to shop" (primary, `PlusSign`) in the header; before
  the shop is set up, the empty state "Set up the shop first" (`Store04`) with "Go to shop settings". A filter row
  (search "Name or SKU", max 320px; a Show segmented control All / In the shop / Drafts; a category select with
  `FolderLibrary`), then a data table sorted on the server and paged, a row click opens the editor: listing (a 40px
  photo, radius 8px, 1px `line`, `object-contain`, or a `subtle` tile with `Image01`; the name at 500 and "SKU ·
  150 ml" in caption `ink-3`, the SKU in `Geist Mono`), category, shop price (right, the struck old price under it,
  or "No price"), stock (`good` "In stock" `CheckmarkCircle02`, `warn` "Out of stock" `Alert02`, or "No warehouse"
  in `ink-3`), status (`good` "In the shop" `Store04`, neutral "Draft" `FileEdit`), and the day it changed.
- **Add to shop dialog:** "Add a product to the shop": a `Combobox` of the products not in the shop yet (the server
  searches; detail "SKU · ৳price"), a shop category select ("Add categories" when there are none), and "Add to shop".
  It makes a draft and opens its editor, with the toast "Neem face wash 150 ml added as a draft".
- **Listing editor (`/storefront/listings/$listingId`):** a "Catalog" back link (`ArrowLeft01`), then the page
  header: the listing's name, its status pill above "Sells Neem face wash · NFW-150" and the shop line; on the right
  a 42px `MoreHorizontal` menu button (View in the shop, Delete listing) and "Show in the shop" (primary, `Store04`)
  or "Take out of the shop" (secondary, `FileEdit`), disabled with "Save your changes first…" while the form has
  changes. A `warn` notice (`Alert02`) when the product is archived, a neutral one on a draft. The cards Basics,
  Photos, Price and sale, Description and Search engines sit beside a 320px column, sticky from `lg`, with "In the
  shop now": the first photo (56px), the name, the price at the KPI size, the struck price, a `brand` `Tag01` pill
  ("10% OFF") and when the sale starts or ends. Sale days are whole days in the workspace's time zone, Until
  included. Save waits until every photo is ready.
- **Listing photos card:** up to 4 tiles, two columns from `sm` (1px `line`, radius 10px, 12px padding): "Photo 1"
  with move earlier / later (`ArrowLeft01` / `ArrowRight01`) and remove icon buttons, a 4:3 `subtle` box with the
  photo (`object-contain`, `mix-blend-multiply`), a `brand` "On the shop's card" pill (`Image01`) on the first one,
  and the alt text box ("What the photo shows", required). While the image job runs the box says "Uploading…" or
  "Preparing the photo…" (`Loading03`, spinning only without reduced motion, `role="status"`) and the page asks
  again every 2 seconds; a failed photo says why in `crit` with an `Alert02` icon and a "Remove it" text link. The
  Add tile: a dashed `line-strong` border, a 40px `brand-soft` `ImageAdd01` tile, "Add photo" and "1 more can be
  added".
- **Sections card (a listing's Description, a text page's Sections):** `SectionsCard`
  (`apps/app/src/components/storefront-sections.tsx`), one editor for both; each page owns its `useFieldArray` and
  passes the rows, its title, placeholders and caption. Each section in a 1px `line` box (radius 10px, 16px
  padding): "Section 1" with move up / down and remove icon buttons, Heading, Text (a text area: `- ` lists, `1.`
  numbered lists, `**bold**`, links) and a Preview / Hide preview button (`View` / `ViewOffSlash`). The preview is
  the shop's own HTML (`renderSections`, which escapes everything typed) under a `subtle` caption row ("As the
  product page shows it", "As the shop shows it"). "Add section" (secondary `sm`, `PlusSign`), at most 12.
- **Shop appearance (`/storefront/appearance`):** the page header ("Your shop's logo, colors, hero banner and home
  page") and three cards; before the shop is set up, the empty state "Set up the shop first" (`PaintBoard`) with
  "Go to shop settings". **Logo and colors** is its own form with its own footer (no save bar): "Use the default
  colors" (a text link, pushed left), "Discard changes" (secondary, only with changes) and Save; inside, the logo
  (a 64px `subtle` box, radius 8px, `object-contain`, or the Omnivo mark with "No logo. The shop shows the Omnivo
  mark.", then Upload / Replace / Remove picture, secondary `sm`), Brand color and Accent color side by side from
  `sm`, the contrast list, and from `lg` a 380px "In the shop" drawing (the shop's header, a chip and two of the
  shop's own cards in the colors typed; two grey shapes when it has no listing). **Hero banner:** with none, a
  centered 40px `brand-soft` `Image02` tile, "No hero banner. The home page starts with its products." and "Add
  hero banner" (secondary `sm` link, `PlusSign`); with one, "Edit hero banner" (`Edit02`) in the header, the
  drawing (computer from `sm`, phone below), the headline and "Goes to /c/all?offer=1" in caption `ink-3`. **Home
  page:** "4 of 12 blocks" (caption `ink-3` `tabular-nums`) on the right of the header, a caption line with
  `InformationCircle` ("The hero banner and the product grid always come first."), then the blocks in a 1px `line`
  box (radius 10px), one 64px row each with 1px `line` rules: a 96 × 40 thumbnail from `sm` (the banner's picture,
  `object-cover`, or a `brand-soft` tile of three small cards for a collection), the name (a picture banner by its
  alt text, opening its dialog; a collection a link to its page, with a 14px `ink-3` `Fire` when it has the flame)
  and a caption line ("Picture banner · Goes to /c/all", "Collection · 8 products", "5 of 8 in the shop", or `warn`
  with `Alert02` "None in the shop now, so the row is hidden"), then Move up / Move down icon buttons and a
  `MoreHorizontal` menu (Edit `Edit02`, Delete `Delete02`, which asks first). Empty: "Nothing under the product grid
  yet" (`DashboardSquareAdd`). Under the list "Add picture banner" (`ImageAdd01`) and "Add collection"
  (`PlusSign`), secondary `sm`, each disabled at its limit (6 banners, 8 collections, 12 blocks) with a 13px
  `ink-3` line that says why. A new banner or collection goes to the end.
- **Color box and contrast list:** `ColorInput` (`storefront-color.tsx`), the input box with a 26px swatch on the
  left (radius 8px, 1px `line-strong`) that opens the browser's color picker ("Pick Brand color on a palette") and
  the code in `Geist Mono` (`#005859`). Under the boxes, `ContrastList`: a 1px `line` box (radius 10px) of one row
  per pair ("Brand color on light backgrounds", "Brand and accent together"), the ratio in caption `ink-3`
  `tabular-nums` ("4.4:1, needs 4.5:1", cut, never rounded up) and a `good` "Easy to read" (`CheckmarkCircle02`)
  or `crit` "Too low" (`Alert02`) pill. The form refuses a low pair on the box itself, and the API refuses it too.
- **Picture box:** `PictureField` (`storefront-picture.tsx`), one picture of the hero, a picture banner or (its own
  smaller box) the logo: the label, then a 1px `line` box (radius 10px, 12px padding) with the picture in a
  `subtle` box at the shop's own shape (at most 180px tall), Replace picture / Remove picture (secondary `sm`) and
  the alt text box ("What the picture shows", required). Empty, the box is a button with a dashed `line-strong`
  border, a 40px `brand-soft` `ImageAdd01` tile and "Upload picture". It uses the listing photos' upload and job
  ("Uploading…", "Preparing the picture…", the 2-second ask, a failed one in `crit` with "Remove it"); a save tried
  with no picture says "Upload a picture." under it. The hint gives the file rule and the size that looks sharp.
- **Links to:** `LinkPicker` (`storefront-link.tsx`), for the hero and a picture banner. A select (`Link01`): A
  shop category, A product, Products on offer, All products, Another address; the first two add a second box
  beside it from `sm` (a category select with `FolderLibrary`, or a product `Combobox` with `Store04`), the last an
  address box ("/pages/about", or a whole `https://` link). Under it, "Goes to /c/skin-care" in 13px `ink-3`. A
  saved address that names nothing now, or a draft product, gets a `warn` line with `Alert02` that says the link
  shows "page not found". Only the address is saved (`href`); the select keeps its own choice while typing.
- **Hero banner page (`/storefront/appearance/hero`):** a "Shop appearance" back link (`ArrowLeft01`), "Add the hero
  banner" or "Edit the hero banner" with a `MoreHorizontal` menu (Delete hero banner, which asks first). Cards, one
  column: "In the shop" (a Computer / Phone segmented control and the drawing at the shop's own size, scaled to the
  card: the computer one at 1280 × 280 so the headline wraps where the shop wraps it, the phone one 361 × 220 on
  `subtle`; it follows every key), Words (Headline, then Button and Tag side by side from `sm`, Line under the
  headline, Links to; each hint says where it shows), Pictures (computer and phone side by side from `md`), and
  Colors (Background, Panel, Button, Button's words, two by two from `sm`, then the contrast list: "Button's words
  on the button" 4.5:1 and "White headline on the panel" 3:1). The save bar shows with changes, and always on a
  new hero ("Discard changes" then goes back).
- **Picture banner dialog:** the dialog at 560px (two pictures do not fit 520px), "Add a picture banner" or "Edit
  picture banner", with "A picture with its words in it, like a sale, across the home page." The picture for
  computers (shown 1,280 × 280) and for phones (about 360 × 140), each with its alt text ("The banner's words are
  in the picture, so type them here…"), then Links to. "Add banner" / Save (primary), Cancel, and on a saved one
  Delete (secondary, pushed left).
- **Collection page (`/storefront/appearance/collections/$collectionId`, `…/new`):** at most 880px wide; a "Shop
  appearance" back link, the title (or "New collection") with a `MoreHorizontal` menu (Delete collection, which
  asks first), and a `warn` document notice (`Alert02`) while none of its products is in the shop ("…the home page
  hides this row until one is"). Cards: the title box and a checkbox "Show a flame after the title" (`Fire`);
  then Products ("Up to 24, in the order the row shows them.", "5 of 24" on the right): a product `Combobox`
  (`Store04`, max 520px; detail "SKU · ৳229 · Draft", no photos; the ones already in it are left out), then the
  list in a 1px `line` box (radius 10px): the number from `sm` (caption `ink-3`), a 40px photo, the name, "SKU ·
  150 ml" (SKU in `Geist Mono`), the price and the status pill from `sm`, then Move up / Move down / Remove icon
  buttons. Empty, a neutral notice "No products yet…"; with a draft, "Drafts stay here and show in the row once
  they are in the shop." A new one has "Add collection" (primary, right-aligned); a saved one the save bar.
- **Shop pages (`/storefront/pages`):** the page header ("The four pages linked from the shop's footer") and a data
  table of the four, no sort and no paging, a row click opens the editor: page (a 30px `brand-soft` tile with the
  page's icon, `SecurityCheck` / `LegalDocument01` / `Store01` / `CallIncoming01`, the footer's name and an `ink-3`
  sub-line of what the page is for), status (`good` "In the footer" `CheckmarkCircle02`, or neutral "Not written"
  `MinusSignCircle`), sections ("3 sections" or a dash), changed (or a dash), and a Write / Edit text link.
- **Text page editor (`/storefront/pages/$slug`):** at most 880px wide; a "Shop pages" back link, the status pill
  above the page's name, "View page" (the View shop look) and a `MoreHorizontal` menu (Delete page, which asks
  first and says the footer drops its link). A page not written yet has a neutral notice that its link is not in
  the footer and its address shows "page not found". Then the sections card ("Sections", "Each with a heading and
  its text, like Delivery and Returns.") and the save bar. The first save puts it in the shop ("Terms & Condition is
  in the shop"); a page always keeps at least one section, so taking it out is Delete.
- **Shop orders (`/storefront/orders`, `storefront.order.read`):** the page header ("Orders from your online shop,
  from the checkout to the shopper’s door"; "View shop" only with `storefront.manage`, and no "Changes show in
  the shop" line; "Export for courier", secondary with `Download04`, on every tab, with `storefront.order.manage`
  and online only: a CSV of the packed orders with no parcel, at most 500, in Steadfast's bulk upload columns
  (Invoice, Name, Address, Phone, Amount, Note), with a byte order mark so Excel reads Bangla, a `'` before a cell
  that starts with `=`, `+`, `-` or `@`, the amount with paisa and the local day in the file name; nothing waiting is
  a toast, never an empty file, and the same toast says when more orders wait than one file holds), a search box ("Order number, name or phone", max 320px, inside the tab only), a segmented control
  New / Packed / Shipped / Delivered / Cancelled / Returned / All (the tab is in the address, `?view=packed`; New, the
  default, has none), then a data table sorted on the server and paged: order (number in `Geist Mono`, "3 items" under it),
  confirmed (date and time, newest first at first, sortable), shopper (name, phone under it), delivery zone,
  payment ("Cash on Delivery" or "Paid online"), total (sortable) and status (the status pill; on a shipped order
  whose newest parcel did not all reach the shopper (`parcelStatus`), a second `warn` pill, "Partly delivered"
  (`PackageRemove`) or "Coming back" (`DeliveryReturn01`); and a `crit` "Needs attention" pill when its sales order,
  its parcel's booking or its COD receipt failed). A row click opens the
  order. On a phone the card leaves out Payment. A pending order (waiting for its phone code) never shows. Empty: "No
  shop orders yet" on All, the tab's own line on the others, and "No order matches" with "Search every order" (moves
  to All, keeps the search). Online only.
- **Shop order page (`/storefront/orders/$orderId`):** a "Shop orders" back link (`ArrowLeft01`), the number (`h1`) with
  its pills beside it and "Placed …" under it; on the right "Cancel order" (secondary,
  `CancelCircle`, while New or Packed), "Book courier" (secondary, `ShippingTruck01`, on a packed order with no
  parcel on its way, also while a failed one waits, so another account can take it) and the next step's primary
  button: "Make the sales order" (`Agreement01`, a
  New order without one), "Mark packed" (`Package`), "Mark shipped" (`DeliveryTruck01`, at once; it stays while an
  API parcel is on its way, as a way out when the courier's news are late). A shipped order has three buttons, the
  primary last: "Record what came back" (`PackageRemove`), "Receive the return" (`PackageReceive`) and "Mark
  delivered" (`PackageDelivered`, its own dialog: it posts an invoice); the primary is the one the newest parcel
  asks for (partly delivered → Record what came back; going back or returned → Receive the return; else Mark
  delivered), the other two secondary. On a phone the buttons are two columns and the step's button takes the whole
  second row. One notice under
  the header: `crit` "The sales order could not be made." with the error's own words, else `crit` "The COD receipt
  could not be made." with the error's words and a "Make the receipt" text link (with `storefront.order.manage`), else
  `crit` "Steadfast Dhaka
  did not book the parcel." with the error's words and a "Book again" button (books the same parcel with the same
  account), else neutral "This order has
  no sales order yet…", else what the next step does (a delivered order's ends with a "Record payment" link to a new
  money receipt for that invoice, with `sales.receipt.manage`; a delivered order paid online says "The invoice is
  paid: it took the online payment’s money receipt." with no link; one whose COD receipt was made says "The rider’s
  cash came in on money receipt MR-…, into …’s COD account…" with no link; one where the rider collected ৳0 says
  no receipt was made, with the link). A shipped order whose parcel came back in part or is coming back says so
  ("Steadfast Dhaka delivered part of the parcel. Once the goods that came back are on the shelf, record what came
  back…", "…is bringing the parcel back. Once it is on the shelf, receive the return…"). A paid order that must give
  money back (cancelled after it was paid, paid twice, paid online and then switched to cash on delivery, or paid
  online and partly delivered) also has a `warn` notice
  (`MoneyRemove01`) with the amount and a "Record refund" link (with `sales.refund.manage`, a new refund of the last
  paid try's receipt); it comes after the sales order's error and before the step's line. Once the order has a
  parcel, the step's line says who moves it next: "Omnivo is booking the parcel with …", "The order moves to Shipped
  by itself when …’s rider picks the parcel up", "…to Delivered by itself when … delivers it. That posts the
  invoice."; a manual parcel keeps the buttons ("Mark it shipped when Pathao picks the parcel up."), and a packed
  order with none says "Book a courier, or mark it shipped…". While a parcel is booking the page asks again every 3
  seconds. Without `storefront.order.manage`, no buttons and a
  neutral notice that says which permission moves orders. From `xl` two columns: Items (a 40px photo, name, "SKU ·
  150ml", "2 pcs × ৳229", the amount; then Subtotal, Discount only when there is one, Delivery charge or "Free", and
  the Total at 500, all on `subtle`), the parcel cards under it (newest first), the Payments card (only when the
  order has a payment try) and Timeline (oldest first, 24px round icons on `subtle`, the step it is at on
  `brand-soft`/`brand`, a 1px `line` between them, the time in 12px `ink-3`, and "Why: …" under Cancelled), beside a
  340px column of Deliver to (name, mobile number, address with its line breaks, zone, payment ("Paid online"), "Customer in Omnivo"
  or "Found by the phone with the sales order") and Documents (sales order, challan, invoice, sales return; each
  number a link, or when it comes: "When it is packed"; a cancelled order lists only what it made). On a phone the
  cards are Items, Parcels, Payments, Deliver to, Documents, Timeline. Amounts like the shop (paisa only when there is some). Online
  only.
- **Payments card (shop order page):** `storefront-order-payments.tsx`, "Payments", "Each visit to the SSLCommerz
  page…", one row per try, oldest first, with 1px `line` rules: "Try 2" (13.5px/500), its pill and the amount on the
  right, "Started …" and "Answered …" in 12px `ink-3`, then a grid of facts with caption labels (two columns on a
  phone, three from `sm`): Transaction ID in `Geist Mono`, and for a paid try Paid with ("BKASH-BKash"), Bank’s
  transaction ID (`Geist Mono`, `break-words`), Gateway fee (amount − what SSLCommerz pays out), SSLCommerz pays out,
  and Money receipt as a link. A try that did not pay shows only its transaction ID. A paid try whose receipt could
  not be made has a `subtle` box with the error in `crit` with `Alert02` and, with `storefront.order.manage`, "Make
  the receipt" (secondary `sm`, sends the order's version).
- **Shop payment try statuses:** Started (`brand`, `Clock01`), Page did not open (neutral, `Unlink04`), Paid (`good`,
  `CheckmarkCircle02`), Failed (neutral, `CreditCardNotAccept`), Cancelled (neutral, `CancelCircle`). Failed is not
  `crit`: a refused card is the shop's normal day. Only Paid is final; a later Paid replaces a Failed or a Cancelled.
- **Parcel card (shop order page):** `storefront-order-parcels.tsx`, one card per parcel, "Parcel" ("Parcel 2" above
  "Parcel 1" when the order was booked again), the parcel pill beside the title, "Sent with Steadfast Dhaka" under
  it, and "Print label" (secondary `sm`, `Printer`) on the right once it has a tracking code and is not cancelled.
  While booking, a `role="status"` line with `Loading03` (spinning only without reduced motion), "Booking with …"
  and "Tried 2 times. Omnivo tries again by itself." once a try failed. A failed booking shows "The courier said:
  “Invalid phone number”" when the courier sent words, else our error's words. Then a grid of facts with caption
  labels (two columns on a phone, three from `sm`), only the ones that exist: Courier, Tracking code, Courier’s ID,
  Rider collects ("Nothing: paid online" for a paid order; paisa only when there is some), Booked, Last news, then
  from 28b Rider collected (the courier's notice or what the member typed; ৳0 is shown), Courier’s charge and Money
  receipt (the COD receipt's number in `Geist Mono` as a link), then from 28c "Paid out on" (the posted payout's
  `CPO-…` number in `Geist Mono`, a link only with `storefront.payout.manage`, else plain text). A COD receipt that failed adds a `crit` line with
  `Alert02` ("The COD receipt could not be made. …"), with no button: "Make the receipt" is in the page's notice. An API
  parcel then lists "The courier’s news", newest first, in the Timeline card's style with the pills' icons ("No news
  from the courier yet."); a manual one says "Booked by hand. Move the order with its buttons."
- **Parcel statuses:** Booking (`brand`, `Clock01`), Booking failed (`crit`, `Alert02`), Booked (`brand`,
  `DeliveryBox01`), Picked up (`brand`, `PackageMoving`), In transit (`brand`, `DeliveryTruck01`), Out for delivery
  (`brand`, `DeliveryTracking01`), Delivered (`good`, `PackageDelivered`), Partly delivered (`warn`, `PackageRemove`),
  On hold (`warn`, `DeliveryDelay01`), Going back (`warn`, `DeliveryReturn01`), Returned (neutral, `PackageReceive`),
  Cancelled (neutral, `CancelCircle`). Work on its way is `brand`; `warn` is what the shop must act on. Booking and
  Booking failed are the ERP's own: the shop shows a parcel only once the courier gave it a tracking code.
- **Book courier dialog:** "Book a courier for W-000123", a line of what the courier gets and what the rider
  collects (or that the order is paid), a "Courier account" select ("Steadfast Dhaka · Steadfast", the active
  accounts, starting at the default), and for a manual account a "Tracking code" box (upper-cased, letters, digits
  and dashes, "Book the parcel on the courier’s website or app first…"); an API account's hint says Omnivo books it
  now. "Book courier" (primary). The toast: "Booking W-000123’s parcel with …", or "W-000123 booked with …, code …"
  for a manual one. With no active account, a line that says to add one in Shop couriers.
- **Parcel label:** a print sheet like the POS receipt (`data-print-sheet`, its own `@page { size: A6; margin: 0 }`),
  105 × 148 mm, black on white, no fills and no barcode (the courier prints its own): "Steadfast · SFR2611120042" in
  `Geist Mono` over a 2px rule, the order number, To (name, phone, the address with its line breaks, zone), the
  amount in a 2px box ("Collect ৳578.00", always with paisa, or "Paid. Collect nothing.") and From (the company's
  legal name, address and phone). It waits for the company's settings, prints once and leaves the page.
- **Packed dialog:** the dialog at 560px, "Pack W-000123", "The challan takes these goods out of Main warehouse…".
  One block per line in a 1px `line` box (radius 10px): the name and "Needs 3 pcs"; an untracked product says "No
  batch or serial number to pick."; a batch product has rows of a batch select ("AT-2408 · expires 30 Nov 2026 · 12
  pcs here", first expiry first as the server suggests) and a quantity box, a remove icon button (disabled on the
  last row), "Add another batch" (secondary `sm`) and "2 of 3 pcs picked" (`good` with `CheckmarkCircle02` once it adds up), or
  `crit` "No batch of this product has stock in …"; a serial product has the serial number box and "1 of 2 typed".
  A quantity shows without its zeros at the end, never rounded. Errors land under the box the API names
  (`lines.0.picks.1.quantity`). Under the lines, "Send with" (only when the shop has an API courier account): the
  active API accounts, starting at the default ("Book at Packed"), and "Don’t book now", with a hint of what each
  does; the dialog waits for the plan and the accounts together, and opens without the select when the accounts
  can't be read (packing never waits for a courier). "Mark packed" (primary); the toast then says the booking
  started.
- **Cancel shop order dialog:** "Cancel W-000123?", what happens (a new order frees its stock; a packed one gets a
  sales return), "Why" (optional, 200 characters, "Only your team sees this. The SMS does not say why."), "Keep the
  order" (secondary) and "Cancel order" (primary). With a booked parcel, a `warn` document notice says it is
  cancelled here too and must be cancelled on the courier's panel as well. A parcel still booking is refused
  (`storefront_order_parcel_booking`), and one the courier picked up is a return, not a cancel.
- **Mark delivered dialog:** `storefront-order-door.tsx`, "Mark W-000123 delivered?", what it posts: with the
  parcel's courier account's COD account, "This posts an invoice for ৳538, dated today, and a money receipt into
  Steadfast Dhaka’s COD account for what the rider collected."; paid online, that the invoice takes the online
  payment's receipt; else the invoice alone. Only with a COD account and something to collect, a money input "What
  the rider collected" (starts with the courier's figure, else what the rider was to collect; "The rider was to
  collect ৳538. Type less if the shopper paid less…"; never more than that, and ৳0 makes no receipt). Cancel and
  "Mark delivered" (primary). The toast names the invoice, and the money receipt when one was made.
- **Record what came back dialog:** `storefront-came-back.tsx`, its own lazy chunk, at 560px: "Record what came back
  of W-000123", "Tick the goods that came back. A sales return brings them back into Main warehouse…". The challan's
  lines in a 1px `line` box (radius 10px, 1px `line` rules), each a checkbox ("Came back: …") with the name, the SKU
  in `Geist Mono`, "3 pcs sent" and the batch in caption `ink-3`; once ticked, a quantity stepper (1 to what was
  sent) or ticks of the serial numbers that left. Then "What the rider collected" (a money input, only with a COD
  account; it starts with the courier's figure, else empty, with "Steadfast Dhaka says the rider collected ৳309."
  under it with `InformationCircle`), "Why it came back" (optional, it goes on the sales return), Cancel and "Record
  what came back" (primary). Nothing ticked is refused (that is Mark delivered), and everything ticked too (that is
  Receive the return). It posts the sales return before the invoice of the rest, then the COD receipt.
- **Receive the return dialog:** "Receive W-000123 back?", that a sales return brings everything on the challan back
  into stock, the sales order is cancelled, the order moves to Returned and the shopper gets an SMS; a neutral
  document notice "Do this once the parcel is on your shelf, not on the courier’s word alone."; "Why it came back"
  (optional); "Not yet" (secondary) and "Receive the return" (primary). The courier's returned never moves stock by
  itself.
- **Shop order statuses:** New (`brand`, `Clock01`), Packed (`brand`, `Package`), Shipped (`brand`,
  `DeliveryTruck01`), Delivered (`good`, `PackageDelivered`), Cancelled (neutral, `CancelCircle`), Returned (neutral,
  `PackageReceive`, after Receive the return), plus a second `crit` "Needs attention" pill (`Alert02`) while its sales
  order could not be made, its parcel's booking failed or a delivered parcel's COD receipt failed (`needsAttention`,
  set by the API). A shipped order whose newest parcel is partly delivered or going back has a second `warn` pill
  (Partly delivered, `PackageRemove`; Coming back, `DeliveryReturn01`). The timeline's icons: placed `ShoppingCart01`, confirmed `SmartPhone01` ("Confirmed with the phone
  code") or, on an order paid online, `CreditCardAccept` ("Confirmed when the payment arrived"), then the pills'
  icons.
- **Filter chips / segmented control:** radius 8px, 1px `line-strong` border. The
  selected chip is inverted (`ink` background, `bg` text). The selected segment uses a
  `subtle` background. With more options than fit (a sales order has six statuses), the control scrolls inside
  its own box on a phone; the page never scrolls sideways. Its `fieldset` is `relative`, so the `sr-only` radios
  stay inside the box that scrolls.
- **Sidebar nav:** 14px/500 `ink-2` items with `ink-3` icons, radius 8px, hover
  `subtle`. The active item uses a `brand-soft` background with `brand` text and icon.
  Group labels are 11.5px/500 `ink-3`. Counts are right-aligned (`crit` when they need
  action). The active state comes from `aria-current="page"`, not a separate prop. On
  phones the nav is one horizontally scrolling row and group labels are hidden.
  The desktop sidebar scrolls inside itself (`overflow-y-auto`) when the navigation is
  taller than the screen.
- **Module rail:** the eight modules — Home, Sell, Buy, Stock, Accounts, Shop, Reports, Setup — as a 72px column
  of 56px items: a 20px icon over a `micro`/500 label, centred, radius 8px, hover `subtle`, the open one
  `brand-soft` with `brand` text and icon. A module with work waiting shows a 6px `crit` dot at its icon's
  top-right, never a number (the number is on the menu's own link), and the item's accessible name says it
  ("Buy, 3 waiting"). Each item is a link to its module's landing page, so Back works and a page can be
  bookmarked; which item is open comes from the route, not from a click, and no module is marked on a page that
  belongs to none (`/sync`, `/my-devices`). A module whose every link is hidden by permission is not in the rail.
  On a phone the rail is a row of the top bar, above the module's links: the same items as 13.5px chips in a
  horizontally scrolling row. The logo, the bell and the account menu stay where they are.
- **Module menu:** the 244px column beside the rail: the module's name (15px/600, `sr-only` on phones), the
  workspace switcher, then the module's links in named sections (`NavGroup`), then the sync line. Sections are
  the order of work, not the alphabet (Sell: Counter, Orders, Money in, What comes back, Customers). A module
  with five links or fewer has no section label. The menu scrolls inside itself when a module is taller than the
  screen (Sell's fifteen links are, on a 900px laptop); the sync line is then sticky at the bottom of the menu,
  on `surface`, so it never goes under the fold. The `nav` is labelled by the module's name.
- **Icon button:** 18px `ink-3` icon, radius 8px, 8px padding, hover `subtle` with an
  `ink` icon. It always has an accessible label.
- **Notification bell:** an icon button (`Notification03Icon`) next to the logo on every screen size, with an
  unread badge: 18px `brand` circle, `brand-ink` 12px/500 `tabular-nums`, top-right, "9+" above nine, hidden
  from screen readers (the button's label says the count). The panel is a popover, 340px (never wider than the
  screen minus the gutters), a 15px/600 title with a "Mark all as read" text link, and rows with a `brand`
  unread dot, 13.5px text (`ink` unread, `ink-2` read) and a 12px `ink-3` time. Clicking a row marks it read and
  opens its page.
- **Dropdown menu / popover:** `surface`, 1px `line`, radius 10px, `shadow-lg`, 4px
  padding (12px for a popover). Items are 13.5px `ink-2`, radius 8px, highlighted
  (hover or keyboard) `subtle` with `ink` text. Group labels are 12px/500 `ink-3`. The
  selected radio item shows a `brand` `Tick02` icon.
- **Dialog:** `surface`, 1px `line`, radius 14px, `shadow-lg`, max-width 520px, padding 24px (18px on phones),
  16px from the screen edges on phones and scrolls inside when tall. The backdrop is `overlay`, no blur. Header is
  the card header (15px/600 title, 13px `ink-3` description) with a Close icon button; the footer is a right-aligned
  button row above a 1px `line` rule, destructive or secondary actions pushed left. No animation.
- **Select:** a native `<select>` inside the input box (same height, border, radius, focus), with an `ArrowDown01`
  icon in `ink-3` on the right. Use it for fixed lists (currency, month, time zone); use a dropdown menu for actions.
- **Select (bare):** `Select` from `@omnivo/ui` is the select box without its label, for controls labelled by a
  column header (journal lines). `SelectField` is built on it.
- **Combobox:** `Combobox` from `@omnivo/ui`, for picking one of many rows the server searches (a customer).
  The button looks exactly like an input (17px leading icon, an `ArrowDown01` icon on the right, the chosen
  label or the placeholder in `ink-3`). It opens a popover as wide as the button, at least 288px, with a search
  box on top and the matches below: 13.5px label, a 12px `ink-3` detail line (code · phone), highlighted
  `subtle`, the chosen one with a `brand` `Tick02` icon. "Searching…" and "Nothing matches" (or the page's own
  text, "No active customer matches") are a `role="status"` line. The focus stays in the search box (the ARIA
  combobox pattern). The page owns the search and runs it on the server, or on the device for the customer box
  (step 18a); use a native select for short fixed lists.
- **Line editor (journal lines, opening balances):** a card that is a container (`@container`); each row is a
  `role="group"` labelled "Line 2". On a wide card (`@3xl`) the rows share one grid template with the header and
  the totals row, and each control's label is `sr-only`; on a narrow card the labels show and debit/credit sit
  side by side. Totals row on `subtle` with a `good` "Balanced" or `crit` "Out by" pill.
- **Sales line editor (quotations, orders, purchase orders, bills):** `SalesLinesEditor`, a card that is a container (`@container`) and
  its own lazy chunk. The lines are one controlled form value (a `Controller` on `lines`), so two form types
  share it. On a wide card (`@5xl`) item, unit, quantity, price, discount, VAT rate and amount share one grid
  template with a caption header; on a narrow card each control shows its label. The price column says "Price
  with VAT" or "Price before VAT" from the document's own setting. A new line shows where its price came from
  under the box (12px `ink-3`: "From their price list", "Product price", "No price set: type one"). When a line
  was priced for another customer, a text link at the top offers "Use this customer's prices on every line";
  changing the customer never reprices by itself. A purchase order uses the same editor with a supplier's
  `LinePricing`: the hints are "Last price from this supplier", "Last price paid", "From the average cost" and "No
  earlier price: type one", and the link says "Use this supplier's last prices on every line". A bill uses it with
  `totals={false}`, because its totals also count the expenses: a line from a goods receipt says "From GRN-… ·
  PO-…", that the item, unit and quantity are the receipt's, and "Order's price: ৳1,87,500 · ৳1,500 over the order"
  (12px `ink-3`, the difference `ink-2`/500); a `warn` document notice under the totals gives the sum. After a
  return before the bill, a receipt line bills what was kept, in the receipt's unit when that is a whole number of
  it, else in the base unit, and says "30 m went back before billing: this bills the rest". An invoice line from a
  challan follows the same rule after a return before billing ("12 pcs came back before billing: this bills the
  rest", then 4 of 5 dozen; 42 pcs of 2 cases of 24 bill in pcs), so the order's price is not rounded. Under the
  lines, a totals block on `subtle` (line discounts
  only when there are any, before VAT, VAT, total at 500) with paisa, and on the left whether prices include VAT.
- **Expenses card (bills):** `BillExpenses`, a card that is a container (`@container`) under the bill's lines:
  "Expenses" with "Costs with no product, like rent, electricity or a repair". On a wide card (`@3xl`) account,
  description, amount, VAT rate and the amount with VAT share one grid template with a caption header on
  `subtle`; on a narrow card each control shows its label. "Add expense" (secondary `sm`, `PlusSign`) at the
  bottom; a remove icon button per row. The bill's one totals block sits under both cards. A debit note uses the
  same card for the bill's expenses it takes money off ("Bill expenses to take money off, like a transport charge
  billed twice"), each row with "৳1,200 of this line can still be taken off" under it.
- **Sales document statuses:** quotation Open (`brand`, `Clock01`), Accepted (`good`, `CheckmarkCircle02`),
  Declined (neutral, `CancelCircle`), Expired (`warn`, `Hourglass`, worked out by the page: open and past its
  date). Order Draft (neutral, `FileEdit`), Confirmed (`brand`, `Agreement01`), Partly delivered (`brand`,
  `DeliveryTruck01`), Delivered (`good`, `PackageDelivered`), Closed (neutral, `StopCircle`), Cancelled (neutral,
  `CancelCircle`), plus a second `warn` "Late" pill (`Time04`) for a confirmed order past its delivery date.
  Delivery Draft (neutral, `FileEdit`), Posted (`good`, `CheckmarkCircle02`). Work in progress is `brand`, not
  `warn`; `warn` is for something the person must act on.
- **Invoice and receipt statuses:** invoice Draft (neutral, `FileEdit`), then by payment Unpaid (`brand`,
  `Clock01`), Partly paid (`brand`, `Coins01`), Paid (`good`, `CheckmarkCircle02`), plus a second `crit` "Overdue"
  pill (`Time04`) for a posted invoice not paid by its due date (worked out by the page, in the workspace's time
  zone). Money receipt Posted (`good`, `CheckmarkCircle02`), Voided (neutral, `CancelCircle`). A challan's billing:
  Not invoiced (neutral, `Invoice01`), Partly invoiced (`brand`, `Invoice03`), Invoiced (`good`, `Invoice02`), also
  per line. An overdue invoice has a `warn` document notice (`Hourglass`) that says how many days.
- **Return, credit note and refund statuses:** sales return and credit note Draft (neutral, `FileEdit`), Posted
  (`good`, `CheckmarkCircle02`); refund Posted (`good`, `CheckmarkCircle02`), Voided (neutral, `CancelCircle`). An
  invoice that credit notes took money off: Credited (neutral, `Invoice04`) in place of its payment pill when the
  whole total is credited, else Partly credited (neutral, `Invoice04`) beside it. A challan's returns: Partly
  returned (neutral, `DeliveryReturn01`), Returned (neutral, `PackageReceive`); nothing came back = no pill.
  Purchase return and debit note Draft (neutral, `FileEdit`), Posted (`good`, `CheckmarkCircle02`); supplier refund
  Posted (`good`, `CheckmarkCircle02`), Voided (neutral, `CancelCircle`). A bill that debit notes took money off:
  Debited (neutral, `Invoice04`) in place of its payment pill when the whole total is debited, else Partly debited
  (neutral, `Invoice04`) beside it. A goods receipt's returns: Partly returned (neutral, `TruckReturn`), Returned
  (neutral, `PackageRemove`); nothing went back = no pill.
- **Purchase statuses:** requisition Draft (neutral, `FileEdit`), Waiting for approval (`brand`, `Clock01`),
  Approved (`good`, `CheckmarkCircle02`), Cancelled (neutral, `CancelCircle`). An approval round and its steps:
  Waiting (`brand`, `Clock01`), Approved (`good`, `CheckmarkCircle02`), Rejected (`warn`, `ArrowTurnBackward`:
  the writer must act), Reopened (neutral, `Undo02`), and a step never reached "Not yet" / "Not decided"
  (neutral, `MinusSignCircle`). A requisition is also Closed (neutral, `StopCircle`), and an approved one has a
  second pill for how much is ordered: Partly ordered (`brand`, `ShoppingCart01`), Ordered (`good`,
  `ShoppingCartCheck01`), none while nothing is. Purchase order Draft (neutral, `FileEdit`), Waiting for approval
  (`brand`, `Clock01`), Approved (`good`, `CheckmarkCircle02`), Partly received (`brand`, `DeliveryTruck01`, in
  Approved's place), Received (`good`, `PackageReceive`), Closed (neutral, `StopCircle`), Cancelled (neutral,
  `CancelCircle`), plus a second `warn` "Late" pill (`Time04`) for an approved order past its expected date. Goods
  receipt Draft (neutral, `FileEdit`), Posted (`good`, `CheckmarkCircle02`). A goods receipt's billing: Not billed
  (neutral, `Invoice01`), Partly billed (`brand`, `Invoice03`), Billed (`good`, `Invoice02`), also per line. Bill
  Draft (neutral, `FileEdit`), Waiting for approval (`brand`, `Clock01`), Cancelled (neutral, `CancelCircle`), then
  by payment like an invoice: Unpaid (`brand`, `Clock01`), Partly paid (`brand`, `Coins01`), Paid (`good`,
  `CheckmarkCircle02`), plus a second `crit` "Overdue" pill (`Time04`). Supplier payment Draft (neutral,
  `FileEdit`), Waiting for approval (`brand`, `Clock01`), Posted (`good`, `CheckmarkCircle02`), Voided and
  Cancelled (both neutral, `CancelCircle`).
- **Approval card:** a card ("Approval", with a subtitle) on every document that needs an approval. A draft lists
  the levels its amount reaches now ("Purchase manager · from ৳20,000"). A round: "Round 2" (13.5px/500) with its
  pill, a 13px `ink-3` line (who submitted it, when, for how much), then its steps in a 1px `line` box (radius
  10px, one row each, 1px `line` rules): the level, its pill, a 12px `ink-3` "who and when", and the comment in a
  `<q>`. The waiting step gets a `subtle` box below: "Step 2 waits for you." with Approve (primary `sm`) and
  Reject (secondary `sm`, `ArrowTurnBackward`), "You submitted it, so someone else approves it." for the writer,
  or "Waiting for Purchase manager". Earlier rounds fold into a `<details>` with a `brand` text-link summary.
  Approve and Reject are on the document's page only, never on a list. On a bill or a supplier payment, the last
  approval posts it, and the dialog and the card say so ("This is the last step: BILL-2026-27-0004 is posted in the
  books when you do.", "No level applied, so it was posted when it was submitted.").
- **Approval dialogs:** the dialog. Approve says whether this click finishes the approval or passes it on, with
  an optional comment; Reject needs a comment (it says what to change). Errors that name no box show at the top.
- **Approval levels (Settings):** one card per kind of document, each its own form. A level is a box (1px `line`,
  radius 10px, 16px padding) with "Level 2" (13px/500 `ink-2`), a whole-taka money input "From amount" and a role
  select side by side, and a remove icon button. "Add a level" (secondary) and Save (primary) at the bottom, the
  rules in 13px `ink-3` above them; at most five levels. Without `core.settings.manage` the same page is read-only.
- **Document notice:** a line above a document that says what its state means and what to do next: radius
  10px, 13.5px text, a 17px icon, `warn-bg` with `warn` text and an `Hourglass` icon
  for an offer that has ended, a credit note more than 6 months after its invoice, an overdue bill or a bill whose
  prices differ from its orders, a device that has not synced for 24 hours or 7 days, or an `ArrowTurnBackward`
  icon and the approver's comment for a document sent back by an approval,
  `crit-bg` with `crit` text and an `Alert02` icon when the document can't go on until someone acts (a shop order
  whose sales order could not be made), and
  `subtle` with `ink-2` text and an `InformationCircle` icon otherwise. An optional action (a text link like "Record
  payment") sits at the end of the line and wraps under the words on a phone. It is `DocumentNotice` in
  `apps/app/src/components/document-notice.tsx` (since 18c; the sign-in page uses it, so it may not import any
  module's code).
- **Credit line and credit dialog:** under the customer box on an order or invoice form, a 13px line: "Credit
  left: ৳35,000 of ৳2,00,000 · ৳40,000 on confirmed orders" in `ink-3`, whole taka, `tabular-nums`; over the limit
  it is `crit`/500 with a 15px `Alert02` icon. Shown only with `sales.customer.balance`. When the API refuses a
  document over the limit, someone with `sales.credit.override` gets a dialog (what the customer would owe and the
  limit, in paisa; "The audit log records that you went over the limit."; Back and "Confirm anyway" / "Post
  anyway"); everyone else gets the error text under the form with the same amounts.
- **Allocation table (money receipts, supplier payments, debit notes):** the invoices the customer still owes on, oldest due date first, in an
  `overflow-x-auto` box: invoice number (`Geist Mono`) with its dates under it, the total, what is still due
  (500), and a money input for this receipt. Above it "Apply oldest first" and "Clear" (secondary `sm`); below
  it a `subtle` row with Applied and "Left as advance" (or a `crit` "Over by ৳x" with an `Alert02` icon). A
  supplier payment uses the same table for the supplier's posted bills, with the supplier's own bill number
  ("Their bill PSM/2026/0412") under ours. A debit note's money is applied to the supplier's bills with the same
  table, in the payment's "Apply money" dialog.
- **Stock line rows (adjustments, transfers, goods receipts, purchase returns):** a card that is a container (`@container`); one grid template for a
  caption header and every row on a wide card (`@3xl`): item (name, SKU, stock here), unit, quantity (with
  "= 72 pcs" under it), and on a line that brings stock in, the unit cost per unit of the line (a `MoneyInput`
  with 4 decimals, "Cost per case", placeholder "At average cost", "= ৳3,600.00" under it), batch or serial
  numbers, remove. On a narrow card each control shows its label. Lines are added with the "Add items" dialog
  (search or scan; Enter adds the only match; the dialog stays open). On a goods receipt the quantity is
  "Accepted", with "Ordered 1,000 m · 400 m left on the order · Up to 430 m may come" under it (the last part only
  when the workspace lets more in), then "Rejected" in the line's unit and, once something is rejected, "Why it was
  rejected". On a purchase return, a line from a goods receipt says "From GRN-…", that the item and the batch are
  the receipt's, and "400 m can still go back"; a line on its own says "Not from a goods receipt: it leaves at the
  average cost".
- **Stock values:** a value worked out from the books is shown only with `inventory.stock.value`; without it the
  column is left out (lists) or shows a dash (documents). A stock document links its journal entries
  ("JV-2026-27-0042") for people who read the journal, and a stock entry links back ("From ADJ-…").
- **Serial number box:** the text area's look, `Geist Mono`, one serial number per line.
- **Expiry pill:** expired = `crit`, 30 days or less = `warn` ("12 days left"), later = the date alone.
- **Text area:** the input box, three rows tall, resizes vertically only.
- **Stepper (wizards):** numbered 26px circles, which is valid because the steps are a
  real sequence. The current step has a `brand` border and ring. Done steps are filled
  `brand` with a `Tick02` icon.
- **Selectable card (industry, module):** 1px `line-strong` border. When selected it
  gets a `brand` border, a `brand-soft` background and a `brand` icon tile. A group of them is
  `SelectableCardGroup`: real radio inputs, one choice.
- **Toast:** `ink` background with `bg` text, radius 10px, `shadow-lg`, bottom-center,
  about 3s. The copy names what happened ("Workspace created").
- **Charts:** `LineChart` from `@omnivo/ui`, our own SVG (no chart library), in the page's lazy chunk. A single
  series uses a 2px `brand` line, a `brand` area fill fading from 14% to 0 down to the zero line, dashed `line`
  gridlines at round steps (below zero too, for a day with more returns than sales), 11px `ink-3` axis labels and
  an emphasized end point. It is drawn at its box's pixel width, so the labels stay 11px on a phone. Every chart
  gets a hover crosshair and tooltip (`surface`, `line` border, `shadow`), and takes the focus: the arrow keys,
  Home and End walk the days, and a live region says each one. Magnitude bars use `brand`, with `brand-line` for
  de-emphasized bars. Never use dual axes.
- **Logo:** two offset rounded squares, a filled `brand` square and an outlined
  `brand` square (debit/credit columns), next to "Omnivo" in 17px/600.
- **Print layout:** `PrintSheet` and `PrintBlock` from `@omnivo/ui`. A document page renders its sheet into
  `<body>`, hidden on screen; the browser's Print (`window.print()`) prints only the sheet, in the light palette
  whatever the theme, on A4 with 12mm margins. White paper, `ink` text, 1px rules (`ink` under the header and the
  table head, `line` between rows), no fills, no shadows, no radius. The header has the logo, the company (legal
  name, address lines, BIN, phone) on the left, the document's title (24px) and its details on the right. Lines
  are a real `<table>` whose `<thead>` repeats on every page; rows, blocks, totals and the signature lines use
  `break-inside-avoid`. Only a numbered document prints (a draft on paper looks real); a voided receipt, payment or refund does not.
- **Send menu (document output):** a secondary button "Send" (`Sent` icon, `ArrowDown01` on the right) next to
  Print on a quotation, purchase order, invoice, money receipt and credit note: Download PDF (the customer's language), Download
  PDF in the other language (named in its own script, "বাংলা"), Email, Share on WhatsApp. Without the send
  permission it is a single secondary "Download PDF" button (`Pdf01`). While the PDF is being made the button says
  "Making the PDF…"; after about 20 seconds it gives up with a message, never a spinner forever.
- **Email dialog:** the dialog with Language (a select), To and CC (one text box each, up to 5 addresses), Subject
  and Message (a text area). A line under the title says the PDF is attached and where replies go. "Send email"
  (`Mail01`) is the primary button. Changing the language writes the subject and the message again, and its hint
  says so.
- **Share dialog:** first the language and "Make link"; then the link in a read-only input (selected on focus,
  "shown once" as its hint), the WhatsApp message in a read-only text area, "Copy link" and "Copy message"
  (secondary `sm`, `Copy01`), and "Open WhatsApp" as a real link (`LinkSquare02`) in the footer. When the
  customer's phone is not a mobile number, a 13px `ink-3` line says WhatsApp will ask for the contact.
- **Document history cards:** "Emails" and "Share links" under the document, each a card with rows. An email:
  Sending (`brand`, `Clock01`), Sent (`good`, `CheckmarkCircle02`), Failed (`crit`, `Alert02`) with a `crit`
  hint, the addresses, CC, who and when. A link: Active (`good`, `Link01`), Ended (neutral, `Hourglass`), Turned
  off (neutral, `CancelCircle`), its language, who made it, until when, first and last opened; "Turn off"
  (secondary `sm`, `Unlink01`, asks first) on an active link for people with the send permission.
- **Public document page (`/d/<token>`):** no app shell and no login. The `bg` page with one centered card (at
  most 480px; padding 32px, 22px on phones): the company's logo and name, the document's name and number
  (`Geist Mono`, never broken), the customer or the supplier (`recipient`), then number, date, total (and for an invoice the due date and what
  is still due) in a two-column list, a full-width primary "Download PDF" (a `crit` line with `Alert02` instead
  when the PDF could not be made), and a 13px `ink-3` line that the link is private. A caption footer "Sent with
  Omnivo". It speaks the link's language and does not save it. An ended or unknown link shows the same "This link
  no longer works" state.

### Content and formatting

- **Money:** BDT with lakh/crore grouping via `Intl.NumberFormat('en-IN')`, prefixed
  `৳` (e.g. `৳18,42,600`). No decimals unless the value is a unit price. Chart axes
  may abbreviate as `৳18L`. In Bangla the grouping is the same with Bangla digits
  (`bn-BD`), and `৳` still comes first (`৳১৮,৪২,৬০০`). Money is a decimal string end
  to end, never a JavaScript `number`; round with `decimal.js`. Accounting documents
  (journal entries, ledgers, opening balances and the financial statements) show 2
  decimals, because their totals must visibly add up; dashboards and lists stay without
  decimals.
- **Money at the counter:** the POS screen shows whole taka unless an amount has paisa (`৳420`, `৳247.50`), so the
  lines add up on the screen; the receipt always shows 2 decimals.
- **Quantities:** decimal strings, never numbers, shown with the unit's decimals and code (`72 pcs`, `2.74 m`).
  Stock is always counted in the product's base unit.
- **Stock values:** to the paisa, like money; a unit cost keeps 4 decimals and is shown with 2. Lists and the
  stock card's KPIs show whole taka; documents, the stock card's history and the journal show paisa.
- **A customer's balance:** "Owes ৳1,15,000" when the customer owes the company, "৳20,000 in advance" when the
  company owes the customer (an advance or an overpayment), "Nothing owed" at zero. Shown only with
  `sales.customer.balance`; without it the balance column is left out. Offline the column shows a dash, and the
  list says "Balances need a connection".
- **Aging:** by the due date: Current (not due yet, or due that day), 1–30, 31–60, 61–90, Over 90 days. Money received
  and not applied is an advance, in its own column, never spread over the buckets.
- **VAT rates:** a rate is shown with its name and percent ("VAT 15% · 15%", "Exempt · 0%"). Zero-rated and
  exempt are different rates, even though both are 0%.
- **Dates:** `23 Sep 2026` in UI, `September 2026` for periods. In Bangla, `২৩ সেপ, ২০২৬`
  and `সেপ্টেম্বর ২০২৬`. The fiscal year defaults to July – June.
- **Language:** every user-facing string goes through `t()` from `@omnivo/i18n`, and
  money, numbers and dates through its `useLocale().format`. New keys go into `en.ts`
  first, then `bn.ts` (the type check fails if `bn.ts` is missing a key). The storefront's
  words (`shop.*`) live apart, in `packages/i18n/src/locales/shop/en.ts` and `bn.ts`, behind
  the `@omnivo/i18n/shop` entry that only `apps/shop` imports: the ERP app never loads them,
  and `t('shop.…')` does not type-check there. `errors.shop_*` stay in `en.ts` and `bn.ts`
  with the other error codes. Keep common
  office terms such as PO, LC, workspace and role in English inside Bangla text.
  Error messages are never written in code: the API and the Zod schemas send an
  error code (`slug_taken`, see `ERROR_CODES` in `@omnivo/contracts`), and the text
  lives in `errors.*` in `en.ts`/`bn.ts`. The dev-only kitchen sink stays English.
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
- **Class names:** merge them with `cn()` from `@omnivo/ui` (tailwind-merge extended
  with our type scale, radius and shadow names), never by string concatenation, so a
  caller's `className` reliably overrides a component's default.
- **Transitions:** 150ms for color, border and shadow only. No bounce and no scale.
  Respect `prefers-reduced-motion`.
- **Module switch motion:** the module menu's list enters with opacity 0 → 1 and a 4px upward slide over 160ms
  `ease-out`, keyed on the module id (`.module-menu-in` in `packages/ui/src/styles.css`). The rail item itself
  animates colors only. Nothing else in the app animates `transform`. Under `prefers-reduced-motion: reduce` the
  menu appears with no fade and no slide (the stylesheet's own base rule turns every animation off). No sliding
  active indicator, no bounce, no scale. A module switch never moves the content's edges: the rail and the menu
  keep their widths whatever is in them.
- **The router preloads on intent** (`defaultPreload: 'intent'`, `defaultPreloadDelay: 50` in
  `apps/app/src/router.tsx`). Every page is its own chunk (`lazyRouteComponent`), so pointing at a rail item or a
  nav link downloads that page while the pointer is on it and the click then paints at once. It is a download,
  not a render: a page must not do its work in a route loader.
- **Focus:** every interactive element shows a visible focus state, either the `brand`
  ring or a 2px `brand` outline with 2px offset.
- **The service worker keeps every built script, style and woff2 font** (`apps/app/sw/sw.ts`), so every screen loads
  offline in a production build, with nothing to list. A new kind of built file (an image a screen imports) needs
  its extension in `globPatterns` in `vite.config.ts`; `pnpm test:bundle-size` fails while a built file is missing
  from the worker's list. Mock mode has no worker of ours, so a screen that works offline also goes into
  `apps/app/src/mocks/offline-screens.ts`, or the mock e2e tests that go offline cannot load it.
- **The device's copy is sealed.** Every row in the device's database is `{ key, gen, box }` plus the ids an index
  needs, `box` sealed with AES-GCM by `LocalCopy` (`packages/sync/src/copy.ts`). A new table on the device goes
  through `sealed.ts`, and only ids, codes that are searched exactly (SKU, barcodes) and dates stay readable: never
  a name, a phone number, an amount or a command. Code that reads the copy takes the open `LocalCopy`, never the
  database.

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
  --font-sans: "Geist Variable", "Noto Sans Bengali", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, "SF Mono", Menlo, monospace;
  --radius-control: 10px; /* rounded-control */
  --radius-card: 14px; /* rounded-card */
  --radius-panel: 20px; /* rounded-panel — শুধু auth side panel; 8px-এর জন্য rounded-lg */
  /* shadow: :root-এ --elev-sm / --elev / --elev-lg / --focus-ring (light + dark) */
  --shadow-sm: var(--elev-sm);
  --shadow-md: var(--elev);
  --shadow-lg: var(--elev-lg);
  --shadow-ring: var(--focus-ring);
  --shadow-ring-crit: 0 0 0 4px var(--crit-bg);
}

/* টাইপ স্কেল — মান স্থির, তাই inline ছাড়া; text-body, text-label ইত্যাদি utility */
@theme {
  --text-display: 34px;
  --text-display--line-height: 1.15;
  --text-h1: 26px;
  --text-h1--line-height: 1.2;
  /* h2, kpi, h3, body, body-sm, label, caption, micro — Typography টেবিলের মান একই ভাবে */
}
```

Use the named utilities (`text-body`, `text-label`, `rounded-control`, `shadow-ring`)
instead of arbitrary values like `text-[14.5px]`. From step 4 on, the full stylesheet
lives in `packages/ui/src/styles.css` (before step 4 is implemented it is still
`apps/app/src/styles.css`). It does not import Tailwind itself: each app's own
stylesheet starts with `@import 'tailwindcss';` and then `@import '@omnivo/ui/styles.css';`,
and the ui stylesheet declares `@source './'` so Tailwind scans the ui components.
App-specific utilities (such as `auth-grid` for the login page) stay in the app's
stylesheet.

shadcn/ui's own variables (`--primary`, `--border`, `--ring`, `--muted` and so on)
must point at these tokens (`--primary: var(--brand)`, `--border: var(--line)`,
`--ring: var(--brand)`, `--muted: var(--subtle)`, `--muted-foreground: var(--ink-3)`)
so generated components match without per-component overrides.

## Storefront design system (approved 2026-11-07)

The tenant's public online shop (`apps/shop`, Astro + React islands) has its own look. It does **not** use the
App UI design system above: no `@omnivo/ui/styles.css`, no ERP tokens, no `AppShell`. Source of truth is the
Figma file [Omnivo](https://www.figma.com/design/DPfaCGUrx2XFf6eJaEYHb5/Omnivo), page `design`: `home_page`
(37:3083), `product_details` (37:3521), `checkout_process` (37:3765), `confirmation_status` (41:4066) at 1440px,
and `home_page_mobile` (138:234) at 393px. The frames on the `draft` page are older copies; the `Checkout` frame
(33:2748, "britflow") is a reference from another site, not our design. Every screen must match Figma: sizes,
spacing, radius, colors, icons and copy, at 1440px and (for what the mobile frame shows) at 393px. The only
intended differences are the ones written below: the font, the contrast fixes, the cart icon, the logo, the
menu button on the phone, the "All Categories" and "Offer" chips without a chevron, the payment section ("Pay
online" in place of Figma's "Mobile Banking"), the removed Reviews tab, no emoji, one badge style on every screen size, banners as images, and
the confirmation's SMS wording.

What still applies from the rest of this file: HugeIcons Stroke Rounded only, no `any`, every string through
`t()` (keys under `shop.*`, from `@omnivo/i18n/shop`), money as decimal strings (formatted in browser scripts with `@omnivo/i18n/format`: the
package's main entry starts i18next with every word, so a browser script never imports it), `cursor: pointer` on
everything clickable, a visible focus state, 150ms color-only transitions and `prefers-reduced-motion`. Light theme only for now
(`color-scheme: light`); Figma has no dark design. Pages are Astro with small scripts; the checkout form is the only
React island, and it gets its words from the server as props (no i18next in the browser). Every page and route reads
its data from `Astro.locals.source`, which `src/middleware.ts` sets for each request: the mock (the default,
`SHOP_SOURCE=mock`) or the ERP's `/public/v1` for the shop the host names (`SHOP_SOURCE=api` plus `SHOP_API_URL`).
Only the middleware imports `data/source.ts`. The API reads a shop only inside `ShopDb.read`, a read-only
transaction as the `omnivo_public` role, so a table or column the shop needs is granted to that role in a migration.
The order routes (place an order, the phone code, the payment's settle, wait, retry and pay on delivery,
`/order/<no>`, the tracking link, `/track`) are `auth: 'shop'`:
only the shop's server may call them, with `x-shop-key` (the shop's `SHOP_API_KEY`, required with `SHOP_SOURCE=api`,
equal to the API's `STOREFRONT_SHOP_KEY`) and the shopper's address in `x-shop-client-address`; every token goes in
a POST body, never in an address. The API writes them only inside `ShopDb.orders`, a transaction as `omnivo_shop`
(the public reads plus the order tables, nothing else). A text to the shopper goes through `SmsSender` on its own
`sms` queue, never through the outbox; in development and CI it is an email to `<phone>@sms.invalid` in Mailpit.
Astro's own `checkOrigin` is off: `src/middleware.ts` runs the same check first, with exactly two exceptions (the
gateway's return and notice paths), and refuses `same-site` too, because another tenant's shop is the same site.
Online payment goes through `apps/api/src/payments/` (`SslcommerzGateway`, `FakeGateway`): `PAYMENT_GATEWAY` is
`fake` outside production and `sslcommerz` in it (fake is refused in production), and the API never believes the
browser's post: it asks the gateway (by `val_id`, else by `tran_id`) and checks status, amount, currency and try
with the try's row locked. The tenant's store password is sealed with AES-256-GCM under `CREDENTIALS_KEY` (32 random
bytes, base64, the same on `api` and `worker`, with a key version) in `storefront_payment_gateways`, which only
`omnivo_app` reads, never the shop's roles; without the key the card answers `storefront_gateway_key_missing`. A
paid try gets a posted money receipt (an advance) from the worker, with the fee (`amount − store_amount`) on its own
line to the fee account, and the invoice takes it at Delivered.
Couriers go through `apps/api/src/shipping/` (`CourierAdapter`: `SteadfastAdapter`, `FakeCourier`; a manual account
has no adapter): `COURIER_MODE` is `fake` outside production and `live` in it (fake is refused in production). A
courier account's keys are sealed under the same `CREDENTIALS_KEY` in `courier_accounts`, which only `omnivo_app`
reads. Packed (or Book courier) writes the parcel row and an outbox event in the order's transaction; the worker
books it on its own `couriers` queue, never inside a request, with the order number as the courier's `invoice`
(`W-000123`, `W-000123-2` for a second parcel) and `UNIQUE` on it, and after a lost answer it asks the courier by
that invoice before trying again. Five tries, then the parcel is `booking_failed`, the order needs attention and
the bell rings (`storefront.shipment_failed`); it never fails quietly. The courier's news come by a webhook per
account (`POST /public/v1/couriers/steadfast/<account id>`, checked against the account's bearer token, of which only
the hash is kept; any wrong token is 401, an unknown parcel 200, and a body is never refused for its shape) and by a
15-minute poll of the parcels on their way. Every step goes into the append-only `storefront_shipment_events` once
(`event_key`). Picked up moves the order to Shipped (and texts the shopper), delivered to Delivered (the invoice). The
real Steadfast API has not been run yet: book one parcel with a real account before the first live shop.
The rider's cash (step 28b) goes into the courier account's COD account (an account that holds money, "Cash with
Steadfast"; empty = typed by hand, as before). At Delivered, from the courier's news or from "Mark delivered", the
invoice is posted and then a posted money receipt (method `courier`, in `RECEIPT_METHODS` only, never offered by the
receipt form or a refund) for what the rider collected, applied to the invoice: Dr COD account / Cr receivable. The
receipt belongs to the parcel (`storefront_shipments.receipt_id`). What was collected comes from Steadfast's
`cod_amount` on a delivered or partly delivered notice, cut to the parcel's `codAmount` (the raw notice keeps the
courier's figure); `delivery_charge` is kept as the courier's charge, for the payout. ৳0 collected makes no receipt.
The receipt is made in a savepoint, so a refusal never loses the courier's news: the parcel keeps the error, the
order needs attention, the bell rings once per parcel (`storefront.cod_receipt_failed`), and "Make the receipt" tries
again. A trigger (`storefront_shipments_cod_guard`) keeps the link fixed once made and checks that the receipt is
posted, `courier`, for the collected amount and into that COD account. A partly delivered or returned parcel never
moves stock by itself: a member records what came back (a sales return before the invoice of the rest) or receives
the return (a sales return of the whole challan, the sales order cancelled, Returned, an SMS). A voided COD receipt
stays linked and drops out of Holds.
The courier's payout (step 28c) takes that money to the bank: a posted document `storefront_payouts` (`CPO-…`,
journal source `storefront_payout`, `storefront.payout.manage`: the Owner, and the Accountant, Shop manager and
Manager templates) with one line per parcel,
Dr bank (net) + Dr courier charges / Cr COD account. A COD line is a parcel with a posted COD receipt into the
account's current COD account (collected = the receipt's amount, fixed); a charge line is a parcel that brought no
cash but has a charge (returned, cancelled, paid online). The charge starts at the courier's `courier_charge` and the
member may change it; a net below zero is refused, a net of zero has no bank line, and the charges have no input VAT.
Saving posts it; there is no draft. The parcel keeps the payout (`storefront_shipments.payout_id`, set at post,
cleared at void, rows locked `FOR UPDATE`, guarded by triggers, and a deferred check makes the sums add up at
COMMIT). The date is never before the newest COD receipt of its lines. Voiding is the money receipt's void (date and
reason) and frees the parcels; the journal's Reverse refuses its entry (`journal_is_payout`), and a COD receipt a
posted payout took can't be voided (`receipt_paid_out`). The courier's payout CSV is never uploaded: the browser
POSTs its text to a match route (at most 1 MB and 5,000 rows), parsed by the shared `apps/api/src/common/csv/csv.ts`,
with a column map saved on the courier account (`payout_csv_map`). The Steadfast preset is a guess: no real payout
file was seen, and Steadfast's payments API waits for a real account.
A shop photo comes from the ERP's Storefront menu as a `storefront_image` upload; the worker's `sharp` job writes
`storefront/<id>/small.webp`, `large.webp` and `wide.webp`, and only that `storefront/` folder of the storage is
public. The original stays private, and the shop never links to it.

### Storefront color tokens

CSS variables in `apps/shop/src/styles/shop.css`, mapped with `@theme inline` like the app's tokens. Use only
the tokens, never raw hex.

| Token | Value | Figma name | Use |
|---|---|---|---|
| `canvas` | `#F6F7F7` | Off White | Page background, section header background, description sections (with `cream`), checkout line image box, promo box |
| `card` | `#FFFFFF` | White | Product cards, inputs, footer, gallery card and thumbnails, the cart drawer |
| `card-glass` | `rgb(255 255 255 / .7)` | — | Product info card, description card and checkout card (on `canvas`) |
| `cream` | `#F4F5EC` | Ivory | Radio cards, tab bar, checkout card header, secondary button, stepper buttons, alternate description sections, social circles |
| `brand` | `#005859` | Dark Teal | Header, titles, product names, labels, selected chip, active tab, `NEW` badge, apply-coupon button |
| `accent` | `#B8EF69` | Lime Green | Add to cart, Place Order, Confirm Order, search button, text on `brand` fills |
| `price` | `#A70B1E` | Crimson | Prices, totals, the discount ribbon, "Hotline:" |
| `promo` | `#CC3F29` | Coral, darkened | "Most Picked" / "Buy 1 Get 1" badges, sale countdown text, delete icon |
| `promo-soft` | `rgb(255 108 85 / .1)` | Coral 10% | Delete button background |
| `muted` | `#707070` | Gray, darkened | Placeholders, pack size ("500ml"), struck-out price, "Per Piece", footer address, separators |
| `muted-line` | `#949494` | Gray | Size chip border only (non-text, 3:1 on white) |
| `body` | `#52524F` | — | Description text, terms line |
| `rule` | `#DEE1E1` | — | Section header bottom rule, dividers in the info card and checkout |
| `field` | `#E9E9E9` | — | Input border at rest (as in Figma) |
| `on-brand-line` | `rgb(255 255 255 / .15)` | — | Header button borders |
| `overlay` | `rgb(0 25 25 / .6)` | `#001919` at 60% | Dim behind the order dialog, the cart drawer and the category drawer only |
| `hero-scrim` | `linear-gradient(to bottom, rgb(0 0 0 / 0), rgb(0 0 0 / .8))` | — | Over the photo of the phone hero, so its white text reads |

- **Contrast fixes (approved):** Figma's Gray `#949494` is 3.0:1 on white, so text uses `muted` `#707070`
  (4.95:1 on `card`, 4.61:1 on `canvas`, 4.51:1 on `cream`). White 10px text on Coral `#FF6C55` is 2.8:1, so
  `promo` is `#CC3F29` (4.87:1). Every other Figma pair passes AA (`brand` on `accent` 6.1:1, `price` on white
  7.8:1, `brand` on `cream` 7.5:1, `body` on `cream` 7.1:1).
- **Tenant theme:** only `brand` and `accent` come from the tenant's `storefront_settings` (`brand_color`, `accent_color`, `#rrggbb`); all other
  tokens are fixed. The pair must keep at least 4.5:1 between them (accent text on brand and brand text on
  accent), and `brand` at least 4.5:1 on `cream` (names and titles sit on the light fills), checked by one
  `contrastRatio()` in `@omnivo/contracts`, in the form as the tenant types and again by the API on save. The
  defaults are the Figma values. The logo (`logo_image_id`) is a `storefront_image` like a listing's photo.
- Hero and promo banner colors (`#EEE0D8`, `#E7D1B2`, `#8B471F` in the Figma hero) are part of each banner's
  data, not tokens. The hero's button and its words keep 4.5:1, and the white headline keeps 3:1 on the panel
  (large text), checked the same way.
- **What the tenant sets (ERP → Shop appearance, Shop pages):** the logo and the two colors, one hero banner, up to 6
  picture banners and 8 collections (24 listings each) as up to 12 blocks under the product grid in their order,
  and the four text pages. Everything else on the shop is fixed. A link on a banner is an address (`/c/skin-care`,
  `/p/…`, `/c/all?offer=1`, or `https://…`); a slug changed later makes it "page not found".

### Storefront typography

- **Family:** the app's stack (`"Geist Variable", "Noto Sans Bengali", "Segoe UI", system-ui, sans-serif`),
  self-hosted, in place of Figma's Roboto and Helvetica. Sizes, weights and line heights stay as in Figma. Every
  text uses `letter-spacing: -0.02em` (Figma's tracking). Prices, quantities and the countdown use
  `tabular-nums`. Order numbers use `Geist Mono` (self-hosted, `--font-mono`), as in the app.
- Scale (desktop; the phone values from `home_page_mobile` in brackets):

| Token | Size / line-height | Weight | Where |
|---|---|---|---|
| `sf-display` | 36px / 1.2 (20px / 1.2, 700) | 600 | Section titles ("All Category"), desktop hero headline |
| `sf-price-lg` | 32px / 1 (28px) | 600 | Product page price |
| `sf-title` | 24px / 30px (20px / 26px) | 600 | Product page name, checkout card title, dialog title, header wordmark (phone: 20px/700), card price (line-height 20px; phone: 18px/700) |
| `sf-subtitle` | 20px / 26px | 600 | Description section headings (30px line-height), checkout line name and line total; "Total" row at 700 |
| `sf-body` | 16px / 20px | 400–600 | Card names (600), buttons (600), labels (600), chips (400; selected 500), placeholders (500) |
| `sf-small` | 14px / 24px | 400–600 | Description text, stock and SKU lines (500), phone chips (400), "View All" (600), phone pack size (400) |
| `sf-meta` | 12px / 20px | 600 | Pack size under the card name, cart count badge, phone copyright (400) |
| `sf-tag` | 10px / 11px | 700 | Badges and the discount ribbon |

Footer wordmark is 32px/600 (phone 24px/700). The terms line is 18px/400 `body`. Confirm Order is 18px/600. The
phone hero headline is 28px/700 and its line under it 14px/400.

### Storefront shape and layout

- **Radius:** 16px for header, hero, banners, footer, gallery card, info card, checkout card and the tabbed
  description card. 12px for header buttons and the checkout card header (top corners). 8px for product cards,
  chips, inputs, radio cards, tab bar, description sections, thumbnails, Load More. 5px for stepper and delete
  buttons. 4px for the add, place-order and confirm buttons and tabs. 999px for the search bar, badges, size chip,
  promo box, apply button, arrows, social circles.
- **Container:** content is 1280px wide, centered (80px each side at 1440px). Gutters are 32px from `md` and
  16px on phones; the page never scrolls sideways. No shadows anywhere (Figma has none).
- **Vertical rhythm (home):** header 20px from the top; 16px from header to hero; 64px from hero to the first
  section; 48px between sections and banners; 36px from a section title row to its content.
- **Breakpoints:** Tailwind defaults. Below `md` (768px) the phone layout of `home_page_mobile` applies: 16px
  gutters, 16px from the top to the header and from the header to the hero, 16px between blocks, one product
  card per row. From `xl` (1280px) the desktop frames apply as drawn. Between them the desktop layout is fluid:
  grids show 3 cards at `md` and 4 at `lg`, and every two-column layout (product top, checkout fields and radio
  cards) stays two columns from `md` and becomes one below it.

### Storefront components

- **Header:** a 72px `brand` bar, radius 16. Left: `Menu01` (30px, white; opens the category drawer), then the
  logo. Center: the search bar, 420×40 `card` pill, placeholder "Search for Cosmetics, Food" 16px/500 `muted`
  at 20px from the left, and a 47×36 `accent` submit inside its right end (right corners round) with a 20px
  `brand` `Search01`. Right, 8px apart: the cart button and the account button, both 42px high, radius 12, 1px
  `on-brand-line` border, 8px padding, 24px white icons. The cart button uses `ShoppingCart01` (it replaces
  Figma's bell); its count badge sits over the top-left corner (10px left, 8px up): `brand` fill, 1px `accent`
  border, 4px padding, radius 999, 12px/600 white, "99+" above 99, hidden from screen readers (the button's
  label says "Cart, 3 items"). The account button has `User02` and the name in 16px/600 white (padding 8px 10px
  8px 8px, gap 4px); without a name it says "Account". Both account buttons open `/track` until the shop
  has a customer sign-in. Below `md` (Figma `mobile-header`): a 64px `brand` bar,
  radius 16, padding 12px. Left a 40px `card` menu button (radius 12, 20px `brand` `Menu01`; not in Figma, it
  reaches the category drawer from every page), 8px later the logo (24px mark, wordmark 20px/700 white, 8px apart;
  a long shop name ends in "…"); right
  three 40px `card` buttons 8px apart, radius 12, with 20px `brand` icons: search (`Search01`, opens a search box
  that covers the bar), cart (`ShoppingCart01`, with the same count badge) and account (`User02`).
- **Logo:** the Omnivo mark (two offset rounded squares, see the app's Logo) in place of Figma's bag icon. In the
  header: 36px mark in `accent` on `brand` plus the wordmark 24px/600 white, 4px apart. In the footer: 48px mark
  in `brand` plus the wordmark 32px/600 `brand`, 5px apart (phone: 24px mark, 24px/700, 8px apart). When the
  tenant uploads a logo, it replaces the mark and the wordmark shows the shop's name.
- **Hero banner:** 280px high, radius 16, clipped. A slanted left panel (Figma's 600×280 shape, in the banner's
  panel color) holds the headline (`sf-display`, white, max 303px wide, 102px from the left, centered
  vertically) and a pill button 36px below it (padding 16px 24px, 16px/600, the banner's chip colors). The
  product image fills the right side. Below `md` (Figma `hero`): 220px high, radius 16, the banner's phone photo
  `object-cover` under `hero-scrim`, 20px padding; at the top an `accent` pill (padding 6px 12px, 12px/700
  `brand`, uppercase, "EXCLUSIVE OFFER"), at the bottom the headline (28px/700 white) and 8px below it one line
  (14px/400 white at 80%). No button on the phone: the whole banner is the link. A banner's data therefore has
  a desktop image, a phone photo, a headline, an optional line, an optional eyebrow, a button label and its
  colors.
- **Image banner ("Mega Sale"):** one image, `object-cover`, radius 16: 280px high at desktop, 140px below `md`
  (the banner's phone image). Its words are part of the image: Figma's phone frame writes "MEGA SALE" in
  Pacifico on a 60% black layer, which is not done (no other font families, and the tenant's own banner has its
  own words).
- **Filter row:** chips 38px high, padding 12px, radius 8, 16px apart, each with a 14px icon 8px after the label
  (`ArrowDown01`, or `FilterHorizontal` for "All Filter"). Selected: `brand` fill, `accent` 16px/500 text and
  icon. Others: `card` fill, `brand` 16px/400; hover `cream`. "Sort By" sits at the far right: 1px `brand`
  border, `brand` 16px/500, `FilterHorizontal`. The first chip, "All Categories", is a link to `/c/all` with no
  chevron (Figma draws one). Then the shop's top categories: one with sub-categories has a chevron and opens a menu
  ("All of Cosmetics", then its sub-categories, 16px more indent per level); one without is a link with no chevron.
  "Offer" (listings on sale) is a switch with no chevron (Figma draws one). "All Filter" opens a 320px panel (20px
  padding): "Price (৳)" with From and To side by side (48px inputs, whole taka), "In stock only", then Clear
  (`cream`) and Apply (`accent`), 44px, radius 4. "Sort By" opens a menu: Newest (the default), Price: low to high,
  Price: high to low, Name: A to Z. A chip whose filter is on is filled like the selected chip, and its name says
  "on" to a screen reader. The menus and the panel are native popovers under their chip (CSS anchor positioning;
  without it the browser centers them): `card`, 1px `rule`, radius 8, 8px padding, no shadow; a line is 16px
  `brand`, radius 4, hover `cream`, and the current one is 600 with a 16px `Tick02`. Every choice is in the address
  (`?sort=price_asc&min=100&max=500&stock=1&offer=1`), so a link keeps it; Figma's "Review" chip is
  removed with the reviews. Below `md` (Figma `categories`): the title "All Categories" (20px/700 `brand`), 12px
  down the categories as pills that wrap, 8px apart: padding 10px 16px, radius 999, 14px; selected `brand` fill
  with `accent` 600 text (Figma draws white; `accent` keeps it the same as desktop), others `card` with a 1px
  `rule` border and `brand` 400 text. No "All Filter" or "Sort By" on the phone.
- **Phone "Featured Products":** below `md` the "All Category" grid becomes this block (Figma
  `featured-products`): a row with "Featured Products" (20px/700 `brand`) and "View All" (14px/600 `brand`, a
  link to `/c/all`), then 16px down the grid's first two cards, stacked 16px apart.
- **Section header:** 86px high on `canvas` with a 1px `rule` bottom border. The title (`sf-display`, `brand`)
  on the left; on the right two 40px round `card` arrow buttons 16px apart (`ArrowLeft01` / `ArrowRight01`,
  24px `brand`, 8px padding). Hover fills `accent`; the disabled one is at 60% opacity. "Hot & Trending Right
  Now" gets a 32px `promo` `Fire` icon 8px after the title instead of the emoji (20px on the phone). Below `md`
  (Figma `section-header`): a 40px row with no background and no rule, the title 20px/700, the arrows 8px apart,
  and the cards 16px below it.
- **Product card:** 243×458 at desktop, `card`, radius 8, clipped, everything centered. Discount ribbon: a
  30×40 `price` tag with a zigzag bottom (Figma's "Rectangle 3" vector, downloaded as SVG) at 16px from the left,
  top 0, with "৳10" / "OFF" (or "10%" / "OFF") in `sf-tag` white on two lines. Badges at the top right (10px
  in, 7px padding, radius 999, `sf-tag`): `promo` fill with white text ("Most Picked", "Buy 1 Get 1"); a `NEW`
  badge at the top left is `brand` with `accent` text. Image slot 223×200 at 10px in and 54px down, `card`
  background, the photo `object-contain` with `mix-blend-mode: multiply`. Info at 270px down, 223px wide: name
  16px/20px 600 `brand`, two lines then clamped with an ellipsis; 16px below it the pack size (`sf-meta`,
  `muted`); 23px below that the price 24px/600 `price`. The add button is 195×44, centered, 24px from the
  card's bottom (390px from its top): `accent` fill, radius 4, padding 10px 16px 10px 10px, `Add01` 24px plus "Add to cart"
  16px/600 `brand`, 4px apart; hover inverts (`brand` fill, `accent` text and icon). Out of stock: the button is
  disabled, `canvas` fill, `muted` "Out of Stock", no icon. Between `md` and `xl` the card is fluid (height from
  content, image slot keeps 223:200, button full width minus 24px each side). Below `md` (Figma `product-card`):
  full width, radius 12, padding 12px, 12px between its parts, left-aligned. The image box is 160px high, radius
  8, `canvas`, the photo `object-contain` (Figma shows lifestyle photos with `object-cover`; a listing has
  packshots, which a crop would cut); the ribbon sits at its top left (8px in) and the badge at its top right
  (8px in), in the same pill style as desktop (Figma's phone badge is a radius-4 uppercase tag; one style is
  kept). Info, 4px apart: name 16px/600 `brand` (two lines, then an ellipsis), pack size 14px/400 `muted`,
  price 18px/700 `price`. The add button is full width, 44px.
- **Product rows (Refresh with Himalaya, Hot & Trending, Diabetic Corner, Related Products):** one row of
  cards that scrolls sideways with snap; the arrows move it by a page. On the phone it shows one card at a time
  (full width); the arrows and a swipe move it by one card.
- **Load More:** under the last list of a page. `card`, 38px high, padding 12px 16px, radius 8, "Load More"
  16px/500 `brand`. While loading: "Loading" plus a 24px `Loading03` icon that spins (static under reduced
  motion), 10px apart, and the button is disabled. 20 cards a page. Without JavaScript it is a link to the next
  page (`?cursor=…`). With it, a script fetches the next cards from the list's partial (`/c/<slug>/more`,
  `/search/more`) and adds them under the others; the focus stays on the button and a live region says "20 more
  products". On the last page the button goes and the focus moves to the first new card.
- **Footer:** `card`, radius 16, clipped, 64px top padding, content 440px wide and centered with 48px between the
  logo and the rest. Social links: 40px circles, `cream` fill, 15px `brand` icons (`Facebook01`, `Instagram`,
  `NewTwitter`, `Linkedin01`), 14.6px apart; hover fills `accent`. 24px below: the address, 16px/24px `muted`,
  centered. 24px below: the links (Privacy Policy, Terms & Condition, About Us, Contact Us; only the pages the
  tenant has written, from the shop's `pages`, so no link leads to "page not found") 16px/24px `brand`, separated
  by `muted` " | ". Two soft `accent` blobs sit at the bottom left and right (Figma's Vector 2 and
  Vector 3, downloaded as SVG, decorative, `aria-hidden`). Under the footer, 35px down: "©2026 All rights
  reserved by Omnivo" 16px/24px `brand`, centered, then 34px to the page end. Below `md` (Figma `footer`): `card`
  with only the top corners round (24px), 32px top and bottom padding, 24px between its parts, everything
  centered (Figma puts the logo at the left; centered matches the rest): the logo, the address 14px `muted`,
  the social circles 16px apart with 18px icons, the links 14px `brand`, and the copyright inside the footer
  at 12px `muted`. No blobs on the phone. It ends 24px above the page's bottom.
- **Product page, top:** two cards 16px apart. Gallery (524×440, `card`, radius 16): the ribbon and badge as on
  the product card, the photo centered and `object-contain`. Under it, 16px down, four 119×92 thumbnails, 16px
  apart, radius 16, with a 2px `card` border and no selected look (as in Figma; `aria-pressed` marks the one shown). Product
  names (this title and the card's) use `text-wrap: wrap`, not the headings' balance, so they break where Figma does. Info card (740×548, `card-glass`, radius
  16, padding 32px 36px): the countdown row (`Clock01` 20px plus "01 : 12 : 10 : 32" 16px/600, both `promo`,
  12px apart; only when the listing has a `sale_until`), 24px down the name (`sf-title`, `brand`), 24px down the
  size chip (`card`, 1px `muted-line` border, radius 999, padding 8px 12px, 16px/600 `brand`), 36px down the
  price (`sf-price-lg` `price`) with the old price 8px after it (16px/600 `muted`, struck through, bottom
  aligned), 16px down "Per Piece" (16px/400 `muted`), 32px down two 195×44 buttons 16px apart: Place Order
  (`accent`, `ShoppingBag01`, 8px gap; puts the product in the cart once, never a second time, and opens checkout) and Add to cart (`cream`, `Add01`, 4px gap),
  both 16px/600 `brand`, radius 4. Then 36px down: "Available in stock" (`CheckmarkBadge01`) and 20px below "SKU:
  MD2346" (`ShoppingBag01`), 16px icons, 14px/500 `brand`, 8px gap; out of stock shows an `Alert02` with
  "Out of stock" in `promo`. A 1px `rule` line 36px below, then 26px down "Hotline:" (`price`) and the number
  (`brand`) at 16px/600 after a 24px `price` `Call02` icon, 12px apart. Below `lg` the two cards stack, the gallery stays
  at most 524px wide and centered, and the buttons share the width. The page's `<title>` and
  `<meta name="description">` are the product's `seo`, which the API fills: the tenant's SEO words, or the name and
  the start of the description.
- **Product page, description:** a `card-glass` card (radius 16, 8px padding) with the tab bar (`cream`, radius
  8, 8px padding) holding one 160×48 "Overview" label in the tab's look (`brand` fill, `accent` 16px/600, radius 4).
  It is a label, not a `tablist`: Reviews is removed (there are no reviews in the data model), and a list of one
  tab would tell a screen reader there is a choice. Then the description sections 8px apart, each radius 8,
  padding 36px (20px on phones), alternating `canvas` and `cream` starting with `canvas`: heading `sf-subtitle`
  (30px line-height) `brand`, 24px down the text 14px/24px `body`, lists with discs (numbers for an `<ol>`)
  indented 21px, label words at 600. The sections come from the listing's `description_html`, styled by one prose
  class (`shop-prose`), never per-section markup. No description: no card.
- **Checkout card:** max 848px, centered, 36px below the header (128px from the page top), `card-glass`, radius
  16, 4px inset. Header: `cream`, top radius 12, padding 24px, "Shipping & Contact Details" `sf-title` `brand`
  centered. Body: 36px from the card's edge (36px under the header, and 32px inside the 4px inset at the sides and
  the bottom), 32px between blocks, except 36px before the lines and 48px around the promo box and the payment
  cards. Every gap is measured between trimmed text boxes (`trim-text`). The card ends 160px above the footer. Field: label 16px/600 `brand`, 12px gap, input 48px high,
  `card`, 1px `field` border, radius 8; focus uses a `brand` border plus a 2px `brand` outline. Full Name and
  Mobile Number side by side (16px apart), Delivery Address full width. Radio card: `cream`, radius 8, padding
  20px 30px, a 24px radio (`brand` ring, `brand` dot when checked) plus 16px/600 `brand`, 4px apart; the whole
  card is the label. Groups: "Delivery Location" (Inside Dhaka — ৳80, Outside Dhaka — ৳120; the zones come
  from the shop's settings; no location is picked at first: until one is, the Delivery Charge row says "Pick a
  location" in `muted`) and "Payment Method" (Cash on Delivery, Pay online; Figma says "Mobile Banking", but
  SSLCommerz's page takes cards and internet banking too), each two cards side by side, 16px apart. While Pay online
  is picked, a 14px `muted` line under the cards says the shopper pays on SSLCommerz's page. Free delivery is not a choice: when the order reaches the shop's threshold, the Delivery
  Charge row says "Free", and a 14px `muted` line under Delivery Location says "Free delivery on orders over
  ৳1,000". The form is `inert` until its island has run, so nothing a shopper types before then is lost. Pay online
  is offered only while the shop ticks it and its Online payment card is ready (`storefront_online_ready()`); an
  online order gets no phone code: Confirm Order says "Opening the payment page…" and the browser goes to the
  gateway's page (or to `/checkout/paid` when no page opened; the order and its stock stay). Too many orders (5 per phone or 20 per connection in an hour) is the form's error with
  the minutes to wait, in the shop's digits.
- **Checkout lines:** per line, a 155×130 `canvas` image box (radius 8), 20px gap, then the name (`sf-subtitle`,
  `brand`, max 288px) and 20px below it the stepper (the name and the stepper centered beside the image): minus and plus 40px `cream` buttons (radius 5,
  `MinusSign` / `Add01` 14px `brand`), a 60×40 quantity box between them (`card`, 1.5px `cream` border, radius 5,
  20px), 6px apart, then 16px later the delete button (40px, `promo-soft`, radius 5, `Delete02` 24px `promo`).
  The line total is at the right, `sf-subtitle` `price`. Quantity never goes below 1; delete removes the line.
  1px `rule` lines above and below the Delivery Charge row (16px/600 `brand`, amount right), the first 30px under
  the lines. While a coupon is applied, a Discount row ("Discount (WELCOME10)", the amount after a minus sign) sits
  above it inside the same rules, 24px apart. "Total" row 20px/700:
  label `brand`, amount `price`. Promo box: 60px `canvas` pill, "Add Promo" placeholder 16px/600 `muted` at
  36px in, and an "Apply Coupon" button inside it (156×52, 4px inset, `brand`, `accent` 16px/600, radius 999).
  Under it, an applied code is a 14px/500 line with `CheckmarkCircle02` ("WELCOME10 applied: 10% off, up to ৳200",
  the cap only when the coupon has one) and a "Remove the code" link; a refused one is the field's error line with
  the reason (does not exist, ended, used up, under its minimum). The coupon comes off the items only, never
  delivery. "Once per mobile number" is known only when the order is placed, so it is the form's error then.
  Terms: a 20px checkbox (`CheckmarkSquare02` `brand` when checked) and "I agree with the Terms and Conditions"
  18px `body`, the link underlined (it opens in a new tab), 12px apart. Confirm Order: full width, 64px, `accent`,
  radius 4, 18px/600 `brand`; disabled until the terms are ticked, while newer prices load, with an out-of-stock
  line, and under the shop's minimum order (a `promo` line under Total says how much more to add). Below `md` the card fills the width, its body padding is 20px,
  and every two-card row is one column.
- **Order confirmed dialog (Figma `confirmation_status`):** after the order is placed (after the phone code for
  Cash on Delivery, on `/checkout/paid` once the online payment arrived), over the checkout page with `overlay` behind it. 440px wide (the screen minus 32px on a
  phone), `card`, radius 16, padding 64px 48px 48px, centered content. A 24px close icon button (`Cancel01`,
  `muted`) 16px from the top right. The illustration: Figma's two-tone `tick-double-03` (`accent` and `brand`),
  100px, as an SVG file from Figma (a two-tone drawing is not a Stroke Rounded icon). 48px down "Order
  Confirmed" (`sf-title`, `brand`), 24px down the line (16px/24px `muted`, max 307px): "We have received your
  order. We'll send updates by SMS to **01786 120356**.", the number at 500 in `body` (Figma says a confirmation
  email; the shop takes a phone, not an email). 64px down two 44px buttons 12px apart, full width (344px),
  radius 4, 16px/500 `brand`: "View Order Details" (`cream`, opens `/order/[no]`) and "Continue shopping"
  (`accent`, goes home, has the focus). Closing it any way is "Continue shopping": the cart is already empty.

### Storefront screens not in Figma

These follow the same tokens and components. Use them exactly as written here until Figma has them.

- **Category and search (`/c/[slug]`, `/search`):** the home page's "All Category" block alone, 36px under the
  header (16px on a phone): the title as the page's `h1` in the section title's style (the category's name, "All
  Products" on `/c/all`, or `Results for "neem"`), 36px down the filter row, 36px down the grid (3, 4 and 5
  columns; one card a row on a phone), Load More. A category shows the listings of its sub-categories too. Search
  looks in the name, the SKU and the category names, in English or Bangla, in any case; an empty search goes to
  `/c/all`. An empty list shows the empty state for its reason: a filter is on (`FilterRemove`, "Clear the
  filters"), a search found nothing (`Search01`, "See all products"), or the category has nothing yet
  (`ShoppingBasket01`).
- **Empty state:** a `card` (radius 16, padding 48px) with a 64px round `cream` tile holding a 28px `brand`
  icon, a `sf-title` `brand` title, a 16px `muted` line that says what to do, and an optional `accent` button
  (44px, radius 4). Used for empty cart (`ShoppingCart01`), no results (`Search01`), no listing for the filters
  (`FilterRemove`), an empty category (`ShoppingBasket01`), page not found (`FileNotFound`, "Go to the home page")
  and a tracking link that does not work (`Unlink04`, "Track with the number"). There is no closed shop: a shop is
  always open.
- **Cart drawer:** opens from the cart button, from the right, 420px wide (full width on phones), `card`, with
  `overlay` behind it and no blur. A native `<dialog>` (`showModal()`), so the focus stays inside, Escape and a
  click on the backdrop close it, and the focus goes back to the cart button. It does not slide in. The header:
  "Your Cart" `sf-title` `brand` and a close icon button, a 1px `rule` line under it. The lines are the checkout's
  at drawer size, 1px `rule` lines between them: the image box 96×80 (`canvas`, radius 8), 16px gap, the name
  16px/600 `brand` (two lines, then an ellipsis) with the line total 16px/600 `price` to its right, the pack size
  (`sf-meta` `muted`), then the checkout's stepper and delete button (same sizes and gaps). An out-of-stock line
  says "Out of stock: not in the subtotal" in `promo` with `Alert02` and keeps only its delete button. Padding
  24px (20px on phones). At the bottom, above a 1px `rule` line: "Subtotal" and the amount (`sf-subtitle`
  `price`), and "Checkout" (full width, 52px, `accent`, radius 4, 16px/600 `brand`; greyed and not a link when
  every line is out of stock). The prices come from the server's quote, asked each time the drawer opens and 250ms
  after the last change; until the answer, the amounts are `muted`. A quantity changes at once. A failed quote
  shows no prices: a `promo-soft` tile, "The prices did not load…" and "Try again" (`cream`). Empty: the empty
  state (`ShoppingCart01`, "Continue shopping" closes the drawer).
- **Category drawer:** opens from the header's menu button, from the left, 420px wide (full width on phones),
  `card`, with `overlay` behind it and no blur. A native `<dialog>` like the cart drawer: the focus stays inside,
  Escape and a click on the backdrop close it, the focus goes back to the menu button, and it closes when the page
  is left. The header: "Categories" `sf-title` `brand` and a close icon button, a 1px `rule` line under it. Then
  "All Products" and the top categories as rows at least 48px high (16px/600 `brand`, radius 8, hover `cream`, 1px
  `rule` lines between the top rows); a category with sub-categories has a 48px show/hide button (`ArrowRight01`
  shut, `ArrowDown01` open, `aria-expanded`), and its list is indented 16px. The name is a link, the button only
  shows and hides. The list on screen is marked (`cream` row, `Tick02`, `aria-current`), and its group starts open.
- **Phone verification (`/checkout/verify`):** the checkout card at 560px: header "Verify Your Phone", a 16px
  `body` line "We sent a 6-digit code to +880 17•• ••• 356", one 48px input (`tabular-nums`, centered, Bangla
  digits become ASCII), "Confirm Order" (the checkout's button), and "Resend code" as a `brand` text link (with
  "in 0:45" while it waits). A wrong code shows an `Alert02` line in `promo` under the input, with the tries left.
  After 5 wrong codes the order is dropped: the box goes and "Back to checkout" takes its place (the cart is kept).
  A code works 10 minutes and an order gets 3 codes. An expired code costs no try: the box is cleared and the line
  says to ask for a new code. After the third code "Resend code" goes, but the box and Confirm Order stay (the last
  code may still come or still work), with the error line and "Back to checkout" under them. An order that never
  gets its code is deleted after 60 minutes, with the stock it held. The page finds its order by an httpOnly cookie,
  never by the number, and with no order waiting it goes to `/checkout`. The mock shows its test code in a line under
  the sentence; on the API the code comes only by SMS.
- **Back from the payment (`/checkout/paid`):** SSLCommerz posts the shopper back to `/checkout/pay/return` (and calls
  `/api/payments/notice` on its own); the shop reads only `tran_id` and `val_id`, asks the API to settle the try, and
  always answers 303 to this GET page, where the `SameSite=Lax` checkout cookie works. It finds the order by that
  cookie (none: `/checkout`; an order that waits for its code: `/checkout/verify`). The checkout card at 560px, the
  title in its `cream` header, by state. Paid: the confirmed dialog's sentence, "View Order Details" (`cream`), the
  dialog over it, the order moved into this browser's orders cookie and the checkout cookie gone. Checking: "Checking
  your payment" (`role="status"`), a "Check again" link, and the page looks again after 4 seconds with
  `location.replace()`. Unpaid: the title and line of why ("The payment did not go through", "…was cancelled", "…did
  not open", "…is not finished"), "Your order for ৳578 is still here…", the tries left ("You can try 2 more
  times.", a try is three at most), an `Alert02` `promo` error line in a `role="alert"` block, then "Try again"
  (primary, the Confirm Order look, while tries are left) and "Pay on delivery instead" (`cream`, or primary with no
  tries left; it makes the order cash on delivery and sends the phone code) with its 14px `muted` hint; "Back to
  checkout" only when neither button is there. Both buttons are POST routes; while one waits, both are
  `aria-disabled`.
- **Test payment page (`/checkout/fake-gateway`):** the fake gateway's page, on every shop (with SSLCommerz behind
  the API, a fake `val_id` pays nothing). `noindex`, `no-store`, 404 for an address that is not a try's. The checkout
  card at 560px, "Test payment", a `canvas` notice with `InformationCircle` ("This is a test page, not SSLCommerz. No
  money moves…"), Amount (`price`) and Transaction (`Geist Mono`, `break-all`), then one form with three submit
  buttons: "Pay ৳538" (the Confirm Order look), "Fail the payment" and "Cancel the payment" (`cream`, 44px). It posts
  to the return path like SSLCommerz, with no script.
- **Order details (`/order/[no]`, from "View Order Details"):** the checkout card at 848px: header "Order
  Details", the order number in `Geist Mono` `sf-title` `brand`, the status timeline of the track page, the
  delivery details (name, phone, address, area) in 16px `body`, and the lines and totals as in checkout,
  read-only (no stepper, no delete; "150ml · 2 × ৳229" under the name), with a Subtotal row above Delivery Charge.
  Only the browser that placed the order sees it (a cookie); anyone else gets page not found.
- **Tracking link (`/t/<token>`):** the link the shop sends the buyer (by SMS from step 27). The token is 128 bits
  (22 base64url characters) and only its hash is stored, like a share link. The checkout card at 848px, header
  "Track Order", body padding 36px (20px on phones), 32px between blocks: the order number (`Geist Mono`
  `sf-title`, never broken) with "Placed on …" under it; a `canvas` box (radius 8, padding 20px) with "3 items"
  and the total in `price`, and "Keep ৳578 ready in cash for the rider." (Cash on Delivery, until delivered) or
  "Paid online."; the order's timeline: 24px dots (done: `brand` fill with an `accent` tick; current:
  2px `accent` ring on `brand`; later: 1px `rule` ring), 2px connecting line, 16px/600 `brand` status and a 14px
  `muted` date; then one section per parcel (at most 5), newest first: "Parcel" (an older one "Earlier parcel"),
  "Steadfast · SFR2611120042" in 14px `muted` `tabular-nums`, an optional "See it on the Steadfast site" link
  (`LinkSquare02`, https only, `rel="noopener noreferrer"`), and the courier's events newest first in the same
  dots and line (status, time, and the courier's own note in 14px `body`). Each courier's statuses map to the
  shop's ten. Before a courier is booked, the parcel section says so; a parcel still booking or whose booking failed
  is not shown, nor a notice the API could not read. Steps with the same courier time keep the order they arrived in. It ends with "Anyone with this link can
  see this page. It shows no address and no phone number." in 14px `muted`: the page names no person, because a
  link can be forwarded. Headers `Cache-Control: no-store`, `X-Robots-Tag: noindex` and
  `Referrer-Policy: no-referrer`. A broken or unknown link answers 404 with its own empty state.
- **Track order (`/track`):** the way back for a lost SMS. The checkout card at 560px: header "Track Order", a
  16px `body` line, Mobile Number and Order Number side by side from `md` (the checkout's fields; the number
  takes "w000123" or Bangla digits too), and "Track Order" (the Confirm Order button's look). The form POSTs to
  the same page and works with no script, so the phone never goes into the address. A match draws the tracking
  link's view in place at 848px, ending with "Track another order" (`cream`, 44px, radius 4). A wrong number or
  phone, of any kind, gets one answer above the boxes ("No order has this number and mobile number…", `Alert02`,
  `promo`, it takes the focus); a box with an error says so under it, and the first one takes the focus. After
  10 misses in 15 minutes from one address (IPv6: its /64) the page answers 429, "Too many tries. Wait 15
  minutes…" (the API counts the misses in Redis; the mock source counts them itself). It cannot send the shopper to `/t/<token>`: only the token's hash is stored. The mock shop lists
  its demo orders, their phones and their links in a `canvas` box under the line.
- **Text pages (`/pages/privacy`, `terms`, `about`, `contact`):** the
  checkout card at 848px with the footer's own word as the title in the header ("Terms & Condition"), "Last
  updated 1 Nov 2026" under it in 14px `muted` (the day in the shop's time zone) when the page has a date, and the
  tenant's HTML in the description's prose style (`shop-prose`), its sections 8px apart in the card's 4px frame.
  Only these four; any other slug, or a page the tenant has not written, is page not found. Contact is text only,
  with no form.
- **Page not found (`404`):** the full layout (header and footer) with the
  empty state 36px under the header (16px on a phone): `FileNotFound`, "Page not found", "The link may have a
  typo, or the page has moved…", and "Go to the home page". Status 404. It answers every address with no page,
  and every page that rewrites to `/404` (an unknown product, category, order or text page).
- **No shop (a host with no launched shop):** a page of its own, not the shop's layout, because there is no shop
  to take a name, colors or a menu from. The empty state 16px from the top (36px from `md`) in the default colors:
  `StoreRemove01`, "No shop has this address", "Check the address for a typo…", and no button (a link to `/` would
  land here again). English, `noindex`, status 404. `/api/*` on such a host answers `404 storefront_not_found` as
  problem JSON.
- **Toast:** bottom center, `brand` fill, `accent` 16px/600 text, radius 8, padding 12px 16px, about 3s, e.g.
  "Added to cart".

### Storefront tests

Unit tests (Vitest) sit next to the code. Browser tests are Playwright, in `apps/shop/e2e/`, against the built
server (`astro build`, then `node dist/server/entry.mjs` on 127.0.0.1:4331), in Chromium at 1440×900 and at
390px (Pixel 7). There are no screenshot diffs: a test checks what a shopper sees and does, and that the page
never scrolls sideways. CI runs them in their own step, `pnpm --filter @omnivo/shop test:e2e`, and
`pnpm --filter @omnivo/shop typecheck` checks `e2e/` too. A test that uses up `/track`'s tries sends its own
`X-Forwarded-For`, so it does not stop the other tests. They run on the mock source. The API source is tested
without a browser, against a fake `/public/v1` made of the mock (`src/data/api/api-source.spec.ts`), and the API's
answers by its own integration and tenant-leak tests (`apps/api/src/storefront/`; the orders, the phone code, the
limits and the race for the last piece in `storefront/orders/`, each test with its own phones and shopper address,
because the limits count them across tests).

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

### Landing page prototypes (2026-11-26)

Three directions for the marketing landing page, built as single-file HTML prototypes
(Three.js r128 from cdnjs, a hand-written scroll smoother, HugeIcons path data inlined).
None is chosen yet. The files open in any browser; the Artifact links are private to the owner.

| # | Direction | File | Artifact |
|---|---|---|---|
| 1 | Tiles: one set of rounded tiles re-forms into the logo, a device, a ledger, a stock rack and a delivery route | [docs/landing-prototypes/01-tiles.html](docs/landing-prototypes/01-tiles.html) | https://claude.ai/artifact/4uoMPcZtTN9iMDJBTzKF4B |
| 2 | Halkhata: a 3D red khata opens and turns its pages (handwriting on the left, Omnivo on the right), then closes onto an Omnivo cover | [docs/landing-prototypes/02-halkhata.html](docs/landing-prototypes/02-halkhata.html) | https://claude.ai/artifact/6ttg7cMYsRoVi8jpYPExeb |
| 3 | Layers: dark, the Overview screen comes apart into 3D layers (outbox, trial balance, POS receipt, the tenant's shop) and snaps back | [docs/landing-prototypes/03-layers.html](docs/landing-prototypes/03-layers.html) | https://claude.ai/artifact/D7BrJfix7cozVZqfvj7pxg |

Names, BIN, phone numbers and "Free for 14 days" in them are placeholders.

**Chosen (2026-11-26): #2 Halkhata**, built as `apps/website` (`@omnivo/website`, static Astro, port
4341). Stack confirmed: plain `three` from npm plus the prototype's own scroll-to-step code (no GSAP,
no R3F). three.js loads with a dynamic import after the text paints, and never with Save-Data; without
WebGL the page drops the book (`html.no-stage`). The book's pages are canvases drawn at a quality the
stage picks from the device pixels a page covers (0.75–1.5 × 1024 × 1426), after the fonts load. The
marketing site alone adds the fonts Atma (handwriting) and Tiro Bangla (the khata's print).
`PUBLIC_APP_URL` (build time) is where Sign in, Start free trial and the workspace form go.
