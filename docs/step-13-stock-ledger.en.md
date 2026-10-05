# Step 13: Stock ledger — warehouses, adjustments, transfers, batches, serial numbers and reorder levels

> The implementation guide for "Phase 4 → Step 13" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `9ffbc4a`, the end of
> step 12) and checked on 2026-10-05: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (240 — 22 new), `pnpm test:integration` (201 — 26 new), `pnpm test:tenant-leak` (43 — 4 new), `pnpm build`, `pnpm test:bundle-size` (first load 179.8 KB gz, budget 200; the stock card 85.9 KB), `pnpm gen:openapi` (90 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 84 — 8 new, desktop and 390px) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked by hand:
>
> - **The screens**, with the mock API, at 1280px and 390px: the stock list (10,000 styles), a stock card with
>   serial numbers, the adjustment form with the item picker, a transfer being received, the reorder list and the
>   warehouses. No console error, and no page scrolls sideways. The screenshots found two details, fixed in this
>   guide ("What we found on the way").
> - **Two people taking the last stock at the same moment**, in the integration test: a write-off and a transfer
>   of 30 of the 40 pieces in a depot, held back by a third connection until both wait on the same balance row;
>   one is posted, the other is refused under its line with `stock_insufficient`, and 10 are left.
> - **The database's own rules**, written to directly as the superuser, past the API: a movement cannot be changed
>   or deleted, a batch cannot go below zero, and every balance equals the sum of its movements.
> - **Every guard broken on purpose**: skip the API's stock check → "refuses to take more than is there" fails (the trigger's refusal has no field). Take `FOR UPDATE` off the balance rows → "lets only one of two people take the same last 30 pieces" fails. Leave the append-only trigger out → "never changes or deletes a movement" fails. Let the trigger refuse inflows below zero too → the negative stock test fails. Accept a batch of another variant → the tenant-leak test fails. Leave RLS off `stock_balances` → the RLS coverage test fails. Drop the base-unit guard → "keeps its base unit" fails. Let a receipt exceed what was sent → "receives it short" fails. Each check ran its whole test file.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` first
> (migrations 0021 and 0022), or every stock page fails. (2) The new tests on GitHub Actions. (3) The Bangla texts
> were written by me, not reviewed by a native speaker. (4) The stock list with 10,000 products *and* years of
> movements on a real Postgres: the queries use the indexes below, but nobody has timed them with a big ledger yet.
> (5) Playwright on a busy laptop: the full suite passed 84/84 twice on the final code; a third run while the
> machine's load average was above 90 timed out in 50 tests across every file, old ones included (step 10's known
> "times out on a busy laptop" note).

## Goal

📦 **Stock, the way a warehouse really works.** Step 12 built the products. This step counts them: how many of
each variant sit in each warehouse, how they got there, and what is about to run out. Every change of stock is one
row in an append-only ledger — nothing is ever overwritten, and the stock is always the sum of those rows.

After this step:

- **Warehouses.** Each branch has one or more: a fabric store and a finished goods store in a factory, a depot, a
  shop's back room. Every workspace starts with a "Main store" in its head office.
- **The stock ledger.** `stock_movements`, one row per change, never updated, never deleted — the database refuses
  it. A trigger keeps `stock_balances` (what is where right now) equal to the sum of the movements.
- **Stock adjustments.** Stock that comes in or goes out without a sale or a purchase: the **opening stock** on
  the first day, goods found in a count, a damaged carton, an expired batch, physician samples. Draft → posted,
  numbered `ADJ-2026-27-0001`. A posted adjustment never changes; a mistake is fixed by another one.
- **Transfers in two steps.** "Send" takes the stock out of one warehouse and puts it **in transit**; "Receive" at
  the other warehouse adds what arrived. Anything less stays on the transfer as a shortage. Numbered `TRF-…`.
- **Batches and expiry.** A batch-tracked product comes in with its lot number and expiry date; it goes out from a
  named batch, and the form splits a quantity **first expiry, first out** (FEFO). An expiry report lists every
  batch with stock, the soonest first, with "Expired" and "12 days left" pills.
- **Serial numbers.** A serial-tracked product (a phone, a sewing machine) moves one IMEI or serial plate at a
  time. Each serial number is in one warehouse, on a truck, or gone — never in two places.
- **Negative stock: a workspace setting, off by default.** Off: nothing takes more than is there. On: an untracked
  product may go below zero (the shelf had it before the books did). Batches and serial numbers never go negative.
- **Reorder levels and alerts.** Per variant and warehouse: "reorder when it falls to 12, order 48". A posting
  that takes stock down to its level rings the bell of everyone who manages products, and the Reorder page lists
  what to order.
- **Three permissions:** `inventory.warehouse.manage`, `inventory.stock.adjust`, `inventory.stock.transfer`.
  Reading stock needs none.

## The whole picture

```
packages/contracts   quantities.ts (exact quantity arithmetic, toBaseQuantity) · warehouses.ts · stock.ts
      │               stock-adjustments.ts · stock-transfers.ts
      │               24 routes · 3 permissions · 14 audit actions · 1 notification · 41 errors
      │               the number series 'inventory.adjustment' (ADJ) and 'inventory.transfer' (TRF)
      ▼
packages/db          warehouses · stock_movements · stock_balances · reorder_levels
                     stock_adjustments (+ lines) · stock_transfers (+ lines) · serials.warehouse_id
                     0021 (drizzle, reordered) · 0022 (RLS, the ledger's triggers, a Main store for old workspaces)
      │
      ▼
apps/api             InventoryModule
                       stock-lines.ts         resolveLines(): every line rule that does not depend on stock
                       StockPostingService    the one way into the ledger: batches, serials, stock, movements
                       WarehousesService · StockAdjustmentsService · StockTransfersService · StockService
                     worker: LowStockHandler → the bell
                     changed: sign-up (a Main store), branches (no archive with warehouses), products (no new
                     base unit or tracking once stocked), settings (allowNegativeStock), role templates
      │
      ▼
apps/app             /stock · /stock/$variantId · /stock/adjustments(/new, /$id) · /stock/transfers(/new, /$id)
                     /stock/batches · /stock/reorder · /warehouses · Settings → Inventory
                     the Bangla texts load on demand (i18n) · KpiStrip moved into @omnivo/ui
                     MSW: warehouses, a ledger, an opening stock, a truck on the road

one adjustment, from the click to the stock:
  Post ──POST /stock-adjustments {post: true}──► API, one transaction:
     warehouse active? date open and not tomorrow? every line → resolveLines() (unit, decimals, lot, serials)
     lots → batches · number ADJ-… · StockPostingService.post():
        serials checked (FOR UPDATE) · balance rows locked (FOR UPDATE, in key order) · enough stock?
        INSERT stock_movements ──► trigger: stock_balances += quantity, below zero? refused · serial moved
        crossed a reorder level? → outbox event
     header posted · audit · COMMIT
  relay → worker: LowStockHandler counts again → bell "Main store: 1 items fell to their reorder level"
```

## The decisions behind this step

You made the first four on 2026-10-05. The others follow from them, from the build plan, or from what each trade
needs. Please read 5–16 with care: they are mine.

1. **Warehouses belong to a branch.** (You chose this.) A new `warehouses` table; a branch has as many as it needs.
   A branch cannot be archived while it has an active warehouse, and a warehouse with stock history cannot move to
   another branch — its history (and, from step 14, its value) belongs to the branch it was in.
2. **Negative stock is a workspace setting, off by default.** (You chose this.) Off: an outflow larger than the
   stock is refused, line by line. On: an untracked product may go below zero; a batch or a serial number never
   does. Offline POS (steps 18–20) needs it on; most companies want it off.
3. **Transfers in two steps, with in transit.** (You chose this.) Send = out of the source, now. Receive = into the
   destination, on the day it arrived, with what arrived. The shortage stays on the transfer's lines.
4. **Batches with expiry and serial numbers, both in full.** (You chose this.) Lots are typed when stock comes in
   and become batches when posted; outflows name a batch, and the form splits FEFO. Serial numbers move one by one.
5. **The ledger is append-only, and the database says so.** A trigger refuses every `UPDATE` and `DELETE` on
   `stock_movements`, for every role. Fixing a mistake is a new document, exactly like a journal reversal.
6. **`stock_balances` is kept by a trigger, not by code.** Reading stock must not add up years of movements, so the
   current stock per warehouse, variant and batch is a table — but no code writes it. An `AFTER INSERT` trigger on
   `stock_movements` adds each movement, so a balance always equals the sum of its movements, whoever inserts
   them. It is also the row two concurrent documents queue on. This is not the `products.quantity` column the
   build plan warns about: that one is overwritten by the app; this one is derived, inside the same transaction,
   and never sent to an offline client.
7. **The API checks first, the database checks last.** `StockPostingService` locks the balance rows and refuses a
   line with a readable error under its field (`lines.2.quantity`). The trigger refuses the same thing again with
   an exception — the second line of defence, like migration 0016's balanced-entry trigger for the journal. If the
   trigger ever speaks, its refusal is still turned into the 409 it means (`stock_insufficient`), never a 500.
8. **One way into the ledger: `StockPostingService.post()`.** Adjustments and transfers use it now; purchases,
   sales and POS will build a `StockPosting` and call it inside their own transaction, so the document and its
   movements commit together. It is exported from `InventoryModule`, like the journal's `PostingService`.
9. **Quantities are decimal strings in the base unit, never numbers.** A line keeps what was typed (3 cases), the
   factor at the time (24) and the base quantity (72). `toBaseQuantity()` rounds half up to the base unit's
   decimals (3 yards = 2.74 m when metres keep 2), and the form shows "= 2.74 m" before saving. A quantity with
   more decimals than its unit allows (1.5 boxes) is refused.
10. **Drafts, then posting; numbers at posting.** Like the journal: `ADJ-…` and `TRF-…` are given when posted or
    sent, so they have no gaps. One permission covers writing and posting an adjustment (`inventory.stock.adjust`),
    another sending and receiving a transfer (`inventory.stock.transfer`). Reading stock needs none.
11. **Documents are dated in an open period and not in the future.** The accounting lock date applies (from step 14
    every movement also posts to the books), and nothing moves on a day that has not come yet.
12. **A lot is a batch per variant.** The same lot number (in any case) adds to the same batch and takes its expiry;
    typing a different expiry for a known lot is refused. A new lot of a product with expiry dates needs its date.
13. **Reorder levels per variant and warehouse; the alert fires on the crossing.** A posting that takes stock from
    above the level to at-or-below it queues one outbox event per warehouse. The worker counts again, then notifies
    the owners and everyone whose role has `inventory.product.manage`. Stock that was already low does not ring
    again with every sale.
14. **A product with stock keeps its base unit, tracking and type.** Changing them would turn 120 pieces into
    120 kg, or stock into stock without batches. Draft lines and movements also keep a variant from being deleted
    (`product_variant_in_use`, `product_in_use`). A pack can still be resized: old lines keep their own factor.
15. **The Bangla texts load on demand.** This step's texts pushed the first page load to 201.8 KB (budget 200).
    English stays in the bundle (it is also the fallback); Bangla is its own chunk, fetched before the first render
    only on a device that uses Bangla. The first load is now 179.8 KB.
16. **ESLint gets a 4 GB heap.** Type-aware linting of the whole repo already used about 2.3 GB at the end of step
    12, right at Node's default limit; this step's files tipped it over. The root `lint` script now runs ESLint
    with `--max-old-space-size=4096`.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| The value of stock, and journal entries for movements | Step 14 (valuation + the first module integration) |
| Stock counts on a count sheet (counted vs. expected, the difference posted) | A "Found in a count" or "Correction" adjustment covers it now; a count sheet with a freeze date later |
| Opening stock from a CSV | The adjustment form takes up to 500 lines; an import like step 12's when a big shop asks |
| Bin and rack locations inside a warehouse | You chose warehouses under branches (decision 1); bins when a depot asks |
| Who may move stock in which warehouse | Permissions are workspace-wide; per-warehouse access with the POS (step 20) |
| Cancelling a transfer on its way | Receive it with what arrived (zero is allowed); a return is a new transfer |
| Reversing a posted adjustment with one click | Post another adjustment the other way; a reverse button when people ask |
| Purchase receipts, sales deliveries | Steps 15 and 17, through `StockPostingService.post()` |
| Barcode labels, scale barcodes | POS (step 20) |

## What changes in the code you already have

- **No new package.** No new `.env` line, no new database role.
- **`pnpm db:migrate`** adds eight tables and two columns (`serials.warehouse_id`,
  `tenant_settings.allow_negative_stock`), the ledger's triggers, the three permissions (`syncPermissions()`), and a
  "Main store" (`MAIN`) in the first active branch of every existing workspace.
- **Sign-up** also makes the "Main store" in the new workspace's head office.
- **Archiving a branch** is refused while it has an active warehouse (`branch_has_warehouses`).
- **Products:** a product with stock movements keeps its base unit, tracking and type; the stock tables' foreign
  keys are mapped to `product_in_use` / `product_variant_in_use`.
- **Settings** get `allowNegativeStock`: the settings page has a new "Inventory" card, and the settings `PUT` body
  needs the new field (three existing tests send it now).
- **The role templates** give the new permissions to the store keeper, depot managers, production manager, shop
  manager and manager of **new** workspaces. Existing roles do not get them; an owner ticks them on the Roles page.
- **Two new number series**, `inventory.adjustment` (ADJ) and `inventory.transfer` (TRF), on the Numbering page.
- **i18n:** Bangla is loaded on demand (`languageReady`), and `main.tsx` waits for it before the first render.
- **ui:** `KpiStrip` moved from the app's `report-parts.tsx` into `@omnivo/ui`; `controlBoxClass` is exported.
- **app:** `useDebounced` moved from `routes/products.tsx` to `lib/use-debounced.ts`.
- **Root `package.json`:** the `lint` script gives ESLint a 4 GB heap (decision 16).
- **Existing tests that change:** the setup test (the store keeper's new permissions), the numbering test (nine
  series now), and the settings, journal and contracts settings tests (the new settings field).

---

## 13.1 — `packages/contracts`: the contract

Five new files: quantities (the arithmetic), warehouses, stock (the reads, the shared line rules and the reorder
levels), stock adjustments and stock transfers. Then one or two lines in eight existing files.

### `packages/contracts/src/quantities.ts` (new)

`packages/contracts/src/quantities.ts`:

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';

// A quantity of stock is a decimal string end to end, like money: the database column is
// NUMERIC(19,4) ("24.0000"), and a unit allows at most 4 decimals (units.decimals). A JavaScript
// number would turn 0.1 + 0.2 kg into 0.30000000000000004 kg.
const QUANTITY = /^\d{1,13}(?:\.\d{1,4})?$/;
const SIGNED = /^(-?)(\d+)(?:\.(\d{1,10}))?$/;

// The arithmetic below works in ten-thousandths, as BigInt — exact, and contracts stays on zod
// alone (the contracts-only-zod boundary), the same way money.ts does it.
const SCALE = 10_000n;
const MICRO = 1_000_000n;

function toUnits(value: string): bigint {
  const match = SIGNED.exec(value);
  const whole = match?.[2];
  if (match === null || whole === undefined) throw new Error(`Not a quantity: "${value}"`);
  const fraction = (match[3] ?? '').padEnd(4, '0').slice(0, 4);
  const units = BigInt(whole) * SCALE + BigInt(fraction);
  return match[1] === '-' ? -units : units;
}

// Always 4 decimals, like Postgres sends NUMERIC(19,4), so two results compare as plain strings.
// Zero has no minus sign.
function fromUnits(units: bigint): string {
  const size = units < 0n ? -units : units;
  return `${units < 0n ? '-' : ''}${String(size / SCALE)}.${String(size % SCALE).padStart(4, '0')}`;
}

export function isQuantity(value: string): boolean {
  return QUANTITY.test(value) && toUnits(value) > 0n;
}

// What a line's quantity box sends: a positive number with at most 4 decimals. Zero is not a
// quantity: a line that moves nothing is a mistake, not a line.
export const quantitySchema = z
  .string()
  .trim()
  .refine((value) => isQuantity(value), errorCode('quantity_format'));

// What arrived of a transfer line: zero is a real answer (the carton never came)
export const receivedQuantitySchema = z
  .string()
  .trim()
  .refine((value) => QUANTITY.test(value), errorCode('quantity_format'));

// A level (a reorder point): zero is allowed ("tell me when it runs out"), '' = no level
export const levelSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || QUANTITY.test(value), errorCode('quantity_format'))
  .transform((value) => (value === '' ? null : value))
  .nullable();

export function addQuantity(a: string, b: string): string {
  return fromUnits(toUnits(a) + toUnits(b));
}

export function subtractQuantity(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function sumQuantity(values: readonly string[]): string {
  return fromUnits(values.reduce((total, value) => total + toUnits(value), 0n));
}

export function negateQuantity(value: string): string {
  return fromUnits(-toUnits(value));
}

// -1, 0 or 1, like a sort comparator: compareQuantity(onHand, wanted) < 0 = not enough
export function compareQuantity(a: string, b: string): number {
  const difference = toUnits(a) - toUnits(b);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

export function isZeroQuantity(value: string): boolean {
  return toUnits(value) === 0n;
}

// "1.50" fits a unit with 1 decimal (the trailing zero means nothing); "1.25" does not. A box or
// a piece allows 0 decimals: 1.5 boxes is a typing mistake, not half a box.
export function fitsDecimals(value: string, decimals: number): boolean {
  const fraction = (value.split('.')[1] ?? '').replace(/0+$/, '');
  return fraction.length <= decimals;
}

// A quantity typed in a pack, in the product's base unit: quantity × factor, rounded half up to
// the decimals the base unit allows. A carton of 24 → 3 cartons = 72 pcs, exact. A yard is
// 0.9144 m and metres keep 2 decimals → 3 yards = 2.7432 m = 2.74 m: the line shows "= 2.74 m"
// before it is saved, so nobody is surprised. The result has 4 decimals, like the column.
export function toBaseQuantity(quantity: string, factor: string, decimals: number): string {
  // quantity in ten-thousandths × factor in millionths = 10^10ths
  const [whole = '0', fraction = ''] = factor.split('.');
  const factorMicro = BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  const product = toUnits(quantity) * factorMicro;
  // Down to `decimals` places: divide by 10^(10 - decimals), half up (quantities are positive)
  const step = 10n ** BigInt(10 - decimals);
  const rounded = (product + step / 2n) / step;
  // Back to ten-thousandths: × 10^(4 - decimals)
  return fromUnits(rounded * 10n ** BigInt(4 - decimals));
}

// A serial-tracked line counts whole items: one serial number per base unit
export function isWholeQuantity(value: string): boolean {
  return toUnits(value) % SCALE === 0n;
}

export function wholeCount(value: string): number {
  return Number(toUnits(value) / SCALE);
}

// "24.0000" → "24", "2.7400" → "2.74": for a sentence or an audit row. Tables use the unit's
// decimals with format.number instead, so the column lines up.
export function plainQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
```

Why it is written this way:

- **Strings, BigInt inside.** A quantity is a decimal string end to end, like money. `0.1 + 0.2` kg as JavaScript
  numbers is `0.30000000000000004` kg; `addQuantity('0.1', '0.2')` is exactly `'0.3000'`. BigInt in
  ten-thousandths is exact for what stock does (add, subtract, compare), and it keeps this package on zod alone —
  the `contracts-only-zod` boundary rule forbids `decimal.js` here (step 10 found that out for money).
- **Always 4 decimals out** (`fromUnits`): Postgres sends `NUMERIC(19,4)` as `"72.0000"`. When the API's and the
  browser's results have the same shape, two quantities compare as strings in tests, and nothing is "72" in one
  place and "72.0000" in another.
- **`quantitySchema` refuses zero; `receivedQuantitySchema` and `levelSchema` allow it.** A line that moves
  nothing is a mistake. "Nothing arrived" is a real receipt, and "reorder when it runs out" is a real level.
- **`toBaseQuantity()`** multiplies in 10^10ths (quantity in 10^4ths × factor in 10^6ths), then rounds half up
  *once* to the base unit's decimals. Rounding twice (first to 4 places, then to 2) can round a 5 up twice. The
  result is positive, so "half up" is simply `+ step / 2` before dividing.
- **`fitsDecimals()`** ignores trailing zeros: `1.50` fits a unit with 1 decimal. Without that, a person who types
  `3.0` boxes would be told boxes take no decimals.
- **`wholeCount()` and `isWholeQuantity()`** are for serial numbers: one per base unit, so 3 phones need exactly 3
  IMEIs and 2.5 phones is never valid.

### `packages/contracts/src/warehouses.ts` (new)

`packages/contracts/src/warehouses.ts`:

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// A place that holds stock: a fabric store and a finished goods store in one factory, a depot, a
// shop's back room. It belongs to a branch, so stock can be read branch by branch (and, from step
// 14, valued that way). Archived, never deleted: its movements stay in every stock card.
export const warehouseSchema = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  code: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Warehouse = z.infer<typeof warehouseSchema>;

// Short and upper case like a branch code (MAIN, FAB, FG, CTG-DEPOT is too long): it sits in
// narrow table columns and on a transfer slip. Upper-cased first, so "fab" and "FAB" are one code.
const warehouseCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, errorCode('warehouse_code_format'));

export const warehouseInputSchema = z.object({
  // The form's empty select sends '' — "not chosen", with its own message
  branchId: z.uuid(errorCode('warehouse_branch_invalid')),
  code: warehouseCodeSchema,
  name: z.string().trim().min(2, errorCode('warehouse_name_required')).max(120),
  address: optionalText(300),
});
export type WarehouseInput = z.infer<typeof warehouseInputSchema>;

export const updateWarehouseInputSchema = warehouseInputSchema.extend({ version: versionSchema });
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseInputSchema>;

export const warehouseVersionInputSchema = z.object({ version: versionSchema });

export const WAREHOUSE_STATUSES = ['active', 'archived'] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

export const warehouseListQuerySchema = z.object({
  status: z.enum(WAREHOUSE_STATUSES).default('active'),
});

// A company has a handful of warehouses, a distributor a few dozen: the whole list at once
export const warehouseListSchema = z.object({ items: z.array(warehouseSchema) });

const warehouseParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: every stock page and every stock line picks a warehouse
export const warehouseRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/warehouses',
    summary: 'The warehouses of the workspace',
    auth: 'bearer',
    status: 200,
    query: warehouseListQuerySchema,
    response: warehouseListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/warehouses',
    summary: 'Add a warehouse to a branch',
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 201,
    body: warehouseInputSchema,
    response: warehouseSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/warehouses/:id',
    summary: "Change a warehouse's code, name, address or branch",
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 200,
    params: warehouseParamsSchema,
    body: updateWarehouseInputSchema,
    response: warehouseSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/warehouses/:id/archive',
    summary: 'Archive an empty warehouse',
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 200,
    params: warehouseParamsSchema,
    body: warehouseVersionInputSchema,
    response: warehouseSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/warehouses/:id/restore',
    summary: 'Bring an archived warehouse back',
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 200,
    params: warehouseParamsSchema,
    body: warehouseVersionInputSchema,
    response: warehouseSchema,
  }),
};
```

- **`branchId` is required** and the empty select's `''` gets its own error (`warehouse_branch_invalid`), so the
  form says "pick an active branch", not "invalid uuid".
- **The code is upper-cased before the regex**, exactly like a branch code: `fab` and `FAB` cannot become two
  warehouses that slip past the unique index.
- **No `get` route and no `remove` route.** The list is small and the pages read it whole; a warehouse is archived,
  never deleted, because its movements point at it for ever.
- **Reading needs no permission:** every stock page and every stock line picks a warehouse.

### `packages/contracts/src/stock.ts` (new)

`packages/contracts/src/stock.ts`:

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { levelSchema, quantitySchema } from './quantities.js';

// What a movement is, by the document that made it. The response sends it as z.string(), like a
// journal source: a newer server's new kind (a sales delivery, step 15) must not break an older
// offline client.
export const MOVEMENT_KINDS = ['adjustment', 'transfer_out', 'transfer_in'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export function isMovementKind(value: string): value is MovementKind {
  return MOVEMENT_KINDS.some((kind) => kind === value);
}

// An opening stock sheet or a transfer of a whole depot runs to a few hundred lines; a line of
// phones to a few hundred serial numbers
export const MAX_STOCK_LINES = 500;
export const MAX_SERIALS_PER_LINE = 1000;

// ---------------------------------------------------------------------------------------------
// What a document line sends

// What a scanner types: an IMEI (15 digits), a machine's plate (SN-4471-B). Printable ASCII
// without spaces, like a barcode, and matched exactly as typed.
export const serialNumberSchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7E]{1,64}$/, errorCode('serial_number_format'));

// The form's "not chosen" is ''
const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const optionalDateSchema = z
  .union([z.iso.date(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

// One line that takes stock out (or moves it): which variant, in which unit, how many. A batch
// product names the batch it takes from (FEFO picks it in the form); a serial product lists the
// serial numbers, one per base unit.
export const stockLineFieldsSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  // The base unit or one of the product's packs; the quantity is in this unit
  unitId: z.uuid(errorCode('stock_unit_invalid')),
  quantity: quantitySchema,
  batchId: optionalIdSchema,
  serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
});

// A line that brings stock in (an adjustment "in", opening stock) also says which batch the goods
// are: the lot number printed on them, and its dates. Receiving more of an existing lot adds to
// that batch.
export const stockInLineFieldsSchema = stockLineFieldsSchema.extend({
  lotNumber: optionalText(40),
  expiresOn: optionalDateSchema,
  manufacturedOn: optionalDateSchema,
});

interface LineFields {
  serialNumbers: readonly string[];
  manufacturedOn?: string | null;
  expiresOn?: string | null;
}

// The rules inside one line: each serial number once, and a batch that expires after it was made.
// Each error sits on the field to change, so the form shows it there.
export function stockLineRules<T extends LineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  const seen = new Set<string>();
  line.serialNumbers.forEach((serial, index) => {
    if (seen.has(serial)) {
      ctx.addIssue({
        code: 'custom',
        path: ['serialNumbers', index],
        message: errorCode('stock_serial_twice'),
      });
    }
    seen.add(serial);
  });
  const made = line.manufacturedOn ?? null;
  const expires = line.expiresOn ?? null;
  if (made !== null && expires !== null && expires <= made) {
    ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: errorCode('stock_batch_dates') });
  }
}

// A serial number moves once per document: the same IMEI on two lines is a scanning slip
export function documentSerialRules<T extends { lines: readonly LineFields[] }>(
  input: T,
  ctx: z.RefinementCtx<T>,
): void {
  const seen = new Set<string>();
  input.lines.forEach((line, lineIndex) => {
    line.serialNumbers.forEach((serial, index) => {
      if (seen.has(serial)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', lineIndex, 'serialNumbers', index],
          message: errorCode('stock_serial_twice'),
        });
      }
      seen.add(serial);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// What the API sends

// Which variant a row is about, with what a person needs to recognise it
export const variantRefSchema = z.object({
  variantId: z.uuid(),
  productId: z.uuid(),
  productCode: z.string(),
  productName: z.string(),
  // Empty for a simple product
  optionValues: z.array(z.string()),
  sku: z.string(),
  baseUnitId: z.uuid(),
});
export type VariantRef = z.infer<typeof variantRefSchema>;

// A pack of the product, for the line's unit select: "1 carton = 24 pcs"
export const stockUnitSchema = z.object({ unitId: z.uuid(), factor: z.string() });

// One variant on the stock page and in the "Add items" search
export const stockItemSchema = variantRefSchema.extend({
  // z.string(), not the enum: the rule of products.ts
  tracking: z.string(),
  hasExpiry: z.boolean(),
  units: z.array(stockUnitSchema),
  // The product or the variant is archived: it shows while it still holds stock
  archived: z.boolean(),
  // In the chosen warehouse, or in all of them. Decimal strings with 4 places, in the base unit.
  onHand: z.string(),
  // Sent from another warehouse and not received yet (to the chosen warehouse, or anywhere)
  inTransit: z.string(),
  // At or below its reorder level in the chosen warehouse (or in any warehouse)
  low: z.boolean(),
});
export type StockItem = z.infer<typeof stockItemSchema>;

// A line of an adjustment or a transfer as the API sends it: the variant with what the form needs
// to edit it again (its packs, its tracking), what was typed, and the quantity in the base unit
export const stockLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  tracking: z.string(),
  hasExpiry: z.boolean(),
  units: z.array(stockUnitSchema),
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  manufacturedOn: z.iso.date().nullable(),
  serialNumbers: z.array(z.string()),
});
export type StockLine = z.infer<typeof stockLineSchema>;

export const STOCK_FILTERS = ['all', 'in_stock', 'low'] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];

export const stockListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code or a SKU; or a whole barcode or serial number (a scan)
  search: z.string().trim().max(100).optional(),
  warehouseId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  filter: z.enum(STOCK_FILTERS).default('all'),
});
export type StockListQuery = z.input<typeof stockListQuerySchema>;

export const stockPageSchema = pageOf(stockItemSchema);
export type StockPage = z.infer<typeof stockPageSchema>;

// One variant's stock card: where it is, in which batches, which serial numbers
export const stockCardSchema = z.object({
  item: stockItemSchema,
  // Every active warehouse, and an archived one that still holds some
  warehouses: z.array(
    z.object({
      warehouseId: z.uuid(),
      onHand: z.string(),
      inTransit: z.string(),
      minQuantity: z.string().nullable(),
      reorderQuantity: z.string().nullable(),
    }),
  ),
  // The batches with stock, the one to use first (FEFO: first expiry, first out) on top
  batches: z.array(
    z.object({
      batchId: z.uuid(),
      lotNumber: z.string(),
      manufacturedOn: z.iso.date().nullable(),
      expiresOn: z.iso.date().nullable(),
      warehouseId: z.uuid(),
      quantity: z.string(),
    }),
  ),
  // The serial numbers in stock, and the ones on their way (warehouseId null = in transit)
  serials: z.array(z.object({ serialNumber: z.string(), warehouseId: z.uuid().nullable() })),
});
export type StockCard = z.infer<typeof stockCardSchema>;

// One row of the stock card's history. quantity is signed: + in, − out. balance runs over the
// rows of the chosen warehouse (or all of them), in date order.
export const stockMovementSchema = z.object({
  id: z.uuid(),
  date: z.iso.date(),
  warehouseId: z.uuid(),
  kind: z.string(),
  documentId: z.uuid(),
  documentNumber: z.string(),
  quantity: z.string(),
  balance: z.string(),
  lotNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const stockMovementQuerySchema = pageQuerySchema.extend({
  warehouseId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const stockMovementPageSchema = pageOf(stockMovementSchema).extend({
  // Before `from`, and after `to` — the same on every page
  openingBalance: z.string(),
  closingBalance: z.string(),
});
export type StockMovementPage = z.infer<typeof stockMovementPageSchema>;

// The expiry report: every batch with stock, the soonest expiry first
export const batchStockSchema = variantRefSchema.extend({
  batchId: z.uuid(),
  lotNumber: z.string(),
  manufacturedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  warehouseId: z.uuid(),
  quantity: z.string(),
});
export type BatchStock = z.infer<typeof batchStockSchema>;

export const batchStockQuerySchema = pageQuerySchema.extend({
  warehouseId: z.uuid().optional(),
  // Only batches that expire within this many days of today (expired ones always show)
  expiresWithin: z.coerce.number<number>().int().min(0).max(3650).optional(),
});

export const batchStockPageSchema = pageOf(batchStockSchema);
export type BatchStockPage = z.infer<typeof batchStockPageSchema>;

// The reorder report: a variant in a warehouse at or below its reorder level
export const reorderItemSchema = variantRefSchema.extend({
  warehouseId: z.uuid(),
  onHand: z.string(),
  inTransit: z.string(),
  minQuantity: z.string(),
  reorderQuantity: z.string().nullable(),
});
export type ReorderItem = z.infer<typeof reorderItemSchema>;

export const reorderListQuerySchema = pageQuerySchema.extend({ warehouseId: z.uuid().optional() });

export const reorderPageSchema = pageOf(reorderItemSchema);
export type ReorderPage = z.infer<typeof reorderPageSchema>;

// Reorder when the stock in this warehouse falls to minQuantity; order reorderQuantity. Both empty
// = no level. An order size without a level means nothing to anyone.
export const reorderLevelInputSchema = z
  .object({
    warehouseId: z.uuid(),
    variantId: z.uuid(),
    minQuantity: levelSchema,
    reorderQuantity: levelSchema,
  })
  .superRefine((input, ctx) => {
    if (input.reorderQuantity === null) return;
    if (input.minQuantity === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['minQuantity'],
        message: errorCode('reorder_level_required'),
      });
    }
    if (/^0+(?:\.0+)?$/.test(input.reorderQuantity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reorderQuantity'],
        message: errorCode('quantity_format'),
      });
    }
  });
export type ReorderLevelInput = z.infer<typeof reorderLevelInputSchema>;

export const reorderLevelSchema = z.object({
  warehouseId: z.uuid(),
  variantId: z.uuid(),
  minQuantity: z.string().nullable(),
  reorderQuantity: z.string().nullable(),
});

const variantParamsSchema = z.object({ id: z.uuid() });

// Reading stock needs no permission: a sales officer checks it before promising a delivery, a
// cashier before a sale. Cost and value (step 14) will need one.
export const stockRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock',
    summary: 'Stock on hand per variant, in one warehouse or all of them',
    auth: 'bearer',
    status: 200,
    query: stockListQuerySchema,
    response: stockPageSchema,
  }),
  card: defineRoute({
    method: 'GET',
    path: '/stock/variants/:id',
    summary: "One variant's stock per warehouse, batch and serial number",
    auth: 'bearer',
    status: 200,
    params: variantParamsSchema,
    response: stockCardSchema,
  }),
  movements: defineRoute({
    method: 'GET',
    path: '/stock/variants/:id/movements',
    summary: "One variant's stock movements in date order, with the running balance",
    auth: 'bearer',
    status: 200,
    params: variantParamsSchema,
    query: stockMovementQuerySchema,
    response: stockMovementPageSchema,
  }),
  batches: defineRoute({
    method: 'GET',
    path: '/stock/batches',
    summary: 'Batches with stock, the soonest expiry first',
    auth: 'bearer',
    status: 200,
    query: batchStockQuerySchema,
    response: batchStockPageSchema,
  }),
  reorder: defineRoute({
    method: 'GET',
    path: '/stock/reorder',
    summary: 'Variants at or below their reorder level',
    auth: 'bearer',
    status: 200,
    query: reorderListQuerySchema,
    response: reorderPageSchema,
  }),
  setReorderLevel: defineRoute({
    method: 'PUT',
    path: '/stock/reorder-levels',
    summary: "Set or clear a variant's reorder level in a warehouse",
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    body: reorderLevelInputSchema,
    response: reorderLevelSchema,
  }),
};
```

- **`MOVEMENT_KINDS` and `kind: z.string()`** — the same rule as journal sources and account purposes: a newer
  server's new kind (a sales delivery, step 15) must not break an older offline client's parse. The app narrows it
  with `isMovementKind()`.
- **Two line shapes, one set of rules.** `stockLineFieldsSchema` is a line that takes stock out or moves it (it
  names a batch); `stockInLineFieldsSchema` adds the lot and its dates for a line that brings stock in. They stay
  plain objects so adjustments and transfers can build on them; `stockLineRules()` and `documentSerialRules()` are
  the refinements, applied by each document (Zod 4 refuses `.extend()` on a refined schema — step 12's lesson).
- **The rules are generic** (`<T extends LineFields>`): Zod's `RefinementCtx<T>` must be the schema's own output
  type, and each document's line has a different one.
- **Contract rules vs. server rules.** The contract can only check what the line itself says: each serial number
  once, a batch that expires after it was made, the same IMEI not on two lines. Whether the product is batch
  tracked, whether the unit is one of its packs, whether there is enough stock — only the server knows that.
- **`stockItemSchema`** is one row of the stock list *and* of the picker. It carries the product's packs
  (`units`), its tracking and `archived`, so a document line can be drawn without fetching the product.
- **`stockLineSchema`** is a saved line: what was typed, the base quantity, and enough of the product to edit it
  again (the packs, the tracking). The lot and expiry come from the batch once it exists.
- **`stockCardSchema.serials`** lists serial numbers in stock *and* those on a truck (`warehouseId: null`): a
  serial number is never just "gone" while it is still the company's.
- **`reorderLevelInputSchema`**: an order quantity without a level means nothing, and an order of zero is refused.
  Both empty = clear the level.
- **Reading stock needs no permission** (a sales officer checks it before promising a delivery). Setting a reorder
  level needs `inventory.product.manage`: it is planning data about the product, like its price.

### `packages/contracts/src/stock-adjustments.ts` (new)

`packages/contracts/src/stock-adjustments.ts`:

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import {
  documentSerialRules,
  MAX_STOCK_LINES,
  stockInLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// A stock adjustment brings stock into one warehouse or takes it out, for a reason that is not a
// sale or a purchase: the opening stock on the first day, goods found in a count, a damaged carton,
// an expired batch, physician samples. Like a journal entry: a draft can be changed, a posted one
// is in the stock ledger for good, and a mistake is fixed by another adjustment.
export const ADJUSTMENT_DIRECTIONS = ['in', 'out'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export const ADJUSTMENT_REASONS = [
  'opening',
  'found',
  'damaged',
  'expired',
  'lost',
  'sample',
  'internal_use',
  'correction',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

// Which way each reason moves stock. A correction goes either way; the rest say it themselves —
// nobody "finds" stock that leaves, or "damages" stock into a warehouse.
export const REASON_DIRECTIONS = {
  opening: ['in'],
  found: ['in'],
  damaged: ['out'],
  expired: ['out'],
  lost: ['out'],
  sample: ['out'],
  internal_use: ['out'],
  correction: ['in', 'out'],
} as const satisfies Record<AdjustmentReason, readonly AdjustmentDirection[]>;

export function reasonFits(reason: AdjustmentReason, direction: AdjustmentDirection): boolean {
  const allowed: readonly AdjustmentDirection[] = REASON_DIRECTIONS[reason];
  return allowed.includes(direction);
}

export function isAdjustmentReason(value: string): value is AdjustmentReason {
  return ADJUSTMENT_REASONS.some((reason) => reason === value);
}

export function isAdjustmentDirection(value: string): value is AdjustmentDirection {
  return ADJUSTMENT_DIRECTIONS.some((direction) => direction === value);
}

export const STOCK_DOCUMENT_STATUSES = ['draft', 'posted'] as const;
export type StockDocumentStatus = (typeof STOCK_DOCUMENT_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const stockAdjustmentSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: the number is given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  warehouseId: z.uuid(),
  // z.string(): the rule of every list the server may grow
  direction: z.string(),
  reason: z.string(),
  note: z.string().nullable(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StockAdjustmentSummary = z.infer<typeof stockAdjustmentSummarySchema>;

export const stockAdjustmentSchema = stockAdjustmentSummarySchema.extend({
  lines: z.array(stockLineSchema),
});
export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const adjustmentLineInputSchema = stockInLineFieldsSchema.superRefine(stockLineRules);

const stockAdjustmentFieldsSchema = z.object({
  date: z.iso.date(errorCode('stock_date_required')),
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  direction: z.enum(ADJUSTMENT_DIRECTIONS),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: optionalText(300),
  lines: z
    .array(adjustmentLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = the form's "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type AdjustmentRuleInput = z.output<typeof stockAdjustmentFieldsSchema>;

function adjustmentRules(input: AdjustmentRuleInput, ctx: z.RefinementCtx<AdjustmentRuleInput>) {
  if (!reasonFits(input.reason, input.direction)) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: errorCode('adjustment_reason_direction'),
    });
  }
  documentSerialRules(input, ctx);
}

export const stockAdjustmentInputSchema = stockAdjustmentFieldsSchema.superRefine(adjustmentRules);
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentInputSchema>;

export const updateStockAdjustmentInputSchema = stockAdjustmentFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(adjustmentRules);
export type UpdateStockAdjustmentInput = z.infer<typeof updateStockAdjustmentInputSchema>;
export type StockAdjustmentFormValues = z.input<typeof updateStockAdjustmentInputSchema>;

export const stockAdjustmentVersionInputSchema = z.object({ version: versionSchema });

export const deleteStockAdjustmentQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const stockAdjustmentListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  warehouseId: z.uuid().optional(),
});

export const stockAdjustmentPageSchema = pageOf(stockAdjustmentSummarySchema);

const adjustmentParamsSchema = z.object({ id: z.uuid() });

export const stockAdjustmentRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock-adjustments',
    summary: 'Stock adjustments, newest date first',
    auth: 'bearer',
    status: 200,
    query: stockAdjustmentListQuerySchema,
    response: stockAdjustmentPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/stock-adjustments/:id',
    summary: 'One stock adjustment with its lines',
    auth: 'bearer',
    status: 200,
    params: adjustmentParamsSchema,
    response: stockAdjustmentSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/stock-adjustments',
    summary: 'Write a stock adjustment as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 201,
    body: stockAdjustmentInputSchema,
    response: stockAdjustmentSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/stock-adjustments/:id',
    summary: 'Change a draft adjustment, and optionally post it',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 200,
    params: adjustmentParamsSchema,
    body: updateStockAdjustmentInputSchema,
    response: stockAdjustmentSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/stock-adjustments/:id',
    summary: 'Delete a draft adjustment',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 204,
    params: adjustmentParamsSchema,
    query: deleteStockAdjustmentQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/stock-adjustments/:id/post',
    summary: 'Post a draft adjustment: it gets its number and moves the stock',
    auth: 'bearer',
    permission: 'inventory.stock.adjust',
    status: 200,
    params: adjustmentParamsSchema,
    body: stockAdjustmentVersionInputSchema,
    response: stockAdjustmentSchema,
  }),
};
```

- **`REASON_DIRECTIONS` with `satisfies`** — a new reason does not compile until it says which way it moves stock.
  `reasonFits()` reads it through a widened type (`readonly AdjustmentDirection[]`): `includes()` on the narrow
  tuple type would refuse the other direction as an argument.
- **The fields schema and the rules are separate** so the update schema can add `version` and run the same rules
  (`adjustmentRules`): the create and update bodies can never drift apart.
- **`post: boolean`** — "Save and post" is one request, all or nothing, like the journal: a refused post leaves no
  half-saved draft behind.
- **`direction` and `reason` are `z.string()` in the response** for the offline-client rule; the request side is
  strict (`z.enum`).

### `packages/contracts/src/stock-transfers.ts` (new)

`packages/contracts/src/stock-transfers.ts`:

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { receivedQuantitySchema } from './quantities.js';
import {
  documentSerialRules,
  MAX_SERIALS_PER_LINE,
  MAX_STOCK_LINES,
  serialNumberSchema,
  stockLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// Stock moving between two warehouses, in two steps (you chose this): "Send" takes it out of the
// source and puts it in transit; "Receive" at the destination adds what arrived. A truck from the
// Gazipur factory to the Chattogram depot is on the road for a day — in those hours the stock is
// in neither warehouse, and the transfer says where it is. What did not arrive stays a shortage on
// the transfer (step 14 values it as a loss).
export const TRANSFER_STATUSES = ['draft', 'in_transit', 'received'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const transferLineSchema = stockLineSchema.extend({
  // Set on receipt, in the base unit; null until then
  receivedQuantity: z.string().nullable(),
  receivedSerialNumbers: z.array(z.string()).nullable(),
});
export type TransferLine = z.infer<typeof transferLineSchema>;

export const stockTransferSummarySchema = z.object({
  id: z.uuid(),
  // Given when it is sent
  number: z.string().nullable(),
  status: z.enum(TRANSFER_STATUSES),
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  // The day it leaves (the draft's planned day until then)
  sentOn: z.iso.date(),
  receivedOn: z.iso.date().nullable(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  // Received less than was sent, on any line
  short: z.boolean(),
  sentAt: z.iso.datetime().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StockTransferSummary = z.infer<typeof stockTransferSummarySchema>;

export const stockTransferSchema = stockTransferSummarySchema.extend({
  lines: z.array(transferLineSchema),
});
export type StockTransfer = z.infer<typeof stockTransferSchema>;

// ---------------------------------------------------------------------------------------------
// What the forms send

const transferLineInputSchema = stockLineFieldsSchema.superRefine(stockLineRules);

const stockTransferFieldsSchema = z.object({
  fromWarehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  toWarehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  date: z.iso.date(errorCode('stock_date_required')),
  note: optionalText(300),
  lines: z
    .array(transferLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Send": save and send in one step
  send: z.boolean(),
});

type TransferRuleInput = z.output<typeof stockTransferFieldsSchema>;

function transferRules(input: TransferRuleInput, ctx: z.RefinementCtx<TransferRuleInput>) {
  if (input.fromWarehouseId === input.toWarehouseId) {
    ctx.addIssue({
      code: 'custom',
      path: ['toWarehouseId'],
      message: errorCode('transfer_same_warehouse'),
    });
  }
  documentSerialRules(input, ctx);
}

export const stockTransferInputSchema = stockTransferFieldsSchema.superRefine(transferRules);
export type StockTransferInput = z.infer<typeof stockTransferInputSchema>;

export const updateStockTransferInputSchema = stockTransferFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(transferRules);
export type UpdateStockTransferInput = z.infer<typeof updateStockTransferInputSchema>;
export type StockTransferFormValues = z.input<typeof updateStockTransferInputSchema>;

// The receipt: every line once, with what arrived. In the base unit, so "9 cartons and 6 pieces"
// is one number (222 pcs), and never more than was sent.
export const receiveTransferInputSchema = z
  .object({
    version: versionSchema,
    date: z.iso.date(errorCode('stock_date_required')),
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          receivedQuantity: receivedQuantitySchema,
          // A serial line: the serial numbers that arrived, a part of the ones sent
          serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
        }),
      )
      .min(1)
      .max(MAX_STOCK_LINES),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.lines.forEach((line, index) => {
      if (seen.has(line.lineId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'lineId'],
          message: errorCode('transfer_lines_mismatch'),
        });
      }
      seen.add(line.lineId);
    });
  });
export type ReceiveTransferInput = z.infer<typeof receiveTransferInputSchema>;
export type ReceiveTransferFormValues = z.input<typeof receiveTransferInputSchema>;

export const stockTransferVersionInputSchema = z.object({ version: versionSchema });

export const deleteStockTransferQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const stockTransferListQuerySchema = pageQuerySchema.extend({
  status: z.enum(TRANSFER_STATUSES).optional(),
  // Transfers from or to this warehouse
  warehouseId: z.uuid().optional(),
});

export const stockTransferPageSchema = pageOf(stockTransferSummarySchema);

const transferParamsSchema = z.object({ id: z.uuid() });

export const stockTransferRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock-transfers',
    summary: 'Stock transfers, newest first',
    auth: 'bearer',
    status: 200,
    query: stockTransferListQuerySchema,
    response: stockTransferPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/stock-transfers/:id',
    summary: 'One stock transfer with its lines',
    auth: 'bearer',
    status: 200,
    params: transferParamsSchema,
    response: stockTransferSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/stock-transfers',
    summary: 'Write a transfer as a draft, or write and send it in one step',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 201,
    body: stockTransferInputSchema,
    response: stockTransferSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/stock-transfers/:id',
    summary: 'Change a draft transfer, and optionally send it',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 200,
    params: transferParamsSchema,
    body: updateStockTransferInputSchema,
    response: stockTransferSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/stock-transfers/:id',
    summary: 'Delete a draft transfer',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 204,
    params: transferParamsSchema,
    query: deleteStockTransferQuerySchema,
    response: z.void(),
  }),
  send: defineRoute({
    method: 'POST',
    path: '/stock-transfers/:id/send',
    summary: 'Send a draft transfer: the stock leaves the source and is in transit',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 200,
    params: transferParamsSchema,
    body: stockTransferVersionInputSchema,
    response: stockTransferSchema,
  }),
  receive: defineRoute({
    method: 'POST',
    path: '/stock-transfers/:id/receive',
    summary: 'Receive a transfer at its destination: what arrived is added there',
    auth: 'bearer',
    permission: 'inventory.stock.transfer',
    status: 200,
    params: transferParamsSchema,
    body: receiveTransferInputSchema,
    response: stockTransferSchema,
  }),
};
```

- **`short: boolean` on the summary** so the list can show a "Short" pill without loading the lines.
- **The receipt is in the base unit.** "9 cartons and 6 pieces arrived" is one number (222 pcs); a receipt in the
  sent unit could not say it.
- **Every line exactly once** (`transfer_lines_mismatch`): a receipt that left a line out would leave it in transit
  for ever. The contract catches a line sent twice; the server catches a missing line.
- **The same-warehouse rule sits on `toWarehouseId`**, the field the person changes to fix it.

### Changes to existing contract files

`packages/contracts/src/permissions.ts` (changed):

```diff
@@ -16,6 +16,9 @@ export const PERMISSION_KEYS = [
   'accounting.period.close',
   'accounting.report.read',
   'inventory.product.manage',
+  'inventory.warehouse.manage',
+  'inventory.stock.adjust',
+  'inventory.stock.transfer',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -46,4 +49,7 @@ export const PERMISSION_GROUP_OF = {
   'accounting.period.close': 'accounting',
   'accounting.report.read': 'accounting',
   'inventory.product.manage': 'inventory',
+  'inventory.warehouse.manage': 'inventory',
+  'inventory.stock.adjust': 'inventory',
+  'inventory.stock.transfer': 'inventory',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

Three keys, all in the `inventory` group of the permission matrix. `PERMISSION_GROUP_OF` is
`satisfies Record<PermissionKey, …>`, so forgetting the group does not compile.

`packages/contracts/src/errors.ts` (changed):

```diff
@@ -168,6 +168,48 @@ export const ERROR_CODES = [
   'import_category_invalid',
   'import_value_invalid',
   'import_options_without_code',
+  // warehouses and stock (step 13)
+  'warehouse_code_format',
+  'warehouse_code_taken',
+  'warehouse_name_required',
+  'warehouse_branch_invalid',
+  'warehouse_branch_locked',
+  'warehouse_has_stock',
+  'warehouse_has_transfers',
+  'branch_has_warehouses',
+  'quantity_format',
+  'serial_number_format',
+  'stock_date_required',
+  'stock_date_future',
+  'stock_warehouse_invalid',
+  'stock_lines_required',
+  'stock_variant_required',
+  'stock_variant_invalid',
+  'stock_unit_invalid',
+  'stock_quantity_decimals',
+  'stock_lot_required',
+  'stock_expiry_required',
+  'stock_batch_dates',
+  'stock_batch_required',
+  'stock_batch_invalid',
+  'stock_batch_expiry_mismatch',
+  'stock_serial_count',
+  'stock_serial_twice',
+  'stock_serial_in_stock',
+  'stock_serial_not_here',
+  'stock_insufficient',
+  'stock_not_draft',
+  'adjustment_reason_direction',
+  'transfer_same_warehouse',
+  'transfer_not_in_transit',
+  'transfer_lines_mismatch',
+  'transfer_receive_too_many',
+  'transfer_receive_date',
+  'transfer_serial_not_sent',
+  'reorder_level_required',
+  'product_base_unit_locked',
+  'product_tracking_locked',
+  'product_type_locked',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

Forty-one codes. Each needs its text in `en.ts` and `bn.ts`, or the type check fails (`satisfies
Record<ErrorCode, string>`).

`packages/contracts/src/audit.ts` (changed):

```diff
@@ -62,6 +62,20 @@ export const AUDIT_ACTIONS = [
   'product.restored',
   'product.deleted',
   'product.imported',
+  'warehouse.created',
+  'warehouse.updated',
+  'warehouse.archived',
+  'warehouse.restored',
+  'stock_adjustment.created',
+  'stock_adjustment.updated',
+  'stock_adjustment.deleted',
+  'stock_adjustment.posted',
+  'stock_transfer.created',
+  'stock_transfer.updated',
+  'stock_transfer.deleted',
+  'stock_transfer.sent',
+  'stock_transfer.received',
+  'reorder_level.changed',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -86,6 +100,10 @@ export const AUDIT_ENTITY_TYPES = [
   'custom_field',
   'product',
   'product_import',
+  'warehouse',
+  'stock_adjustment',
+  'stock_transfer',
+  'reorder_level',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
```

`packages/contracts/src/notifications.ts` (changed):

```diff
@@ -8,6 +8,7 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // report.ready / report.failed: params { report, format } — the export the person asked for
 // import.done: params { file, count } — count = products made; import.failed: { file, count } —
 // count = problems found
+// stock.low: params { warehouse, count } — count = variants that fell to their reorder level
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -16,6 +17,7 @@ export const NOTIFICATION_TYPES = [
   'report.failed',
   'import.done',
   'import.failed',
+  'stock.low',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
```

`packages/contracts/src/numbering.ts` (changed):

```diff
@@ -13,6 +13,8 @@ export const DOCUMENT_TYPES = [
   'inventory.receipt',
   'accounting.journal',
   'inventory.product',
+  'inventory.adjustment',
+  'inventory.transfer',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -34,6 +36,8 @@ const DEFAULT_PREFIXES = {
   'inventory.receipt': 'GRN',
   'accounting.journal': 'JV',
   'inventory.product': 'P',
+  'inventory.adjustment': 'ADJ',
+  'inventory.transfer': 'TRF',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
```

The two new document types number by fiscal year (`ADJ-2026-27-0001`), the default for every document except
product codes.

`packages/contracts/src/settings.ts` (changed):

```diff
@@ -63,6 +63,11 @@ export const settingsSchema = z.object({
   timezone: z.string(),
   // url: কিছুক্ষণের জন্য সই করা (presigned) ঠিকানা — <img src>-এ সরাসরি বসে
   logo: z.object({ attachmentId: z.uuid(), url: z.url() }).nullable(),
+  // Off (the default): stock never goes below zero — a sale or an adjustment that takes more than
+  // is there is refused. On: an untracked product may go negative (the shelf had it, the books
+  // did not yet). Batches and serial numbers never go negative: a batch or an IMEI either is in
+  // the warehouse or is not.
+  allowNegativeStock: z.boolean(),
   version: z.number().int(),
 });
 export type Settings = z.infer<typeof settingsSchema>;
@@ -79,6 +84,7 @@ export const updateSettingsInputSchema = z.object({
   baseCurrency: z.enum(CURRENCIES),
   fiscalYearStartMonth: z.number().int().min(1).max(12),
   timezone: z.string().refine(isTimeZone, errorCode('timezone_invalid')),
+  allowNegativeStock: z.boolean(),
 });
 export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;
```

`allowNegativeStock` is in the settings **and** in the update body: it is saved with the rest of the settings form.
Every client that sends the settings `PUT` now has to send it (the tests in 13.5 do).

`packages/contracts/src/routes.ts` (changed):

```diff
@@ -20,7 +20,11 @@ import { productRoutes } from './products.js';
 import { roleRoutes } from './roles.js';
 import { settingsRoutes } from './settings.js';
 import { setupRoutes } from './setup.js';
+import { stockAdjustmentRoutes } from './stock-adjustments.js';
+import { stockTransferRoutes } from './stock-transfers.js';
+import { stockRoutes } from './stock.js';
 import { unitRoutes } from './units.js';
+import { warehouseRoutes } from './warehouses.js';
 
 export const healthRoutes = {
   check: defineRoute({
@@ -62,4 +66,8 @@ export const routes = {
   customFields: customFieldRoutes,
   products: productRoutes,
   productImports: productImportRoutes,
+  warehouses: warehouseRoutes,
+  stock: stockRoutes,
+  stockAdjustments: stockAdjustmentRoutes,
+  stockTransfers: stockTransferRoutes,
 };
```

`packages/contracts/src/index.ts` (changed):

```diff
@@ -19,9 +19,14 @@ export * from './preferences.js';
 export * from './product-categories.js';
 export * from './product-imports.js';
 export * from './products.js';
+export * from './quantities.js';
 export * from './reports.js';
 export * from './roles.js';
 export * from './routes.js';
 export * from './settings.js';
 export * from './setup.js';
+export * from './stock.js';
+export * from './stock-adjustments.js';
+export * from './stock-transfers.js';
 export * from './units.js';
+export * from './warehouses.js';
```

### Tests: `quantities.spec.ts`, `stock.spec.ts` (new), `settings.spec.ts`

`packages/contracts/src/quantities.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  addQuantity,
  compareQuantity,
  fitsDecimals,
  isQuantity,
  levelSchema,
  negateQuantity,
  plainQuantity,
  receivedQuantitySchema,
  subtractQuantity,
  sumQuantity,
  toBaseQuantity,
  wholeCount,
} from './quantities.js';

describe('quantities', () => {
  it('accepts positive quantities with up to 4 decimals', () => {
    expect(['1', '0.5', '1.2500', '9999999999999.9999'].every(isQuantity)).toBe(true);
    expect(['0', '0.0000', '-1', '1.23456', '1e3', '', ' 1'].some(isQuantity)).toBe(false);
  });

  it('adds and subtracts exactly, in Postgres’s 4-decimal shape', () => {
    // 0.1 + 0.2 kg: exactly 0.3, not 0.30000000000000004
    expect(addQuantity('0.1', '0.2')).toBe('0.3000');
    expect(subtractQuantity('10', '12.5')).toBe('-2.5000');
    expect(sumQuantity(['72.0000', '-2', '-4'])).toBe('66.0000');
    expect(negateQuantity('0')).toBe('0.0000');
    expect(compareQuantity('10.0000', '12')).toBe(-1);
    expect(compareQuantity('12', '12.0000')).toBe(0);
  });

  it('turns a pack into base units, rounded to the base unit’s decimals', () => {
    // 3 cases of 24 pieces
    expect(toBaseQuantity('3', '24.000000', 0)).toBe('72.0000');
    // 3 yards in metres (2 decimals): 2.7432 → 2.74
    expect(toBaseQuantity('3', '0.914400', 2)).toBe('2.7400');
    // Half up: 1 yard = 0.9144 → 0.91; 5 yards = 4.572 → 4.57; 0.5 yard = 0.4572 → 0.46
    expect(toBaseQuantity('0.5', '0.914400', 2)).toBe('0.4600');
    // A kilo bag in kg with 3 decimals stays exact
    expect(toBaseQuantity('1.25', '50', 3)).toBe('62.5000');
  });

  it('knows when a quantity has more decimals than its unit allows', () => {
    expect(fitsDecimals('1.50', 1)).toBe(true);
    expect(fitsDecimals('1.25', 1)).toBe(false);
    expect(fitsDecimals('3.0000', 0)).toBe(true);
    expect(fitsDecimals('1.5', 0)).toBe(false);
  });

  it('counts whole items and writes a quantity plainly', () => {
    expect(wholeCount('3.0000')).toBe(3);
    expect(plainQuantity('24.0000')).toBe('24');
    expect(plainQuantity('2.7400')).toBe('2.74');
    expect(plainQuantity('-5.0000')).toBe('-5');
    expect(plainQuantity('0.0000')).toBe('0');
  });

  it('reads levels and received quantities, where zero is a real answer', () => {
    expect(levelSchema.parse('')).toBeNull();
    expect(levelSchema.parse('0')).toBe('0');
    expect(receivedQuantitySchema.safeParse('0').success).toBe(true);
    expect(receivedQuantitySchema.safeParse('').success).toBe(false);
  });
});
```

The rounding cases are the ones a garments store meets: whole cases, yards in metres (2.7432 → 2.74), and half a
yard (0.4572 → 0.46, half up).

`packages/contracts/src/stock.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import { reasonFits, stockAdjustmentInputSchema } from './stock-adjustments.js';
import { receiveTransferInputSchema, stockTransferInputSchema } from './stock-transfers.js';
import { reorderLevelInputSchema } from './stock.js';

const WAREHOUSE = '01920000-0000-7000-8000-000000000001';
const DEPOT = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';

function line(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '2',
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function adjustment(extra: object = {}) {
  return {
    date: '2026-10-01',
    warehouseId: WAREHOUSE,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines: [line()],
    post: true,
    ...extra,
  };
}

// The error codes where the form will show them: field path → code
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('stock adjustment input', () => {
  it('turns the form’s empty boxes into nulls', () => {
    const parsed = stockAdjustmentInputSchema.parse(adjustment({ note: '  ' }));
    expect(parsed.note).toBeNull();
    expect(parsed.lines[0]).toMatchObject({ batchId: null, lotNumber: null, expiresOn: null });
  });

  it('keeps each reason to its direction', () => {
    expect(reasonFits('opening', 'in')).toBe(true);
    expect(reasonFits('damaged', 'in')).toBe(false);
    expect(reasonFits('correction', 'out')).toBe(true);
    const result = stockAdjustmentInputSchema.safeParse(
      adjustment({ direction: 'out', reason: 'found' }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({ reason: 'adjustment_reason_direction' });
  });

  it('refuses zero, a batch that expires before it was made, and an IMEI twice', () => {
    const result = stockAdjustmentInputSchema.safeParse(
      adjustment({
        lines: [
          line({ quantity: '0' }),
          line({ manufacturedOn: '2026-09-01', expiresOn: '2026-08-01' }),
          line({ quantity: '2', serialNumbers: ['356938035643809', '356938035643809'] }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      'lines.0.quantity': 'quantity_format',
      'lines.1.expiresOn': 'stock_batch_dates',
      'lines.2.serialNumbers.1': 'stock_serial_twice',
    });
  });

  it('refuses the same serial number on two lines', () => {
    const result = stockAdjustmentInputSchema.safeParse(
      adjustment({
        lines: [
          line({ quantity: '1', serialNumbers: ['SN-1'] }),
          line({ quantity: '1', serialNumbers: ['SN-1'] }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('needs at least one line', () => {
    const result = stockAdjustmentInputSchema.safeParse(adjustment({ lines: [] }), {
      error: contractErrorMap,
    });
    expect(errorsOf(result)).toEqual({ lines: 'stock_lines_required' });
  });
});

describe('stock transfer input', () => {
  it('refuses a transfer to the warehouse it comes from', () => {
    const result = stockTransferInputSchema.safeParse(
      {
        fromWarehouseId: WAREHOUSE,
        toWarehouseId: WAREHOUSE,
        date: '2026-10-02',
        note: '',
        lines: [
          { variantId: VARIANT, unitId: UNIT, quantity: '1', batchId: '', serialNumbers: [] },
        ],
        send: true,
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({ toWarehouseId: 'transfer_same_warehouse' });
    expect(
      stockTransferInputSchema.safeParse({
        fromWarehouseId: WAREHOUSE,
        toWarehouseId: DEPOT,
        date: '2026-10-02',
        note: '',
        lines: [
          { variantId: VARIANT, unitId: UNIT, quantity: '1', batchId: '', serialNumbers: [] },
        ],
        send: true,
      }).success,
    ).toBe(true);
  });

  it('receives every line once, zero included', () => {
    const lineId = '01920000-0000-7000-8000-000000000009';
    expect(
      receiveTransferInputSchema.safeParse({
        version: 2,
        date: '2026-10-03',
        lines: [{ lineId, receivedQuantity: '0', serialNumbers: [] }],
      }).success,
    ).toBe(true);
    const twice = receiveTransferInputSchema.safeParse(
      {
        version: 2,
        date: '2026-10-03',
        lines: [
          { lineId, receivedQuantity: '1', serialNumbers: [] },
          { lineId, receivedQuantity: '1', serialNumbers: [] },
        ],
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(twice)).toEqual({ 'lines.1.lineId': 'transfer_lines_mismatch' });
  });
});

describe('reorder level input', () => {
  it('needs a level before an order size, and an order of more than nothing', () => {
    const base = { warehouseId: WAREHOUSE, variantId: VARIANT };
    expect(
      reorderLevelInputSchema.parse({ ...base, minQuantity: '', reorderQuantity: '' }),
    ).toMatchObject({
      minQuantity: null,
      reorderQuantity: null,
    });
    expect(
      errorsOf(
        reorderLevelInputSchema.safeParse({ ...base, minQuantity: '', reorderQuantity: '48' }),
      ),
    ).toEqual({ minQuantity: 'reorder_level_required' });
    expect(
      errorsOf(
        reorderLevelInputSchema.safeParse({ ...base, minQuantity: '12', reorderQuantity: '0' }),
      ),
    ).toEqual({ reorderQuantity: 'quantity_format' });
  });
});
```

`errorsOf()` turns Zod's issues into "field path → code", the same thing the form will show. The tests check the
*path* of each error, not only that parsing failed: an error on the wrong field is a bug the person sees.

`packages/contracts/src/settings.spec.ts` (changed):

```diff
@@ -15,6 +15,7 @@ const valid = {
   baseCurrency: 'BDT',
   fiscalYearStartMonth: 7,
   timezone: 'Asia/Dhaka',
+  allowNegativeStock: false,
 } as const;
 
 describe('settings input', () => {
```

---

## 13.2 — `packages/db`: eight tables and two migrations

### `packages/db/src/schema/warehouses.ts` (new)

`packages/db/src/schema/warehouses.ts`:

```ts
import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { tenants } from './tenants.js';

// A place that holds stock, inside a branch (step 13). Archived, never deleted: its movements stay
// in the stock ledger and point at it. deleted_at (from baseColumns) is not used, like branches.
export const warehouses = pgTable(
  'warehouses',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // An archived warehouse keeps its code: "FAB" in an old stock card means one place
    uniqueIndex('warehouses_tenant_code_idx').on(table.tenantId, table.code),
    // The target of the composite FKs from movements, balances, documents and serials
    uniqueIndex('warehouses_tenant_id_idx').on(table.tenantId, table.id),
    // A branch's warehouses — and Postgres's own check of the FK below
    index('warehouses_tenant_branch_idx').on(table.tenantId, table.branchId),
    foreignKey({
      name: 'warehouses_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);
```

- **`warehouses_tenant_id_idx (tenant_id, id)`** is the target of every composite foreign key below. A movement,
  a balance, a document or a serial number can only point at a warehouse *of the same tenant* — Postgres checks
  foreign keys without RLS, so this is what stops a cross-tenant reference at the database.
- **The code is unique even when archived**: "FAB" in a two-year-old stock card means one place.

### `packages/db/src/schema/stock.ts` (new)

`packages/db/src/schema/stock.ts`:

```ts
import { MOVEMENT_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches, serials } from './batches.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// The stock ledger (build plan step 13): one row per change of stock, never updated, never
// deleted (migration 0022's trigger). Stock is the sum of these rows — there is no quantity column
// on products, and there never will be (system design §17, mistake 6). A posted document writes
// its rows once; a mistake is fixed by another document, like a journal entry.
export const stockMovements = pgTable(
  'stock_movements',
  {
    // UUIDv7: ordered by the time the row was written — the stock card's tie-break inside a day
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // The business date of the document, without time or time zone
    date: date('date', { mode: 'string' }).notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // A batch-tracked product: always a batch. A serial-tracked one: one row per serial number.
    batchId: uuid('batch_id'),
    serialId: uuid('serial_id'),
    // In the product's base unit: + in, − out. NUMERIC(19,4), a string in TypeScript.
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    kind: text('kind', { enum: MOVEMENT_KINDS }).notNull(),
    // The document that made it (an adjustment or a transfer) and its number at the time: a
    // posted document's number never changes, so the stock card needs no join to show it
    documentId: uuid('document_id').notNull(),
    documentNumber: text('document_number').notNull(),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    // The stock card: one variant's rows in date order (keyset on date, id)
    index('stock_movements_variant_date_idx').on(
      table.tenantId,
      table.variantId,
      table.date,
      table.id,
    ),
    // "Does this product have stock history?" (ProductsService) and the variant FK's own check
    index('stock_movements_product_idx').on(table.tenantId, table.productId, table.variantId),
    index('stock_movements_warehouse_idx').on(table.tenantId, table.warehouseId),
    index('stock_movements_document_idx').on(table.tenantId, table.documentId),
    // No ON DELETE: a variant with movements cannot be deleted, so neither can its product (the
    // API turns this FK's error into product_in_use / product_variant_in_use)
    foreignKey({
      name: 'stock_movements_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_movements_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // variant_id is in both keys: the batch and the serial are always of this variant
    foreignKey({
      name: 'stock_movements_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    foreignKey({
      name: 'stock_movements_serial_fk',
      columns: [table.tenantId, table.variantId, table.serialId],
      foreignColumns: [serials.tenantId, serials.variantId, serials.id],
    }),
    check('stock_movements_quantity_check', sql`${table.quantity} <> 0`),
    check(
      'stock_movements_serial_check',
      sql`${table.serialId} IS NULL OR ${table.quantity} IN (1, -1)`,
    ),
  ],
);

// What is in each warehouse right now, per variant and batch: the sum of the movements, kept by
// the database itself (migration 0022's trigger adds every new movement here, in the same
// transaction). Code never writes it. It exists for two reasons: reading stock must not add up
// years of movements, and the row is what two people taking the last carton at the same time
// queue on (a row lock), so the second one sees the first one's result.
export const stockBalances = pgTable(
  'stock_balances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    warehouseId: uuid('warehouse_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // NULL for a product without batches
    batchId: uuid('batch_id'),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per place. NULLS NOT DISTINCT: without it, two rows with batch_id NULL would not
    // collide, and an untracked variant could get two balances in one warehouse.
    unique('stock_balances_key')
      .on(table.tenantId, table.warehouseId, table.variantId, table.batchId)
      .nullsNotDistinct(),
    // A variant's stock in every warehouse (the stock list, the card)
    index('stock_balances_variant_idx').on(table.tenantId, table.variantId),
    foreignKey({
      name: 'stock_balances_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_balances_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'stock_balances_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
  ],
);

// When to order more: per variant and warehouse (a depot keeps more Napa than a shop does)
export const reorderLevels = pgTable(
  'reorder_levels',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    warehouseId: uuid('warehouse_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // Reorder when the stock here falls to this (zero = "when it runs out")
    minQuantity: numeric('min_quantity', { precision: 19, scale: 4 }).notNull(),
    // How much to order then; NULL = the person decides each time
    reorderQuantity: numeric('reorder_quantity', { precision: 19, scale: 4 }),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
  },
  (table) => [
    uniqueIndex('reorder_levels_key_idx').on(table.tenantId, table.warehouseId, table.variantId),
    index('reorder_levels_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // A variant that is deleted (never had stock) takes its levels with it
    foreignKey({
      name: 'reorder_levels_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'reorder_levels_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check('reorder_levels_min_check', sql`${table.minQuantity} >= 0`),
    check(
      'reorder_levels_quantity_check',
      sql`${table.reorderQuantity} IS NULL OR ${table.reorderQuantity} > 0`,
    ),
  ],
);
```

- **`stock_movements.id` is UUIDv7**: ordered by the moment it was written. The stock card sorts by
  `(date, id)`, so two movements on one day keep the order they happened in, and the keyset cursor is stable.
- **`document_number` is copied onto the row.** A posted document's number never changes, so the stock card shows
  "ADJ-2026-27-0004" without joining two document tables (and, later, every module's documents).
- **No `ON DELETE` on the variant foreign keys** of movements and balances: a variant with history cannot be
  deleted, so its product cannot either. `reorder_levels` *does* cascade: a variant that never had stock may be
  deleted, and its levels mean nothing without it.
- **The batch and serial foreign keys include `variant_id`** (`(tenant_id, variant_id, batch_id)`): a movement can
  never point at another variant's batch, even if the code had a bug.
- **`stock_balances_key` is `NULLS NOT DISTINCT`.** An untracked variant's balance has `batch_id NULL`. With a plain
  unique constraint, two `NULL`s never collide, and one warehouse could hold two balance rows for the same variant
  — the `ON CONFLICT` upsert in the trigger would never find the first one. Postgres 15+ has `NULLS NOT DISTINCT`;
  Drizzle writes it with `.nullsNotDistinct()` on a `unique()` constraint.
- **Two checks on movements**: never zero, and a serial row moves exactly one unit.

### `packages/db/src/schema/stock-documents.ts` (new)

`packages/db/src/schema/stock-documents.ts`:

```ts
import {
  ADJUSTMENT_DIRECTIONS,
  ADJUSTMENT_REASONS,
  STOCK_DOCUMENT_STATUSES,
  TRANSFER_STATUSES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// The columns every stock document line has: which variant, in which unit and how many, and the
// same quantity in the base unit. The factor is copied from the product at the time (1 for the
// base unit): removing or resizing a pack later never changes what an old line meant.
function lineColumns() {
  return {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    // As typed: 3 (cartons)
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    // Base units in one of that unit: 24
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    // In the base unit, rounded to its decimals: 72 (pcs)
    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
    // The batch the line takes from (out), or the one it went into (in, set when posted)
    batchId: uuid('batch_id'),
    // One per base unit, for a serial-tracked product
    serialNumbers: text('serial_numbers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  };
}

// ---------------------------------------------------------------------------------------------
// Stock adjustments

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    // deleted_at is not used: a draft is deleted for real, a posted adjustment never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted (NumberingService, 'inventory.adjustment'), so numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    direction: text('direction', { enum: ADJUSTMENT_DIRECTIONS }).notNull(),
    reason: text('reason', { enum: ADJUSTMENT_REASONS }).notNull(),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('stock_adjustments_tenant_id_idx').on(table.tenantId, table.id),
    // Drafts have no number; NULLs never collide
    uniqueIndex('stock_adjustments_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('stock_adjustments_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('stock_adjustments_tenant_warehouse_idx').on(table.tenantId, table.warehouseId),
    foreignKey({
      name: 'stock_adjustments_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ it has a number and a posting time, like a journal entry
    check(
      'stock_adjustments_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

export const stockAdjustmentLines = pgTable(
  'stock_adjustment_lines',
  {
    ...lineColumns(),
    adjustmentId: uuid('adjustment_id').notNull(),
    // An "in" line of a batch product: the lot as typed. Posting finds or makes the batch.
    lotNumber: text('lot_number'),
    expiresOn: date('expires_on', { mode: 'string' }),
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
  },
  (table) => [
    uniqueIndex('stock_adjustment_lines_line_idx').on(
      table.tenantId,
      table.adjustmentId,
      table.lineNo,
    ),
    // A draft's line blocks deleting its variant too (product_variant_in_use): the draft would
    // otherwise point at nothing
    index('stock_adjustment_lines_variant_idx').on(
      table.tenantId,
      table.productId,
      table.variantId,
    ),
    foreignKey({
      name: 'stock_adjustment_lines_adjustment_fk',
      columns: [table.tenantId, table.adjustmentId],
      foreignColumns: [stockAdjustments.tenantId, stockAdjustments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'stock_adjustment_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_adjustment_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'stock_adjustment_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'stock_adjustment_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Stock transfers

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when sent ('inventory.transfer')
    number: text('number'),
    status: text('status', { enum: TRANSFER_STATUSES }).notNull().default('draft'),
    fromWarehouseId: uuid('from_warehouse_id').notNull(),
    toWarehouseId: uuid('to_warehouse_id').notNull(),
    sentOn: date('sent_on', { mode: 'string' }).notNull(),
    receivedOn: date('received_on', { mode: 'string' }),
    note: text('note'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: uuid('sent_by'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: uuid('received_by'),
  },
  (table) => [
    uniqueIndex('stock_transfers_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('stock_transfers_tenant_number_idx').on(table.tenantId, table.number),
    index('stock_transfers_tenant_date_idx').on(table.tenantId, table.sentOn, table.id),
    // What is on the road to a warehouse: the stock list's "in transit"
    index('stock_transfers_in_transit_idx')
      .on(table.tenantId, table.toWarehouseId)
      .where(sql`${table.status} = 'in_transit'`),
    index('stock_transfers_from_idx').on(table.tenantId, table.fromWarehouseId),
    foreignKey({
      name: 'stock_transfers_from_fk',
      columns: [table.tenantId, table.fromWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'stock_transfers_to_fk',
      columns: [table.tenantId, table.toWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check('stock_transfers_places_check', sql`${table.fromWarehouseId} <> ${table.toWarehouseId}`),
    // Sent (in transit or received) ⇔ a number and a sending time; received ⇔ its date and time
    check(
      'stock_transfers_sent_check',
      sql`(${table.status} <> 'draft') = (${table.number} IS NOT NULL AND ${table.sentAt} IS NOT NULL)`,
    ),
    check(
      'stock_transfers_received_check',
      sql`(${table.status} = 'received') = (${table.receivedOn} IS NOT NULL AND ${table.receivedAt} IS NOT NULL)`,
    ),
  ],
);

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    ...lineColumns(),
    transferId: uuid('transfer_id').notNull(),
    // Set on receipt, in the base unit: what arrived. sent − received = the shortage.
    receivedQuantity: numeric('received_quantity', { precision: 19, scale: 4 }),
    receivedSerialNumbers: text('received_serial_numbers').array(),
  },
  (table) => [
    uniqueIndex('stock_transfer_lines_line_idx').on(table.tenantId, table.transferId, table.lineNo),
    index('stock_transfer_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'stock_transfer_lines_transfer_fk',
      columns: [table.tenantId, table.transferId],
      foreignColumns: [stockTransfers.tenantId, stockTransfers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'stock_transfer_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_transfer_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'stock_transfer_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'stock_transfer_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'stock_transfer_lines_received_check',
      sql`${table.receivedQuantity} IS NULL OR ${table.receivedQuantity} BETWEEN 0 AND ${table.baseQuantity}`,
    ),
  ],
);
```

- **`lineColumns()`** is shared by both line tables: the same seven columns mean the same thing in both, and a
  later document (a purchase receipt) can use it too.
- **The factor is copied onto the line.** If someone resizes a carton from 24 to 20 next month, last month's line
  still says 3 cartons = 72 pieces. That is why decision 14 does not lock a product's packs.
- **The `_posted_check` / `_sent_check` / `_received_check` constraints** tie the status to its columns: a posted
  adjustment without a number, or a received transfer without its date, cannot exist, whatever the code does.
- **`stock_transfers_in_transit_idx` is partial** (`WHERE status = 'in_transit'`): "what is on the road to this
  warehouse" reads a handful of rows, however many transfers the company has made.
- **`received_quantity BETWEEN 0 AND base_quantity`** — never more than was sent, checked by the database too.

### Changes to existing schema files

`packages/db/src/schema/batches.ts` (changed):

```diff
@@ -1,12 +1,22 @@
 import { sql } from 'drizzle-orm';
-import { check, date, foreignKey, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
+import {
+  check,
+  date,
+  foreignKey,
+  index,
+  pgTable,
+  text,
+  uniqueIndex,
+  uuid,
+} from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
 import { productVariants } from './products.js';
 import { tenants } from './tenants.js';
+import { warehouses } from './warehouses.js';
 
 // Batches (lots) and serial numbers: the tables exist from step 12 (build plan 0.3), so step 13's
-// stock_movements can point at them from its first line. Nothing writes them yet: a batch is made
-// when goods are received (step 13), a serial when a phone is received or sold.
+// stock_movements point at them from their first row. A batch is made the first time a lot comes
+// in (an adjustment "in", later a purchase receipt); a serial the first time an IMEI does.
 
 export const batches = pgTable(
   'batches',
@@ -33,6 +43,8 @@ export const batches = pgTable(
       table.variantId,
       sql`lower(${table.lotNumber})`,
     ),
+    // The target of the composite FKs from stock rows: a batch of THIS variant (step 13)
+    uniqueIndex('batches_variant_id_idx').on(table.tenantId, table.variantId, table.id),
     foreignKey({
       name: 'batches_variant_fk',
       columns: [table.tenantId, table.productId, table.variantId],
@@ -56,6 +68,9 @@ export const serials = pgTable(
     variantId: uuid('variant_id').notNull(),
     // An IMEI, a machine's serial plate
     serialNumber: text('serial_number').notNull(),
+    // Where it is now: NULL = not in any warehouse (sold, written off, or on a truck in transit).
+    // Kept by migration 0022's trigger from the movements, like stock_balances; code never writes it.
+    warehouseId: uuid('warehouse_id'),
     createdAt: baseColumns().createdAt,
     createdBy: baseColumns().createdBy,
   },
@@ -65,6 +80,14 @@ export const serials = pgTable(
       table.variantId,
       table.serialNumber,
     ),
+    uniqueIndex('serials_variant_id_idx').on(table.tenantId, table.variantId, table.id),
+    // The serial numbers in a warehouse (the stock card)
+    index('serials_warehouse_idx').on(table.tenantId, table.warehouseId, table.variantId),
+    foreignKey({
+      name: 'serials_warehouse_fk',
+      columns: [table.tenantId, table.warehouseId],
+      foreignColumns: [warehouses.tenantId, warehouses.id],
+    }),
     foreignKey({
       name: 'serials_variant_fk',
       columns: [table.tenantId, table.productId, table.variantId],
```

- **`batches_variant_id_idx` and `serials_variant_id_idx`** are new targets for the composite foreign keys from
  the stock tables.
- **`serials.warehouse_id`** says where a serial number is now. Like `stock_balances`, only the trigger writes it.

`packages/db/src/schema/tenant-settings.ts` (changed):

```diff
@@ -1,6 +1,6 @@
 import { CURRENCIES, DEFAULT_SETTINGS } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
-import { check, foreignKey, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
+import { boolean, check, foreignKey, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
 import { attachments } from './attachments.js';
 import { tenants } from './tenants.js';
@@ -27,6 +27,8 @@ export const tenantSettings = pgTable(
       .default(DEFAULT_SETTINGS.fiscalYearStartMonth),
     timezone: text('timezone').notNull().default(DEFAULT_SETTINGS.timezone),
     logoAttachmentId: uuid('logo_attachment_id'),
+    // Step 13: may an untracked product's stock go below zero? Read by migration 0022's trigger.
+    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
     createdAt: baseColumns().createdAt,
     updatedAt: baseColumns().updatedAt,
     updatedBy: baseColumns().updatedBy,
```

`packages/db/src/schema/outbox-events.ts` (changed):

```diff
@@ -15,6 +15,7 @@ export const OUTBOX_EVENT_TYPES = [
   'report.export_requested',
   'workspace.catalog_requested',
   'product.import_requested',
+  'stock.below_reorder',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
```

`packages/db/src/schema/index.ts` (changed):

```diff
@@ -26,3 +26,6 @@ export * from './custom-fields.js';
 export * from './products.js';
 export * from './batches.js';
 export * from './product-imports.js';
+export * from './warehouses.js';
+export * from './stock.js';
+export * from './stock-documents.js';
```

`packages/db/src/permission-catalog.ts` (changed):

```diff
@@ -23,7 +23,10 @@ const DESCRIPTIONS = {
   'accounting.report.read':
     'View the trial balance, profit and loss and balance sheet, and export them to Excel or PDF',
   'inventory.product.manage':
-    'Add, edit, archive and import products, and manage their categories and units',
+    'Add, edit, archive and import products, manage their categories and units, and set reorder levels',
+  'inventory.warehouse.manage': 'Add, edit and archive warehouses',
+  'inventory.stock.adjust': 'Write and post stock adjustments, including opening stock',
+  'inventory.stock.transfer': 'Send stock to another warehouse and receive it there',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

### Migration 0021 (generated — then move the indexes up)

```bash
pnpm --filter @omnivo/db exec drizzle-kit generate --name stock
```

Drizzle writes the foreign keys before the indexes they need, and Postgres refuses a foreign key whose target
columns have no unique index yet ("there is no unique constraint matching given keys"). The same thing happened in
steps 9, 10 and 12. Move every `CREATE INDEX` / `CREATE UNIQUE INDEX` above the first `ALTER TABLE … ADD
CONSTRAINT`, keeping the `CREATE TABLE` and `ADD COLUMN` statements first. The file as it should end up:

`packages/db/migrations/0021_stock.sql`:

```sql
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reorder_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"min_quantity" numeric(19, 4) NOT NULL,
	"reorder_quantity" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "reorder_levels_min_check" CHECK ("reorder_levels"."min_quantity" >= 0),
	CONSTRAINT "reorder_levels_quantity_check" CHECK ("reorder_levels"."reorder_quantity" IS NULL OR "reorder_levels"."reorder_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_key" UNIQUE NULLS NOT DISTINCT("tenant_id","warehouse_id","variant_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid,
	"serial_id" uuid,
	"quantity" numeric(19, 4) NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "stock_movements_quantity_check" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_serial_check" CHECK ("stock_movements"."serial_id" IS NULL OR "stock_movements"."quantity" IN (1, -1))
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"lot_number" text,
	"expires_on" date,
	"manufactured_on" date,
	CONSTRAINT "stock_adjustment_lines_quantity_check" CHECK ("stock_adjustment_lines"."quantity" > 0 AND "stock_adjustment_lines"."factor" > 0 AND "stock_adjustment_lines"."base_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "stock_adjustments_posted_check" CHECK (("stock_adjustments"."status" = 'posted') = ("stock_adjustments"."number" IS NOT NULL AND "stock_adjustments"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"transfer_id" uuid NOT NULL,
	"received_quantity" numeric(19, 4),
	"received_serial_numbers" text[],
	CONSTRAINT "stock_transfer_lines_quantity_check" CHECK ("stock_transfer_lines"."quantity" > 0 AND "stock_transfer_lines"."factor" > 0 AND "stock_transfer_lines"."base_quantity" > 0),
	CONSTRAINT "stock_transfer_lines_received_check" CHECK ("stock_transfer_lines"."received_quantity" IS NULL OR "stock_transfer_lines"."received_quantity" BETWEEN 0 AND "stock_transfer_lines"."base_quantity")
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"from_warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid NOT NULL,
	"sent_on" date NOT NULL,
	"received_on" date,
	"note" text,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	CONSTRAINT "stock_transfers_places_check" CHECK ("stock_transfers"."from_warehouse_id" <> "stock_transfers"."to_warehouse_id"),
	CONSTRAINT "stock_transfers_sent_check" CHECK (("stock_transfers"."status" <> 'draft') = ("stock_transfers"."number" IS NOT NULL AND "stock_transfers"."sent_at" IS NOT NULL)),
	CONSTRAINT "stock_transfers_received_check" CHECK (("stock_transfers"."status" = 'received') = ("stock_transfers"."received_on" IS NOT NULL AND "stock_transfers"."received_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "allow_negative_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "serials" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_tenant_code_idx" ON "warehouses" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_tenant_id_idx" ON "warehouses" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "warehouses_tenant_branch_idx" ON "warehouses" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_levels_key_idx" ON "reorder_levels" USING btree ("tenant_id","warehouse_id","variant_id");--> statement-breakpoint
CREATE INDEX "reorder_levels_variant_idx" ON "reorder_levels" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_balances_variant_idx" ON "stock_balances" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_date_idx" ON "stock_movements" USING btree ("tenant_id","variant_id","date","id");--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_warehouse_idx" ON "stock_movements" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movements_document_idx" ON "stock_movements" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustment_lines_line_idx" ON "stock_adjustment_lines" USING btree ("tenant_id","adjustment_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_adjustment_lines_variant_idx" ON "stock_adjustment_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_tenant_id_idx" ON "stock_adjustments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_tenant_number_idx" ON "stock_adjustments" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_adjustments_tenant_date_idx" ON "stock_adjustments" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_tenant_warehouse_idx" ON "stock_adjustments" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_lines_line_idx" ON "stock_transfer_lines" USING btree ("tenant_id","transfer_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_variant_idx" ON "stock_transfer_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_tenant_id_idx" ON "stock_transfers" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_tenant_number_idx" ON "stock_transfers" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_transfers_tenant_date_idx" ON "stock_transfers" USING btree ("tenant_id","sent_on","id");--> statement-breakpoint
CREATE INDEX "stock_transfers_in_transit_idx" ON "stock_transfers" USING btree ("tenant_id","to_warehouse_id") WHERE "stock_transfers"."status" = 'in_transit';--> statement-breakpoint
CREATE INDEX "stock_transfers_from_idx" ON "stock_transfers" USING btree ("tenant_id","from_warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_variant_id_idx" ON "batches" USING btree ("tenant_id","variant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "serials_variant_id_idx" ON "serials" USING btree ("tenant_id","variant_id","id");--> statement-breakpoint
CREATE INDEX "serials_warehouse_idx" ON "serials" USING btree ("tenant_id","warehouse_id","variant_id");--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_levels" ADD CONSTRAINT "reorder_levels_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_serial_fk" FOREIGN KEY ("tenant_id","variant_id","serial_id") REFERENCES "public"."serials"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."stock_adjustments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_fk" FOREIGN KEY ("tenant_id","transfer_id") REFERENCES "public"."stock_transfers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_fk" FOREIGN KEY ("tenant_id","from_warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_fk" FOREIGN KEY ("tenant_id","to_warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;
```

### Migration 0022 (custom): RLS, the ledger's rules, a Main store for every workspace

```bash
pnpm --filter @omnivo/db exec drizzle-kit generate --custom --name stock-rules
```

`packages/db/migrations/0022_stock-rules.sql`:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The eight new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'warehouses', 'stock_movements', 'stock_balances', 'reorder_levels', 'stock_adjustments',
      'stock_adjustment_lines', 'stock_transfers', 'stock_transfer_lines'
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

-- 2) The stock ledger is append-only (build plan step 13): a movement is never changed or deleted.
--    A wrong adjustment is fixed by another adjustment, and both stay in the stock card. omnivo_app
--    has UPDATE and DELETE on every table (default privileges), so the rule lives here.
CREATE FUNCTION stock_movements_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock movement % cannot be changed or deleted; post another document instead', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_movements_append_only';
END $$;

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();

-- 3) Every new movement updates the balance of its warehouse, variant and batch, in the same
--    transaction — so a balance is always the sum of its movements, whoever inserts them.
--    INSERT … ON CONFLICT DO UPDATE locks the balance row: two documents taking the last carton
--    at the same moment run one after the other here, and the second one sees the first one's
--    result. Taking stock below zero is refused unless the workspace allows it (tenant_settings),
--    and never for a batch or a serial number: a batch or an IMEI is either there or it is not.
--    Only a movement OUT is refused: stock coming into a warehouse that is still below zero (the
--    workspace allowed it once, then turned it off) must always be welcome.
--    The API checks all of this first, line by line, to give a readable error; this is the last
--    word, the way 0016 checks that a posted journal entry balances.
--    A serial number's current warehouse is kept here too: in = it must not be in stock anywhere,
--    out = it must be in this warehouse.
CREATE FUNCTION stock_movements_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric;
  v_tracking text;
  v_allowed boolean;
  v_serial_at uuid;
BEGIN
  INSERT INTO stock_balances AS b
         (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity, updated_at)
  VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.product_id, NEW.variant_id, NEW.batch_id,
          NEW.quantity, now())
  ON CONFLICT ON CONSTRAINT stock_balances_key
  DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity, updated_at = now()
  RETURNING b.quantity INTO v_balance;

  IF v_balance < 0 AND NEW.quantity < 0 THEN
    SELECT p.tracking INTO v_tracking
      FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.product_id;
    SELECT s.allow_negative_stock INTO v_allowed
      FROM tenant_settings s WHERE s.tenant_id = NEW.tenant_id;
    IF v_tracking <> 'none' OR NOT coalesce(v_allowed, false) THEN
      RAISE EXCEPTION 'stock of variant % in warehouse % would be %',
          NEW.variant_id, NEW.warehouse_id, v_balance
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_balances_not_negative';
    END IF;
  END IF;

  IF NEW.serial_id IS NOT NULL THEN
    SELECT s.warehouse_id INTO v_serial_at
      FROM serials s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.serial_id
       FOR UPDATE;
    IF NEW.quantity > 0 AND v_serial_at IS NOT NULL THEN
      RAISE EXCEPTION 'serial % is already in stock', NEW.serial_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'serials_in_stock';
    END IF;
    IF NEW.quantity < 0 AND v_serial_at IS DISTINCT FROM NEW.warehouse_id THEN
      RAISE EXCEPTION 'serial % is not in warehouse %', NEW.serial_id, NEW.warehouse_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'serials_not_here';
    END IF;
    UPDATE serials
       SET warehouse_id = CASE WHEN NEW.quantity > 0 THEN NEW.warehouse_id END
     WHERE tenant_id = NEW.tenant_id AND id = NEW.serial_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_apply();

-- 4) A posted adjustment and its lines never change, like a posted journal entry (0016). Only a
--    draft may be edited, deleted or posted.
CREATE FUNCTION stock_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'stock adjustment % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_adjustments_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_adjustments_guard
  BEFORE UPDATE OR DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION stock_adjustments_guard();

CREATE FUNCTION stock_adjustment_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM stock_adjustments
         WHERE tenant_id = OLD.tenant_id AND id = OLD.adjustment_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM stock_adjustments
         WHERE tenant_id = NEW.tenant_id AND id = NEW.adjustment_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted stock adjustment cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_adjustment_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_adjustment_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION stock_adjustment_lines_guard();

-- 5) A transfer goes draft → in_transit → received, and nothing else. Once sent, what was sent
--    (the places, the date, the number, the lines) is fixed; the only change left is the receipt,
--    once. A received transfer never changes. Only a draft may be deleted.
CREATE FUNCTION stock_transfers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'stock transfer % was sent and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfers_sent_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'received'
     OR (OLD.status = 'in_transit' AND (
          NEW.status <> 'received'
          OR (NEW.number, NEW.from_warehouse_id, NEW.to_warehouse_id, NEW.sent_on, NEW.note,
              NEW.sent_at, NEW.sent_by)
             IS DISTINCT FROM
             (OLD.number, OLD.from_warehouse_id, OLD.to_warehouse_id, OLD.sent_on, OLD.note,
              OLD.sent_at, OLD.sent_by))) THEN
    RAISE EXCEPTION 'stock transfer % was sent: only its receipt can be recorded', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfers_sent_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_transfers_guard
  BEFORE UPDATE OR DELETE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION stock_transfers_guard();

-- The lines: free while the transfer is a draft. In transit, a line may only get its receipt
-- (received_quantity, received_serial_numbers), once, with nothing else changed. Received: frozen.
-- When a draft is deleted its lines go by ON DELETE CASCADE; the header is gone by then, so the
-- lookup finds nothing and lets them go.
CREATE FUNCTION stock_transfer_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status
      FROM stock_transfers WHERE tenant_id = NEW.tenant_id AND id = NEW.transfer_id;
    -- NULL: no such transfer — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines cannot be added to a stock transfer that was sent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfer_lines_sent_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM stock_transfers WHERE tenant_id = OLD.tenant_id AND id = OLD.transfer_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF v_status = 'in_transit' AND TG_OP = 'UPDATE' AND OLD.received_quantity IS NULL
     AND NEW.received_quantity IS NOT NULL
     AND (NEW.tenant_id, NEW.transfer_id, NEW.line_no, NEW.product_id, NEW.variant_id,
          NEW.unit_id, NEW.quantity, NEW.factor, NEW.base_quantity, NEW.batch_id,
          NEW.serial_numbers)
         IS NOT DISTINCT FROM
         (OLD.tenant_id, OLD.transfer_id, OLD.line_no, OLD.product_id, OLD.variant_id,
          OLD.unit_id, OLD.quantity, OLD.factor, OLD.base_quantity, OLD.batch_id,
          OLD.serial_numbers) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a sent stock transfer cannot be changed, except to record the receipt once'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfer_lines_sent_immutable';
END $$;

CREATE TRIGGER stock_transfer_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION stock_transfer_lines_guard();

-- 6) Every workspace gets a first warehouse, "Main store" (MAIN), in its first active branch —
--    sign-up does the same for new workspaces (auth.service.ts). Without one, no stock page can
--    be used. Plain SQL, not a job: the data is fixed and needs no template.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO warehouses (id, tenant_id, branch_id, code, name)
    SELECT gen_random_uuid(), t, b.id, 'MAIN', 'Main store'
      FROM branches b
     WHERE b.tenant_id = t AND b.archived_at IS NULL
     ORDER BY b.created_at, b.code
     LIMIT 1
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

Why each part is written this way:

- **(1) RLS** on all eight tables, `ENABLE` + `FORCE`, with the `NULLIF` policy of migration 0002. The RLS coverage
  test fails for any tenant table left without it.
- **(2) Append-only.** `omnivo_app` has `UPDATE` and `DELETE` on every table (default privileges), so only a
  trigger can forbid them — for every role, the superuser included.
- **(3) `stock_movements_apply()`**:
  - `INSERT … ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE` takes a row lock on the balance. Two
    documents taking the last carton queue there; the second sees the first one's result. `RETURNING b.quantity`
    gives the new balance in the same statement.
  - The negative check runs **only when the movement goes out** (`NEW.quantity < 0`). Stock coming in to a
    warehouse that is still below zero (the workspace allowed it once, then switched it off) must always be
    welcome — refusing it would make the hole impossible to fill. This was found while building (see "What we
    found on the way").
  - The variable names start with `v_`: in PL/pgSQL, a variable named `tracking` and a column named `tracking` in
    the same query are ambiguous.
  - The serial row is locked (`FOR UPDATE`) and moved in the same transaction as its movement.
  - It is an `AFTER` trigger that returns `NULL`: it changes other tables, not the movement itself.
- **(4) Adjustments**: the journal's rules (0016), for adjustments and their lines.
- **(5) Transfers**: draft → in transit → received, and nothing else. Once sent, the "what was sent" columns are
  compared as one row value (`(…) IS DISTINCT FROM (…)`), which treats two `NULL`s as equal. A line in transit may
  change only once, and only its receipt columns.
- **(6) A Main store per workspace**: plain SQL, not an outbox job (unlike step 12's catalog), because it needs no
  template — every workspace gets the same row. `gen_random_uuid()` because Drizzle's UUIDv7 default lives in
  TypeScript, not in the database. `set_config('app.tenant_id', …, true)` per tenant, because the table has
  `FORCE ROW LEVEL SECURITY` even for its owner.

---

## 13.3 — The API: `apps/api/src/inventory/`

A new module. The order below is the order the pieces depend on each other: the line rules, the posting service,
then the services that use them, then the controllers, the worker's handler and the module.

### `inventory/stock-lines.ts` (new)

`apps/api/src/inventory/stock-lines.ts`:

```ts
import {
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  isWholeQuantity,
  type StockLine,
  toBaseQuantity,
  wholeCount,
} from '@omnivo/contracts';
import { batches, products, productUnits, productVariants, units, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What a stock line needs to know about its variant: how the product is counted and tracked
export interface VariantInfo {
  variantId: string;
  productId: string;
  productCode: string;
  productName: string;
  optionValues: string[];
  sku: string;
  type: string;
  tracking: string;
  hasExpiry: boolean;
  baseUnitId: string;
  // How many decimals a quantity in the base unit may have (pcs 0, kg 3)
  baseDecimals: number;
  // The product or the variant is archived
  archived: boolean;
  // The packs, in the product's order: a carton = "24", typed with up to `decimals` places
  units: { unitId: string; factor: string; decimals: number }[];
}

// The variants of these ids, with their packs. lock: FOR SHARE on the products while a document
// is posted — until we commit, nobody changes a product's base unit or tracking under us
// (ProductsService locks FOR UPDATE and then checks for movements).
export async function loadVariants(
  tx: Transaction,
  variantIds: readonly string[],
  { lock = false }: { lock?: boolean } = {},
): Promise<Map<string, VariantInfo>> {
  const tenantId = getTenantId();
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const query = tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productCode: products.code,
      productName: products.name,
      optionValues: productVariants.optionValues,
      sku: productVariants.sku,
      type: products.type,
      tracking: products.tracking,
      hasExpiry: products.hasExpiry,
      baseUnitId: products.baseUnitId,
      baseDecimals: units.decimals,
      productArchivedAt: products.archivedAt,
      variantArchivedAt: productVariants.archivedAt,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.tenantId, productVariants.tenantId),
        eq(products.id, productVariants.productId),
      ),
    )
    .innerJoin(units, and(eq(units.tenantId, products.tenantId), eq(units.id, products.baseUnitId)))
    .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, ids)));
  const rows = lock ? await query.for('share', { of: products }) : await query;

  const productIds = [...new Set(rows.map((row) => row.productId))];
  const packs =
    productIds.length === 0
      ? []
      : await tx
          .select({
            productId: productUnits.productId,
            unitId: productUnits.unitId,
            factor: productUnits.factor,
            decimals: units.decimals,
          })
          .from(productUnits)
          .innerJoin(
            units,
            and(eq(units.tenantId, productUnits.tenantId), eq(units.id, productUnits.unitId)),
          )
          .where(
            and(eq(productUnits.tenantId, tenantId), inArray(productUnits.productId, productIds)),
          )
          .orderBy(asc(productUnits.position));

  return new Map(
    rows.map((row) => [
      row.variantId,
      {
        variantId: row.variantId,
        productId: row.productId,
        productCode: row.productCode,
        productName: row.productName,
        optionValues: row.optionValues,
        sku: row.sku,
        type: row.type,
        tracking: row.tracking,
        hasExpiry: row.hasExpiry,
        baseUnitId: row.baseUnitId,
        baseDecimals: row.baseDecimals,
        archived: row.productArchivedAt !== null || row.variantArchivedAt !== null,
        units: packs
          .filter((pack) => pack.productId === row.productId)
          .map((pack) => ({ unitId: pack.unitId, factor: pack.factor, decimals: pack.decimals })),
      },
    ]),
  );
}

// Many problems at once, each under its own field ("lines.2.quantity"), like a form's errors: the
// person fixes every line in one go instead of meeting them one by one
export interface LineIssue {
  path: string;
  code: ErrorCode;
}

export function linesError(issues: readonly LineIssue[]): AppError {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
  const [first] = issues;
  return new AppError(
    409,
    first?.code ?? 'invalid_input',
    'Some lines cannot be used. Check the highlighted fields.',
    { fieldErrors },
  );
}

export function linePath(index: number, field: string): string {
  return `lines.${String(index)}.${field}`;
}

// A line as the form sends it. Lot and dates only on lines that bring stock in.
export interface LineInput {
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: string[];
  lotNumber?: string | null;
  expiresOn?: string | null;
  manufacturedOn?: string | null;
}

// A line checked against its product: the factor and the base quantity worked out, and the
// fields that do not apply to its tracking cleared
export interface ResolvedLine {
  variant: VariantInfo;
  unitId: string;
  quantity: string;
  factor: string;
  baseQuantity: string;
  batchId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: string[];
}

// 'in' brings stock in (a lot is typed and becomes a batch when posted); 'out' takes it out or
// moves it (an existing batch is picked). Archived products can still leave — their remaining
// stock has to go somewhere — but nothing new comes in for them.
export type LineMode = 'in' | 'out';

// Every rule of a line that does not depend on what is in stock: the variant is a stocked product
// of this workspace, the unit is its base unit or one of its packs, the quantity fits the unit,
// and the batch or serial numbers match the product's tracking. Stock itself is checked when the
// document is posted (StockPostingService), because a draft moves nothing.
export async function resolveLines(
  tx: Transaction,
  lines: readonly LineInput[],
  mode: LineMode,
  { lock = false }: { lock?: boolean } = {},
): Promise<ResolvedLine[]> {
  const tenantId = getTenantId();
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
    { lock },
  );
  const issues: LineIssue[] = [];
  const resolved: ResolvedLine[] = [];

  // The batches named by "out" lines, to check they belong to their line's variant
  const batchIds = [
    ...new Set(lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId]))),
  ];
  const known =
    batchIds.length === 0
      ? []
      : await tx
          .select({ id: batches.id, variantId: batches.variantId })
          .from(batches)
          .where(and(eq(batches.tenantId, tenantId), inArray(batches.id, batchIds)));
  const batchVariant = new Map(known.map((batch) => [batch.id, batch.variantId]));

  lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
    };
    const variant = variants.get(line.variantId);
    // The same answer for "no such variant", "another workspace's", "a service" and (coming in)
    // "archived": pick a stocked product from the list
    if (variant?.type !== 'goods' || (mode === 'in' && variant.archived)) {
      at('variantId', 'stock_variant_invalid');
      return;
    }
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) {
      at('unitId', 'stock_unit_invalid');
      return;
    }
    const { factor } = unit;
    if (!isQuantity(line.quantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    // 1.5 boxes, or 2.5 pcs: more decimals than the unit allows (a box and a piece allow none)
    if (!fitsDecimals(line.quantity, unit.decimals)) {
      at('quantity', 'stock_quantity_decimals');
      return;
    }
    // Rounded to the base unit's decimals: 3 yards = 2.74 m when metres keep 2
    const baseQuantity = toBaseQuantity(line.quantity, factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) {
      // Rounded to nothing: 0.001 of a yard in whole metres
      at('quantity', 'quantity_format');
      return;
    }

    let batchId: string | null = null;
    let lotNumber: string | null = null;
    let expiresOn: string | null = null;
    let manufacturedOn: string | null = null;
    let serialNumbers: string[] = [];

    if (variant.tracking === 'batch') {
      if (mode === 'in') {
        lotNumber = line.lotNumber ?? null;
        expiresOn = line.expiresOn ?? null;
        manufacturedOn = line.manufacturedOn ?? null;
        // The expiry is asked for when the lot is new (StockPostingService.resolveBatches): more of
        // a known lot takes the expiry it already has
        if (lotNumber === null) at('lotNumber', 'stock_lot_required');
      } else {
        batchId = line.batchId;
        if (batchId === null) at('batchId', 'stock_batch_required');
        else if (batchVariant.get(batchId) !== variant.variantId)
          at('batchId', 'stock_batch_invalid');
      }
    }
    if (variant.tracking === 'serial') {
      serialNumbers = line.serialNumbers;
      // One serial number per base unit: 3 phones, 3 IMEIs
      if (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== serialNumbers.length) {
        at('serialNumbers', 'stock_serial_count');
      }
    }

    resolved.push({
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor,
      baseQuantity,
      batchId,
      lotNumber,
      expiresOn,
      manufacturedOn,
      serialNumbers,
    });
  });

  if (issues.length > 0) throw linesError(issues);
  return resolved;
}

// A warehouse a new document may use: this workspace's, and not archived. FOR SHARE: nobody
// archives it until we commit (WarehousesService locks it FOR UPDATE).
export async function assertWarehousesActive(
  tx: Transaction,
  places: readonly { field: string; warehouseId: string }[],
): Promise<void> {
  const ids = [...new Set(places.map((place) => place.warehouseId))];
  const rows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.tenantId, getTenantId()),
        inArray(warehouses.id, ids),
        isNull(warehouses.archivedAt),
      ),
    )
    .for('share');
  const active = new Set(rows.map((row) => row.id));
  const bad = places.filter((place) => !active.has(place.warehouseId));
  if (bad.length > 0) {
    throw new AppError(409, 'stock_warehouse_invalid', 'Pick an active warehouse.', {
      fieldErrors: Object.fromEntries(
        bad.map((place) => [place.field, ['stock_warehouse_invalid']]),
      ),
    });
  }
}

// A stored line, with its variant, in the shape the API sends (StockLine)
export function toStockLine(
  row: {
    id: string;
    unitId: string;
    quantity: string;
    baseQuantity: string;
    batchId: string | null;
    serialNumbers: string[];
    lotNumber?: string | null;
    expiresOn?: string | null;
    manufacturedOn?: string | null;
  },
  variant: VariantInfo,
  batch: { lotNumber: string; expiresOn: string | null; manufacturedOn: string | null } | undefined,
): StockLine {
  return {
    id: row.id,
    variantId: variant.variantId,
    productId: variant.productId,
    productCode: variant.productCode,
    productName: variant.productName,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: variant.baseUnitId,
    tracking: variant.tracking,
    hasExpiry: variant.hasExpiry,
    units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    unitId: row.unitId,
    quantity: row.quantity,
    baseQuantity: row.baseQuantity,
    batchId: row.batchId,
    // An "out" line shows its batch's lot; an "in" line its own until the batch exists
    lotNumber: batch?.lotNumber ?? row.lotNumber ?? null,
    expiresOn: batch?.expiresOn ?? row.expiresOn ?? null,
    manufacturedOn: batch?.manufacturedOn ?? row.manufacturedOn ?? null,
    serialNumbers: row.serialNumbers,
  };
}

interface BatchDates {
  id: string;
  lotNumber: string;
  expiresOn: string | null;
  manufacturedOn: string | null;
}

// The lots and dates of the batches some lines point at
export async function batchesOf(
  tx: Transaction,
  batchIds: readonly (string | null)[],
): Promise<Map<string, BatchDates>> {
  const ids = [...new Set(batchIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: batches.id,
      lotNumber: batches.lotNumber,
      expiresOn: batches.expiresOn,
      manufacturedOn: batches.manufacturedOn,
    })
    .from(batches)
    .where(and(eq(batches.tenantId, getTenantId()), inArray(batches.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}
```

- **`loadVariants(…, { lock: true })`** takes `FOR SHARE` on the *products* while a document is posted.
  `ProductsService.update()` locks the product `FOR UPDATE` and then looks for movements before it allows a new
  base unit (13.4). One of the two waits for the other, so a base unit cannot change between "this line is 3
  cases = 72 pcs" and the movement being written.
- **Every problem at once** (`LineIssue[]` → `linesError()`), each under its own field: `lines.2.quantity`. The
  form puts each one under its control, and the person fixes the whole sheet in one go.
- **One answer for four cases** — no such variant, another workspace's, a service, an archived product coming in —
  `stock_variant_invalid`. The tenant-leak test relies on it: nothing tells a caller that another workspace's id
  exists.
- **Archived products may still go out** (`mode === 'out'`): the remaining stock of a discontinued colour has to
  leave somehow.
- **The decimals check is on the unit typed** (`unit.decimals`), not only the base unit: 1.5 boxes is refused even
  when the base unit (tablets) would take it.
- **The lot of an "in" line is required; its expiry is not, here.** More of a known lot takes the expiry it
  already has; whether the lot is new is only known when posting (`StockPostingService.resolveBatches()`).
- **`assertWarehousesActive()`** locks the warehouses `FOR SHARE`: archiving one (which locks it `FOR UPDATE` and
  checks for stock) waits until a posting into it has committed — and then sees the stock it brought.

### `inventory/stock-posting.service.ts` (new)

`apps/api/src/inventory/stock-posting.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type MovementKind,
  negateQuantity,
  subtractQuantity,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';
import {
  batches,
  reorderLevels,
  serials,
  stockBalances,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { isCheckViolation } from '../common/db/pg-errors.js';
import { emit } from '../common/outbox/outbox.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId, tenantStorage } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import {
  type LineIssue,
  linePath,
  linesError,
  type ResolvedLine,
  type VariantInfo,
} from './stock-lines.js';

// One movement of a document, before it is written: from which line (for errors under the right
// field), where, what and how much — always positive, the posting's direction gives the sign.
export interface StockMove {
  line: number;
  warehouseId: string;
  variant: VariantInfo;
  batchId: string | null;
  quantity: string;
  serialNumbers: string[];
}

export interface StockPosting {
  date: string;
  kind: MovementKind;
  // 'in' adds to the warehouse, 'out' takes from it. A document posts one direction at a time: an
  // adjustment is in or out, a transfer sends (out) and later receives (in).
  direction: 'in' | 'out';
  documentId: string;
  documentNumber: string;
  moves: readonly StockMove[];
  // A transfer's receipt: its serial numbers are on that transfer's lines, in transit, not "in
  // stock somewhere else"
  receivingTransferId?: string;
}

// The trigger's refusals as the API's answers, without a field: the trigger does not know which
// line of the document a movement came from
function triggerError(error: unknown): unknown {
  if (isCheckViolation(error, 'stock_balances_not_negative')) {
    return new AppError(409, 'stock_insufficient', 'Not enough stock for this posting.');
  }
  if (isCheckViolation(error, 'serials_in_stock')) {
    return new AppError(409, 'stock_serial_in_stock', 'A serial number is already in stock.');
  }
  if (isCheckViolation(error, 'serials_not_here')) {
    return new AppError(409, 'stock_serial_not_here', 'A serial number is not in this warehouse.');
  }
  return error;
}

function actorId(): string | null {
  return tenantStorage.getStore()?.principal?.userId ?? null;
}

// warehouse|variant|batch — the key of a balance row ('' for no batch)
function balanceKey(warehouseId: string, variantId: string, batchId: string | null): string {
  return `${warehouseId}|${variantId}|${batchId ?? ''}`;
}

// The one way into the stock ledger. Adjustments and transfers use it now; purchases, sales and
// POS (steps 15–20) will build a StockPosting and call post() inside their own transaction, so the
// document and its movements commit together or not at all. Every rule of stock lives here once —
// and the database checks the last ones again (migration 0022's trigger).
@Injectable()
export class StockPostingService {
  // A document is dated in an open period (the accounting lock date: from step 14 every movement
  // also posts to the books) and not in the future: tomorrow's stock cannot leave today
  async assertDate(tx: Transaction, date: string, field = 'date'): Promise<void> {
    await assertPeriodOpen(tx, date);
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
    if (date > todayIn(settings.timezone)) {
      throw new AppError(
        409,
        'stock_date_future',
        'A stock document cannot be dated in the future.',
        {
          fieldErrors: { [field]: ['stock_date_future'] },
        },
      );
    }
  }

  // The batches of lines that bring a batch product in: an existing lot of the variant, or a new
  // one. Receiving more of NP24117 adds to the same batch, and takes its expiry: typed again, it
  // must be the same (a lot never has two expiry dates). A new lot of a product with expiry dates
  // needs its date. Returns each line's batch id (null if untracked).
  async resolveBatches(
    tx: Transaction,
    lines: readonly ResolvedLine[],
  ): Promise<(string | null)[]> {
    const tenantId = getTenantId();
    const issues: LineIssue[] = [];
    const ids: (string | null)[] = [];
    for (const [index, line] of lines.entries()) {
      const lotNumber = line.lotNumber;
      if (lotNumber === null) {
        ids.push(null);
        continue;
      }
      const find = async () => {
        const [found] = await tx
          .select({ id: batches.id, expiresOn: batches.expiresOn })
          .from(batches)
          .where(
            and(
              eq(batches.tenantId, tenantId),
              eq(batches.variantId, line.variant.variantId),
              sql`lower(${batches.lotNumber}) = lower(${lotNumber})`,
            ),
          );
        return found;
      };
      let batch = await find();
      if (!batch) {
        if (line.variant.hasExpiry && line.expiresOn === null) {
          issues.push({ path: linePath(index, 'expiresOn'), code: 'stock_expiry_required' });
          ids.push(null);
          continue;
        }
        // ON CONFLICT DO NOTHING: two documents bringing in the same new lot at once both get
        // here; the unique index (variant, lower(lot)) lets one through and the other reads it
        await tx
          .insert(batches)
          .values({
            tenantId,
            productId: line.variant.productId,
            variantId: line.variant.variantId,
            lotNumber,
            manufacturedOn: line.manufacturedOn,
            expiresOn: line.expiresOn,
            createdBy: actorId(),
          })
          .onConflictDoNothing();
        batch = await find();
        if (!batch) throw new Error('Batch upsert returned no row');
      }
      if (line.expiresOn !== null && batch.expiresOn !== line.expiresOn) {
        issues.push({ path: linePath(index, 'expiresOn'), code: 'stock_batch_expiry_mismatch' });
      }
      ids.push(batch.id);
    }
    if (issues.length > 0) throw linesError(issues);
    return ids;
  }

  async post(tx: Transaction, posting: StockPosting): Promise<void> {
    if (posting.moves.length === 0) return;
    const serialIds = await this.checkSerials(tx, posting);
    const before = posting.direction === 'out' ? await this.checkAvailable(tx, posting) : null;

    const sign = (quantity: string) =>
      posting.direction === 'in' ? quantity : negateQuantity(quantity);
    const rows = posting.moves.flatMap((move) => {
      const base = {
        tenantId: getTenantId(),
        date: posting.date,
        warehouseId: move.warehouseId,
        productId: move.variant.productId,
        variantId: move.variant.variantId,
        batchId: move.batchId,
        kind: posting.kind,
        documentId: posting.documentId,
        documentNumber: posting.documentNumber,
        createdBy: actorId(),
      };
      // A serial product moves one row per serial number: the stock card then shows where each
      // IMEI went, and the trigger moves each serial row on its own
      if (move.serialNumbers.length > 0) {
        return move.serialNumbers.map((serial) => ({
          ...base,
          serialId: serialIds.get(`${move.variant.variantId}|${serial}`) ?? null,
          quantity: sign('1'),
        }));
      }
      return [{ ...base, serialId: null, quantity: sign(move.quantity) }];
    });
    // In the order of their balance rows: every document locks those rows in the same order, so
    // two documents touching the same products wait for each other instead of deadlocking
    rows.sort((a, b) =>
      balanceKey(a.warehouseId, a.variantId, a.batchId).localeCompare(
        balanceKey(b.warehouseId, b.variantId, b.batchId),
      ),
    );
    try {
      await tx.insert(stockMovements).values(rows);
    } catch (error) {
      // The database's last word (migration 0022's trigger). The checks above make it unreachable
      // in practice; if it ever speaks, the person still gets the 409 it means, not a 500. The
      // transaction is aborted either way, and rolls back when this error leaves withTenant.
      throw triggerError(error);
    }

    if (before !== null) await this.reportLow(tx, posting, before);
  }

  // Serial numbers in: made the first time they are seen, and never already in stock (in a
  // warehouse, or on a truck). Out: each one is in this warehouse. Returns variant|serial → id.
  private async checkSerials(tx: Transaction, posting: StockPosting): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    const wanted = posting.moves.filter((move) => move.serialNumbers.length > 0);
    if (wanted.length === 0) return new Map();

    if (posting.direction === 'in') {
      await tx
        .insert(serials)
        .values(
          wanted.flatMap((move) =>
            move.serialNumbers.map((serialNumber) => ({
              tenantId,
              productId: move.variant.productId,
              variantId: move.variant.variantId,
              serialNumber,
              createdBy: actorId(),
            })),
          ),
        )
        .onConflictDoNothing();
    }
    const variantIds = [...new Set(wanted.map((move) => move.variant.variantId))];
    const numbers = [...new Set(wanted.flatMap((move) => move.serialNumbers))];
    // FOR UPDATE: the trigger moves these rows; until we commit, no other document moves them
    const rows = await tx
      .select({
        id: serials.id,
        variantId: serials.variantId,
        serialNumber: serials.serialNumber,
        warehouseId: serials.warehouseId,
      })
      .from(serials)
      .where(
        and(
          eq(serials.tenantId, tenantId),
          inArray(serials.variantId, variantIds),
          inArray(serials.serialNumber, numbers),
        ),
      )
      .orderBy(asc(serials.id))
      .for('update');
    const found = new Map(rows.map((row) => [`${row.variantId}|${row.serialNumber}`, row]));

    // On their way in another transfer: not in a warehouse, but not free to come in either
    const inTransit = new Set<string>();
    if (posting.direction === 'in') {
      const sent = await tx
        .select({
          transferId: stockTransferLines.transferId,
          variantId: stockTransferLines.variantId,
          serialNumbers: stockTransferLines.serialNumbers,
        })
        .from(stockTransferLines)
        .innerJoin(
          stockTransfers,
          and(
            eq(stockTransfers.tenantId, stockTransferLines.tenantId),
            eq(stockTransfers.id, stockTransferLines.transferId),
          ),
        )
        .where(
          and(
            eq(stockTransferLines.tenantId, tenantId),
            eq(stockTransfers.status, 'in_transit'),
            inArray(stockTransferLines.variantId, variantIds),
          ),
        );
      for (const line of sent) {
        if (line.transferId === posting.receivingTransferId) continue;
        for (const serial of line.serialNumbers) inTransit.add(`${line.variantId}|${serial}`);
      }
    }

    const issues: LineIssue[] = [];
    for (const move of wanted) {
      const bad = move.serialNumbers.some((serial) => {
        const key = `${move.variant.variantId}|${serial}`;
        const row = found.get(key);
        // No row (cannot happen after the insert above) reads as "somewhere else": refused
        return posting.direction === 'in'
          ? row?.warehouseId !== null || inTransit.has(key)
          : row?.warehouseId !== move.warehouseId;
      });
      if (bad) {
        issues.push({
          path: linePath(move.line, 'serialNumbers'),
          code: posting.direction === 'in' ? 'stock_serial_in_stock' : 'stock_serial_not_here',
        });
      }
    }
    if (issues.length > 0) throw linesError(issues);
    return new Map(rows.map((row) => [`${row.variantId}|${row.serialNumber}`, row.id]));
  }

  // Enough stock for every line that takes some out. The balance rows are locked first (FOR
  // UPDATE, in key order): a second document taking the same stock waits here and then sees what
  // the first one left. Two lines taking the same batch count together. Returns each place's stock
  // before this document, per warehouse and variant, for the reorder check.
  private async checkAvailable(
    tx: Transaction,
    posting: StockPosting,
  ): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    const pairs = [
      ...new Map(
        posting.moves.map((move) => [
          `${move.warehouseId}|${move.variant.variantId}`,
          sql`(${move.warehouseId}::uuid, ${move.variant.variantId}::uuid)`,
        ]),
      ).values(),
    ];
    const balances = await tx
      .select({
        warehouseId: stockBalances.warehouseId,
        variantId: stockBalances.variantId,
        batchId: stockBalances.batchId,
        quantity: stockBalances.quantity,
      })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, tenantId),
          sql`(${stockBalances.warehouseId}, ${stockBalances.variantId}) IN (${sql.join(pairs, sql`, `)})`,
        ),
      )
      .orderBy(
        asc(stockBalances.warehouseId),
        asc(stockBalances.variantId),
        sql`${stockBalances.batchId} NULLS FIRST`,
      )
      .for('update');
    const available = new Map(
      balances.map((row) => [
        balanceKey(row.warehouseId, row.variantId, row.batchId),
        row.quantity,
      ]),
    );

    const demand = new Map<string, string[]>();
    for (const move of posting.moves) {
      const key = balanceKey(move.warehouseId, move.variant.variantId, move.batchId);
      demand.set(key, [...(demand.get(key) ?? []), move.quantity]);
    }

    const [settings] = await tx
      .select({ allowNegativeStock: tenantSettings.allowNegativeStock })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const issues: LineIssue[] = [];
    for (const move of posting.moves) {
      // Below zero is allowed only when the workspace says so, and never for a batch or an IMEI
      if (move.variant.tracking === 'none' && settings?.allowNegativeStock === true) continue;
      const key = balanceKey(move.warehouseId, move.variant.variantId, move.batchId);
      const wanted = sumQuantity(demand.get(key) ?? []);
      if (compareQuantity(available.get(key) ?? '0', wanted) < 0) {
        issues.push({ path: linePath(move.line, 'quantity'), code: 'stock_insufficient' });
      }
    }
    if (issues.length > 0) throw linesError(issues);

    const totals = new Map<string, string[]>();
    for (const row of balances) {
      const key = `${row.warehouseId}|${row.variantId}`;
      totals.set(key, [...(totals.get(key) ?? []), row.quantity]);
    }
    return new Map([...totals].map(([key, values]) => [key, sumQuantity(values)]));
  }

  // The places this document took down to (or below) their reorder level: one outbox event per
  // warehouse, and the worker tells the people who manage products (LowStockHandler). Only a
  // crossing counts — stock that was already low does not ring again with every sale.
  private async reportLow(
    tx: Transaction,
    posting: StockPosting,
    before: Map<string, string>,
  ): Promise<void> {
    const taken = new Map<
      string,
      { warehouseId: string; variantId: string; quantities: string[] }
    >();
    for (const move of posting.moves) {
      const key = `${move.warehouseId}|${move.variant.variantId}`;
      const entry = taken.get(key) ?? {
        warehouseId: move.warehouseId,
        variantId: move.variant.variantId,
        quantities: [],
      };
      entry.quantities.push(move.quantity);
      taken.set(key, entry);
    }
    const pairs = [...taken.values()].map(
      (entry) => sql`(${entry.warehouseId}::uuid, ${entry.variantId}::uuid)`,
    );
    const levels = await tx
      .select({
        warehouseId: reorderLevels.warehouseId,
        variantId: reorderLevels.variantId,
        minQuantity: reorderLevels.minQuantity,
      })
      .from(reorderLevels)
      .where(
        and(
          eq(reorderLevels.tenantId, getTenantId()),
          sql`(${reorderLevels.warehouseId}, ${reorderLevels.variantId}) IN (${sql.join(pairs, sql`, `)})`,
        ),
      );
    const crossed = new Map<string, string[]>();
    for (const level of levels) {
      const key = `${level.warehouseId}|${level.variantId}`;
      const was = before.get(key) ?? '0';
      const now = subtractQuantity(was, sumQuantity(taken.get(key)?.quantities ?? []));
      if (
        compareQuantity(was, level.minQuantity) > 0 &&
        compareQuantity(now, level.minQuantity) <= 0
      ) {
        crossed.set(level.warehouseId, [
          ...(crossed.get(level.warehouseId) ?? []),
          level.variantId,
        ]);
      }
    }
    for (const [warehouseId, variantIds] of crossed) {
      await emit(tx, 'stock.below_reorder', { warehouseId, variantIds });
    }
  }
}
```

- **`assertDate()`** — the period lock first (it takes the shared advisory lock of step 10, so the lock date cannot
  move under a posting), then "not in the future", in the company's time zone.
- **`resolveBatches()`**: `INSERT … ON CONFLICT DO NOTHING` without a target catches the expression index
  `(variant_id, lower(lot_number))`; then the row is read again. Two documents bringing in the same new lot at the
  same moment both end up with the one batch. The lookup happens first so that only a *new* lot needs its expiry.
- **`checkSerials()`** — "in": the serial numbers are inserted if new, then all of them locked; each must be in no
  warehouse *and* on no truck (another transfer in transit). A transfer's own receipt is told apart by
  `receivingTransferId`. "Out": each must be in this warehouse.
- **`checkAvailable()`**:
  - It locks **every balance row of each (warehouse, variant)**, all batches, `ORDER BY` the same key every
    document uses. Two documents touching the same products then wait for each other instead of deadlocking.
  - Lines on the same balance are added up first: 50 + 30 from one batch of 72 is refused, even though each line
    alone would pass.
  - Negative stock is allowed only for untracked products and only when the workspace says so.
  - It returns each place's stock *before* this document, for the reorder check.
- **Movements are inserted in balance-key order** for the same reason as the lock order: the trigger takes the
  balance rows in that order too.
- **`triggerError()`** turns the trigger's refusals (`stock_balances_not_negative`, `serials_in_stock`,
  `serials_not_here`) into the API's 409s. They carry no field: the trigger does not know which line a movement
  came from. `isCheckViolation()` is new in `common/db/pg-errors.ts` (13.4).
- **`reportLow()`** looks for the *crossing*: above the level before, at or below after. It emits one outbox event
  per warehouse with the variant ids — ids only, never names (the worker reads the current rows).

### `inventory/warehouses.service.ts` and `warehouses.controller.ts` (new)

`apps/api/src/inventory/warehouses.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  UpdateWarehouseInput,
  Warehouse,
  WarehouseInput,
  WarehouseStatus,
} from '@omnivo/contracts';
import { branches, stockBalances, stockMovements, stockTransfers, warehouses } from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type WarehouseRow = typeof warehouses.$inferSelect;

function toWarehouse(row: WarehouseRow): Warehouse {
  return {
    id: row.id,
    branchId: row.branchId,
    code: row.code,
    name: row.name,
    address: row.address,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows: the form's fields, with the branch by its code
function snapshot(row: Pick<WarehouseRow, 'code' | 'name' | 'address'>, branch: string | null) {
  return { code: row.code, name: row.name, address: row.address, branch };
}

function codeTaken(code: string): AppError {
  return new AppError(409, 'warehouse_code_taken', `Warehouse code ${code} is already used.`, {
    fieldErrors: { code: ['warehouse_code_taken'] },
  });
}

@Injectable()
export class WarehousesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(status: WarehouseStatus): Promise<Warehouse[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, getTenantId()),
            status === 'active' ? isNull(warehouses.archivedAt) : isNotNull(warehouses.archivedAt),
          ),
        )
        .orderBy(asc(warehouses.code));
      return rows.map(toWarehouse);
    });
  }

  async create(input: WarehouseInput): Promise<Warehouse> {
    try {
      return await this.withTenant(async (tx) => {
        const branch = await this.activeBranch(tx, input.branchId);
        const [row] = await tx
          .insert(warehouses)
          .values({ tenantId: getTenantId(), ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Warehouse insert returned no row');
        await audit(tx, {
          action: 'warehouse.created',
          entityType: 'warehouse',
          entityId: row.id,
          changes: created(snapshot(row, branch)),
        });
        return toWarehouse(row);
      });
    } catch (error) {
      // Caught outside the transaction, after the rollback (step 6's pattern)
      if (isUniqueViolation(error, 'warehouses_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  async update(id: string, input: UpdateWarehouseInput): Promise<Warehouse> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        const { version, ...fields } = input;
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        const oldBranch = await this.branchCode(tx, before.branchId);
        const newBranch =
          fields.branchId === before.branchId
            ? oldBranch
            : await this.activeBranch(tx, fields.branchId);
        // Its history belongs to the branch it was in: moving a warehouse that already has
        // movements would move years of stock (and, from step 14, its value) to another branch
        if (fields.branchId !== before.branchId && (await this.hasMovements(tx, id))) {
          throw new AppError(
            409,
            'warehouse_branch_locked',
            'A warehouse with stock history stays in its branch.',
            { fieldErrors: { branchId: ['warehouse_branch_locked'] } },
          );
        }
        const [after] = await tx
          .update(warehouses)
          .set({
            ...fields,
            version: sql`${warehouses.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, id)))
          .returning();
        if (!after) throw notFound('Warehouse');
        await audit(tx, {
          action: 'warehouse.updated',
          entityType: 'warehouse',
          entityId: id,
          changes: diff(snapshot(before, oldBranch), snapshot(after, newBranch)),
        });
        return toWarehouse(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'warehouses_tenant_code_idx')) throw codeTaken(input.code);
      throw error;
    }
  }

  setArchived(id: string, version: number, archived: boolean): Promise<Warehouse> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // FOR UPDATE: documents being posted hold it FOR SHARE (assertWarehousesActive), so an
      // archive waits for them — and then sees the stock they brought in
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toWarehouse(before);
      if (archived) {
        // Stock in it would vanish from every list. Move it out or adjust it to zero first.
        const [stock] = await tx
          .select({ quantity: stockBalances.quantity })
          .from(stockBalances)
          .where(
            and(
              eq(stockBalances.tenantId, tenantId),
              eq(stockBalances.warehouseId, id),
              ne(stockBalances.quantity, '0'),
            ),
          )
          .limit(1);
        if (stock) {
          throw new AppError(409, 'warehouse_has_stock', 'Move or adjust its stock out first.');
        }
        // A truck on its way to or from it still has to arrive somewhere
        const [moving] = await tx
          .select({ id: stockTransfers.id })
          .from(stockTransfers)
          .where(
            and(
              eq(stockTransfers.tenantId, tenantId),
              eq(stockTransfers.status, 'in_transit'),
              or(eq(stockTransfers.fromWarehouseId, id), eq(stockTransfers.toWarehouseId, id)),
            ),
          )
          .limit(1);
        if (moving) {
          throw new AppError(
            409,
            'warehouse_has_transfers',
            'Receive the transfers on their way first.',
          );
        }
      } else {
        // Its branch may have been archived meanwhile: a warehouse comes back to an active branch
        await this.activeBranch(tx, before.branchId);
      }
      const [after] = await tx
        .update(warehouses)
        .set({
          archivedAt: archived ? new Date() : null,
          version: sql`${warehouses.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, id)))
        .returning();
      if (!after) throw notFound('Warehouse');
      await audit(tx, {
        action: archived ? 'warehouse.archived' : 'warehouse.restored',
        entityType: 'warehouse',
        entityId: id,
      });
      return toWarehouse(after);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<WarehouseRow> {
    const [row] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, id)))
      .for('update');
    if (!row) throw notFound('Warehouse');
    return row;
  }

  // An active branch of this workspace, locked against archiving until we commit
  // (BranchesService.archive refuses a branch with active warehouses). Returns its code.
  private async activeBranch(tx: Transaction, branchId: string): Promise<string> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(
        and(
          eq(branches.tenantId, getTenantId()),
          eq(branches.id, branchId),
          isNull(branches.archivedAt),
        ),
      )
      .for('share');
    if (!branch) {
      throw new AppError(409, 'warehouse_branch_invalid', 'Pick an active branch.', {
        fieldErrors: { branchId: ['warehouse_branch_invalid'] },
      });
    }
    return branch.code;
  }

  private async branchCode(tx: Transaction, branchId: string): Promise<string | null> {
    const [branch] = await tx
      .select({ code: branches.code })
      .from(branches)
      .where(and(eq(branches.tenantId, getTenantId()), eq(branches.id, branchId)));
    return branch?.code ?? null;
  }

  private async hasMovements(tx: Transaction, id: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, getTenantId()), eq(stockMovements.warehouseId, id)))
      .limit(1);
    return row !== undefined;
  }
}
```

`apps/api/src/inventory/warehouses.controller.ts`:

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { WarehousesService } from './warehouses.service.js';

type Routes = typeof routes.warehouses;

@Controller()
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Endpoint(routes.warehouses.list)
  async list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.warehouses.list(query.status) };
  }

  @Endpoint(routes.warehouses.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.warehouses.create(body);
  }

  @Endpoint(routes.warehouses.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.warehouses.update(params.id, body);
  }

  @Endpoint(routes.warehouses.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.warehouses.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.warehouses.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.warehouses.setArchived(params.id, body.version, false);
  }
}
```

- **The unique violation is caught outside `withTenant`**, after the rollback — the same pattern as branches:
  checking first with a `SELECT` would let two people take the same code at the same moment.
- **Archiving checks two things**: no stock left (`ne(quantity, '0')`, so a negative balance counts as stock too),
  and no transfer on its way to or from it.
- **Restoring checks the branch** is active: a warehouse cannot come back into an archived branch.

### `inventory/stock-adjustments.service.ts` (new)

`apps/api/src/inventory/stock-adjustments.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  StockAdjustment,
  StockAdjustmentInput,
  StockAdjustmentSummary,
  StockDocumentStatus,
  UpdateStockAdjustmentInput,
} from '@omnivo/contracts';
import { stockAdjustmentLines, stockAdjustments, warehouses } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineInput,
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from './stock-lines.js';
import { StockPostingService } from './stock-posting.service.js';

type AdjustmentRow = typeof stockAdjustments.$inferSelect;
type LineRow = typeof stockAdjustmentLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The outer table by its name: in a select from one table, Drizzle prints ${stockAdjustments.id}
// as a bare "id", which inside this subquery would mean the line's own id
const lineCount = sql<number>`(
  SELECT count(*)::int FROM stock_adjustment_lines l
   WHERE l.tenant_id = stock_adjustments.tenant_id AND l.adjustment_id = stock_adjustments.id
)`;

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. Post another adjustment to correct a posted one.',
  );
}

function toSummary(row: AdjustmentRow, lines: number): StockAdjustmentSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    warehouseId: row.warehouseId,
    direction: row.direction,
    reason: row.reason,
    note: row.note,
    status: row.status,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A stored line as resolveLines() takes it, to check it again when the draft is posted
function storedInput(line: LineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: line.serialNumbers,
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn,
    manufacturedOn: line.manufacturedOn,
  };
}

@Injectable()
export class StockAdjustmentsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: StockDocumentStatus | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: StockAdjustmentSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.status === undefined ? undefined : eq(stockAdjustments.status, query.status),
          query.warehouseId === undefined
            ? undefined
            : eq(stockAdjustments.warehouseId, query.warehouseId),
          after === undefined
            ? undefined
            : sql`(${stockAdjustments.date}, ${stockAdjustments.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<StockAdjustment> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: StockAdjustmentInput): Promise<StockAdjustment> {
    return this.withTenant(async (tx) => {
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveLines(tx, input.lines, input.direction);
      const [row] = await tx
        .insert(stockAdjustments)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          warehouseId: input.warehouseId,
          direction: input.direction,
          reason: input.reason,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Stock adjustment insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'stock_adjustment.created',
        entityType: 'stock_adjustment',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateStockAdjustmentInput): Promise<StockAdjustment> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveLines(tx, input.lines, input.direction);
      const [updated] = await tx
        .update(stockAdjustments)
        .set({
          date: input.date,
          warehouseId: input.warehouseId,
          direction: input.direction,
          reason: input.reason,
          note: input.note,
          version: sql`${stockAdjustments.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)))
        .returning();
      if (!updated) throw notFound('Stock adjustment');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'stock_adjustment.updated',
        entityType: 'stock_adjustment',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, linesBefore.length),
          await this.snapshot(tx, updated, lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(stockAdjustments)
        .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)));
      await audit(tx, {
        action: 'stock_adjustment.deleted',
        entityType: 'stock_adjustment',
        entityId: id,
        changes: diff(await this.snapshot(tx, before, lines.length), {
          date: null,
          warehouse: null,
          direction: null,
          reason: null,
          lines: null,
        }),
      });
    });
  }

  post(id: string, version: number): Promise<StockAdjustment> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // A draft into the stock ledger: the date and the warehouse checked, every line checked again
  // against its product as it is now (a pack may have been resized since the draft was saved), the
  // lots turned into batches, the number taken, and the movements written — all in the caller's
  // transaction, so a refused line leaves nothing posted and no number used.
  private async postAndLog(tx: Transaction, draft: AdjustmentRow): Promise<void> {
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveLines(tx, stored.map(storedInput), draft.direction, { lock: true });
    const batchIds =
      draft.direction === 'in'
        ? await this.posting.resolveBatches(tx, lines)
        : lines.map((line) => line.batchId);
    await this.writeLines(tx, draft.id, lines, batchIds);

    const number = await this.numbering.next(tx, 'inventory.adjustment', draft.date);
    await this.posting.post(tx, {
      date: draft.date,
      kind: 'adjustment',
      direction: draft.direction,
      documentId: draft.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        variant: line.variant,
        batchId: batchIds[index] ?? null,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    });
    await tx
      .update(stockAdjustments)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${stockAdjustments.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, draft.id)));
    await audit(tx, {
      action: 'stock_adjustment.posted',
      entityType: 'stock_adjustment',
      entityId: draft.id,
      changes: created({ number }),
    });
  }

  // The lines in the order they were written. batchIds: set when posting brings lots in.
  private async writeLines(
    tx: Transaction,
    adjustmentId: string,
    lines: readonly ResolvedLine[],
    batchIds: readonly (string | null)[] = lines.map((line) => line.batchId),
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(stockAdjustmentLines)
      .where(
        and(
          eq(stockAdjustmentLines.tenantId, tenantId),
          eq(stockAdjustmentLines.adjustmentId, adjustmentId),
        ),
      );
    await tx.insert(stockAdjustmentLines).values(
      lines.map((line, index) => ({
        tenantId,
        adjustmentId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: batchIds[index] ?? null,
        lotNumber: line.lotNumber,
        expiresOn: line.expiresOn,
        manufacturedOn: line.manufacturedOn,
        serialNumbers: line.serialNumbers,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<AdjustmentRow> {
    const [row] = await tx
      .select()
      .from(stockAdjustments)
      .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)))
      .for('update');
    if (!row) throw notFound('Stock adjustment');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, adjustmentId: string) {
    return tx
      .select()
      .from(stockAdjustmentLines)
      .where(
        and(
          eq(stockAdjustmentLines.tenantId, getTenantId()),
          eq(stockAdjustmentLines.adjustmentId, adjustmentId),
        ),
      )
      .orderBy(asc(stockAdjustmentLines.lineNo));
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<StockAdjustmentSummary[]> {
    const rows = await tx
      .select({ adjustment: stockAdjustments, lineCount })
      .from(stockAdjustments)
      .where(and(eq(stockAdjustments.tenantId, getTenantId()), where))
      .orderBy(desc(stockAdjustments.date), desc(stockAdjustments.id))
      .limit(limit);
    return rows.map((row) => toSummary(row.adjustment, row.lineCount));
  }

  private async read(tx: Transaction, id: string): Promise<StockAdjustment> {
    const [summary] = await this.summaries(tx, eq(stockAdjustments.id, id), 1);
    if (!summary) throw notFound('Stock adjustment');
    const lines = await this.linesOf(tx, id);
    const [variants, batches] = await Promise.all([
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
    ]);
    return {
      ...summary,
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          toStockLine(line, variant, line.batchId === null ? undefined : batches.get(line.batchId)),
        ];
      }),
    };
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: AdjustmentRow, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      date: row.date,
      warehouse: warehouse?.code ?? null,
      direction: row.direction,
      reason: row.reason,
      lines,
    };
  }
}
```

- **`lineCount` names the outer table in plain SQL** (`stock_adjustments.id`). In a select from one table, Drizzle
  prints `${stockAdjustments.id}` as a bare `"id"`, and inside the subquery a bare `id` is the *line's* own id — the
  count was always 0. Found by the integration test (see "What we found on the way"). The journal's `total` works
  with Drizzle's columns only because its select has joins, which make Drizzle qualify every column.
- **`postAndLog()` checks every line again** with the products as they are now, locked. A pack resized after the
  draft was saved gives the posted line the new factor; a product archived meanwhile is refused.
- **The number is taken before the movements are written** (they carry it), inside the same transaction: a refused
  line rolls the number back, so numbers have no gaps.
- **`storedInput()`** turns a saved line back into what `resolveLines()` takes, so a draft and a fresh request go
  through exactly the same rules.

### `inventory/stock-transfers.service.ts` (new)

`apps/api/src/inventory/stock-transfers.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type ErrorCode,
  fitsDecimals,
  isZeroQuantity,
  type ReceiveTransferInput,
  type StockTransfer,
  type StockTransferInput,
  type StockTransferSummary,
  type TransferStatus,
  type UpdateStockTransferInput,
  wholeCount,
} from '@omnivo/contracts';
import { stockTransferLines, stockTransfers, warehouses } from '@omnivo/db';
import { and, asc, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineInput,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from './stock-lines.js';
import { StockPostingService } from './stock-posting.service.js';

type TransferRow = typeof stockTransfers.$inferSelect;
type LineRow = typeof stockTransferLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The outer table by its name: in a select from one table, Drizzle prints ${stockTransfers.id} as
// a bare "id", which inside these subqueries would mean the line's own id
const lineCount = sql<number>`(
  SELECT count(*)::int FROM stock_transfer_lines l
   WHERE l.tenant_id = stock_transfers.tenant_id AND l.transfer_id = stock_transfers.id
)`;

// Any line received short: what was sent and what arrived differ
const short = sql<boolean>`EXISTS (
  SELECT 1 FROM stock_transfer_lines l
   WHERE l.tenant_id = stock_transfers.tenant_id AND l.transfer_id = stock_transfers.id
     AND l.received_quantity < l.base_quantity
)`;

function notDraft(): AppError {
  return new AppError(409, 'stock_not_draft', 'Only a draft transfer can be changed or sent.');
}

function toSummary(row: TransferRow, lines: number, isShort: boolean): StockTransferSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    fromWarehouseId: row.fromWarehouseId,
    toWarehouseId: row.toWarehouseId,
    sentOn: row.sentOn,
    receivedOn: row.receivedOn,
    note: row.note,
    lineCount: lines,
    short: isShort,
    sentAt: row.sentAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function storedInput(line: LineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: line.serialNumbers,
  };
}

@Injectable()
export class StockTransfersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: TransferStatus | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: StockTransferSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.status === undefined ? undefined : eq(stockTransfers.status, query.status),
          query.warehouseId === undefined
            ? undefined
            : or(
                eq(stockTransfers.fromWarehouseId, query.warehouseId),
                eq(stockTransfers.toWarehouseId, query.warehouseId),
              ),
          after === undefined
            ? undefined
            : sql`(${stockTransfers.sentOn}, ${stockTransfers.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.sentOn, last.id]);
    });
  }

  get(id: string): Promise<StockTransfer> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: StockTransferInput): Promise<StockTransfer> {
    return this.withTenant(async (tx) => {
      await this.assertPlaces(tx, input);
      const lines = await resolveLines(tx, input.lines, 'out');
      const [row] = await tx
        .insert(stockTransfers)
        .values({
          tenantId: getTenantId(),
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          sentOn: input.date,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Stock transfer insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'stock_transfer.created',
        entityType: 'stock_transfer',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, lines.length)),
      });
      if (input.send) await this.sendAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateStockTransferInput): Promise<StockTransfer> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      await this.assertPlaces(tx, input);
      const lines = await resolveLines(tx, input.lines, 'out');
      const [updated] = await tx
        .update(stockTransfers)
        .set({
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          sentOn: input.date,
          note: input.note,
          version: sql`${stockTransfers.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, id)))
        .returning();
      if (!updated) throw notFound('Stock transfer');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'stock_transfer.updated',
        entityType: 'stock_transfer',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, linesBefore.length),
          await this.snapshot(tx, updated, lines.length),
        ),
      });
      if (input.send) await this.sendAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      await tx
        .delete(stockTransfers)
        .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, id)));
      await audit(tx, {
        action: 'stock_transfer.deleted',
        entityType: 'stock_transfer',
        entityId: id,
        changes: diff(await this.snapshot(tx, before, lines.length), {
          date: null,
          from: null,
          to: null,
          lines: null,
        }),
      });
    });
  }

  send(id: string, version: number): Promise<StockTransfer> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.sendAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // The second step, at the destination: what arrived is added there, on the day it arrived. A
  // line received short keeps the difference as its shortage — it left the source and never
  // reached the destination, and the transfer is where anyone can see that.
  receive(id: string, input: ReceiveTransferInput): Promise<StockTransfer> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [transfer] = await tx
        .select()
        .from(stockTransfers)
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, id)))
        .for('update');
      if (!transfer) throw notFound('Stock transfer');
      if (transfer.status !== 'in_transit') {
        throw new AppError(
          409,
          'transfer_not_in_transit',
          'Only a transfer on its way can be received.',
        );
      }
      if (transfer.version !== input.version) throw versionConflict();
      // It cannot arrive before it left
      if (input.date < transfer.sentOn) {
        throw new AppError(409, 'transfer_receive_date', 'It cannot arrive before it was sent.', {
          fieldErrors: { date: ['transfer_receive_date'] },
        });
      }
      await this.posting.assertDate(tx, input.date);

      const stored = await this.linesOf(tx, id);
      // Every line exactly once: a receipt that leaves a line out would leave it in transit for
      // ever, with no way to say what happened to it
      const byId = new Map(input.lines.map((line, index) => [line.lineId, { line, index }]));
      if (stored.length !== input.lines.length || stored.some((line) => !byId.has(line.id))) {
        throw new AppError(409, 'transfer_lines_mismatch', 'Receive every line of the transfer.', {
          fieldErrors: { lines: ['transfer_lines_mismatch'] },
        });
      }
      const variants = await loadVariants(
        tx,
        stored.map((line) => line.variantId),
        { lock: true },
      );
      const issues: LineIssue[] = [];
      const receipts = stored.map((line) => {
        const received = byId.get(line.id);
        if (!received) throw new Error('Line checked above');
        const { index } = received;
        const at = (field: string, code: ErrorCode) => {
          issues.push({ path: linePath(index, field), code });
        };
        const variant = variants.get(line.variantId);
        if (!variant) throw new Error(`Variant ${line.variantId} of a sent line is missing`);
        const quantity = received.line.receivedQuantity;
        if (compareQuantity(quantity, line.baseQuantity) > 0) {
          at('receivedQuantity', 'transfer_receive_too_many');
        } else if (!fitsDecimals(quantity, variant.baseDecimals)) {
          at('receivedQuantity', 'stock_quantity_decimals');
        }
        const serialNumbers = received.line.serialNumbers;
        if (variant.tracking === 'serial') {
          const sent = new Set(line.serialNumbers);
          received.line.serialNumbers.forEach((serial, serialIndex) => {
            if (!sent.has(serial))
              at(`serialNumbers.${String(serialIndex)}`, 'transfer_serial_not_sent');
          });
          if (wholeCount(quantity) !== serialNumbers.length || !fitsDecimals(quantity, 0)) {
            at('serialNumbers', 'stock_serial_count');
          }
        } else if (serialNumbers.length > 0) {
          at('serialNumbers', 'stock_serial_count');
        }
        return { line, index, variant, quantity, serialNumbers };
      });
      if (issues.length > 0) throw linesError(issues);

      for (const receipt of receipts) {
        await tx
          .update(stockTransferLines)
          .set({
            receivedQuantity: receipt.quantity,
            receivedSerialNumbers: receipt.serialNumbers,
          })
          .where(
            and(
              eq(stockTransferLines.tenantId, tenantId),
              eq(stockTransferLines.id, receipt.line.id),
            ),
          );
      }
      await this.posting.post(tx, {
        date: input.date,
        kind: 'transfer_in',
        direction: 'in',
        documentId: id,
        documentNumber: transfer.number ?? '',
        receivingTransferId: id,
        // Nothing arrived on a line: no movement for it, only its shortage
        moves: receipts.flatMap((receipt) =>
          isZeroQuantity(receipt.quantity)
            ? []
            : [
                {
                  line: receipt.index,
                  warehouseId: transfer.toWarehouseId,
                  variant: receipt.variant,
                  batchId: receipt.line.batchId,
                  quantity: receipt.quantity,
                  serialNumbers: receipt.serialNumbers,
                },
              ],
        ),
      });
      await tx
        .update(stockTransfers)
        .set({
          status: 'received',
          receivedOn: input.date,
          receivedAt: new Date(),
          receivedBy: currentPrincipal().userId,
          version: sql`${stockTransfers.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, id)));
      const isShort = receipts.some(
        (receipt) => compareQuantity(receipt.quantity, receipt.line.baseQuantity) < 0,
      );
      await audit(tx, {
        action: 'stock_transfer.received',
        entityType: 'stock_transfer',
        entityId: id,
        changes: created({ date: input.date, short: isShort }),
      });
      return this.read(tx, id);
    });
  }

  // The first step: the stock leaves the source, today's number is taken, and the transfer is in
  // transit. The lines are checked again with the products as they are now, like a journal post.
  private async sendAndLog(tx: Transaction, draft: TransferRow): Promise<void> {
    await this.posting.assertDate(tx, draft.sentOn);
    await this.assertPlaces(tx, {
      fromWarehouseId: draft.fromWarehouseId,
      toWarehouseId: draft.toWarehouseId,
    });
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveLines(tx, stored.map(storedInput), 'out', { lock: true });
    await this.writeLines(tx, draft.id, lines);
    const number = await this.numbering.next(tx, 'inventory.transfer', draft.sentOn);
    await this.posting.post(tx, {
      date: draft.sentOn,
      kind: 'transfer_out',
      direction: 'out',
      documentId: draft.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: draft.fromWarehouseId,
        variant: line.variant,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    });
    await tx
      .update(stockTransfers)
      .set({
        status: 'in_transit',
        number,
        sentAt: new Date(),
        sentBy: currentPrincipal().userId,
        version: sql`${stockTransfers.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, draft.id)));
    await audit(tx, {
      action: 'stock_transfer.sent',
      entityType: 'stock_transfer',
      entityId: draft.id,
      changes: created({ number }),
    });
  }

  private assertPlaces(
    tx: Transaction,
    input: { fromWarehouseId: string; toWarehouseId: string },
  ): Promise<void> {
    return assertWarehousesActive(tx, [
      { field: 'fromWarehouseId', warehouseId: input.fromWarehouseId },
      { field: 'toWarehouseId', warehouseId: input.toWarehouseId },
    ]);
  }

  private async writeLines(
    tx: Transaction,
    transferId: string,
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(stockTransferLines)
      .where(
        and(
          eq(stockTransferLines.tenantId, tenantId),
          eq(stockTransferLines.transferId, transferId),
        ),
      );
    await tx.insert(stockTransferLines).values(
      lines.map((line, index) => ({
        tenantId,
        transferId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
      })),
    );
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<TransferRow> {
    const [row] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, id)))
      .for('update');
    if (!row) throw notFound('Stock transfer');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, transferId: string) {
    return tx
      .select()
      .from(stockTransferLines)
      .where(
        and(
          eq(stockTransferLines.tenantId, getTenantId()),
          eq(stockTransferLines.transferId, transferId),
        ),
      )
      .orderBy(asc(stockTransferLines.lineNo));
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<StockTransferSummary[]> {
    const rows = await tx
      .select({ transfer: stockTransfers, lineCount, short })
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, getTenantId()), where))
      .orderBy(desc(stockTransfers.sentOn), desc(stockTransfers.id))
      .limit(limit);
    return rows.map((row) => toSummary(row.transfer, row.lineCount, row.short));
  }

  private async read(tx: Transaction, id: string): Promise<StockTransfer> {
    const [summary] = await this.summaries(tx, eq(stockTransfers.id, id), 1);
    if (!summary) throw notFound('Stock transfer');
    const lines = await this.linesOf(tx, id);
    const [variants, batches] = await Promise.all([
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
    ]);
    return {
      ...summary,
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        if (!variant) return [];
        return [
          {
            ...toStockLine(
              line,
              variant,
              line.batchId === null ? undefined : batches.get(line.batchId),
            ),
            receivedQuantity: line.receivedQuantity,
            receivedSerialNumbers: line.receivedSerialNumbers,
          },
        ];
      }),
    };
  }

  private async snapshot(tx: Transaction, row: TransferRow, lines: number) {
    const places = await tx
      .select({ id: warehouses.id, code: warehouses.code })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, getTenantId()),
          inArray(warehouses.id, [row.fromWarehouseId, row.toWarehouseId]),
        ),
      );
    const code = (id: string) => places.find((place) => place.id === id)?.code ?? null;
    return {
      date: row.sentOn,
      from: code(row.fromWarehouseId),
      to: code(row.toWarehouseId),
      lines,
    };
  }
}
```

- **`short`** uses the same plain-SQL rule as `lineCount`.
- **`receive()`** locks the transfer, checks it is still in transit, then the version (a second receipt of the
  same transfer gets `transfer_not_in_transit`, which says more than `version_conflict`).
- **Received lines are matched by id, errors by the input's index.** The form sends the lines in the transfer's
  order, so `lines.0.receivedQuantity` is the first row on screen.
- **A line with nothing received writes no movement** — its whole quantity stays as the shortage.

### `inventory/stock.service.ts` (new)

`apps/api/src/inventory/stock.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  addQuantity,
  type BatchStockPage,
  type ReorderLevelInput,
  type ReorderPage,
  shiftIsoDate,
  type StockCard,
  type StockFilter,
  type StockItem,
  type StockMovementPage,
  type StockPage,
  todayIn,
} from '@omnivo/contracts';
import {
  batches,
  products,
  productVariants,
  reorderLevels,
  serials,
  stockBalances,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, gt, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, diff } from '../common/audit/audit.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// Postgres's NUMERIC as the API sends every quantity: 4 decimals, "0.0000" for nothing
function quantityText(value: SQL): SQL<string> {
  return sql<string>`round(coalesce(${value}, 0), 4)::text`;
}

// LIKE's own wildcards in what the person typed are meant literally (as in the product list)
function containsPattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const unitsSchema = z.array(z.object({ unitId: z.uuid(), factor: z.string() }));

const itemRowSchema = z.object({
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  tracking: z.string(),
  has_expiry: z.boolean(),
  // postgres.js parses json; a driver that does not would hand over the text
  units: z.union([
    unitsSchema,
    z
      .string()
      .transform((text): unknown => JSON.parse(text))
      .pipe(unitsSchema),
  ]),
  archived: z.boolean(),
  on_hand: z.string(),
  in_transit: z.string(),
  low: z.boolean(),
  sort_key: z.string(),
  position: z.number().int(),
});

function toItem(row: z.output<typeof itemRowSchema>): StockItem {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    optionValues: row.option_values,
    sku: row.sku,
    baseUnitId: row.base_unit_id,
    tracking: row.tracking,
    hasExpiry: row.has_expiry,
    units: row.units,
    archived: row.archived,
    onHand: row.on_hand,
    inTransit: row.in_transit,
    low: row.low,
  };
}

const listCursorSchema = z.tuple([z.string(), z.uuid(), z.number().int()]);
const movementCursorSchema = z.tuple([z.iso.date(), z.uuid()]);
// A batch without an expiry sorts last: 9999-12-31 stands for "never"
const NEVER = '9999-12-31';
const batchCursorSchema = z.tuple([z.iso.date(), z.uuid(), z.uuid()]);
const reorderCursorSchema = z.tuple([z.string(), z.uuid(), z.uuid()]);

const batchRowSchema = z.object({
  batch_id: z.uuid(),
  lot_number: z.string(),
  manufactured_on: z.iso.date().nullable(),
  expires_on: z.iso.date().nullable(),
  warehouse_id: z.uuid(),
  quantity: z.string(),
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
});

const reorderRowSchema = z.object({
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  warehouse_id: z.uuid(),
  on_hand: z.string(),
  in_transit: z.string(),
  min_quantity: z.string(),
  reorder_quantity: z.string().nullable(),
  sort_key: z.string(),
});

// Reading stock: every query here reads stock_balances (what is there now) and stock_movements
// (how it got there) — never a quantity stored on a product.
@Injectable()
export class StockService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    warehouseId?: string | undefined;
    categoryId?: string | undefined;
    filter: StockFilter;
  }): Promise<StockPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, listCursorSchema);
    const conditions: SQL[] = [
      // Archived products and variants drop out of the list once they hold nothing
      sql`((p.archived_at IS NULL AND v.archived_at IS NULL) OR coalesce(s.on_hand, 0) <> 0)`,
    ];
    if (query.filter === 'in_stock') conditions.push(sql`coalesce(s.on_hand, 0) > 0`);
    if (query.filter === 'low') conditions.push(lowCondition(query.warehouseId));
    if (query.categoryId !== undefined) {
      // The category and everything under it, like the product list
      conditions.push(sql`p.category_id IN (
        WITH RECURSIVE down AS (
          SELECT id FROM product_categories WHERE tenant_id = ${tenantId}::uuid AND id = ${query.categoryId}::uuid
          UNION ALL
          SELECT c.id FROM product_categories c JOIN down ON c.parent_id = down.id
           WHERE c.tenant_id = ${tenantId}::uuid
        ) SELECT id FROM down)`);
    }
    if (query.search !== undefined && query.search !== '') {
      const pattern = containsPattern(query.search);
      // A barcode and a serial number are matched whole: a scan into the search box finds the
      // variant itself, not every product of the style
      conditions.push(sql`(
        lower(p.name) LIKE ${pattern} OR lower(p.code) LIKE ${pattern} OR lower(v.sku) LIKE ${pattern}
        OR EXISTS (SELECT 1 FROM product_barcodes b
                    WHERE b.tenant_id = v.tenant_id AND b.variant_id = v.id AND b.code = ${query.search})
        OR EXISTS (SELECT 1 FROM serials sr
                    WHERE sr.tenant_id = v.tenant_id AND sr.variant_id = v.id AND sr.serial_number = ${query.search}))`);
    }
    if (after !== undefined) {
      conditions.push(
        sql`(lower(p.name), p.id, v.position) > (${after[0]}, ${after[1]}::uuid, ${after[2]}::int)`,
      );
    }
    return this.withTenant(async (tx) => {
      const rows = await this.items(tx, conditions, query.warehouseId, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toItem),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor([last.sort_key, last.product_id, last.position])
            : null,
      };
    });
  }

  card(variantId: string): Promise<StockCard> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [row] = await this.items(tx, [sql`v.id = ${variantId}::uuid`], undefined, 1);
      if (!row) throw notFound('Variant');

      const balance = sql<string>`(SELECT sum(sb.quantity) FROM stock_balances sb
        WHERE sb.tenant_id = w.tenant_id AND sb.warehouse_id = w.id AND sb.variant_id = ${variantId}::uuid)`;
      const places = z
        .array(
          z.object({
            warehouse_id: z.uuid(),
            on_hand: z.string(),
            in_transit: z.string(),
            min_quantity: z.string().nullable(),
            reorder_quantity: z.string().nullable(),
          }),
        )
        .parse(
          await tx.execute(sql`
            SELECT w.id::text AS warehouse_id, ${quantityText(balance)} AS on_hand,
                   ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                      JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                     WHERE l.tenant_id = w.tenant_id AND l.variant_id = ${variantId}::uuid
                       AND t.status = 'in_transit' AND t.to_warehouse_id = w.id)`)} AS in_transit,
                   r.min_quantity::text AS min_quantity, r.reorder_quantity::text AS reorder_quantity
              FROM warehouses w
              LEFT JOIN reorder_levels r
                ON r.tenant_id = w.tenant_id AND r.warehouse_id = w.id AND r.variant_id = ${variantId}::uuid
             WHERE w.tenant_id = ${tenantId}::uuid
               AND (w.archived_at IS NULL OR coalesce(${balance}, 0) <> 0)
             ORDER BY w.code`),
        );

      // FEFO: the batch that expires first is used first; no expiry goes last
      const batchRows = await tx
        .select({
          batchId: batches.id,
          lotNumber: batches.lotNumber,
          manufacturedOn: batches.manufacturedOn,
          expiresOn: batches.expiresOn,
          warehouseId: stockBalances.warehouseId,
          quantity: stockBalances.quantity,
        })
        .from(stockBalances)
        .innerJoin(
          batches,
          and(eq(batches.tenantId, stockBalances.tenantId), eq(batches.id, stockBalances.batchId)),
        )
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.variantId, variantId),
            gt(stockBalances.quantity, '0'),
          ),
        )
        .orderBy(
          sql`${batches.expiresOn} ASC NULLS LAST`,
          sql`lower(${batches.lotNumber})`,
          asc(stockBalances.warehouseId),
        );

      const inStock = await tx
        .select({ serialNumber: serials.serialNumber, warehouseId: serials.warehouseId })
        .from(serials)
        .where(
          and(
            eq(serials.tenantId, tenantId),
            eq(serials.variantId, variantId),
            isNotNull(serials.warehouseId),
          ),
        )
        .orderBy(asc(serials.serialNumber));
      const travelling = await tx
        .select({ serialNumbers: stockTransferLines.serialNumbers })
        .from(stockTransferLines)
        .innerJoin(
          stockTransfers,
          and(
            eq(stockTransfers.tenantId, stockTransferLines.tenantId),
            eq(stockTransfers.id, stockTransferLines.transferId),
          ),
        )
        .where(
          and(
            eq(stockTransferLines.tenantId, tenantId),
            eq(stockTransferLines.variantId, variantId),
            eq(stockTransfers.status, 'in_transit'),
          ),
        );

      return {
        item: toItem(row),
        warehouses: places.map((place) => ({
          warehouseId: place.warehouse_id,
          onHand: place.on_hand,
          inTransit: place.in_transit,
          minQuantity: place.min_quantity,
          reorderQuantity: place.reorder_quantity,
        })),
        batches: batchRows,
        serials: [
          ...inStock,
          ...travelling
            .flatMap((line) => line.serialNumbers)
            .sort()
            .map((serialNumber) => ({ serialNumber, warehouseId: null })),
        ],
      };
    });
  }

  // The stock card's history, like an account's ledger (LedgerService): in date order, with a
  // running balance that continues from page to page, an opening balance before `from` and a
  // closing balance up to `to`
  movements(
    variantId: string,
    query: {
      limit: number;
      cursor?: string | undefined;
      warehouseId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<StockMovementPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, movementCursorSchema);
    return this.withTenant(async (tx) => {
      const [variant] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.id, variantId)));
      if (!variant) throw notFound('Variant');

      const scope = and(
        eq(stockMovements.tenantId, tenantId),
        eq(stockMovements.variantId, variantId),
        query.warehouseId === undefined
          ? undefined
          : eq(stockMovements.warehouseId, query.warehouseId),
      );
      const position = sql`(${stockMovements.date}, ${stockMovements.id})`;
      const beforeFrom =
        query.from === undefined ? undefined : sql`${stockMovements.date} < ${query.from}::date`;

      const rows = await tx
        .select({
          id: stockMovements.id,
          date: stockMovements.date,
          warehouseId: stockMovements.warehouseId,
          kind: stockMovements.kind,
          documentId: stockMovements.documentId,
          documentNumber: stockMovements.documentNumber,
          quantity: stockMovements.quantity,
          lotNumber: batches.lotNumber,
          serialNumber: serials.serialNumber,
        })
        .from(stockMovements)
        .leftJoin(
          batches,
          and(
            eq(batches.tenantId, stockMovements.tenantId),
            eq(batches.id, stockMovements.batchId),
          ),
        )
        .leftJoin(
          serials,
          and(
            eq(serials.tenantId, stockMovements.tenantId),
            eq(serials.id, stockMovements.serialId),
          ),
        )
        .where(
          and(
            scope,
            query.from === undefined
              ? undefined
              : sql`${stockMovements.date} >= ${query.from}::date`,
            query.to === undefined ? undefined : sql`${stockMovements.date} <= ${query.to}::date`,
            after === undefined
              ? undefined
              : sql`${position} > (${after[0]}::date, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(asc(stockMovements.date), asc(stockMovements.id))
        .limit(query.limit + 1);

      const sumWhere = (condition: SQL | undefined) =>
        quantityText(sql`sum(${stockMovements.quantity}) FILTER (WHERE ${condition ?? sql`true`})`);
      const [sums] = await tx
        .select({
          beforePage: sumWhere(
            after === undefined
              ? (beforeFrom ?? sql`false`)
              : sql`${position} <= (${after[0]}::date, ${after[1]}::uuid)`,
          ),
          opening: sumWhere(beforeFrom ?? sql`false`),
          closing: sumWhere(
            query.to === undefined ? undefined : sql`${stockMovements.date} <= ${query.to}::date`,
          ),
        })
        .from(stockMovements)
        .where(scope);
      if (!sums) throw new Error('Stock card sums returned no row');

      const page = toPage(rows, query.limit, (last) => [last.date, last.id]);
      let balance = sums.beforePage;
      return {
        items: page.items.map((row) => {
          balance = addQuantity(balance, row.quantity);
          return { ...row, balance };
        }),
        nextCursor: page.nextCursor,
        openingBalance: sums.opening,
        closingBalance: sums.closing,
      };
    });
  }

  // The expiry report: every batch with stock, the soonest expiry first — expired ones on top
  batches(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId?: string | undefined;
    expiresWithin?: number | undefined;
  }): Promise<BatchStockPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, batchCursorSchema);
    return this.withTenant(async (tx) => {
      const conditions: SQL[] = [sql`sb.tenant_id = ${tenantId}::uuid`, sql`sb.quantity > 0`];
      if (query.warehouseId !== undefined) {
        conditions.push(sql`sb.warehouse_id = ${query.warehouseId}::uuid`);
      }
      if (query.expiresWithin !== undefined) {
        // "Within 30 days" counts from today in the company's time zone, not the server's
        const until = shiftIsoDate(await this.today(tx), query.expiresWithin);
        conditions.push(sql`b.expires_on <= ${until}::date`);
      }
      const key = sql`coalesce(b.expires_on, ${NEVER}::date)`;
      if (after !== undefined) {
        conditions.push(
          sql`(${key}, b.id, sb.warehouse_id) > (${after[0]}::date, ${after[1]}::uuid, ${after[2]}::uuid)`,
        );
      }
      const rows = z.array(batchRowSchema).parse(
        await tx.execute(sql`
          SELECT b.id::text AS batch_id, b.lot_number, b.manufactured_on::text AS manufactured_on,
                 b.expires_on::text AS expires_on, sb.warehouse_id::text AS warehouse_id,
                 round(sb.quantity, 4)::text AS quantity, v.id::text AS variant_id,
                 p.id::text AS product_id, p.code AS product_code, p.name AS product_name,
                 v.option_values, v.sku, p.base_unit_id::text AS base_unit_id
            FROM stock_balances sb
            JOIN batches b ON b.tenant_id = sb.tenant_id AND b.id = sb.batch_id
            JOIN product_variants v ON v.tenant_id = sb.tenant_id AND v.id = sb.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
           WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY ${key}, b.id, sb.warehouse_id
           LIMIT ${query.limit + 1}`),
      );
      const page = toPage(rows, query.limit, (last) => [
        last.expires_on ?? NEVER,
        last.batch_id,
        last.warehouse_id,
      ]);
      return {
        items: page.items.map((row) => ({
          batchId: row.batch_id,
          lotNumber: row.lot_number,
          manufacturedOn: row.manufactured_on,
          expiresOn: row.expires_on,
          warehouseId: row.warehouse_id,
          quantity: row.quantity,
          variantId: row.variant_id,
          productId: row.product_id,
          productCode: row.product_code,
          productName: row.product_name,
          optionValues: row.option_values,
          sku: row.sku,
          baseUnitId: row.base_unit_id,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // What to order: every variant whose stock in a warehouse is at or below its level there
  reorder(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<ReorderPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, reorderCursorSchema);
    return this.withTenant(async (tx) => {
      const conditions: SQL[] = [
        sql`r.tenant_id = ${tenantId}::uuid`,
        sql`coalesce(s.on_hand, 0) <= r.min_quantity`,
        sql`p.archived_at IS NULL AND v.archived_at IS NULL`,
      ];
      if (query.warehouseId !== undefined) {
        conditions.push(sql`r.warehouse_id = ${query.warehouseId}::uuid`);
      }
      if (after !== undefined) {
        conditions.push(
          sql`(lower(p.name), v.id, r.warehouse_id) > (${after[0]}, ${after[1]}::uuid, ${after[2]}::uuid)`,
        );
      }
      const rows = z.array(reorderRowSchema).parse(
        await tx.execute(sql`
          SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
                 p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
                 r.warehouse_id::text AS warehouse_id, ${quantityText(sql`s.on_hand`)} AS on_hand,
                 ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                    JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                   WHERE l.tenant_id = r.tenant_id AND l.variant_id = r.variant_id
                     AND t.status = 'in_transit' AND t.to_warehouse_id = r.warehouse_id)`)} AS in_transit,
                 round(r.min_quantity, 4)::text AS min_quantity,
                 round(r.reorder_quantity, 4)::text AS reorder_quantity,
                 lower(p.name) AS sort_key
            FROM reorder_levels r
            JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id AND w.archived_at IS NULL
            JOIN product_variants v ON v.tenant_id = r.tenant_id AND v.id = r.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN LATERAL (
              SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
               WHERE sb.tenant_id = r.tenant_id AND sb.warehouse_id = r.warehouse_id
                 AND sb.variant_id = r.variant_id
            ) s ON true
           WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY lower(p.name), v.id, r.warehouse_id
           LIMIT ${query.limit + 1}`),
      );
      const page = toPage(rows, query.limit, (last) => [
        last.sort_key,
        last.variant_id,
        last.warehouse_id,
      ]);
      return {
        items: page.items.map((row) => ({
          variantId: row.variant_id,
          productId: row.product_id,
          productCode: row.product_code,
          productName: row.product_name,
          optionValues: row.option_values,
          sku: row.sku,
          baseUnitId: row.base_unit_id,
          warehouseId: row.warehouse_id,
          onHand: row.on_hand,
          inTransit: row.in_transit,
          minQuantity: row.min_quantity,
          reorderQuantity: row.reorder_quantity,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  setReorderLevel(input: ReorderLevelInput) {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [variant] = await tx
        .select({ productId: products.id, type: products.type })
        .from(productVariants)
        .innerJoin(
          products,
          and(
            eq(products.tenantId, productVariants.tenantId),
            eq(products.id, productVariants.productId),
          ),
        )
        .where(
          and(eq(productVariants.tenantId, tenantId), eq(productVariants.id, input.variantId)),
        );
      if (variant?.type !== 'goods') {
        throw new AppError(409, 'stock_variant_invalid', 'Pick a stocked product.', {
          fieldErrors: { variantId: ['stock_variant_invalid'] },
        });
      }
      const [warehouse] = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.tenantId, tenantId),
            eq(warehouses.id, input.warehouseId),
            isNull(warehouses.archivedAt),
          ),
        );
      if (!warehouse) {
        throw new AppError(409, 'stock_warehouse_invalid', 'Pick an active warehouse.', {
          fieldErrors: { warehouseId: ['stock_warehouse_invalid'] },
        });
      }

      const key = and(
        eq(reorderLevels.tenantId, tenantId),
        eq(reorderLevels.warehouseId, input.warehouseId),
        eq(reorderLevels.variantId, input.variantId),
      );
      const [before] = await tx.select().from(reorderLevels).where(key).for('update');
      const result = {
        warehouseId: input.warehouseId,
        variantId: input.variantId,
        minQuantity: input.minQuantity,
        reorderQuantity: input.minQuantity === null ? null : input.reorderQuantity,
      };
      let id = before?.id;
      if (input.minQuantity === null) {
        if (before) await tx.delete(reorderLevels).where(key);
      } else {
        const [row] = await tx
          .insert(reorderLevels)
          .values({
            tenantId,
            warehouseId: input.warehouseId,
            productId: variant.productId,
            variantId: input.variantId,
            minQuantity: input.minQuantity,
            reorderQuantity: input.reorderQuantity,
            updatedBy: currentPrincipal().userId,
          })
          .onConflictDoUpdate({
            target: [reorderLevels.tenantId, reorderLevels.warehouseId, reorderLevels.variantId],
            set: {
              minQuantity: input.minQuantity,
              reorderQuantity: input.reorderQuantity,
              updatedAt: new Date(),
              updatedBy: currentPrincipal().userId,
            },
          })
          .returning({
            id: reorderLevels.id,
            minQuantity: reorderLevels.minQuantity,
            reorderQuantity: reorderLevels.reorderQuantity,
          });
        if (!row) throw new Error('Reorder level upsert returned no row');
        id = row.id;
        result.minQuantity = row.minQuantity;
        result.reorderQuantity = row.reorderQuantity;
      }
      // Clearing a level that was never set changes nothing, and logs nothing
      if (id !== undefined) {
        await audit(tx, {
          action: 'reorder_level.changed',
          entityType: 'reorder_level',
          entityId: id,
          changes: diff(
            { min: before?.minQuantity ?? null, reorder: before?.reorderQuantity ?? null },
            { min: result.minQuantity, reorder: result.reorderQuantity },
          ),
        });
      }
      return result;
    });
  }

  // One query for the list and the card: the variant, its product, its packs, and its stock in
  // the chosen warehouse (or all of them)
  private async items(
    tx: Transaction,
    conditions: readonly SQL[],
    warehouseId: string | undefined,
    limit: number,
  ) {
    const tenantId = getTenantId();
    const inWarehouse = (column: SQL) =>
      warehouseId === undefined ? sql`true` : sql`${column} = ${warehouseId}::uuid`;
    return z.array(itemRowSchema).parse(
      await tx.execute(sql`
        SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               p.tracking, p.has_expiry,
               coalesce((SELECT json_agg(json_build_object('unitId', pu.unit_id, 'factor', pu.factor::text)
                                         ORDER BY pu.position)
                           FROM product_units pu
                          WHERE pu.tenant_id = p.tenant_id AND pu.product_id = p.id), '[]'::json) AS units,
               (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived,
               ${quantityText(sql`s.on_hand`)} AS on_hand,
               ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                  JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                 WHERE l.tenant_id = v.tenant_id AND l.variant_id = v.id AND t.status = 'in_transit'
                   AND ${inWarehouse(sql`t.to_warehouse_id`)})`)} AS in_transit,
               ${lowCondition(warehouseId)} AS low,
               lower(p.name) AS sort_key, v.position::int AS position
          FROM product_variants v
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          LEFT JOIN LATERAL (
            SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
             WHERE sb.tenant_id = v.tenant_id AND sb.variant_id = v.id
               AND ${inWarehouse(sql`sb.warehouse_id`)}
          ) s ON true
         WHERE v.tenant_id = ${tenantId}::uuid AND p.type = 'goods'
           AND ${sql.join([...conditions], sql` AND `)}
         ORDER BY lower(p.name), p.id, v.position
         LIMIT ${limit}`),
    );
  }

  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }
}

// At or below the reorder level in the chosen warehouse, or in any active warehouse
function lowCondition(warehouseId: string | undefined): SQL {
  return sql`EXISTS (
    SELECT 1 FROM reorder_levels r
      JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id AND w.archived_at IS NULL
     WHERE r.tenant_id = v.tenant_id AND r.variant_id = v.id
       AND ${warehouseId === undefined ? sql`true` : sql`r.warehouse_id = ${warehouseId}::uuid`}
       AND coalesce((SELECT sum(sb.quantity) FROM stock_balances sb
                      WHERE sb.tenant_id = r.tenant_id AND sb.warehouse_id = r.warehouse_id
                        AND sb.variant_id = r.variant_id), 0) <= r.min_quantity)`;
}
```

- **One query for the list and the card** (`items()`): the same columns, the same "low" rule, the same packs.
- **Raw SQL with `z.array(…).parse()`**: like the product list, the result of `tx.execute()` is checked with a
  schema instead of trusted. Timestamps and dates are cast to text in SQL (`::text`), numbers rounded to 4 places.
- **`units` accepts parsed JSON or text**: `postgres.js` parses `json` columns itself, but the schema does not
  depend on that.
- **Archived products stay in the list while they hold stock** (`coalesce(s.on_hand, 0) <> 0`), then drop out.
- **A barcode or a serial number is matched whole**, on the variant: a scanned IMEI finds that phone's variant,
  not every phone of the product.
- **The card's batches are FEFO-ordered** (`expires_on ASC NULLS LAST`): the form's "Split by first expiry" takes
  them in that order.
- **`movements()`** is the ledger page of step 10 again: one pass of `FILTER` sums gives the balance before the
  page, the opening balance and the closing balance, so page 3's running balance continues exactly where page 2
  stopped.
- **`batches()`** counts "within 30 days" from today *in the company's time zone*, and puts batches without an
  expiry last (`9999-12-31`).
- **`setReorderLevel()`** audits only real changes: clearing a level that was never set writes nothing.

### Controllers, the low-stock handler and the module

`apps/api/src/inventory/stock.controller.ts`:

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { StockAdjustmentsService } from './stock-adjustments.service.js';
import { StockTransfersService } from './stock-transfers.service.js';
import { StockService } from './stock.service.js';

type Routes = typeof routes.stock;
type AdjustmentRoutes = typeof routes.stockAdjustments;
type TransferRoutes = typeof routes.stockTransfers;

@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Endpoint(routes.stock.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.stock.list(query);
  }

  @Endpoint(routes.stock.card)
  card({ params }: RouteInput<Routes['card']>): Promise<RouteResponse<Routes['card']>> {
    return this.stock.card(params.id);
  }

  @Endpoint(routes.stock.movements)
  movements({
    params,
    query,
  }: RouteInput<Routes['movements']>): Promise<RouteResponse<Routes['movements']>> {
    return this.stock.movements(params.id, query);
  }

  @Endpoint(routes.stock.batches)
  batches({ query }: RouteInput<Routes['batches']>): Promise<RouteResponse<Routes['batches']>> {
    return this.stock.batches(query);
  }

  @Endpoint(routes.stock.reorder)
  reorder({ query }: RouteInput<Routes['reorder']>): Promise<RouteResponse<Routes['reorder']>> {
    return this.stock.reorder(query);
  }

  @Endpoint(routes.stock.setReorderLevel)
  setReorderLevel({
    body,
  }: RouteInput<Routes['setReorderLevel']>): Promise<RouteResponse<Routes['setReorderLevel']>> {
    return this.stock.setReorderLevel(body);
  }
}

@Controller()
export class StockAdjustmentsController {
  constructor(private readonly adjustments: StockAdjustmentsService) {}

  @Endpoint(routes.stockAdjustments.list)
  list({
    query,
  }: RouteInput<AdjustmentRoutes['list']>): Promise<RouteResponse<AdjustmentRoutes['list']>> {
    return this.adjustments.list(query);
  }

  @Endpoint(routes.stockAdjustments.get)
  get({
    params,
  }: RouteInput<AdjustmentRoutes['get']>): Promise<RouteResponse<AdjustmentRoutes['get']>> {
    return this.adjustments.get(params.id);
  }

  @Endpoint(routes.stockAdjustments.create)
  create({
    body,
  }: RouteInput<AdjustmentRoutes['create']>): Promise<RouteResponse<AdjustmentRoutes['create']>> {
    return this.adjustments.create(body);
  }

  @Endpoint(routes.stockAdjustments.update)
  update({
    params,
    body,
  }: RouteInput<AdjustmentRoutes['update']>): Promise<RouteResponse<AdjustmentRoutes['update']>> {
    return this.adjustments.update(params.id, body);
  }

  @Endpoint(routes.stockAdjustments.remove)
  remove({ params, query }: RouteInput<AdjustmentRoutes['remove']>): Promise<void> {
    return this.adjustments.remove(params.id, query.version);
  }

  @Endpoint(routes.stockAdjustments.post)
  post({
    params,
    body,
  }: RouteInput<AdjustmentRoutes['post']>): Promise<RouteResponse<AdjustmentRoutes['post']>> {
    return this.adjustments.post(params.id, body.version);
  }
}

@Controller()
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) {}

  @Endpoint(routes.stockTransfers.list)
  list({
    query,
  }: RouteInput<TransferRoutes['list']>): Promise<RouteResponse<TransferRoutes['list']>> {
    return this.transfers.list(query);
  }

  @Endpoint(routes.stockTransfers.get)
  get({
    params,
  }: RouteInput<TransferRoutes['get']>): Promise<RouteResponse<TransferRoutes['get']>> {
    return this.transfers.get(params.id);
  }

  @Endpoint(routes.stockTransfers.create)
  create({
    body,
  }: RouteInput<TransferRoutes['create']>): Promise<RouteResponse<TransferRoutes['create']>> {
    return this.transfers.create(body);
  }

  @Endpoint(routes.stockTransfers.update)
  update({
    params,
    body,
  }: RouteInput<TransferRoutes['update']>): Promise<RouteResponse<TransferRoutes['update']>> {
    return this.transfers.update(params.id, body);
  }

  @Endpoint(routes.stockTransfers.remove)
  remove({ params, query }: RouteInput<TransferRoutes['remove']>): Promise<void> {
    return this.transfers.remove(params.id, query.version);
  }

  @Endpoint(routes.stockTransfers.send)
  send({
    params,
    body,
  }: RouteInput<TransferRoutes['send']>): Promise<RouteResponse<TransferRoutes['send']>> {
    return this.transfers.send(params.id, body.version);
  }

  @Endpoint(routes.stockTransfers.receive)
  receive({
    params,
    body,
  }: RouteInput<TransferRoutes['receive']>): Promise<RouteResponse<TransferRoutes['receive']>> {
    return this.transfers.receive(params.id, body);
  }
}
```

`apps/api/src/inventory/low-stock.handler.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { compareQuantity } from '@omnivo/contracts';
import {
  membershipRoles,
  memberships,
  permissions,
  reorderLevels,
  rolePermissions,
  roles,
  warehouses,
} from '@omnivo/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// "3 items at Main store fell to their reorder level" in the bell of everyone who manages
// products (they set the levels and order the stock) and of the owners. Runs after the posting
// committed; it counts again, so a variant refilled in between is not reported. Idempotent: the
// event id is each notification's key.
@Injectable()
export class LowStockHandler implements EventHandler<'stock.below_reorder'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'stock.below_reorder'>): Promise<void> {
    const tenantId = getTenantId();
    const { warehouseId, variantIds } = event.payload;
    await this.withTenant(async (tx) => {
      const [warehouse] = await tx
        .select({ name: warehouses.name })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, warehouseId)));
      if (!warehouse) return;

      const levels = await tx
        .select({
          minQuantity: reorderLevels.minQuantity,
          // The outer table by its name (see stock-adjustments.service.ts's lineCount)
          onHand: sql<string>`coalesce((SELECT sum(sb.quantity) FROM stock_balances sb
            WHERE sb.tenant_id = reorder_levels.tenant_id AND sb.warehouse_id = reorder_levels.warehouse_id
              AND sb.variant_id = reorder_levels.variant_id), 0)::text`,
        })
        .from(reorderLevels)
        .where(
          and(
            eq(reorderLevels.tenantId, tenantId),
            eq(reorderLevels.warehouseId, warehouseId),
            inArray(reorderLevels.variantId, variantIds),
          ),
        );
      const count = levels.filter(
        (level) => compareQuantity(level.onHand, level.minQuantity) <= 0,
      ).length;
      if (count === 0) return;

      // Owners, and members with a role that has inventory.product.manage
      const recipients = await tx
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(
          membershipRoles,
          and(
            eq(membershipRoles.tenantId, memberships.tenantId),
            eq(membershipRoles.membershipId, memberships.id),
            isNull(membershipRoles.deletedAt),
          ),
        )
        .innerJoin(
          roles,
          and(
            eq(roles.tenantId, membershipRoles.tenantId),
            eq(roles.id, membershipRoles.roleId),
            isNull(roles.deletedAt),
          ),
        )
        .leftJoin(
          rolePermissions,
          and(
            eq(rolePermissions.tenantId, roles.tenantId),
            eq(rolePermissions.roleId, roles.id),
            isNull(rolePermissions.deletedAt),
          ),
        )
        .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            isNull(memberships.deletedAt),
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'inventory.product.manage')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'stock.low',
          params: { warehouse: warehouse.name, count },
          eventId: event.id,
        });
      }
    });
  }
}
```

- **It counts again** before notifying: stock refilled between the posting and the job is not reported.
- **Recipients**: owners (their permissions live in code, not in `role_permissions`) and members whose roles have
  `inventory.product.manage` — the people who set the levels and order the stock. Deleted memberships, roles and
  grants are skipped, like `PermissionService` does.
- **`notify()`'s event id** makes a retried job harmless: the unique index turns the second insert into nothing.

`apps/api/src/inventory/inventory.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { NumberingModule } from '../numbering/numbering.module.js';
import { StockAdjustmentsService } from './stock-adjustments.service.js';
import {
  StockAdjustmentsController,
  StockController,
  StockTransfersController,
} from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';
import { StockTransfersService } from './stock-transfers.service.js';
import { StockService } from './stock.service.js';
import { WarehousesController } from './warehouses.controller.js';
import { WarehousesService } from './warehouses.service.js';

// Warehouses and the stock ledger (step 13). StockPostingService is exported: purchases, sales and
// POS (steps 15–20) import this module and call post() in their own transaction, the way every
// module that posts to the books uses the journal's PostingService. The low-stock alert's worker
// half (low-stock.handler.ts) is wired in worker/worker.module.ts, like every handler.
@Module({
  imports: [NumberingModule],
  controllers: [
    WarehousesController,
    StockController,
    StockAdjustmentsController,
    StockTransfersController,
  ],
  providers: [
    WarehousesService,
    StockService,
    StockPostingService,
    StockAdjustmentsService,
    StockTransfersService,
  ],
  exports: [StockPostingService],
})
export class InventoryModule {}
```

### Wiring

`apps/api/src/app.module.ts` (changed):

```diff
@@ -21,6 +21,7 @@ import type { Config } from './config.js';
 import { DocsController } from './docs/docs.controller.js';
 import { HealthController } from './health/health.controller.js';
 import { InfraModule } from './infra/infra.module.js';
+import { InventoryModule } from './inventory/inventory.module.js';
 import { InvitationsModule } from './invitations/invitations.module.js';
 import { JournalModule } from './journal/journal.module.js';
 import { MembersModule } from './members/members.module.js';
@@ -59,6 +60,7 @@ export class AppModule implements NestModule {
         ReportsModule,
         CustomFieldsModule,
         ProductsModule,
+        InventoryModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

`apps/api/src/common/outbox/outbox.ts` (changed):

```diff
@@ -24,6 +24,12 @@ export const outboxPayloadSchemas = {
   'workspace.catalog_requested': z.object({}),
   // The product_imports row says which file, and who uploaded it
   'product.import_requested': z.object({ importId: z.uuid() }),
+  // A posting took these variants down to their reorder level in this warehouse (step 13). The
+  // worker counts them again when it runs: one that was refilled meanwhile is not reported.
+  'stock.below_reorder': z.object({
+    warehouseId: z.uuid(),
+    variantIds: z.array(z.uuid()).min(1).max(500),
+  }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

`apps/api/src/worker/handlers.ts` (changed):

```diff
@@ -2,6 +2,7 @@ import { Injectable } from '@nestjs/common';
 import type { OutboxEventType } from '@omnivo/db';
 
 import type { EventHandler } from '../common/outbox/outbox.js';
+import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
@@ -30,6 +31,7 @@ export class EventHandlers {
     reportExport: ReportExportHandler,
     catalog: CatalogHandler,
     productImport: ProductImportHandler,
+    lowStock: LowStockHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -40,6 +42,7 @@ export class EventHandlers {
       'report.export_requested': reportExport,
       'workspace.catalog_requested': catalog,
       'product.import_requested': productImport,
+      'stock.below_reorder': lowStock,
     };
   }
```

`apps/api/src/worker/queues.ts` (changed):

```diff
@@ -21,6 +21,7 @@ const QUEUE_OF = {
   'report.export_requested': 'jobs',
   'workspace.catalog_requested': 'jobs',
   'product.import_requested': 'jobs',
+  'stock.below_reorder': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

`apps/api/src/worker/worker.module.ts` (changed):

```diff
@@ -4,6 +4,7 @@ import { createDb, type Db } from '@omnivo/db';
 import { createWithTenant } from '../common/tenant/with-tenant.js';
 import type { WorkerConfig } from '../config.js';
 import { CONFIG, DB, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
+import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
@@ -58,6 +59,7 @@ export class WorkerModule implements OnApplicationShutdown {
         // The import gives new products their codes, like the API does
         NumberingService,
         ProductImportHandler,
+        LowStockHandler,
       ],
     };
   }
```

---

## 13.4 — The API: changes to existing code

### `common/db/pg-errors.ts`: check violations

`apps/api/src/common/db/pg-errors.ts` (changed):

```diff
@@ -18,6 +18,12 @@ export function isUniqueViolation(error: unknown, constraint: string): boolean {
   return hasPgError(error, '23505', constraint);
 }
 
+// 23514 = check_violation: a CHECK constraint, or a trigger that raises with ERRCODE
+// 'check_violation' and a CONSTRAINT name (the stock ledger's triggers, migration 0022)
+export function isCheckViolation(error: unknown, constraint: string): boolean {
+  return hasPgError(error, '23514', constraint);
+}
+
 // 23503 = foreign_key_violation: যে রো-কে আরেকটা রো এখনো রেফার করছে সেটা মোছার চেষ্টা (বা উল্টোটা)
 export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
   return hasPgError(error, '23503', constraint);
```

### Sign-up: a Main store

`apps/api/src/auth/auth.service.ts` (changed):

```diff
@@ -25,6 +25,7 @@ import {
   tenantSettings,
   tenants,
   users,
+  warehouses,
 } from '@omnivo/db';
 
 import { audit, created } from '../common/audit/audit.js';
@@ -423,9 +424,20 @@ export class AuthService {
       // settings রো (বাকি সব DB-র ডিফল্ট: BDT, জুলাই, Asia/Dhaka) আর একটা ব্রাঞ্চ — প্রতিটা
       // workspace-এ অন্তত একটা চালু ব্রাঞ্চ থাকে, archive-এর নিয়ম সেটা ধরে রাখে (branches.service.ts)
       await tx.insert(tenantSettings).values({ tenantId: tenant.id, updatedBy: userId });
-      await tx
+      const [branch] = await tx
         .insert(branches)
-        .values({ tenantId: tenant.id, code: 'HO', name: 'Head office', createdBy: userId });
+        .values({ tenantId: tenant.id, code: 'HO', name: 'Head office', createdBy: userId })
+        .returning({ id: branches.id });
+      if (!branch) throw new Error('Branch insert returned no row');
+      // And a first warehouse in it (step 13): stock always lives in a warehouse, and a new
+      // company's opening stock needs somewhere to go. Migration 0022 gave older workspaces theirs.
+      await tx.insert(warehouses).values({
+        tenantId: tenant.id,
+        branchId: branch.id,
+        code: 'MAIN',
+        name: 'Main store',
+        createdBy: userId,
+      });
 
       await audit(tx, {
         action: 'workspace.created',
```

### Branches: not archived while they hold warehouses

`apps/api/src/branches/branches.service.ts` (changed):

```diff
@@ -1,6 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import type { Branch, BranchInput, BranchStatus } from '@omnivo/contracts';
-import { branches } from '@omnivo/db';
+import { branches, warehouses } from '@omnivo/db';
 import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -131,6 +131,27 @@ export class BranchesService {
           'A workspace needs at least one active branch.',
         );
       }
+      // Step 13: a warehouse lives in a branch. Archive (or move) its warehouses first, so no
+      // stock is left in a branch nobody can pick any more. FOR UPDATE: a warehouse being created in
+      // this branch right now holds the branch FOR SHARE, so one of the two waits for the other.
+      const [warehouse] = await tx
+        .select({ id: warehouses.id })
+        .from(warehouses)
+        .where(
+          and(
+            eq(warehouses.tenantId, tenantId),
+            eq(warehouses.branchId, id),
+            isNull(warehouses.archivedAt),
+          ),
+        )
+        .limit(1);
+      if (warehouse) {
+        throw new AppError(
+          409,
+          'branch_has_warehouses',
+          'Archive or move the warehouses of this branch first.',
+        );
+      }
 
       const after = await this.write(tx, id, { archivedAt: new Date() });
       await audit(tx, { action: 'branch.archived', entityType: 'branch', entityId: id });
```

The check runs after the step 6 lock on the tenant's active branches, inside the same transaction.

### Products: the meaning of stock is kept

`apps/api/src/products/products.service.ts` (changed):

```diff
@@ -1,5 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  type ErrorCode,
   type Product,
   type ProductInput,
   type ProductPage,
@@ -13,6 +14,7 @@ import {
   products,
   productUnits,
   productVariants,
+  stockMovements,
   tenantSettings,
   units,
 } from '@omnivo/db';
@@ -43,6 +45,18 @@ import {
 
 type ProductRow = typeof products.$inferSelect;
 
+// Rows that hold on to a variant (and so to its product). Deleting either is refused while one of
+// them exists; the API turns the foreign key's error into product_in_use / product_variant_in_use.
+// reorder_levels is not here: a variant's levels go with it (ON DELETE CASCADE).
+const VARIANT_IN_USE = [
+  'batches_variant_fk',
+  'serials_variant_fk',
+  'stock_movements_variant_fk',
+  'stock_balances_variant_fk',
+  'stock_adjustment_lines_variant_fk',
+  'stock_transfer_lines_variant_fk',
+] as const;
+
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
 // (the last row's key and id) says exactly where the next page starts — never OFFSET.
 const ORDERS = {
@@ -253,6 +267,7 @@ export class ProductsService {
         });
         const issues = [...checked.issues, ...unknown];
         if (issues.length > 0) throw issuesError(issues);
+        await this.assertMeaningKept(tx, before, input);
 
         // An empty code on an existing product keeps the one it has
         const code = input.code ?? before.code;
@@ -296,10 +311,7 @@ export class ProductsService {
         return product;
       });
     } catch (error) {
-      if (
-        isForeignKeyViolation(error, 'batches_variant_fk') ||
-        isForeignKeyViolation(error, 'serials_variant_fk')
-      ) {
+      if (VARIANT_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
         throw new AppError(409, 'product_variant_in_use', 'Archive the variant instead.');
       }
       throw racedError(error);
@@ -348,18 +360,51 @@ export class ProductsService {
         });
       });
     } catch (error) {
-      // A batch or a serial number (and from step 13 a stock line) points at a variant: the
-      // product has a history and stays
-      if (
-        isForeignKeyViolation(error, 'batches_variant_fk') ||
-        isForeignKeyViolation(error, 'serials_variant_fk')
-      ) {
+      // A batch, a serial number, a stock movement or a stock document line points at a variant:
+      // the product has a history and stays
+      if (VARIANT_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
         throw new AppError(409, 'product_in_use', 'Archive this product instead.');
       }
       throw error;
     }
   }
 
+  // Once a product has stock, its base unit, tracking and type say what that stock means: 120 is
+  // 120 pieces, in these batches. Changing them would silently turn it into 120 kg, or stock
+  // without batches. FOR UPDATE on the product (lock() above) against StockPostingService's
+  // FOR SHARE: no document is posting for it while we look.
+  private async assertMeaningKept(
+    tx: Transaction,
+    before: ProductRow,
+    input: UpdateProductInput,
+  ): Promise<void> {
+    const changed = {
+      baseUnitId: input.baseUnitId !== before.baseUnitId,
+      tracking: input.tracking !== before.tracking,
+      type: input.type !== before.type,
+    };
+    if (!changed.baseUnitId && !changed.tracking && !changed.type) return;
+    const [moved] = await tx
+      .select({ id: stockMovements.id })
+      .from(stockMovements)
+      .where(
+        and(eq(stockMovements.tenantId, getTenantId()), eq(stockMovements.productId, before.id)),
+      )
+      .limit(1);
+    if (!moved) return;
+    const fieldErrors: Record<string, ErrorCode[]> = {};
+    if (changed.baseUnitId) fieldErrors.baseUnitId = ['product_base_unit_locked'];
+    if (changed.tracking) fieldErrors.tracking = ['product_tracking_locked'];
+    if (changed.type) fieldErrors.type = ['product_type_locked'];
+    const [code] = Object.values(fieldErrors).flat();
+    throw new AppError(
+      409,
+      code ?? 'product_base_unit_locked',
+      'This product has stock: its base unit, tracking and type stay as they are.',
+      { fieldErrors },
+    );
+  }
+
   // The next free code: the series may hand out a code someone typed by hand before (P-00007
   // typed on a product, then the series reaches 7). Such numbers are skipped, not refused.
   private async newCode(tx: Transaction): Promise<string> {
```

- **`VARIANT_IN_USE`** — one list for both places (`update()` deletes variants, `remove()` deletes the product). A
  new table that points at variants is one line here.
- **`assertMeaningKept()`** runs only when the base unit, tracking or type actually change, and then looks for one
  movement (`LIMIT 1` on the `(tenant_id, product_id, variant_id)` index). Each changed field gets its own error.

### Settings: `allowNegativeStock`

`apps/api/src/settings/settings.service.ts` (changed):

```diff
@@ -185,5 +185,6 @@ function pickEditable(settings: typeof tenantSettings.$inferSelect) {
     baseCurrency: settings.baseCurrency,
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
+    allowNegativeStock: settings.allowNegativeStock,
   };
 }
```

`pickEditable()` is used for the answer *and* for the audit's "before": the new field is audited like every other.

### Role templates

`apps/api/src/setup/templates.ts` (changed):

```diff
@@ -85,10 +85,13 @@ const ACCOUNTANT: RoleTemplate = {
   ],
 };
 
+// Step 13: the people who keep the stock adjust it and move it between warehouses
+const STOCK_WORK = ['inventory.stock.adjust', 'inventory.stock.transfer'] as const;
+
 const STORE_KEEPER: RoleTemplate = {
   name: 'Store keeper',
   description: 'Receives goods and writes GRNs',
-  permissions: ['inventory.product.manage'],
+  permissions: ['inventory.product.manage', ...STOCK_WORK],
 };
 
 function group(
@@ -313,7 +316,12 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Depot manager',
         description: 'Stock by batch and expiry at a depot',
-        permissions: ['core.branch.manage', 'inventory.product.manage'],
+        permissions: [
+          'core.branch.manage',
+          'inventory.product.manage',
+          'inventory.warehouse.manage',
+          ...STOCK_WORK,
+        ],
       },
       { name: 'Sales representative', description: 'Orders from pharmacies', permissions: [] },
     ],
@@ -372,7 +380,12 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Depot manager',
         description: 'Stock and deliveries at a depot',
-        permissions: ['core.branch.manage', 'inventory.product.manage'],
+        permissions: [
+          'core.branch.manage',
+          'inventory.product.manage',
+          'inventory.warehouse.manage',
+          ...STOCK_WORK,
+        ],
       },
       {
         name: 'Sales officer',
@@ -418,7 +431,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Production manager',
         description: 'Production orders and material use',
-        permissions: ['core.user.read', 'inventory.product.manage'],
+        permissions: ['core.user.read', 'inventory.product.manage', ...STOCK_WORK],
       },
       STORE_KEEPER,
     ],
@@ -461,7 +474,13 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Shop manager',
         description: 'Runs a shop and its staff',
-        permissions: ['core.user.read', 'core.branch.manage', 'inventory.product.manage'],
+        permissions: [
+          'core.user.read',
+          'core.branch.manage',
+          'inventory.product.manage',
+          'inventory.warehouse.manage',
+          ...STOCK_WORK,
+        ],
       },
       { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
     ],
@@ -500,7 +519,12 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Manager',
         description: 'Runs day-to-day work',
-        permissions: ['core.user.read', 'inventory.product.manage'],
+        permissions: [
+          'core.user.read',
+          'inventory.product.manage',
+          'inventory.warehouse.manage',
+          ...STOCK_WORK,
+        ],
       },
     ],
     chart: standardChart({
```

---

## 13.5 — The API's tests

### `inventory/stock.int.spec.ts` (new)

One distributor, from the opening count to a truck that arrives short: juice in cases of 24, Napa in batches,
phones by IMEI. The tests run in order and build on each other (like the journal's), so the numbers in each one
follow from the ones before it.

`apps/api/src/inventory/stock.int.spec.ts`:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  batchStockPageSchema,
  notificationPageSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  reorderPageSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockAdjustmentPageSchema,
  stockAdjustmentSchema,
  type StockAdjustmentFormValues,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  stockTransferSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// One distributor's stock, from the first opening count to a truck that arrived short: juice in
// cartons of 24 (untracked), Napa in batches with expiry dates, and phones by IMEI.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role at all: reads stock, changes nothing
let viewer: SignedIn;
let units: Unit[];
let main: Warehouse;
let depot: Warehouse;
let juice: Product;
let napa: Product;
let phone: Product;

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

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function product(name: string, extra: Partial<ProductFormValues>): Promise<Product> {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

// What the adjustment form sends for one line; each test changes a few fields
function line(variantId: string, quantity: string, extra: object = {}) {
  return {
    variantId,
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function adjustment(
  direction: 'in' | 'out',
  lines: object[],
  extra: Partial<StockAdjustmentFormValues> = {},
) {
  return {
    date: '2026-10-01',
    warehouseId: main.id,
    direction,
    reason: direction === 'in' ? 'opening' : 'damaged',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

// What the settings page sends: every field of the form, the version it was opened with
function settingsForm(settings: Settings) {
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
    allowNegativeStock: settings.allowNegativeStock,
  };
}

async function posted(body: object) {
  const res = await send('POST', '/stock-adjustments', body);
  expect(res.statusCode, res.body).toBe(201);
  return stockAdjustmentSchema.parse(res.json());
}

async function cardOf(variantId: string) {
  const res = await send('GET', `/stock/variants/${variantId}`);
  expect(res.statusCode, res.body).toBe(200);
  return stockCardSchema.parse(res.json());
}

function onHandIn(card: Awaited<ReturnType<typeof cardOf>>, warehouseId: string): string {
  return card.warehouses.find((place) => place.warehouseId === warehouseId)?.onHand ?? 'missing';
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Meghna Distribution',
    workspaceSlug: 'meghna-distribution',
    fullName: 'Tanvir Hasan',
    email: 'tanvir@meghnadist.com',
    password: 'Depot-truck-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;

  const { items } = warehouseListSchema.parse((await send('GET', '/warehouses')).json());
  const first = items[0];
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  juice = await product('Pran Mango Juice 250 ml', {
    units: [{ unitId: unitId('case'), factor: '24', barcode: '' }],
  });
  napa = await product('Napa 500 mg', { tracking: 'batch', hasExpiry: true });
  phone = await product('Walton Primo H10', { tracking: 'serial' });

  await signUp(app, {
    companyName: 'Rina Store',
    workspaceSlug: 'rina-store',
    fullName: 'Rina Akter',
    email: 'rina@meghnadist.com',
    password: 'Counter-cash-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rina@meghnadist.com',
    workspace: 'meghna-distribution',
  });
  viewer = await logIn(app, {
    workspace: 'meghna-distribution',
    email: 'rina@meghnadist.com',
    password: 'Counter-cash-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('warehouses', () => {
  it('starts every workspace with a Main store in its head office', () => {
    expect(main).toMatchObject({ code: 'MAIN', name: 'Main store', archivedAt: null });
  });

  it('adds a depot, and refuses a code that is taken', async () => {
    const res = await send('POST', '/warehouses', {
      branchId: main.branchId,
      code: 'depot',
      name: 'Chattogram depot',
      address: 'Sagorika Road, Pahartali',
    });
    expect(res.statusCode, res.body).toBe(201);
    depot = warehouseSchema.parse(res.json());
    // Upper-cased by the contract, like a branch code
    expect(depot.code).toBe('DEPOT');

    const twice = await send('POST', '/warehouses', {
      branchId: main.branchId,
      code: 'DEPOT',
      name: 'Another depot',
      address: '',
    });
    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).fieldErrors).toEqual({ code: ['warehouse_code_taken'] });
  });

  it('keeps a branch with active warehouses from being archived', async () => {
    const res = await send('POST', '/branches', {
      code: 'CTG',
      name: 'Chattogram',
      phone: '',
      address: '',
    });
    expect(res.statusCode, res.body).toBe(201);
    const branch = warehouseSchema.pick({ id: true, version: true }).parse(res.json());
    const store = await send('POST', '/warehouses', {
      branchId: branch.id,
      code: 'CTG',
      name: 'Chattogram store',
      address: '',
    });
    expect(store.statusCode).toBe(201);
    const archive = await send('POST', `/branches/${branch.id}/archive`, {
      version: branch.version,
    });
    expect(archive.statusCode).toBe(409);
    expect(problemOf(archive).code).toBe('branch_has_warehouses');
  });

  it('needs inventory.warehouse.manage to add one', async () => {
    const res = await send(
      'POST',
      '/warehouses',
      { branchId: main.branchId, code: 'BACK', name: 'Back room', address: '' },
      viewer,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('stock adjustments', () => {
  it('posts the opening stock: 3 cases of juice are 72 pieces', async () => {
    const adjustment1 = await posted(
      adjustment('in', [line(variantOf(juice), '3', { unitId: unitId('case') })]),
    );
    expect(adjustment1).toMatchObject({ status: 'posted', direction: 'in', reason: 'opening' });
    expect(adjustment1.number).toMatch(/^ADJ-2026-27-0001$/);
    expect(adjustment1.lines[0]).toMatchObject({ quantity: '3.0000', baseQuantity: '72.0000' });

    const card = await cardOf(variantOf(juice));
    expect(card.item.onHand).toBe('72.0000');
    expect(onHandIn(card, main.id)).toBe('72.0000');
  });

  it('lets anyone read the stock list, and searches it', async () => {
    const res = await send('GET', '/stock?search=mango', undefined, viewer);
    expect(res.statusCode, res.body).toBe(200);
    const page = stockPageSchema.parse(res.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      productName: 'Pran Mango Juice 250 ml',
      onHand: '72.0000',
      units: [{ unitId: unitId('case'), factor: '24.000000' }],
    });
    // In stock only: the phone and Napa have none yet
    const inStock = stockPageSchema.parse((await send('GET', '/stock?filter=in_stock')).json());
    expect(inStock.items.map((item) => item.productName)).toEqual(['Pran Mango Juice 250 ml']);
  });

  it('needs inventory.stock.adjust to write one', async () => {
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1')]),
      viewer,
    );
    expect(res.statusCode).toBe(403);
  });

  it('refuses a reason that goes the other way, and half a case', async () => {
    const wrongWay = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '1')], { reason: 'found' }),
    );
    expect(wrongWay.statusCode).toBe(400);
    expect(problemOf(wrongWay).fieldErrors).toEqual({ reason: ['adjustment_reason_direction'] });

    const half = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1.5', { unitId: unitId('case') })]),
    );
    expect(half.statusCode).toBe(409);
    expect(problemOf(half).fieldErrors).toEqual({
      'lines.0.quantity': ['stock_quantity_decimals'],
    });
  });

  it('refuses to take more than is there, and uses no number for it', async () => {
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '80')]),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.0.quantity': ['stock_insufficient'] });
    // Two lines of the same stock count together: 50 + 30 > 72
    const together = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '50'), line(variantOf(juice), '30')]),
    );
    expect(together.statusCode).toBe(409);
    expect(Object.keys(problemOf(together).fieldErrors ?? {})).toEqual([
      'lines.0.quantity',
      'lines.1.quantity',
    ]);

    const ok = await posted(adjustment('out', [line(variantOf(juice), '2')]));
    // The refused ones took no number: this is the second adjustment posted
    expect(ok.number).toBe('ADJ-2026-27-0002');
    expect((await cardOf(variantOf(juice))).item.onHand).toBe('70.0000');
  });

  it('keeps a draft until it is posted, and moves nothing before', async () => {
    const draft = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '5')], { post: false, reason: 'sample' }),
    );
    expect(draft.statusCode, draft.body).toBe(201);
    const saved = stockAdjustmentSchema.parse(draft.json());
    expect(saved).toMatchObject({ status: 'draft', number: null });
    expect((await cardOf(variantOf(juice))).item.onHand).toBe('70.0000');

    const edited = await send('PUT', `/stock-adjustments/${saved.id}`, {
      ...adjustment('out', [line(variantOf(juice), '4')], { post: false, reason: 'sample' }),
      version: saved.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const again = stockAdjustmentSchema.parse(edited.json());
    const post = await send('POST', `/stock-adjustments/${saved.id}/post`, {
      version: again.version,
    });
    expect(post.statusCode, post.body).toBe(200);
    expect(stockAdjustmentSchema.parse(post.json())).toMatchObject({
      status: 'posted',
      lineCount: 1,
    });
    expect((await cardOf(variantOf(juice))).item.onHand).toBe('66.0000');

    // Posted: no edit, no delete
    const remove = await send(
      'DELETE',
      `/stock-adjustments/${saved.id}?version=${String(again.version + 1)}`,
    );
    expect(remove.statusCode).toBe(409);
    expect(problemOf(remove).code).toBe('stock_not_draft');

    const list = stockAdjustmentPageSchema.parse((await send('GET', '/stock-adjustments')).json());
    expect(list.items.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a date in the future and a date in closed books', async () => {
    const future = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1')], { date: '2099-01-01' }),
    );
    expect(future.statusCode).toBe(409);
    expect(problemOf(future).fieldErrors).toEqual({ date: ['stock_date_future'] });

    expect(
      (await send('PUT', '/period-lock', { lockDate: '2026-09-30', version: 0 })).statusCode,
    ).toBe(200);
    const locked = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(juice), '1')], { date: '2026-09-15' }),
    );
    expect(locked.statusCode).toBe(409);
    expect(problemOf(locked).code).toBe('journal_period_locked');
  });

  it('shows the history with a running balance', async () => {
    const res = await send('GET', `/stock/variants/${variantOf(juice)}/movements?limit=2`);
    expect(res.statusCode, res.body).toBe(200);
    const first = stockMovementPageSchema.parse(res.json());
    expect(first.items.map((row) => [row.quantity, row.balance])).toEqual([
      ['72.0000', '72.0000'],
      ['-2.0000', '70.0000'],
    ]);
    expect(first.items[0]?.documentNumber).toBe('ADJ-2026-27-0001');
    const next = stockMovementPageSchema.parse(
      (
        await send(
          'GET',
          `/stock/variants/${variantOf(juice)}/movements?limit=2&cursor=${first.nextCursor ?? ''}`,
        )
      ).json(),
    );
    // Page two goes on from where page one stopped
    expect(next.items[0]?.balance).toBe('66.0000');
    expect(next.closingBalance).toBe('66.0000');
  });
});

describe('batches and expiry', () => {
  it('brings Napa in by lot, and adds a later carton of the same lot to the same batch', async () => {
    await posted(
      adjustment('in', [
        line(variantOf(napa), '100', { lotNumber: 'NP24117', expiresOn: '2027-06-30' }),
        line(variantOf(napa), '50', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
      ]),
    );
    await posted(
      adjustment('in', [line(variantOf(napa), '20', { lotNumber: 'np24117', expiresOn: '' })], {
        reason: 'found',
      }),
    );
    const card = await cardOf(variantOf(napa));
    // FEFO: the batch that expires first is on top
    expect(card.batches.map((batch) => [batch.lotNumber, batch.quantity])).toEqual([
      ['NP24090', '50.0000'],
      ['NP24117', '120.0000'],
    ]);
  });

  it('refuses a lot without its expiry, a second expiry for one lot, and an out line without a batch', async () => {
    const noExpiry = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(napa), '10', { lotNumber: 'NP25001' })]),
    );
    expect(problemOf(noExpiry).fieldErrors).toEqual({
      'lines.0.expiresOn': ['stock_expiry_required'],
    });

    const otherExpiry = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [
        line(variantOf(napa), '10', { lotNumber: 'NP24117', expiresOn: '2028-01-31' }),
      ]),
    );
    expect(problemOf(otherExpiry).fieldErrors).toEqual({
      'lines.0.expiresOn': ['stock_batch_expiry_mismatch'],
    });

    const noBatch = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(napa), '10')], { reason: 'expired' }),
    );
    expect(problemOf(noBatch).fieldErrors).toEqual({ 'lines.0.batchId': ['stock_batch_required'] });
  });

  it('takes from the batch named, never more than it holds', async () => {
    const card = await cardOf(variantOf(napa));
    const first = card.batches[0];
    if (!first) throw new Error('no batch');
    const tooMuch = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(napa), '60', { batchId: first.batchId })], {
        reason: 'expired',
      }),
    );
    expect(problemOf(tooMuch).fieldErrors).toEqual({ 'lines.0.quantity': ['stock_insufficient'] });
    await posted(
      adjustment('out', [line(variantOf(napa), '10', { batchId: first.batchId })], {
        reason: 'expired',
      }),
    );
    const report = batchStockPageSchema.parse((await send('GET', '/stock/batches')).json());
    expect(report.items.map((batch) => [batch.lotNumber, batch.quantity])).toEqual([
      ['NP24090', '40.0000'],
      ['NP24117', '120.0000'],
    ]);
  });
});

describe('serial numbers', () => {
  it('brings phones in by IMEI and keeps each one in one place', async () => {
    const count = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(phone), '2', { serialNumbers: ['356938035643809'] })]),
    );
    expect(problemOf(count).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['stock_serial_count'],
    });

    await posted(
      adjustment('in', [
        line(variantOf(phone), '2', { serialNumbers: ['356938035643809', '356938035643817'] }),
      ]),
    );
    const again = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(phone), '1', { serialNumbers: ['356938035643809'] })]),
    );
    expect(problemOf(again).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['stock_serial_in_stock'],
    });

    const elsewhere = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(phone), '1', { serialNumbers: ['356938035643809'] })], {
        warehouseId: depot.id,
        reason: 'lost',
      }),
    );
    expect(problemOf(elsewhere).fieldErrors).toEqual({
      'lines.0.serialNumbers': ['stock_serial_not_here'],
    });

    const card = await cardOf(variantOf(phone));
    expect(card.serials).toEqual([
      { serialNumber: '356938035643809', warehouseId: main.id },
      { serialNumber: '356938035643817', warehouseId: main.id },
    ]);
    // A scan of the IMEI finds the phone
    const found = stockPageSchema.parse(
      (await send('GET', '/stock?search=356938035643817')).json(),
    );
    expect(found.items.map((item) => item.productName)).toEqual(['Walton Primo H10']);
  });
});

describe('transfers', () => {
  it('sends juice to the depot, which receives it short', async () => {
    const create = await send('POST', '/stock-transfers', {
      fromWarehouseId: main.id,
      toWarehouseId: depot.id,
      date: '2026-10-02',
      note: 'Truck DM-TA 11-2233',
      lines: [
        {
          variantId: variantOf(juice),
          unitId: unitId('case'),
          quantity: '2',
          batchId: '',
          serialNumbers: [],
        },
        {
          variantId: variantOf(phone),
          unitId: unitId('pcs'),
          quantity: '1',
          batchId: '',
          serialNumbers: ['356938035643817'],
        },
      ],
      send: true,
    });
    expect(create.statusCode, create.body).toBe(201);
    const sent = stockTransferSchema.parse(create.json());
    expect(sent).toMatchObject({ status: 'in_transit', number: 'TRF-2026-27-0001' });

    // On the road: out of Main store, not yet in the depot
    const card = await cardOf(variantOf(juice));
    expect(onHandIn(card, main.id)).toBe('18.0000');
    expect(card.warehouses.find((place) => place.warehouseId === depot.id)).toMatchObject({
      onHand: '0.0000',
      inTransit: '48.0000',
    });
    expect((await cardOf(variantOf(phone))).serials).toContainEqual({
      serialNumber: '356938035643817',
      warehouseId: null,
    });

    const [juiceLine, phoneLine] = sent.lines;
    if (!juiceLine || !phoneLine) throw new Error('lines missing');
    const tooMany = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: sent.version,
      date: '2026-10-03',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '50', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '1', serialNumbers: ['356938035643817'] },
      ],
    });
    expect(problemOf(tooMany).fieldErrors).toEqual({
      'lines.0.receivedQuantity': ['transfer_receive_too_many'],
    });
    const early = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: sent.version,
      date: '2026-10-01',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '48', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '1', serialNumbers: ['356938035643817'] },
      ],
    });
    expect(problemOf(early).fieldErrors).toEqual({ date: ['transfer_receive_date'] });

    const receive = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: sent.version,
      date: '2026-10-03',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '40', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '1', serialNumbers: ['356938035643817'] },
      ],
    });
    expect(receive.statusCode, receive.body).toBe(200);
    const received = stockTransferSchema.parse(receive.json());
    expect(received).toMatchObject({ status: 'received', short: true, receivedOn: '2026-10-03' });

    const after = await cardOf(variantOf(juice));
    expect(onHandIn(after, depot.id)).toBe('40.0000');
    expect(after.item.inTransit).toBe('0.0000');
    expect((await cardOf(variantOf(phone))).serials).toContainEqual({
      serialNumber: '356938035643817',
      warehouseId: depot.id,
    });

    const twice = await send('POST', `/stock-transfers/${sent.id}/receive`, {
      version: received.version,
      date: '2026-10-03',
      lines: [
        { lineId: juiceLine.id, receivedQuantity: '8', serialNumbers: [] },
        { lineId: phoneLine.id, receivedQuantity: '0', serialNumbers: [] },
      ],
    });
    expect(problemOf(twice).code).toBe('transfer_not_in_transit');
  });

  it('refuses a transfer to the same warehouse', async () => {
    const res = await send('POST', '/stock-transfers', {
      fromWarehouseId: main.id,
      toWarehouseId: main.id,
      date: '2026-10-02',
      note: '',
      lines: [
        {
          variantId: variantOf(juice),
          unitId: unitId('pcs'),
          quantity: '1',
          batchId: '',
          serialNumbers: [],
        },
      ],
      send: false,
    });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({ toWarehouseId: ['transfer_same_warehouse'] });
  });

  it('lets only one of two people take the same last 30 pieces', async () => {
    // The depot has 40. One person writes 30 off, another sends 30 to Main store, at the same
    // moment. Two kinds of document on purpose: two adjustments would already queue on their
    // shared number series' counter, and never meet at the stock. To make "the same moment"
    // certain, a third connection holds the balance row until both requests wait for it; then
    // one takes the row, the other waits, sees 10 left and is refused under its line.
    const writeOff = () =>
      send(
        'POST',
        '/stock-adjustments',
        adjustment('out', [line(variantOf(juice), '30')], {
          warehouseId: depot.id,
          reason: 'lost',
        }),
      );
    const sendBack = () =>
      send('POST', '/stock-transfers', {
        fromWarehouseId: depot.id,
        toWarehouseId: main.id,
        date: '2026-10-04',
        note: '',
        lines: [
          {
            variantId: variantOf(juice),
            unitId: unitId('pcs'),
            quantity: '30',
            batchId: '',
            serialNumbers: [],
          },
        ],
        send: true,
      });
    const blocker = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    const probe = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    let answers: Awaited<ReturnType<typeof writeOff>>[] = [];
    try {
      let both: Promise<typeof answers> | undefined;
      await blocker.begin(async (sql) => {
        await sql`SELECT 1 FROM stock_balances
                   WHERE warehouse_id = ${depot.id} AND variant_id = ${variantOf(juice)} FOR UPDATE`;
        both = Promise.all([writeOff(), sendBack()]);
        await eventually(async () => {
          const [waiting] = await probe<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = 'omnivo'`;
          expect(waiting?.n).toBe(2);
        });
      });
      answers = await (both ?? Promise.resolve([]));
    } finally {
      await Promise.all([blocker.end(), probe.end()]);
    }
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const refused = answers.find((res) => res.statusCode === 409);
    // Refused by the API's own check, under the line: not by the database's trigger, which
    // cannot say which line it was
    expect(refused && problemOf(refused).fieldErrors).toEqual({
      'lines.0.quantity': ['stock_insufficient'],
    });
    expect(onHandIn(await cardOf(variantOf(juice)), depot.id)).toBe('10.0000');
  });

  it('keeps a warehouse with stock from being archived', async () => {
    const res = await send('POST', `/warehouses/${depot.id}/archive`, { version: depot.version });
    expect(problemOf(res).code).toBe('warehouse_has_stock');
  });
});

describe('reorder levels', () => {
  it('rings the bell when a posting takes juice down to its level', async () => {
    const level = await send('PUT', '/stock/reorder-levels', {
      warehouseId: main.id,
      variantId: variantOf(juice),
      minQuantity: '12',
      reorderQuantity: '48',
    });
    expect(level.statusCode, level.body).toBe(200);

    // 18 → 10: below 12
    await posted(adjustment('out', [line(variantOf(juice), '8')]));
    const report = reorderPageSchema.parse((await send('GET', '/stock/reorder')).json());
    expect(report.items).toEqual([
      expect.objectContaining({
        productName: 'Pran Mango Juice 250 ml',
        warehouseId: main.id,
        onHand: '10.0000',
        minQuantity: '12.0000',
        reorderQuantity: '48.0000',
      }),
    ]);
    const low = stockPageSchema.parse(
      (await send('GET', `/stock?filter=low&warehouseId=${main.id}`)).json(),
    );
    expect(low.items.map((item) => item.productName)).toEqual(['Pran Mango Juice 250 ml']);

    await eventually(async () => {
      const page = notificationPageSchema.parse((await send('GET', '/notifications')).json());
      expect(page.items[0]).toMatchObject({
        type: 'stock.low',
        params: { warehouse: 'Main store', count: 1 },
      });
    });
  });
});

describe('negative stock', () => {
  it('is refused until the workspace allows it, and never for a batch', async () => {
    const on = await send('PUT', '/settings', {
      ...settingsForm(settingsSchema.parse((await send('GET', '/settings')).json())),
      allowNegativeStock: true,
    });
    expect(on.statusCode, on.body).toBe(200);

    // 10 left, 15 taken: −5 is allowed now for juice (untracked)
    await posted(adjustment('out', [line(variantOf(juice), '15')], { reason: 'lost' }));
    expect(onHandIn(await cardOf(variantOf(juice)), main.id)).toBe('-5.0000');

    const batch = (await cardOf(variantOf(napa))).batches[0];
    if (!batch) throw new Error('no batch');
    const napaOut = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(napa), '500', { batchId: batch.batchId })], {
        reason: 'lost',
      }),
    );
    expect(problemOf(napaOut).fieldErrors).toEqual({ 'lines.0.quantity': ['stock_insufficient'] });

    // Turned off again: stock still comes in to a warehouse below zero
    const off = await send('PUT', '/settings', {
      ...settingsForm(settingsSchema.parse((await send('GET', '/settings')).json())),
      allowNegativeStock: false,
    });
    expect(off.statusCode).toBe(200);
    await posted(adjustment('in', [line(variantOf(juice), '2')], { reason: 'found' }));
    expect(onHandIn(await cardOf(variantOf(juice)), main.id)).toBe('-3.0000');
  });
});

describe('a product with stock', () => {
  it('keeps its base unit and cannot be deleted', async () => {
    const current = productSchema.parse((await send('GET', `/products/${juice.id}`)).json());
    const res = await send('PUT', `/products/${juice.id}`, {
      code: current.code,
      name: current.name,
      type: 'goods',
      categoryId: '',
      description: '',
      baseUnitId: unitId('bottle'),
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      options: [],
      variants: current.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        optionValues: [],
        barcode: '',
        salePrice: '',
        archived: false,
      })),
      units: [],
      customFields: {},
      version: current.version,
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ baseUnitId: ['product_base_unit_locked'] });

    const remove = await send('DELETE', `/products/${juice.id}?version=${String(current.version)}`);
    expect(remove.statusCode).toBe(409);
    expect(problemOf(remove).code).toBe('product_in_use');
  });
});

describe('the database itself', () => {
  it('never changes or deletes a movement', async () => {
    await expect(
      superuserSql((sql) => sql`UPDATE stock_movements SET quantity = 1000`),
    ).rejects.toThrow(/cannot be changed or deleted/);
    await expect(superuserSql((sql) => sql`DELETE FROM stock_movements`)).rejects.toThrow(
      /cannot be changed or deleted/,
    );
  });

  it('keeps every balance equal to the sum of its movements', async () => {
    const drift = await superuserSql(
      (sql) => sql`
        SELECT b.warehouse_id, b.variant_id, b.batch_id, b.quantity, m.total
          FROM stock_balances b
          LEFT JOIN LATERAL (
            SELECT coalesce(sum(quantity), 0) AS total FROM stock_movements m
             WHERE m.tenant_id = b.tenant_id AND m.warehouse_id = b.warehouse_id
               AND m.variant_id = b.variant_id AND m.batch_id IS NOT DISTINCT FROM b.batch_id
          ) m ON true
         WHERE b.quantity <> m.total`,
    );
    expect(drift).toEqual([]);
  });

  it('refuses a movement that takes a batch below zero, whoever writes it', async () => {
    await expect(
      superuserSql(async (sql) => {
        const [row] = await sql<
          {
            id: string;
            tenant_id: string;
            variant_id: string;
            product_id: string;
            warehouse_id: string;
            batch_id: string;
          }[]
        >`
          SELECT * FROM stock_balances WHERE batch_id IS NOT NULL LIMIT 1`;
        if (!row) throw new Error('no batch balance');
        await sql`INSERT INTO stock_movements (id, tenant_id, date, warehouse_id, product_id, variant_id,
                    batch_id, quantity, kind, document_id, document_number)
                  VALUES (gen_random_uuid(), ${row.tenant_id}, '2026-10-04', ${row.warehouse_id},
                    ${row.product_id}, ${row.variant_id}, ${row.batch_id}, -100000, 'adjustment',
                    gen_random_uuid(), 'X')`;
      }),
    ).rejects.toThrow(/would be/);
  });
});
```

- **"refuses to take more than is there, and uses no number for it"** posts after two refusals and expects
  `ADJ-…-0002`: the refused postings rolled their numbers back.
- **"lets only one of two people take the same last 30 pieces"** races a write-off against a transfer. A third
  connection holds the balance row until `pg_stat_activity` shows both requests waiting, so "at the same moment" is
  certain, not luck. It must be two *kinds* of document: two adjustments already queue on their number series'
  counter row and never meet at the stock (the first version of this test proved nothing — see "What we found on
  the way"). The refused one must carry `lines.0.quantity`: only the API's own check, under its row lock, can say
  which line it was.
- **"the database itself"** writes as the superuser, past the API and past RLS: the triggers must hold anyway.
- **"keeps every balance equal to the sum of its movements"** is also the query to run on a real database if a
  balance ever looks wrong (COMMANDS.md, 13.12).

### `inventory/stock.tenant-leak.int.spec.ts` (new)

`apps/api/src/inventory/stock.tenant-leak.int.spec.ts`:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  problemSchema,
  type Product,
  productSchema,
  setupSchema,
  type StockAdjustment,
  stockAdjustmentSchema,
  stockCardSchema,
  stockPageSchema,
  type StockTransfer,
  stockTransferSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two workspaces with stock: A must never see, use or change B's warehouses, stock, batches,
// adjustments or transfers. Every answer is 404, or the same "pick one from the list" as for an id
// that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let unitsOfB: Unit[];
let mainOfA: Warehouse;
let mainOfB: Warehouse;
let productOfA: Product;
let productOfB: Product;
let adjustmentOfB: StockAdjustment;
let transferOfB: StockTransfer;

function as(
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

async function setUp(who: SignedIn): Promise<{ units: Unit[]; main: Warehouse }> {
  expect((await as(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  const units = unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
  const [main] = warehouseListSchema.parse((await as(who, 'GET', '/warehouses')).json()).items;
  if (!main) throw new Error('no warehouse');
  return { units, main };
}

async function productIn(who: SignedIn, units: Unit[], name: string): Promise<Product> {
  const res = await as(who, 'POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcsOf(units),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'batch',
    hasExpiry: false,
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error('no variant');
  return variant.id;
}

function stockIn(warehouseId: string, variantId: string, unitId: string) {
  return {
    date: '2026-10-01',
    warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines: [
      {
        variantId,
        unitId,
        quantity: '10',
        batchId: '',
        lotNumber: 'LOT-1',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: [],
      },
    ],
    post: true,
  };
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  tenantA = await signUp(app, {
    companyName: 'Agora Mart',
    workspaceSlug: 'agora-mart',
    fullName: 'Abir Hossain',
    email: 'abir@agoramart.com',
    password: 'Shelf-scan-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Bazar Point',
    workspaceSlug: 'bazar-point',
    fullName: 'Bithi Rahman',
    email: 'bithi@bazarpoint.com',
    password: 'Counter-two-2026',
  });
  ({ units: unitsOfA, main: mainOfA } = await setUp(tenantA));
  ({ units: unitsOfB, main: mainOfB } = await setUp(tenantB));
  productOfA = await productIn(tenantA, unitsOfA, 'Teer Soybean Oil 1 l');
  productOfB = await productIn(tenantB, unitsOfB, 'Rupchanda Soybean Oil 5 l');

  const adjustment = await as(
    tenantB,
    'POST',
    '/stock-adjustments',
    stockIn(mainOfB.id, variantOf(productOfB), pcsOf(unitsOfB)),
  );
  expect(adjustment.statusCode, adjustment.body).toBe(201);
  adjustmentOfB = stockAdjustmentSchema.parse(adjustment.json());

  const store = await as(tenantB, 'POST', '/warehouses', {
    branchId: mainOfB.branchId,
    code: 'BACK',
    name: 'Back room',
    address: '',
  });
  const backOfB = warehouseSchema.parse(store.json());
  const transfer = await as(tenantB, 'POST', '/stock-transfers', {
    fromWarehouseId: mainOfB.id,
    toWarehouseId: backOfB.id,
    date: '2026-10-02',
    note: '',
    lines: [
      {
        variantId: variantOf(productOfB),
        unitId: pcsOf(unitsOfB),
        quantity: '1',
        batchId: adjustmentOfB.lines[0]?.batchId ?? '',
        serialNumbers: [],
      },
    ],
    send: false,
  });
  expect(transfer.statusCode, transfer.body).toBe(201);
  transferOfB = stockTransferSchema.parse(transfer.json());
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('stock across workspaces', () => {
  it("does not list or open B's stock", async () => {
    const page = stockPageSchema.parse(
      (await as(tenantA, 'GET', '/stock?search=rupchanda')).json(),
    );
    expect(page.items).toEqual([]);
    expect((await as(tenantA, 'GET', `/stock/variants/${variantOf(productOfB)}`)).statusCode).toBe(
      404,
    );
    expect(
      (await as(tenantA, 'GET', `/stock/variants/${variantOf(productOfB)}/movements`)).statusCode,
    ).toBe(404);
    expect((await as(tenantA, 'GET', `/stock-adjustments/${adjustmentOfB.id}`)).statusCode).toBe(
      404,
    );
    expect((await as(tenantA, 'GET', `/stock-transfers/${transferOfB.id}`)).statusCode).toBe(404);
    const warehouses = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json());
    expect(warehouses.items.map((warehouse) => warehouse.id)).toEqual([mainOfA.id]);
  });

  it("cannot move stock in B's warehouse or of B's product", async () => {
    const intoB = await as(
      tenantA,
      'POST',
      '/stock-adjustments',
      stockIn(mainOfB.id, variantOf(productOfA), pcsOf(unitsOfA)),
    );
    expect(problemSchema.parse(intoB.json()).fieldErrors).toEqual({
      warehouseId: ['stock_warehouse_invalid'],
    });
    const ofB = await as(
      tenantA,
      'POST',
      '/stock-adjustments',
      stockIn(mainOfA.id, variantOf(productOfB), pcsOf(unitsOfB)),
    );
    expect(problemSchema.parse(ofB.json()).fieldErrors).toEqual({
      'lines.0.variantId': ['stock_variant_invalid'],
    });
  });

  it("cannot take from B's batch", async () => {
    await as(
      tenantA,
      'POST',
      '/stock-adjustments',
      stockIn(mainOfA.id, variantOf(productOfA), pcsOf(unitsOfA)),
    );
    const res = await as(tenantA, 'POST', '/stock-adjustments', {
      ...stockIn(mainOfA.id, variantOf(productOfA), pcsOf(unitsOfA)),
      direction: 'out',
      reason: 'damaged',
      lines: [
        {
          variantId: variantOf(productOfA),
          unitId: pcsOf(unitsOfA),
          quantity: '1',
          batchId: adjustmentOfB.lines[0]?.batchId ?? '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
        },
      ],
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.0.batchId': ['stock_batch_invalid'],
    });
  });

  it("cannot change B's warehouse, transfer or reorder levels", async () => {
    expect(
      (
        await as(tenantA, 'PUT', `/warehouses/${mainOfB.id}`, {
          branchId: mainOfA.branchId,
          code: 'MAIN',
          name: 'Taken over',
          address: '',
          version: mainOfB.version,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await as(tenantA, 'POST', `/stock-transfers/${transferOfB.id}/send`, {
          version: transferOfB.version,
        })
      ).statusCode,
    ).toBe(404);
    const level = await as(tenantA, 'PUT', '/stock/reorder-levels', {
      warehouseId: mainOfA.id,
      variantId: variantOf(productOfB),
      minQuantity: '5',
      reorderQuantity: '',
    });
    expect(problemSchema.parse(level.json()).code).toBe('stock_variant_invalid');
    // B's own stock is untouched by all of it
    const card = stockCardSchema.parse(
      (await as(tenantB, 'GET', `/stock/variants/${variantOf(productOfB)}`)).json(),
    );
    expect(card.item.onHand).toBe('10.0000');
  });
});
```

### Existing tests that change

`apps/api/src/setup/setup.int.spec.ts` (changed):

```diff
@@ -140,7 +140,10 @@ describe('starting the setup', () => {
         ],
       ],
       ['Merchandiser', ['core.user.read', 'inventory.product.manage']],
-      ['Store keeper', ['inventory.product.manage']],
+      [
+        'Store keeper',
+        ['inventory.product.manage', 'inventory.stock.adjust', 'inventory.stock.transfer'],
+      ],
     ]);
     const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
     expect(chart.items.find((account) => account.code === '4110')).toMatchObject({
```

`apps/api/src/numbering/numbering.int.spec.ts` (changed):

```diff
@@ -101,7 +101,12 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(7);
+    expect(items.map((series) => series.documentType)).toHaveLength(9);
+    // Stock documents (step 13): numbered by fiscal year, like the journal
+    expect(items.find((series) => series.documentType === 'inventory.transfer')).toMatchObject({
+      prefix: 'TRF',
+      nextNumber: `TRF-${today}-0001`,
+    });
     // Product codes (step 12): no year in them, five digits
     expect(items.find((series) => series.documentType === 'inventory.product')).toMatchObject({
       prefix: 'P',
```

`apps/api/src/settings/settings.int.spec.ts` (changed):

```diff
@@ -90,6 +90,7 @@ function form(settings: Settings) {
     baseCurrency: settings.baseCurrency,
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
+    allowNegativeStock: settings.allowNegativeStock,
   };
 }
```

`apps/api/src/journal/journal.int.spec.ts` (changed):

```diff
@@ -399,6 +399,7 @@ describe('a posted entry', () => {
       baseCurrency: 'USD',
       fiscalYearStartMonth: settings.fiscalYearStartMonth,
       timezone: settings.timezone,
+      allowNegativeStock: settings.allowNegativeStock,
     });
     expect(res.statusCode).toBe(409);
     expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
```

The RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`) needs no change: it finds the eight new tables by
their `tenant_id` column and checks them.

---

## 13.6 — `packages/i18n`: the texts, and Bangla on demand

### `i18n.ts` and `index.ts`

`packages/i18n/src/i18n.ts` (changed):

```diff
@@ -2,8 +2,8 @@ import type { LanguageCode } from '@omnivo/contracts';
 import i18next from 'i18next';
 import { initReactI18next } from 'react-i18next';
 
-import { bn } from './locales/bn.js';
 import { en } from './locales/en.js';
+import type { Messages } from './locales/messages.js';
 
 // satisfies: সার্ভারে সেভ হওয়া ভাষা (contracts-এর LANGUAGE_CODES) আর এই তালিকা একই — চুক্তিতে নেই এমন
 // ভাষা এখানে যোগ করলে compile error। import type: runtime-এ contracts লাগে না
@@ -30,21 +30,38 @@ function storedLanguage(): Language {
   }
 }
 
+// Step 13: English is in the first page load (it is also the fallback for a missing key); every
+// other language is a chunk of its own, fetched the first time someone uses it. Both languages
+// together had grown to 45 KB gz of the 200 KB first-load budget, and most readers use one.
+// satisfies: a new language in LANGUAGES does not compile until it has a loader here.
+const LOADERS = {
+  bn: async () => (await import('./locales/bn.js')).bn,
+} satisfies Record<Exclude<Language, 'en'>, () => Promise<Messages>>;
+
 // global singleton-এর বদলে নিজস্ব instance: অন্য কোনো লাইব্রেরি i18next-এর default instance
 // init করলেও আমাদের অনুবাদে হাত পড়বে না
 export const i18n = i18next.createInstance();
 
 void i18n.use(initReactI18next).init({
-  resources: { en: { translation: en }, bn: { translation: bn } },
-  lng: storedLanguage(),
+  resources: { en: { translation: en } },
+  // English until the stored language has arrived (languageReady below)
+  lng: 'en',
   fallbackLng: 'en',
   supportedLngs: LANGUAGES.map((language) => language.code),
-  // resource bundle-এর ভেতরেই আছে, তাই init sync — প্রথম render-এই অনুবাদ তৈরি
+  // The other languages are added later with addResourceBundle
+  partialBundledLanguages: true,
+  // English is in the bundle, so init is sync: the first render already has its texts
   initAsync: false,
   // React নিজেই escape করে; i18next আবার করলে "&amp;" দেখা যেত
   interpolation: { escapeValue: false },
 });
 
+// A language's texts, fetched once. English is always there.
+async function loadLanguage(language: Language): Promise<void> {
+  if (language === 'en' || i18n.hasResourceBundle(language, 'translation')) return;
+  i18n.addResourceBundle(language, 'translation', await LOADERS[language]());
+}
+
 // স্ক্রিন রিডার আর ব্রাউজারের hyphenation/ফন্ট নির্বাচন <html lang> দেখে
 function syncDocumentLanguage(language: string): void {
   if (typeof document !== 'undefined') document.documentElement.lang = language;
@@ -53,6 +70,7 @@ syncDocumentLanguage(i18n.language);
 i18n.on('languageChanged', syncDocumentLanguage);
 
 export async function setLanguage(language: Language): Promise<void> {
+  await loadLanguage(language);
   await i18n.changeLanguage(language);
   try {
     localStorage.setItem(STORAGE_KEY, language);
@@ -60,3 +78,8 @@ export async function setLanguage(language: Language): Promise<void> {
     // সেভ না হলে শুধু এই সেশনে ভাষা বদলাবে — ক্ষতি নেই
   }
 }
+
+// The language this device used last, ready to use. main.tsx waits for it before the first render,
+// so a Bangla reader never sees a flash of English; for English it resolves at once. A failed fetch
+// (offline on the very first visit) leaves the app in English instead of not starting at all.
+export const languageReady: Promise<void> = setLanguage(storedLanguage()).catch(() => undefined);
```

`packages/i18n/src/index.ts` (changed):

```diff
@@ -1,6 +1,6 @@
 import './types.js';
 
-export { i18n, isLanguage, LANGUAGES, setLanguage, type Language } from './i18n.js';
+export { i18n, isLanguage, LANGUAGES, languageReady, setLanguage, type Language } from './i18n.js';
 export {
   formatDate,
   formatDateTime,
```

- **`LOADERS … satisfies Record<Exclude<Language, 'en'>, …>`**: a third language in `LANGUAGES` does not compile
  until it has a loader. English is never loaded this way: it is in the bundle because it is the fallback for any
  missing key.
- **`partialBundledLanguages: true`** tells i18next that some languages arrive later through
  `addResourceBundle()`; without it, it would treat Bangla as "loaded, but empty".
- **`lng: 'en'` at init**, then `languageReady` switches to the stored language. `main.tsx` waits for it (13.8), so
  a Bangla reader's first screen is already in Bangla.
- **`.catch(() => undefined)`**: if the Bangla chunk cannot be fetched (offline on the very first visit), the app
  starts in English instead of not starting.
- **Every language change already went through `setLanguage()`** (the login page's switch, the user menu, the saved
  preference after sign-in), so loading the chunk there covers every path.

### `locales/en.ts` and `locales/bn.ts`

`packages/i18n/src/locales/en.ts` (changed):

```diff
@@ -59,6 +59,13 @@ export const en = {
     units: 'Units',
     productImports: 'Imports',
     customFields: 'Custom fields',
+    stock: 'Stock',
+    stockOnHand: 'Stock on hand',
+    adjustments: 'Adjustments',
+    transfers: 'Transfers',
+    expiry: 'Batches and expiry',
+    reorder: 'Reorder',
+    warehouses: 'Warehouses',
   },
   auth: {
     workspace: 'Workspace',
@@ -136,6 +143,11 @@ export const en = {
     replaceLogo: 'Replace',
     removeLogo: 'Remove',
     uploading: 'Uploading…',
+    inventoryTitle: 'Inventory',
+    inventorySubtitle: 'How stock behaves in every warehouse',
+    allowNegativeStock: 'Allow negative stock',
+    allowNegativeStockHint:
+      'Sales and adjustments may then take more than the stock shows, for products without batches or serial numbers. Leave it off unless your counters sell before the stock is entered.',
     logoSaved: 'Logo updated',
     logoRemoved: 'Logo removed',
     saved: 'Settings saved',
@@ -154,7 +166,12 @@ export const en = {
     documents: {
       sales: { invoice: 'Sales invoice', order: 'Sales order' },
       purchase: { order: 'Purchase order', bill: 'Supplier bill' },
-      inventory: { receipt: 'Goods receipt (GRN)', product: 'Product code' },
+      inventory: {
+        receipt: 'Goods receipt (GRN)',
+        product: 'Product code',
+        adjustment: 'Stock adjustment',
+        transfer: 'Stock transfer',
+      },
       accounting: { journal: 'Journal voucher' },
     },
     yearStyles: {
@@ -819,6 +836,291 @@ export const en = {
     loadFailed: "Couldn't load the imports. Refresh the page to try again.",
     readOnly: 'To import products, ask for the inventory.product.manage permission.',
   },
+  warehouses: {
+    title: 'Warehouses',
+    description: 'Where stock is kept: stores, depots and back rooms, each in a branch',
+    add: 'Add warehouse',
+    newTitle: 'Add a warehouse',
+    editTitle: 'Edit {{code}}',
+    code: 'Code',
+    codeHint: '2–10 capital letters or digits',
+    name: 'Name',
+    branch: 'Branch',
+    address: 'Address',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: { warehouse: 'Warehouse', branch: 'Branch', status: 'Status' },
+    archive: 'Archive',
+    restore: 'Restore',
+    created: '{{name}} added',
+    updated: 'Changes to {{name}} saved',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    readOnly:
+      'Ask a workspace owner for the inventory.warehouse.manage permission to change warehouses.',
+    emptyTitle: 'No warehouses yet',
+    emptyBody:
+      'Add the places you keep stock: a finished goods store, a depot, a shop’s back room.',
+    emptyArchivedTitle: 'No archived warehouses',
+    emptyArchivedBody: 'A depot you close can be archived once its stock is moved out.',
+    loadFailed: "Couldn't load the warehouses. Refresh the page to try again.",
+  },
+  stock: {
+    title: 'Stock on hand',
+    description: 'What is in each warehouse now, from every posted movement',
+    searchLabel: 'Search stock',
+    searchPlaceholder: 'Name, code or SKU, or scan a barcode or IMEI',
+    warehouse: 'Warehouse',
+    allWarehouses: 'All warehouses',
+    category: 'Category',
+    allCategories: 'All categories',
+    show: 'Show',
+    filters: { all: 'All', in_stock: 'In stock', low: 'Low' },
+    columns: {
+      product: 'Product',
+      onHand: 'On hand',
+      inTransit: 'In transit',
+      status: 'Status',
+    },
+    statuses: { low: 'Low', out: 'Out of stock', negative: 'Below zero', archived: 'Archived' },
+    newAdjustment: 'New adjustment',
+    newTransfer: 'New transfer',
+    emptyTitle: 'No stock yet',
+    emptyBody:
+      'Post your opening stock with an adjustment: every product counted on your first day, warehouse by warehouse.',
+    noMatchTitle: 'Nothing matches “{{query}}”',
+    noMatchBody: 'Try part of the name, or scan the barcode again.',
+    lowEmptyTitle: 'Nothing is low',
+    lowEmptyBody: 'Set reorder levels on a product’s stock page to see here what runs low.',
+    loadFailed: "Couldn't load the stock. Refresh the page to try again.",
+    back: 'Stock on hand',
+    cardFailed: 'This product is not stocked, or no longer exists.',
+    kpis: {
+      onHand: 'On hand',
+      inTransit: 'In transit',
+      places: 'Warehouses with stock',
+    },
+    byWarehouse: 'By warehouse',
+    byWarehouseSubtitle: 'On hand, on its way, and when to order more',
+    level: 'Reorder level',
+    levelAt: 'At {{quantity}}',
+    levelOrder: 'Order {{quantity}}',
+    noLevel: 'Not set',
+    setLevel: 'Set the reorder level at {{warehouse}}',
+    levelTitle: 'Reorder level at {{warehouse}}',
+    levelDescription: 'You hear in the bell when stock here falls to this level.',
+    minQuantity: 'Reorder when stock falls to',
+    reorderQuantity: 'Order quantity',
+    levelSaved: 'Reorder level saved',
+    levelCleared: 'Reorder level cleared',
+    clearLevel: 'Clear level',
+    batchesTitle: 'Batches',
+    batchesSubtitle: 'First expiry, first out: the top batch goes first',
+    lot: 'Lot',
+    made: 'Made',
+    expires: 'Expires',
+    noExpiry: 'No expiry',
+    serialsTitle: 'Serial numbers',
+    serialsSubtitle: 'In stock, and on their way between warehouses',
+    inTransitPlace: 'In transit',
+    historyTitle: 'History',
+    historySubtitle: 'Every posted movement, with the running balance',
+    from: 'From',
+    to: 'To',
+    opening: 'Opening balance',
+    closing: 'Closing balance',
+    history: {
+      date: 'Date',
+      document: 'Document',
+      warehouse: 'Warehouse',
+      detail: 'Batch or serial',
+      in: 'In',
+      out: 'Out',
+      balance: 'Balance',
+    },
+    kinds: { adjustment: 'Adjustment', transfer_out: 'Sent', transfer_in: 'Received' },
+    historyEmpty: 'No movement in these dates.',
+  },
+  stockLines: {
+    items: 'Items',
+    addItems: 'Add items',
+    pickerTitle: 'Add items',
+    pickerDescription: 'Search, or scan a barcode. Each click adds a line.',
+    pickerSearch: 'Search products',
+    pickerEmpty: 'No stocked product matches.',
+    add: 'Add',
+    added: 'Added',
+    inStock: '{{quantity}} in stock here',
+    archived: 'Archived',
+    line: 'Line {{number}}',
+    remove: 'Remove line {{number}}',
+    unit: 'Unit',
+    quantity: 'Quantity',
+    equals: '= {{quantity}}',
+    lot: 'Lot number',
+    expiresOn: 'Expiry date',
+    manufacturedOn: 'Made on',
+    batch: 'Batch',
+    batchPlaceholder: 'Pick a batch',
+    batchOption: '{{lot}} · {{quantity}} · {{expiry}}',
+    pickFefo: 'Split by first expiry',
+    fefoShort: 'Only {{quantity}} in all batches here',
+    serials: 'Serial numbers',
+    serialsHint: 'One per line. A scanner adds them one by one.',
+    serialsCount: '{{count}} of {{wanted}} entered',
+    noLines: 'No items yet. Add the products this document moves.',
+    pickWarehouse: 'Pick the warehouse first: the search shows its stock.',
+  },
+  adjustments: {
+    title: 'Stock adjustments',
+    description:
+      'Opening stock, counts, damage and samples: stock that comes or goes without a sale or a purchase',
+    new: 'New adjustment',
+    newTitle: 'New stock adjustment',
+    draftTitle: 'Draft adjustment',
+    back: 'Stock adjustments',
+    date: 'Date',
+    warehouse: 'Warehouse',
+    direction: 'Direction',
+    directions: { in: 'Stock in', out: 'Stock out' },
+    reason: 'Reason',
+    reasons: {
+      opening: 'Opening stock',
+      found: 'Found in a count',
+      damaged: 'Damaged',
+      expired: 'Expired',
+      lost: 'Lost or stolen',
+      sample: 'Free samples',
+      internal_use: 'Used in the company',
+      correction: 'Correction',
+    },
+    note: 'Note',
+    notePlaceholder: 'Counted by Rafiq on 30 Sep; carton 14 water-damaged',
+    show: 'Show',
+    all: 'All',
+    statuses: { draft: 'Draft', posted: 'Posted' },
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      warehouse: 'Warehouse',
+      reason: 'Reason',
+      lines: 'Items',
+      status: 'Status',
+    },
+    lineCount_one: '{{count}} item',
+    lineCount_other: '{{count}} items',
+    saveDraft: 'Save draft',
+    post: 'Post adjustment',
+    posting: 'Posting…',
+    posted: '{{number}} posted',
+    draftSaved: 'Draft saved',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'A deleted draft cannot be brought back.',
+    deleted: 'Draft deleted',
+    postHint:
+      'Posting moves the stock. A posted adjustment never changes: post another one to correct it.',
+    cantWrite:
+      'You can view adjustments. Ask a workspace owner for the inventory.stock.adjust permission to write them.',
+    postedOn: 'Posted {{date}}',
+    notFound: 'This adjustment no longer exists. A draft may have been deleted.',
+    emptyTitle: 'No adjustments yet',
+    emptyBody:
+      'Start with your opening stock: one “Stock in” adjustment per warehouse, with the reason “Opening stock”.',
+    loadFailed: "Couldn't load the adjustments. Refresh the page to try again.",
+  },
+  transfers: {
+    title: 'Stock transfers',
+    description: 'Stock sent between warehouses: out when it leaves, in when it arrives',
+    new: 'New transfer',
+    newTitle: 'New stock transfer',
+    draftTitle: 'Draft transfer',
+    back: 'Stock transfers',
+    from: 'From',
+    to: 'To',
+    date: 'Send date',
+    note: 'Note',
+    notePlaceholder: 'Truck DM-TA 11-2233, driver Kamal',
+    show: 'Show',
+    all: 'All',
+    statuses: { draft: 'Draft', in_transit: 'In transit', received: 'Received' },
+    shortPill: 'Short',
+    columns: {
+      number: 'Number',
+      route: 'From → To',
+      sent: 'Sent',
+      lines: 'Items',
+      status: 'Status',
+    },
+    saveDraft: 'Save draft',
+    send: 'Send transfer',
+    sending: 'Sending…',
+    sent: '{{number}} sent',
+    draftSaved: 'Draft saved',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'A deleted draft cannot be brought back.',
+    deleted: 'Draft deleted',
+    sendHint:
+      'Sending takes the stock out of the first warehouse. It is in transit until received.',
+    cantWrite:
+      'You can view transfers. Ask a workspace owner for the inventory.stock.transfer permission to send and receive them.',
+    sentOn: 'Sent {{date}}',
+    receivedOn: 'Received {{date}}',
+    receiveTitle: 'Receive at {{warehouse}}',
+    receiveSubtitle: 'Count what arrived. Anything less stays on this transfer as a shortage.',
+    receiveDate: 'Arrived on',
+    sentQuantity: 'Sent',
+    receivedQuantity: 'Arrived',
+    receive: 'Receive transfer',
+    receiving: 'Receiving…',
+    received: '{{number}} received',
+    shortBy: 'Short by {{quantity}}',
+    allArrived: 'All arrived',
+    serialsArrived: 'Serial numbers that arrived',
+    notFound: 'This transfer no longer exists. A draft may have been deleted.',
+    emptyTitle: 'No transfers yet',
+    emptyBody:
+      'Send stock from your main store to a depot or a shop. It shows here while it is on the road.',
+    loadFailed: "Couldn't load the transfers. Refresh the page to try again.",
+  },
+  expiry: {
+    title: 'Batches and expiry',
+    description: 'Every batch with stock, the soonest expiry first',
+    within: 'Expiring',
+    windows: { all: 'All', d30: 'In 30 days', d60: 'In 60 days', d90: 'In 90 days' },
+    columns: {
+      product: 'Product',
+      lot: 'Lot',
+      warehouse: 'Warehouse',
+      expires: 'Expires',
+      quantity: 'Quantity',
+    },
+    expired: 'Expired',
+    daysLeft_one: '{{count}} day left',
+    daysLeft_other: '{{count}} days left',
+    noExpiry: 'No expiry',
+    emptyTitle: 'No batch expires in this time',
+    emptyBody:
+      'Batches appear when stock of a batch-tracked product comes in with its lot number and expiry date.',
+    loadFailed: "Couldn't load the batches. Refresh the page to try again.",
+  },
+  reorder: {
+    title: 'Reorder',
+    description: 'What has fallen to its reorder level, warehouse by warehouse',
+    columns: {
+      product: 'Product',
+      warehouse: 'Warehouse',
+      onHand: 'On hand',
+      inTransit: 'In transit',
+      level: 'Reorder level',
+      order: 'Order',
+    },
+    emptyTitle: 'Nothing to reorder',
+    emptyBody:
+      'Set a reorder level on a product’s stock page. It shows here when the stock falls to it.',
+    loadFailed: "Couldn't load the reorder list. Refresh the page to try again.",
+  },
   yearEnd: {
     title: 'Year-end close',
     description: "Move each year's profit into retained earnings and close its dates",
@@ -970,7 +1272,14 @@ export const en = {
       report: { read: 'See the reports and export them' },
     },
     inventory: {
-      product: { manage: 'Add, edit and import products, their categories and units' },
+      product: {
+        manage: 'Add, edit and import products, their categories and units, and set reorder levels',
+      },
+      warehouse: { manage: 'Add, edit and archive warehouses' },
+      stock: {
+        adjust: 'Write and post stock adjustments and opening stock',
+        transfer: 'Send stock to another warehouse and receive it',
+      },
     },
   },
   invite: {
@@ -1013,6 +1322,10 @@ export const en = {
       custom_field: 'Custom fields',
       product: 'Products',
       product_import: 'Product imports',
+      warehouse: 'Warehouses',
+      stock_adjustment: 'Stock adjustments',
+      stock_transfer: 'Stock transfers',
+      reorder_level: 'Reorder levels',
     },
     columns: {
       when: 'When',
@@ -1105,6 +1418,26 @@ export const en = {
         deleted: 'Deleted a product',
         imported: 'Imported products from a file',
       },
+      warehouse: {
+        created: 'Added a warehouse',
+        updated: 'Edited a warehouse',
+        archived: 'Archived a warehouse',
+        restored: 'Restored a warehouse',
+      },
+      stock_adjustment: {
+        created: 'Wrote a stock adjustment',
+        updated: 'Edited a draft adjustment',
+        deleted: 'Deleted a draft adjustment',
+        posted: 'Posted a stock adjustment',
+      },
+      stock_transfer: {
+        created: 'Wrote a stock transfer',
+        updated: 'Edited a draft transfer',
+        deleted: 'Deleted a draft transfer',
+        sent: 'Sent a stock transfer',
+        received: 'Received a stock transfer',
+      },
+      reorder_level: { changed: 'Changed a reorder level' },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -1157,6 +1490,16 @@ export const en = {
       units: 'Units',
       categories: 'Categories',
       customFields: 'Custom fields',
+      warehouse: 'Warehouse',
+      branch: 'Branch',
+      direction: 'Direction',
+      reason: 'Reason',
+      from: 'From',
+      to: 'To',
+      short: 'Received short',
+      min: 'Reorder level',
+      reorder: 'Order quantity',
+      allowNegativeStock: 'Negative stock allowed',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -1236,6 +1579,9 @@ export const en = {
         done: '{{file}}: {{count}} products imported.',
         failed: '{{file}} was not imported: {{count}} problems to fix. Nothing was saved.',
       },
+      stock: {
+        low: '{{warehouse}}: {{count}} items fell to their reorder level. Time to order more.',
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
@@ -1412,6 +1758,52 @@ export const en = {
     import_unit_unknown: 'No unit "{{value}}". Use a code from the Units page.',
     import_category_invalid: 'Write the category as a path, like Fabrics > Knit.',
     import_value_invalid: 'Use one of: {{allowed}}.',
+    warehouse_code_format: 'Use 2 to 10 capital letters or digits, like FG or CTG.',
+    warehouse_code_taken: 'Another warehouse uses this code. Pick a different one.',
+    warehouse_name_required: 'Enter the warehouse name.',
+    warehouse_branch_invalid: 'Pick an active branch.',
+    warehouse_branch_locked:
+      'This warehouse has stock history, so it stays in its branch. Add a new warehouse instead.',
+    warehouse_has_stock:
+      'This warehouse still holds stock. Transfer it or adjust it out, then archive the warehouse.',
+    warehouse_has_transfers:
+      'Stock is on its way to or from this warehouse. Receive those transfers first.',
+    branch_has_warehouses: 'Archive or move this branch’s warehouses first.',
+    quantity_format: 'Enter a number above zero, with up to 4 decimals.',
+    serial_number_format: 'A serial number is letters, digits and dashes, without spaces.',
+    stock_date_required: 'Pick the date.',
+    stock_date_future: 'Stock cannot move on a day that has not come yet. Pick today or earlier.',
+    stock_warehouse_invalid: 'Pick an active warehouse.',
+    stock_lines_required: 'Add at least one item.',
+    stock_variant_required: 'Pick a product.',
+    stock_variant_invalid: 'Pick a stocked product. Archived products can only go out.',
+    stock_unit_invalid: 'Pick the base unit or one of this product’s packs.',
+    stock_quantity_decimals: 'This unit does not take that many decimals. Enter a whole number.',
+    stock_lot_required: 'Enter the lot number printed on the goods.',
+    stock_expiry_required: 'This lot is new: enter its expiry date.',
+    stock_batch_dates: 'The expiry date must come after the manufacturing date.',
+    stock_batch_required: 'Pick the batch the goods come from.',
+    stock_batch_invalid: 'Pick a batch of this product.',
+    stock_batch_expiry_mismatch:
+      'This lot already has another expiry date. Check the lot number, or leave the date empty.',
+    stock_serial_count: 'Enter one serial number for each item.',
+    stock_serial_twice: 'This serial number is entered twice.',
+    stock_serial_in_stock: 'One of these serial numbers is already in stock.',
+    stock_serial_not_here: 'One of these serial numbers is not in this warehouse.',
+    stock_insufficient: 'Not enough stock here. Lower the quantity or pick another batch.',
+    stock_not_draft: 'Only a draft can be changed. Post another document to correct it.',
+    adjustment_reason_direction: 'This reason does not fit the direction. Pick another reason.',
+    transfer_same_warehouse: 'Pick a different warehouse to send to.',
+    transfer_not_in_transit: 'This transfer is not on its way any more. Reload the page.',
+    transfer_lines_mismatch: 'Receive every line of the transfer.',
+    transfer_receive_too_many: 'More than was sent. Enter what actually arrived.',
+    transfer_receive_date: 'It cannot arrive before the day it was sent.',
+    transfer_serial_not_sent: 'This serial number was not sent on this transfer.',
+    reorder_level_required: 'Enter the reorder level before the order quantity.',
+    product_base_unit_locked:
+      'This product has stock, so its base unit stays. Add a pack for the other unit instead.',
+    product_tracking_locked: 'This product has stock, so its tracking stays as it is.',
+    product_type_locked: 'This product has stock, so it stays goods.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
```

`packages/i18n/src/locales/bn.ts` (changed):

```diff
@@ -59,6 +59,13 @@ export const bn: Messages = {
     units: 'ইউনিট',
     productImports: 'ইমপোর্ট',
     customFields: 'কাস্টম ফিল্ড',
+    stock: 'স্টক',
+    stockOnHand: 'হাতে থাকা স্টক',
+    adjustments: 'অ্যাডজাস্টমেন্ট',
+    transfers: 'ট্রান্সফার',
+    expiry: 'ব্যাচ ও মেয়াদ',
+    reorder: 'রিঅর্ডার',
+    warehouses: 'গুদাম',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -136,6 +143,11 @@ export const bn: Messages = {
     replaceLogo: 'বদলান',
     removeLogo: 'সরান',
     uploading: 'আপলোড হচ্ছে…',
+    inventoryTitle: 'ইনভেন্টরি',
+    inventorySubtitle: 'প্রতিটা গুদামে স্টক কীভাবে চলবে',
+    allowNegativeStock: 'স্টক শূন্যের নিচে যেতে দিন',
+    allowNegativeStockHint:
+      'তাহলে ব্যাচ বা সিরিয়াল নম্বর ছাড়া প্রোডাক্টে বিক্রি আর অ্যাডজাস্টমেন্ট খাতায় থাকা স্টকের চেয়ে বেশি নিতে পারবে। কাউন্টারে স্টক এন্ট্রির আগেই বিক্রি না হলে এটা বন্ধ রাখুন।',
     logoSaved: 'লোগো বদলানো হয়েছে',
     logoRemoved: 'লোগো সরানো হয়েছে',
     saved: 'সেটিংস সেভ হয়েছে',
@@ -154,7 +166,12 @@ export const bn: Messages = {
     documents: {
       sales: { invoice: 'বিক্রয় ইনভয়েস', order: 'সেলস অর্ডার' },
       purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
-      inventory: { receipt: 'মাল গ্রহণ (GRN)', product: 'প্রোডাক্ট কোড' },
+      inventory: {
+        receipt: 'মাল গ্রহণ (GRN)',
+        product: 'প্রোডাক্ট কোড',
+        adjustment: 'স্টক অ্যাডজাস্টমেন্ট',
+        transfer: 'স্টক ট্রান্সফার',
+      },
       accounting: { journal: 'জার্নাল ভাউচার' },
     },
     yearStyles: {
@@ -814,6 +831,287 @@ export const bn: Messages = {
     loadFailed: 'ইমপোর্টের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     readOnly: 'প্রোডাক্ট ইমপোর্ট করতে inventory.product.manage অনুমতি চান।',
   },
+  warehouses: {
+    title: 'গুদাম',
+    description: 'স্টক যেখানে থাকে: স্টোর, ডিপো আর পেছনের ঘর, প্রতিটা একটা ব্রাঞ্চে',
+    add: 'গুদাম যোগ করুন',
+    newTitle: 'নতুন গুদাম',
+    editTitle: '{{code}} বদলান',
+    code: 'কোড',
+    codeHint: '২–১০টা বড় হাতের অক্ষর বা অঙ্ক',
+    name: 'নাম',
+    branch: 'ব্রাঞ্চ',
+    address: 'ঠিকানা',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ' },
+    columns: { warehouse: 'গুদাম', branch: 'ব্রাঞ্চ', status: 'অবস্থা' },
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরিয়ে আনা হয়েছে',
+    readOnly:
+      'গুদাম বদলাতে একজন workspace owner-এর কাছে inventory.warehouse.manage permission চান।',
+    emptyTitle: 'এখনো কোনো গুদাম নেই',
+    emptyBody: 'যেখানে স্টক রাখেন সেগুলো যোগ করুন: ফিনিশড গুডসের স্টোর, ডিপো, দোকানের পেছনের ঘর।',
+    emptyArchivedTitle: 'কোনো আর্কাইভ করা গুদাম নেই',
+    emptyArchivedBody: 'বন্ধ করা ডিপোর স্টক সরিয়ে নেওয়ার পরে সেটা আর্কাইভ করা যায়।',
+    loadFailed: 'গুদামের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  stock: {
+    title: 'হাতে থাকা স্টক',
+    description: 'প্রতিটা গুদামে এখন কী আছে, প্রতিটা পোস্ট করা মুভমেন্ট থেকে',
+    searchLabel: 'স্টক খুঁজুন',
+    searchPlaceholder: 'নাম, কোড বা SKU, অথবা বারকোড বা IMEI স্ক্যান করুন',
+    warehouse: 'গুদাম',
+    allWarehouses: 'সব গুদাম',
+    category: 'ক্যাটাগরি',
+    allCategories: 'সব ক্যাটাগরি',
+    show: 'দেখান',
+    filters: { all: 'সব', in_stock: 'স্টকে আছে', low: 'কম' },
+    columns: {
+      product: 'প্রোডাক্ট',
+      onHand: 'হাতে আছে',
+      inTransit: 'পথে আছে',
+      status: 'অবস্থা',
+    },
+    statuses: { low: 'কম', out: 'স্টক শেষ', negative: 'শূন্যের নিচে', archived: 'আর্কাইভ' },
+    newAdjustment: 'নতুন অ্যাডজাস্টমেন্ট',
+    newTransfer: 'নতুন ট্রান্সফার',
+    emptyTitle: 'এখনো কোনো স্টক নেই',
+    emptyBody:
+      'একটা অ্যাডজাস্টমেন্ট দিয়ে ওপেনিং স্টক পোস্ট করুন: প্রথম দিনে গোনা প্রতিটা প্রোডাক্ট, গুদাম ধরে ধরে।',
+    noMatchTitle: '“{{query}}”-এর সাথে কিছু মেলেনি',
+    noMatchBody: 'নামের একটা অংশ দিয়ে খুঁজুন, বা বারকোডটা আবার স্ক্যান করুন।',
+    lowEmptyTitle: 'কিছুই কম নেই',
+    lowEmptyBody: 'কোনটা কমে যাচ্ছে এখানে দেখতে প্রোডাক্টের স্টক পেজে রিঅর্ডার লেভেল দিন।',
+    loadFailed: 'স্টক আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    back: 'হাতে থাকা স্টক',
+    cardFailed: 'এই প্রোডাক্ট স্টকে রাখা হয় না, অথবা আর নেই।',
+    kpis: {
+      onHand: 'হাতে আছে',
+      inTransit: 'পথে আছে',
+      places: 'যতগুলো গুদামে স্টক আছে',
+    },
+    byWarehouse: 'গুদাম অনুযায়ী',
+    byWarehouseSubtitle: 'হাতে কত, পথে কত, আর কখন আবার অর্ডার করবেন',
+    level: 'রিঅর্ডার লেভেল',
+    levelAt: '{{quantity}}-এ',
+    levelOrder: '{{quantity}} অর্ডার',
+    noLevel: 'দেওয়া নেই',
+    setLevel: '{{warehouse}}-এ রিঅর্ডার লেভেল দিন',
+    levelTitle: '{{warehouse}}-এ রিঅর্ডার লেভেল',
+    levelDescription: 'এখানে স্টক এই লেভেলে নামলে বেলে জানতে পারবেন।',
+    minQuantity: 'স্টক যখন এতে নামবে, অর্ডার করুন',
+    reorderQuantity: 'অর্ডারের পরিমাণ',
+    levelSaved: 'রিঅর্ডার লেভেল সেভ হয়েছে',
+    levelCleared: 'রিঅর্ডার লেভেল মুছে ফেলা হয়েছে',
+    clearLevel: 'লেভেল মুছুন',
+    batchesTitle: 'ব্যাচ',
+    batchesSubtitle: 'যার মেয়াদ আগে শেষ, সেটা আগে যায়: সবার উপরের ব্যাচ প্রথমে',
+    lot: 'লট',
+    made: 'তৈরি',
+    expires: 'মেয়াদ শেষ',
+    noExpiry: 'মেয়াদ নেই',
+    serialsTitle: 'সিরিয়াল নম্বর',
+    serialsSubtitle: 'স্টকে আছে, আর এক গুদাম থেকে আরেক গুদামের পথে',
+    inTransitPlace: 'পথে আছে',
+    historyTitle: 'ইতিহাস',
+    historySubtitle: 'প্রতিটা পোস্ট করা মুভমেন্ট, চলতি ব্যালান্স সহ',
+    from: 'থেকে',
+    to: 'পর্যন্ত',
+    opening: 'শুরুর ব্যালান্স',
+    closing: 'শেষের ব্যালান্স',
+    history: {
+      date: 'তারিখ',
+      document: 'ডকুমেন্ট',
+      warehouse: 'গুদাম',
+      detail: 'ব্যাচ বা সিরিয়াল',
+      in: 'ঢুকেছে',
+      out: 'বেরিয়েছে',
+      balance: 'ব্যালান্স',
+    },
+    kinds: { adjustment: 'অ্যাডজাস্টমেন্ট', transfer_out: 'পাঠানো', transfer_in: 'গ্রহণ' },
+    historyEmpty: 'এই তারিখগুলোর মধ্যে কোনো মুভমেন্ট নেই।',
+  },
+  stockLines: {
+    items: 'আইটেম',
+    addItems: 'আইটেম যোগ করুন',
+    pickerTitle: 'আইটেম যোগ করুন',
+    pickerDescription: 'খুঁজুন, বা বারকোড স্ক্যান করুন। প্রতিটা ক্লিকে একটা লাইন যোগ হয়।',
+    pickerSearch: 'প্রোডাক্ট খুঁজুন',
+    pickerEmpty: 'স্টকে রাখা কোনো প্রোডাক্ট মেলেনি।',
+    add: 'যোগ করুন',
+    added: 'যোগ হয়েছে',
+    inStock: 'এখানে স্টকে {{quantity}}',
+    archived: 'আর্কাইভ',
+    line: 'লাইন {{number}}',
+    remove: 'লাইন {{number}} সরান',
+    unit: 'ইউনিট',
+    quantity: 'পরিমাণ',
+    equals: '= {{quantity}}',
+    lot: 'লট নম্বর',
+    expiresOn: 'মেয়াদ শেষের তারিখ',
+    manufacturedOn: 'তৈরির তারিখ',
+    batch: 'ব্যাচ',
+    batchPlaceholder: 'একটা ব্যাচ বাছুন',
+    batchOption: '{{lot}} · {{quantity}} · {{expiry}}',
+    pickFefo: 'আগে মেয়াদ শেষ অনুযায়ী ভাগ করুন',
+    fefoShort: 'এখানে সব ব্যাচ মিলিয়ে মাত্র {{quantity}}',
+    serials: 'সিরিয়াল নম্বর',
+    serialsHint: 'প্রতি লাইনে একটা। স্ক্যানার একটা একটা করে যোগ করে।',
+    serialsCount: '{{wanted}}-এর মধ্যে {{count}}টা লেখা হয়েছে',
+    noLines: 'এখনো কোনো আইটেম নেই। এই ডকুমেন্ট যে প্রোডাক্টগুলো নাড়াবে সেগুলো যোগ করুন।',
+    pickWarehouse: 'আগে গুদাম বাছুন: খোঁজার সময় সেখানকার স্টক দেখাবে।',
+  },
+  adjustments: {
+    title: 'স্টক অ্যাডজাস্টমেন্ট',
+    description:
+      'ওপেনিং স্টক, গণনা, নষ্ট মাল আর স্যাম্পল: বিক্রি বা কেনা ছাড়া যে স্টক ঢোকে বা বের হয়',
+    new: 'নতুন অ্যাডজাস্টমেন্ট',
+    newTitle: 'নতুন স্টক অ্যাডজাস্টমেন্ট',
+    draftTitle: 'খসড়া অ্যাডজাস্টমেন্ট',
+    back: 'স্টক অ্যাডজাস্টমেন্ট',
+    date: 'তারিখ',
+    warehouse: 'গুদাম',
+    direction: 'দিক',
+    directions: { in: 'স্টক ঢুকছে', out: 'স্টক বের হচ্ছে' },
+    reason: 'কারণ',
+    reasons: {
+      opening: 'ওপেনিং স্টক',
+      found: 'গণনায় পাওয়া',
+      damaged: 'নষ্ট',
+      expired: 'মেয়াদ শেষ',
+      lost: 'হারানো বা চুরি',
+      sample: 'ফ্রি স্যাম্পল',
+      internal_use: 'কোম্পানির নিজের কাজে',
+      correction: 'ভুল সংশোধন',
+    },
+    note: 'নোট',
+    notePlaceholder: '৩০ সেপ্টেম্বর রফিক গুনেছেন; ১৪ নম্বর কার্টন পানিতে নষ্ট',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { draft: 'খসড়া', posted: 'পোস্ট করা' },
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      warehouse: 'গুদাম',
+      reason: 'কারণ',
+      lines: 'আইটেম',
+      status: 'অবস্থা',
+    },
+    lineCount_one: '{{count}}টা আইটেম',
+    lineCount_other: '{{count}}টা আইটেম',
+    saveDraft: 'খসড়া সেভ করুন',
+    post: 'অ্যাডজাস্টমেন্ট পোস্ট করুন',
+    posting: 'পোস্ট হচ্ছে…',
+    posted: '{{number}} পোস্ট হয়েছে',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    postHint:
+      'পোস্ট করলে স্টক নড়ে। পোস্ট করা অ্যাডজাস্টমেন্ট আর বদলায় না: ঠিক করতে আরেকটা পোস্ট করুন।',
+    cantWrite:
+      'আপনি অ্যাডজাস্টমেন্ট দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে inventory.stock.adjust permission চান।',
+    postedOn: '{{date}}-এ পোস্ট হয়েছে',
+    notFound: 'এই অ্যাডজাস্টমেন্ট আর নেই। খসড়াটা হয়তো মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো অ্যাডজাস্টমেন্ট নেই',
+    emptyBody:
+      'ওপেনিং স্টক দিয়ে শুরু করুন: প্রতিটা গুদামের জন্য একটা “স্টক ঢুকছে” অ্যাডজাস্টমেন্ট, কারণ “ওপেনিং স্টক”।',
+    loadFailed: 'অ্যাডজাস্টমেন্টগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  transfers: {
+    title: 'স্টক ট্রান্সফার',
+    description: 'এক গুদাম থেকে আরেক গুদামে পাঠানো স্টক: রওনা দিলে বের হয়, পৌঁছালে ঢোকে',
+    new: 'নতুন ট্রান্সফার',
+    newTitle: 'নতুন স্টক ট্রান্সফার',
+    draftTitle: 'খসড়া ট্রান্সফার',
+    back: 'স্টক ট্রান্সফার',
+    from: 'যেখান থেকে',
+    to: 'যেখানে',
+    date: 'পাঠানোর তারিখ',
+    note: 'নোট',
+    notePlaceholder: 'ট্রাক ঢাকা মেট্রো-ট ১১-২২৩৩, চালক কামাল',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { draft: 'খসড়া', in_transit: 'পথে আছে', received: 'গ্রহণ করা' },
+    shortPill: 'কম পৌঁছেছে',
+    columns: {
+      number: 'নম্বর',
+      route: 'থেকে → যেখানে',
+      sent: 'পাঠানো',
+      lines: 'আইটেম',
+      status: 'অবস্থা',
+    },
+    saveDraft: 'খসড়া সেভ করুন',
+    send: 'ট্রান্সফার পাঠান',
+    sending: 'পাঠানো হচ্ছে…',
+    sent: '{{number}} পাঠানো হয়েছে',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    sendHint: 'পাঠালে প্রথম গুদাম থেকে স্টক বের হয়ে যায়। গ্রহণ না করা পর্যন্ত সেটা পথে থাকে।',
+    cantWrite:
+      'আপনি ট্রান্সফার দেখতে পারেন। পাঠাতে ও গ্রহণ করতে একজন workspace owner-এর কাছে inventory.stock.transfer permission চান।',
+    sentOn: '{{date}}-এ পাঠানো',
+    receivedOn: '{{date}}-এ গ্রহণ করা',
+    receiveTitle: '{{warehouse}}-এ গ্রহণ করুন',
+    receiveSubtitle: 'যা পৌঁছেছে সেটা গুনুন। কম হলে সেটা এই ট্রান্সফারে ঘাটতি হিসেবে থাকবে।',
+    receiveDate: 'পৌঁছানোর তারিখ',
+    sentQuantity: 'পাঠানো',
+    receivedQuantity: 'পৌঁছেছে',
+    receive: 'ট্রান্সফার গ্রহণ করুন',
+    receiving: 'গ্রহণ হচ্ছে…',
+    received: '{{number}} গ্রহণ করা হয়েছে',
+    shortBy: '{{quantity}} কম',
+    allArrived: 'সব পৌঁছেছে',
+    serialsArrived: 'যে সিরিয়াল নম্বরগুলো পৌঁছেছে',
+    notFound: 'এই ট্রান্সফার আর নেই। খসড়াটা হয়তো মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো ট্রান্সফার নেই',
+    emptyBody: 'মূল স্টোর থেকে ডিপো বা দোকানে স্টক পাঠান। পথে থাকার সময় সেটা এখানে দেখাবে।',
+    loadFailed: 'ট্রান্সফারগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  expiry: {
+    title: 'ব্যাচ ও মেয়াদ',
+    description: 'স্টক থাকা প্রতিটা ব্যাচ, যার মেয়াদ আগে শেষ সেটা আগে',
+    within: 'মেয়াদ শেষ',
+    windows: { all: 'সব', d30: '৩০ দিনে', d60: '৬০ দিনে', d90: '৯০ দিনে' },
+    columns: {
+      product: 'প্রোডাক্ট',
+      lot: 'লট',
+      warehouse: 'গুদাম',
+      expires: 'মেয়াদ শেষ',
+      quantity: 'পরিমাণ',
+    },
+    expired: 'মেয়াদ শেষ',
+    daysLeft_one: '{{count}} দিন বাকি',
+    daysLeft_other: '{{count}} দিন বাকি',
+    noExpiry: 'মেয়াদ নেই',
+    emptyTitle: 'এই সময়ে কোনো ব্যাচের মেয়াদ শেষ হচ্ছে না',
+    emptyBody:
+      'ব্যাচ-ট্র্যাক করা প্রোডাক্টের স্টক লট নম্বর আর মেয়াদের তারিখ সহ ঢুকলে ব্যাচ তৈরি হয়।',
+    loadFailed: 'ব্যাচগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  reorder: {
+    title: 'রিঅর্ডার',
+    description: 'যা রিঅর্ডার লেভেলে নেমেছে, গুদাম ধরে ধরে',
+    columns: {
+      product: 'প্রোডাক্ট',
+      warehouse: 'গুদাম',
+      onHand: 'হাতে আছে',
+      inTransit: 'পথে আছে',
+      level: 'রিঅর্ডার লেভেল',
+      order: 'অর্ডার',
+    },
+    emptyTitle: 'অর্ডার করার কিছু নেই',
+    emptyBody: 'প্রোডাক্টের স্টক পেজে রিঅর্ডার লেভেল দিন। স্টক সেখানে নামলে এখানে দেখাবে।',
+    loadFailed: 'রিঅর্ডারের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   yearEnd: {
     title: 'বছর শেষের ক্লোজিং',
     description: 'প্রতিটা বছরের লাভ রিটেইনড আর্নিংসে নিন আর সেই বছরের তারিখগুলো বন্ধ করুন',
@@ -963,7 +1261,14 @@ export const bn: Messages = {
       report: { read: 'রিপোর্ট দেখা আর এক্সপোর্ট করা' },
     },
     inventory: {
-      product: { manage: 'প্রোডাক্ট, তার ক্যাটাগরি আর ইউনিট যোগ, বদল আর ইমপোর্ট' },
+      product: {
+        manage: 'প্রোডাক্ট, তার ক্যাটাগরি আর ইউনিট যোগ, বদল আর ইমপোর্ট, আর রিঅর্ডার লেভেল ঠিক করা',
+      },
+      warehouse: { manage: 'গুদাম যোগ, বদল আর আর্কাইভ' },
+      stock: {
+        adjust: 'স্টক অ্যাডজাস্টমেন্ট আর ওপেনিং স্টক লেখা ও পোস্ট করা',
+        transfer: 'অন্য গুদামে স্টক পাঠানো আর গ্রহণ করা',
+      },
     },
   },
   invite: {
@@ -1006,6 +1311,10 @@ export const bn: Messages = {
       custom_field: 'কাস্টম ফিল্ড',
       product: 'প্রোডাক্ট',
       product_import: 'প্রোডাক্ট ইমপোর্ট',
+      warehouse: 'গুদাম',
+      stock_adjustment: 'স্টক অ্যাডজাস্টমেন্ট',
+      stock_transfer: 'স্টক ট্রান্সফার',
+      reorder_level: 'রিঅর্ডার লেভেল',
     },
     columns: {
       when: 'কখন',
@@ -1096,6 +1405,26 @@ export const bn: Messages = {
         deleted: 'একটা প্রোডাক্ট মুছেছেন',
         imported: 'ফাইল থেকে প্রোডাক্ট ইমপোর্ট করেছেন',
       },
+      warehouse: {
+        created: 'একটা গুদাম যোগ করেছেন',
+        updated: 'একটা গুদাম বদলেছেন',
+        archived: 'একটা গুদাম আর্কাইভ করেছেন',
+        restored: 'একটা গুদাম ফিরিয়ে এনেছেন',
+      },
+      stock_adjustment: {
+        created: 'একটা স্টক অ্যাডজাস্টমেন্ট লিখেছেন',
+        updated: 'একটা খসড়া অ্যাডজাস্টমেন্ট বদলেছেন',
+        deleted: 'একটা খসড়া অ্যাডজাস্টমেন্ট মুছেছেন',
+        posted: 'একটা স্টক অ্যাডজাস্টমেন্ট পোস্ট করেছেন',
+      },
+      stock_transfer: {
+        created: 'একটা স্টক ট্রান্সফার লিখেছেন',
+        updated: 'একটা খসড়া ট্রান্সফার বদলেছেন',
+        deleted: 'একটা খসড়া ট্রান্সফার মুছেছেন',
+        sent: 'একটা স্টক ট্রান্সফার পাঠিয়েছেন',
+        received: 'একটা স্টক ট্রান্সফার গ্রহণ করেছেন',
+      },
+      reorder_level: { changed: 'একটা রিঅর্ডার লেভেল বদলেছেন' },
     },
     fields: {
       name: 'নাম',
@@ -1147,6 +1476,16 @@ export const bn: Messages = {
       units: 'ইউনিট',
       categories: 'ক্যাটাগরি',
       customFields: 'কাস্টম ফিল্ড',
+      warehouse: 'গুদাম',
+      branch: 'ব্রাঞ্চ',
+      direction: 'দিক',
+      reason: 'কারণ',
+      from: 'থেকে',
+      to: 'যেখানে',
+      short: 'কম পৌঁছেছে',
+      min: 'রিঅর্ডার লেভেল',
+      reorder: 'অর্ডারের পরিমাণ',
+      allowNegativeStock: 'শূন্যের নিচে স্টক চলবে',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -1222,6 +1561,9 @@ export const bn: Messages = {
         done: '{{file}}: {{count}}টা প্রোডাক্ট ইমপোর্ট হয়েছে।',
         failed: '{{file}} ইমপোর্ট হয়নি: {{count}}টা সমস্যা ঠিক করতে হবে। কিছুই সেভ হয়নি।',
       },
+      stock: {
+        low: '{{warehouse}}: {{count}}টা আইটেম রিঅর্ডার লেভেলে নেমেছে। আবার অর্ডার করার সময়।',
+      },
     },
   },
   errors: {
@@ -1394,6 +1736,53 @@ export const bn: Messages = {
     import_unit_unknown: '"{{value}}" নামে কোনো ইউনিট নেই। Units পেজের একটা কোড দিন।',
     import_category_invalid: 'ক্যাটাগরি পথ হিসেবে লিখুন, যেমন Fabrics > Knit।',
     import_value_invalid: 'এগুলোর একটা দিন: {{allowed}}।',
+    warehouse_code_format: '২ থেকে ১০টা বড় হাতের অক্ষর বা অঙ্ক দিন, যেমন FG বা CTG।',
+    warehouse_code_taken: 'এই কোড আরেকটা গুদামে আছে। অন্য একটা কোড দিন।',
+    warehouse_name_required: 'গুদামের নাম লিখুন।',
+    warehouse_branch_invalid: 'একটা চালু ব্রাঞ্চ বাছুন।',
+    warehouse_branch_locked:
+      'এই গুদামে স্টকের ইতিহাস আছে, তাই এটা নিজের ব্রাঞ্চেই থাকবে। বদলে নতুন একটা গুদাম যোগ করুন।',
+    warehouse_has_stock:
+      'এই গুদামে এখনো স্টক আছে। ট্রান্সফার বা অ্যাডজাস্টমেন্ট করে বের করুন, তারপর আর্কাইভ করুন।',
+    warehouse_has_transfers:
+      'এই গুদামে আসা বা যাওয়ার পথে স্টক আছে। আগে সেই ট্রান্সফারগুলো গ্রহণ করুন।',
+    branch_has_warehouses: 'আগে এই ব্রাঞ্চের গুদামগুলো আর্কাইভ করুন বা সরান।',
+    quantity_format: 'শূন্যের বেশি একটা সংখ্যা দিন, দশমিকের পরে সর্বোচ্চ ৪ ঘর।',
+    serial_number_format: 'সিরিয়াল নম্বরে অক্ষর, অঙ্ক আর ড্যাশ চলে — ফাঁকা জায়গা না।',
+    stock_date_required: 'তারিখ বাছুন।',
+    stock_date_future: 'যে দিন এখনো আসেনি সেদিন স্টক নড়তে পারে না। আজ বা তার আগের তারিখ দিন।',
+    stock_warehouse_invalid: 'একটা চালু গুদাম বাছুন।',
+    stock_lines_required: 'অন্তত একটা আইটেম যোগ করুন।',
+    stock_variant_required: 'একটা প্রোডাক্ট বাছুন।',
+    stock_variant_invalid:
+      'স্টকে রাখা হয় এমন একটা প্রোডাক্ট বাছুন। আর্কাইভ করা প্রোডাক্ট শুধু বের হতে পারে।',
+    stock_unit_invalid: 'বেস ইউনিট বা এই প্রোডাক্টের একটা প্যাক বাছুন।',
+    stock_quantity_decimals: 'এই ইউনিটে এত দশমিক চলে না। পূর্ণ সংখ্যা দিন।',
+    stock_lot_required: 'মালের গায়ে ছাপা লট নম্বর লিখুন।',
+    stock_expiry_required: 'এই লট নতুন: মেয়াদ শেষের তারিখ দিন।',
+    stock_batch_dates: 'মেয়াদ শেষের তারিখ তৈরির তারিখের পরে হতে হবে।',
+    stock_batch_required: 'কোন ব্যাচ থেকে মাল যাচ্ছে সেটা বাছুন।',
+    stock_batch_invalid: 'এই প্রোডাক্টের একটা ব্যাচ বাছুন।',
+    stock_batch_expiry_mismatch:
+      'এই লটের অন্য একটা মেয়াদ আগেই আছে। লট নম্বরটা মিলিয়ে দেখুন, বা তারিখের ঘর খালি রাখুন।',
+    stock_serial_count: 'প্রতিটা আইটেমের জন্য একটা করে সিরিয়াল নম্বর দিন।',
+    stock_serial_twice: 'এই সিরিয়াল নম্বর দুবার লেখা হয়েছে।',
+    stock_serial_in_stock: 'এর মধ্যে একটা সিরিয়াল নম্বর আগে থেকেই স্টকে আছে।',
+    stock_serial_not_here: 'এর মধ্যে একটা সিরিয়াল নম্বর এই গুদামে নেই।',
+    stock_insufficient: 'এখানে যথেষ্ট স্টক নেই। পরিমাণ কমান বা অন্য ব্যাচ বাছুন।',
+    stock_not_draft: 'শুধু খসড়া বদলানো যায়। ঠিক করতে আরেকটা ডকুমেন্ট পোস্ট করুন।',
+    adjustment_reason_direction: 'এই কারণ এই দিকের সাথে মেলে না। অন্য কারণ বাছুন।',
+    transfer_same_warehouse: 'পাঠানোর জন্য অন্য একটা গুদাম বাছুন।',
+    transfer_not_in_transit: 'এই ট্রান্সফার আর পথে নেই। পেজটা রিলোড করুন।',
+    transfer_lines_mismatch: 'ট্রান্সফারের প্রতিটা লাইন গ্রহণ করুন।',
+    transfer_receive_too_many: 'যা পাঠানো হয়েছিল তার চেয়ে বেশি। আসলে যা পৌঁছেছে সেটা লিখুন।',
+    transfer_receive_date: 'পাঠানোর দিনের আগে পৌঁছাতে পারে না।',
+    transfer_serial_not_sent: 'এই সিরিয়াল নম্বর এই ট্রান্সফারে পাঠানো হয়নি।',
+    reorder_level_required: 'অর্ডারের পরিমাণের আগে রিঅর্ডার লেভেল দিন।',
+    product_base_unit_locked:
+      'এই প্রোডাক্টের স্টক আছে, তাই বেস ইউনিট বদলাবে না। অন্য ইউনিটের জন্য একটা প্যাক যোগ করুন।',
+    product_tracking_locked: 'এই প্রোডাক্টের স্টক আছে, তাই ট্র্যাকিং যেমন আছে তেমন থাকবে।',
+    product_type_locked: 'এই প্রোডাক্টের স্টক আছে, তাই এটা পণ্যই থাকবে।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
```

- **`lineCount_one` / `lineCount_other`, `daysLeft_one` / `daysLeft_other`**: i18next picks the plural form from
  `count`. Bangla has one form; both keys exist because `bn` must have exactly the keys of `en`.
- **`notifications.types.stock.low`** — the bell builds its key from the notification's type, so the type's dot
  becomes the nesting here, like `import.done`.
- **The error texts say how to fix the problem**, never just "invalid": "Not enough stock here. Lower the quantity
  or pick another batch."

---

## 13.7 — `packages/ui`: `KpiStrip` and `controlBoxClass`

`packages/ui/src/components/kpi-strip.tsx`:

```tsx
import { Card } from './card.js';

interface KpiStripProps {
  cells: readonly { label: string; value: string; sub?: string | undefined }[];
}

// CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line.
// Moved here from the app's report-parts.tsx in step 13: the stock card uses it too, and importing
// it from the reports' file pulled the reports' code into the stock card's chunk.
export function KpiStrip({ cells }: KpiStripProps) {
  return (
    <Card className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      {cells.map((cell) => (
        <div key={cell.label} className="grid gap-1 px-5 py-4">
          <span className="text-caption text-ink-3">{cell.label}</span>
          <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
          {cell.sub !== undefined && (
            <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
          )}
        </div>
      ))}
    </Card>
  );
}
```

`packages/ui/src/index.ts` (changed):

```diff
@@ -28,6 +28,7 @@ export {
 } from './components/dropdown-menu.js';
 export { EmptyState } from './components/empty-state.js';
 export {
+  controlBoxClass,
   Field,
   Input,
   Select,
@@ -43,6 +44,7 @@ export {
 } from './components/field.js';
 export { FormAlert } from './components/form-alert.js';
 export { FormField, type FormFieldControlProps } from './components/form-field.js';
+export { KpiStrip } from './components/kpi-strip.js';
 export { Logo } from './components/logo.js';
 export { MoneyInput } from './components/money-input.js';
 export { PageHeader, SectionHeader } from './components/page-header.js';
```

`KpiStrip` was in the app's `components/report-parts.tsx`. The stock card imported it from there and pulled the
reports' code into its own chunk (100.7 KB, over the 100 KB budget). It is a design-system component (CLAUDE.md →
KPI strip), so it belongs in `@omnivo/ui`. `controlBoxClass` is the input box's look, now used by the serial number
box (13.8).

---

## 13.8 — `apps/app`: the stock pages

### Data and helpers

`apps/app/src/lib/queries.ts` (changed):

```diff
@@ -7,7 +7,11 @@ import {
   type ProductStatus,
   type ProfitAndLossQuery,
   routes,
+  type StockDocumentStatus,
+  type StockFilter,
+  type TransferStatus,
   type TrialBalanceQuery,
+  type WarehouseStatus,
 } from '@omnivo/contracts';
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
 
@@ -305,3 +309,183 @@ export function productImportQuery(tenantId: string, importId: string) {
     queryFn: () => call(routes.productImports.get, { params: { id: importId } }),
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// Warehouses and stock (step 13). Every stock query starts with ['stock', tenantId]: posting an
+// adjustment or a transfer changes the stock list, the cards, the reports and the documents, and
+// one invalidate refreshes them all.
+
+// The warehouses page lists them; every stock page and form picks from them
+export function warehousesQuery(tenantId: string, status: WarehouseStatus) {
+  return queryOptions({
+    queryKey: ['warehouses', tenantId, status],
+    queryFn: async () => (await call(routes.warehouses.list, { query: { status } })).items,
+  });
+}
+
+export interface StockListFilter {
+  search: string;
+  warehouseId: string;
+  categoryId: string;
+  filter: StockFilter;
+}
+
+export function stockListQuery(tenantId: string, filter: StockListFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'list', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stock.list, {
+        query: {
+          limit: 50,
+          filter: filter.filter,
+          ...(filter.search !== '' && { search: filter.search }),
+          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(filter.categoryId !== '' && { categoryId: filter.categoryId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// The "Add items" search of a document form: the first 20 matches, with the stock in the form's
+// warehouse
+export function stockSearchQuery(tenantId: string, search: string, warehouseId: string) {
+  return queryOptions({
+    queryKey: ['stock', tenantId, 'search', warehouseId, search],
+    queryFn: async () =>
+      (
+        await call(routes.stock.list, {
+          query: {
+            limit: 20,
+            filter: 'all',
+            ...(search !== '' && { search }),
+            ...(warehouseId !== '' && { warehouseId }),
+          },
+        })
+      ).items,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function stockCardQuery(tenantId: string, variantId: string) {
+  return queryOptions({
+    queryKey: ['stock', tenantId, 'card', variantId],
+    queryFn: () => call(routes.stock.card, { params: { id: variantId } }),
+    retry: false,
+  });
+}
+
+export function stockMovementsQuery(
+  tenantId: string,
+  variantId: string,
+  filter: { warehouseId: string; from: string; to: string },
+) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'movements', variantId, filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stock.movements, {
+        params: { id: variantId },
+        query: {
+          limit: 100,
+          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(filter.from !== '' && { from: filter.from }),
+          ...(filter.to !== '' && { to: filter.to }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function batchStockQuery(
+  tenantId: string,
+  filter: { warehouseId: string; expiresWithin: number | null },
+) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'batches', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stock.batches, {
+        query: {
+          limit: 100,
+          ...(filter.warehouseId !== '' && { warehouseId: filter.warehouseId }),
+          ...(filter.expiresWithin !== null && { expiresWithin: filter.expiresWithin }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function reorderQuery(tenantId: string, warehouseId: string) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'reorder', warehouseId],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stock.reorder, {
+        query: {
+          limit: 100,
+          ...(warehouseId !== '' && { warehouseId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function stockAdjustmentsQuery(tenantId: string, status: StockDocumentStatus | undefined) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'adjustments', status ?? 'all'],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stockAdjustments.list, {
+        query: {
+          limit: 50,
+          ...(status !== undefined && { status }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function stockAdjustmentQuery(tenantId: string, adjustmentId: string) {
+  return queryOptions({
+    queryKey: ['stock', tenantId, 'adjustment', adjustmentId],
+    queryFn: () => call(routes.stockAdjustments.get, { params: { id: adjustmentId } }),
+    retry: false,
+  });
+}
+
+export function stockTransfersQuery(tenantId: string, status: TransferStatus | undefined) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'transfers', status ?? 'all'],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stockTransfers.list, {
+        query: {
+          limit: 50,
+          ...(status !== undefined && { status }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function stockTransferQuery(tenantId: string, transferId: string) {
+  return queryOptions({
+    queryKey: ['stock', tenantId, 'transfer', transferId],
+    queryFn: () => call(routes.stockTransfers.get, { params: { id: transferId } }),
+    retry: false,
+  });
+}
```

- **Every stock query starts with `['stock', tenantId]`**, so posting anything invalidates the list, the cards, the
  reports and the documents in one call (`useStockRefresh()`). Warehouses have their own prefix: they change on
  their own page.
- **`stockSearchQuery`** is the picker's: the first 20 matches, with the stock of the form's warehouse.

`apps/app/src/lib/stock.ts`:

```ts
import {
  compareQuantity,
  isQuantity,
  plainQuantity,
  subtractQuantity,
  toBaseQuantity,
  type Unit,
} from '@omnivo/contracts';
import type { SelectOption } from '@omnivo/ui';

import { plainFactor } from './products';

// The pure parts of the stock pages: no React, so they are unit-tested (stock.spec.ts) and shared
// by the forms and the views.

// "Polo shirt · M / Navy" — a simple product is just its name
export function variantName(ref: { productName: string; optionValues: readonly string[] }): string {
  return ref.optionValues.length === 0
    ? ref.productName
    : `${ref.productName} · ${ref.optionValues.join(' / ')}`;
}

// The units a line can be counted in: the base unit, then the product's packs with their size —
// "case = 24 pcs". The base unit's code is the same in every language, like the units page shows it.
export function unitChoices(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  units: readonly Unit[],
): SelectOption[] {
  const code = (id: string) => units.find((unit) => unit.id === id)?.code ?? '?';
  return [
    { value: item.baseUnitId, label: code(item.baseUnitId) },
    ...item.units.map((pack) => ({
      value: pack.unitId,
      label: `${code(pack.unitId)} = ${plainFactor(pack.factor)} ${code(item.baseUnitId)}`,
    })),
  ];
}

// What a line typed in a pack is in the base unit, the way the server will count it; null while
// the quantity is not a quantity yet, or the line is already in the base unit (nothing to show)
export function basePreview(
  item: { baseUnitId: string; units: readonly { unitId: string; factor: string }[] },
  unitId: string,
  quantity: string,
  units: readonly Unit[],
): string | null {
  if (unitId === item.baseUnitId || !isQuantity(quantity.trim())) return null;
  const pack = item.units.find((candidate) => candidate.unitId === unitId);
  const decimals = units.find((unit) => unit.id === item.baseUnitId)?.decimals;
  if (!pack || decimals === undefined) return null;
  return toBaseQuantity(quantity.trim(), pack.factor, decimals);
}

// First expiry, first out: how much of each batch to take for `wanted`, from the batch that
// expires first. The batches come from the stock card already in that order. What is left over
// (not enough in all batches together) is returned too, so the form can say so.
export function fefoSplit(
  batches: readonly { batchId: string; quantity: string }[],
  wanted: string,
): { picks: { batchId: string; quantity: string }[]; missing: string } {
  const picks: { batchId: string; quantity: string }[] = [];
  let left = wanted;
  for (const batch of batches) {
    if (compareQuantity(left, '0') <= 0) break;
    if (compareQuantity(batch.quantity, '0') <= 0) continue;
    const take = compareQuantity(batch.quantity, left) >= 0 ? left : batch.quantity;
    picks.push({ batchId: batch.batchId, quantity: plainQuantity(take) });
    left = subtractQuantity(left, take);
  }
  return { picks, missing: compareQuantity(left, '0') > 0 ? left : '0.0000' };
}

// Whole days from `today` to `iso` (both ISO dates): negative once expired. Counted on UTC dates,
// so no time zone and no summer time can make a day 23 hours long.
export function daysUntil(iso: string, today: string): number {
  const day = (value: string) =>
    Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return Math.round((day(iso) - day(today)) / 86_400_000);
}

export type ExpiryTone = 'crit' | 'warn' | 'neutral';

// Expired is a problem; within a month is a warning (time to sell it or send it back to the
// principal); later is just a date
export function expiryTone(expiresOn: string | null, today: string): ExpiryTone {
  if (expiresOn === null) return 'neutral';
  const days = daysUntil(expiresOn, today);
  if (days < 0) return 'crit';
  return days <= 30 ? 'warn' : 'neutral';
}

// The serial number box: one per line (a scanner ends each with Enter), commas and spaces work too
export function parseSerials(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((serial) => serial.trim())
    .filter((serial) => serial !== '');
}

// The routes a stock card's row links to, by its kind (unknown kinds from a newer server: none)
export function documentRoute(
  kind: string,
): '/stock/adjustments/$adjustmentId' | '/stock/transfers/$transferId' | null {
  if (kind === 'adjustment') return '/stock/adjustments/$adjustmentId';
  if (kind === 'transfer_out' || kind === 'transfer_in') return '/stock/transfers/$transferId';
  return null;
}

// The first error message inside a form error, however deep: a line's serial numbers keep one
// error per number (lines.0.serialNumbers.3), the form shows the first under the box. unknown in,
// narrowed here: react-hook-form's error types differ per form, this works for every one of them.
export function firstMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('message' in error && typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }
  for (const value of Object.values(error)) {
    // `ref` is the input element itself; never walk into the DOM
    if (value instanceof Object && !('nodeType' in value)) {
      const found = firstMessage(value);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// "lines.2.serialNumbers.1": where the server puts an error about one serial number. The cast
// only narrows a string built from two numbers to the template type it is (like rowPath).
export function serialPath(
  index: number,
  serial: number,
): `lines.${number}.serialNumbers.${number}` {
  return `lines.${String(index)}.serialNumbers.${String(serial)}` as `lines.${number}.serialNumbers.${number}`;
}
```

- **`basePreview()`** calls the contract's `toBaseQuantity()`: the "= 72 pcs" under a line is computed exactly the
  way the server will compute it.
- **`fefoSplit()`** takes from the batch that expires first, as much as it holds, then the next; what is left over
  is returned so the form can say "only 160 in all batches here".
- **`daysUntil()`** works on UTC dates built from the ISO parts: no time zone and no summer time can make a day 23
  hours long.
- **`firstMessage()`** takes `unknown` on purpose: each form's react-hook-form error type is different, and a
  serial line keeps one error per serial number (`lines.0.serialNumbers.3`). Narrowing `unknown` with `in` checks
  needs no cast. It skips DOM nodes (`ref`), which are objects too.
- **`serialPath()`** has one cast, like `rowPath()` in `lib/products.ts`: the string is built from two numbers, and
  TypeScript cannot see that `String(n)` gives a `${number}`.

`apps/app/src/lib/stock.spec.ts`:

```ts
import type { Unit } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  basePreview,
  daysUntil,
  documentRoute,
  expiryTone,
  fefoSplit,
  firstMessage,
  parseSerials,
  unitChoices,
  variantName,
} from './stock';

function unit(id: string, code: string, decimals = 0): Unit {
  return {
    id,
    code,
    name: code,
    dimension: 'count',
    ratio: null,
    decimals,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const UNITS = [
  unit('pcs', 'pcs'),
  unit('case', 'case'),
  unit('m', 'm', 2),
  unit('yard', 'yard', 2),
];
const juice = { baseUnitId: 'pcs', units: [{ unitId: 'case', factor: '24.000000' }] };

describe('stock helpers', () => {
  it('names a variant by its product and values', () => {
    expect(variantName({ productName: 'Napa 500 mg', optionValues: [] })).toBe('Napa 500 mg');
    expect(variantName({ productName: 'Polo shirt', optionValues: ['M', 'Navy'] })).toBe(
      'Polo shirt · M / Navy',
    );
  });

  it('offers the base unit and each pack with its size', () => {
    expect(unitChoices(juice, UNITS)).toEqual([
      { value: 'pcs', label: 'pcs' },
      { value: 'case', label: 'case = 24 pcs' },
    ]);
  });

  it('shows a pack in base units, rounded like the server', () => {
    expect(basePreview(juice, 'case', '3', UNITS)).toBe('72.0000');
    expect(basePreview(juice, 'pcs', '3', UNITS)).toBeNull();
    expect(basePreview(juice, 'case', '', UNITS)).toBeNull();
    const fabric = { baseUnitId: 'm', units: [{ unitId: 'yard', factor: '0.914400' }] };
    expect(basePreview(fabric, 'yard', '3', UNITS)).toBe('2.7400');
  });

  it('takes from the batch that expires first, then the next', () => {
    const batches = [
      { batchId: 'NP24090', quantity: '40.0000' },
      { batchId: 'NP24117', quantity: '120.0000' },
    ];
    expect(fefoSplit(batches, '30')).toEqual({
      picks: [{ batchId: 'NP24090', quantity: '30' }],
      missing: '0.0000',
    });
    expect(fefoSplit(batches, '100')).toEqual({
      picks: [
        { batchId: 'NP24090', quantity: '40' },
        { batchId: 'NP24117', quantity: '60' },
      ],
      missing: '0.0000',
    });
    expect(fefoSplit(batches, '200').missing).toBe('40.0000');
  });

  it('counts days to an expiry and colours it', () => {
    expect(daysUntil('2026-10-31', '2026-10-01')).toBe(30);
    expect(daysUntil('2026-09-30', '2026-10-01')).toBe(-1);
    expect(expiryTone('2026-09-30', '2026-10-01')).toBe('crit');
    expect(expiryTone('2026-10-31', '2026-10-01')).toBe('warn');
    expect(expiryTone('2027-06-30', '2026-10-01')).toBe('neutral');
    expect(expiryTone(null, '2026-10-01')).toBe('neutral');
  });

  it('reads serial numbers one per line, or separated by commas', () => {
    expect(parseSerials('356938035643809\n356938035643817\n\n')).toEqual([
      '356938035643809',
      '356938035643817',
    ]);
    expect(parseSerials(' SN-1, SN-2 ;SN-3 ')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });

  it('links a movement to its document', () => {
    expect(documentRoute('adjustment')).toBe('/stock/adjustments/$adjustmentId');
    expect(documentRoute('transfer_in')).toBe('/stock/transfers/$transferId');
    expect(documentRoute('sales_delivery')).toBeNull();
  });
});

describe('form errors', () => {
  it('finds the first message, even inside a list of serial numbers', () => {
    expect(firstMessage({ message: 'stock_serial_count' })).toBe('stock_serial_count');
    expect(firstMessage([undefined, { message: 'stock_serial_twice' }])).toBe('stock_serial_twice');
    expect(firstMessage(undefined)).toBeUndefined();
  });
});
```

`apps/app/src/lib/use-debounced.ts`:

```ts
import { useEffect, useState } from 'react';

// What the person typed, a moment after they stop: one request per word, not per key. Moved here
// from routes/products.tsx in step 13: the stock pages and the item picker search the same way.
export function useDebounced(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}
```

`apps/app/src/routes/products.tsx` (changed):

```diff
@@ -26,12 +26,13 @@ import {
 } from '@omnivo/ui';
 import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import { useCallback, useEffect, useMemo, useState } from 'react';
+import { useCallback, useMemo, useState } from 'react';
 
 import { useCan } from '../lib/permissions';
 import { categoryOptions, categoryPath } from '../lib/products';
 import { productCategoriesQuery, productListQuery, unitsQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
+import { useDebounced } from '../lib/use-debounced';
 
 const column = dataTableColumns<ProductSummary>();
 
@@ -43,20 +44,6 @@ function sortOf(state: SortingState): ProductSort {
   return 'name';
 }
 
-// What the person typed, a moment after they stop: one request per word, not per key
-function useDebounced(value: string, ms = 300): string {
-  const [settled, setSettled] = useState(value);
-  useEffect(() => {
-    const timer = setTimeout(() => {
-      setSettled(value);
-    }, ms);
-    return () => {
-      clearTimeout(timer);
-    };
-  }, [value, ms]);
-  return settled;
-}
-
 export function ProductsPage() {
   const { t, format } = useLocale();
   const navigate = useNavigate();
```

`apps/app/src/lib/settings-form.ts` (changed):

```diff
@@ -21,5 +21,6 @@ export function settingsToForm(settings: Settings): SettingsFormValues {
     baseCurrency: settings.baseCurrency,
     fiscalYearStartMonth: settings.fiscalYearStartMonth,
     timezone: settings.timezone,
+    allowNegativeStock: settings.allowNegativeStock,
   };
 }
```

### Shared components

`apps/app/src/components/stock-parts.tsx`:

```tsx
import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  DeliveryTruck01Icon,
  FileEditIcon,
  HourglassIcon,
  PackageDeliveredIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  todayIn,
  type StockDocumentStatus,
  type TransferStatus,
  type VariantRef,
  type Warehouse,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { parseIsoDate, Pill } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { settingsQuery, unitsQuery, warehousesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { daysUntil, expiryTone, variantName } from '../lib/stock';

// Shared by the stock pages and forms. Here, not in a route file: a route file is its own lazy
// chunk, and importing from one would pull that whole page into the others.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// "72 pcs", "2.74 m": a quantity with its unit's decimals and code, in the reader's digits. The
// units are a small list every product page already loaded.
export function useQuantity(): (value: string, unitId: string) => string {
  const { format } = useLocale();
  const units = useQuery(unitsQuery(useTenantId())).data;
  return useCallback(
    (value: string, unitId: string) => {
      const unit = units?.find((candidate) => candidate.id === unitId);
      return unit === undefined
        ? format.number(value, 0)
        : `${format.number(value, unit.decimals)} ${unit.code}`;
    },
    [units, format],
  );
}

// Every warehouse, archived ones too (old documents point at them), by id; and the active ones,
// for the forms' selects
export function useWarehouses(): {
  active: Warehouse[] | undefined;
  byId: Map<string, Warehouse>;
} {
  const tenantId = useTenantId();
  const active = useQuery(warehousesQuery(tenantId, 'active')).data;
  const archived = useQuery(warehousesQuery(tenantId, 'archived')).data;
  const byId = useMemo(
    () => new Map([...(active ?? []), ...(archived ?? [])].map((place) => [place.id, place])),
    [active, archived],
  );
  return { active, byId };
}

export function warehouseLabel(place: Warehouse | undefined): string {
  return place === undefined ? '—' : `${place.code} · ${place.name}`;
}

// "Today" in the company's time zone: the forms' default date, and the expiry countdown
export function useToday(): string {
  const timeZone =
    useQuery(settingsQuery(useTenantId())).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  return todayIn(timeZone);
}

// After a posting: everything under ['stock', tenant] — the list, the cards, the reports and the
// documents — is fetched again
export function useStockRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
    [queryClient, tenantId],
  );
}

// A variant in a table: the product's name and values, and the code and SKU underneath
export function VariantCell({ item }: { item: VariantRef }) {
  return (
    <span className="grid max-w-[24rem] min-w-0">
      <span className="truncate font-medium text-ink">{variantName(item)}</span>
      <span className="truncate font-mono text-caption text-ink-3">{item.sku}</span>
    </span>
  );
}

export function AdjustmentStatusPill({ status }: { status: StockDocumentStatus }) {
  const { t } = useLocale();
  return status === 'draft' ? (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('adjustments.statuses.draft')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('adjustments.statuses.posted')}
    </Pill>
  );
}

// Draft, In transit (still on the road: attention), Received — and a separate "Short" pill when
// less arrived than was sent
export function TransferStatusPills({
  transfer,
}: {
  transfer: { status: TransferStatus; short: boolean };
}) {
  const { t } = useLocale();
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {transfer.status === 'draft' && (
        <Pill tone="neutral" icon={FileEditIcon}>
          {t('transfers.statuses.draft')}
        </Pill>
      )}
      {transfer.status === 'in_transit' && (
        <Pill tone="warn" icon={DeliveryTruck01Icon}>
          {t('transfers.statuses.in_transit')}
        </Pill>
      )}
      {transfer.status === 'received' && (
        <Pill tone="good" icon={PackageDeliveredIcon}>
          {t('transfers.statuses.received')}
        </Pill>
      )}
      {transfer.short && (
        <Pill tone="crit" icon={Alert02Icon}>
          {t('transfers.shortPill')}
        </Pill>
      )}
    </span>
  );
}

// Expired (crit), a month or less left (warn), or just the date. Never colour alone.
export function ExpiryPill({ expiresOn, today }: { expiresOn: string | null; today: string }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  if (expiresOn === null) {
    return <span className="text-ink-3">{t('expiry.noExpiry')}</span>;
  }
  const tone = expiryTone(expiresOn, today);
  if (tone === 'neutral') return <span className="tabular-nums">{isoDate(expiresOn)}</span>;
  const days = daysUntil(expiresOn, today);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular-nums">{isoDate(expiresOn)}</span>
      <Pill tone={tone} icon={HourglassIcon}>
        {days < 0 ? t('expiry.expired') : t('expiry.daysLeft', { count: days })}
      </Pill>
    </span>
  );
}

// "23 Sep 2026" from "2026-09-23", read with local date parts, never as UTC (the journal's helper,
// again here so the stock chunks do not load the journal's parts)
export function useIsoDate(): (iso: string) => string {
  const { format } = useLocale();
  return useCallback(
    (iso: string) => {
      const date = parseIsoDate(iso);
      return date ? format.date(date) : iso;
    },
    [format],
  );
}

export function BackLink({
  to,
  label,
}: {
  to: '/stock' | '/stock/adjustments' | '/stock/transfers';
  label: string;
}) {
  return (
    <Link
      to={to}
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {label}
    </Link>
  );
}
```

- **`useQuantity()`** formats with the unit's own decimals and code ("2.74 m", "72 pcs"), in the reader's digits.
- **`useWarehouses()`** keeps archived ones in `byId`: an old document must still show where its stock went.
- **`TransferStatusPills`** shows "Short" as its own crit pill next to the status: "Received" and "Short" are both
  true at once.
- **`ExpiryPill`**: expired = crit, 30 days or less = warn, later = just the date. Always icon and word.

`apps/app/src/components/serial-numbers-input.tsx`:

```tsx
import { controlBoxClass } from '@omnivo/ui';
import { type Ref, useState } from 'react';

import { parseSerials } from '../lib/stock';

interface SerialNumbersInputProps {
  id: string;
  name?: string;
  // The form keeps a list; the box shows one serial number per line
  value: readonly string[];
  onChange: (value: string[]) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLTextAreaElement>;
  invalid?: boolean;
  'aria-describedby'?: string | undefined;
}

// The serial numbers of a line: a scanner types an IMEI and Enter, so one per line is how they
// arrive. While the box has focus it keeps exactly what was typed (a half-typed number, a trailing
// Enter); the form gets the cleaned list on every key, like MoneyInput does with amounts.
export function SerialNumbersInput({
  id,
  name,
  value,
  onChange,
  onBlur,
  ref,
  invalid = false,
  'aria-describedby': describedBy,
}: SerialNumbersInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={`${controlBoxClass(invalid)} items-stretch`}>
      <textarea
        ref={ref}
        id={id}
        name={name}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="min-w-0 flex-1 resize-y bg-transparent py-2.5 font-mono text-body-sm outline-none"
        value={draft ?? value.join('\n')}
        onFocus={() => {
          setDraft(value.join('\n'));
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(parseSerials(event.target.value));
        }}
        onBlur={() => {
          setDraft(null);
          onBlur?.();
        }}
      />
    </div>
  );
}
```

A scanner types an IMEI and Enter. While the box has focus it keeps exactly what was typed (a half-typed number, a
trailing new line); the form gets the cleaned list on every key. Rebuilding the text from the list on every key
would swallow the Enter and jump the cursor — `MoneyInput` keeps a draft for the same reason.

`apps/app/src/components/item-picker.tsx`:

```tsx
import {
  PackageSearchIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { StockItem } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogContent, EmptyState, Input, Pill } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { stockSearchQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';
import { useQuantity, useTenantId, VariantCell } from './stock-parts';

// "Add items": search or scan, then one click per line. The dialog stays open, so a store keeper
// scans carton after carton without reaching for the mouse; Enter adds the only match (a scanner
// ends a barcode with Enter). The stock shown is the form's warehouse's.
export function ItemPicker({
  warehouseId,
  // A line that brings stock in cannot be an archived product (the API refuses it): those show,
  // but cannot be added
  allowArchived,
  onAdd,
}: {
  warehouseId: string;
  allowArchived: boolean;
  onAdd: (item: StockItem) => void;
}) {
  const { t } = useLocale();
  const quantity = useQuantity();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const { data: items, isFetching } = useQuery(
    stockSearchQuery(useTenantId(), settled, warehouseId),
  );

  const add = (item: StockItem) => {
    onAdd(item);
    setAdded((before) => new Set(before).add(item.variantId));
  };
  const usable = (item: StockItem) => allowArchived || !item.archived;

  return (
    <DialogContent
      title={t('stockLines.pickerTitle')}
      description={t('stockLines.pickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('stockLines.pickerSearch')}
          placeholder={t('stock.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            // Only when the list is the answer to what is in the box now, and it is one item
            const [only, ...rest] = items ?? [];
            if (
              settled === search.trim() &&
              !isFetching &&
              only &&
              rest.length === 0 &&
              usable(only)
            ) {
              add(only);
              setSearch('');
            }
          }}
        />
        {items?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t('stockLines.pickerEmpty')}
            description={t('stock.noMatchBody')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {items?.map((item) => (
              <li
                key={item.variantId}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="min-w-0 flex-1">
                  <VariantCell item={item} />
                  <span className="text-caption text-ink-3 tabular-nums">
                    {t('stockLines.inStock', { quantity: quantity(item.onHand, item.baseUnitId) })}
                  </span>
                </span>
                {item.archived && (
                  <Pill tone="neutral" icon={PackageSearchIcon}>
                    {t('stockLines.archived')}
                  </Pill>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!usable(item)}
                  onClick={() => {
                    add(item);
                  }}
                >
                  <HugeiconsIcon
                    icon={added.has(item.variantId) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(item.variantId) ? t('stockLines.added') : t('stockLines.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
```

- **Enter adds the only match** — but only when the list answers what is in the box *now* (`settled === search` and
  not fetching). Otherwise a fast scanner's Enter would add the result of the previous search.
- **The dialog stays open**: carton after carton, without the mouse.

`apps/app/src/components/stock-line-row.tsx`:

```tsx
import { Delete02Icon, Layers01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { plainQuantity, type StockItem, type StockLine } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn, IconButton, Input, Select } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { stockCardQuery, unitsQuery } from '../lib/queries';
import { basePreview, unitChoices } from '../lib/stock';
import { LineField } from './journal-parts';
import { useIsoDate, useQuantity, useTenantId, VariantCell } from './stock-parts';

// What a line needs to know about its variant, from the picker (StockItem) or a saved line
// (StockLine): both carry these fields
export type LineItem = Pick<
  StockItem,
  | 'variantId'
  | 'productId'
  | 'productCode'
  | 'productName'
  | 'optionValues'
  | 'sku'
  | 'baseUnitId'
  | 'tracking'
  | 'hasExpiry'
  | 'units'
>;

export function toLineItem(source: StockItem | StockLine): LineItem {
  return {
    variantId: source.variantId,
    productId: source.productId,
    productCode: source.productCode,
    productName: source.productName,
    optionValues: source.optionValues,
    sku: source.sku,
    baseUnitId: source.baseUnitId,
    tracking: source.tracking,
    hasExpiry: source.hasExpiry,
    units: source.units,
  };
}

// One template for every row, so the columns line up on a wide card: the item, the unit, the
// quantity, what the tracking asks for, and the remove button. A container query (@3xl), not a
// screen one, like the journal's lines: the sidebar takes room the screen width does not show.
const COLUMNS =
  '@3xl:grid-cols-[minmax(0,2fr)_8.5rem_9rem_minmax(0,1.8fr)_2.25rem] @3xl:items-start';

// The column headers of a wide card. Hidden from screen readers: each control has its own
// (sr-only) label there, which reads better than a header far away.
export function StockLinesHeader() {
  const { t } = useLocale();
  return (
    <div
      aria-hidden="true"
      className={cn(
        'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
        COLUMNS,
      )}
    >
      <span>{t('stockLines.items')}</span>
      <span>{t('stockLines.unit')}</span>
      <span className="text-right">{t('stockLines.quantity')}</span>
      <span>{t('stock.history.detail')}</span>
    </div>
  );
}

export interface LineErrors {
  unitId?: string | undefined;
  quantity?: string | undefined;
  batchId?: string | undefined;
  lotNumber?: string | undefined;
}

// One line of an adjustment or a transfer. It holds no form state of its own: the form passes its
// registered inputs (unit, quantity, batch, lot) and renders the controlled ones (dates, serial
// numbers) itself, so the same row works in both forms, each with its own types.
export function StockLineRow({
  index,
  item,
  mode,
  warehouseId,
  unitId,
  quantity,
  fields,
  dates,
  serials,
  errors,
  onRemove,
  onSplit,
}: {
  index: number;
  item: LineItem;
  // in: a lot is typed (it becomes a batch when posted); out: an existing batch is picked
  mode: 'in' | 'out';
  warehouseId: string;
  // The line's current unit and quantity, for the "= 72 pcs" under the box
  unitId: string;
  quantity: string;
  fields: {
    unitId: UseFormRegisterReturn;
    quantity: UseFormRegisterReturn;
    batchId: UseFormRegisterReturn;
    lotNumber?: UseFormRegisterReturn | undefined;
  };
  // The expiry and manufacturing dates of an "in" batch line, already in their LineFields
  dates?: ReactNode;
  // The serial number box of a serial line, already in its LineField
  serials?: ReactNode;
  errors: LineErrors;
  onRemove: () => void;
  onSplit: (batches: readonly { batchId: string; quantity: string }[]) => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  // The variant's stock card: what is here, and in which batches (FEFO order)
  const card = useQuery({
    ...stockCardQuery(tenantId, item.variantId),
    enabled: warehouseId !== '',
  }).data;
  const here = card?.warehouses.find((place) => place.warehouseId === warehouseId);
  const batchesHere = (card?.batches ?? []).filter((batch) => batch.warehouseId === warehouseId);
  const preview = basePreview(item, unitId, quantity, units);
  const number = index + 1;
  const id = (field: string) => `lines.${String(index)}.${field}`;

  const removeButton = (
    <IconButton icon={Delete02Icon} label={t('stockLines.remove', { number })} onClick={onRemove} />
  );

  return (
    <div
      role="group"
      aria-label={t('stockLines.line', { number })}
      className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
    >
      <div className="col-span-2 flex items-start justify-between gap-3 @3xl:col-span-1">
        <span className="grid min-w-0 gap-0.5">
          <VariantCell item={item} />
          {here && (
            <span className="text-caption text-ink-3 tabular-nums">
              {t('stockLines.inStock', { quantity: quantityText(here.onHand, item.baseUnitId) })}
            </span>
          )}
        </span>
        <span className="@3xl:hidden">{removeButton}</span>
      </div>
      <LineField id={id('unitId')} label={t('stockLines.unit')} error={errors.unitId}>
        <Select
          id={id('unitId')}
          options={unitChoices(item, units)}
          invalid={errors.unitId !== undefined}
          {...fields.unitId}
        />
      </LineField>
      <LineField id={id('quantity')} label={t('stockLines.quantity')} error={errors.quantity}>
        <Input
          id={id('quantity')}
          inputMode="decimal"
          autoComplete="off"
          align="end"
          invalid={errors.quantity !== undefined}
          aria-describedby={errors.quantity ? `${id('quantity')}-error` : undefined}
          {...fields.quantity}
        />
        {preview !== null && (
          <span className="text-right text-caption text-ink-3 tabular-nums">
            {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
          </span>
        )}
      </LineField>
      <div className="col-span-2 grid grid-cols-1 gap-3 @3xl:col-span-1">
        {item.tracking === 'batch' && mode === 'in' && fields.lotNumber && (
          <>
            <LineField id={id('lotNumber')} label={t('stockLines.lot')} error={errors.lotNumber}>
              <Input
                id={id('lotNumber')}
                autoComplete="off"
                spellCheck={false}
                placeholder="NP24117"
                invalid={errors.lotNumber !== undefined}
                {...fields.lotNumber}
              />
            </LineField>
            {dates}
          </>
        )}
        {item.tracking === 'batch' && mode === 'out' && (
          <>
            <LineField id={id('batchId')} label={t('stockLines.batch')} error={errors.batchId}>
              <Select
                id={id('batchId')}
                invalid={errors.batchId !== undefined}
                options={[
                  { value: '', label: t('stockLines.batchPlaceholder') },
                  ...batchesHere.map((batch) => ({
                    value: batch.batchId,
                    label: t('stockLines.batchOption', {
                      lot: batch.lotNumber,
                      quantity: quantityText(batch.quantity, item.baseUnitId),
                      expiry:
                        batch.expiresOn === null ? t('stock.noExpiry') : isoDate(batch.expiresOn),
                    }),
                  })),
                ]}
                {...fields.batchId}
              />
            </LineField>
            {batchesHere.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onSplit(
                    batchesHere.map((batch) => ({
                      batchId: batch.batchId,
                      quantity: plainQuantity(batch.quantity),
                    })),
                  );
                }}
                className="inline-flex w-fit items-center gap-1.5 text-label font-medium text-brand underline-offset-3 hover:underline"
              >
                <HugeiconsIcon icon={Layers01Icon} size={15} strokeWidth={1.5} />
                {t('stockLines.pickFefo')}
              </button>
            )}
          </>
        )}
        {item.tracking === 'serial' && serials}
      </div>
      <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
    </div>
  );
}
```

- **No form state inside.** Each form passes its registered inputs (`UseFormRegisterReturn` is generic only over
  the field's name, which widens to `string`) and renders its controlled fields (dates, serial numbers) itself.
  That is how one row serves two forms whose react-hook-form types differ, without a cast.
- **The row fetches its variant's stock card**: what is in the chosen warehouse, and its batches in FEFO order for
  the batch select.
- **One grid template** (`COLUMNS`) for the header and every row, switched by the card's width (`@3xl`), like the
  journal's lines.

`apps/app/src/components/stock-lines-table.tsx`:

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import {
  compareQuantity,
  type StockLine,
  subtractQuantity,
  type TransferLine,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, Pill } from '@omnivo/ui';

import { useIsoDate, useQuantity, VariantCell } from './stock-parts';

// The lines of a posted adjustment or a sent transfer: a real <table> in a card, scrolling inside
// its own box on a phone. What was typed (3 case), the base quantity it was (72 pcs), the batch
// with its expiry or the serial numbers — and for a received transfer, what arrived.
export function StockLinesTable({
  lines,
  received = false,
}: {
  lines: readonly (StockLine | TransferLine)[];
  received?: boolean;
}) {
  const { t } = useLocale();
  const quantity = useQuantity();
  const isoDate = useIsoDate();
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-body-sm">
        <caption className="sr-only">{t('stockLines.items')}</caption>
        <thead>
          <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
            <th scope="col" className="px-5 py-2.5">
              {t('stock.columns.product')}
            </th>
            <th scope="col" className="px-5 py-2.5 text-right">
              {t('stockLines.quantity')}
            </th>
            <th scope="col" className="px-5 py-2.5">
              {t('stock.history.detail')}
            </th>
            {received && (
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('transfers.receivedQuantity')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const arrived = 'receivedQuantity' in line ? line.receivedQuantity : null;
            const short =
              arrived !== null && compareQuantity(arrived, line.baseQuantity) < 0
                ? subtractQuantity(line.baseQuantity, arrived)
                : null;
            return (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <VariantCell item={line} />
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.unitId)}
                  {line.unitId !== line.baseUnitId && (
                    <span className="block text-caption text-ink-3">
                      {t('stockLines.equals', {
                        quantity: quantity(line.baseQuantity, line.baseUnitId),
                      })}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3">
                  {line.lotNumber !== null && (
                    <span className="block">
                      <span className="font-mono text-caption">{line.lotNumber}</span>
                      {line.expiresOn !== null && (
                        <span className="text-caption text-ink-3">
                          {' '}
                          · {t('stock.expires')} {isoDate(line.expiresOn)}
                        </span>
                      )}
                    </span>
                  )}
                  {line.serialNumbers.length > 0 && (
                    <span className="block font-mono text-caption break-all text-ink-2">
                      {line.serialNumbers.join(', ')}
                    </span>
                  )}
                  {line.lotNumber === null && line.serialNumbers.length === 0 && (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                {received && (
                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                    {arrived === null ? '—' : quantity(arrived, line.baseUnitId)}
                    {short !== null && (
                      <span className="mt-1 block">
                        <Pill tone="crit" icon={Alert02Icon}>
                          {t('transfers.shortBy', { quantity: quantity(short, line.baseUnitId) })}
                        </Pill>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
```

`apps/app/src/components/adjustment-form.tsx`:

```tsx
import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADJUSTMENT_DIRECTIONS,
  ADJUSTMENT_REASONS,
  type AdjustmentDirection,
  contractErrorMap,
  isAdjustmentDirection,
  plainQuantity,
  reasonFits,
  routes,
  type StockAdjustment,
  type StockAdjustmentFormValues,
  type StockItem,
  updateStockAdjustmentInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  Dialog,
  FormAlert,
  FormField,
  PageHeader,
  SegmentedControl,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { unitsQuery } from '../lib/queries';
import { basePreview, fefoSplit, firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import {
  BackLink,
  useStockRefresh,
  useTenantId,
  useWarehouses,
  warehouseLabel,
} from './stock-parts';

// The adjustment form: its own chunk (loaded by routes/stock-adjustment.tsx), because the form
// library, the date picker and the picker are only needed to write — a posted adjustment is read
// without them.

type FormValues = StockAdjustmentFormValues;
type LineValues = FormValues['lines'][number];

function emptyLine(item: LineItem): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
  };
}

// The server's field names for the errors it can send — one set per line, and one per serial
// number it may point at ("lines.2.serialNumbers.1")
function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'date',
    'warehouseId',
    'direction',
    'reason',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'lotNumber'),
      rowPath('lines', index, 'expiresOn'),
      rowPath('lines', index, 'manufacturedOn'),
      rowPath('lines', index, 'serialNumbers'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// Writing a new adjustment, or changing a draft. "Save draft" keeps it a draft; "Post adjustment"
// saves and posts in one request, all or nothing.
export function AdjustmentForm({
  adjustment,
  today,
}: {
  adjustment: StockAdjustment | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // What each line's variant is (name, packs, tracking): kept beside the form, by variant, because
  // the form holds only what is sent
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () => new Map(adjustment?.lines.map((line) => [line.variantId, toLineItem(line)])),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateStockAdjustmentInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: adjustment?.date ?? today,
      warehouseId: adjustment?.warehouseId ?? '',
      direction:
        adjustment && isAdjustmentDirection(adjustment.direction) ? adjustment.direction : 'in',
      reason: ADJUSTMENT_REASONS.find((reason) => reason === adjustment?.reason) ?? 'opening',
      note: adjustment?.note ?? '',
      lines:
        adjustment?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          lotNumber: line.lotNumber ?? '',
          expiresOn: line.expiresOn ?? '',
          manufacturedOn: line.manufacturedOn ?? '',
          serialNumbers: line.serialNumbers,
        })) ?? [],
      post: false,
      version: adjustment?.version ?? 1,
    },
  });
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const direction = useWatch({ control, name: 'direction' });
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const { active } = useWarehouses();
  const units = useQuery(unitsQuery(useTenantId())).data ?? [];

  const reasonOptions = useMemo(
    () =>
      ADJUSTMENT_REASONS.filter((reason) => reasonFits(reason, direction)).map((reason) => ({
        value: reason,
        label: t(`adjustments.reasons.${reason}`),
      })),
    [direction, t],
  );

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = adjustment
          ? await call(routes.stockAdjustments.update, {
              params: { id: adjustment.id },
              body: { ...body, version },
            })
          : await call(routes.stockAdjustments.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('adjustments.posted', { number: saved.number ?? '' })
            : t('adjustments.draftSaved'),
        );
        if (!adjustment) {
          void navigate({
            to: '/stock/adjustments/$adjustmentId',
            params: { adjustmentId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: StockAdjustment) =>
      call(routes.stockAdjustments.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('adjustments.deleted'));
      void navigate({ to: '/stock/adjustments' });
    },
  });

  // FEFO for a line that takes stock out: the line becomes one line per batch, the batch that
  // expires first taking as much as it holds, in the base unit
  const split = (index: number, batches: readonly { batchId: string; quantity: string }[]) => {
    const typed = getValues(rowPath('lines', index, 'quantity'));
    const unitId = getValues(rowPath('lines', index, 'unitId'));
    const item = items.get(getValues(rowPath('lines', index, 'variantId')));
    if (!item) return;
    const wanted =
      unitId === item.baseUnitId ? typed.trim() : basePreview(item, unitId, typed, units);
    if (wanted === null || wanted === '') return;
    const { picks, missing } = fefoSplit(batches, wanted);
    if (picks.length === 0) return;
    remove(index);
    insert(
      index,
      picks.map((pick) => ({
        ...emptyLine(item),
        quantity: pick.quantity,
        batchId: pick.batchId,
      })),
    );
    if (missing !== '0.0000')
      toast(t('stockLines.fefoShort', { quantity: plainQuantity(missing) }));
  };

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
      <PageHeader
        title={adjustment ? t('adjustments.draftTitle') : t('adjustments.newTitle')}
        description={t('adjustments.description')}
      />
      <form
        id="adjustment-form"
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)]">
          <FormField control={control} name="date" label={t('adjustments.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <SelectField
            label={t('adjustments.warehouse')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <div className="grid grid-cols-1 content-start gap-1.5">
            <span className="text-label font-medium text-ink">{t('adjustments.direction')}</span>
            <Controller
              control={control}
              name="direction"
              render={({ field }) => (
                <SegmentedControl
                  label={t('adjustments.direction')}
                  value={field.value}
                  options={ADJUSTMENT_DIRECTIONS.map((value) => ({
                    value,
                    label: t(`adjustments.directions.${value}`),
                  }))}
                  onChange={(next: AdjustmentDirection) => {
                    field.onChange(next);
                    // A reason that does not go this way gives way to the first one that does
                    if (!reasonFits(getValues('reason'), next)) {
                      setValue('reason', next === 'in' ? 'opening' : 'damaged');
                    }
                  }}
                />
              )}
            />
          </div>
          {/* Controlled, not registered: when the direction changes, the reason is set in the same
              render as its new options. A registered select took the value before the options
              existed, and the browser fell back to the one option both lists share. */}
          <Controller
            control={control}
            name="reason"
            render={({ field, fieldState }) => (
              <SelectField
                label={t('adjustments.reason')}
                options={reasonOptions}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onChange={(event) => {
                  const next = ADJUSTMENT_REASONS.find((reason) => reason === event.target.value);
                  if (next) field.onChange(next);
                }}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
              />
            )}
          />
          <div className="sm:col-span-2">
            <TextField
              label={t('adjustments.note')}
              optional
              placeholder={t('adjustments.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('stockLines.noLines')}</p>
          ) : (
            <StockLinesHeader />
          )}
          {fields.length > 0 &&
            fields.map((field, index) => {
              const item = items.get(field.variantId);
              if (!item) return null;
              const lineErrors = errors.lines?.[index];
              const serialPath = rowPath('lines', index, 'serialNumbers');
              return (
                <StockLineRow
                  key={field.id}
                  index={index}
                  item={item}
                  mode={direction}
                  warehouseId={warehouseId}
                  unitId={lines[index]?.unitId ?? item.baseUnitId}
                  quantity={lines[index]?.quantity ?? ''}
                  fields={{
                    unitId: register(rowPath('lines', index, 'unitId')),
                    quantity: register(rowPath('lines', index, 'quantity')),
                    batchId: register(rowPath('lines', index, 'batchId')),
                    lotNumber: register(rowPath('lines', index, 'lotNumber')),
                  }}
                  dates={(['expiresOn', 'manufacturedOn'] as const).map((date) => (
                    <Controller
                      key={date}
                      control={control}
                      name={rowPath('lines', index, date)}
                      render={({ field: dateField, fieldState }) => (
                        <LineField
                          id={dateField.name}
                          label={t(`stockLines.${date}`)}
                          error={fieldState.error?.message}
                        >
                          <DatePicker
                            id={dateField.name}
                            name={dateField.name}
                            ref={dateField.ref}
                            value={dateField.value ?? ''}
                            onChange={dateField.onChange}
                            onBlur={dateField.onBlur}
                            invalid={fieldState.error !== undefined}
                          />
                        </LineField>
                      )}
                    />
                  ))}
                  serials={
                    <Controller
                      control={control}
                      name={serialPath}
                      render={({ field: serialField }) => {
                        const error = firstMessage(lineErrors?.serialNumbers);
                        return (
                          <LineField id={serialPath} label={t('stockLines.serials')} error={error}>
                            <SerialNumbersInput
                              id={serialPath}
                              name={serialField.name}
                              ref={serialField.ref}
                              value={serialField.value}
                              onChange={serialField.onChange}
                              onBlur={serialField.onBlur}
                              invalid={error !== undefined}
                            />
                            <span className="text-caption text-ink-3">
                              {t('stockLines.serialsHint')}
                            </span>
                          </LineField>
                        );
                      }}
                    />
                  }
                  errors={{
                    unitId: lineErrors?.unitId?.message,
                    quantity: lineErrors?.quantity?.message,
                    batchId: lineErrors?.batchId?.message,
                    lotNumber: lineErrors?.lotNumber?.message,
                  }}
                  onRemove={() => {
                    remove(index);
                  }}
                  onSplit={(batches) => {
                    split(index, batches);
                  }}
                />
              );
            })}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={warehouseId === ''}
              onClick={() => {
                setPicking(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('stockLines.addItems')}
            </Button>
            {warehouseId === '' && (
              <p className="mt-2 text-label text-ink-3">{t('stockLines.pickWarehouse')}</p>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {adjustment && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(adjustment);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('adjustments.confirmDelete') : t('adjustments.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('adjustments.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('adjustments.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('adjustments.posting') : t('adjustments.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('adjustments.postHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId={warehouseId}
            allowArchived={direction === 'out'}
            onAdd={(item: StockItem) => {
              setItems((before) => new Map(before).set(item.variantId, toLineItem(item)));
              append(emptyLine(item));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **`items` beside the form**: the form holds only what is sent; what each variant *is* (name, packs, tracking)
  is kept in a map by variant id, filled from the picker or from the saved lines.
- **The reason is a controlled select.** When the direction switches to "Stock out", the reason must change to one
  that goes out. A registered (uncontrolled) select got the new value before React had rendered the new options;
  the browser could not select "Damaged" yet and fell back to "Correction", the only option both lists share. The
  Playwright test caught it.
- **`split()`** replaces a line by one line per batch, in the base unit, FEFO.
- **`fieldNames()`** includes one path per serial number, so the server's `lines.0.serialNumbers.1` lands under the
  right box instead of the form's top alert.

`apps/app/src/components/adjustment-view.tsx`:

```tsx
import { isAdjustmentDirection, isAdjustmentReason, type StockAdjustment } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';

import { StockLinesTable } from './stock-lines-table';
import {
  AdjustmentStatusPill,
  BackLink,
  useIsoDate,
  useWarehouses,
  warehouseLabel,
} from './stock-parts';

// A posted adjustment, read only: it never changes. A mistake is put right with another one.
export function AdjustmentView({ adjustment }: { adjustment: StockAdjustment }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const direction = isAdjustmentDirection(adjustment.direction)
    ? t(`adjustments.directions.${adjustment.direction}`)
    : adjustment.direction;
  const reason = isAdjustmentReason(adjustment.reason)
    ? t(`adjustments.reasons.${adjustment.reason}`)
    : adjustment.reason;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
      <PageHeader
        title={adjustment.number ?? t('adjustments.draftTitle')}
        description={`${direction} · ${reason}`}
        actions={<AdjustmentStatusPill status={adjustment.status} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('adjustments.date')} value={isoDate(adjustment.date)} />
        <Fact
          label={t('adjustments.warehouse')}
          value={warehouseLabel(byId.get(adjustment.warehouseId))}
        />
        {adjustment.note !== null && <Fact label={t('adjustments.note')} value={adjustment.note} />}
      </Card>
      <StockLinesTable lines={adjustment.lines} />
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-caption font-medium text-ink-3">{label}</span>
      <span className="text-body-sm text-ink">{value}</span>
    </div>
  );
}
```

`apps/app/src/components/transfer-form.tsx`:

```tsx
import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  routes,
  type StockItem,
  type StockTransfer,
  type StockTransferFormValues,
  updateStockTransferInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  Dialog,
  FormAlert,
  FormField,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { unitsQuery } from '../lib/queries';
import { basePreview, fefoSplit, firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import {
  BackLink,
  useStockRefresh,
  useTenantId,
  useWarehouses,
  warehouseLabel,
} from './stock-parts';

// The transfer form: writing a new transfer or changing a draft. "Send transfer" saves and sends
// in one request: the stock leaves the first warehouse and is in transit. Its own chunk, like the
// adjustment form.

type FormValues = StockTransferFormValues;
type LineValues = FormValues['lines'][number];

function emptyLine(item: LineItem): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    serialNumbers: [],
  };
}

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'fromWarehouseId',
    'toWarehouseId',
    'date',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

export function TransferForm({
  transfer,
  today,
}: {
  transfer: StockTransfer | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () => new Map(transfer?.lines.map((line) => [line.variantId, toLineItem(line)])),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateStockTransferInputSchema, { error: contractErrorMap }),
    defaultValues: {
      fromWarehouseId: transfer?.fromWarehouseId ?? '',
      toWarehouseId: transfer?.toWarehouseId ?? '',
      date: transfer?.sentOn ?? today,
      note: transfer?.note ?? '',
      lines:
        transfer?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          serialNumbers: line.serialNumbers,
        })) ?? [],
      send: false,
      version: transfer?.version ?? 1,
    },
  });
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const fromWarehouseId = useWatch({ control, name: 'fromWarehouseId' });
  const { active } = useWarehouses();
  const units = useQuery(unitsQuery(useTenantId())).data ?? [];
  const placeOptions = [
    { value: '', label: t('stockLines.pickWarehouse') },
    ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
  ];

  const save = (send: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, send };
        const saved = transfer
          ? await call(routes.stockTransfers.update, {
              params: { id: transfer.id },
              body: { ...body, version },
            })
          : await call(routes.stockTransfers.create, { body });
        await refresh();
        toast(
          saved.status === 'draft'
            ? t('transfers.draftSaved')
            : t('transfers.sent', { number: saved.number ?? '' }),
        );
        if (!transfer) {
          void navigate({
            to: '/stock/transfers/$transferId',
            params: { transferId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: StockTransfer) =>
      call(routes.stockTransfers.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('transfers.deleted'));
      void navigate({ to: '/stock/transfers' });
    },
  });

  // FEFO, as in the adjustment form
  const split = (index: number, batches: readonly { batchId: string; quantity: string }[]) => {
    const typed = getValues(rowPath('lines', index, 'quantity'));
    const unitId = getValues(rowPath('lines', index, 'unitId'));
    const item = items.get(getValues(rowPath('lines', index, 'variantId')));
    if (!item) return;
    const wanted =
      unitId === item.baseUnitId ? typed.trim() : basePreview(item, unitId, typed, units);
    if (wanted === null || wanted === '') return;
    const { picks, missing } = fefoSplit(batches, wanted);
    if (picks.length === 0) return;
    remove(index);
    insert(
      index,
      picks.map((pick) => ({ ...emptyLine(item), quantity: pick.quantity, batchId: pick.batchId })),
    );
    if (missing !== '0.0000')
      toast(t('stockLines.fefoShort', { quantity: plainQuantity(missing) }));
  };

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/transfers" label={t('transfers.back')} />
      <PageHeader
        title={transfer ? t('transfers.draftTitle') : t('transfers.newTitle')}
        description={t('transfers.description')}
      />
      <form
        id="transfer-form"
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_13rem]">
          <SelectField
            label={t('transfers.from')}
            options={placeOptions}
            {...register('fromWarehouseId')}
            error={errors.fromWarehouseId?.message}
          />
          <SelectField
            label={t('transfers.to')}
            options={placeOptions}
            {...register('toWarehouseId')}
            error={errors.toWarehouseId?.message}
          />
          <FormField control={control} name="date" label={t('transfers.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('transfers.note')}
              optional
              placeholder={t('transfers.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('stockLines.noLines')}</p>
          ) : (
            <StockLinesHeader />
          )}
          {fields.length > 0 &&
            fields.map((field, index) => {
              const item = items.get(field.variantId);
              if (!item) return null;
              const lineErrors = errors.lines?.[index];
              const serials = rowPath('lines', index, 'serialNumbers');
              return (
                <StockLineRow
                  key={field.id}
                  index={index}
                  item={item}
                  mode="out"
                  warehouseId={fromWarehouseId}
                  unitId={lines[index]?.unitId ?? item.baseUnitId}
                  quantity={lines[index]?.quantity ?? ''}
                  fields={{
                    unitId: register(rowPath('lines', index, 'unitId')),
                    quantity: register(rowPath('lines', index, 'quantity')),
                    batchId: register(rowPath('lines', index, 'batchId')),
                  }}
                  serials={
                    <Controller
                      control={control}
                      name={serials}
                      render={({ field: serialField }) => {
                        const error = firstMessage(lineErrors?.serialNumbers);
                        return (
                          <LineField id={serials} label={t('stockLines.serials')} error={error}>
                            <SerialNumbersInput
                              id={serials}
                              name={serialField.name}
                              ref={serialField.ref}
                              value={serialField.value}
                              onChange={serialField.onChange}
                              onBlur={serialField.onBlur}
                              invalid={error !== undefined}
                            />
                            <span className="text-caption text-ink-3">
                              {t('stockLines.serialsHint')}
                            </span>
                          </LineField>
                        );
                      }}
                    />
                  }
                  errors={{
                    unitId: lineErrors?.unitId?.message,
                    quantity: lineErrors?.quantity?.message,
                    batchId: lineErrors?.batchId?.message,
                  }}
                  onRemove={() => {
                    remove(index);
                  }}
                  onSplit={(batches) => {
                    split(index, batches);
                  }}
                />
              );
            })}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={fromWarehouseId === ''}
              onClick={() => {
                setPicking(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('stockLines.addItems')}
            </Button>
            {fromWarehouseId === '' && (
              <p className="mt-2 text-label text-ink-3">{t('stockLines.pickWarehouse')}</p>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {transfer && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(transfer);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('transfers.confirmDelete') : t('transfers.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('transfers.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('transfers.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('transfers.sending') : t('transfers.send')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('transfers.sendHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId={fromWarehouseId}
            allowArchived
            onAdd={(item: StockItem) => {
              setItems((before) => new Map(before).set(item.variantId, toLineItem(item)));
              append(emptyLine(item));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

`apps/app/src/components/transfer-view.tsx`:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  type ReceiveTransferFormValues,
  receiveTransferInputSchema,
  routes,
  type StockTransfer,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { Controller, type Path, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { firstMessage } from '../lib/stock';
import { Fact } from './adjustment-view';
import { LineField } from './journal-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { StockLinesTable } from './stock-lines-table';
import {
  BackLink,
  TransferStatusPills,
  useIsoDate,
  useQuantity,
  useStockRefresh,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from './stock-parts';

// A sent transfer. On its way, someone who can receive it sees the receipt form; received, it is
// read only — with what arrived and any shortage, line by line.
export function TransferView({
  transfer,
  canReceive,
  today,
}: {
  transfer: StockTransfer;
  canReceive: boolean;
  today: string;
}) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const to = warehouseLabel(byId.get(transfer.toWarehouseId));
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/transfers" label={t('transfers.back')} />
      <PageHeader
        title={transfer.number ?? t('transfers.draftTitle')}
        description={`${warehouseLabel(byId.get(transfer.fromWarehouseId))} → ${to}`}
        actions={<TransferStatusPills transfer={transfer} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('transfers.date')} value={isoDate(transfer.sentOn)} />
        {transfer.receivedOn !== null && (
          <Fact label={t('transfers.receiveDate')} value={isoDate(transfer.receivedOn)} />
        )}
        {transfer.note !== null && <Fact label={t('transfers.note')} value={transfer.note} />}
      </Card>
      {transfer.status === 'in_transit' && canReceive ? (
        <ReceiveForm transfer={transfer} today={today} warehouse={to} />
      ) : (
        <StockLinesTable lines={transfer.lines} received={transfer.status === 'received'} />
      )}
    </div>
  );
}

type FormValues = ReceiveTransferFormValues;

const LINE_COLUMNS = '@3xl:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.6fr)] @3xl:items-start';

// What arrived, line by line, in the base unit. Every line starts as "all of it arrived": the
// store keeper only changes what is short. A serial line counts the serial numbers left in its box.
function ReceiveForm({
  transfer,
  today,
  warehouse,
}: {
  transfer: StockTransfer;
  today: string;
  warehouse: string;
}) {
  const { t } = useLocale();
  const quantity = useQuantity();
  const refresh = useStockRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(receiveTransferInputSchema, { error: contractErrorMap }),
    defaultValues: {
      version: transfer.version,
      date: today,
      lines: transfer.lines.map((line) => ({
        lineId: line.id,
        receivedQuantity: plainQuantity(line.baseQuantity),
        serialNumbers: line.serialNumbers,
      })),
    },
  });

  const names: Path<FormValues>[] = [
    'date',
    'lines',
    ...transfer.lines.flatMap((_, index) => [
      rowPath('lines', index, 'receivedQuantity'),
      rowPath('lines', index, 'serialNumbers'),
    ]),
  ];

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.stockTransfers.receive, {
        params: { id: transfer.id },
        body: values,
      });
      await refresh();
      toast(t('transfers.received', { number: saved.number ?? '' }));
    } catch (error) {
      applyApiError(error, names, setError);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid grid-cols-1 gap-5">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      <Card className="@container grid grid-cols-1 overflow-hidden">
        <CardHeader
          title={t('transfers.receiveTitle', { warehouse })}
          subtitle={t('transfers.receiveSubtitle')}
        />
        <div className="grid grid-cols-1 gap-5 px-5 pt-4 pb-5 sm:max-w-[13rem]">
          <FormField control={control} name="date" label={t('transfers.receiveDate')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            LINE_COLUMNS,
          )}
        >
          <span>{t('stockLines.items')}</span>
          <span className="text-right">{t('transfers.sentQuantity')}</span>
          <span>{t('transfers.receivedQuantity')}</span>
        </div>
        {transfer.lines.map((line, index) => {
          const lineErrors = errors.lines?.[index];
          const path = rowPath('lines', index, 'receivedQuantity');
          const serials = rowPath('lines', index, 'serialNumbers');
          return (
            <div
              key={line.id}
              role="group"
              aria-label={t('stockLines.line', { number: index + 1 })}
              className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', LINE_COLUMNS)}
            >
              <div className="col-span-2 @3xl:col-span-1">
                <VariantCell item={line} />
              </div>
              <div className="grid content-start gap-1.5">
                <span className="text-label font-medium text-ink @3xl:sr-only">
                  {t('transfers.sentQuantity')}
                </span>
                <span className="py-2.5 text-body tabular-nums @3xl:text-right">
                  {quantity(line.baseQuantity, line.baseUnitId)}
                </span>
              </div>
              {line.tracking === 'serial' ? (
                <div className="col-span-2 @3xl:col-span-1">
                  <Controller
                    control={control}
                    name={serials}
                    render={({ field }) => {
                      const error = firstMessage(lineErrors?.serialNumbers);
                      return (
                        <LineField id={serials} label={t('transfers.serialsArrived')} error={error}>
                          <SerialNumbersInput
                            id={serials}
                            name={field.name}
                            ref={field.ref}
                            value={field.value}
                            onChange={(next) => {
                              field.onChange(next);
                              // A serial line's quantity is its serial numbers, one each
                              setValue(path, String(next.length));
                            }}
                            onBlur={field.onBlur}
                            invalid={error !== undefined}
                          />
                        </LineField>
                      );
                    }}
                  />
                </div>
              ) : (
                <LineField
                  id={path}
                  label={t('transfers.receivedQuantity')}
                  error={lineErrors?.receivedQuantity?.message}
                >
                  <Input
                    id={path}
                    inputMode="decimal"
                    autoComplete="off"
                    align="end"
                    invalid={lineErrors?.receivedQuantity !== undefined}
                    {...register(path)}
                  />
                </LineField>
              )}
            </div>
          );
        })}
      </Card>
      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('transfers.receiving') : t('transfers.receive')}
        </Button>
      </div>
    </form>
  );
}
```

- **Every line starts as "all of it arrived"**: the store keeper only changes what is short.
- **A serial line has no quantity box**: its quantity is the number of serial numbers left in its box (`setValue`
  on every change), so the two can never disagree.
- **After a receipt the page reloads the transfer** (the route's `key` includes the version), and the view shows
  what arrived with its shortage.

`apps/app/src/components/reorder-level-form.tsx`:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  reorderLevelInputSchema,
  routes,
  type StockCard,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogClose, DialogContent, FormAlert, TextField, toast } from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useStockRefresh, useWarehouses, warehouseLabel } from './stock-parts';

const LEVEL_FIELDS = reorderLevelInputSchema.keyof().options;

// When to order more of this variant in one warehouse. Both boxes empty = no level.
export function ReorderLevelForm({
  card,
  warehouseId,
  onDone,
}: {
  card: StockCard;
  warehouseId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useStockRefresh();
  const { byId } = useWarehouses();
  const place = card.warehouses.find((row) => row.warehouseId === warehouseId);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(reorderLevelInputSchema, { error: contractErrorMap }),
    defaultValues: {
      warehouseId,
      variantId: card.item.variantId,
      minQuantity: place?.minQuantity === null || !place ? '' : plainQuantity(place.minQuantity),
      reorderQuantity:
        place?.reorderQuantity === null || !place ? '' : plainQuantity(place.reorderQuantity),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.stock.setReorderLevel, { body: values });
      await refresh();
      toast(t(saved.minQuantity === null ? 'stock.levelCleared' : 'stock.levelSaved'));
      onDone();
    } catch (error) {
      applyApiError(error, LEVEL_FIELDS, setError);
    }
  });

  const name = warehouseLabel(byId.get(warehouseId));
  return (
    <DialogContent
      title={t('stock.levelTitle', { warehouse: name })}
      description={t('stock.levelDescription')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="level-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="level-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5 sm:grid-cols-2 sm:gap-x-4"
      >
        {errors.root?.server?.message && (
          <div className="sm:col-span-2">
            <FormAlert message={errors.root.server.message} />
          </div>
        )}
        <TextField
          label={t('stock.minQuantity')}
          inputMode="decimal"
          autoComplete="off"
          align="end"
          {...register('minQuantity')}
          error={errors.minQuantity?.message}
        />
        <TextField
          label={t('stock.reorderQuantity')}
          optional
          inputMode="decimal"
          autoComplete="off"
          align="end"
          {...register('reorderQuantity')}
          error={errors.reorderQuantity?.message}
        />
      </form>
    </DialogContent>
  );
}
```

A chunk of its own (loaded when the dialog opens): with the form library in it, the stock card's chunk was over its
100 KB budget.

### The pages

`apps/app/src/routes/warehouses.tsx`:

```tsx
import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  WarehouseIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Branch,
  contractErrorMap,
  routes,
  updateWarehouseInputSchema,
  type Warehouse,
  WAREHOUSE_STATUSES,
  type WarehouseStatus,
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
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { branchesQuery, warehousesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<Warehouse>();
const FIELD_NAMES = updateWarehouseInputSchema.keyof().options;

// One form for both: a new warehouse (none given) and a change. Like the branch form, version 1
// for a new one passes the schema, and the create route never reads it.
function WarehouseForm({
  warehouse,
  branches,
  onDone,
}: {
  warehouse: Warehouse | null;
  branches: readonly Branch[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateWarehouseInputSchema, { error: contractErrorMap }),
    defaultValues: {
      // A new warehouse goes to the first branch unless the person picks another
      branchId: warehouse?.branchId ?? branches[0]?.id ?? '',
      code: warehouse?.code ?? '',
      name: warehouse?.name ?? '',
      address: warehouse?.address ?? '',
      version: warehouse?.version ?? 1,
    },
  });

  // The warehouse lists and every stock page show warehouses: both prefixes refresh
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['warehouses', tenantId] });
    await queryClient.invalidateQueries({ queryKey: ['stock', tenantId] });
  };

  const toggle = useMutation({
    mutationFn: (current: Warehouse) =>
      call(current.archivedAt === null ? routes.warehouses.archive : routes.warehouses.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'warehouses.restoredToast' : 'warehouses.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = warehouse
        ? await call(routes.warehouses.update, {
            params: { id: warehouse.id },
            body: { ...fields, version },
          })
        : await call(routes.warehouses.create, { body: fields });
      await refresh();
      toast(t(warehouse ? 'warehouses.updated' : 'warehouses.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // archive/restore's errors (warehouse_has_stock, version_conflict) belong to no field
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={
        warehouse ? t('warehouses.editTitle', { code: warehouse.code }) : t('warehouses.newTitle')
      }
      footer={
        <>
          {warehouse && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(warehouse);
              }}
            >
              {warehouse.archivedAt === null ? t('warehouses.archive') : t('warehouses.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="warehouse-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : warehouse ? t('common.save') : t('warehouses.add')}
          </Button>
        </>
      }
    >
      <form
        id="warehouse-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('warehouses.code')}
            hint={t('warehouses.codeHint')}
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="FG"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('warehouses.name')}
            icon={WarehouseIcon}
            placeholder="Finished goods store"
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <SelectField
          label={t('warehouses.branch')}
          options={branches.map((branch) => ({
            value: branch.id,
            label: `${branch.code} · ${branch.name}`,
          }))}
          {...register('branchId')}
          error={errors.branchId?.message}
        />
        <TextAreaField
          label={t('warehouses.address')}
          optional
          placeholder="Shed 3, BSCIC Industrial Area, Konabari, Gazipur 1751"
          {...register('address')}
          error={errors.address?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | Warehouse;

export function WarehousesPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('inventory.warehouse.manage');
  const [status, setStatus] = useState<WarehouseStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({
    ...warehousesQuery(tenantId, status),
    enabled: me !== null,
  });
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const archivedBranches = useQuery(branchesQuery(tenantId, 'archived')).data;
  const branchName = useMemo(
    () =>
      new Map(
        [...(branches ?? []), ...(archivedBranches ?? [])].map((branch) => [
          branch.id,
          `${branch.code} · ${branch.name}`,
        ]),
      ),
    [branches, archivedBranches],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('warehouses.columns.warehouse'),
          meta: { card: 'title' },
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
        column.accessor('branchId', {
          header: t('warehouses.columns.branch'),
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => branchName.get(getValue()) ?? '—',
        }),
        column.accessor('archivedAt', {
          header: t('warehouses.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('warehouses.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('warehouses.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t, branchName],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('warehouses.title')}
        description={t('warehouses.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('warehouses.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('warehouses.show')}
          value={status}
          options={WAREHOUSE_STATUSES.map((value) => ({
            value,
            label: t(`warehouses.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('warehouses.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('warehouses.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('warehouses.title')}
          data={data}
          columns={columns}
          getRowId={(warehouse) => warehouse.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('warehouses.emptyArchivedTitle')}
                description={t('warehouses.emptyArchivedBody')}
              />
            ) : (
              <EmptyState
                icon={WarehouseIcon}
                title={t('warehouses.emptyTitle')}
                description={t('warehouses.emptyBody')}
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
        {/* The form opens with the branches loaded: a new warehouse starts in the first one */}
        {editing !== null && branches && (
          <WarehouseForm
            key={editing === 'new' ? 'new' : editing.id}
            warehouse={editing === 'new' ? null : editing}
            branches={branches}
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

The branches page's pattern. The dialog opens only once the branches are loaded: a new warehouse starts in the
first branch, and a select whose value is not among its options shows one thing and sends another.

`apps/app/src/routes/stock.tsx`:

```tsx
import {
  Alert02Icon,
  Archive02Icon,
  ArrowDataTransferHorizontalIcon,
  Layers01Icon,
  PackageOutOfStockIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareQuantity,
  isZeroQuantity,
  STOCK_FILTERS,
  type StockFilter,
  type StockItem,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  useQuantity,
  useTenantId,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { productCategoriesQuery, stockListQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';

const column = dataTableColumns<StockItem>();

// Why a row needs a look: below zero (crit), at its reorder level (warn: "Out of stock" when
// nothing is left), or archived and still holding some (neutral). Each with its icon and word,
// never colour alone. Zero alone is no warning: a garments factory has thousands of styles it
// does not keep — only a variant with a reorder level is expected to be in stock.
function StockStatus({ item }: { item: StockItem }) {
  const { t } = useLocale();
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5">
      {compareQuantity(item.onHand, '0') < 0 && (
        <Pill tone="crit" icon={Alert02Icon}>
          {t('stock.statuses.negative')}
        </Pill>
      )}
      {item.low && isZeroQuantity(item.onHand) && (
        <Pill tone="warn" icon={PackageOutOfStockIcon}>
          {t('stock.statuses.out')}
        </Pill>
      )}
      {item.low && compareQuantity(item.onHand, '0') > 0 && (
        <Pill tone="warn" icon={PackageOutOfStockIcon}>
          {t('stock.statuses.low')}
        </Pill>
      )}
      {item.archived && (
        <Pill tone="neutral" icon={Archive02Icon}>
          {t('stock.statuses.archived')}
        </Pill>
      )}
    </span>
  );
}

export function StockPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const can = useCan();
  const quantity = useQuantity();
  const { active } = useWarehouses();
  const [search, setSearch] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');
  const settled = useDebounced(search.trim());
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockListQuery(tenantId, { search: settled, warehouseId, categoryId, filter }),
  );
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const items = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('stock.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('onHand', {
          header: t('stock.columns.onHand'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <span className="font-medium tabular-nums">
              {quantity(row.original.onHand, row.original.baseUnitId)}
            </span>
          ),
        }),
        column.accessor('inTransit', {
          header: t('stock.columns.inTransit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) =>
            isZeroQuantity(row.original.inTransit) ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="tabular-nums">
                {quantity(row.original.inTransit, row.original.baseUnitId)}
              </span>
            ),
        }),
        column.display({
          id: 'status',
          header: t('stock.columns.status'),
          meta: { align: 'end', card: 'subtitle' },
          cell: ({ row }) => <StockStatus item={row.original} />,
        }),
      ]),
    [t, quantity],
  );

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('stock.noMatchTitle', { query: settled })}
        description={t('stock.noMatchBody')}
      />
    ) : filter === 'low' ? (
      <EmptyState
        icon={PackageOutOfStockIcon}
        title={t('stock.lowEmptyTitle')}
        description={t('stock.lowEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={Layers01Icon}
        title={t('stock.emptyTitle')}
        description={t('stock.emptyBody')}
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('stock.title')}
        description={t('stock.description')}
        actions={
          <>
            {can('inventory.stock.transfer') && (
              <Button
                variant="secondary"
                onClick={() => void navigate({ to: '/stock/transfers/new' })}
              >
                <HugeiconsIcon icon={ArrowDataTransferHorizontalIcon} size={17} strokeWidth={1.5} />
                {t('stock.newTransfer')}
              </Button>
            )}
            {can('inventory.stock.adjust') && (
              <Button onClick={() => void navigate({ to: '/stock/adjustments/new' })}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('stock.newAdjustment')}
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('stock.searchLabel')}
            placeholder={t('stock.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('stock.warehouse')}
            options={[
              { value: '', label: t('stock.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('stock.category')}
            options={[
              { value: '', label: t('stock.allCategories') },
              ...categoryOptions(categories ?? []),
            ]}
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('stock.show')}
          value={filter}
          options={STOCK_FILTERS.map((value) => ({ value, label: t(`stock.filters.${value}`) }))}
          onChange={setFilter}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('stock.loadFailed')}</p>}
      {items && (
        <DataTable
          label={t('stock.title')}
          data={items}
          columns={columns}
          getRowId={(item) => item.variantId}
          onRowClick={(item) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: item.variantId } })
          }
          onEndReached={loadMore}
          maxHeight={640}
          empty={empty}
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

**"Out of stock" only for a variant with a reorder level.** The first screenshot showed a wall of orange pills: a
garments factory has thousands of styles it does not keep. Zero alone is no warning; zero where a level says "we
keep this" is.

`apps/app/src/routes/stock-card.tsx`:

```tsx
import { AlertCircleIcon, Edit02Icon, TransactionHistoryIcon } from '@hugeicons/core-free-icons';
import {
  compareQuantity,
  isMovementKind,
  isZeroQuantity,
  negateQuantity,
  type StockMovement,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  CardHeader,
  DataTable,
  dataTableColumns,
  DatePicker,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  KpiStrip,
  PageHeader,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import {
  BackLink,
  ExpiryPill,
  useIsoDate,
  useQuantity,
  useTenantId,
  useToday,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockCardQuery, stockMovementsQuery } from '../lib/queries';
import { documentRoute, variantName } from '../lib/stock';

const column = dataTableColumns<StockMovement>();

// The reorder level dialog is a chunk of its own: the form library is only needed when someone
// opens it, and with it this page was over its 100 KB budget
const ReorderLevelForm = lazy(async () => ({
  default: (await import('../components/reorder-level-form')).ReorderLevelForm,
}));

export function StockCardPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { variantId = '' } = useParams({ strict: false });
  const tenantId = useTenantId();
  const canSetLevels = useCan()('inventory.product.manage');
  const quantity = useQuantity();
  const isoDate = useIsoDate();
  const today = useToday();
  const { active, byId } = useWarehouses();
  const [editing, setEditing] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const { data: card, isError } = useQuery({
    ...stockCardQuery(tenantId, variantId),
    enabled: variantId !== '',
  });
  const history = useInfiniteQuery({
    ...stockMovementsQuery(tenantId, variantId, { warehouseId, ...range }),
    enabled: variantId !== '',
  });
  const movements = useMemo(
    () => history.data?.pages.flatMap((page) => page.items),
    [history.data],
  );
  const first = history.data?.pages[0];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const baseUnitId = card?.item.baseUnitId ?? '';
  const columns = useMemo(() => {
    const side = (value: string, sign: 1 | -1) =>
      compareQuantity(value, '0') * sign > 0
        ? quantity(sign === 1 ? value : negateQuantity(value), baseUnitId)
        : '';
    return column.columns([
      column.accessor('documentNumber', {
        header: t('stock.history.document'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium tabular-nums">
              {row.original.documentNumber}
            </span>
            <span className="text-caption text-ink-3 tabular-nums">
              {isoDate(row.original.date)} ·{' '}
              {isMovementKind(row.original.kind)
                ? t(`stock.kinds.${row.original.kind}`)
                : row.original.kind}
            </span>
          </span>
        ),
      }),
      column.accessor('warehouseId', {
        header: t('stock.history.warehouse'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => byId.get(getValue())?.code ?? '—',
      }),
      column.accessor((row) => row.lotNumber ?? row.serialNumber ?? '', {
        id: 'detail',
        header: t('stock.history.detail'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <span className="font-mono text-caption">{getValue() || '—'}</span>,
      }),
      column.accessor('quantity', {
        id: 'in',
        header: t('stock.history.in'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => side(getValue(), 1),
      }),
      column.accessor('quantity', {
        id: 'out',
        header: t('stock.history.out'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => side(getValue(), -1),
      }),
      column.accessor('balance', {
        header: t('stock.history.balance'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => (
          <span className="font-medium">{quantity(getValue(), baseUnitId)}</span>
        ),
      }),
    ]);
  }, [t, quantity, isoDate, byId, baseUnitId]);

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock" label={t('stock.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('stock.title')}
          description={t('stock.cardFailed')}
        />
      </div>
    );
  }
  if (!card) return null;
  const { item } = card;
  const places = card.warehouses.filter((place) => !isZeroQuantity(place.onHand)).length;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock" label={t('stock.back')} />
      <PageHeader
        title={variantName(item)}
        // A simple product's SKU is its code: once is enough
        description={
          item.sku === item.productCode ? item.productCode : `${item.productCode} · ${item.sku}`
        }
      />
      <KpiStrip
        cells={[
          { label: t('stock.kpis.onHand'), value: quantity(item.onHand, item.baseUnitId) },
          { label: t('stock.kpis.inTransit'), value: quantity(item.inTransit, item.baseUnitId) },
          { label: t('stock.kpis.places'), value: String(places) },
        ]}
      />

      <Card className="overflow-x-auto">
        <CardHeader title={t('stock.byWarehouse')} subtitle={t('stock.byWarehouseSubtitle')} />
        <table className="mt-4 w-full min-w-[560px] border-collapse text-body-sm">
          <caption className="sr-only">{t('stock.byWarehouse')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('stock.warehouse')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('stock.columns.onHand')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('stock.columns.inTransit')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('stock.level')}
              </th>
              {canSetLevels && <th scope="col" className="w-12" />}
            </tr>
          </thead>
          <tbody>
            {card.warehouses.map((place) => (
              <tr key={place.warehouseId} className="border-t border-line">
                <td className="px-5 py-3 font-medium">
                  {warehouseLabel(byId.get(place.warehouseId))}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {quantity(place.onHand, item.baseUnitId)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {isZeroQuantity(place.inTransit)
                    ? '—'
                    : quantity(place.inTransit, item.baseUnitId)}
                </td>
                <td className="px-5 py-3 text-ink-2 tabular-nums">
                  {place.minQuantity === null
                    ? t('stock.noLevel')
                    : [
                        t('stock.levelAt', {
                          quantity: quantity(place.minQuantity, item.baseUnitId),
                        }),
                        place.reorderQuantity !== null &&
                          t('stock.levelOrder', {
                            quantity: quantity(place.reorderQuantity, item.baseUnitId),
                          }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </td>
                {canSetLevels && (
                  <td className="px-3 py-1.5">
                    {active?.some((warehouse) => warehouse.id === place.warehouseId) && (
                      <IconButton
                        icon={Edit02Icon}
                        label={t('stock.setLevel', {
                          warehouse: warehouseLabel(byId.get(place.warehouseId)),
                        })}
                        onClick={() => {
                          setEditing(place.warehouseId);
                        }}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {item.tracking === 'batch' && card.batches.length > 0 && (
        <Card className="overflow-x-auto">
          <CardHeader title={t('stock.batchesTitle')} subtitle={t('stock.batchesSubtitle')} />
          <table className="mt-4 w-full min-w-[560px] border-collapse text-body-sm">
            <caption className="sr-only">{t('stock.batchesTitle')}</caption>
            <thead>
              <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
                <th scope="col" className="px-5 py-2.5">
                  {t('stock.lot')}
                </th>
                <th scope="col" className="px-5 py-2.5">
                  {t('stock.warehouse')}
                </th>
                <th scope="col" className="px-5 py-2.5">
                  {t('stock.expires')}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('stock.columns.onHand')}
                </th>
              </tr>
            </thead>
            <tbody>
              {card.batches.map((batch) => (
                <tr key={`${batch.batchId}-${batch.warehouseId}`} className="border-t border-line">
                  <td className="px-5 py-3">
                    <span className="font-mono">{batch.lotNumber}</span>
                    {batch.manufacturedOn !== null && (
                      <span className="block text-caption text-ink-3">
                        {t('stock.made')} {isoDate(batch.manufacturedOn)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">{byId.get(batch.warehouseId)?.code ?? '—'}</td>
                  <td className="px-5 py-3">
                    <ExpiryPill expiresOn={batch.expiresOn} today={today} />
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {quantity(batch.quantity, item.baseUnitId)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {item.tracking === 'serial' && card.serials.length > 0 && (
        <Card>
          <CardHeader title={t('stock.serialsTitle')} subtitle={t('stock.serialsSubtitle')} />
          <ul className="grid grid-cols-1 gap-x-6 px-5 pt-3 pb-4 sm:grid-cols-2 lg:grid-cols-3">
            {card.serials.map((serial) => (
              <li
                key={serial.serialNumber}
                className="flex items-center justify-between gap-3 border-b border-line py-2 text-body-sm"
              >
                <span className="font-mono">{serial.serialNumber}</span>
                <span className="text-caption text-ink-3">
                  {serial.warehouseId === null
                    ? t('stock.inTransitPlace')
                    : (byId.get(serial.warehouseId)?.code ?? '—')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section className="grid grid-cols-1 gap-4">
        <header>
          <h2 className="text-h3">{t('stock.historyTitle')}</h2>
          <p className="text-label text-ink-3">{t('stock.historySubtitle')}</p>
        </header>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field id="history-warehouse" label={t('stock.warehouse')}>
            <Select
              id="history-warehouse"
              options={[
                { value: '', label: t('stock.allWarehouses') },
                ...card.warehouses.map((place) => ({
                  value: place.warehouseId,
                  label: warehouseLabel(byId.get(place.warehouseId)),
                })),
              ]}
              value={warehouseId}
              onChange={(event) => {
                setWarehouseId(event.target.value);
              }}
            />
          </Field>
          <Field id="history-from" label={t('stock.from')}>
            <DatePicker
              id="history-from"
              value={range.from}
              onChange={(value) => {
                setRange((before) => ({ ...before, from: value }));
              }}
            />
          </Field>
          <Field id="history-to" label={t('stock.to')}>
            <DatePicker
              id="history-to"
              value={range.to}
              onChange={(value) => {
                setRange((before) => ({ ...before, to: value }));
              }}
            />
          </Field>
        </div>
        {first && range.from !== '' && (
          <p className="text-body-sm text-ink-2 tabular-nums">
            {t('stock.opening')}: {quantity(first.openingBalance, item.baseUnitId)} ·{' '}
            {t('stock.closing')}: {quantity(first.closingBalance, item.baseUnitId)}
          </p>
        )}
        {movements && (
          <DataTable
            label={t('stock.historyTitle')}
            data={movements}
            columns={columns}
            getRowId={(movement) => movement.id}
            onRowClick={(movement) => {
              const route = documentRoute(movement.kind);
              if (route === '/stock/adjustments/$adjustmentId') {
                void navigate({ to: route, params: { adjustmentId: movement.documentId } });
              } else if (route === '/stock/transfers/$transferId') {
                void navigate({ to: route, params: { transferId: movement.documentId } });
              }
            }}
            onEndReached={loadMore}
            empty={
              <EmptyState
                icon={TransactionHistoryIcon}
                title={t('stock.historyTitle')}
                description={t('stock.historyEmpty')}
              />
            }
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
              )
            }
          />
        )}
      </section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <Suspense fallback={null}>
            <ReorderLevelForm
              key={editing}
              card={card}
              warehouseId={editing}
              onDone={() => {
                setEditing(null);
              }}
            />
          </Suspense>
        )}
      </Dialog>
    </div>
  );
}
```

`apps/app/src/routes/stock-adjustments.tsx`:

```tsx
import { PlusSignIcon, TaskEdit01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isAdjustmentDirection,
  isAdjustmentReason,
  STOCK_DOCUMENT_STATUSES,
  type StockAdjustmentSummary,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  AdjustmentStatusPill,
  useIsoDate,
  useTenantId,
  useWarehouses,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockAdjustmentsQuery } from '../lib/queries';

const column = dataTableColumns<StockAdjustmentSummary>();

type Show = StockDocumentStatus | 'all';

export function StockAdjustmentsPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('inventory.stock.adjust');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockAdjustmentsQuery(useTenantId(), show === 'all' ? undefined : show),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('adjustments.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('adjustments.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor('warehouseId', {
          header: t('adjustments.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => byId.get(getValue())?.name ?? '—',
        }),
        column.accessor('reason', {
          header: t('adjustments.columns.reason'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => {
            const { direction, reason } = row.original;
            return (
              <span className="grid">
                <span>
                  {isAdjustmentReason(reason) ? t(`adjustments.reasons.${reason}`) : reason}
                </span>
                <span className="text-caption text-ink-3">
                  {isAdjustmentDirection(direction)
                    ? t(`adjustments.directions.${direction}`)
                    : direction}
                </span>
              </span>
            );
          },
        }),
        column.accessor('lineCount', {
          header: t('adjustments.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('adjustments.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('adjustments.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <AdjustmentStatusPill status={getValue()} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('adjustments.title')}
        description={t('adjustments.description')}
        actions={
          canWrite && (
            <Button onClick={() => void navigate({ to: '/stock/adjustments/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('adjustments.new')}
            </Button>
          )
        }
      />
      <SegmentedControl
        label={t('adjustments.show')}
        value={show}
        options={[
          { value: 'all', label: t('adjustments.all') },
          ...STOCK_DOCUMENT_STATUSES.map((value) => ({
            value,
            label: t(`adjustments.statuses.${value}`),
          })),
        ]}
        onChange={setShow}
      />
      {isError && <p className="text-body-sm text-crit">{t('adjustments.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('adjustments.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/stock/adjustments/$adjustmentId',
              params: { adjustmentId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={TaskEdit01Icon}
              title={t('adjustments.emptyTitle')}
              description={t('adjustments.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

`apps/app/src/routes/stock-adjustment.tsx`:

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink, useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockAdjustmentQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// journal entry's pattern): reading a posted adjustment needs neither the form library nor the
// date picker.
const AdjustmentForm = lazy(async () => ({
  default: (await import('../components/adjustment-form')).AdjustmentForm,
}));
const AdjustmentView = lazy(async () => ({
  default: (await import('../components/adjustment-view')).AdjustmentView,
}));

// What every adjustment page needs before it draws: the units and the warehouses
function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

export function NewStockAdjustmentPage() {
  const { t } = useLocale();
  const canWrite = useCan()('inventory.stock.adjust');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
        <p className="text-body-sm text-ink-3">{t('adjustments.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <AdjustmentForm adjustment={null} today={today} />
    </Suspense>
  );
}

export function StockAdjustmentPage() {
  const { t } = useLocale();
  const { adjustmentId = '' } = useParams({ strict: false });
  const canWrite = useCan()('inventory.stock.adjust');
  const today = useToday();
  const ready = useReady();
  const { data: adjustment, isError } = useQuery({
    ...stockAdjustmentQuery(useTenantId(), adjustmentId),
    enabled: adjustmentId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/adjustments" label={t('adjustments.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('adjustments.draftTitle')}
          description={t('adjustments.notFound')}
        />
      </div>
    );
  }
  if (!adjustment || !ready) return null;
  if (adjustment.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <AdjustmentForm
          key={`${adjustment.id}-${String(adjustment.version)}`}
          adjustment={adjustment}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <AdjustmentView adjustment={adjustment} />
    </Suspense>
  );
}
```

The journal entry's pattern: the page loads the data and picks the form (a draft, for someone who may write) or the
view, each a lazy chunk. Most visits read a posted adjustment, which needs neither the form library nor the picker.

`apps/app/src/routes/stock-transfers.tsx`:

```tsx
import { ArrowDataTransferHorizontalIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type StockTransferSummary,
  TRANSFER_STATUSES,
  type TransferStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  TransferStatusPills,
  useIsoDate,
  useTenantId,
  useWarehouses,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockTransfersQuery } from '../lib/queries';

const column = dataTableColumns<StockTransferSummary>();

type Show = TransferStatus | 'all';

export function StockTransfersPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('inventory.stock.transfer');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [show, setShow] = useState<Show>('all');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockTransfersQuery(useTenantId(), show === 'all' ? undefined : show),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('transfers.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('transfers.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.sentOn)}
              </span>
            </span>
          ),
        }),
        column.accessor('fromWarehouseId', {
          header: t('transfers.columns.route'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            `${byId.get(row.original.fromWarehouseId)?.code ?? '—'} → ${byId.get(row.original.toWarehouseId)?.code ?? '—'}`,
        }),
        column.accessor('lineCount', {
          header: t('transfers.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('adjustments.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('transfers.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <TransferStatusPills transfer={row.original} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('transfers.title')}
        description={t('transfers.description')}
        actions={
          canWrite && (
            <Button onClick={() => void navigate({ to: '/stock/transfers/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('transfers.new')}
            </Button>
          )
        }
      />
      <SegmentedControl
        label={t('transfers.show')}
        value={show}
        options={[
          { value: 'all', label: t('transfers.all') },
          ...TRANSFER_STATUSES.map((value) => ({ value, label: t(`transfers.statuses.${value}`) })),
        ]}
        onChange={setShow}
      />
      {isError && <p className="text-body-sm text-crit">{t('transfers.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('transfers.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/stock/transfers/$transferId', params: { transferId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ArrowDataTransferHorizontalIcon}
              title={t('transfers.emptyTitle')}
              description={t('transfers.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

`apps/app/src/routes/stock-transfer.tsx`:

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink, useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockTransferQuery, unitsQuery } from '../lib/queries';

// Like the adjustment page: data first, then the draft form or the view (with the receipt form)
const TransferForm = lazy(async () => ({
  default: (await import('../components/transfer-form')).TransferForm,
}));
const TransferView = lazy(async () => ({
  default: (await import('../components/transfer-view')).TransferView,
}));

function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

export function NewStockTransferPage() {
  const { t } = useLocale();
  const canWrite = useCan()('inventory.stock.transfer');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/transfers" label={t('transfers.back')} />
        <p className="text-body-sm text-ink-3">{t('transfers.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <TransferForm transfer={null} today={today} />
    </Suspense>
  );
}

export function StockTransferPage() {
  const { t } = useLocale();
  const { transferId = '' } = useParams({ strict: false });
  const canWrite = useCan()('inventory.stock.transfer');
  const today = useToday();
  const ready = useReady();
  const { data: transfer, isError } = useQuery({
    ...stockTransferQuery(useTenantId(), transferId),
    enabled: transferId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/transfers" label={t('transfers.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('transfers.draftTitle')}
          description={t('transfers.notFound')}
        />
      </div>
    );
  }
  if (!transfer || !ready) return null;
  if (transfer.status === 'draft' && canWrite) {
    return (
      <Suspense fallback={null}>
        <TransferForm
          key={`${transfer.id}-${String(transfer.version)}`}
          transfer={transfer}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <TransferView
        key={`${transfer.id}-${String(transfer.version)}`}
        transfer={transfer}
        canReceive={canWrite}
        today={today}
      />
    </Suspense>
  );
}
```

`apps/app/src/routes/stock-batches.tsx`:

```tsx
import { HourglassIcon } from '@hugeicons/core-free-icons';
import type { BatchStock } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  ExpiryPill,
  useQuantity,
  useTenantId,
  useToday,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from '../components/stock-parts';
import { batchStockQuery } from '../lib/queries';

const column = dataTableColumns<BatchStock>();

// The windows a pharma depot works with: what to sell or return to the principal first
const WINDOWS = { all: null, d30: 30, d60: 60, d90: 90 } as const;
type ExpiryWindow = keyof typeof WINDOWS;
const WINDOW_KEYS = ['all', 'd30', 'd60', 'd90'] as const satisfies readonly ExpiryWindow[];

export function StockBatchesPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const quantity = useQuantity();
  const today = useToday();
  const { active, byId } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [within, setWithin] = useState<ExpiryWindow>('d90');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    batchStockQuery(useTenantId(), { warehouseId, expiresWithin: WINDOWS[within] }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('expiry.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('lotNumber', {
          header: t('expiry.columns.lot'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="font-mono">{getValue()}</span>,
        }),
        column.accessor('warehouseId', {
          header: t('expiry.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => byId.get(getValue())?.code ?? '—',
        }),
        column.accessor('expiresOn', {
          header: t('expiry.columns.expires'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <ExpiryPill expiresOn={getValue()} today={today} />,
        }),
        column.accessor('quantity', {
          header: t('expiry.columns.quantity'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {quantity(row.original.quantity, row.original.baseUnitId)}
            </span>
          ),
        }),
      ]),
    [t, quantity, today, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('expiry.title')} description={t('expiry.description')} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-64">
          <Select
            aria-label={t('stock.warehouse')}
            options={[
              { value: '', label: t('stock.allWarehouses') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            value={warehouseId}
            onChange={(event) => {
              setWarehouseId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('expiry.within')}
          value={within}
          options={WINDOW_KEYS.map((value) => ({ value, label: t(`expiry.windows.${value}`) }))}
          onChange={setWithin}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('expiry.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('expiry.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => `${row.batchId}-${row.warehouseId}`}
          onRowClick={(row) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: row.variantId } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={HourglassIcon}
              title={t('expiry.emptyTitle')}
              description={t('expiry.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

`apps/app/src/routes/stock-reorder.tsx`:

```tsx
import { PackageOutOfStockIcon } from '@hugeicons/core-free-icons';
import { isZeroQuantity, type ReorderItem } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, Select } from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import {
  useQuantity,
  useTenantId,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from '../components/stock-parts';
import { reorderQuery } from '../lib/queries';

const column = dataTableColumns<ReorderItem>();

// The list a purchase officer works from: what fell to its level, where, and how much to order.
// From step 17 a row will turn into a purchase requisition.
export function StockReorderPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const quantity = useQuantity();
  const { active, byId } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    reorderQuery(useTenantId(), warehouseId),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('reorder.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('warehouseId', {
          header: t('reorder.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('onHand', {
          header: t('reorder.columns.onHand'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => (
            <span className="font-medium tabular-nums">
              {quantity(row.original.onHand, row.original.baseUnitId)}
            </span>
          ),
        }),
        column.accessor('inTransit', {
          header: t('reorder.columns.inTransit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) =>
            isZeroQuantity(row.original.inTransit)
              ? '—'
              : quantity(row.original.inTransit, row.original.baseUnitId),
        }),
        column.accessor('minQuantity', {
          header: t('reorder.columns.level'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) => quantity(row.original.minQuantity, row.original.baseUnitId),
        }),
        column.accessor('reorderQuantity', {
          header: t('reorder.columns.order'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) =>
            row.original.reorderQuantity === null
              ? '—'
              : quantity(row.original.reorderQuantity, row.original.baseUnitId),
        }),
      ]),
    [t, quantity, byId],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('reorder.title')} description={t('reorder.description')} />
      <div className="min-w-0 sm:max-w-sm">
        <Select
          aria-label={t('stock.warehouse')}
          options={[
            { value: '', label: t('stock.allWarehouses') },
            ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
          ]}
          value={warehouseId}
          onChange={(event) => {
            setWarehouseId(event.target.value);
          }}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('reorder.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('reorder.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => `${row.variantId}-${row.warehouseId}`}
          onRowClick={(row) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: row.variantId } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={PackageOutOfStockIcon}
              title={t('reorder.emptyTitle')}
              description={t('reorder.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

### Routes, navigation, the bell, settings, `main.tsx`

`apps/app/src/router.tsx` (changed):

```diff
@@ -228,6 +228,78 @@ const productImportsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/product-imports'), 'ProductImportsPage'),
 });
 
+// Warehouses and stock (step 13). The fixed segments ('/stock/adjustments', '/stock/transfers',
+// '/stock/batches', '/stock/reorder', and their '/new') beat '/stock/$variantId' and the document
+// ids, like '/products/new' beats '/products/$productId'.
+const warehousesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/warehouses',
+  component: lazyRouteComponent(() => import('./routes/warehouses'), 'WarehousesPage'),
+});
+
+const stockRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock',
+  component: lazyRouteComponent(() => import('./routes/stock'), 'StockPage'),
+});
+
+const stockCardRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/$variantId',
+  component: lazyRouteComponent(() => import('./routes/stock-card'), 'StockCardPage'),
+});
+
+const stockAdjustmentsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/adjustments',
+  component: lazyRouteComponent(() => import('./routes/stock-adjustments'), 'StockAdjustmentsPage'),
+});
+
+const newStockAdjustmentRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/adjustments/new',
+  component: lazyRouteComponent(
+    () => import('./routes/stock-adjustment'),
+    'NewStockAdjustmentPage',
+  ),
+});
+
+const stockAdjustmentRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/adjustments/$adjustmentId',
+  component: lazyRouteComponent(() => import('./routes/stock-adjustment'), 'StockAdjustmentPage'),
+});
+
+const stockTransfersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/transfers',
+  component: lazyRouteComponent(() => import('./routes/stock-transfers'), 'StockTransfersPage'),
+});
+
+const newStockTransferRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/transfers/new',
+  component: lazyRouteComponent(() => import('./routes/stock-transfer'), 'NewStockTransferPage'),
+});
+
+const stockTransferRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/transfers/$transferId',
+  component: lazyRouteComponent(() => import('./routes/stock-transfer'), 'StockTransferPage'),
+});
+
+const stockBatchesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/batches',
+  component: lazyRouteComponent(() => import('./routes/stock-batches'), 'StockBatchesPage'),
+});
+
+const stockReorderRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/reorder',
+  component: lazyRouteComponent(() => import('./routes/stock-reorder'), 'StockReorderPage'),
+});
+
 const customFieldsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/custom-fields',
@@ -291,6 +363,17 @@ const routeTree = rootRoute.addChildren([
     productCategoriesRoute,
     unitsRoute,
     productImportsRoute,
+    warehousesRoute,
+    stockRoute,
+    stockCardRoute,
+    stockAdjustmentsRoute,
+    newStockAdjustmentRoute,
+    stockAdjustmentRoute,
+    stockTransfersRoute,
+    newStockTransferRoute,
+    stockTransferRoute,
+    stockBatchesRoute,
+    stockReorderRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
```

`apps/app/src/routes/app-shell.tsx` (changed):

```diff
@@ -1,4 +1,5 @@
 import {
+  ArrowDataTransferHorizontalIcon,
   BalanceScaleIcon,
   Book02Icon,
   BookOpen02Icon,
@@ -8,21 +9,26 @@ import {
   FileDownloadIcon,
   FileImportIcon,
   FolderTreeIcon,
+  HourglassIcon,
+  Layers01Icon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
   Notebook02Icon,
   PackageIcon,
+  PackageOutOfStockIcon,
   PieChartIcon,
   RulerIcon,
   SecurityCheckIcon,
   Settings02Icon,
   Store01Icon,
   TableIcon,
+  TaskEdit01Icon,
   TextIcon,
   UnfoldMoreIcon,
   UserCircleIcon,
   UserGroupIcon,
+  WarehouseIcon,
   WorkHistoryIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
@@ -301,6 +307,28 @@ export function AppShell() {
               </NavLink>
             )}
           </NavGroup>
+          {/* Stock (step 13): everyone reads it — a sales officer checks it before promising a
+              delivery. Adjusting and moving it is checked on the pages and by the API. */}
+          <NavGroup label={t('nav.stock')}>
+            <NavLink to="/stock" icon={Layers01Icon} activeOptions={{ exact: true }}>
+              {t('nav.stockOnHand')}
+            </NavLink>
+            <NavLink to="/stock/adjustments" icon={TaskEdit01Icon}>
+              {t('nav.adjustments')}
+            </NavLink>
+            <NavLink to="/stock/transfers" icon={ArrowDataTransferHorizontalIcon}>
+              {t('nav.transfers')}
+            </NavLink>
+            <NavLink to="/stock/batches" icon={HourglassIcon}>
+              {t('nav.expiry')}
+            </NavLink>
+            <NavLink to="/stock/reorder" icon={PackageOutOfStockIcon}>
+              {t('nav.reorder')}
+            </NavLink>
+            <NavLink to="/warehouses" icon={WarehouseIcon}>
+              {t('nav.warehouses')}
+            </NavLink>
+          </NavGroup>
           <NavGroup label={t('nav.workspace')}>
             {(can('core.user.read') || can('core.user.invite')) && (
               <NavLink to="/team" icon={UserGroupIcon}>
```

A "Stock" group of its own, visible to every member: reading stock needs no permission. The pages hide the buttons a
person cannot use, and the API refuses them anyway.

`apps/app/src/components/notification-bell.tsx` (changed):

```diff
@@ -30,6 +30,7 @@ const TARGET = {
   'report.failed': '/reports/exports',
   'import.done': '/products/imports',
   'import.failed': '/products/imports',
+  'stock.low': '/stock/reorder',
 } as const satisfies Record<NotificationType, string>;
 
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
```

`apps/app/src/routes/settings.tsx` (changed):

```diff
@@ -26,6 +26,7 @@ import {
   Button,
   Card,
   CardHeader,
+  Checkbox,
   FormAlert,
   PageHeader,
   SelectField,
@@ -35,7 +36,7 @@ import {
 } from '@omnivo/ui';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { type ChangeEvent, useMemo, useRef } from 'react';
-import { useForm } from 'react-hook-form';
+import { Controller, useForm } from 'react-hook-form';
 
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
@@ -65,6 +66,7 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
   const queryClient = useQueryClient();
   const {
     register,
+    control,
     handleSubmit,
     reset,
     setError,
@@ -209,6 +211,34 @@ function SettingsForm({ settings, canManage }: { settings: Settings; canManage:
             />
           </div>
         </Card>
+
+        {/* Step 13. A checkbox, not a switch: it is saved with the rest of the form. */}
+        <Card>
+          <CardHeader
+            title={t('settings.inventoryTitle')}
+            subtitle={t('settings.inventorySubtitle')}
+          />
+          <div className="grid gap-2 p-5">
+            <Controller
+              control={control}
+              name="allowNegativeStock"
+              render={({ field }) => (
+                <Checkbox
+                  id="allowNegativeStock"
+                  label={t('settings.allowNegativeStock')}
+                  checked={field.value}
+                  disabled={!canManage}
+                  onCheckedChange={(checked) => {
+                    field.onChange(checked === true);
+                  }}
+                />
+              )}
+            />
+            <p className="pl-[27px] text-label text-ink-3">
+              {t('settings.allowNegativeStockHint')}
+            </p>
+          </div>
+        </Card>
       </fieldset>
 
       {canManage ? (
```

`apps/app/src/main.tsx` (changed):

```diff
@@ -1,6 +1,6 @@
 import './styles.css';
 // প্রথম render-এর আগে i18n init — নাহলে প্রথম ঝলকে key ("nav.overview") দেখা যেত
-import '@omnivo/i18n';
+import { languageReady } from '@omnivo/i18n';
 
 import { Toaster } from '@omnivo/ui';
 import { QueryClientProvider } from '@tanstack/react-query';
@@ -30,8 +30,9 @@ if (!rootElement) {
   throw new Error('Root element #root is missing from index.html');
 }
 
-// worker চালু হওয়ার পরে render — নাহলে প্রথম request (session ফেরানো) mock-এর আগেই বেরিয়ে যেত
-void enableMocking().then(() => {
+// worker চালু হওয়ার পরে render — নাহলে প্রথম request (session ফেরানো) mock-এর আগেই বেরিয়ে যেত.
+// And after this device's language has arrived (Bangla is its own chunk since step 13).
+void Promise.all([enableMocking(), languageReady]).then(() => {
   createRoot(rootElement).render(
     <StrictMode>
       <QueryClientProvider client={queryClient}>
```

`apps/app/src/components/report-parts.tsx` (changed):

```diff
@@ -19,7 +19,6 @@ import {
 import { useLocale } from '@omnivo/i18n';
 import {
   Button,
-  Card,
   cn,
   DatePicker,
   DropdownMenu,
@@ -208,27 +207,6 @@ export function BalancePill({ difference }: { difference: string }) {
   );
 }
 
-// CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line
-export function KpiStrip({
-  cells,
-}: {
-  cells: { label: string; value: string; sub?: string | undefined }[];
-}) {
-  return (
-    <Card className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
-      {cells.map((cell) => (
-        <div key={cell.label} className="grid gap-1 px-5 py-4">
-          <span className="text-caption text-ink-3">{cell.label}</span>
-          <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
-          {cell.sub !== undefined && (
-            <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
-          )}
-        </div>
-      ))}
-    </Card>
-  );
-}
-
 // ---------------------------------------------------------------------------------------------
 // The statement table: a real <table> (screen readers read rows and column headers), inside a card
 // that scrolls sideways on its own when the columns do not fit (CLAUDE.md → Page gutters). The
```

`apps/app/src/routes/balance-sheet.tsx` (changed):

```diff
@@ -1,7 +1,7 @@
 import { PieChartIcon } from '@hugeicons/core-free-icons';
 import { addMoney, type BalanceSheetQuery, fiscalYearOf, subtractMoney } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { DatePicker, EmptyState, Field, PageHeader, SelectField } from '@omnivo/ui';
+import { DatePicker, EmptyState, Field, KpiStrip, PageHeader, SelectField } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { useState } from 'react';
 
@@ -9,7 +9,6 @@ import { useIsoDate } from '../components/journal-parts';
 import {
   BalancePill,
   ExportMenu,
-  KpiStrip,
   sectionRows,
   type StatementRow,
   StatementTable,
```

`apps/app/src/routes/profit-and-loss.tsx` (changed):

```diff
@@ -1,14 +1,13 @@
 import { ChartIncreaseIcon } from '@hugeicons/core-free-icons';
 import type { ProfitAndLossQuery } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
-import { EmptyState, PageHeader, SelectField } from '@omnivo/ui';
+import { EmptyState, KpiStrip, PageHeader, SelectField } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { useState } from 'react';
 
 import { useIsoDate } from '../components/journal-parts';
 import {
   ExportMenu,
-  KpiStrip,
   PeriodFields,
   sectionRows,
   StatementTable,
```

---

## 13.9 — MSW: stock in the mocks

`apps/app/src/mocks/stock-data.ts`:

```ts
import {
  addQuantity,
  type BatchStock,
  compareQuantity,
  defaultNumberFormat,
  type ErrorCode,
  fitsDecimals,
  formatDocumentNumber,
  isQuantity,
  isWholeQuantity,
  type MovementKind,
  negateQuantity,
  periodOf,
  type Product,
  type ProductVariant,
  type ReorderItem,
  type ReorderLevelInput,
  type StockAdjustment,
  type StockAdjustmentInput,
  type StockCard,
  type StockItem,
  type StockLine,
  type StockListQuery,
  type StockMovement,
  type StockTransfer,
  type StockTransferInput,
  sumQuantity,
  toBaseQuantity,
  todayIn,
  type TransferLine,
  type Warehouse,
  wholeCount,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import type { WorkspaceData } from './workspace-data';

// The mock's stock: warehouses, the movements (the ledger), batches, serial numbers, reorder
// levels, adjustments and transfers. Balances are added up from the movements on every read —
// a few hundred rows, no need for the API's stock_balances. The rules the UI shows errors for are
// the API's (stock_insufficient, lots, serial numbers, receipts); the rest is kept simple.

interface MockMovement {
  id: string;
  date: string;
  warehouseId: string;
  productId: string;
  variantId: string;
  batchId: string | null;
  serialNumber: string | null;
  quantity: string;
  kind: MovementKind;
  documentId: string;
  documentNumber: string;
}

interface MockBatch {
  id: string;
  variantId: string;
  lotNumber: string;
  manufacturedOn: string | null;
  expiresOn: string | null;
}

export interface MockStock {
  warehouses: Warehouse[];
  movements: MockMovement[];
  batches: MockBatch[];
  // variant|serial → its warehouse now (null = not in stock)
  serials: Map<string, string | null>;
  levels: {
    warehouseId: string;
    variantId: string;
    minQuantity: string;
    reorderQuantity: string | null;
  }[];
  adjustments: StockAdjustment[];
  transfers: StockTransfer[];
  counters: { adjustment: number; transfer: number };
}

export function emptyStock(): MockStock {
  return {
    warehouses: [],
    movements: [],
    batches: [],
    serials: new Map(),
    levels: [],
    adjustments: [],
    transfers: [],
    counters: { adjustment: 0, transfer: 0 },
  };
}

function now(): string {
  return new Date().toISOString();
}

export function warehouse(
  branchId: string,
  code: string,
  name: string,
  address: string | null,
): Warehouse {
  return {
    id: crypto.randomUUID(),
    branchId,
    code,
    name,
    address,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

// --- Variants -----------------------------------------------------------------------------------

function findVariant(
  data: WorkspaceData,
  variantId: string,
): { product: Product; variant: ProductVariant } | undefined {
  for (const product of data.catalog.products) {
    const variant = product.variants.find((candidate) => candidate.id === variantId);
    if (variant) return { product, variant };
  }
  return undefined;
}

function decimalsOf(data: WorkspaceData, unitId: string): number {
  return data.catalog.units.find((unit) => unit.id === unitId)?.decimals ?? 0;
}

// warehouse|variant → on hand, and warehouse|variant|batch → on hand, from every movement
function balancesOf(stock: MockStock) {
  const byPlace = new Map<string, string>();
  const byBatch = new Map<string, string>();
  for (const movement of stock.movements) {
    const place = `${movement.warehouseId}|${movement.variantId}`;
    byPlace.set(place, addQuantity(byPlace.get(place) ?? '0', movement.quantity));
    const batch = `${place}|${movement.batchId ?? ''}`;
    byBatch.set(batch, addQuantity(byBatch.get(batch) ?? '0', movement.quantity));
  }
  return { byPlace, byBatch };
}

function onHand(
  stock: MockStock,
  balances: ReturnType<typeof balancesOf>,
  variantId: string,
  warehouseId: string | undefined,
): string {
  const places =
    warehouseId === undefined ? stock.warehouses.map((place) => place.id) : [warehouseId];
  return sumQuantity(places.map((place) => balances.byPlace.get(`${place}|${variantId}`) ?? '0'));
}

function inTransit(stock: MockStock, variantId: string, toWarehouseId: string | undefined): string {
  return sumQuantity(
    stock.transfers
      .filter(
        (transfer) =>
          transfer.status === 'in_transit' &&
          (toWarehouseId === undefined || transfer.toWarehouseId === toWarehouseId),
      )
      .flatMap((transfer) =>
        transfer.lines
          .filter((line) => line.variantId === variantId)
          .map((line) => line.baseQuantity),
      ),
  );
}

function isLow(
  stock: MockStock,
  balances: ReturnType<typeof balancesOf>,
  variantId: string,
  warehouseId: string | undefined,
): boolean {
  return stock.levels.some(
    (level) =>
      level.variantId === variantId &&
      (warehouseId === undefined || level.warehouseId === warehouseId) &&
      compareQuantity(
        balances.byPlace.get(`${level.warehouseId}|${variantId}`) ?? '0',
        level.minQuantity,
      ) <= 0,
  );
}

function refOf(product: Product, variant: ProductVariant) {
  return {
    variantId: variant.id,
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: product.baseUnitId,
  };
}

function itemOf(
  data: WorkspaceData,
  balances: ReturnType<typeof balancesOf>,
  product: Product,
  variant: ProductVariant,
  warehouseId: string | undefined,
): StockItem {
  const { stock } = data;
  return {
    ...refOf(product, variant),
    tracking: product.tracking,
    hasExpiry: product.hasExpiry,
    units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    archived: product.archivedAt !== null || variant.archivedAt !== null,
    onHand: onHand(stock, balances, variant.id, warehouseId),
    inTransit: inTransit(stock, variant.id, warehouseId),
    low: isLow(stock, balances, variant.id, warehouseId),
  };
}

// --- Reading ------------------------------------------------------------------------------------

export function listStock(
  data: WorkspaceData,
  query: StockListQuery & { filter: string },
): StockItem[] {
  const balances = balancesOf(data.stock);
  const search = query.search?.trim().toLowerCase() ?? '';
  const categories = new Set<string>();
  if (query.categoryId !== undefined) {
    // The category and everything under it, like the API
    const walk = (id: string) => {
      categories.add(id);
      data.catalog.categories
        .filter((category) => category.parentId === id)
        .forEach((child) => {
          walk(child.id);
        });
    };
    walk(query.categoryId);
  }
  return data.catalog.products
    .filter((product) => product.type === 'goods')
    .filter(
      (product) =>
        query.categoryId === undefined ||
        (product.categoryId !== null && categories.has(product.categoryId)),
    )
    .toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .flatMap((product) =>
      product.variants
        .filter((variant) => {
          if (search === '') return true;
          const serial = data.stock.serials.has(`${variant.id}|${query.search?.trim() ?? ''}`);
          return (
            product.name.toLowerCase().includes(search) ||
            product.code.toLowerCase().includes(search) ||
            variant.sku.toLowerCase().includes(search) ||
            variant.barcode === query.search?.trim() ||
            serial
          );
        })
        .map((variant) => itemOf(data, balances, product, variant, query.warehouseId)),
    )
    .filter((item) => !item.archived || compareQuantity(item.onHand, '0') !== 0)
    .filter((item) => query.filter !== 'in_stock' || compareQuantity(item.onHand, '0') > 0)
    .filter((item) => query.filter !== 'low' || item.low);
}

export function cardOf(data: WorkspaceData, variantId: string): StockCard {
  const found = findVariant(data, variantId);
  if (found?.product.type !== 'goods') throw new MockProblem(404, 'not_found');
  const { stock } = data;
  const balances = balancesOf(stock);
  const places = stock.warehouses.filter(
    (place) =>
      place.archivedAt === null ||
      compareQuantity(balances.byPlace.get(`${place.id}|${variantId}`) ?? '0', '0') !== 0,
  );
  return {
    item: itemOf(data, balances, found.product, found.variant, undefined),
    warehouses: places.map((place) => {
      const level = stock.levels.find(
        (row) => row.warehouseId === place.id && row.variantId === variantId,
      );
      return {
        warehouseId: place.id,
        onHand: onHand(stock, balances, variantId, place.id),
        inTransit: inTransit(stock, variantId, place.id),
        minQuantity: level?.minQuantity ?? null,
        reorderQuantity: level?.reorderQuantity ?? null,
      };
    }),
    batches: stock.batches
      .filter((batch) => batch.variantId === variantId)
      .flatMap((batch) =>
        stock.warehouses.flatMap((place) => {
          const quantity = balances.byBatch.get(`${place.id}|${variantId}|${batch.id}`) ?? '0';
          return compareQuantity(quantity, '0') > 0
            ? [
                {
                  batchId: batch.id,
                  lotNumber: batch.lotNumber,
                  manufacturedOn: batch.manufacturedOn,
                  expiresOn: batch.expiresOn,
                  warehouseId: place.id,
                  quantity,
                },
              ]
            : [];
        }),
      )
      // FEFO: the batch that expires first on top, no expiry last
      .toSorted((a, b) => (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31')),
    serials: [...stock.serials]
      .filter(([key]) => key.startsWith(`${variantId}|`))
      .flatMap(([key, warehouseId]) => {
        const serialNumber = key.slice(variantId.length + 1);
        const travelling = stock.transfers.some(
          (transfer) =>
            transfer.status === 'in_transit' &&
            transfer.lines.some(
              (line) => line.variantId === variantId && line.serialNumbers.includes(serialNumber),
            ),
        );
        return warehouseId !== null || travelling ? [{ serialNumber, warehouseId }] : [];
      })
      .toSorted((a, b) => a.serialNumber.localeCompare(b.serialNumber)),
  };
}

export function movementsOf(
  data: WorkspaceData,
  variantId: string,
  query: { warehouseId?: string | undefined; from?: string | undefined; to?: string | undefined },
): { items: StockMovement[]; openingBalance: string; closingBalance: string } {
  if (!findVariant(data, variantId)) throw new MockProblem(404, 'not_found');
  const rows = data.stock.movements.filter(
    (movement) =>
      movement.variantId === variantId &&
      (query.warehouseId === undefined || movement.warehouseId === query.warehouseId),
  );
  const before = rows.filter((row) => query.from !== undefined && row.date < query.from);
  const shown = rows.filter(
    (row) =>
      (query.from === undefined || row.date >= query.from) &&
      (query.to === undefined || row.date <= query.to),
  );
  const openingBalance = sumQuantity(before.map((row) => row.quantity));
  let balance = openingBalance;
  const items = shown.map((row) => {
    balance = addQuantity(balance, row.quantity);
    return {
      id: row.id,
      date: row.date,
      warehouseId: row.warehouseId,
      kind: row.kind,
      documentId: row.documentId,
      documentNumber: row.documentNumber,
      quantity: row.quantity,
      balance,
      lotNumber: data.stock.batches.find((batch) => batch.id === row.batchId)?.lotNumber ?? null,
      serialNumber: row.serialNumber,
    };
  });
  const closingBalance = sumQuantity(
    rows.filter((row) => query.to === undefined || row.date <= query.to).map((row) => row.quantity),
  );
  return { items, openingBalance, closingBalance };
}

export function batchReport(
  data: WorkspaceData,
  query: { warehouseId?: string | undefined; expiresWithin?: number | undefined },
): BatchStock[] {
  const today = todayIn(data.settings.timezone);
  const until =
    query.expiresWithin === undefined
      ? null
      : new Date(Date.parse(`${today}T00:00:00Z`) + query.expiresWithin * 86_400_000)
          .toISOString()
          .slice(0, 10);
  const balances = balancesOf(data.stock);
  return data.stock.batches
    .filter((batch) => until === null || (batch.expiresOn !== null && batch.expiresOn <= until))
    .flatMap((batch) => {
      const found = findVariant(data, batch.variantId);
      if (!found) return [];
      return data.stock.warehouses
        .filter((place) => query.warehouseId === undefined || place.id === query.warehouseId)
        .flatMap((place) => {
          const quantity =
            balances.byBatch.get(`${place.id}|${batch.variantId}|${batch.id}`) ?? '0';
          return compareQuantity(quantity, '0') > 0
            ? [
                {
                  ...refOf(found.product, found.variant),
                  batchId: batch.id,
                  lotNumber: batch.lotNumber,
                  manufacturedOn: batch.manufacturedOn,
                  expiresOn: batch.expiresOn,
                  warehouseId: place.id,
                  quantity,
                },
              ]
            : [];
        });
    })
    .toSorted((a, b) => (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'));
}

export function reorderReport(data: WorkspaceData, warehouseId: string | undefined): ReorderItem[] {
  const balances = balancesOf(data.stock);
  return data.stock.levels
    .filter((level) => warehouseId === undefined || level.warehouseId === warehouseId)
    .flatMap((level) => {
      const found = findVariant(data, level.variantId);
      const here = balances.byPlace.get(`${level.warehouseId}|${level.variantId}`) ?? '0';
      if (!found || compareQuantity(here, level.minQuantity) > 0) return [];
      return [
        {
          ...refOf(found.product, found.variant),
          warehouseId: level.warehouseId,
          onHand: here,
          inTransit: inTransit(data.stock, level.variantId, level.warehouseId),
          minQuantity: level.minQuantity,
          reorderQuantity: level.reorderQuantity,
        },
      ];
    });
}

export function setLevel(data: WorkspaceData, input: ReorderLevelInput) {
  const { stock } = data;
  stock.levels = stock.levels.filter(
    (level) => !(level.warehouseId === input.warehouseId && level.variantId === input.variantId),
  );
  if (input.minQuantity !== null) {
    stock.levels.push({
      warehouseId: input.warehouseId,
      variantId: input.variantId,
      minQuantity: input.minQuantity,
      reorderQuantity: input.reorderQuantity,
    });
  }
  return {
    warehouseId: input.warehouseId,
    variantId: input.variantId,
    minQuantity: input.minQuantity,
    reorderQuantity: input.minQuantity === null ? null : input.reorderQuantity,
  };
}

// --- Documents ----------------------------------------------------------------------------------

interface LineInput {
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: string[];
  lotNumber?: string | null;
  expiresOn?: string | null;
  manufacturedOn?: string | null;
}

function issuesError(issues: { path: string; code: ErrorCode }[]): MockProblem {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
  return new MockProblem(409, issues[0]?.code ?? 'invalid_input', fieldErrors);
}

// The API's line rules (stock-lines.ts), shortened: a stocked product, its unit, the decimals,
// and what its tracking asks for. Returns the lines as the API stores them.
function resolveLines(
  data: WorkspaceData,
  lines: readonly LineInput[],
  mode: 'in' | 'out',
): StockLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((line, index): StockLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, line.variantId);
    if (found?.product.type !== 'goods') {
      at('variantId', 'stock_variant_invalid');
      return [];
    }
    const { product, variant } = found;
    const factor =
      line.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === line.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!isQuantity(line.quantity)) {
      at('quantity', 'quantity_format');
      return [];
    }
    if (!fitsDecimals(line.quantity, decimalsOf(data, line.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const baseQuantity = toBaseQuantity(
      line.quantity,
      factor,
      decimalsOf(data, product.baseUnitId),
    );
    let batch: MockBatch | undefined;
    if (product.tracking === 'batch' && mode === 'in' && !line.lotNumber)
      at('lotNumber', 'stock_lot_required');
    if (product.tracking === 'batch' && mode === 'out') {
      batch = data.stock.batches.find((candidate) => candidate.id === line.batchId);
      if (line.batchId === null) at('batchId', 'stock_batch_required');
      else if (batch?.variantId !== variant.id) at('batchId', 'stock_batch_invalid');
    }
    if (
      product.tracking === 'serial' &&
      (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== line.serialNumbers.length)
    ) {
      at('serialNumbers', 'stock_serial_count');
    }
    return [
      {
        ...refOf(product, variant),
        id: crypto.randomUUID(),
        tracking: product.tracking,
        hasExpiry: product.hasExpiry,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: line.unitId,
        quantity: addQuantity(line.quantity, '0'),
        baseQuantity,
        batchId: product.tracking === 'batch' && mode === 'out' ? line.batchId : null,
        lotNumber:
          product.tracking === 'batch'
            ? mode === 'in'
              ? (line.lotNumber ?? null)
              : (batch?.lotNumber ?? null)
            : null,
        expiresOn:
          product.tracking === 'batch'
            ? mode === 'in'
              ? (line.expiresOn ?? null)
              : (batch?.expiresOn ?? null)
            : null,
        manufacturedOn:
          mode === 'in' ? (line.manufacturedOn ?? null) : (batch?.manufacturedOn ?? null),
        serialNumbers: product.tracking === 'serial' ? line.serialNumbers : [],
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

function assertWarehouses(data: WorkspaceData, places: { field: string; id: string }[]): void {
  const bad = places.filter(
    (place) => !data.stock.warehouses.some((row) => row.id === place.id && row.archivedAt === null),
  );
  if (bad.length > 0) {
    throw new MockProblem(
      409,
      'stock_warehouse_invalid',
      Object.fromEntries(bad.map((place) => [place.field, ['stock_warehouse_invalid' as const]])),
    );
  }
}

function assertDate(data: WorkspaceData, date: string): void {
  if (date > todayIn(data.settings.timezone)) {
    throw new MockProblem(409, 'stock_date_future', { date: ['stock_date_future'] });
  }
}

function nextNumber(
  data: WorkspaceData,
  type: 'inventory.adjustment' | 'inventory.transfer',
  date: string,
): string {
  const format = defaultNumberFormat(type);
  const key = type === 'inventory.adjustment' ? 'adjustment' : 'transfer';
  data.stock.counters[key] += 1;
  return formatDocumentNumber(
    format,
    periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth),
    data.stock.counters[key],
  );
}

interface Move {
  line: number;
  warehouseId: string;
  stockLine: StockLine;
  batchId: string | null;
  quantity: string;
  serialNumbers: string[];
}

// The API's StockPostingService.post(), shortened: serial numbers and stock checked, then the
// movements written (one per serial number for a serial product)
function postMoves(
  data: WorkspaceData,
  posting: {
    date: string;
    kind: MovementKind;
    direction: 'in' | 'out';
    documentId: string;
    number: string;
  },
  moves: readonly Move[],
  receivingTransferId?: string,
): void {
  const { stock } = data;
  const issues: { path: string; code: ErrorCode }[] = [];
  const balances = balancesOf(stock);
  const wanted = new Map<string, string>();
  for (const move of moves) {
    const key = `${move.warehouseId}|${move.stockLine.variantId}|${move.batchId ?? ''}`;
    wanted.set(key, addQuantity(wanted.get(key) ?? '0', move.quantity));
  }
  for (const move of moves) {
    const travelling = (serial: string) =>
      stock.transfers.some(
        (transfer) =>
          transfer.id !== receivingTransferId &&
          transfer.status === 'in_transit' &&
          transfer.lines.some(
            (line) =>
              line.variantId === move.stockLine.variantId && line.serialNumbers.includes(serial),
          ),
      );
    const badSerial = move.serialNumbers.some((serial) => {
      const at = stock.serials.get(`${move.stockLine.variantId}|${serial}`);
      return posting.direction === 'in'
        ? (at !== undefined && at !== null) || travelling(serial)
        : at !== move.warehouseId;
    });
    if (badSerial) {
      issues.push({
        path: `lines.${String(move.line)}.serialNumbers`,
        code: posting.direction === 'in' ? 'stock_serial_in_stock' : 'stock_serial_not_here',
      });
    }
    if (posting.direction === 'out') {
      const key = `${move.warehouseId}|${move.stockLine.variantId}|${move.batchId ?? ''}`;
      const allowed = move.stockLine.tracking === 'none' && data.settings.allowNegativeStock;
      if (
        !allowed &&
        compareQuantity(balances.byBatch.get(key) ?? '0', wanted.get(key) ?? '0') < 0
      ) {
        issues.push({ path: `lines.${String(move.line)}.quantity`, code: 'stock_insufficient' });
      }
    }
  }
  if (issues.length > 0) throw issuesError(issues);

  for (const move of moves) {
    const base = {
      date: posting.date,
      warehouseId: move.warehouseId,
      productId: move.stockLine.productId,
      variantId: move.stockLine.variantId,
      batchId: move.batchId,
      kind: posting.kind,
      documentId: posting.documentId,
      documentNumber: posting.number,
    };
    if (move.serialNumbers.length > 0) {
      for (const serial of move.serialNumbers) {
        stock.movements.push({
          ...base,
          id: crypto.randomUUID(),
          serialNumber: serial,
          quantity: posting.direction === 'in' ? '1.0000' : '-1.0000',
        });
        stock.serials.set(
          `${move.stockLine.variantId}|${serial}`,
          posting.direction === 'in' ? move.warehouseId : null,
        );
      }
    } else {
      stock.movements.push({
        ...base,
        id: crypto.randomUUID(),
        serialNumber: null,
        quantity: posting.direction === 'in' ? move.quantity : negateQuantity(move.quantity),
      });
    }
  }
}

export function findAdjustment(data: WorkspaceData, id: string): StockAdjustment {
  const found = data.stock.adjustments.find((adjustment) => adjustment.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function saveAdjustment(
  data: WorkspaceData,
  input: Omit<StockAdjustmentInput, 'post'>,
  existing?: StockAdjustment,
): StockAdjustment {
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const lines = resolveLines(data, input.lines, input.direction);
  const saved: StockAdjustment = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    warehouseId: input.warehouseId,
    direction: input.direction,
    reason: input.reason,
    note: input.note,
    status: 'draft',
    lineCount: lines.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines,
  };
  data.stock.adjustments = [saved, ...data.stock.adjustments.filter((row) => row.id !== saved.id)];
  return saved;
}

export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): StockAdjustment {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.date);
  const direction = draft.direction === 'out' ? 'out' : 'in';
  // An "in" line's lot becomes a batch: an existing one of the variant, or a new one
  const issues: { path: string; code: ErrorCode }[] = [];
  const lines = draft.lines.map((line, index) => {
    if (direction !== 'in' || line.lotNumber === null) return line;
    const lot = line.lotNumber;
    let batch = data.stock.batches.find(
      (candidate) =>
        candidate.variantId === line.variantId &&
        candidate.lotNumber.toLowerCase() === lot.toLowerCase(),
    );
    if (!batch) {
      if (line.hasExpiry && line.expiresOn === null) {
        issues.push({ path: `lines.${String(index)}.expiresOn`, code: 'stock_expiry_required' });
        return line;
      }
      batch = {
        id: crypto.randomUUID(),
        variantId: line.variantId,
        lotNumber: lot,
        manufacturedOn: line.manufacturedOn,
        expiresOn: line.expiresOn,
      };
      data.stock.batches.push(batch);
    } else if (line.expiresOn !== null && line.expiresOn !== batch.expiresOn) {
      issues.push({
        path: `lines.${String(index)}.expiresOn`,
        code: 'stock_batch_expiry_mismatch',
      });
    }
    return { ...line, batchId: batch.id, expiresOn: batch.expiresOn };
  });
  if (issues.length > 0) throw issuesError(issues);
  const number = nextNumber(data, 'inventory.adjustment', draft.date);
  try {
    postMoves(
      data,
      { date: draft.date, kind: 'adjustment', direction, documentId: draft.id, number },
      lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    );
  } catch (error) {
    // The API's transaction gives the number back; so does the mock
    data.stock.counters.adjustment -= 1;
    throw error;
  }
  const posted: StockAdjustment = {
    ...draft,
    lines,
    number,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  };
  data.stock.adjustments = data.stock.adjustments.map((row) =>
    row.id === posted.id ? posted : row,
  );
  return posted;
}

export function findTransfer(data: WorkspaceData, id: string): StockTransfer {
  const found = data.stock.transfers.find((transfer) => transfer.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function saveTransfer(
  data: WorkspaceData,
  input: Omit<StockTransferInput, 'send'>,
  existing?: StockTransfer,
): StockTransfer {
  assertWarehouses(data, [
    { field: 'fromWarehouseId', id: input.fromWarehouseId },
    { field: 'toWarehouseId', id: input.toWarehouseId },
  ]);
  const lines: TransferLine[] = resolveLines(data, input.lines, 'out').map((line) => ({
    ...line,
    receivedQuantity: null,
    receivedSerialNumbers: null,
  }));
  const saved: StockTransfer = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    status: 'draft',
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    sentOn: input.date,
    receivedOn: null,
    note: input.note,
    lineCount: lines.length,
    short: false,
    sentAt: null,
    receivedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines,
  };
  data.stock.transfers = [saved, ...data.stock.transfers.filter((row) => row.id !== saved.id)];
  return saved;
}

export function sendTransfer(data: WorkspaceData, draft: StockTransfer): StockTransfer {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.sentOn);
  const number = nextNumber(data, 'inventory.transfer', draft.sentOn);
  try {
    postMoves(
      data,
      { date: draft.sentOn, kind: 'transfer_out', direction: 'out', documentId: draft.id, number },
      draft.lines.map((line, index) => ({
        line: index,
        warehouseId: draft.fromWarehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    );
  } catch (error) {
    data.stock.counters.transfer -= 1;
    throw error;
  }
  const sent: StockTransfer = {
    ...draft,
    number,
    status: 'in_transit',
    sentAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  };
  data.stock.transfers = data.stock.transfers.map((row) => (row.id === sent.id ? sent : row));
  return sent;
}

export function receiveTransfer(
  data: WorkspaceData,
  transfer: StockTransfer,
  input: {
    date: string;
    lines: { lineId: string; receivedQuantity: string; serialNumbers: string[] }[];
  },
): StockTransfer {
  if (transfer.status !== 'in_transit') throw new MockProblem(409, 'transfer_not_in_transit');
  if (input.date < transfer.sentOn) {
    throw new MockProblem(409, 'transfer_receive_date', { date: ['transfer_receive_date'] });
  }
  assertDate(data, input.date);
  const issues: { path: string; code: ErrorCode }[] = [];
  const lines = transfer.lines.map((line) => {
    const index = input.lines.findIndex((received) => received.lineId === line.id);
    const received = input.lines[index];
    if (!received)
      throw new MockProblem(409, 'transfer_lines_mismatch', { lines: ['transfer_lines_mismatch'] });
    if (compareQuantity(received.receivedQuantity, line.baseQuantity) > 0) {
      issues.push({
        path: `lines.${String(index)}.receivedQuantity`,
        code: 'transfer_receive_too_many',
      });
    }
    return {
      index,
      line: {
        ...line,
        receivedQuantity: addQuantity(received.receivedQuantity, '0'),
        receivedSerialNumbers: received.serialNumbers,
      },
    };
  });
  if (issues.length > 0) throw issuesError(issues);
  postMoves(
    data,
    {
      date: input.date,
      kind: 'transfer_in',
      direction: 'in',
      documentId: transfer.id,
      number: transfer.number ?? '',
    },
    lines.flatMap(({ index, line }) =>
      compareQuantity(line.receivedQuantity, '0') === 0
        ? []
        : [
            {
              line: index,
              warehouseId: transfer.toWarehouseId,
              stockLine: line,
              batchId: line.batchId,
              quantity: line.receivedQuantity,
              serialNumbers: line.receivedSerialNumbers,
            },
          ],
    ),
    transfer.id,
  );
  const received: StockTransfer = {
    ...transfer,
    lines: lines.map(({ line }) => line),
    status: 'received',
    receivedOn: input.date,
    receivedAt: now(),
    short: lines.some(({ line }) => compareQuantity(line.receivedQuantity, line.baseQuantity) < 0),
    version: transfer.version + 1,
    updatedAt: now(),
  };
  data.stock.transfers = data.stock.transfers.map((row) =>
    row.id === received.id ? received : row,
  );
  return received;
}

// --- Seed ---------------------------------------------------------------------------------------

function daysFromToday(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// What a fixture workspace starts with: its warehouses, an opening stock adjustment a week ago,
// and (garments) a truck on the road to the Chattogram depot and a low stock of mailer bags
export function seedStock(data: WorkspaceData, garments: boolean): void {
  const [ho, factory, depot] = data.branches;
  if (!ho) return;
  const today = todayIn(data.settings.timezone);
  const weekAgo = daysFromToday(today, -7);
  data.stock.warehouses =
    garments && factory && depot
      ? [
          warehouse(ho.id, 'MAIN', 'Main store', 'House 42, Road 11, Banani, Dhaka 1213'),
          warehouse(
            factory.id,
            'FG',
            'Finished goods store',
            'Shed 3, BSCIC Industrial Area, Gazipur',
          ),
          warehouse(depot.id, 'CTG', 'Chattogram depot', 'Port Connecting Road, Chattogram 4100'),
        ]
      : [warehouse(ho.id, 'MAIN', 'Main store', 'Tejgaon Industrial Area, Dhaka 1208')];
  const [main] = data.stock.warehouses;
  if (!main) return;

  const byCode = (code: string) => data.catalog.products.find((product) => product.code === code);
  type SeedLine = StockAdjustmentInput['lines'][number];
  const blank = { batchId: null, lotNumber: null, expiresOn: null, manufacturedOn: null };
  const line = (code: string, quantity: string, extra: Partial<SeedLine> = {}): SeedLine[] => {
    const product = byCode(code);
    const variant = product?.variants[0];
    if (!product || !variant) return [];
    return [
      {
        ...blank,
        variantId: variant.id,
        unitId: product.baseUnitId,
        quantity,
        serialNumbers: [],
        ...extra,
      },
    ];
  };
  const opening = (lines: SeedLine[]) =>
    postAdjustment(
      data,
      saveAdjustment(data, {
        date: weekAgo,
        warehouseId: main.id,
        direction: 'in',
        reason: 'opening',
        note: null,
        lines,
      }),
    );

  if (garments) {
    const polo = byCode('ST-118');
    opening([
      ...(polo?.variants.map((variant) => ({
        ...blank,
        variantId: variant.id,
        unitId: polo.baseUnitId,
        quantity: '120',
        serialNumbers: [],
      })) ?? []),
      ...line('P-00001', '480'),
      ...line('P-00002', '1250.5'),
      ...line('P-00003', '7200'),
      ...line('P-00004', '3000'),
      ...line('P-00005', '3', {
        serialNumbers: ['JK8000-24-0117', 'JK8000-24-0118', 'JK8000-24-0119'],
      }),
    ]);
    const mailer = byCode('P-00004')?.variants[0];
    if (mailer) {
      data.stock.levels.push({
        warehouseId: main.id,
        variantId: mailer.id,
        minQuantity: '4000',
        reorderQuantity: '10000',
      });
    }
    const depotStore = data.stock.warehouses[2];
    const tee = line('P-00001', '48');
    if (depotStore && tee.length > 0) {
      sendTransfer(
        data,
        saveTransfer(data, {
          fromWarehouseId: main.id,
          toWarehouseId: depotStore.id,
          date: daysFromToday(today, -1),
          note: 'Truck DM-TA 11-2233, driver Kamal',
          lines: tee,
        }),
      );
    }
  } else {
    opening([
      ...line('P-00001', '3000', { lotNumber: 'NP24090', expiresOn: daysFromToday(today, 25) }),
      ...line('P-00001', '12000', { lotNumber: 'NP24117', expiresOn: daysFromToday(today, 270) }),
    ]);
  }
}
```

A shorter copy of the API's rules (the mock cannot import server code): balances are added up from the movements on
every read, which is fine for a few hundred rows. The rules the UI shows errors for are the API's: not enough
stock, lots and expiry, serial numbers, receipts. The seed gives the garments workspace three warehouses, an
opening stock a week ago (with three sewing machines by serial plate), a truck on its way to Chattogram and a low
stock of mailer bags; the pharma workspace two batches of Napa, one expiring in 25 days.

`apps/app/src/mocks/workspace-data.ts` (changed):

```diff
@@ -27,6 +27,7 @@ import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import type { MockExport } from './report-data';
+import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -46,6 +47,8 @@ export interface WorkspaceData {
   exports: MockExport[];
   // Units, categories, custom fields, products and imports (step 12)
   catalog: MockCatalog;
+  // Warehouses, the stock ledger and its documents (step 13)
+  stock: MockStock;
 }
 
 function now(): string {
@@ -78,6 +81,7 @@ function seed(workspace: Workspace): WorkspaceData {
       address: null,
       ...DEFAULT_SETTINGS,
       logo: null,
+      allowNegativeStock: false,
       version: 1,
     },
     branches: garments
@@ -99,8 +103,10 @@ function seed(workspace: Workspace): WorkspaceData {
     journal: emptyJournal(),
     exports: [],
     catalog: garments ? garmentsCatalog() : pharmaCatalog(),
+    stock: emptyStock(),
   };
   if (garments) seedJournal(data);
+  seedStock(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -159,6 +165,10 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.exports = [];
   // Like the chart: the setup job brings the units and categories (settleSetup)
   data.catalog = emptyCatalog();
+  // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
+  data.stock = emptyStock();
+  const [first] = data.branches;
+  if (first) data.stock.warehouses = [warehouse(first.id, 'MAIN', 'Main store', null)];
   store.set(workspace.tenantId, data);
 }
 
@@ -220,6 +230,13 @@ export function assertCodeFree(data: WorkspaceData, code: string, except?: strin
   }
 }
 
+function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: string): number {
+  if (documentType === 'accounting.journal') return data.journal.counters.get(period) ?? 0;
+  if (documentType === 'inventory.adjustment') return data.stock.counters.adjustment;
+  if (documentType === 'inventory.transfer') return data.stock.counters.transfer;
+  return 0;
+}
+
 export function seriesList(data: WorkspaceData): NumberSeries[] {
   const period = (format: NumberFormat) =>
     periodOf(todayIn(data.settings.timezone), format.yearStyle, data.settings.fiscalYearStartMonth);
@@ -230,13 +247,11 @@ export function seriesList(data: WorkspaceData): NumberSeries[] {
       documentType,
       ...format,
       version: saved?.version ?? 0,
-      // Only journal entries get numbers in the mock so far; every other type starts at 1
+      // Journal entries and stock documents get numbers in the mock; the rest start at 1
       nextNumber: formatDocumentNumber(
         format,
         period(format),
-        (documentType === 'accounting.journal'
-          ? (data.journal.counters.get(period(format)) ?? 0)
-          : 0) + 1,
+        usedNumbers(data, documentType, period(format)) + 1,
       ),
     };
   });
```

`apps/app/src/mocks/product-data.ts` (changed):

```diff
@@ -307,6 +307,18 @@ export function garmentsCatalog(): MockCatalog {
       price: '6.0000',
       packs: [['carton', '500.000000']],
     }),
+    // Step 13: a machine tracked by its serial plate, for the serial number screens
+    {
+      ...product(catalog, {
+        code: 'P-00005',
+        name: 'Juki DDL-8000A lockstitch machine',
+        category: 'Finished garments',
+        base: 'pcs',
+        price: null,
+      }),
+      categoryId: null,
+      tracking: 'serial',
+    },
   ];
   const generated = Array.from({ length: 10_000 }, (_, index) => {
     const garment = GARMENTS[index % GARMENTS.length] ?? 'T-shirt';
@@ -323,7 +335,7 @@ export function garmentsCatalog(): MockCatalog {
       updatedMinutesAgo: 60 + index,
     });
   });
-  return { ...catalog, products: [...named, ...generated], lastCode: 4 };
+  return { ...catalog, products: [...named, ...generated], lastCode: 5 };
 }
 
 export function pharmaCatalog(): MockCatalog {
```

`apps/app/src/mocks/handlers.ts` (changed):

```diff
@@ -70,6 +70,22 @@ import {
   toImport,
 } from './product-data';
 import { settleSetup, startSetup } from './setup-data';
+import {
+  batchReport,
+  cardOf,
+  findAdjustment,
+  findTransfer,
+  listStock,
+  movementsOf,
+  postAdjustment,
+  receiveTransfer,
+  reorderReport,
+  saveAdjustment,
+  saveTransfer,
+  sendTransfer,
+  setLevel,
+  warehouse as newWarehouse,
+} from './stock-data';
 import {
   assertCodeFree,
   checkVersion,
@@ -131,6 +147,7 @@ function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
 // audit-এর "আগের মান" — ফর্মের ঘরগুলো
 function editable(settings: Settings) {
   return {
+    allowNegativeStock: settings.allowNegativeStock,
     companyName: settings.companyName,
     legalName: settings.legalName,
     bin: settings.bin,
@@ -1533,4 +1550,317 @@ export const handlers = [
       return reply(routes.productImports.get, { ...toImport(item), errors: item.errors });
     }),
   ),
+
+  // --- Warehouses and stock (step 13) ----------------------------------------------------------
+
+  mock(routes.warehouses.list, ({ request }) => {
+    const { status } = readQuery(routes.warehouses.list.query, request);
+    const items = current()
+      .stock.warehouses.filter((place) => (status === 'active') === (place.archivedAt === null))
+      .toSorted((a, b) => a.code.localeCompare(b.code));
+    return reply(routes.warehouses.list, { items });
+  }),
+
+  mock(
+    routes.warehouses.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.warehouses.create.body, request);
+      const data = current();
+      if (data.stock.warehouses.some((place) => place.code === body.code)) {
+        throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
+      }
+      const created = newWarehouse(body.branchId, body.code, body.name, body.address);
+      data.stock.warehouses.push(created);
+      record(data, 'warehouse.created', 'warehouse', created.id, diff({}, { code: created.code }));
+      return reply(routes.warehouses.create, created);
+    }),
+  ),
+
+  mock(
+    routes.warehouses.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.warehouses.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.warehouses.update.body, request);
+      const data = current();
+      const target = data.stock.warehouses.find((place) => place.id === id);
+      if (!target) throw new MockProblem(404, 'not_found');
+      checkVersion(target.version, version);
+      if (data.stock.warehouses.some((place) => place.code === fields.code && place.id !== id)) {
+        throw new MockProblem(409, 'warehouse_code_taken', { code: ['warehouse_code_taken'] });
+      }
+      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
+      record(data, 'warehouse.updated', 'warehouse', id);
+      return reply(routes.warehouses.update, target);
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.warehouses[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.warehouses[action].params.parse(params);
+        const { version } = await readBody(routes.warehouses[action].body, request);
+        const data = current();
+        const target = data.stock.warehouses.find((place) => place.id === id);
+        if (!target) throw new MockProblem(404, 'not_found');
+        checkVersion(target.version, version);
+        if (action === 'archive') {
+          const holds = data.stock.movements
+            .filter((movement) => movement.warehouseId === id)
+            .reduce((sum, movement) => sum + Number(movement.quantity), 0);
+          if (holds !== 0) throw new MockProblem(409, 'warehouse_has_stock');
+        }
+        Object.assign(target, {
+          archivedAt: action === 'archive' ? new Date().toISOString() : null,
+          version: version + 1,
+        });
+        record(
+          data,
+          action === 'archive' ? 'warehouse.archived' : 'warehouse.restored',
+          'warehouse',
+          id,
+        );
+        return reply(routes.warehouses[action], target);
+      }),
+    ),
+  ),
+
+  mock(routes.stock.list, async ({ request }) => {
+    const query = readQuery(routes.stock.list.query, request);
+    const start = query.cursor === undefined ? 0 : Number(query.cursor);
+    const all = listStock(current(), query);
+    const items = all.slice(start, start + query.limit);
+    const end = start + items.length;
+    if (start > 0) await delay(300);
+    return reply(routes.stock.list, { items, nextCursor: end < all.length ? String(end) : null });
+  }),
+
+  mock(
+    routes.stock.card,
+    guarded(({ params }) => {
+      const { id } = routes.stock.card.params.parse(params);
+      return reply(routes.stock.card, cardOf(current(), id));
+    }),
+  ),
+
+  mock(
+    routes.stock.movements,
+    guarded(({ request, params }) => {
+      const { id } = routes.stock.movements.params.parse(params);
+      const query = readQuery(routes.stock.movements.query, request);
+      const { items, openingBalance, closingBalance } = movementsOf(current(), id, query);
+      return reply(routes.stock.movements, {
+        items,
+        nextCursor: null,
+        openingBalance,
+        closingBalance,
+      });
+    }),
+  ),
+
+  mock(routes.stock.batches, ({ request }) => {
+    const query = readQuery(routes.stock.batches.query, request);
+    return reply(routes.stock.batches, { items: batchReport(current(), query), nextCursor: null });
+  }),
+
+  mock(routes.stock.reorder, ({ request }) => {
+    const query = readQuery(routes.stock.reorder.query, request);
+    return reply(routes.stock.reorder, {
+      items: reorderReport(current(), query.warehouseId),
+      nextCursor: null,
+    });
+  }),
+
+  mock(
+    routes.stock.setReorderLevel,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.stock.setReorderLevel.body, request);
+      const data = current();
+      const saved = setLevel(data, body);
+      record(data, 'reorder_level.changed', 'reorder_level', body.variantId);
+      return reply(routes.stock.setReorderLevel, saved);
+    }),
+  ),
+
+  mock(routes.stockAdjustments.list, ({ request }) => {
+    const query = readQuery(routes.stockAdjustments.list.query, request);
+    const items = current()
+      .stock.adjustments.filter(
+        (adjustment) =>
+          (query.status === undefined || adjustment.status === query.status) &&
+          (query.warehouseId === undefined || adjustment.warehouseId === query.warehouseId),
+      )
+      // A whole adjustment is a summary with its lines: the client's parse drops them
+      .toSorted((a, b) => b.date.localeCompare(a.date));
+    return reply(routes.stockAdjustments.list, { items, nextCursor: null });
+  }),
+
+  mock(
+    routes.stockAdjustments.get,
+    guarded(({ params }) => {
+      const { id } = routes.stockAdjustments.get.params.parse(params);
+      return reply(routes.stockAdjustments.get, findAdjustment(current(), id));
+    }),
+  ),
+
+  mock(
+    routes.stockAdjustments.create,
+    guarded(async ({ request }) => {
+      const { post, ...input } = await readBody(routes.stockAdjustments.create.body, request);
+      const data = current();
+      const draft = saveAdjustment(data, input);
+      record(data, 'stock_adjustment.created', 'stock_adjustment', draft.id);
+      const saved = post ? postAdjustment(data, draft) : draft;
+      await delay();
+      return reply(routes.stockAdjustments.create, saved);
+    }),
+  ),
+
+  mock(
+    routes.stockAdjustments.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.stockAdjustments.update.params.parse(params);
+      const { post, version, ...input } = await readBody(
+        routes.stockAdjustments.update.body,
+        request,
+      );
+      const data = current();
+      const target = findAdjustment(data, id);
+      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
+      checkVersion(target.version, version);
+      const draft = saveAdjustment(data, input, target);
+      record(data, 'stock_adjustment.updated', 'stock_adjustment', id);
+      const saved = post ? postAdjustment(data, draft) : draft;
+      await delay();
+      return reply(routes.stockAdjustments.update, saved);
+    }),
+  ),
+
+  mock(
+    routes.stockAdjustments.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.stockAdjustments.remove.params.parse(params);
+      const { version } = readQuery(routes.stockAdjustments.remove.query, request);
+      const data = current();
+      const target = findAdjustment(data, id);
+      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
+      checkVersion(target.version, version);
+      data.stock.adjustments = data.stock.adjustments.filter((row) => row.id !== id);
+      record(data, 'stock_adjustment.deleted', 'stock_adjustment', id);
+      return reply(routes.stockAdjustments.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.stockAdjustments.post,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.stockAdjustments.post.params.parse(params);
+      const { version } = await readBody(routes.stockAdjustments.post.body, request);
+      const data = current();
+      const target = findAdjustment(data, id);
+      checkVersion(target.version, version);
+      const posted = postAdjustment(data, target);
+      record(data, 'stock_adjustment.posted', 'stock_adjustment', id);
+      return reply(routes.stockAdjustments.post, posted);
+    }),
+  ),
+
+  mock(routes.stockTransfers.list, ({ request }) => {
+    const query = readQuery(routes.stockTransfers.list.query, request);
+    const items = current()
+      .stock.transfers.filter(
+        (transfer) =>
+          (query.status === undefined || transfer.status === query.status) &&
+          (query.warehouseId === undefined ||
+            transfer.fromWarehouseId === query.warehouseId ||
+            transfer.toWarehouseId === query.warehouseId),
+      )
+      .toSorted((a, b) => b.sentOn.localeCompare(a.sentOn));
+    return reply(routes.stockTransfers.list, { items, nextCursor: null });
+  }),
+
+  mock(
+    routes.stockTransfers.get,
+    guarded(({ params }) => {
+      const { id } = routes.stockTransfers.get.params.parse(params);
+      return reply(routes.stockTransfers.get, findTransfer(current(), id));
+    }),
+  ),
+
+  mock(
+    routes.stockTransfers.create,
+    guarded(async ({ request }) => {
+      const { send, ...input } = await readBody(routes.stockTransfers.create.body, request);
+      const data = current();
+      const draft = saveTransfer(data, input);
+      record(data, 'stock_transfer.created', 'stock_transfer', draft.id);
+      const saved = send ? sendTransfer(data, draft) : draft;
+      await delay();
+      return reply(routes.stockTransfers.create, saved);
+    }),
+  ),
+
+  mock(
+    routes.stockTransfers.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.stockTransfers.update.params.parse(params);
+      const { send, version, ...input } = await readBody(
+        routes.stockTransfers.update.body,
+        request,
+      );
+      const data = current();
+      const target = findTransfer(data, id);
+      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
+      checkVersion(target.version, version);
+      const draft = saveTransfer(data, input, target);
+      record(data, 'stock_transfer.updated', 'stock_transfer', id);
+      const saved = send ? sendTransfer(data, draft) : draft;
+      await delay();
+      return reply(routes.stockTransfers.update, saved);
+    }),
+  ),
+
+  mock(
+    routes.stockTransfers.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.stockTransfers.remove.params.parse(params);
+      const { version } = readQuery(routes.stockTransfers.remove.query, request);
+      const data = current();
+      const target = findTransfer(data, id);
+      if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
+      checkVersion(target.version, version);
+      data.stock.transfers = data.stock.transfers.filter((row) => row.id !== id);
+      record(data, 'stock_transfer.deleted', 'stock_transfer', id);
+      return reply(routes.stockTransfers.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.stockTransfers.send,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.stockTransfers.send.params.parse(params);
+      const { version } = await readBody(routes.stockTransfers.send.body, request);
+      const data = current();
+      const target = findTransfer(data, id);
+      checkVersion(target.version, version);
+      const sent = sendTransfer(data, target);
+      record(data, 'stock_transfer.sent', 'stock_transfer', id);
+      return reply(routes.stockTransfers.send, sent);
+    }),
+  ),
+
+  mock(
+    routes.stockTransfers.receive,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.stockTransfers.receive.params.parse(params);
+      const { version, ...input } = await readBody(routes.stockTransfers.receive.body, request);
+      const data = current();
+      const target = findTransfer(data, id);
+      checkVersion(target.version, version);
+      const received = receiveTransfer(data, target, input);
+      record(data, 'stock_transfer.received', 'stock_transfer', id);
+      await delay();
+      return reply(routes.stockTransfers.receive, received);
+    }),
+  ),
 ];
```

---

## 13.10 — Playwright

`apps/app/e2e/stock.e2e.ts`:

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// The nav says "Adjustments"; the page says more in its heading
async function openPage(page: Page, link: string, heading: string) {
  await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

async function newAdjustment(page: Page) {
  await openPage(page, 'Adjustments', 'Stock adjustments');
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New stock adjustment' })).toBeVisible();
  await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
}

// Scan (type) into the picker and press Enter: the only match is added, the dialog stays open
async function scan(page: Page, code: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill(code);
  await expect(page.getByRole('dialog').getByText(/in stock here/)).toHaveCount(1);
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await page.keyboard.press('Escape');
}

test('posts opening stock found in a count, and the stock goes up', async ({ page }) => {
  await newAdjustment(page);
  await page.getByLabel('Reason').selectOption({ label: 'Found in a count' });
  await scan(page, '8941100500118');
  const line = page.getByRole('group', { name: 'Line 1' });
  await expect(line.getByText('Basic crew-neck T-shirt')).toBeVisible();
  await line.getByLabel('Quantity').fill('20');
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText(/ADJ-\d{4}-\d{2}-0002 posted/)).toBeVisible();

  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('crew-neck');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toContainText('452 pcs');
  await listItem(page, /Basic crew-neck T-shirt/).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Basic crew-neck T-shirt' }),
  ).toBeVisible();
  await expect(page.getByText(/ADJ-\d{4}-\d{2}-0002/).first()).toBeVisible();
  await expectNoSideScroll(page);
});

test('refuses to take out more than the warehouse holds', async ({ page }) => {
  await newAdjustment(page);
  await page.getByRole('radio', { name: 'Stock out' }).check({ force: true });
  await expect(page.getByLabel('Reason')).toHaveValue('damaged');
  await scan(page, 'P-00004');
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Quantity').fill('5000');
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(
    page.getByText('Not enough stock here. Lower the quantity or pick another batch.'),
  ).toBeVisible();
});

test('receives a transfer short, and keeps the shortage on it', async ({ page }) => {
  await openPage(page, 'Transfers', 'Stock transfers');
  await listItem(page, /TRF-/).first().click();
  await expect(
    page.getByRole('heading', { name: 'Receive at CTG · Chattogram depot' }),
  ).toBeVisible();
  await page.getByRole('group', { name: 'Line 1' }).getByLabel('Arrived').fill('40');
  await page.getByRole('button', { name: 'Receive transfer' }).click();
  await expect(page.getByText(/TRF-\d{4}-\d{2}-0001 received/)).toBeVisible();
  await expect(page.getByText('Short by 8 pcs')).toBeVisible();
  await expect(page.getByText('Short', { exact: true })).toBeVisible();
  await expectNoSideScroll(page);
});

test('lists what fell to its reorder level, and sets a new level', async ({ page }) => {
  await openFromNav(page, 'Reorder');
  await expect(listItem(page, /Poly mailer bag 10x14/)).toContainText('3,000 pcs');

  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('crew-neck');
  await listItem(page, /Basic crew-neck T-shirt/).click();
  await page.getByRole('button', { name: 'Set the reorder level at MAIN · Main store' }).click();
  await page.getByLabel('Reorder when stock falls to').fill('500');
  await page.getByLabel('Order quantity').fill('1200');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Reorder level saved')).toBeVisible();
  await expect(page.getByText('At 500 pcs · Order 1,200 pcs')).toBeVisible();

  await openFromNav(page, 'Reorder');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
});
```

Four flows, each on desktop and at 390px: an adjustment posted from a scanned barcode, a refused outflow, a transfer
received short, and a reorder level set from the stock card.

`apps/app/e2e/products.e2e.ts` (changed):

```diff
@@ -59,8 +59,8 @@ test('adds a simple product with a pack, and fills in a standard unit’s size',
   await page.getByRole('button', { name: 'Add product' }).click();
 
   await expect(page.getByText('Poly mailer bag 12x16 added')).toBeVisible();
-  // The next code of the series
-  await expect(page.getByRole('heading', { level: 1, name: 'Edit P-00005' })).toBeVisible();
+  // The next code of the series (the mock's sewing machine of step 13 is P-00005)
+  await expect(page.getByRole('heading', { level: 1, name: 'Edit P-00006' })).toBeVisible();
   await expectNoSideScroll(page);
 });
```

The mock's new sewing machine (13.9) took the product code `P-00005`, so the product this test adds is `P-00006`.

---

## 13.11 — Root files

`package.json` (changed):

```diff
@@ -12,7 +12,7 @@
     "build": "turbo run build",
     "typecheck": "turbo run typecheck",
     "test": "turbo run test",
-    "lint": "turbo run build --filter=./packages/* && eslint .",
+    "lint": "turbo run build --filter=./packages/* && node --max-old-space-size=4096 node_modules/eslint/bin/eslint.js .",
     "format": "prettier --check .",
     "format:write": "prettier --write .",
     "boundaries": "depcruise apps packages",
```

Decision 16: `node --max-old-space-size=4096 node_modules/eslint/bin/eslint.js .` instead of `eslint .`. Written
this way (not `NODE_OPTIONS=… eslint .`) so it works the same in every shell, Windows included, with no new
package. The CI workflow runs `pnpm lint`, so it gets the same heap.

```bash
pnpm gen:openapi      # openapi.json — 90 paths (73 before); commit it
```

The Drizzle snapshots (`migrations/meta/0021_snapshot.json`, `0022_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

---

## 13.12 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", after "Pack rows":

> - **Stock line rows (adjustments, transfers):** a card that is a container (`@container`); one grid template for a
>   caption header and every row on a wide card (`@3xl`): item (name, SKU, stock here), unit, quantity (with
>   "= 72 pcs" under it), batch or serial numbers, remove. On a narrow card each control shows its label. Lines are
>   added with the "Add items" dialog (search or scan; Enter adds the only match; the dialog stays open).
> - **Serial number box:** the text area's look, `Geist Mono`, one serial number per line.
> - **Expiry pill:** expired = `crit`, 30 days or less = `warn` ("12 days left"), later = the date alone.

And under "Content and formatting":

> - **Quantities:** decimal strings, never numbers, shown with the unit's decimals and code (`72 pcs`, `2.74 m`).
>   Stock is always counted in the product's base unit.

**build-plan.bn.md** — step 13's text:

> `warehouses` (ব্রাঞ্চের অধীনে), **`stock_movements` (append-only — trigger UPDATE/DELETE আটকায়)**,
> `stock_balances` (trigger দিয়ে রাখা, কোড লেখে না), adjustment (opening stock সহ, draft → posted, `ADJ-…`),
> দুই ধাপের transfer (in transit, ঘাটতি থাকে), batch + expiry + FEFO, serial number, reorder level + বেলের alert,
> workspace সেটিং "negative stock" (ডিফল্ট বন্ধ)। `StockPostingService.post()` — স্টকে ঢোকার একমাত্র পথ।
> **দেখবেন:** স্টক রিপোর্ট; stock adjustment করলে লেজারে নতুন লাইন যোগ হয়, পুরনো লাইন অপরিবর্তিত থাকে।

**COMMANDS.md** — in the database section:

````markdown
```sh
# stock balances that do not match their movements (should print nothing; the trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT b.tenant_id, b.warehouse_id, b.variant_id, b.batch_id, b.quantity, m.total FROM stock_balances b LEFT JOIN LATERAL (SELECT coalesce(sum(quantity), 0) AS total FROM stock_movements m WHERE m.tenant_id = b.tenant_id AND m.warehouse_id = b.warehouse_id AND m.variant_id = b.variant_id AND m.batch_id IS NOT DISTINCT FROM b.batch_id) m ON true WHERE b.quantity <> m.total"
# transfers still on the road, oldest first
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, s.number, s.sent_on FROM stock_transfers s JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'in_transit' ORDER BY s.sent_on"
```
````

---

## 13.13 — Run it

```bash
pnpm install
pnpm db:migrate                               # 0021 + 0022, the three permissions, a Main store per workspace
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it, the worker too
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('warehouses', 'stock_movements', 'stock_balances', 'stock_adjustments');  -- t for each
SELECT tgname FROM pg_trigger WHERE tgrelid = 'stock_movements'::regclass AND NOT tgisinternal;
  -- stock_movements_append_only, stock_movements_apply
SELECT code, name FROM warehouses;                                                         -- MAIN, Main store
```

### What you will see

1. **Your existing roles do not have the new permissions yet.** As the owner you have them all. For a store keeper:
   Roles → Inventory → tick "Write and post stock adjustments" and "Send stock to another warehouse".
2. A new sidebar group **Stock**: Stock on hand, Adjustments, Transfers, Batches and expiry, Reorder, Warehouses.
3. **Warehouses**: "MAIN · Main store" in your head office. Add "FG · Finished goods store".
4. **Adjustments → New adjustment**: warehouse MAIN, "Stock in", reason "Opening stock", **Add items** → scan or
   search a product, pick a pack unit and see "= 72 pcs" under the quantity → **Post adjustment** →
   `ADJ-2026-27-0001`.
5. **Stock on hand**: the product with 72 pcs. Open it: the stock card, its history with the running balance.
6. A **batch** product (tracking "Batch", with expiry): stock in with a lot number and an expiry date; then stock out
   and use **Split by first expiry**. **Batches and expiry** lists the batch with its days left.
7. A **serial** product: stock in two serial numbers, one per line. Search the stock list for one of them.
8. **Transfers → New transfer**: MAIN → FG, **Send transfer**: the stock list shows it "in transit". Open the transfer,
   change "Arrived" to less than was sent, **Receive transfer**: "Short by …".
9. On a stock card, **set a reorder level** above what is left, then post an adjustment out: the bell rings, and
   **Reorder** lists it.
10. **Settings → Inventory → Allow negative stock**: off, an outflow larger than the stock is refused under its
    quantity; on, an untracked product may go below zero.
11. **Bangla**: switch the language — the first switch fetches the Bangla texts (DevTools → Network: one chunk).
12. DevTools at 390px: the lines stack with their labels, the tables become cards, and the page never scrolls
    sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint                    # now with a 4 GB heap for ESLint
pnpm format
pnpm typecheck
pnpm test                    # 240: contracts 90 + api 68 + app 45 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 201 — 26 new
pnpm test:tenant-leak        # 43 — 4 new
pnpm test:e2e                # 84: 42 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 179.8 KB gz (201.8 before decision 15); stock card 85.9
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The migration's foreign keys came before their indexes** — steps 9, 10 and 12's problem again (13.2).
- **The race test proved nothing at first.** It sent two adjustments at once, and still passed with the balance
  rows' `FOR UPDATE` removed: both adjustments take a number first, and the number series' counter row already
  made the second wait for the first. The test now races a write-off against a transfer (two counters) and holds
  the balance row until both wait; without `FOR UPDATE` it fails, as it should.
- **A refusal by the trigger was a 500.** It is turned into the 409 it means now (`triggerError()`).
- **The transfer was never "short", and every document had 0 lines.** In a select from one table, Drizzle prints a
  column as a bare `"id"`; inside a correlated subquery that is the *inner* table's id. `lineCount`, `short` and the
  low-stock handler's count now name the outer table in plain SQL. The journal's `total` never hit this because its
  select has joins. The low-stock alert never rang for the same reason: its "stock now" summed the whole tenant.
- **More of a known lot was refused without its expiry.** The expiry was required on every "in" line; it is now
  required only for a lot that is new (decided when posting).
- **Stock could not come in to a warehouse below zero** once negative stock was switched off again: the trigger
  refused every movement that left a negative balance. It now refuses only movements that go *out*.
- **Switching an adjustment to "Stock out" picked "Correction"** instead of "Damaged" (the Playwright test): the
  registered select got its value before its new options existed. The reason is a controlled select now.
- **A wall of "Out of stock" pills** on the stock list (the first screenshot): only a variant with a reorder level
  shows it now.
- **"P-00005 · P-00005"** under a simple product's stock card heading: the SKU is shown only when it differs from
  the code.
- **The first page load went over 200 KB** (201.8), with this step's texts in two languages: Bangla loads on demand
  (decision 15). **The stock card's chunk went over 100 KB** twice: the reorder dialog became its own chunk, and
  `KpiStrip` moved into `@omnivo/ui`.
- **ESLint ran out of memory** on the whole repo (decision 16). The baseline at the end of step 12 already peaked at
  about 2.3 GB; Node's default heap on a 16 GB Mac is about 2.2 GB.
- **Break-it checks**: the eight in the header, each run on its whole test file. One of them failed to fail at first: that is the race test above.

---

## Notes left for later steps

**Step 14 (valuation + the first integration):**

- **`StockPostingService.post()` is where the journal entry goes.** Each movement has a value from step 14's
  weighted average; the posting builds a `NewEntry` and calls `PostingService.postNew()` in the same transaction.
  The adjustment reason picks the other account (opening stock → opening balance equity, damaged → a loss account).
- **A transfer's shortage is a loss** to write off when it is received; while in transit, the stock is still the
  company's (an "in transit" inventory account, or the source's until received).
- **The value per warehouse** can follow `stock_balances`; the branch of a warehouse is the branch of its entries.

**Steps 15–20 (sales, purchases, POS):**

- **Add the movement kind** (`purchase_receipt`, `sales_delivery`, `pos_sale`) to `MOVEMENT_KINDS`, its text to
  `stock.kinds`, and its page to `documentRoute()`.
- **A purchase receipt brings lots in** exactly like an "in" adjustment: `resolveBatches()`, then `post()`.
- **A sale's outflow picks batches by FEFO on the server** (the adjustment form does it in the browser today), and
  must refuse an expired batch — an adjustment may take an expired batch out, a sale must not sell it.
- **Offline POS** needs negative stock on, or its sync must report the refused lines; `stock_balances_not_negative`
  is the error the sync will meet.
- **Every document that moves stock must lock its balance rows**, through `StockPostingService.post()`: two
  different document types do not share a number counter, so nothing else makes them wait for each other.

**Notes for any step:**

- **A correlated subquery names its outer table in plain SQL** when the select is from one table (the Drizzle bare
  column, above).
- **Texts of a new language load on demand**; only English is in the first load.
- **The stock list's queries are planned for 10,000 products**, not timed with years of movements; `stock_balances`
  keeps the list off the ledger, and partitioning `stock_movements` by month (system design §5) is the step after.
