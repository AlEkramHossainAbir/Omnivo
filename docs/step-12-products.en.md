# Step 12: Products — units, categories, variants, packs, barcodes, custom fields and CSV import

> The implementation guide for "Phase 4 → Step 12" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `341497c`, the end of
> step 11) and checked on 2026-10-04: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (218 — 51 new), `pnpm test:integration` (175 — 22 new), `pnpm test:tenant-leak` (39 — 4 new),
> `pnpm build`, `pnpm test:bundle-size` (first load 192.2 KB gz, budget 200; the product form 93.4 KB),
> `pnpm gen:openapi` (73 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 76 — 12
> new, desktop and 390px) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked by hand:
>
> - **The screens**, with the mock API, at 1280px and 390px: the product list (searched, filtered, 10,000 mock
>   products), a product with six variants, the categories tree, the units, the custom fields and the import
>   page. The screenshots found three layout details, fixed in this guide ("What we found on the way").
> - **The import's whole way** in the integration test: the API gives an upload address, the file goes straight
>   to a real MinIO, the real worker reads it, and the products appear — or nothing does, with the row and column
>   of each problem.
> - **A 10,000-row file** (2,500 styles in two sizes and 5,000 simple products): 7,500 products, about 4 seconds from
>   upload to done, in a throwaway integration test against the real worker and MinIO.
> - **Every guard broken on purpose.** Let the API take any size for a standard unit → "refuses a dozen of 10
>   pieces" fails. Let the import write without its savepoint → "creates nothing from a file with one wrong row"
>   fails (the category made for the file stays). Accept another product's variant id on an edit → the tenant-leak
>   test fails. Leave RLS off `batches` → the RLS coverage test fails. Filter by a category without its
>   sub-categories → "filters by a category…" fails. Allow the same combination twice → the contract test fails.
>   Let a later CSV row contradict the product's first row → the CSV test fails. Drop an archived field's values on
>   save → "keeps the values of an archived field" fails. Each check ran its whole test file (see "What we found on
>   the way").
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database. Nothing new is needed there
> (no new env line), but run `pnpm db:migrate`: an old database without the new tables makes every new page fail
> (step 10's lesson). (2) The new tests on GitHub Actions. (3) A CSV saved by Microsoft Excel itself: the tests
> use files written by code, with and without Excel's byte order mark. (4) The Bangla texts were written by me,
> not reviewed by a native speaker. (5) The unit and category templates were written from general knowledge of
> each trade; ask a pharma depot manager and a merchandiser whether the lists fit.

## Goal

📦 **Products, the way each trade counts them.** Steps 9–11 built the books. This step builds what the books will
soon count: the products. Stock (step 13), sales and purchases (steps 15 and 17) all start from here.

After this step:

- **Units.** pcs, dozen, kg, g, m, yard, litre, box, carton, strip… seeded for each business type. A unit says what
  it measures (count, weight, length, area, volume), its fixed size if it has one (a yard is 0.9144 m, a dozen is
  12 pcs), and how many decimals a quantity may have (pieces 0, kg 3 — 1.250 kg of rice in a supershop).
- **Product categories.** A tree, like the chart of accounts: Finished garments › Polo shirts, Finished products ›
  Tablets.
- **Products, simple or with variants.** A supershop's rice is one simple product. A garments style has a variant
  for each size and colour, each with its own SKU, barcode and price. Stock, sales and purchase lines will always
  point at a variant, so both kinds work the same way underneath.
- **Packs.** A product is counted in its base unit and also comes in bigger units: a box of 10 strips of 10
  tablets, a carton of 24, a 50 kg sack. Standard sizes (a dozen) are filled in and fixed; pack sizes are typed.
  Each product says which unit sales and purchases start with (buy in boxes, sell in strips).
- **Barcodes.** On variants and on packs, one meaning per barcode in the whole workspace, with the check digit of
  retail barcodes verified — a barcode typed with one wrong digit is refused.
- **Tracking.** None, batch (with or without expiry) or serial number, per product; a pharma company's new
  products start with batch and expiry. The batch and serial tables exist now; step 13 fills them.
- **Custom fields.** The workspace's own fields on products — Generic name, Strength, Dosage form for pharma; Buyer,
  Fabric composition, GSM for garments — text, number, date, a choice from a list, or yes/no. The product form shows
  them and checks them with the same rules as the API.
- **CSV import.** Up to 10,000 rows. Rows with the same code are the variants of one product. The worker checks the
  whole file: if one cell is wrong nothing is saved, and the import page lists every problem by row and column.
  The bell says when it is done.
- **A permission:** `inventory.product.manage`. Everyone reads products (every sales line will pick one); people
  with this permission change them.

## The whole picture

```
packages/contracts   units.ts · product-categories.ts · custom-fields.ts · products.ts · product-imports.ts
      │               standardFactor() · productRules() · customFieldsInputSchema() — API, form and import alike
      │               26 routes · 1 permission · 19 audit actions · 2 notifications · 63 errors
      │               the number series 'inventory.product' (P-00001)
      ▼
packages/db          units · product_categories · custom_field_definitions · products · product_variants
                     product_units · product_barcodes · batches · serials · product_imports
                     0019 (drizzle, reordered) · 0020 (RLS, trigram search indexes, the catalog job for old workspaces)
      │
      ▼
apps/api             setup: catalog templates per industry → seedCatalog() (setup job + CatalogHandler)
                     ProductsModule: units · categories · products · product imports
                       product-write.ts: checkProduct · findTaken · insertProducts   ← the API and the worker
                     CustomFieldsModule
                     worker: ProductImportHandler → import/csv.ts → savepoint → insertProducts → notify
                     NumberingService.nextMany() · StorageService.get()
      │
      ▼
apps/app             /products · /products/new · /products/$id · /products/categories · /products/units
                     /products/imports · /custom-fields · nav group "Inventory"
                     MSW: 10,000 garments styles, a pretend import worker

one import, from the click to the products:
  Import ──POST /product-imports──► API: INSERT product_imports (uploading) + a signed PUT address
  browser ──PUT──► MinIO (the file never passes through the API)
  ──POST /product-imports/:id/start──► API: HEAD the file, size matches → queued + outbox event → COMMIT
  relay → BullMQ 'jobs' → worker: read the file → check every row → SAVEPOINT → categories, codes, products
     ok → done + bell "medicines.csv: 3 products imported"
     a cell is wrong → ROLLBACK TO SAVEPOINT → failed + the problems by row and column + bell
```

## The decisions behind this step

You made the first four on 2026-10-04. The others follow from them, from the build plan, or from what each trade
needs. Please read 5–15 with care: they are mine.

1. **Simple products and products with variants, both.** (You asked for both: "in some cases there will be no
   variant, like the supershop".) The form has "One version" and "With variants". Underneath, every product has at
   least one row in `product_variants` — a simple product exactly one, which the form never shows as a variant.
   So stock, sales and purchase lines (steps 13–17) always hold a `variant_id`, and no query ever has to handle
   "a product without a variant" as a second case. A product can switch from one version to variants later: its one
   variant becomes the first combination and keeps its id (and from step 13, its stock).
2. **Full unit support, for pharma, distribution, supershop and garments.** (You asked for all of it.) Each unit has a
   dimension, an optional fixed ratio, and allowed decimals. Each product has a base unit (stock is always counted
   in it) and up to 10 packs, each "1 pack = n base units". When both units have a fixed ratio in the same
   dimension, the number is not the person's to choose: a dozen is 12 pcs in every product, and the API refuses
   anything else. A box or a carton has no fixed ratio: its size is typed per product.
3. **CSV import in the worker, all or nothing.** (You chose this.) The whole file is checked first; one wrong cell
   and nothing is saved. Fixing the file and importing it again is then always safe — there is never a
   half-imported file to clean up. The worker writes inside a savepoint, so even categories it made for the file
   are undone when a later check (a barcode another product has) fails.
4. **Custom fields with industry templates.** (You chose this.) A table of definitions, a settings page, the product
   form draws them, and the values are checked by a schema built from the definitions —
   `customFieldsInputSchema()` in contracts, used by the API, the form and the import alike.
5. **One permission, `inventory.product.manage`; reading needs none.** Like the chart of accounts: every sales,
   purchase and stock line will pick a product, so every member reads them. Custom field definitions are
   workspace settings and need `core.settings.manage`, because customers and suppliers will have them too.
6. **A product holds its sale price, not its cost.** The cost of stock comes from valuation (step 14) and purchase
   prices from suppliers (step 17). Keeping cost off the product also means the product list never shows margins to
   people who only sell.
7. **Codes from the number series.** A product without a code gets the next of the new `inventory.product` series:
   `P-00001`, no year (a code lasts for the product's life). A garments factory types its own style numbers
   instead. A variant without a SKU gets one from the code and its values: `ST-118-M-NAVY-BLUE`. Codes and SKUs are
   unique in any case (`st-118` is `ST-118`).
8. **Every barcode in one table.** A variant's barcode and a pack's barcode live in `product_barcodes`, so one unique
   index makes sure a barcode means one thing in the whole workspace, and a scan is one lookup. 8, 12 or 13 digits is
   a retail barcode (EAN-8, UPC-A, EAN-13) and must pass its check digit. A pack barcode is only allowed on a simple
   product (which variant would a carton of a variant product be?).
9. **Archived units stay on the products that use them.** A unit that is archived cannot start a new product, but a
   product that already has it can still be saved. A unit is deleted only when no product uses it.
10. **Categories are a plain tree.** No types or codes. Names are unique among siblings, in any case. A category is
    deleted only when it is empty. Filtering the list by a category includes everything under it.
11. **The batch and serial tables now, the screens later.** The build plan (0.3) asks for them in step 12, so step
    13's stock movements can point at a batch from their first line. Nothing writes them yet.
12. **Search by part of a name, code or SKU, and by a whole barcode.** "napa" finds "Napa Extra 500 mg"; a barcode
    scanned into the search box finds its product. Postgres's own trigram index (`pg_trgm`) keeps "contains" search
    fast at 10,000 products.
13. **Old workspaces get their catalog from a job.** Like step 9's chart: migration 0020 queues one
    `workspace.catalog_requested` event per workspace that was set up before this step, and the worker seeds it
    with the same code as the setup job.
14. **Imports create products; they never change existing ones.** A code that already exists is an error in that
    row. Updating prices or names by CSV is a different, riskier tool (see "Not in this step"). Every product manager
    sees every import of the workspace — an import changes the list everybody works with.
15. **Pages import the route groups they use, and the first load imports none of the rest.** The first page load
    was over its 200 KB budget once this step's schemas were added; `lib/api.ts`, `lib/session.ts` and
    `lib/preferences.ts` now import `authRoutes`, `invitationRoutes` and `meRoutes` instead of the whole `routes`
    map (12.7).

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Stock, warehouses, batches and serials on screen | Step 13 (stock ledger) |
| Cost, valuation | Step 14 |
| Price lists, customer prices, discounts | Step 15 (sales) |
| VAT rate per product (Mushak) | With sales, when the VAT return needs it |
| Product images | With the storefront (step 26) or when someone asks; the attachments of step 6 can carry them |
| Printing barcode labels, making in-store barcodes | With POS (step 20) |
| Scale barcodes for weighed goods (price or weight in the barcode) | With POS (step 20) |
| Updating existing products from a CSV, exporting products to a CSV | Later; an update import needs its own rules (what an empty cell means) |
| A brands table | A custom field ("Brand", "Principal company") covers it until reports need it |
| Reorder levels | Step 13, with stock |

## What changes in the code you already have

- **One new package in `apps/api`:** `csv-parse` (no dependencies of its own). No new `.env` line, no new database
  role.
- **`pnpm db:migrate`** adds ten tables, the trigram search indexes, the new permission (`syncPermissions()`), and
  queues one catalog job per existing workspace — your existing workspace gets the units, categories and custom
  fields of its business type when the worker runs.
- **The setup job** also seeds the catalog (`seedCatalog()`), and its audit row says how many units, categories and
  custom fields it made.
- **The role templates** give `inventory.product.manage` to the store keeper, depot manager, merchandiser, production
  manager, shop manager and manager of **new** workspaces. Existing roles do not get it; an owner ticks it on the
  Roles page.
- **A new number series**, `inventory.product` ("Product code" on the Numbering page): `P-00001`, no year.
- `NumberingService` gets `nextMany()` (an import takes its codes in one statement); `next()` calls it.
- `StorageService` gets `get()`: the worker reads the uploaded CSV.
- `lib/api.ts`, `lib/session.ts` and `lib/preferences.ts` in the app import the route groups by name (decision 15).
- Three existing tests change with this step: the setup test (new role permissions, the catalog in the audit row and
  in the retry scenario) and the numbering test (seven series now).

---

## 12.1 — `packages/contracts`: the contract

Five new files, one per thing a person manages: units, categories, custom fields, products, imports. Each holds
its schemas, its routes, and the small pure functions the API, the browser and the import share.

**File: `packages/contracts/src/units.ts`** (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// What a unit measures. Units of one dimension convert into each other by a fixed ratio (a kg is
// 1000 g everywhere); units of different dimensions never do on their own.
export const UNIT_DIMENSIONS = ['count', 'weight', 'length', 'area', 'volume'] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

// A ratio or a conversion factor: a positive decimal string with at most 6 places, the way
// Postgres sends NUMERIC(19,6) ("0.914400"). A yard is 0.9144 m; a pack of 6 is "6".
const FACTOR = /^\d{1,13}(?:\.\d{1,6})?$/;
const MICRO = 1_000_000n;

// "0.9144" → 914400n: millionths, as BigInt, so the arithmetic is exact (like money.ts, and for
// the same reason: contracts may use zod and nothing else, so no decimal.js here)
function toMicro(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}

function fromMicro(micro: bigint): string {
  return `${String(micro / MICRO)}.${String(micro % MICRO).padStart(6, '0')}`;
}

export function isFactor(value: string): boolean {
  return FACTOR.test(value) && toMicro(value) > 0n;
}

// Two factors are the same number however they are written: "12" and "12.000000"
export function sameFactor(a: string, b: string): boolean {
  return toMicro(a) === toMicro(b);
}

// A form sends a factor as typed: "24", "0.5". Zero is not a factor: a pack of nothing.
export const factorSchema = z
  .string()
  .trim()
  .refine((value) => isFactor(value), errorCode('factor_format'));

// How many base units one `unit` is, when both have a fixed ratio in the same dimension: with a
// metre base, a yard is 0.9144; with a yard base, a metre is 1.093613 (rounded half up to the 6
// places the column keeps). null when there is no standard answer — a box holds as many tablets as
// that product's box holds, so the person types it.
export function standardFactor(
  unit: Pick<Unit, 'dimension' | 'ratio'>,
  base: Pick<Unit, 'dimension' | 'ratio'>,
): string | null {
  if (unit.ratio === null || base.ratio === null || unit.dimension !== base.dimension) return null;
  const numerator = toMicro(unit.ratio) * MICRO;
  const denominator = toMicro(base.ratio);
  return fromMicro((numerator * 2n + denominator) / (denominator * 2n));
}

export const unitSchema = z.object({
  id: z.uuid(),
  // What lists and forms show: "pcs", "kg", "box"
  code: z.string(),
  name: z.string(),
  // z.string(), not an enum: a newer server's new dimension must not break an older offline client
  dimension: z.string(),
  // How many of the dimension's reference unit (pcs, kg, m, m², l) one of this unit is. null = a
  // pack (box, carton, strip): its size differs from product to product.
  ratio: z.string().nullable(),
  // How many decimals a quantity in this unit may have: 0 for pieces, 3 for kg (1.250 kg of
  // rice). The stock and sales steps round quantities to it.
  decimals: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Unit = z.infer<typeof unitSchema>;

export function isUnitDimension(value: string): value is UnitDimension {
  return UNIT_DIMENSIONS.some((dimension) => dimension === value);
}

// Letters of any script and digits, then dots, slashes or hyphens: pcs, kg, m², sq.ft, পিস
const unitCodeSchema = z
  .string()
  .trim()
  .min(1, errorCode('unit_code_format'))
  .max(12, errorCode('unit_code_format'))
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}²³._/-]*$/u, errorCode('unit_code_format'));

const unitNameSchema = z.string().trim().min(1, errorCode('unit_name_required')).max(40);

export const createUnitInputSchema = z.object({
  code: unitCodeSchema,
  name: unitNameSchema,
  dimension: z.enum(UNIT_DIMENSIONS),
  // '' = a pack. Fixed once made: changing it would change what every product's quantity means.
  ratio: z
    .string()
    .trim()
    .refine((value) => value === '' || isFactor(value), errorCode('factor_format'))
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  decimals: z.number().int().min(0).max(4),
});
export type CreateUnitInput = z.infer<typeof createUnitInputSchema>;

// The dimension and the ratio stay as they were made
export const updateUnitInputSchema = z.object({
  code: unitCodeSchema,
  name: unitNameSchema,
  decimals: z.number().int().min(0).max(4),
  version: versionSchema,
});
export type UpdateUnitInput = z.infer<typeof updateUnitInputSchema>;

export const unitVersionInputSchema = z.object({ version: versionSchema });

export const deleteUnitQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// A workspace has a few dozen units at most: the whole list at once, archived ones included
export const unitListSchema = z.object({ items: z.array(unitSchema) });

const unitParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: every product form, and from step 13 every stock and sales line,
// picks a unit from this list
export const unitRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/units',
    summary: 'The units of measure of the workspace, archived ones included',
    auth: 'bearer',
    status: 200,
    response: unitListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/units',
    summary: 'Add a unit of measure',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: createUnitInputSchema,
    response: unitSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/units/:id',
    summary: "Change a unit's code, name or decimals",
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: unitParamsSchema,
    body: updateUnitInputSchema,
    response: unitSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/units/:id/archive',
    summary: 'Hide a unit from new products; products that use it keep it',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: unitParamsSchema,
    body: unitVersionInputSchema,
    response: unitSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/units/:id/restore',
    summary: 'Bring an archived unit back',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: unitParamsSchema,
    body: unitVersionInputSchema,
    response: unitSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/units/:id',
    summary: 'Delete a unit that no product uses',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 204,
    params: unitParamsSchema,
    query: deleteUnitQuerySchema,
    response: z.void(),
  }),
};
```

- **`FACTOR` and `toMicro()`.** A ratio or a pack size is a decimal string with at most 6 places, the way Postgres
  sends `NUMERIC(19,6)`. The arithmetic runs on millionths as BigInt, like `money.ts` does with ten-thousandths:
  exact, and without decimal.js, which the `contracts-only-zod` boundary rule keeps out of this package.
- **`isFactor()` refuses zero.** "1 box = 0 tablets" would make every later quantity conversion divide by zero.
- **`sameFactor()`** compares numbers, not text: the database sends `12.000000`, a form sends `12`.
- **`standardFactor()`** is the rule of decision 2. It answers only when both units have a ratio and the same
  dimension; a pack (`ratio === null`) or another dimension gives `null`, and the person types the size. The
  division can be endless (a metre in yards is 1.0936132983…), so it is rounded half up to the 6 places the column
  keeps: `(n * 2 + d) / (2 * d)` is integer rounding without floats. The API checks a saved product with this
  function, and the form fills the box with it — so the form can never offer a number the API refuses.
- **`unitSchema.dimension` is `z.string()`, not an enum** — the rule of error codes and account purposes: a newer
  server's new dimension must not break an older offline client. `isUnitDimension()` narrows it in the app.
- **`ratio` in `createUnitInputSchema`** turns `''` into `null` ("a pack") — the same "empty box is null, never ''"
  rule as `optionalText()`.
- **`updateUnitInputSchema` has no dimension and no ratio.** Changing a kg into a gram would silently change the
  meaning of every quantity already counted in it (from step 13). Like an account's type, they are fixed at creation.
- **The unit code regex** takes letters of any script (`পিস` works), digits, `²`/`³` (`m²`), dots, slashes and
  hyphens — but no spaces: a code is typed into narrow boxes and a CSV cell.
- **Reading units needs no permission**: every product form, and later every stock and sales line, picks one.

**File: `packages/contracts/src/product-categories.ts`** (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// A tree like the chart of accounts, but simpler: no types, no codes, no groups-only rule. A
// category may hold products and other categories at the same time ("Tablets" under "Medicine").
export const productCategorySchema = z.object({
  id: z.uuid(),
  // null = a top-level category
  parentId: z.uuid().nullable(),
  name: z.string(),
  // Products directly in it (not in its sub-categories), archived ones included
  productCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type ProductCategory = z.infer<typeof productCategorySchema>;

const categoryNameSchema = z.string().trim().min(1, errorCode('category_name_required')).max(80);

// The form's "Top level" option sends ''
const parentIdSchema = z
  .union([z.uuid(errorCode('category_parent_invalid')), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const createProductCategoryInputSchema = z.object({
  parentId: parentIdSchema,
  name: categoryNameSchema,
});
export type CreateProductCategoryInput = z.infer<typeof createProductCategoryInputSchema>;

// A new parentId moves the category with everything under it
export const updateProductCategoryInputSchema = createProductCategoryInputSchema.extend({
  version: versionSchema,
});
export type UpdateProductCategoryInput = z.infer<typeof updateProductCategoryInputSchema>;

export const deleteProductCategoryQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// Tens to a few hundred categories: the whole tree at once, like the chart
export const productCategoryListSchema = z.object({ items: z.array(productCategorySchema) });

const categoryParamsSchema = z.object({ id: z.uuid() });

export const productCategoryRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/product-categories',
    summary: 'The product categories of the workspace, as a flat list with parent ids',
    auth: 'bearer',
    status: 200,
    response: productCategoryListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/product-categories',
    summary: 'Add a category, at the top or under another one',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: createProductCategoryInputSchema,
    response: productCategorySchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/product-categories/:id',
    summary: 'Rename a category or move it under another one',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: categoryParamsSchema,
    body: updateProductCategoryInputSchema,
    response: productCategorySchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/product-categories/:id',
    summary: 'Delete a category that holds no products and no categories',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 204,
    params: categoryParamsSchema,
    query: deleteProductCategoryQuerySchema,
    response: z.void(),
  }),
};
```

- **`productCount`** is the number of products directly in the category. The page shows it, and it tells the person
  why "Delete" will be refused before they try.
- **`parentIdSchema`** turns the form's "Top level" (`''`) into `null`. An id that is not a uuid gets
  `category_parent_invalid` — the same message the API gives for a uuid that does not exist, so nothing leaks.
- **`updateProductCategoryInputSchema` extends the create schema** with the version: the same fields, and moving a
  category is just a new `parentId`.
- **There is no archive.** A category holds no history of its own (documents point at products, not at
  categories), so an unused category is deleted, and a used one is refused (`category_in_use`).

**File: `packages/contracts/src/custom-fields.ts`** (new)

```ts
import { z } from 'zod';

import { type ErrorCode, errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// The records a workspace can add its own fields to. Products now; customers and suppliers when
// they come (steps 15 and 17) add a line here.
export const CUSTOM_FIELD_ENTITIES = ['product'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export function isCustomFieldType(value: string): value is CustomFieldType {
  return CUSTOM_FIELD_TYPES.some((type) => type === value);
}

// A workspace's own field: "Generic name" on a pharma company's products, "GSM" on a knit
// factory's. The values live in the record's custom_fields column under `key`.
export const customFieldDefinitionSchema = z.object({
  id: z.uuid(),
  // z.string(), not enums: a newer server's new entity or type must not break an older client.
  // The app narrows `type` with isCustomFieldType() and skips a field it cannot draw.
  entity: z.string(),
  // The name inside custom_fields and the CSV column (cf_generic_name). Fixed once made: renaming
  // it would orphan every value already saved under the old name.
  key: z.string(),
  label: z.string(),
  type: z.string(),
  // The choices of a select; empty for the other types
  options: z.array(z.string()),
  required: z.boolean(),
  // An archived field is hidden from forms; the values saved under it stay on the records
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>;

// Lowercase letters, digits and _, starting with a letter: it becomes a CSV column name and a JSON
// key, so it stays plain ASCII whatever language the label is in
const customFieldKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, errorCode('custom_field_key_format'));

const customFieldLabelSchema = z
  .string()
  .trim()
  .min(1, errorCode('custom_field_label_required'))
  .max(60);

// The select's choices, each once (Tablet and tablet are the same choice)
const optionsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(50)
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    options.forEach((option, index) => {
      const folded = option.toLowerCase();
      if (seen.has(folded)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: errorCode('custom_field_option_twice'),
        });
      }
      seen.add(folded);
    });
  });

export const createCustomFieldInputSchema = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    key: customFieldKeySchema,
    label: customFieldLabelSchema,
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema,
    // A yes/no field always has a value (unticked = no), so "required" means nothing there
    required: z.boolean(),
  })
  .superRefine((input, ctx) => {
    if (input.type === 'select' && input.options.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: errorCode('custom_field_options_required'),
      });
    }
  });
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldInputSchema>;

// The type and the key stay as they were made. The server checks "a select keeps a choice",
// because only it knows the field's type.
export const updateCustomFieldInputSchema = z.object({
  label: customFieldLabelSchema,
  options: optionsSchema,
  required: z.boolean(),
  version: versionSchema,
});
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldInputSchema>;

export const customFieldVersionInputSchema = z.object({ version: versionSchema });

export const customFieldListQuerySchema = z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES) });

export const customFieldListSchema = z.object({ items: z.array(customFieldDefinitionSchema) });

// ---------------------------------------------------------------------------------------------
// The values

// On the wire: key → a string (text, number, date, select) or a boolean (yes/no). A number is a
// decimal string like money, so "180" GSM never turns into 179.99999.
export const customFieldValuesSchema = z
  .record(z.string().max(40), z.union([z.string().max(200), z.boolean()]))
  .refine((values) => Object.keys(values).length <= 50, errorCode('too_long'));
export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;

type FieldRule = Pick<CustomFieldDefinition, 'key' | 'type' | 'options' | 'required'>;

const DECIMAL = /^-?\d{1,13}(?:\.\d{1,6})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// One field of a form: '' or a missing key = no value. Checked only when there is a value; then
// "required" is checked on its own, so an empty required field says "required", not "wrong format".
function stringValue(required: boolean, valid: (value: string) => boolean, code: ErrorCode) {
  return z
    .string()
    .trim()
    .max(200)
    .optional()
    .refine((value) => value === undefined || value === '' || valid(value), errorCode(code))
    .refine((value) => !required || (value !== undefined && value !== ''), errorCode('required'))
    .transform((value) => (value === '' ? undefined : value));
}

function valueSchema(field: FieldRule) {
  switch (field.type) {
    case 'number':
      return stringValue(field.required, (value) => DECIMAL.test(value), 'number_format');
    case 'date':
      return stringValue(
        field.required,
        (value) => ISO_DATE.test(value) && z.iso.date().safeParse(value).success,
        'invalid_format',
      );
    case 'select':
      return stringValue(field.required, (value) => field.options.includes(value), 'invalid_value');
    case 'boolean':
      return z.boolean().optional();
    default:
      // 'text', and a type this build does not know yet: kept as text, never lost
      return stringValue(field.required, () => true, 'invalid_value');
  }
}

// The values a record may hold, built from the workspace's active fields: the API checks a saved
// product with it, the product form uses the same schema in its resolver, and the CSV import checks
// each row with it. Unknown keys are refused (a typo in an API call, or an archived field), and
// empty values are dropped, so the column never stores "".
export function customFieldsInputSchema(fields: readonly FieldRule[]) {
  const shape = Object.fromEntries(fields.map((field) => [field.key, valueSchema(field)]));
  return z
    .strictObject(shape, { error: errorCode('custom_field_unknown') })
    .transform((values): CustomFieldValues => {
      const kept: CustomFieldValues = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string' || typeof value === 'boolean') kept[key] = value;
      }
      return kept;
    });
}

const customFieldParamsSchema = z.object({ id: z.uuid() });

export const customFieldRoutes = {
  // Every member reads them: every product form draws them
  list: defineRoute({
    method: 'GET',
    path: '/custom-fields',
    summary: "The workspace's own fields for one kind of record, archived ones included",
    auth: 'bearer',
    status: 200,
    query: customFieldListQuerySchema,
    response: customFieldListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/custom-fields',
    summary: 'Add a field of your own to a kind of record',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 201,
    body: createCustomFieldInputSchema,
    response: customFieldDefinitionSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/custom-fields/:id',
    summary: "Change a field's label, choices or whether it is required",
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: customFieldParamsSchema,
    body: updateCustomFieldInputSchema,
    response: customFieldDefinitionSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/custom-fields/:id/archive',
    summary: 'Hide a field from forms; saved values stay',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: customFieldParamsSchema,
    body: customFieldVersionInputSchema,
    response: customFieldDefinitionSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/custom-fields/:id/restore',
    summary: 'Bring an archived field back, with its saved values',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    params: customFieldParamsSchema,
    body: customFieldVersionInputSchema,
    response: customFieldDefinitionSchema,
  }),
};
```

- **`CUSTOM_FIELD_ENTITIES = ['product']`.** Customers and suppliers add a line here when they come.
- **`key` is ASCII and fixed.** It is the JSON key the values are saved under and the CSV column name
  (`cf_generic_name`). Renaming it would orphan every saved value, so the update schema has no `key`.
- **`optionsSchema` refuses a choice twice in any case** ("Tablet" and "tablet"), with the error on the second one.
- **The "a select needs a choice" rule** is a `superRefine` on create. On update the schema cannot know the field's
  type (it is not sent), so the service checks it.
- **`required` on a yes/no field means nothing**: unticked is a value too. The service stores `false` for it.
- **`customFieldValuesSchema`** is the wire shape: key → a string or a boolean, at most 50 keys. A number is a decimal
  string like money, so "180" GSM never becomes 179.99999.
- **`stringValue()`** checks the format only when there is a value, then "required" on its own. An empty required
  field then says "Fill in this field", not "Enter a number". It turns `''` into `undefined`, which the final
  `transform` drops: the column never stores empty strings.
- **The `date` check** runs the regex and `z.iso.date()`: the regex alone would let `2026-02-30` through.
- **`default:` in `valueSchema()`** treats a type this build does not know as text. A newer server's new type then
  shows as a text box and its value is kept, instead of being lost on the next save.
- **`customFieldsInputSchema()` builds a schema from the active fields.** `strictObject` refuses a key the workspace
  does not have (a typo in an API call, or a field archived after the form was opened) with `custom_field_unknown`.
  The API, the product form's resolver and the CSV import all call it, so the three can never disagree.
- **The definitions need `core.settings.manage`** to change (decision 5); reading them needs nothing, because every
  product form draws them.

**File: `packages/contracts/src/money.ts`** (change)

```diff
@@ -14,6 +14,16 @@ export const amountSchema = z
   .refine((value) => value === '' || MONEY.test(value), errorCode('money_format'))
   .transform((value) => (value === '' ? '0' : value));
 
+// A price that may be left out (step 12: a variant's sale price). '' (an empty box) is "no fixed
+// price" — a garments factory prices each buyer's PO — and is stored as NULL, never as 0, because a
+// price of zero is a real price (a free sample).
+export const priceSchema = z
+  .string()
+  .trim()
+  .refine((value) => value === '' || MONEY.test(value), errorCode('money_format'))
+  .transform((value) => (value === '' ? null : value))
+  .nullable();
+
 // The arithmetic below works in ten-thousandths of a taka, as BigInt: "18450.5" is 184505000n.
 // Exact like decimal.js for what the journal does — adding and subtracting amounts with at most
 // 4 decimals, so nothing is ever rounded — and it keeps this package on zod alone (the
```

`priceSchema` is `amountSchema`'s sibling for a value that may be left out. `amountSchema` turns `''` into `'0'`
(a journal line side that is empty is zero). A price must not: an empty price box is "no fixed price" — a garments
factory prices each buyer's PO — and zero is a real price (a free sample). So `''` becomes `null`.

**File: `packages/contracts/src/products.ts`** (new)

```ts
import { z } from 'zod';

import { customFieldValuesSchema } from './custom-fields.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import type { Industry } from './setup.js';
import { factorSchema } from './units.js';

// goods = kept in stock (from step 13); service = sold, never stocked (stitching charge, delivery)
export const PRODUCT_TYPES = ['goods', 'service'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

// How each unit of stock is told apart (build plan 0.3): not at all (a T-shirt), by batch or lot
// (a medicine, with its expiry), or one by one (a phone, by IMEI). Set per product; the batch and
// serial screens come with the stock steps.
export const TRACKING_MODES = ['none', 'batch', 'serial'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export function isTrackingMode(value: string): value is TrackingMode {
  return TRACKING_MODES.some((mode) => mode === value);
}

// What a new product's form starts with, by business type: a pharma company tracks every product
// by batch with an expiry date; the others start untracked and switch per product (a retailer's
// milk has an expiry, its T-shirts do not)
export function trackingDefault(industry: Industry | null): {
  tracking: TrackingMode;
  hasExpiry: boolean;
} {
  return industry === 'pharma'
    ? { tracking: 'batch', hasExpiry: true }
    : { tracking: 'none', hasExpiry: false };
}

// Up to three options (Size, Colour, Fit) like most shops and ERPs; 300 variants is a garments
// style in 12 sizes and 25 colours, with room to spare
export const MAX_PRODUCT_OPTIONS = 3;
export const MAX_OPTION_VALUES = 50;
export const MAX_VARIANTS = 300;
export const MAX_PRODUCT_UNITS = 10;

// ---------------------------------------------------------------------------------------------
// Codes and barcodes

// Letters of any script and digits, then dots, slashes, underscores or hyphens: P-00042,
// ST-2026/118, NAPA-500. No spaces: a code is typed into a scanner field and searched for whole.
const CODE = /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;

function optionalCode(code: 'product_code_format' | 'product_sku_format') {
  return z
    .string()
    .trim()
    .max(40, errorCode(code))
    .refine((value) => value === '' || CODE.test(value), errorCode(code))
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

// A variant's SKU when the person leaves it empty: the product's code for a simple product,
// the code and the option values for a variant — ST-118 + [M, Navy blue] → ST-118-M-NAVY-BLUE.
// Anything a code may not hold (spaces, &) becomes a hyphen.
export function variantSku(productCode: string, optionValues: readonly string[]): string {
  const parts = optionValues.map((value) =>
    value
      .toUpperCase()
      .replace(/[^\p{L}\p{N}._/]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  );
  return [productCode, ...parts.filter((part) => part !== '')].join('-').slice(0, 40);
}

// GS1's check digit (EAN-8, UPC-A, EAN-13): from the right, the digits are weighted 3, 1, 3, …;
// the check digit makes the sum a multiple of 10. A typo in one digit always breaks it.
export function hasValidCheckDigit(digits: string): boolean {
  let sum = 0;
  for (let index = digits.length - 2, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(digits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

// What a scanner types: printable ASCII without spaces (Code 128 can hold all of it). 8, 12 or 13
// digits is a retail barcode (EAN-8, UPC-A, EAN-13) and must pass its check digit — a typed barcode
// with one wrong digit is refused here instead of never matching at the till.
const BARCODE = /^[\x21-\x7E]{1,48}$/;
const GTIN = /^(?:\d{8}|\d{12}|\d{13})$/;

export const barcodeSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || BARCODE.test(value), errorCode('barcode_format'))
  .refine(
    (value) => !GTIN.test(value) || hasValidCheckDigit(value),
    errorCode('barcode_check_digit'),
  )
  .transform((value) => (value === '' ? null : value))
  .nullable();

// ---------------------------------------------------------------------------------------------
// What the API sends

export const productOptionSchema = z.object({
  name: z.string(),
  // In the order the person typed them: S, M, L, XL — not alphabetical
  values: z.array(z.string()),
});
export type ProductOption = z.infer<typeof productOptionSchema>;

// The thing that is stocked and sold. A simple product has exactly one, with no option values;
// stock, sales and purchase lines (steps 13–17) always point at a variant.
export const productVariantSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  // One value per option, in the options' order: ['M', 'Navy blue']
  optionValues: z.array(z.string()),
  // The barcode of one base unit
  barcode: z.string().nullable(),
  // Per base unit, a decimal string like every amount; null = no fixed price
  salePrice: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});
export type ProductVariant = z.infer<typeof productVariantSchema>;

// A bigger unit the product also comes in: a box of 10 strips, a carton of 24, a 50 kg sack
export const productUnitSchema = z.object({
  unitId: z.uuid(),
  // How many base units one of these is, as a decimal string: "24", "0.914400"
  factor: z.string(),
  // The pack's own barcode (a carton's ITF or EAN). Only on products without variants.
  barcode: z.string().nullable(),
});
export type ProductUnit = z.infer<typeof productUnitSchema>;

export const productSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  // z.string(), not enums: a newer server's new type or tracking mode must not break an older
  // offline client (the rule of error codes and account purposes)
  type: z.string(),
  categoryId: z.uuid().nullable(),
  description: z.string().nullable(),
  // Stock is always counted in this unit
  baseUnitId: z.uuid(),
  // The unit sales and purchase forms start with; null = the base unit
  salesUnitId: z.uuid().nullable(),
  purchaseUnitId: z.uuid().nullable(),
  tracking: z.string(),
  // Batches carry an expiry date (medicine, food)
  hasExpiry: z.boolean(),
  // Empty = a simple product
  options: z.array(productOptionSchema),
  variants: z.array(productVariantSchema),
  units: z.array(productUnitSchema),
  // Every saved value, the archived fields' too (the form shows only the active ones)
  customFields: customFieldValuesSchema,
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof productSchema>;

// One row of the list: no variants, units or custom fields — a page of 50 stays small
export const productSummarySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  categoryId: z.uuid().nullable(),
  baseUnitId: z.uuid(),
  tracking: z.string(),
  hasVariants: z.boolean(),
  // Active variants only
  variantCount: z.number().int(),
  // The lowest and highest sale price of the active variants; null when none has a price
  minPrice: z.string().nullable(),
  maxPrice: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ProductSummary = z.infer<typeof productSummarySchema>;

// ---------------------------------------------------------------------------------------------
// What a form or an import sends

// The form's "None" options send '' for "not chosen"
const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const optionValueSchema = z.string().trim().min(1).max(40);

const productOptionInputSchema = z.object({
  name: z.string().trim().min(1, errorCode('product_option_name_required')).max(30),
  values: z
    .array(optionValueSchema)
    .min(1, errorCode('product_option_values_required'))
    .max(MAX_OPTION_VALUES),
});

const productVariantInputSchema = z.object({
  // An existing variant keeps its id (its stock and history from step 13 hang on it); null = new
  id: z.uuid().nullable(),
  // null = made from the product's code (variantSku)
  sku: optionalCode('product_sku_format'),
  optionValues: z.array(optionValueSchema).max(MAX_PRODUCT_OPTIONS),
  barcode: barcodeSchema,
  salePrice: priceSchema,
  // A colour that is no longer made: hidden from new sales, kept for the history
  archived: z.boolean(),
});
export type ProductVariantInput = z.input<typeof productVariantInputSchema>;

const productUnitInputSchema = z.object({
  unitId: z.uuid(errorCode('product_unit_required')),
  factor: factorSchema,
  barcode: barcodeSchema,
});

// The fields without the cross-field rules below: the product form extends it with the
// workspace's own custom fields, then adds the same rules (productRules) on top
export const productFieldsSchema = z.object({
  // null = the next number from the 'inventory.product' series (P-00042)
  code: optionalCode('product_code_format'),
  name: z.string().trim().min(2, errorCode('product_name_required')).max(120),
  type: z.enum(PRODUCT_TYPES),
  categoryId: optionalIdSchema,
  description: optionalText(500),
  baseUnitId: z.uuid(errorCode('product_unit_required')),
  // null or '' = the base unit
  salesUnitId: optionalIdSchema,
  purchaseUnitId: optionalIdSchema,
  tracking: z.enum(TRACKING_MODES),
  hasExpiry: z.boolean(),
  options: z.array(productOptionInputSchema).max(MAX_PRODUCT_OPTIONS),
  variants: z.array(productVariantInputSchema).min(1).max(MAX_VARIANTS),
  units: z.array(productUnitInputSchema).max(MAX_PRODUCT_UNITS),
  customFields: customFieldValuesSchema,
});

type ProductRuleInput = Omit<z.output<typeof productFieldsSchema>, 'customFields'>;

// The rules between fields. Each error sits on the field the person has to change, so the form
// shows it in the right place — and the import maps the same paths to its CSV columns.
export function productRules(input: ProductRuleInput, ctx: z.RefinementCtx<ProductRuleInput>) {
  const issue = (path: (string | number)[], code: Parameters<typeof errorCode>[0]) => {
    ctx.addIssue({ code: 'custom', path, message: errorCode(code) });
  };

  // Options: each name once, each value once inside its option (case does not make a new one)
  const optionNames = new Set<string>();
  input.options.forEach((option, index) => {
    const name = option.name.toLowerCase();
    if (optionNames.has(name)) issue(['options', index, 'name'], 'product_option_twice');
    optionNames.add(name);
    const values = new Set<string>();
    option.values.forEach((value, valueIndex) => {
      if (values.has(value.toLowerCase())) {
        issue(['options', index, 'values', valueIndex], 'product_option_value_twice');
      }
      values.add(value.toLowerCase());
    });
  });

  // Variants: a simple product has one, without values; otherwise every variant has one value of
  // each option, and no two variants the same values
  if (input.options.length === 0) {
    if (input.variants.length !== 1 || input.variants[0]?.optionValues.length !== 0) {
      issue(['variants'], 'product_variants_simple');
    }
  } else {
    const combinations = new Set<string>();
    input.variants.forEach((variant, index) => {
      const fits =
        variant.optionValues.length === input.options.length &&
        variant.optionValues.every((value, k) => input.options[k]?.values.includes(value));
      if (!fits) issue(['variants', index, 'optionValues'], 'product_variant_values');
      const key = JSON.stringify(variant.optionValues);
      if (combinations.has(key))
        issue(['variants', index, 'optionValues'], 'product_variant_twice');
      combinations.add(key);
    });
  }
  if (input.variants.every((variant) => variant.archived)) {
    issue(['variants'], 'product_variant_last_active');
  }

  // Units: each once, never the base unit itself, and the default units are among them
  const unitIds = new Set<string>();
  input.units.forEach((unit, index) => {
    if (unit.unitId === input.baseUnitId) issue(['units', index, 'unitId'], 'product_unit_is_base');
    else if (unitIds.has(unit.unitId)) issue(['units', index, 'unitId'], 'product_unit_twice');
    unitIds.add(unit.unitId);
    if (input.options.length > 0 && unit.barcode !== null) {
      issue(['units', index, 'barcode'], 'product_pack_barcode_variants');
    }
  });
  for (const field of ['salesUnitId', 'purchaseUnitId'] as const) {
    const unitId = input[field];
    if (unitId !== null && unitId !== input.baseUnitId && !unitIds.has(unitId)) {
      issue([field], 'product_default_unit_invalid');
    }
  }

  // Tracking: a service is never stocked; an expiry belongs to a batch
  if (input.type === 'service' && input.tracking !== 'none') {
    issue(['tracking'], 'product_tracking_service');
  }
  if (input.hasExpiry && input.tracking !== 'batch')
    issue(['hasExpiry'], 'product_expiry_needs_batch');

  // A barcode or a SKU means one thing: checked across the whole form here, and across the
  // workspace by the database's unique indexes
  const barcodes = new Set<string>();
  const seeBarcode = (barcode: string | null, path: (string | number)[]) => {
    if (barcode === null) return;
    if (barcodes.has(barcode)) issue(path, 'barcode_twice');
    barcodes.add(barcode);
  };
  const skus = new Set<string>();
  input.variants.forEach((variant, index) => {
    seeBarcode(variant.barcode, ['variants', index, 'barcode']);
    if (variant.sku === null) return;
    if (skus.has(variant.sku.toLowerCase())) issue(['variants', index, 'sku'], 'product_sku_twice');
    skus.add(variant.sku.toLowerCase());
  });
  input.units.forEach((unit, index) => {
    seeBarcode(unit.barcode, ['units', index, 'barcode']);
  });
}

export const productInputSchema = productFieldsSchema.superRefine(productRules);
export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductFormValues = z.input<typeof productInputSchema>;

export const updateProductInputSchema = productFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(productRules);
export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;

export const productVersionInputSchema = z.object({ version: versionSchema });

export const deleteProductQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// The list

export const PRODUCT_SORTS = ['name', '-name', 'code', '-code', '-updated'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const productListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code or a SKU, or a whole barcode (a scan into the search box)
  search: z.string().trim().max(100).optional(),
  // This category and every category under it
  categoryId: z.uuid().optional(),
  status: z.enum(PRODUCT_STATUSES).default('active'),
  sort: z.enum(PRODUCT_SORTS).default('name'),
});
export type ProductListQuery = z.input<typeof productListQuerySchema>;

export const productPageSchema = pageOf(productSummarySchema);
export type ProductPage = z.infer<typeof productPageSchema>;

const productParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the chart of accounts: every sales, purchase and stock line
// picks a product. A product holds no cost (step 14's valuation does), so the list shows no margin.
export const productRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/products',
    summary: 'Products, a page at a time, searched, filtered and sorted on the server',
    auth: 'bearer',
    status: 200,
    query: productListQuerySchema,
    response: productPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/products/:id',
    summary: 'One product with its variants, units and custom fields',
    auth: 'bearer',
    status: 200,
    params: productParamsSchema,
    response: productSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/products',
    summary: 'Add a product with its variants and units',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: productInputSchema,
    response: productSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/products/:id',
    summary: 'Change a product: the variants and units sent replace the ones it had',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: productParamsSchema,
    body: updateProductInputSchema,
    response: productSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/products/:id/archive',
    summary: 'Hide a product from new documents; its history stays',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: productParamsSchema,
    body: productVersionInputSchema,
    response: productSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/products/:id/restore',
    summary: 'Bring an archived product back',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: productParamsSchema,
    body: productVersionInputSchema,
    response: productSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/products/:id',
    summary: 'Delete a product that no document uses yet',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 204,
    params: productParamsSchema,
    query: deleteProductQuerySchema,
    response: z.void(),
  }),
};
```

- **`variantSku()`** makes a SKU from the code and the option values: uppercase, every character a code may not hold
  becomes a hyphen, leading and trailing hyphens trimmed, and the whole cut to 40 characters (the code limit). The
  regex uses `\p{L}\p{N}` so Bangla values stay as they are.
- **`hasValidCheckDigit()`** is GS1's rule for EAN-8, UPC-A and EAN-13: from the right, the digits before the check
  digit are weighted 3, 1, 3, …; the check digit makes the sum a multiple of 10. A loop over indices, not
  `[...digits]`: the lint rule `no-misused-spread` refuses spreading a string (it can split letters, step 11).
- **`barcodeSchema`** accepts printable ASCII without spaces (what Code 128 can hold), and verifies the check digit
  only when the value looks like a retail barcode (8, 12 or 13 digits). A store's own code like `ST-118-M` is not
  checked. The second `refine` runs on `''` too, but `GTIN.test('')` is false, so an empty box passes.
- **`productSchema.options` and `variants`.** A simple product has `options: []` and one variant with
  `optionValues: []`. `hasVariants` in the list is just `options.length > 0`; no column stores it, so it can never
  disagree with the options.
- **`salesUnitId` / `purchaseUnitId` are `null` for the base unit.** "No default pack" and "the base unit" are the
  same thing, so there is one way to write it.
- **`productSummarySchema`** is the list's row: no variants, units or custom fields, so a page of 50 stays small.
  `minPrice`/`maxPrice` let the list show "৳600.00 – ৳650.00" without loading the variants.
- **`productVariantInputSchema.id`** is `null` for a new variant and the existing id otherwise. That is what keeps a
  variant's identity (and from step 13 its stock) when the form is saved again.
- **`productFieldsSchema` and `productRules` are separate**, and `productInputSchema` joins them. The reason is Zod 4:
  `.extend()` is refused on a schema that has refinements. The product form extends the plain fields with the
  workspace's custom fields and the version, then adds the same `productRules` — one set of rules, two shapes.
- **`productRules` puts each error on the field to change:** `options.1.name` for a repeated option,
  `variants.2.optionValues` for a variant whose values do not fit, `units.0.barcode` for a pack barcode on a variant
  product. The form shows them under the right box, and the import maps the same paths to CSV columns.
- **"Every variant archived" is refused** (`product_variant_last_active`): a product with no sellable variant is an
  archived product, and there is a button for that.
- **The barcode and SKU checks in `productRules`** catch a value used twice inside one product, before the request is
  sent. Across the workspace, the database's unique indexes are the guard.
- **`updateProductInputSchema`** extends the plain fields with the version and adds the rules again — again because
  a refined schema cannot be extended.
- **`trackingDefault()`** is decision 1 of build plan 0.3: a pharma workspace's new products start with batch
  tracking and expiry; the others start untracked.
- **`productListQuerySchema`** has `search`, `categoryId`, `status` (active or archived) and `sort`. Five orders, each
  with a stable tie-breaker on the server (12.4).

**File: `packages/contracts/src/product-imports.ts`** (new)

```ts
import { z } from 'zod';

import { uploadTicketSchema } from './attachments.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// A CSV file of products, checked and saved by the worker: every row is right and every product
// is created, or nothing is (you chose "all or nothing"). Fixing a file and importing it again is
// then always safe — there is never a half-imported file to clean up first.

// uploading = the row and the upload address exist, the file is on its way to storage
// queued      = the file is in storage and the worker has been asked
// done        = every product was created
// failed      = nothing was created; `errors` says what to fix
export const PRODUCT_IMPORT_STATUSES = ['uploading', 'queued', 'done', 'failed'] as const;
export type ProductImportStatus = (typeof PRODUCT_IMPORT_STATUSES)[number];

// 10,000 rows of products is about 2 MB; 5 MB leaves room for long names and many custom fields
export const PRODUCT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMPORT_MAX_ROWS = 10_000;
// A file with a wrong unit in every row would list 10,000 errors. The first 100 say what to fix.
export const PRODUCT_IMPORT_MAX_ERRORS = 100;

// The columns, in the template's order. Only name and unit must be there; a missing column is the
// same as an empty one. Rows with the same code are the variants of one product.
export const PRODUCT_IMPORT_COLUMNS = [
  'code',
  'name',
  'type',
  'category',
  'unit',
  'sale_price',
  'sku',
  'barcode',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'option3_name',
  'option3_value',
  'sales_unit',
  'purchase_unit',
  'pack1_unit',
  'pack1_factor',
  'pack1_barcode',
  'pack2_unit',
  'pack2_factor',
  'pack2_barcode',
  'tracking',
  'expiry',
  'description',
] as const;
export type ProductImportColumn = (typeof PRODUCT_IMPORT_COLUMNS)[number];

export const PRODUCT_IMPORT_REQUIRED_COLUMNS = ['name', 'unit'] as const;

// A custom field's column is its key after this prefix: cf_generic_name
export const CUSTOM_FIELD_COLUMN_PREFIX = 'cf_';

// A category path in one cell: "Fabrics > Knit"
export const CATEGORY_PATH_SEPARATOR = '>';

export const createProductImportInputSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => name.toLowerCase().endsWith('.csv'), errorCode('import_file_type')),
  sizeBytes: z.number().int().positive().max(PRODUCT_IMPORT_MAX_BYTES, errorCode('file_too_large')),
});
export type CreateProductImportInput = z.infer<typeof createProductImportInputSchema>;

// One thing to fix. row is the spreadsheet's row number (the header is row 1, as Excel shows it);
// null = the whole file (a missing column, a file that is not UTF-8). column is the CSV column.
export const productImportErrorSchema = z.object({
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  // An error code like the API's (z.string(): the same rule as everywhere), with its values
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type ProductImportError = z.infer<typeof productImportErrorSchema>;

export const productImportSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(PRODUCT_IMPORT_STATUSES),
  // Set by the worker: the data rows read, and the products made from them (done only)
  rowCount: z.number().int().nullable(),
  productCount: z.number().int().nullable(),
  // How many problems were found; the detail route lists the first 100
  errorCount: z.number().int(),
  requestedBy: z.object({ id: z.uuid(), fullName: z.string() }),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ProductImport = z.infer<typeof productImportSchema>;

export const productImportDetailSchema = productImportSchema.extend({
  errors: z.array(productImportErrorSchema),
});
export type ProductImportDetail = z.infer<typeof productImportDetailSchema>;

// The import row, plus where to PUT the file: the same short-lived address as an attachment's
export const productImportTicketSchema = z.object({
  import: productImportSchema,
  upload: uploadTicketSchema.shape.upload,
});

export const productImportPageSchema = pageOf(productImportSchema);

const importParamsSchema = z.object({ id: z.uuid() });

// The whole workspace's imports, not only your own (unlike report exports): an import changes the
// product list everybody works with, so whoever manages products sees what came in and from whom
export const productImportRoutes = {
  create: defineRoute({
    method: 'POST',
    path: '/product-imports',
    summary: 'Describe a CSV file of products and get a short-lived URL to upload it',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: createProductImportInputSchema,
    response: productImportTicketSchema,
  }),
  start: defineRoute({
    method: 'POST',
    path: '/product-imports/:id/start',
    summary: 'Confirm the upload and ask the worker to check and import the file',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: importParamsSchema,
    response: productImportSchema,
  }),
  list: defineRoute({
    method: 'GET',
    path: '/product-imports',
    summary: 'The product imports of the workspace, newest first',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    query: pageQuerySchema,
    response: productImportPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/product-imports/:id',
    summary: 'One import, with the first 100 problems found in its file',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: importParamsSchema,
    response: productImportDetailSchema,
  }),
};
```

- **The four statuses.** `uploading` exists so that a row and its upload address can be made before the file
  arrives; `start` moves it to `queued` only after the API has seen the file in storage. A row stuck in `uploading`
  is an upload the browser never finished, and it never reaches the worker.
- **The limits** (10,000 rows, 5 MB, 100 errors listed) are exported, so the page's text and the worker use the same
  numbers.
- **`PRODUCT_IMPORT_COLUMNS`** is the template's order and the list of known columns. Only `name` and `unit` must be
  there; a missing column is the same as an empty one, so a simple file can be just `name,unit,sale_price`.
- **`createProductImportInputSchema` checks the name and the size, not the content type.** Windows reports a `.csv`
  as `application/vnd.ms-excel`, so the browser's word is not useful. The API signs the upload for `text/csv` itself
  (12.4).
- **`productImportErrorSchema.row` is the spreadsheet's row number** (the header is row 1), because that is the
  number the person sees in Excel when they go to fix it. `null` = the whole file.
- **`productImportSchema.errorCount` and `productImportDetailSchema.errors`.** The list carries only the count; the
  detail route carries the first 100 problems. A list of 50 imports with 100 problems each would be a heavy page for
  nothing.
- **`productImportTicketSchema.upload`** reuses the attachment's upload shape (`uploadTicketSchema.shape.upload`), so
  the browser code that uploads a logo and the code that uploads a CSV read the same fields.
- **Every product manager sees every import** (decision 14), unlike report exports, which are private copies of the
  books.

**File: `packages/contracts/src/errors.ts`** (change)

```diff
@@ -102,6 +102,72 @@ export const ERROR_CODES = [
   'year_earlier_open',
   'year_later_closed',
   'export_not_ready',
+  // units, categories and custom fields (step 12)
+  'factor_format',
+  'unit_code_format',
+  'unit_code_taken',
+  'unit_name_required',
+  'unit_in_use',
+  'category_name_required',
+  'category_name_taken',
+  'category_parent_invalid',
+  'category_parent_loop',
+  'category_has_children',
+  'category_in_use',
+  'custom_field_key_format',
+  'custom_field_key_taken',
+  'custom_field_label_required',
+  'custom_field_option_twice',
+  'custom_field_options_required',
+  'custom_field_unknown',
+  'number_format',
+  // products
+  'product_code_format',
+  'product_code_taken',
+  'product_sku_format',
+  'product_sku_taken',
+  'product_sku_twice',
+  'product_name_required',
+  'product_unit_required',
+  'product_unit_invalid',
+  'product_unit_is_base',
+  'product_unit_twice',
+  'product_default_unit_invalid',
+  'product_factor_standard',
+  'product_option_name_required',
+  'product_option_values_required',
+  'product_option_twice',
+  'product_option_value_twice',
+  'product_variants_simple',
+  'product_variant_values',
+  'product_variant_twice',
+  'product_variant_last_active',
+  'product_variant_unknown',
+  'product_variant_in_use',
+  'product_pack_barcode_variants',
+  'product_tracking_service',
+  'product_expiry_needs_batch',
+  'product_category_invalid',
+  'product_in_use',
+  'barcode_format',
+  'barcode_check_digit',
+  'barcode_taken',
+  'barcode_twice',
+  // product imports
+  'import_file_type',
+  'import_not_uploaded',
+  'import_not_pending',
+  'import_encoding',
+  'import_csv_malformed',
+  'import_empty',
+  'import_too_many_rows',
+  'import_column_missing',
+  'import_column_unknown',
+  'import_row_conflict',
+  'import_unit_unknown',
+  'import_category_invalid',
+  'import_value_invalid',
+  'import_options_without_code',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

63 new codes, in three groups. Each one needs its text in `en.ts` and `bn.ts` (12.6) — the type check fails until
they are written.

**File: `packages/contracts/src/permissions.ts`** (change)

```diff
@@ -15,6 +15,7 @@ export const PERMISSION_KEYS = [
   'accounting.journal.post',
   'accounting.period.close',
   'accounting.report.read',
+  'inventory.product.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -27,7 +28,7 @@ export function isPermissionKey(value: string): value is PermissionKey {
 
 // matrix-এর সারি কোন দলে: key-র মাঝের অংশ (resource) দিয়ে না, হাতে বাছা — "Team" দলে user আর role
 // দুটোই থাকে, কারণ মানুষ দুটোকে একই কাজ ভাবে। Record<PermissionKey, …>: নতুন key দল ছাড়া থাকতে পারে না
-export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting'] as const;
+export const PERMISSION_GROUPS = ['team', 'workspace', 'accounting', 'inventory'] as const;
 export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
 
 export const PERMISSION_GROUP_OF = {
@@ -44,4 +45,5 @@ export const PERMISSION_GROUP_OF = {
   'accounting.journal.post': 'accounting',
   'accounting.period.close': 'accounting',
   'accounting.report.read': 'accounting',
+  'inventory.product.manage': 'inventory',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

A new key and a new group, `inventory`. `PERMISSION_GROUP_OF` is `satisfies Record<PermissionKey, …>`, so the key
cannot be added without its group, and the Roles page's matrix gets a new "Inventory" section by itself.

**File: `packages/contracts/src/audit.ts`** (change)

```diff
@@ -43,6 +43,25 @@ export const AUDIT_ACTIONS = [
   'books.lock_date_changed',
   'books.year_closed',
   'books.year_reopened',
+  'workspace.catalog_created',
+  'unit.created',
+  'unit.updated',
+  'unit.archived',
+  'unit.restored',
+  'unit.deleted',
+  'product_category.created',
+  'product_category.updated',
+  'product_category.deleted',
+  'custom_field.created',
+  'custom_field.updated',
+  'custom_field.archived',
+  'custom_field.restored',
+  'product.created',
+  'product.updated',
+  'product.archived',
+  'product.restored',
+  'product.deleted',
+  'product.imported',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -62,6 +81,11 @@ export const AUDIT_ENTITY_TYPES = [
   'role',
   'account',
   'journal_entry',
+  'unit',
+  'product_category',
+  'custom_field',
+  'product',
+  'product_import',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

19 actions and 5 entity types. `product.imported` belongs to the entity `product_import`: the log row is about the
file, and its `changes` say how many products it made.

**File: `packages/contracts/src/notifications.ts`** (change)

```diff
@@ -6,12 +6,16 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // Every kind of in-app notification. The server stores the type and a few values (params), never a
 // sentence: the app turns them into text in the reader's language (notifications.types.* in en.ts).
 // report.ready / report.failed: params { report, format } — the export the person asked for
+// import.done: params { file, count } — count = products made; import.failed: { file, count } —
+// count = problems found
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
   'invitation.failed',
   'report.ready',
   'report.failed',
+  'import.done',
+  'import.failed',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

Two notification types. Their params are plain values (the file name, a count), never sentences: the bell writes the
text in the reader's language.

**File: `packages/contracts/src/numbering.ts`** (change)

```diff
@@ -12,6 +12,7 @@ export const DOCUMENT_TYPES = [
   'purchase.bill',
   'inventory.receipt',
   'accounting.journal',
+  'inventory.product',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -32,10 +33,16 @@ const DEFAULT_PREFIXES = {
   'purchase.bill': 'BILL',
   'inventory.receipt': 'GRN',
   'accounting.journal': 'JV',
+  'inventory.product': 'P',
 } satisfies Record<DocumentType, string>;
 
-// টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়
+// টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
+// A product code is not a yearly document: P-00042 stays P-00042 for the product's whole life, so
+// its series never restarts (no year) and has room for 99,999 products before it grows a digit.
 export function defaultNumberFormat(documentType: DocumentType): NumberFormat {
+  if (documentType === 'inventory.product') {
+    return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'none', padding: 5 };
+  }
   return { prefix: DEFAULT_PREFIXES[documentType], yearStyle: 'fiscal', padding: 4 };
 }
 
```

- **`'inventory.product'` is a new number series**, so product codes get the step 6 machinery for free: a counter in
  the same transaction (a rolled-back product gives its number back), and the Numbering page to change the prefix.
- **Its default has no year and 5 digits.** A document number restarts every fiscal year (`JV-2026-27-0001`); a
  product code lasts for the product's whole life, and two products called `P-0001` in two years would be a disaster
  at the till. The `if` keeps every other type's default exactly as it was.

**File: `packages/contracts/src/routes.ts`** (change)

```diff
@@ -13,9 +13,14 @@ import { notificationRoutes } from './notifications.js';
 import { numberSeriesRoutes } from './numbering.js';
 import { meRoutes } from './preferences.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
+import { customFieldRoutes } from './custom-fields.js';
+import { productCategoryRoutes } from './product-categories.js';
+import { productImportRoutes } from './product-imports.js';
+import { productRoutes } from './products.js';
 import { roleRoutes } from './roles.js';
 import { settingsRoutes } from './settings.js';
 import { setupRoutes } from './setup.js';
+import { unitRoutes } from './units.js';
 
 export const healthRoutes = {
   check: defineRoute({
@@ -52,4 +57,9 @@ export const routes = {
   reports: reportRoutes,
   fiscalYears: fiscalYearRoutes,
   reportExports: reportExportRoutes,
+  units: unitRoutes,
+  productCategories: productCategoryRoutes,
+  customFields: customFieldRoutes,
+  products: productRoutes,
+  productImports: productImportRoutes,
 };
```

Five route groups. The API's `contract.spec.ts` checks that Nest's routes and this map match exactly, so a route
written here and forgotten in a controller fails `pnpm test`.

**File: `packages/contracts/src/index.ts`** (change)

```diff
@@ -3,6 +3,7 @@ export * from './attachments.js';
 export * from './audit.js';
 export * from './auth.js';
 export * from './branches.js';
+export * from './custom-fields.js';
 export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
@@ -15,8 +16,12 @@ export * from './numbering.js';
 export * from './pagination.js';
 export * from './permissions.js';
 export * from './preferences.js';
+export * from './product-categories.js';
+export * from './product-imports.js';
+export * from './products.js';
 export * from './reports.js';
 export * from './roles.js';
 export * from './routes.js';
 export * from './settings.js';
 export * from './setup.js';
+export * from './units.js';
```

**File: `packages/contracts/src/products.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { customFieldsInputSchema } from './custom-fields.js';
import {
  barcodeSchema,
  hasValidCheckDigit,
  productInputSchema,
  type ProductFormValues,
  variantSku,
} from './products.js';
import { createUnitInputSchema, sameFactor, standardFactor } from './units.js';

const pcs = '01939d1c-0000-7000-8000-000000000001';
const carton = '01939d1c-0000-7000-8000-000000000002';
const dozen = '01939d1c-0000-7000-8000-000000000003';

function variant(optionValues: string[] = [], extra: object = {}) {
  return { id: null, sku: '', optionValues, barcode: '', salePrice: '', archived: false, ...extra };
}

function product(extra: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    code: '',
    name: 'Basic crew-neck T-shirt',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    options: [],
    variants: [variant()],
    units: [],
    customFields: {},
    ...extra,
  };
}

// The first problem's path and code — what the form puts under a field
function firstIssue(input: ProductFormValues) {
  const issue = productInputSchema.safeParse(input).error?.issues[0];
  return issue && { path: issue.path.join('.'), message: issue.message };
}

describe('product input', () => {
  it('turns the empty boxes of a simple product into nulls', () => {
    const parsed = productInputSchema.parse(
      product({ variants: [variant([], { salePrice: '450' })] }),
    );
    expect(parsed).toMatchObject({ code: null, categoryId: null, salesUnitId: null });
    expect(parsed.variants[0]).toMatchObject({ sku: null, barcode: null, salePrice: '450' });
  });

  it('gives a simple product exactly one variant, without option values', () => {
    expect(firstIssue(product({ variants: [variant(), variant()] }))).toEqual({
      path: 'variants',
      message: 'product_variants_simple',
    });
    expect(firstIssue(product({ variants: [variant(['M'])] }))).toEqual({
      path: 'variants',
      message: 'product_variants_simple',
    });
  });

  it('takes variants with one value of every option, each combination once', () => {
    const options = [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Navy', 'White'] },
    ];
    expect(
      productInputSchema.safeParse(
        product({ options, variants: [variant(['S', 'Navy']), variant(['M', 'White'])] }),
      ).success,
    ).toBe(true);
    expect(firstIssue(product({ options, variants: [variant(['S'])] }))).toEqual({
      path: 'variants.0.optionValues',
      message: 'product_variant_values',
    });
    expect(firstIssue(product({ options, variants: [variant(['XL', 'Navy'])] }))).toEqual({
      path: 'variants.0.optionValues',
      message: 'product_variant_values',
    });
    expect(
      firstIssue(product({ options, variants: [variant(['S', 'Navy']), variant(['S', 'Navy'])] })),
    ).toEqual({ path: 'variants.1.optionValues', message: 'product_variant_twice' });
  });

  it('refuses an option or a value twice, whatever the case', () => {
    expect(
      firstIssue(
        product({
          options: [
            { name: 'Size', values: ['S'] },
            { name: 'size', values: ['M'] },
          ],
          variants: [variant(['S', 'M'])],
        }),
      ),
    ).toEqual({ path: 'options.1.name', message: 'product_option_twice' });
    expect(
      firstIssue(
        product({ options: [{ name: 'Size', values: ['M', 'm'] }], variants: [variant(['M'])] }),
      ),
    ).toEqual({ path: 'options.0.values.1', message: 'product_option_value_twice' });
  });

  it('keeps one variant active', () => {
    expect(firstIssue(product({ variants: [variant([], { archived: true })] }))).toEqual({
      path: 'variants',
      message: 'product_variant_last_active',
    });
  });

  it('checks the packs and the default units against the base unit', () => {
    const units = [{ unitId: carton, factor: '24', barcode: '' }];
    expect(productInputSchema.safeParse(product({ units, salesUnitId: carton })).success).toBe(
      true,
    );
    expect(firstIssue(product({ units: [{ unitId: pcs, factor: '1', barcode: '' }] }))).toEqual({
      path: 'units.0.unitId',
      message: 'product_unit_is_base',
    });
    expect(firstIssue(product({ units: [...units, ...units] }))).toEqual({
      path: 'units.1.unitId',
      message: 'product_unit_twice',
    });
    expect(firstIssue(product({ units, purchaseUnitId: dozen }))).toEqual({
      path: 'purchaseUnitId',
      message: 'product_default_unit_invalid',
    });
    expect(firstIssue(product({ units: [{ unitId: carton, factor: '0', barcode: '' }] }))).toEqual({
      path: 'units.0.factor',
      message: 'factor_format',
    });
  });

  it('keeps services untracked and expiry dates on batches', () => {
    expect(firstIssue(product({ type: 'service', tracking: 'batch' }))).toEqual({
      path: 'tracking',
      message: 'product_tracking_service',
    });
    expect(firstIssue(product({ tracking: 'serial', hasExpiry: true }))).toEqual({
      path: 'hasExpiry',
      message: 'product_expiry_needs_batch',
    });
  });

  it('finds a barcode or a SKU used twice in one product', () => {
    const options = [{ name: 'Size', values: ['S', 'M'] }];
    expect(
      firstIssue(
        product({
          options,
          variants: [
            variant(['S'], { barcode: '8901234567890' }),
            variant(['M'], { barcode: '8901234567890' }),
          ],
        }),
      ),
    ).toEqual({ path: 'variants.1.barcode', message: 'barcode_twice' });
    expect(
      firstIssue(
        product({
          options,
          variants: [variant(['S'], { sku: 'ST-1' }), variant(['M'], { sku: 'st-1' })],
        }),
      ),
    ).toEqual({ path: 'variants.1.sku', message: 'product_sku_twice' });
  });

  it('keeps pack barcodes to products without variants', () => {
    expect(
      firstIssue(
        product({
          options: [{ name: 'Size', values: ['M'] }],
          variants: [variant(['M'])],
          units: [{ unitId: carton, factor: '24', barcode: '18901234567897' }],
        }),
      ),
    ).toEqual({ path: 'units.0.barcode', message: 'product_pack_barcode_variants' });
  });
});

describe('barcodes', () => {
  it('checks the check digit of retail barcodes only', () => {
    expect(hasValidCheckDigit('8941100500118')).toBe(true);
    expect(barcodeSchema.safeParse('8941100500118').success).toBe(true);
    // One digit typed wrong
    expect(barcodeSchema.safeParse('8941100500128').error?.issues[0]?.message).toBe(
      'barcode_check_digit',
    );
    // EAN-8 and UPC-A
    expect(barcodeSchema.safeParse('96385074').success).toBe(true);
    expect(barcodeSchema.safeParse('036000291452').success).toBe(true);
    // A store's own code is not a retail barcode: no check digit to check
    expect(barcodeSchema.safeParse('ST-118-M').success).toBe(true);
    expect(barcodeSchema.safeParse('has space').error?.issues[0]?.message).toBe('barcode_format');
  });
});

describe('variantSku', () => {
  it('joins the code and the values, as a code may be written', () => {
    expect(variantSku('ST-118', ['M', 'Navy blue'])).toBe('ST-118-M-NAVY-BLUE');
    expect(variantSku('ST-118', ['Black & white'])).toBe('ST-118-BLACK-WHITE');
    expect(variantSku('P-00042', [])).toBe('P-00042');
  });
});

describe('units', () => {
  const unit = (dimension: string, ratio: string | null) => ({ dimension, ratio });

  it('converts within a dimension, rounded to 6 places', () => {
    expect(standardFactor(unit('length', '0.914400'), unit('length', '1'))).toBe('0.914400');
    expect(standardFactor(unit('length', '1'), unit('length', '0.9144'))).toBe('1.093613');
    expect(standardFactor(unit('count', '12'), unit('count', '1'))).toBe('12.000000');
    expect(standardFactor(unit('weight', '1'), unit('weight', '0.001'))).toBe('1000.000000');
  });

  it('has no standard answer for packs or across dimensions', () => {
    expect(standardFactor(unit('count', null), unit('count', '1'))).toBeNull();
    expect(standardFactor(unit('weight', '1'), unit('count', '1'))).toBeNull();
  });

  it('compares factors as numbers', () => {
    expect(sameFactor('12', '12.000000')).toBe(true);
    expect(sameFactor('0.5', '0.50001')).toBe(false);
  });

  it('takes an empty ratio as a pack', () => {
    expect(
      createUnitInputSchema.parse({
        code: 'box',
        name: 'Box',
        dimension: 'count',
        ratio: '',
        decimals: 0,
      }).ratio,
    ).toBeNull();
    expect(
      createUnitInputSchema.safeParse({
        code: 'sq ft',
        name: 'Square foot',
        dimension: 'area',
        ratio: '0.092903',
        decimals: 2,
      }).error?.issues[0]?.message,
    ).toBe('unit_code_format');
  });
});

describe('custom field values', () => {
  const schema = customFieldsInputSchema([
    { key: 'generic_name', type: 'text', options: [], required: true },
    { key: 'gsm', type: 'number', options: [], required: false },
    { key: 'dosage_form', type: 'select', options: ['Tablet', 'Syrup'], required: false },
    { key: 'expiry_on_pack', type: 'boolean', options: [], required: false },
    { key: 'registered', type: 'date', options: [], required: false },
  ]);

  it('drops empty values and keeps the rest as they are', () => {
    expect(
      schema.parse({
        generic_name: ' Paracetamol ',
        gsm: '',
        dosage_form: 'Tablet',
        expiry_on_pack: true,
        registered: '',
      }),
    ).toEqual({ generic_name: 'Paracetamol', dosage_form: 'Tablet', expiry_on_pack: true });
  });

  it('says what is wrong with each value', () => {
    const issues = schema.safeParse({
      generic_name: '',
      gsm: '180 g',
      dosage_form: 'Capsule',
      registered: '2026-02-30',
    }).error?.issues;
    expect(issues?.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['generic_name', 'required'],
      ['gsm', 'number_format'],
      ['dosage_form', 'invalid_value'],
      ['registered', 'invalid_format'],
    ]);
  });

  it('refuses a field the workspace does not have', () => {
    expect(
      schema.safeParse({ generic_name: 'Paracetamol', fabric: 'Cotton' }).error?.issues[0]?.message,
    ).toBe('custom_field_unknown');
  });
});
```

The contract's rules, tested without a server: each test checks the path and the code of the first problem, because
that is what the form puts under a field. The barcodes `8941100500118`, `96385074` and `036000291452` are valid
EAN-13, EAN-8 and UPC-A numbers; `8941100500128` is the first one with one digit typed wrong. The unit tests include
the rounding case (a metre in yards) and the "no standard answer" cases. The custom field tests check that empty
values are dropped, that each wrong value names its own problem, and that an unknown key is refused.

```bash
pnpm --filter @omnivo/contracts test     # 76 tests — 18 new
pnpm --filter @omnivo/contracts build    # the API and the app read contracts from dist/
```

---

## 12.2 — `packages/db`: ten tables and two migrations

**File: `packages/db/src/schema/units.ts`** (new)

```ts
import { UNIT_DIMENSIONS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// The units of measure a workspace uses: pcs, kg, yard, box. Seeded from the industry template
// (step 12), then the workspace's own data. deleted_at is not used: a unit is deleted for real
// (only when no product uses it) or archived.
export const units = pgTable(
  'units',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    dimension: text('dimension', { enum: UNIT_DIMENSIONS }).notNull(),
    // How many of the dimension's reference unit one of this is (a yard = 0.9144 m). NULL = a pack
    // whose size each product says (box, carton, strip). NUMERIC(19,6), read and written as strings.
    ratio: numeric('ratio', { precision: 19, scale: 6 }),
    // Decimals a quantity in this unit may have (pcs 0, kg 3)
    decimals: smallint('decimals').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // "KG" and "kg" are one unit: people type codes in any case, and a CSV import matches them so
    uniqueIndex('units_tenant_code_idx').on(table.tenantId, sql`lower(${table.code})`),
    // The target of the composite FKs from products and product_units
    uniqueIndex('units_tenant_id_idx').on(table.tenantId, table.id),
    check('units_ratio_check', sql`${table.ratio} IS NULL OR ${table.ratio} > 0`),
    check('units_decimals_check', sql`${table.decimals} BETWEEN 0 AND 4`),
  ],
);
```

- **The unique index is on `lower(code)`.** "KG" and "kg" are one unit: people type codes in any case, and the CSV
  import matches them that way.
- **`(tenant_id, id)` unique** is the target of the composite foreign keys from `products` and `product_units`: a
  product can only use a unit of its own workspace, whatever the code does.
- **`ratio` is `NUMERIC(19,6)`**, read and written as a string. 6 places hold 0.9144 (a yard in metres) and 0.000001
  if anyone ever needs it.

**File: `packages/db/src/schema/product-categories.ts`** (new)

```ts
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// Product categories: a tree, like the chart of accounts but without types or codes. deleted_at is
// not used: a category is deleted for real, and only when nothing is in it (the FKs say so).
export const productCategories = pgTable(
  'product_categories',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // NULL = a top-level category
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
  },
  (table) => [
    // Two "Tablets" in one place would be two answers to "which one?". Unique among siblings, in any
    // case. COALESCE: NULLs never collide in a unique index, so without it two top-level "Fabrics"
    // would both go in; the zero uuid stands for "the top".
    uniqueIndex('product_categories_sibling_name_idx').on(
      table.tenantId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
    // The target of the parent FK below and of products' category FK
    uniqueIndex('product_categories_tenant_id_idx').on(table.tenantId, table.id),
    // A category's children — and what Postgres uses to check the parent FK on delete
    index('product_categories_tenant_parent_idx').on(table.tenantId, table.parentId),
    // The parent is in the same tenant. A category with children cannot be deleted: the API turns
    // this FK's error into category_has_children.
    foreignKey({
      name: 'product_categories_parent_fk',
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check('product_categories_parent_not_self', sql`${table.parentId} <> ${table.id}`),
  ],
);
```

- **`COALESCE(parent_id, zero uuid)` in the sibling index.** NULLs never collide in a unique index, so without it two
  top-level "Fabrics" would both go in. The zero uuid stands for "the top", and no real id is ever all zeros.
- **`lower(name)`**: "Knit" and "knit" in one place would be two answers to "which one?".
- **The parent FK is composite** (tenant + id), like the chart's: a category can only sit under one of its own
  workspace's. It has no `ON DELETE`: deleting a category with children fails, and the API turns that error into
  `category_has_children`.

**File: `packages/db/src/schema/custom-fields.ts`** (new)

```ts
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// A workspace's own fields (system-design §4.8): what each one is called and what it holds. The
// values live on the records themselves, in a custom_fields JSONB column under `key`.
export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entity: text('entity', { enum: CUSTOM_FIELD_ENTITIES }).notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type', { enum: CUSTOM_FIELD_TYPES }).notNull(),
    // A select's choices; empty for the other types
    options: text('options')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    required: boolean('required').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // One key per kind of record: it is the JSON key the values are saved under
    uniqueIndex('custom_field_definitions_key_idx').on(table.tenantId, table.entity, table.key),
    check(
      'custom_field_definitions_select_check',
      sql`${table.type} <> 'select' OR cardinality(${table.options}) > 0`,
    ),
  ],
);
```

The values are not here: they live on the records (`products.custom_fields`). The unique index on
`(tenant, entity, key)` is what makes a key a safe JSON key. The CHECK repeats the contract's "a select has a choice"
in the database.

**File: `packages/db/src/schema/products.ts`** (new)

```ts
import {
  type CustomFieldValues,
  PRODUCT_TYPES,
  type ProductOption,
  TRACKING_MODES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productCategories } from './product-categories.js';
import { tenants } from './tenants.js';
import { units } from './units.js';

// A product: what it is called, how it is counted and grouped. What is stocked and sold is its
// variants (product_variants): exactly one for a simple product. deleted_at is not used: a product
// is deleted for real (only while nothing uses it) or archived.
export const products = pgTable(
  'products',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // P-00042 from the number series, or the company's own (a garments style number)
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: PRODUCT_TYPES }).notNull().default('goods'),
    categoryId: uuid('category_id'),
    description: text('description'),
    // Stock is counted in this unit, always. Packs are rows of product_units.
    baseUnitId: uuid('base_unit_id').notNull(),
    tracking: text('tracking', { enum: TRACKING_MODES }).notNull().default('none'),
    hasExpiry: boolean('has_expiry').notNull().default(false),
    // [{ name: 'Size', values: ['S', 'M'] }], checked with Zod on the way in. JSONB, not a table:
    // it is only ever read and written whole, with its product.
    options: jsonb('options')
      .$type<ProductOption[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The workspace's own fields (custom_field_definitions): key → value
    customFields: jsonb('custom_fields')
      .$type<CustomFieldValues>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // A code means one product, in any case: a scanner field or a CSV does not care about case
    uniqueIndex('products_tenant_code_idx').on(table.tenantId, sql`lower(${table.code})`),
    // The target of the composite FKs from variants and units
    uniqueIndex('products_tenant_id_idx').on(table.tenantId, table.id),
    // The list's keyset orders: by name, and by last change. By code uses the unique index above.
    index('products_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`, table.id),
    index('products_tenant_updated_idx').on(table.tenantId, table.updatedAt, table.id),
    // A category's products — and Postgres's own check of the FK when a category is deleted
    index('products_tenant_category_idx').on(table.tenantId, table.categoryId),
    index('products_tenant_base_unit_idx').on(table.tenantId, table.baseUnitId),
    foreignKey({
      name: 'products_category_fk',
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
    }),
    foreignKey({
      name: 'products_base_unit_fk',
      columns: [table.tenantId, table.baseUnitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // The same two rules as the contract's productRules, here too: a row written by any other path
    // (a script, a later import) still cannot be a tracked service or an expiry without batches
    check('products_service_untracked', sql`${table.type} = 'goods' OR ${table.tracking} = 'none'`),
    check(
      'products_expiry_needs_batch',
      sql`NOT ${table.hasExpiry} OR ${table.tracking} = 'batch'`,
    ),
    check('products_options_array', sql`jsonb_typeof(${table.options}) = 'array'`),
    check('products_custom_fields_object', sql`jsonb_typeof(${table.customFields}) = 'object'`),
  ],
);

// What is stocked and sold: a size and colour of a T-shirt, or the one and only "variant" of a
// simple product. Stock, sales and purchase lines (steps 13–17) point here.
export const productVariants = pgTable(
  'product_variants',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    // The order the form shows them in
    position: smallint('position').notNull(),
    sku: text('sku').notNull(),
    // One value per product option, in the options' order; '{}' for a simple product
    optionValues: text('option_values')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Per base unit. NULL = no fixed price (not zero: zero is a price)
    salePrice: numeric('sale_price', { precision: 19, scale: 4 }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: baseColumns().createdAt,
    // Step 18's sync reads changes by updated_at
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [
    uniqueIndex('product_variants_tenant_sku_idx').on(table.tenantId, sql`lower(${table.sku})`),
    // The target of the FKs from barcodes, batches and serials: a variant of THIS product
    uniqueIndex('product_variants_product_id_idx').on(table.tenantId, table.productId, table.id),
    // Each combination once per product. An array, so no NULLs to slip past the index.
    uniqueIndex('product_variants_values_idx').on(
      table.tenantId,
      table.productId,
      table.optionValues,
    ),
    // Deleting a product deletes its variants. From step 13, a variant with stock lines cannot be
    // deleted (their FK), so neither can its product: the API turns that into product_in_use.
    foreignKey({
      name: 'product_variants_product_fk',
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    check(
      'product_variants_price_check',
      sql`${table.salePrice} IS NULL OR ${table.salePrice} >= 0`,
    ),
    check('product_variants_values_check', sql`cardinality(${table.optionValues}) <= 3`),
  ],
);

// The bigger units a product also comes in, with how many base units each is: a box = 10 strips,
// a strip = 10 tablets (both written in tablets: 100 and 10). The base unit itself is not a row.
export const productUnits = pgTable(
  'product_units',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    position: smallint('position').notNull(),
    // Base units in one of these. NUMERIC(19,6): a yard in metres is 0.9144.
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    // The unit sales and purchase forms start with. No row flagged = the base unit.
    isSalesDefault: boolean('is_sales_default').notNull().default(false),
    isPurchaseDefault: boolean('is_purchase_default').notNull().default(false),
  },
  (table) => [
    // Each unit once per product. Also the target of the barcodes' FK below.
    uniqueIndex('product_units_product_unit_idx').on(table.tenantId, table.productId, table.unitId),
    // At most one default of each kind per product
    uniqueIndex('product_units_sales_default_idx')
      .on(table.tenantId, table.productId)
      .where(sql`${table.isSalesDefault}`),
    uniqueIndex('product_units_purchase_default_idx')
      .on(table.tenantId, table.productId)
      .where(sql`${table.isPurchaseDefault}`),
    // A unit used by a product cannot be deleted (unit_in_use)
    index('product_units_tenant_unit_idx').on(table.tenantId, table.unitId),
    foreignKey({
      name: 'product_units_product_fk',
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'product_units_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    check('product_units_factor_check', sql`${table.factor} > 0`),
  ],
);

// Every barcode, in one table: a variant's own, and a pack's (unit_id). A scan is then one lookup,
// and the unique index makes sure a barcode means one thing in the whole workspace — a variant's
// barcode can never also be some carton's.
export const productBarcodes = pgTable(
  'product_barcodes',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // NULL = one base unit of the variant; otherwise the pack it is printed on
    unitId: uuid('unit_id'),
  },
  (table) => [
    uniqueIndex('product_barcodes_tenant_code_idx').on(table.tenantId, table.code),
    index('product_barcodes_product_idx').on(table.tenantId, table.productId),
    // product_id is in both keys, so the variant and the pack are always of the same product
    foreignKey({
      name: 'product_barcodes_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }).onDelete('cascade'),
    // NULL unit_id skips the check (MATCH SIMPLE)
    foreignKey({
      name: 'product_barcodes_unit_fk',
      columns: [table.tenantId, table.productId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.productId, productUnits.unitId],
    }).onDelete('cascade'),
  ],
);
```

- **`products.options` and `products.custom_fields` are JSONB.** They are only ever read and written whole, with their
  product; a table for option values would add joins and gain nothing. The CHECKs make sure they are an array and an
  object, whatever writes them.
- **The two other CHECKs on `products`** repeat `productRules` in the database: a service is never tracked, an expiry
  needs batch tracking. A script or a later bug cannot write such a row.
- **`products_tenant_name_idx` is on `lower(name), id`** — exactly the list's "by name" order (12.4), so a page is an
  index range scan. "By code" uses the unique `lower(code)` index, "last changed" uses `updated_at, id`.
- **`product_variants.option_values` is `text[]`, not three columns.** The unique index on
  `(tenant, product, option_values)` then catches the same combination twice, and an array has no NULLs to slip
  past it (three nullable columns would need `NULLS NOT DISTINCT`). `cardinality(...) <= 3` keeps the option limit.
- **`(tenant_id, product_id, id)` unique on variants** is what barcodes, batches and serials point at: their FK
  includes the product, so a barcode row can never name a variant of another product.
- **`ON DELETE CASCADE` from products to variants, units and barcodes.** A product that nothing else uses is deleted
  with its parts in one statement. From step 13, a stock line pointing at a variant blocks that cascade — and the API
  turns that into `product_in_use` (12.4). Today a batch already does.
- **`sale_price` is NULL for "no fixed price"**, with a CHECK against negatives.
- **`product_variants` has `updated_at`.** Step 18's sync reads changes by it.
- **`product_units` holds packs only**, never the base unit — "1 pcs = 1 pcs" is not information. The default
  sales and purchase units are flags with a partial unique index each ("at most one default"), and no flag means
  the base unit. Flags instead of two FK columns on `products`: deleting a pack row then cannot leave a product
  pointing at a pack that no longer exists.
- **`product_barcodes` has both FKs with `product_id` in them.** A variant's barcode has `unit_id` NULL; a pack's
  barcode names its pack (`MATCH SIMPLE` skips the pack FK when it is NULL). The one unique index on
  `(tenant, code)` is decision 8.

**File: `packages/db/src/schema/batches.ts`** (new)

```ts
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';

// Batches (lots) and serial numbers: the tables exist from step 12 (build plan 0.3), so step 13's
// stock_movements can point at them from its first line. Nothing writes them yet: a batch is made
// when goods are received (step 13), a serial when a phone is received or sold.

export const batches = pgTable(
  'batches',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The maker's lot number, as printed on the strip: "NP24117"
    lotNumber: text('lot_number').notNull(),
    // mode 'string': business dates without a time zone, like the journal's
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
    // NULL when the product has no expiry (products.has_expiry)
    expiresOn: date('expires_on', { mode: 'string' }),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    // One lot number per variant: receiving more of NP24117 adds to the same batch
    uniqueIndex('batches_variant_lot_idx').on(
      table.tenantId,
      table.variantId,
      sql`lower(${table.lotNumber})`,
    ),
    foreignKey({
      name: 'batches_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    check(
      'batches_dates_check',
      sql`${table.manufacturedOn} IS NULL OR ${table.expiresOn} IS NULL OR ${table.expiresOn} > ${table.manufacturedOn}`,
    ),
  ],
);

export const serials = pgTable(
  'serials',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // An IMEI, a machine's serial plate
    serialNumber: text('serial_number').notNull(),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    uniqueIndex('serials_variant_number_idx').on(
      table.tenantId,
      table.variantId,
      table.serialNumber,
    ),
    foreignKey({
      name: 'serials_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
  ],
);
```

Two small tables for step 13 (decision 11). The lot number is unique per variant in any case, because receiving more
of lot NP24117 adds to that batch. The CHECK refuses an expiry on or before the manufacturing date — a typo that
would otherwise make a batch "expired" on arrival. Their FKs point at a variant of the same product, and have no
`ON DELETE`: a product with a batch cannot be deleted (12.4 turns the error into `product_in_use`).

**File: `packages/db/src/schema/product-imports.ts`** (new)

```ts
import { PRODUCT_IMPORT_STATUSES, type ProductImportError } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// One CSV file of products (step 12): the API makes the row and the upload address, the worker
// checks the file and creates the products — all of them, or none. Like report_exports: written by
// the API, finished by the worker, never edited after.
export const productImports = pgTable(
  'product_imports',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    fileName: text('file_name').notNull(),
    // As declared by the browser; the start route checks the stored file against it
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status', { enum: PRODUCT_IMPORT_STATUSES }).notNull().default('uploading'),
    rowCount: integer('row_count'),
    productCount: integer('product_count'),
    errorCount: integer('error_count').notNull().default(0),
    // The first 100 problems, in file order
    errors: jsonb('errors')
      .$type<ProductImportError[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: baseColumns().createdAt,
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // The list, newest first: id is UUIDv7, so its order is the order of the uploads
    index('product_imports_tenant_id_idx').on(table.tenantId, table.id),
    // A finished import says when; a done one says how many products it made
    check(
      'product_imports_finished_check',
      sql`(${table.status} IN ('done', 'failed')) = (${table.finishedAt} IS NOT NULL)`,
    ),
    check(
      'product_imports_done_check',
      sql`${table.status} <> 'done' OR ${table.productCount} IS NOT NULL`,
    ),
  ],
);
```

Like `report_exports` (step 11): written by the API, finished by the worker, never edited after. The two CHECKs make
a half-finished row impossible: a done or failed import has its `finished_at`, and a done import says how many products
it made. `errors` holds the first 100 problems; `error_count` the full number.

**File: `packages/db/src/schema/index.ts`** (change)

```diff
@@ -20,3 +20,9 @@ export * from './notifications.js';
 export * from './ledger-accounts.js';
 export * from './journal.js';
 export * from './report-exports.js';
+export * from './units.js';
+export * from './product-categories.js';
+export * from './custom-fields.js';
+export * from './products.js';
+export * from './batches.js';
+export * from './product-imports.js';
```

**File: `packages/db/src/schema/outbox-events.ts`** (change)

```diff
@@ -13,6 +13,8 @@ export const OUTBOX_EVENT_TYPES = [
   'member.joined',
   'workspace.chart_requested',
   'report.export_requested',
+  'workspace.catalog_requested',
+  'product.import_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

Two events: the catalog of an old workspace (decision 13), and an import to run.

**File: `packages/db/src/permission-catalog.ts`** (change)

```diff
@@ -22,6 +22,8 @@ const DESCRIPTIONS = {
     'Close the books up to a date, close and reopen fiscal years, and open the books again',
   'accounting.report.read':
     'View the trial balance, profit and loss and balance sheet, and export them to Excel or PDF',
+  'inventory.product.manage':
+    'Add, edit, archive and import products, and manage their categories and units',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

### Migration 0019 (generated — then move the indexes up)

```bash
pnpm db:generate --name products
```

⚠️ **The same problem as steps 9 and 10, nine times over.** drizzle-kit writes the tables, then the foreign keys,
then the indexes. A composite foreign key needs the unique index on the columns it points at, and Postgres refuses
`ADD CONSTRAINT … FOREIGN KEY` before that index exists ("there is no unique constraint matching given keys for
referenced table"). Nine of this step's FKs point at five indexes made in this same file: `units_tenant_id_idx`,
`product_categories_tenant_id_idx`, `products_tenant_id_idx`, `product_variants_product_id_idx` and
`product_units_product_unit_idx`. Picking out five lines is easy to get wrong, so move them all:

**Open `packages/db/migrations/0019_products.sql` and move every `CREATE INDEX` / `CREATE UNIQUE INDEX` line above
the first `ALTER TABLE … ADD CONSTRAINT` line.** Keep the `--> statement-breakpoint` at the end of each line; drizzle's
migrator splits on it. The result, top to bottom: the ten `CREATE TABLE` blocks, the 24 index lines, then the 21
`ALTER TABLE` lines. The file as it should end up:

**File: `packages/db/migrations/0019_products.sql`** (new)

```sql
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"dimension" text NOT NULL,
	"ratio" numeric(19, 6),
	"decimals" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "units_ratio_check" CHECK ("units"."ratio" IS NULL OR "units"."ratio" > 0),
	CONSTRAINT "units_decimals_check" CHECK ("units"."decimals" BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	CONSTRAINT "product_categories_parent_not_self" CHECK ("product_categories"."parent_id" <> "product_categories"."id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "custom_field_definitions_select_check" CHECK ("custom_field_definitions"."type" <> 'select' OR cardinality("custom_field_definitions"."options") > 0)
);
--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid
);
--> statement-breakpoint
CREATE TABLE "product_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"is_sales_default" boolean DEFAULT false NOT NULL,
	"is_purchase_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "product_units_factor_check" CHECK ("product_units"."factor" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"sku" text NOT NULL,
	"option_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"sale_price" numeric(19, 4),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_price_check" CHECK ("product_variants"."sale_price" IS NULL OR "product_variants"."sale_price" >= 0),
	CONSTRAINT "product_variants_values_check" CHECK (cardinality("product_variants"."option_values") <= 3)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'goods' NOT NULL,
	"category_id" uuid,
	"description" text,
	"base_unit_id" uuid NOT NULL,
	"tracking" text DEFAULT 'none' NOT NULL,
	"has_expiry" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "products_service_untracked" CHECK ("products"."type" = 'goods' OR "products"."tracking" = 'none'),
	CONSTRAINT "products_expiry_needs_batch" CHECK (NOT "products"."has_expiry" OR "products"."tracking" = 'batch'),
	CONSTRAINT "products_options_array" CHECK (jsonb_typeof("products"."options") = 'array'),
	CONSTRAINT "products_custom_fields_object" CHECK (jsonb_typeof("products"."custom_fields") = 'object')
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"manufactured_on" date,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "batches_dates_check" CHECK ("batches"."manufactured_on" IS NULL OR "batches"."expires_on" IS NULL OR "batches"."expires_on" > "batches"."manufactured_on")
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"row_count" integer,
	"product_count" integer,
	"error_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "product_imports_finished_check" CHECK (("product_imports"."status" IN ('done', 'failed')) = ("product_imports"."finished_at" IS NOT NULL)),
	CONSTRAINT "product_imports_done_check" CHECK ("product_imports"."status" <> 'done' OR "product_imports"."product_count" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "units_tenant_code_idx" ON "units" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "units_tenant_id_idx" ON "units" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_sibling_name_idx" ON "product_categories" USING btree ("tenant_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_tenant_id_idx" ON "product_categories" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "product_categories_tenant_parent_idx" ON "product_categories" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_key_idx" ON "custom_field_definitions" USING btree ("tenant_id","entity","key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_barcodes_tenant_code_idx" ON "product_barcodes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "product_barcodes_product_idx" ON "product_barcodes" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_product_unit_idx" ON "product_units" USING btree ("tenant_id","product_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_sales_default_idx" ON "product_units" USING btree ("tenant_id","product_id") WHERE "product_units"."is_sales_default";--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_purchase_default_idx" ON "product_units" USING btree ("tenant_id","product_id") WHERE "product_units"."is_purchase_default";--> statement-breakpoint
CREATE INDEX "product_units_tenant_unit_idx" ON "product_units" USING btree ("tenant_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_sku_idx" ON "product_variants" USING btree ("tenant_id",lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_id_idx" ON "product_variants" USING btree ("tenant_id","product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_values_idx" ON "product_variants" USING btree ("tenant_id","product_id","option_values");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_code_idx" ON "products" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_id_idx" ON "products" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "products" USING btree ("tenant_id",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "products_tenant_updated_idx" ON "products" USING btree ("tenant_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "products_tenant_category_idx" ON "products" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "products_tenant_base_unit_idx" ON "products" USING btree ("tenant_id","base_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_variant_lot_idx" ON "batches" USING btree ("tenant_id","variant_id",lower("lot_number"));--> statement-breakpoint
CREATE UNIQUE INDEX "serials_variant_number_idx" ON "serials" USING btree ("tenant_id","variant_id","serial_number");--> statement-breakpoint
CREATE INDEX "product_imports_tenant_id_idx" ON "product_imports" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_unit_fk" FOREIGN KEY ("tenant_id","product_id","unit_id") REFERENCES "public"."product_units"("tenant_id","product_id","unit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."product_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_fk" FOREIGN KEY ("tenant_id","base_unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_imports" ADD CONSTRAINT "product_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
```

The snapshot (`meta/0019_snapshot.json`) does not record the order of statements, so the move changes nothing for
drizzle-kit's next `generate`.

### Migration 0020 (custom): RLS, the search indexes, the catalog job

```bash
pnpm db:generate --custom --name products-rls
```

**File: `packages/db/migrations/0020_products-rls.sql`** (new)

```sql
-- Custom SQL migration file, put your code below! --

-- 1) The ten new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'units', 'product_categories', 'custom_field_definitions', 'products', 'product_variants',
      'product_units', 'product_barcodes', 'batches', 'serials', 'product_imports'
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

-- 2) "Contains" search for the product list: part of a name, a code or a SKU ("napa" finds
--    "Napa Extra 500 mg"). A b-tree index only helps a LIKE that starts at the beginning; a
--    trigram index (pg_trgm, which ships with Postgres) helps LIKE '%napa%' too. pg_trgm is a
--    "trusted" extension, so the database owner (omnivo_migrator) may create it without being a
--    superuser. These indexes live here and not in the Drizzle schema: drizzle-kit would create
--    them before the extension exists. Drizzle never sees them, so it never tries to drop them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm_idx ON products USING gin (lower(name) gin_trgm_ops);
CREATE INDEX products_code_trgm_idx ON products USING gin (lower(code) gin_trgm_ops);
CREATE INDEX product_variants_sku_trgm_idx ON product_variants USING gin (lower(sku) gin_trgm_ops);

-- 3) Workspaces set up before this step have no units, categories or custom fields, and a product
--    cannot be made without a unit. The starting set lives in TypeScript (setup/templates.ts), so,
--    like 0014's chart, one outbox event per workspace asks the worker to make it with the same
--    code the setup job uses. 'pending' workspaces are skipped: their setup job makes it after the
--    owner picks a business type.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE setup_status <> 'pending' AND deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO outbox_events (id, tenant_id, type, payload)
    VALUES (gen_random_uuid(), t, 'workspace.catalog_requested', '{}'::jsonb);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

1. **RLS on all ten tables**, the same loop as step 10's 0016. The tenant-leak suite's coverage test fails if a table
   with a `tenant_id` column is missing here.
2. **`pg_trgm` and three trigram indexes.** A b-tree index helps `LIKE 'napa%'` only; a trigram index helps
   `LIKE '%napa%'`, the list's "contains" search. `pg_trgm` is a *trusted* extension, so `omnivo_migrator` (the
   database's owner) may create it without being a superuser — in docker-compose, in Testcontainers, and on most
   managed Postgres services. The indexes live in this file, not in the Drizzle schema: drizzle-kit would emit them
   in 0019, before the extension exists. Drizzle never sees them, so a later `db:generate` never tries to drop them.
   They do not start with `tenant_id` (GIN cannot hold a uuid without another extension); the query still filters
   by tenant, and Postgres combines the two indexes.
3. **One `workspace.catalog_requested` event per set-up workspace**, inside the tenant's context because
   `outbox_events` has FORCE RLS — the same pattern as 0014's chart.

```bash
pnpm --filter @omnivo/db build
```

---

## 12.3 — The API: the starting catalog

Every workspace needs units before its first product, so the setup job makes them — with categories and custom fields
that fit its trade.

**File: `apps/api/src/setup/templates.ts`** (change)

```diff
@@ -1,4 +1,11 @@
-import type { AccountPurpose, AccountType, Industry, PermissionKey } from '@omnivo/contracts';
+import type {
+  AccountPurpose,
+  AccountType,
+  CustomFieldType,
+  Industry,
+  PermissionKey,
+  UnitDimension,
+} from '@omnivo/contracts';
 
 export interface RoleTemplate {
   name: string;
@@ -19,13 +26,46 @@ export interface AccountTemplate {
 // each account takes it from its top-level group, exactly as the database does (the parent FK).
 export type ChartTemplate = Record<AccountType, AccountTemplate>;
 
-// Starting data for each business type: the roles such a company is staffed with, and its chart
-// of accounts. Step 12 adds the product tracking (batch for pharma). Everything here is ordinary
+// A unit of measure. ratio = how many of the dimension's reference unit (pcs, kg, m, m², l) one of
+// it is; null = a pack whose size each product says.
+export interface UnitTemplate {
+  code: string;
+  name: string;
+  dimension: UnitDimension;
+  ratio: string | null;
+  decimals: number;
+}
+
+// A product category; with children, the categories under it
+export interface CategoryTemplate {
+  name: string;
+  children?: readonly CategoryTemplate[];
+}
+
+export interface CustomFieldTemplate {
+  key: string;
+  label: string;
+  type: CustomFieldType;
+  options?: readonly string[];
+  required?: boolean;
+}
+
+// What a new workspace needs before its first product (step 12)
+export interface CatalogTemplate {
+  units: readonly UnitTemplate[];
+  categories: readonly CategoryTemplate[];
+  customFields: readonly CustomFieldTemplate[];
+}
+
+// Starting data for each business type: the roles such a company is staffed with, its chart of
+// accounts, and its units, product categories and custom fields (step 12; a pharma company's
+// products start with batch tracking — contracts' trackingDefault()). Everything here is ordinary
 // data once created: the workspace can rename, change or delete it, and a later change to this
 // file never touches workspaces that already exist.
 export interface IndustryTemplate {
   roles: RoleTemplate[];
   chart: ChartTemplate;
+  catalog: CatalogTemplate;
 }
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
@@ -48,7 +88,7 @@ const ACCOUNTANT: RoleTemplate = {
 const STORE_KEEPER: RoleTemplate = {
   name: 'Store keeper',
   description: 'Receives goods and writes GRNs',
-  permissions: [],
+  permissions: ['inventory.product.manage'],
 };
 
 function group(
@@ -169,6 +209,39 @@ function standardChart(industry: IndustryAccounts): ChartTemplate {
   };
 }
 
+// ---------------------------------------------------------------------------------------------
+// Units, categories and custom fields (step 12)
+
+function unit(
+  code: string,
+  name: string,
+  dimension: UnitDimension,
+  ratio: string | null,
+  decimals = 0,
+): UnitTemplate {
+  return { code, name, dimension, ratio, decimals };
+}
+
+function category(name: string, children?: readonly string[]): CategoryTemplate {
+  return children === undefined
+    ? { name }
+    : { name, children: children.map((child) => ({ name: child })) };
+}
+
+// Every company counts, weighs and measures: these units are in every workspace. Packs (box,
+// carton) have no ratio: a box of Napa holds 10 strips, a box of buttons 144 pieces.
+const COMMON_UNITS = [
+  unit('pcs', 'Pieces', 'count', '1'),
+  unit('dozen', 'Dozen', 'count', '12'),
+  unit('kg', 'Kilogram', 'weight', '1', 3),
+  unit('g', 'Gram', 'weight', '0.001'),
+  unit('m', 'Metre', 'length', '1', 2),
+  unit('l', 'Litre', 'volume', '1', 3),
+  unit('ml', 'Millilitre', 'volume', '0.001'),
+  unit('box', 'Box', 'count', null),
+  unit('carton', 'Carton', 'count', null),
+] as const;
+
 const TRADER_STOCK = account('1150', 'Inventory', 'inventory');
 const COGS = account('5110', 'Cost of goods sold', 'cost_of_goods_sold');
 // Makers post the sale's cost from finished goods; raw materials move there through production
@@ -186,7 +259,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Merchandiser',
         description: 'Buyer POs, LCs and shipment dates',
-        permissions: ['core.user.read'],
+        permissions: ['core.user.read', 'inventory.product.manage'],
       },
       STORE_KEEPER,
     ],
@@ -210,6 +283,29 @@ export const INDUSTRY_TEMPLATES = {
         account('5340', 'Buying house commission'),
       ],
     }),
+    catalog: {
+      units: [
+        ...COMMON_UNITS,
+        unit('yard', 'Yard', 'length', '0.9144', 2),
+        unit('gross', 'Gross', 'count', '144'),
+        unit('roll', 'Roll', 'count', null),
+        unit('cone', 'Cone', 'count', null),
+        unit('pair', 'Pair', 'count', null),
+      ],
+      categories: [
+        category('Fabrics', ['Knit', 'Woven', 'Denim']),
+        category('Yarn'),
+        category('Trims and accessories', ['Buttons', 'Zippers', 'Labels', 'Sewing thread']),
+        category('Packing materials', ['Poly bags', 'Cartons', 'Hangers']),
+        category('Finished garments', ['T-shirts', 'Polo shirts', 'Trousers', 'Jackets']),
+      ],
+      customFields: [
+        { key: 'buyer', label: 'Buyer', type: 'text' },
+        { key: 'composition', label: 'Fabric composition', type: 'text' },
+        { key: 'gsm', label: 'GSM', type: 'number' },
+        { key: 'season', label: 'Season', type: 'text' },
+      ],
+    },
   },
   pharma: {
     roles: [
@@ -217,7 +313,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Depot manager',
         description: 'Stock by batch and expiry at a depot',
-        permissions: ['core.branch.manage'],
+        permissions: ['core.branch.manage', 'inventory.product.manage'],
       },
       { name: 'Sales representative', description: 'Orders from pharmacies', permissions: [] },
     ],
@@ -236,6 +332,39 @@ export const INDUSTRY_TEMPLATES = {
         account('5350', 'Expired and damaged goods'),
       ],
     }),
+    catalog: {
+      units: [
+        ...COMMON_UNITS,
+        unit('strip', 'Strip', 'count', null),
+        unit('bottle', 'Bottle', 'count', null),
+        unit('vial', 'Vial', 'count', null),
+        unit('ampoule', 'Ampoule', 'count', null),
+        unit('tube', 'Tube', 'count', null),
+        unit('sachet', 'Sachet', 'count', null),
+      ],
+      categories: [
+        category('Finished products', [
+          'Tablets',
+          'Capsules',
+          'Syrups and suspensions',
+          'Injections',
+          'Creams and ointments',
+        ]),
+        category('Raw materials', ['Active ingredients (API)', 'Excipients']),
+        category('Packing materials', ['Foil and blister', 'Bottles and caps', 'Inner cartons']),
+      ],
+      customFields: [
+        { key: 'generic_name', label: 'Generic name', type: 'text', required: true },
+        { key: 'strength', label: 'Strength', type: 'text' },
+        {
+          key: 'dosage_form',
+          label: 'Dosage form',
+          type: 'select',
+          options: ['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Cream', 'Drops'],
+        },
+        { key: 'dar_number', label: 'DAR number', type: 'text' },
+      ],
+    },
   },
   distribution: {
     roles: [
@@ -243,7 +372,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Depot manager',
         description: 'Stock and deliveries at a depot',
-        permissions: ['core.branch.manage'],
+        permissions: ['core.branch.manage', 'inventory.product.manage'],
       },
       {
         name: 'Sales officer',
@@ -262,6 +391,26 @@ export const INDUSTRY_TEMPLATES = {
         account('5340', 'Sales team allowances'),
       ],
     }),
+    catalog: {
+      units: [
+        ...COMMON_UNITS,
+        unit('case', 'Case', 'count', null),
+        unit('pack', 'Pack', 'count', null),
+        unit('bag', 'Bag', 'count', null),
+        unit('bottle', 'Bottle', 'count', null),
+      ],
+      categories: [
+        category('Beverages'),
+        category('Snacks and biscuits'),
+        category('Personal care'),
+        category('Home care'),
+        category('Dairy and baby food'),
+      ],
+      customFields: [
+        { key: 'principal', label: 'Principal company', type: 'text' },
+        { key: 'brand', label: 'Brand', type: 'text' },
+      ],
+    },
   },
   manufacturing: {
     roles: [
@@ -269,7 +418,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Production manager',
         description: 'Production orders and material use',
-        permissions: ['core.user.read'],
+        permissions: ['core.user.read', 'inventory.product.manage'],
       },
       STORE_KEEPER,
     ],
@@ -283,6 +432,28 @@ export const INDUSTRY_TEMPLATES = {
       revenue: [account('4110', 'Sales', 'sales')],
       costOfSales: [...MAKER_COSTS, account('5140', 'Factory power and fuel')],
     }),
+    catalog: {
+      units: [
+        ...COMMON_UNITS,
+        unit('ton', 'Metric ton', 'weight', '1000', 3),
+        unit('ft', 'Foot', 'length', '0.3048', 2),
+        unit('sqm', 'Square metre', 'area', '1', 2),
+        unit('sqft', 'Square foot', 'area', '0.092903', 2),
+        unit('drum', 'Drum', 'count', null),
+        unit('bag', 'Bag', 'count', null),
+      ],
+      categories: [
+        category('Raw materials'),
+        category('Components'),
+        category('Finished goods'),
+        category('Spare parts'),
+        category('Consumables'),
+      ],
+      customFields: [
+        { key: 'specification', label: 'Specification', type: 'text' },
+        { key: 'grade', label: 'Grade', type: 'text' },
+      ],
+    },
   },
   retail: {
     roles: [
@@ -290,7 +461,7 @@ export const INDUSTRY_TEMPLATES = {
       {
         name: 'Shop manager',
         description: 'Runs a shop and its staff',
-        permissions: ['core.user.read', 'core.branch.manage'],
+        permissions: ['core.user.read', 'core.branch.manage', 'inventory.product.manage'],
       },
       { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
     ],
@@ -304,16 +475,43 @@ export const INDUSTRY_TEMPLATES = {
         account('5340', 'Shrinkage and damaged goods'),
       ],
     }),
+    catalog: {
+      units: [
+        ...COMMON_UNITS,
+        unit('pack', 'Pack', 'count', null),
+        unit('bottle', 'Bottle', 'count', null),
+        unit('sack', 'Sack', 'count', null),
+        unit('tray', 'Tray', 'count', null),
+      ],
+      categories: [
+        category('Groceries', ['Rice', 'Lentils', 'Oil', 'Spices', 'Flour and sugar']),
+        category('Fresh', ['Fruits', 'Vegetables', 'Fish and meat', 'Eggs']),
+        category('Beverages'),
+        category('Snacks'),
+        category('Personal care'),
+        category('Household'),
+      ],
+      customFields: [{ key: 'brand', label: 'Brand', type: 'text' }],
+    },
   },
   other: {
     roles: [
       ACCOUNTANT,
-      { name: 'Manager', description: 'Runs day-to-day work', permissions: ['core.user.read'] },
+      {
+        name: 'Manager',
+        description: 'Runs day-to-day work',
+        permissions: ['core.user.read', 'inventory.product.manage'],
+      },
     ],
     chart: standardChart({
       stock: TRADER_STOCK,
       revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Service income')],
       costOfSales: [COGS],
     }),
+    catalog: {
+      units: COMMON_UNITS,
+      categories: [category('General')],
+      customFields: [],
+    },
   },
 } satisfies Record<Industry, IndustryTemplate>;
```

- **`CatalogTemplate`** joins `roles` and `chart` in `IndustryTemplate`, and `satisfies Record<Industry, …>` makes
  every business type carry one.
- **`COMMON_UNITS`** are in every workspace: pcs, dozen, kg, g, m, l, ml, box, carton. The ratios are written once per
  dimension's reference unit (pcs, kg, m, m², l). kg and l allow 3 decimals (1.250 kg of rice), m allows 2 (1.75 m of
  fabric), pieces none.
- **Each trade adds its own**: yard, gross (144), roll, cone, pair for garments; strip, bottle, vial, ampoule, tube,
  sachet for pharma; case, pack, bag for distribution; ton, foot, m², ft² and drum for manufacturing; pack, bottle,
  sack, tray for a supershop.
- **`sqft` is `0.092903`**, the exact 0.09290304 rounded to the column's 6 places. The ratios only matter for
  `standardFactor()` between two units of the same dimension.
- **Custom fields**: Generic name (required), Strength, Dosage form (a choice), DAR number for pharma — the Drug
  Administration registration number printed on every pack; Buyer, Fabric composition, GSM, Season for garments;
  Principal company and Brand for a distributor; Brand for a supershop.
- **`inventory.product.manage`** goes to the roles that look after goods: the store keeper, both depot managers, the
  merchandiser (who opens every new style), the production manager, the shop manager and the general manager.

**File: `apps/api/src/setup/seed-catalog.ts`** (new)

```ts
import { customFieldDefinitions, productCategories, units } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { CatalogTemplate, CategoryTemplate } from './templates.js';

interface Pending {
  node: CategoryTemplate;
  parentId: string | null;
}

export interface SeededCatalog {
  units: number;
  categories: number;
  customFields: number;
}

// Creates a template's units, product categories and custom fields in the transaction's tenant.
// Makes nothing (returns null) if the workspace already has any unit: the set is made whole or not
// at all, in one transaction, so "a unit exists" means "the catalog was made" — the same rule as
// seedChart(), and what makes the setup job and the catalog job idempotent. Both lock the tenant
// row first, so they never race.
export async function seedCatalog(
  tx: Transaction,
  tenantId: string,
  catalog: CatalogTemplate,
): Promise<SeededCatalog | null> {
  const [existing] = await tx
    .select({ id: units.id })
    .from(units)
    .where(eq(units.tenantId, tenantId))
    .limit(1);
  if (existing) return null;

  await tx.insert(units).values(catalog.units.map((unit) => ({ tenantId, ...unit })));

  // One level at a time, like the chart: a child needs its parent's id. Names are unique among
  // siblings (templates.spec.ts), so the name finds the new row's id.
  let level: Pending[] = catalog.categories.map((node) => ({ node, parentId: null }));
  let categories = 0;
  while (level.length > 0) {
    const inserted = await tx
      .insert(productCategories)
      .values(level.map(({ node, parentId }) => ({ tenantId, parentId, name: node.name })))
      .returning({
        id: productCategories.id,
        name: productCategories.name,
        parentId: productCategories.parentId,
      });
    categories += inserted.length;
    level = level.flatMap(({ node, parentId }) => {
      const row = inserted.find(
        (candidate) => candidate.name === node.name && candidate.parentId === parentId,
      );
      if (!row) throw new Error(`Catalog template: category ${node.name} was not created`);
      return (node.children ?? []).map((child) => ({
        node: child,
        parentId: row.id,
      }));
    });
  }

  if (catalog.customFields.length > 0) {
    await tx.insert(customFieldDefinitions).values(
      catalog.customFields.map((field) => ({
        tenantId,
        entity: 'product' as const,
        key: field.key,
        label: field.label,
        type: field.type,
        options: [...(field.options ?? [])],
        required: field.required ?? false,
      })),
    );
  }
  return {
    units: catalog.units.length,
    categories,
    customFields: catalog.customFields.length,
  };
}
```

- **"A unit exists" means "the catalog was made"**, exactly like `seedChart()`'s rule for accounts. The two jobs that
  call it lock the tenant row first, so they never race, and the second finds units and stops.
- **`Pending`** is typed once, so the first level's `parentId: null` does not need a cast to widen it.
- **One `INSERT` per tree level**, and each new id is found by its name *and* its parent — the same pair the
  database keeps unique, and the templates test checks. A name alone would be enough for today's templates, but not
  for one that repeats a name in two places (an "Others" in every group).

**File: `apps/api/src/setup/catalog.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { isIndustry } from '@omnivo/contracts';
import { tenants } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { seedCatalog } from './seed-catalog.js';
import { INDUSTRY_TEMPLATES } from './templates.js';

// Gives units, product categories and custom fields to a workspace set up before step 12.
// Migration 0020 queues one 'workspace.catalog_requested' per such workspace; new workspaces get
// theirs from the setup job (ProvisioningHandler). Both call seedCatalog(): the same result.
@Injectable()
export class CatalogHandler implements EventHandler<'workspace.catalog_requested'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // The setup job's lock: if both run for one workspace, they take turns and the second stops
      const [tenant] = await tx
        .select({ industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new PermanentJobError('The workspace no longer exists');
      const industry =
        tenant.industry !== null && isIndustry(tenant.industry) ? tenant.industry : 'other';
      const seeded = await seedCatalog(tx, tenantId, INDUSTRY_TEMPLATES[industry].catalog);
      // Already there: a second run of this job, or the setup job was first
      if (seeded === null) return;
      await audit(tx, {
        action: 'workspace.catalog_created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ industry, ...seeded }),
      });
    });
  }
}
```

The worker side of decision 13, a copy of step 9's `ChartHandler` with `seedCatalog()`. A workspace that never picked a
business type (made before step 8) gets the general ('other') catalog. No `actorUserId` in the audit row: the log shows
"System".

**File: `apps/api/src/setup/provisioning.handler.ts`** (change)

```diff
@@ -9,6 +9,7 @@ import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { notify } from '../notifications/notify.js';
+import { seedCatalog } from './seed-catalog.js';
 import { seedChart } from './seed-chart.js';
 import { INDUSTRY_TEMPLATES, type RoleTemplate } from './templates.js';
 
@@ -88,6 +89,9 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
       // 0 when the workspace already has a chart: step 9's migration queued one for a workspace
       // whose setup had failed, and it ran before this retry
       const accounts = await seedChart(tx, tenantId, template.chart);
+      // null when step 12's migration already gave this workspace its catalog (a failed setup
+      // retried after the catalog job ran)
+      const catalog = await seedCatalog(tx, tenantId, template.catalog);
       await tx.update(tenants).set({ setupStatus: 'ready' }).where(eq(tenants.id, tenantId));
       // No actorUserId: the audit log shows "System" — the job did it, not a person
       await audit(tx, {
@@ -98,6 +102,9 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
           industry,
           roles: seeded.length === 0 ? null : seeded.map((role) => role.name).join(', '),
           accounts: accounts === 0 ? null : accounts,
+          units: catalog?.units ?? null,
+          categories: catalog?.categories ?? null,
+          customFields: catalog?.customFields ?? null,
         }),
       });
       await notify(tx, {
```

The setup job makes the catalog in the same transaction as the roles and the chart. `null` means a catalog job already
ran (a workspace whose setup failed, then got the catalog from migration 0020, then was retried); the audit row then
leaves the counts out, as it does for the chart.

## 12.4 — The API: products

### What the API and the worker share

**File: `apps/api/src/numbering/numbering.service.ts`** (change)

```diff
@@ -41,23 +41,42 @@ export class NumberingService {
   // কাউন্টার সেই transaction-এর অংশ — ইনভয়েস rollback হলে নম্বরও ফেরত যায়, ফাঁক থাকে না। দুজন একসাথে
   // চাইলে ON CONFLICT DO UPDATE রো-টা lock করে: দ্বিতীয়জন প্রথমজনের commit পর্যন্ত অপেক্ষা করে পরেরটা পায়
   async next(tx: Transaction, documentType: DocumentType, isoDate: string): Promise<string> {
+    const [number] = await this.nextMany(tx, documentType, isoDate, 1);
+    if (number === undefined) throw new Error('nextMany returned no number');
+    return number;
+  }
+
+  // `count` numbers in a row with one counter update — a CSV import of 5,000 products takes its
+  // codes in one statement instead of 5,000. Same transaction rule as next(): a rollback gives them
+  // all back.
+  async nextMany(
+    tx: Transaction,
+    documentType: DocumentType,
+    isoDate: string,
+    count: number,
+  ): Promise<string[]> {
+    if (count < 1) return [];
     const tenantId = getTenantId();
     const { format, fiscalYearStartMonth } = await this.formatOf(tx, documentType);
     const period = periodOf(isoDate, format.yearStyle, fiscalYearStartMonth);
     const [counter] = await tx
       .insert(numberSeriesCounters)
-      .values({ tenantId, documentType, period: periodKey(period), lastValue: 1 })
+      .values({ tenantId, documentType, period: periodKey(period), lastValue: count })
       .onConflictDoUpdate({
         target: [
           numberSeriesCounters.tenantId,
           numberSeriesCounters.documentType,
           numberSeriesCounters.period,
         ],
-        set: { lastValue: sql`${numberSeriesCounters.lastValue} + 1` },
+        set: { lastValue: sql`${numberSeriesCounters.lastValue} + ${count}` },
       })
       .returning({ lastValue: numberSeriesCounters.lastValue });
     if (!counter) throw new Error('Counter upsert returned no row');
-    return formatDocumentNumber(format, period, counter.lastValue);
+    // The counter now holds the last of them; the first is count - 1 before it
+    const first = counter.lastValue - count + 1;
+    return Array.from({ length: count }, (_, index) =>
+      formatDocumentNumber(format, period, first + index),
+    );
   }
 
   list(): Promise<NumberSeries[]> {
```

`nextMany()` takes `count` numbers with one counter update: `lastValue + count`. The counter then holds the last of
them, so the first is `lastValue - count + 1`. An import of 5,000 products takes its codes in one statement instead of
5,000, and still in the caller's transaction (a rollback gives them all back). `next()` is now `nextMany(…, 1)`, so
there is one way to take a number.

**File: `apps/api/src/storage/storage.service.ts`** (change)

```diff
@@ -5,6 +5,7 @@ import {
   GetObjectCommand,
   HeadBucketCommand,
   HeadObjectCommand,
+  NoSuchKey,
   NotFound,
   PutObjectCommand,
   S3Client,
@@ -122,6 +123,20 @@ export class StorageService implements OnApplicationBootstrap {
     );
   }
 
+  // A file someone uploaded, read by the server (a product import's CSV, step 12). null = no such
+  // file. Whole into memory: callers limit the size first (the import's 5 MB).
+  async get(key: string): Promise<Uint8Array | null> {
+    try {
+      const object = await this.client.send(
+        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
+      );
+      return object.Body ? await object.Body.transformToByteArray() : null;
+    } catch (error) {
+      if (error instanceof NoSuchKey) return null;
+      throw error;
+    }
+  }
+
   async delete(key: string): Promise<void> {
     await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
   }
```

The worker reads the uploaded CSV with `get()`. `NoSuchKey` (the file was never uploaded, or was removed) becomes
`null`, so the handler can give up cleanly instead of retrying a file that will never appear. The whole file goes into
memory; that is fine because the import refuses files over 5 MB before they are uploaded.

**File: `apps/api/src/common/outbox/outbox.ts`** (change)

```diff
@@ -20,6 +20,10 @@ export const outboxPayloadSchemas = {
   'workspace.chart_requested': z.object({}),
   // The report_exports row says which report, which dates and for whom
   'report.export_requested': z.object({ exportId: z.uuid() }),
+  // Like the chart's: the workspace and its business type say everything
+  'workspace.catalog_requested': z.object({}),
+  // The product_imports row says which file, and who uploaded it
+  'product.import_requested': z.object({ importId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

**File: `apps/api/src/worker/queues.ts`** (change)

```diff
@@ -19,6 +19,8 @@ const QUEUE_OF = {
   'member.joined': 'jobs',
   'workspace.chart_requested': 'jobs',
   'report.export_requested': 'jobs',
+  'workspace.catalog_requested': 'jobs',
+  'product.import_requested': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

Both new events go to the `jobs` queue: neither sends email, so a slow mail server never holds them up.

**File: `apps/api/src/products/product-write.ts`** (new)

```ts
import {
  type CustomFieldValues,
  customFieldsInputSchema,
  type ErrorCode,
  isErrorCode,
  type ProductInput,
  sameFactor,
  standardFactor,
  variantSku,
} from '@omnivo/contracts';
import {
  customFieldDefinitions,
  productBarcodes,
  productCategories,
  products,
  productUnits,
  productVariants,
  units,
} from '@omnivo/db';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What both the API (one product from the form) and the import job (thousands from a CSV) need
// to check a product against the database and write it. One place, so a product that the form
// refuses is refused by the import too — with the same error codes on the same paths.

type UnitRow = typeof units.$inferSelect;

// A problem on one field, by the form's path: "units.0.factor", "customFields.gsm"
export interface ProductIssue {
  path: string;
  code: ErrorCode;
}

// The workspace's units, categories and active product fields: read once per request or per
// import, not once per product
export interface ProductContext {
  units: Map<string, UnitRow>;
  categoryIds: Set<string>;
  fields: (typeof customFieldDefinitions.$inferSelect)[];
}

export async function loadProductContext(tx: Transaction): Promise<ProductContext> {
  const tenantId = getTenantId();
  const [unitRows, categoryRows, fieldRows] = await Promise.all([
    tx.select().from(units).where(eq(units.tenantId, tenantId)),
    tx
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(eq(productCategories.tenantId, tenantId)),
    tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.tenantId, tenantId),
          eq(customFieldDefinitions.entity, 'product'),
          isNull(customFieldDefinitions.archivedAt),
        ),
      )
      .orderBy(customFieldDefinitions.id),
  ]);
  return {
    units: new Map(unitRows.map((row) => [row.id, row])),
    categoryIds: new Set(categoryRows.map((row) => row.id)),
    fields: fieldRows,
  };
}

// The checks the contract cannot do, because they need the workspace's data: the units exist and
// are active, a standard conversion is exactly right, the category exists, the custom fields fit
// the workspace's fields. `keepUnits`: units the product already uses stay allowed after being
// archived ("products that use it keep it"). `saved`: the product's stored custom fields — the
// values of archived fields are kept, the form never sends them.
export function checkProduct(
  input: ProductInput,
  context: ProductContext,
  keepUnits: ReadonlySet<string> = new Set(),
  saved: CustomFieldValues = {},
): { issues: ProductIssue[]; customFields: CustomFieldValues } {
  const issues: ProductIssue[] = [];
  const usable = (id: string): UnitRow | undefined => {
    const unit = context.units.get(id);
    return unit && (unit.archivedAt === null || keepUnits.has(id)) ? unit : undefined;
  };

  if (input.categoryId !== null && !context.categoryIds.has(input.categoryId)) {
    issues.push({ path: 'categoryId', code: 'product_category_invalid' });
  }
  const base = usable(input.baseUnitId);
  if (!base) issues.push({ path: 'baseUnitId', code: 'product_unit_invalid' });
  input.units.forEach((pack, index) => {
    const unit = usable(pack.unitId);
    if (!unit) {
      issues.push({ path: `units.${String(index)}.unitId`, code: 'product_unit_invalid' });
      return;
    }
    // A dozen is 12 pieces in every product. Only a pack (no ratio) or another dimension (eggs
    // sold by the piece and bought by the kg) takes the number the person typed.
    const standard = base ? standardFactor(unit, base) : null;
    if (standard !== null && base && !sameFactor(standard, pack.factor)) {
      issues.push({ path: `units.${String(index)}.factor`, code: 'product_factor_standard' });
    }
  });

  const parsed = customFieldsInputSchema(context.fields).safeParse(input.customFields);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: ['customFields', ...issue.path.map(String)].join('.'),
        code: isErrorCode(issue.message) ? issue.message : 'invalid_value',
      });
    }
  }
  const activeKeys = new Set(context.fields.map((field) => field.key));
  const kept = Object.fromEntries(Object.entries(saved).filter(([key]) => !activeKeys.has(key)));
  return { issues, customFields: { ...kept, ...(parsed.data ?? {}) } };
}

// resolveSkus() gives one SKU per variant, so a missing one is a bug here, never the person's input
export function skuAt(skus: readonly string[], position: number): string {
  const sku = skus[position];
  if (sku === undefined) throw new Error(`No SKU for variant ${String(position)}`);
  return sku;
}

// The SKUs a product's variants get: the typed one, or one made from the product's code
export function resolveSkus(input: ProductInput, code: string): string[] {
  return input.variants.map((variant) => variant.sku ?? variantSku(code, variant.optionValues));
}

// Which of these codes, SKUs and barcodes another product already uses (case-insensitive for
// codes and SKUs, like their unique indexes). Asked before writing, so the answer can name the
// field; the unique indexes stay the real guard against two saves at the same moment.
export async function findTaken(
  tx: Transaction,
  wanted: { codes: string[]; skus: string[]; barcodes: string[] },
  exceptProductId?: string,
): Promise<{ codes: Set<string>; skus: Set<string>; barcodes: Set<string> }> {
  const tenantId = getTenantId();
  const lower = (values: string[]) => [...new Set(values.map((value) => value.toLowerCase()))];
  const notThis = (column: typeof products.id | typeof productVariants.productId) =>
    exceptProductId === undefined ? undefined : ne(column, exceptProductId);
  const [codes, skus, barcodes] = await Promise.all([
    wanted.codes.length === 0
      ? []
      : tx
          .select({ value: sql<string>`lower(${products.code})` })
          .from(products)
          .where(
            and(
              eq(products.tenantId, tenantId),
              inArray(sql`lower(${products.code})`, lower(wanted.codes)),
              notThis(products.id),
            ),
          ),
    wanted.skus.length === 0
      ? []
      : tx
          .select({ value: sql<string>`lower(${productVariants.sku})` })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              inArray(sql`lower(${productVariants.sku})`, lower(wanted.skus)),
              notThis(productVariants.productId),
            ),
          ),
    wanted.barcodes.length === 0
      ? []
      : tx
          .select({ value: productBarcodes.code })
          .from(productBarcodes)
          .where(
            and(
              eq(productBarcodes.tenantId, tenantId),
              inArray(productBarcodes.code, [...new Set(wanted.barcodes)]),
              exceptProductId === undefined
                ? undefined
                : ne(productBarcodes.productId, exceptProductId),
            ),
          ),
  ]);
  return {
    codes: new Set(codes.map((row) => row.value)),
    skus: new Set(skus.map((row) => row.value)),
    barcodes: new Set(barcodes.map((row) => row.value)),
  };
}

// The taken values as field errors, on the field that holds each
export function takenIssues(
  input: ProductInput,
  code: string,
  skus: string[],
  taken: { codes: Set<string>; skus: Set<string>; barcodes: Set<string> },
): ProductIssue[] {
  const issues: ProductIssue[] = [];
  if (taken.codes.has(code.toLowerCase()))
    issues.push({ path: 'code', code: 'product_code_taken' });
  skus.forEach((sku, index) => {
    if (taken.skus.has(sku.toLowerCase())) {
      issues.push({ path: `variants.${String(index)}.sku`, code: 'product_sku_taken' });
    }
  });
  input.variants.forEach((variant, index) => {
    if (variant.barcode !== null && taken.barcodes.has(variant.barcode)) {
      issues.push({ path: `variants.${String(index)}.barcode`, code: 'barcode_taken' });
    }
  });
  input.units.forEach((pack, index) => {
    if (pack.barcode !== null && taken.barcodes.has(pack.barcode)) {
      issues.push({ path: `units.${String(index)}.barcode`, code: 'barcode_taken' });
    }
  });
  return issues;
}

// A product ready to write: checked, with its code, SKUs and custom fields settled
export interface PreparedProduct {
  input: ProductInput;
  code: string;
  skus: string[];
  customFields: CustomFieldValues;
}

// Postgres takes at most 65,535 values in one statement. A product row has 14 columns, so 1,000
// rows (14,000 values) per INSERT is far below the limit, and 10,000 products take ten statements
// instead of ten thousand.
const CHUNK = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += CHUNK) {
    result.push(items.slice(start, start + CHUNK));
  }
  return result;
}

// The rows of a product's units and barcodes, from its input and its variants' new ids
function unitRows(tenantId: string, productId: string, input: ProductInput) {
  return input.units.map((pack, position) => ({
    tenantId,
    productId,
    unitId: pack.unitId,
    position,
    factor: pack.factor,
    isSalesDefault: input.salesUnitId === pack.unitId,
    isPurchaseDefault: input.purchaseUnitId === pack.unitId,
  }));
}

export function barcodeRows(
  tenantId: string,
  productId: string,
  input: ProductInput,
  variantIds: readonly string[],
) {
  const own = input.variants.flatMap((variant, index) => {
    const variantId = variantIds[index];
    return variant.barcode === null || variantId === undefined
      ? []
      : [{ tenantId, productId, variantId, code: variant.barcode, unitId: null }];
  });
  // A pack barcode is only allowed on a simple product (productRules), whose one variant it labels
  const only = variantIds[0];
  const packs = input.units.flatMap((pack) =>
    pack.barcode === null || only === undefined
      ? []
      : [{ tenantId, productId, variantId: only, code: pack.barcode, unitId: pack.unitId }],
  );
  return [...own, ...packs];
}

// Writes new products — one from the form, or thousands from an import — in a handful of
// statements per table. Returns the new ids in the order of `prepared`.
export async function insertProducts(
  tx: Transaction,
  prepared: readonly PreparedProduct[],
  userId: string,
): Promise<string[]> {
  const tenantId = getTenantId();
  const ids: string[] = [];
  for (const part of chunks(prepared)) {
    const inserted = await tx
      .insert(products)
      .values(
        part.map(({ input, code, customFields }) => ({
          tenantId,
          code,
          name: input.name,
          type: input.type,
          categoryId: input.categoryId,
          description: input.description,
          baseUnitId: input.baseUnitId,
          tracking: input.tracking,
          hasExpiry: input.hasExpiry,
          options: input.options,
          customFields,
          createdBy: userId,
          updatedBy: userId,
        })),
      )
      .returning({ id: products.id });
    // INSERT … RETURNING gives the rows back in the order of VALUES
    ids.push(...inserted.map((row) => row.id));
  }

  // Each product with its new id: from here on nothing is looked up by position in two lists
  const written = prepared.map((product, index) => {
    const id = ids[index];
    if (id === undefined) throw new Error('Product insert returned too few rows');
    return { ...product, id };
  });

  const variants = written.flatMap(({ id, input, skus }) =>
    input.variants.map((variant, position) => ({
      tenantId,
      productId: id,
      position,
      sku: skuAt(skus, position),
      optionValues: variant.optionValues,
      salePrice: variant.salePrice,
      archivedAt: variant.archived ? new Date() : null,
    })),
  );
  const variantIds: string[] = [];
  for (const part of chunks(variants)) {
    const inserted = await tx
      .insert(productVariants)
      .values(part)
      .returning({ id: productVariants.id });
    variantIds.push(...inserted.map((row) => row.id));
  }

  const packs = written.flatMap(({ id, input }) => unitRows(tenantId, id, input));
  for (const part of chunks(packs)) await tx.insert(productUnits).values(part);

  // The variants were inserted product by product, so each product's ids are the next slice
  let offset = 0;
  const barcodes = written.flatMap(({ id, input }) => {
    const own = variantIds.slice(offset, offset + input.variants.length);
    offset += input.variants.length;
    return barcodeRows(tenantId, id, input, own);
  });
  for (const part of chunks(barcodes)) await tx.insert(productBarcodes).values(part);
  return ids;
}

// The product's own units again (on an update): delete and insert. Nothing outside the product
// points at these rows — stock and sales lines (steps 13–17) hold a unit id, not a pack row.
export async function replaceUnits(
  tx: Transaction,
  productId: string,
  input: ProductInput,
): Promise<void> {
  const tenantId = getTenantId();
  await tx
    .delete(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.productId, productId)));
  const rows = unitRows(tenantId, productId, input);
  if (rows.length > 0) await tx.insert(productUnits).values(rows);
}

// Problems found before writing, as the API's answer: 409 when only "taken" values stand in the
// way (someone else has them — a conflict), 400 for everything the person typed wrong. Every field
// gets its code, so the form shows them all at once.
export function issuesError(issues: readonly ProductIssue[]): AppError {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
  const taken = issues.every((issue) => TAKEN.has(issue.code));
  const first = issues[0]?.code ?? 'invalid_input';
  return taken
    ? new AppError(409, first, 'Another product already uses one of these values.', { fieldErrors })
    : new AppError(400, 'invalid_input', 'Check the highlighted fields and try again.', {
        fieldErrors,
      });
}

const TAKEN = new Set<ErrorCode>(['product_code_taken', 'product_sku_taken', 'barcode_taken']);
```

The heart of the step: everything the API and the import both do. One place, so a product the form refuses, the
import refuses too — with the same error code, on the same field path.

- **`loadProductContext()`** reads the units, the category ids and the active product fields once. A request checks
  one product; an import checks thousands against the same context.
- **`checkProduct()` does what the contract cannot**, because it needs the workspace's data: the category exists, the
  units exist and are active, a standard unit has exactly its standard size, and the custom fields fit the active
  definitions. `keepUnits` is decision 9: a product saved again may keep an archived unit it already had.
- **`saved` and `kept`**: the values of archived custom fields stay on the product. The form only sends active fields,
  and a save must not wipe what an archived field still holds — restoring the field brings its values back.
- **`resolveSkus()`** gives each variant its typed SKU, or one made from the code (`variantSku()`).
- **`findTaken()` asks before writing**, with three queries at once, which codes, SKUs and barcodes another product
  already has (case-insensitive for codes and SKUs, like their unique indexes). Asking first lets the answer name the
  field — `variants.2.sku` — which a unique-violation error cannot. The unique indexes stay the real guard against two
  saves at the same moment (`racedError()` in the service). `exceptProductId` leaves the product itself out on an edit.
- **`takenIssues()`** turns the taken values into field errors.
- **`issuesError()`** decides the status: 409 when only taken values stand in the way (a conflict with someone else's
  data), 400 for what the person typed wrong. Every field gets its codes, so the form shows them all at once.
- **`insertProducts()` writes 1 or 10,000 products in a handful of statements.** Postgres takes at most 65,535 values
  per statement; a product row has 14 columns, so 1,000 rows per `INSERT` stays far below it. `RETURNING` gives the new
  ids in the order of `VALUES`, so each id is paired with its product right away (`written`) and nothing is looked up
  by position in two lists afterwards. The variants of each product are a slice of the variant ids, in insert order —
  that is how barcodes find their variant.
- **`skuAt()`** throws instead of falling back to some value: `resolveSkus()` gives one SKU per variant, so a missing
  one is a bug, and a silent fallback would hide it.
- **`barcodeRows()`**: a variant's barcode names the variant; a pack's barcode names the pack and the product's only
  variant (a pack barcode is only allowed on a simple product, decision 8).
- **`replaceUnits()` deletes and inserts a product's packs** on an update. Nothing outside the product points at a
  pack row: stock and sales lines (steps 13–17) will hold a unit id, not a pack row.

### Units

**File: `apps/api/src/products/units.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { CreateUnitInput, Unit, UpdateUnitInput } from '@omnivo/contracts';
import { units } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type UnitRow = typeof units.$inferSelect;

function toUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    dimension: row.dimension,
    ratio: row.ratio,
    decimals: row.decimals,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: Pick<UnitRow, 'code' | 'name' | 'decimals'>) {
  return { code: row.code, name: row.name, decimals: row.decimals };
}

function codeTaken(): AppError {
  return new AppError(409, 'unit_code_taken', 'Another unit already uses this code.', {
    fieldErrors: { code: ['unit_code_taken'] },
  });
}

@Injectable()
export class UnitsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<Unit[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(units)
        .where(eq(units.tenantId, getTenantId()))
        .orderBy(asc(units.dimension), asc(units.ratio), asc(units.code));
      return rows.map(toUnit);
    });
  }

  async create(input: CreateUnitInput): Promise<Unit> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(units)
          .values({ tenantId: getTenantId(), ...input, createdBy: currentPrincipal().userId })
          .returning();
        if (!row) throw new Error('Unit insert returned no row');
        await audit(tx, {
          action: 'unit.created',
          entityType: 'unit',
          entityId: row.id,
          changes: created({ ...snapshot(row), dimension: row.dimension, ratio: row.ratio }),
        });
        return toUnit(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'units_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateUnitInput): Promise<Unit> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        const after = await this.write(tx, id, {
          code: input.code,
          name: input.name,
          decimals: input.decimals,
        });
        await audit(tx, {
          action: 'unit.updated',
          entityType: 'unit',
          entityId: id,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return toUnit(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'units_tenant_code_idx')) throw codeTaken();
      throw error;
    }
  }

  // Archived: hidden from new products. Products that use it keep it, and can still be saved.
  setArchived(id: string, version: number, archived: boolean): Promise<Unit> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toUnit(before);
      const after = await this.write(tx, id, { archivedAt: archived ? new Date() : null });
      await audit(tx, {
        action: archived ? 'unit.archived' : 'unit.restored',
        entityType: 'unit',
        entityId: id,
      });
      return toUnit(after);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        await tx.delete(units).where(and(eq(units.tenantId, getTenantId()), eq(units.id, id)));
        await audit(tx, {
          action: 'unit.deleted',
          entityType: 'unit',
          entityId: id,
          changes: diff(snapshot(before), { code: null, name: null, decimals: null }),
        });
      });
    } catch (error) {
      // No "is it used?" query first: the FKs are the check, and they cannot miss a product
      // saved a moment ago
      if (
        isForeignKeyViolation(error, 'products_base_unit_fk') ||
        isForeignKeyViolation(error, 'product_units_unit_fk')
      ) {
        throw new AppError(409, 'unit_in_use', 'Products use this unit. Archive it instead.');
      }
      throw error;
    }
  }

  private async lock(tx: Transaction, id: string): Promise<UnitRow> {
    const [row] = await tx
      .select()
      .from(units)
      .where(and(eq(units.tenantId, getTenantId()), eq(units.id, id)))
      .for('update');
    if (!row) throw notFound('Unit');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<UnitRow, 'code' | 'name' | 'decimals' | 'archivedAt'>>,
  ): Promise<UnitRow> {
    const [row] = await tx
      .update(units)
      .set({
        ...fields,
        version: sql`${units.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(units.tenantId, getTenantId()), eq(units.id, id)))
      .returning();
    if (!row) throw notFound('Unit');
    return row;
  }
}
```

- **The list is sorted by dimension, then size**: pcs before dozen, g before kg, packs last (`NULLS LAST` is the
  default for `ASC`).
- **`create()` catches the unique violation outside the transaction**, after its rollback — the pattern of every
  service since step 6.
- **`setArchived()`** returns the unit unchanged when it is already in the asked state: a second click is not an
  error.
- **`remove()` asks no "is it used?" question first.** The two foreign keys (a product's base unit, a pack) are the
  check, and they cannot miss a product saved a moment ago.

**File: `apps/api/src/products/units.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { UnitsService } from './units.service.js';

type Routes = typeof routes.units;

@Controller()
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Endpoint(routes.units.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.units.list() };
  }

  @Endpoint(routes.units.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.units.create(body);
  }

  @Endpoint(routes.units.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.units.update(params.id, body);
  }

  @Endpoint(routes.units.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.units.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.units.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.units.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.units.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.units.remove(params.id, query.version);
  }
}
```

### Categories

**File: `apps/api/src/products/product-categories.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateProductCategoryInput,
  ProductCategory,
  UpdateProductCategoryInput,
} from '@omnivo/contracts';
import { productCategories, products } from '@omnivo/db';
import { and, asc, count, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type CategoryRow = typeof productCategories.$inferSelect;

function toCategory(row: CategoryRow, productCount: number): ProductCategory {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    productCount,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'category_name_taken', 'This place already has a category so named.', {
    fieldErrors: { name: ['category_name_taken'] },
  });
}

function parentInvalid(): AppError {
  return new AppError(409, 'category_parent_invalid', 'Pick a category from the list.', {
    fieldErrors: { parentId: ['category_parent_invalid'] },
  });
}

// The chart's lock (accounts.service.ts), for the same two races: two moves in opposite
// directions, and a new category under one that is being deleted. Categories change rarely, so
// making one tenant's changes wait for each other costs nothing. The import job takes it too
// before it adds categories (import.handler.ts).
export async function lockCategoryTree(tx: Transaction): Promise<void> {
  const key = `product_categories:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

@Injectable()
export class ProductCategoriesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<ProductCategory[]> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const counts = tx
        .select({ categoryId: products.categoryId, total: count().as('total') })
        .from(products)
        .where(eq(products.tenantId, tenantId))
        .groupBy(products.categoryId)
        .as('counts');
      const rows = await tx
        // coalesce: a category without products has no row in `counts` — 0, not null
        .select({
          category: productCategories,
          total: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
        })
        .from(productCategories)
        .leftJoin(counts, eq(counts.categoryId, productCategories.id))
        .where(eq(productCategories.tenantId, tenantId))
        .orderBy(asc(productCategories.name));
      return rows.map((row) => toCategory(row.category, row.total));
    });
  }

  async create(input: CreateProductCategoryInput): Promise<ProductCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockCategoryTree(tx);
        const parent = input.parentId === null ? null : await this.find(tx, input.parentId);
        if (input.parentId !== null && !parent) throw parentInvalid();
        const [row] = await tx
          .insert(productCategories)
          .values({
            tenantId: getTenantId(),
            parentId: input.parentId,
            name: input.name,
            createdBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Category insert returned no row');
        await audit(tx, {
          action: 'product_category.created',
          entityType: 'product_category',
          entityId: row.id,
          changes: created({ name: row.name, parent: parent?.name ?? null }),
        });
        return toCategory(row, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'product_categories_sibling_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateProductCategoryInput): Promise<ProductCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockCategoryTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== input.version) throw versionConflict();
        const parentBefore = before.parentId === null ? null : await this.find(tx, before.parentId);
        const parentAfter =
          input.parentId === before.parentId
            ? parentBefore
            : await this.moveTarget(tx, id, input.parentId);
        const [after] = await tx
          .update(productCategories)
          .set({
            parentId: input.parentId,
            name: input.name,
            version: sql`${productCategories.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(productCategories.tenantId, getTenantId()), eq(productCategories.id, id)))
          .returning();
        if (!after) throw notFound('Category');
        await audit(tx, {
          action: 'product_category.updated',
          entityType: 'product_category',
          entityId: id,
          changes: diff(
            { name: before.name, parent: parentBefore?.name ?? null },
            { name: after.name, parent: parentAfter?.name ?? null },
          ),
        });
        const [counted] = await tx
          .select({ total: count() })
          .from(products)
          .where(and(eq(products.tenantId, getTenantId()), eq(products.categoryId, id)));
        return toCategory(after, counted?.total ?? 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'product_categories_sibling_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        await lockCategoryTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(productCategories)
          .where(and(eq(productCategories.tenantId, getTenantId()), eq(productCategories.id, id)));
        await audit(tx, {
          action: 'product_category.deleted',
          entityType: 'product_category',
          entityId: id,
          changes: diff({ name: before.name }, { name: null }),
        });
      });
    } catch (error) {
      // The FKs are the checks: sub-categories (the parent FK) and products (theirs)
      if (isForeignKeyViolation(error, 'product_categories_parent_fk')) {
        throw new AppError(
          409,
          'category_has_children',
          'Move or delete the sub-categories first.',
        );
      }
      if (isForeignKeyViolation(error, 'products_category_fk')) {
        throw new AppError(409, 'category_in_use', 'Move the products to another category first.');
      }
      throw error;
    }
  }

  // The new parent, after checking the move does not put the category under itself. The tree
  // lock makes sure no other move is half done while we walk up.
  private async moveTarget(
    tx: Transaction,
    id: string,
    parentId: string | null,
  ): Promise<CategoryRow | null> {
    if (parentId === null) return null;
    const parent = await this.find(tx, parentId);
    if (!parent) throw parentInvalid();
    const loop = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM product_categories
         WHERE tenant_id = ${getTenantId()}::uuid AND id = ${parentId}::uuid
        UNION ALL
        SELECT c.id, c.parent_id FROM product_categories c
          JOIN up ON c.id = up.parent_id
         WHERE c.tenant_id = ${getTenantId()}::uuid
      )
      SELECT 1 FROM up WHERE id = ${id}::uuid LIMIT 1`);
    if (loop.length > 0) {
      throw new AppError(409, 'category_parent_loop', 'A category cannot go under itself.', {
        fieldErrors: { parentId: ['category_parent_loop'] },
      });
    }
    return parent;
  }

  private async find(tx: Transaction, id: string, forUpdate = false) {
    const query = tx
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, getTenantId()), eq(productCategories.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }
}
```

- **The count of products per category** is one `GROUP BY` joined to the categories. `coalesce(…, 0)`: a category
  without products has no row in the counts, and the contract wants a number.
- **`lockCategoryTree()`** is the chart's lock (step 9), for the same two races: two moves in opposite directions
  would deadlock on row locks, and a new category could land under one that is being deleted. It is exported because
  the import takes it too before it adds categories.
- **`moveTarget()` walks up from the new parent** with a recursive query; meeting the category itself means the move
  would put it under its own branch.
- **`remove()` lets the foreign keys answer**: the parent FK means "it has sub-categories", the products' FK means "it
  holds products".

**File: `apps/api/src/products/product-categories.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ProductCategoriesService } from './product-categories.service.js';

type Routes = typeof routes.productCategories;

@Controller()
export class ProductCategoriesController {
  constructor(private readonly categories: ProductCategoriesService) {}

  @Endpoint(routes.productCategories.list)
  async list(): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.categories.list() };
  }

  @Endpoint(routes.productCategories.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.categories.create(body);
  }

  @Endpoint(routes.productCategories.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.categories.update(params.id, body);
  }

  @Endpoint(routes.productCategories.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.categories.remove(params.id, query.version);
  }
}
```

### Custom fields

**File: `apps/api/src/custom-fields/custom-fields.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateCustomFieldInput,
  CustomFieldDefinition,
  CustomFieldEntity,
  UpdateCustomFieldInput,
} from '@omnivo/contracts';
import { customFieldDefinitions } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type FieldRow = typeof customFieldDefinitions.$inferSelect;

function toDefinition(row: FieldRow): CustomFieldDefinition {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options,
    required: row.required,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// The audit log shows the choices as one line: "Tablet, Capsule, Syrup"
function snapshot(row: Pick<FieldRow, 'label' | 'options' | 'required'>) {
  return { label: row.label, options: row.options.join(', '), required: row.required };
}

// The workspace's own fields. Only the definitions live here; each record checks its values
// against them (customFieldsInputSchema in contracts, used by products/product-write.ts).
@Injectable()
export class CustomFieldsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // In the order they were made (UUIDv7 ids), which is the order forms show them in
  list(entity: CustomFieldEntity): Promise<CustomFieldDefinition[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.tenantId, getTenantId()),
            eq(customFieldDefinitions.entity, entity),
          ),
        )
        .orderBy(asc(customFieldDefinitions.id));
      return rows.map(toDefinition);
    });
  }

  async create(input: CreateCustomFieldInput): Promise<CustomFieldDefinition> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(customFieldDefinitions)
          .values({
            tenantId: getTenantId(),
            entity: input.entity,
            key: input.key,
            label: input.label,
            type: input.type,
            // A choice list on a text field would mean nothing
            options: input.type === 'select' ? input.options : [],
            // Unticked is a value too: a yes/no field is never "missing"
            required: input.type === 'boolean' ? false : input.required,
            createdBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Custom field insert returned no row');
        await audit(tx, {
          action: 'custom_field.created',
          entityType: 'custom_field',
          entityId: row.id,
          changes: created({ key: row.key, type: row.type, ...snapshot(row) }),
        });
        return toDefinition(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'custom_field_definitions_key_idx')) {
        throw new AppError(409, 'custom_field_key_taken', 'Another field uses this key.', {
          fieldErrors: { key: ['custom_field_key_taken'] },
        });
      }
      throw error;
    }
  }

  // A removed choice stays on the records that hold it; their form shows it as wrong when they are
  // next edited, so nothing changes behind anyone's back
  update(id: string, input: UpdateCustomFieldInput): Promise<CustomFieldDefinition> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== input.version) throw versionConflict();
      if (before.type === 'select' && input.options.length === 0) {
        throw new AppError(400, 'invalid_input', 'A select keeps at least one choice.', {
          fieldErrors: { options: ['custom_field_options_required'] },
        });
      }
      const after = await this.write(tx, id, {
        label: input.label,
        options: before.type === 'select' ? input.options : [],
        required: before.type === 'boolean' ? false : input.required,
      });
      await audit(tx, {
        action: 'custom_field.updated',
        entityType: 'custom_field',
        entityId: id,
        changes: diff(snapshot(before), snapshot(after)),
      });
      return toDefinition(after);
    });
  }

  setArchived(id: string, version: number, archived: boolean): Promise<CustomFieldDefinition> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toDefinition(before);
      const after = await this.write(tx, id, { archivedAt: archived ? new Date() : null });
      await audit(tx, {
        action: archived ? 'custom_field.archived' : 'custom_field.restored',
        entityType: 'custom_field',
        entityId: id,
      });
      return toDefinition(after);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<FieldRow> {
    const [row] = await tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(eq(customFieldDefinitions.tenantId, getTenantId()), eq(customFieldDefinitions.id, id)),
      )
      .for('update');
    if (!row) throw notFound('Custom field');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<FieldRow, 'label' | 'options' | 'required' | 'archivedAt'>>,
  ): Promise<FieldRow> {
    const [row] = await tx
      .update(customFieldDefinitions)
      .set({
        ...fields,
        version: sql`${customFieldDefinitions.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(
        and(eq(customFieldDefinitions.tenantId, getTenantId()), eq(customFieldDefinitions.id, id)),
      )
      .returning();
    if (!row) throw notFound('Custom field');
    return row;
  }
}
```

- **The list is in the order the fields were made** (UUIDv7 ids sort by time), which is the order the form shows them.
- **`create()` stores no choices on a non-select field and never "required" on a yes/no field**, whatever was sent.
- **`update()` checks "a select keeps a choice"** with the type it reads from the row; the contract cannot.
- **A removed choice stays on the products that hold it.** The product form shows it as an extra choice, so nothing
  changes behind anyone's back; it is checked again the next time that product is saved.

**File: `apps/api/src/custom-fields/custom-fields.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { CustomFieldsService } from './custom-fields.service.js';

type Routes = typeof routes.customFields;

@Controller()
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Endpoint(routes.customFields.list)
  async list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return { items: await this.fields.list(query.entity) };
  }

  @Endpoint(routes.customFields.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.fields.create(body);
  }

  @Endpoint(routes.customFields.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.fields.update(params.id, body);
  }

  @Endpoint(routes.customFields.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.fields.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.customFields.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.fields.setArchived(params.id, body.version, false);
  }
}
```

**File: `apps/api/src/custom-fields/custom-fields.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';

// The workspace's own fields (system-design §4.8). Products use them from step 12; customers and
// suppliers will, when they come. The values are checked where each record is saved.
@Module({
  controllers: [CustomFieldsController],
  providers: [CustomFieldsService],
})
export class CustomFieldsModule {}
```

### Products

**File: `apps/api/src/products/products.service.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type Product,
  type ProductInput,
  type ProductPage,
  type ProductSort,
  todayIn,
  type UpdateProductInput,
} from '@omnivo/contracts';
import {
  productBarcodes,
  productCategories,
  products,
  productUnits,
  productVariants,
  tenantSettings,
  units,
} from '@omnivo/db';
import { and, asc, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  barcodeRows,
  checkProduct,
  findTaken,
  insertProducts,
  issuesError,
  loadProductContext,
  type ProductIssue,
  replaceUnits,
  resolveSkus,
  skuAt,
  takenIssues,
} from './product-write.js';

type ProductRow = typeof products.$inferSelect;

// The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
// (the last row's key and id) says exactly where the next page starts — never OFFSET.
const ORDERS = {
  name: { key: sql`lower(p.name)`, desc: false },
  '-name': { key: sql`lower(p.name)`, desc: true },
  code: { key: sql`lower(p.code)`, desc: false },
  '-code': { key: sql`lower(p.code)`, desc: true },
  // updated_at::text keeps the microseconds; a JavaScript Date would round them away, and a
  // cursor a few microseconds off skips or repeats a row
  '-updated': { key: sql`p.updated_at`, desc: true },
} satisfies Record<ProductSort, { key: SQL; desc: boolean }>;

const cursorSchema = z.tuple([z.string(), z.uuid()]);

const summaryRowSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  category_id: z.uuid().nullable(),
  base_unit_id: z.uuid(),
  tracking: z.string(),
  has_variants: z.boolean(),
  variant_count: z.number().int(),
  min_price: z.string().nullable(),
  max_price: z.string().nullable(),
  archived_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
  sort_key: z.string(),
});

// Drizzle's postgres-js driver leaves timestamps of a raw query as Postgres's own text
// ("2026-10-04 09:55:01.12+00"), which is not ISO. The query writes them as ISO itself, in UTC
// with milliseconds — the shape every other answer of the API has.
function isoText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// LIKE's own wildcards in what the person typed are meant literally: "10%" finds "10% off"
function containsPattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// What the audit log shows of a product: what a person would recognise, not ids
interface Snapshot {
  [field: string]: string | number | null;
  code: string;
  name: string;
  type: string;
  category: string | null;
  baseUnit: string | null;
  tracking: string;
  variants: number;
  packs: string | null;
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    categoryId?: string | undefined;
    status: 'active' | 'archived';
    sort: ProductSort;
  }): Promise<ProductPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const order = ORDERS[query.sort];
    const compare = order.desc ? sql`<` : sql`>`;
    const direction = order.desc ? sql`DESC` : sql`ASC`;
    const conditions: SQL[] = [
      sql`p.tenant_id = ${tenantId}::uuid`,
      query.status === 'active' ? sql`p.archived_at IS NULL` : sql`p.archived_at IS NOT NULL`,
    ];
    if (query.categoryId !== undefined) {
      // The category and everything under it: "Finished garments" shows the T-shirts too
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
      // A barcode is matched whole: a scan into the search box is the whole code, and part of a
      // barcode means nothing to anyone
      conditions.push(sql`(
        lower(p.name) LIKE ${pattern} OR lower(p.code) LIKE ${pattern}
        OR EXISTS (SELECT 1 FROM product_variants v
                    WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND lower(v.sku) LIKE ${pattern})
        OR EXISTS (SELECT 1 FROM product_barcodes b
                    WHERE b.tenant_id = p.tenant_id AND b.product_id = p.id AND b.code = ${query.search}))`);
    }
    if (after !== undefined) {
      const key = query.sort === '-updated' ? sql`${after[0]}::timestamptz` : sql`${after[0]}`;
      conditions.push(sql`(${order.key}, p.id) ${compare} (${key}, ${after[1]}::uuid)`);
    }

    return this.withTenant(async (tx) => {
      const rows = z.array(summaryRowSchema).parse(
        await tx.execute(sql`
          SELECT p.id::text, p.code, p.name, p.type, p.category_id::text, p.base_unit_id::text,
                 p.tracking, jsonb_array_length(p.options) > 0 AS has_variants,
                 s.variant_count, s.min_price, s.max_price,
                 ${isoText(sql`p.archived_at`)} AS archived_at, ${isoText(sql`p.updated_at`)} AS updated_at,
                 ${order.key}::text AS sort_key
            FROM products p
            LEFT JOIN LATERAL (
              SELECT count(*)::int AS variant_count,
                     min(v.sale_price)::text AS min_price, max(v.sale_price)::text AS max_price
                FROM product_variants v
               WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND v.archived_at IS NULL
            ) s ON true
           WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY ${order.key} ${direction}, p.id ${direction}
           LIMIT ${query.limit + 1}`),
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          type: row.type,
          categoryId: row.category_id,
          baseUnitId: row.base_unit_id,
          tracking: row.tracking,
          hasVariants: row.has_variants,
          variantCount: row.variant_count,
          minPrice: row.min_price,
          maxPrice: row.max_price,
          archivedAt: row.archived_at,
          updatedAt: row.updated_at,
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor([last.sort_key, last.id])
            : null,
      };
    });
  }

  get(id: string): Promise<Product> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: ProductInput): Promise<Product> {
    try {
      return await this.withTenant(async (tx) => {
        const context = await loadProductContext(tx);
        const checked = checkProduct(input, context);
        if (checked.issues.length > 0) throw issuesError(checked.issues);
        const code = input.code ?? (await this.newCode(tx));
        const skus = resolveSkus(input, code);
        const taken = await findTaken(tx, { codes: [code], skus, barcodes: barcodesOf(input) });
        const conflicts = takenIssues(input, code, skus, taken);
        if (conflicts.length > 0) throw issuesError(conflicts);

        const [id] = await insertProducts(
          tx,
          [{ input, code, skus, customFields: checked.customFields }],
          currentPrincipal().userId,
        );
        if (id === undefined) throw new Error('Product insert returned no id');
        const product = await this.read(tx, id);
        await audit(tx, {
          action: 'product.created',
          entityType: 'product',
          entityId: id,
          changes: created(await this.snapshot(tx, product)),
        });
        return product;
      });
    } catch (error) {
      throw racedError(error);
    }
  }

  async update(id: string, input: UpdateProductInput): Promise<Product> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        const old = await this.read(tx, id);
        const context = await loadProductContext(tx);
        const keep = new Set([old.baseUnitId, ...old.units.map((pack) => pack.unitId)]);
        const checked = checkProduct(input, context, keep, before.customFields);
        // An id sent back must be one of this product's own variants, and only once
        const known = new Set(old.variants.map((variant) => variant.id));
        const seen = new Set<string>();
        const unknown: ProductIssue[] = input.variants.flatMap((variant, index) => {
          if (variant.id === null) return [];
          const bad = !known.has(variant.id) || seen.has(variant.id);
          seen.add(variant.id);
          return bad
            ? [{ path: `variants.${String(index)}.id`, code: 'product_variant_unknown' }]
            : [];
        });
        const issues = [...checked.issues, ...unknown];
        if (issues.length > 0) throw issuesError(issues);

        // An empty code on an existing product keeps the one it has
        const code = input.code ?? before.code;
        const skus = resolveSkus(input, code);
        const taken = await findTaken(tx, { codes: [code], skus, barcodes: barcodesOf(input) }, id);
        const conflicts = takenIssues(input, code, skus, taken);
        if (conflicts.length > 0) throw issuesError(conflicts);

        await tx
          .update(products)
          .set({
            code,
            name: input.name,
            type: input.type,
            categoryId: input.categoryId,
            description: input.description,
            baseUnitId: input.baseUnitId,
            tracking: input.tracking,
            hasExpiry: input.hasExpiry,
            options: input.options,
            customFields: checked.customFields,
            version: sql`${products.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
        await replaceUnits(tx, id, input);
        const variantIds = await this.replaceVariants(tx, id, input, skus, old);
        await tx
          .delete(productBarcodes)
          .where(and(eq(productBarcodes.tenantId, tenantId), eq(productBarcodes.productId, id)));
        const barcodes = barcodeRows(tenantId, id, input, variantIds);
        if (barcodes.length > 0) await tx.insert(productBarcodes).values(barcodes);

        const product = await this.read(tx, id);
        await audit(tx, {
          action: 'product.updated',
          entityType: 'product',
          entityId: id,
          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, product)),
        });
        return product;
      });
    } catch (error) {
      if (
        isForeignKeyViolation(error, 'batches_variant_fk') ||
        isForeignKeyViolation(error, 'serials_variant_fk')
      ) {
        throw new AppError(409, 'product_variant_in_use', 'Archive the variant instead.');
      }
      throw racedError(error);
    }
  }

  setArchived(id: string, version: number, archived: boolean): Promise<Product> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await tx
          .update(products)
          .set({
            archivedAt: archived ? new Date() : null,
            version: sql`${products.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)));
        await audit(tx, {
          action: archived ? 'product.archived' : 'product.restored',
          entityType: 'product',
          entityId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        const old = await this.read(tx, id);
        // Variants, packs and barcodes go with it (ON DELETE CASCADE)
        await tx
          .delete(products)
          .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)));
        const gone = await this.snapshot(tx, old);
        await audit(tx, {
          action: 'product.deleted',
          entityType: 'product',
          entityId: id,
          changes: diff(gone, { code: null, name: null }),
        });
      });
    } catch (error) {
      // A batch or a serial number (and from step 13 a stock line) points at a variant: the
      // product has a history and stays
      if (
        isForeignKeyViolation(error, 'batches_variant_fk') ||
        isForeignKeyViolation(error, 'serials_variant_fk')
      ) {
        throw new AppError(409, 'product_in_use', 'Archive this product instead.');
      }
      throw error;
    }
  }

  // The next free code: the series may hand out a code someone typed by hand before (P-00007
  // typed on a product, then the series reaches 7). Such numbers are skipped, not refused.
  private async newCode(tx: Transaction): Promise<string> {
    const today = await this.today(tx);
    for (;;) {
      const code = await this.numbering.next(tx, 'inventory.product', today);
      const taken = await findTaken(tx, { codes: [code], skus: [], barcodes: [] });
      if (!taken.codes.has(code.toLowerCase())) return code;
    }
  }

  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }

  // Variants on an update: the ones not sent are deleted, the ones sent with an id are changed in
  // place (their id — and from step 13 their stock — stays), the new ones are inserted. Returns
  // every variant's id in the order of input.variants.
  private async replaceVariants(
    tx: Transaction,
    productId: string,
    input: ProductInput,
    skus: string[],
    old: Product,
  ): Promise<string[]> {
    const tenantId = getTenantId();
    const ofProduct = and(
      eq(productVariants.tenantId, tenantId),
      eq(productVariants.productId, productId),
    );
    const keptIds = input.variants.flatMap((variant) => (variant.id === null ? [] : [variant.id]));
    await tx
      .delete(productVariants)
      .where(
        keptIds.length === 0 ? ofProduct : and(ofProduct, notInArray(productVariants.id, keptIds)),
      );
    if (keptIds.length > 0) {
      // Two variants may swap SKUs or values (S ↔ M typed the other way round). Changed one by one,
      // the first update would hit the unique index on the value the second still holds. So first
      // every kept variant gets a value nobody else can have: its own id.
      await tx
        .update(productVariants)
        .set({
          sku: sql`${productVariants.id}::text`,
          optionValues: sql`ARRAY[${productVariants.id}::text]`,
        })
        .where(and(ofProduct, inArray(productVariants.id, keptIds)));
    }
    const archivedAt = new Map(old.variants.map((variant) => [variant.id, variant.archivedAt]));
    const ids: string[] = [];
    for (const [position, variant] of input.variants.entries()) {
      const fields = {
        position,
        sku: skuAt(skus, position),
        optionValues: variant.optionValues,
        salePrice: variant.salePrice,
      };
      if (variant.id === null) {
        const [row] = await tx
          .insert(productVariants)
          .values({
            tenantId,
            productId,
            ...fields,
            archivedAt: variant.archived ? new Date() : null,
          })
          .returning({ id: productVariants.id });
        if (!row) throw new Error('Variant insert returned no row');
        ids.push(row.id);
        continue;
      }
      // An archived variant keeps the day it was archived
      const was = archivedAt.get(variant.id) ?? null;
      await tx
        .update(productVariants)
        .set({
          ...fields,
          archivedAt: variant.archived ? (was === null ? new Date() : new Date(was)) : null,
          updatedAt: new Date(),
        })
        .where(and(ofProduct, eq(productVariants.id, variant.id)));
      ids.push(variant.id);
    }
    return ids;
  }

  private async lock(tx: Transaction, id: string): Promise<ProductRow> {
    const [row] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)))
      .for('update');
    if (!row) throw notFound('Product');
    return row;
  }

  // The whole product: its row, variants, units and barcodes, in four small queries
  private async read(tx: Transaction, id: string): Promise<Product> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
    if (!row) throw notFound('Product');
    const [variants, packs, barcodes] = await Promise.all([
      tx
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, id)))
        .orderBy(asc(productVariants.position)),
      tx
        .select()
        .from(productUnits)
        .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.productId, id)))
        .orderBy(asc(productUnits.position)),
      tx
        .select()
        .from(productBarcodes)
        .where(and(eq(productBarcodes.tenantId, tenantId), eq(productBarcodes.productId, id))),
    ]);
    const variantBarcode = new Map(
      barcodes.flatMap((barcode) =>
        barcode.unitId === null ? [[barcode.variantId, barcode.code]] : [],
      ),
    );
    const packBarcode = new Map(
      barcodes.flatMap((barcode) =>
        barcode.unitId === null ? [] : [[barcode.unitId, barcode.code]],
      ),
    );
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      categoryId: row.categoryId,
      description: row.description,
      baseUnitId: row.baseUnitId,
      salesUnitId: packs.find((pack) => pack.isSalesDefault)?.unitId ?? null,
      purchaseUnitId: packs.find((pack) => pack.isPurchaseDefault)?.unitId ?? null,
      tracking: row.tracking,
      hasExpiry: row.hasExpiry,
      options: row.options,
      variants: variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        optionValues: variant.optionValues,
        barcode: variantBarcode.get(variant.id) ?? null,
        salePrice: variant.salePrice,
        archivedAt: variant.archivedAt?.toISOString() ?? null,
      })),
      units: packs.map((pack) => ({
        unitId: pack.unitId,
        factor: pack.factor,
        barcode: packBarcode.get(pack.unitId) ?? null,
      })),
      customFields: row.customFields,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async snapshot(tx: Transaction, product: Product): Promise<Snapshot> {
    const tenantId = getTenantId();
    const unitIds = [product.baseUnitId, ...product.units.map((pack) => pack.unitId)];
    const [unitRows, [category]] = await Promise.all([
      tx
        .select({ id: units.id, code: units.code })
        .from(units)
        .where(and(eq(units.tenantId, tenantId), inArray(units.id, unitIds))),
      product.categoryId === null
        ? [undefined]
        : tx
            .select({ name: productCategories.name })
            .from(productCategories)
            .where(
              and(
                eq(productCategories.tenantId, tenantId),
                eq(productCategories.id, product.categoryId),
              ),
            ),
    ]);
    const codeOf = new Map(unitRows.map((unit) => [unit.id, unit.code]));
    const packs = product.units
      .map((pack) => `${codeOf.get(pack.unitId) ?? '?'} = ${pack.factor.replace(/\.?0+$/, '')}`)
      .join(', ');
    return {
      code: product.code,
      name: product.name,
      type: product.type,
      category: category?.name ?? null,
      baseUnit: codeOf.get(product.baseUnitId) ?? null,
      tracking: product.tracking,
      variants: product.variants.filter((variant) => variant.archivedAt === null).length,
      packs: packs === '' ? null : packs,
    };
  }
}

function barcodesOf(input: ProductInput): string[] {
  return [
    ...input.variants.flatMap((variant) => (variant.barcode === null ? [] : [variant.barcode])),
    ...input.units.flatMap((pack) => (pack.barcode === null ? [] : [pack.barcode])),
  ];
}

// Two saves at the same moment can both pass findTaken(); the unique index then refuses the
// second. The answer is the same as findTaken's, without knowing which variant it was.
function racedError(error: unknown): unknown {
  if (isUniqueViolation(error, 'products_tenant_code_idx')) {
    return new AppError(409, 'product_code_taken', 'Another product uses this code.', {
      fieldErrors: { code: ['product_code_taken'] },
    });
  }
  if (isUniqueViolation(error, 'product_variants_tenant_sku_idx')) {
    return new AppError(409, 'product_sku_taken', 'Another product uses one of these SKUs.');
  }
  if (isUniqueViolation(error, 'product_barcodes_tenant_code_idx')) {
    return new AppError(409, 'barcode_taken', 'Another product uses one of these barcodes.');
  }
  return error;
}
```

- **`ORDERS`**: five orders, each a key plus the id. The cursor is the last row's key and id, so the next page starts
  exactly after it — no OFFSET (system-design §5.6).
- **`-updated` sorts by `updated_at` and keeps its cursor as Postgres text.** `updated_at::text` holds microseconds; a
  JavaScript Date would round them to milliseconds, and a cursor a few microseconds off skips or repeats a row.
- **`isoText()`**: drizzle's postgres-js driver leaves the timestamps of a raw query as Postgres's own text
  (`2026-10-04 09:55:01.12+00`), which is not ISO and which the contract refuses. The query writes ISO itself. (Found
  as a 500 on the list; see "What we found on the way".)
- **`containsPattern()`** escapes `\`, `%` and `_`: "10%" searches for "10%", not "10 followed by anything".
- **The search** looks for part of the name, the code or any SKU, and for the whole barcode (decision 12). The two
  `EXISTS` subqueries stop at the first match.
- **The category filter** collects the category and everything under it with a recursive query, then filters by
  `IN (…)`.
- **The `LATERAL` subquery** counts the active variants and finds the price range of each product on the page — 50
  small lookups by the `(tenant, product, id)` index, not a count over the whole table.
- **`create()`**: check against the workspace, take a code if none was typed, resolve the SKUs, ask what is taken,
  insert, then read the product back the way `get()` does, and audit what a person recognises.
- **`newCode()` skips a code someone typed by hand.** If a product was saved as `P-00007` by hand and the series
  reaches 7, the series moves on to 8 instead of refusing the next product.
- **`update()` checks the variant ids**: an id sent back must be one of this product's own variants, and only once
  (`product_variant_unknown`). Without this, a form could name another product's variant — or another workspace's,
  where RLS would make the update silently touch nothing.
- **An empty code on an existing product keeps the one it has**, so clearing the box by mistake does not renumber it.
- **`replaceVariants()` first gives every kept variant its own id as SKU and values.** Two variants may swap SKUs or
  values (S and M typed the wrong way round); changed one by one, the first update would collide on the unique index
  with the value the second still holds. After that step, every final value is free.
- **An archived variant keeps the day it was archived**; a restored one gets `null`.
- **Barcodes are deleted and written again** on every save: they carry no history.
- **`remove()`** deletes the product and lets the cascade take its parts. A batch (and from step 13 a stock line)
  pointing at a variant stops the cascade, and the API answers `product_in_use`. The same constraint during an update
  means a removed variant has history: `product_variant_in_use`.
- **`racedError()`**: two saves at the same moment can both pass `findTaken()`; the unique index refuses the second,
  and this turns it into the same answer.

**File: `apps/api/src/products/products.controller.ts`** (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { ProductImportsService } from './product-imports.service.js';
import { ProductsService } from './products.service.js';

type Routes = typeof routes.products;
type ImportRoutes = typeof routes.productImports;

@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Endpoint(routes.products.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.products.list(query);
  }

  @Endpoint(routes.products.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.products.get(params.id);
  }

  @Endpoint(routes.products.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.products.create(body);
  }

  @Endpoint(routes.products.update)
  update({ params, body }: RouteInput<Routes['update']>): Promise<RouteResponse<Routes['update']>> {
    return this.products.update(params.id, body);
  }

  @Endpoint(routes.products.archive)
  archive({
    params,
    body,
  }: RouteInput<Routes['archive']>): Promise<RouteResponse<Routes['archive']>> {
    return this.products.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.products.restore)
  restore({
    params,
    body,
  }: RouteInput<Routes['restore']>): Promise<RouteResponse<Routes['restore']>> {
    return this.products.setArchived(params.id, body.version, false);
  }

  @Endpoint(routes.products.remove)
  remove({ params, query }: RouteInput<Routes['remove']>): Promise<void> {
    return this.products.remove(params.id, query.version);
  }
}

@Controller()
export class ProductImportsController {
  constructor(private readonly imports: ProductImportsService) {}

  @Endpoint(routes.productImports.create)
  create({
    body,
  }: RouteInput<ImportRoutes['create']>): Promise<RouteResponse<ImportRoutes['create']>> {
    return this.imports.create(body);
  }

  @Endpoint(routes.productImports.start)
  start({
    params,
  }: RouteInput<ImportRoutes['start']>): Promise<RouteResponse<ImportRoutes['start']>> {
    return this.imports.start(params.id);
  }

  @Endpoint(routes.productImports.list)
  list({ query }: RouteInput<ImportRoutes['list']>): Promise<RouteResponse<ImportRoutes['list']>> {
    return this.imports.list(query);
  }

  @Endpoint(routes.productImports.get)
  get({ params }: RouteInput<ImportRoutes['get']>): Promise<RouteResponse<ImportRoutes['get']>> {
    return this.imports.get(params.id);
  }
}
```

The products and the imports share a file: two small controllers with the same module.

### Imports: the API's half

**File: `apps/api/src/products/product-imports.service.ts`** (new)

```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateProductImportInput,
  ProductImport,
  ProductImportDetail,
} from '@omnivo/contracts';
import { productImports, users } from '@omnivo/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';

// Ten minutes to upload, like an attachment: plenty for 5 MB on a slow line
const UPLOAD_TTL_SECONDS = 10 * 60;
// The browser must send exactly this type; Windows reports a .csv as application/vnd.ms-excel,
// so the type is fixed here instead of taken from the browser
const CSV_TYPE = 'text/csv';

type ImportRow = typeof productImports.$inferSelect;

function toImport(row: ImportRow, fullName: string): ProductImport {
  return {
    id: row.id,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    status: row.status,
    rowCount: row.rowCount,
    productCount: row.productCount,
    errorCount: row.errorCount,
    requestedBy: { id: row.requestedBy, fullName },
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

const cursorSchema = z.tuple([z.uuid()]);

// The API's half of an import: the row, the upload address, and the outbox event once the file is
// really in storage. The worker does the rest (import.handler.ts).
@Injectable()
export class ProductImportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  create(input: CreateProductImportInput) {
    const tenantId = getTenantId();
    const principal = currentPrincipal();
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(productImports)
        .values({
          tenantId,
          requestedBy: principal.userId,
          fileName: input.fileName,
          sizeBytes: input.sizeBytes,
          // The key is fixed before the row exists, so it can hold no id; a random part keeps two
          // uploads of the same name apart
          storageKey: ['tenants', tenantId, 'product-imports', `${randomUUID()}.csv`].join('/'),
        })
        .returning();
      if (!row) throw new Error('Product import insert returned no row');
      const upload = await this.storage.uploadUrl(row.storageKey, CSV_TYPE, UPLOAD_TTL_SECONDS);
      return {
        import: toImport(row, await this.nameOf(tx, row.requestedBy)),
        upload: {
          method: 'PUT' as const,
          url: upload.url,
          headers: { 'content-type': CSV_TYPE },
          expiresAt: upload.expiresAt.toISOString(),
        },
      };
    });
  }

  // The browser says "uploaded"; storage is asked rather than believed. Then, in the same
  // transaction as the status change, the outbox event (step 8): queued exactly once.
  start(id: string): Promise<ProductImport> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(productImports)
        .where(and(eq(productImports.tenantId, getTenantId()), eq(productImports.id, id)))
        .for('update');
      if (!row) throw notFound('Product import');
      if (row.status !== 'uploading') {
        throw new AppError(409, 'import_not_pending', 'This import was started already.');
      }
      const stored = await this.storage.head(row.storageKey);
      // A presigned PUT cannot limit the size (attachments.service.ts): checked here instead
      if (stored?.sizeBytes !== row.sizeBytes) {
        throw new AppError(409, 'import_not_uploaded', "The file isn't in storage, or it differs.");
      }
      const [queued] = await tx
        .update(productImports)
        .set({ status: 'queued' })
        .where(eq(productImports.id, id))
        .returning();
      if (!queued) throw notFound('Product import');
      await emit(tx, 'product.import_requested', { importId: id });
      return toImport(queued, await this.nameOf(tx, queued.requestedBy));
    });
  }

  list(query: { limit: number; cursor?: string | undefined }) {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ row: productImports, fullName: users.fullName })
        .from(productImports)
        .innerJoin(users, eq(users.id, productImports.requestedBy))
        .where(
          and(
            eq(productImports.tenantId, getTenantId()),
            after === undefined ? undefined : lt(productImports.id, after[0]),
          ),
        )
        .orderBy(desc(productImports.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.row.id]);
      return {
        items: page.items.map(({ row, fullName }) => toImport(row, fullName)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<ProductImportDetail> {
    return this.withTenant(async (tx) => {
      const [found] = await tx
        .select({ row: productImports, fullName: users.fullName })
        .from(productImports)
        .innerJoin(users, eq(users.id, productImports.requestedBy))
        .where(and(eq(productImports.tenantId, getTenantId()), eq(productImports.id, id)));
      if (!found) throw notFound('Product import');
      return { ...toImport(found.row, found.fullName), errors: found.row.errors };
    });
  }

  private async nameOf(tx: Transaction, userId: string): Promise<string> {
    const [user] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId));
    return user?.fullName ?? '';
  }
}
```

- **`CSV_TYPE` is fixed.** The upload is signed for `text/csv` and the browser must send exactly that header; Windows
  would otherwise announce `application/vnd.ms-excel`.
- **The storage key has a random name**: the row's id is not known before the insert, and two uploads of the same file
  name must not overwrite each other.
- **`start()` asks storage instead of believing the browser** (step 6's rule for attachments): a missing file, or one
  of another size, is `import_not_uploaded`. A presigned PUT cannot limit the size; this check can.
- **The status change and the outbox event are in one transaction**, under a row lock: a double click on Import
  queues the file once, and the second click gets `import_not_pending`.

### Imports: the CSV

**File: `apps/api/src/products/import/csv.ts`** (new)

```ts
import {
  CATEGORY_PATH_SEPARATOR,
  contractErrorMap,
  CUSTOM_FIELD_COLUMN_PREFIX,
  type CustomFieldDefinition,
  customFieldsInputSchema,
  type ErrorCode,
  isErrorCode,
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_MAX_ROWS,
  PRODUCT_IMPORT_REQUIRED_COLUMNS,
  type ProductImportError,
  type ProductInput,
  productInputSchema,
  type TrackingMode,
} from '@omnivo/contracts';
import { CsvError, parse } from 'csv-parse/sync';

// The CSV half of an import, without the database: bytes in, product inputs (or what is wrong)
// out. Pure, so every rule is tested on its own (csv.spec.ts) without containers.

interface ImportUnit {
  id: string;
  code: string;
}

// What the file is read against: the workspace's active units and fields, and what a blank
// tracking cell means (the form's default for the business type)
export interface ImportLookups {
  units: readonly ImportUnit[];
  fields: readonly Pick<CustomFieldDefinition, 'key' | 'type' | 'options' | 'required'>[];
  defaultTracking: { tracking: TrackingMode; hasExpiry: boolean };
}

// One product of the file: its checked input, the rows it came from (the first holds the product's
// own cells, each row is one variant), and its category as a path still to be found or made
export interface ImportedProduct {
  input: ProductInput;
  rows: number[];
  categoryPath: string[] | null;
}

export interface ReadFile {
  products: ImportedProduct[];
  errors: ProductImportError[];
  rowCount: number;
}

type Cells = Record<string, string>;

function fileError(code: ErrorCode, params?: Record<string, string | number>): ProductImportError {
  return { row: null, column: null, code, ...(params && { params }) };
}

// Bytes → text. Excel's "CSV UTF-8" starts with a byte order mark; its plain "CSV" on Windows is
// not UTF-8 at all, and a Bangla name would come out as question marks. fatal: true refuses such a
// file instead of importing broken names.
function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// The cells of the columns that describe the product, not one variant: in a product's later rows
// they are empty or the same as in its first row
const PRODUCT_COLUMNS = new Set<string>([
  'code',
  'name',
  'type',
  'category',
  'unit',
  'option1_name',
  'option2_name',
  'option3_name',
  'sales_unit',
  'purchase_unit',
  'pack1_unit',
  'pack1_factor',
  'pack1_barcode',
  'pack2_unit',
  'pack2_factor',
  'pack2_barcode',
  'tracking',
  'expiry',
  'description',
]);

const OPTION_COLUMNS = [1, 2, 3] as const;
const PACK_COLUMNS = [1, 2] as const;

// The column a contract path belongs to, for a product built from `rows`: "units.1.factor" →
// pack2_factor on the first row; "variants.3.sku" → sku on the fourth row
export function columnOf(path: readonly (string | number)[], rows: readonly number[]) {
  const first = rows[0] ?? null;
  const [head, index, field] = path;
  const at = (row: number | null, column: string | null) => ({ row, column });
  switch (head) {
    case 'baseUnitId':
      return at(first, 'unit');
    case 'salesUnitId':
      return at(first, 'sales_unit');
    case 'purchaseUnitId':
      return at(first, 'purchase_unit');
    case 'hasExpiry':
      return at(first, 'expiry');
    case 'categoryId':
      return at(first, 'category');
    case 'code':
    case 'name':
    case 'type':
    case 'tracking':
    case 'description':
      return at(first, head);
    case 'options':
      return typeof index === 'number'
        ? at(
            first,
            field === 'name'
              ? `option${String(index + 1)}_name`
              : `option${String(index + 1)}_value`,
          )
        : at(first, 'option1_name');
    case 'units':
      return typeof index === 'number'
        ? at(
            first,
            `pack${String(index + 1)}_${field === 'factor' ? 'factor' : field === 'barcode' ? 'barcode' : 'unit'}`,
          )
        : at(first, 'pack1_unit');
    case 'customFields':
      return at(first, typeof index === 'string' ? `${CUSTOM_FIELD_COLUMN_PREFIX}${index}` : null);
    case 'variants': {
      if (typeof index !== 'number') return at(rows[1] ?? first, 'option1_value');
      const row = rows[index] ?? first;
      const column =
        field === 'sku'
          ? 'sku'
          : field === 'barcode'
            ? 'barcode'
            : field === 'salePrice'
              ? 'sale_price'
              : 'option1_value';
      return at(row, column);
    }
    default:
      return at(first, null);
  }
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

export function readProductsCsv(bytes: Uint8Array, lookups: ImportLookups): ReadFile {
  const text = decode(bytes);
  if (text === null) return { products: [], errors: [fileError('import_encoding')], rowCount: 0 };

  let records: string[][];
  try {
    // relax_column_count: Excel leaves trailing empty cells out of short rows. bom: drop the BOM.
    records = parse(text, { bom: true, trim: true, relax_column_count: true });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return { products: [], errors: [fileError('import_csv_malformed')], rowCount: 0 };
  }

  // --- The header -------------------------------------------------------------------------------
  const header = (records[0] ?? []).map((cell) => cell.toLowerCase());
  const known = new Set<string>([
    ...PRODUCT_IMPORT_COLUMNS,
    ...lookups.fields.map((field) => `${CUSTOM_FIELD_COLUMN_PREFIX}${field.key}`),
  ]);
  const errors: ProductImportError[] = [];
  for (const column of header) {
    if (column !== '' && !known.has(column)) {
      errors.push({ row: 1, column, code: 'import_column_unknown', params: { column } });
    }
  }
  for (const column of PRODUCT_IMPORT_REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      errors.push({ row: 1, column, code: 'import_column_missing', params: { column } });
    }
  }
  if (errors.length > 0) return { products: [], errors, rowCount: 0 };

  // Row numbers as a spreadsheet shows them: the header is row 1, so record i is row i + 1.
  // A row of empty cells (Excel writes a few at the end) is skipped, keeping the numbers.
  const rows = records.slice(1).flatMap((record, index) => {
    if (record.every((cell) => cell === '')) return [];
    const cells: Cells = {};
    header.forEach((column, position) => {
      if (column !== '') cells[column] = record[position] ?? '';
    });
    return [{ row: index + 2, cells }];
  });
  if (rows.length === 0) return { products: [], errors: [fileError('import_empty')], rowCount: 0 };
  if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
    return {
      products: [],
      errors: [fileError('import_too_many_rows', { max: PRODUCT_IMPORT_MAX_ROWS })],
      rowCount: rows.length,
    };
  }

  // --- Rows → products: the same code = the same product ------------------------------------------
  const groups = new Map<string, { row: number; cells: Cells }[]>();
  for (const row of rows) {
    const code = row.cells.code ?? '';
    if (code === '') {
      if (OPTION_COLUMNS.some((k) => (row.cells[`option${String(k)}_value`] ?? '') !== '')) {
        errors.push({ row: row.row, column: 'code', code: 'import_options_without_code' });
        continue;
      }
      groups.set(`#${String(row.row)}`, [row]);
      continue;
    }
    const key = code.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const unitByCode = new Map(lookups.units.map((unit) => [unit.code.toLowerCase(), unit.id]));
  const products: ImportedProduct[] = [];
  for (const group of groups.values()) {
    const built = buildProduct(group, lookups, unitByCode);
    errors.push(...built.errors);
    if (built.product) products.push(built.product);
  }
  return { products, errors, rowCount: rows.length };
}

function buildProduct(
  group: readonly { row: number; cells: Cells }[],
  lookups: ImportLookups,
  unitByCode: ReadonlyMap<string, string>,
): { product: ImportedProduct | null; errors: ProductImportError[] } {
  const errors: ProductImportError[] = [];
  const [first, ...rest] = group;
  if (!first) return { product: null, errors };
  const cell = (column: string) => first.cells[column] ?? '';
  const error = (column: string, code: ErrorCode, params?: Record<string, string | number>) => {
    errors.push({ row: first.row, column, code, ...(params && { params }) });
  };

  // The product's own cells: the later rows leave them empty or repeat them
  for (const row of rest) {
    for (const column of PRODUCT_COLUMNS) {
      const value = row.cells[column] ?? '';
      if (value !== '' && value !== cell(column)) {
        errors.push({ row: row.row, column, code: 'import_row_conflict' });
      }
    }
  }

  // A word from a fixed list; '' = the default
  const pick = <T extends string>(column: string, allowed: readonly T[], fallback: T): T => {
    const value = cell(column).toLowerCase();
    if (value === '') return fallback;
    const found = allowed.find((option) => option === value);
    if (found === undefined) error(column, 'import_value_invalid', { allowed: allowed.join(', ') });
    return found ?? fallback;
  };
  const yesNo = (column: string, value: string, fallback: boolean): boolean => {
    const word = value.toLowerCase();
    if (word === '') return fallback;
    if (YES.has(word)) return true;
    if (NO.has(word)) return false;
    error(column, 'import_value_invalid', { allowed: 'yes, no' });
    return fallback;
  };
  // A unit code → its id; '' = none. An unknown code is reported, and the field left empty so the
  // contract does not add a second error for the same cell.
  const unitId = (column: string): string => {
    const code = cell(column);
    if (code === '') return '';
    const id = unitByCode.get(code.toLowerCase());
    if (id === undefined) error(column, 'import_unit_unknown', { value: code });
    return id ?? '';
  };

  const type = pick('type', ['goods', 'service'] as const, 'goods');
  const tracking = pick(
    'tracking',
    ['none', 'batch', 'serial'] as const,
    type === 'service' ? 'none' : lookups.defaultTracking.tracking,
  );
  const hasExpiry = yesNo(
    'expiry',
    cell('expiry'),
    tracking === 'batch' && cell('tracking') === '' ? lookups.defaultTracking.hasExpiry : false,
  );

  // Options: a name in the first row, a value in every row; the values in the order they come
  const options = OPTION_COLUMNS.flatMap((k) => {
    const values = [
      ...new Set(
        group.map((row) => row.cells[`option${String(k)}_value`] ?? '').filter((v) => v !== ''),
      ),
    ];
    const name = cell(`option${String(k)}_name`);
    if (values.length === 0 && name === '') return [];
    return [{ k, name, values }];
  });

  const units = PACK_COLUMNS.flatMap((k) => {
    const prefix = `pack${String(k)}_`;
    const used = ['unit', 'factor', 'barcode'].some((part) => cell(`${prefix}${part}`) !== '');
    if (!used) return [];
    return [
      {
        unitId: unitId(`${prefix}unit`),
        factor: cell(`${prefix}factor`),
        barcode: cell(`${prefix}barcode`),
      },
    ];
  });

  const customFields: Record<string, string | boolean> = {};
  for (const field of lookups.fields) {
    const column = `${CUSTOM_FIELD_COLUMN_PREFIX}${field.key}`;
    const value = cell(column);
    if (field.type === 'boolean') {
      if (value !== '') customFields[field.key] = yesNo(column, value, false);
    } else {
      customFields[field.key] = value;
    }
  }

  const category = cell('category');
  const categoryPath =
    category === '' ? null : category.split(CATEGORY_PATH_SEPARATOR).map((part) => part.trim());
  if (categoryPath?.some((part) => part === '' || part.length > 80)) {
    error('category', 'import_category_invalid');
  }

  const raw = {
    code: cell('code'),
    name: cell('name'),
    type,
    categoryId: '',
    description: cell('description'),
    baseUnitId: unitId('unit'),
    salesUnitId: unitId('sales_unit'),
    purchaseUnitId: unitId('purchase_unit'),
    tracking,
    hasExpiry,
    options: options.map(({ name, values }) => ({ name, values })),
    variants: group.map((row) => ({
      id: null,
      sku: row.cells.sku ?? '',
      optionValues: options.map(({ k }) => row.cells[`option${String(k)}_value`] ?? ''),
      barcode: row.cells.barcode ?? '',
      salePrice: row.cells.sale_price ?? '',
      archived: false,
    })),
    units,
    customFields,
  };

  // The same contract as the form. A cell already reported above (an unknown unit) is empty now,
  // so the contract's "required" for it would say the same thing twice: skipped.
  const parsed = productInputSchema.safeParse(raw, { error: contractErrorMap });
  const rows = group.map((row) => row.row);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = columnOf(
        issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        rows,
      );
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      if (errors.some((seen) => seen.row === where.row && seen.column === where.column)) continue;
      errors.push({ row: where.row, column: where.column, code });
    }
  }
  // The workspace's own fields too (the contract only sees "some values"), so a row with a wrong
  // unit also says its missing Generic name — every problem of the file in one go, not one per try
  const fields = customFieldsInputSchema(lookups.fields).safeParse(customFields);
  if (!fields.success) {
    for (const issue of fields.error.issues) {
      const key = issue.path[0];
      const column = typeof key === 'string' ? `${CUSTOM_FIELD_COLUMN_PREFIX}${key}` : null;
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      if (errors.some((seen) => seen.row === first.row && seen.column === column)) continue;
      errors.push({ row: first.row, column, code });
    }
  }
  if (errors.length > 0 || !parsed.success) return { product: null, errors };
  return { product: { input: parsed.data, rows, categoryPath }, errors };
}
```

Pure: bytes and lookups in, product inputs or problems out. Every rule is tested without a database (12.5).

- **`decode()` refuses anything that is not UTF-8** (`fatal: true`). Excel's plain "CSV" on Windows is Windows-1252,
  and a Bangla name would come out as question marks. Refusing the file with "save it as CSV UTF-8" is better than
  importing broken names.
- **`csv-parse` options**: `bom` drops Excel's byte order mark; `relax_column_count` accepts short rows (Excel leaves
  out trailing empty cells); `trim` drops spaces around cells. An unclosed quote is a `CsvError`, reported as
  `import_csv_malformed`.
- **The header is checked before any row**: an unknown column (a typo like "colour", or a custom field that is
  archived) and a missing required column stop the import at once — every row would be wrong otherwise.
- **Row numbers are the spreadsheet's**: the header is row 1, so record `i` is row `i + 2`. Rows that are all empty
  (Excel writes a few at the end) are skipped without changing the numbers.
- **Grouping**: rows with the same code (in any case) are one product; a row without a code is a product of its own.
  A row without a code but with option values is refused: nothing would say which product it belongs to.
- **`PRODUCT_COLUMNS` and `import_row_conflict`**: a product's own cells (name, unit, packs, tracking…) are read from
  its first row. A later row may leave them empty or repeat them; anything else is refused, because the person meant
  something the import would silently ignore.
- **`pick()` and `yesNo()`** read the few fixed words (goods/service, none/batch/serial, yes/no) in any case, and name
  the allowed words in the error.
- **A blank tracking cell takes the business type's default**, like the form (`trackingDefault()`).
- **`unitId()` reports an unknown unit code itself, then leaves the field empty.** The contract would otherwise add
  "pick a unit" for the same cell; the `seen` check below drops any second problem on a cell already reported.
- **The category stays a path** ("Fabrics > Knit") until the handler finds or makes it.
- **The same contract as the form**: the built input goes through `productInputSchema`, and every problem's path goes
  through `columnOf()` to a row and a column.
- **The custom fields are checked here too**, with `customFieldsInputSchema()`. Without it, a row with a wrong unit
  would hide its missing Generic name until the unit was fixed — one problem per try instead of all of them at once.
  (Found by the integration test; see "What we found on the way".)

### Imports: the worker's half

**File: `apps/api/src/products/import.handler.ts`** (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  isIndustry,
  PRODUCT_IMPORT_MAX_ERRORS,
  type ProductImportError,
  todayIn,
  trackingDefault,
} from '@omnivo/contracts';
import { productCategories, productImports, tenantSettings, tenants } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { StorageService } from '../storage/storage.service.js';
import { lockCategoryTree } from './product-categories.service.js';
import { columnOf, type ImportedProduct, readProductsCsv } from './import/csv.js';
import {
  checkProduct,
  findTaken,
  insertProducts,
  loadProductContext,
  type PreparedProduct,
  type ProductIssue,
  resolveSkus,
  takenIssues,
} from './product-write.js';

type ImportRow = typeof productImports.$inferSelect;

// Thrown inside the savepoint when the file is wrong: everything the savepoint did (new
// categories, product codes taken from the series) is undone, and the errors are recorded outside it
class RejectedFile extends Error {
  constructor(readonly errors: ProductImportError[]) {
    super('The file has errors');
  }
}

// A product's problem on its CSV cell. The path is the contract's ("units.0.factor").
function fileErrorOf(issue: ProductIssue, product: ImportedProduct): ProductImportError {
  const path = issue.path.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { ...columnOf(path, product.rows), code: issue.code };
}

// The order a person fixes a file in: top to bottom, the whole-file problems first
function inFileOrder(errors: readonly ProductImportError[]): ProductImportError[] {
  return errors.toSorted((a, b) => (a.row ?? 0) - (b.row ?? 0));
}

// Reads a product CSV and creates its products: all of them, or none (you chose this). Idempotent
// like every handler: only a 'queued' import is worked on, under a row lock, and the status moves
// on in the same transaction as the products — a second run finds 'done' or 'failed' and stops.
@Injectable()
export class ProductImportHandler implements EventHandler<'product.import_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
    private readonly numbering: NumberingService,
  ) {}

  async handle(event: OutboxEvent<'product.import_requested'>): Promise<void> {
    const tenantId = getTenantId();
    // 1) The file first, outside any transaction: no transaction waits on the network
    const row = await this.withTenant((tx) => this.find(tx, event.payload.importId, false));
    if (!row) throw new PermanentJobError('The import no longer exists');
    if (row.status !== 'queued') return;
    const bytes = await this.storage.get(row.storageKey);
    if (bytes === null) throw new PermanentJobError('The uploaded file is gone');

    // 2) One transaction: check the whole file, then write all of it or record why not
    await this.withTenant(async (tx) => {
      const locked = await this.find(tx, row.id, true);
      if (locked?.status !== 'queued') return;
      const context = await loadProductContext(tx);
      const [tenant] = await tx
        .select({ industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const industry =
        tenant?.industry !== null && tenant?.industry !== undefined && isIndustry(tenant.industry)
          ? tenant.industry
          : null;
      const file = readProductsCsv(bytes, {
        // Only active units: a new product cannot start with an archived one
        units: [...context.units.values()].filter((unit) => unit.archivedAt === null),
        fields: context.fields,
        defaultTracking: trackingDefault(industry),
      });

      const errors = [...file.errors];
      const prepared = file.products.map((product) => {
        const checked = checkProduct(product.input, context);
        errors.push(...checked.issues.map((issue) => fileErrorOf(issue, product)));
        return { product, customFields: checked.customFields };
      });

      let productCount = 0;
      if (errors.length === 0) {
        try {
          productCount = await tx.transaction((inner) => this.write(inner, locked, prepared));
        } catch (error) {
          if (!(error instanceof RejectedFile)) throw error;
          errors.push(...error.errors);
        }
      }

      const finishedAt = new Date();
      if (errors.length > 0) {
        await tx
          .update(productImports)
          .set({
            status: 'failed',
            rowCount: file.rowCount,
            errorCount: errors.length,
            errors: inFileOrder(errors).slice(0, PRODUCT_IMPORT_MAX_ERRORS),
            finishedAt,
          })
          .where(eq(productImports.id, locked.id));
        await notify(tx, {
          userId: locked.requestedBy,
          type: 'import.failed',
          params: { file: locked.fileName, count: errors.length },
          eventId: event.id,
        });
        return;
      }
      await tx
        .update(productImports)
        .set({ status: 'done', rowCount: file.rowCount, productCount, finishedAt })
        .where(eq(productImports.id, locked.id));
      // The person who uploaded it did it; the worker only carried it out
      await audit(tx, {
        action: 'product.imported',
        entityType: 'product_import',
        entityId: locked.id,
        actorUserId: locked.requestedBy,
        changes: created({ file: locked.fileName, products: productCount }),
      });
      await notify(tx, {
        userId: locked.requestedBy,
        type: 'import.done',
        params: { file: locked.fileName, count: productCount },
        eventId: event.id,
      });
    });
  }

  // After the last attempt (the file vanished, the database was down for every retry): the import
  // is failed and its owner hears it, instead of a spinner that never stops
  async onGiveUp(event: OutboxEvent<'product.import_requested'>): Promise<void> {
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(productImports)
        .set({
          status: 'failed',
          errorCount: 1,
          errors: [{ row: null, column: null, code: 'internal_error' }],
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(productImports.tenantId, getTenantId()),
            eq(productImports.id, event.payload.importId),
            eq(productImports.status, 'queued'),
          ),
        )
        .returning();
      if (!failed) return;
      await notify(tx, {
        userId: failed.requestedBy,
        type: 'import.failed',
        params: { file: failed.fileName, count: 1 },
        eventId: event.id,
      });
    });
  }

  // Inside the savepoint: categories, codes, the checks that need them, and the products
  private async write(
    tx: Transaction,
    row: ImportRow,
    checked: readonly {
      product: ImportedProduct;
      customFields: Record<string, string | boolean>;
    }[],
  ): Promise<number> {
    const categoryIds = await this.categories(
      tx,
      checked.flatMap(({ product }) => (product.categoryPath ? [product.categoryPath] : [])),
    );
    const codes = await this.codes(
      tx,
      checked.filter(({ product }) => product.input.code === null).length,
    );
    let nextCode = 0;
    const prepared: (PreparedProduct & { product: ImportedProduct })[] = checked.map(
      ({ product, customFields }) => {
        const code = product.input.code ?? codes[nextCode++] ?? '';
        const input = {
          ...product.input,
          categoryId: product.categoryPath
            ? (categoryIds.get(pathKey(product.categoryPath)) ?? null)
            : null,
        };
        return { product, input, code, skus: resolveSkus(input, code), customFields };
      },
    );

    // Taken by products already in the workspace, or twice in this file
    const errors: ProductImportError[] = [];
    const taken = await findTaken(tx, {
      codes: prepared.flatMap(({ product, code }) => (product.input.code === null ? [] : [code])),
      skus: prepared.flatMap(({ skus }) => skus),
      barcodes: prepared.flatMap(({ input }) => [
        ...input.variants.flatMap((variant) => (variant.barcode === null ? [] : [variant.barcode])),
        ...input.units.flatMap((pack) => (pack.barcode === null ? [] : [pack.barcode])),
      ]),
    });
    const seenSkus = new Set<string>();
    const seenBarcodes = new Set<string>();
    for (const { product, input, code, skus } of prepared) {
      const issues = takenIssues(input, code, skus, taken);
      skus.forEach((sku, index) => {
        if (seenSkus.has(sku.toLowerCase())) {
          issues.push({ path: `variants.${String(index)}.sku`, code: 'product_sku_taken' });
        }
        seenSkus.add(sku.toLowerCase());
      });
      input.variants.forEach((variant, index) => {
        if (variant.barcode === null) return;
        if (seenBarcodes.has(variant.barcode)) {
          issues.push({ path: `variants.${String(index)}.barcode`, code: 'barcode_taken' });
        }
        seenBarcodes.add(variant.barcode);
      });
      input.units.forEach((pack, index) => {
        if (pack.barcode === null) return;
        if (seenBarcodes.has(pack.barcode)) {
          issues.push({ path: `units.${String(index)}.barcode`, code: 'barcode_taken' });
        }
        seenBarcodes.add(pack.barcode);
      });
      errors.push(...issues.map((issue) => fileErrorOf(issue, product)));
    }
    if (errors.length > 0) throw new RejectedFile(errors);

    const ids = await insertProducts(tx, prepared, row.requestedBy);
    return ids.length;
  }

  // Every category path of the file → its id, making the ones that do not exist yet. Names match
  // in any case, like the unique index ("knit" is the Knit that is already there).
  private async categories(
    tx: Transaction,
    paths: readonly string[][],
  ): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    const result = new Map<string, string>();
    if (paths.length === 0) return result;
    // The categories page's lock: no move or delete runs while the import adds to the tree
    await lockCategoryTree(tx);
    const existing = await tx
      .select({
        id: productCategories.id,
        parentId: productCategories.parentId,
        name: productCategories.name,
      })
      .from(productCategories)
      .where(eq(productCategories.tenantId, tenantId));
    const byPlace = new Map(
      existing.map((category) => [
        `${category.parentId ?? ''}/${category.name.toLowerCase()}`,
        category.id,
      ]),
    );
    // One step down the path: the category of this name under parentId, made if missing
    const step = async (parentId: string | null, name: string): Promise<string> => {
      const place = `${parentId ?? ''}/${name.toLowerCase()}`;
      const found = byPlace.get(place);
      if (found !== undefined) return found;
      const [made] = await tx
        .insert(productCategories)
        .values({ tenantId, parentId, name })
        .returning({ id: productCategories.id });
      if (!made) throw new Error('Category insert returned no row');
      byPlace.set(place, made.id);
      return made.id;
    };
    for (const path of paths) {
      if (result.has(pathKey(path))) continue;
      let parentId: string | null = null;
      for (const name of path) parentId = await step(parentId, name);
      if (parentId !== null) result.set(pathKey(path), parentId);
    }
    return result;
  }

  // `count` codes from the series, skipping any a product already has (typed by hand earlier)
  private async codes(tx: Transaction, count: number): Promise<string[]> {
    if (count === 0) return [];
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');
    const codes: string[] = [];
    while (codes.length < count) {
      const batch = await this.numbering.nextMany(
        tx,
        'inventory.product',
        today,
        count - codes.length,
      );
      const taken = await findTaken(tx, { codes: batch, skus: [], barcodes: [] });
      codes.push(...batch.filter((code) => !taken.codes.has(code.toLowerCase())));
    }
    return codes;
  }

  private async find(tx: Transaction, id: string, forUpdate: boolean) {
    const query = tx
      .select()
      .from(productImports)
      .where(and(eq(productImports.tenantId, getTenantId()), eq(productImports.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }
}

function pathKey(path: readonly string[]): string {
  return path.map((part) => part.toLowerCase()).join('\u0000');
}
```

- **The file is read before any transaction**, so no transaction waits on the network. A file that is gone is a
  `PermanentJobError`: retrying cannot bring it back, and `onGiveUp()` tells the person.
- **The row is locked and its status checked again inside the transaction**: two runs of the same job (a retry after a
  crash) take turns, and the second finds `done` or `failed` and stops.
- **Only active units** are offered to the CSV: a new product cannot start with an archived unit.
- **`checkProduct()` runs on every product before anything is written**, so all the problems of the file are found
  in one pass.
- **The write happens in a savepoint** (`tx.transaction(…)` inside a transaction is a `SAVEPOINT` in drizzle). The
  savepoint makes the categories, takes the codes, runs the checks that need them (codes, SKUs and barcodes taken in
  the workspace or twice in the file), and inserts. If a check fails, it throws `RejectedFile`; the savepoint is rolled
  back — the new categories and the taken code numbers with it — and the outer transaction records the failure. Without
  the savepoint, the failure record would either be rolled back too, or the categories would stay (the break-it check
  in the header proved the second).
- **The failure is recorded with the first 100 problems in file order**, and the bell says how many there were.
- **`actorUserId: locked.requestedBy`** in the audit row: the person who uploaded the file did it; the worker only
  carried it out.
- **`categories()`** takes the category tree lock, reads the tree once, and walks each path, making what is missing.
  Names match in any case, like the unique index. A path seen twice in the file is found once.
- **`codes()`** takes `count` codes with `nextMany()` and skips any a product already has, asking again for the rest
  until it has enough.

### Wiring

**File: `apps/api/src/products/products.module.ts`** (new)

```ts
import { Module } from '@nestjs/common';

import { NumberingModule } from '../numbering/numbering.module.js';
import { ProductCategoriesController } from './product-categories.controller.js';
import { ProductCategoriesService } from './product-categories.service.js';
import { ProductImportsService } from './product-imports.service.js';
import { ProductImportsController, ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { UnitsController } from './units.controller.js';
import { UnitsService } from './units.service.js';

// Products, their units and categories, and CSV imports (step 12). NumberingModule gives the
// product codes (P-00042). The import's worker half (import.handler.ts) is wired in
// worker/worker.module.ts, like every handler.
@Module({
  imports: [NumberingModule],
  controllers: [
    UnitsController,
    ProductCategoriesController,
    ProductsController,
    ProductImportsController,
  ],
  providers: [UnitsService, ProductCategoriesService, ProductsService, ProductImportsService],
})
export class ProductsModule {}
```

**File: `apps/api/src/app.module.ts`** (change)

```diff
@@ -13,6 +13,7 @@ import { AuthGuard } from './auth/auth.guard.js';
 import { AuthMiddleware } from './auth/auth.middleware.js';
 import { AuthModule } from './auth/auth.module.js';
 import { BranchesModule } from './branches/branches.module.js';
+import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
 import { ContractInterceptor } from './common/http/contract.interceptor.js';
 import { ProblemFilter } from './common/http/problem.filter.js';
 import { RequestContextMiddleware } from './common/request/request-context.js';
@@ -26,6 +27,7 @@ import { MembersModule } from './members/members.module.js';
 import { NotificationsModule } from './notifications/notifications.module.js';
 import { NumberingModule } from './numbering/numbering.module.js';
 import { PermissionGuard } from './rbac/permission.guard.js';
+import { ProductsModule } from './products/products.module.js';
 import { RbacModule } from './rbac/rbac.module.js';
 import { ReportsModule } from './reports/reports.module.js';
 import { RolesModule } from './roles/roles.module.js';
@@ -55,6 +57,8 @@ export class AppModule implements NestModule {
         AccountsModule,
         JournalModule,
         ReportsModule,
+        CustomFieldsModule,
+        ProductsModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

**File: `apps/api/src/worker/handlers.ts`** (change)

```diff
@@ -4,7 +4,9 @@ import type { OutboxEventType } from '@omnivo/db';
 import type { EventHandler } from '../common/outbox/outbox.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
+import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
+import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
@@ -26,6 +28,8 @@ export class EventHandlers {
     memberJoined: MemberJoinedHandler,
     chart: ChartHandler,
     reportExport: ReportExportHandler,
+    catalog: CatalogHandler,
+    productImport: ProductImportHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -34,6 +38,8 @@ export class EventHandlers {
       'member.joined': memberJoined,
       'workspace.chart_requested': chart,
       'report.export_requested': reportExport,
+      'workspace.catalog_requested': catalog,
+      'product.import_requested': productImport,
     };
   }
 
```

The mapped type `{ [T in OutboxEventType]: EventHandler<T> }` would not compile until both new events have a handler.

**File: `apps/api/src/worker/worker.module.ts`** (change)

```diff
@@ -7,7 +7,10 @@ import { CONFIG, DB, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/toke
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
+import { NumberingService } from '../numbering/numbering.service.js';
+import { ProductImportHandler } from '../products/import.handler.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
+import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
@@ -51,6 +54,10 @@ export class WorkerModule implements OnApplicationShutdown {
         MemberJoinedHandler,
         ChartHandler,
         ReportExportHandler,
+        CatalogHandler,
+        // The import gives new products their codes, like the API does
+        NumberingService,
+        ProductImportHandler,
       ],
     };
   }
```

The import handler takes product codes from `NumberingService`, so the worker gets it as a provider of its own — the
worker does not import the API's modules (step 8).

**File: `apps/api/package.json`** (change)

```diff
@@ -39,6 +39,7 @@
     "@omnivo/contracts": "workspace:*",
     "@omnivo/db": "workspace:*",
     "bullmq": "^6.3.9",
+    "csv-parse": "^7.0.3",
     "dotenv": "^18.0.3",
     "drizzle-orm": "^0.45.3",
     "fastify": "5.12.5",
```

```bash
pnpm install
```

`csv-parse` has no dependencies of its own, and `pnpm audit` shows no new advisory (the one moderate advisory it lists,
an old `esbuild` under `drizzle-kit`, was there before this step).

---

## 12.5 — The API's tests

**File: `apps/api/src/products/import/csv.spec.ts`** (new)

```ts
import { describe, expect, it } from 'vitest';

import { type ImportLookups, readProductsCsv } from './csv.js';

const pcs = '01939d1c-0000-7000-8000-000000000001';
const box = '01939d1c-0000-7000-8000-000000000002';
const strip = '01939d1c-0000-7000-8000-000000000003';

const lookups: ImportLookups = {
  units: [
    { id: pcs, code: 'pcs' },
    { id: box, code: 'box' },
    { id: strip, code: 'Strip' },
  ],
  fields: [
    { key: 'generic_name', type: 'text', options: [], required: false },
    { key: 'cold_chain', type: 'boolean', options: [], required: false },
  ],
  defaultTracking: { tracking: 'batch', hasExpiry: true },
};

function read(text: string, extra: Partial<ImportLookups> = {}) {
  return readProductsCsv(new TextEncoder().encode(text), { ...lookups, ...extra });
}

describe('reading a product CSV', () => {
  it('makes a simple product per row without a code, with packs and custom fields', () => {
    const file = read(
      [
        'name,unit,sale_price,pack1_unit,pack1_factor,pack2_unit,pack2_factor,sales_unit,cf_generic_name,cf_cold_chain',
        'Napa 500 mg,pcs,1.20,strip,10,box,100,strip,Paracetamol,no',
        'Seclo 20 mg,pcs,7,box,30,,,,Omeprazole,',
      ].join('\n'),
    );
    expect(file.errors).toEqual([]);
    expect(file.rowCount).toBe(2);
    const [napa, seclo] = file.products;
    expect(napa?.input).toMatchObject({
      code: null,
      name: 'Napa 500 mg',
      baseUnitId: pcs,
      salesUnitId: strip,
      // A blank tracking cell takes the business type's default, like the form
      tracking: 'batch',
      hasExpiry: true,
      units: [
        { unitId: strip, factor: '10', barcode: null },
        { unitId: box, factor: '100', barcode: null },
      ],
      customFields: { generic_name: 'Paracetamol', cold_chain: false },
    });
    expect(napa?.input.variants).toMatchObject([{ optionValues: [], salePrice: '1.20' }]);
    expect(seclo?.rows).toEqual([3]);
  });

  it('turns rows with one code into the variants of one product', () => {
    const file = read(
      [
        'code,name,unit,option1_name,option1_value,option2_name,option2_value,sale_price,tracking',
        'ST-118,Polo shirt,pcs,Size,M,Colour,Navy,650,none',
        'ST-118,,,,L,,Navy,650,',
        'ST-118,,,,M,,White,,',
      ].join('\n'),
    );
    expect(file.errors).toEqual([]);
    expect(file.products).toHaveLength(1);
    expect(file.products[0]?.input.options).toEqual([
      { name: 'Size', values: ['M', 'L'] },
      { name: 'Colour', values: ['Navy', 'White'] },
    ]);
    expect(file.products[0]?.input.variants.map((variant) => variant.optionValues)).toEqual([
      ['M', 'Navy'],
      ['L', 'Navy'],
      ['M', 'White'],
    ]);
    expect(file.products[0]?.rows).toEqual([2, 3, 4]);
  });

  it('points at the row and column of every problem, as a spreadsheet numbers them', () => {
    const file = read(
      [
        'name,unit,sale_price,pack1_unit,pack1_factor,type',
        'Napa 500 mg,tablet,1.20,,,',
        'Ace syrup,pcs,abc,box,0,',
        'X,pcs,,,,gadget',
      ].join('\n'),
    );
    expect(file.products).toEqual([]);
    expect(file.errors).toEqual([
      { row: 2, column: 'unit', code: 'import_unit_unknown', params: { value: 'tablet' } },
      { row: 3, column: 'sale_price', code: 'money_format' },
      { row: 3, column: 'pack1_factor', code: 'factor_format' },
      {
        row: 4,
        column: 'type',
        code: 'import_value_invalid',
        params: { allowed: 'goods, service' },
      },
      { row: 4, column: 'name', code: 'product_name_required' },
    ]);
  });

  it('refuses a later row that says something else about the product', () => {
    const file = read(
      [
        'code,name,unit,option1_name,option1_value',
        'ST-118,Polo shirt,pcs,Size,M',
        'ST-118,Polo shirt (new),pcs,,L',
      ].join('\n'),
    );
    expect(file.errors).toEqual([{ row: 3, column: 'name', code: 'import_row_conflict' }]);
  });

  it('needs a code to put variants together', () => {
    const file = read(['name,unit,option1_name,option1_value', 'Polo,pcs,Size,M'].join('\n'));
    expect(file.errors).toEqual([{ row: 2, column: 'code', code: 'import_options_without_code' }]);
  });

  it('checks the header before any row', () => {
    expect(read('name,colour\nPolo,Navy').errors).toEqual([
      { row: 1, column: 'colour', code: 'import_column_unknown', params: { column: 'colour' } },
      { row: 1, column: 'unit', code: 'import_column_missing', params: { column: 'unit' } },
    ]);
    // A custom field the workspace does not have (or has archived) is an unknown column too
    expect(read('name,unit,cf_gsm\nPolo,pcs,180').errors[0]?.code).toBe('import_column_unknown');
  });

  it('reads Excel’s CSV UTF-8 (with a BOM, Bangla, quotes) and refuses other encodings', () => {
    const file = read(
      '\uFEFFname,unit,description\n"নাপা ৫০০, ট্যাবলেট",pcs,"Says ""fever"""\n,,\n',
    );
    expect(file.errors).toEqual([]);
    expect(file.products[0]?.input).toMatchObject({
      name: 'নাপা ৫০০, ট্যাবলেট',
      description: 'Says "fever"',
    });
    // Windows-1252 "CSV": the é is one byte, 0xE9, which is not UTF-8
    const latin = readProductsCsv(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xe9]), lookups);
    expect(latin.errors).toEqual([{ row: null, column: null, code: 'import_encoding' }]);
    expect(read('name,unit\n"Napa,pcs').errors[0]?.code).toBe('import_csv_malformed');
    expect(read('name,unit\n').errors[0]?.code).toBe('import_empty');
  });

  it('keeps a category as a path to find or make later', () => {
    const file = read(
      'name,unit,category\nPolo,pcs,Finished garments > Polo shirts\nTee,pcs,A >> B',
    );
    expect(file.products[0]?.categoryPath).toEqual(['Finished garments', 'Polo shirts']);
    expect(file.errors).toEqual([{ row: 3, column: 'category', code: 'import_category_invalid' }]);
  });
});
```

The CSV rules without a database or a worker: a pharma file with packs and custom fields, a variant product spread
over three rows, the row and column of each kind of problem, a later row that contradicts the first, a header with an
unknown or a missing column, and Excel's own quirks — a byte order mark, Bangla text, a comma inside quotes, doubled
quotes, a trailing empty row, and a Windows-1252 file (the `0xE9` byte is "é" in Windows-1252 and not valid UTF-8 on
its own).

**File: `apps/api/src/setup/templates.spec.ts`** (change)

```diff
@@ -2,11 +2,13 @@ import {
   ACCOUNT_PURPOSES,
   ACCOUNT_TYPES,
   createAccountInputSchema,
+  createCustomFieldInputSchema,
+  createUnitInputSchema,
   INDUSTRIES,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
-import { type AccountTemplate, INDUSTRY_TEMPLATES } from './templates.js';
+import { type AccountTemplate, type CategoryTemplate, INDUSTRY_TEMPLATES } from './templates.js';
 
 function flatten(node: AccountTemplate): AccountTemplate[] {
   return [node, ...(node.children ?? []).flatMap(flatten)];
@@ -43,3 +45,50 @@ describe.each(INDUSTRIES)('the %s chart', (industry) => {
     });
   });
 });
+
+function names(nodes: readonly CategoryTemplate[]): string[][] {
+  return [
+    nodes.map((node) => node.name.toLowerCase()),
+    ...nodes.flatMap((node) => names(node.children ?? [])),
+  ];
+}
+
+// The same reason as the charts: a mistake here would surface only in the worker, at a real
+// workspace's setup. These are what the API itself would refuse.
+describe.each(INDUSTRIES)('the %s catalog', (industry) => {
+  const catalog = INDUSTRY_TEMPLATES[industry].catalog;
+
+  it('has units the API accepts, each code once, with pieces and kilograms', () => {
+    for (const unit of catalog.units) {
+      expect(
+        createUnitInputSchema.safeParse({ ...unit, ratio: unit.ratio ?? '' }).success,
+        unit.code,
+      ).toBe(true);
+    }
+    const codes = catalog.units.map((unit) => unit.code.toLowerCase());
+    expect(new Set(codes).size).toBe(codes.length);
+    expect(codes).toEqual(expect.arrayContaining(['pcs', 'kg']));
+  });
+
+  it('names sibling categories once', () => {
+    for (const siblings of names(catalog.categories)) {
+      expect(new Set(siblings).size, siblings.join(', ')).toBe(siblings.length);
+    }
+  });
+
+  it('has custom fields the API accepts, each key once', () => {
+    for (const field of catalog.customFields) {
+      expect(
+        createCustomFieldInputSchema.safeParse({
+          entity: 'product',
+          options: [],
+          required: false,
+          ...field,
+        }).success,
+        field.key,
+      ).toBe(true);
+    }
+    const keys = catalog.customFields.map((field) => field.key);
+    expect(new Set(keys).size).toBe(keys.length);
+  });
+});
```

The catalog is data typed by hand, like the charts: a mistake would surface only in the worker, at a real company's
setup. These checks run each unit and custom field through the API's own input schemas, and look for a code, a key
or a sibling category name used twice.

**File: `apps/api/src/testing/chart.ts`** (change)

```diff
@@ -1,6 +1,11 @@
 import { ACCOUNT_TYPES } from '@omnivo/contracts';
 
-import type { AccountTemplate, ChartTemplate } from '../setup/templates.js';
+import type {
+  AccountTemplate,
+  CatalogTemplate,
+  CategoryTemplate,
+  ChartTemplate,
+} from '../setup/templates.js';
 
 function count(node: AccountTemplate): number {
   return 1 + (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
@@ -11,3 +16,16 @@ function count(node: AccountTemplate): number {
 export function accountCount(chart: ChartTemplate): number {
   return ACCOUNT_TYPES.reduce((sum, type) => sum + count(chart[type]), 0);
 }
+
+function countCategories(nodes: readonly CategoryTemplate[]): number {
+  return nodes.reduce((sum, node) => sum + 1 + countCategories(node.children ?? []), 0);
+}
+
+// What seedCatalog() makes from a template, for the setup's audit row (step 12)
+export function catalogCount(catalog: CatalogTemplate) {
+  return {
+    units: catalog.units.length,
+    categories: countCategories(catalog.categories),
+    customFields: catalog.customFields.length,
+  };
+}
```

`catalogCount()` counts what `seedCatalog()` makes from a template, so the setup test compares with the template
instead of numbers typed by hand.

**File: `apps/api/src/products/products.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  customFieldDefinitionSchema,
  customFieldListSchema,
  type Product,
  productCategoryListSchema,
  productCategorySchema,
  type ProductFormValues,
  productPageSchema,
  productSchema,
  problemSchema,
  setupSchema,
  type Unit,
  unitListSchema,
  unitSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INDUSTRY_TEMPLATES } from '../setup/templates.js';
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

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Nasrin: a member of Farhana's workspace with no role at all
let viewer: SignedIn;
let units: Unit[];

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

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

async function categoryId(name: string): Promise<string> {
  const { items } = productCategoryListSchema.parse(
    (await send('GET', '/product-categories')).json(),
  );
  const found = items.find((category) => category.name === name);
  if (!found) throw new Error(`no category ${name}`);
  return found.id;
}

function variant(optionValues: string[] = [], extra: object = {}) {
  return { id: null, sku: '', optionValues, barcode: '', salePrice: '', archived: false, ...extra };
}

// What the product form sends for a simple product; each test changes a few fields
function simple(name: string, extra: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
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
    variants: [variant()],
    units: [],
    customFields: {},
    ...extra,
  };
}

// A form built from a saved product, as the edit page does
function formOf(product: Product): ProductFormValues & { version: number } {
  return {
    code: product.code,
    name: product.name,
    type: product.type === 'service' ? 'service' : 'goods',
    categoryId: product.categoryId ?? '',
    description: product.description ?? '',
    baseUnitId: product.baseUnitId,
    salesUnitId: product.salesUnitId ?? '',
    purchaseUnitId: product.purchaseUnitId ?? '',
    tracking: 'none',
    hasExpiry: product.hasExpiry,
    options: product.options,
    variants: product.variants.map((saved) => ({
      id: saved.id,
      sku: saved.sku,
      optionValues: saved.optionValues,
      barcode: saved.barcode ?? '',
      salePrice: saved.salePrice ?? '',
      archived: saved.archivedAt !== null,
    })),
    units: product.units.map((pack) => ({ ...pack, barcode: pack.barcode ?? '' })),
    customFields: {},
    version: product.version,
  };
}

async function created(body: object): Promise<Product> {
  const res = await send('POST', '/products', body);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  // The units, categories and custom fields come from the setup job: the real worker runs
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;

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
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the starting catalog', () => {
  it('comes with the setup job: the template’s units, categories and fields', async () => {
    const template = INDUSTRY_TEMPLATES.garments.catalog;
    expect(units.map((unit) => unit.code).sort()).toEqual(
      template.units.map((unit) => unit.code).sort(),
    );
    expect(units.find((unit) => unit.code === 'yard')).toMatchObject({
      dimension: 'length',
      ratio: '0.914400',
      decimals: 2,
    });
    expect(units.find((unit) => unit.code === 'box')?.ratio).toBeNull();
    const { items } = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    );
    const garments = items.find((category) => category.name === 'Finished garments');
    expect(
      items.filter((category) => category.parentId === garments?.id).map((c) => c.name),
    ).toEqual(expect.arrayContaining(['T-shirts', 'Polo shirts']));
    const fields = customFieldListSchema.parse(
      (await send('GET', '/custom-fields?entity=product')).json(),
    ).items;
    expect(fields.map((field) => field.key)).toEqual(['buyer', 'composition', 'gsm', 'season']);
  });

  it('reaches a workspace set up before this step, through the catalog job', async () => {
    // A workspace that was 'ready' before step 12: no units yet, and the event that migration
    // 0020 queues for it
    const old = await signUp(app, {
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
    });
    await superuserSql(async (sql) => {
      const [tenant] = await sql<{ id: string }[]>`
        UPDATE tenants SET setup_status = 'ready', industry = 'pharma'
         WHERE slug = 'karim-pharma' RETURNING id`;
      if (!tenant) throw new Error('no tenant');
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                VALUES (gen_random_uuid(), ${tenant.id}, 'workspace.catalog_requested', '{}')`;
    });
    await eventually(async () => {
      const list = unitListSchema.parse(
        (
          await app.inject({ method: 'GET', url: '/units', headers: bearer(old.accessToken) })
        ).json(),
      ).items;
      expect(list.map((unit) => unit.code)).toContain('strip');
    });
    const fields = customFieldListSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/custom-fields?entity=product',
          headers: bearer(old.accessToken),
        })
      ).json(),
    ).items;
    expect(fields.find((field) => field.key === 'generic_name')?.required).toBe(true);
  });
});

describe('units', () => {
  it('adds a unit; its code is taken in any case', async () => {
    const res = await send('POST', '/units', {
      code: 'Gz',
      name: 'Gauze roll',
      dimension: 'count',
      ratio: '',
      decimals: 0,
    });
    expect(res.statusCode).toBe(201);
    expect(unitSchema.parse(res.json())).toMatchObject({ code: 'Gz', ratio: null });
    const again = await send('POST', '/units', {
      code: 'gz',
      name: 'Gauze',
      dimension: 'count',
      ratio: '',
      decimals: 0,
    });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).fieldErrors).toEqual({ code: ['unit_code_taken'] });
  });

  it('keeps a unit a product uses; archiving hides it from new products only', async () => {
    const reel = unitSchema.parse(
      (
        await send('POST', '/units', {
          code: 'reel',
          name: 'Reel',
          dimension: 'count',
          ratio: '',
          decimals: 0,
        })
      ).json(),
    );
    units.push(reel);
    const thread = await created(
      simple('Sewing thread 40/2', { units: [{ unitId: reel.id, factor: '12', barcode: '' }] }),
    );
    const removed = await send('DELETE', `/units/${reel.id}?version=${String(reel.version)}`);
    expect(removed.statusCode).toBe(409);
    expect(problemOf(removed).code).toBe('unit_in_use');

    const archived = await send('POST', `/units/${reel.id}/archive`, { version: reel.version });
    expect(archived.statusCode).toBe(200);
    // The product that has it can still be saved…
    const kept = await send('PUT', `/products/${thread.id}`, formOf(thread));
    expect(kept.statusCode, kept.body).toBe(200);
    // …a new one cannot start with it
    const refused = await send(
      'POST',
      '/products',
      simple('Sewing thread 60/3', { units: [{ unitId: reel.id, factor: '12', barcode: '' }] }),
    );
    expect(refused.statusCode).toBe(400);
    expect(problemOf(refused).fieldErrors).toEqual({ 'units.0.unitId': ['product_unit_invalid'] });
  });
});

describe('categories', () => {
  it('keeps names unique among siblings, and a category out of its own branch', async () => {
    const fabrics = await categoryId('Fabrics');
    const twice = await send('POST', '/product-categories', { parentId: fabrics, name: 'knit' });
    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).fieldErrors).toEqual({ name: ['category_name_taken'] });
    // The same name elsewhere is fine
    expect(
      (await send('POST', '/product-categories', { parentId: '', name: 'Knit' })).statusCode,
    ).toBe(201);

    const knit = await categoryId('Fabrics');
    const { items } = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    );
    const child = items.find((category) => category.parentId === knit && category.name === 'Knit');
    const parent = items.find((category) => category.id === knit);
    if (!child || !parent) throw new Error('no Knit under Fabrics');
    const loop = await send('PUT', `/product-categories/${knit}`, {
      parentId: child.id,
      name: parent.name,
      version: parent.version,
    });
    expect(loop.statusCode).toBe(409);
    expect(problemOf(loop).code).toBe('category_parent_loop');
  });

  it('deletes only an empty category', async () => {
    const tees = await categoryId('T-shirts');
    await created(simple('Basic crew-neck T-shirt', { categoryId: tees }));
    const { items } = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    );
    const category = productCategorySchema.parse(items.find((item) => item.id === tees));
    expect(category.productCount).toBe(1);
    const inUse = await send(
      'DELETE',
      `/product-categories/${tees}?version=${String(category.version)}`,
    );
    expect(problemOf(inUse).code).toBe('category_in_use');
    const garments = items.find((item) => item.name === 'Finished garments');
    const withChildren = await send(
      'DELETE',
      `/product-categories/${garments?.id ?? ''}?version=${String(garments?.version ?? 1)}`,
    );
    expect(problemOf(withChildren).code).toBe('category_has_children');
  });
});

describe('a product', () => {
  it('gets the next code, and its one variant the same SKU', async () => {
    const shirt = await created(
      simple('Oxford shirt', {
        variants: [variant([], { salePrice: '1450', barcode: '8941100500118' })],
      }),
    );
    expect(shirt.code).toMatch(/^P-\d{5}$/);
    expect(shirt.variants).toMatchObject([
      { sku: shirt.code, salePrice: '1450.0000', barcode: '8941100500118', archivedAt: null },
    ]);
    // The barcode means this shirt in the whole workspace — a pack of another product too
    const clash = await send(
      'POST',
      '/products',
      simple('Oxford shirt box', {
        units: [{ unitId: unitId('box'), factor: '10', barcode: '8941100500118' }],
      }),
    );
    expect(clash.statusCode).toBe(409);
    expect(problemOf(clash).fieldErrors).toEqual({ 'units.0.barcode': ['barcode_taken'] });
  });

  it('makes a variant product, with SKUs from its code and options', async () => {
    const polo = await created(
      simple('Pique polo shirt', {
        code: 'ST-118',
        options: [
          { name: 'Size', values: ['M', 'L'] },
          { name: 'Colour', values: ['Navy blue', 'White'] },
        ],
        variants: [
          variant(['M', 'Navy blue'], { salePrice: '650' }),
          variant(['L', 'Navy blue'], { salePrice: '650' }),
          variant(['M', 'White'], { salePrice: '600', sku: 'ST-118-MW' }),
        ],
        units: [{ unitId: unitId('dozen'), factor: '12', barcode: '' }],
        purchaseUnitId: unitId('dozen'),
        customFields: { gsm: '220', buyer: 'H&M', composition: '', season: '' },
      }),
    );
    expect(polo.variants.map((v) => v.sku)).toEqual([
      'ST-118-M-NAVY-BLUE',
      'ST-118-L-NAVY-BLUE',
      'ST-118-MW',
    ]);
    expect(polo).toMatchObject({
      purchaseUnitId: unitId('dozen'),
      salesUnitId: null,
      customFields: { gsm: '220', buyer: 'H&M' },
    });
    // The code is taken in any case
    const again = await send('POST', '/products', simple('Polo copy', { code: 'st-118' }));
    expect(problemOf(again).fieldErrors).toEqual({ code: ['product_code_taken'] });
  });

  it('refuses a dozen of 10 pieces: standard units convert at their own rate', async () => {
    const res = await send(
      'POST',
      '/products',
      simple('Shirt buttons', { units: [{ unitId: unitId('dozen'), factor: '10', barcode: '' }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({ 'units.0.factor': ['product_factor_standard'] });
    // A yard of fabric sold by the metre: the rounded standard number
    const fabric = await created(
      simple('Single jersey 180 GSM', {
        baseUnitId: unitId('m'),
        units: [{ unitId: unitId('yard'), factor: '0.9144', barcode: '' }],
      }),
    );
    expect(fabric.units).toEqual([{ unitId: unitId('yard'), factor: '0.914400', barcode: null }]);
  });

  it('checks the custom fields against the workspace’s', async () => {
    const res = await send(
      'POST',
      '/products',
      simple('Fleece hoodie', { customFields: { gsm: 'heavy', fabric: 'Fleece' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      'customFields.gsm': ['number_format'],
      customFields: ['custom_field_unknown'],
    });
  });

  it('keeps the values of an archived field when the product is saved again', async () => {
    const fields = customFieldListSchema.parse(
      (await send('GET', '/custom-fields?entity=product')).json(),
    ).items;
    const season = customFieldDefinitionSchema.parse(
      fields.find((field) => field.key === 'season'),
    );
    const jacket = await created(
      simple('Puffer jacket', { customFields: { season: 'Winter 2026' } }),
    );
    await send('POST', `/custom-fields/${season.id}/archive`, { version: season.version });
    // The form no longer sends the archived field; the value stays
    const saved = productSchema.parse(
      (
        await send('PUT', `/products/${jacket.id}`, {
          ...formOf(jacket),
          name: 'Puffer jacket (men)',
        })
      ).json(),
    );
    expect(saved.customFields).toEqual({ season: 'Winter 2026' });
    const restored = await send('POST', `/custom-fields/${season.id}/restore`, {
      version: season.version + 1,
    });
    expect(restored.statusCode).toBe(200);
  });

  it('keeps variant ids on an edit: values can swap, variants come and go', async () => {
    const tee = await created(
      simple('Raglan tee', {
        code: 'ST-207',
        options: [{ name: 'Size', values: ['S', 'M'] }],
        variants: [variant(['S'], { barcode: '96385074' }), variant(['M'])],
      }),
    );
    const [small, medium] = tee.variants;
    if (!small || !medium) throw new Error('two variants');
    const form = formOf(tee);
    const res = await send('PUT', `/products/${tee.id}`, {
      ...form,
      options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      variants: [
        // S and M swap their SKUs (typed the wrong way round the first time)
        { ...form.variants[0], sku: medium.sku },
        { ...form.variants[1], sku: small.sku, archived: true },
        variant(['L']),
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = productSchema.parse(res.json());
    expect(saved.variants.map((v) => [v.id === small.id, v.sku, v.archivedAt !== null])).toEqual([
      [true, 'ST-207-M', false],
      [false, 'ST-207-S', true],
      [false, 'ST-207-L', false],
    ]);
    expect(saved.variants[1]?.id).toBe(medium.id);
    expect(saved.variants[0]?.barcode).toBe('96385074');

    // An id that is not this product's own
    const foreign = await send('PUT', `/products/${tee.id}`, {
      ...formOf(saved),
      variants: [
        { ...formOf(saved).variants[0], id: crypto.randomUUID() },
        ...formOf(saved).variants.slice(1),
      ],
    });
    expect(problemOf(foreign).fieldErrors).toEqual({
      'variants.0.id': ['product_variant_unknown'],
    });
    // A stale form
    const stale = await send('PUT', `/products/${tee.id}`, formOf(tee));
    expect(problemOf(stale).code).toBe('version_conflict');
  });

  it('archives, restores and deletes — but not a product with a history', async () => {
    const mug = await created(simple('Promotional mug'));
    const archived = productSchema.parse(
      (await send('POST', `/products/${mug.id}/archive`, { version: mug.version })).json(),
    );
    expect(archived.archivedAt).not.toBeNull();
    const restored = productSchema.parse(
      (await send('POST', `/products/${mug.id}/restore`, { version: archived.version })).json(),
    );
    expect(restored.archivedAt).toBeNull();

    // A batch (from step 13: a stock line) points at its variant: it stays
    await superuserSql(
      (sql) => sql`INSERT INTO batches (id, tenant_id, product_id, variant_id, lot_number)
                   SELECT gen_random_uuid(), tenant_id, product_id, id, 'L-01'
                     FROM product_variants WHERE id = ${restored.variants[0]?.id ?? ''}`,
    );
    const inUse = await send('DELETE', `/products/${mug.id}?version=${String(restored.version)}`);
    expect(problemOf(inUse).code).toBe('product_in_use');

    const sample = await created(simple('Sample swatch card'));
    expect(
      (await send('DELETE', `/products/${sample.id}?version=${String(sample.version)}`)).statusCode,
    ).toBe(204);
    expect((await send('GET', `/products/${sample.id}`)).statusCode).toBe(404);
    const audit = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=product')).json(),
    );
    expect(audit.items.find((item) => item.action === 'product.deleted')?.changes).toMatchObject({
      name: { from: 'Sample swatch card', to: null },
    });
  });
});

describe('the product list', () => {
  it('pages through every product once, in each order', async () => {
    for (const sort of ['name', '-name', 'code', '-code', '-updated'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ sort, limit: '3', ...(cursor && { cursor }) });
        const page = productPageSchema.parse((await send('GET', `/products?${query}`)).json());
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      const all = productPageSchema.parse(
        (await send('GET', `/products?sort=${sort}&limit=100`)).json(),
      );
      expect(seen, sort).toEqual(all.items.map((item) => item.id));
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('finds by part of a name, code or SKU, and by a whole barcode', async () => {
    const search = async (term: string) =>
      productPageSchema
        .parse((await send('GET', `/products?search=${encodeURIComponent(term)}`)).json())
        .items.map((item) => item.name);
    expect(await search('polo')).toEqual(['Pique polo shirt']);
    expect(await search('st-118')).toEqual(['Pique polo shirt']);
    expect(await search('navy-blue')).toEqual(['Pique polo shirt']);
    expect(await search('8941100500118')).toEqual(['Oxford shirt']);
    expect(await search('89411005')).toEqual([]);
    // LIKE's wildcards are plain characters in a search
    expect(await search('%')).toEqual([]);
  });

  it('filters by a category and the categories under it, and by status', async () => {
    const garments = await categoryId('Finished garments');
    const page = productPageSchema.parse(
      (await send('GET', `/products?categoryId=${garments}`)).json(),
    );
    expect(page.items.map((item) => item.name)).toEqual(['Basic crew-neck T-shirt']);
    const archived = productPageSchema.parse(
      (await send('GET', '/products?status=archived')).json(),
    );
    expect(archived.items).toEqual([]);
  });

  it('sums up each product: variants and price range', async () => {
    const page = productPageSchema.parse((await send('GET', '/products?search=polo')).json());
    expect(page.items[0]).toMatchObject({
      hasVariants: true,
      variantCount: 3,
      minPrice: '600.0000',
      maxPrice: '650.0000',
    });
  });
});

describe('permissions', () => {
  it('lets every member read products, and only managers change them', async () => {
    expect((await send('GET', '/products', undefined, viewer)).statusCode).toBe(200);
    expect((await send('GET', '/units', undefined, viewer)).statusCode).toBe(200);
    const res = await send('POST', '/products', simple('Viewer’s product'), viewer);
    expect(res.statusCode).toBe(403);
    expect(problemOf(res).params).toEqual({ permissions: 'inventory.product.manage' });
    const field = await send(
      'POST',
      '/custom-fields',
      { entity: 'product', key: 'x', label: 'X', type: 'text', options: [], required: false },
      viewer,
    );
    expect(field.statusCode).toBe(403);
  });
});
```

- **The starting catalog** comes from the real setup job, and an "old" workspace (set to `ready` by hand, with the
  event migration 0020 would have queued) gets its own from the catalog job.
- **`formOf()`** builds a form from a saved product, the way the edit page does, so the edits test what a person can
  really send.
- **Units**: the code is taken in any case; a used unit cannot be deleted; an archived unit stays on the product that
  has it and cannot start a new one.
- **Categories**: siblings in any case, a loop refused, only an empty category deleted.
- **Products**: the next code and its SKU; one barcode in the whole workspace (a variant's against a pack's); SKUs
  from code and values; the standard size of a dozen and the rounded yard; custom fields checked against the
  workspace's; an archived field's value kept; variant ids kept through a swap of SKUs, an archive and a new
  variant; a foreign variant id and a stale version refused; archive, restore, delete, and a product with a batch kept.
- **The list**: every order paged three at a time must give exactly the same rows as one big page — no row skipped,
  none twice; the search by name, code, SKU and whole barcode; `%` taken literally; the category filter with its
  sub-categories; the price range.
- **Permissions**: a member without a role reads products and units, and cannot create a product or a custom field.

These tests build on each other inside the file (the list tests count products made earlier). Run the file as a
whole: one test picked out with `-t` can fail on its own even when nothing is broken.

**File: `apps/api/src/products/product-imports.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  notificationPageSchema,
  productCategoryListSchema,
  type ProductImport,
  productImportDetailSchema,
  productImportSchema,
  productImportTicketSchema,
  productPageSchema,
  problemSchema,
  setupSchema,
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
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// The whole way of an import: the API gives an upload address, the file goes straight to a real
// MinIO, the real worker reads and checks it, and the products appear — or nothing does.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;

function send(method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(owner.accessToken),
    ...(payload && { payload }),
  });
}

// Upload a CSV and start the import, as the import page does
async function upload(fileName: string, csv: string): Promise<ProductImport> {
  const bytes = new TextEncoder().encode(csv);
  const ticket = productImportTicketSchema.parse(
    (await send('POST', '/product-imports', { fileName, sizeBytes: bytes.byteLength })).json(),
  );
  const put = await fetch(ticket.upload.url, {
    method: 'PUT',
    headers: ticket.upload.headers,
    body: bytes,
  });
  expect(put.status).toBe(200);
  const started = await send('POST', `/product-imports/${ticket.import.id}/start`);
  expect(started.statusCode, started.body).toBe(200);
  return productImportSchema.parse(started.json());
}

async function finished(id: string) {
  return eventually(async () => {
    const detail = productImportDetailSchema.parse(
      (await send('GET', `/product-imports/${id}`)).json(),
    );
    expect(['done', 'failed']).toContain(detail.status);
    return detail;
  }, 8_000);
}

async function productNames(): Promise<string[]> {
  return productPageSchema
    .parse((await send('GET', '/products?limit=100')).json())
    .items.map((item) => item.name);
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  expect((await send('POST', '/setup', { industry: 'pharma' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

describe('importing products from a CSV', () => {
  it('creates every product of a good file, with new categories and codes', async () => {
    const started = await upload(
      'medicines.csv',
      [
        'name,unit,sale_price,pack1_unit,pack1_factor,pack2_unit,pack2_factor,sales_unit,category,barcode,cf_generic_name,cf_dosage_form',
        'Napa 500 mg,pcs,1.20,strip,10,box,100,strip,Finished products > Tablets,8941100500118,Paracetamol,Tablet',
        'Seclo 20 mg,pcs,7,strip,10,,,strip,Finished products > Capsules,,Omeprazole,Capsule',
        // A category that does not exist yet: made, under one that does
        'Napa syrup 60 ml,bottle,35,,,,,,Finished products > Paediatric syrups,,Paracetamol,Syrup',
      ].join('\n'),
    );
    expect(started).toMatchObject({ status: 'queued', fileName: 'medicines.csv' });

    const done = await finished(started.id);
    expect(done).toMatchObject({ status: 'done', rowCount: 3, productCount: 3, errors: [] });
    expect(await productNames()).toEqual(['Napa 500 mg', 'Napa syrup 60 ml', 'Seclo 20 mg']);
    const napa = productPageSchema.parse(
      (await send('GET', '/products?search=8941100500118')).json(),
    ).items[0];
    // A pharma workspace: batch tracking, from the business type, like the form
    expect(napa).toMatchObject({ code: 'P-00001', tracking: 'batch' });
    const categories = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    ).items;
    expect(categories.map((category) => category.name)).toContain('Paediatric syrups');

    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items[0]).toMatchObject({
      type: 'import.done',
      params: { file: 'medicines.csv', count: 3 },
    });
  });

  it('creates nothing from a file with one wrong row, and says where', async () => {
    const started = await upload(
      'more-medicines.csv',
      [
        'name,unit,sale_price,category,barcode,cf_generic_name',
        'Ace 500 mg,pcs,1.10,Finished products > Antacids,,Paracetamol',
        // Taken by Napa from the first file
        'Ace Plus,pcs,2.50,,8941100500118,Paracetamol + Caffeine',
        // The pharma template makes Generic name required
        'Fexo 120 mg,tablet,8,,,',
      ].join('\n'),
    );
    const failed = await finished(started.id);
    expect(failed.status).toBe('failed');
    expect(failed.errors).toEqual([
      { row: 4, column: 'unit', code: 'import_unit_unknown', params: { value: 'tablet' } },
      { row: 4, column: 'cf_generic_name', code: 'required' },
    ]);
    // Nothing was written, not even the new category
    expect(await productNames()).not.toContain('Ace 500 mg');

    // The same file with Fexo fixed: now the taken barcode is what stands in the way. The worker
    // checked it inside a savepoint, so the category made for Ace was undone again.
    const second = await upload(
      'more-medicines.csv',
      [
        'name,unit,sale_price,category,barcode,cf_generic_name',
        'Ace 500 mg,pcs,1.10,Finished products > Antacids,,Paracetamol',
        'Ace Plus,pcs,2.50,,8941100500118,Paracetamol + Caffeine',
      ].join('\n'),
    );
    const again = await finished(second.id);
    expect(again.errors).toEqual([{ row: 3, column: 'barcode', code: 'barcode_taken' }]);
    const categories = productCategoryListSchema.parse(
      (await send('GET', '/product-categories')).json(),
    ).items;
    expect(categories.map((category) => category.name)).not.toContain('Antacids');
    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items[0]).toMatchObject({
      type: 'import.failed',
      params: { file: 'more-medicines.csv', count: 1 },
    });
  });

  it('starts only a file that is really in storage, and only once', async () => {
    const ticket = productImportTicketSchema.parse(
      (await send('POST', '/product-imports', { fileName: 'empty.csv', sizeBytes: 120 })).json(),
    );
    const early = await send('POST', `/product-imports/${ticket.import.id}/start`);
    expect(problemSchema.parse(early.json()).code).toBe('import_not_uploaded');

    const started = await upload(
      'one.csv',
      'name,unit,cf_generic_name\nNorvasc 5 mg,pcs,Amlodipine',
    );
    const twice = await send('POST', `/product-imports/${started.id}/start`);
    expect(problemSchema.parse(twice.json()).code).toBe('import_not_pending');
    expect((await finished(started.id)).status).toBe('done');
  });

  it('refuses a file that is not a CSV, or too large, before any upload', async () => {
    const res = await send('POST', '/product-imports', {
      fileName: 'products.xlsx',
      sizeBytes: 6 * 1024 * 1024,
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      fileName: ['import_file_type'],
      sizeBytes: ['file_too_large'],
    });
  });
});
```

The whole way of an import against a real MinIO and the real worker: a good file (with a category that does not exist
yet, and pharma's batch tracking from the business type), a file with problems in two cells of one row, the same file
fixed but with a barcode another product has (the savepoint undoes the new category), the upload checks, and the
refusal of an `.xlsx` before any upload.

**File: `apps/api/src/products/products.tenant-leak.int.spec.ts`** (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  customFieldListSchema,
  type Product,
  productCategoryListSchema,
  type ProductFormValues,
  productImportTicketSchema,
  productPageSchema,
  productSchema,
  problemSchema,
  setupSchema,
  type Unit,
  unitListSchema,
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

// Two workspaces, each with products: A must never see, use or change B's products, units,
// categories, custom fields or imports. Every answer is 404, or the same "pick one from the list"
// as for an id that does not exist — never a hint that it does.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let unitsOfA: Unit[];
let unitsOfB: Unit[];
let productOfB: Product;

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

async function setUp(who: SignedIn, industry: 'garments' | 'pharma'): Promise<Unit[]> {
  expect((await as(who, 'POST', '/setup', { industry })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  return unitListSchema.parse((await as(who, 'GET', '/units')).json()).items;
}

function pcsOf(units: Unit[]): string {
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (!pcs) throw new Error('no pcs');
  return pcs.id;
}

function product(name: string, units: Unit[], extra: Partial<ProductFormValues> = {}) {
  return {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcsOf(units),
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
  } satisfies ProductFormValues;
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
  [unitsOfA, unitsOfB] = await Promise.all([setUp(tenantA, 'garments'), setUp(tenantB, 'pharma')]);
  const res = await as(
    tenantB,
    'POST',
    '/products',
    product('Napa 500 mg', unitsOfB, {
      variants: [
        {
          id: null,
          sku: '',
          optionValues: [],
          barcode: '8941100500118',
          salePrice: '1.20',
          archived: false,
        },
      ],
      customFields: { generic_name: 'Paracetamol' },
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  productOfB = productSchema.parse(res.json());
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('product isolation over HTTP', () => {
  it("never lists, finds or reads tenant B's products", async () => {
    const page = productPageSchema.parse((await as(tenantA, 'GET', '/products')).json());
    expect(page.items).toEqual([]);
    // Not by name, nor by B's barcode scanned into A's search box
    for (const search of ['napa', '8941100500118', productOfB.code]) {
      const found = productPageSchema.parse(
        (await as(tenantA, 'GET', `/products?search=${search}`)).json(),
      );
      expect(found.items, search).toEqual([]);
    }
    expect((await as(tenantA, 'GET', `/products/${productOfB.id}`)).statusCode).toBe(404);
  });

  it("cannot change, archive or delete tenant B's product", async () => {
    const edit = { ...product('Taken over', unitsOfA), version: 1 };
    expect((await as(tenantA, 'PUT', `/products/${productOfB.id}`, edit)).statusCode).toBe(404);
    for (const action of ['archive', 'restore']) {
      const res = await as(tenantA, 'POST', `/products/${productOfB.id}/${action}`, { version: 1 });
      expect(res.statusCode).toBe(404);
    }
    expect((await as(tenantA, 'DELETE', `/products/${productOfB.id}?version=1`)).statusCode).toBe(
      404,
    );
    const still = productSchema.parse(
      (await as(tenantB, 'GET', `/products/${productOfB.id}`)).json(),
    );
    expect(still).toMatchObject({ name: 'Napa 500 mg', version: 1, archivedAt: null });
  });

  it("cannot use tenant B's units, categories or variants in its own product", async () => {
    const categoriesOfB = productCategoryListSchema.parse(
      (await as(tenantB, 'GET', '/product-categories')).json(),
    ).items;
    const strip = unitsOfB.find((unit) => unit.code === 'strip');
    const res = await as(
      tenantA,
      'POST',
      '/products',
      product('Borrowed everything', unitsOfA, {
        baseUnitId: pcsOf(unitsOfB),
        categoryId: categoriesOfB[0]?.id ?? '',
        units: [{ unitId: strip?.id ?? '', factor: '10', barcode: '' }],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      categoryId: ['product_category_invalid'],
      baseUnitId: ['product_unit_invalid'],
      'units.0.unitId': ['product_unit_invalid'],
    });
    // B's barcode is B's: A may print the same number on its own product
    const same = await as(
      tenantA,
      'POST',
      '/products',
      product('Gift card', unitsOfA, {
        variants: [
          {
            id: null,
            sku: productOfB.code,
            optionValues: [],
            barcode: '8941100500118',
            salePrice: '',
            archived: false,
          },
        ],
      }),
    );
    expect(same.statusCode, same.body).toBe(201);
    // …and A's form cannot claim B's variant as one of its own
    const created = productSchema.parse(same.json());
    const steal = await as(tenantA, 'PUT', `/products/${created.id}`, {
      ...product('Gift card', unitsOfA, {
        variants: [
          {
            id: productOfB.variants[0]?.id ?? null,
            sku: '',
            optionValues: [],
            barcode: '',
            salePrice: '',
            archived: false,
          },
        ],
      }),
      version: created.version,
    });
    expect(problemSchema.parse(steal.json()).fieldErrors).toEqual({
      'variants.0.id': ['product_variant_unknown'],
    });
  });

  it("cannot touch tenant B's units, categories, fields or imports", async () => {
    const unit = unitsOfB.find((candidate) => candidate.code === 'strip');
    const category = productCategoryListSchema.parse(
      (await as(tenantB, 'GET', '/product-categories')).json(),
    ).items[0];
    const field = customFieldListSchema.parse(
      (await as(tenantB, 'GET', '/custom-fields?entity=product')).json(),
    ).items[0];
    if (!unit || !category || !field) throw new Error('B has no catalog');

    const attempts = [
      as(tenantA, 'PUT', `/units/${unit.id}`, { code: 'x', name: 'X', decimals: 0, version: 1 }),
      as(tenantA, 'POST', `/units/${unit.id}/archive`, { version: 1 }),
      as(tenantA, 'DELETE', `/units/${unit.id}?version=1`),
      as(tenantA, 'PUT', `/product-categories/${category.id}`, {
        parentId: '',
        name: 'X',
        version: 1,
      }),
      as(tenantA, 'DELETE', `/product-categories/${category.id}?version=1`),
      as(tenantA, 'PUT', `/custom-fields/${field.id}`, {
        label: 'X',
        options: [],
        required: false,
        version: 1,
      }),
      as(tenantA, 'POST', `/custom-fields/${field.id}/archive`, { version: 1 }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(404);
    // A sub-category of A under B's category is "pick one from the list", like a made-up id
    const under = await as(tenantA, 'POST', '/product-categories', {
      parentId: category.id,
      name: 'X',
    });
    expect(problemSchema.parse(under.json()).code).toBe('category_parent_invalid');

    const ticket = productImportTicketSchema.parse(
      (await as(tenantB, 'POST', '/product-imports', { fileName: 'b.csv', sizeBytes: 10 })).json(),
    );
    expect((await as(tenantA, 'GET', `/product-imports/${ticket.import.id}`)).statusCode).toBe(404);
    expect(
      (await as(tenantA, 'POST', `/product-imports/${ticket.import.id}/start`)).statusCode,
    ).toBe(404);
    const list = await as(tenantA, 'GET', '/product-imports');
    expect(list.json()).toMatchObject({ items: [] });
  });
});
```

Workspace A against workspace B's data: B's products are never listed, found by name or by B's barcode, read, changed,
archived or deleted; B's units, categories and variants cannot be used in A's product (the same "pick one from the
list" answer as for a made-up id); B's units, categories, fields and imports answer 404. A may print the same barcode
number on its own product — a barcode is unique per workspace, not across them.

**File: `apps/api/src/setup/setup.int.spec.ts`** (change)

```diff
@@ -8,6 +8,7 @@ import {
   problemSchema,
   roleListSchema,
   setupSchema,
+  unitListSchema,
 } from '@omnivo/contracts';
 import postgres from 'postgres';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
@@ -28,11 +29,12 @@ import {
   type TestRedis,
 } from '../testing/containers.js';
 import { bearer, type SignedIn, signUp } from '../testing/http.js';
-import { accountCount } from '../testing/chart.js';
+import { accountCount, catalogCount } from '../testing/chart.js';
 import { lastMailTo } from '../testing/mailpit.js';
 import { INDUSTRY_TEMPLATES } from './templates.js';
 
 const GARMENTS_ACCOUNTS = accountCount(INDUSTRY_TEMPLATES.garments.chart);
+const GARMENTS_CATALOG = catalogCount(INDUSTRY_TEMPLATES.garments.catalog);
 
 let pg: TestPostgres;
 let redis: TestRedis;
@@ -137,8 +139,8 @@ describe('starting the setup', () => {
           'core.user.read',
         ],
       ],
-      ['Merchandiser', ['core.user.read']],
-      ['Store keeper', []],
+      ['Merchandiser', ['core.user.read', 'inventory.product.manage']],
+      ['Store keeper', ['inventory.product.manage']],
     ]);
     const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
     expect(chart.items.find((account) => account.code === '4110')).toMatchObject({
@@ -163,6 +165,9 @@ describe('starting the setup', () => {
       changes: {
         roles: { from: null, to: 'Accountant, Merchandiser, Store keeper' },
         accounts: { from: null, to: GARMENTS_ACCOUNTS },
+        units: { from: null, to: GARMENTS_CATALOG.units },
+        categories: { from: null, to: GARMENTS_CATALOG.categories },
+        customFields: { from: null, to: GARMENTS_CATALOG.customFields },
       },
     });
     // The worker ran in the context of the POST /setup request: one click, traced end to end
@@ -255,13 +260,21 @@ describe('when the setup job fails', () => {
     await superuserSql(
       (sql) => sql`UPDATE tenants SET industry = 'pharma' WHERE slug = 'karim-pharma'`,
     );
-    // Step 9's migration queues a chart for every workspace that is not 'pending' — this failed
-    // one too. Its chart arrives before the retry, so the retried setup job must leave it alone.
+    // Step 9's migration queues a chart, and step 12's a catalog, for every workspace that is not
+    // 'pending' — this failed one too. Both arrive before the retry, so the retried setup job must
+    // leave them alone.
     await superuserSql(
       (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
-                   SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}'::jsonb
-                   FROM tenants WHERE slug = 'karim-pharma'`,
+                   SELECT gen_random_uuid(), id, event, '{}'::jsonb
+                   FROM tenants, unnest(ARRAY['workspace.chart_requested', 'workspace.catalog_requested']) AS event
+                   WHERE slug = 'karim-pharma'`,
     );
+    await eventually(async () => {
+      const units = unitListSchema.parse(
+        (await send('GET', '/units', undefined, pharmaOwner)).json(),
+      );
+      expect(units.items).toHaveLength(INDUSTRY_TEMPLATES.pharma.catalog.units.length);
+    });
     const pharmaAccounts = accountCount(INDUSTRY_TEMPLATES.pharma.chart);
     await eventually(async () => {
       const chart = accountListSchema.parse(
```

- The garments roles now carry `inventory.product.manage`.
- The setup's audit row has the catalog counts.
- The retry scenario: migration 0020 queues a catalog for a failed workspace too, so the test queues it next to the
  chart, waits for its units, and still expects the retried setup to add nothing twice.

**File: `apps/api/src/numbering/numbering.int.spec.ts`** (change)

```diff
@@ -101,7 +101,13 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(6);
+    expect(items.map((series) => series.documentType)).toHaveLength(7);
+    // Product codes (step 12): no year in them, five digits
+    expect(items.find((series) => series.documentType === 'inventory.product')).toMatchObject({
+      prefix: 'P',
+      yearStyle: 'none',
+      nextNumber: 'P-00001',
+    });
     expect(items.find((series) => series.documentType === 'purchase.order')).toMatchObject({
       prefix: 'PO',
       version: 0,
```

```bash
pnpm --filter @omnivo/api test                 # 68 — 26 new (csv.spec 8, templates.spec 18)
pnpm --filter @omnivo/api test:integration     # 175 — 22 new
pnpm --filter @omnivo/api test:tenant-leak     # 39 — 4 new
```

---

## 12.6 — `packages/i18n`: the texts

**File: `packages/i18n/src/locales/en.ts`** (change)

```diff
@@ -53,6 +53,12 @@ export const en = {
     profitAndLoss: 'Profit and loss',
     balanceSheet: 'Balance sheet',
     exports: 'Exports',
+    inventory: 'Inventory',
+    products: 'Products',
+    categories: 'Categories',
+    units: 'Units',
+    productImports: 'Imports',
+    customFields: 'Custom fields',
   },
   auth: {
     workspace: 'Workspace',
@@ -148,7 +154,7 @@ export const en = {
     documents: {
       sales: { invoice: 'Sales invoice', order: 'Sales order' },
       purchase: { order: 'Purchase order', bill: 'Supplier bill' },
-      inventory: { receipt: 'Goods receipt (GRN)' },
+      inventory: { receipt: 'Goods receipt (GRN)', product: 'Product code' },
       accounting: { journal: 'Journal voucher' },
     },
     yearStyles: {
@@ -522,6 +528,297 @@ export const en = {
     emptyBody: 'Open a report, like the trial balance, and choose Export. The file shows up here.',
     loadFailed: "Couldn't load your exports. Refresh the page to try again.",
   },
+  products: {
+    title: 'Products',
+    description: 'Everything you buy, make, keep in stock or sell',
+    add: 'Add product',
+    import: 'Import',
+    searchLabel: 'Search products',
+    searchPlaceholder: 'Name, code, SKU or barcode',
+    category: 'Category',
+    allCategories: 'All categories',
+    show: 'Show',
+    statuses: { active: 'Active', archived: 'Archived' },
+    columns: {
+      product: 'Product',
+      variants: 'Variants',
+      unit: 'Unit',
+      tracking: 'Tracking',
+      price: 'Sale price',
+    },
+    variantCount_one: '{{count}} variant',
+    variantCount_other: '{{count}} variants',
+    simple: 'One version',
+    emptyTitle: 'No products yet',
+    emptyBody:
+      "Add your first product, like a buyer's polo shirt style or a strip of Napa, or import them all from a CSV file.",
+    noMatchTitle: 'No product matches "{{query}}"',
+    noMatchBody: 'Check the spelling, or search by code, SKU or barcode.',
+    archivedEmptyTitle: 'No archived products',
+    archivedEmptyBody: 'A product you archive shows up here. Archive what you no longer sell.',
+    loadFailed: "Couldn't load the products. Refresh the page to try again.",
+    readOnly:
+      'You can see the products. To change them, ask for the inventory.product.manage permission.',
+    back: 'Products',
+    newTitle: 'New product',
+    editTitle: 'Edit {{code}}',
+    notFound: "This product doesn't exist, or it was deleted.",
+    sections: {
+      basics: 'Basics',
+      units: 'Units and packs',
+      unitsHint:
+        'Stock is always counted in the base unit. Packs are bigger units the product also comes in.',
+      variants: 'Versions',
+      variantsHint: 'Sizes, colours or other options, each with its own SKU, barcode and price.',
+      tracking: 'Stock tracking',
+      trackingHint:
+        'How each unit in stock is told apart. Batches and serial numbers are entered when goods arrive.',
+      details: 'More details',
+      detailsHint: "Your workspace's own fields. Add more on the Custom fields page.",
+    },
+    fields: {
+      name: 'Name',
+      namePlaceholder: 'Pique polo shirt',
+      code: 'Code',
+      codeHint: 'Leave empty for the next number, like P-00042.',
+      type: 'Type',
+      category: 'Category',
+      noCategory: 'No category',
+      description: 'Description',
+      baseUnit: 'Base unit',
+      salesUnit: 'Sell in',
+      purchaseUnit: 'Buy in',
+      sku: 'SKU',
+      skuHint: 'Leave empty to make one from the code.',
+      barcode: 'Barcode',
+      price: 'Sale price per {{unit}}',
+      tracking: 'Tracking',
+      hasExpiry: 'Batches have an expiry date',
+    },
+    types: { goods: 'Goods (kept in stock)', service: 'Service (not stocked)' },
+    trackings: { none: 'None', batch: 'Batch or lot', serial: 'Serial number' },
+    trackingHints: {
+      none: 'Every unit is the same, like T-shirts or rice.',
+      batch: 'Each delivery has a lot number, like medicine or food.',
+      serial: 'Each unit has its own number, like phones (IMEI) or machines.',
+    },
+    kinds: { simple: 'One version', variants: 'With variants' },
+    kindLabel: 'Versions',
+    simpleLocked: 'Keep one variant to go back to one version.',
+    options: {
+      name: 'Option',
+      namePlaceholder: 'Size',
+      values: 'Values',
+      valuesPlaceholder: 'S, M, L, XL',
+      valuesHint: 'Separate them with commas.',
+      add: 'Add an option',
+      remove: 'Remove option {{number}}',
+      generate: 'Create the variants',
+      generateHint:
+        'After changing the options, create the variants again. Existing ones keep their SKU, barcode and price.',
+    },
+    variantsTable: {
+      label: 'Variants',
+      variant: 'Variant',
+      archived: 'Archived',
+      remove: 'Remove {{name}}',
+      empty: 'Add the options and their values, then create the variants.',
+    },
+    packs: {
+      label: 'Packs',
+      unit: 'Pack',
+      placeholder: 'Pick a unit',
+      factor: 'Holds',
+      barcode: 'Pack barcode',
+      add: 'Add a pack',
+      remove: 'Remove pack {{number}}',
+      number: 'Pack {{number}}',
+      standard: 'A standard size, filled in for you.',
+      line: '1 {{pack}} = {{factor}} {{base}}',
+    },
+    yes: 'Yes',
+    no: 'No',
+    choose: 'Choose',
+    create: 'Add product',
+    save: 'Save product',
+    saving: 'Saving…',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    archive: 'Archive',
+    restore: 'Restore',
+    archivedToast: '{{name}} archived',
+    restoredToast: '{{name}} restored',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{code}}',
+    deleteWarning: 'This cannot be undone. A product with stock or documents can only be archived.',
+    deleted: '{{name}} deleted',
+    archivedNotice: 'This product is archived: it is hidden from new documents.',
+  },
+  categories: {
+    title: 'Product categories',
+    description: 'Groups for your products, like Fabrics › Knit',
+    add: 'Add category',
+    addTo: 'Add a category to {{name}}',
+    newTitle: 'Add category',
+    editTitle: 'Edit {{name}}',
+    parent: 'Inside',
+    topLevel: 'Top level',
+    name: 'Name',
+    namePlaceholder: 'Polo shirts',
+    productCount_one: '{{formatted}} product',
+    productCount_other: '{{formatted}} products',
+    created: '{{name}} added',
+    updated: '{{name}} saved',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{name}}',
+    deleteWarning: 'Only an empty category can be deleted.',
+    deleted: '{{name}} deleted',
+    expand: 'Show the categories in {{name}}',
+    collapse: 'Hide the categories in {{name}}',
+    expandAll: 'Expand all',
+    collapseAll: 'Collapse all',
+    searchLabel: 'Search categories',
+    searchPlaceholder: 'Search categories',
+    noMatchTitle: 'No category matches "{{query}}"',
+    noMatchBody: 'Check the spelling, or add the category.',
+    emptyTitle: 'No categories yet',
+    emptyBody:
+      'Add groups like Fabrics, Trims and Finished garments, then sort your products into them.',
+    loadFailed: "Couldn't load the categories. Refresh the page to try again.",
+    readOnly: 'To change the categories, ask for the inventory.product.manage permission.',
+  },
+  units: {
+    title: 'Units',
+    description: 'How your products are counted, weighed and measured',
+    add: 'Add unit',
+    newTitle: 'Add unit',
+    editTitle: 'Edit {{code}}',
+    code: 'Code',
+    codeHint: 'Short, like pcs or kg',
+    name: 'Name',
+    namePlaceholder: 'Pieces',
+    dimension: 'Measures',
+    dimensions: {
+      count: 'Count',
+      weight: 'Weight',
+      length: 'Length',
+      area: 'Area',
+      volume: 'Volume',
+    },
+    references: {
+      count: 'pcs',
+      weight: 'kg',
+      length: 'm',
+      area: 'm²',
+      volume: 'l',
+    },
+    ratio: 'Size',
+    ratioHint:
+      'How many {{reference}} one is. Leave empty for a pack, like a box, whose size each product says.',
+    decimals: 'Decimals',
+    decimalsHint: 'How many decimals a quantity may have: 0 for pieces, 3 for 1.250 kg.',
+    fixed: 'What it measures and its size stay as they were made.',
+    columns: { unit: 'Unit', measures: 'Measures', size: 'Size', decimals: 'Decimals' },
+    pack: 'Pack, size set per product',
+    sizeLine: '1 {{code}} = {{ratio}} {{reference}}',
+    showArchived: 'Show archived',
+    archived: 'Archived',
+    archive: 'Archive',
+    restore: 'Restore',
+    delete: 'Delete',
+    confirmDelete: 'Delete {{code}}',
+    deleteWarning: 'Only a unit that no product uses can be deleted.',
+    created: '{{code}} added',
+    updated: '{{code}} saved',
+    archivedToast: '{{code}} archived',
+    restoredToast: '{{code}} restored',
+    deleted: '{{code}} deleted',
+    emptyTitle: 'No units yet',
+    emptyBody: 'Add the units you count in, like pcs, kg, yard or box.',
+    loadFailed: "Couldn't load the units. Refresh the page to try again.",
+    readOnly: 'To change the units, ask for the inventory.product.manage permission.',
+  },
+  customFields: {
+    title: 'Custom fields',
+    description: 'Your own fields on products, like Generic name or GSM',
+    add: 'Add field',
+    newTitle: 'Add field',
+    editTitle: 'Edit {{label}}',
+    label: 'Label',
+    labelPlaceholder: 'Generic name',
+    key: 'Column name in imports',
+    keyHint: 'Small letters, digits and _. It stays as it is made.',
+    type: 'Type',
+    types: {
+      text: 'Text',
+      number: 'Number',
+      date: 'Date',
+      select: 'Choice from a list',
+      boolean: 'Yes or no',
+    },
+    options: 'Choices',
+    optionsHint: 'One per line',
+    required: 'Must be filled in',
+    requiredPill: 'Required',
+    columns: { field: 'Field', type: 'Type', column: 'Import column' },
+    archived: 'Archived',
+    archive: 'Archive',
+    restore: 'Restore',
+    showArchived: 'Show archived',
+    created: '{{label}} added',
+    updated: '{{label}} saved',
+    archivedToast: '{{label}} archived',
+    restoredToast: '{{label}} restored',
+    emptyTitle: 'No custom fields yet',
+    emptyBody:
+      'Add the details your products need, like Generic name for medicines or GSM for fabric.',
+    loadFailed: "Couldn't load the custom fields. Refresh the page to try again.",
+    readOnly: 'To change the custom fields, ask for the core.settings.manage permission.',
+  },
+  imports: {
+    title: 'Import products',
+    description: 'Add many products at once from a CSV file',
+    howTitle: 'How it works',
+    how: {
+      template:
+        'Download the template and fill in one row per product. Rows with the same code are the sizes or colours of one product.',
+      save: 'In Excel, save it with File → Save as → CSV UTF-8.',
+      upload:
+        'Upload it here. Every row is checked first: if one is wrong, nothing is imported and you see what to fix.',
+    },
+    template: 'Download the template',
+    file: 'CSV file',
+    fileHint: 'Up to 10,000 rows and 5 MB',
+    submit: 'Import',
+    uploading: 'Uploading…',
+    started: '{{file}} is being imported. You will hear when it is done.',
+    uploadFailed: "The file couldn't be uploaded. Try again.",
+    history: 'Imports',
+    historySubtitle: 'Every import in this workspace, newest first',
+    columns: { file: 'File', by: 'By', status: 'Status', result: 'Result' },
+    statuses: {
+      uploading: 'Uploading',
+      queued: 'Importing',
+      done: 'Imported',
+      failed: 'Not imported',
+    },
+    products_one: '{{formatted}} product',
+    products_other: '{{formatted}} products',
+    problems_one: '{{count}} problem',
+    problems_other: '{{count}} problems',
+    showProblems: 'See problems',
+    problemsTitle: 'Problems in {{file}}',
+    problemsDescription: 'Nothing was imported. Fix these cells and import the file again.',
+    row: 'Row',
+    column: 'Column',
+    problem: 'Problem',
+    wholeFile: 'Whole file',
+    moreProblems: 'The first {{shown}} of {{count}} problems are listed.',
+    emptyTitle: 'No imports yet',
+    emptyBody: 'Download the template, fill in your products and import the file.',
+    loadFailed: "Couldn't load the imports. Refresh the page to try again.",
+    readOnly: 'To import products, ask for the inventory.product.manage permission.',
+  },
   yearEnd: {
     title: 'Year-end close',
     description: "Move each year's profit into retained earnings and close its dates",
@@ -620,6 +917,7 @@ export const en = {
       team: 'Team',
       workspace: 'Workspace',
       accounting: 'Accounting',
+      inventory: 'Inventory',
     },
     members_one: '{{count}} person',
     members_other: '{{count}} people',
@@ -671,6 +969,9 @@ export const en = {
       period: { close: 'Close the books up to a date, and close fiscal years' },
       report: { read: 'See the reports and export them' },
     },
+    inventory: {
+      product: { manage: 'Add, edit and import products, their categories and units' },
+    },
   },
   invite: {
     checking: 'Checking your invitation…',
@@ -707,6 +1008,11 @@ export const en = {
       role: 'Roles',
       account: 'Chart of accounts',
       journal_entry: 'Journal',
+      unit: 'Units',
+      product_category: 'Product categories',
+      custom_field: 'Custom fields',
+      product: 'Products',
+      product_import: 'Product imports',
     },
     columns: {
       when: 'When',
@@ -728,6 +1034,7 @@ export const en = {
         setup_started: 'Started the workspace setup',
         provisioned: 'Added the starting roles and chart of accounts',
         chart_created: 'Added the chart of accounts',
+        catalog_created: 'Added the starting units, categories and custom fields',
       },
       auth: { signed_in: 'Signed in', switched_in: 'Switched into this workspace' },
       settings: { updated: 'Changed the settings', logo_changed: 'Changed the logo' },
@@ -772,6 +1079,32 @@ export const en = {
         year_closed: 'Closed a fiscal year',
         year_reopened: 'Reopened a fiscal year',
       },
+      unit: {
+        created: 'Added a unit',
+        updated: 'Edited a unit',
+        archived: 'Archived a unit',
+        restored: 'Restored a unit',
+        deleted: 'Deleted a unit',
+      },
+      product_category: {
+        created: 'Added a product category',
+        updated: 'Edited a product category',
+        deleted: 'Deleted a product category',
+      },
+      custom_field: {
+        created: 'Added a custom field',
+        updated: 'Edited a custom field',
+        archived: 'Archived a custom field',
+        restored: 'Restored a custom field',
+      },
+      product: {
+        created: 'Added a product',
+        updated: 'Edited a product',
+        archived: 'Archived a product',
+        restored: 'Restored a product',
+        deleted: 'Deleted a product',
+        imported: 'Imported products from a file',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -806,6 +1139,24 @@ export const en = {
       goLiveDate: 'First day on Omnivo',
       entry: 'Entry',
       year: 'Fiscal year',
+      type: 'Type',
+      category: 'Category',
+      baseUnit: 'Base unit',
+      tracking: 'Tracking',
+      variants: 'Variants',
+      packs: 'Packs',
+      dimension: 'Measures',
+      ratio: 'Size',
+      decimals: 'Decimals',
+      label: 'Label',
+      key: 'Key',
+      required: 'Required',
+      options: 'Choices',
+      file: 'File',
+      products: 'Products',
+      units: 'Units',
+      categories: 'Categories',
+      customFields: 'Custom fields',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -881,6 +1232,10 @@ export const en = {
         ready: '{{report}} ({{format}}) is ready to download.',
         failed: "{{report}} ({{format}}) couldn't be made. Try the export again.",
       },
+      import: {
+        done: '{{file}}: {{count}} products imported.',
+        failed: '{{file}} was not imported: {{count}} problems to fix. Nothing was saved.',
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
@@ -987,6 +1342,78 @@ export const en = {
     year_earlier_open: 'Close the earlier fiscal year first.',
     year_later_closed: 'Reopen the later fiscal year first.',
     export_not_ready: "The file isn't ready yet. Wait for the notification, then try again.",
+    factor_format: 'Enter a number above 0 with up to 6 decimals, like 24 or 0.9144.',
+    unit_code_format: 'Use up to 12 letters or digits without spaces, like pcs, kg or sq.ft.',
+    unit_code_taken: 'Another unit already uses this code. Pick a different one.',
+    unit_name_required: 'Enter the unit name.',
+    unit_in_use: 'Products use this unit, so it stays. Archive it instead.',
+    category_name_required: 'Enter the category name.',
+    category_name_taken: 'This place already has a category with this name.',
+    category_parent_invalid: 'Pick a category from the list, or the top level.',
+    category_parent_loop: "A category can't go under one of its own sub-categories.",
+    category_has_children: 'Move or delete the categories under this one first.',
+    category_in_use: 'Products are in this category. Move them to another category first.',
+    custom_field_key_format:
+      'Start with a small letter and use small letters, digits and _, like generic_name.',
+    custom_field_key_taken: 'Another field already uses this key. Pick a different one.',
+    custom_field_label_required: 'Enter the label people will see.',
+    custom_field_option_twice: 'This choice is in the list already.',
+    custom_field_options_required: 'Add at least one choice.',
+    custom_field_unknown: 'This field is not in the workspace any more. Reload the page.',
+    number_format: 'Enter a number, like 180 or 12.5.',
+    product_code_format: 'Use letters and digits without spaces, like P-00042 or ST-2026/118.',
+    product_code_taken: 'Another product already uses this code. Pick a different one.',
+    product_sku_format: 'Use letters and digits without spaces, like ST-118-M-NAVY.',
+    product_sku_taken: 'Another product already uses this SKU. Pick a different one.',
+    product_sku_twice: 'Two variants have this SKU. Give each its own.',
+    product_name_required: 'Enter the product name.',
+    product_unit_required: 'Pick a unit.',
+    product_unit_invalid: 'Pick an active unit from the list.',
+    product_unit_is_base: 'This is the base unit already. Pick a bigger unit for the pack.',
+    product_unit_twice: 'This unit is in the list already.',
+    product_default_unit_invalid: 'Pick the base unit or one of the packs below.',
+    product_factor_standard:
+      'This unit converts at a fixed rate, like 1 dozen = 12 pcs. Use that number.',
+    product_option_name_required: 'Name the option, like Size or Colour.',
+    product_option_values_required: 'Enter at least one value, like S, M, L.',
+    product_option_twice: 'This option is in the list already.',
+    product_option_value_twice: 'This value is in the list already.',
+    product_variants_simple: 'A product without options has exactly one version.',
+    product_variant_values:
+      "This variant's values don't match the options. Create the variants again.",
+    product_variant_twice: 'Two variants have the same values. Remove one.',
+    product_variant_last_active: 'Keep at least one variant active, or archive the whole product.',
+    product_variant_unknown: 'A variant changed while you were editing. Reload the page.',
+    product_variant_in_use: 'Documents use this variant, so it stays. Archive it instead.',
+    product_pack_barcode_variants:
+      'Products with variants keep their barcodes on the variants, not on the packs.',
+    product_tracking_service: "A service isn't stocked, so it isn't tracked. Pick None.",
+    product_expiry_needs_batch: 'Expiry dates are kept per batch. Pick batch tracking first.',
+    product_category_invalid: 'Pick a category from the list.',
+    product_in_use: 'Documents use this product, so it stays. Archive it instead.',
+    barcode_format: 'Use letters, digits and symbols without spaces.',
+    barcode_check_digit: 'The last digit is wrong for this barcode. Check the number on the pack.',
+    barcode_taken: 'Another product already uses this barcode.',
+    barcode_twice: 'This barcode is used twice in this product.',
+    import_file_type: 'Pick a CSV file. In Excel: File → Save as → CSV UTF-8.',
+    import_not_uploaded: "The file didn't finish uploading. Pick it again.",
+    import_not_pending: 'This file was started already. Reload the page to see how far it is.',
+    import_encoding:
+      'Save the file as CSV UTF-8 (Excel: File → Save as → CSV UTF-8) and try again.',
+    import_csv_malformed: 'A quote is not closed in this row. Check the cells with " in them.',
+    import_empty: 'The file has no product rows under the header.',
+    import_too_many_rows: 'The file has more than {{max}} rows. Split it into smaller files.',
+    import_column_missing:
+      'Add the column "{{column}}". Download the template to see every column.',
+    import_column_unknown:
+      'Remove the column "{{column}}", or fix its name. The template lists them.',
+    import_row_conflict:
+      'This row says something else than the first row of the product. Make them the same, or leave this cell empty.',
+    import_unit_unknown: 'No unit "{{value}}". Use a code from the Units page.',
+    import_category_invalid: 'Write the category as a path, like Fabrics > Knit.',
+    import_value_invalid: 'Use one of: {{allowed}}.',
+    import_options_without_code:
+      'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
     version_conflict:
       'Someone else saved changes while you were editing. Reload to see them, then make your change again.',
```

- **`numbering.documents.inventory.product`**: the number series' name sits inside `inventory`, because i18next reads
  the dot in `inventory.product` as nesting (`t('numbering.documents.inventory.product')`). A flat key
  `inventory_product` would never be found.
- **`roles.groups.inventory`** is the new section of the permission matrix; `permissions.inventory.product.manage`
  is the row.
- **`productCount_one/_other` and `products_one/_other` take `{{formatted}}`**, not `{{count}}`: `count` picks the
  singular or plural, `formatted` is the number written the reader's way (3,333 — ৩,৩৩৩). The screenshots showed
  "3333 products" before this.
- **`product_factor_standard` has no `{{values}}`.** A form's field error carries only its code, not values, so a text
  with `{{unit}}` would show the braces. The form fills the standard number in anyway.
- **Error texts say how to fix**, with the real way out where there is one: "Save the file as CSV UTF-8 (Excel: File →
  Save as → CSV UTF-8)", "Archive it instead".
- **`imports.how.*`** is the three-line help on the import page: the template, Excel's save, all or nothing.

**File: `packages/i18n/src/locales/bn.ts`** (change)

```diff
@@ -53,6 +53,12 @@ export const bn: Messages = {
     profitAndLoss: 'লাভ-ক্ষতি',
     balanceSheet: 'ব্যালান্স শিট',
     exports: 'এক্সপোর্ট',
+    inventory: 'ইনভেন্টরি',
+    products: 'প্রোডাক্ট',
+    categories: 'ক্যাটাগরি',
+    units: 'ইউনিট',
+    productImports: 'ইমপোর্ট',
+    customFields: 'কাস্টম ফিল্ড',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -148,7 +154,7 @@ export const bn: Messages = {
     documents: {
       sales: { invoice: 'বিক্রয় ইনভয়েস', order: 'সেলস অর্ডার' },
       purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
-      inventory: { receipt: 'মাল গ্রহণ (GRN)' },
+      inventory: { receipt: 'মাল গ্রহণ (GRN)', product: 'প্রোডাক্ট কোড' },
       accounting: { journal: 'জার্নাল ভাউচার' },
     },
     yearStyles: {
@@ -518,6 +524,296 @@ export const bn: Messages = {
       'একটা রিপোর্ট খুলুন, যেমন ট্রায়াল ব্যালান্স, আর এক্সপোর্ট বাছুন। ফাইলটা এখানে আসবে।',
     loadFailed: 'এক্সপোর্টগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  products: {
+    title: 'প্রোডাক্ট',
+    description: 'যা কিছু কেনেন, বানান, স্টকে রাখেন বা বিক্রি করেন',
+    add: 'প্রোডাক্ট যোগ করুন',
+    import: 'ইমপোর্ট',
+    searchLabel: 'প্রোডাক্ট খুঁজুন',
+    searchPlaceholder: 'নাম, কোড, SKU বা বারকোড',
+    category: 'ক্যাটাগরি',
+    allCategories: 'সব ক্যাটাগরি',
+    show: 'দেখান',
+    statuses: { active: 'চালু', archived: 'আর্কাইভ করা' },
+    columns: {
+      product: 'প্রোডাক্ট',
+      variants: 'ভ্যারিয়েন্ট',
+      unit: 'ইউনিট',
+      tracking: 'ট্র্যাকিং',
+      price: 'বিক্রয়মূল্য',
+    },
+    variantCount_one: '{{count}}টা ভ্যারিয়েন্ট',
+    variantCount_other: '{{count}}টা ভ্যারিয়েন্ট',
+    simple: 'একটাই সংস্করণ',
+    emptyTitle: 'এখনো কোনো প্রোডাক্ট নেই',
+    emptyBody:
+      'প্রথম প্রোডাক্টটা যোগ করুন, যেমন বায়ারের একটা পোলো শার্ট স্টাইল বা নাপার এক স্ট্রিপ, অথবা CSV ফাইল থেকে সবগুলো একসাথে ইমপোর্ট করুন।',
+    noMatchTitle: '"{{query}}"-এর সাথে কোনো প্রোডাক্ট মেলেনি',
+    noMatchBody: 'বানানটা দেখুন, বা কোড, SKU বা বারকোড দিয়ে খুঁজুন।',
+    archivedEmptyTitle: 'কোনো আর্কাইভ করা প্রোডাক্ট নেই',
+    archivedEmptyBody:
+      'যে প্রোডাক্ট আর্কাইভ করবেন সেটা এখানে দেখাবে। আর বিক্রি হয় না এমনগুলো আর্কাইভ করুন।',
+    loadFailed: 'প্রোডাক্টের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'আপনি প্রোডাক্ট দেখতে পারেন। বদলাতে inventory.product.manage অনুমতি চান।',
+    back: 'প্রোডাক্ট',
+    newTitle: 'নতুন প্রোডাক্ট',
+    editTitle: '{{code}} বদলান',
+    notFound: 'এই প্রোডাক্টটা নেই, বা মুছে ফেলা হয়েছে।',
+    sections: {
+      basics: 'মূল তথ্য',
+      units: 'ইউনিট ও প্যাক',
+      unitsHint: 'স্টক সবসময় মূল ইউনিটে গোনা হয়। প্যাক হলো বড় ইউনিট, যাতে প্রোডাক্টটা আসে।',
+      variants: 'সংস্করণ',
+      variantsHint: 'সাইজ, রং বা অন্য অপশন — প্রতিটার নিজের SKU, বারকোড আর দাম।',
+      tracking: 'স্টক ট্র্যাকিং',
+      trackingHint:
+        'স্টকের প্রতিটা ইউনিট কীভাবে আলাদা চেনা হবে। ব্যাচ আর সিরিয়াল নম্বর দেওয়া হয় মাল আসার সময়।',
+      details: 'আরও তথ্য',
+      detailsHint: 'আপনার ওয়ার্কস্পেসের নিজের ফিল্ড। Custom fields পেজ থেকে আরও যোগ করুন।',
+    },
+    fields: {
+      name: 'নাম',
+      namePlaceholder: 'পিকে পোলো শার্ট',
+      code: 'কোড',
+      codeHint: 'ফাঁকা রাখলে পরের নম্বর বসবে, যেমন P-00042।',
+      type: 'ধরন',
+      category: 'ক্যাটাগরি',
+      noCategory: 'কোনো ক্যাটাগরি নেই',
+      description: 'বিবরণ',
+      baseUnit: 'মূল ইউনিট',
+      salesUnit: 'বিক্রি হয়',
+      purchaseUnit: 'কেনা হয়',
+      sku: 'SKU',
+      skuHint: 'ফাঁকা রাখলে কোড থেকে বানানো হবে।',
+      barcode: 'বারকোড',
+      price: 'প্রতি {{unit}} বিক্রয়মূল্য',
+      tracking: 'ট্র্যাকিং',
+      hasExpiry: 'ব্যাচের মেয়াদের তারিখ আছে',
+    },
+    types: { goods: 'মাল (স্টকে থাকে)', service: 'সার্ভিস (স্টকে থাকে না)' },
+    trackings: { none: 'নেই', batch: 'ব্যাচ বা লট', serial: 'সিরিয়াল নম্বর' },
+    trackingHints: {
+      none: 'প্রতিটা ইউনিট একই রকম, যেমন টি-শার্ট বা চাল।',
+      batch: 'প্রতিটা চালানের একটা লট নম্বর থাকে, যেমন ওষুধ বা খাবার।',
+      serial: 'প্রতিটা ইউনিটের নিজের নম্বর, যেমন ফোন (IMEI) বা মেশিন।',
+    },
+    kinds: { simple: 'একটাই সংস্করণ', variants: 'ভ্যারিয়েন্টসহ' },
+    kindLabel: 'সংস্করণ',
+    simpleLocked: 'একটাই সংস্করণে ফিরতে একটা ভ্যারিয়েন্ট রাখুন।',
+    options: {
+      name: 'অপশন',
+      namePlaceholder: 'Size',
+      values: 'মান',
+      valuesPlaceholder: 'S, M, L, XL',
+      valuesHint: 'কমা দিয়ে আলাদা করুন।',
+      add: 'একটা অপশন যোগ করুন',
+      remove: 'অপশন {{number}} সরান',
+      generate: 'ভ্যারিয়েন্ট তৈরি করুন',
+      generateHint:
+        'অপশন বদলানোর পরে আবার ভ্যারিয়েন্ট তৈরি করুন। আগেরগুলোর SKU, বারকোড আর দাম থেকে যাবে।',
+    },
+    variantsTable: {
+      label: 'ভ্যারিয়েন্ট',
+      variant: 'ভ্যারিয়েন্ট',
+      archived: 'আর্কাইভ করা',
+      remove: '{{name}} সরান',
+      empty: 'অপশন আর তার মানগুলো দিন, তারপর ভ্যারিয়েন্ট তৈরি করুন।',
+    },
+    packs: {
+      label: 'প্যাক',
+      unit: 'প্যাক',
+      placeholder: 'একটা ইউনিট বাছুন',
+      factor: 'ভেতরে',
+      barcode: 'প্যাকের বারকোড',
+      add: 'একটা প্যাক যোগ করুন',
+      remove: 'প্যাক {{number}} সরান',
+      number: 'প্যাক {{number}}',
+      standard: 'নির্দিষ্ট মাপ, নিজে থেকে বসানো হয়েছে।',
+      line: '১ {{pack}} = {{factor}} {{base}}',
+    },
+    yes: 'হ্যাঁ',
+    no: 'না',
+    choose: 'বাছুন',
+    create: 'প্রোডাক্ট যোগ করুন',
+    save: 'প্রোডাক্ট সেভ করুন',
+    saving: 'সেভ হচ্ছে…',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    archivedToast: '{{name}} আর্কাইভ হয়েছে',
+    restoredToast: '{{name}} ফিরে এসেছে',
+    delete: 'মুছুন',
+    confirmDelete: '{{code}} মুছুন',
+    deleteWarning:
+      'এটা আর ফেরানো যাবে না। স্টক বা ডকুমেন্ট আছে এমন প্রোডাক্ট শুধু আর্কাইভ করা যায়।',
+    deleted: '{{name}} মোছা হয়েছে',
+    archivedNotice: 'এই প্রোডাক্টটা আর্কাইভ করা: নতুন ডকুমেন্টে এটা দেখাবে না।',
+  },
+  categories: {
+    title: 'প্রোডাক্ট ক্যাটাগরি',
+    description: 'প্রোডাক্টের দল, যেমন Fabrics › Knit',
+    add: 'ক্যাটাগরি যোগ করুন',
+    addTo: '{{name}}-এর ভেতরে ক্যাটাগরি যোগ করুন',
+    newTitle: 'ক্যাটাগরি যোগ করুন',
+    editTitle: '{{name}} বদলান',
+    parent: 'যার ভেতরে',
+    topLevel: 'সবার উপরে',
+    name: 'নাম',
+    namePlaceholder: 'পোলো শার্ট',
+    productCount_one: '{{formatted}}টা প্রোডাক্ট',
+    productCount_other: '{{formatted}}টা প্রোডাক্ট',
+    created: '{{name}} যোগ হয়েছে',
+    updated: '{{name}} সেভ হয়েছে',
+    delete: 'মুছুন',
+    confirmDelete: '{{name}} মুছুন',
+    deleteWarning: 'শুধু ফাঁকা ক্যাটাগরিই মোছা যায়।',
+    deleted: '{{name}} মোছা হয়েছে',
+    expand: '{{name}}-এর ক্যাটাগরিগুলো দেখান',
+    collapse: '{{name}}-এর ক্যাটাগরিগুলো লুকান',
+    expandAll: 'সব খুলুন',
+    collapseAll: 'সব বন্ধ করুন',
+    searchLabel: 'ক্যাটাগরি খুঁজুন',
+    searchPlaceholder: 'ক্যাটাগরি খুঁজুন',
+    noMatchTitle: '"{{query}}"-এর সাথে কোনো ক্যাটাগরি মেলেনি',
+    noMatchBody: 'বানানটা দেখুন, বা ক্যাটাগরিটা যোগ করুন।',
+    emptyTitle: 'এখনো কোনো ক্যাটাগরি নেই',
+    emptyBody:
+      'Fabrics, Trims, Finished garments-এর মতো দল যোগ করুন, তারপর প্রোডাক্টগুলো তাতে সাজান।',
+    loadFailed: 'ক্যাটাগরি আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'ক্যাটাগরি বদলাতে inventory.product.manage অনুমতি চান।',
+  },
+  units: {
+    title: 'ইউনিট',
+    description: 'আপনার প্রোডাক্ট কীভাবে গোনা, ওজন আর মাপা হয়',
+    add: 'ইউনিট যোগ করুন',
+    newTitle: 'ইউনিট যোগ করুন',
+    editTitle: '{{code}} বদলান',
+    code: 'কোড',
+    codeHint: 'ছোট, যেমন pcs বা kg',
+    name: 'নাম',
+    namePlaceholder: 'পিস',
+    dimension: 'যা মাপে',
+    dimensions: {
+      count: 'সংখ্যা',
+      weight: 'ওজন',
+      length: 'দৈর্ঘ্য',
+      area: 'ক্ষেত্রফল',
+      volume: 'আয়তন',
+    },
+    references: {
+      count: 'pcs',
+      weight: 'kg',
+      length: 'm',
+      area: 'm²',
+      volume: 'l',
+    },
+    ratio: 'মাপ',
+    ratioHint:
+      'একটায় কত {{reference}}। প্যাক হলে (যেমন box, যার মাপ প্রোডাক্টভেদে আলাদা) ফাঁকা রাখুন।',
+    decimals: 'দশমিক',
+    decimalsHint: 'পরিমাণে কত ঘর দশমিক থাকতে পারে: পিসে 0, 1.250 kg-তে 3।',
+    fixed: 'কী মাপে আর তার মাপ তৈরির পরে আর বদলায় না।',
+    columns: { unit: 'ইউনিট', measures: 'যা মাপে', size: 'মাপ', decimals: 'দশমিক' },
+    pack: 'প্যাক, মাপ প্রোডাক্টভেদে',
+    sizeLine: '১ {{code}} = {{ratio}} {{reference}}',
+    showArchived: 'আর্কাইভ করাগুলোও দেখান',
+    archived: 'আর্কাইভ করা',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    delete: 'মুছুন',
+    confirmDelete: '{{code}} মুছুন',
+    deleteWarning: 'শুধু যে ইউনিট কোনো প্রোডাক্টে নেই সেটাই মোছা যায়।',
+    created: '{{code}} যোগ হয়েছে',
+    updated: '{{code}} সেভ হয়েছে',
+    archivedToast: '{{code}} আর্কাইভ হয়েছে',
+    restoredToast: '{{code}} ফিরে এসেছে',
+    deleted: '{{code}} মোছা হয়েছে',
+    emptyTitle: 'এখনো কোনো ইউনিট নেই',
+    emptyBody: 'যে ইউনিটে গোনেন সেগুলো যোগ করুন, যেমন pcs, kg, yard বা box।',
+    loadFailed: 'ইউনিট আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'ইউনিট বদলাতে inventory.product.manage অনুমতি চান।',
+  },
+  customFields: {
+    title: 'কাস্টম ফিল্ড',
+    description: 'প্রোডাক্টে আপনার নিজের ফিল্ড, যেমন Generic name বা GSM',
+    add: 'ফিল্ড যোগ করুন',
+    newTitle: 'ফিল্ড যোগ করুন',
+    editTitle: '{{label}} বদলান',
+    label: 'লেবেল',
+    labelPlaceholder: 'Generic name',
+    key: 'ইমপোর্টে কলামের নাম',
+    keyHint: 'ছোট হাতের ইংরেজি অক্ষর, অঙ্ক আর _। তৈরির পরে বদলায় না।',
+    type: 'ধরন',
+    types: {
+      text: 'লেখা',
+      number: 'সংখ্যা',
+      date: 'তারিখ',
+      select: 'তালিকা থেকে বাছাই',
+      boolean: 'হ্যাঁ বা না',
+    },
+    options: 'পছন্দগুলো',
+    optionsHint: 'প্রতি লাইনে একটা',
+    required: 'অবশ্যই পূরণ করতে হবে',
+    requiredPill: 'বাধ্যতামূলক',
+    columns: { field: 'ফিল্ড', type: 'ধরন', column: 'ইমপোর্টের কলাম' },
+    archived: 'আর্কাইভ করা',
+    archive: 'আর্কাইভ',
+    restore: 'ফিরিয়ে আনুন',
+    showArchived: 'আর্কাইভ করাগুলোও দেখান',
+    created: '{{label}} যোগ হয়েছে',
+    updated: '{{label}} সেভ হয়েছে',
+    archivedToast: '{{label}} আর্কাইভ হয়েছে',
+    restoredToast: '{{label}} ফিরে এসেছে',
+    emptyTitle: 'এখনো কোনো কাস্টম ফিল্ড নেই',
+    emptyBody: 'প্রোডাক্টের যা তথ্য লাগে তা যোগ করুন, যেমন ওষুধের Generic name বা কাপড়ের GSM।',
+    loadFailed: 'কাস্টম ফিল্ড আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'কাস্টম ফিল্ড বদলাতে core.settings.manage অনুমতি চান।',
+  },
+  imports: {
+    title: 'প্রোডাক্ট ইমপোর্ট',
+    description: 'CSV ফাইল থেকে একসাথে অনেক প্রোডাক্ট যোগ করুন',
+    howTitle: 'কীভাবে কাজ করে',
+    how: {
+      template:
+        'টেমপ্লেট ডাউনলোড করে প্রতি প্রোডাক্টে এক সারি লিখুন। একই কোডের সারিগুলো এক প্রোডাক্টের সাইজ বা রং।',
+      save: 'Excel-এ File → Save as → CSV UTF-8 দিয়ে সেভ করুন।',
+      upload:
+        'এখানে আপলোড করুন। আগে প্রতিটা সারি দেখা হয়: একটাও ভুল থাকলে কিছুই ইমপোর্ট হয় না, আর কী ঠিক করতে হবে দেখতে পাবেন।',
+    },
+    template: 'টেমপ্লেট ডাউনলোড করুন',
+    file: 'CSV ফাইল',
+    fileHint: '১০,০০০ সারি আর ৫ MB পর্যন্ত',
+    submit: 'ইমপোর্ট',
+    uploading: 'আপলোড হচ্ছে…',
+    started: '{{file}} ইমপোর্ট হচ্ছে। শেষ হলে জানানো হবে।',
+    uploadFailed: 'ফাইলটা আপলোড করা যায়নি। আবার চেষ্টা করুন।',
+    history: 'ইমপোর্ট',
+    historySubtitle: 'এই ওয়ার্কস্পেসের সব ইমপোর্ট, নতুনগুলো আগে',
+    columns: { file: 'ফাইল', by: 'যিনি করেছেন', status: 'অবস্থা', result: 'ফল' },
+    statuses: {
+      uploading: 'আপলোড হচ্ছে',
+      queued: 'ইমপোর্ট হচ্ছে',
+      done: 'ইমপোর্ট হয়েছে',
+      failed: 'ইমপোর্ট হয়নি',
+    },
+    products_one: '{{formatted}}টা প্রোডাক্ট',
+    products_other: '{{formatted}}টা প্রোডাক্ট',
+    problems_one: '{{count}}টা সমস্যা',
+    problems_other: '{{count}}টা সমস্যা',
+    showProblems: 'সমস্যাগুলো দেখুন',
+    problemsTitle: '{{file}}-এর সমস্যা',
+    problemsDescription: 'কিছুই ইমপোর্ট হয়নি। এই ঘরগুলো ঠিক করে ফাইলটা আবার ইমপোর্ট করুন।',
+    row: 'সারি',
+    column: 'কলাম',
+    problem: 'সমস্যা',
+    wholeFile: 'পুরো ফাইল',
+    moreProblems: '{{count}}টা সমস্যার প্রথম {{shown}}টা দেখানো হয়েছে।',
+    emptyTitle: 'এখনো কোনো ইমপোর্ট নেই',
+    emptyBody: 'টেমপ্লেট ডাউনলোড করে প্রোডাক্টগুলো লিখুন, তারপর ফাইলটা ইমপোর্ট করুন।',
+    loadFailed: 'ইমপোর্টের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    readOnly: 'প্রোডাক্ট ইমপোর্ট করতে inventory.product.manage অনুমতি চান।',
+  },
   yearEnd: {
     title: 'বছর শেষের ক্লোজিং',
     description: 'প্রতিটা বছরের লাভ রিটেইনড আর্নিংসে নিন আর সেই বছরের তারিখগুলো বন্ধ করুন',
@@ -616,6 +912,7 @@ export const bn: Messages = {
       team: 'টিম',
       workspace: 'ওয়ার্কস্পেস',
       accounting: 'হিসাবরক্ষণ',
+      inventory: 'ইনভেন্টরি',
     },
     members_one: '{{count}} জন',
     members_other: '{{count}} জন',
@@ -665,6 +962,9 @@ export const bn: Messages = {
       period: { close: 'একটা তারিখ পর্যন্ত বই বন্ধ করা, আর অর্থবছর ক্লোজ করা' },
       report: { read: 'রিপোর্ট দেখা আর এক্সপোর্ট করা' },
     },
+    inventory: {
+      product: { manage: 'প্রোডাক্ট, তার ক্যাটাগরি আর ইউনিট যোগ, বদল আর ইমপোর্ট' },
+    },
   },
   invite: {
     checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
@@ -701,6 +1001,11 @@ export const bn: Messages = {
       role: 'রোল',
       account: 'চার্ট অফ অ্যাকাউন্টস',
       journal_entry: 'জার্নাল',
+      unit: 'ইউনিট',
+      product_category: 'প্রোডাক্ট ক্যাটাগরি',
+      custom_field: 'কাস্টম ফিল্ড',
+      product: 'প্রোডাক্ট',
+      product_import: 'প্রোডাক্ট ইমপোর্ট',
     },
     columns: {
       when: 'কখন',
@@ -720,6 +1025,7 @@ export const bn: Messages = {
         setup_started: 'ওয়ার্কস্পেসের সেটআপ শুরু করেছেন',
         provisioned: 'শুরুর রোল আর চার্ট অফ অ্যাকাউন্টস যোগ করেছে',
         chart_created: 'চার্ট অফ অ্যাকাউন্টস যোগ করেছে',
+        catalog_created: 'শুরুর ইউনিট, ক্যাটাগরি আর কাস্টম ফিল্ড যোগ করেছে',
       },
       auth: { signed_in: 'সাইন ইন করেছেন', switched_in: 'এই ওয়ার্কস্পেসে এসেছেন' },
       settings: { updated: 'সেটিংস বদলেছেন', logo_changed: 'লোগো বদলেছেন' },
@@ -764,6 +1070,32 @@ export const bn: Messages = {
         year_closed: 'একটা অর্থবছর ক্লোজ করেছেন',
         year_reopened: 'একটা অর্থবছর আবার খুলেছেন',
       },
+      unit: {
+        created: 'একটা ইউনিট যোগ করেছেন',
+        updated: 'একটা ইউনিট বদলেছেন',
+        archived: 'একটা ইউনিট আর্কাইভ করেছেন',
+        restored: 'একটা ইউনিট ফিরিয়ে এনেছেন',
+        deleted: 'একটা ইউনিট মুছেছেন',
+      },
+      product_category: {
+        created: 'একটা প্রোডাক্ট ক্যাটাগরি যোগ করেছেন',
+        updated: 'একটা প্রোডাক্ট ক্যাটাগরি বদলেছেন',
+        deleted: 'একটা প্রোডাক্ট ক্যাটাগরি মুছেছেন',
+      },
+      custom_field: {
+        created: 'একটা কাস্টম ফিল্ড যোগ করেছেন',
+        updated: 'একটা কাস্টম ফিল্ড বদলেছেন',
+        archived: 'একটা কাস্টম ফিল্ড আর্কাইভ করেছেন',
+        restored: 'একটা কাস্টম ফিল্ড ফিরিয়ে এনেছেন',
+      },
+      product: {
+        created: 'একটা প্রোডাক্ট যোগ করেছেন',
+        updated: 'একটা প্রোডাক্ট বদলেছেন',
+        archived: 'একটা প্রোডাক্ট আর্কাইভ করেছেন',
+        restored: 'একটা প্রোডাক্ট ফিরিয়ে এনেছেন',
+        deleted: 'একটা প্রোডাক্ট মুছেছেন',
+        imported: 'ফাইল থেকে প্রোডাক্ট ইমপোর্ট করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -797,6 +1129,24 @@ export const bn: Messages = {
       goLiveDate: 'Omnivo-তে প্রথম দিন',
       entry: 'এন্ট্রি',
       year: 'অর্থবছর',
+      type: 'ধরন',
+      category: 'ক্যাটাগরি',
+      baseUnit: 'মূল ইউনিট',
+      tracking: 'ট্র্যাকিং',
+      variants: 'ভ্যারিয়েন্ট',
+      packs: 'প্যাক',
+      dimension: 'যা মাপে',
+      ratio: 'মাপ',
+      decimals: 'দশমিক',
+      label: 'লেবেল',
+      key: 'কী',
+      required: 'বাধ্যতামূলক',
+      options: 'পছন্দ',
+      file: 'ফাইল',
+      products: 'প্রোডাক্ট',
+      units: 'ইউনিট',
+      categories: 'ক্যাটাগরি',
+      customFields: 'কাস্টম ফিল্ড',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -868,6 +1218,10 @@ export const bn: Messages = {
         ready: '{{report}} ({{format}}) ডাউনলোডের জন্য তৈরি।',
         failed: '{{report}} ({{format}}) তৈরি করা যায়নি। আবার এক্সপোর্ট করুন।',
       },
+      import: {
+        done: '{{file}}: {{count}}টা প্রোডাক্ট ইমপোর্ট হয়েছে।',
+        failed: '{{file}} ইমপোর্ট হয়নি: {{count}}টা সমস্যা ঠিক করতে হবে। কিছুই সেভ হয়নি।',
+      },
     },
   },
   errors: {
@@ -972,6 +1326,76 @@ export const bn: Messages = {
     year_earlier_open: 'আগের অর্থবছরটা আগে ক্লোজ করুন।',
     year_later_closed: 'পরের অর্থবছরটা আগে আবার খুলুন।',
     export_not_ready: 'ফাইলটা এখনো তৈরি হয়নি। নোটিফিকেশনের জন্য অপেক্ষা করে আবার চেষ্টা করুন।',
+    factor_format: '০-এর বেশি একটা সংখ্যা দিন, ৬ দশমিক পর্যন্ত, যেমন 24 বা 0.9144।',
+    unit_code_format: 'ফাঁকা ছাড়া ১২টা পর্যন্ত অক্ষর বা অঙ্ক দিন, যেমন pcs, kg বা sq.ft।',
+    unit_code_taken: 'অন্য একটা ইউনিট এই কোড ব্যবহার করছে। অন্য কোড দিন।',
+    unit_name_required: 'ইউনিটের নাম দিন।',
+    unit_in_use: 'প্রোডাক্ট এই ইউনিট ব্যবহার করছে, তাই এটা থাকবে। বরং আর্কাইভ করুন।',
+    category_name_required: 'ক্যাটাগরির নাম দিন।',
+    category_name_taken: 'এই জায়গায় এই নামে একটা ক্যাটাগরি আগেই আছে।',
+    category_parent_invalid: 'তালিকা থেকে একটা ক্যাটাগরি বাছুন, বা সবার উপরে রাখুন।',
+    category_parent_loop: 'একটা ক্যাটাগরি তার নিজের সাব-ক্যাটাগরির নিচে যেতে পারে না।',
+    category_has_children: 'আগে এর নিচের ক্যাটাগরিগুলো সরান বা মুছুন।',
+    category_in_use: 'এই ক্যাটাগরিতে প্রোডাক্ট আছে। আগে সেগুলো অন্য ক্যাটাগরিতে সরান।',
+    custom_field_key_format:
+      'ছোট হাতের ইংরেজি অক্ষর দিয়ে শুরু করুন; ছোট অক্ষর, অঙ্ক আর _ দিন, যেমন generic_name।',
+    custom_field_key_taken: 'অন্য একটা ফিল্ড এই কী ব্যবহার করছে। অন্যটা দিন।',
+    custom_field_label_required: 'সবাই যে লেবেল দেখবে সেটা দিন।',
+    custom_field_option_twice: 'এই পছন্দটা তালিকায় আগেই আছে।',
+    custom_field_options_required: 'অন্তত একটা পছন্দ যোগ করুন।',
+    custom_field_unknown: 'এই ফিল্ডটা আর ওয়ার্কস্পেসে নেই। পেজটা রিলোড করুন।',
+    number_format: 'একটা সংখ্যা দিন, যেমন 180 বা 12.5।',
+    product_code_format: 'ফাঁকা ছাড়া অক্ষর আর অঙ্ক দিন, যেমন P-00042 বা ST-2026/118।',
+    product_code_taken: 'অন্য একটা প্রোডাক্ট এই কোড ব্যবহার করছে। অন্য কোড দিন।',
+    product_sku_format: 'ফাঁকা ছাড়া অক্ষর আর অঙ্ক দিন, যেমন ST-118-M-NAVY।',
+    product_sku_taken: 'অন্য একটা প্রোডাক্ট এই SKU ব্যবহার করছে। অন্যটা দিন।',
+    product_sku_twice: 'দুটো ভ্যারিয়েন্টের একই SKU। প্রত্যেকটাকে আলাদা দিন।',
+    product_name_required: 'প্রোডাক্টের নাম দিন।',
+    product_unit_required: 'একটা ইউনিট বাছুন।',
+    product_unit_invalid: 'তালিকা থেকে একটা চালু ইউনিট বাছুন।',
+    product_unit_is_base: 'এটা তো মূল ইউনিট। প্যাকের জন্য বড় একটা ইউনিট বাছুন।',
+    product_unit_twice: 'এই ইউনিটটা তালিকায় আগেই আছে।',
+    product_default_unit_invalid: 'মূল ইউনিট বা নিচের কোনো প্যাক বাছুন।',
+    product_factor_standard: 'এই ইউনিটের মাপ নির্দিষ্ট, যেমন ১ ডজন = ১২ পিস। সেই সংখ্যাটাই দিন।',
+    product_option_name_required: 'অপশনের নাম দিন, যেমন Size বা Colour।',
+    product_option_values_required: 'অন্তত একটা মান দিন, যেমন S, M, L।',
+    product_option_twice: 'এই অপশনটা তালিকায় আগেই আছে।',
+    product_option_value_twice: 'এই মানটা তালিকায় আগেই আছে।',
+    product_variants_simple: 'অপশন ছাড়া প্রোডাক্টের ঠিক একটাই সংস্করণ থাকে।',
+    product_variant_values:
+      'এই ভ্যারিয়েন্টের মান অপশনের সাথে মেলে না। ভ্যারিয়েন্টগুলো আবার তৈরি করুন।',
+    product_variant_twice: 'দুটো ভ্যারিয়েন্টের মান একই। একটা সরান।',
+    product_variant_last_active:
+      'অন্তত একটা ভ্যারিয়েন্ট চালু রাখুন, বা পুরো প্রোডাক্ট আর্কাইভ করুন।',
+    product_variant_unknown: 'আপনি বদলানোর সময় একটা ভ্যারিয়েন্ট বদলে গেছে। পেজটা রিলোড করুন।',
+    product_variant_in_use: 'ডকুমেন্টে এই ভ্যারিয়েন্ট আছে, তাই এটা থাকবে। বরং আর্কাইভ করুন।',
+    product_pack_barcode_variants:
+      'ভ্যারিয়েন্টওয়ালা প্রোডাক্টের বারকোড থাকে ভ্যারিয়েন্টে, প্যাকে না।',
+    product_tracking_service: 'সার্ভিস স্টকে থাকে না, তাই ট্র্যাক হয় না। None বাছুন।',
+    product_expiry_needs_batch: 'মেয়াদের তারিখ রাখা হয় ব্যাচে। আগে ব্যাচ ট্র্যাকিং বাছুন।',
+    product_category_invalid: 'তালিকা থেকে একটা ক্যাটাগরি বাছুন।',
+    product_in_use: 'ডকুমেন্টে এই প্রোডাক্ট আছে, তাই এটা থাকবে। বরং আর্কাইভ করুন।',
+    barcode_format: 'ফাঁকা ছাড়া অক্ষর, অঙ্ক আর চিহ্ন দিন।',
+    barcode_check_digit: 'এই বারকোডের শেষ অঙ্কটা ভুল। প্যাকের নম্বরটা মিলিয়ে দেখুন।',
+    barcode_taken: 'অন্য একটা প্রোডাক্ট এই বারকোড ব্যবহার করছে।',
+    barcode_twice: 'এই প্রোডাক্টে বারকোডটা দুবার আছে।',
+    import_file_type: 'একটা CSV ফাইল বাছুন। Excel-এ: File → Save as → CSV UTF-8।',
+    import_not_uploaded: 'ফাইলটা পুরো আপলোড হয়নি। আবার বাছুন।',
+    import_not_pending: 'এই ফাইলের কাজ আগেই শুরু হয়েছে। কতদূর হলো দেখতে পেজটা রিলোড করুন।',
+    import_encoding:
+      'ফাইলটা CSV UTF-8 হিসেবে সেভ করুন (Excel: File → Save as → CSV UTF-8), তারপর আবার চেষ্টা করুন।',
+    import_csv_malformed: 'এই সারিতে একটা উদ্ধৃতিচিহ্ন (") বন্ধ হয়নি। " আছে এমন ঘরগুলো দেখুন।',
+    import_empty: 'ফাইলে হেডারের নিচে কোনো প্রোডাক্টের সারি নেই।',
+    import_too_many_rows: 'ফাইলে {{max}}টার বেশি সারি। ছোট কয়েকটা ফাইলে ভাগ করুন।',
+    import_column_missing: '"{{column}}" কলামটা যোগ করুন। সব কলাম দেখতে টেমপ্লেট ডাউনলোড করুন।',
+    import_column_unknown: '"{{column}}" কলামটা সরান, বা নামটা ঠিক করুন। টেমপ্লেটে সব কলাম আছে।',
+    import_row_conflict:
+      'এই সারিতে প্রোডাক্টের প্রথম সারির চেয়ে আলাদা কথা লেখা। দুটো এক করুন, বা এই ঘরটা ফাঁকা রাখুন।',
+    import_unit_unknown: '"{{value}}" নামে কোনো ইউনিট নেই। Units পেজের একটা কোড দিন।',
+    import_category_invalid: 'ক্যাটাগরি পথ হিসেবে লিখুন, যেমন Fabrics > Knit।',
+    import_value_invalid: 'এগুলোর একটা দিন: {{allowed}}।',
+    import_options_without_code:
+      'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
     version_conflict:
       'আপনি বদলানোর সময় আরেকজন পরিবর্তন সেভ করেছেন। রিলোড করে তাঁরটা দেখুন, তারপর আবার বদলান।',
```

The same keys (the `Messages` type refuses a missing or an extra one). Office words stay in English inside the Bangla:
SKU, CSV, Excel, pcs, kg, the permission keys.

```bash
pnpm --filter @omnivo/i18n build
```

---

## 12.7 — `apps/app`: the product pages

### Helpers

**File: `apps/app/src/lib/products.ts`** (new)

```ts
import {
  CUSTOM_FIELD_COLUMN_PREFIX,
  type CustomFieldDefinition,
  PRODUCT_IMPORT_COLUMNS,
  type ProductCategory,
  type ProductVariantInput,
} from '@omnivo/contracts';
import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';

// Pure helpers of the product pages, tested on their own (products.spec.ts)

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function categoryTree(categories: readonly ProductCategory[]): TreeNode<ProductCategory>[] {
  return buildTree(categories, {
    id: (category) => category.id,
    parentId: (category) => category.parentId,
    compare: (a, b) => byName.compare(a.name, b.name),
  });
}

function withoutBranch(
  nodes: readonly TreeNode<ProductCategory>[],
  id: string | undefined,
): TreeNode<ProductCategory>[] {
  return nodes.flatMap((node) =>
    node.id === id ? [] : [{ ...node, children: withoutBranch(node.children, id) }],
  );
}

// The categories in tree order, indented with em spaces for a native <select>. `moving` leaves out
// a category and everything under it: it cannot go inside itself (the API refuses that too).
export function categoryOptions(
  categories: readonly ProductCategory[],
  moving?: string,
): { value: string; label: string }[] {
  return flattenTree(withoutBranch(categoryTree(categories), moving)).map(({ node, depth }) => ({
    value: node.id,
    label: `${' '.repeat(depth)}${node.item.name}`,
  }));
}

// "Finished garments › T-shirts": where a product sits, for its row in the list
export function categoryPath(categories: readonly ProductCategory[], id: string | null): string {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const names: string[] = [];
  for (let current = id === null ? undefined : byId.get(id); current;) {
    names.unshift(current.name);
    // A broken parent chain (should never happen) must not loop forever
    if (names.length > 20) break;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return names.join(' › ');
}

// "S, M, L,, m" → ['S', 'M', 'L']: what an option's values box holds. Empty parts and repeats (in
// any case) go, like the API's rule.
export function splitValues(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      const folded = part.toLowerCase();
      if (part === '' || seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
}

// Every combination of the options' values, in order: Size × Colour = S-Navy, S-White, M-Navy …
export function combinations(options: readonly { values: readonly string[] }[]): string[][] {
  return options.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])),
    [[]],
  );
}

// A field of one row of a react-hook-form field array: rowPath('units', 2, 'factor') →
// "units.2.factor". react-hook-form types it `units.${number}.factor`. The lint rule
// restrict-template-expressions wants String(index) in a template, which gives `${string}`, which
// react-hook-form does not accept. The one cast says only "this text was made from a number" —
// String(index) makes sure of it. Kept in this one place (CLAUDE.md rule 3), like journal.ts's
// linePath.
export function rowPath<A extends string, F extends string>(
  array: A,
  index: number,
  field: F,
): `${A}.${number}.${F}` {
  return `${array}.${String(index)}.${field}` as `${A}.${number}.${F}`;
}

// "0.914400" → "0.9144", "12.000000" → "12": a size as people write it
export function plainFactor(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function emptyVariant(optionValues: string[] = []): ProductVariantInput {
  return { id: null, sku: '', optionValues, barcode: '', salePrice: '', archived: false };
}

// The variants after the options changed: one per combination, in the options' order. A variant
// whose values still exist keeps everything (its id, SKU, barcode, price). The one variant of a
// product that was simple until now takes the first combination, so its id — and from step 13 its
// stock — carries over. Variants whose values no longer exist are left out.
export function syncVariants(
  options: readonly { values: readonly string[] }[],
  current: readonly ProductVariantInput[],
): ProductVariantInput[] {
  const key = (values: readonly string[]) => JSON.stringify(values);
  const byValues = new Map(current.map((variant) => [key(variant.optionValues), variant]));
  let former = current.find((variant) => variant.optionValues.length === 0);
  return combinations(options).map((values) => {
    const kept = byValues.get(key(values));
    if (kept) return kept;
    if (former) {
      const taken = { ...former, optionValues: values };
      former = undefined;
      return taken;
    }
    return emptyVariant(values);
  });
}

// One CSV cell: quoted when it holds a comma, a quote or a line break (RFC 4180)
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// The import template: every column, the workspace's own fields at the end, and two example
// products — a simple one with packs, and one in two sizes (rows with the same code)
export function importTemplate(fields: readonly CustomFieldDefinition[]): string {
  const custom = fields
    .filter((field) => field.archivedAt === null)
    .map((field) => `${CUSTOM_FIELD_COLUMN_PREFIX}${field.key}`);
  const header = [...PRODUCT_IMPORT_COLUMNS, ...custom];
  // Record<string, …>: the header holds the custom columns too, which no example fills
  const example = (cells: Record<string, string>) =>
    header.map((column) => csvCell(cells[column] ?? ''));
  const rows = [
    header,
    example({
      name: 'Poly mailer bag 10x14',
      unit: 'pcs',
      sale_price: '6',
      pack1_unit: 'carton',
      pack1_factor: '500',
      purchase_unit: 'carton',
    }),
    example({
      code: 'ST-118',
      name: 'Pique polo shirt',
      category: 'Finished garments > Polo shirts',
      unit: 'pcs',
      option1_name: 'Size',
      option1_value: 'M',
      sale_price: '650',
    }),
    example({ code: 'ST-118', option1_value: 'L', sale_price: '650' }),
  ];
  // CRLF, and a BOM so Excel opens the Bangla in it as UTF-8
  return `\uFEFF${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}
```

- **`categoryOptions()`** indents with em spaces, because a native `<select>` shows plain text only (the chart's
  `groupOptions()` does the same). `moving` leaves out a category and its whole branch: it cannot go inside itself.
- **`categoryPath()`** writes "Finished garments › T-shirts" for a row of the list. The `> 20` stop is a guard: a broken
  parent chain must never hang the page.
- **`splitValues()`** reads an option's values box like the API counts values: empty parts and repeats in any case go.
- **`combinations()`** is the cartesian product of the options, first option first: S-Navy, S-White, M-Navy…
- **`rowPath()`**: react-hook-form types a row's field as `` `units.${number}.factor` ``. The lint rule
  `restrict-template-expressions` wants `String(index)` inside a template, which gives `` `${string}` ``, which
  react-hook-form refuses. The one cast says only "this text was made from a number"; it lives here, once (CLAUDE.md
  rule 3), like the journal's `linePath()`.
- **`plainFactor()`**: the database sends `12.000000`; a person reads `12`.
- **`syncVariants()`** is what "Create the variants" does. A variant whose values still exist keeps everything (id, SKU,
  barcode, price). The one variant of a product that was simple until now takes the first combination, so its id —
  and from step 13 its stock — carries over (decision 1). Variants whose values no longer exist are left out.
- **`importTemplate()`** writes the template: every column, the workspace's active custom fields at the end, and two
  example products — a simple one with a pack, and one style in two sizes (two rows, one code). Cells with a comma, a
  quote or a line break are quoted (RFC 4180). CRLF line ends and a byte order mark, so Excel on Windows opens it as
  UTF-8 and the Bangla stays readable.

**File: `apps/app/src/lib/products.spec.ts`** (new)

```ts
import type { ProductCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  categoryOptions,
  categoryPath,
  combinations,
  emptyVariant,
  importTemplate,
  splitValues,
  syncVariants,
} from './products';

function category(id: string, name: string, parentId: string | null = null): ProductCategory {
  return { id, parentId, name, productCount: 0, version: 1, updatedAt: '2026-10-04T00:00:00.000Z' };
}

const categories = [
  category('c2', 'Fabrics'),
  category('c1', 'Finished garments'),
  category('c3', 'T-shirts', 'c1'),
  category('c4', 'Polo shirts', 'c1'),
];

describe('categories', () => {
  it('lists them in tree order, indented, without the one being moved', () => {
    expect(categoryOptions(categories).map((option) => option.label)).toEqual([
      'Fabrics',
      'Finished garments',
      ' Polo shirts',
      ' T-shirts',
    ]);
    expect(categoryOptions(categories, 'c1').map((option) => option.value)).toEqual(['c2']);
  });

  it('writes where a category sits', () => {
    expect(categoryPath(categories, 'c3')).toBe('Finished garments › T-shirts');
    expect(categoryPath(categories, null)).toBe('');
  });
});

describe('options and variants', () => {
  it('reads a values box like the API counts values', () => {
    expect(splitValues(' S, M ,, L, m ,XL ')).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('makes every combination, first option first', () => {
    expect(combinations([{ values: ['S', 'M'] }, { values: ['Navy', 'White'] }])).toEqual([
      ['S', 'Navy'],
      ['S', 'White'],
      ['M', 'Navy'],
      ['M', 'White'],
    ]);
    expect(combinations([])).toEqual([[]]);
  });

  it('keeps what a variant holds when the options change', () => {
    const small = { ...emptyVariant(['S']), id: 'v-s', salePrice: '600' };
    const large = { ...emptyVariant(['L']), id: 'v-l' };
    const next = syncVariants([{ values: ['S', 'M'] }], [small, large]);
    expect(next.map((variant) => [variant.id, variant.optionValues])).toEqual([
      ['v-s', ['S']],
      [null, ['M']],
    ]);
    expect(next[0]?.salePrice).toBe('600');
  });

  it('lets a simple product’s one variant become the first combination', () => {
    const only = { ...emptyVariant(), id: 'v-1', barcode: '8941100500118' };
    const next = syncVariants([{ values: ['M', 'L'] }], [only]);
    expect(next.map((variant) => [variant.id, variant.optionValues, variant.barcode])).toEqual([
      ['v-1', ['M'], '8941100500118'],
      [null, ['L'], ''],
    ]);
  });
});

describe('the import template', () => {
  it('has every column, the active custom fields, and quotes what needs quoting', () => {
    const text = importTemplate([
      {
        id: 'f1',
        entity: 'product',
        key: 'gsm',
        label: 'GSM',
        type: 'number',
        options: [],
        required: false,
        archivedAt: null,
        version: 1,
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
      {
        id: 'f2',
        entity: 'product',
        key: 'season',
        label: 'Season',
        type: 'text',
        options: [],
        required: false,
        archivedAt: '2026-10-04T00:00:00.000Z',
        version: 2,
        updatedAt: '2026-10-04T00:00:00.000Z',
      },
    ]);
    const [header, ...rows] = text.replace('\uFEFF', '').trim().split('\r\n');
    expect(header?.startsWith('code,name,type,category,unit')).toBe(true);
    expect(header?.endsWith(',description,cf_gsm')).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('Finished garments > Polo shirts');
  });
});
```

**File: `apps/app/src/lib/queries.ts`** (change)

```diff
@@ -3,6 +3,8 @@ import {
   type BranchStatus,
   type JournalStatus,
   type MemberSort,
+  type ProductSort,
+  type ProductStatus,
   type ProfitAndLossQuery,
   routes,
   type TrialBalanceQuery,
@@ -218,3 +220,88 @@ export function reportExportsQuery(tenantId: string) {
       query.state.data?.some((item) => item.status === 'pending') ? 2_000 : false,
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// Products (step 12). Everything starts with ['products', tenantId]: saving a unit, a category or a
+// product refreshes every product page with one invalidate.
+
+// Small lists, read whole. While the catalog job of an older workspace has not run yet, the units
+// are empty: ask again every 3 seconds until they arrive, like the chart of accounts.
+export function unitsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'units'],
+    queryFn: async () => (await call(routes.units.list)).items,
+    refetchInterval: (query) => (query.state.data?.length === 0 ? 3_000 : false),
+  });
+}
+
+export function productCategoriesQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'categories'],
+    queryFn: async () => (await call(routes.productCategories.list)).items,
+  });
+}
+
+export function productFieldsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'custom-fields'],
+    queryFn: async () =>
+      (await call(routes.customFields.list, { query: { entity: 'product' } })).items,
+  });
+}
+
+export interface ProductFilter {
+  search: string;
+  categoryId: string;
+  status: ProductStatus;
+  sort: ProductSort;
+}
+
+// The list, 50 at a time; the server searches, filters and sorts (10,000 products never come to
+// the browser at once)
+export function productListQuery(tenantId: string, filter: ProductFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['products', tenantId, 'list', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.products.list, {
+        query: {
+          limit: 50,
+          status: filter.status,
+          sort: filter.sort,
+          ...(filter.search !== '' && { search: filter.search }),
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
+export function productQuery(tenantId: string, productId: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'product', productId],
+    queryFn: () => call(routes.products.get, { params: { id: productId } }),
+    retry: false,
+  });
+}
+
+// The imports, polled every 2 seconds while one is still on its way (like the exports)
+export function productImportsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'imports'],
+    queryFn: async () => (await call(routes.productImports.list, { query: { limit: 50 } })).items,
+    refetchInterval: (query) =>
+      query.state.data?.some((item) => item.status === 'uploading' || item.status === 'queued')
+        ? 2_000
+        : false,
+  });
+}
+
+export function productImportQuery(tenantId: string, importId: string) {
+  return queryOptions({
+    queryKey: ['products', tenantId, 'imports', importId],
+    queryFn: () => call(routes.productImports.get, { params: { id: importId } }),
+  });
+}
```

- **Every key starts with `['products', tenantId]`**: saving a unit, a category, a field or a product refreshes every
  product page with one invalidate.
- **`unitsQuery` polls while the list is empty**: an older workspace's catalog job may not have run yet, like the
  chart's backfill in step 9.
- **`productListQuery`** asks 50 at a time; the server searches, filters and sorts, so 10,000 products never come to
  the browser at once. `keepPreviousData` keeps the old rows on screen while a new search loads.
- **`productImportsQuery` polls every 2 seconds** while an import is uploading or queued, and stops by itself.

### The first page load (decision 15)

**File: `apps/app/src/lib/api.ts`** (change)

```diff
@@ -1,5 +1,6 @@
 import {
   type AuthSession,
+  authRoutes,
   buildPath,
   type ErrorCode,
   isErrorCode,
@@ -8,12 +9,14 @@ import {
   type RouteDef,
   type RouteRequest,
   type RouteResult,
-  routes,
 } from '@omnivo/contracts';
 import type { z } from 'zod';
 
 import { sessionStore } from './session-store';
 
+// authRoutes, not the whole `routes` map: this file is in the first page load, and `routes` holds
+// every module's schemas. Pages import `routes` themselves, in their own lazy chunks.
+
 export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
 
 // API-র যেকোনো ব্যর্থতা এই এক আকারে — সার্ভারের problem, নেটওয়ার্ক বন্ধ, বা চুক্তি-ভাঙা উত্তর
@@ -110,9 +113,9 @@ export function refreshSession(): Promise<AuthSession | null> {
     // Web Locks: একই ব্রাউজারের একাধিক ট্যাবও একটার পর একটা refresh করবে, একসাথে না।
     // call() না, send() — call() নিজেই 401-এ refresh ডাকে, lock-এর ভেতর থেকে সেটা আটকে যেত
     .request('omnivo-refresh', async () => {
-      const response = await send(routes.auth.refresh, {}, null);
+      const response = await send(authRoutes.refresh, {}, null);
       if (!response.ok) return null;
-      return read(routes.auth.refresh, response);
+      return read(authRoutes.refresh, response);
     })
     .finally(() => {
       refreshInFlight = null;
```

**File: `apps/app/src/lib/session.ts`** (change)

```diff
@@ -1,8 +1,11 @@
+// The route groups by name, not the whole `routes` map: this file is in the first page load, and
+// `routes` would bring every module's schemas into it (step 12 found the first load over budget)
 import {
   type AcceptInvitationInput,
   type AuthSession,
+  authRoutes,
+  invitationRoutes,
   type LoginInput,
-  routes,
   type SignUpInput,
 } from '@omnivo/contracts';
 
@@ -13,7 +16,7 @@ import { sessionStore } from './session-store';
 
 async function startSession(session: AuthSession): Promise<void> {
   sessionStore.getState().setAccessToken(session.accessToken);
-  const me = await call(routes.auth.me);
+  const me = await call(authRoutes.me);
   // আগের ইউজার বা workspace-এর ক্যাশ করা ডেটা (টিম, ইনভয়েস) নতুন session-এ এক মুহূর্তের জন্যও
   // দেখা যাবে না — signIn-এর আগে মোছা, তাই নতুন পেজ খালি ক্যাশ থেকে আনে
   queryClient.clear();
@@ -24,7 +27,7 @@ async function startSession(session: AuthSession): Promise<void> {
 
 // কোম্পানির নাম বদলানোর পরে switcher আর সাইডবারে নতুন নাম
 export async function refreshMe(): Promise<void> {
-  sessionStore.getState().setMe(await call(routes.auth.me));
+  sessionStore.getState().setMe(await call(authRoutes.me));
 }
 
 // পেজ reload-এ memory-র টোকেন হারায়; httpOnly cookie দিয়ে নতুন টোকেন আনা।
@@ -49,26 +52,26 @@ export function restoreSession(): Promise<void> {
 }
 
 export async function login(input: LoginInput): Promise<void> {
-  await startSession(await call(routes.auth.login, { body: input }));
+  await startSession(await call(authRoutes.login, { body: input }));
 }
 
 export async function signUp(input: SignUpInput): Promise<void> {
-  await startSession(await call(routes.auth.signUp, { body: input }));
+  await startSession(await call(authRoutes.signUp, { body: input }));
 }
 
 // invitation গ্রহণ = লগইন: উত্তরে একই session, আর সেই workspace-এ। আগে অন্য অ্যাকাউন্টে লগইন থাকলে
 // startSession সেটার ক্যাশ মুছে নতুনটা বসায়
 export async function acceptInvitation(input: AcceptInvitationInput): Promise<void> {
-  await startSession(await call(routes.invitations.accept, { body: input }));
+  await startSession(await call(invitationRoutes.accept, { body: input }));
 }
 
 export async function switchTenant(tenantId: string): Promise<void> {
-  await startSession(await call(routes.auth.switchTenant, { body: { tenantId } }));
+  await startSession(await call(authRoutes.switchTenant, { body: { tenantId } }));
 }
 
 export async function logout(): Promise<void> {
   try {
-    await call(routes.auth.logout);
+    await call(authRoutes.logout);
   } finally {
     // নেটওয়ার্ক ব্যর্থ হলেও এই ট্যাবে লগআউট দেখাতে হবে, আর আগের ইউজারের ক্যাশ মুছতে হবে
     queryClient.clear();
```

**File: `apps/app/src/lib/preferences.ts`** (change)

```diff
@@ -1,4 +1,4 @@
-import { type Preferences, routes, type UpdatePreferencesInput } from '@omnivo/contracts';
+import { meRoutes, type Preferences, type UpdatePreferencesInput } from '@omnivo/contracts';
 import { i18n, setLanguage } from '@omnivo/i18n';
 import { toast } from '@omnivo/ui';
 
@@ -19,7 +19,7 @@ export async function savePreference(input: UpdatePreferencesInput): Promise<voi
   if (input.theme !== undefined) applyTheme(input.theme);
   if (input.language !== undefined) await setLanguage(input.language);
   try {
-    const preferences = await call(routes.me.updatePreferences, { body: input });
+    const preferences = await call(meRoutes.updatePreferences, { body: input });
     const me = sessionStore.getState().me;
     if (me) sessionStore.getState().setMe({ ...me, preferences });
   } catch {
```

These three files are in the first page load (the login page needs them). Each used to import the whole `routes` map,
and `routes` holds every module's schemas — so every new module made the first load bigger. With this step's schemas
it went to 201.3 KB, over the 200 KB budget. Importing the three route groups by name lets the bundler leave the rest
out: the first load is 192.2 KB again, and the other schemas move into the pages' own chunks. The rule for later steps:
a file in the first load imports a route group, never `routes`.

### Routes and navigation

**File: `apps/app/src/router.tsx`** (change)

```diff
@@ -187,6 +187,53 @@ const reportExportsRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/report-exports'), 'ReportExportsPage'),
 });
 
+// Products (step 12). '/products/new', '/products/categories', '/products/units' and
+// '/products/imports' beat '/products/$productId': a fixed segment ranks above a parameter.
+const productsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/products',
+  component: lazyRouteComponent(() => import('./routes/products'), 'ProductsPage'),
+});
+
+const newProductRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/products/new',
+  component: lazyRouteComponent(() => import('./routes/product'), 'NewProductPage'),
+});
+
+const productRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/products/$productId',
+  component: lazyRouteComponent(() => import('./routes/product'), 'ProductPage'),
+});
+
+const productCategoriesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/products/categories',
+  component: lazyRouteComponent(
+    () => import('./routes/product-categories'),
+    'ProductCategoriesPage',
+  ),
+});
+
+const unitsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/products/units',
+  component: lazyRouteComponent(() => import('./routes/units'), 'UnitsPage'),
+});
+
+const productImportsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/products/imports',
+  component: lazyRouteComponent(() => import('./routes/product-imports'), 'ProductImportsPage'),
+});
+
+const customFieldsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/custom-fields',
+  component: lazyRouteComponent(() => import('./routes/custom-fields'), 'CustomFieldsPage'),
+});
+
 const teamRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/team',
@@ -238,6 +285,13 @@ const routeTree = rootRoute.addChildren([
     profitAndLossRoute,
     balanceSheetRoute,
     reportExportsRoute,
+    productsRoute,
+    newProductRoute,
+    productRoute,
+    productCategoriesRoute,
+    unitsRoute,
+    productImportsRoute,
+    customFieldsRoute,
     teamRoute,
     rolesRoute,
     auditLogRoute,
```

`/products/new`, `/products/categories`, `/products/units` and `/products/imports` all beat `/products/$productId`:
TanStack Router ranks a fixed segment above a parameter, so "new" is never read as a product id.

**File: `apps/app/src/routes/app-shell.tsx`** (change)

```diff
@@ -6,15 +6,20 @@ import {
   ChartIncreaseIcon,
   DashboardSquare01Icon,
   FileDownloadIcon,
+  FileImportIcon,
+  FolderTreeIcon,
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
   Notebook02Icon,
+  PackageIcon,
   PieChartIcon,
+  RulerIcon,
   SecurityCheckIcon,
   Settings02Icon,
   Store01Icon,
   TableIcon,
+  TextIcon,
   UnfoldMoreIcon,
   UserCircleIcon,
   UserGroupIcon,
@@ -278,6 +283,24 @@ export function AppShell() {
               </NavLink>
             </NavGroup>
           )}
+          {/* Every member reads products (every sales and stock line picks one); imports change
+              them, so only managers see that page */}
+          <NavGroup label={t('nav.inventory')}>
+            <NavLink to="/products" icon={PackageIcon} activeOptions={{ exact: true }}>
+              {t('nav.products')}
+            </NavLink>
+            <NavLink to="/products/categories" icon={FolderTreeIcon}>
+              {t('nav.categories')}
+            </NavLink>
+            <NavLink to="/products/units" icon={RulerIcon}>
+              {t('nav.units')}
+            </NavLink>
+            {can('inventory.product.manage') && (
+              <NavLink to="/products/imports" icon={FileImportIcon}>
+                {t('nav.productImports')}
+              </NavLink>
+            )}
+          </NavGroup>
           <NavGroup label={t('nav.workspace')}>
             {(can('core.user.read') || can('core.user.invite')) && (
               <NavLink to="/team" icon={UserGroupIcon}>
@@ -289,6 +312,9 @@ export function AppShell() {
                 {t('nav.roles')}
               </NavLink>
             )}
+            <NavLink to="/custom-fields" icon={TextIcon}>
+              {t('nav.customFields')}
+            </NavLink>
             <NavLink to="/branches" icon={Store01Icon}>
               {t('nav.branches')}
             </NavLink>
```

- **A new nav group "Inventory".** Products, Categories and Units are for every member (they read them); Imports only
  for people who can manage products.
- **`activeOptions={{ exact: true }}` on Products**: without it, `/products` is a prefix of `/products/units`, and
  both items would look active.
- **Custom fields** sit in the Workspace group, next to the settings they are part of.

**File: `apps/app/src/components/notification-bell.tsx`** (change)

```diff
@@ -28,6 +28,8 @@ const TARGET = {
   'invitation.failed': '/team',
   'report.ready': '/reports/exports',
   'report.failed': '/reports/exports',
+  'import.done': '/products/imports',
+  'import.failed': '/products/imports',
 } as const satisfies Record<NotificationType, string>;
 
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
```

A click on "import done/failed" opens the import page. `TARGET` is `satisfies Record<NotificationType, …>`: a new type
without a page does not compile.

### The pages

**File: `apps/app/src/routes/units.tsx`** (new)

```tsx
import { Archive02Icon, PlusSignIcon, RulerIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createUnitInputSchema,
  isUnitDimension,
  routes,
  type Unit,
  UNIT_DIMENSIONS,
  type UnitDimension,
  updateUnitInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  PageHeader,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { plainFactor } from '../lib/products';
import { unitsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<Unit>();
const CREATE_FIELDS = createUnitInputSchema.keyof().options;
const UPDATE_FIELDS = updateUnitInputSchema.keyof().options;
const DECIMALS = [0, 1, 2, 3, 4] as const;

function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  // ['products', tenantId]: the product pages show unit codes too
  return () => queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
}

// "1 yard = 0.9144 m", or "Pack, size set per product"
function SizeLine({ unit }: { unit: Unit }) {
  const { t } = useLocale();
  if (unit.ratio === null || !isUnitDimension(unit.dimension)) return <>{t('units.pack')}</>;
  return (
    <span className="tabular-nums">
      {t('units.sizeLine', {
        code: unit.code,
        ratio: plainFactor(unit.ratio),
        reference: t(`units.references.${unit.dimension}`),
      })}
    </span>
  );
}

function NewUnitForm({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createUnitInputSchema, { error: contractErrorMap }),
    defaultValues: { code: '', name: '', dimension: 'count', ratio: '', decimals: 0 },
  });
  const dimension: UnitDimension = useWatch({ control, name: 'dimension' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.units.create, { body: values });
      await refresh();
      toast(t('units.created', { code: saved.code }));
      onDone();
    } catch (error) {
      applyApiError(error, CREATE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('units.newTitle')}
      description={t('units.fixed')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="unit-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('units.add')}
          </Button>
        </>
      }
    >
      <form
        id="unit-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('units.code')}
            hint={t('units.codeHint')}
            spellCheck={false}
            placeholder="pcs"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('units.name')}
            placeholder={t('units.namePlaceholder')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <SelectField
          label={t('units.dimension')}
          options={UNIT_DIMENSIONS.map((value) => ({
            value,
            label: t(`units.dimensions.${value}`),
          }))}
          {...register('dimension')}
          error={errors.dimension?.message}
        />
        <TextField
          label={t('units.ratio')}
          optional
          inputMode="decimal"
          hint={t('units.ratioHint', { reference: t(`units.references.${dimension}`) })}
          suffix={t(`units.references.${dimension}`)}
          {...register('ratio')}
          error={errors.ratio?.message}
        />
        <SelectField
          label={t('units.decimals')}
          hint={t('units.decimalsHint')}
          options={DECIMALS.map((value) => ({ value: String(value), label: String(value) }))}
          {...register('decimals', { valueAsNumber: true })}
          error={errors.decimals?.message}
        />
      </form>
    </DialogContent>
  );
}

function EditUnitForm({ unit, onDone }: { unit: Unit; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateUnitInputSchema, { error: contractErrorMap }),
    defaultValues: {
      code: unit.code,
      name: unit.name,
      decimals: unit.decimals,
      version: unit.version,
    },
  });

  const toggle = useMutation({
    mutationFn: () =>
      call(unit.archivedAt === null ? routes.units.archive : routes.units.restore, {
        params: { id: unit.id },
        body: { version: unit.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'units.restoredToast' : 'units.archivedToast', {
          code: saved.code,
        }),
      );
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.units.remove, { params: { id: unit.id }, query: { version: unit.version } }),
    onSuccess: async () => {
      await refresh();
      toast(t('units.deleted', { code: unit.code }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.units.update, { params: { id: unit.id }, body: values });
      await refresh();
      toast(t('units.updated', { code: saved.code }));
      onDone();
    } catch (error) {
      applyApiError(error, UPDATE_FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ?? failureOf(toggle.error) ?? failureOf(remove.error);
  const busy = toggle.isPending || remove.isPending;

  return (
    <DialogContent
      title={t('units.editTitle', { code: unit.code })}
      footer={
        <>
          <div className="mr-auto flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                toggle.mutate();
              }}
            >
              {unit.archivedAt === null ? t('units.archive') : t('units.restore')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (confirming) remove.mutate();
                else setConfirming(true);
              }}
            >
              {confirming ? t('units.confirmDelete', { code: unit.code }) : t('units.delete')}
            </Button>
          </div>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="unit-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="unit-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('units.deleteWarning')}</p>}
        <p className="text-label text-ink-3">
          {isUnitDimension(unit.dimension)
            ? t(`units.dimensions.${unit.dimension}`)
            : unit.dimension}
          {' · '}
          <SizeLine unit={unit} />
        </p>
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('units.code')}
            spellCheck={false}
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField label={t('units.name')} {...register('name')} error={errors.name?.message} />
        </div>
        <SelectField
          label={t('units.decimals')}
          hint={t('units.decimalsHint')}
          options={DECIMALS.map((value) => ({ value: String(value), label: String(value) }))}
          {...register('decimals', { valueAsNumber: true })}
          error={errors.decimals?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | { kind: 'new' } | { kind: 'edit'; unit: Unit };

export function UnitsPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('inventory.product.manage');
  const { data: units, isError } = useQuery(unitsQuery(tenantId));
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const visible = useMemo(
    () => units?.filter((unit) => showArchived || unit.archivedAt === null),
    [units, showArchived],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('code', {
          header: t('units.columns.unit'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono text-body-sm font-medium">{row.original.code}</span>
              <span className="text-caption text-ink-3">{row.original.name}</span>
            </span>
          ),
        }),
        column.accessor('dimension', {
          header: t('units.columns.measures'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const dimension = getValue();
            return isUnitDimension(dimension) ? t(`units.dimensions.${dimension}`) : dimension;
          },
        }),
        column.accessor((unit) => unit.ratio ?? '', {
          id: 'size',
          header: t('units.columns.size'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => <SizeLine unit={row.original} />,
        }),
        column.accessor('decimals', {
          header: t('units.columns.decimals'),
          meta: { align: 'end', card: 'detail' },
        }),
        column.accessor((unit) => unit.archivedAt ?? '', {
          id: 'archived',
          header: '',
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) =>
            row.original.archivedAt !== null && (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('units.archived')}
              </Pill>
            ),
        }),
      ]),
    [t],
  );

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('units.title')}
        description={t('units.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing({ kind: 'new' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('units.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!canManage ? <p className="text-body-sm text-ink-3">{t('units.readOnly')}</p> : <span />}
        <Checkbox
          id="units-show-archived"
          label={t('units.showArchived')}
          checked={showArchived}
          onCheckedChange={(checked) => {
            setShowArchived(checked === true);
          }}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('units.loadFailed')}</p>}
      {visible && (
        <DataTable
          label={t('units.title')}
          data={visible}
          columns={columns}
          getRowId={(unit) => unit.id}
          // A few dozen units: the whole list on the page, no scroll box inside it
          maxHeight={2000}
          onRowClick={
            canManage
              ? (unit) => {
                  setEditing({ kind: 'edit', unit });
                }
              : undefined
          }
          empty={
            <EmptyState
              icon={RulerIcon}
              title={t('units.emptyTitle')}
              description={t('units.emptyBody')}
            />
          }
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing?.kind === 'new' && (
          <NewUnitForm
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {editing?.kind === 'edit' && (
          <EditUnitForm
            key={editing.unit.id}
            unit={editing.unit}
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

- **`SizeLine`** writes "1 yard = 0.9144 m", or "Pack, size set per product" when the unit has no ratio.
- **`NewUnitForm`** shows the dimension's reference unit as the size box's suffix, and the hint names it ("How many
  m one is"), so the person knows what number to type.
- **`EditUnitForm`** shows the dimension and the size as text, not as boxes: they are fixed (decision 2).
- **`register('decimals', { valueAsNumber: true })`**: the select gives a string, the schema wants a number.
- **`maxHeight={2000}`** on the table: a few dozen units fit on the page, and a scroll box inside the page would only
  hide the last rows (the first screenshot showed it).
- **`useRefresh()` invalidates `['products', tenantId]`**, because the product pages show unit codes too.

**File: `apps/app/src/routes/product-categories.tsx`** (new)

```tsx
import {
  FolderTreeIcon,
  PlusSignIcon,
  Search01Icon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createProductCategoryInputSchema,
  type ProductCategory,
  routes,
  updateProductCategoryInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  filterTree,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
  TreeList,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { categoryOptions, categoryTree } from '../lib/products';
import { productCategoriesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const FIELDS = updateProductCategoryInputSchema.keyof().options;

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
}

// One form for both: a new category (no `category`) or an existing one. The parent select leaves
// out the category itself and everything under it — it cannot go inside itself.
function CategoryForm({
  categories,
  category,
  parentId,
  onDone,
}: {
  categories: ProductCategory[];
  category: ProductCategory | null;
  parentId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const parents = useMemo(
    () => [
      { value: '', label: t('categories.topLevel') },
      ...categoryOptions(categories, category?.id),
    ],
    [categories, category, t],
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateProductCategoryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId: category ? (category.parentId ?? '') : parentId,
      name: category?.name ?? '',
      // A new category has no version; 1 passes the schema, and the create route never reads it
      version: category?.version ?? 1,
    },
  });

  const remove = useMutation({
    mutationFn: (target: ProductCategory) =>
      call(routes.productCategories.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('categories.deleted', { name: category?.name ?? '' }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = category
        ? await call(routes.productCategories.update, {
            params: { id: category.id },
            body: { ...fields, version },
          })
        : await call(routes.productCategories.create, {
            body: createProductCategoryInputSchema.parse(fields),
          });
      await refresh();
      toast(t(category ? 'categories.updated' : 'categories.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ??
    (remove.error instanceof ApiRequestError
      ? remove.error.code
      : remove.error
        ? 'unknown_error'
        : undefined);

  return (
    <DialogContent
      title={
        category ? t('categories.editTitle', { name: category.name }) : t('categories.newTitle')
      }
      footer={
        <>
          {category && (
            <div className="mr-auto flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirming) remove.mutate(category);
                  else setConfirming(true);
                }}
              >
                {confirming
                  ? t('categories.confirmDelete', { name: category.name })
                  : t('categories.delete')}
              </Button>
            </div>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="category-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : category ? t('common.save') : t('categories.add')}
          </Button>
        </>
      }
    >
      <form
        id="category-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('categories.deleteWarning')}</p>}
        <SelectField
          label={t('categories.parent')}
          options={parents}
          {...register('parentId')}
          error={errors.parentId?.message}
        />
        <TextField
          label={t('categories.name')}
          placeholder={t('categories.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

function CategoryRow({
  category,
  canManage,
  onOpen,
  onAdd,
}: {
  category: ProductCategory;
  canManage: boolean;
  onOpen: (category: ProductCategory) => void;
  onAdd: (parent: ProductCategory) => void;
}) {
  const { t, format } = useLocale();
  const nameClass = 'min-w-0 truncate text-left text-body-sm font-medium text-ink';
  return (
    <>
      {canManage ? (
        <button
          type="button"
          onClick={() => {
            onOpen(category);
          }}
          className={cn(nameClass, 'underline-offset-3 hover:underline')}
        >
          {category.name}
        </button>
      ) : (
        <span className={nameClass}>{category.name}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {category.productCount > 0 && (
          <span className="text-caption text-ink-3 tabular-nums">
            {t('categories.productCount', {
              count: category.productCount,
              formatted: format.number(category.productCount),
            })}
          </span>
        )}
        {canManage && (
          <IconButton
            icon={PlusSignIcon}
            label={t('categories.addTo', { name: category.name })}
            // CLAUDE.md → Tree list: shown on hover or focus with a mouse, always on touch screens
            className="-my-1 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
            onClick={() => {
              onAdd(category);
            }}
          />
        )}
      </span>
    </>
  );
}

type Editing =
  null | { kind: 'new'; parentId: string } | { kind: 'edit'; category: ProductCategory };

export function ProductCategoriesPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('inventory.product.manage');
  const { data: categories, isError } = useQuery(productCategoriesQuery(tenantId));
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const query = search.trim().toLowerCase();

  const tree = useMemo(() => {
    const full = categoryTree(categories ?? []);
    return query === ''
      ? full
      : filterTree(full, (category) => category.name.toLowerCase().includes(query));
  }, [categories, query]);

  const isOpen = useCallback(
    (id: string) => query !== '' || !collapsed.has(id),
    [query, collapsed],
  );
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const open = useCallback((category: ProductCategory) => {
    setEditing({ kind: 'edit', category });
  }, []);
  const add = useCallback((parent: ProductCategory) => {
    setEditing({ kind: 'new', parentId: parent.id });
  }, []);

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('categories.title')}
        description={t('categories.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing({ kind: 'new', parentId: '' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('categories.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('categories.searchLabel')}
            placeholder={t('categories.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set());
            }}
          >
            <HugeiconsIcon icon={UnfoldMoreIcon} size={16} strokeWidth={1.5} />
            {t('categories.expandAll')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set(categories?.map((category) => category.id)));
            }}
          >
            <HugeiconsIcon icon={UnfoldLessIcon} size={16} strokeWidth={1.5} />
            {t('categories.collapseAll')}
          </Button>
        </div>
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('categories.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('categories.loadFailed')}</p>}
      {categories?.length === 0 && (
        <EmptyState
          icon={FolderTreeIcon}
          title={t('categories.emptyTitle')}
          description={t('categories.emptyBody')}
        />
      )}
      {categories && categories.length > 0 && tree.length === 0 && (
        <EmptyState
          icon={Search01Icon}
          title={t('categories.noMatchTitle', { query: search.trim() })}
          description={t('categories.noMatchBody')}
        />
      )}
      {tree.length > 0 && (
        <TreeList
          label={t('categories.title')}
          nodes={tree}
          isOpen={isOpen}
          onToggle={toggle}
          toggleLabel={(category, shown) =>
            t(shown ? 'categories.collapse' : 'categories.expand', { name: category.name })
          }
          renderRow={(category) => (
            <CategoryRow category={category} canManage={canManage} onOpen={open} onAdd={add} />
          )}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(shown) => {
          if (!shown) setEditing(null);
        }}
      >
        {categories && editing !== null && (
          <CategoryForm
            key={editing.kind === 'edit' ? editing.category.id : `new-${editing.parentId}`}
            categories={categories}
            category={editing.kind === 'edit' ? editing.category : null}
            parentId={editing.kind === 'new' ? editing.parentId : ''}
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

The chart of accounts' page, made simpler: one form for new and existing categories, the `TreeList` with an "add a
category here" button per row (visible on hover or focus with a mouse, always on touch screens — CLAUDE.md → Tree
list), the search that keeps the groups on the way to a match open, and the product count per row in the reader's
digits.

**File: `apps/app/src/routes/custom-fields.tsx`** (new)

```tsx
import {
  Archive02Icon,
  PlusSignIcon,
  TextIcon,
  CheckmarkCircle02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createCustomFieldInputSchema,
  CUSTOM_FIELD_COLUMN_PREFIX,
  CUSTOM_FIELD_TYPES,
  type CustomFieldDefinition,
  errorCode,
  isCustomFieldType,
  routes,
  updateCustomFieldInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  PageHeader,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { productFieldsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<CustomFieldDefinition>();

// The choices are typed one per line in a text area; the API takes a list. Blank lines are
// dropped here, so a trailing Enter never becomes an empty choice.
function choicesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// "Generic name" → "generic_name": a key suggested from the label while the key was not typed
// by hand. Letters outside a–z (a Bangla label) leave nothing to suggest; the person types it.
function keyOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);
}

// The form's own shape: the choices as one text. Built from the contract's shape (not .extend():
// the contract's rule "a select needs a choice" is a refinement, and is checked again below).
const newFieldSchema = z
  .object({ ...createCustomFieldInputSchema.shape, options: z.string() })
  .superRefine((values, ctx) => {
    if (values.type === 'select' && choicesOf(values.options).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: errorCode('custom_field_options_required'),
      });
    }
  });
// Typed by the schema, so 'product' and 'text' stay the literals the schema wants
const NEW_FIELD: z.input<typeof newFieldSchema> = {
  entity: 'product',
  key: '',
  label: '',
  type: 'text',
  options: '',
  required: false,
};
const editFieldSchema = updateCustomFieldInputSchema.extend({ options: z.string() });
const NEW_FIELDS = ['key', 'label', 'type', 'options', 'required'] as const;
const EDIT_FIELDS = ['label', 'options', 'required'] as const;

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
}

function NewFieldForm({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm({
    resolver: zodResolver(newFieldSchema, { error: contractErrorMap }),
    defaultValues: NEW_FIELD,
  });
  const type = useWatch({ control, name: 'type' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.customFields.create, {
        body: { ...values, options: choicesOf(values.options) },
      });
      await refresh();
      toast(t('customFields.created', { label: saved.label }));
      onDone();
    } catch (error) {
      applyApiError(error, NEW_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('customFields.newTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="field-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('customFields.add')}
          </Button>
        </>
      }
    >
      <form
        id="field-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('customFields.label')}
          placeholder={t('customFields.labelPlaceholder')}
          {...register('label', {
            onChange: (event: ChangeEvent<HTMLInputElement>) => {
              if (!dirtyFields.key) setValue('key', keyOf(event.target.value));
            },
          })}
          error={errors.label?.message}
        />
        <TextField
          label={t('customFields.key')}
          hint={t('customFields.keyHint')}
          prefix={CUSTOM_FIELD_COLUMN_PREFIX}
          spellCheck={false}
          {...register('key')}
          error={errors.key?.message}
        />
        <SelectField
          label={t('customFields.type')}
          options={CUSTOM_FIELD_TYPES.map((value) => ({
            value,
            label: t(`customFields.types.${value}`),
          }))}
          {...register('type')}
          error={errors.type?.message}
        />
        {type === 'select' && (
          <TextAreaField
            label={t('customFields.options')}
            hint={t('customFields.optionsHint')}
            placeholder={'Tablet\nCapsule\nSyrup'}
            {...register('options')}
            error={errors.options?.message}
          />
        )}
        {type !== 'boolean' && (
          <Controller
            control={control}
            name="required"
            render={({ field }) => (
              <Checkbox
                id="field-required"
                label={t('customFields.required')}
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
              />
            )}
          />
        )}
      </form>
    </DialogContent>
  );
}

function EditFieldForm({ field, onDone }: { field: CustomFieldDefinition; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(editFieldSchema, { error: contractErrorMap }),
    defaultValues: {
      label: field.label,
      options: field.options.join('\n'),
      required: field.required,
      version: field.version,
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      call(field.archivedAt === null ? routes.customFields.archive : routes.customFields.restore, {
        params: { id: field.id },
        body: { version: field.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'customFields.restoredToast' : 'customFields.archivedToast', {
          label: saved.label,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.customFields.update, {
        params: { id: field.id },
        body: { ...values, options: choicesOf(values.options) },
      });
      await refresh();
      toast(t('customFields.updated', { label: saved.label }));
      onDone();
    } catch (error) {
      applyApiError(error, EDIT_FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ??
    (toggle.error instanceof ApiRequestError ? toggle.error.code : undefined);

  return (
    <DialogContent
      title={t('customFields.editTitle', { label: field.label })}
      description={`${CUSTOM_FIELD_COLUMN_PREFIX}${field.key} · ${
        isCustomFieldType(field.type) ? t(`customFields.types.${field.type}`) : field.type
      }`}
      footer={
        <>
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={toggle.isPending}
            onClick={() => {
              toggle.mutate();
            }}
          >
            {field.archivedAt === null ? t('customFields.archive') : t('customFields.restore')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="field-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="field-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('customFields.label')}
          {...register('label')}
          error={errors.label?.message}
        />
        {field.type === 'select' && (
          <TextAreaField
            label={t('customFields.options')}
            hint={t('customFields.optionsHint')}
            {...register('options')}
            error={errors.options?.message}
          />
        )}
        {field.type !== 'boolean' && (
          <Controller
            control={control}
            name="required"
            render={({ field: required }) => (
              <Checkbox
                id="field-required"
                label={t('customFields.required')}
                checked={required.value}
                onCheckedChange={(checked) => {
                  required.onChange(checked === true);
                }}
              />
            )}
          />
        )}
      </form>
    </DialogContent>
  );
}

type Editing = null | { kind: 'new' } | { kind: 'edit'; field: CustomFieldDefinition };

export function CustomFieldsPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('core.settings.manage');
  const { data: fields, isError } = useQuery(productFieldsQuery(tenantId));
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const visible = useMemo(
    () => fields?.filter((field) => showArchived || field.archivedAt === null),
    [fields, showArchived],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('label', {
          header: t('customFields.columns.field'),
          meta: { card: 'title' },
        }),
        column.accessor('type', {
          header: t('customFields.columns.type'),
          meta: { card: 'subtitle' },
          cell: ({ row }) => {
            const { type, options } = row.original;
            const name = isCustomFieldType(type) ? t(`customFields.types.${type}`) : type;
            return type === 'select' ? `${name}: ${options.join(', ')}` : name;
          },
        }),
        column.accessor('key', {
          header: t('customFields.columns.column'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="font-mono text-caption text-ink-3">
              {CUSTOM_FIELD_COLUMN_PREFIX}
              {getValue()}
            </span>
          ),
        }),
        column.accessor((field) => (field.archivedAt === null ? '' : 'archived'), {
          id: 'state',
          header: '',
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) =>
            row.original.archivedAt !== null ? (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('customFields.archived')}
              </Pill>
            ) : (
              row.original.required && (
                <Pill tone="brand" icon={CheckmarkCircle02Icon}>
                  {t('customFields.requiredPill')}
                </Pill>
              )
            ),
        }),
      ]),
    [t],
  );

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('customFields.title')}
        description={t('customFields.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing({ kind: 'new' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customFields.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!canManage ? (
          <p className="text-body-sm text-ink-3">{t('customFields.readOnly')}</p>
        ) : (
          <span />
        )}
        <Checkbox
          id="fields-show-archived"
          label={t('customFields.showArchived')}
          checked={showArchived}
          onCheckedChange={(checked) => {
            setShowArchived(checked === true);
          }}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('customFields.loadFailed')}</p>}
      {visible && (
        <DataTable
          label={t('customFields.title')}
          data={visible}
          columns={columns}
          getRowId={(field) => field.id}
          onRowClick={
            canManage
              ? (field) => {
                  setEditing({ kind: 'edit', field });
                }
              : undefined
          }
          empty={
            <EmptyState
              icon={TextIcon}
              title={t('customFields.emptyTitle')}
              description={t('customFields.emptyBody')}
            />
          }
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing?.kind === 'new' && (
          <NewFieldForm
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {editing?.kind === 'edit' && (
          <EditFieldForm
            key={editing.field.id}
            field={editing.field}
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

- **`choicesOf()`**: the choices are typed one per line in a text area; blank lines are dropped, so a trailing Enter
  never becomes an empty choice.
- **`keyOf()`** suggests the import column from the label while the key has not been typed by hand ("Generic name" →
  `generic_name`). A Bangla label leaves nothing to suggest; the person types the key.
- **`newFieldSchema` is built from `createCustomFieldInputSchema.shape`**, with the choices as one text — and its
  "a select needs a choice" rule written again, because a refined schema cannot be extended (12.1).
- **`NEW_FIELD` is typed with the schema's input**, so `'product'` and `'text'` stay the literals the schema wants
  instead of widening to `string`.
- **A required field shows a "Required" pill** in the list; an archived one an "Archived" pill.

**File: `apps/app/src/routes/products.tsx`** (new)

```tsx
import {
  FileImportIcon,
  PackageIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isTrackingMode,
  PRODUCT_STATUSES,
  type ProductSort,
  type ProductStatus,
  type ProductSummary,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCan } from '../lib/permissions';
import { categoryOptions, categoryPath } from '../lib/products';
import { productCategoriesQuery, productListQuery, unitsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<ProductSummary>();

// The table's sort → the API's. Two sortable columns; the server keeps a stable order on each.
function sortOf(state: SortingState): ProductSort {
  const [first] = state;
  if (first?.id === 'code') return first.desc ? '-code' : 'code';
  if (first?.id === 'name') return first.desc ? '-name' : 'name';
  return 'name';
}

// What the person typed, a moment after they stop: one request per word, not per key
function useDebounced(value: string, ms = 300): string {
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

export function ProductsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('inventory.product.manage');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<ProductStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, categoryId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    productListQuery(tenantId, filter),
  );
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const units = useQuery(unitsQuery(tenantId)).data;
  const products = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const unitCode = useMemo(() => new Map(units?.map((unit) => [unit.id, unit.code])), [units]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('code', {
          header: t('products.fields.code'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="font-mono text-caption text-ink-2 tabular-nums">{getValue()}</span>
          ),
        }),
        column.accessor('name', {
          header: t('products.columns.product'),
          meta: { card: 'title' },
          cell: ({ row }) => {
            const where = categoryPath(categories ?? [], row.original.categoryId);
            return (
              <span className="grid max-w-[22rem]">
                <span className="truncate font-medium">{row.original.name}</span>
                {where !== '' && <span className="truncate text-caption text-ink-3">{where}</span>}
              </span>
            );
          },
        }),
        column.accessor('variantCount', {
          header: t('products.columns.variants'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            row.original.hasVariants
              ? t('products.variantCount', { count: row.original.variantCount })
              : t('products.simple'),
        }),
        column.accessor('baseUnitId', {
          header: t('products.columns.unit'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="font-mono text-caption">{unitCode.get(getValue()) ?? ''}</span>
          ),
        }),
        column.accessor('tracking', {
          header: t('products.columns.tracking'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const mode = getValue();
            return isTrackingMode(mode) ? t(`products.trackings.${mode}`) : mode;
          },
        }),
        column.accessor((product) => product.minPrice ?? '', {
          id: 'price',
          header: t('products.columns.price'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          // A sale price is a unit price: 2 decimals (CLAUDE.md → Money). A range when the
          // variants differ.
          cell: ({ row }) => {
            const { minPrice, maxPrice } = row.original;
            if (minPrice === null || maxPrice === null) return '—';
            const low = format.money(minPrice, { decimals: 2 });
            return minPrice === maxPrice
              ? low
              : `${low} – ${format.money(maxPrice, { decimals: 2 })}`;
          },
        }),
      ]),
    [t, format, categories, unitCode],
  );

  const filtered = settled !== '' || categoryId !== '';
  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('products.noMatchTitle', { query: settled })}
        description={t('products.noMatchBody')}
      />
    ) : status === 'archived' ? (
      <EmptyState
        icon={PackageIcon}
        title={t('products.archivedEmptyTitle')}
        description={t('products.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={PackageIcon}
        title={t('products.emptyTitle')}
        description={t('products.emptyBody')}
        action={
          canManage &&
          !filtered && (
            <Button onClick={() => void navigate({ to: '/products/new' })}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('products.add')}
            </Button>
          )
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('products.title')}
        description={t('products.description')}
        actions={
          canManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => void navigate({ to: '/products/imports' })}
              >
                <HugeiconsIcon icon={FileImportIcon} size={17} strokeWidth={1.5} />
                {t('products.import')}
              </Button>
              <Button onClick={() => void navigate({ to: '/products/new' })}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('products.add')}
              </Button>
            </>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('products.searchLabel')}
            placeholder={t('products.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('products.category')}
            options={[
              { value: '', label: t('products.allCategories') },
              ...categoryOptions(categories ?? []),
            ]}
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('products.show')}
          value={status}
          options={PRODUCT_STATUSES.map((value) => ({
            value,
            label: t(`products.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('products.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('products.loadFailed')}</p>}
      {products && (
        <DataTable
          label={t('products.title')}
          data={products}
          columns={columns}
          getRowId={(product) => product.id}
          sorting={{ state: sorting, onChange: setSorting }}
          onRowClick={(product) =>
            void navigate({ to: '/products/$productId', params: { productId: product.id } })
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

- **`sortOf()`** turns the table's sort into the API's. Sorting happens on the server (`sorting` prop), because the
  browser holds only the pages loaded so far.
- **`useDebounced()`** sends the search 300 ms after the last key: one request per word, not per letter.
- **The price column** shows a unit price with 2 decimals (CLAUDE.md → Money), and a range when the variants differ.
- **Three empty states**: nothing matches the search, no archived products, and no products at all — the last with
  "Add product", because that is what fills the page.
- **Every column says where it goes on a phone** (`meta.card`): the name as the title, versions as the subtitle, the
  price trailing, code, unit and tracking as details.

**File: `apps/app/src/routes/product.tsx`** (new)

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { isIndustry, trackingDefault } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useMemo } from 'react';

import { useCan } from '../lib/permissions';
import {
  productCategoriesQuery,
  productFieldsQuery,
  productQuery,
  setupQuery,
  unitsQuery,
} from '../lib/queries';
import { useSession } from '../lib/session-store';

// The page loads the data; the form is a lazy chunk of its own (the form library, the money input
// and the date picker are only needed here)
const ProductForm = lazy(async () => ({
  default: (await import('../components/product-form')).ProductForm,
}));

// What both pages need: the units, the categories, the active custom fields, and the business
// type (a pharma company's new products start with batch tracking)
function useProductData() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const units = useQuery(unitsQuery(tenantId)).data;
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const allFields = useQuery(productFieldsQuery(tenantId)).data;
  const industry = useQuery(setupQuery(tenantId)).data?.industry ?? null;
  const fields = useMemo(
    () => allFields?.filter((field) => field.archivedAt === null),
    [allFields],
  );
  return {
    tenantId,
    units,
    categories,
    fields,
    defaults: trackingDefault(industry !== null && isIndustry(industry) ? industry : null),
  };
}

export function NewProductPage() {
  const canManage = useCan()('inventory.product.manage');
  const { units, categories, fields, defaults } = useProductData();
  if (!units || !categories || !fields) return null;
  return (
    <Suspense fallback={null}>
      <ProductForm
        product={null}
        units={units}
        categories={categories}
        fields={fields}
        defaults={defaults}
        canManage={canManage}
      />
    </Suspense>
  );
}

export function ProductPage() {
  const { t } = useLocale();
  const { productId = '' } = useParams({ strict: false });
  const canManage = useCan()('inventory.product.manage');
  const { tenantId, units, categories, fields, defaults } = useProductData();
  const { data: product, isError } = useQuery({
    ...productQuery(tenantId, productId),
    enabled: productId !== '',
  });
  if (isError) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <Link
          to="/products"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('products.back')}
        </Link>
        <EmptyState
          icon={AlertCircleIcon}
          title={t('products.title')}
          description={t('products.notFound')}
        />
      </div>
    );
  }
  if (!product || !units || !categories || !fields) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a saved product comes back with a new version, and the form starts from it again */}
      <ProductForm
        key={`${product.id}-${String(product.version)}`}
        product={product}
        units={units}
        categories={categories}
        fields={fields}
        defaults={defaults}
        canManage={canManage}
      />
    </Suspense>
  );
}
```

The page loads the data (units, categories, active fields, the business type) and the form is a lazy chunk of its own:
the form library, the money input and the date picker are only needed here. `key={id-version}`: a saved product comes
back with a new version, and the form starts from it again.

**File: `apps/app/src/components/product-form.tsx`** (new)

```tsx
import {
  Alert02Icon,
  Archive02Icon,
  Delete02Icon,
  GridViewIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomFieldDefinition,
  customFieldsInputSchema,
  isCustomFieldType,
  MAX_PRODUCT_OPTIONS,
  type Product,
  type ProductCategory,
  productFieldsSchema,
  productRules,
  PRODUCT_TYPES,
  routes,
  standardFactor,
  TRACKING_MODES,
  type TrackingMode,
  type Unit,
  versionSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  SegmentedControl,
  Select,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  type Control,
  Controller,
  type Path,
  useFieldArray,
  useForm,
  useWatch,
} from 'react-hook-form';
import type { z } from 'zod';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  categoryOptions,
  emptyVariant,
  plainFactor,
  rowPath,
  splitValues,
  syncVariants,
} from '../lib/products';
import { productQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { LineError } from './journal-parts';

// The product form: a chunk of its own (loaded by routes/product.tsx). The schema is the
// contract's own fields and rules, with the workspace's custom fields put in — so the form refuses
// exactly what the API refuses, in the same words, before anything is sent.
function formSchema(fields: readonly CustomFieldDefinition[]) {
  return productFieldsSchema
    .extend({ customFields: customFieldsInputSchema(fields), version: versionSchema })
    .superRefine(productRules);
}

type FormValues = z.input<ReturnType<typeof formSchema>>;

// The two kinds of form: a simple product (one version) or one with options
const KINDS = ['simple', 'variants'] as const;
type Kind = (typeof KINDS)[number];

// A product as the form holds it: '' for every empty box, the active custom fields only
function valuesOf(
  product: Product | null,
  fields: readonly CustomFieldDefinition[],
  defaults: { baseUnitId: string; tracking: TrackingMode; hasExpiry: boolean },
): FormValues {
  const customFields: Record<string, string | boolean> = {};
  for (const field of fields) {
    const saved = product?.customFields[field.key];
    customFields[field.key] =
      field.type === 'boolean' ? saved === true : typeof saved === 'string' ? saved : '';
  }
  if (!product) {
    return {
      code: '',
      name: '',
      type: 'goods',
      categoryId: '',
      description: '',
      baseUnitId: defaults.baseUnitId,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: defaults.tracking,
      hasExpiry: defaults.hasExpiry,
      options: [],
      variants: [emptyVariant()],
      units: [],
      customFields,
      version: 1,
    };
  }
  return {
    code: product.code,
    name: product.name,
    type: product.type === 'service' ? 'service' : 'goods',
    categoryId: product.categoryId ?? '',
    description: product.description ?? '',
    baseUnitId: product.baseUnitId,
    salesUnitId: product.salesUnitId ?? '',
    purchaseUnitId: product.purchaseUnitId ?? '',
    tracking: TRACKING_MODES.find((mode) => mode === product.tracking) ?? 'none',
    hasExpiry: product.hasExpiry,
    options: product.options,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      optionValues: variant.optionValues,
      barcode: variant.barcode ?? '',
      salePrice: variant.salePrice ?? '',
      archived: variant.archivedAt !== null,
    })),
    // "12.000000" from the database reads "12" in the box
    units: product.units.map((pack) => ({
      unitId: pack.unitId,
      factor: plainFactor(pack.factor),
      barcode: pack.barcode ?? '',
    })),
    customFields,
    version: product.version,
  };
}

// Every field the server may name in an error, so it lands under the right box
function fieldNames(
  values: FormValues,
  fields: readonly CustomFieldDefinition[],
): Path<FormValues>[] {
  const names: Path<FormValues>[] = [
    'code',
    'name',
    'type',
    'categoryId',
    'description',
    'baseUnitId',
    'salesUnitId',
    'purchaseUnitId',
    'tracking',
    'hasExpiry',
    'variants',
  ];
  values.variants.forEach((_, index) => {
    names.push(
      rowPath('variants', index, 'sku'),
      rowPath('variants', index, 'barcode'),
      rowPath('variants', index, 'salePrice'),
    );
  });
  values.units.forEach((_, index) => {
    names.push(
      rowPath('units', index, 'unitId'),
      rowPath('units', index, 'factor'),
      rowPath('units', index, 'barcode'),
    );
  });
  for (const field of fields) names.push(`customFields.${field.key}`);
  return names;
}

// An option's values as one comma-separated box. Its own text while typing ("S, M," keeps the
// comma); the list goes to the form when the box is left, cleaned like the API counts values.
function ValuesInput({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: readonly string[];
  onChange: (values: string[]) => void;
  invalid: boolean;
}) {
  const { t } = useLocale();
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      id={id}
      value={text}
      invalid={invalid}
      placeholder={t('products.options.valuesPlaceholder')}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onBlur={() => {
        const values = splitValues(text);
        setText(values.join(', '));
        onChange(values);
      }}
    />
  );
}

function SectionCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className={cn('grid grid-cols-1 gap-5 p-5', className)}>{children}</div>
    </Card>
  );
}

function CustomFieldInput({
  control,
  field,
}: {
  control: Control<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>;
  field: CustomFieldDefinition;
}) {
  const { t } = useLocale();
  const name: Path<FormValues> = `customFields.${field.key}`;
  const optional = !field.required;
  if (!isCustomFieldType(field.type)) return null;
  if (field.type === 'boolean') {
    return (
      <Controller
        control={control}
        name={name}
        render={({ field: box }) => (
          <Checkbox
            id={name}
            label={field.label}
            checked={box.value === true}
            onCheckedChange={(checked) => {
              box.onChange(checked === true);
            }}
          />
        )}
      />
    );
  }
  if (field.type === 'date') {
    return (
      <FormField control={control} name={name} label={field.label} optional={optional}>
        {(box) => (
          <DatePicker
            {...box}
            value={typeof box.value === 'string' ? box.value : ''}
            onChange={box.onChange}
          />
        )}
      </FormField>
    );
  }
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: box, fieldState }) => {
        const value = typeof box.value === 'string' ? box.value : '';
        return field.type === 'select' ? (
          <SelectField
            id={name}
            label={field.label}
            optional={optional}
            options={[
              { value: '', label: t('products.choose') },
              // A choice removed from the field after this product saved it stays visible
              ...[
                ...field.options,
                ...(value !== '' && !field.options.includes(value) ? [value] : []),
              ].map((option) => ({ value: option, label: option })),
            ]}
            name={box.name}
            value={value}
            onChange={box.onChange}
            onBlur={box.onBlur}
            ref={box.ref}
            error={fieldState.error?.message}
          />
        ) : (
          <TextField
            id={name}
            label={field.label}
            optional={optional}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            name={box.name}
            value={value}
            onChange={box.onChange}
            onBlur={box.onBlur}
            ref={box.ref}
            error={fieldState.error?.message}
          />
        );
      }}
    />
  );
}

export function ProductForm({
  product,
  units,
  categories,
  fields,
  defaults,
  canManage,
}: {
  product: Product | null;
  units: Unit[];
  categories: ProductCategory[];
  // The workspace's active custom fields for products
  fields: CustomFieldDefinition[];
  defaults: { tracking: TrackingMode; hasExpiry: boolean };
  canManage: boolean;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [confirming, setConfirming] = useState(false);
  const schema = useMemo(() => formSchema(fields), [fields]);
  const pcs = units.find((unit) => unit.code === 'pcs' && unit.archivedAt === null);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema, { error: contractErrorMap }),
    defaultValues: valuesOf(product, fields, { ...defaults, baseUnitId: pcs?.id ?? '' }),
  });
  const optionArray = useFieldArray({ control, name: 'options' });
  const variantArray = useFieldArray({ control, name: 'variants' });
  const packArray = useFieldArray({ control, name: 'units' });
  const [kind, setKind] = useState<Kind>(
    product && product.options.length > 0 ? 'variants' : 'simple',
  );
  const baseUnitId = useWatch({ control, name: 'baseUnitId' });
  const packs = useWatch({ control, name: 'units' });
  const type = useWatch({ control, name: 'type' });
  const tracking = useWatch({ control, name: 'tracking' });
  const options = useWatch({ control, name: 'options' });

  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const base = unitById.get(baseUnitId);
  // Active units, plus the ones this product already uses (an archived unit stays on it)
  const used = new Set([product?.baseUnitId, ...(product?.units.map((pack) => pack.unitId) ?? [])]);
  const unitOptions = units
    .filter((unit) => unit.archivedAt === null || used.has(unit.id))
    .map((unit) => ({ value: unit.id, label: `${unit.code} · ${unit.name}` }));
  const defaultUnitOptions = [
    { value: '', label: base ? `${base.code} · ${base.name}` : '' },
    ...packs.flatMap((pack) => {
      const unit = unitById.get(pack.unitId);
      return unit ? [{ value: unit.id, label: `${unit.code} · ${unit.name}` }] : [];
    }),
  ];

  // A standard unit's size is not the person's to choose (a dozen is 12): filled in and fixed
  const standardOf = (unitId: string, baseId: string) => {
    const unit = unitById.get(unitId);
    const baseUnit = unitById.get(baseId);
    return unit && baseUnit ? standardFactor(unit, baseUnit) : null;
  };
  const refillFactors = (baseId: string) => {
    getValues('units').forEach((pack, index) => {
      const standard = standardOf(pack.unitId, baseId);
      if (standard !== null) setValue(rowPath('units', index, 'factor'), plainFactor(standard));
    });
  };

  const refresh = (saved?: Product) => {
    if (saved) queryClient.setQueryData(productQuery(tenantId, saved.id).queryKey, saved);
    return queryClient.invalidateQueries({ queryKey: ['products', tenantId, 'list'] });
  };

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = product
        ? await call(routes.products.update, {
            params: { id: product.id },
            body: { ...values, version },
          })
        : await call(routes.products.create, { body: values });
      await refresh(saved);
      toast(t(product ? 'products.updated' : 'products.created', { name: saved.name }));
      if (!product) {
        void navigate({
          to: '/products/$productId',
          params: { productId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(getValues(), fields), setError);
    }
  });

  const toggle = useMutation({
    mutationFn: (target: Product) =>
      call(target.archivedAt === null ? routes.products.archive : routes.products.restore, {
        params: { id: target.id },
        body: { version: target.version },
      }),
    onSuccess: async (saved) => {
      await refresh(saved);
      toast(
        t(saved.archivedAt === null ? 'products.restoredToast' : 'products.archivedToast', {
          name: saved.name,
        }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: (target: Product) =>
      call(routes.products.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('products.deleted', { name: product?.name ?? '' }));
      void navigate({ to: '/products' });
    },
  });

  const switchKind = (next: Kind) => {
    if (next === kind) return;
    if (next === 'variants') {
      // The one variant stays (its id carries over to the first combination when created)
      optionArray.replace([{ name: '', values: [] }]);
    } else {
      const [only] = getValues('variants');
      optionArray.replace([]);
      variantArray.replace([{ ...(only ?? emptyVariant()), optionValues: [] }]);
    }
    setKind(next);
  };

  const createVariants = () => {
    const current = getValues('options');
    variantArray.replace(
      syncVariants(
        current.map((option) => ({ values: option.values })),
        getValues('variants'),
      ),
    );
  };

  const failure =
    errors.root?.server?.message ??
    (toggle.error instanceof ApiRequestError ? toggle.error.code : undefined) ??
    (remove.error instanceof ApiRequestError ? remove.error.code : undefined);
  const variantsError = errors.variants?.root?.message ?? errors.variants?.message;
  const unitWord = base?.code ?? '';
  const { errorText } = useLocale();

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <Link
        to="/products"
        className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
      >
        ← {t('products.back')}
      </Link>
      <PageHeader
        title={product ? t('products.editTitle', { code: product.code }) : t('products.newTitle')}
        description={product?.name}
      />
      {product?.archivedAt && (
        <p className="flex items-center gap-2 text-body-sm text-ink-2">
          <Pill tone="neutral" icon={Archive02Icon}>
            {t('products.statuses.archived')}
          </Pill>
          {t('products.archivedNotice')}
        </p>
      )}
      <form id="product-form" noValidate onSubmit={(event) => void onSubmit(event)}>
        {/* Without the permission the same page reads, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
          {failure && <FormAlert message={failure} />}

          <SectionCard title={t('products.sections.basics')}>
            <TextField
              label={t('products.fields.name')}
              placeholder={t('products.fields.namePlaceholder')}
              {...register('name')}
              error={errors.name?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('products.fields.code')}
                hint={product ? undefined : t('products.fields.codeHint')}
                optional={!product}
                spellCheck={false}
                {...register('code')}
                error={errors.code?.message}
              />
              <SelectField
                label={t('products.fields.type')}
                options={PRODUCT_TYPES.map((value) => ({
                  value,
                  label: t(`products.types.${value}`),
                }))}
                {...register('type', {
                  onChange: () => {
                    // A service is never stocked: nothing to track
                    if (getValues('type') === 'service') {
                      setValue('tracking', 'none');
                      setValue('hasExpiry', false);
                    }
                  },
                })}
                error={errors.type?.message}
              />
            </div>
            <SelectField
              label={t('products.fields.category')}
              options={[
                { value: '', label: t('products.fields.noCategory') },
                ...categoryOptions(categories),
              ]}
              {...register('categoryId')}
              error={errors.categoryId?.message}
            />
            <TextAreaField
              label={t('products.fields.description')}
              optional
              {...register('description')}
              error={errors.description?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('products.sections.units')}
            subtitle={t('products.sections.unitsHint')}
          >
            <SelectField
              label={t('products.fields.baseUnit')}
              options={unitOptions}
              {...register('baseUnitId', {
                onChange: () => {
                  refillFactors(getValues('baseUnitId'));
                },
              })}
              error={errors.baseUnitId?.message}
            />
            {packArray.fields.length > 0 && (
              <ul aria-label={t('products.packs.label')} className="grid gap-3">
                {packArray.fields.map((pack, index) => {
                  const number = index + 1;
                  const unitId = packs[index]?.unitId ?? '';
                  const standard = standardOf(unitId, baseUnitId);
                  const packErrors = errors.units?.[index];
                  return (
                    <li
                      key={pack.id}
                      aria-label={t('products.packs.number', { number })}
                      className="grid grid-cols-1 gap-3 rounded-control border border-line p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-start"
                    >
                      <div className="grid gap-1.5">
                        <label
                          htmlFor={`units.${String(index)}.unitId`}
                          className="text-label font-medium"
                        >
                          {t('products.packs.unit')}
                        </label>
                        <Select
                          id={`units.${String(index)}.unitId`}
                          options={[
                            { value: '', label: t('products.packs.placeholder') },
                            ...unitOptions,
                          ]}
                          invalid={packErrors?.unitId !== undefined}
                          {...register(rowPath('units', index, 'unitId'), {
                            onChange: () => {
                              const next = standardOf(
                                getValues(rowPath('units', index, 'unitId')),
                                baseUnitId,
                              );
                              if (next !== null)
                                setValue(rowPath('units', index, 'factor'), plainFactor(next));
                            },
                          })}
                        />
                        <LineError
                          id={`units.${String(index)}.unitId`}
                          error={packErrors?.unitId?.message}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <label
                          htmlFor={`units.${String(index)}.factor`}
                          className="text-label font-medium"
                        >
                          {t('products.packs.factor')}
                        </label>
                        <Input
                          id={`units.${String(index)}.factor`}
                          inputMode="decimal"
                          suffix={unitWord}
                          readOnly={standard !== null}
                          invalid={packErrors?.factor !== undefined}
                          {...register(rowPath('units', index, 'factor'))}
                        />
                        {standard !== null ? (
                          <p className="text-label text-ink-3">{t('products.packs.standard')}</p>
                        ) : (
                          <LineError
                            id={`units.${String(index)}.factor`}
                            error={packErrors?.factor?.message}
                          />
                        )}
                      </div>
                      {kind === 'simple' ? (
                        <div className="grid gap-1.5">
                          <label
                            htmlFor={`units.${String(index)}.barcode`}
                            className="text-label font-medium"
                          >
                            {t('products.packs.barcode')}
                          </label>
                          <Input
                            id={`units.${String(index)}.barcode`}
                            spellCheck={false}
                            invalid={packErrors?.barcode !== undefined}
                            {...register(rowPath('units', index, 'barcode'))}
                          />
                          <LineError
                            id={`units.${String(index)}.barcode`}
                            error={packErrors?.barcode?.message}
                          />
                        </div>
                      ) : (
                        <span className="hidden sm:block" />
                      )}
                      <IconButton
                        icon={Delete02Icon}
                        label={t('products.packs.remove', { number })}
                        className="justify-self-end sm:mt-[26px]"
                        onClick={() => {
                          packArray.remove(index);
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  packArray.append({ unitId: '', factor: '', barcode: '' });
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('products.packs.add')}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <SelectField
                label={t('products.fields.salesUnit')}
                options={defaultUnitOptions}
                {...register('salesUnitId')}
                error={errors.salesUnitId?.message}
              />
              <SelectField
                label={t('products.fields.purchaseUnit')}
                options={defaultUnitOptions}
                {...register('purchaseUnitId')}
                error={errors.purchaseUnitId?.message}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t('products.sections.variants')}
            subtitle={t('products.sections.variantsHint')}
          >
            <div className="grid gap-1.5">
              <div>
                <SegmentedControl
                  label={t('products.kindLabel')}
                  value={kind}
                  options={KINDS.map((value) => ({ value, label: t(`products.kinds.${value}`) }))}
                  onChange={(next) => {
                    if (next === 'simple' && variantArray.fields.length > 1) return;
                    switchKind(next);
                  }}
                />
              </div>
              {kind === 'variants' && variantArray.fields.length > 1 && (
                <p className="text-label text-ink-3">{t('products.simpleLocked')}</p>
              )}
            </div>

            {kind === 'simple' ? (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-x-4">
                <TextField
                  label={t('products.fields.sku')}
                  optional
                  hint={t('products.fields.skuHint')}
                  spellCheck={false}
                  {...register('variants.0.sku')}
                  error={errors.variants?.[0]?.sku?.message}
                />
                <TextField
                  label={t('products.fields.barcode')}
                  optional
                  spellCheck={false}
                  {...register('variants.0.barcode')}
                  error={errors.variants?.[0]?.barcode?.message}
                />
                <FormField
                  control={control}
                  name="variants.0.salePrice"
                  label={t('products.fields.price', { unit: unitWord })}
                  optional
                >
                  {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
                </FormField>
              </div>
            ) : (
              <>
                <ul className="grid gap-3">
                  {optionArray.fields.map((option, index) => {
                    const number = index + 1;
                    const optionErrors = errors.options?.[index];
                    const valuesError =
                      optionErrors?.values?.message ??
                      optionErrors?.values?.root?.message ??
                      optionErrors?.values?.find?.((value) => value?.message)?.message;
                    return (
                      <li
                        key={option.id}
                        className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-start"
                      >
                        <div className="grid gap-1.5">
                          <label
                            htmlFor={`options.${String(index)}.name`}
                            className="text-label font-medium"
                          >
                            {t('products.options.name')}
                          </label>
                          <Input
                            id={`options.${String(index)}.name`}
                            placeholder={t('products.options.namePlaceholder')}
                            invalid={optionErrors?.name !== undefined}
                            {...register(rowPath('options', index, 'name'))}
                          />
                          <LineError
                            id={`options.${String(index)}.name`}
                            error={optionErrors?.name?.message}
                          />
                        </div>
                        <Controller
                          control={control}
                          name={rowPath('options', index, 'values')}
                          render={({ field }) => (
                            <div className="grid gap-1.5">
                              <label
                                htmlFor={`options.${String(index)}.values`}
                                className="text-label font-medium"
                              >
                                {t('products.options.values')}
                              </label>
                              <ValuesInput
                                id={`options.${String(index)}.values`}
                                value={field.value}
                                onChange={field.onChange}
                                invalid={valuesError !== undefined}
                              />
                              {valuesError ? (
                                <LineError
                                  id={`options.${String(index)}.values`}
                                  error={valuesError}
                                />
                              ) : (
                                <p className="text-label text-ink-3">
                                  {t('products.options.valuesHint')}
                                </p>
                              )}
                            </div>
                          )}
                        />
                        <IconButton
                          icon={Delete02Icon}
                          label={t('products.options.remove', { number })}
                          className="justify-self-end sm:mt-[26px]"
                          disabled={optionArray.fields.length <= 1}
                          onClick={() => {
                            optionArray.remove(index);
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={optionArray.fields.length >= MAX_PRODUCT_OPTIONS}
                    onClick={() => {
                      optionArray.append({ name: '', values: [] });
                    }}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                    {t('products.options.add')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={createVariants}>
                    <HugeiconsIcon icon={GridViewIcon} size={16} strokeWidth={1.5} />
                    {t('products.options.generate')}
                  </Button>
                </div>
                <p className="text-label text-ink-3">{t('products.options.generateHint')}</p>
                <VariantRows
                  control={control}
                  register={register}
                  fields={variantArray.fields}
                  errors={errors.variants}
                  hasOptions={options.length > 0}
                  unitWord={unitWord}
                  onRemove={(index) => {
                    variantArray.remove(index);
                  }}
                />
              </>
            )}
            {variantsError && (
              <p className="flex items-center gap-1.5 text-label text-crit">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  size={15}
                  strokeWidth={1.5}
                  className="shrink-0"
                />
                {errorText(variantsError)}
              </p>
            )}
          </SectionCard>

          {type !== 'service' && (
            <SectionCard
              title={t('products.sections.tracking')}
              subtitle={t('products.sections.trackingHint')}
            >
              <SelectField
                label={t('products.fields.tracking')}
                hint={t(`products.trackingHints.${tracking}`)}
                options={TRACKING_MODES.map((value) => ({
                  value,
                  label: t(`products.trackings.${value}`),
                }))}
                {...register('tracking', {
                  onChange: () => {
                    if (getValues('tracking') !== 'batch') setValue('hasExpiry', false);
                  },
                })}
                error={errors.tracking?.message}
              />
              {tracking === 'batch' && (
                <Controller
                  control={control}
                  name="hasExpiry"
                  render={({ field }) => (
                    <Checkbox
                      id="hasExpiry"
                      label={t('products.fields.hasExpiry')}
                      checked={field.value}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                      }}
                    />
                  )}
                />
              )}
            </SectionCard>
          )}

          {fields.length > 0 && (
            <SectionCard
              title={t('products.sections.details')}
              subtitle={t('products.sections.detailsHint')}
              className="sm:grid-cols-2 sm:gap-x-4"
            >
              {fields.map((field) => (
                <CustomFieldInput key={field.id} control={control} field={field} />
              ))}
            </SectionCard>
          )}

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {product && (
                // Left, away from Save. Delete takes two clicks: it cannot be undone.
                <div className="mr-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={toggle.isPending}
                    onClick={() => {
                      toggle.mutate(product);
                    }}
                  >
                    {product.archivedAt === null ? t('products.archive') : t('products.restore')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirming) remove.mutate(product);
                      else setConfirming(true);
                    }}
                  >
                    {confirming
                      ? t('products.confirmDelete', { code: product.code })
                      : t('products.delete')}
                  </Button>
                  {confirming && (
                    <span className="text-body-sm text-ink-2">{t('products.deleteWarning')}</span>
                  )}
                </div>
              )}
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('products.saving')
                  : product
                    ? t('products.save')
                    : t('products.create')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}

// One template for the header and every variant row, so the columns line up: values, SKU,
// barcode, price, archived, remove. minmax(0, …) here and grid-cols-1 in each cell (as in Field): a
// column may then shrink below an <input>'s own default width — without them the price box ran
// into the Archived box (found on the 1280px screenshot).
const VARIANT_COLUMNS =
  '@3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_7rem_2.25rem]';

// The variants of a product with options: one row each, labelled by its values ("M / Navy blue")
function VariantRows({
  control,
  register,
  fields,
  errors,
  hasOptions,
  unitWord,
  onRemove,
}: {
  control: Control<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>;
  register: ReturnType<
    typeof useForm<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>
  >['register'];
  fields: readonly { id: string }[];
  errors: ReturnType<
    typeof useForm<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>
  >['formState']['errors']['variants'];
  hasOptions: boolean;
  unitWord: string;
  onRemove: (index: number) => void;
}) {
  const { t } = useLocale();
  const variants = useWatch({ control, name: 'variants' });
  if (!hasOptions || fields.length === 0 || variants.every((v) => v.optionValues.length === 0)) {
    return <p className="text-body-sm text-ink-3">{t('products.variantsTable.empty')}</p>;
  }
  return (
    // A container query, like the journal lines: the card's width, not the screen's, decides
    // whether a row fits on one line (the sidebar takes 244px of a desktop screen)
    <div className="@container grid gap-2">
      <div
        aria-hidden="true"
        className={cn(
          'hidden gap-3 px-3 text-caption font-medium text-ink-3 @3xl:grid',
          VARIANT_COLUMNS,
        )}
      >
        <span>{t('products.variantsTable.variant')}</span>
        <span>{t('products.fields.sku')}</span>
        <span>{t('products.fields.barcode')}</span>
        <span className="text-right">{t('products.fields.price', { unit: unitWord })}</span>
        {/* The checkbox in each row says "Archived" itself */}
        <span />
      </div>
      <ul aria-label={t('products.variantsTable.label')} className="grid gap-3">
        {fields.map((row, index) => {
          const values = variants[index]?.optionValues ?? [];
          const name = values.join(' / ');
          const rowErrors = errors?.[index];
          const id = (part: string) => `variants.${String(index)}.${part}`;
          return (
            <li
              key={row.id}
              role="group"
              aria-label={name}
              className={cn(
                'grid grid-cols-2 gap-3 rounded-control border border-line p-3 @3xl:items-start',
                VARIANT_COLUMNS,
              )}
            >
              <div className="col-span-2 grid min-w-0 grid-cols-1 content-start gap-1 @3xl:col-span-1 @3xl:pt-2.5">
                <span className="text-body-sm font-medium">{name}</span>
                <LineError id={id('optionValues')} error={rowErrors?.optionValues?.message} />
              </div>
              <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 @3xl:col-span-1">
                <label htmlFor={id('sku')} className="text-label font-medium @3xl:sr-only">
                  {t('products.fields.sku')}
                </label>
                <Input
                  id={id('sku')}
                  spellCheck={false}
                  placeholder={t('products.fields.sku')}
                  invalid={rowErrors?.sku !== undefined}
                  {...register(rowPath('variants', index, 'sku'))}
                />
                <LineError id={id('sku')} error={rowErrors?.sku?.message} />
              </div>
              <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 @3xl:col-span-1">
                <label htmlFor={id('barcode')} className="text-label font-medium @3xl:sr-only">
                  {t('products.fields.barcode')}
                </label>
                <Input
                  id={id('barcode')}
                  spellCheck={false}
                  placeholder={t('products.fields.barcode')}
                  invalid={rowErrors?.barcode !== undefined}
                  {...register(rowPath('variants', index, 'barcode'))}
                />
                <LineError id={id('barcode')} error={rowErrors?.barcode?.message} />
              </div>
              <Controller
                control={control}
                name={rowPath('variants', index, 'salePrice')}
                render={({ field, fieldState }) => (
                  <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 @3xl:col-span-1">
                    <label
                      htmlFor={id('salePrice')}
                      className="text-label font-medium @3xl:sr-only"
                    >
                      {t('products.fields.price', { unit: unitWord })}
                    </label>
                    <MoneyInput
                      id={id('salePrice')}
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      invalid={fieldState.error !== undefined}
                    />
                    <LineError id={id('salePrice')} error={fieldState.error?.message} />
                  </div>
                )}
              />
              <Controller
                control={control}
                name={rowPath('variants', index, 'archived')}
                render={({ field }) => (
                  <div className="@3xl:pt-2.5">
                    <Checkbox
                      id={id('archived')}
                      label={t('products.variantsTable.archived')}
                      checked={field.value}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                      }}
                    />
                  </div>
                )}
              />
              <IconButton
                icon={Delete02Icon}
                label={t('products.variantsTable.remove', { name })}
                className="justify-self-end"
                onClick={() => {
                  onRemove(index);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- **`formSchema()`** is decision 4's promise: the contract's fields, the workspace's custom fields from
  `customFieldsInputSchema()`, the version, and the same `productRules`. The form refuses exactly what the API refuses,
  in the same words, before anything is sent.
- **`valuesOf()`** turns a product into form values: `''` for every empty box, `plainFactor()` for pack sizes, only the
  active custom fields (the strict schema would refuse an archived one, and the API keeps those values anyway).
- **`fieldNames()`** lists every field the server may name in an error, row by row, so `applyApiError()` puts each one
  under its box — the journal form's pattern.
- **`ValuesInput`** keeps its own text while typing ("S, M," keeps its comma) and gives the list to the form when the
  box is left. Splitting on every key press would eat the comma being typed.
- **`<fieldset disabled={!canManage}>`**: a member without the permission sees the same page with every control
  disabled at once, and no save buttons.
- **The base unit's `onChange` refills the standard pack sizes**: with pcs as the base, a gross holds 144; with dozen
  as the base, 12. A pack of another dimension, or a box, has no standard and keeps what was typed.
- **A pack's unit `onChange` fills its size** when there is a standard one, and the box becomes read-only with "A
  standard size, filled in for you."
- **The pack barcode box shows only for a simple product** (decision 8).
- **"Sell in" and "Buy in"** offer the base unit (`''`) and the packs chosen above.
- **`switchKind()`**: to variants, one empty option row appears and the one variant stays (it becomes the first
  combination when the variants are created); back to one version only while there is at most one variant, which keeps
  its id.
- **`createVariants()`** runs `syncVariants()` on the current options and replaces the rows.
- **Changing the type to service resets tracking**, and leaving batch tracking clears the expiry — the two rules the API
  would refuse otherwise.
- **`CustomFieldInput`** draws each field by its type: a checkbox for yes/no, the date picker for a date, a native select
  for a choice (with a choice the product holds but the field no longer offers, so nothing vanishes), a decimal text box
  for a number.
- **`VARIANT_COLUMNS`** is one grid template for the header and every variant row, inside a container query (`@3xl`, the
  card's width, not the screen's). `minmax(0, …)` and `grid-cols-1` in each cell let a column shrink below an input's
  default width — without them the price box ran into the "Archived" box at 1280px.
- **Archive, restore and delete** sit left, away from Save; delete takes two clicks.

**File: `apps/app/src/routes/product-imports.tsx`** (new)

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Download04Icon,
  FileImportIcon,
  Upload04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  createProductImportInputSchema,
  DEFAULT_SETTINGS,
  isErrorCode,
  PRODUCT_IMPORT_MAX_ERRORS,
  type ProductImport,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  FormAlert,
  PageHeader,
  Pill,
  SectionHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { importTemplate } from '../lib/products';
import {
  productFieldsQuery,
  productImportQuery,
  productImportsQuery,
  settingsQuery,
} from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<ProductImport>();

function StatusPill({ status }: { status: ProductImport['status'] }) {
  const { t } = useLocale();
  if (status === 'done') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('imports.statuses.done')}
      </Pill>
    );
  }
  if (status === 'failed') {
    return (
      <Pill tone="crit" icon={Alert02Icon}>
        {t('imports.statuses.failed')}
      </Pill>
    );
  }
  return (
    <Pill tone="warn" icon={Clock01Icon}>
      {t(`imports.statuses.${status}`)}
    </Pill>
  );
}

// A file the browser makes itself (the template): a Blob, a hidden link, a click
function saveText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// The problems of one failed import, row by row
function Problems({ importId, onClose }: { importId: string; onClose: () => void }) {
  const { t, errorText } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const detail = useQuery(productImportQuery(tenantId, importId)).data;
  if (!detail) return null;
  return (
    <DialogContent
      title={t('imports.problemsTitle', { file: detail.fileName })}
      description={t('imports.problemsDescription')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="max-h-[60vh] overflow-auto rounded-control border border-line">
        <table className="w-full border-collapse text-body-sm">
          <thead className="sticky top-0 bg-subtle text-left text-caption text-ink-3">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('imports.row')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('imports.column')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('imports.problem')}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.errors.map((problem, index) => (
              <tr key={index} className="border-t border-line align-top">
                <td className="px-3 py-2 tabular-nums">{problem.row ?? t('imports.wholeFile')}</td>
                <td className="px-3 py-2 font-mono text-caption text-ink-2">
                  {problem.column ?? '—'}
                </td>
                <td className="px-3 py-2 text-ink-2">
                  {isErrorCode(problem.code)
                    ? errorText(problem.code, problem.params)
                    : problem.code}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.errorCount > detail.errors.length && (
        <p className="mt-3 text-label text-ink-3">
          {t('imports.moreProblems', {
            shown: Math.min(detail.errors.length, PRODUCT_IMPORT_MAX_ERRORS),
            count: detail.errorCount,
          })}
        </p>
      )}
    </DialogContent>
  );
}

export function ProductImportsPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const canManage = useCan()('inventory.product.manage');
  const { data: imports, isError } = useQuery({
    ...productImportsQuery(tenantId),
    enabled: canManage,
  });
  const fields = useQuery(productFieldsQuery(tenantId)).data;
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showing, setShowing] = useState<string | null>(null);

  // Three steps, like a logo upload (step 6): the row and an address, the file straight to
  // storage, then "start" — the API checks the stored file before the worker is asked
  const upload = useMutation({
    mutationFn: async (picked: File) => {
      const ticket = await call(routes.productImports.create, {
        body: { fileName: picked.name, sizeBytes: picked.size },
      });
      const put = await fetch(ticket.upload.url, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: picked,
      });
      if (!put.ok) throw new Error(`Upload failed with ${String(put.status)}`);
      return call(routes.productImports.start, { params: { id: ticket.import.id } });
    },
    onSuccess: async (started) => {
      await queryClient.invalidateQueries({ queryKey: productImportsQuery(tenantId).queryKey });
      toast(t('imports.started', { file: started.fileName }));
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    },
  });

  const pick = (picked: File | null) => {
    setFile(picked);
    if (!picked) {
      setProblem(null);
      return;
    }
    // The same schema as the API: a .xlsx or a 6 MB file is refused before any upload
    const checked = createProductImportInputSchema.safeParse({
      fileName: picked.name,
      sizeBytes: picked.size,
    });
    const code = checked.error?.issues[0]?.message;
    setProblem(code !== undefined && isErrorCode(code) ? code : null);
  };

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('fileName', {
          header: t('imports.columns.file'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-medium">{row.original.fileName}</span>
              <span className="text-caption text-ink-3">
                {format.dateTime(new Date(row.original.createdAt), timeZone)}
              </span>
            </span>
          ),
        }),
        column.accessor((item) => item.requestedBy.fullName, {
          id: 'by',
          header: t('imports.columns.by'),
          meta: { card: 'subtitle' },
        }),
        column.accessor('status', {
          header: t('imports.columns.status'),
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <StatusPill status={getValue()} />,
        }),
        column.accessor((item) => item.productCount ?? item.errorCount, {
          id: 'result',
          header: t('imports.columns.result'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => {
            const item = row.original;
            if (item.status === 'done') {
              const count = item.productCount ?? 0;
              return t('imports.products', { count, formatted: format.number(count) });
            }
            if (item.status !== 'failed') return '—';
            return (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowing(item.id);
                }}
              >
                {t('imports.showProblems')} · {t('imports.problems', { count: item.errorCount })}
              </Button>
            );
          },
        }),
      ]),
    [t, format, timeZone],
  );

  if (!canManage) {
    return (
      <div className="grid max-w-4xl grid-cols-1 gap-5">
        <PageHeader title={t('imports.title')} description={t('imports.description')} />
        <p className="text-body-sm text-ink-3">{t('imports.readOnly')}</p>
      </div>
    );
  }

  const failure =
    upload.error instanceof ApiRequestError
      ? upload.error.code
      : upload.error
        ? 'unknown_error'
        : undefined;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('imports.title')}
        description={t('imports.description')}
        actions={
          <Button
            variant="secondary"
            disabled={!fields}
            onClick={() => {
              saveText('omnivo-products-template.csv', importTemplate(fields ?? []));
            }}
          >
            <HugeiconsIcon icon={Download04Icon} size={17} strokeWidth={1.5} />
            {t('imports.template')}
          </Button>
        }
      />
      <Card>
        <CardHeader title={t('imports.howTitle')} />
        <div className="grid gap-5 p-5">
          <ol className="grid list-decimal gap-2 pl-5 text-body-sm text-ink-2">
            <li>{t('imports.how.template')}</li>
            <li>{t('imports.how.save')}</li>
            <li>{t('imports.how.upload')}</li>
          </ol>
          {failure && <FormAlert message={failure} />}
          <form
            noValidate
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (file && problem === null) upload.mutate(file);
            }}
          >
            <Field
              id="import-file"
              label={t('imports.file')}
              hint={t('imports.fileHint')}
              error={problem ?? undefined}
            >
              <input
                ref={fileInput}
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                aria-describedby={problem ? 'import-file-error' : 'import-file-hint'}
                className="min-h-[42px] rounded-control border border-line-strong bg-surface px-3 py-2 text-body-sm shadow-sm file:mr-3 file:rounded-lg file:border-0 file:bg-subtle file:px-3 file:py-1 file:text-body-sm file:font-medium file:text-ink"
                onChange={(event) => {
                  pick(event.target.files?.[0] ?? null);
                }}
              />
            </Field>
            <Button
              type="submit"
              disabled={!file || problem !== null || upload.isPending}
              className="sm:mb-[26px]"
            >
              <HugeiconsIcon icon={Upload04Icon} size={17} strokeWidth={1.5} />
              {upload.isPending ? t('imports.uploading') : t('imports.submit')}
            </Button>
          </form>
        </div>
      </Card>
      <SectionHeader title={t('imports.history')} subtitle={t('imports.historySubtitle')} />
      {isError && <p className="text-body-sm text-crit">{t('imports.loadFailed')}</p>}
      {imports && (
        <DataTable
          label={t('imports.history')}
          data={imports}
          columns={columns}
          getRowId={(item) => item.id}
          empty={
            <EmptyState
              icon={FileImportIcon}
              title={t('imports.emptyTitle')}
              description={t('imports.emptyBody')}
            />
          }
        />
      )}
      <Dialog
        open={showing !== null}
        onOpenChange={(open) => {
          if (!open) setShowing(null);
        }}
      >
        {showing !== null && (
          <Problems
            importId={showing}
            onClose={() => {
              setShowing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **`upload`** does the three steps of decision 3 in one mutation: the row and its address, the file straight to
  storage, then `start`. The file never passes through the API.
- **`pick()` checks the file with the contract's schema** before any upload: an `.xlsx` or a 6 MB file is refused at
  once, and Import stays disabled.
- **`saveText()`** downloads the template the browser made itself (no route): a Blob, a hidden link, a click.
- **`Problems`** loads the detail of a failed import and lists row, column and problem, in the reader's language with
  the error's values (`errorText(code, params)`). "Whole file" stands for a problem with no row.

---

## 12.8 — MSW: the products in the mocks

**File: `apps/app/src/mocks/product-data.ts`** (new)

```ts
import {
  type CustomFieldDefinition,
  customFieldsInputSchema,
  type ErrorCode,
  formatDocumentNumber,
  isErrorCode,
  type Product,
  type ProductCategory,
  type ProductImport,
  type ProductImportDetail,
  type ProductImportError,
  type ProductInput,
  type ProductSort,
  type ProductStatus,
  type ProductSummary,
  sameFactor,
  standardFactor,
  type Unit,
  variantSku,
} from '@omnivo/contracts';

import { MockProblem } from './mock';

// The mock's products, units, categories, custom fields and imports. A shorter copy of the API's
// templates (apps/api/src/setup/templates.ts) — the mock cannot import server code — and the same
// rules as the API where the UI shows their errors.

export interface MockImport extends ProductImportDetail {
  // When the pretend worker finishes it, and the uploaded text it reads
  readyAt: number;
  text: string | null;
}

export interface MockCatalog {
  units: Unit[];
  categories: ProductCategory[];
  fields: CustomFieldDefinition[];
  products: Product[];
  imports: MockImport[];
  // The last product code given (P-00042)
  lastCode: number;
}

function now(): string {
  return new Date().toISOString();
}

function unit(
  code: string,
  name: string,
  dimension: string,
  ratio: string | null,
  decimals = 0,
): Unit {
  return {
    id: crypto.randomUUID(),
    code,
    name,
    dimension,
    ratio,
    decimals,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

function field(
  key: string,
  label: string,
  type: string,
  options: string[] = [],
  required = false,
): CustomFieldDefinition {
  return {
    id: crypto.randomUUID(),
    entity: 'product',
    key,
    label,
    type,
    options,
    required,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

const COMMON_UNITS = () => [
  unit('pcs', 'Pieces', 'count', '1.000000'),
  unit('dozen', 'Dozen', 'count', '12.000000'),
  unit('kg', 'Kilogram', 'weight', '1.000000', 3),
  unit('g', 'Gram', 'weight', '0.001000'),
  unit('m', 'Metre', 'length', '1.000000', 2),
  unit('l', 'Litre', 'volume', '1.000000', 3),
  unit('box', 'Box', 'count', null),
  unit('carton', 'Carton', 'count', null),
];

// Categories from a [name, children] list; returns them flat with parent ids, like the API
function categoriesOf(tree: readonly (readonly [string, readonly string[]])[]): ProductCategory[] {
  return tree.flatMap(([name, children]) => {
    const parent: ProductCategory = {
      id: crypto.randomUUID(),
      parentId: null,
      name,
      productCount: 0,
      version: 1,
      updatedAt: now(),
    };
    return [
      parent,
      ...children.map((child) => ({
        ...parent,
        id: crypto.randomUUID(),
        parentId: parent.id,
        name: child,
      })),
    ];
  });
}

export function emptyCatalog(): MockCatalog {
  return { units: [], categories: [], fields: [], products: [], imports: [], lastCode: 0 };
}

// What the setup job gives a new workspace (no products: those are the company's own)
export function startingCatalog(industry: string): MockCatalog {
  const pharma = industry === 'pharma';
  return {
    ...emptyCatalog(),
    units: pharma
      ? [
          ...COMMON_UNITS(),
          unit('strip', 'Strip', 'count', null),
          unit('bottle', 'Bottle', 'count', null),
        ]
      : [
          ...COMMON_UNITS(),
          unit('yard', 'Yard', 'length', '0.914400', 2),
          unit('gross', 'Gross', 'count', '144.000000'),
          unit('cone', 'Cone', 'count', null),
        ],
    categories: pharma
      ? categoriesOf([
          ['Finished products', ['Tablets', 'Capsules', 'Syrups and suspensions']],
          ['Raw materials', ['Active ingredients (API)', 'Excipients']],
          ['Packing materials', []],
        ])
      : categoriesOf([
          ['Fabrics', ['Knit', 'Woven']],
          ['Trims and accessories', ['Buttons', 'Labels', 'Sewing thread']],
          ['Packing materials', []],
          ['Finished garments', ['T-shirts', 'Polo shirts', 'Trousers', 'Jackets']],
        ]),
    fields: pharma
      ? [
          field('generic_name', 'Generic name', 'text', [], true),
          field('strength', 'Strength', 'text'),
          field('dosage_form', 'Dosage form', 'select', [
            'Tablet',
            'Capsule',
            'Syrup',
            'Injection',
          ]),
        ]
      : [
          field('buyer', 'Buyer', 'text'),
          field('composition', 'Fabric composition', 'text'),
          field('gsm', 'GSM', 'number'),
        ],
  };
}

function codeAt(sequence: number): string {
  return formatDocumentNumber({ prefix: 'P', yearStyle: 'none', padding: 5 }, '', sequence);
}

function variantOf(
  sku: string,
  optionValues: string[],
  salePrice: string | null,
  barcode: string | null = null,
) {
  return { id: crypto.randomUUID(), sku, optionValues, barcode, salePrice, archivedAt: null };
}

// A product as the API would return it, from a short description
function product(
  catalog: MockCatalog,
  parts: {
    code: string;
    name: string;
    category: string;
    base: string;
    price: string | null;
    options?: { name: string; values: string[] }[];
    barcode?: string;
    packs?: [string, string][];
    customFields?: Record<string, string>;
    updatedMinutesAgo?: number;
  },
): Product {
  const categoryId =
    catalog.categories.find((category) => category.name === parts.category)?.id ?? null;
  const unitId = (code: string) => catalog.units.find((unit) => unit.code === code)?.id ?? '';
  const options = parts.options ?? [];
  const combos = options.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])),
    [[]],
  );
  return {
    id: crypto.randomUUID(),
    code: parts.code,
    name: parts.name,
    type: 'goods',
    categoryId,
    description: null,
    baseUnitId: unitId(parts.base),
    salesUnitId: null,
    purchaseUnitId: parts.packs?.[0] ? unitId(parts.packs[0][0]) : null,
    tracking: 'none',
    hasExpiry: false,
    options,
    variants: combos.map((values) =>
      variantOf(
        variantSku(parts.code, values),
        values,
        parts.price,
        values.length === 0 ? (parts.barcode ?? null) : null,
      ),
    ),
    units: (parts.packs ?? []).map(([code, factor]) => ({
      unitId: unitId(code),
      factor,
      barcode: null,
    })),
    customFields: parts.customFields ?? {},
    archivedAt: null,
    version: 1,
    updatedAt: new Date(Date.now() - (parts.updatedMinutesAgo ?? 60) * 60_000).toISOString(),
  };
}

const GARMENTS = ['T-shirt', 'Polo shirt', 'Hoodie', 'Trouser', 'Jacket', 'Sweatshirt'] as const;
const CATEGORY_OF = {
  'T-shirt': 'T-shirts',
  'Polo shirt': 'Polo shirts',
  Hoodie: 'Jackets',
  Trouser: 'Trousers',
  Jacket: 'Jackets',
  Sweatshirt: 'T-shirts',
} satisfies Record<(typeof GARMENTS)[number], string>;
const FITS = ['Regular fit', 'Slim fit', 'Oversized', 'Kids'] as const;
const BUYERS = ['H&M', 'Primark', 'Zara', 'C&A', 'Walmart'] as const;

// The garments workspace: a few real-looking products, then 10,000 styles — enough to see the
// list stay smooth (virtualized rows, 50 at a time from the server)
export function garmentsCatalog(): MockCatalog {
  const catalog = startingCatalog('garments');
  const named = [
    product(catalog, {
      code: 'ST-118',
      name: 'Pique polo shirt',
      category: 'Polo shirts',
      base: 'pcs',
      price: '650.0000',
      options: [
        { name: 'Size', values: ['M', 'L', 'XL'] },
        { name: 'Colour', values: ['Navy blue', 'White'] },
      ],
      packs: [['dozen', '12.000000']],
      customFields: { buyer: 'H&M', gsm: '220' },
      updatedMinutesAgo: 5,
    }),
    product(catalog, {
      code: 'P-00001',
      name: 'Basic crew-neck T-shirt',
      category: 'T-shirts',
      base: 'pcs',
      price: '320.0000',
      barcode: '8941100500118',
      customFields: { buyer: 'Primark', gsm: '160' },
    }),
    product(catalog, {
      code: 'P-00002',
      name: 'Single jersey 180 GSM',
      category: 'Knit',
      base: 'm',
      price: null,
      packs: [['yard', '0.914400']],
      customFields: { composition: '100% cotton', gsm: '180' },
    }),
    product(catalog, {
      code: 'P-00003',
      name: 'Shirt buttons 4-hole 18L',
      category: 'Buttons',
      base: 'pcs',
      price: null,
      packs: [['gross', '144.000000']],
    }),
    product(catalog, {
      code: 'P-00004',
      name: 'Poly mailer bag 10x14',
      category: 'Packing materials',
      base: 'pcs',
      price: '6.0000',
      packs: [['carton', '500.000000']],
    }),
  ];
  const generated = Array.from({ length: 10_000 }, (_, index) => {
    const garment = GARMENTS[index % GARMENTS.length] ?? 'T-shirt';
    const fit = FITS[index % FITS.length] ?? 'Regular fit';
    const style = 20_000 + index;
    return product(catalog, {
      code: `ST-${String(style)}`,
      name: `${fit} ${garment.toLowerCase()} ${String(style)}`,
      category: CATEGORY_OF[garment],
      base: 'pcs',
      price: `${String(300 + (index % 40) * 25)}.0000`,
      ...(index % 4 === 0 && { options: [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }] }),
      customFields: { buyer: BUYERS[index % BUYERS.length] ?? 'H&M' },
      updatedMinutesAgo: 60 + index,
    });
  });
  return { ...catalog, products: [...named, ...generated], lastCode: 4 };
}

export function pharmaCatalog(): MockCatalog {
  const catalog = startingCatalog('pharma');
  const napa = product(catalog, {
    code: 'P-00001',
    name: 'Napa 500 mg',
    category: 'Tablets',
    base: 'pcs',
    price: '1.2000',
    barcode: '8941100500200',
    packs: [
      ['strip', '10.000000'],
      ['box', '100.000000'],
    ],
    customFields: { generic_name: 'Paracetamol', strength: '500 mg', dosage_form: 'Tablet' },
  });
  return {
    ...catalog,
    products: [{ ...napa, tracking: 'batch', hasExpiry: true }],
    lastCode: 1,
  };
}

// --- The list -----------------------------------------------------------------------------------

export function productSummaryOf(item: Product): ProductSummary {
  const active = item.variants.filter((variant) => variant.archivedAt === null);
  const prices = active.flatMap((variant) =>
    variant.salePrice === null ? [] : [Number(variant.salePrice)],
  );
  const money = (value: number) => value.toFixed(4);
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    type: item.type,
    categoryId: item.categoryId,
    baseUnitId: item.baseUnitId,
    tracking: item.tracking,
    hasVariants: item.options.length > 0,
    variantCount: active.length,
    minPrice: prices.length === 0 ? null : money(Math.min(...prices)),
    maxPrice: prices.length === 0 ? null : money(Math.max(...prices)),
    archivedAt: item.archivedAt,
    updatedAt: item.updatedAt,
  };
}

// The API's filters and orders, on an array. The cursor is an offset, like the mock's other lists.
export function listProducts(
  catalog: MockCatalog,
  query: {
    search?: string | undefined;
    categoryId?: string | undefined;
    status: ProductStatus;
    sort: ProductSort;
  },
) {
  const search = query.search?.toLowerCase() ?? '';
  const inside = new Set<string>();
  if (query.categoryId !== undefined) {
    inside.add(query.categoryId);
    for (let grew = true; grew;) {
      grew = false;
      for (const category of catalog.categories) {
        if (
          category.parentId !== null &&
          inside.has(category.parentId) &&
          !inside.has(category.id)
        ) {
          inside.add(category.id);
          grew = true;
        }
      }
    }
  }
  const found = catalog.products.filter(
    (item) =>
      (query.status === 'archived') === (item.archivedAt !== null) &&
      (query.categoryId === undefined ||
        (item.categoryId !== null && inside.has(item.categoryId))) &&
      (search === '' ||
        item.name.toLowerCase().includes(search) ||
        item.code.toLowerCase().includes(search) ||
        item.variants.some(
          (variant) =>
            variant.sku.toLowerCase().includes(search) || variant.barcode === query.search,
        )),
  );
  const by = {
    name: (a: Product, b: Product) => a.name.localeCompare(b.name),
    '-name': (a: Product, b: Product) => b.name.localeCompare(a.name),
    code: (a: Product, b: Product) => a.code.localeCompare(b.code),
    '-code': (a: Product, b: Product) => b.code.localeCompare(a.code),
    '-updated': (a: Product, b: Product) => b.updatedAt.localeCompare(a.updatedAt),
  };
  return found.sort(by[query.sort]);
}

// --- Saving, with the API's rules ---------------------------------------------------------------

function problem(status: number, path: string, code: ErrorCode): MockProblem {
  return new MockProblem(status, status === 409 ? code : 'invalid_input', { [path]: [code] });
}

export function saveProduct(
  catalog: MockCatalog,
  input: ProductInput,
  existing?: Product,
): Product {
  const unitOf = (id: string) => catalog.units.find((unit) => unit.id === id);
  const base = unitOf(input.baseUnitId);
  if (!base) throw problem(400, 'baseUnitId', 'product_unit_invalid');
  input.units.forEach((pack, index) => {
    const packUnit = unitOf(pack.unitId);
    if (!packUnit) throw problem(400, `units.${String(index)}.unitId`, 'product_unit_invalid');
    const standard = standardFactor(packUnit, base);
    if (standard !== null && !sameFactor(standard, pack.factor)) {
      throw problem(400, `units.${String(index)}.factor`, 'product_factor_standard');
    }
  });
  if (
    input.categoryId !== null &&
    !catalog.categories.some((category) => category.id === input.categoryId)
  ) {
    throw problem(400, 'categoryId', 'product_category_invalid');
  }
  const active = catalog.fields.filter((definition) => definition.archivedAt === null);
  const fields = customFieldsInputSchema(active).safeParse(input.customFields);
  if (!fields.success) {
    const fieldErrors: Record<string, ErrorCode[]> = {};
    for (const issue of fields.error.issues) {
      const path = ['customFields', ...issue.path.map(String)].join('.');
      (fieldErrors[path] ??= []).push(isErrorCode(issue.message) ? issue.message : 'invalid_value');
    }
    throw new MockProblem(400, 'invalid_input', fieldErrors);
  }

  const others = catalog.products.filter((item) => item.id !== existing?.id);
  let code = input.code ?? existing?.code;
  if (code === undefined) {
    catalog.lastCode += 1;
    code = codeAt(catalog.lastCode);
  }
  const folded = code.toLowerCase();
  if (others.some((item) => item.code.toLowerCase() === folded)) {
    throw problem(409, 'code', 'product_code_taken');
  }
  const skus = new Set(
    others.flatMap((item) => item.variants.map((variant) => variant.sku.toLowerCase())),
  );
  const barcodes = new Set(
    others.flatMap((item) => [
      ...item.variants.flatMap((variant) => (variant.barcode === null ? [] : [variant.barcode])),
      ...item.units.flatMap((pack) => (pack.barcode === null ? [] : [pack.barcode])),
    ]),
  );
  const known = new Map(existing?.variants.map((variant) => [variant.id, variant]));
  const variants = input.variants.map((variant, index) => {
    const sku = variant.sku ?? variantSku(code, variant.optionValues);
    if (skus.has(sku.toLowerCase()))
      throw problem(409, `variants.${String(index)}.sku`, 'product_sku_taken');
    if (variant.barcode !== null && barcodes.has(variant.barcode)) {
      throw problem(409, `variants.${String(index)}.barcode`, 'barcode_taken');
    }
    const before = variant.id === null ? undefined : known.get(variant.id);
    if (variant.id !== null && !before)
      throw problem(400, `variants.${String(index)}.id`, 'product_variant_unknown');
    return {
      id: before?.id ?? crypto.randomUUID(),
      sku,
      optionValues: variant.optionValues,
      barcode: variant.barcode,
      salePrice: variant.salePrice === null ? null : Number(variant.salePrice).toFixed(4),
      archivedAt: variant.archived ? (before?.archivedAt ?? now()) : null,
    };
  });
  // Archived fields keep their values: the form never sends them
  const kept = Object.fromEntries(
    Object.entries(existing?.customFields ?? {}).filter(
      ([key]) => !active.some((definition) => definition.key === key),
    ),
  );
  return {
    id: existing?.id ?? crypto.randomUUID(),
    code,
    name: input.name,
    type: input.type,
    categoryId: input.categoryId,
    description: input.description,
    baseUnitId: input.baseUnitId,
    salesUnitId: input.salesUnitId === input.baseUnitId ? null : input.salesUnitId,
    purchaseUnitId: input.purchaseUnitId === input.baseUnitId ? null : input.purchaseUnitId,
    tracking: input.tracking,
    hasExpiry: input.hasExpiry,
    options: input.options,
    variants,
    units: input.units.map((pack) => ({ ...pack, factor: Number(pack.factor).toFixed(6) })),
    customFields: { ...kept, ...fields.data },
    archivedAt: existing?.archivedAt ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
}

export function findProduct(catalog: MockCatalog, id: string): Product {
  const found = catalog.products.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// --- Imports: a pretend worker ------------------------------------------------------------------

// How long the pretend import takes — long enough to see "Importing"
export const IMPORT_DELAY_MS = 1_500;

// A naive reading of the CSV (no quoted commas): enough for the mock. Rows need a name and a known
// unit; the rest is left out. All or nothing, like the real worker.
function readImport(
  catalog: MockCatalog,
  text: string,
): { errors: ProductImportError[]; rows: { name: string; unitId: string; price: string }[] } {
  const [head = '', ...lines] = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = head.split(',').map((cell) => cell.trim().toLowerCase());
  const errors: ProductImportError[] = [];
  for (const column of ['name', 'unit']) {
    if (!header.includes(column))
      errors.push({ row: 1, column, code: 'import_column_missing', params: { column } });
  }
  if (errors.length > 0) return { errors, rows: [] };
  const rows = lines.flatMap((line, index) => {
    if (line.trim() === '') return [];
    const cells = line.split(',');
    const cell = (column: string) => (cells[header.indexOf(column)] ?? '').trim();
    const row = index + 2;
    const unitId = catalog.units.find(
      (unit) => unit.code.toLowerCase() === cell('unit').toLowerCase(),
    )?.id;
    if (cell('name').length < 2)
      errors.push({ row, column: 'name', code: 'product_name_required' });
    if (!unitId)
      errors.push({
        row,
        column: 'unit',
        code: 'import_unit_unknown',
        params: { value: cell('unit') },
      });
    return unitId ? [{ name: cell('name'), unitId, price: cell('sale_price') }] : [];
  });
  if (rows.length === 0 && errors.length === 0)
    errors.push({ row: null, column: null, code: 'import_empty' });
  return { errors, rows };
}

export function settleImports(
  catalog: MockCatalog,
  notify: (type: 'import.done' | 'import.failed', params: { file: string; count: number }) => void,
): void {
  for (const item of catalog.imports) {
    if (item.status !== 'queued' || Date.now() < item.readyAt) continue;
    const { errors, rows } = readImport(catalog, item.text ?? '');
    const lineCount = rows.length + new Set(errors.map((error) => error.row)).size;
    if (errors.length > 0) {
      Object.assign(item, {
        status: 'failed',
        rowCount: lineCount,
        errorCount: errors.length,
        errors,
        finishedAt: now(),
      });
      notify('import.failed', { file: item.fileName, count: errors.length });
      continue;
    }
    for (const row of rows) {
      catalog.lastCode += 1;
      const code = codeAt(catalog.lastCode);
      catalog.products.push({
        ...product(catalog, {
          code,
          name: row.name,
          category: '',
          base: 'pcs',
          price: row.price === '' ? null : Number(row.price).toFixed(4),
        }),
        baseUnitId: row.unitId,
        updatedAt: now(),
      });
    }
    Object.assign(item, {
      status: 'done',
      rowCount: rows.length,
      productCount: rows.length,
      finishedAt: now(),
    });
    notify('import.done', { file: item.fileName, count: rows.length });
  }
}

// What the API sends of an import: the pretend worker's own fields left out
export function toImport(item: MockImport): ProductImport {
  return {
    id: item.id,
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    status: item.status,
    rowCount: item.rowCount,
    productCount: item.productCount,
    errorCount: item.errorCount,
    requestedBy: item.requestedBy,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
  };
}
```

- **A short copy of the templates**: the mock cannot import server code, so it keeps the units, categories and fields
  of the two fixture workspaces (garments and pharma).
- **`garmentsCatalog()` makes 10,000 styles** next to a few real-looking products (the polo shirt with six variants,
  fabric in metres with a yard pack, buttons by the gross, mailer bags by the carton). The build plan asks to see the
  list "smooth at 10,000 rows": the table draws only the rows on screen, and the server — here the mock — sends 50 at
  a time.
- **`listProducts()`** applies the API's filters and orders to an array; its cursor is an offset, like every other mock
  list.
- **`saveProduct()`** applies the rules whose errors the UI shows: units, the standard size, categories, custom fields,
  a code, SKU or barcode taken, a foreign variant id. It keeps archived fields' values, like the API.
- **The pretend import worker** (`settleImports()`, run on every request like the pretend export worker of step 11)
  reads the CSV naively (no quoted commas — enough for the mock), checks name and unit, and either creates simple
  products and says "done", or lists the problems — all or nothing.

**File: `apps/app/src/mocks/workspace-data.ts`** (change)

```diff
@@ -25,6 +25,7 @@ import { OWNER, type Workspace } from './fixtures';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
 import { type People, seedPeople } from './people-data';
+import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import type { MockExport } from './report-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
@@ -43,6 +44,8 @@ export interface WorkspaceData {
   journal: MockJournal;
   // "My exports", newest first; the pretend worker finishes them (report-data.ts)
   exports: MockExport[];
+  // Units, categories, custom fields, products and imports (step 12)
+  catalog: MockCatalog;
 }
 
 function now(): string {
@@ -95,6 +98,7 @@ function seed(workspace: Workspace): WorkspaceData {
     accounts: seedAccounts(garments ? 'garments' : 'pharma'),
     journal: emptyJournal(),
     exports: [],
+    catalog: garments ? garmentsCatalog() : pharmaCatalog(),
   };
   if (garments) seedJournal(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
@@ -153,6 +157,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.accounts = [];
   data.journal = emptyJournal();
   data.exports = [];
+  // Like the chart: the setup job brings the units and categories (settleSetup)
+  data.catalog = emptyCatalog();
   store.set(workspace.tenantId, data);
 }
 
```

**File: `apps/app/src/mocks/setup-data.ts`** (change)

```diff
@@ -2,6 +2,7 @@ import type { Industry, Setup } from '@omnivo/contracts';
 
 import { seedAccounts } from './accounting-data';
 import { MockProblem } from './mock';
+import { startingCatalog } from './product-data';
 import { record, type WorkspaceData } from './workspace-data';
 
 // How long the pretend setup job takes — long enough to see "Preparing the roles…"
@@ -54,6 +55,7 @@ export function settleSetup(data: WorkspaceData): void {
     });
   }
   if (data.accounts.length === 0) data.accounts = seedAccounts(industry);
+  if (data.catalog.units.length === 0) data.catalog = startingCatalog(industry);
   data.setup = { status: 'ready', industry };
   data.setupReadyAt = null;
   record(data, 'workspace.provisioned', 'workspace', crypto.randomUUID(), {
```

A signed-up mock workspace starts with no catalog; the pretend setup job gives it one, like the real one.

**File: `apps/app/src/mocks/handlers.ts`** (change)

```diff
@@ -2,6 +2,7 @@ import {
   type Account,
   type AuthSession,
   type Preferences,
+  type ProductCategory,
   routes,
   type Settings,
 } from '@omnivo/contracts';
@@ -58,6 +59,16 @@ import {
   toExport,
   trialBalanceOf,
 } from './report-data';
+import {
+  findProduct,
+  IMPORT_DELAY_MS,
+  listProducts,
+  type MockImport,
+  saveProduct,
+  settleImports,
+  productSummaryOf,
+  toImport,
+} from './product-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   assertCodeFree,
@@ -85,6 +96,15 @@ function current() {
   const data = dataOf(workspace);
   settleSetup(data);
   settleExports(data);
+  settleImports(data.catalog, (type, params) => {
+    data.notifications.unshift({
+      id: crypto.randomUUID(),
+      type,
+      params,
+      readAt: null,
+      createdAt: new Date().toISOString(),
+    });
+  });
   return data;
 }
 
@@ -130,6 +150,27 @@ function session(): AuthSession {
   };
 }
 
+// The API's sibling rule: two "Knit" in one place would be two answers to "which one?"
+function assertCategoryPlace(
+  categories: readonly ProductCategory[],
+  parentId: string | null,
+  name: string,
+  except?: string,
+): void {
+  if (parentId !== null && !categories.some((category) => category.id === parentId)) {
+    throw new MockProblem(409, 'category_parent_invalid', {
+      parentId: ['category_parent_invalid'],
+    });
+  }
+  const taken = categories.some(
+    (category) =>
+      category.id !== except &&
+      category.parentId === parentId &&
+      category.name.toLowerCase() === name.toLowerCase(),
+  );
+  if (taken) throw new MockProblem(409, 'category_name_taken', { name: ['category_name_taken'] });
+}
+
 // UI-র প্রতিটা পথ দেখার জন্য: লগইনে পাসওয়ার্ড "wrong-password" → invalid_credentials,
 // সাইনআপে ঠিকানা "rahman-garments" → slug_taken
 export const handlers = [
@@ -1083,4 +1124,413 @@ export const handlers = [
       });
     }),
   ),
+
+  // ---------------------------------------------------------------------------------------------
+  // Units, categories, custom fields, products and imports (step 12)
+
+  mock(routes.units.list, () => reply(routes.units.list, { items: current().catalog.units })),
+
+  mock(
+    routes.units.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.units.create.body, request);
+      const data = current();
+      if (data.catalog.units.some((unit) => unit.code.toLowerCase() === body.code.toLowerCase())) {
+        throw new MockProblem(409, 'unit_code_taken', { code: ['unit_code_taken'] });
+      }
+      const created = {
+        id: crypto.randomUUID(),
+        ...body,
+        ratio: body.ratio === null ? null : Number(body.ratio).toFixed(6),
+        archivedAt: null,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.catalog.units.push(created);
+      record(
+        data,
+        'unit.created',
+        'unit',
+        created.id,
+        diff({}, { code: body.code, name: body.name }),
+      );
+      return reply(routes.units.create, created);
+    }),
+  ),
+
+  mock(
+    routes.units.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.units.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.units.update.body, request);
+      const data = current();
+      const target = data.catalog.units.find((unit) => unit.id === id);
+      if (!target) throw new MockProblem(404, 'not_found');
+      checkVersion(target.version, version);
+      if (
+        data.catalog.units.some(
+          (unit) => unit.id !== id && unit.code.toLowerCase() === fields.code.toLowerCase(),
+        )
+      ) {
+        throw new MockProblem(409, 'unit_code_taken', { code: ['unit_code_taken'] });
+      }
+      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
+      record(data, 'unit.updated', 'unit', id);
+      return reply(routes.units.update, target);
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.units[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.units[action].params.parse(params);
+        const { version } = await readBody(routes.units[action].body, request);
+        const data = current();
+        const target = data.catalog.units.find((unit) => unit.id === id);
+        if (!target) throw new MockProblem(404, 'not_found');
+        checkVersion(target.version, version);
+        Object.assign(target, {
+          archivedAt: action === 'archive' ? new Date().toISOString() : null,
+          version: version + 1,
+        });
+        record(data, action === 'archive' ? 'unit.archived' : 'unit.restored', 'unit', id);
+        return reply(routes.units[action], target);
+      }),
+    ),
+  ),
+
+  mock(
+    routes.units.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.units.remove.params.parse(params);
+      const { version } = readQuery(routes.units.remove.query, request);
+      const data = current();
+      const target = data.catalog.units.find((unit) => unit.id === id);
+      if (!target) throw new MockProblem(404, 'not_found');
+      checkVersion(target.version, version);
+      const used = data.catalog.products.some(
+        (item) => item.baseUnitId === id || item.units.some((pack) => pack.unitId === id),
+      );
+      if (used) throw new MockProblem(409, 'unit_in_use');
+      data.catalog.units = data.catalog.units.filter((unit) => unit.id !== id);
+      record(data, 'unit.deleted', 'unit', id);
+      return reply(routes.units.remove, undefined);
+    }),
+  ),
+
+  mock(routes.productCategories.list, () => {
+    const { categories, products } = current().catalog;
+    return reply(routes.productCategories.list, {
+      items: categories.map((category) => ({
+        ...category,
+        productCount: products.filter((item) => item.categoryId === category.id).length,
+      })),
+    });
+  }),
+
+  mock(
+    routes.productCategories.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.productCategories.create.body, request);
+      const data = current();
+      assertCategoryPlace(data.catalog.categories, body.parentId, body.name);
+      const created = {
+        id: crypto.randomUUID(),
+        ...body,
+        productCount: 0,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.catalog.categories.push(created);
+      record(data, 'product_category.created', 'product_category', created.id);
+      return reply(routes.productCategories.create, created);
+    }),
+  ),
+
+  mock(
+    routes.productCategories.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.productCategories.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.productCategories.update.body, request);
+      const data = current();
+      const target = data.catalog.categories.find((category) => category.id === id);
+      if (!target) throw new MockProblem(404, 'not_found');
+      checkVersion(target.version, version);
+      // Walk up from the new parent: meeting the category itself means a loop
+      for (
+        let above = fields.parentId;
+        above !== null;
+        above = data.catalog.categories.find((category) => category.id === above)?.parentId ?? null
+      ) {
+        if (above === id) {
+          throw new MockProblem(409, 'category_parent_loop', {
+            parentId: ['category_parent_loop'],
+          });
+        }
+      }
+      assertCategoryPlace(data.catalog.categories, fields.parentId, fields.name, id);
+      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
+      record(data, 'product_category.updated', 'product_category', id);
+      return reply(routes.productCategories.update, {
+        ...target,
+        productCount: data.catalog.products.filter((item) => item.categoryId === id).length,
+      });
+    }),
+  ),
+
+  mock(
+    routes.productCategories.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.productCategories.remove.params.parse(params);
+      const { version } = readQuery(routes.productCategories.remove.query, request);
+      const data = current();
+      const target = data.catalog.categories.find((category) => category.id === id);
+      if (!target) throw new MockProblem(404, 'not_found');
+      checkVersion(target.version, version);
+      if (data.catalog.categories.some((category) => category.parentId === id)) {
+        throw new MockProblem(409, 'category_has_children');
+      }
+      if (data.catalog.products.some((item) => item.categoryId === id)) {
+        throw new MockProblem(409, 'category_in_use');
+      }
+      data.catalog.categories = data.catalog.categories.filter((category) => category.id !== id);
+      record(data, 'product_category.deleted', 'product_category', id);
+      return reply(routes.productCategories.remove, undefined);
+    }),
+  ),
+
+  mock(routes.customFields.list, () =>
+    reply(routes.customFields.list, { items: current().catalog.fields }),
+  ),
+
+  mock(
+    routes.customFields.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.customFields.create.body, request);
+      const data = current();
+      if (data.catalog.fields.some((field) => field.key === body.key)) {
+        throw new MockProblem(409, 'custom_field_key_taken', { key: ['custom_field_key_taken'] });
+      }
+      const created = {
+        id: crypto.randomUUID(),
+        ...body,
+        options: body.type === 'select' ? body.options : [],
+        required: body.type === 'boolean' ? false : body.required,
+        archivedAt: null,
+        version: 1,
+        updatedAt: new Date().toISOString(),
+      };
+      data.catalog.fields.push(created);
+      record(data, 'custom_field.created', 'custom_field', created.id);
+      return reply(routes.customFields.create, created);
+    }),
+  ),
+
+  mock(
+    routes.customFields.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.customFields.update.params.parse(params);
+      const { version, ...fields } = await readBody(routes.customFields.update.body, request);
+      const data = current();
+      const target = data.catalog.fields.find((field) => field.id === id);
+      if (!target) throw new MockProblem(404, 'not_found');
+      checkVersion(target.version, version);
+      if (target.type === 'select' && fields.options.length === 0) {
+        throw new MockProblem(400, 'invalid_input', { options: ['custom_field_options_required'] });
+      }
+      Object.assign(target, fields, { version: version + 1, updatedAt: new Date().toISOString() });
+      record(data, 'custom_field.updated', 'custom_field', id);
+      return reply(routes.customFields.update, target);
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.customFields[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.customFields[action].params.parse(params);
+        const { version } = await readBody(routes.customFields[action].body, request);
+        const data = current();
+        const target = data.catalog.fields.find((field) => field.id === id);
+        if (!target) throw new MockProblem(404, 'not_found');
+        checkVersion(target.version, version);
+        Object.assign(target, {
+          archivedAt: action === 'archive' ? new Date().toISOString() : null,
+          version: version + 1,
+        });
+        record(
+          data,
+          action === 'archive' ? 'custom_field.archived' : 'custom_field.restored',
+          'custom_field',
+          id,
+        );
+        return reply(routes.customFields[action], target);
+      }),
+    ),
+  ),
+
+  mock(routes.products.list, async ({ request }) => {
+    const query = readQuery(routes.products.list.query, request);
+    const start = query.cursor === undefined ? 0 : Number(query.cursor);
+    const all = listProducts(current().catalog, query);
+    const items = all.slice(start, start + query.limit).map(productSummaryOf);
+    const end = start + items.length;
+    // A short wait on later pages: "Loading more…" can be seen while scrolling
+    if (start > 0) await delay(300);
+    return reply(routes.products.list, {
+      items,
+      nextCursor: end < all.length ? String(end) : null,
+    });
+  }),
+
+  mock(
+    routes.products.get,
+    guarded(({ params }) => {
+      const { id } = routes.products.get.params.parse(params);
+      return reply(routes.products.get, findProduct(current().catalog, id));
+    }),
+  ),
+
+  mock(
+    routes.products.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.products.create.body, request);
+      const data = current();
+      const saved = saveProduct(data.catalog, body);
+      data.catalog.products.push(saved);
+      record(
+        data,
+        'product.created',
+        'product',
+        saved.id,
+        diff({}, { code: saved.code, name: saved.name }),
+      );
+      await delay();
+      return reply(routes.products.create, saved);
+    }),
+  ),
+
+  mock(
+    routes.products.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.products.update.params.parse(params);
+      const { version, ...body } = await readBody(routes.products.update.body, request);
+      const data = current();
+      const target = findProduct(data.catalog, id);
+      checkVersion(target.version, version);
+      const saved = saveProduct(data.catalog, body, target);
+      data.catalog.products = data.catalog.products.map((item) => (item.id === id ? saved : item));
+      record(
+        data,
+        'product.updated',
+        'product',
+        id,
+        diff({ name: target.name }, { name: saved.name }),
+      );
+      await delay();
+      return reply(routes.products.update, saved);
+    }),
+  ),
+
+  ...(['archive', 'restore'] as const).map((action) =>
+    mock(
+      routes.products[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.products[action].params.parse(params);
+        const { version } = await readBody(routes.products[action].body, request);
+        const data = current();
+        const target = findProduct(data.catalog, id);
+        checkVersion(target.version, version);
+        Object.assign(target, {
+          archivedAt: action === 'archive' ? new Date().toISOString() : null,
+          version: version + 1,
+          updatedAt: new Date().toISOString(),
+        });
+        record(data, action === 'archive' ? 'product.archived' : 'product.restored', 'product', id);
+        return reply(routes.products[action], target);
+      }),
+    ),
+  ),
+
+  mock(
+    routes.products.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.products.remove.params.parse(params);
+      const { version } = readQuery(routes.products.remove.query, request);
+      const data = current();
+      const target = findProduct(data.catalog, id);
+      checkVersion(target.version, version);
+      data.catalog.products = data.catalog.products.filter((item) => item.id !== id);
+      record(data, 'product.deleted', 'product', id, diff({ name: target.name }, { name: null }));
+      return reply(routes.products.remove, undefined);
+    }),
+  ),
+
+  mock(routes.productImports.create, async ({ request }) => {
+    const body = await readBody(routes.productImports.create.body, request);
+    const item: MockImport = {
+      id: crypto.randomUUID(),
+      ...body,
+      status: 'uploading',
+      rowCount: null,
+      productCount: null,
+      errorCount: 0,
+      errors: [],
+      requestedBy: { id: OWNER.id, fullName: OWNER.fullName },
+      createdAt: new Date().toISOString(),
+      finishedAt: null,
+      readyAt: 0,
+      text: null,
+    };
+    current().catalog.imports.unshift(item);
+    return reply(routes.productImports.create, {
+      import: toImport(item),
+      upload: {
+        method: 'PUT',
+        url: `${MOCK_STORAGE}/imports/${item.id}`,
+        headers: { 'content-type': 'text/csv' },
+        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
+      },
+    });
+  }),
+
+  // The CSV goes to the pretend storage: kept as text for the pretend worker
+  http.put(`${MOCK_STORAGE}/imports/:id`, async ({ request, params }) => {
+    const item = current().catalog.imports.find((candidate) => candidate.id === params.id);
+    if (!item) return new HttpResponse(null, { status: 404 });
+    item.text = await request.text();
+    await delay(400);
+    return new HttpResponse(null, { status: 200 });
+  }),
+
+  mock(
+    routes.productImports.start,
+    guarded(({ params }) => {
+      const { id } = routes.productImports.start.params.parse(params);
+      const item = current().catalog.imports.find((candidate) => candidate.id === id);
+      if (!item) throw new MockProblem(404, 'not_found');
+      if (item.status !== 'uploading') throw new MockProblem(409, 'import_not_pending');
+      if (item.text === null) throw new MockProblem(409, 'import_not_uploaded');
+      Object.assign(item, { status: 'queued', readyAt: Date.now() + IMPORT_DELAY_MS });
+      return reply(routes.productImports.start, toImport(item));
+    }),
+  ),
+
+  mock(routes.productImports.list, () =>
+    reply(routes.productImports.list, {
+      items: current().catalog.imports.map(toImport),
+      nextCursor: null,
+    }),
+  ),
+
+  mock(
+    routes.productImports.get,
+    guarded(({ params }) => {
+      const { id } = routes.productImports.get.params.parse(params);
+      const item = current().catalog.imports.find((candidate) => candidate.id === id);
+      if (!item) throw new MockProblem(404, 'not_found');
+      return reply(routes.productImports.get, { ...toImport(item), errors: item.errors });
+    }),
+  ),
 ];
```

- **`assertCategoryPlace()`** is the API's sibling rule and "the parent exists".
- **The move loop check walks up** from the new parent, like the API's recursive query.
- **`http.put(…/imports/:id)`** stands in for storage: it keeps the CSV as text for the pretend worker. It is a plain
  MSW handler, not `mock()`, because storage is not a contract route.
- **`productSummaryOf`**, not `summaryOf`: the journal mock already exports a `summaryOf`, and `handlers.ts` imports
  both.

---

## 12.9 — Playwright

**File: `apps/app/e2e/products.e2e.ts`** (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// The nav says "Categories" and "Imports"; their pages say more in their headings
async function openPage(page: Page, link: string, heading: string) {
  await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

async function newProduct(page: Page) {
  await openFromNav(page, 'Products');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New product' })).toBeVisible();
}

test('finds a product by name or by a scanned barcode, and opens it', async ({ page }) => {
  await openFromNav(page, 'Products');
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill('pique');
  await expect(listItem(page, /Pique polo shirt/)).toBeVisible();
  // A barcode is matched whole, like a scan into the box
  await search.fill('8941100500118');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
  await expect(listItem(page, /Pique polo shirt/)).toBeHidden();
  await search.fill('cashmere');
  await expect(page.getByText('No product matches "cashmere"')).toBeVisible();

  await search.fill('pique');
  await listItem(page, /Pique polo shirt/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit ST-118' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'M / Navy blue' }).getByLabel('SKU')).toHaveValue(
    'ST-118-M-NAVY-BLUE',
  );
  await expectNoSideScroll(page);
});

test('adds a simple product with a pack, and fills in a standard unit’s size', async ({ page }) => {
  await newProduct(page);
  await page.getByLabel('Name').fill('Poly mailer bag 12x16');
  await page.getByRole('button', { name: 'Add a pack' }).click();
  // A dozen is always 12 pieces: filled in, not typed
  await page.getByLabel('Pack', { exact: true }).selectOption({ label: 'dozen · Dozen' });
  await expect(page.getByLabel('Holds')).toHaveValue('12');
  await expect(page.getByText('A standard size, filled in for you.')).toBeVisible();
  // A carton's size is the product's own
  await page.getByLabel('Pack', { exact: true }).selectOption({ label: 'carton · Carton' });
  await page.getByLabel('Holds').fill('500');
  await page.getByLabel('Buy in').selectOption({ label: 'carton · Carton' });
  await page.getByLabel('Barcode (optional)', { exact: true }).fill('8941100500119');
  await page.getByRole('button', { name: 'Add product' }).click();
  // One wrong digit of a retail barcode is caught before anything is sent
  await expect(page.getByText('The last digit is wrong for this barcode.')).toBeVisible();
  await page.getByLabel('Barcode (optional)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByText('Poly mailer bag 12x16 added')).toBeVisible();
  // The next code of the series
  await expect(page.getByRole('heading', { level: 1, name: 'Edit P-00005' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('makes a product with sizes and colours, one variant per combination', async ({ page }) => {
  await newProduct(page);
  await page.getByLabel('Name').fill('Fleece hoodie');
  // Optional fields say so in their label
  await page.getByLabel('Code (optional)', { exact: true }).fill('ST-305');
  await page.getByText('With variants').click();
  await page.getByLabel('Option', { exact: true }).fill('Size');
  await page.getByLabel('Values').fill('S, M');
  await page.getByRole('button', { name: 'Add an option' }).click();
  await page.getByLabel('Option', { exact: true }).nth(1).fill('Colour');
  await page.getByLabel('Values').nth(1).fill('Navy, White');
  await page.getByRole('button', { name: 'Create the variants' }).click();

  const variants = page.getByRole('list', { name: 'Variants' });
  await expect(variants.getByRole('group')).toHaveCount(4);
  await variants
    .getByRole('group', { name: 'S / Navy' })
    .getByLabel('Sale price per pcs')
    .fill('950');
  await variants
    .getByRole('group', { name: 'M / White' })
    .getByRole('button', { name: 'Remove M / White' })
    .click();
  await expect(variants.getByRole('group')).toHaveCount(3);
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Edit ST-305' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'S / White' }).getByLabel('SKU')).toHaveValue(
    'ST-305-S-WHITE',
  );
  // Back to the list: three variants, the one price
  await page.getByRole('link', { name: '← Products' }).click();
  await page.getByRole('searchbox', { name: 'Search products' }).fill('fleece');
  await expect(listItem(page, /Fleece hoodie/)).toContainText('3 variants');
  await expect(listItem(page, /Fleece hoodie/)).toContainText('৳950.00');
});

test('keeps categories in a tree, and an emptied one only can go', async ({ page }) => {
  await openPage(page, 'Categories', 'Product categories');
  await page.getByRole('button', { name: 'Add a category to Fabrics' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add category' });
  await expect(dialog.getByLabel('Inside')).toHaveValue(/.+/);
  await dialog.getByLabel('Name').fill('knit');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await expect(dialog.getByText('This place already has a category with this name.')).toBeVisible();
  await dialog.getByLabel('Name').fill('Denim');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByText('Denim added')).toBeVisible();

  const tree = page.getByRole('list', { name: 'Product categories' });
  await tree.getByRole('button', { name: 'Knit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Knit' });
  await edit.getByRole('button', { name: 'Delete' }).click();
  await edit.getByRole('button', { name: 'Delete Knit' }).click();
  await expect(edit.getByRole('alert')).toHaveText(/Move them to another category first/);
});

test('adds a custom field, which the product form then shows', async ({ page }) => {
  await openFromNav(page, 'Custom fields');
  await page.getByRole('button', { name: 'Add field' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add field' });
  await dialog.getByLabel('Label').fill('Wash care');
  // The column name follows the label until it is typed by hand
  await expect(dialog.getByLabel('Column name in imports')).toHaveValue('wash_care');
  await dialog.getByLabel('Type').selectOption({ label: 'Choice from a list' });
  await dialog.getByLabel('Choices').fill('Hand wash\nMachine wash 30°C');
  await dialog.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText('Wash care added')).toBeVisible();

  await newProduct(page);
  await expect(page.getByLabel('Wash care')).toBeVisible();
  await page.getByLabel('GSM').fill('heavy');
  await page.getByLabel('Name').fill('Rib cuff sweatshirt');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByText('Enter a number, like 180 or 12.5.')).toBeVisible();
});

test('imports a CSV file, or lists what to fix in it', async ({ page }) => {
  await openPage(page, 'Imports', 'Import products');
  const file = page.getByLabel('CSV file');
  await file.setInputFiles({
    name: 'trims.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,unit,sale_price\nYKK zipper 7 inch,pcs,18\nCare label,pcs,1.5\n'),
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('trims.csv is being imported.')).toBeVisible();
  await expect(page.getByText('2 products')).toBeVisible();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();

  await file.setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,unit\nWoven label,tablet\n'),
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByRole('button', { name: /See problems/ }).click();
  const problems = page.getByRole('dialog', { name: 'Problems in bad.csv' });
  await expect(problems.getByRole('row', { name: /2 unit No unit "tablet"/ })).toBeVisible();

  // A spreadsheet that is not a CSV is refused before any upload
  await page.keyboard.press('Escape');
  await file.setInputFiles({
    name: 'products.xlsx',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from('x'),
  });
  await expect(page.getByText('Pick a CSV file.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await expectNoSideScroll(page);
});
```

Six flows, each at 1280px and 390px:

- **Search** by name and by a whole barcode, no match, and opening a product.
- **A simple product with a pack**: the dozen's size filled in and fixed, a carton's typed, a barcode with a wrong
  check digit refused before sending, and the next code of the series.
- **Sizes and colours**: four combinations, a price on one, one removed, saved with SKUs from the code; the list shows
  "3 variants" and the price.
- **Categories**: a name taken among siblings, a new sub-category, and a category with products refused.
- **A custom field** that appears in the product form and checks its value.
- **The import**: a good file ("2 products"), a bad one with its problem listed, and an `.xlsx` refused before upload.

Optional fields say so in their label ("Barcode (optional)"), so the tests find them by their full name;
`getByLabel('Code')` alone would also match "Barcode".

`openPage()` exists because the nav says "Categories" and "Imports" while those pages' headings say "Product
categories" and "Import products"; `openFromNav()` expects them to be the same.

---

## 12.10 — Root files

`pnpm-lock.yaml` changes with `csv-parse` (12.4). No new `.env` line, no change to `.gitignore` or the CI workflow.

```bash
pnpm gen:openapi      # openapi.json — 73 paths (56 before); commit it
```

---

## 12.11 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", after "Line editor":

> - **Variant rows (product form):** inside a container (`@container`); on a wide card (`@3xl`) one grid template for a
>   caption header and every row: values, SKU, barcode, price, archived, remove. Each cell is `grid-cols-1` with
>   `minmax(0, …)` columns, so inputs shrink with the card. On a narrow card each control shows its label.
> - **Pack rows:** a bordered box (radius 10px) per pack: unit, "Holds" with the base unit as suffix (read-only with a
>   hint when the size is standard), the pack barcode (simple products only), remove.

**build-plan.bn.md** — step 12's text:

> `units` (dimension, ratio, decimals; প্রতি ইন্ডাস্ট্রির টেমপ্লেট), `product_categories` (tree), `products` +
> `product_variants` (simple প্রোডাক্টেও একটা variant — পরের সব লাইন `variant_id` ধরে), `product_units` (pack, standard
> unit-এর মাপ নির্দিষ্ট), `product_barcodes` (workspace-জুড়ে এক মানে, EAN check digit), `custom_field_definitions` +
> `custom_fields JSONB`, **`tracking: none | batch | serial`**, `batches` ও `serials` টেবিল — স্কিমা এখনই, UI ধাপ
> ১৩-এ। CSV import worker-এ (সব বা কিছুই না, savepoint), `inventory.product.manage`।
> **দেখবেন:** প্রোডাক্ট লিস্ট (virtualized, ১০,০০০ রো মসৃণ), ভ্যারিয়েন্ট সহ ফর্ম, CSV import।

**COMMANDS.md** — in the database section:

````markdown
```sh
# product imports: status and counts (a 'queued' one older than a minute means the worker is not running)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, i.file_name, i.status, i.row_count, i.product_count, i.error_count, i.created_at FROM product_imports i JOIN tenants t ON t.id = i.tenant_id ORDER BY i.id DESC LIMIT 20"
# products per workspace, and whether its catalog arrived (no units = the catalog job has not run)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, (SELECT count(*) FROM units u WHERE u.tenant_id = t.id) AS units, (SELECT count(*) FROM products p WHERE p.tenant_id = t.id) AS products FROM tenants t ORDER BY t.slug"
```
````

---

## 12.12 — Run it

```bash
pnpm install                                  # csv-parse (12.4)
pnpm db:migrate                               # 0019 + 0020, the new permission, the catalog jobs
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it, the worker too
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('units', 'products', 'product_variants', 'product_imports');   -- t for each
SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';                         -- pg_trgm
SELECT count(*) FROM units;                                                         -- not 0 once the worker ran
```

### What you will see

1. **Your existing roles do not have `inventory.product.manage` yet.** As the owner you have it. For your store keeper
   or merchandiser: Roles → the new "Inventory" section → tick it.
2. A new sidebar group **Inventory**: Products, Categories, Units, Imports. And **Custom fields** under Workspace.
3. **Units**: your business type's units. Add "Bale" (Count, size empty = a pack). Open "yard": its size is fixed text.
4. **Categories**: the tree. Add a sub-category from a row's "+".
5. **Products → Add product**: a name, a pack of "dozen" (12, filled in and fixed), a carton (type 24), "Buy in:
   carton", a sale price. Save → `P-00001`.
6. **With variants**: Size `S, M, L`, Colour `Navy, White` → Create the variants → six rows with SKUs made on save.
   Archive one colour; remove a row you never make.
7. **Products list**: search part of a name, a SKU, or a whole barcode; filter by a parent category (its children's
   products show too); sort by name or code.
8. **Imports → Download the template**, fill two rows, save as CSV UTF-8, Import. A few seconds later the bell:
   "…: 2 products imported." Then a file with an unknown unit: "Not imported" → See problems → row and column.
   Nothing from that file is in the list.
9. **Custom fields**: add "Season" (a choice: Spring, Winter). The product form shows it under "More details".
10. **Bangla**: প্রোডাক্ট, ইউনিট, ক্যাটাগরি; the counts in Bangla digits.
11. DevTools at 390px: the list becomes cards, the variant rows stack with their labels, and the page never scrolls
    sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 218: contracts 76 + api 68 + app 37 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 175 — 22 new
pnpm test:tenant-leak        # 39 — 4 new
pnpm test:e2e                # 76: 38 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 192.2 KB gz; product form 93.4, units 82.8, custom fields 81.7
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The migration's foreign keys came before their indexes** — steps 9 and 10's problem, now nine times (12.2).
- **The product list answered 500**: drizzle's postgres-js driver leaves timestamps of a raw query as Postgres text,
  and the row schema expected a `Date`. The query writes ISO text itself now (`isoText()`).
- **A row with a wrong unit hid its missing Generic name.** The CSV reader checked the custom fields only for rows that
  passed the contract, so a person would fix one problem and meet the next. It checks them for every row now.
- **The import test's "good" file failed**: the pharma template makes Generic name required — the rule worked; the
  test file was missing the column.
- **The first page load went over 200 KB** (201.3) because three first-load files imported the whole `routes` map
  (decision 15).
- **Three layout details on the screenshots**: the variant rows' price box ran into the Archived box (cells now
  `grid-cols-1` with `minmax(0, …)`), the variant rows had no column headers on a wide card, and the units table cut
  off at 560px inside the page.
- **"3333 products"** in the categories tree: counts now go through `format.number`.
- **A pack size read "12.000000"** in the form: shown with `plainFactor()`.
- **A break-it check that proved nothing**: one test picked out with `-t` from a file whose tests build on each other
  failed even with nothing broken. Every check in the header was run on whole files.
- **Zod 4 refuses `.extend()` on a refined schema**, which is why `productFieldsSchema` and `productRules` are
  separate (12.1).

---

## Notes left for later steps

**Step 13 (stock ledger):**

- **Stock lines point at `product_variants`** (with the product id in the FK, like batches). Map their FK's error to
  `product_in_use` in `ProductsService.remove()` and to `product_variant_in_use` in `update()`, next to the batch and
  serial constraints.
- **Quantities are in the base unit.** A line in a pack converts with `product_units.factor`; round to the base unit's
  `decimals`. A yard in metres has 4 decimals and metres allow 2 — decide the rounding with an accountant.
- **Once a product has stock**, changing its base unit, its tracking, or removing a pack it was received in changes the
  meaning of that stock. Refuse those changes then (a check in `update()`).
- **`batches` and `serials` get their screens**; `has_expiry` decides whether a receipt asks for an expiry date.
- **Reorder levels** belong on the variant (or per warehouse), with stock.

**Step 15 onwards:**

- **The sale price is a default**, per base unit. Price lists and customer prices go in their own tables; a pack's price
  is `factor × price` unless a price list says otherwise.
- **A sales line snapshots** the product's name, the variant's values, the unit and the price (build plan step 15), so
  renaming a product later never rewrites an invoice.
- **Customers and suppliers can get custom fields** by adding `'customer'` / `'supplier'` to `CUSTOM_FIELD_ENTITIES`
  and a `custom_fields` column.

**Notes for any step:**

- **A file in the first page load imports a route group, never `routes`** (decision 15).
- **The import's 10,000 rows run in one transaction** in the worker. A file of 10,000 rows (2,500 styles in two sizes
  and 5,000 simple products: 7,500 products) took about 4 seconds from upload to done, measured once in a throwaway
  test on a laptop. A much larger limit would want batches with their own savepoints and a progress count.
- **Old import files stay in storage** (`tenants/<tenant>/product-imports/`), like old exports: the same cleanup job
  can delete both.

