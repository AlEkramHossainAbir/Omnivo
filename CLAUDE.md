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
