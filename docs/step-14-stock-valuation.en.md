# Step 14: Stock valuation — the value of every movement, and the first module that posts to the books

> The implementation guide for "Phase 4 → Step 14" of [build-plan.bn.md](build-plan.bn.md): which file gets what
> code, and which command runs where.
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `77986c1`, the end of
> step 13) and checked on 2026-10-06: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (251 — 11 new), `pnpm test:integration` (219 — 18 new), `pnpm test:tenant-leak` (45 — 2 new), `pnpm build`, `pnpm test:bundle-size` (first load 181.4 KB gz, budget 200; the adjustment form 89.5 KB, the revaluation form 97.1 KB), `pnpm gen:openapi` (95 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 92 — 8 new, desktop and 390px) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked by hand:
>
> - **The screens**, with the mock API, at 1280px and 390px: the adjustment form with its cost column, a posted
>   adjustment with its journal entry, the journal entry with its "From ADJ-…" link, the stock card with its
>   average cost, the valuation page, a revaluation being written, and Settings → Inventory. No console error, and
>   no page scrolls sideways. The valuation table is a list of cards on the phone, and the cost box drops under the quantity with its own label.
> - **Two people taking the same item at the same moment**, in the integration test: Main store sends its 20 tea
>   packets to Chattogram while the depot writes its 20 off. A third connection holds the item's value row until
>   both wait for it; they are then priced one after the other, and the value ends at exactly ৳0.
> - **The books against the stock**, after every test that moves stock: the stock's value plus what is on the road
>   equals the inventory account plus the goods in transit account, to the paisa; and every `stock_values` row
>   equals the sum of its movements, read straight from the database.
> - **Every guard broken on purpose**: read the value rows without `FOR UPDATE` → "prices two outflows of the same item one after the other" fails (−৳0.01 left with no stock). Let manual journal lines reach the stock accounts → "refuses a manual entry or an opening balance…" fails. Let a stock entry be reversed from the journal → "refuses to reverse a stock entry" fails (and the books stop agreeing with the stock). Take the value out of the trigger's `stock_values` update → four valuation tests fail. Leave RLS off `stock_values` → the RLS coverage test fails. Show costs to everyone → both "who sees what stock costs" tests fail. Post an entry for a transfer inside one branch → both transfer tests fail. Let a chosen stock account be archived → "keeps a chosen account from being archived or deleted" fails. Each check ran its whole test file, and the file was restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` first
> (migrations 0023 and 0024) and restart the worker, or every stock page fails and your workspace never gets its
> stock accounts. (2) The new tests on GitHub Actions. (3) The Bangla texts were written by me, not reviewed by a
> native speaker. (4) An accountant has not reviewed the account choices in the templates (decision 2). Please
> show them the table in decision 2 before you rely on it. (5) The integration suites at full parallelism on a busy laptop: with other Docker stacks running, the test containers missed the 120-second start-up limit, and the runs that timed out left ~20 containers behind. The suites passed with `--maxWorkers=3` after removing them; on GitHub Actions the default should be fine.

## Goal

💰 **Stock that is worth something, and books that know it.** Step 13 counted the stock. This step values it:
every movement now carries what it is worth, and every stock document writes its own journal entry. The two
modules talk to each other for the first time: you post an opening stock adjustment, and the balance sheet's
Inventory line grows by itself.

After this step:

- **A value on every movement.** Stock coming in is worth what it cost (you type the cost on the adjustment).
  Stock going out is worth the **average cost** at that moment (weighted average, one average per item for the
  whole company). The value is kept to the paisa.
- **A journal entry for every stock document.** An adjustment, a transfer between two branches, a transfer that
  arrived short, and a revaluation each post their own entry through the journal's `PostingService`, in the same
  transaction as the stock. The entry links back to its document, and the document to its entry.
- **The books always agree with the stock.** The inventory account and the goods in transit account can only be
  posted to by stock documents. A stock entry cannot be reversed from the journal. The valuation page shows both
  sides, and says "Books agree".
- **Stock accounts in Settings → Inventory.** Which account each kind of adjustment, a transfer's shortage, goods
  in transit and a revaluation post to. The templates fill them in; the owner can change them.
- **Revalue stock.** A new document (`REV-2026-27-0001`): give some items a new average cost. The difference goes
  to the books at once. This is how the stock from step 13 (which came in without a cost) gets its value.
- **The valuation page.** Every item's quantity, average cost and value, the total in the warehouses and on the
  road, and the check against the books.
- **Costs are private.** A new permission, `inventory.stock.value`, is needed to see what stock costs; a second,
  `inventory.stock.revalue`, to revalue it. A cashier still sees how many are left, not what the owner paid.

## The whole picture

```
packages/contracts   money.ts: multiplyMoney, prorateMoney, splitMoney, unitCostOf (exact, BigInt)
      │               stock-accounts.ts (new) · stock-revaluations.ts (new)
      │               stock.ts: unitCost/value on items and movements, the valuation report
      │               adjustments: a unit cost per line, values, the entry · transfers: values, the entries
      │               journal: 3 stock sources, entry.document · 2 permissions · 9 errors · series REV
      ▼
packages/db          stock_values (per item: quantity, value, average) · stock_accounts · stock_revaluations (+ lines)
                     stock_movements.value · adjustment lines: unit_cost, value · transfer lines: value
                     journal_entries.document_id/_number
                     0023 (drizzle, indexes moved up) · 0024 (RLS, the trigger now keeps values, backfill)
      │
      ▼
apps/api             StockPostingService.post() → the value of every move · revalue()
                     StockBooksService (new) → one journal entry per posting, through PostingService.postNew()
                     StockRevaluationsService · StockAccountsService · ValueAccess · the valuation report
                     journal: no manual lines on stock accounts, no Reverse of a stock entry
                     setup: the stock accounts with the chart · StockAccountsHandler for older workspaces
      │
      ▼
apps/app             adjustment form: a cost per line, "= ৳3,600.00", a total · documents show values and entries
                     /stock/valuation · /stock/revaluations (/new, /$id) · Settings → Inventory: Stock accounts
                     stock list and card: value and average cost · journal entry: "From ADJ-…"
                     MSW: the same valuation, and the mock books follow the mock stock

one opening stock adjustment, from the click to the balance sheet:
  Post ──POST /stock-adjustments {post: true}──► API, one transaction:
     step 13's checks · number ADJ-… · StockPostingService.post():
        stock_values rows locked (FOR UPDATE, by item) · balance rows locked (step 13)
        each line's value: typed cost × quantity (3 cartons × ৳1,200 = ৳3,600), or the average
        INSERT stock_movements (+ value) ──► trigger: stock_balances += quantity
                                                      stock_values  += quantity, value; average again
     lines keep their values · header posted
     StockBooksService.adjustment() ──► PostingService.postNew():
        Dr 1150 Inventory (Main store's branch) ৳3,600 / Cr 3300 Opening balance equity ৳3,600
        source 'stock_adjustment', document = the adjustment · JV-2026-27-0042
     audit · COMMIT
  Balance sheet: Inventory ৳3,600 ── the same number the valuation page shows
```

## The decisions behind this step

You made the first four on 2026-10-05. The others follow from them, from the build plan, or from what an
accountant needs. Please read 5–18 with care: they are mine.

1. **One average cost per item for the whole company.** (You chose this.) Not one per warehouse. A transfer does
   not change what an item costs; only stock coming in does. The value can still be split by branch in the books:
   every journal line carries the branch of the warehouse it is about.
2. **Each adjustment reason has its own account, and the owner can change it.** (You chose this.) Opening stock is
   always against **Opening balance equity**, like the opening balances of step 10. The rest are settings, filled
   in by the template:

   | Use | Garments, manufacturing, other | Pharma | Distribution | Retail |
   |---|---|---|---|---|
   | Damaged, expired, lost, received short | 5150 Stock losses (new) | 5350 Expired and damaged goods | 5330 Damaged and expired goods | 5340 Shrinkage and damaged goods |
   | Free samples | 5310 Advertising and promotion | 5330 Medical promotion and samples | 5310 | 5310 |
   | Used in the company | 5290 Consumables and internal use (new) | ← | ← | ← |
   | Found in a count, correction, revaluation | 5190 Stock adjustments and revaluation (new) | ← | ← | ← |
   | Goods in transit | 1175 Goods in transit (new) | ← | ← | ← |

   An industry that already had a loss account (pharma, distribution, retail) uses it instead of getting a second
   one with nearly the same name.
3. **A transfer between two branches goes through goods in transit.** (You chose this.) Sending: Dr Goods in
   transit / Cr Inventory (the sending branch). Receiving: Dr Inventory (the receiving branch) / Cr Goods in
   transit; what did not arrive is Dr the shortage account. **A transfer inside one branch posts nothing**, unless
   it arrives short: then only the shortage (Dr shortage / Cr Inventory).
4. **The stock from step 13 starts at zero cost, and a revaluation gives it its value.** (You chose this.) The
   migration does not guess costs. A new document, "Revalue stock", sets an item's average cost; it also puts a
   wrong cost right later.
5. **Every movement carries its value.** `stock_movements.value`, signed like the quantity (+ in, − out), to the
   paisa. The stock card can show what each movement did to the value, and nothing ever has to be recalculated.
6. **`stock_values` is kept by the database, like `stock_balances`.** One row per item: quantity, value, average
   cost. Migration 0024 extends step 13's trigger: every new movement adds its quantity and value there, in the
   same statement. Code never writes it. So an item's value is always the sum of its movements' values, whoever
   inserts them.
7. **An outflow takes its share of the value, and the last piece takes what is left.** Taking 30 of 40 pieces
   worth ৳1,000 takes ৳750 (`prorateMoney`), not 30 × a rounded average. Taking all of it takes all of the value.
   So stock that reaches zero is worth exactly ৳0 — rounding never leaves a few paisa in the inventory account
   with nothing behind them.
8. **Values to the paisa, unit costs to 4 decimals.** The journal shows 2 decimals and its totals must add up, so
   every value is rounded once, to the paisa, when it is made. A unit cost keeps 4 decimals: a Napa tablet costs
   ৳0.8512.
9. **`post()` returns the values; `StockBooksService` writes the entry.** Only the document knows the other side
   of the entry (a reason's account, goods in transit, a sale's cost of goods sold in step 15). So the stock
   service works out the values and returns them, and the document hands them to `StockBooksService`, which sums
   the lines per account and branch and calls the journal's `PostingService.postNew()` in the same transaction.
   One entry per posting: an opening stock of 400 items is a two-line entry, not 800 lines. A posting worth
   nothing (stock at zero cost) writes no entry.
10. **The books stay with the stock.** Only stock documents may post to the inventory account and the goods in
    transit account: a manual journal entry or an opening balance on them is refused (`journal_account_stock`).
    A stock document's entry cannot be reversed from the journal (`journal_is_stock`); another stock document puts
    it right. Together: stock value + value in transit = inventory account + goods in transit account, always.
11. **Stock coming in is valued at the cost typed on the line, per unit of the line.** "3 cartons at ৳1,200 a
    carton" is what is on the supplier's invoice. An empty cost means "at the average cost this item has now"; an
    item with no cost yet must have one (`stock_cost_required`). A line going out never takes a cost.
12. **The value row is locked first.** Every posting locks its items' `stock_values` rows (`FOR UPDATE`, in item
    order) before step 13's balance rows. Two documents moving the same item from two warehouses then price their
    outflows one after the other, and a document bringing stock in and one taking it out never wait for each other
    in a circle (a deadlock).
13. **Two permissions.** `inventory.stock.value` to see costs and values: without it the API sends them as `null`
    and the valuation report is refused (403). `inventory.stock.revalue` for revaluations (which show costs and
    change the books). The Accountant template gets both. A cost a person typed on an adjustment stays visible on
    that adjustment to everyone who reads it — it is part of the document; values worked out from the books are
    not.
14. **A revaluation is posted when it is saved.** No drafts: its difference depends on the stock at that moment. It
    is split over the warehouses that hold the item, as movements of quantity zero (kind `revaluation`), so the
    stock card shows it and every journal line has its branch. Only stock that is there can be revalued.
15. **A back-dated document uses the average cost at the moment it is posted.** Nothing later is recalculated.
    Documents are dated in an open period anyway (step 13), and recalculating every later movement would change
    posted journal entries — which the journal never allows.
16. **A missing stock account refuses the posting, and says where to fix it.** `stock_account_missing`, with the
    use in its params: "Choose the stock accounts in Settings → Inventory first". An archived or deleted account
    cannot be chosen; and an account that is chosen cannot be archived or deleted (`account_used_by_stock`).
17. **Older workspaces get their stock accounts from a job.** Migration 0024 queues one
    `workspace.stock_accounts_requested` per workspace with a chart. The job adds the template's new accounts
    under their template group (or the top-level group of their type, if the owner moved that group) and chooses
    them. It never takes over an account the owner made for something else: if code 5290 is already "Tea and
    entertainment", that use stays empty for the owner to choose.
18. **Values are rounded with BigInt in `contracts`, not with decimal.js.** The browser and the API both need
    `multiplyMoney` (the form's "= ৳3,600.00", the posting itself), and `contracts` stays on Zod alone (the
    `contracts-only-zod` boundary), the way `money.ts` and `quantities.ts` already do their arithmetic.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| FIFO valuation | The build plan says weighted average now, FIFO later. Every movement keeps its value, so FIFO layers can be built from the ledger when a company asks |
| An inventory account per category (raw materials, finished goods) | All stock posts to the one account with the `inventory` purpose. Per-category accounts with manufacturing (BOM) |
| Landed cost (freight, LC charges, duty on an import) | With purchases (step 17): a goods receipt can add its costs to the items' value |
| Stock value on a past date | The valuation page shows today. "As of" a date (from the movements' values) with the reports in step 21 |
| Recalculating the average after a back-dated document | Decision 15 |
| A sale's cost of goods sold | Step 15: a delivery is an outflow; its value is the cost of goods sold |
| Who may see costs per warehouse | Permissions are workspace-wide (step 13's note), like the rest |

## What changes in the code you already have

- **No new package**, no new `.env` line, no new database role.
- **`pnpm db:migrate`** adds four tables and five columns, replaces step 13's movement trigger with one that also
  keeps the values, gives the step 13 stock its `stock_values` rows (at zero value), and queues the stock accounts
  job for every existing workspace. **Restart the worker** after migrating, so it picks the job up.
- **The journal:** three new sources (`stock_adjustment`, `stock_transfer`, `stock_revaluation`); every entry has
  a `document`; manual entries and opening balances may not touch the inventory or goods in transit account; a
  stock entry cannot be reversed.
- **Accounts:** an account chosen as a stock account cannot be archived or deleted.
- **Templates:** four new accounts (1175, 5150 where needed, 5190, 5290), the stock accounts per industry, and the
  Accountant role gets the two new permissions — for **new** workspaces. Existing roles do not get them; an owner
  ticks them on the Roles page.
- **Step 13's adjustments and transfers** return values now; an adjustment's "in" lines take a `unitCost`.
- **A new number series**, `inventory.revaluation` (REV), on the Numbering page.
- **ui:** `KpiStrip` takes four cells.
- **app:** `useStockRefresh()` also refreshes the journal and reports (a posting writes an entry).
- **Existing tests that change:** step 13's stock tests give their lines a cost; the journal test's own account
  moves from 5290 to 5295 (the template has a 5290 now); the numbering test counts ten series; the setup test
  expects the Accountant's new permissions and the stock accounts; the journal e2e test expects JV-…-0009 (the mock
  workspace's stock now posts two entries of its own), and the onboarding e2e test counts 47 mock accounts.

---
## 14.1 — `packages/contracts`: the contract

Two new files (the stock accounts, the revaluations), the arithmetic in `money.ts`, and new fields in the stock,
adjustment, transfer and journal contracts. Then one or two lines in six existing files.

### `money.ts`: multiplying and sharing money

`packages/contracts/src/money.ts` (changed):

```diff
@@ -78,3 +78,63 @@ export function absMoney(value: string): string {
   const units = toUnits(value);
   return fromUnits(units < 0n ? -units : units);
 }
+
+export function negateMoney(value: string): string {
+  return fromUnits(-toUnits(value));
+}
+
+// -1, 0 or 1, like a sort comparator
+export function compareMoney(a: string, b: string): number {
+  const difference = toUnits(a) - toUnits(b);
+  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
+}
+
+// ---------------------------------------------------------------------------------------------
+// Stock values (step 14). A value is rounded to the paisa (2 decimals), because the journal shows
+// 2 and its totals must visibly add up; a unit cost keeps 4, because a tablet costs ৳0.8512.
+
+const PAISA = 100n;
+
+// numerator ÷ denominator, rounded half away from zero (a negative value rounds like a positive
+// one: −0.005 → −0.01). The denominator is always positive here.
+function divideRounded(numerator: bigint, denominator: bigint): bigint {
+  const half = denominator / 2n;
+  return numerator < 0n ? -((-numerator + half) / denominator) : (numerator + half) / denominator;
+}
+
+// quantity × price, to the paisa: 3 cartons × ৳1,200.50 = ৳3,601.50. Both have at most 4 decimals,
+// so the exact product has 8; it is rounded once, at the end.
+export function multiplyMoney(quantity: string, price: string): string {
+  const exact = toUnits(quantity) * toUnits(price);
+  // exact is in 10^-8 taka; one paisa is 10^6 of those
+  return fromUnits(divideRounded(exact, 1_000_000n) * PAISA);
+}
+
+// The share of a value that goes with part of a quantity: value × part ÷ whole, to the paisa. Taking
+// 30 of the 40 pieces worth ৳1,000 takes ৳750. The whole must be positive.
+export function prorateMoney(value: string, part: string, whole: string): string {
+  const wholeUnits = toUnits(whole);
+  if (wholeUnits <= 0n) throw new Error(`Cannot share a value over "${whole}"`);
+  // value (10^-4) × part (10^-4) ÷ whole (10^-4) = 10^-4 taka; ÷ 100 more for the paisa
+  return fromUnits(divideRounded(toUnits(value) * toUnits(part), wholeUnits * PAISA) * PAISA);
+}
+
+// A value cut into `count` pieces that add up to it exactly: ৳100 over 3 serial numbers is 33.33,
+// 33.33 and 33.34. The last piece takes what rounding left over.
+export function splitMoney(value: string, count: number): string[] {
+  if (!Number.isInteger(count) || count < 1) throw new Error(`Cannot split into ${String(count)}`);
+  const total = toUnits(value);
+  const piece = divideRounded(total, BigInt(count) * PAISA) * PAISA;
+  return Array.from({ length: count }, (_, index) =>
+    fromUnits(index === count - 1 ? total - piece * BigInt(count - 1) : piece),
+  );
+}
+
+// What one unit costs: value ÷ quantity, to 4 decimals (৳1,000 for 3 pieces = ৳333.3333). The
+// quantity must be positive.
+export function unitCostOf(value: string, quantity: string): string {
+  const quantityUnits = toUnits(quantity);
+  if (quantityUnits <= 0n) throw new Error(`No unit cost for a quantity of "${quantity}"`);
+  // value (10^-4) × 10^4 ÷ quantity (10^-4) = 10^-4 taka per unit
+  return fromUnits(divideRounded(toUnits(value) * 10_000n, quantityUnits));
+}
```

Why each helper exists, and why it is written this way:

- **Everything is BigInt in ten-thousandths of a taka**, like the rest of `money.ts`. `0.1 + 0.2` in a JavaScript
  number is `0.30000000000000004`; a value on a stock card that drifts by a paisa would make the books disagree
  with the stock. BigInt is exact, and `contracts` needs no decimal library (decision 18).
- **`divideRounded()` rounds half away from zero.** A negative value (an outflow, a value going down in a
  revaluation) rounds like a positive one: −0.005 → −0.01, not −0.00. Rounding "half up" on negative numbers
  would make an outflow and the inflow it mirrors differ by a paisa.
- **`multiplyMoney()` rounds once, at the end.** Quantity and price each have up to 4 decimals, so the exact
  product has 8. Rounding the price first (or the quantity) would lose a paisa on a large quantity: 7,200 buttons
  at ৳0.4512 is ৳3,248.64 exactly; rounding the price to ৳0.45 first gives ৳3,240.
- **`prorateMoney()` is how an outflow is valued** (decision 7): value × part ÷ whole, in one integer division.
  It throws on a whole of zero — that is a bug in the caller, never something to round away.
- **`splitMoney()`'s last piece takes what rounding left.** A serial product moves one movement row per serial
  number; ৳100 over three phones is 33.33 + 33.33 + 33.34, so the rows add up to the move's value exactly.
- **`unitCostOf()`** is the average shown to people (4 decimals). The database works it out the same way
  (`round(value / quantity, 4)` in the trigger); the API recomputes it while a posting runs through its lines.
- **`negateMoney()` and `compareMoney()`** exist for the books: a credit is a negative amount until it is turned
  into a credit line.

### `stock-accounts.ts` (new)

`packages/contracts/src/stock-accounts.ts` (new):

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';

// The accounts a stock document posts to besides the inventory account (step 14). Each one is a
// setting the owner may change in Settings → Inventory; the template fills them in when the chart
// is made. Two other accounts are fixed and are not here: the inventory account (the account with
// the 'inventory' purpose) and, for opening stock, opening balance equity.
//   in_transit          Goods in transit: a transfer between two branches, sent and not received
//   found … correction  The other side of an adjustment, one per reason (except opening stock)
//   transfer_shortage   What a transfer lost on the way (received short)
//   revaluation         The other side of a stock revaluation
export const STOCK_ACCOUNT_USES = [
  'in_transit',
  'found',
  'damaged',
  'expired',
  'lost',
  'sample',
  'internal_use',
  'correction',
  'transfer_shortage',
  'revaluation',
] as const;
export type StockAccountUse = (typeof STOCK_ACCOUNT_USES)[number];

export function isStockAccountUse(value: string): value is StockAccountUse {
  return STOCK_ACCOUNT_USES.some((use) => use === value);
}

// Goods in transit are still the company's goods: an asset. Every other use is a gain or a loss,
// so it belongs in the profit and loss — an income or an expense account.
export function accountTypeFits(use: StockAccountUse, type: string): boolean {
  return use === 'in_transit' ? type === 'asset' : type === 'income' || type === 'expense';
}

// One value per use. The keys are written out (not built from the list) so the type is exact
// without a cast; Record<StockAccountUse, T> makes a new use fail to compile until it is added here.
function perUse<T>(make: () => T): Record<StockAccountUse, T> {
  return {
    in_transit: make(),
    found: make(),
    damaged: make(),
    expired: make(),
    lost: make(),
    sample: make(),
    internal_use: make(),
    correction: make(),
    transfer_shortage: make(),
    revaluation: make(),
  };
}

// What the API sends: every use, with its account (null = not chosen yet; a posting that needs it
// is refused with stock_account_missing until someone chooses one)
export const stockAccountsSchema = z.object(perUse(() => z.uuid().nullable()));
export type StockAccounts = z.infer<typeof stockAccountsSchema>;

// What the form sends: an account for every use. The form's empty select sends '', which is not
// a uuid: "choose an account".
export const updateStockAccountsInputSchema = z.object(
  perUse(() => z.uuid(errorCode('stock_account_invalid'))),
);
export type UpdateStockAccountsInput = z.infer<typeof updateStockAccountsInputSchema>;
export type StockAccountsFormValues = z.input<typeof updateStockAccountsInputSchema>;

export const stockAccountRoutes = {
  // Reading them needs no permission: the settings page shows them to everyone who opens it
  get: defineRoute({
    method: 'GET',
    path: '/stock-accounts',
    summary: 'The accounts stock documents post to, besides the inventory account',
    auth: 'bearer',
    status: 200,
    response: stockAccountsSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/stock-accounts',
    summary: 'Choose the accounts stock documents post to',
    auth: 'bearer',
    permission: 'core.settings.manage',
    status: 200,
    body: updateStockAccountsInputSchema,
    response: stockAccountsSchema,
  }),
};
```

- **The uses are a closed list in `contracts`**, like the account purposes: the API, the database's
  `text(… { enum })` column, the settings form and the translations all take their type from it. A new use is
  one line here, and the type check shows every place that needs it.
- **Inventory and opening balance equity are not uses.** They are found by their purpose (every chart has them,
  and the owner cannot delete or archive them), so they cannot be "not chosen".
- **`accountTypeFits()`**: goods in transit are still the company's goods, so an asset; everything else is a gain
  or a loss, so it must reach the profit and loss. Pointing "damaged" at a bank account would hide a loss in the
  balance sheet.
- **`perUse()` writes the ten keys out** instead of building the object from the list. `Object.fromEntries` would
  give `{ [key: string]: … }`, and only a cast (banned) would turn that back into the exact shape. With
  `Record<StockAccountUse, T>` as the return type, a new use does not compile until it is added here.
- **The response is `uuid | null` per use; the input is a `uuid` per use.** Reading says "not chosen yet"; saving
  must choose every one. The form's empty select sends `''`, which fails `z.uuid()` with `stock_account_invalid`,
  under that select.
- **Reading needs no permission, saving needs `core.settings.manage`** — the same as the settings page around it.

### `stock-revaluations.ts` (new)

`packages/contracts/src/stock-revaluations.ts` (new):

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { MAX_STOCK_LINES, variantRefSchema } from './stock.js';

// Revaluing stock (step 14): a new average cost for some variants, without moving a piece. It is
// how the stock that came in before step 14 (at zero cost) gets its real value, and how a wrong
// cost is put right later. The difference goes to the books at once: up, Dr Inventory / Cr the
// revaluation account; down, the other way round. Posted when it is saved — there is no draft,
// because the difference depends on the stock at that moment.

// A unit cost per base unit, like the average it replaces: up to 4 decimals (a tablet costs
// ৳0.8512). Zero is allowed: goods that are worth nothing now (a damaged lot kept for a claim).
const unitCostSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(?:\.\d{1,4})?$/, errorCode('money_format'));

export const revaluationLineInputSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  unitCost: unitCostSchema,
});

export const stockRevaluationInputSchema = z
  .object({
    date: z.iso.date(errorCode('stock_date_required')),
    note: optionalText(300),
    lines: z
      .array(revaluationLineInputSchema)
      .min(1, errorCode('stock_lines_required'))
      .max(MAX_STOCK_LINES),
  })
  .superRefine((input, ctx) => {
    // One new cost per variant: two lines for the same one would say two different things
    const seen = new Set<string>();
    input.lines.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'variantId'],
          message: errorCode('revaluation_variant_twice'),
        });
      }
      seen.add(line.variantId);
    });
  });
export type StockRevaluationInput = z.infer<typeof stockRevaluationInputSchema>;
export type StockRevaluationFormValues = z.input<typeof stockRevaluationInputSchema>;

export const stockRevaluationSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  // The sum of the lines' differences: + the stock is worth more now, − less
  difference: z.string(),
  postedAt: z.iso.datetime(),
});
export type StockRevaluationSummary = z.infer<typeof stockRevaluationSummarySchema>;

// One variant: the stock it had then, its value before and after, and the difference
export const revaluationLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  quantity: z.string(),
  oldUnitCost: z.string().nullable(),
  oldValue: z.string(),
  unitCost: z.string(),
  newValue: z.string(),
  difference: z.string(),
});
export type RevaluationLine = z.infer<typeof revaluationLineSchema>;

export const stockRevaluationSchema = stockRevaluationSummarySchema.extend({
  lines: z.array(revaluationLineSchema),
  // null when no line changed the value (every new cost was the old one)
  entry: entryRefSchema.nullable(),
});
export type StockRevaluation = z.infer<typeof stockRevaluationSchema>;

export const stockRevaluationPageSchema = pageOf(stockRevaluationSummarySchema);

const revaluationParamsSchema = z.object({ id: z.uuid() });

// Every route needs inventory.stock.revalue: a revaluation shows costs and changes the books
export const stockRevaluationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock-revaluations',
    summary: 'Stock revaluations, newest date first',
    auth: 'bearer',
    permission: 'inventory.stock.revalue',
    status: 200,
    query: pageQuerySchema,
    response: stockRevaluationPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/stock-revaluations/:id',
    summary: 'One stock revaluation with its lines',
    auth: 'bearer',
    permission: 'inventory.stock.revalue',
    status: 200,
    params: revaluationParamsSchema,
    response: stockRevaluationSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/stock-revaluations',
    summary: 'Give some variants a new average cost, and post the difference to the books',
    auth: 'bearer',
    permission: 'inventory.stock.revalue',
    status: 201,
    body: stockRevaluationInputSchema,
    response: stockRevaluationSchema,
  }),
};
```

- **The new cost is per base unit**, like the average it replaces (the valuation page and the stock card show
  costs per base unit). Zero is a real cost: a damaged lot kept for an insurance claim is worth nothing.
- **One line per item** (`revaluation_variant_twice`, on the second line's `variantId`): two lines for one item
  would say two different costs. The database says it too (a unique index, 14.2).
- **No `post` flag, no `version`, no update or delete route.** A revaluation is posted when it is created
  (decision 14) and never changes.
- **`difference` on the summary** is what the list shows: how much the books moved.
- **Every route needs `inventory.stock.revalue`**, reading too: a revaluation's lines are costs.

### `stock.ts`: values on the stock pages, and the valuation report

`packages/contracts/src/stock.ts` (changed):

```diff
@@ -9,7 +9,8 @@ import { levelSchema, quantitySchema } from './quantities.js';
 // What a movement is, by the document that made it. The response sends it as z.string(), like a
 // journal source: a newer server's new kind (a sales delivery, step 15) must not break an older
 // offline client.
-export const MOVEMENT_KINDS = ['adjustment', 'transfer_out', 'transfer_in'] as const;
+// revaluation (step 14): a change of value without a change of quantity — its quantity is zero.
+export const MOVEMENT_KINDS = ['adjustment', 'transfer_out', 'transfer_in', 'revaluation'] as const;
 export type MovementKind = (typeof MOVEMENT_KINDS)[number];
 
 export function isMovementKind(value: string): value is MovementKind {
@@ -143,6 +144,12 @@ export const stockItemSchema = variantRefSchema.extend({
   inTransit: z.string(),
   // At or below its reorder level in the chosen warehouse (or in any warehouse)
   low: z.boolean(),
+  // Step 14, only for someone with inventory.stock.value (null for everyone else, and for a
+  // variant that never had a cost). unitCost: the company-wide average per base unit, 4 decimals.
+  // value: what onHand is worth — in all warehouses the ledger's own total, in one warehouse its
+  // quantity at the average cost.
+  unitCost: z.string().nullable(),
+  value: z.string().nullable(),
 });
 export type StockItem = z.infer<typeof stockItemSchema>;
 
@@ -219,6 +226,8 @@ export const stockMovementSchema = z.object({
   documentNumber: z.string(),
   quantity: z.string(),
   balance: z.string(),
+  // Signed like quantity; null without inventory.stock.value (step 14)
+  value: z.string().nullable(),
   lotNumber: z.string().nullable(),
   serialNumber: z.string().nullable(),
 });
@@ -309,8 +318,43 @@ export const reorderLevelSchema = z.object({
 
 const variantParamsSchema = z.object({ id: z.uuid() });
 
+// ---------------------------------------------------------------------------------------------
+// The valuation report (step 14): what the stock is worth, per variant, and whether the books agree
+
+export const stockValueSchema = variantRefSchema.extend({
+  // In every warehouse, without what is on a truck
+  quantity: z.string(),
+  unitCost: z.string().nullable(),
+  value: z.string(),
+});
+export type StockValue = z.infer<typeof stockValueSchema>;
+
+export const stockValueQuerySchema = pageQuerySchema.extend({
+  search: z.string().trim().max(100).optional(),
+  categoryId: z.uuid().optional(),
+});
+
+export const stockValuePageSchema = pageOf(stockValueSchema);
+export type StockValuePage = z.infer<typeof stockValuePageSchema>;
+
+// Stock value + in transit = inventory account + goods in transit account. Every stock document
+// posts both halves in one transaction, so the two sides are equal; the page shows it.
+export const valuationSummarySchema = z.object({
+  // In the warehouses (the sum of every variant's value)
+  stockValue: z.string(),
+  // Sent and not received yet
+  inTransitValue: z.string(),
+  // The balances of the two accounts in the books, today (null = no such account chosen yet)
+  inventoryAccount: z.object({ id: z.uuid(), balance: z.string() }).nullable(),
+  inTransitAccount: z.object({ id: z.uuid(), balance: z.string() }).nullable(),
+  // stock + in transit − both accounts: "0.0000" when the books agree
+  difference: z.string(),
+});
+export type ValuationSummary = z.infer<typeof valuationSummarySchema>;
+
 // Reading stock needs no permission: a sales officer checks it before promising a delivery, a
-// cashier before a sale. Cost and value (step 14) will need one.
+// cashier before a sale. What it costs needs inventory.stock.value (step 14): without it, every
+// cost and value in these answers is null, and the valuation report is refused.
 export const stockRoutes = {
   list: defineRoute({
     method: 'GET',
@@ -358,6 +402,25 @@ export const stockRoutes = {
     query: reorderListQuerySchema,
     response: reorderPageSchema,
   }),
+  valuation: defineRoute({
+    method: 'GET',
+    path: '/stock/valuation',
+    summary: 'What the stock is worth, per variant, at the average cost',
+    auth: 'bearer',
+    permission: 'inventory.stock.value',
+    status: 200,
+    query: stockValueQuerySchema,
+    response: stockValuePageSchema,
+  }),
+  valuationSummary: defineRoute({
+    method: 'GET',
+    path: '/stock/valuation/summary',
+    summary: 'The total stock value, and whether the books agree with it',
+    auth: 'bearer',
+    permission: 'inventory.stock.value',
+    status: 200,
+    response: valuationSummarySchema,
+  }),
   setReorderLevel: defineRoute({
     method: 'PUT',
     path: '/stock/reorder-levels',
```

- **`revaluation` is a movement kind.** It has quantity 0 (decision 14). The response still sends `kind` as
  `z.string()`, so an older offline client does not break on it.
- **`unitCost` and `value` are nullable on every item and movement.** `null` means "you may not see it" or "this
  item never had a cost". The two cases look the same on purpose: a cashier must not learn from a `null` versus a
  `'0.0000'` whether an item has a cost.
- **`value` of an item in one warehouse is its quantity there at the average cost**; in all warehouses it is the
  ledger's own total (`stock_values.value`). Both are the same number when there is one warehouse; with several,
  the parts can differ from the total by a paisa of rounding, which is why the total is never a sum of parts.
- **`valuationSummarySchema.difference`** is the one number an accountant looks at: stock + in transit − the two
  accounts. "0.0000" when the books agree.
- **The valuation routes need `inventory.stock.value`**; the old reading routes still need nothing (step 13).

### `stock-adjustments.ts`: a cost per line, and the entry

`packages/contracts/src/stock-adjustments.ts` (changed):

```diff
@@ -3,6 +3,8 @@ import { z } from 'zod';
 import { errorCode } from './errors.js';
 import { optionalText, versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
+import { entryRefSchema } from './journal.js';
+import { priceSchema } from './money.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
 import {
   documentSerialRules,
@@ -81,15 +83,33 @@ export const stockAdjustmentSummarySchema = z.object({
 });
 export type StockAdjustmentSummary = z.infer<typeof stockAdjustmentSummarySchema>;
 
+// A line of an adjustment (step 14): what it cost as typed, per unit of the line (3 cartons at
+// ৳1,200), and what it moved in value once posted. unitCost is null when nobody typed one (an
+// "out" line, or an "in" line at the average cost). value is null for a draft, and for anyone
+// without inventory.stock.value: it was worked out from the books.
+export const adjustmentLineSchema = stockLineSchema.extend({
+  unitCost: z.string().nullable(),
+  value: z.string().nullable(),
+});
+export type AdjustmentLine = z.infer<typeof adjustmentLineSchema>;
+
 export const stockAdjustmentSchema = stockAdjustmentSummarySchema.extend({
-  lines: z.array(stockLineSchema),
+  lines: z.array(adjustmentLineSchema),
+  // The journal entry the posting made; null for a draft, or when the adjustment moved no value
+  // (stock at zero cost)
+  entry: entryRefSchema.nullable(),
 });
 export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;
 
 // ---------------------------------------------------------------------------------------------
 // What the form sends
 
-const adjustmentLineInputSchema = stockInLineFieldsSchema.superRefine(stockLineRules);
+// unitCost: per unit of the line, for a line that brings stock in. '' or left out = at the
+// average cost the variant has now (the API refuses it with stock_cost_required if it has none
+// yet). An "out" line never takes one: what leaves goes at the average cost.
+const adjustmentLineInputSchema = stockInLineFieldsSchema
+  .extend({ unitCost: priceSchema.default(null) })
+  .superRefine(stockLineRules);
 
 const stockAdjustmentFieldsSchema = z.object({
   date: z.iso.date(errorCode('stock_date_required')),
```

- **`unitCost: priceSchema.default(null)`.** `priceSchema` turns `''` into `null` (step 12's sale price); the
  default turns a missing key into `null` too, so step 13's clients (and the "out" lines) still pass. Both mean
  "at the average cost" (decision 11).
- **`adjustmentLineSchema`** adds `unitCost` (as typed — visible to everyone who reads the adjustment) and `value`
  (worked out when posted — `null` for a draft and without the permission). Decision 13 explains the difference.
- **`entry`** is the journal entry the posting made, or `null`: a draft, or an adjustment that moved no value.

### `stock-transfers.ts`: values and entries

`packages/contracts/src/stock-transfers.ts` (changed):

```diff
@@ -3,6 +3,7 @@ import { z } from 'zod';
 import { errorCode } from './errors.js';
 import { optionalText, versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
+import { entryRefSchema } from './journal.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
 import { receivedQuantitySchema } from './quantities.js';
 import {
@@ -27,6 +28,10 @@ export const transferLineSchema = stockLineSchema.extend({
   // Set on receipt, in the base unit; null until then
   receivedQuantity: z.string().nullable(),
   receivedSerialNumbers: z.array(z.string()).nullable(),
+  // Step 14, null without inventory.stock.value: what the line was worth when it left (at the
+  // average cost then), and what arrived of it (the same cost per unit); the rest is the shortage
+  value: z.string().nullable(),
+  receivedValue: z.string().nullable(),
 });
 export type TransferLine = z.infer<typeof transferLineSchema>;
 
@@ -53,6 +58,9 @@ export type StockTransferSummary = z.infer<typeof stockTransferSummarySchema>;
 
 export const stockTransferSchema = stockTransferSummarySchema.extend({
   lines: z.array(transferLineSchema),
+  // The journal entries the transfer made (step 14): one when it was sent between two branches,
+  // one when it was received — none for a transfer inside one branch that arrived whole
+  entries: z.array(entryRefSchema),
 });
 export type StockTransfer = z.infer<typeof stockTransferSchema>;
 
```

- **`value`** is what the line was worth when it left; **`receivedValue`** what arrived of it, at the same cost
  per unit. The shortage's value is the difference, so it is not sent separately.
- **`entries`** is a list: a transfer between branches has one entry when sent and one when received; one inside
  a branch has none, or only the shortage's.

### `journal.ts`: three sources, and the document

`packages/contracts/src/journal.ts` (changed):

```diff
@@ -16,13 +16,36 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // newer server's new source does not break an older offline client.
 // year_close: the closing entry of a fiscal year (step 11), which moves income and expenses into
 // retained earnings. The profit and loss leaves it out, or every closed year would show zero profit.
-export const JOURNAL_SOURCES = ['manual', 'opening_balance', 'reversal', 'year_close'] as const;
+// stock_adjustment, stock_transfer, stock_revaluation (step 14): the entry a stock document makes
+// when it is posted. It points back at its document (document), and only another stock document
+// can change it — the journal's Reverse refuses it, or the books and the stock would disagree.
+export const JOURNAL_SOURCES = [
+  'manual',
+  'opening_balance',
+  'reversal',
+  'year_close',
+  'stock_adjustment',
+  'stock_transfer',
+  'stock_revaluation',
+] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
 export function isJournalSource(value: string): value is JournalSource {
   return JOURNAL_SOURCES.some((source) => source === value);
 }
 
+// The sources a stock document posts: their entries are made and undone by stock documents only
+export const STOCK_JOURNAL_SOURCES = [
+  'stock_adjustment',
+  'stock_transfer',
+  'stock_revaluation',
+] as const satisfies readonly JournalSource[];
+export type StockJournalSource = (typeof STOCK_JOURNAL_SOURCES)[number];
+
+export function isStockJournalSource(value: string): value is StockJournalSource {
+  return STOCK_JOURNAL_SOURCES.some((source) => source === value);
+}
+
 // '2026-07-01' and -1 → '2026-06-30'. The arithmetic runs in UTC, so no time zone can move the
 // day (the same reason periodOf() reads the parts of the string, numbering.ts).
 export function shiftIsoDate(isoDate: string, days: number): string {
@@ -35,7 +58,9 @@ export function shiftIsoDate(isoDate: string, days: number): string {
 // A real entry has a handful of lines; a payroll or an opening balance a few hundred at most
 export const MAX_JOURNAL_LINES = 200;
 
-const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });
+// A posted entry as another page links to it: "JV-2026-27-0042"
+export const entryRefSchema = z.object({ id: z.uuid(), number: z.string() });
+export type EntryRef = z.infer<typeof entryRefSchema>;
 
 export const journalLineSchema = z.object({
   id: z.uuid(),
@@ -64,6 +89,9 @@ export const journalEntrySummarySchema = z.object({
   // This entry undoes reversalOf; reversedBy undid this entry
   reversalOf: entryRefSchema.nullable(),
   reversedBy: entryRefSchema.nullable(),
+  // The stock document that made this entry (step 14): its id and number. Which kind of document
+  // it is follows from the source. null for every other entry.
+  document: z.object({ id: z.uuid(), number: z.string() }).nullable(),
   postedAt: z.iso.datetime().nullable(),
   version: z.number().int(),
   updatedAt: z.iso.datetime(),
```

- **`STOCK_JOURNAL_SOURCES` with `satisfies readonly JournalSource[]`**: a typo in the list does not compile, and
  `isStockJournalSource()` narrows a `string` (the response's `source`) without a cast.
- **`entryRefSchema` is exported** now: the stock documents point at entries with it.
- **`document`** is `null` for every entry that a stock document did not make. Its kind follows from `source`, so
  the journal page knows which page to link to.

### The other contract files

`packages/contracts/src/permissions.ts` (changed):

```diff
@@ -19,6 +19,8 @@ export const PERMISSION_KEYS = [
   'inventory.warehouse.manage',
   'inventory.stock.adjust',
   'inventory.stock.transfer',
+  'inventory.stock.value',
+  'inventory.stock.revalue',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -52,4 +54,6 @@ export const PERMISSION_GROUP_OF = {
   'inventory.warehouse.manage': 'inventory',
   'inventory.stock.adjust': 'inventory',
   'inventory.stock.transfer': 'inventory',
+  'inventory.stock.value': 'inventory',
+  'inventory.stock.revalue': 'inventory',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

`packages/contracts/src/errors.ts` (changed):

```diff
@@ -210,6 +210,16 @@ export const ERROR_CODES = [
   'product_base_unit_locked',
   'product_tracking_locked',
   'product_type_locked',
+  // stock values and the books (step 14)
+  'stock_cost_required',
+  'stock_account_missing',
+  'stock_account_invalid',
+  'stock_account_inventory',
+  'journal_account_stock',
+  'journal_is_stock',
+  'revaluation_no_stock',
+  'revaluation_variant_twice',
+  'account_used_by_stock',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

`packages/contracts/src/numbering.ts` (changed):

```diff
@@ -15,6 +15,7 @@ export const DOCUMENT_TYPES = [
   'inventory.product',
   'inventory.adjustment',
   'inventory.transfer',
+  'inventory.revaluation',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -38,6 +39,7 @@ const DEFAULT_PREFIXES = {
   'inventory.product': 'P',
   'inventory.adjustment': 'ADJ',
   'inventory.transfer': 'TRF',
+  'inventory.revaluation': 'REV',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
```

`packages/contracts/src/audit.ts` (changed):

```diff
@@ -76,6 +76,9 @@ export const AUDIT_ACTIONS = [
   'stock_transfer.sent',
   'stock_transfer.received',
   'reorder_level.changed',
+  'stock_accounts.changed',
+  'stock_accounts.created',
+  'stock_revaluation.posted',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -104,6 +107,7 @@ export const AUDIT_ENTITY_TYPES = [
   'stock_adjustment',
   'stock_transfer',
   'reorder_level',
+  'stock_revaluation',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

`packages/contracts/src/routes.ts` (changed):

```diff
@@ -20,7 +20,9 @@ import { productRoutes } from './products.js';
 import { roleRoutes } from './roles.js';
 import { settingsRoutes } from './settings.js';
 import { setupRoutes } from './setup.js';
+import { stockAccountRoutes } from './stock-accounts.js';
 import { stockAdjustmentRoutes } from './stock-adjustments.js';
+import { stockRevaluationRoutes } from './stock-revaluations.js';
 import { stockTransferRoutes } from './stock-transfers.js';
 import { stockRoutes } from './stock.js';
 import { unitRoutes } from './units.js';
@@ -70,4 +72,6 @@ export const routes = {
   stock: stockRoutes,
   stockAdjustments: stockAdjustmentRoutes,
   stockTransfers: stockTransferRoutes,
+  stockRevaluations: stockRevaluationRoutes,
+  stockAccounts: stockAccountRoutes,
 };
```

`packages/contracts/src/index.ts` (changed):

```diff
@@ -26,7 +26,9 @@ export * from './routes.js';
 export * from './settings.js';
 export * from './setup.js';
 export * from './stock.js';
+export * from './stock-accounts.js';
 export * from './stock-adjustments.js';
+export * from './stock-revaluations.js';
 export * from './stock-transfers.js';
 export * from './units.js';
 export * from './warehouses.js';
```

- **Two permissions in the inventory group** (decision 13). Their texts go into `en.ts`/`bn.ts` (14.6), and their
  descriptions into the database catalog (14.2) — the type check fails until all three exist.
- **Nine error codes, plus `account_used_by_stock`.** Each has a text in `errors.*` (14.6).
- **`inventory.revaluation` → `REV`**, numbered by fiscal year like every stock document.
- **Audit:** `stock_accounts.changed` (the settings card), `stock_accounts.created` (the job for older
  workspaces), `stock_revaluation.posted`, and the entity type `stock_revaluation`.

### Tests: `money.spec.ts`

`packages/contracts/src/money.spec.ts` (changed):

```diff
@@ -4,10 +4,16 @@ import {
   absMoney,
   addMoney,
   amountSchema,
+  compareMoney,
   isNegativeMoney,
   isZeroMoney,
+  multiplyMoney,
+  negateMoney,
+  prorateMoney,
+  splitMoney,
   subtractMoney,
   sumMoney,
+  unitCostOf,
 } from './money.js';
 
 describe('money', () => {
@@ -44,4 +50,44 @@ describe('money', () => {
       expect(amountSchema.safeParse(bad).error?.issues[0]?.message, bad).toBe('money_format');
     }
   });
+
+  it('multiplies a quantity by a price, rounded once to the paisa', () => {
+    expect(multiplyMoney('3', '1200.5')).toBe('3601.5000');
+    // 2.74 m at ৳123.4567 = 338.271358 → 338.27
+    expect(multiplyMoney('2.74', '123.4567')).toBe('338.2700');
+    // Half a paisa rounds away from zero, on both sides of it
+    expect(multiplyMoney('1', '0.005')).toBe('0.0100');
+    expect(multiplyMoney('1', '-0.005')).toBe('-0.0100');
+    expect(multiplyMoney('0.0001', '0.0001')).toBe('0.0000');
+  });
+
+  it('shares a value over part of a quantity, and the whole takes all of it', () => {
+    // 30 of 40 pieces worth ৳1,000
+    expect(prorateMoney('1000', '30', '40')).toBe('750.0000');
+    // 1 of 3 pieces worth ৳100: 33.33, never 33.3333 (the books keep paisa)
+    expect(prorateMoney('100', '1', '3')).toBe('33.3300');
+    expect(prorateMoney('100', '3', '3')).toBe('100.0000');
+    expect(prorateMoney('-100', '2', '3')).toBe('-66.6700');
+    expect(() => prorateMoney('100', '1', '0')).toThrow();
+  });
+
+  it('splits a value into pieces that add up to it exactly', () => {
+    expect(splitMoney('100', 3)).toEqual(['33.3300', '33.3300', '33.3400']);
+    expect(splitMoney('-0.05', 2)).toEqual(['-0.0300', '-0.0200']);
+    expect(sumMoney(splitMoney('1234.57', 7))).toBe('1234.5700');
+    expect(splitMoney('5', 1)).toEqual(['5.0000']);
+  });
+
+  it('works out a unit cost to 4 decimals', () => {
+    expect(unitCostOf('1000', '3')).toBe('333.3333');
+    expect(unitCostOf('8.512', '10')).toBe('0.8512');
+    expect(() => unitCostOf('10', '0')).toThrow();
+  });
+
+  it('compares and negates', () => {
+    expect(compareMoney('10', '10.0000')).toBe(0);
+    expect(compareMoney('-1', '0')).toBe(-1);
+    expect(negateMoney('12.5')).toBe('-12.5000');
+    expect(negateMoney('0')).toBe('0.0000');
+  });
 });
```

Each case is a number that went wrong in a first try, or would with a JavaScript number: `2.74 m × ৳123.4567`
(eight decimals before rounding), half a paisa on both sides of zero, ৳100 over three pieces, `1234.57` over seven
(the remainder lands on the last piece), and a quantity of zero (a bug, so it throws).

---
## 14.2 — `packages/db`: four tables, five columns, two migrations

### `schema/stock.ts`: a value on every movement, and `stock_values`

`packages/db/src/schema/stock.ts` (changed):

```diff
@@ -41,6 +41,10 @@ export const stockMovements = pgTable(
     serialId: uuid('serial_id'),
     // In the product's base unit: + in, − out. NUMERIC(19,4), a string in TypeScript.
     quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
+    // What the movement is worth (step 14), signed like the quantity, to the paisa: an inflow at
+    // its cost, an outflow at the average cost. The rows from before step 14 have 0 (they were
+    // written without a cost; a revaluation gives that stock its value).
+    value: numeric('value', { precision: 19, scale: 4 }).notNull().default('0'),
     kind: text('kind', { enum: MOVEMENT_KINDS }).notNull(),
     // The document that made it (an adjustment or a transfer) and its number at the time: a
     // posted document's number never changes, so the stock card needs no join to show it
@@ -84,7 +88,11 @@ export const stockMovements = pgTable(
       columns: [table.tenantId, table.variantId, table.serialId],
       foreignColumns: [serials.tenantId, serials.variantId, serials.id],
     }),
-    check('stock_movements_quantity_check', sql`${table.quantity} <> 0`),
+    // Every movement moves stock, except a revaluation (step 14): it changes only the value
+    check(
+      'stock_movements_quantity_check',
+      sql`(${table.kind} = 'revaluation') = (${table.quantity} = 0)`,
+    ),
     check(
       'stock_movements_serial_check',
       sql`${table.serialId} IS NULL OR ${table.quantity} IN (1, -1)`,
@@ -137,6 +145,41 @@ export const stockBalances = pgTable(
   ],
 );
 
+// What each variant's stock is worth, company-wide (step 14: one average cost per variant, in
+// every warehouse). Like stock_balances, it is kept by the database (migration 0024's trigger
+// adds every movement's quantity and value) and code never writes it. It does not count what is on
+// a truck: a sent transfer took its value out, and its receipt brings it back.
+// It is also the row two documents moving the same variant queue on: StockPostingService locks it
+// (FOR UPDATE) before it reads the average, so the second one prices its outflow after the first.
+export const stockValues = pgTable(
+  'stock_values',
+  {
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    productId: uuid('product_id').notNull(),
+    variantId: uuid('variant_id').notNull(),
+    // In every warehouse, in the base unit (the sum of the movements' quantities)
+    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('0'),
+    // The sum of the movements' values
+    value: numeric('value', { precision: 19, scale: 4 }).notNull().default('0'),
+    // value ÷ quantity while there is stock, to 4 decimals. When the stock reaches zero (or goes
+    // below, if the workspace allows it) it keeps the last average: an outflow below zero is
+    // priced at it. NULL = this variant never had a cost.
+    unitCost: numeric('unit_cost', { precision: 19, scale: 4 }),
+    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
+  },
+  (table) => [
+    // One row per variant: the trigger's ON CONFLICT target
+    unique('stock_values_key').on(table.tenantId, table.variantId),
+    foreignKey({
+      name: 'stock_values_variant_fk',
+      columns: [table.tenantId, table.productId, table.variantId],
+      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
+    }),
+  ],
+);
+
 // When to order more: per variant and warehouse (a depot keeps more Napa than a shop does)
 export const reorderLevels = pgTable(
   'reorder_levels',
```

- **`stock_movements.value` defaults to 0.** The rows from step 13 get it without a rewrite of the table (a column
  with a constant default is added in place, and no `UPDATE` runs — step 13's append-only trigger never sees one).
  Zero is the truth for them: they came in without a cost (decision 4).
- **The quantity check changes from `quantity <> 0` to `(kind = 'revaluation') = (quantity = 0)`.** A revaluation
  is the only movement without a quantity, and every other movement still must have one. One check says both.
- **`stock_values` has no `id` and no `version`.** Its key is (tenant, variant) — the `ON CONFLICT` target of the
  trigger — and nobody edits it, so there is nothing to version.
- **`unit_cost` keeps its last value when the stock reaches zero.** An outflow below zero (negative stock allowed)
  needs a price; the last average is the best one there is. `NULL` means "never had a cost": the first stock of such
  an item must come in with one (decision 11).

### `schema/stock-documents.ts`: costs and values on the lines

`packages/db/src/schema/stock-documents.ts` (changed):

```diff
@@ -105,6 +105,10 @@ export const stockAdjustmentLines = pgTable(
     lotNumber: text('lot_number'),
     expiresOn: date('expires_on', { mode: 'string' }),
     manufacturedOn: date('manufactured_on', { mode: 'string' }),
+    // Step 14. An "in" line's cost per unit of the line, as typed (3 cartons at ৳1,200); NULL =
+    // at the average cost. value: what the line moved, set when the adjustment is posted.
+    unitCost: numeric('unit_cost', { precision: 19, scale: 4 }),
+    value: numeric('value', { precision: 19, scale: 4 }),
   },
   (table) => [
     uniqueIndex('stock_adjustment_lines_line_idx').on(
@@ -143,6 +147,10 @@ export const stockAdjustmentLines = pgTable(
       'stock_adjustment_lines_quantity_check',
       sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
     ),
+    check(
+      'stock_adjustment_lines_value_check',
+      sql`(${table.unitCost} IS NULL OR ${table.unitCost} >= 0) AND (${table.value} IS NULL OR ${table.value} >= 0)`,
+    ),
   ],
 );
 
@@ -209,6 +217,9 @@ export const stockTransferLines = pgTable(
     // Set on receipt, in the base unit: what arrived. sent − received = the shortage.
     receivedQuantity: numeric('received_quantity', { precision: 19, scale: 4 }),
     receivedSerialNumbers: text('received_serial_numbers').array(),
+    // What the line was worth when it left (step 14), at the average cost then; set when it is
+    // sent. What arrives is valued at the same cost per unit; the rest is the shortage.
+    value: numeric('value', { precision: 19, scale: 4 }),
   },
   (table) => [
     uniqueIndex('stock_transfer_lines_line_idx').on(table.tenantId, table.transferId, table.lineNo),
```

- **`unit_cost` is per unit of the line, as typed** (3 cartons at ৳1,200), not per base unit: it is what the
  person read off the supplier's invoice, and the document must show it back the same way.
- **The values are set while the document is still a draft**, in the posting's transaction, before the status
  changes (14.4). Step 13's guards freeze a posted adjustment's lines and a sent transfer's lines; migration 0024
  adds `value` to the transfer lines' frozen columns.
- **A check keeps both non-negative.** Lines carry amounts; the sign is the document's direction.

### `schema/stock-valuation.ts` (new)

`packages/db/src/schema/stock-valuation.ts` (new):

```ts
import { STOCK_ACCOUNT_USES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';

// The accounts stock documents post to besides the inventory account (step 14, contracts'
// STOCK_ACCOUNT_USES): one row per use, set by the template and changed in Settings → Inventory.
// A missing row is "not chosen yet": the posting that needs it is refused until someone picks one.
export const stockAccounts = pgTable(
  'stock_accounts',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    use: text('use', { enum: STOCK_ACCOUNT_USES }).notNull(),
    accountId: uuid('account_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    primaryKey({ name: 'stock_accounts_pkey', columns: [table.tenantId, table.use] }),
    // "Is this account chosen for a stock use?" — the account FK's own check on delete, too
    index('stock_accounts_account_idx').on(table.tenantId, table.accountId),
    // An account that a stock use points at cannot be deleted (AccountsService: account_in_use)
    foreignKey({
      name: 'stock_accounts_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
  ],
);

// A stock revaluation (step 14): new average costs for some variants, posted when it is saved.
// Its movements (kind 'revaluation', quantity 0) carry the difference into stock_values; its
// journal entry carries it into the books.
export const stockRevaluations = pgTable(
  'stock_revaluations',
  {
    // deleted_at and version are not used: a revaluation is never changed or deleted (0024)
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    note: text('note'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('stock_revaluations_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('stock_revaluations_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('stock_revaluations_tenant_date_idx').on(table.tenantId, table.date, table.id),
  ],
);

export const stockRevaluationLines = pgTable(
  'stock_revaluation_lines',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    revaluationId: uuid('revaluation_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The stock and its value when it was revalued: the difference is new − old
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    oldUnitCost: numeric('old_unit_cost', { precision: 19, scale: 4 }),
    oldValue: numeric('old_value', { precision: 19, scale: 4 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 19, scale: 4 }).notNull(),
    newValue: numeric('new_value', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_revaluation_lines_line_idx').on(
      table.tenantId,
      table.revaluationId,
      table.lineNo,
    ),
    // One line per variant in a revaluation (the contract says it too)
    uniqueIndex('stock_revaluation_lines_variant_idx').on(
      table.tenantId,
      table.revaluationId,
      table.variantId,
    ),
    index('stock_revaluation_lines_product_idx').on(
      table.tenantId,
      table.productId,
      table.variantId,
    ),
    foreignKey({
      name: 'stock_revaluation_lines_revaluation_fk',
      columns: [table.tenantId, table.revaluationId],
      foreignColumns: [stockRevaluations.tenantId, stockRevaluations.id],
    }),
    foreignKey({
      name: 'stock_revaluation_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    check(
      'stock_revaluation_lines_values_check',
      sql`${table.quantity} > 0 AND ${table.unitCost} >= 0 AND ${table.newValue} >= 0`,
    ),
  ],
);
```

- **`stock_accounts` is keyed by (tenant, use)**: one account per use, and a save is an upsert of ten rows.
- **Its foreign key to `ledger_accounts` has no `ON DELETE`**: an account a use points at cannot be deleted. The
  API turns the error into `account_used_by_stock` (14.4), and refuses to archive one too.
- **`stock_revaluations` has a `number` that is never null**: it is posted when it is created (decision 14).
  `baseColumns()` gives it `version` and `deleted_at` like every table; they are never used, and migration 0024
  makes sure nothing can change the row anyway.
- **A revaluation line keeps the stock and value it saw** (`quantity`, `old_value`, `old_unit_cost`), so the
  document shows what it did even after the stock moves on.
- **`stock_revaluation_lines_variant_idx` is unique per revaluation**: the database's own "one line per item".

### `schema/journal.ts`: the entry's document

`packages/db/src/schema/journal.ts` (changed):

```diff
@@ -40,6 +40,11 @@ export const journalEntries = pgTable(
     source: text('source', { enum: JOURNAL_SOURCES }).notNull().default('manual'),
     // Set on a reversal: the entry it undoes
     reversalOfId: uuid('reversal_of_id'),
+    // The stock document that made this entry (step 14): which one follows from the source (an
+    // adjustment, a transfer, a revaluation); its number never changes once posted, so the
+    // journal shows it without a join
+    documentId: uuid('document_id'),
+    documentNumber: text('document_number'),
     postedAt: timestamp('posted_at', { withTimezone: true }),
     postedBy: uuid('posted_by'),
   },
@@ -70,6 +75,15 @@ export const journalEntries = pgTable(
       'journal_entries_reversal_check',
       sql`(${table.source} = 'reversal') = (${table.reversalOfId} IS NOT NULL)`,
     ),
+    // A stock document's entry always points at its document, and no other entry does
+    check(
+      'journal_entries_document_check',
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+    ),
+    // A stock document's entries (a transfer has up to two)
+    index('journal_entries_document_idx')
+      .on(table.tenantId, table.documentId)
+      .where(sql`${table.documentId} IS NOT NULL`),
   ],
 );
 
```

- **`document_id` and `document_number`**, like `stock_movements.document_id`/`document_number`: a posted
  document's number never changes, so the journal shows it without a join to three different tables.
- **`journal_entries_document_check`**: an entry from a stock document always has its document, and no other entry
  has one. A future module (sales, step 15) adds its source to this check in its own migration.
- **A partial index on `(tenant_id, document_id)`**: a document's page finds its entries by it
  (`StockBooksService.entriesOf()`), and most entries (manual ones) never need to be in it.

### The other schema files

`packages/db/src/schema/outbox-events.ts` (changed):

```diff
@@ -16,6 +16,7 @@ export const OUTBOX_EVENT_TYPES = [
   'workspace.catalog_requested',
   'product.import_requested',
   'stock.below_reorder',
+  'workspace.stock_accounts_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

`packages/db/src/schema/index.ts` (changed):

```diff
@@ -29,3 +29,4 @@ export * from './product-imports.js';
 export * from './warehouses.js';
 export * from './stock.js';
 export * from './stock-documents.js';
+export * from './stock-valuation.js';
```

`packages/db/src/permission-catalog.ts` (changed):

```diff
@@ -27,6 +27,8 @@ const DESCRIPTIONS = {
   'inventory.warehouse.manage': 'Add, edit and archive warehouses',
   'inventory.stock.adjust': 'Write and post stock adjustments, including opening stock',
   'inventory.stock.transfer': 'Send stock to another warehouse and receive it there',
+  'inventory.stock.value': 'See what stock costs and what it is worth',
+  'inventory.stock.revalue': 'Revalue stock: give items a new average cost',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

### Migration 0023 (generated — then move the indexes up)

```bash
cd packages/db
pnpm generate --name stock-valuation
```

`drizzle-kit` writes the foreign keys before the indexes they need. `stock_revaluation_lines_revaluation_fk`
points at `(tenant_id, id)` of `stock_revaluations`, which only becomes a valid target when
`stock_revaluations_tenant_id_idx` (unique) exists — so the migration fails with "there is no unique constraint
matching given keys" (steps 9, 10, 12 and 13 met the same thing). Move every `CREATE INDEX` / `CREATE UNIQUE INDEX`
statement up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The result:

`packages/db/migrations/0023_stock-valuation.sql`:

```sql
CREATE TABLE "stock_values" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(19, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_values_key" UNIQUE("tenant_id","variant_id")
);--> statement-breakpoint
CREATE TABLE "stock_accounts" (
	"tenant_id" uuid NOT NULL,
	"use" text NOT NULL,
	"account_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "stock_accounts_pkey" PRIMARY KEY("tenant_id","use")
);--> statement-breakpoint
CREATE TABLE "stock_revaluation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revaluation_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"old_unit_cost" numeric(19, 4),
	"old_value" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"new_value" numeric(19, 4) NOT NULL,
	CONSTRAINT "stock_revaluation_lines_values_check" CHECK ("stock_revaluation_lines"."quantity" > 0 AND "stock_revaluation_lines"."unit_cost" >= 0 AND "stock_revaluation_lines"."new_value" >= 0)
);--> statement-breakpoint
CREATE TABLE "stock_revaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid
);--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_check";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "document_number" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "value" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD COLUMN "unit_cost" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD COLUMN "value" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD COLUMN "value" numeric(19, 4);--> statement-breakpoint
CREATE INDEX "stock_accounts_account_idx" ON "stock_accounts" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluation_lines_line_idx" ON "stock_revaluation_lines" USING btree ("tenant_id","revaluation_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluation_lines_variant_idx" ON "stock_revaluation_lines" USING btree ("tenant_id","revaluation_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_revaluation_lines_product_idx" ON "stock_revaluation_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluations_tenant_id_idx" ON "stock_revaluations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_revaluations_tenant_number_idx" ON "stock_revaluations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "stock_revaluations_tenant_date_idx" ON "stock_revaluations" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "journal_entries_document_idx" ON "journal_entries" USING btree ("tenant_id","document_id") WHERE "journal_entries"."document_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_values" ADD CONSTRAINT "stock_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_values" ADD CONSTRAINT "stock_values_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_accounts" ADD CONSTRAINT "stock_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_accounts" ADD CONSTRAINT "stock_accounts_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluation_lines" ADD CONSTRAINT "stock_revaluation_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluation_lines" ADD CONSTRAINT "stock_revaluation_lines_revaluation_fk" FOREIGN KEY ("tenant_id","revaluation_id") REFERENCES "public"."stock_revaluations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluation_lines" ADD CONSTRAINT "stock_revaluation_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_revaluations" ADD CONSTRAINT "stock_revaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_check" CHECK (("stock_movements"."kind" = 'revaluation') = ("stock_movements"."quantity" = 0));--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_value_check" CHECK (("stock_adjustment_lines"."unit_cost" IS NULL OR "stock_adjustment_lines"."unit_cost" >= 0) AND ("stock_adjustment_lines"."value" IS NULL OR "stock_adjustment_lines"."value" >= 0));
```

- **`DROP CONSTRAINT stock_movements_quantity_check` then `ADD CONSTRAINT` with the new rule.** Postgres checks the
  new rule against every existing row: all of step 13's movements have a quantity and are not revaluations, so it
  passes.
- **`journal_entries_document_check` is checked against every existing entry** too: none has a stock source yet.
- The snapshot (`meta/0023_snapshot.json`) and `_journal.json` are written by `drizzle-kit`; commit them as they
  are.

### Migration 0024 (custom): RLS, the trigger that keeps the values, the backfill

```bash
pnpm generate --custom --name stock-valuation-rules
```

`packages/db/migrations/0024_stock-valuation-rules.sql`:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['stock_values', 'stock_accounts', 'stock_revaluations', 'stock_revaluation_lines'])
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

-- 2) Every new movement also adds its quantity and value to its variant's stock_values row (step
--    14), in the same statement that updates its warehouse balance (0022). So the value of a
--    variant's stock is always the sum of its movements' values, whoever inserts them, exactly like
--    its quantity. The average cost is worked out here too: value ÷ quantity while there is stock;
--    at zero or below it keeps the last one, which prices an outflow below zero.
--    A revaluation's movement has quantity 0: it changes the value only, so it does not touch the
--    warehouse balance (that would make an empty balance row for a batch product).
CREATE OR REPLACE FUNCTION stock_movements_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric;
  v_tracking text;
  v_allowed boolean;
  v_serial_at uuid;
BEGIN
  IF NEW.quantity <> 0 THEN
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

  INSERT INTO stock_values AS sv
         (tenant_id, product_id, variant_id, quantity, value, unit_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.product_id, NEW.variant_id, NEW.quantity, NEW.value,
          CASE WHEN NEW.quantity > 0 THEN round(NEW.value / NEW.quantity, 4) END, now())
  ON CONFLICT ON CONSTRAINT stock_values_key
  DO UPDATE SET
    quantity = sv.quantity + EXCLUDED.quantity,
    value = sv.value + EXCLUDED.value,
    unit_cost = CASE
      WHEN sv.quantity + EXCLUDED.quantity > 0
        THEN round((sv.value + EXCLUDED.value) / (sv.quantity + EXCLUDED.quantity), 4)
      ELSE coalesce(sv.unit_cost, EXCLUDED.unit_cost)
    END,
    updated_at = now();
  RETURN NULL;
END $$;

-- 3) A revaluation and its lines never change and are never deleted, like a posted journal entry:
--    a wrong one is put right by another revaluation
CREATE FUNCTION stock_revaluations_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a stock revaluation cannot be changed or deleted; post another one instead'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_revaluations_immutable';
END $$;

CREATE TRIGGER stock_revaluations_immutable
  BEFORE UPDATE OR DELETE ON stock_revaluations
  FOR EACH ROW EXECUTE FUNCTION stock_revaluations_immutable();

CREATE TRIGGER stock_revaluation_lines_immutable
  BEFORE UPDATE OR DELETE ON stock_revaluation_lines
  FOR EACH ROW EXECUTE FUNCTION stock_revaluations_immutable();

-- 4) A sent transfer line keeps its value (set while it was still a draft, in the same transaction
--    as the sending): 0022's guard, with value added to what the receipt must not change
CREATE OR REPLACE FUNCTION stock_transfer_lines_guard() RETURNS trigger
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
          NEW.serial_numbers, NEW.value)
         IS NOT DISTINCT FROM
         (OLD.tenant_id, OLD.transfer_id, OLD.line_no, OLD.product_id, OLD.variant_id,
          OLD.unit_id, OLD.quantity, OLD.factor, OLD.base_quantity, OLD.batch_id,
          OLD.serial_numbers, OLD.value) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a sent stock transfer cannot be changed, except to record the receipt once'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfer_lines_sent_immutable';
END $$;

-- 5) The stock that is already there (step 13) gets its stock_values row: its quantity, at zero
--    value — it came in without a cost. You chose this: a revaluation gives it its real value. The
--    sums are taken from the movements, exactly what the trigger would have added. Per tenant, with
--    app.tenant_id set, because FORCE RLS applies to the table owner too.
--    Then every workspace that already has a chart gets a job that adds the stock accounts and
--    chooses them (StockAccountsHandler); a workspace without a chart gets them with its chart.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO stock_values (tenant_id, product_id, variant_id, quantity, value, unit_cost)
    SELECT m.tenant_id, m.product_id, m.variant_id, sum(m.quantity), 0,
           CASE WHEN sum(m.quantity) > 0 THEN 0 END
      FROM stock_movements m
     WHERE m.tenant_id = t
     GROUP BY m.tenant_id, m.product_id, m.variant_id
    ON CONFLICT ON CONSTRAINT stock_values_key DO NOTHING;

    IF EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.tenant_id = t) THEN
      INSERT INTO outbox_events (id, tenant_id, type, payload)
      VALUES (gen_random_uuid(), t, 'workspace.stock_accounts_requested', '{}'::jsonb);
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

Part by part:

1. **RLS on the four new tables**, exactly like 0022. The tenant-leak suite's RLS coverage test fails if any table
   with a `tenant_id` lacks `FORCE ROW LEVEL SECURITY`.
2. **`CREATE OR REPLACE FUNCTION stock_movements_apply()`.** The same trigger as 0022, with two changes:
   - **`IF NEW.quantity <> 0`** around the balance part. A revaluation moves no stock; without this guard, a
     revaluation of a batch product would create a `(warehouse, variant, NULL batch)` balance row of zero, which
     the stock pages would then show as an empty "no batch" line.
   - **The `stock_values` upsert at the end.** Every movement adds its quantity and value; the average is
     `round(value / quantity, 4)` while the quantity is positive, and the old average otherwise (decision 6).
     `INSERT … ON CONFLICT DO UPDATE` also locks the row, so two transactions can never add to it at the same
     time — but the API locks it earlier anyway (decision 12), because it must *read* the average before it writes.
   The trigger itself (`CREATE TRIGGER stock_movements_apply`) is not created again: it calls the function by
   name, and `CREATE OR REPLACE` swaps the function under it.
3. **Revaluations are immutable**: one function, two triggers, `BEFORE UPDATE OR DELETE`. The API never changes
   them; this stops anyone else (a script, a future bug) from doing it.
4. **`stock_transfer_lines_guard()` again, with `value` in the frozen tuple.** Without it, the receipt (the one
   update a sent line allows) could also change what the line was worth when it left.
5. **The backfill.** Each item's `stock_values` row from its movements: the quantity summed, the value 0, the
   average 0 if there is stock (so an "in" line without a cost uses ৳0, not "no cost yet"). The loop sets
   `app.tenant_id` per workspace, because `FORCE ROW LEVEL SECURITY` applies to the table owner too (the
   migrator is not a superuser). Then **one `workspace.stock_accounts_requested` event per workspace that has a
   chart**: the worker adds the accounts and chooses them (decision 17). A workspace without a chart (its setup
   failed before step 9) gets them with its chart.

---
## 14.3 — The API: values in `apps/api/src/inventory/`

The order below is the order the pieces depend on each other: the posting service learns values, a new service
writes the books, the documents use both, then the reads, the new documents and the module.

### `stock-posting.service.ts`: the value of every move

`apps/api/src/inventory/stock-posting.service.ts` (changed):

```diff
@@ -1,11 +1,19 @@
 import { Injectable } from '@nestjs/common';
 import {
+  addMoney,
   compareQuantity,
+  isZeroMoney,
   type MovementKind,
+  multiplyMoney,
+  negateMoney,
   negateQuantity,
+  prorateMoney,
+  splitMoney,
+  subtractMoney,
   subtractQuantity,
   sumQuantity,
   todayIn,
+  unitCostOf,
 } from '@omnivo/contracts';
 import {
   batches,
@@ -15,6 +23,7 @@ import {
   stockMovements,
   stockTransferLines,
   stockTransfers,
+  stockValues,
   tenantSettings,
 } from '@omnivo/db';
 import { and, asc, eq, inArray, sql } from 'drizzle-orm';
@@ -42,6 +51,34 @@ export interface StockMove {
   batchId: string | null;
   quantity: string;
   serialNumbers: string[];
+  // Step 14, for a move IN: what it is worth (a typed cost × quantity, or what a transfer sent).
+  // null or left out = at the variant's average cost now. A move OUT always goes at the average:
+  // its value is worked out here, never handed in.
+  value?: string | null;
+}
+
+// A variant's stock and value as stock_values holds them, while a posting works through its moves
+interface ValueState {
+  quantity: string;
+  value: string;
+  unitCost: string | null;
+}
+
+// One line of a revaluation: the variant and its new average cost per base unit
+export interface Revaluation {
+  line: number;
+  variant: Pick<VariantInfo, 'variantId' | 'productId'>;
+  unitCost: string;
+}
+
+// What a revaluation did to one variant, and where (the difference per warehouse, for the books)
+export interface Revalued {
+  quantity: string;
+  oldUnitCost: string | null;
+  oldValue: string;
+  newValue: string;
+  difference: string;
+  byWarehouse: { warehouseId: string; value: string }[];
 }
 
 export interface StockPosting {
@@ -77,6 +114,36 @@ function actorId(): string | null {
   return tenantStorage.getStore()?.principal?.userId ?? null;
 }
 
+// What `quantity` taken out of `state` is worth, at the average cost (step 14). Taking all of it
+// takes all of its value — so stock that reaches zero is worth exactly zero, with no paisa left
+// behind by rounding. Taking part takes its share. Taking more than there is (negative stock,
+// when the workspace allows it) takes what there was, and prices the rest at the last average.
+function outflowValue(state: ValueState, quantity: string): string {
+  const positive = compareQuantity(state.quantity, '0') > 0;
+  if (positive && compareQuantity(quantity, state.quantity) === 0) return state.value;
+  if (positive && compareQuantity(quantity, state.quantity) < 0) {
+    return prorateMoney(state.value, quantity, state.quantity);
+  }
+  const beyond = positive ? subtractQuantity(quantity, state.quantity) : quantity;
+  return addMoney(positive ? state.value : '0', multiplyMoney(beyond, state.unitCost ?? '0'));
+}
+
+// The new state after a move, like migration 0024's trigger: the average follows the stock while
+// there is some, and keeps its last value at zero or below
+function apply(state: ValueState, quantity: string, value: string): ValueState {
+  const next = {
+    quantity: sumQuantity([state.quantity, quantity]),
+    value: addMoney(state.value, value),
+  };
+  return {
+    ...next,
+    unitCost:
+      compareQuantity(next.quantity, '0') > 0
+        ? unitCostOf(next.value, next.quantity)
+        : (state.unitCost ?? null),
+  };
+}
+
 // warehouse|variant|batch — the key of a balance row ('' for no batch)
 function balanceKey(warehouseId: string, variantId: string, batchId: string | null): string {
   return `${warehouseId}|${variantId}|${batchId ?? ''}`;
@@ -172,14 +239,55 @@ export class StockPostingService {
     return ids;
   }
 
-  async post(tx: Transaction, posting: StockPosting): Promise<void> {
-    if (posting.moves.length === 0) return;
+  // Returns what each move was worth (step 14), in the order of posting.moves: positive amounts to
+  // the paisa. The caller gives them to StockBooksService for the journal entry, and keeps them on
+  // its lines.
+  async post(tx: Transaction, posting: StockPosting): Promise<string[]> {
+    if (posting.moves.length === 0) return [];
     const serialIds = await this.checkSerials(tx, posting);
+    // The variants' value rows first, then the balance rows: every posting takes its locks in this
+    // order, so a document bringing stock in and one taking it out never wait for each other in a
+    // circle (a deadlock)
+    const states = await this.lockValues(
+      tx,
+      posting.moves.map((move) => move.variant.variantId),
+    );
     const before = posting.direction === 'out' ? await this.checkAvailable(tx, posting) : null;
 
+    // The value of each move, in the document's order: two lines of the same variant (two batches
+    // of one product) price one after the other, the second at what the first left
+    const issues: LineIssue[] = [];
+    const values = posting.moves.map((move) => {
+      const state = states.get(move.variant.variantId) ?? {
+        quantity: '0',
+        value: '0',
+        unitCost: null,
+      };
+      let value: string;
+      if (posting.direction === 'out') {
+        value = outflowValue(state, move.quantity);
+        states.set(
+          move.variant.variantId,
+          apply(state, negateQuantity(move.quantity), negateMoney(value)),
+        );
+      } else {
+        const given = move.value ?? null;
+        if (given === null && state.unitCost === null) {
+          // Nothing to go by: the first stock of an item needs its cost
+          issues.push({ path: linePath(move.line, 'unitCost'), code: 'stock_cost_required' });
+        }
+        value = given ?? multiplyMoney(move.quantity, state.unitCost ?? '0');
+        states.set(move.variant.variantId, apply(state, move.quantity, value));
+      }
+      return value;
+    });
+    if (issues.length > 0) throw linesError(issues);
+
     const sign = (quantity: string) =>
       posting.direction === 'in' ? quantity : negateQuantity(quantity);
-    const rows = posting.moves.flatMap((move) => {
+    const signed = (value: string) => (posting.direction === 'in' ? value : negateMoney(value));
+    const rows = posting.moves.flatMap((move, index) => {
+      const value = values[index] ?? '0';
       const base = {
         tenantId: getTenantId(),
         date: posting.date,
@@ -195,13 +303,16 @@ export class StockPostingService {
       // A serial product moves one row per serial number: the stock card then shows where each
       // IMEI went, and the trigger moves each serial row on its own
       if (move.serialNumbers.length > 0) {
-        return move.serialNumbers.map((serial) => ({
+        // The move's value cut into one piece per serial number, adding up to it exactly
+        const pieces = splitMoney(value, move.serialNumbers.length);
+        return move.serialNumbers.map((serial, piece) => ({
           ...base,
           serialId: serialIds.get(`${move.variant.variantId}|${serial}`) ?? null,
           quantity: sign('1'),
+          value: signed(pieces[piece] ?? '0'),
         }));
       }
-      return [{ ...base, serialId: null, quantity: sign(move.quantity) }];
+      return [{ ...base, serialId: null, quantity: sign(move.quantity), value: signed(value) }];
     });
     // In the order of their balance rows: every document locks those rows in the same order, so
     // two documents touching the same products wait for each other instead of deadlocking
@@ -220,6 +331,118 @@ export class StockPostingService {
     }
 
     if (before !== null) await this.reportLow(tx, posting, before);
+    return values;
+  }
+
+  // A revaluation (step 14): each variant gets a new average cost, and its stock's value changes
+  // by the difference — no piece moves. The difference is written as movements of quantity 0
+  // (kind 'revaluation'), one per warehouse that holds the variant, split by the quantity there,
+  // so the stock card shows it and the books can tag each part with its warehouse's branch. The
+  // trigger adds them to stock_values like any movement. Only stock that is there can be revalued.
+  async revalue(
+    tx: Transaction,
+    document: { date: string; documentId: string; documentNumber: string },
+    lines: readonly Revaluation[],
+  ): Promise<Revalued[]> {
+    const tenantId = getTenantId();
+    const states = await this.lockValues(
+      tx,
+      lines.map((line) => line.variant.variantId),
+    );
+    const issues: LineIssue[] = [];
+    const results: Revalued[] = [];
+    const rows: (typeof stockMovements.$inferInsert)[] = [];
+    for (const line of lines) {
+      const state = states.get(line.variant.variantId);
+      if (!state || compareQuantity(state.quantity, '0') <= 0) {
+        issues.push({ path: linePath(line.line, 'variantId'), code: 'revaluation_no_stock' });
+        continue;
+      }
+      const newValue = multiplyMoney(state.quantity, line.unitCost);
+      const difference = subtractMoney(newValue, state.value);
+      // Where the stock is: the warehouses holding some of it. The value rows are locked, so no
+      // other posting moves this variant until we commit.
+      const places = await tx
+        .select({
+          warehouseId: stockBalances.warehouseId,
+          quantity: sql<string>`sum(${stockBalances.quantity})`,
+        })
+        .from(stockBalances)
+        .where(
+          and(
+            eq(stockBalances.tenantId, tenantId),
+            eq(stockBalances.variantId, line.variant.variantId),
+          ),
+        )
+        .groupBy(stockBalances.warehouseId)
+        .having(sql`sum(${stockBalances.quantity}) > 0`)
+        .orderBy(asc(stockBalances.warehouseId));
+      const held = sumQuantity(places.map((place) => place.quantity));
+      // Each warehouse its share; the last one what rounding left, so the parts add up exactly
+      let left = difference;
+      const byWarehouse = places.map((place, index) => {
+        const value =
+          index === places.length - 1 ? left : prorateMoney(difference, place.quantity, held);
+        left = subtractMoney(left, value);
+        return { warehouseId: place.warehouseId, value };
+      });
+      for (const part of byWarehouse) {
+        if (isZeroMoney(part.value)) continue;
+        rows.push({
+          tenantId,
+          date: document.date,
+          warehouseId: part.warehouseId,
+          productId: line.variant.productId,
+          variantId: line.variant.variantId,
+          batchId: null,
+          serialId: null,
+          quantity: '0',
+          value: part.value,
+          kind: 'revaluation',
+          documentId: document.documentId,
+          documentNumber: document.documentNumber,
+          createdBy: actorId(),
+        });
+      }
+      results.push({
+        quantity: state.quantity,
+        oldUnitCost: state.unitCost,
+        oldValue: state.value,
+        newValue,
+        difference,
+        byWarehouse: byWarehouse.filter((part) => !isZeroMoney(part.value)),
+      });
+    }
+    if (issues.length > 0) throw linesError(issues);
+    if (rows.length > 0) await tx.insert(stockMovements).values(rows);
+    return results;
+  }
+
+  // The value rows of these variants, locked (FOR UPDATE) in variant order — the first lock every
+  // posting takes (see post()). A variant that never moved has no row yet: its first movement makes
+  // it (the trigger), and until then it has nothing to price.
+  private async lockValues(
+    tx: Transaction,
+    variantIds: readonly string[],
+  ): Promise<Map<string, ValueState>> {
+    const ids = [...new Set(variantIds)];
+    const rows = await tx
+      .select({
+        variantId: stockValues.variantId,
+        quantity: stockValues.quantity,
+        value: stockValues.value,
+        unitCost: stockValues.unitCost,
+      })
+      .from(stockValues)
+      .where(and(eq(stockValues.tenantId, getTenantId()), inArray(stockValues.variantId, ids)))
+      .orderBy(asc(stockValues.variantId))
+      .for('update');
+    return new Map(
+      rows.map((row) => [
+        row.variantId,
+        { quantity: row.quantity, value: row.value, unitCost: row.unitCost },
+      ]),
+    );
   }
 
   // Serial numbers in: made the first time they are seen, and never already in stock (in a
```

Line by line, the parts that carry the weight:

- **`StockMove.value`** is only read for a move *in*. For an outflow it is ignored on purpose: what leaves always
  goes at the average (decision 7), so a caller cannot slip in a different value.
- **`outflowValue()`**:
  - all of the stock → all of the value. This is what makes "zero stock is worth ৳0" true without any clean-up.
  - part of it → `prorateMoney()`, its share.
  - more than there is (negative stock allowed) → what there was, plus the rest at the last average. The value goes
    negative with the quantity; the next inflow brings both back.
- **`apply()`** is the trigger's arithmetic in TypeScript. A posting can move the same item twice (two batches
  of one product, FEFO-split lines); the second line must be priced from what the first left, before anything is
  written. `apply()` keeps that running state in memory; the trigger then writes the same numbers.
- **`lockValues()` comes first in `post()`** — before `checkAvailable()` locks step 13's balance rows (decision 12).
  Every posting takes the value rows first, in item order, so no two postings ever hold each other's next lock.
  `FOR UPDATE` here (not only the trigger's upsert) is what makes the *read* of the average safe: without it, two
  postings would both read "40 pieces worth ৳1,000.03" and both take their share of it. The race test (14.5)
  fails without it.
- **`stock_cost_required` is a line error** (`lines.2.unitCost`): the form shows it under that line's cost box.
  It is raised before anything is written.
- **The serial rows split the move's value** with `splitMoney()`, so the rows of one IMEI line add up to the line.
- **`post()` returns the values** in the order of the moves (decision 9). The documents keep them on their lines
  and hand their sum to the books.
- **`revalue()`** (decision 14): for each line, the item's new value is its stock × the new cost, and the
  difference is split over the warehouses that hold it, by their quantity, the last warehouse taking what rounding
  left. Each part is a movement of quantity 0; a part of zero is not written. `places` is read *after*
  `lockValues()`: every posting that could change those balances must take the same value row first, so the
  quantities cannot move under the revaluation. An item without stock (`quantity <= 0`) is refused under its line.

### `stock-books.service.ts` (new)

`apps/api/src/inventory/stock-books.service.ts` (new):

```ts
import { Injectable } from '@nestjs/common';
import {
  type AdjustmentReason,
  compareMoney,
  type EntryRef,
  isZeroMoney,
  negateMoney,
  type StockAccountUse,
  type StockJournalSource,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { journalEntries, ledgerAccounts, stockAccounts, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { type LineInput, PostingService } from '../journal/posting.service.js';

// One amount on one side of the entry before lines are summed: + debit, − credit
interface Amount {
  accountId: string;
  branchId: string | null;
  amount: string;
}

// What a stock posting moved, in one warehouse: the books tag it with the warehouse's branch
interface WarehouseValue {
  warehouseId: string;
  value: string;
}

// The accounts a stock entry may need. inventory and equity are found by their purpose (every chart
// has them, and they cannot be deleted or archived); the others are the choices in Settings →
// Inventory, each of which must still be an active ledger.
interface Accounts {
  inventory: string;
  openingEquity: string;
  use: (use: StockAccountUse) => string;
}

function missing(use: string): AppError {
  return new AppError(
    409,
    'stock_account_missing',
    `No usable account is chosen for "${use}" in Settings → Inventory.`,
    { params: { use } },
  );
}

// The journal half of every stock document (step 14). StockPostingService works out what each
// movement is worth; this turns those values into one journal entry per posting — the inventory
// account on one side, the account the document says on the other — and posts it through the
// journal's PostingService, inside the document's own transaction. So the stock and the books
// change together or not at all, and the books always say what the stock is worth.
// Lines are summed per account and branch: an opening stock of 400 items is a two-line entry,
// not 800 lines. An entry worth nothing (stock at zero cost) is not written at all.
@Injectable()
export class StockBooksService {
  constructor(private readonly posting: PostingService) {}

  // An adjustment: Dr Inventory / Cr the reason's account when stock comes in, the other way round
  // when it goes out. Opening stock is against opening balance equity, like opening balances.
  async adjustment(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: {
      direction: 'in' | 'out';
      reason: AdjustmentReason;
      moved: readonly WarehouseValue[];
    },
  ): Promise<EntryRef | null> {
    const accounts = await this.accounts(tx);
    const against =
      input.reason === 'opening' ? accounts.openingEquity : accounts.use(input.reason);
    const branchOf = await this.branches(tx, input.moved);
    const sign = input.direction === 'in' ? (value: string) => value : negateMoney;
    return this.write(tx, document, 'stock_adjustment', `Stock adjustment ${document.number}`, [
      ...input.moved.map((part) => ({
        accountId: accounts.inventory,
        branchId: branchOf(part.warehouseId),
        amount: sign(part.value),
      })),
      ...input.moved.map((part) => ({
        accountId: against,
        branchId: branchOf(part.warehouseId),
        amount: negateMoney(sign(part.value)),
      })),
    ]);
  }

  // A transfer leaving: between two branches, the goods move from the source branch's inventory to
  // goods in transit (Dr Goods in transit / Cr Inventory). Inside one branch nothing changes in the
  // books (you chose this): the stock is still that branch's, only in another room.
  async transferSent(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: { fromWarehouseId: string; toWarehouseId: string; value: string },
  ): Promise<EntryRef | null> {
    const branchOf = await this.branches(tx, [
      { warehouseId: input.fromWarehouseId, value: '0' },
      { warehouseId: input.toWarehouseId, value: '0' },
    ]);
    const from = branchOf(input.fromWarehouseId);
    if (from === branchOf(input.toWarehouseId)) return null;
    const accounts = await this.accounts(tx);
    return this.write(tx, document, 'stock_transfer', `Stock transfer ${document.number} sent`, [
      { accountId: accounts.use('in_transit'), branchId: null, amount: input.value },
      { accountId: accounts.inventory, branchId: from, amount: negateMoney(input.value) },
    ]);
  }

  // A transfer arriving with `received` of the `sent` value. Between two branches: Dr Inventory at
  // the destination for what arrived, Dr the shortage account for what did not (the source
  // branch's loss: it left there), Cr Goods in transit for everything that was sent. Inside one
  // branch, only a shortage is written: Dr shortage / Cr Inventory.
  async transferReceived(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: { fromWarehouseId: string; toWarehouseId: string; sent: string; received: string },
  ): Promise<EntryRef | null> {
    const branchOf = await this.branches(tx, [
      { warehouseId: input.fromWarehouseId, value: '0' },
      { warehouseId: input.toWarehouseId, value: '0' },
    ]);
    const from = branchOf(input.fromWarehouseId);
    const to = branchOf(input.toWarehouseId);
    const short = subtractMoney(input.sent, input.received);
    const sameBranch = from === to;
    if (sameBranch && isZeroMoney(short)) return null;
    const accounts = await this.accounts(tx);
    const shortage = isZeroMoney(short)
      ? []
      : [{ accountId: accounts.use('transfer_shortage'), branchId: from, amount: short }];
    const narration = `Stock transfer ${document.number} received`;
    if (sameBranch) {
      return this.write(tx, document, 'stock_transfer', narration, [
        ...shortage,
        { accountId: accounts.inventory, branchId: from, amount: negateMoney(short) },
      ]);
    }
    return this.write(tx, document, 'stock_transfer', narration, [
      { accountId: accounts.inventory, branchId: to, amount: input.received },
      ...shortage,
      { accountId: accounts.use('in_transit'), branchId: null, amount: negateMoney(input.sent) },
    ]);
  }

  // A revaluation: each warehouse's part of the difference on the inventory account (with its
  // branch), and the opposite on the revaluation account. Worth more: Dr Inventory / Cr
  // revaluation; worth less: the other way round.
  async revaluation(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    moved: readonly WarehouseValue[],
  ): Promise<EntryRef | null> {
    if (moved.length === 0) return null;
    const accounts = await this.accounts(tx);
    const branchOf = await this.branches(tx, moved);
    const revaluation = accounts.use('revaluation');
    return this.write(tx, document, 'stock_revaluation', `Stock revaluation ${document.number}`, [
      ...moved.map((part) => ({
        accountId: accounts.inventory,
        branchId: branchOf(part.warehouseId),
        amount: part.value,
      })),
      ...moved.map((part) => ({
        accountId: revaluation,
        branchId: branchOf(part.warehouseId),
        amount: negateMoney(part.value),
      })),
    ]);
  }

  // The posted entries of a document, oldest first: an adjustment has at most one, a transfer two
  async entriesOf(tx: Transaction, documentId: string): Promise<EntryRef[]> {
    const rows = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.documentId, documentId)),
      )
      .orderBy(asc(journalEntries.postedAt), asc(journalEntries.id));
    return rows.flatMap((row) => (row.number === null ? [] : [{ id: row.id, number: row.number }]));
  }

  // Sums the amounts per account and branch, turns each sum into a debit or a credit line, and
  // posts the entry. null when nothing is left (every amount was zero).
  private async write(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    source: StockJournalSource,
    narration: string,
    amounts: readonly Amount[],
  ): Promise<EntryRef | null> {
    const sums = new Map<string, Amount[]>();
    for (const amount of amounts) {
      const key = `${amount.accountId}|${amount.branchId ?? ''}`;
      sums.set(key, [...(sums.get(key) ?? []), amount]);
    }
    const lines: LineInput[] = [...sums.values()].flatMap((group) => {
      const [first] = group;
      if (!first) return [];
      const total = sumMoney(group.map((amount) => amount.amount));
      if (isZeroMoney(total)) return [];
      const debit = compareMoney(total, '0') > 0;
      return [
        {
          accountId: first.accountId,
          branchId: first.branchId,
          description: null,
          debit: debit ? total : '0',
          credit: debit ? '0' : negateMoney(total),
        },
      ];
    });
    if (lines.length < 2) return null;
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source,
      document: { id: document.id, number: document.number },
      lines,
    });
    if (entry.number === null) throw new Error('A posted entry has no number');
    return { id: entry.id, number: entry.number };
  }

  // The inventory and opening equity accounts, and the Settings → Inventory choices. A choice that
  // is missing, archived or a group is refused with stock_account_missing when a posting needs it:
  // the person is told where to fix it, and nothing is posted.
  private async accounts(tx: Transaction): Promise<Accounts> {
    const tenantId = getTenantId();
    // FOR SHARE: until we commit, nobody archives or deletes them (AccountsService locks FOR
    // UPDATE), while other postings to the same accounts go on in parallel
    const purposes = await tx
      .select({ id: ledgerAccounts.id, purpose: ledgerAccounts.purpose })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          inArray(ledgerAccounts.purpose, ['inventory', 'opening_balance_equity']),
        ),
      )
      .for('share');
    const inventory = purposes.find((row) => row.purpose === 'inventory')?.id;
    const openingEquity = purposes.find((row) => row.purpose === 'opening_balance_equity')?.id;
    // A workspace whose chart is still being made by the setup job
    if (inventory === undefined) throw missing('inventory');
    if (openingEquity === undefined) throw missing('opening_balance_equity');

    const chosen = await tx
      .select({ use: stockAccounts.use, accountId: stockAccounts.accountId })
      .from(stockAccounts)
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.tenantId, stockAccounts.tenantId),
          eq(ledgerAccounts.id, stockAccounts.accountId),
        ),
      )
      .where(
        and(
          eq(stockAccounts.tenantId, tenantId),
          eq(ledgerAccounts.isGroup, false),
          isNull(ledgerAccounts.archivedAt),
        ),
      )
      .for('share', { of: ledgerAccounts });
    const byUse = new Map(chosen.map((row) => [row.use, row.accountId]));
    return {
      inventory,
      openingEquity,
      use: (use) => {
        const id = byUse.get(use);
        if (id === undefined) throw missing(use);
        return id;
      },
    };
  }

  // warehouse → its branch, for the parts a posting moved
  private async branches(
    tx: Transaction,
    parts: readonly WarehouseValue[],
  ): Promise<(warehouseId: string) => string> {
    const ids = [...new Set(parts.map((part) => part.warehouseId))];
    const rows = await tx
      .select({ id: warehouses.id, branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), inArray(warehouses.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row.branchId]));
    return (warehouseId) => {
      const branchId = byId.get(warehouseId);
      if (branchId === undefined) throw new Error(`Warehouse ${warehouseId} has no branch`);
      return branchId;
    };
  }
}
```

How it is built, and why:

- **Amounts are signed** (+ debit, − credit) until the very end. Each method lists what each account gets; `write()`
  sums them per account and branch and only then turns each sum into a debit or a credit line. So an opening stock
  of 400 lines is a two-line entry, and two parts that cancel (a revaluation up in one warehouse, down in another of
  the same branch) disappear instead of becoming a debit and a credit on the same account.
- **Zero sums are dropped, and fewer than two lines writes nothing.** A posting worth nothing (stock at zero cost)
  has no entry (decision 9); `PostingService` would refuse an entry with fewer than two lines anyway.
- **`document`** goes into `NewEntry` (14.4): the entry points back at the adjustment, transfer or revaluation.
- **`accounts()` finds inventory and opening equity by purpose, and the rest from `stock_accounts`**, joined to the
  account so an archived or group account counts as "not chosen". `FOR SHARE` on both: until we commit, nobody
  archives or deletes them (`AccountsService` locks `FOR UPDATE`), while other postings to the same accounts go on.
  `inventory === undefined` happens in exactly one case: a workspace whose chart the setup job has not made yet.
- **`missing()` puts the use in the problem's `params`**, so a developer can see which one in the response; the
  person reads the general text ("Choose the stock accounts in Settings → Inventory first").
- **`transferSent()` returns before it needs any account when both warehouses are in one branch** (decision 3).
  So a single-branch company can move stock between rooms without ever choosing a goods in transit account.
- **`transferReceived()`** writes one entry for both halves of a receipt between branches: what arrived into the
  destination's inventory, the shortage to its account, and all of goods in transit back out. The shortage is the
  *sending* branch's (`branchId: from`): the goods left its books and never reached the other. Inside one branch,
  only a shortage is written.
- **`revaluation()`** tags each part with its warehouse's branch, on both sides: a branch-wise profit and loss
  (step 11's branch filter) shows each branch's own revaluation.
- **`entriesOf()`** is how a document's page finds its entries (by `document_id`, oldest first). A draft's entry
  never exists, so `number` is never null here; the `flatMap` only satisfies the type.

### `value-access.ts` (new)

`apps/api/src/inventory/value-access.ts` (new):

```ts
import { Injectable } from '@nestjs/common';

import { PermissionService } from '../rbac/permission.service.js';

// Who may see what stock costs (step 14): inventory.stock.value. Reading stock needs no permission
// (step 13), so the same answers go to everyone — with every cost and value worked out from the
// books set to null for someone without it. A shop's cashier sees how many are left, not what the
// owner paid for them. A cost a person typed on a document stays on it: it is part of the document.
@Injectable()
export class ValueAccess {
  constructor(private readonly permissions: PermissionService) {}

  async canSee(): Promise<boolean> {
    const access = await this.permissions.ofCurrentUser();
    return access.permissions.includes('inventory.stock.value');
  }
}
```

One question, asked by every read that can show a cost (decision 13). `ofCurrentUser()` reads the permission
cache the guard has just filled, so it costs nothing on most requests.

### `stock-adjustments.service.ts`: costs in, values out, one entry

`apps/api/src/inventory/stock-adjustments.service.ts` (changed):

```diff
@@ -1,10 +1,12 @@
 import { Inject, Injectable } from '@nestjs/common';
-import type {
-  StockAdjustment,
-  StockAdjustmentInput,
-  StockAdjustmentSummary,
-  StockDocumentStatus,
-  UpdateStockAdjustmentInput,
+import {
+  multiplyMoney,
+  type StockAdjustment,
+  type StockAdjustmentInput,
+  type StockAdjustmentSummary,
+  type StockDocumentStatus,
+  sumMoney,
+  type UpdateStockAdjustmentInput,
 } from '@omnivo/contracts';
 import { stockAdjustmentLines, stockAdjustments, warehouses } from '@omnivo/db';
 import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
@@ -26,7 +28,9 @@ import {
   resolveLines,
   toStockLine,
 } from './stock-lines.js';
+import { StockBooksService } from './stock-books.service.js';
 import { StockPostingService } from './stock-posting.service.js';
+import { ValueAccess } from './value-access.js';
 
 type AdjustmentRow = typeof stockAdjustments.$inferSelect;
 type LineRow = typeof stockAdjustmentLines.$inferSelect;
@@ -65,6 +69,23 @@ function toSummary(row: AdjustmentRow, lines: number): StockAdjustmentSummary {
   };
 }
 
+// What posting adds to the lines besides what resolveLines() checked: the batches the lots became,
+// the typed costs (step 14) and the values the posting worked out
+interface LineExtras {
+  batchIds?: readonly (string | null)[];
+  unitCosts: readonly (string | null)[];
+  values?: readonly string[];
+}
+
+// A typed cost belongs on a line that brings stock in; on an "out" line it means nothing (what
+// leaves goes at the average cost), so it is not kept
+function costsOf(
+  direction: 'in' | 'out',
+  lines: readonly { unitCost?: string | null }[],
+): (string | null)[] {
+  return lines.map((line) => (direction === 'in' ? (line.unitCost ?? null) : null));
+}
+
 // A stored line as resolveLines() takes it, to check it again when the draft is posted
 function storedInput(line: LineRow): LineInput {
   return {
@@ -85,6 +106,8 @@ export class StockAdjustmentsService {
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
     private readonly numbering: NumberingService,
     private readonly posting: StockPostingService,
+    private readonly books: StockBooksService,
+    private readonly access: ValueAccess,
   ) {}
 
   list(query: {
@@ -134,7 +157,9 @@ export class StockAdjustmentsService {
         })
         .returning();
       if (!row) throw new Error('Stock adjustment insert returned no row');
-      await this.writeLines(tx, row.id, lines);
+      await this.writeLines(tx, row.id, lines, {
+        unitCosts: costsOf(input.direction, input.lines),
+      });
       await audit(tx, {
         action: 'stock_adjustment.created',
         entityType: 'stock_adjustment',
@@ -166,7 +191,7 @@ export class StockAdjustmentsService {
         .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)))
         .returning();
       if (!updated) throw notFound('Stock adjustment');
-      await this.writeLines(tx, id, lines);
+      await this.writeLines(tx, id, lines, { unitCosts: costsOf(input.direction, input.lines) });
       await audit(tx, {
         action: 'stock_adjustment.updated',
         entityType: 'stock_adjustment',
@@ -225,10 +250,16 @@ export class StockAdjustmentsService {
       draft.direction === 'in'
         ? await this.posting.resolveBatches(tx, lines)
         : lines.map((line) => line.batchId);
-    await this.writeLines(tx, draft.id, lines, batchIds);
+    // Step 14: an "in" line with a typed cost is worth quantity × cost (3 cartons × ৳1,200, in the
+    // line's own unit); without one (null), the posting prices it at the average cost
+    const unitCosts = costsOf(draft.direction, stored);
+    const typedValues = lines.map((line, index) => {
+      const cost = unitCosts[index] ?? null;
+      return cost === null ? null : multiplyMoney(line.quantity, cost);
+    });
 
     const number = await this.numbering.next(tx, 'inventory.adjustment', draft.date);
-    await this.posting.post(tx, {
+    const values = await this.posting.post(tx, {
       date: draft.date,
       kind: 'adjustment',
       direction: draft.direction,
@@ -241,8 +272,11 @@ export class StockAdjustmentsService {
         batchId: batchIds[index] ?? null,
         quantity: line.baseQuantity,
         serialNumbers: line.serialNumbers,
+        value: typedValues[index] ?? null,
       })),
     });
+    // Still a draft here: the lines may change, and take their batches and values
+    await this.writeLines(tx, draft.id, lines, { batchIds, unitCosts, values });
     await tx
       .update(stockAdjustments)
       .set({
@@ -254,20 +288,31 @@ export class StockAdjustmentsService {
         updatedBy: currentPrincipal().userId,
       })
       .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, draft.id)));
+    // The books (step 14): one entry, the inventory account against the reason's account
+    const entry = await this.books.adjustment(
+      tx,
+      { id: draft.id, number, date: draft.date },
+      {
+        direction: draft.direction,
+        reason: draft.reason,
+        moved: [{ warehouseId: draft.warehouseId, value: sumMoney(values) }],
+      },
+    );
     await audit(tx, {
       action: 'stock_adjustment.posted',
       entityType: 'stock_adjustment',
       entityId: draft.id,
-      changes: created({ number }),
+      changes: created({ number, entry: entry?.number ?? null }),
     });
   }
 
-  // The lines in the order they were written. batchIds: set when posting brings lots in.
+  // The lines in the order they were written. batchIds: set when posting brings lots in; values:
+  // set when posting has priced them.
   private async writeLines(
     tx: Transaction,
     adjustmentId: string,
     lines: readonly ResolvedLine[],
-    batchIds: readonly (string | null)[] = lines.map((line) => line.batchId),
+    { batchIds = lines.map((line) => line.batchId), unitCosts, values }: LineExtras,
   ): Promise<void> {
     const tenantId = getTenantId();
     await tx
@@ -294,6 +339,8 @@ export class StockAdjustmentsService {
         expiresOn: line.expiresOn,
         manufacturedOn: line.manufacturedOn,
         serialNumbers: line.serialNumbers,
+        unitCost: unitCosts[index] ?? null,
+        value: values?.[index] ?? null,
       })),
     );
   }
@@ -342,6 +389,10 @@ export class StockAdjustmentsService {
     const [summary] = await this.summaries(tx, eq(stockAdjustments.id, id), 1);
     if (!summary) throw notFound('Stock adjustment');
     const lines = await this.linesOf(tx, id);
+    const [canSee, entries] = await Promise.all([
+      this.access.canSee(),
+      this.books.entriesOf(tx, id),
+    ]);
     const [variants, batches] = await Promise.all([
       loadVariants(
         tx,
@@ -359,9 +410,20 @@ export class StockAdjustmentsService {
         // The FK keeps the variant while a line points at it
         if (!variant) return [];
         return [
-          toStockLine(line, variant, line.batchId === null ? undefined : batches.get(line.batchId)),
+          {
+            ...toStockLine(
+              line,
+              variant,
+              line.batchId === null ? undefined : batches.get(line.batchId),
+            ),
+            // Typed by a person: part of the document. Worked out from the books: needs the
+            // permission (step 14).
+            unitCost: line.unitCost,
+            value: canSee ? line.value : null,
+          },
         ];
       }),
+      entry: entries[0] ?? null,
     };
   }
 
```

- **`costsOf()` keeps a typed cost on "in" lines only.** An "out" line's cost would mean nothing (decision 11), and
  storing it would show a number on the document that the posting ignored.
- **The values are computed from the typed cost in the line's own unit**: `multiplyMoney(line.quantity, cost)` —
  3 (cartons) × ৳1,200, not 72 × ৳50. The two are equal only when the factor divides evenly; the invoice says
  "per carton", so that is what is multiplied.
- **`writeLines()` runs again after `post()`**, still in the draft state, to store the batches and the values. Step
  13's guard allows any change to a draft's lines; the status update right after freezes them.
- **`books.adjustment()` comes after the status update**, inside the same transaction. If an account is missing,
  it throws, and the whole posting (movements, number, status) rolls back.
- **`read()`** gives the typed `unitCost` to everyone, and `value` only with the permission; and the entry
  (`entries[0]`: an adjustment has at most one).
- **The audit row of the posting records the entry's number**: the audit log reads "posted ADJ-…, entry JV-…".

### `stock-transfers.service.ts`: values that travel with the goods

`apps/api/src/inventory/stock-transfers.service.ts` (changed):

```diff
@@ -4,11 +4,13 @@ import {
   type ErrorCode,
   fitsDecimals,
   isZeroQuantity,
+  prorateMoney,
   type ReceiveTransferInput,
   type StockTransfer,
   type StockTransferInput,
   type StockTransferSummary,
   type TransferStatus,
+  sumMoney,
   type UpdateStockTransferInput,
   wholeCount,
 } from '@omnivo/contracts';
@@ -35,7 +37,9 @@ import {
   resolveLines,
   toStockLine,
 } from './stock-lines.js';
+import { StockBooksService } from './stock-books.service.js';
 import { StockPostingService } from './stock-posting.service.js';
+import { ValueAccess } from './value-access.js';
 
 type TransferRow = typeof stockTransfers.$inferSelect;
 type LineRow = typeof stockTransferLines.$inferSelect;
@@ -79,6 +83,16 @@ function toSummary(row: TransferRow, lines: number, isShort: boolean): StockTran
   };
 }
 
+// What arrived of a line is worth the same per unit as what was sent (step 14): all of it, its
+// share, or nothing. A line sent before step 14 has no value (NULL): it left at zero, and arrives
+// at zero.
+function receivedValueOf(line: LineRow, received: string): string {
+  const sent = line.value ?? '0';
+  if (compareQuantity(received, line.baseQuantity) === 0) return sent;
+  if (isZeroQuantity(received)) return '0.0000';
+  return prorateMoney(sent, received, line.baseQuantity);
+}
+
 function storedInput(line: LineRow): LineInput {
   return {
     variantId: line.variantId,
@@ -95,6 +109,8 @@ export class StockTransfersService {
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
     private readonly numbering: NumberingService,
     private readonly posting: StockPostingService,
+    private readonly books: StockBooksService,
+    private readonly access: ValueAccess,
   ) {}
 
   list(query: {
@@ -310,6 +326,7 @@ export class StockTransfersService {
             ),
           );
       }
+      const values = receipts.map((receipt) => receivedValueOf(receipt.line, receipt.quantity));
       await this.posting.post(tx, {
         date: input.date,
         kind: 'transfer_in',
@@ -318,7 +335,7 @@ export class StockTransfersService {
         documentNumber: transfer.number ?? '',
         receivingTransferId: id,
         // Nothing arrived on a line: no movement for it, only its shortage
-        moves: receipts.flatMap((receipt) =>
+        moves: receipts.flatMap((receipt, index) =>
           isZeroQuantity(receipt.quantity)
             ? []
             : [
@@ -329,6 +346,8 @@ export class StockTransfersService {
                   batchId: receipt.line.batchId,
                   quantity: receipt.quantity,
                   serialNumbers: receipt.serialNumbers,
+                  // At the cost it left with, not today's average
+                  value: values[index] ?? '0',
                 },
               ],
         ),
@@ -347,11 +366,23 @@ export class StockTransfersService {
       const isShort = receipts.some(
         (receipt) => compareQuantity(receipt.quantity, receipt.line.baseQuantity) < 0,
       );
+      // The books (step 14): what arrived into the destination's inventory, what did not to the
+      // shortage account — between branches through goods in transit
+      const entry = await this.books.transferReceived(
+        tx,
+        { id, number: transfer.number ?? '', date: input.date },
+        {
+          fromWarehouseId: transfer.fromWarehouseId,
+          toWarehouseId: transfer.toWarehouseId,
+          sent: sumMoney(receipts.map((receipt) => receipt.line.value ?? '0')),
+          received: sumMoney(values),
+        },
+      );
       await audit(tx, {
         action: 'stock_transfer.received',
         entityType: 'stock_transfer',
         entityId: id,
-        changes: created({ date: input.date, short: isShort }),
+        changes: created({ date: input.date, short: isShort, entry: entry?.number ?? null }),
       });
       return this.read(tx, id);
     });
@@ -367,9 +398,9 @@ export class StockTransfersService {
     });
     const stored = await this.linesOf(tx, draft.id);
     const lines = await resolveLines(tx, stored.map(storedInput), 'out', { lock: true });
-    await this.writeLines(tx, draft.id, lines);
     const number = await this.numbering.next(tx, 'inventory.transfer', draft.sentOn);
-    await this.posting.post(tx, {
+    // What each line is worth as it leaves, at the average cost (step 14)
+    const values = await this.posting.post(tx, {
       date: draft.sentOn,
       kind: 'transfer_out',
       direction: 'out',
@@ -384,6 +415,8 @@ export class StockTransfersService {
         serialNumbers: line.serialNumbers,
       })),
     });
+    // Still a draft here: the lines may change, and keep their values from now on (0024's guard)
+    await this.writeLines(tx, draft.id, lines, values);
     await tx
       .update(stockTransfers)
       .set({
@@ -395,11 +428,20 @@ export class StockTransfersService {
         updatedBy: currentPrincipal().userId,
       })
       .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, draft.id)));
+    const entry = await this.books.transferSent(
+      tx,
+      { id: draft.id, number, date: draft.sentOn },
+      {
+        fromWarehouseId: draft.fromWarehouseId,
+        toWarehouseId: draft.toWarehouseId,
+        value: sumMoney(values),
+      },
+    );
     await audit(tx, {
       action: 'stock_transfer.sent',
       entityType: 'stock_transfer',
       entityId: draft.id,
-      changes: created({ number }),
+      changes: created({ number, entry: entry?.number ?? null }),
     });
   }
 
@@ -413,10 +455,12 @@ export class StockTransfersService {
     ]);
   }
 
+  // values: set when the transfer is sent (step 14)
   private async writeLines(
     tx: Transaction,
     transferId: string,
     lines: readonly ResolvedLine[],
+    values?: readonly string[],
   ): Promise<void> {
     const tenantId = getTenantId();
     await tx
@@ -440,6 +484,7 @@ export class StockTransfersService {
         baseQuantity: line.baseQuantity,
         batchId: line.batchId,
         serialNumbers: line.serialNumbers,
+        value: values?.[index] ?? null,
       })),
     );
   }
@@ -487,6 +532,10 @@ export class StockTransfersService {
     const [summary] = await this.summaries(tx, eq(stockTransfers.id, id), 1);
     if (!summary) throw notFound('Stock transfer');
     const lines = await this.linesOf(tx, id);
+    const [canSee, entries] = await Promise.all([
+      this.access.canSee(),
+      this.books.entriesOf(tx, id),
+    ]);
     const [variants, batches] = await Promise.all([
       loadVariants(
         tx,
@@ -511,9 +560,16 @@ export class StockTransfersService {
             ),
             receivedQuantity: line.receivedQuantity,
             receivedSerialNumbers: line.receivedSerialNumbers,
+            // Worked out from the books: only with the permission (step 14)
+            value: canSee ? line.value : null,
+            receivedValue:
+              canSee && line.receivedQuantity !== null
+                ? receivedValueOf(line, line.receivedQuantity)
+                : null,
           },
         ];
       }),
+      entries,
     };
   }
 
```

- **Sending** prices the lines at the average (`post()` returns the values) and stores them on the lines before
  the status changes; migration 0024 freezes them from then on.
- **`receivedValueOf()`**: what arrived is worth the same per unit as what left — all of it, its share, or nothing.
  A transfer that was sent before step 14 has `value` NULL: it left at zero, and arrives at zero; nothing is
  invented for it.
- **The receipt's moves carry their value explicitly** (`value: values[index]`), so `post()` does not price them
  at today's average: goods on a truck keep the cost they left with.
- **`read()`** sends `value` and `receivedValue` only with the permission, and every entry of the transfer.

### `stock.service.ts`: the stock pages, and the valuation report

`apps/api/src/inventory/stock.service.ts` (changed):

```diff
@@ -10,7 +10,11 @@ import {
   type StockItem,
   type StockMovementPage,
   type StockPage,
+  type StockValuePage,
+  subtractMoney,
+  sumMoney,
   todayIn,
+  type ValuationSummary,
 } from '@omnivo/contracts';
 import {
   batches,
@@ -34,6 +38,7 @@ import { decodeCursor, encodeCursor, toPage } from '../common/pagination/cursor.
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
+import { ValueAccess } from './value-access.js';
 
 // Postgres's NUMERIC as the API sends every quantity: 4 decimals, "0.0000" for nothing
 function quantityText(value: SQL): SQL<string> {
@@ -69,11 +74,14 @@ const itemRowSchema = z.object({
   on_hand: z.string(),
   in_transit: z.string(),
   low: z.boolean(),
+  unit_cost: z.string().nullable(),
+  value: z.string().nullable(),
   sort_key: z.string(),
   position: z.number().int(),
 });
 
-function toItem(row: z.output<typeof itemRowSchema>): StockItem {
+// canSee: inventory.stock.value (step 14) — without it, the costs are left out (null)
+function toItem(row: z.output<typeof itemRowSchema>, canSee: boolean): StockItem {
   return {
     variantId: row.variant_id,
     productId: row.product_id,
@@ -89,6 +97,8 @@ function toItem(row: z.output<typeof itemRowSchema>): StockItem {
     onHand: row.on_hand,
     inTransit: row.in_transit,
     low: row.low,
+    unitCost: canSee ? row.unit_cost : null,
+    value: canSee ? row.value : null,
   };
 }
 
@@ -115,6 +125,21 @@ const batchRowSchema = z.object({
   base_unit_id: z.uuid(),
 });
 
+const valueRowSchema = z.object({
+  variant_id: z.uuid(),
+  product_id: z.uuid(),
+  product_code: z.string(),
+  product_name: z.string(),
+  option_values: z.array(z.string()),
+  sku: z.string(),
+  base_unit_id: z.uuid(),
+  quantity: z.string(),
+  unit_cost: z.string().nullable(),
+  value: z.string(),
+  sort_key: z.string(),
+  position: z.number().int(),
+});
+
 const reorderRowSchema = z.object({
   variant_id: z.uuid(),
   product_id: z.uuid(),
@@ -135,7 +160,10 @@ const reorderRowSchema = z.object({
 // (how it got there) — never a quantity stored on a product.
 @Injectable()
 export class StockService {
-  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}
+  constructor(
+    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
+    private readonly access: ValueAccess,
+  ) {}
 
   list(query: {
     limit: number;
@@ -181,10 +209,11 @@ export class StockService {
     }
     return this.withTenant(async (tx) => {
       const rows = await this.items(tx, conditions, query.warehouseId, query.limit + 1);
+      const canSee = await this.access.canSee();
       const page = rows.slice(0, query.limit);
       const last = page.at(-1);
       return {
-        items: page.map(toItem),
+        items: page.map((row) => toItem(row, canSee)),
         nextCursor:
           rows.length > query.limit && last !== undefined
             ? encodeCursor([last.sort_key, last.product_id, last.position])
@@ -285,7 +314,7 @@ export class StockService {
         );
 
       return {
-        item: toItem(row),
+        item: toItem(row, await this.access.canSee()),
         warehouses: places.map((place) => ({
           warehouseId: place.warehouse_id,
           onHand: place.on_hand,
@@ -347,6 +376,7 @@ export class StockService {
           documentId: stockMovements.documentId,
           documentNumber: stockMovements.documentNumber,
           quantity: stockMovements.quantity,
+          value: stockMovements.value,
           lotNumber: batches.lotNumber,
           serialNumber: serials.serialNumber,
         })
@@ -399,11 +429,12 @@ export class StockService {
       if (!sums) throw new Error('Stock card sums returned no row');
 
       const page = toPage(rows, query.limit, (last) => [last.date, last.id]);
+      const canSee = await this.access.canSee();
       let balance = sums.beforePage;
       return {
         items: page.items.map((row) => {
           balance = addQuantity(balance, row.quantity);
-          return { ...row, balance };
+          return { ...row, balance, value: canSee ? row.value : null };
         }),
         nextCursor: page.nextCursor,
         openingBalance: sums.opening,
@@ -478,6 +509,137 @@ export class StockService {
     });
   }
 
+  // The valuation report (step 14): every variant that has stock or value, at its average cost.
+  // The numbers come from stock_values — the movements' own sums — never from quantity × a price.
+  valuation(query: {
+    limit: number;
+    cursor?: string | undefined;
+    search?: string | undefined;
+    categoryId?: string | undefined;
+  }): Promise<StockValuePage> {
+    const tenantId = getTenantId();
+    const after = decodeCursor(query.cursor, listCursorSchema);
+    const conditions: SQL[] = [
+      sql`sv.tenant_id = ${tenantId}::uuid`,
+      sql`(sv.quantity <> 0 OR sv.value <> 0)`,
+    ];
+    if (query.categoryId !== undefined) {
+      conditions.push(sql`p.category_id IN (
+        WITH RECURSIVE down AS (
+          SELECT id FROM product_categories WHERE tenant_id = ${tenantId}::uuid AND id = ${query.categoryId}::uuid
+          UNION ALL
+          SELECT c.id FROM product_categories c JOIN down ON c.parent_id = down.id
+           WHERE c.tenant_id = ${tenantId}::uuid
+        ) SELECT id FROM down)`);
+    }
+    if (query.search !== undefined && query.search !== '') {
+      const pattern = containsPattern(query.search);
+      conditions.push(
+        sql`(lower(p.name) LIKE ${pattern} OR lower(p.code) LIKE ${pattern} OR lower(v.sku) LIKE ${pattern})`,
+      );
+    }
+    if (after !== undefined) {
+      conditions.push(
+        sql`(lower(p.name), p.id, v.position) > (${after[0]}, ${after[1]}::uuid, ${after[2]}::int)`,
+      );
+    }
+    return this.withTenant(async (tx) => {
+      const rows = z.array(valueRowSchema).parse(
+        await tx.execute(sql`
+          SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
+                 p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
+                 round(sv.quantity, 4)::text AS quantity, round(sv.unit_cost, 4)::text AS unit_cost,
+                 round(sv.value, 4)::text AS value,
+                 lower(p.name) AS sort_key, v.position::int AS position
+            FROM stock_values sv
+            JOIN product_variants v ON v.tenant_id = sv.tenant_id AND v.id = sv.variant_id
+            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
+           WHERE ${sql.join(conditions, sql` AND `)}
+           ORDER BY lower(p.name), p.id, v.position
+           LIMIT ${query.limit + 1}`),
+      );
+      const page = rows.slice(0, query.limit);
+      const last = page.at(-1);
+      return {
+        items: page.map((row) => ({
+          variantId: row.variant_id,
+          productId: row.product_id,
+          productCode: row.product_code,
+          productName: row.product_name,
+          optionValues: row.option_values,
+          sku: row.sku,
+          baseUnitId: row.base_unit_id,
+          quantity: row.quantity,
+          unitCost: row.unit_cost,
+          value: row.value,
+        })),
+        nextCursor:
+          rows.length > query.limit && last !== undefined
+            ? encodeCursor([last.sort_key, last.product_id, last.position])
+            : null,
+      };
+    });
+  }
+
+  // The two sides that must be equal: the stock's value (in warehouses and on trucks) and the
+  // balances of the inventory and goods in transit accounts. Every stock document posts both in
+  // one transaction; a difference means something reached the books another way — an opening
+  // balance or a manual entry on the inventory account from before step 14.
+  valuationSummary(): Promise<ValuationSummary> {
+    const tenantId = getTenantId();
+    return this.withTenant(async (tx) => {
+      const totals = z
+        .array(z.object({ stock_value: z.string(), in_transit_value: z.string() }))
+        .parse(
+          await tx.execute(sql`
+            SELECT
+              round(coalesce((SELECT sum(sv.value) FROM stock_values sv
+                               WHERE sv.tenant_id = ${tenantId}::uuid), 0), 4)::text AS stock_value,
+              round(coalesce((SELECT sum(l.value) FROM stock_transfer_lines l
+                                JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
+                               WHERE l.tenant_id = ${tenantId}::uuid AND t.status = 'in_transit'), 0), 4)::text
+                AS in_transit_value`),
+        );
+      const accountIds = z
+        .array(z.object({ inventory: z.string().nullable(), in_transit: z.string().nullable() }))
+        .parse(
+          await tx.execute(sql`
+            SELECT (SELECT a.id::text FROM ledger_accounts a
+                     WHERE a.tenant_id = ${tenantId}::uuid AND a.purpose = 'inventory') AS inventory,
+                   (SELECT s.account_id::text FROM stock_accounts s
+                     WHERE s.tenant_id = ${tenantId}::uuid AND s.use = 'in_transit') AS in_transit`),
+        );
+      const ids = accountIds[0] ?? { inventory: null, in_transit: null };
+      const balanceOf = async (accountId: string | null) => {
+        if (accountId === null) return null;
+        const [row] = z.array(z.object({ balance: z.string() })).parse(
+          await tx.execute(sql`
+            SELECT round(coalesce(sum(l.debit - l.credit), 0), 4)::text AS balance
+              FROM journal_lines l
+              JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
+             WHERE l.tenant_id = ${tenantId}::uuid AND l.account_id = ${accountId}::uuid
+               AND e.status = 'posted'`),
+        );
+        return { id: accountId, balance: row?.balance ?? '0.0000' };
+      };
+      const [inventoryAccount, inTransitAccount] = await Promise.all([
+        balanceOf(ids.inventory),
+        balanceOf(ids.in_transit),
+      ]);
+      const total = totals[0] ?? { stock_value: '0.0000', in_transit_value: '0.0000' };
+      return {
+        stockValue: total.stock_value,
+        inTransitValue: total.in_transit_value,
+        inventoryAccount,
+        inTransitAccount,
+        difference: subtractMoney(
+          sumMoney([total.stock_value, total.in_transit_value]),
+          sumMoney([inventoryAccount?.balance ?? '0', inTransitAccount?.balance ?? '0']),
+        ),
+      };
+    });
+  }
+
   // What to order: every variant whose stock in a warehouse is at or below its level there
   reorder(query: {
     limit: number;
@@ -676,9 +838,17 @@ export class StockService {
                  WHERE l.tenant_id = v.tenant_id AND l.variant_id = v.id AND t.status = 'in_transit'
                    AND ${inWarehouse(sql`t.to_warehouse_id`)})`)} AS in_transit,
                ${lowCondition(warehouseId)} AS low,
+               round(sv.unit_cost, 4)::text AS unit_cost,
+               ${
+                 // In all warehouses: the ledger's own total. In one: its stock at the average.
+                 warehouseId === undefined
+                   ? sql`round(sv.value, 4)::text`
+                   : sql`round(round(coalesce(s.on_hand, 0) * coalesce(sv.unit_cost, 0), 2), 4)::text`
+               } AS value,
                lower(p.name) AS sort_key, v.position::int AS position
           FROM product_variants v
           JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
+          LEFT JOIN stock_values sv ON sv.tenant_id = v.tenant_id AND sv.variant_id = v.id
           LEFT JOIN LATERAL (
             SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
              WHERE sb.tenant_id = v.tenant_id AND sb.variant_id = v.id
```

- **`items()` joins `stock_values`** once, for the list and the card. In all warehouses the value is the ledger's
  own total; in one warehouse it is the quantity there × the average, rounded to the paisa
  (`round(round(…, 2), 4)::text`: two decimals of value, sent with four like every amount).
- **`toItem(row, canSee)`** is the one place a cost is hidden. `canSee` is asked once per request, not per row.
- **`valuation()`** reads only `stock_values` (no sums over the ledger): the list stays fast however many years
  of movements there are. An item with neither stock nor value is left out.
- **`valuationSummary()`** adds the four numbers of the check. The account balances are all posted lines, whatever
  their date: the stock's value is "now", so the books are too. A workspace that typed an opening balance on its
  inventory account before step 14 will see a difference here — see "Notes left for later steps".

### `stock-revaluations.service.ts` (new)

`apps/api/src/inventory/stock-revaluations.service.ts` (new):

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type StockRevaluation,
  type StockRevaluationInput,
  type StockRevaluationSummary,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { stockRevaluationLines, stockRevaluations } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { type LineIssue, linePath, linesError, loadVariants } from './stock-lines.js';
import { StockBooksService } from './stock-books.service.js';
import { StockPostingService } from './stock-posting.service.js';

type RevaluationRow = typeof stockRevaluations.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The outer table by its name: in a select from one table, Drizzle prints ${stockRevaluations.id}
// as a bare "id", which inside these subqueries would mean the line's own id (step 13's lesson)
const lineCount = sql<number>`(
  SELECT count(*)::int FROM stock_revaluation_lines l
   WHERE l.tenant_id = stock_revaluations.tenant_id AND l.revaluation_id = stock_revaluations.id
)`;
const difference = sql<string>`(
  SELECT round(coalesce(sum(l.new_value - l.old_value), 0), 4)::text FROM stock_revaluation_lines l
   WHERE l.tenant_id = stock_revaluations.tenant_id AND l.revaluation_id = stock_revaluations.id
)`;

function toSummary(row: RevaluationRow, lines: number, total: string): StockRevaluationSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    note: row.note,
    lineCount: lines,
    difference: total,
    postedAt: row.postedAt.toISOString(),
  };
}

// Revaluing stock (step 14): new average costs, posted at once. A revaluation is written whole
// in one transaction — its header, its movements (StockPostingService.revalue()), its lines and its
// journal entry — and never changes afterwards (migration 0024).
@Injectable()
export class StockRevaluationsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: StockRevaluationSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        after === undefined
          ? undefined
          : sql`(${stockRevaluations.date}, ${stockRevaluations.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<StockRevaluation> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: StockRevaluationInput): Promise<StockRevaluation> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // An open period, and not tomorrow: the same rule as every stock document
      await this.posting.assertDate(tx, input.date);
      // FOR SHARE on the products: nobody turns one into a service under us
      const variants = await loadVariants(
        tx,
        input.lines.map((line) => line.variantId),
        { lock: true },
      );
      const issues: LineIssue[] = [];
      input.lines.forEach((line, index) => {
        // The same answer for "no such variant", "another workspace's" and "a service"
        if (variants.get(line.variantId)?.type !== 'goods') {
          issues.push({ path: linePath(index, 'variantId'), code: 'stock_variant_invalid' });
        }
      });
      if (issues.length > 0) throw linesError(issues);

      const number = await this.numbering.next(tx, 'inventory.revaluation', input.date);
      const [row] = await tx
        .insert(stockRevaluations)
        .values({
          tenantId,
          number,
          date: input.date,
          note: input.note,
          postedBy: currentPrincipal().userId,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Stock revaluation insert returned no row');

      const results = await this.posting.revalue(
        tx,
        { date: input.date, documentId: row.id, documentNumber: number },
        input.lines.map((line, index) => {
          const variant = variants.get(line.variantId);
          if (!variant) throw new Error('Variant checked above');
          return { line: index, variant, unitCost: line.unitCost };
        }),
      );
      await tx.insert(stockRevaluationLines).values(
        input.lines.map((line, index) => {
          const variant = variants.get(line.variantId);
          const result = results[index];
          if (!variant || !result) throw new Error('Line checked above');
          return {
            tenantId,
            revaluationId: row.id,
            lineNo: index + 1,
            productId: variant.productId,
            variantId: variant.variantId,
            quantity: result.quantity,
            oldUnitCost: result.oldUnitCost,
            oldValue: result.oldValue,
            unitCost: line.unitCost,
            newValue: result.newValue,
          };
        }),
      );
      const entry = await this.books.revaluation(
        tx,
        { id: row.id, number, date: input.date },
        results.flatMap((result) => result.byWarehouse),
      );
      await audit(tx, {
        action: 'stock_revaluation.posted',
        entityType: 'stock_revaluation',
        entityId: row.id,
        changes: created({
          number,
          lines: input.lines.length,
          difference: sumMoney(results.map((result) => result.difference)),
          entry: entry?.number ?? null,
        }),
      });
      return this.read(tx, row.id);
    });
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<StockRevaluationSummary[]> {
    const rows = await tx
      .select({ revaluation: stockRevaluations, lineCount, difference })
      .from(stockRevaluations)
      .where(and(eq(stockRevaluations.tenantId, getTenantId()), where))
      .orderBy(desc(stockRevaluations.date), desc(stockRevaluations.id))
      .limit(limit);
    return rows.map((row) => toSummary(row.revaluation, row.lineCount, row.difference));
  }

  private async read(tx: Transaction, id: string): Promise<StockRevaluation> {
    const [summary] = await this.summaries(tx, eq(stockRevaluations.id, id), 1);
    if (!summary) throw notFound('Stock revaluation');
    const lines = await tx
      .select()
      .from(stockRevaluationLines)
      .where(
        and(
          eq(stockRevaluationLines.tenantId, getTenantId()),
          eq(stockRevaluationLines.revaluationId, id),
        ),
      )
      .orderBy(asc(stockRevaluationLines.lineNo));
    const variants = await loadVariants(
      tx,
      lines.map((line) => line.variantId),
    );
    const [entry] = await this.books.entriesOf(tx, id);
    return {
      ...summary,
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          {
            id: line.id,
            variantId: variant.variantId,
            productId: variant.productId,
            productCode: variant.productCode,
            productName: variant.productName,
            optionValues: variant.optionValues,
            sku: variant.sku,
            baseUnitId: variant.baseUnitId,
            quantity: line.quantity,
            oldUnitCost: line.oldUnitCost,
            oldValue: line.oldValue,
            unitCost: line.unitCost,
            newValue: line.newValue,
            difference: subtractMoney(line.newValue, line.oldValue),
          },
        ];
      }),
      entry: entry ?? null,
    };
  }
}
```

- **One transaction for everything**: header, movements, lines, entry, audit. A refused line (no stock) leaves
  nothing behind, and the number goes back (step 6's numbering is transactional).
- **The header is inserted before `revalue()`**: the movements need its id and number. `stock_movements` has no
  foreign key to documents (step 13), so the order would not matter to the database; it matters to the reader.
- **`loadVariants(…, { lock: true })`**: `FOR SHARE` on the products, so nobody turns one into a service while it
  is being revalued (the same rule as step 13's postings).
- **The audit `difference` is `sumMoney(…)`**, a decimal string — never a JavaScript number.
- **`lineCount` and `difference` name the outer table in plain SQL**: in a select from one table, Drizzle prints
  `${stockRevaluations.id}` as a bare `"id"`, which inside the subquery would be the line's own id (step 13's
  lesson).

### `stock-accounts.service.ts` (new)

`apps/api/src/inventory/stock-accounts.service.ts` (new):

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  accountTypeFits,
  type ErrorCode,
  STOCK_ACCOUNT_USES,
  type StockAccounts,
  type UpdateStockAccountsInput,
} from '@omnivo/contracts';
import { ledgerAccounts, stockAccounts } from '@omnivo/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { lockChart } from '../accounts/accounts.service.js';
import { audit, diff } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// The accounts stock documents post to (step 14), as Settings → Inventory shows and saves them
@Injectable()
export class StockAccountsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<StockAccounts> {
    return this.withTenant((tx) => this.read(tx));
  }

  // Every use at once, like the settings form: each must be an active ledger of a type that fits
  // (an asset for goods in transit, income or expense for the rest), and never the inventory
  // account itself — stock against stock would post nothing real.
  update(input: UpdateStockAccountsInput): Promise<StockAccounts> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // The chart's own lock: nobody archives or deletes one of these accounts until we commit
      // (AccountsService takes it first, then refuses an account a stock use points at)
      await lockChart(tx);
      const before = await this.read(tx);
      const ids = [...new Set(STOCK_ACCOUNT_USES.map((use) => input[use]))];
      const accounts = await tx
        .select({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          type: ledgerAccounts.type,
          isGroup: ledgerAccounts.isGroup,
          purpose: ledgerAccounts.purpose,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.tenantId, tenantId),
            inArray(ledgerAccounts.id, ids),
            isNull(ledgerAccounts.archivedAt),
          ),
        );
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const fieldErrors: Record<string, ErrorCode[]> = {};
      for (const use of STOCK_ACCOUNT_USES) {
        const account = byId.get(input[use]);
        if (account?.purpose === 'inventory') fieldErrors[use] = ['stock_account_inventory'];
        else if (!account || account.isGroup || !accountTypeFits(use, account.type)) {
          fieldErrors[use] = ['stock_account_invalid'];
        }
      }
      const [first] = Object.values(fieldErrors);
      if (first?.[0] !== undefined) {
        throw new AppError(409, first[0], 'Some stock accounts cannot be used.', { fieldErrors });
      }

      await tx
        .insert(stockAccounts)
        .values(
          STOCK_ACCOUNT_USES.map((use) => ({
            tenantId,
            use,
            accountId: input[use],
            updatedBy: currentPrincipal().userId,
          })),
        )
        .onConflictDoUpdate({
          target: [stockAccounts.tenantId, stockAccounts.use],
          set: {
            // The row's new value, as this insert would have written it
            accountId: sql`excluded.account_id`,
            updatedAt: new Date(),
            updatedBy: currentPrincipal().userId,
          },
        });
      const after = await this.read(tx);
      // The audit log shows codes ("5150"), which a person can read, not ids
      const codeOf = await this.codes(tx, [...Object.values(before), ...ids]);
      const asCodes = (choices: StockAccounts) =>
        Object.fromEntries(
          STOCK_ACCOUNT_USES.map((use) => {
            const id = choices[use];
            return [use, id === null ? null : (codeOf.get(id) ?? null)];
          }),
        );
      await audit(tx, {
        action: 'stock_accounts.changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff(asCodes(before), asCodes(after)),
      });
      return after;
    });
  }

  private async codes(
    tx: Transaction,
    ids: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await tx
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), inArray(ledgerAccounts.id, wanted)));
    return new Map(rows.map((row) => [row.id, row.code]));
  }

  private async read(tx: Transaction): Promise<StockAccounts> {
    const rows = await tx
      .select({ use: stockAccounts.use, accountId: stockAccounts.accountId })
      .from(stockAccounts)
      .where(eq(stockAccounts.tenantId, getTenantId()));
    const byUse = new Map(rows.map((row) => [row.use, row.accountId]));
    return {
      in_transit: byUse.get('in_transit') ?? null,
      found: byUse.get('found') ?? null,
      damaged: byUse.get('damaged') ?? null,
      expired: byUse.get('expired') ?? null,
      lost: byUse.get('lost') ?? null,
      sample: byUse.get('sample') ?? null,
      internal_use: byUse.get('internal_use') ?? null,
      correction: byUse.get('correction') ?? null,
      transfer_shortage: byUse.get('transfer_shortage') ?? null,
      revaluation: byUse.get('revaluation') ?? null,
    };
  }
}
```

- **`lockChart(tx)` first** — the chart's own advisory lock, now exported from `AccountsService` (14.4). Archiving an
  account takes it too, then refuses an account a stock use points at. So "choose 5150" and "archive 5150" can never
  both succeed.
- **All the problems at once**, each under its use (`damaged: ['stock_account_invalid']`): the card shows each
  error under its select.
- **`stock_account_inventory`** is its own code: "this one is the inventory account itself" says more than "pick
  another account". Stock against stock would post nothing real.
- **An upsert of all ten rows** (`onConflictDoUpdate` with `excluded.account_id`): the form always saves every
  choice, and a use that was missing (an older workspace whose job could not choose it) is created here.
- **The audit row shows codes**, not ids (`{ sample: { from: '5310', to: '5320' } }`): the audit log is read by
  people.

### Controllers and the module

`apps/api/src/inventory/stock.controller.ts` (changed):

```diff
@@ -42,6 +42,18 @@ export class StockController {
     return this.stock.reorder(query);
   }
 
+  @Endpoint(routes.stock.valuation)
+  valuation({
+    query,
+  }: RouteInput<Routes['valuation']>): Promise<RouteResponse<Routes['valuation']>> {
+    return this.stock.valuation(query);
+  }
+
+  @Endpoint(routes.stock.valuationSummary)
+  valuationSummary(): Promise<RouteResponse<Routes['valuationSummary']>> {
+    return this.stock.valuationSummary();
+  }
+
   @Endpoint(routes.stock.setReorderLevel)
   setReorderLevel({
     body,
```

`apps/api/src/inventory/valuation.controller.ts` (new):

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { StockAccountsService } from './stock-accounts.service.js';
import { StockRevaluationsService } from './stock-revaluations.service.js';

type RevaluationRoutes = typeof routes.stockRevaluations;
type AccountRoutes = typeof routes.stockAccounts;

@Controller()
export class StockRevaluationsController {
  constructor(private readonly revaluations: StockRevaluationsService) {}

  @Endpoint(routes.stockRevaluations.list)
  list({
    query,
  }: RouteInput<RevaluationRoutes['list']>): Promise<RouteResponse<RevaluationRoutes['list']>> {
    return this.revaluations.list(query);
  }

  @Endpoint(routes.stockRevaluations.get)
  get({
    params,
  }: RouteInput<RevaluationRoutes['get']>): Promise<RouteResponse<RevaluationRoutes['get']>> {
    return this.revaluations.get(params.id);
  }

  @Endpoint(routes.stockRevaluations.create)
  create({
    body,
  }: RouteInput<RevaluationRoutes['create']>): Promise<RouteResponse<RevaluationRoutes['create']>> {
    return this.revaluations.create(body);
  }
}

@Controller()
export class StockAccountsController {
  constructor(private readonly accounts: StockAccountsService) {}

  @Endpoint(routes.stockAccounts.get)
  get(): Promise<RouteResponse<AccountRoutes['get']>> {
    return this.accounts.get();
  }

  @Endpoint(routes.stockAccounts.update)
  update({
    body,
  }: RouteInput<AccountRoutes['update']>): Promise<RouteResponse<AccountRoutes['update']>> {
    return this.accounts.update(body);
  }
}
```

`apps/api/src/inventory/inventory.module.ts` (changed — the whole file):

```ts
import { Module } from '@nestjs/common';

import { JournalModule } from '../journal/journal.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { RbacModule } from '../rbac/rbac.module.js';
import { StockAccountsService } from './stock-accounts.service.js';
import { StockAdjustmentsService } from './stock-adjustments.service.js';
import { StockBooksService } from './stock-books.service.js';
import {
  StockAdjustmentsController,
  StockController,
  StockTransfersController,
} from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';
import { StockRevaluationsService } from './stock-revaluations.service.js';
import { StockTransfersService } from './stock-transfers.service.js';
import { StockService } from './stock.service.js';
import { StockAccountsController, StockRevaluationsController } from './valuation.controller.js';
import { ValueAccess } from './value-access.js';
import { WarehousesController } from './warehouses.controller.js';
import { WarehousesService } from './warehouses.service.js';

// Warehouses and the stock ledger (step 13), and what the stock is worth (step 14).
// StockPostingService and StockBooksService are exported: purchases, sales and POS (steps 15–20)
// import this module, call post() for the stock and its values, and write their own journal entry
// in the same transaction, the way every module that posts to the books uses the journal's
// PostingService. JournalModule gives StockBooksService that PostingService; RbacModule gives
// ValueAccess the permission check. The low-stock alert's worker half (low-stock.handler.ts) is
// wired in worker/worker.module.ts, like every handler.
@Module({
  imports: [NumberingModule, JournalModule, RbacModule],
  controllers: [
    WarehousesController,
    StockController,
    StockAdjustmentsController,
    StockTransfersController,
    StockRevaluationsController,
    StockAccountsController,
  ],
  providers: [
    WarehousesService,
    StockService,
    StockPostingService,
    StockBooksService,
    StockAdjustmentsService,
    StockTransfersService,
    StockRevaluationsService,
    StockAccountsService,
    ValueAccess,
  ],
  exports: [StockPostingService, StockBooksService],
})
export class InventoryModule {}
```

- **`InventoryModule` imports `JournalModule`** (for `PostingService`) and **`RbacModule`** (for `ValueAccess`).
  Neither imports `InventoryModule`, so there is no circle; `pnpm boundaries` checks it.
- **`StockBooksService` is exported** next to `StockPostingService`: a sales delivery (step 15) will call `post()`
  for the stock and write its own entry (Dr Cost of goods sold / Cr Inventory) the same way.

---
## 14.4 — The API: changes to existing code

### The journal: the document, and the stock accounts kept for stock

`apps/api/src/journal/posting.service.ts` (changed):

```diff
@@ -1,6 +1,11 @@
 import { Injectable } from '@nestjs/common';
-import { type ErrorCode, type JournalSource, sumMoney } from '@omnivo/contracts';
-import { branches, journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
+import {
+  type ErrorCode,
+  isStockJournalSource,
+  type JournalSource,
+  sumMoney,
+} from '@omnivo/contracts';
+import { branches, journalEntries, journalLines, ledgerAccounts, stockAccounts } from '@omnivo/db';
 import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
 
 import { AppError } from '../common/http/app-error.js';
@@ -27,6 +32,8 @@ export interface NewEntry {
   source: JournalSource;
   // Only for source 'reversal'
   reversalOfId?: string;
+  // Only for a stock document's entry (step 14): the document that made it
+  document?: { id: string; number: string };
   lines: readonly LineInput[];
 }
 
@@ -39,6 +46,25 @@ function lineErrors(code: ErrorCode, field: string, indexes: readonly number[]):
   });
 }
 
+// The accounts only stock documents post to (step 14): the inventory account and the goods in
+// transit account. A manual entry or an opening balance on them would make the books say one value
+// and the stock another, with nothing to bring them back together. Stock comes in through an
+// adjustment (opening stock too), and a wrong value is put right by a revaluation.
+export async function stockAccountIds(tx: Transaction): Promise<Set<string>> {
+  const tenantId = getTenantId();
+  const [inventory, inTransit] = await Promise.all([
+    tx
+      .select({ id: ledgerAccounts.id })
+      .from(ledgerAccounts)
+      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.purpose, 'inventory'))),
+    tx
+      .select({ id: stockAccounts.accountId })
+      .from(stockAccounts)
+      .where(and(eq(stockAccounts.tenantId, tenantId), eq(stockAccounts.use, 'in_transit'))),
+  ]);
+  return new Set([...inventory, ...inTransit].map((row) => row.id));
+}
+
 // Who did it: the person behind the request, or nobody (a background job) — like audit()
 function actorId(): string | null {
   return tenantStorage.getStore()?.principal?.userId ?? null;
@@ -57,10 +83,15 @@ export class PostingService {
   // locks FOR UPDATE), while other postings to the same account go on in parallel.
   // allowArchived: a reversal undoes an entry exactly, even if one of its accounts was archived
   // since — archiving hides an account from new work, it must not block fixing old work.
+  // allowStock: the entry may post to the inventory and goods in transit accounts — a stock
+  // document's entry, or a reversal or closing entry of old work. Every other entry may not.
   async checkLines(
     tx: Transaction,
     lines: readonly LineInput[],
-    { allowArchived = false }: { allowArchived?: boolean } = {},
+    {
+      allowArchived = false,
+      allowStock = false,
+    }: { allowArchived?: boolean; allowStock?: boolean } = {},
   ): Promise<void> {
     const tenantId = getTenantId();
     const accountIds = [...new Set(lines.map((line) => line.accountId))];
@@ -83,6 +114,11 @@ export class PostingService {
     // the form shows one sentence, and nothing about other tenants leaks
     if (badAccounts.length > 0)
       throw lineErrors('journal_account_invalid', 'accountId', badAccounts);
+    if (!allowStock) {
+      const stock = await stockAccountIds(tx);
+      const onStock = lines.flatMap((line, index) => (stock.has(line.accountId) ? [index] : []));
+      if (onStock.length > 0) throw lineErrors('journal_account_stock', 'accountId', onStock);
+    }
 
     const branchIds = [
       ...new Set(lines.flatMap((line) => (line.branchId === null ? [] : [line.branchId]))),
@@ -139,6 +175,8 @@ export class PostingService {
         narration: entry.narration,
         source: entry.source,
         reversalOfId: entry.reversalOfId ?? null,
+        documentId: entry.document?.id ?? null,
+        documentNumber: entry.document?.number ?? null,
         createdBy: actorId(),
         updatedBy: actorId(),
       })
@@ -175,6 +213,10 @@ export class PostingService {
     // that holds a balance: both must reach an account that was archived since
     await this.checkLines(tx, lines, {
       allowArchived: entry.source === 'reversal' || entry.source === 'year_close',
+      allowStock:
+        entry.source === 'reversal' ||
+        entry.source === 'year_close' ||
+        isStockJournalSource(entry.source),
     });
 
     // In the same transaction: if anything after this fails, the number goes back (step 6)
```

- **`stockAccountIds()`** is exported: `OpeningBalancesService` needs the same answer.
- **`checkLines(…, { allowStock })`** refuses lines on the inventory and goods in transit accounts unless the entry
  may post to them (decision 10). The refusal sits under each such line (`lines.0.accountId`), like every other
  line error of the journal form.
- **`post()` allows them for three kinds of entry**: a stock document's (it *is* the stock), a reversal (it undoes
  an entry that was allowed, perhaps from before step 14), and a year-end close (it only empties income and expense
  accounts, so it never meets the inventory account — allowing it keeps a future change from refusing a close). A manual entry and an opening balance are refused.
- **`insertDraft()` stores `document`.** The database check (14.2) makes sure a stock source always comes with it.

`apps/api/src/journal/journal.service.ts` (changed):

```diff
@@ -1,5 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  isStockJournalSource,
   type JournalEntry,
   type JournalEntryInput,
   type JournalEntrySummary,
@@ -185,6 +186,16 @@ export class JournalService {
             'A closing entry is undone by reopening its year.',
           );
         }
+        if (isStockJournalSource(entry.source)) {
+          // A stock document's entry moves with its stock (step 14): reversing it alone would
+          // leave the stock worth one thing and the books another. Another stock document puts it
+          // right — an adjustment the other way, or a revaluation.
+          throw new AppError(
+            409,
+            'journal_is_stock',
+            'This entry belongs to a stock document. Post another stock document to correct it.',
+          );
+        }
         if (entry.version !== input.version) throw versionConflict();
         const [already] = await tx
           .select({ id: reversal.id })
@@ -326,6 +337,10 @@ export class JournalService {
         refs.reversedById !== null && refs.reversedByNumber !== null
           ? { id: refs.reversedById, number: refs.reversedByNumber }
           : null,
+      document:
+        entry.documentId !== null && entry.documentNumber !== null
+          ? { id: entry.documentId, number: entry.documentNumber }
+          : null,
       postedAt: entry.postedAt?.toISOString() ?? null,
       version: entry.version,
       updatedAt: entry.updatedAt.toISOString(),
```

- **Reversing a stock entry is refused** (`journal_is_stock`), before the version check: it is never possible, so
  it should not depend on having the latest version. The other side of the rule is in the app: the Reverse button
  is not shown for them (14.7).
- **`document` in every summary**, from the entry's own columns: the journal list and page need no join.

`apps/api/src/journal/opening-balances.service.ts` (changed):

```diff
@@ -18,7 +18,7 @@ import { AppError, versionConflict } from '../common/http/app-error.js';
 import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
-import { type LineInput, PostingService } from './posting.service.js';
+import { type LineInput, PostingService, stockAccountIds } from './posting.service.js';
 
 const reversal = alias(journalEntries, 'reversal');
 
@@ -27,7 +27,7 @@ const reversal = alias(journalEntries, 'reversal');
 const OPENING_TYPES = ['asset', 'liability', 'equity'] as const;
 
 function invalidLines(
-  code: 'opening_account_invalid' | 'opening_account_twice',
+  code: 'opening_account_invalid' | 'opening_account_twice' | 'journal_account_stock',
   indexes: number[],
 ) {
   return new AppError(409, code, 'Some lines cannot take an opening balance.', {
@@ -101,6 +101,11 @@ export class OpeningBalancesService {
       );
       const invalid = filled.flatMap((line) => (allowed.has(line.accountId) ? [] : [line.index]));
       if (invalid.length > 0) throw invalidLines('opening_account_invalid', invalid);
+      // Step 14: opening stock is an adjustment (reason "Opening stock"), which values each item and
+      // posts it — a number typed here would be a value with no stock behind it
+      const stock = await stockAccountIds(tx);
+      const onStock = filled.flatMap((line) => (stock.has(line.accountId) ? [line.index] : []));
+      if (onStock.length > 0) throw invalidLines('journal_account_stock', onStock);
 
       if (current) {
         const lines = await this.linesOf(tx, current.id);
```

Opening balances have their own error shape (their indexes are the page's rows, not the posted entry's lines),
so they check the stock accounts themselves instead of waiting for `PostingService` to refuse them with the
entry's line numbers. Opening stock is an adjustment with the reason "Opening stock" (decision 2).

### Accounts: a chosen stock account stays

`apps/api/src/accounts/accounts.service.ts` (changed):

```diff
@@ -1,6 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import type { Account, CreateAccountInput, UpdateAccountInput } from '@omnivo/contracts';
-import { ledgerAccounts } from '@omnivo/db';
+import { ledgerAccounts, stockAccounts } from '@omnivo/db';
 import { and, asc, eq, isNull, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../common/audit/audit.js';
@@ -56,6 +56,26 @@ function locked(): AppError {
   );
 }
 
+function usedByStock(): AppError {
+  return new AppError(
+    409,
+    'account_used_by_stock',
+    'Stock documents post to this account. Choose another one in Settings → Inventory first.',
+  );
+}
+
+// An account chosen in Settings → Inventory stays usable (step 14). The caller holds the chart
+// lock, and so does StockAccountsService when it saves the choices: nobody points a stock use at
+// this account before we commit.
+async function assertNotStockAccount(tx: Transaction, accountId: string): Promise<void> {
+  const [used] = await tx
+    .select({ use: stockAccounts.use })
+    .from(stockAccounts)
+    .where(and(eq(stockAccounts.tenantId, getTenantId()), eq(stockAccounts.accountId, accountId)))
+    .limit(1);
+  if (used) throw usedByStock();
+}
+
 // Every change to a tenant's chart takes this lock first, so the changes to one chart run one after
 // another (other tenants never wait). A chart is edited a few times a month, so the wait is
 // nothing, and it removes two races that row locks alone leave open:
@@ -69,7 +89,7 @@ function locked(): AppError {
 // An advisory lock is a lock on a number instead of a row; the _xact_ kind is released at commit or
 // rollback by itself. hashtextextended turns the text into that number; the prefix keeps it apart
 // from any other advisory lock added later.
-async function lockChart(tx: Transaction): Promise<void> {
+export async function lockChart(tx: Transaction): Promise<void> {
   const key = `ledger_accounts:${getTenantId()}`;
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
 }
@@ -169,6 +189,8 @@ export class AccountsService {
       if (before.version !== version) throw versionConflict();
       if (before.archivedAt !== null) return toAccount(before);
       if (before.parentId === null || before.purpose !== null) throw locked();
+      // Chosen for a stock use (step 14): archived, it would refuse every stock posting that needs it
+      await assertNotStockAccount(tx, id);
       if (before.isGroup) {
         // The chart lock keeps a new or restored child from appearing before we commit
         const [child] = await tx
@@ -263,6 +285,8 @@ export class AccountsService {
       if (isForeignKeyViolation(error, 'journal_lines_account_fk')) {
         throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
       }
+      // Chosen for a stock use in Settings → Inventory (step 14)
+      if (isForeignKeyViolation(error, 'stock_accounts_account_fk')) throw usedByStock();
       throw error;
     }
   }
```

- **`lockChart()` is exported**: `StockAccountsService` takes the same lock (14.3).
- **Archiving** checks `stock_accounts` under that lock. **Deleting** relies on the foreign key (like
  `journal_lines_account_fk`): one fewer query, and no race to get wrong.

### Setup: the stock accounts with the chart

`apps/api/src/setup/templates.ts` (changed):

```diff
@@ -4,6 +4,7 @@ import type {
   CustomFieldType,
   Industry,
   PermissionKey,
+  StockAccountUse,
   UnitDimension,
 } from '@omnivo/contracts';
 
@@ -66,6 +67,9 @@ export interface IndustryTemplate {
   roles: RoleTemplate[];
   chart: ChartTemplate;
   catalog: CatalogTemplate;
+  // Step 14: the account (by its code in `chart`) each stock use starts with. The owner may choose
+  // others in Settings → Inventory.
+  stockAccounts: Record<StockAccountUse, string>;
 }
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
@@ -82,6 +86,9 @@ const ACCOUNTANT: RoleTemplate = {
     'accounting.journal.post',
     'accounting.period.close',
     'accounting.report.read',
+    // Step 14: what the stock is worth, and putting a wrong cost right
+    'inventory.stock.value',
+    'inventory.stock.revalue',
   ],
 };
 
@@ -147,6 +154,8 @@ function standardChart(industry: IndustryAccounts): ChartTemplate {
           account('1164', 'Advance income tax (AIT)'),
         ]),
         account('1170', 'Input VAT', 'vat_input'),
+        // Step 14: stock sent from one branch to another, on its way. Still the company's goods.
+        account('1175', 'Goods in transit'),
         ...(industry.currentAssets ?? []),
       ]),
       group('1200', 'Fixed assets', [
@@ -187,7 +196,12 @@ function standardChart(industry: IndustryAccounts): ChartTemplate {
       ]),
     ]),
     expense: group('5000', 'Expenses', [
-      group('5100', 'Cost of sales', industry.costOfSales),
+      group('5100', 'Cost of sales', [
+        ...industry.costOfSales,
+        // Step 14: stock found in a count, corrections and revaluations — gains and losses on the
+        // stock itself, next to what the stock cost when it was sold
+        account('5190', 'Stock adjustments and revaluation'),
+      ]),
       group('5200', 'Administrative expenses', [
         account('5210', 'Salaries and allowances'),
         account('5220', 'Office rent'),
@@ -197,6 +211,8 @@ function standardChart(industry: IndustryAccounts): ChartTemplate {
         account('5260', 'Telephone and internet'),
         account('5270', 'Repairs and maintenance'),
         account('5280', 'Depreciation'),
+        // Step 14: stock the company uses itself (cleaning stores, a sample for the office)
+        account('5290', 'Consumables and internal use'),
       ]),
       group('5300', 'Selling and distribution expenses', [
         account('5310', 'Advertising and promotion'),
@@ -245,6 +261,27 @@ const COMMON_UNITS = [
   unit('carton', 'Carton', 'count', null),
 ] as const;
 
+// The accounts a new workspace's stock documents post to (step 14). loss: where damaged, expired,
+// lost and short-received stock goes — an industry that already has such an account uses it, the
+// others get "Stock losses" (STOCK_LOSSES). samples: physician samples in pharma, promotion
+// elsewhere. Codes from standardChart(): 1175, 5190, 5290, 5310.
+function stockAccounts(codes: { loss: string; samples?: string }): Record<StockAccountUse, string> {
+  return {
+    in_transit: '1175',
+    found: '5190',
+    damaged: codes.loss,
+    expired: codes.loss,
+    lost: codes.loss,
+    sample: codes.samples ?? '5310',
+    internal_use: '5290',
+    correction: '5190',
+    transfer_shortage: codes.loss,
+    revaluation: '5190',
+  };
+}
+
+const STOCK_LOSSES = account('5150', 'Stock losses (damaged, expired, lost)');
+
 const TRADER_STOCK = account('1150', 'Inventory', 'inventory');
 const COGS = account('5110', 'Cost of goods sold', 'cost_of_goods_sold');
 // Makers post the sale's cost from finished goods; raw materials move there through production
@@ -280,7 +317,7 @@ export const INDUSTRY_TEMPLATES = {
       currentLiabilities: [account('2180', 'Back-to-back LC payable')],
       revenue: [account('4110', 'Export sales', 'sales'), account('4120', 'Local sales')],
       otherIncome: [account('4230', 'Cash incentive on exports')],
-      costOfSales: [...MAKER_COSTS, account('5140', 'Subcontract charges')],
+      costOfSales: [...MAKER_COSTS, account('5140', 'Subcontract charges'), STOCK_LOSSES],
       selling: [
         account('5330', 'Export freight and C&F charges'),
         account('5340', 'Buying house commission'),
@@ -309,6 +346,7 @@ export const INDUSTRY_TEMPLATES = {
         { key: 'season', label: 'Season', type: 'text' },
       ],
     },
+    stockAccounts: stockAccounts({ loss: '5150' }),
   },
   pharma: {
     roles: [
@@ -373,6 +411,7 @@ export const INDUSTRY_TEMPLATES = {
         { key: 'dar_number', label: 'DAR number', type: 'text' },
       ],
     },
+    stockAccounts: stockAccounts({ loss: '5350', samples: '5330' }),
   },
   distribution: {
     roles: [
@@ -424,6 +463,7 @@ export const INDUSTRY_TEMPLATES = {
         { key: 'brand', label: 'Brand', type: 'text' },
       ],
     },
+    stockAccounts: stockAccounts({ loss: '5330' }),
   },
   manufacturing: {
     roles: [
@@ -443,7 +483,7 @@ export const INDUSTRY_TEMPLATES = {
         account('1154', 'Stores and spares'),
       ]),
       revenue: [account('4110', 'Sales', 'sales')],
-      costOfSales: [...MAKER_COSTS, account('5140', 'Factory power and fuel')],
+      costOfSales: [...MAKER_COSTS, account('5140', 'Factory power and fuel'), STOCK_LOSSES],
     }),
     catalog: {
       units: [
@@ -467,6 +507,7 @@ export const INDUSTRY_TEMPLATES = {
         { key: 'grade', label: 'Grade', type: 'text' },
       ],
     },
+    stockAccounts: stockAccounts({ loss: '5150' }),
   },
   retail: {
     roles: [
@@ -512,6 +553,7 @@ export const INDUSTRY_TEMPLATES = {
       ],
       customFields: [{ key: 'brand', label: 'Brand', type: 'text' }],
     },
+    stockAccounts: stockAccounts({ loss: '5340' }),
   },
   other: {
     roles: [
@@ -530,12 +572,13 @@ export const INDUSTRY_TEMPLATES = {
     chart: standardChart({
       stock: TRADER_STOCK,
       revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Service income')],
-      costOfSales: [COGS],
+      costOfSales: [COGS, STOCK_LOSSES],
     }),
     catalog: {
       units: COMMON_UNITS,
       categories: [category('General')],
       customFields: [],
     },
+    stockAccounts: stockAccounts({ loss: '5150' }),
   },
 } satisfies Record<Industry, IndustryTemplate>;
```

- **Four accounts in `standardChart()`**: 1175 Goods in transit (every industry), 5190 Stock adjustments and
  revaluation, 5290 Consumables and internal use. **5150 Stock losses** only where the industry has no loss
  account of its own (`STOCK_LOSSES` in garments, manufacturing and other).
- **`stockAccounts()`** builds each industry's choices from codes. `IndustryTemplate.stockAccounts` is a
  `Record<StockAccountUse, string>`, so a new use does not compile until every industry says where it goes.
- **The Accountant gets both new permissions.** Store keepers do not: they count stock, they do not price it.

`apps/api/src/setup/templates.spec.ts` (changed):

```diff
@@ -4,7 +4,9 @@ import {
   createAccountInputSchema,
   createCustomFieldInputSchema,
   createUnitInputSchema,
+  accountTypeFits,
   INDUSTRIES,
+  STOCK_ACCOUNT_USES,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
@@ -36,6 +38,22 @@ describe.each(INDUSTRIES)('the %s chart', (industry) => {
     }
   });
 
+  it('chooses a ledger of the right type for every stock use (step 14)', () => {
+    const typeOf = new Map(
+      ACCOUNT_TYPES.flatMap((type) =>
+        flatten(chart[type])
+          .filter((node) => node.children === undefined && node.purpose === undefined)
+          .map((node) => [node.code, type] as const),
+      ),
+    );
+    const codes = INDUSTRY_TEMPLATES[industry].stockAccounts;
+    for (const use of STOCK_ACCOUNT_USES) {
+      const type = typeOf.get(codes[use]);
+      expect(type, `${use} → ${codes[use]}`).toBeDefined();
+      expect(accountTypeFits(use, type ?? ''), use).toBe(true);
+    }
+  });
+
   it('starts each type with a group, and puts every code under its type digit', () => {
     ACCOUNT_TYPES.forEach((type, index) => {
       expect(chart[type].children).toBeDefined();
```

The templates are data typed by hand; this test catches a code that is not in the chart, a group, a purpose
account, or an account of the wrong type — before a real workspace's setup job meets it.

`apps/api/src/setup/seed-stock-accounts.ts` (new):

```ts
import {
  ACCOUNT_TYPES,
  type AccountType,
  accountTypeFits,
  STOCK_ACCOUNT_USES,
  type StockAccountUse,
} from '@omnivo/contracts';
import { ledgerAccounts, stockAccounts } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { AccountTemplate, ChartTemplate, IndustryTemplate } from './templates.js';

interface Found {
  node: AccountTemplate;
  type: AccountType;
  // The group it sits under in the template
  parentCode: string;
}

// Where a code sits in a template chart: the account, its type and its group
function findInTemplate(chart: ChartTemplate, code: string): Found | undefined {
  const walk = (node: AccountTemplate, type: AccountType): Found | undefined => {
    for (const child of node.children ?? []) {
      if (child.code === code) return { node: child, type, parentCode: node.code };
      const found = walk(child, type);
      if (found) return found;
    }
    return undefined;
  };
  for (const type of ACCOUNT_TYPES) {
    const found = walk(chart[type], type);
    if (found) return found;
  }
  return undefined;
}

// Chooses the stock accounts (step 14) for the transaction's tenant, from its template, and returns
// how many uses it chose — 0 when they were all chosen already, null when the workspace has no
// chart yet (the chart's own job calls this again once it has one).
// A new workspace has every template account, so this only writes the choices. A workspace whose
// chart was made before step 14 lacks the new accounts (Goods in transit, Stock adjustments …):
// each one is added under its template group, or under the top-level group of its type if the
// owner moved or renamed that group. An account already at the template's code is used only if it
// is the template's own (the same name) and fits the use; otherwise that use stays empty for the
// owner to choose in Settings → Inventory — nothing the owner made is ever changed or taken over.
// Idempotent: a second run finds everything chosen and writes nothing. The callers lock the
// tenant row first (like seedChart), so two runs never race.
export async function seedStockAccounts(
  tx: Transaction,
  tenantId: string,
  template: IndustryTemplate,
): Promise<number | null> {
  const accounts = await tx
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      isGroup: ledgerAccounts.isGroup,
      purpose: ledgerAccounts.purpose,
      parentId: ledgerAccounts.parentId,
      archivedAt: ledgerAccounts.archivedAt,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tenantId));
  if (accounts.length === 0) return null;
  const byCode = new Map(accounts.map((account) => [account.code, account]));

  const chosen = await tx
    .select({ use: stockAccounts.use })
    .from(stockAccounts)
    .where(eq(stockAccounts.tenantId, tenantId));
  const done = new Set<StockAccountUse>(chosen.map((row) => row.use));

  const choices: { use: StockAccountUse; accountId: string }[] = [];
  for (const use of STOCK_ACCOUNT_USES) {
    if (done.has(use)) continue;
    const code = template.stockAccounts[use];
    const found = findInTemplate(template.chart, code);
    if (!found) throw new Error(`Template: stock account ${code} is not in the chart`);
    let account = byCode.get(code);
    // The code is taken by an account the owner made for something else ("5290 Tea and
    // entertainment"): never use it for stock. The use stays empty for the owner to choose.
    if (account && account.name.toLowerCase() !== found.node.name.toLowerCase()) continue;
    if (!account) {
      const group = byCode.get(found.parentCode);
      const parentId =
        group?.isGroup === true && group.type === found.type && group.archivedAt === null
          ? group.id
          : accounts.find((row) => row.parentId === null && row.type === found.type)?.id;
      if (parentId === undefined) throw new Error(`No ${found.type} group for account ${code}`);
      const [row] = await tx
        .insert(ledgerAccounts)
        .values({ tenantId, parentId, code, name: found.node.name, type: found.type })
        .returning({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          name: ledgerAccounts.name,
          type: ledgerAccounts.type,
          isGroup: ledgerAccounts.isGroup,
          purpose: ledgerAccounts.purpose,
          parentId: ledgerAccounts.parentId,
          archivedAt: ledgerAccounts.archivedAt,
        });
      if (!row) throw new Error('Stock account insert returned no row');
      account = row;
      accounts.push(row);
      byCode.set(code, row);
    }
    const usable =
      !account.isGroup &&
      account.archivedAt === null &&
      account.purpose !== 'inventory' &&
      accountTypeFits(use, account.type);
    if (usable) choices.push({ use, accountId: account.id });
  }
  if (choices.length === 0) return 0;
  await tx
    .insert(stockAccounts)
    .values(choices.map((choice) => ({ tenantId, ...choice })))
    .onConflictDoNothing();
  return choices.length;
}
```

- **`null` when there is no chart**: the chart's own job calls this again once it has made one. `0` when everything
  is chosen: a second run of the job, which must do nothing.
- **A missing template account is created under its template group**, or under the top-level group of its type if
  the owner archived, moved or removed that group. Nothing the owner made is ever changed (decision 17).
- **An account already at the template's code is used only if it has the template's name.** Step 9 left gaps of 10
  in the codes "for the company's own accounts"; an owner may well have made a 5290 of their own. Its name tells us.
- **The callers hold the tenant row's lock** (`FOR UPDATE`, like `seedChart()`), so two runs never race.

`apps/api/src/setup/stock-accounts.handler.ts` (new):

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
import { seedStockAccounts } from './seed-stock-accounts.js';
import { INDUSTRY_TEMPLATES } from './templates.js';

// Gives the stock accounts (step 14) to a workspace whose chart was made before step 14. Migration
// 0024 queues one 'workspace.stock_accounts_requested' per such workspace; a new workspace gets
// them from the setup job, a chart made by ChartHandler from that job. All three call
// seedStockAccounts(), so the result is the same.
@Injectable()
export class StockAccountsHandler implements EventHandler<'workspace.stock_accounts_requested'> {
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
      const chosen = await seedStockAccounts(tx, tenantId, INDUSTRY_TEMPLATES[industry]);
      // No chart (its own job will choose them), or chosen already (a second run of this job)
      if (chosen === null || chosen === 0) return;
      await audit(tx, {
        action: 'stock_accounts.created',
        entityType: 'workspace',
        entityId: tenantId,
        changes: created({ industry, uses: chosen }),
      });
    });
  }
}
```

`apps/api/src/setup/chart.handler.ts` (changed):

```diff
@@ -9,6 +9,7 @@ import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { seedChart } from './seed-chart.js';
+import { seedStockAccounts } from './seed-stock-accounts.js';
 import { INDUSTRY_TEMPLATES } from './templates.js';
 
 // Gives a chart of accounts to a workspace that was set up before step 9. Migration 0014 queues
@@ -36,6 +37,8 @@ export class ChartHandler implements EventHandler<'workspace.chart_requested'> {
       const accounts = await seedChart(tx, tenantId, INDUSTRY_TEMPLATES[industry].chart);
       // Already had a chart: a second run of this job, or the setup job was first
       if (accounts === 0) return;
+      // Step 14: a chart made here gets its stock accounts at once, like a new workspace's
+      await seedStockAccounts(tx, tenantId, INDUSTRY_TEMPLATES[industry]);
       // No actorUserId: the audit log shows "System"
       await audit(tx, {
         action: 'workspace.chart_created',
```

`apps/api/src/setup/provisioning.handler.ts` (changed):

```diff
@@ -11,6 +11,7 @@ import { WITH_TENANT } from '../infra/tokens.js';
 import { notify } from '../notifications/notify.js';
 import { seedCatalog } from './seed-catalog.js';
 import { seedChart } from './seed-chart.js';
+import { seedStockAccounts } from './seed-stock-accounts.js';
 import { INDUSTRY_TEMPLATES, type RoleTemplate } from './templates.js';
 
 type Event = OutboxEvent<'workspace.setup_requested'>;
@@ -89,6 +90,9 @@ export class ProvisioningHandler implements EventHandler<'workspace.setup_reques
       // 0 when the workspace already has a chart: step 9's migration queued one for a workspace
       // whose setup had failed, and it ran before this retry
       const accounts = await seedChart(tx, tenantId, template.chart);
+      // Step 14: which accounts stock documents post to. Nothing to do when the workspace already
+      // had them (the stock accounts job ran first for a failed setup that is retried now).
+      await seedStockAccounts(tx, tenantId, template);
       // null when step 12's migration already gave this workspace its catalog (a failed setup
       // retried after the catalog job ran)
       const catalog = await seedCatalog(tx, tenantId, template.catalog);
```

Three paths, one function: a new workspace (the setup job), a workspace whose chart is made late (step 9's chart
job), and a workspace that had its chart before step 14 (the new job, queued by migration 0024).

### The worker's wiring

`apps/api/src/common/outbox/outbox.ts` (changed):

```diff
@@ -30,6 +30,8 @@ export const outboxPayloadSchemas = {
     warehouseId: z.uuid(),
     variantIds: z.array(z.uuid()).min(1).max(500),
   }),
+  // Like the chart's: the workspace and its business type say everything (step 14)
+  'workspace.stock_accounts_requested': z.object({}),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

`apps/api/src/worker/queues.ts` (changed):

```diff
@@ -22,6 +22,7 @@ const QUEUE_OF = {
   'workspace.catalog_requested': 'jobs',
   'product.import_requested': 'jobs',
   'stock.below_reorder': 'jobs',
+  'workspace.stock_accounts_requested': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

`apps/api/src/worker/handlers.ts` (changed):

```diff
@@ -10,6 +10,7 @@ import { ReportExportHandler } from '../reports/export.handler.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
+import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 
 // Which handler runs for which event — the one place to look. The mapped type ties each key to a
@@ -32,6 +33,7 @@ export class EventHandlers {
     catalog: CatalogHandler,
     productImport: ProductImportHandler,
     lowStock: LowStockHandler,
+    stockAccounts: StockAccountsHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -43,6 +45,7 @@ export class EventHandlers {
       'workspace.catalog_requested': catalog,
       'product.import_requested': productImport,
       'stock.below_reorder': lowStock,
+      'workspace.stock_accounts_requested': stockAccounts,
     };
   }
 
```

`apps/api/src/worker/worker.module.ts` (changed):

```diff
@@ -14,6 +14,7 @@ import { ReportExportHandler } from '../reports/export.handler.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
+import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
 import { EventHandlers } from './handlers.js';
@@ -60,6 +61,7 @@ export class WorkerModule implements OnApplicationShutdown {
         NumberingService,
         ProductImportHandler,
         LowStockHandler,
+        StockAccountsHandler,
       ],
     };
   }
```

Each of the four is checked by the type system: an event type without a payload schema, a queue or a handler
does not compile.

---
## 14.5 — The API's tests

### `inventory/valuation.int.spec.ts` (new)

`apps/api/src/inventory/valuation.int.spec.ts` (new):

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  branchSchema,
  journalEntrySchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  setupSchema,
  stockAccountsSchema,
  stockAdjustmentSchema,
  type StockAdjustmentFormValues,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  stockRevaluationSchema,
  stockTransferSchema,
  stockValuePageSchema,
  type Unit,
  unitListSchema,
  valuationSummarySchema,
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

// Step 14: what the stock is worth, and the books that follow it. One distributor again: juice in
// cartons of 24 at a typed cost, a depot in the same branch, a Chattogram store in another branch,
// rice that came in at zero cost and is revalued, and two people taking the last tea at once.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role: reads stock, sees no cost
let viewer: SignedIn;
let units: Unit[];
let accounts: Account[];
let main: Warehouse;
let depot: Warehouse;
let ctg: Warehouse;
let juice: Product;

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

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
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

async function product(name: string, extra: Partial<ProductFormValues> = {}): Promise<Product> {
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

function line(variantId: string, quantity: string, unitCost = '', extra: object = {}) {
  return {
    variantId,
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
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

async function posted(body: object) {
  const res = await send('POST', '/stock-adjustments', body);
  expect(res.statusCode, res.body).toBe(201);
  return stockAdjustmentSchema.parse(res.json());
}

function transfer(from: Warehouse, to: Warehouse, variantId: string, quantity: string) {
  return {
    fromWarehouseId: from.id,
    toWarehouseId: to.id,
    date: '2026-10-02',
    note: '',
    lines: [{ variantId, unitId: unitId('pcs'), quantity, batchId: '', serialNumbers: [] }],
    send: true,
  };
}

async function sent(body: object) {
  const res = await send('POST', '/stock-transfers', body);
  expect(res.statusCode, res.body).toBe(201);
  return stockTransferSchema.parse(res.json());
}

async function received(id: string, quantity: string) {
  const before = stockTransferSchema.parse((await send('GET', `/stock-transfers/${id}`)).json());
  const res = await send('POST', `/stock-transfers/${id}/receive`, {
    version: before.version,
    date: '2026-10-03',
    lines: before.lines.map((item) => ({
      lineId: item.id,
      receivedQuantity: quantity,
      serialNumbers: [],
    })),
  });
  expect(res.statusCode, res.body).toBe(200);
  return stockTransferSchema.parse(res.json());
}

// A journal entry as [account code, branch, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [
    codeOf(item.accountId),
    item.branchId,
    item.debit,
    item.credit,
  ]);
}

async function cardOf(variantId: string) {
  return stockCardSchema.parse((await send('GET', `/stock/variants/${variantId}`)).json());
}

async function summary() {
  const res = await send('GET', '/stock/valuation/summary');
  expect(res.statusCode, res.body).toBe(200);
  return valuationSummarySchema.parse(res.json());
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
    companyName: 'Padma Traders',
    workspaceSlug: 'padma-traders',
    fullName: 'Nasrin Sultana',
    email: 'nasrin@padmatraders.com',
    password: 'Ledger-stock-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const { items } = warehouseListSchema.parse((await send('GET', '/warehouses')).json());
  const first = items[0];
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;
  depot = warehouseSchema.parse(
    (
      await send('POST', '/warehouses', {
        branchId: main.branchId,
        code: 'DEPOT',
        name: 'Tejgaon depot',
        address: '',
      })
    ).json(),
  );
  const branch = branchSchema.parse(
    (
      await send('POST', '/branches', {
        code: 'CTG',
        name: 'Chattogram',
        phone: '',
        address: '',
      })
    ).json(),
  );
  ctg = warehouseSchema.parse(
    (
      await send('POST', '/warehouses', {
        branchId: branch.id,
        code: 'CTG',
        name: 'Chattogram store',
        address: '',
      })
    ).json(),
  );
  juice = await product('Pran Mango Juice 250 ml', {
    units: [{ unitId: unitId('case'), factor: '24', barcode: '' }],
  });

  await signUp(app, {
    companyName: 'Rina Store',
    workspaceSlug: 'rina-store',
    fullName: 'Rina Akter',
    email: 'rina@padmatraders.com',
    password: 'Counter-cash-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rina@padmatraders.com',
    workspace: 'padma-traders',
  });
  viewer = await logIn(app, {
    workspace: 'padma-traders',
    email: 'rina@padmatraders.com',
    password: 'Counter-cash-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the value of stock', () => {
  it('values opening stock at its typed cost, and posts it against opening balance equity', async () => {
    // 3 cartons at ৳1,200 a carton: 72 pieces worth ৳3,600, ৳50 a piece
    const opening = await posted(
      adjustment('in', [line(variantOf(juice), '3', '1200', { unitId: unitId('case') })]),
    );
    expect(opening.lines[0]).toMatchObject({
      baseQuantity: '72.0000',
      unitCost: '1200.0000',
      value: '3600.0000',
    });
    if (!opening.entry) throw new Error('expected a journal entry');
    expect(await entryLines(opening.entry.id)).toEqual([
      ['1150', main.branchId, '3600.0000', '0.0000'],
      ['3300', main.branchId, '0.0000', '3600.0000'],
    ]);
    expect((await cardOf(variantOf(juice))).item).toMatchObject({
      onHand: '72.0000',
      unitCost: '50.0000',
      value: '3600.0000',
    });
  });

  it('moves the average with each inflow, and takes outflows at it', async () => {
    // 48 more at ৳56.25: 120 pieces worth ৳6,300, ৳52.50 a piece
    await posted(adjustment('in', [line(variantOf(juice), '48', '56.25')], { reason: 'found' }));
    // 20 damaged go at the average: ৳1,050 to the loss account
    const damaged = await posted(adjustment('out', [line(variantOf(juice), '20')]));
    expect(damaged.lines[0]).toMatchObject({ unitCost: null, value: '1050.0000' });
    if (!damaged.entry) throw new Error('expected a journal entry');
    expect(await entryLines(damaged.entry.id)).toEqual([
      ['1150', main.branchId, '0.0000', '1050.0000'],
      ['5330', main.branchId, '1050.0000', '0.0000'],
    ]);
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(juice)}/movements`)).json(),
    );
    expect(history.items.map((item) => [item.quantity, item.value])).toEqual([
      ['72.0000', '3600.0000'],
      ['48.0000', '2700.0000'],
      ['-20.0000', '-1050.0000'],
    ]);
    expect((await cardOf(variantOf(juice))).item).toMatchObject({
      onHand: '100.0000',
      unitCost: '52.5000',
      value: '5250.0000',
    });
  });

  it('prices an in-line without a cost at the average, and refuses the first stock of an item without one', async () => {
    const more = await posted(
      adjustment('in', [line(variantOf(juice), '10')], { reason: 'correction' }),
    );
    expect(more.lines[0]).toMatchObject({ unitCost: null, value: '525.0000' });

    const biscuit = await product('Olympic Energy Plus');
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('in', [line(variantOf(biscuit), '5')]),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.0.unitCost': ['stock_cost_required'] });
  });

  it('empties the value with the stock: the last piece takes what is left', async () => {
    // 3 pieces at ৳33.3333 = ৳100 (99.9999, to the paisa). Out one by one: 33.33, 33.34, 33.33.
    const soap = await product('Lux Soap 100 g');
    await posted(adjustment('in', [line(variantOf(soap), '3', '33.3333')]));
    const values: (string | null | undefined)[] = [];
    for (let piece = 0; piece < 3; piece++) {
      const out = await posted(adjustment('out', [line(variantOf(soap), '1')]));
      values.push(out.lines[0]?.value);
    }
    expect(values).toEqual(['33.3300', '33.3400', '33.3300']);
    expect((await cardOf(variantOf(soap))).item).toMatchObject({
      onHand: '0.0000',
      value: '0.0000',
      // The last average stays: an outflow below zero (if allowed) is priced at it
      unitCost: '33.3300',
    });
  });
});

describe('transfers', () => {
  it('posts nothing inside a branch, and only the shortage when it arrives short', async () => {
    // 110 pieces worth ৳5,775; 24 of them are worth ৳1,260
    const transferred = await sent(transfer(main, depot, variantOf(juice), '24'));
    expect(transferred.entries).toEqual([]);
    expect(transferred.lines[0]?.value).toBe('1260.0000');
    expect(await summary()).toMatchObject({ inTransitValue: '1260.0000', difference: '0.0000' });

    // 20 arrive: ৳1,050 into the depot, ৳210 lost on the way
    const arrived = await received(transferred.id, '20');
    expect(arrived.lines[0]).toMatchObject({ value: '1260.0000', receivedValue: '1050.0000' });
    const [entry] = arrived.entries;
    if (!entry) throw new Error('expected a journal entry for the shortage');
    expect(await entryLines(entry.id)).toEqual([
      ['5330', main.branchId, '210.0000', '0.0000'],
      ['1150', main.branchId, '0.0000', '210.0000'],
    ]);
    expect(await summary()).toMatchObject({ inTransitValue: '0.0000', difference: '0.0000' });
  });

  it('sends between branches through goods in transit', async () => {
    // 106 pieces worth ৳5,565; 10 of them ৳525
    const transferred = await sent(transfer(main, ctg, variantOf(juice), '10'));
    const [sentEntry] = transferred.entries;
    if (!sentEntry) throw new Error('expected a journal entry for the sending');
    expect(await entryLines(sentEntry.id)).toEqual([
      ['1175', null, '525.0000', '0.0000'],
      ['1150', main.branchId, '0.0000', '525.0000'],
    ]);
    expect(await summary()).toMatchObject({ inTransitValue: '525.0000', difference: '0.0000' });

    // 8 arrive in Chattogram: ৳420 into its stock, ৳105 lost (Dhaka's loss: it left there)
    const arrived = await received(transferred.id, '8');
    expect(arrived.entries).toHaveLength(2);
    const receivedEntry = arrived.entries[1];
    if (!receivedEntry) throw new Error('expected a journal entry for the receipt');
    expect(await entryLines(receivedEntry.id)).toEqual([
      ['1150', ctg.branchId, '420.0000', '0.0000'],
      ['5330', main.branchId, '105.0000', '0.0000'],
      ['1175', null, '0.0000', '525.0000'],
    ]);
    expect(await summary()).toMatchObject({ inTransitValue: '0.0000', difference: '0.0000' });
  });
});

describe('revaluation', () => {
  it('gives stock that came in at zero cost its value, and posts the difference', async () => {
    const rice = await product('Chinigura Rice 1 kg');
    const free = await posted(adjustment('in', [line(variantOf(rice), '50', '0')]));
    // Nothing to post: the stock is worth nothing yet
    expect(free.entry).toBeNull();

    const res = await send('POST', '/stock-revaluations', {
      date: '2026-10-04',
      note: 'At the supplier invoice price',
      lines: [{ variantId: variantOf(rice), unitCost: '80' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const revaluation = stockRevaluationSchema.parse(res.json());
    expect(revaluation.number).toMatch(/^REV-/);
    expect(revaluation.difference).toBe('4000.0000');
    expect(revaluation.lines[0]).toMatchObject({
      quantity: '50.0000',
      oldUnitCost: '0.0000',
      oldValue: '0.0000',
      unitCost: '80.0000',
      newValue: '4000.0000',
      difference: '4000.0000',
    });
    if (!revaluation.entry) throw new Error('expected a journal entry');
    expect(await entryLines(revaluation.entry.id)).toEqual([
      ['1150', main.branchId, '4000.0000', '0.0000'],
      ['5190', main.branchId, '0.0000', '4000.0000'],
    ]);
    // On the stock card: a movement of no quantity and ৳4,000
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(rice)}/movements`)).json(),
    );
    expect(history.items.at(-1)).toMatchObject({
      kind: 'revaluation',
      quantity: '0.0000',
      value: '4000.0000',
      balance: '50.0000',
    });
    expect((await cardOf(variantOf(rice))).item).toMatchObject({
      unitCost: '80.0000',
      value: '4000.0000',
    });
  });

  it('refuses an item with no stock, and never changes once posted', async () => {
    const empty = await product('Fresh Atta 2 kg');
    const res = await send('POST', '/stock-revaluations', {
      date: '2026-10-04',
      note: '',
      lines: [{ variantId: variantOf(empty), unitCost: '120' }],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.0.variantId': ['revaluation_no_stock'] });

    await expect(
      superuserSql((sql) => sql`UPDATE stock_revaluations SET note = 'changed'`),
    ).rejects.toThrow(/cannot be changed or deleted/);
  });
});

describe('the books stay with the stock', () => {
  it('refuses a manual entry or an opening balance on the inventory or transit account', async () => {
    for (const code of ['1150', '1175']) {
      const res = await send('POST', '/journal-entries', {
        date: '2026-10-05',
        narration: '',
        lines: [
          { accountId: accountId(code), branchId: '', description: '', debit: '100', credit: '' },
          { accountId: accountId('1110'), branchId: '', description: '', debit: '', credit: '100' },
        ],
        post: false,
      });
      expect(res.statusCode, code).toBe(409);
      expect(problemOf(res).fieldErrors).toEqual({
        'lines.0.accountId': ['journal_account_stock'],
      });
    }
    const opening = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [{ accountId: accountId('1150'), debit: '5000', credit: '' }],
    });
    expect(opening.statusCode).toBe(409);
    expect(problemOf(opening).fieldErrors).toEqual({
      'lines.0.accountId': ['journal_account_stock'],
    });
  });

  it('refuses to reverse a stock entry from the journal', async () => {
    const out = await posted(adjustment('out', [line(variantOf(juice), '1')], { reason: 'lost' }));
    if (!out.entry) throw new Error('expected a journal entry');
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${out.entry.id}`)).json(),
    );
    expect(entry).toMatchObject({
      source: 'stock_adjustment',
      document: { id: out.id, number: out.number },
    });
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-05',
    });
    expect(problemOf(res).code).toBe('journal_is_stock');
  });

  it('keeps every value equal to the sum of its movements, and the books equal to the stock', async () => {
    const drift = await superuserSql(
      (sql) => sql`
        SELECT v.variant_id FROM stock_values v
          LEFT JOIN LATERAL (
            SELECT coalesce(sum(m.quantity), 0) AS quantity, coalesce(sum(m.value), 0) AS value
              FROM stock_movements m
             WHERE m.tenant_id = v.tenant_id AND m.variant_id = v.variant_id
          ) m ON true
         WHERE v.quantity <> m.quantity OR v.value <> m.value`,
    );
    expect(drift).toEqual([]);
    expect((await summary()).difference).toBe('0.0000');
  });
});

describe('who sees what stock costs', () => {
  it('shows quantities to everyone, and costs only with inventory.stock.value', async () => {
    const page = stockPageSchema.parse((await send('GET', '/stock', undefined, viewer)).json());
    const item = page.items.find((row) => row.variantId === variantOf(juice));
    expect(item).toMatchObject({ unitCost: null, value: null });
    expect(item?.onHand).not.toBe('0.0000');

    const { items } = stockValuePageSchema.parse((await send('GET', '/stock/valuation')).json());
    expect(items.map((row) => row.productName)).toContain('Pran Mango Juice 250 ml');
    expect((await send('GET', '/stock/valuation', undefined, viewer)).statusCode).toBe(403);
    expect((await send('GET', '/stock-revaluations', undefined, viewer)).statusCode).toBe(403);
  });

  it('keeps a typed cost on the document, and hides what the books worked out', async () => {
    const found = await posted(
      adjustment('in', [line(variantOf(juice), '2', '60')], { reason: 'found' }),
    );
    const asViewer = stockAdjustmentSchema.parse(
      (await send('GET', `/stock-adjustments/${found.id}`, undefined, viewer)).json(),
    );
    expect(asViewer.lines[0]).toMatchObject({ unitCost: '60.0000', value: null });
  });
});

describe('stock accounts', () => {
  it('starts with the template choices, and refuses an account that does not fit', async () => {
    const choices = stockAccountsSchema.parse((await send('GET', '/stock-accounts')).json());
    expect(codeOf(choices.in_transit ?? '')).toBe('1175');
    expect(codeOf(choices.sample ?? '')).toBe('5310');

    const body = {
      ...Object.fromEntries(Object.entries(choices).map(([use, id]) => [use, id ?? ''])),
      // Cash is an asset, not a loss
      damaged: accountId('1110'),
      // The inventory account itself
      in_transit: accountId('1150'),
    };
    const res = await send('PUT', '/stock-accounts', body);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      in_transit: ['stock_account_inventory'],
      damaged: ['stock_account_invalid'],
    });

    const changed = await send('PUT', '/stock-accounts', {
      ...body,
      damaged: choices.damaged,
      in_transit: choices.in_transit,
      sample: accountId('5320'),
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(codeOf(stockAccountsSchema.parse(changed.json()).sample ?? '')).toBe('5320');
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'stock_accounts.changed',
      changes: { sample: { from: '5310', to: '5320' } },
    });
  });

  it('keeps a chosen account from being archived or deleted', async () => {
    const chosen = accounts.find((account) => account.code === '5190');
    if (!chosen) throw new Error('no 5190');
    const archive = await send('POST', `/accounts/${chosen.id}/archive`, {
      version: chosen.version,
    });
    expect(problemOf(archive).code).toBe('account_used_by_stock');
    const remove = await send('DELETE', `/accounts/${accountId('5290')}?version=1`);
    expect(problemOf(remove).code).toBe('account_used_by_stock');
  });

  it('refuses a posting whose account is not chosen, and posts nothing', async () => {
    await superuserSql(
      (sql) => sql`DELETE FROM stock_accounts WHERE use = 'sample'
                    AND tenant_id = (SELECT id FROM tenants WHERE slug = 'padma-traders')`,
    );
    const before = (await cardOf(variantOf(juice))).item.onHand;
    const res = await send(
      'POST',
      '/stock-adjustments',
      adjustment('out', [line(variantOf(juice), '2')], { reason: 'sample' }),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res)).toMatchObject({
      code: 'stock_account_missing',
      params: { use: 'sample' },
    });
    expect((await cardOf(variantOf(juice))).item.onHand).toBe(before);
  });

  it('gives a workspace from before step 14 its stock accounts', async () => {
    const shopOwner = await signUp(app, {
      companyName: 'Corner Shop',
      workspaceSlug: 'corner-shop',
      fullName: 'Kamal Uddin',
      email: 'kamal@cornershop.com',
      password: 'Corner-shop-2026',
    });
    const asShop = (method: 'GET' | 'POST', url: string, payload?: object) =>
      send(method, url, payload, shopOwner);
    expect((await asShop('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
    await eventually(async () => {
      expect(setupSchema.parse((await asShop('GET', '/setup')).json()).status).toBe('ready');
    });
    // As migration 0024 finds it: a chart without the new accounts, and nothing chosen
    await superuserSql(async (sql) => {
      const [tenant] = await sql<
        { id: string }[]
      >`SELECT id FROM tenants WHERE slug = 'corner-shop'`;
      if (!tenant) throw new Error('no corner-shop');
      await sql`DELETE FROM stock_accounts WHERE tenant_id = ${tenant.id}`;
      await sql`DELETE FROM ledger_accounts
                 WHERE tenant_id = ${tenant.id} AND code IN ('1175', '5150', '5190', '5290')`;
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                VALUES (gen_random_uuid(), ${tenant.id}, 'workspace.stock_accounts_requested', '{}'::jsonb)`;
    });
    await eventually(async () => {
      const choices = stockAccountsSchema.parse((await asShop('GET', '/stock-accounts')).json());
      expect(Object.values(choices).every((id) => id !== null)).toBe(true);
    }, 10_000);
    const chart = accountListSchema.parse((await asShop('GET', '/accounts')).json()).items;
    expect(chart.find((account) => account.code === '1175')).toMatchObject({
      name: 'Goods in transit',
      type: 'asset',
    });
    // Retail's own loss account is used, not a new one
    const choices = stockAccountsSchema.parse((await asShop('GET', '/stock-accounts')).json());
    expect(chart.find((account) => account.id === choices.damaged)?.code).toBe('5340');
  });
});

describe('two people at once', () => {
  it('prices two outflows of the same item one after the other', async () => {
    // Tea in two warehouses: 20 in Main store at 25.0008 (৳500.02) and 20 in the depot at
    // 25.0007 (৳500.01) — ৳1,000.03 in all. Main sends its 20 to Chattogram while the depot writes
    // its 20 off, at the same moment. Priced one after the other: the first takes its share
    // (৳500.02), the second what is left (৳500.01), and the value ends at exactly zero. Priced
    // from the same old average, both would take ৳500.02 and leave −৳0.01 with no stock.
    // A transfer and an adjustment on purpose: they take different number series, so only the
    // value row makes them wait for each other. A third connection holds that row until both wait.
    const tea = await product('Ispahani Mirzapore Tea 400 g');
    await posted(adjustment('in', [line(variantOf(tea), '20', '25.0008')]));
    await posted(
      adjustment('in', [line(variantOf(tea), '20', '25.0007')], { warehouseId: depot.id }),
    );

    const sendOut = () =>
      send('POST', '/stock-transfers', transfer(main, ctg, variantOf(tea), '20'));
    const writeOff = () =>
      send(
        'POST',
        '/stock-adjustments',
        adjustment('out', [line(variantOf(tea), '20')], { warehouseId: depot.id, reason: 'lost' }),
      );
    const blocker = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    const probe = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    let answers: Awaited<ReturnType<typeof sendOut>>[] = [];
    try {
      let both: Promise<typeof answers> | undefined;
      await blocker.begin(async (sql) => {
        await sql`SELECT 1 FROM stock_values WHERE variant_id = ${variantOf(tea)} FOR UPDATE`;
        both = Promise.all([sendOut(), writeOff()]);
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
    expect(answers.map((res) => res.statusCode)).toEqual([201, 201]);
    const [transferred, lost] = answers;
    const values = [
      stockTransferSchema.parse(transferred?.json()).lines[0]?.value,
      stockAdjustmentSchema.parse(lost?.json()).lines[0]?.value,
    ].sort();
    expect(values).toEqual(['500.0100', '500.0200']);
    expect((await cardOf(variantOf(tea))).item).toMatchObject({
      onHand: '0.0000',
      value: '0.0000',
    });
  });
});
```

What each test proves, and the numbers in it:

- **Opening stock at its typed cost**: 3 cartons at ৳1,200 = 72 pieces worth ৳3,600, ৳50 a piece; the entry is
  Dr 1150 / Cr 3300, both with the Main store's branch.
- **The moving average**: 48 more at ৳56.25 makes 120 worth ৳6,300 (৳52.50 each); 20 damaged leave at exactly
  ৳1,050 to 5330 (the distribution template's "Damaged and expired goods"). The history shows each movement's
  signed value.
- **An "in" line without a cost** is priced at the average (10 × ৳52.50 = ৳525); the first stock of an item
  without one is refused under its cost box.
- **The last piece takes what is left**: 3 soaps at ৳33.3333 are worth ৳100.00; out one by one they take
  33.33, 33.34 and 33.33, and the value ends at ৳0.00 — with the last average still there for an outflow below
  zero.
- **Transfers**: inside one branch nothing is posted until it arrives short (24 sent, 20 arrived: ৳210 to the
  loss account); between branches the sending moves ৳525 to 1175 with no branch, and the receipt of 8 of 10 posts
  ৳420 into Chattogram's inventory and ৳105 of loss to Dhaka. After each step the summary's difference is ৳0.
- **Revaluation**: rice that came in at ৳0 (no entry for it) is revalued to ৳80: ৳4,000 to the books (Dr 1150 /
  Cr 5190), a movement of quantity 0 on the stock card. An item without stock is refused; a revaluation cannot be
  changed, even by the superuser.
- **The books stay with the stock**: a manual entry on 1150 or 1175 is refused, even as a draft; so is an
  opening balance on 1150; a stock entry cannot be reversed, and says which document it belongs to. Then, read
  straight from the database: no `stock_values` row differs from the sum of its movements.
- **Who sees costs**: a member without a role reads quantities, gets `null` costs, keeps seeing a typed cost on a
  document, and is refused the valuation report and the revaluations (403).
- **Stock accounts**: the template's choices; cash as a loss account and the inventory account as goods in transit
  are refused, each under its use; a valid change is saved and audited as codes; a chosen account cannot be
  archived or deleted; a posting whose account is missing is refused and moves nothing.
- **A workspace from before step 14** (made by deleting what the migration would not have found, and queuing the
  same event the migration queues): the job adds 1175 and the others, and chooses retail's own loss account, 5340.
- **Two people at once** (decision 12): tea worth ৳1,000.03 in two warehouses, 20 pieces each. The transfer and the
  write-off use different number series, so only the value row can make them wait for each other; a third
  connection holds it until both do. Priced one after the other: ৳500.02 and ৳500.01, and the value ends at ৳0.
  Remove `FOR UPDATE` from `lockValues()` and both take ৳500.02, leaving −৳0.01 with no stock — the test fails.

### `inventory/stock.tenant-leak.int.spec.ts`

`apps/api/src/inventory/stock.tenant-leak.int.spec.ts` (changed):

```diff
@@ -1,6 +1,7 @@
 import type { INestApplicationContext } from '@nestjs/common';
 import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
+  accountListSchema,
   problemSchema,
   type Product,
   productSchema,
@@ -8,9 +9,13 @@ import {
   type StockAdjustment,
   stockAdjustmentSchema,
   stockCardSchema,
+  stockAccountsSchema,
   stockPageSchema,
+  type StockRevaluation,
+  stockRevaluationSchema,
   type StockTransfer,
   stockTransferSchema,
+  stockValuePageSchema,
   type Unit,
   unitListSchema,
   type Warehouse,
@@ -51,6 +56,7 @@ let productOfA: Product;
 let productOfB: Product;
 let adjustmentOfB: StockAdjustment;
 let transferOfB: StockTransfer;
+let revaluationOfB: StockRevaluation;
 
 function as(
   who: SignedIn,
@@ -129,6 +135,7 @@ function stockIn(warehouseId: string, variantId: string, unitId: string) {
         expiresOn: '',
         manufacturedOn: '',
         serialNumbers: [],
+        unitCost: '95',
       },
     ],
     post: true,
@@ -198,6 +205,14 @@ beforeAll(async () => {
   });
   expect(transfer.statusCode, transfer.body).toBe(201);
   transferOfB = stockTransferSchema.parse(transfer.json());
+
+  const revaluation = await as(tenantB, 'POST', '/stock-revaluations', {
+    date: '2026-10-02',
+    note: '',
+    lines: [{ variantId: variantOf(productOfB), unitCost: '99' }],
+  });
+  expect(revaluation.statusCode, revaluation.body).toBe(201);
+  revaluationOfB = stockRevaluationSchema.parse(revaluation.json());
 }, 120_000);
 
 afterAll(async () => {
@@ -309,3 +324,43 @@ describe('stock across workspaces', () => {
     expect(card.item.onHand).toBe('10.0000');
   });
 });
+
+// Step 14: values, revaluations and the stock accounts are as private as the stock itself
+describe('stock values across workspaces', () => {
+  it("does not value or revalue B's stock", async () => {
+    const page = stockValuePageSchema.parse(
+      (await as(tenantA, 'GET', '/stock/valuation?search=rupchanda')).json(),
+    );
+    expect(page.items).toEqual([]);
+    expect((await as(tenantA, 'GET', `/stock-revaluations/${revaluationOfB.id}`)).statusCode).toBe(
+      404,
+    );
+    const res = await as(tenantA, 'POST', '/stock-revaluations', {
+      date: '2026-10-02',
+      note: '',
+      lines: [{ variantId: variantOf(productOfB), unitCost: '1' }],
+    });
+    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
+      'lines.0.variantId': ['stock_variant_invalid'],
+    });
+  });
+
+  it("cannot point a stock account at one of B's accounts", async () => {
+    const choices = stockAccountsSchema.parse((await as(tenantA, 'GET', '/stock-accounts')).json());
+    const accountsOfB = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json());
+    const lossOfB = accountsOfB.items.find((account) => account.code === '5340');
+    if (!lossOfB) throw new Error('B has no 5340');
+    const res = await as(tenantA, 'PUT', '/stock-accounts', {
+      ...Object.fromEntries(Object.entries(choices).map(([use, id]) => [use, id ?? ''])),
+      damaged: lossOfB.id,
+    });
+    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
+      damaged: ['stock_account_invalid'],
+    });
+    // B's value is untouched: its revaluation still stands
+    const card = stockCardSchema.parse(
+      (await as(tenantB, 'GET', `/stock/variants/${variantOf(productOfB)}`)).json(),
+    );
+    expect(card.item).toMatchObject({ unitCost: '99.0000', value: '990.0000' });
+  });
+});
```

Workspace A can neither value nor revalue B's stock, nor read B's revaluation, nor point a stock use at one of
B's accounts — and B's value is unchanged after all of it. Every answer is the one a missing id gets, so nothing
says that B's id exists.

### Existing tests that change

`apps/api/src/inventory/stock.int.spec.ts` (changed):

```diff
@@ -122,7 +122,8 @@ async function product(name: string, extra: Partial<ProductFormValues>): Promise
   return productSchema.parse(res.json());
 }
 
-// What the adjustment form sends for one line; each test changes a few fields
+// What the adjustment form sends for one line; each test changes a few fields. Every item costs
+// ৳10 a unit here (step 14: stock that comes in needs a cost); an "out" line ignores it.
 function line(variantId: string, quantity: string, extra: object = {}) {
   return {
     variantId,
@@ -133,6 +134,7 @@ function line(variantId: string, quantity: string, extra: object = {}) {
     expiresOn: '',
     manufacturedOn: '',
     serialNumbers: [],
+    unitCost: '10',
     ...extra,
   };
 }
```

Step 13's lines now come in at ৳10 a piece: an "in" line of an item with no cost is refused since step 14. The
"out" lines ignore it (decision 11), so the rest of the file is unchanged.

`apps/api/src/journal/journal.int.spec.ts` (changed):

```diff
@@ -414,7 +414,7 @@ describe('the ledger', () => {
       (
         await send('POST', '/accounts', {
           parentId: id('5200'),
-          code: '5290',
+          code: '5295',
           name: 'Tea and entertainment',
           isGroup: false,
           description: '',
@@ -422,19 +422,19 @@ describe('the ledger', () => {
       ).json(),
     );
     accounts.push(tea);
-    await posted('2026-08-20', [debit('5290', '1500'), credit('1110', '1500')], 'Tea, August');
+    await posted('2026-08-20', [debit('5295', '1500'), credit('1110', '1500')], 'Tea, August');
     await posted(
       '2026-09-10',
-      [debit('5290', '2200.50'), credit('1110', '2200.50')],
+      [debit('5295', '2200.50'), credit('1110', '2200.50')],
       'Tea, September',
     );
     await posted(
       '2026-09-12',
-      [debit('1110', '300'), credit('5290', '300')],
+      [debit('1110', '300'), credit('5295', '300')],
       'Refund from the canteen',
     );
     // Drafts are not in the books
-    await write('2026-09-11', [debit('5290', '999'), credit('1110', '999')], { post: false });
+    await write('2026-09-11', [debit('5295', '999'), credit('1110', '999')], { post: false });
 
     const first = ledgerPageSchema.parse(
       (await send('GET', `/accounts/${tea.id}/ledger?from=2026-09-01&limit=1`)).json(),
```

The test made its own account 5290 ("Tea and entertainment"); the template has a 5290 now (Consumables and internal
use), so the test's account moves to 5295.

`apps/api/src/numbering/numbering.int.spec.ts` (changed):

```diff
@@ -101,7 +101,12 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(9);
+    expect(items.map((series) => series.documentType)).toHaveLength(10);
+    // Stock revaluations (step 14)
+    expect(items.find((series) => series.documentType === 'inventory.revaluation')).toMatchObject({
+      prefix: 'REV',
+      nextNumber: `REV-${today}-0001`,
+    });
     // Stock documents (step 13): numbered by fiscal year, like the journal
     expect(items.find((series) => series.documentType === 'inventory.transfer')).toMatchObject({
       prefix: 'TRF',
```

`apps/api/src/setup/setup.int.spec.ts` (changed):

```diff
@@ -8,6 +8,7 @@ import {
   problemSchema,
   roleListSchema,
   setupSchema,
+  stockAccountsSchema,
   unitListSchema,
 } from '@omnivo/contracts';
 import postgres from 'postgres';
@@ -137,6 +138,8 @@ describe('starting the setup', () => {
           'accounting.report.read',
           'core.audit.read',
           'core.user.read',
+          'inventory.stock.revalue',
+          'inventory.stock.value',
         ],
       ],
       ['Merchandiser', ['core.user.read', 'inventory.product.manage']],
@@ -150,6 +153,14 @@ describe('starting the setup', () => {
       name: 'Export sales',
       purpose: 'sales',
     });
+    // Step 14: every stock use has its template account, chosen in the same job
+    const choices = stockAccountsSchema.parse((await send('GET', '/stock-accounts')).json());
+    const codeOf = (id: string | null) =>
+      chart.items.find((account) => account.id === id)?.code ?? null;
+    expect(codeOf(choices.in_transit)).toBe('1175');
+    expect(codeOf(choices.damaged)).toBe('5150');
+    expect(codeOf(choices.revaluation)).toBe('5190');
+    expect(codeOf(choices.internal_use)).toBe('5290');
   });
 
   it('writes the audit log as the system, with the request that started it', async () => {
```

---

## 14.6 — `packages/i18n` and `packages/ui`

### `locales/en.ts` and `locales/bn.ts`

`packages/i18n/src/locales/en.ts` (changed):

```diff
@@ -66,6 +66,8 @@ export const en = {
     expiry: 'Batches and expiry',
     reorder: 'Reorder',
     warehouses: 'Warehouses',
+    valuation: 'Valuation',
+    revaluations: 'Revaluations',
   },
   auth: {
     workspace: 'Workspace',
@@ -148,6 +150,36 @@ export const en = {
     allowNegativeStock: 'Allow negative stock',
     allowNegativeStockHint:
       'Sales and adjustments may then take more than the stock shows, for products without batches or serial numbers. Leave it off unless your counters sell before the stock is entered.',
+    stockAccountsTitle: 'Stock accounts',
+    stockAccountsSubtitle:
+      'Where stock documents post in the books. Stock itself always goes to {{inventory}}, and opening stock against {{equity}}.',
+    stockAccountGroups: {
+      adjustments: 'Adjustments',
+      transfers: 'Transfers',
+      revaluation: 'Revaluation',
+    },
+    stockAccountUses: {
+      in_transit: 'Goods in transit',
+      found: 'Found in a count',
+      damaged: 'Damaged',
+      expired: 'Expired',
+      lost: 'Lost or stolen',
+      sample: 'Free samples',
+      internal_use: 'Used in the company',
+      correction: 'Correction',
+      transfer_shortage: 'Received short',
+      revaluation: 'Revaluation',
+    },
+    stockAccountHints: {
+      in_transit: 'An asset: stock sent between two branches, until it arrives',
+      transfer_shortage: 'What a transfer lost on the way',
+      revaluation: 'The difference when an item gets a new average cost',
+    },
+    stockAccountPlaceholder: 'Pick an account',
+    stockAccountsSave: 'Save stock accounts',
+    stockAccountsSaved: 'Stock accounts saved',
+    stockAccountsMissing:
+      'Some stock accounts are not chosen yet. Stock documents that need them cannot be posted.',
     logoSaved: 'Logo updated',
     logoRemoved: 'Logo removed',
     saved: 'Settings saved',
@@ -171,6 +203,7 @@ export const en = {
         product: 'Product code',
         adjustment: 'Stock adjustment',
         transfer: 'Stock transfer',
+        revaluation: 'Stock revaluation',
       },
       accounting: { journal: 'Journal voucher' },
     },
@@ -373,7 +406,13 @@ export const en = {
       opening_balance: 'Opening balances',
       reversal: 'Reversal',
       year_close: 'Year-end close',
+      stock_adjustment: 'Stock adjustment',
+      stock_transfer: 'Stock transfer',
+      stock_revaluation: 'Stock revaluation',
     },
+    fromDocument: 'From {{document}}',
+    stockEntryHint:
+      'A stock document made this entry. To correct it, post another stock document: an adjustment, or a revaluation.',
     draftSaved: 'Draft saved',
     posted: '{{number}} posted',
     deleted: 'Draft deleted',
@@ -880,6 +919,8 @@ export const en = {
       product: 'Product',
       onHand: 'On hand',
       inTransit: 'In transit',
+      unitCost: 'Average cost',
+      value: 'Value',
       status: 'Status',
     },
     statuses: { low: 'Low', out: 'Out of stock', negative: 'Below zero', archived: 'Archived' },
@@ -899,7 +940,10 @@ export const en = {
       onHand: 'On hand',
       inTransit: 'In transit',
       places: 'Warehouses with stock',
+      unitCost: 'Average cost',
+      value: 'Stock value',
     },
+    noCost: 'No cost yet',
     byWarehouse: 'By warehouse',
     byWarehouseSubtitle: 'On hand, on its way, and when to order more',
     level: 'Reorder level',
@@ -937,8 +981,14 @@ export const en = {
       in: 'In',
       out: 'Out',
       balance: 'Balance',
+      value: 'Value',
+    },
+    kinds: {
+      adjustment: 'Adjustment',
+      transfer_out: 'Sent',
+      transfer_in: 'Received',
+      revaluation: 'Revaluation',
     },
-    kinds: { adjustment: 'Adjustment', transfer_out: 'Sent', transfer_in: 'Received' },
     historyEmpty: 'No movement in these dates.',
   },
   stockLines: {
@@ -970,6 +1020,13 @@ export const en = {
     serialsCount: '{{count}} of {{wanted}} entered',
     noLines: 'No items yet. Add the products this document moves.',
     pickWarehouse: 'Pick the warehouse first: the search shows its stock.',
+    unitCost: 'Unit cost',
+    unitCostPer: 'Cost per {{unit}}',
+    atAverage: 'At average cost',
+    noAverage: 'No cost yet: enter one',
+    lineValue: '= {{amount}}',
+    value: 'Value',
+    total: 'Total',
   },
   adjustments: {
     title: 'Stock adjustments',
@@ -1023,6 +1080,10 @@ export const en = {
     cantWrite:
       'You can view adjustments. Ask a workspace owner for the inventory.stock.adjust permission to write them.',
     postedOn: 'Posted {{date}}',
+    entry: 'Journal entry',
+    noEntry: 'No journal entry: the items moved had no cost',
+    costHint:
+      'Type what each item cost, per unit of its line. Leave it empty to use the average cost the item has now.',
     notFound: 'This adjustment no longer exists. A draft may have been deleted.',
     emptyTitle: 'No adjustments yet',
     emptyBody:
@@ -1078,6 +1139,9 @@ export const en = {
     shortBy: 'Short by {{quantity}}',
     allArrived: 'All arrived',
     serialsArrived: 'Serial numbers that arrived',
+    sentValue: 'Value sent',
+    lostValue: 'Lost {{amount}}',
+    entries: 'Journal entries',
     notFound: 'This transfer no longer exists. A draft may have been deleted.',
     emptyTitle: 'No transfers yet',
     emptyBody:
@@ -1121,6 +1185,81 @@ export const en = {
       'Set a reorder level on a product’s stock page. It shows here when the stock falls to it.',
     loadFailed: "Couldn't load the reorder list. Refresh the page to try again.",
   },
+  valuation: {
+    title: 'Stock valuation',
+    description: 'What the stock is worth at its average cost, and whether the books agree',
+    searchLabel: 'Search stock',
+    searchPlaceholder: 'Name, code or SKU',
+    category: 'Category',
+    allCategories: 'All categories',
+    columns: {
+      product: 'Product',
+      quantity: 'On hand',
+      unitCost: 'Average cost',
+      value: 'Value',
+    },
+    kpis: {
+      stock: 'In warehouses',
+      inTransit: 'In transit',
+      total: 'Stock value',
+      books: 'In the books',
+    },
+    booksAgree: 'Books agree',
+    booksOutBy: 'Out by {{amount}}',
+    booksHint: '{{inventory}} and {{inTransit}}, today',
+    noInTransitAccount: 'no goods in transit account chosen',
+    revalue: 'Revalue stock',
+    emptyTitle: 'No stock yet',
+    emptyBody:
+      'Post your opening stock with its cost. Its value shows here, and in the balance sheet.',
+    noMatchTitle: 'Nothing matches “{{query}}”',
+    noMatchBody: 'Try part of the name or the code.',
+    loadFailed: "Couldn't load the stock values. Refresh the page to try again.",
+  },
+  revaluations: {
+    title: 'Stock revaluations',
+    description: 'New average costs, with the difference posted to the books',
+    new: 'Revalue stock',
+    newTitle: 'Revalue stock',
+    back: 'Stock revaluations',
+    date: 'Date',
+    note: 'Note',
+    notePlaceholder: 'Opening stock at the supplier invoice prices, checked by the auditor',
+    columns: {
+      number: 'Number',
+      date: 'Date',
+      lines: 'Items',
+      difference: 'Difference',
+    },
+    lineColumns: {
+      product: 'Product',
+      quantity: 'On hand',
+      oldCost: 'Cost now',
+      oldValue: 'Value now',
+      newCost: 'New cost',
+      newValue: 'New value',
+      difference: 'Difference',
+    },
+    lineCount_one: '{{count}} item',
+    lineCount_other: '{{count}} items',
+    line: 'Line {{number}}',
+    remove: 'Remove line {{number}}',
+    newCostPer: 'New cost per {{unit}}',
+    noStock: 'No stock to revalue',
+    noLines: 'No items yet. Add the products that need a new cost.',
+    post: 'Post revaluation',
+    posting: 'Posting…',
+    posted: '{{number}} posted',
+    postHint:
+      'The difference goes to the books at once. A revaluation never changes: post another one to correct it.',
+    entry: 'Journal entry',
+    noEntry: 'No journal entry: no value changed',
+    notFound: 'This revaluation does not exist.',
+    emptyTitle: 'No revaluations yet',
+    emptyBody:
+      'Give the stock that came in before costs were kept its real value, or put a wrong cost right.',
+    loadFailed: "Couldn't load the revaluations. Refresh the page to try again.",
+  },
   yearEnd: {
     title: 'Year-end close',
     description: "Move each year's profit into retained earnings and close its dates",
@@ -1279,6 +1418,8 @@ export const en = {
       stock: {
         adjust: 'Write and post stock adjustments and opening stock',
         transfer: 'Send stock to another warehouse and receive it',
+        value: 'See what stock costs and what it is worth',
+        revalue: 'Revalue stock: give items a new average cost',
       },
     },
   },
@@ -1326,6 +1467,7 @@ export const en = {
       stock_adjustment: 'Stock adjustments',
       stock_transfer: 'Stock transfers',
       reorder_level: 'Reorder levels',
+      stock_revaluation: 'Stock revaluations',
     },
     columns: {
       when: 'When',
@@ -1438,6 +1580,11 @@ export const en = {
         received: 'Received a stock transfer',
       },
       reorder_level: { changed: 'Changed a reorder level' },
+      stock_accounts: {
+        changed: 'Changed the stock accounts',
+        created: 'Added the stock accounts',
+      },
+      stock_revaluation: { posted: 'Posted a stock revaluation' },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -1500,6 +1647,18 @@ export const en = {
       min: 'Reorder level',
       reorder: 'Order quantity',
       allowNegativeStock: 'Negative stock allowed',
+      uses: 'Stock accounts',
+      difference: 'Difference',
+      in_transit: 'Goods in transit',
+      found: 'Found in a count',
+      damaged: 'Damaged',
+      expired: 'Expired',
+      lost: 'Lost or stolen',
+      sample: 'Free samples',
+      internal_use: 'Used in the company',
+      correction: 'Correction',
+      transfer_shortage: 'Received short',
+      revaluation: 'Revaluation',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -1804,6 +1963,19 @@ export const en = {
       'This product has stock, so its base unit stays. Add a pack for the other unit instead.',
     product_tracking_locked: 'This product has stock, so its tracking stays as it is.',
     product_type_locked: 'This product has stock, so it stays goods.',
+    stock_cost_required: 'This item has no cost yet. Enter what it cost.',
+    stock_account_missing:
+      'Choose the stock accounts in Settings → Inventory first: this posting needs one that is not chosen, or is archived.',
+    stock_account_invalid: 'Pick an active account of the right type.',
+    stock_account_inventory: 'Pick another account: this one is the inventory account itself.',
+    journal_account_stock:
+      'Only stock documents post to this account. Use a stock adjustment, or a revaluation, instead.',
+    journal_is_stock:
+      'A stock document made this entry. Post another stock document to correct it.',
+    revaluation_no_stock: 'There is no stock of this item to revalue.',
+    revaluation_variant_twice: 'This item is on another line already.',
+    account_used_by_stock:
+      'Stock documents post to this account. Choose another one in Settings → Inventory first.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
```

`packages/i18n/src/locales/bn.ts` (changed):

```diff
@@ -66,6 +66,8 @@ export const bn: Messages = {
     expiry: 'ব্যাচ ও মেয়াদ',
     reorder: 'রিঅর্ডার',
     warehouses: 'গুদাম',
+    valuation: 'স্টকের মূল্য',
+    revaluations: 'পুনর্মূল্যায়ন',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -148,6 +150,36 @@ export const bn: Messages = {
     allowNegativeStock: 'স্টক শূন্যের নিচে যেতে দিন',
     allowNegativeStockHint:
       'তাহলে ব্যাচ বা সিরিয়াল নম্বর ছাড়া প্রোডাক্টে বিক্রি আর অ্যাডজাস্টমেন্ট খাতায় থাকা স্টকের চেয়ে বেশি নিতে পারবে। কাউন্টারে স্টক এন্ট্রির আগেই বিক্রি না হলে এটা বন্ধ রাখুন।',
+    stockAccountsTitle: 'স্টকের অ্যাকাউন্ট',
+    stockAccountsSubtitle:
+      'স্টকের ডকুমেন্ট হিসাবের খাতায় কোথায় পোস্ট হবে। স্টক নিজে সবসময় {{inventory}}-এ যায়, আর ওপেনিং স্টক {{equity}}-এর বিপরীতে।',
+    stockAccountGroups: {
+      adjustments: 'অ্যাডজাস্টমেন্ট',
+      transfers: 'ট্রান্সফার',
+      revaluation: 'পুনর্মূল্যায়ন',
+    },
+    stockAccountUses: {
+      in_transit: 'পথে থাকা মাল',
+      found: 'গণনায় পাওয়া',
+      damaged: 'নষ্ট',
+      expired: 'মেয়াদ শেষ',
+      lost: 'হারানো বা চুরি',
+      sample: 'ফ্রি স্যাম্পল',
+      internal_use: 'কোম্পানির নিজের ব্যবহারে',
+      correction: 'সংশোধন',
+      transfer_shortage: 'কম পৌঁছেছে',
+      revaluation: 'পুনর্মূল্যায়ন',
+    },
+    stockAccountHints: {
+      in_transit: 'একটা সম্পদ: দুই ব্রাঞ্চের মধ্যে পাঠানো স্টক, পৌঁছানো পর্যন্ত',
+      transfer_shortage: 'ট্রান্সফারে পথে যা হারিয়েছে',
+      revaluation: 'কোনো আইটেমের নতুন গড় খরচ ঠিক হলে যে পার্থক্য হয়',
+    },
+    stockAccountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+    stockAccountsSave: 'স্টকের অ্যাকাউন্ট সেভ করুন',
+    stockAccountsSaved: 'স্টকের অ্যাকাউন্ট সেভ হয়েছে',
+    stockAccountsMissing:
+      'কিছু স্টকের অ্যাকাউন্ট এখনো বাছা হয়নি। যে ডকুমেন্টের সেগুলো লাগে, সেগুলো পোস্ট করা যাবে না।',
     logoSaved: 'লোগো বদলানো হয়েছে',
     logoRemoved: 'লোগো সরানো হয়েছে',
     saved: 'সেটিংস সেভ হয়েছে',
@@ -171,6 +203,7 @@ export const bn: Messages = {
         product: 'প্রোডাক্ট কোড',
         adjustment: 'স্টক অ্যাডজাস্টমেন্ট',
         transfer: 'স্টক ট্রান্সফার',
+        revaluation: 'স্টকের পুনর্মূল্যায়ন',
       },
       accounting: { journal: 'জার্নাল ভাউচার' },
     },
@@ -369,7 +402,13 @@ export const bn: Messages = {
       opening_balance: 'ওপেনিং ব্যালান্স',
       reversal: 'রিভার্সাল',
       year_close: 'বছর শেষের ক্লোজিং',
+      stock_adjustment: 'স্টক অ্যাডজাস্টমেন্ট',
+      stock_transfer: 'স্টক ট্রান্সফার',
+      stock_revaluation: 'স্টকের পুনর্মূল্যায়ন',
     },
+    fromDocument: '{{document}} থেকে',
+    stockEntryHint:
+      'এই এন্ট্রিটা একটা স্টকের ডকুমেন্ট বানিয়েছে। সংশোধন করতে আরেকটা স্টকের ডকুমেন্ট পোস্ট করুন: অ্যাডজাস্টমেন্ট, বা পুনর্মূল্যায়ন।',
     draftSaved: 'ড্রাফট সেভ হয়েছে',
     posted: '{{number}} পোস্ট হয়েছে',
     deleted: 'ড্রাফট মোছা হয়েছে',
@@ -874,6 +913,8 @@ export const bn: Messages = {
       product: 'প্রোডাক্ট',
       onHand: 'হাতে আছে',
       inTransit: 'পথে আছে',
+      unitCost: 'গড় খরচ',
+      value: 'মূল্য',
       status: 'অবস্থা',
     },
     statuses: { low: 'কম', out: 'স্টক শেষ', negative: 'শূন্যের নিচে', archived: 'আর্কাইভ' },
@@ -893,7 +934,10 @@ export const bn: Messages = {
       onHand: 'হাতে আছে',
       inTransit: 'পথে আছে',
       places: 'যতগুলো গুদামে স্টক আছে',
+      unitCost: 'গড় খরচ',
+      value: 'স্টকের মূল্য',
     },
+    noCost: 'এখনো খরচ নেই',
     byWarehouse: 'গুদাম অনুযায়ী',
     byWarehouseSubtitle: 'হাতে কত, পথে কত, আর কখন আবার অর্ডার করবেন',
     level: 'রিঅর্ডার লেভেল',
@@ -931,8 +975,14 @@ export const bn: Messages = {
       in: 'ঢুকেছে',
       out: 'বেরিয়েছে',
       balance: 'ব্যালান্স',
+      value: 'মূল্য',
+    },
+    kinds: {
+      adjustment: 'অ্যাডজাস্টমেন্ট',
+      transfer_out: 'পাঠানো',
+      transfer_in: 'গ্রহণ',
+      revaluation: 'পুনর্মূল্যায়ন',
     },
-    kinds: { adjustment: 'অ্যাডজাস্টমেন্ট', transfer_out: 'পাঠানো', transfer_in: 'গ্রহণ' },
     historyEmpty: 'এই তারিখগুলোর মধ্যে কোনো মুভমেন্ট নেই।',
   },
   stockLines: {
@@ -964,6 +1014,13 @@ export const bn: Messages = {
     serialsCount: '{{wanted}}-এর মধ্যে {{count}}টা লেখা হয়েছে',
     noLines: 'এখনো কোনো আইটেম নেই। এই ডকুমেন্ট যে প্রোডাক্টগুলো নাড়াবে সেগুলো যোগ করুন।',
     pickWarehouse: 'আগে গুদাম বাছুন: খোঁজার সময় সেখানকার স্টক দেখাবে।',
+    unitCost: 'একক খরচ',
+    unitCostPer: 'প্রতি {{unit}}-এর খরচ',
+    atAverage: 'গড় খরচে',
+    noAverage: 'এখনো খরচ নেই: একটা লিখুন',
+    lineValue: '= {{amount}}',
+    value: 'মূল্য',
+    total: 'মোট',
   },
   adjustments: {
     title: 'স্টক অ্যাডজাস্টমেন্ট',
@@ -1017,6 +1074,10 @@ export const bn: Messages = {
     cantWrite:
       'আপনি অ্যাডজাস্টমেন্ট দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে inventory.stock.adjust permission চান।',
     postedOn: '{{date}}-এ পোস্ট হয়েছে',
+    entry: 'জার্নাল এন্ট্রি',
+    noEntry: 'জার্নাল এন্ট্রি নেই: যে আইটেমগুলো নড়েছে সেগুলোর খরচ ছিল না',
+    costHint:
+      'প্রতিটা আইটেমের খরচ লিখুন, লাইনের প্রতি ইউনিটে। ফাঁকা রাখলে আইটেমের এখনকার গড় খরচ ধরা হবে।',
     notFound: 'এই অ্যাডজাস্টমেন্ট আর নেই। খসড়াটা হয়তো মুছে ফেলা হয়েছে।',
     emptyTitle: 'এখনো কোনো অ্যাডজাস্টমেন্ট নেই',
     emptyBody:
@@ -1071,6 +1132,9 @@ export const bn: Messages = {
     shortBy: '{{quantity}} কম',
     allArrived: 'সব পৌঁছেছে',
     serialsArrived: 'যে সিরিয়াল নম্বরগুলো পৌঁছেছে',
+    sentValue: 'যত মূল্যের পাঠানো হয়েছে',
+    lostValue: '{{amount}} হারিয়েছে',
+    entries: 'জার্নাল এন্ট্রি',
     notFound: 'এই ট্রান্সফার আর নেই। খসড়াটা হয়তো মুছে ফেলা হয়েছে।',
     emptyTitle: 'এখনো কোনো ট্রান্সফার নেই',
     emptyBody: 'মূল স্টোর থেকে ডিপো বা দোকানে স্টক পাঠান। পথে থাকার সময় সেটা এখানে দেখাবে।',
@@ -1112,6 +1176,79 @@ export const bn: Messages = {
     emptyBody: 'প্রোডাক্টের স্টক পেজে রিঅর্ডার লেভেল দিন। স্টক সেখানে নামলে এখানে দেখাবে।',
     loadFailed: 'রিঅর্ডারের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  valuation: {
+    title: 'স্টকের মূল্য',
+    description: 'গড় খরচে স্টকের দাম কত, আর হিসাবের খাতা তার সাথে মেলে কি না',
+    searchLabel: 'স্টক খুঁজুন',
+    searchPlaceholder: 'নাম, কোড বা SKU',
+    category: 'ক্যাটাগরি',
+    allCategories: 'সব ক্যাটাগরি',
+    columns: {
+      product: 'প্রোডাক্ট',
+      quantity: 'হাতে আছে',
+      unitCost: 'গড় খরচ',
+      value: 'মূল্য',
+    },
+    kpis: {
+      stock: 'গুদামগুলোতে',
+      inTransit: 'পথে আছে',
+      total: 'স্টকের মূল্য',
+      books: 'খাতায়',
+    },
+    booksAgree: 'খাতা মিলেছে',
+    booksOutBy: '{{amount}} গরমিল',
+    booksHint: '{{inventory}} আর {{inTransit}}, আজ পর্যন্ত',
+    noInTransitAccount: 'পথে থাকা মালের অ্যাকাউন্ট বাছা হয়নি',
+    revalue: 'স্টকের পুনর্মূল্যায়ন',
+    emptyTitle: 'এখনো স্টক নেই',
+    emptyBody: 'খরচসহ ওপেনিং স্টক পোস্ট করুন। তার মূল্য এখানে আর ব্যালান্স শিটে দেখাবে।',
+    noMatchTitle: '“{{query}}”-এর সাথে কিছু মেলেনি',
+    noMatchBody: 'নামের একটা অংশ বা কোড দিয়ে খুঁজুন।',
+    loadFailed: 'স্টকের মূল্য আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  revaluations: {
+    title: 'স্টকের পুনর্মূল্যায়ন',
+    description: 'নতুন গড় খরচ, আর তার পার্থক্য হিসাবের খাতায় পোস্ট করা',
+    new: 'স্টকের পুনর্মূল্যায়ন',
+    newTitle: 'স্টকের পুনর্মূল্যায়ন',
+    back: 'স্টকের পুনর্মূল্যায়ন',
+    date: 'তারিখ',
+    note: 'নোট',
+    notePlaceholder: 'সাপ্লায়ারের ইনভয়েসের দামে ওপেনিং স্টক, অডিটর মিলিয়ে দেখেছেন',
+    columns: {
+      number: 'নম্বর',
+      date: 'তারিখ',
+      lines: 'আইটেম',
+      difference: 'পার্থক্য',
+    },
+    lineColumns: {
+      product: 'প্রোডাক্ট',
+      quantity: 'হাতে আছে',
+      oldCost: 'এখনকার খরচ',
+      oldValue: 'এখনকার মূল্য',
+      newCost: 'নতুন খরচ',
+      newValue: 'নতুন মূল্য',
+      difference: 'পার্থক্য',
+    },
+    lineCount_one: '{{count}}টা আইটেম',
+    lineCount_other: '{{count}}টা আইটেম',
+    line: 'লাইন {{number}}',
+    remove: 'লাইন {{number}} সরান',
+    newCostPer: 'প্রতি {{unit}}-এর নতুন খরচ',
+    noStock: 'পুনর্মূল্যায়নের মতো স্টক নেই',
+    noLines: 'এখনো কোনো আইটেম নেই। যে প্রোডাক্টগুলোর নতুন খরচ দরকার সেগুলো যোগ করুন।',
+    post: 'পুনর্মূল্যায়ন পোস্ট করুন',
+    posting: 'পোস্ট হচ্ছে…',
+    posted: '{{number}} পোস্ট হয়েছে',
+    postHint:
+      'পার্থক্যটা সাথে সাথে খাতায় যায়। পুনর্মূল্যায়ন কখনো বদলায় না: সংশোধন করতে আরেকটা পোস্ট করুন।',
+    entry: 'জার্নাল এন্ট্রি',
+    noEntry: 'জার্নাল এন্ট্রি নেই: কোনো মূল্য বদলায়নি',
+    notFound: 'এই পুনর্মূল্যায়নটা নেই।',
+    emptyTitle: 'এখনো কোনো পুনর্মূল্যায়ন নেই',
+    emptyBody: 'খরচ রাখা শুরুর আগে যে স্টক ঢুকেছিল তাকে আসল মূল্য দিন, বা ভুল খরচ ঠিক করুন।',
+    loadFailed: 'পুনর্মূল্যায়নগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   yearEnd: {
     title: 'বছর শেষের ক্লোজিং',
     description: 'প্রতিটা বছরের লাভ রিটেইনড আর্নিংসে নিন আর সেই বছরের তারিখগুলো বন্ধ করুন',
@@ -1268,6 +1405,8 @@ export const bn: Messages = {
       stock: {
         adjust: 'স্টক অ্যাডজাস্টমেন্ট আর ওপেনিং স্টক লেখা ও পোস্ট করা',
         transfer: 'অন্য গুদামে স্টক পাঠানো আর গ্রহণ করা',
+        value: 'স্টকের খরচ আর মূল্য দেখা',
+        revalue: 'স্টকের পুনর্মূল্যায়ন: আইটেমের নতুন গড় খরচ ঠিক করা',
       },
     },
   },
@@ -1315,6 +1454,7 @@ export const bn: Messages = {
       stock_adjustment: 'স্টক অ্যাডজাস্টমেন্ট',
       stock_transfer: 'স্টক ট্রান্সফার',
       reorder_level: 'রিঅর্ডার লেভেল',
+      stock_revaluation: 'স্টকের পুনর্মূল্যায়ন',
     },
     columns: {
       when: 'কখন',
@@ -1425,6 +1565,11 @@ export const bn: Messages = {
         received: 'একটা স্টক ট্রান্সফার গ্রহণ করেছেন',
       },
       reorder_level: { changed: 'একটা রিঅর্ডার লেভেল বদলেছেন' },
+      stock_accounts: {
+        changed: 'স্টকের অ্যাকাউন্ট বদলেছেন',
+        created: 'স্টকের অ্যাকাউন্ট যোগ করেছেন',
+      },
+      stock_revaluation: { posted: 'স্টকের একটা পুনর্মূল্যায়ন পোস্ট করেছেন' },
     },
     fields: {
       name: 'নাম',
@@ -1486,6 +1631,18 @@ export const bn: Messages = {
       min: 'রিঅর্ডার লেভেল',
       reorder: 'অর্ডারের পরিমাণ',
       allowNegativeStock: 'শূন্যের নিচে স্টক চলবে',
+      uses: 'স্টকের অ্যাকাউন্ট',
+      difference: 'পার্থক্য',
+      in_transit: 'পথে থাকা মাল',
+      found: 'গণনায় পাওয়া',
+      damaged: 'নষ্ট',
+      expired: 'মেয়াদ শেষ',
+      lost: 'হারানো বা চুরি',
+      sample: 'ফ্রি স্যাম্পল',
+      internal_use: 'কোম্পানির নিজের ব্যবহারে',
+      correction: 'সংশোধন',
+      transfer_shortage: 'কম পৌঁছেছে',
+      revaluation: 'পুনর্মূল্যায়ন',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -1783,6 +1940,19 @@ export const bn: Messages = {
       'এই প্রোডাক্টের স্টক আছে, তাই বেস ইউনিট বদলাবে না। অন্য ইউনিটের জন্য একটা প্যাক যোগ করুন।',
     product_tracking_locked: 'এই প্রোডাক্টের স্টক আছে, তাই ট্র্যাকিং যেমন আছে তেমন থাকবে।',
     product_type_locked: 'এই প্রোডাক্টের স্টক আছে, তাই এটা পণ্যই থাকবে।',
+    stock_cost_required: 'এই আইটেমের এখনো কোনো খরচ নেই। কত খরচ পড়েছে লিখুন।',
+    stock_account_missing:
+      'আগে Settings → Inventory-তে স্টকের অ্যাকাউন্ট বাছুন: এই পোস্টিংয়ের যেটা লাগে সেটা বাছা হয়নি, বা আর্কাইভ করা।',
+    stock_account_invalid: 'ঠিক ধরনের একটা সক্রিয় অ্যাকাউন্ট বাছুন।',
+    stock_account_inventory: 'অন্য অ্যাকাউন্ট বাছুন: এটা নিজেই ইনভেন্টরির অ্যাকাউন্ট।',
+    journal_account_stock:
+      'এই অ্যাকাউন্টে শুধু স্টকের ডকুমেন্ট পোস্ট করে। এর বদলে স্টক অ্যাডজাস্টমেন্ট বা পুনর্মূল্যায়ন করুন।',
+    journal_is_stock:
+      'এই এন্ট্রিটা একটা স্টকের ডকুমেন্ট বানিয়েছে। সংশোধন করতে আরেকটা স্টকের ডকুমেন্ট পোস্ট করুন।',
+    revaluation_no_stock: 'এই আইটেমের পুনর্মূল্যায়নের মতো স্টক নেই।',
+    revaluation_variant_twice: 'এই আইটেমটা আরেকটা লাইনে আছে।',
+    account_used_by_stock:
+      'স্টকের ডকুমেন্ট এই অ্যাকাউন্টে পোস্ট করে। আগে Settings → Inventory-তে অন্য একটা বাছুন।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
```

- **The audit `fields` get the ten use names**: the stock accounts' audit row has one change per use
  (`sample: 5310 → 5320`), and the audit log shows "Free samples", not `sample`.
- **`stockLines.unitCostPer` takes the unit's code** ("Cost per case"): the cost is per unit of the line, and the
  label says which.
- **In Bangla**, common office terms stay in English inside the sentence (CLAUDE.md → Language): workspace,
  Settings → Inventory.

### `KpiStrip` takes four cells

`packages/ui/src/components/kpi-strip.tsx` (changed):

```diff
@@ -1,3 +1,4 @@
+import { cn } from '../lib/cn.js';
 import { Card } from './card.js';
 
 interface KpiStripProps {
@@ -7,9 +8,16 @@ interface KpiStripProps {
 // CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line.
 // Moved here from the app's report-parts.tsx in step 13: the stock card uses it too, and importing
 // it from the reports' file pulled the reports' code into the stock card's chunk.
+// Three cells or four (step 14: the stock card and the valuation page show what the stock is
+// worth). Whole class names, not `sm:grid-cols-${n}`: Tailwind only finds classes written out.
 export function KpiStrip({ cells }: KpiStripProps) {
   return (
-    <Card className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
+    <Card
+      className={cn(
+        'grid grid-cols-1 divide-y divide-line sm:divide-x sm:divide-y-0',
+        cells.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3',
+      )}
+    >
       {cells.map((cell) => (
         <div key={cell.label} className="grid gap-1 px-5 py-4">
           <span className="text-caption text-ink-3">{cell.label}</span>
```

Tailwind finds class names by reading the source as text: `sm:grid-cols-${n}` would never be found, and the
grid would fall back to one column. So both class names are written out.

---
## 14.7 — `apps/app`: costs on the forms, values on the pages

### Data and helpers

`apps/app/src/lib/queries.ts` (changed):

```diff
@@ -489,3 +489,63 @@ export function stockTransferQuery(tenantId: string, transferId: string) {
     retry: false,
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// What the stock is worth (step 14). Under ['stock', tenantId] too: every posting changes values.
+
+export function stockValuationQuery(
+  tenantId: string,
+  filter: { search: string; categoryId: string },
+) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'valuation', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stock.valuation, {
+        query: {
+          limit: 100,
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
+export function valuationSummaryQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['stock', tenantId, 'valuation-summary'],
+    queryFn: () => call(routes.stock.valuationSummary),
+  });
+}
+
+export function stockRevaluationsQuery(tenantId: string) {
+  return infiniteQueryOptions({
+    queryKey: ['stock', tenantId, 'revaluations'],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.stockRevaluations.list, {
+        query: { limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function stockRevaluationQuery(tenantId: string, revaluationId: string) {
+  return queryOptions({
+    queryKey: ['stock', tenantId, 'revaluation', revaluationId],
+    queryFn: () => call(routes.stockRevaluations.get, { params: { id: revaluationId } }),
+    retry: false,
+  });
+}
+
+// The accounts stock documents post to (Settings → Inventory)
+export function stockAccountsQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['stock-accounts', tenantId],
+    queryFn: () => call(routes.stockAccounts.get),
+  });
+}
```

`apps/app/src/components/stock-parts.tsx` (changed):

```diff
@@ -49,6 +49,15 @@ export function useQuantity(): (value: string, unitId: string) => string {
   );
 }
 
+// "case", "pcs": a unit's code, for "Cost per case" (step 14)
+export function useUnitCode(): (unitId: string) => string {
+  const units = useQuery(unitsQuery(useTenantId())).data;
+  return useCallback(
+    (unitId: string) => units?.find((unit) => unit.id === unitId)?.code ?? '',
+    [units],
+  );
+}
+
 // Every warehouse, archived ones too (old documents point at them), by id; and the active ones,
 // for the forms' selects
 export function useWarehouses(): {
@@ -77,13 +86,26 @@ export function useToday(): string {
 }
 
 // After a posting: everything under ['stock', tenant] — the list, the cards, the reports and the
-// documents — is fetched again
+// documents — is fetched again. And from step 14 the books too (['journal', tenant]): a posting
+// writes a journal entry, which changes the ledgers, the trial balance and the balance sheet.
 export function useStockRefresh(): () => Promise<void> {
   const tenantId = useTenantId();
   const queryClient = useQueryClient();
+  return useCallback(async () => {
+    await Promise.all([
+      queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
+      queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
+    ]);
+  }, [queryClient, tenantId]);
+}
+
+// "৳3,600.00": a value on a stock document, with paisa — the journal entry it made shows them too,
+// and both must visibly agree. null (no permission, or no cost yet) is a dash.
+export function useValue(): (value: string | null) => string {
+  const { format } = useLocale();
   return useCallback(
-    () => queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
-    [queryClient, tenantId],
+    (value: string | null) => (value === null ? '—' : format.money(value, { decimals: 2 })),
+    [format],
   );
 }
 
@@ -181,7 +203,12 @@ export function BackLink({
   to,
   label,
 }: {
-  to: '/stock' | '/stock/adjustments' | '/stock/transfers';
+  to:
+    | '/stock'
+    | '/stock/adjustments'
+    | '/stock/transfers'
+    | '/stock/valuation'
+    | '/stock/revaluations';
   label: string;
 }) {
   return (
```

- **Every new stock query starts with `['stock', tenantId]`**, so step 13's one invalidate refreshes them too. The
  stock accounts are not stock (`['stock-accounts', tenantId]`): a posting does not change them.
- **`useStockRefresh()` refreshes `['journal', tenantId]` as well.** A posting now writes a journal entry, so the
  journal list, the ledgers, the trial balance and the balance sheet are all stale after it. Without this, the
  balance sheet would show the old inventory until the next page load.
- **`useValue()`** formats a document's value with paisa (CLAUDE.md → Money: accounting documents show 2
  decimals) and a dash for `null`. **`useUnitCode()`** gives "case", "pcs" for "Cost per case".

`apps/app/src/lib/stock.ts` (changed):

```diff
@@ -100,9 +100,15 @@ export function parseSerials(text: string): string[] {
 // The routes a stock card's row links to, by its kind (unknown kinds from a newer server: none)
 export function documentRoute(
   kind: string,
-): '/stock/adjustments/$adjustmentId' | '/stock/transfers/$transferId' | null {
+):
+  | '/stock/adjustments/$adjustmentId'
+  | '/stock/transfers/$transferId'
+  | '/stock/revaluations/$revaluationId'
+  | null {
   if (kind === 'adjustment') return '/stock/adjustments/$adjustmentId';
   if (kind === 'transfer_out' || kind === 'transfer_in') return '/stock/transfers/$transferId';
+  // Step 14: a change of value, without a change of quantity
+  if (kind === 'revaluation') return '/stock/revaluations/$revaluationId';
   return null;
 }
 
```

`apps/app/src/lib/stock.spec.ts` (changed):

```diff
@@ -97,6 +97,7 @@ describe('stock helpers', () => {
   it('links a movement to its document', () => {
     expect(documentRoute('adjustment')).toBe('/stock/adjustments/$adjustmentId');
     expect(documentRoute('transfer_in')).toBe('/stock/transfers/$transferId');
+    expect(documentRoute('revaluation')).toBe('/stock/revaluations/$revaluationId');
     expect(documentRoute('sales_delivery')).toBeNull();
   });
 });
```

A revaluation's movement on the stock card opens its revaluation, like an adjustment's opens the adjustment.

### The adjustment form: a cost per line

`apps/app/src/components/stock-line-row.tsx` (changed):

```diff
@@ -44,26 +44,30 @@ export function toLineItem(source: StockItem | StockLine): LineItem {
 }
 
 // One template for every row, so the columns line up on a wide card: the item, the unit, the
-// quantity, what the tracking asks for, and the remove button. A container query (@3xl), not a
-// screen one, like the journal's lines: the sidebar takes room the screen width does not show.
+// quantity, (step 14, on lines that bring stock in) the unit cost, what the tracking asks for, and
+// the remove button. A container query (@3xl), not a screen one, like the journal's lines: the
+// sidebar takes room the screen width does not show.
 const COLUMNS =
   '@3xl:grid-cols-[minmax(0,2fr)_8.5rem_9rem_minmax(0,1.8fr)_2.25rem] @3xl:items-start';
+const COSTED_COLUMNS =
+  '@3xl:grid-cols-[minmax(0,2fr)_8.5rem_9rem_10rem_minmax(0,1.6fr)_2.25rem] @3xl:items-start';
 
 // The column headers of a wide card. Hidden from screen readers: each control has its own
 // (sr-only) label there, which reads better than a header far away.
-export function StockLinesHeader() {
+export function StockLinesHeader({ costed = false }: { costed?: boolean }) {
   const { t } = useLocale();
   return (
     <div
       aria-hidden="true"
       className={cn(
         'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
-        COLUMNS,
+        costed ? COSTED_COLUMNS : COLUMNS,
       )}
     >
       <span>{t('stockLines.items')}</span>
       <span>{t('stockLines.unit')}</span>
       <span className="text-right">{t('stockLines.quantity')}</span>
+      {costed && <span className="text-right">{t('stockLines.unitCost')}</span>}
       <span>{t('stock.history.detail')}</span>
     </div>
   );
@@ -89,6 +93,7 @@ export function StockLineRow({
   fields,
   dates,
   serials,
+  cost,
   errors,
   onRemove,
   onSplit,
@@ -111,6 +116,9 @@ export function StockLineRow({
   dates?: ReactNode;
   // The serial number box of a serial line, already in its LineField
   serials?: ReactNode;
+  // Step 14: the unit cost box of a line that brings stock in, already in its LineField. Given =
+  // the row has the cost column (the header must say costed too).
+  cost?: ReactNode;
   errors: LineErrors;
   onRemove: () => void;
   onSplit: (batches: readonly { batchId: string; quantity: string }[]) => void;
@@ -139,7 +147,10 @@ export function StockLineRow({
     <div
       role="group"
       aria-label={t('stockLines.line', { number })}
-      className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
+      className={cn(
+        'grid grid-cols-2 gap-3 border-t border-line px-5 py-4',
+        cost === undefined ? COLUMNS : COSTED_COLUMNS,
+      )}
     >
       <div className="col-span-2 flex items-start justify-between gap-3 @3xl:col-span-1">
         <span className="grid min-w-0 gap-0.5">
@@ -176,6 +187,7 @@ export function StockLineRow({
           </span>
         )}
       </LineField>
+      {cost !== undefined && <div className="col-span-2 @3xl:col-span-1">{cost}</div>}
       <div className="col-span-2 grid grid-cols-1 gap-3 @3xl:col-span-1">
         {item.tracking === 'batch' && mode === 'in' && fields.lotNumber && (
           <>
```

- **`cost` is a slot**, like `dates` and `serials`: the row does not know about forms. When it is given, the row
  uses a template with one more column, and `StockLinesHeader costed` must say the same, or the header and the rows
  would not line up.

`apps/app/src/components/cost-input.tsx` (new):

```tsx
// The adjustment form's cost box as a chunk of its own (step 14). MoneyInput brings decimal.js
// (about 13 KB gz); the form needs it only on "Stock in" lines, and with it inside, the form's
// chunk went over its 100 KB budget. A module of its own is what makes the bundler split it off.
export { MoneyInput } from '@omnivo/ui';
```

`apps/app/src/components/adjustment-form.tsx` (changed):

```diff
@@ -7,12 +7,15 @@ import {
   type AdjustmentDirection,
   contractErrorMap,
   isAdjustmentDirection,
+  isQuantity,
+  multiplyMoney,
   plainQuantity,
   reasonFits,
   routes,
   type StockAdjustment,
   type StockAdjustmentFormValues,
   type StockItem,
+  sumMoney,
   updateStockAdjustmentInputSchema,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
@@ -23,6 +26,7 @@ import {
   Dialog,
   FormAlert,
   FormField,
+  Input,
   PageHeader,
   SegmentedControl,
   SelectField,
@@ -31,7 +35,7 @@ import {
 } from '@omnivo/ui';
 import { useMutation, useQuery } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import { useMemo, useState } from 'react';
+import { lazy, Suspense, useMemo, useState } from 'react';
 import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
@@ -47,10 +51,14 @@ import {
   BackLink,
   useStockRefresh,
   useTenantId,
+  useValue,
   useWarehouses,
   warehouseLabel,
 } from './stock-parts';
 
+// Loaded the first time a "Stock in" line shows its cost box (cost-input.tsx says why)
+const MoneyInput = lazy(async () => ({ default: (await import('./cost-input')).MoneyInput }));
+
 // The adjustment form: its own chunk (loaded by routes/stock-adjustment.tsx), because the form
 // library, the date picker and the picker are only needed to write — a posted adjustment is read
 // without them.
@@ -68,9 +76,20 @@ function emptyLine(item: LineItem): LineValues {
     expiresOn: '',
     manufacturedOn: '',
     serialNumbers: [],
+    unitCost: '',
   };
 }
 
+// What a line brings in, from its typed quantity and cost: "= ৳3,600.00" under the cost box.
+// null until both are there and make sense.
+function typedValue(line: LineValues | undefined): string | null {
+  const cost = line?.unitCost ?? null;
+  const quantity = line?.quantity.trim() ?? '';
+  return cost === null || cost === '' || !isQuantity(quantity)
+    ? null
+    : multiplyMoney(quantity, cost);
+}
+
 // The server's field names for the errors it can send — one set per line, and one per serial
 // number it may point at ("lines.2.serialNumbers.1")
 function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
@@ -90,6 +109,7 @@ function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
       rowPath('lines', index, 'expiresOn'),
       rowPath('lines', index, 'manufacturedOn'),
       rowPath('lines', index, 'serialNumbers'),
+      rowPath('lines', index, 'unitCost'),
       ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
     ]),
   ];
@@ -107,6 +127,7 @@ export function AdjustmentForm({
   const { t } = useLocale();
   const navigate = useNavigate();
   const refresh = useStockRefresh();
+  const value = useValue();
   const [picking, setPicking] = useState(false);
   const [confirming, setConfirming] = useState(false);
   // What each line's variant is (name, packs, tracking): kept beside the form, by variant, because
@@ -141,6 +162,7 @@ export function AdjustmentForm({
           expiresOn: line.expiresOn ?? '',
           manufacturedOn: line.manufacturedOn ?? '',
           serialNumbers: line.serialNumbers,
+          unitCost: line.unitCost ?? '',
         })) ?? [],
       post: false,
       version: adjustment?.version ?? 1,
@@ -152,6 +174,9 @@ export function AdjustmentForm({
   const warehouseId = useWatch({ control, name: 'warehouseId' });
   const { active } = useWarehouses();
   const units = useQuery(unitsQuery(useTenantId())).data ?? [];
+  // Step 14: a line that brings stock in takes a cost; one that takes it out goes at the average
+  const costed = direction === 'in';
+  const totalValue = sumMoney(lines.map((line) => typedValue(line) ?? '0'));
 
   const reasonOptions = useMemo(
     () =>
@@ -322,7 +347,7 @@ export function AdjustmentForm({
           {fields.length === 0 ? (
             <p className="px-5 py-6 text-body-sm text-ink-2">{t('stockLines.noLines')}</p>
           ) : (
-            <StockLinesHeader />
+            <StockLinesHeader costed={costed} />
           )}
           {fields.length > 0 &&
             fields.map((field, index) => {
@@ -394,6 +419,52 @@ export function AdjustmentForm({
                       }}
                     />
                   }
+                  cost={
+                    costed ? (
+                      <Controller
+                        control={control}
+                        name={rowPath('lines', index, 'unitCost')}
+                        render={({ field: costField, fieldState }) => {
+                          const unitCode =
+                            units.find(
+                              (unit) => unit.id === (lines[index]?.unitId ?? item.baseUnitId),
+                            )?.code ?? '';
+                          const lineValue = typedValue(lines[index]);
+                          return (
+                            <LineField
+                              id={costField.name}
+                              label={t('stockLines.unitCostPer', { unit: unitCode })}
+                              error={fieldState.error?.message}
+                            >
+                              {/* The same box, empty and disabled, for the moment the chunk loads */}
+                              <Suspense
+                                fallback={
+                                  <Input id={costField.name} disabled prefix="৳" align="end" />
+                                }
+                              >
+                                <MoneyInput
+                                  id={costField.name}
+                                  name={costField.name}
+                                  ref={costField.ref}
+                                  scale={4}
+                                  placeholder={t('stockLines.atAverage')}
+                                  value={costField.value ?? ''}
+                                  onChange={costField.onChange}
+                                  onBlur={costField.onBlur}
+                                  invalid={fieldState.error !== undefined}
+                                />
+                              </Suspense>
+                              {lineValue !== null && (
+                                <span className="text-right text-caption text-ink-3 tabular-nums">
+                                  {t('stockLines.lineValue', { amount: value(lineValue) })}
+                                </span>
+                              )}
+                            </LineField>
+                          );
+                        }}
+                      />
+                    ) : undefined
+                  }
                   errors={{
                     unitId: lineErrors?.unitId?.message,
                     quantity: lineErrors?.quantity?.message,
@@ -409,6 +480,15 @@ export function AdjustmentForm({
                 />
               );
             })}
+          {costed && fields.length > 0 && (
+            <div className="grid gap-1 border-t border-line bg-subtle px-5 py-3 text-body-sm">
+              <span className="flex items-center justify-between gap-3">
+                <span className="font-medium">{t('stockLines.total')}</span>
+                <span className="font-medium tabular-nums">{value(totalValue)}</span>
+              </span>
+              <span className="text-caption text-ink-3">{t('adjustments.costHint')}</span>
+            </div>
+          )}
           {linesError && (
             <div className="border-t border-line px-5 py-3">
               <FormAlert message={linesError} />
```

- **The cost box is loaded lazily** (`cost-input.tsx`). `MoneyInput` brings decimal.js, about 13 KB gz; with it
  inside, the form's chunk measured 102.2 KB (budget 100). `lazy()` needs a module to import, and this small
  one gives the bundler the place to split: the measured result is a 23.9 KB chunk of its own. Until it arrives, the same box shows empty and disabled (`Suspense`'s fallback), so
  nothing jumps. The form is 89.5 KB now.
- **The cost box is a `MoneyInput` with `scale={4}`** (a unit cost may have 4 decimals: ৳0.8512), controlled by
  `Controller` because `MoneyInput` reports a canonical string, not an input event.
- **Its label names the line's unit** ("Cost per case"): the same quantity of the same item can be typed in
  cartons or in pieces, and the cost follows the unit.
- **The placeholder says "At average cost"**: an empty box is a real answer (decision 11), not a missing one.
- **`typedValue()` shows "= ৳3,600.00" under the box**, and the total below the lines, from what is typed — before
  saving, with the same `multiplyMoney()` the API uses, so the preview and the posted value are the same number.
- **Only "Stock in" shows the column.** Switching to "Stock out" hides it; the API ignores a cost on an out line
  anyway.

### The documents: values and their entries

`apps/app/src/components/stock-lines-table.tsx` (changed):

```diff
@@ -1,14 +1,26 @@
 import { Alert02Icon } from '@hugeicons/core-free-icons';
 import {
+  type AdjustmentLine,
   compareQuantity,
-  type StockLine,
+  subtractMoney,
   subtractQuantity,
+  sumMoney,
   type TransferLine,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Card, Pill } from '@omnivo/ui';
 
-import { useIsoDate, useQuantity, VariantCell } from './stock-parts';
+import { useIsoDate, useQuantity, useUnitCode, useValue, VariantCell } from './stock-parts';
+
+// Step 14: what a line was worth (null without inventory.stock.value), and on an adjustment the
+// cost a person typed. Read from either kind of line.
+function valueOf(line: AdjustmentLine | TransferLine): string | null {
+  return line.value;
+}
+
+function typedCostOf(line: AdjustmentLine | TransferLine): string | null {
+  return 'unitCost' in line ? line.unitCost : null;
+}
 
 // The lines of a posted adjustment or a sent transfer: a real <table> in a card, scrolling inside
 // its own box on a phone. What was typed (3 case), the base quantity it was (72 pcs), the batch
@@ -17,12 +29,19 @@ export function StockLinesTable({
   lines,
   received = false,
 }: {
-  lines: readonly (StockLine | TransferLine)[];
+  lines: readonly (AdjustmentLine | TransferLine)[];
   received?: boolean;
 }) {
   const { t } = useLocale();
   const quantity = useQuantity();
   const isoDate = useIsoDate();
+  const money = useValue();
+  const unitCode = useUnitCode();
+  // The value column, when there is something to show in it: someone without the permission sees
+  // a typed cost only, and a draft has no values yet
+  const valued = lines.some((line) => valueOf(line) !== null || typedCostOf(line) !== null);
+  const total = sumMoney(lines.map((line) => valueOf(line) ?? '0'));
+  const anyValue = lines.some((line) => valueOf(line) !== null);
   return (
     <Card className="overflow-x-auto">
       <table className="w-full min-w-[640px] border-collapse text-body-sm">
@@ -43,6 +62,11 @@ export function StockLinesTable({
                 {t('transfers.receivedQuantity')}
               </th>
             )}
+            {valued && (
+              <th scope="col" className="px-5 py-2.5 text-right">
+                {t('stockLines.value')}
+              </th>
+            )}
           </tr>
         </thead>
         <tbody>
@@ -98,12 +122,45 @@ export function StockLinesTable({
                         </Pill>
                       </span>
                     )}
+                    {short !== null &&
+                      'receivedValue' in line &&
+                      line.value !== null &&
+                      line.receivedValue !== null && (
+                        <span className="mt-1 block text-caption text-ink-3">
+                          {t('transfers.lostValue', {
+                            amount: money(subtractMoney(line.value, line.receivedValue)),
+                          })}
+                        </span>
+                      )}
+                  </td>
+                )}
+                {valued && (
+                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
+                    {money(valueOf(line))}
+                    {typedCostOf(line) !== null && (
+                      <span className="block text-caption text-ink-3">
+                        {t('stockLines.unitCostPer', { unit: unitCode(line.unitId) })}{' '}
+                        {money(typedCostOf(line))}
+                      </span>
+                    )}
                   </td>
                 )}
               </tr>
             );
           })}
         </tbody>
+        {anyValue && (
+          <tfoot>
+            <tr className="border-t border-line bg-subtle font-medium">
+              <td className="px-5 py-3" colSpan={received ? 4 : 3}>
+                {t('stockLines.total')}
+              </td>
+              <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
+                {money(total)}
+              </td>
+            </tr>
+          </tfoot>
+        )}
       </table>
     </Card>
   );
```

`apps/app/src/components/entry-links.tsx` (new):

```tsx
import type { EntryRef } from '@omnivo/contracts';
import { Link } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';

// The journal entries a stock document made (step 14), in a fact cell: a link to each for someone
// who reads the journal, the plain numbers for everyone else (the journal page would refuse them)
export function EntryLinks({
  label,
  entries,
  none,
}: {
  label: string;
  entries: readonly EntryRef[];
  none: string;
}) {
  const canRead = useCan()('accounting.journal.read');
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-caption font-medium text-ink-3">{label}</span>
      {entries.length === 0 ? (
        <span className="text-body-sm text-ink-3">{none}</span>
      ) : (
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-body-sm">
          {entries.map((entry) =>
            canRead ? (
              <Link
                key={entry.id}
                to="/journal/$entryId"
                params={{ entryId: entry.id }}
                className="font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
              >
                {entry.number}
              </Link>
            ) : (
              <span key={entry.id} className="font-mono tabular-nums">
                {entry.number}
              </span>
            ),
          )}
        </span>
      )}
    </div>
  );
}
```

`apps/app/src/components/adjustment-view.tsx` (changed):

```diff
@@ -2,6 +2,7 @@ import { isAdjustmentDirection, isAdjustmentReason, type StockAdjustment } from
 import { useLocale } from '@omnivo/i18n';
 import { Card, PageHeader } from '@omnivo/ui';
 
+import { EntryLinks } from './entry-links';
 import { StockLinesTable } from './stock-lines-table';
 import {
   AdjustmentStatusPill,
@@ -37,6 +38,13 @@ export function AdjustmentView({ adjustment }: { adjustment: StockAdjustment })
           value={warehouseLabel(byId.get(adjustment.warehouseId))}
         />
         {adjustment.note !== null && <Fact label={t('adjustments.note')} value={adjustment.note} />}
+        {adjustment.status === 'posted' && (
+          <EntryLinks
+            label={t('adjustments.entry')}
+            entries={adjustment.entry ? [adjustment.entry] : []}
+            none={t('adjustments.noEntry')}
+          />
+        )}
       </Card>
       <StockLinesTable lines={adjustment.lines} />
     </div>
```

`apps/app/src/components/transfer-view.tsx` (changed):

```diff
@@ -27,6 +27,7 @@ import { applyApiError } from '../lib/field-errors';
 import { rowPath } from '../lib/products';
 import { firstMessage } from '../lib/stock';
 import { Fact } from './adjustment-view';
+import { EntryLinks } from './entry-links';
 import { LineField } from './journal-parts';
 import { SerialNumbersInput } from './serial-numbers-input';
 import { StockLinesTable } from './stock-lines-table';
@@ -70,6 +71,9 @@ export function TransferView({
           <Fact label={t('transfers.receiveDate')} value={isoDate(transfer.receivedOn)} />
         )}
         {transfer.note !== null && <Fact label={t('transfers.note')} value={transfer.note} />}
+        {transfer.status !== 'draft' && (
+          <EntryLinks label={t('transfers.entries')} entries={transfer.entries} none="—" />
+        )}
       </Card>
       {transfer.status === 'in_transit' && canReceive ? (
         <ReceiveForm transfer={transfer} today={today} warehouse={to} />
```

- **The value column shows when there is something in it**: someone without the permission still sees the cost
  they or a colleague typed, but no value; a draft has neither.
- **A short line shows what was lost** ("Lost ৳210.00") under its "Short by 4 pcs" pill.
- **`EntryLinks` links an entry only for someone who reads the journal**; everyone else sees the number as text,
  instead of a link to a page that would refuse them.

### The journal entry: where it came from

`apps/app/src/components/journal-entry-view.tsx` (changed):

```diff
@@ -6,6 +6,7 @@ import {
   type Branch,
   contractErrorMap,
   isJournalSource,
+  isStockJournalSource,
   type JournalEntry,
   reverseJournalEntryInputSchema,
   routes,
@@ -101,6 +102,22 @@ function ReverseForm({
 }
 
 // A posted entry (read only, with Reverse), or a draft for someone who may post but not edit
+// The stock document a stock entry came from (step 14): its page, by the entry's source
+function documentLinkOf(entry: JournalEntry) {
+  const id = entry.document?.id;
+  if (id === undefined) return null;
+  if (entry.source === 'stock_adjustment') {
+    return { to: '/stock/adjustments/$adjustmentId', params: { adjustmentId: id } } as const;
+  }
+  if (entry.source === 'stock_transfer') {
+    return { to: '/stock/transfers/$transferId', params: { transferId: id } } as const;
+  }
+  if (entry.source === 'stock_revaluation') {
+    return { to: '/stock/revaluations/$revaluationId', params: { revaluationId: id } } as const;
+  }
+  return null;
+}
+
 export function EntryView({
   entry,
   accounts,
@@ -131,13 +148,17 @@ export function EntryView({
     },
   });
 
-  // A closing entry is undone by reopening its year (the Year-end close page), not from here
+  // A closing entry is undone by reopening its year (the Year-end close page), and a stock
+  // document's entry by another stock document (step 14) — not from here
+  const fromStock = isStockJournalSource(entry.source);
   const canReverse =
     canPost &&
     entry.status === 'posted' &&
     entry.reversedBy === null &&
     entry.source !== 'reversal' &&
-    entry.source !== 'year_close';
+    entry.source !== 'year_close' &&
+    !fromStock;
+  const documentLink = documentLinkOf(entry);
   const failure = failureOf(post.error);
   const amount = (value: string) =>
     value === '0.0000' ? '' : format.money(value, { decimals: 2 });
@@ -198,7 +219,16 @@ export function EntryView({
             {t('journal.reversedBy', { number: entry.reversedBy.number })}
           </Link>
         )}
+        {documentLink && (
+          <Link
+            {...documentLink}
+            className="font-medium text-brand underline-offset-3 hover:underline"
+          >
+            {t('journal.fromDocument', { document: entry.document?.number ?? '' })}
+          </Link>
+        )}
       </div>
+      {fromStock && <p className="text-label text-ink-3">{t('journal.stockEntryHint')}</p>}
       {entry.narration && <p className="text-body text-ink">{entry.narration}</p>}
       {/* A plain table in its own scroll box: four columns, a handful of rows, a totals row */}
       <Card className="overflow-x-auto">
```

- **"From ADJ-2026-27-0002"** links to the document; `documentLinkOf()` picks the page from the entry's source.
  `as const` keeps each `to` a literal route, so TanStack Router checks its `params`.
- **No Reverse button for a stock entry**, and a line under the header that says why and what to do instead.

### The stock pages

`apps/app/src/routes/stock.tsx` (changed):

```diff
@@ -78,10 +78,12 @@ function StockStatus({ item }: { item: StockItem }) {
 }
 
 export function StockPage() {
-  const { t } = useLocale();
+  const { t, format } = useLocale();
   const navigate = useNavigate();
   const tenantId = useTenantId();
   const can = useCan();
+  // Step 14: what the stock is worth, for the people who may see costs
+  const canSeeValues = can('inventory.stock.value');
   const quantity = useQuantity();
   const { active } = useWarehouses();
   const [search, setSearch] = useState('');
@@ -131,6 +133,22 @@ export function StockPage() {
               </span>
             ),
         }),
+        ...(canSeeValues
+          ? [
+              // A list: whole taka, like every list and dashboard (CLAUDE.md → Money)
+              column.accessor('value', {
+                header: t('stock.columns.value'),
+                enableSorting: false,
+                meta: { align: 'end', card: 'detail' },
+                cell: ({ row }) =>
+                  row.original.value === null ? (
+                    <span className="text-ink-3">—</span>
+                  ) : (
+                    <span className="tabular-nums">{format.money(row.original.value)}</span>
+                  ),
+              }),
+            ]
+          : []),
         column.display({
           id: 'status',
           header: t('stock.columns.status'),
@@ -138,7 +156,7 @@ export function StockPage() {
           cell: ({ row }) => <StockStatus item={row.original} />,
         }),
       ]),
-    [t, quantity],
+    [t, format, quantity, canSeeValues],
   );
 
   const empty =
```

`apps/app/src/routes/stock-card.tsx` (changed):

```diff
@@ -48,11 +48,14 @@ const ReorderLevelForm = lazy(async () => ({
 }));
 
 export function StockCardPage() {
-  const { t } = useLocale();
+  const { t, format } = useLocale();
   const navigate = useNavigate();
   const { variantId = '' } = useParams({ strict: false });
   const tenantId = useTenantId();
-  const canSetLevels = useCan()('inventory.product.manage');
+  const can = useCan();
+  const canSetLevels = can('inventory.product.manage');
+  // Step 14: what it costs, for the people who may see it
+  const canSeeValues = can('inventory.stock.value');
   const quantity = useQuantity();
   const isoDate = useIsoDate();
   const today = useToday();
@@ -138,8 +141,22 @@ export function StockCardPage() {
           <span className="font-medium">{quantity(getValue(), baseUnitId)}</span>
         ),
       }),
+      ...(canSeeValues
+        ? [
+            // Signed like the quantity: what each movement added to or took from the stock's value
+            column.accessor('value', {
+              header: t('stock.history.value'),
+              enableSorting: false,
+              meta: { align: 'end', card: 'detail' },
+              cell: ({ getValue }) => {
+                const value = getValue();
+                return value === null ? '—' : format.money(value, { decimals: 2 });
+              },
+            }),
+          ]
+        : []),
     ]);
-  }, [t, quantity, isoDate, byId, baseUnitId]);
+  }, [t, format, quantity, isoDate, byId, baseUnitId, canSeeValues]);
 
   if (isError) {
     return (
@@ -171,7 +188,19 @@ export function StockCardPage() {
         cells={[
           { label: t('stock.kpis.onHand'), value: quantity(item.onHand, item.baseUnitId) },
           { label: t('stock.kpis.inTransit'), value: quantity(item.inTransit, item.baseUnitId) },
-          { label: t('stock.kpis.places'), value: String(places) },
+          // With the permission, what it costs takes the place of "warehouses with stock"
+          ...(item.value === null
+            ? [{ label: t('stock.kpis.places'), value: String(places) }]
+            : [
+                {
+                  label: t('stock.kpis.unitCost'),
+                  value:
+                    item.unitCost === null
+                      ? t('stock.noCost')
+                      : format.money(item.unitCost, { decimals: 2 }),
+                },
+                { label: t('stock.kpis.value'), value: format.money(item.value) },
+              ]),
         ]}
       />
 
@@ -372,6 +401,8 @@ export function StockCardPage() {
                 void navigate({ to: route, params: { adjustmentId: movement.documentId } });
               } else if (route === '/stock/transfers/$transferId') {
                 void navigate({ to: route, params: { transferId: movement.documentId } });
+              } else if (route === '/stock/revaluations/$revaluationId') {
+                void navigate({ to: route, params: { revaluationId: movement.documentId } });
               }
             }}
             onEndReached={loadMore}
```

- **The value columns exist only with the permission.** Without it, the API would send `null` anyway; leaving the
  column out keeps a cashier's list as it was.
- **The stock card's KPI strip swaps "Warehouses with stock" for the average cost and the value**, so the strip
  stays one row on a laptop.
- **The list shows whole taka; the card's history and the documents show paisa** (CLAUDE.md → Money: lists and
  dashboards without decimals, accounting documents with 2).

### The valuation page

`apps/app/src/routes/stock-valuation.tsx` (new):

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  MoneyExchange01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { absMoney, isZeroMoney, sumMoney, type StockValue } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  KpiStrip,
  PageHeader,
  Pill,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { useQuantity, useTenantId, VariantCell } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import {
  accountsQuery,
  productCategoriesQuery,
  stockValuationQuery,
  valuationSummaryQuery,
} from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';

const column = dataTableColumns<StockValue>();

// What the stock is worth (step 14): the total in the warehouses and on the road, each variant at
// its average cost, and the check that matters to an accountant — the inventory and goods in
// transit accounts say the same. Every stock document posts both sides at once, so they agree;
// a difference means something reached those accounts another way (an opening balance from
// before step 14).
export function StockValuationPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const can = useCan();
  const quantity = useQuantity();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const settled = useDebounced(search.trim());
  const summary = useQuery(valuationSummaryQuery(tenantId)).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const categories = useQuery(productCategoriesQuery(tenantId)).data;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockValuationQuery(tenantId, { search: settled, categoryId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('productName', {
          header: t('valuation.columns.product'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => <VariantCell item={row.original} />,
        }),
        column.accessor('quantity', {
          header: t('valuation.columns.quantity'),
          enableSorting: false,
          meta: { align: 'end', card: 'subtitle' },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {quantity(row.original.quantity, row.original.baseUnitId)}
            </span>
          ),
        }),
        column.accessor('unitCost', {
          header: t('valuation.columns.unitCost'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A unit price: with paisa (CLAUDE.md → Money)
          cell: ({ getValue }) => {
            const cost = getValue();
            return cost === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="tabular-nums">{format.money(cost, { decimals: 2 })}</span>
            );
          },
        }),
        column.accessor('value', {
          header: t('valuation.columns.value'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => (
            <span className="font-medium tabular-nums">{format.money(getValue())}</span>
          ),
        }),
      ]),
    [t, format, quantity],
  );

  const nameOf = (id: string | undefined) => {
    const account = accounts?.find((row) => row.id === id);
    return account ? `${account.code} ${account.name}` : t('valuation.noInTransitAccount');
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('valuation.title')}
        description={t('valuation.description')}
        actions={
          can('inventory.stock.revalue') && (
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: '/stock/revaluations/new' })}
            >
              <HugeiconsIcon icon={MoneyExchange01Icon} size={17} strokeWidth={1.5} />
              {t('valuation.revalue')}
            </Button>
          )
        }
      />
      {summary && (
        <>
          <KpiStrip
            cells={[
              { label: t('valuation.kpis.stock'), value: format.money(summary.stockValue) },
              { label: t('valuation.kpis.inTransit'), value: format.money(summary.inTransitValue) },
              {
                label: t('valuation.kpis.total'),
                value: format.money(sumMoney([summary.stockValue, summary.inTransitValue])),
              },
              {
                label: t('valuation.kpis.books'),
                value: format.money(
                  sumMoney([
                    summary.inventoryAccount?.balance ?? '0',
                    summary.inTransitAccount?.balance ?? '0',
                  ]),
                ),
                sub: t('valuation.booksHint', {
                  inventory: nameOf(summary.inventoryAccount?.id),
                  inTransit: nameOf(summary.inTransitAccount?.id),
                }),
              },
            ]}
          />
          <div>
            {isZeroMoney(summary.difference) ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('valuation.booksAgree')}
              </Pill>
            ) : (
              <Pill tone="crit" icon={Alert02Icon}>
                {t('valuation.booksOutBy', {
                  amount: format.money(absMoney(summary.difference), { decimals: 2 }),
                })}
              </Pill>
            )}
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('valuation.searchLabel')}
            placeholder={t('valuation.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="w-full sm:w-56">
          <Select
            aria-label={t('valuation.category')}
            value={categoryId}
            options={[
              { value: '', label: t('valuation.allCategories') },
              ...categoryOptions(categories ?? []),
            ]}
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
          />
        </div>
      </div>
      {isError && <p className="text-body-sm text-crit">{t('valuation.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('valuation.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.variantId}
          onRowClick={(row) =>
            void navigate({ to: '/stock/$variantId', params: { variantId: row.variantId } })
          }
          onEndReached={loadMore}
          empty={
            settled === '' ? (
              <EmptyState
                icon={Coins01Icon}
                title={t('valuation.emptyTitle')}
                description={t('valuation.emptyBody')}
              />
            ) : (
              <EmptyState
                icon={Search01Icon}
                title={t('valuation.noMatchTitle', { query: settled })}
                description={t('valuation.noMatchBody')}
              />
            )
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

- **Four KPIs**: in the warehouses, in transit, their sum, and the books — with the two accounts it read named
  under it, so an accountant knows exactly where to look in the trial balance.
- **"Books agree" or "Out by ৳x"**, a pill with its icon and words (never colour alone).
- **Search and category, no warehouse filter**: the value is company-wide (decision 1); a warehouse's share is on
  the stock list.
- **A row opens the item's stock card**, where its movements and their values are.

### Revaluations

`apps/app/src/routes/stock-revaluations.tsx` (new):

```tsx
import { MoneyExchange01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { StockRevaluationSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DataTable, dataTableColumns, EmptyState, PageHeader } from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useIsoDate, useTenantId } from '../components/stock-parts';
import { stockRevaluationsQuery } from '../lib/queries';

const column = dataTableColumns<StockRevaluationSummary>();

// Every revaluation, newest first. The route needs inventory.stock.revalue (the API refuses the
// list without it), and the nav shows it only then.
export function StockRevaluationsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    stockRevaluationsQuery(useTenantId()),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('revaluations.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor('lineCount', {
          header: t('revaluations.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'subtitle' },
          cell: ({ getValue }) => t('revaluations.lineCount', { count: getValue() }),
        }),
        column.accessor('difference', {
          header: t('revaluations.columns.difference'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => (
            <span className="font-medium tabular-nums">{format.money(getValue())}</span>
          ),
        }),
      ]),
    [t, format, isoDate],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('revaluations.title')}
        description={t('revaluations.description')}
        actions={
          <Button onClick={() => void navigate({ to: '/stock/revaluations/new' })}>
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('revaluations.new')}
          </Button>
        }
      />
      {isError && <p className="text-body-sm text-crit">{t('revaluations.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('revaluations.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({
              to: '/stock/revaluations/$revaluationId',
              params: { revaluationId: row.id },
            })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={MoneyExchange01Icon}
              title={t('revaluations.emptyTitle')}
              description={t('revaluations.emptyBody')}
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

`apps/app/src/routes/stock-revaluation.tsx` (new):

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink, useTenantId, useToday } from '../components/stock-parts';
import { stockRevaluationQuery, unitsQuery } from '../lib/queries';

// Like an adjustment's page: the data here, the form and the view each a lazy chunk of their own
const RevaluationForm = lazy(async () => ({
  default: (await import('../components/revaluation-form')).RevaluationForm,
}));
const RevaluationView = lazy(async () => ({
  default: (await import('../components/revaluation-view')).RevaluationView,
}));

// The route needs inventory.stock.revalue (the API refuses the rest): the nav only shows it then
export function NewStockRevaluationPage() {
  const today = useToday();
  const units = useQuery(unitsQuery(useTenantId())).data;
  if (units === undefined) return null;
  return (
    <Suspense fallback={null}>
      <RevaluationForm today={today} />
    </Suspense>
  );
}

export function StockRevaluationPage() {
  const { t } = useLocale();
  const { revaluationId = '' } = useParams({ strict: false });
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { data: revaluation, isError } = useQuery({
    ...stockRevaluationQuery(useTenantId(), revaluationId),
    enabled: revaluationId !== '',
  });
  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock/revaluations" label={t('revaluations.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('revaluations.title')}
          description={t('revaluations.notFound')}
        />
      </div>
    );
  }
  if (!revaluation || units === undefined) return null;
  return (
    <Suspense fallback={null}>
      <RevaluationView revaluation={revaluation} />
    </Suspense>
  );
}
```

`apps/app/src/components/revaluation-form.tsx` (new):

```tsx
import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  compareQuantity,
  contractErrorMap,
  multiplyMoney,
  routes,
  type StockItem,
  type StockRevaluationFormValues,
  stockRevaluationInputSchema,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  Dialog,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  TextField,
  toast,
} from '@omnivo/ui';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { ItemPicker } from './item-picker';
import { LineField } from './journal-parts';
import {
  BackLink,
  useQuantity,
  useStockRefresh,
  useUnitCode,
  useValue,
  VariantCell,
} from './stock-parts';

// Revaluing stock (step 14): its own chunk, loaded by routes/stock-revaluation.tsx. One line per
// item: what it has now (its stock and average cost, company-wide), the new cost per base unit, and
// the difference that will go to the books. Posted when it is saved.

type FormValues = StockRevaluationFormValues;

// One template for the header and every row on a wide card: the item, its cost now, the new cost,
// the new value, the difference, remove (CLAUDE.md → Stock line rows)
const COLUMNS = '@3xl:grid-cols-[minmax(0,2fr)_8rem_10rem_9rem_9rem_2.25rem] @3xl:items-start';

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'date',
    'note',
    'lines',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitCost'),
    ]).flat(),
  ];
}

export function RevaluationForm({ today }: { today: string }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const quantity = useQuantity();
  const unitCode = useUnitCode();
  const value = useValue();
  const [picking, setPicking] = useState(false);
  // What each line's item is (its stock and cost now), by variant: the form holds only what is sent
  const [items, setItems] = useState<ReadonlyMap<string, StockItem>>(new Map());
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(stockRevaluationInputSchema, { error: contractErrorMap }),
    defaultValues: { date: today, note: '', lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });

  // The difference each line will post: stock × new cost − its value now. Not yet typed = nothing.
  const differenceOf = (index: number): string | null => {
    const line = lines[index];
    const item = line ? items.get(line.variantId) : undefined;
    if (!line || !item || line.unitCost === '') return null;
    return subtractMoney(multiplyMoney(item.onHand, line.unitCost), item.value ?? '0');
  };
  const total = sumMoney(fields.map((_, index) => differenceOf(index) ?? '0'));

  const save = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.stockRevaluations.create, { body: values });
      await refresh();
      toast(t('revaluations.posted', { number: saved.number }));
      void navigate({
        to: '/stock/revaluations/$revaluationId',
        params: { revaluationId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(lines.length), setError);
    }
  });

  const failure = errors.root?.server?.message;
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/revaluations" label={t('revaluations.back')} />
      <PageHeader title={t('revaluations.newTitle')} description={t('revaluations.description')} />
      <form noValidate onSubmit={(event) => void save(event)} className="grid grid-cols-1 gap-5">
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
          <FormField control={control} name="date" label={t('revaluations.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <TextField
            label={t('revaluations.note')}
            optional
            placeholder={t('revaluations.notePlaceholder')}
            {...register('note')}
            error={errors.note?.message}
          />
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('revaluations.noLines')}</p>
          ) : (
            <div
              aria-hidden="true"
              className={cn(
                'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
                COLUMNS,
              )}
            >
              <span>{t('revaluations.lineColumns.product')}</span>
              <span className="text-right">{t('revaluations.lineColumns.oldCost')}</span>
              <span className="text-right">{t('revaluations.lineColumns.newCost')}</span>
              <span className="text-right">{t('revaluations.lineColumns.newValue')}</span>
              <span className="text-right">{t('revaluations.lineColumns.difference')}</span>
            </div>
          )}
          {fields.map((field, index) => {
            const item = items.get(field.variantId);
            if (!item) return null;
            const number = index + 1;
            const costPath = rowPath('lines', index, 'unitCost');
            const line = lines[index];
            const newValue =
              line && line.unitCost !== '' ? multiplyMoney(item.onHand, line.unitCost) : null;
            const lineErrors = errors.lines?.[index];
            const removeButton = (
              <IconButton
                icon={Delete02Icon}
                label={t('revaluations.remove', { number })}
                onClick={() => {
                  remove(index);
                  setItems((before) => {
                    const next = new Map(before);
                    next.delete(field.variantId);
                    return next;
                  });
                }}
              />
            );
            return (
              <div
                key={field.id}
                role="group"
                aria-label={t('revaluations.line', { number })}
                className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
              >
                <div className="col-span-2 flex items-start justify-between gap-3 @3xl:col-span-1">
                  <span className="grid min-w-0 gap-0.5">
                    <VariantCell item={item} />
                    <span className="text-caption text-ink-3 tabular-nums">
                      {compareQuantity(item.onHand, '0') > 0
                        ? quantity(item.onHand, item.baseUnitId)
                        : t('revaluations.noStock')}
                    </span>
                    {lineErrors?.variantId?.message && (
                      <span className="text-caption text-crit">{lineErrors.variantId.message}</span>
                    )}
                  </span>
                  <span className="@3xl:hidden">{removeButton}</span>
                </div>
                <div className="grid content-start gap-1.5 text-right">
                  <span className="text-label font-medium text-ink @3xl:sr-only">
                    {t('revaluations.lineColumns.oldCost')}
                  </span>
                  <span className="pt-2.5 text-body-sm tabular-nums">{value(item.unitCost)}</span>
                </div>
                <Controller
                  control={control}
                  name={costPath}
                  render={({ field: costField, fieldState }) => (
                    <LineField
                      id={costField.name}
                      label={t('revaluations.newCostPer', { unit: unitCode(item.baseUnitId) })}
                      error={fieldState.error?.message}
                    >
                      <MoneyInput
                        id={costField.name}
                        name={costField.name}
                        ref={costField.ref}
                        scale={4}
                        value={costField.value}
                        onChange={costField.onChange}
                        onBlur={costField.onBlur}
                        invalid={fieldState.error !== undefined}
                      />
                    </LineField>
                  )}
                />
                <div className="grid content-start gap-1.5 text-right">
                  <span className="text-label font-medium text-ink @3xl:sr-only">
                    {t('revaluations.lineColumns.newValue')}
                  </span>
                  <span className="pt-2.5 text-body-sm tabular-nums">{value(newValue)}</span>
                </div>
                <div className="grid content-start gap-1.5 text-right">
                  <span className="text-label font-medium text-ink @3xl:sr-only">
                    {t('revaluations.lineColumns.difference')}
                  </span>
                  <span className="pt-2.5 text-body-sm font-medium tabular-nums">
                    {value(differenceOf(index))}
                  </span>
                </div>
                <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
              </div>
            );
          })}
          {fields.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-subtle px-5 py-3 text-body-sm">
              <span className="font-medium">{t('stockLines.total')}</span>
              <span className="font-medium tabular-nums">{value(total)}</span>
            </div>
          )}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPicking(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('stockLines.addItems')}
            </Button>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" disabled={isSubmitting || fields.length === 0}>
            {isSubmitting ? t('revaluations.posting') : t('revaluations.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('revaluations.postHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId=""
            allowArchived
            onAdd={(item) => {
              // One line per item: adding it again does nothing (the API refuses a second line)
              if (items.has(item.variantId)) return;
              setItems((before) => new Map(before).set(item.variantId, item));
              append({ variantId: item.variantId, unitCost: '' });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

`apps/app/src/components/revaluation-view.tsx` (new):

```tsx
import type { StockRevaluation } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';

import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { BackLink, useIsoDate, useQuantity, useValue, VariantCell } from './stock-parts';

// A posted revaluation, read only: it never changes. Each line: the stock it had then, its value
// before and after, and the difference that went to the books.
export function RevaluationView({ revaluation }: { revaluation: StockRevaluation }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const value = useValue();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/revaluations" label={t('revaluations.back')} />
      <PageHeader title={revaluation.number} description={t('revaluations.description')} />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('revaluations.date')} value={isoDate(revaluation.date)} />
        {revaluation.note !== null && (
          <Fact label={t('revaluations.note')} value={revaluation.note} />
        )}
        <EntryLinks
          label={t('revaluations.entry')}
          entries={revaluation.entry ? [revaluation.entry] : []}
          none={t('revaluations.noEntry')}
        />
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-body-sm">
          <caption className="sr-only">{t('stockLines.items')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('revaluations.lineColumns.product')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.oldValue')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.newCost')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.newValue')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.difference')}
              </th>
            </tr>
          </thead>
          <tbody>
            {revaluation.lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <VariantCell item={line} />
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.baseUnitId)}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {value(line.oldValue)}
                  <span className="block text-caption text-ink-3">{value(line.oldUnitCost)}</span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {value(line.unitCost)}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {value(line.newValue)}
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {value(line.difference)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-subtle font-medium">
              <td className="px-5 py-3" colSpan={5}>
                {t('stockLines.total')}
              </td>
              <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                {value(revaluation.difference)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}
```

- **The form shows each item's stock and cost now**, from the "Add items" search (all warehouses: `warehouseId=""`),
  and works out the new value and the difference as the cost is typed — the same arithmetic as the API.
- **An item can be added once.** Removing its line forgets it, so it can be added again.
- **The rows are a container (`@container`)** with one grid template for the header and every row on a wide card,
  and their own labels on a narrow one (CLAUDE.md → Stock line rows).
- **The view keeps the value before and after** on every line, with the cost before under the value before.

### Settings → Inventory: the stock accounts

`apps/app/src/components/stock-accounts-card.tsx` (new):

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  accountTypeFits,
  contractErrorMap,
  routes,
  STOCK_ACCOUNT_USES,
  type StockAccounts,
  type StockAccountsFormValues,
  type StockAccountUse,
  updateStockAccountsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { accountsQuery, stockAccountsQuery } from '../lib/queries';

// Settings → Inventory, step 14: where stock documents post in the books. Its own form and save
// button: the choices are saved by their own endpoint, apart from the company settings above.
const GROUPS: readonly {
  key: 'adjustments' | 'transfers' | 'revaluation';
  uses: StockAccountUse[];
}[] = [
  {
    key: 'adjustments',
    uses: ['found', 'damaged', 'expired', 'lost', 'sample', 'internal_use', 'correction'],
  },
  { key: 'transfers', uses: ['in_transit', 'transfer_shortage'] },
  { key: 'revaluation', uses: ['revaluation'] },
];

function toForm(choices: StockAccounts): StockAccountsFormValues {
  return {
    in_transit: choices.in_transit ?? '',
    found: choices.found ?? '',
    damaged: choices.damaged ?? '',
    expired: choices.expired ?? '',
    lost: choices.lost ?? '',
    sample: choices.sample ?? '',
    internal_use: choices.internal_use ?? '',
    correction: choices.correction ?? '',
    transfer_shortage: choices.transfer_shortage ?? '',
    revaluation: choices.revaluation ?? '',
  };
}

function label(account: Account | undefined): string {
  return account ? `${account.code} · ${account.name}` : '—';
}

export function StockAccountsCard({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const choices = useQuery(stockAccountsQuery(tenantId)).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  if (!choices || !accounts) return null;
  // key: a saved form comes back with the new choices, and starts from them again
  return (
    <StockAccountsForm
      key={JSON.stringify(choices)}
      tenantId={tenantId}
      choices={choices}
      accounts={accounts}
      canManage={canManage}
    />
  );
}

function StockAccountsForm({
  tenantId,
  choices,
  accounts,
  canManage,
}: {
  tenantId: string;
  choices: StockAccounts;
  accounts: readonly Account[];
  canManage: boolean;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStockAccountsInputSchema, { error: contractErrorMap }),
    defaultValues: toForm(choices),
  });
  const inventory = accounts.find((account) => account.purpose === 'inventory');
  const equity = accounts.find((account) => account.purpose === 'opening_balance_equity');
  const missing = STOCK_ACCOUNT_USES.some((use) => choices[use] === null);

  // What each use may point at, like the API: an active ledger of a type that fits, never the
  // inventory account. The current choice stays in the list even if it no longer fits (archived
  // since), so the select shows it instead of silently moving to the first option.
  const optionsFor = (use: StockAccountUse) => [
    { value: '', label: t('settings.stockAccountPlaceholder') },
    ...accounts
      .filter(
        (account) =>
          account.id === choices[use] ||
          (!account.isGroup &&
            account.archivedAt === null &&
            account.purpose !== 'inventory' &&
            accountTypeFits(use, account.type)),
      )
      .toSorted((a, b) => a.code.localeCompare(b.code))
      .map((account) => ({ value: account.id, label: label(account) })),
  ];

  const save = handleSubmit(async (values) => {
    try {
      await call(routes.stockAccounts.update, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['stock-accounts', tenantId] });
      toast(t('settings.stockAccountsSaved'));
    } catch (error) {
      applyApiError(error, [...STOCK_ACCOUNT_USES], setError);
    }
  });

  return (
    <Card>
      <CardHeader
        title={t('settings.stockAccountsTitle')}
        subtitle={t('settings.stockAccountsSubtitle', {
          inventory: label(inventory),
          equity: label(equity),
        })}
      />
      <form noValidate onSubmit={(event) => void save(event)} className="grid gap-5 p-5">
        {missing && <FormAlert message={t('settings.stockAccountsMissing')} />}
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {GROUPS.map((group) => (
          <fieldset key={group.key} className="grid gap-4" disabled={!canManage}>
            <legend className="mb-3 text-caption font-medium text-ink-3">
              {t(`settings.stockAccountGroups.${group.key}`)}
            </legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
              {group.uses.map((use) => (
                <SelectField
                  key={use}
                  label={t(`settings.stockAccountUses.${use}`)}
                  hint={
                    use === 'in_transit' || use === 'transfer_shortage' || use === 'revaluation'
                      ? t(`settings.stockAccountHints.${use}`)
                      : undefined
                  }
                  options={optionsFor(use)}
                  {...register(use)}
                  error={errors[use]?.message}
                />
              ))}
            </div>
          </fieldset>
        ))}
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? t('common.saving') : t('settings.stockAccountsSave')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
```

`apps/app/src/routes/settings.tsx` (changed):

```diff
@@ -38,6 +38,7 @@ import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { type ChangeEvent, useMemo, useRef } from 'react';
 import { Controller, useForm } from 'react-hook-form';
 
+import { StockAccountsCard } from '../components/stock-accounts-card';
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { settingsQuery } from '../lib/queries';
@@ -406,6 +407,8 @@ export function SettingsPage() {
           {/* key: workspace বদলালে নতুন টেন্যান্টের মান দিয়ে ফর্ম নতুন করে তৈরি; একই টেন্যান্টের
               refetch-এ না — তাহলে লেখার মাঝে ফর্ম মুছে যেত */}
           <SettingsForm key={tenantId} settings={data} canManage={canManage} />
+          {/* Step 14: where stock documents post — its own form, saved by its own endpoint */}
+          <StockAccountsCard key={`stock-${tenantId}`} tenantId={tenantId} canManage={canManage} />
         </>
       )}
     </div>
```

- **Its own form, its own save button**: the choices are saved by `PUT /stock-accounts`, apart from the company
  settings above. One button for both would have to call two endpoints, and could half-succeed.
- **Each select lists only accounts that fit its use** (an asset for goods in transit, income or expense for the
  rest; never the inventory account) — plus the current choice, even if it no longer fits, so the select shows it
  instead of quietly jumping to the first option.
- **The subtitle names the two fixed accounts** (inventory, opening balance equity), so nobody looks for them in
  the list.
- **`key={JSON.stringify(choices)}`**: after a save, the form starts again from what the server now has.

### Routes and navigation

`apps/app/src/router.tsx` (changed):

```diff
@@ -294,6 +294,38 @@ const stockBatchesRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/stock-batches'), 'StockBatchesPage'),
 });
 
+// What the stock is worth (step 14): the valuation report and the revaluations. Fixed segments
+// again, so '/stock/valuation' and '/stock/revaluations' beat '/stock/$variantId'.
+const stockValuationRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/valuation',
+  component: lazyRouteComponent(() => import('./routes/stock-valuation'), 'StockValuationPage'),
+});
+
+const stockRevaluationsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/revaluations',
+  component: lazyRouteComponent(
+    () => import('./routes/stock-revaluations'),
+    'StockRevaluationsPage',
+  ),
+});
+
+const newStockRevaluationRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/revaluations/new',
+  component: lazyRouteComponent(
+    () => import('./routes/stock-revaluation'),
+    'NewStockRevaluationPage',
+  ),
+});
+
+const stockRevaluationRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/stock/revaluations/$revaluationId',
+  component: lazyRouteComponent(() => import('./routes/stock-revaluation'), 'StockRevaluationPage'),
+});
+
 const stockReorderRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/stock/reorder',
@@ -374,6 +406,10 @@ const routeTree = rootRoute.addChildren([
     stockTransferRoute,
     stockBatchesRoute,
     stockReorderRoute,
+    stockValuationRoute,
+    stockRevaluationsRoute,
+    newStockRevaluationRoute,
+    stockRevaluationRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
```

`apps/app/src/routes/app-shell.tsx` (changed):

```diff
@@ -5,6 +5,7 @@ import {
   BookOpen02Icon,
   CalendarLock01Icon,
   ChartIncreaseIcon,
+  Coins01Icon,
   DashboardSquare01Icon,
   FileDownloadIcon,
   FileImportIcon,
@@ -14,6 +15,7 @@ import {
   LayoutGridIcon,
   LeftToRightListNumberIcon,
   Logout01Icon,
+  MoneyExchange01Icon,
   Notebook02Icon,
   PackageIcon,
   PackageOutOfStockIcon,
@@ -325,6 +327,17 @@ export function AppShell() {
             <NavLink to="/stock/reorder" icon={PackageOutOfStockIcon}>
               {t('nav.reorder')}
             </NavLink>
+            {/* Step 14: what it costs — only for the people who may see it */}
+            {can('inventory.stock.value') && (
+              <NavLink to="/stock/valuation" icon={Coins01Icon}>
+                {t('nav.valuation')}
+              </NavLink>
+            )}
+            {can('inventory.stock.revalue') && (
+              <NavLink to="/stock/revaluations" icon={MoneyExchange01Icon}>
+                {t('nav.revaluations')}
+              </NavLink>
+            )}
             <NavLink to="/warehouses" icon={WarehouseIcon}>
               {t('nav.warehouses')}
             </NavLink>
```

`/stock/valuation` and `/stock/revaluations` are fixed segments, so they win over `/stock/$variantId` (step 13's
rule). The nav shows them only to people who may open them.

---

## 14.8 — MSW: values in the mocks

The mock API (`pnpm dev:mock` and the Playwright tests) follows the API's rules on plain arrays. It now values
every movement the same way, and its stock documents post to its books, so the mock balance sheet shows the mock
stock.

`apps/app/src/mocks/accounting-data.ts` (changed):

```diff
@@ -4,6 +4,7 @@ import {
   ACCOUNT_TYPES,
   type AccountType,
   type Industry,
+  type StockAccounts,
 } from '@omnivo/contracts';
 
 import { MockProblem } from './mock';
@@ -60,6 +61,7 @@ function template(industry: Industry): Record<AccountType, MockNode> {
             { code: '1140', name: 'Accounts receivable', purpose: 'accounts_receivable' },
             stock,
             { code: '1170', name: 'Input VAT', purpose: 'vat_input' },
+            { code: '1175', name: 'Goods in transit' },
           ],
         },
         {
@@ -121,7 +123,11 @@ function template(industry: Industry): Record<AccountType, MockNode> {
         {
           code: '5100',
           name: 'Cost of sales',
-          children: [{ code: '5110', name: 'Cost of goods sold', purpose: 'cost_of_goods_sold' }],
+          children: [
+            { code: '5110', name: 'Cost of goods sold', purpose: 'cost_of_goods_sold' },
+            ...(garments ? [{ code: '5150', name: 'Stock losses (damaged, expired, lost)' }] : []),
+            { code: '5190', name: 'Stock adjustments and revaluation' },
+          ],
         },
         {
           code: '5200',
@@ -130,6 +136,20 @@ function template(industry: Industry): Record<AccountType, MockNode> {
             { code: '5210', name: 'Salaries and allowances' },
             { code: '5220', name: 'Office rent' },
             { code: '5230', name: 'Utilities (electricity, gas, water)' },
+            { code: '5290', name: 'Consumables and internal use' },
+          ],
+        },
+        {
+          code: '5300',
+          name: 'Selling and distribution expenses',
+          children: [
+            { code: '5310', name: 'Advertising and promotion' },
+            ...(garments
+              ? []
+              : [
+                  { code: '5330', name: 'Medical promotion and samples' },
+                  { code: '5350', name: 'Expired and damaged goods' },
+                ]),
           ],
         },
         { code: '5400', name: 'Finance costs', children: [{ code: '5410', name: 'Bank charges' }] },
@@ -218,3 +238,37 @@ export function assertNotLocked(account: Account): void {
 export function codeOf(accounts: readonly Account[], id: string | null): string | null {
   return accounts.find((account) => account.id === id)?.code ?? null;
 }
+
+// The stock accounts a new workspace starts with (step 14), like the API's template: garments has
+// "Stock losses", pharma its own "Expired and damaged goods" and "Medical promotion and samples"
+export function seedStockAccounts(accounts: readonly Account[], industry: Industry): StockAccounts {
+  const id = (code: string) => accounts.find((account) => account.code === code)?.id ?? null;
+  const loss = industry === 'pharma' ? id('5350') : id('5150');
+  return {
+    in_transit: id('1175'),
+    found: id('5190'),
+    damaged: loss,
+    expired: loss,
+    lost: loss,
+    sample: industry === 'pharma' ? id('5330') : id('5310'),
+    internal_use: id('5290'),
+    correction: id('5190'),
+    transfer_shortage: loss,
+    revaluation: id('5190'),
+  };
+}
+
+export function noStockAccounts(): StockAccounts {
+  return {
+    in_transit: null,
+    found: null,
+    damaged: null,
+    expired: null,
+    lost: null,
+    sample: null,
+    internal_use: null,
+    correction: null,
+    transfer_shortage: null,
+    revaluation: null,
+  };
+}
```

`apps/app/src/mocks/workspace-data.ts` (changed):

```diff
@@ -17,10 +17,11 @@ import {
   periodOf,
   type Settings,
   type Setup,
+  type StockAccounts,
   todayIn,
 } from '@omnivo/contracts';
 
-import { seedAccounts } from './accounting-data';
+import { noStockAccounts, seedAccounts, seedStockAccounts } from './accounting-data';
 import { OWNER, type Workspace } from './fixtures';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
@@ -49,6 +50,8 @@ export interface WorkspaceData {
   catalog: MockCatalog;
   // Warehouses, the stock ledger and its documents (step 13)
   stock: MockStock;
+  // The accounts stock documents post to, besides the inventory account (step 14)
+  stockAccounts: StockAccounts;
 }
 
 function now(): string {
@@ -100,11 +103,13 @@ function seed(workspace: Workspace): WorkspaceData {
     setupReadyAt: null,
     notifications: garments ? seedNotifications() : [],
     accounts: seedAccounts(garments ? 'garments' : 'pharma'),
+    stockAccounts: noStockAccounts(),
     journal: emptyJournal(),
     exports: [],
     catalog: garments ? garmentsCatalog() : pharmaCatalog(),
     stock: emptyStock(),
   };
+  data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   if (garments) seedJournal(data);
   seedStock(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
@@ -161,6 +166,7 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.notifications = [];
   // A new workspace has no chart until its setup job runs (settleSetup)
   data.accounts = [];
+  data.stockAccounts = noStockAccounts();
   data.journal = emptyJournal();
   data.exports = [];
   // Like the chart: the setup job brings the units and categories (settleSetup)
@@ -234,6 +240,7 @@ function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: st
   if (documentType === 'accounting.journal') return data.journal.counters.get(period) ?? 0;
   if (documentType === 'inventory.adjustment') return data.stock.counters.adjustment;
   if (documentType === 'inventory.transfer') return data.stock.counters.transfer;
+  if (documentType === 'inventory.revaluation') return data.stock.counters.revaluation;
   return 0;
 }
 
```

`apps/app/src/mocks/setup-data.ts` (changed):

```diff
@@ -1,6 +1,6 @@
 import type { Industry, Setup } from '@omnivo/contracts';
 
-import { seedAccounts } from './accounting-data';
+import { seedAccounts, seedStockAccounts } from './accounting-data';
 import { MockProblem } from './mock';
 import { startingCatalog } from './product-data';
 import { record, type WorkspaceData } from './workspace-data';
@@ -54,7 +54,10 @@ export function settleSetup(data: WorkspaceData): void {
       updatedAt: new Date().toISOString(),
     });
   }
-  if (data.accounts.length === 0) data.accounts = seedAccounts(industry);
+  if (data.accounts.length === 0) {
+    data.accounts = seedAccounts(industry);
+    data.stockAccounts = seedStockAccounts(data.accounts, industry);
+  }
   if (data.catalog.units.length === 0) data.catalog = startingCatalog(industry);
   data.setup = { status: 'ready', industry };
   data.setupReadyAt = null;
```

`apps/app/src/mocks/journal-data.ts` (changed):

```diff
@@ -1,20 +1,25 @@
 import {
   absMoney,
   addMoney,
+  compareMoney,
   defaultNumberFormat,
+  type EntryRef,
   fiscalYearOf,
   formatDocumentNumber,
   isNegativeMoney,
+  isStockJournalSource,
   isZeroMoney,
   type JournalEntry,
   type JournalEntrySummary,
   type JournalLineInput,
   type JournalSource,
   type LedgerPage,
+  negateMoney,
   type OpeningBalances,
   type OpeningBalancesInput,
   periodOf,
   shiftIsoDate,
+  type StockJournalSource,
   subtractMoney,
   sumMoney,
   todayIn,
@@ -47,7 +52,7 @@ function fixed(value: string): string {
 }
 
 function linesProblem(
-  code: 'journal_account_invalid' | 'journal_branch_invalid',
+  code: 'journal_account_invalid' | 'journal_branch_invalid' | 'journal_account_stock',
   field: string,
   indexes: number[],
 ) {
@@ -58,10 +63,20 @@ function linesProblem(
   );
 }
 
+// The inventory account and the goods in transit account: only stock documents post to them
+// (step 14, the API's stockAccountIds())
+export function stockAccountIds(data: WorkspaceData): Set<string> {
+  const inventory = data.accounts.find((account) => account.purpose === 'inventory')?.id;
+  return new Set(
+    [inventory, data.stockAccounts.in_transit].filter((id): id is string => typeof id === 'string'),
+  );
+}
+
 export function checkLines(
   data: WorkspaceData,
   lines: readonly LineIn[],
   allowArchived = false,
+  allowStock = false,
 ): void {
   const badAccounts = lines.flatMap((line, index) => {
     const account = data.accounts.find((item) => item.id === line.accountId);
@@ -71,6 +86,11 @@ export function checkLines(
   });
   if (badAccounts.length > 0)
     throw linesProblem('journal_account_invalid', 'accountId', badAccounts);
+  if (!allowStock) {
+    const stock = stockAccountIds(data);
+    const onStock = lines.flatMap((line, index) => (stock.has(line.accountId) ? [index] : []));
+    if (onStock.length > 0) throw linesProblem('journal_account_stock', 'accountId', onStock);
+  }
   const badBranches = lines.flatMap((line, index) => {
     if (line.branchId === null) return [];
     const branch = data.branches.find((item) => item.id === line.branchId);
@@ -111,6 +131,7 @@ export function summaryOf(entry: JournalEntry): JournalEntrySummary {
     total: entry.total,
     reversalOf: entry.reversalOf,
     reversedBy: entry.reversedBy,
+    document: entry.document,
     postedAt: entry.postedAt,
     version: entry.version,
     updatedAt: entry.updatedAt,
@@ -130,6 +151,7 @@ export function writeDraft(
   input: { date: string; narration: string | null; lines: readonly LineIn[] },
   source: JournalSource = 'manual',
   reversalOf: JournalEntry['reversalOf'] = null,
+  document: EntryRef | null = null,
 ): JournalEntry {
   const now = new Date().toISOString();
   const entry: JournalEntry = {
@@ -142,6 +164,7 @@ export function writeDraft(
     total: sumMoney(input.lines.map((line) => line.debit)),
     reversalOf,
     reversedBy: null,
+    document,
     postedAt: null,
     version: 1,
     updatedAt: now,
@@ -185,7 +208,8 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
   const debits = sumMoney(entry.lines.map((line) => line.debit));
   const credits = sumMoney(entry.lines.map((line) => line.credit));
   if (debits !== credits) throw new MockProblem(409, 'journal_unbalanced');
-  checkLines(data, entry.lines, entry.source === 'reversal' || entry.source === 'year_close');
+  const oldWork = entry.source === 'reversal' || entry.source === 'year_close';
+  checkLines(data, entry.lines, oldWork, oldWork || isStockJournalSource(entry.source));
   Object.assign(entry, {
     status: 'posted',
     number: nextNumber(data, entry.date),
@@ -207,6 +231,7 @@ export function reverseEntry(
   if (entry.source === 'year_close' && !allowYearClose) {
     throw new MockProblem(409, 'journal_is_year_close');
   }
+  if (isStockJournalSource(entry.source)) throw new MockProblem(409, 'journal_is_stock');
   if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
   if (date < entry.date) {
     throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
@@ -236,8 +261,9 @@ export function postNew(
   data: WorkspaceData,
   input: { date: string; narration: string | null; lines: readonly LineIn[] },
   source: JournalSource = 'manual',
+  document: EntryRef | null = null,
 ): JournalEntry {
-  const entry = writeDraft(data, input, source);
+  const entry = writeDraft(data, input, source, null, document);
   try {
     postDraft(data, entry);
   } catch (error) {
@@ -351,6 +377,17 @@ export function saveOpening(data: WorkspaceData, input: OpeningBalancesInput): v
       ['asset', 'liability', 'equity'].includes(account.type);
     return ok ? [] : [line.index];
   });
+  const stock = stockAccountIds(data);
+  const onStock = filled.flatMap((line) => (stock.has(line.accountId) ? [line.index] : []));
+  if (onStock.length > 0) {
+    throw new MockProblem(
+      409,
+      'journal_account_stock',
+      Object.fromEntries(
+        onStock.map((index) => [`lines.${String(index)}.accountId`, ['journal_account_stock']]),
+      ),
+    );
+  }
   if (invalid.length > 0) {
     throw new MockProblem(
       409,
@@ -391,6 +428,54 @@ export function saveOpening(data: WorkspaceData, input: OpeningBalancesInput): v
   );
 }
 
+// A stock document's entry (step 14, the API's StockBooksService.write()): the amounts summed per
+// account and branch (+ debit, − credit), zero sums dropped, nothing written when nothing is left
+export function postStockEntry(
+  data: WorkspaceData,
+  input: {
+    date: string;
+    source: StockJournalSource;
+    document: EntryRef;
+    narration: string;
+    amounts: readonly { accountId: string; branchId: string | null; amount: string }[];
+  },
+): EntryRef | null {
+  const sums = new Map<string, { accountId: string; branchId: string | null; total: string }>();
+  for (const amount of input.amounts) {
+    const key = `${amount.accountId}|${amount.branchId ?? ''}`;
+    const sum = sums.get(key) ?? { ...amount, total: '0' };
+    sum.total = addMoney(sum.total, amount.amount);
+    sums.set(key, sum);
+  }
+  const lines = [...sums.values()]
+    .filter((sum) => !isZeroMoney(sum.total))
+    .map((sum) => {
+      const debit = compareMoney(sum.total, '0') > 0;
+      return {
+        accountId: sum.accountId,
+        branchId: sum.branchId,
+        description: null,
+        debit: debit ? sum.total : '0',
+        credit: debit ? '0' : negateMoney(sum.total),
+      };
+    });
+  if (lines.length < 2) return null;
+  const entry = postNew(
+    data,
+    { date: input.date, narration: input.narration, lines },
+    input.source,
+    input.document,
+  );
+  return { id: entry.id, number: entry.number ?? '' };
+}
+
+// A stock document's entries, oldest first
+export function entriesOfDocument(data: WorkspaceData, documentId: string): EntryRef[] {
+  return data.journal.entries
+    .filter((entry) => entry.document?.id === documentId && entry.number !== null)
+    .map((entry) => ({ id: entry.id, number: entry.number ?? '' }));
+}
+
 export function setLockDate(data: WorkspaceData, lockDate: string | null, version: number): void {
   if (data.journal.lockVersion !== version) throw new MockProblem(409, 'version_conflict');
   if (lockDate !== null && lockDate > todayIn(data.settings.timezone)) {
```

`apps/app/src/mocks/stock-data.ts` (changed):

```diff
@@ -1,18 +1,26 @@
 import {
+  addMoney,
   addQuantity,
+  type AdjustmentLine,
   type BatchStock,
   compareQuantity,
   defaultNumberFormat,
   type ErrorCode,
   fitsDecimals,
   formatDocumentNumber,
+  isAdjustmentReason,
   isQuantity,
   isWholeQuantity,
+  isZeroMoney,
+  isZeroQuantity,
   type MovementKind,
+  multiplyMoney,
+  negateMoney,
   negateQuantity,
   periodOf,
   type Product,
   type ProductVariant,
+  prorateMoney,
   type ReorderItem,
   type ReorderLevelInput,
   type StockAdjustment,
@@ -22,16 +30,26 @@ import {
   type StockLine,
   type StockListQuery,
   type StockMovement,
+  type StockRevaluation,
+  type StockRevaluationInput,
   type StockTransfer,
   type StockTransferInput,
+  type StockValue,
+  splitMoney,
+  subtractMoney,
+  subtractQuantity,
+  sumMoney,
   sumQuantity,
   toBaseQuantity,
   todayIn,
   type TransferLine,
+  unitCostOf,
+  type ValuationSummary,
   type Warehouse,
   wholeCount,
 } from '@omnivo/contracts';
 
+import { postStockEntry } from './journal-data';
 import { MockProblem } from './mock';
 import type { WorkspaceData } from './workspace-data';
 
@@ -49,11 +67,20 @@ interface MockMovement {
   batchId: string | null;
   serialNumber: string | null;
   quantity: string;
+  // Step 14: signed like the quantity
+  value: string;
   kind: MovementKind;
   documentId: string;
   documentNumber: string;
 }
 
+// A variant's stock and value company-wide (the API's stock_values row)
+interface ValueState {
+  quantity: string;
+  value: string;
+  unitCost: string | null;
+}
+
 interface MockBatch {
   id: string;
   variantId: string;
@@ -76,7 +103,10 @@ export interface MockStock {
   }[];
   adjustments: StockAdjustment[];
   transfers: StockTransfer[];
-  counters: { adjustment: number; transfer: number };
+  // Step 14: variant → its value (kept like the API's trigger, as each movement is written)
+  values: Map<string, ValueState>;
+  revaluations: StockRevaluation[];
+  counters: { adjustment: number; transfer: number; revaluation: number };
 }
 
 export function emptyStock(): MockStock {
@@ -88,14 +118,62 @@ export function emptyStock(): MockStock {
     levels: [],
     adjustments: [],
     transfers: [],
-    counters: { adjustment: 0, transfer: 0 },
+    values: new Map(),
+    revaluations: [],
+    counters: { adjustment: 0, transfer: 0, revaluation: 0 },
+  };
+}
+
+// The new state after a movement, like migration 0024's trigger: the average follows the stock
+// while there is some, and keeps its last value at zero or below
+function applyValue(state: ValueState, quantity: string, value: string): ValueState {
+  const next = {
+    quantity: addQuantity(state.quantity, quantity),
+    value: addMoney(state.value, value),
+  };
+  return {
+    ...next,
+    unitCost:
+      compareQuantity(next.quantity, '0') > 0
+        ? unitCostOf(next.value, next.quantity)
+        : state.unitCost,
   };
 }
 
+function valueOf(stock: MockStock, variantId: string): ValueState {
+  return stock.values.get(variantId) ?? { quantity: '0', value: '0.0000', unitCost: null };
+}
+
+// Writes a movement and adds it to its variant's value, like the trigger
+function pushMovement(stock: MockStock, movement: MockMovement): void {
+  stock.movements.push(movement);
+  stock.values.set(
+    movement.variantId,
+    applyValue(valueOf(stock, movement.variantId), movement.quantity, movement.value),
+  );
+}
+
+// The API's outflowValue(): all of it takes all the value, part takes its share, more than there
+// is takes what there was and the rest at the last average
+function outflowValue(state: ValueState, quantity: string): string {
+  const positive = compareQuantity(state.quantity, '0') > 0;
+  if (positive && compareQuantity(quantity, state.quantity) === 0) return state.value;
+  if (positive && compareQuantity(quantity, state.quantity) < 0) {
+    return prorateMoney(state.value, quantity, state.quantity);
+  }
+  const beyond = positive ? subtractQuantity(quantity, state.quantity) : quantity;
+  return addMoney(positive ? state.value : '0', multiplyMoney(beyond, state.unitCost ?? '0'));
+}
+
 function now(): string {
   return new Date().toISOString();
 }
 
+// "1200" → "1200.0000", the way Postgres sends NUMERIC(19,4); null stays null
+function fixedOrNull(value: string | null): string | null {
+  return value === null ? null : addMoney(value, '0');
+}
+
 export function warehouse(
   branchId: string,
   code: string,
@@ -217,6 +295,25 @@ function itemOf(
     onHand: onHand(stock, balances, variant.id, warehouseId),
     inTransit: inTransit(stock, variant.id, warehouseId),
     low: isLow(stock, balances, variant.id, warehouseId),
+    ...valueFields(stock, balances, variant.id, warehouseId),
+  };
+}
+
+// The mock signs everyone in as the owner, who sees costs (inventory.stock.value)
+function valueFields(
+  stock: MockStock,
+  balances: ReturnType<typeof balancesOf>,
+  variantId: string,
+  warehouseId: string | undefined,
+): { unitCost: string | null; value: string | null } {
+  const state = stock.values.get(variantId);
+  if (!state) return { unitCost: null, value: null };
+  return {
+    unitCost: state.unitCost,
+    value:
+      warehouseId === undefined
+        ? state.value
+        : multiplyMoney(onHand(stock, balances, variantId, warehouseId), state.unitCost ?? '0'),
   };
 }
 
@@ -361,6 +458,7 @@ export function movementsOf(
       documentNumber: row.documentNumber,
       quantity: row.quantity,
       balance,
+      value: row.value,
       lotNumber: data.stock.batches.find((batch) => batch.id === row.batchId)?.lotNumber ?? null,
       serialNumber: row.serialNumber,
     };
@@ -464,6 +562,7 @@ interface LineInput {
   lotNumber?: string | null;
   expiresOn?: string | null;
   manufacturedOn?: string | null;
+  unitCost?: string | null;
 }
 
 function issuesError(issues: { path: string; code: ErrorCode }[]): MockProblem {
@@ -579,11 +678,16 @@ function assertDate(data: WorkspaceData, date: string): void {
 
 function nextNumber(
   data: WorkspaceData,
-  type: 'inventory.adjustment' | 'inventory.transfer',
+  type: 'inventory.adjustment' | 'inventory.transfer' | 'inventory.revaluation',
   date: string,
 ): string {
   const format = defaultNumberFormat(type);
-  const key = type === 'inventory.adjustment' ? 'adjustment' : 'transfer';
+  const key =
+    type === 'inventory.adjustment'
+      ? 'adjustment'
+      : type === 'inventory.transfer'
+        ? 'transfer'
+        : 'revaluation';
   data.stock.counters[key] += 1;
   return formatDocumentNumber(
     format,
@@ -599,10 +703,13 @@ interface Move {
   batchId: string | null;
   quantity: string;
   serialNumbers: string[];
+  // An "in" move's value; null = at the average cost (step 14)
+  value?: string | null;
 }
 
-// The API's StockPostingService.post(), shortened: serial numbers and stock checked, then the
-// movements written (one per serial number for a serial product)
+// The API's StockPostingService.post(), shortened: serial numbers and stock checked, the values
+// worked out (step 14), then the movements written (one per serial number for a serial product).
+// Returns each move's value.
 function postMoves(
   data: WorkspaceData,
   posting: {
@@ -614,7 +721,7 @@ function postMoves(
   },
   moves: readonly Move[],
   receivingTransferId?: string,
-): void {
+): string[] {
   const { stock } = data;
   const issues: { path: string; code: ErrorCode }[] = [];
   const balances = balancesOf(stock);
@@ -659,7 +766,30 @@ function postMoves(
   }
   if (issues.length > 0) throw issuesError(issues);
 
-  for (const move of moves) {
+  // The values, in the document's order, each from what the one before left
+  const states = new Map<string, ValueState>();
+  const values = moves.map((move) => {
+    const variantId = move.stockLine.variantId;
+    const state = states.get(variantId) ?? valueOf(stock, variantId);
+    let value: string;
+    if (posting.direction === 'out') {
+      value = outflowValue(state, move.quantity);
+      states.set(variantId, applyValue(state, negateQuantity(move.quantity), negateMoney(value)));
+    } else {
+      const given = move.value ?? null;
+      if (given === null && state.unitCost === null) {
+        issues.push({ path: `lines.${String(move.line)}.unitCost`, code: 'stock_cost_required' });
+      }
+      value = given ?? multiplyMoney(move.quantity, state.unitCost ?? '0');
+      states.set(variantId, applyValue(state, move.quantity, value));
+    }
+    return value;
+  });
+  if (issues.length > 0) throw issuesError(issues);
+  const signed = (value: string) => (posting.direction === 'in' ? value : negateMoney(value));
+
+  moves.forEach((move, index) => {
+    const value = values[index] ?? '0';
     const base = {
       date: posting.date,
       warehouseId: move.warehouseId,
@@ -671,27 +801,54 @@ function postMoves(
       documentNumber: posting.number,
     };
     if (move.serialNumbers.length > 0) {
-      for (const serial of move.serialNumbers) {
-        stock.movements.push({
+      const pieces = splitMoney(value, move.serialNumbers.length);
+      move.serialNumbers.forEach((serial, piece) => {
+        pushMovement(stock, {
           ...base,
           id: crypto.randomUUID(),
           serialNumber: serial,
           quantity: posting.direction === 'in' ? '1.0000' : '-1.0000',
+          value: signed(pieces[piece] ?? '0'),
         });
         stock.serials.set(
           `${move.stockLine.variantId}|${serial}`,
           posting.direction === 'in' ? move.warehouseId : null,
         );
-      }
+      });
     } else {
-      stock.movements.push({
+      pushMovement(stock, {
         ...base,
         id: crypto.randomUUID(),
         serialNumber: null,
         quantity: posting.direction === 'in' ? move.quantity : negateQuantity(move.quantity),
+        value: signed(value),
       });
     }
+  });
+  return values;
+}
+
+// --- The books (step 14, the API's StockBooksService) --------------------------------------------
+
+function branchOf(data: WorkspaceData, warehouseId: string): string | null {
+  return data.stock.warehouses.find((place) => place.id === warehouseId)?.branchId ?? null;
+}
+
+function bookAccounts(data: WorkspaceData) {
+  const inventory = data.accounts.find((account) => account.purpose === 'inventory')?.id;
+  const equity = data.accounts.find((account) => account.purpose === 'opening_balance_equity')?.id;
+  if (inventory === undefined || equity === undefined) {
+    throw new MockProblem(409, 'stock_account_missing');
   }
+  const use = (key: keyof WorkspaceData['stockAccounts']): string => {
+    const id = data.stockAccounts[key];
+    const account = data.accounts.find((row) => row.id === id);
+    if (!account || account.isGroup || account.archivedAt !== null) {
+      throw new MockProblem(409, 'stock_account_missing');
+    }
+    return account.id;
+  };
+  return { inventory, equity, use };
 }
 
 export function findAdjustment(data: WorkspaceData, id: string): StockAdjustment {
@@ -706,7 +863,14 @@ export function saveAdjustment(
   existing?: StockAdjustment,
 ): StockAdjustment {
   assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
-  const lines = resolveLines(data, input.lines, input.direction);
+  const lines: AdjustmentLine[] = resolveLines(data, input.lines, input.direction).map(
+    (line, index) => ({
+      ...line,
+      // A typed cost belongs on an "in" line only, like the API
+      unitCost: input.direction === 'in' ? fixedOrNull(input.lines[index]?.unitCost ?? null) : null,
+      value: null,
+    }),
+  );
   const saved: StockAdjustment = {
     id: existing?.id ?? crypto.randomUUID(),
     number: null,
@@ -721,6 +885,7 @@ export function saveAdjustment(
     version: (existing?.version ?? 0) + 1,
     updatedAt: now(),
     lines,
+    entry: null,
   };
   data.stock.adjustments = [saved, ...data.stock.adjustments.filter((row) => row.id !== saved.id)];
   return saved;
@@ -762,9 +927,16 @@ export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): Sto
     return { ...line, batchId: batch.id, expiresOn: batch.expiresOn };
   });
   if (issues.length > 0) throw issuesError(issues);
+  // The accounts first: a missing one refuses the posting before anything moves
+  const accounts = bookAccounts(data);
+  const reason = draft.reason;
+  // Opening stock is against opening balance equity; every other reason has its own account
+  const against =
+    !isAdjustmentReason(reason) || reason === 'opening' ? accounts.equity : accounts.use(reason);
   const number = nextNumber(data, 'inventory.adjustment', draft.date);
+  let values: string[];
   try {
-    postMoves(
+    values = postMoves(
       data,
       { date: draft.date, kind: 'adjustment', direction, documentId: draft.id, number },
       lines.map((line, index) => ({
@@ -774,6 +946,7 @@ export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): Sto
         batchId: line.batchId,
         quantity: line.baseQuantity,
         serialNumbers: line.serialNumbers,
+        value: line.unitCost === null ? null : multiplyMoney(line.quantity, line.unitCost),
       })),
     );
   } catch (error) {
@@ -781,9 +954,23 @@ export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): Sto
     data.stock.counters.adjustment -= 1;
     throw error;
   }
+  const total = sumMoney(values);
+  const branchId = branchOf(data, draft.warehouseId);
+  const sign = (value: string) => (direction === 'in' ? value : negateMoney(value));
+  const entry = postStockEntry(data, {
+    date: draft.date,
+    source: 'stock_adjustment',
+    document: { id: draft.id, number },
+    narration: `Stock adjustment ${number}`,
+    amounts: [
+      { accountId: accounts.inventory, branchId, amount: sign(total) },
+      { accountId: against, branchId, amount: negateMoney(sign(total)) },
+    ],
+  });
   const posted: StockAdjustment = {
     ...draft,
-    lines,
+    lines: lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
+    entry,
     number,
     status: 'posted',
     postedAt: now(),
@@ -815,6 +1002,8 @@ export function saveTransfer(
     ...line,
     receivedQuantity: null,
     receivedSerialNumbers: null,
+    value: null,
+    receivedValue: null,
   }));
   const saved: StockTransfer = {
     id: existing?.id ?? crypto.randomUUID(),
@@ -832,6 +1021,7 @@ export function saveTransfer(
     version: (existing?.version ?? 0) + 1,
     updatedAt: now(),
     lines,
+    entries: [],
   };
   data.stock.transfers = [saved, ...data.stock.transfers.filter((row) => row.id !== saved.id)];
   return saved;
@@ -840,9 +1030,15 @@ export function saveTransfer(
 export function sendTransfer(data: WorkspaceData, draft: StockTransfer): StockTransfer {
   if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
   assertDate(data, draft.sentOn);
+  const from = branchOf(data, draft.fromWarehouseId);
+  const crossing = from !== branchOf(data, draft.toWarehouseId);
+  // Between branches the goods go through goods in transit: its account must be there first
+  const accounts = crossing ? bookAccounts(data) : null;
+  const inTransitAccount = accounts?.use('in_transit') ?? null;
   const number = nextNumber(data, 'inventory.transfer', draft.sentOn);
+  let values: string[];
   try {
-    postMoves(
+    values = postMoves(
       data,
       { date: draft.sentOn, kind: 'transfer_out', direction: 'out', documentId: draft.id, number },
       draft.lines.map((line, index) => ({
@@ -858,8 +1054,24 @@ export function sendTransfer(data: WorkspaceData, draft: StockTransfer): StockTr
     data.stock.counters.transfer -= 1;
     throw error;
   }
+  const total = sumMoney(values);
+  const entry =
+    accounts && inTransitAccount
+      ? postStockEntry(data, {
+          date: draft.sentOn,
+          source: 'stock_transfer',
+          document: { id: draft.id, number },
+          narration: `Stock transfer ${number} sent`,
+          amounts: [
+            { accountId: inTransitAccount, branchId: null, amount: total },
+            { accountId: accounts.inventory, branchId: from, amount: negateMoney(total) },
+          ],
+        })
+      : null;
   const sent: StockTransfer = {
     ...draft,
+    lines: draft.lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
+    entries: entry ? [entry] : [],
     number,
     status: 'in_transit',
     sentAt: now(),
@@ -905,6 +1117,23 @@ export function receiveTransfer(
     };
   });
   if (issues.length > 0) throw issuesError(issues);
+  // What arrived is worth the same per unit as what left (the API's receivedValueOf())
+  const receivedValues = lines.map(({ line }) => {
+    const sentValue = line.value ?? '0';
+    if (compareQuantity(line.receivedQuantity, line.baseQuantity) === 0) return sentValue;
+    if (isZeroQuantity(line.receivedQuantity)) return '0.0000';
+    return prorateMoney(sentValue, line.receivedQuantity, line.baseQuantity);
+  });
+  const from = branchOf(data, transfer.fromWarehouseId);
+  const to = branchOf(data, transfer.toWarehouseId);
+  const sentTotal = sumMoney(lines.map(({ line }) => line.value ?? '0'));
+  const receivedTotal = sumMoney(receivedValues);
+  const short = subtractMoney(sentTotal, receivedTotal);
+  const needsBooks = from !== to || !isZeroMoney(short);
+  const accounts = needsBooks ? bookAccounts(data) : null;
+  const shortageAccount =
+    accounts && !isZeroMoney(short) ? accounts.use('transfer_shortage') : null;
+  const inTransitAccount = accounts && from !== to ? accounts.use('in_transit') : null;
   postMoves(
     data,
     {
@@ -925,14 +1154,48 @@ export function receiveTransfer(
               batchId: line.batchId,
               quantity: line.receivedQuantity,
               serialNumbers: line.receivedSerialNumbers,
+              value: receivedValues[index] ?? '0',
             },
           ],
     ),
     transfer.id,
   );
+  const document = { id: transfer.id, number: transfer.number ?? '' };
+  const narration = `Stock transfer ${transfer.number ?? ''} received`;
+  const shortage = shortageAccount
+    ? [{ accountId: shortageAccount, branchId: from, amount: short }]
+    : [];
+  const entry = !accounts
+    ? null
+    : inTransitAccount
+      ? postStockEntry(data, {
+          date: input.date,
+          source: 'stock_transfer',
+          document,
+          narration,
+          amounts: [
+            { accountId: accounts.inventory, branchId: to, amount: receivedTotal },
+            ...shortage,
+            { accountId: inTransitAccount, branchId: null, amount: negateMoney(sentTotal) },
+          ],
+        })
+      : postStockEntry(data, {
+          date: input.date,
+          source: 'stock_transfer',
+          document,
+          narration,
+          amounts: [
+            ...shortage,
+            { accountId: accounts.inventory, branchId: from, amount: negateMoney(short) },
+          ],
+        });
   const received: StockTransfer = {
     ...transfer,
-    lines: lines.map(({ line }) => line),
+    lines: lines.map(({ line }, index) => ({
+      ...line,
+      receivedValue: receivedValues[index] ?? null,
+    })),
+    entries: entry ? [...transfer.entries, entry] : transfer.entries,
     status: 'received',
     receivedOn: input.date,
     receivedAt: now(),
@@ -946,14 +1209,187 @@ export function receiveTransfer(
   return received;
 }
 
+// --- Values (step 14) ---------------------------------------------------------------------------
+
+export function valuationList(
+  data: WorkspaceData,
+  query: { search?: string | undefined; categoryId?: string | undefined },
+): StockValue[] {
+  const search = query.search?.trim().toLowerCase() ?? '';
+  return data.catalog.products
+    .filter((product) => query.categoryId === undefined || product.categoryId === query.categoryId)
+    .toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
+    .flatMap((product) =>
+      product.variants.flatMap((variant) => {
+        const state = data.stock.values.get(variant.id);
+        if (!state || (isZeroQuantity(state.quantity) && isZeroMoney(state.value))) return [];
+        const matches =
+          search === '' ||
+          product.name.toLowerCase().includes(search) ||
+          product.code.toLowerCase().includes(search) ||
+          variant.sku.toLowerCase().includes(search);
+        return matches
+          ? [
+              {
+                ...refOf(product, variant),
+                quantity: state.quantity,
+                unitCost: state.unitCost,
+                value: state.value,
+              },
+            ]
+          : [];
+      }),
+    );
+}
+
+export function valuationSummary(data: WorkspaceData): ValuationSummary {
+  const stockValue = sumMoney([...data.stock.values.values()].map((state) => state.value));
+  const inTransitValue = sumMoney(
+    data.stock.transfers
+      .filter((transfer) => transfer.status === 'in_transit')
+      .flatMap((transfer) => transfer.lines.map((line) => line.value ?? '0')),
+  );
+  const balanceOf = (accountId: string | null | undefined) => {
+    if (accountId === null || accountId === undefined) return null;
+    const lines = data.journal.entries
+      .filter((entry) => entry.status === 'posted')
+      .flatMap((entry) => entry.lines.filter((line) => line.accountId === accountId));
+    return {
+      id: accountId,
+      balance: subtractMoney(
+        sumMoney(lines.map((line) => line.debit)),
+        sumMoney(lines.map((line) => line.credit)),
+      ),
+    };
+  };
+  const inventoryAccount = balanceOf(
+    data.accounts.find((account) => account.purpose === 'inventory')?.id,
+  );
+  const inTransitAccount = balanceOf(data.stockAccounts.in_transit);
+  return {
+    stockValue,
+    inTransitValue,
+    inventoryAccount,
+    inTransitAccount,
+    difference: subtractMoney(
+      sumMoney([stockValue, inTransitValue]),
+      sumMoney([inventoryAccount?.balance ?? '0', inTransitAccount?.balance ?? '0']),
+    ),
+  };
+}
+
+export function findRevaluation(data: WorkspaceData, id: string): StockRevaluation {
+  const found = data.stock.revaluations.find((revaluation) => revaluation.id === id);
+  if (!found) throw new MockProblem(404, 'not_found');
+  return found;
+}
+
+// The API's StockRevaluationsService.create() and StockPostingService.revalue(), shortened: the
+// difference split over the warehouses holding the stock, as movements of quantity 0
+export function revalue(data: WorkspaceData, input: StockRevaluationInput): StockRevaluation {
+  assertDate(data, input.date);
+  const { stock } = data;
+  const issues: { path: string; code: ErrorCode }[] = [];
+  const found = input.lines.map((line, index) => {
+    const variant = findVariant(data, line.variantId);
+    if (variant?.product.type !== 'goods') {
+      issues.push({ path: `lines.${String(index)}.variantId`, code: 'stock_variant_invalid' });
+      return null;
+    }
+    const state = valueOf(stock, line.variantId);
+    if (compareQuantity(state.quantity, '0') <= 0) {
+      issues.push({ path: `lines.${String(index)}.variantId`, code: 'revaluation_no_stock' });
+      return null;
+    }
+    return { ...variant, state };
+  });
+  if (issues.length > 0) throw issuesError(issues);
+  const accounts = bookAccounts(data);
+  const revaluationAccount = accounts.use('revaluation');
+  const id = crypto.randomUUID();
+  const number = nextNumber(data, 'inventory.revaluation', input.date);
+  const balances = balancesOf(stock);
+  const amounts: { accountId: string; branchId: string | null; amount: string }[] = [];
+  const lines = input.lines.flatMap((line, index) => {
+    const item = found[index];
+    if (!item) return [];
+    const newValue = multiplyMoney(item.state.quantity, line.unitCost);
+    const difference = subtractMoney(newValue, item.state.value);
+    const places = stock.warehouses.flatMap((place) => {
+      const quantity = balances.byPlace.get(`${place.id}|${line.variantId}`) ?? '0';
+      return compareQuantity(quantity, '0') > 0 ? [{ warehouseId: place.id, quantity }] : [];
+    });
+    const held = sumQuantity(places.map((place) => place.quantity));
+    let left = difference;
+    places.forEach((place, at) => {
+      const value =
+        at === places.length - 1 ? left : prorateMoney(difference, place.quantity, held);
+      left = subtractMoney(left, value);
+      if (isZeroMoney(value)) return;
+      pushMovement(stock, {
+        id: crypto.randomUUID(),
+        date: input.date,
+        warehouseId: place.warehouseId,
+        productId: item.product.id,
+        variantId: line.variantId,
+        batchId: null,
+        serialNumber: null,
+        quantity: '0.0000',
+        value,
+        kind: 'revaluation',
+        documentId: id,
+        documentNumber: number,
+      });
+      const branchId = branchOf(data, place.warehouseId);
+      amounts.push(
+        { accountId: accounts.inventory, branchId, amount: value },
+        { accountId: revaluationAccount, branchId, amount: negateMoney(value) },
+      );
+    });
+    return [
+      {
+        ...refOf(item.product, item.variant),
+        id: crypto.randomUUID(),
+        quantity: item.state.quantity,
+        oldUnitCost: item.state.unitCost,
+        oldValue: item.state.value,
+        unitCost: addMoney(line.unitCost, '0'),
+        newValue,
+        difference,
+      },
+    ];
+  });
+  const entry = postStockEntry(data, {
+    date: input.date,
+    source: 'stock_revaluation',
+    document: { id, number },
+    narration: `Stock revaluation ${number}`,
+    amounts,
+  });
+  const revaluation: StockRevaluation = {
+    id,
+    number,
+    date: input.date,
+    note: input.note,
+    lineCount: lines.length,
+    difference: sumMoney(lines.map((line) => line.difference)),
+    postedAt: now(),
+    lines,
+    entry,
+  };
+  stock.revaluations = [revaluation, ...stock.revaluations];
+  return revaluation;
+}
+
 // --- Seed ---------------------------------------------------------------------------------------
 
 function daysFromToday(today: string, days: number): string {
   return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
 }
 
-// What a fixture workspace starts with: its warehouses, an opening stock adjustment a week ago,
-// and (garments) a truck on the road to the Chattogram depot and a low stock of mailer bags
+// What a fixture workspace starts with: its warehouses, an opening stock adjustment a week ago
+// (with what each item cost: step 14 posts it to the books, against opening balance equity), and
+// (garments) a truck on the road to the Chattogram depot and a low stock of mailer bags
 export function seedStock(data: WorkspaceData, garments: boolean): void {
   const [ho, factory, depot] = data.branches;
   if (!ho) return;
@@ -977,7 +1413,13 @@ export function seedStock(data: WorkspaceData, garments: boolean): void {
 
   const byCode = (code: string) => data.catalog.products.find((product) => product.code === code);
   type SeedLine = StockAdjustmentInput['lines'][number];
-  const blank = { batchId: null, lotNumber: null, expiresOn: null, manufacturedOn: null };
+  const blank = {
+    batchId: null,
+    lotNumber: null,
+    expiresOn: null,
+    manufacturedOn: null,
+    unitCost: null,
+  };
   const line = (code: string, quantity: string, extra: Partial<SeedLine> = {}): SeedLine[] => {
     const product = byCode(code);
     const variant = product?.variants[0];
@@ -1015,13 +1457,15 @@ export function seedStock(data: WorkspaceData, garments: boolean): void {
         unitId: polo.baseUnitId,
         quantity: '120',
         serialNumbers: [],
+        unitCost: '410',
       })) ?? []),
-      ...line('P-00001', '480'),
-      ...line('P-00002', '1250.5'),
-      ...line('P-00003', '7200'),
-      ...line('P-00004', '3000'),
+      ...line('P-00001', '480', { unitCost: '185' }),
+      ...line('P-00002', '1250.5', { unitCost: '520' }),
+      ...line('P-00003', '7200', { unitCost: '0.45' }),
+      ...line('P-00004', '3000', { unitCost: '6.5' }),
       ...line('P-00005', '3', {
         serialNumbers: ['JK8000-24-0117', 'JK8000-24-0118', 'JK8000-24-0119'],
+        unitCost: '68500',
       }),
     ]);
     const mailer = byCode('P-00004')?.variants[0];
@@ -1049,8 +1493,16 @@ export function seedStock(data: WorkspaceData, garments: boolean): void {
     }
   } else {
     opening([
-      ...line('P-00001', '3000', { lotNumber: 'NP24090', expiresOn: daysFromToday(today, 25) }),
-      ...line('P-00001', '12000', { lotNumber: 'NP24117', expiresOn: daysFromToday(today, 270) }),
+      ...line('P-00001', '3000', {
+        lotNumber: 'NP24090',
+        expiresOn: daysFromToday(today, 25),
+        unitCost: '0.85',
+      }),
+      ...line('P-00001', '12000', {
+        lotNumber: 'NP24117',
+        expiresOn: daysFromToday(today, 270),
+        unitCost: '0.85',
+      }),
     ]);
   }
 }
```

`apps/app/src/mocks/handlers.ts` (changed):

```diff
@@ -1,10 +1,13 @@
 import {
   type Account,
+  accountTypeFits,
   type AuthSession,
+  type ErrorCode,
   type Preferences,
   type ProductCategory,
   routes,
   type Settings,
+  STOCK_ACCOUNT_USES,
 } from '@omnivo/contracts';
 import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';
 
@@ -74,16 +77,20 @@ import {
   batchReport,
   cardOf,
   findAdjustment,
+  findRevaluation,
   findTransfer,
   listStock,
   movementsOf,
   postAdjustment,
   receiveTransfer,
   reorderReport,
+  revalue,
   saveAdjustment,
   saveTransfer,
   sendTransfer,
   setLevel,
+  valuationList,
+  valuationSummary,
   warehouse as newWarehouse,
 } from './stock-data';
 import {
@@ -716,6 +723,10 @@ export const handlers = [
       const target = findAccount(data.accounts, id);
       checkVersion(target.version, version);
       assertNotLocked(target);
+      // Chosen in Settings → Inventory (step 14), like the API
+      if (Object.values(current().stockAccounts).includes(target.id)) {
+        throw new MockProblem(409, 'account_used_by_stock');
+      }
       if (data.accounts.some((child) => child.parentId === id && child.archivedAt === null)) {
         throw new MockProblem(409, 'account_has_active_children');
       }
@@ -752,6 +763,10 @@ export const handlers = [
       const target = findAccount(data.accounts, id);
       checkVersion(target.version, version);
       assertNotLocked(target);
+      // Chosen in Settings → Inventory (step 14), like the API
+      if (Object.values(current().stockAccounts).includes(target.id)) {
+        throw new MockProblem(409, 'account_used_by_stock');
+      }
       if (data.accounts.some((child) => child.parentId === id)) {
         throw new MockProblem(409, 'account_has_children');
       }
@@ -1863,4 +1878,98 @@ export const handlers = [
       return reply(routes.stockTransfers.receive, received);
     }),
   ),
+
+  // --- Stock values (step 14) ------------------------------------------------------------------
+
+  mock(routes.stock.valuation, ({ request }) => {
+    const query = readQuery(routes.stock.valuation.query, request);
+    return reply(routes.stock.valuation, {
+      items: valuationList(current(), query),
+      nextCursor: null,
+    });
+  }),
+
+  mock(routes.stock.valuationSummary, () =>
+    reply(routes.stock.valuationSummary, valuationSummary(current())),
+  ),
+
+  mock(routes.stockRevaluations.list, () =>
+    reply(routes.stockRevaluations.list, {
+      items: current().stock.revaluations.map((revaluation) => ({
+        id: revaluation.id,
+        number: revaluation.number,
+        date: revaluation.date,
+        note: revaluation.note,
+        lineCount: revaluation.lineCount,
+        difference: revaluation.difference,
+        postedAt: revaluation.postedAt,
+      })),
+      nextCursor: null,
+    }),
+  ),
+
+  mock(
+    routes.stockRevaluations.get,
+    guarded(({ params }) => {
+      const { id } = routes.stockRevaluations.get.params.parse(params);
+      return reply(routes.stockRevaluations.get, findRevaluation(current(), id));
+    }),
+  ),
+
+  mock(
+    routes.stockRevaluations.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.stockRevaluations.create.body, request);
+      const data = current();
+      const posted = revalue(data, body);
+      record(data, 'stock_revaluation.posted', 'stock_revaluation', posted.id, {
+        number: { from: null, to: posted.number },
+      });
+      await delay();
+      return reply(routes.stockRevaluations.create, posted);
+    }),
+  ),
+
+  mock(routes.stockAccounts.get, () => reply(routes.stockAccounts.get, current().stockAccounts)),
+
+  mock(
+    routes.stockAccounts.update,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.stockAccounts.update.body, request);
+      const data = current();
+      // The API's rules: an active ledger of a type that fits, never the inventory account
+      const fieldErrors: Record<string, ErrorCode[]> = {};
+      for (const use of STOCK_ACCOUNT_USES) {
+        const account = data.accounts.find((row) => row.id === body[use]);
+        if (account?.purpose === 'inventory') fieldErrors[use] = ['stock_account_inventory'];
+        else if (
+          !account ||
+          account.isGroup ||
+          account.archivedAt !== null ||
+          !accountTypeFits(use, account.type)
+        ) {
+          fieldErrors[use] = ['stock_account_invalid'];
+        }
+      }
+      const [first] = Object.values(fieldErrors);
+      if (first?.[0] !== undefined) throw new MockProblem(409, first[0], fieldErrors);
+      const before = data.stockAccounts;
+      data.stockAccounts = { ...body };
+      record(
+        data,
+        'stock_accounts.changed',
+        'workspace',
+        crypto.randomUUID(),
+        diff(
+          Object.fromEntries(
+            STOCK_ACCOUNT_USES.map((use) => [use, codeOf(data.accounts, before[use])]),
+          ),
+          Object.fromEntries(
+            STOCK_ACCOUNT_USES.map((use) => [use, codeOf(data.accounts, body[use])]),
+          ),
+        ),
+      );
+      return reply(routes.stockAccounts.update, data.stockAccounts);
+    }),
+  ),
 ];
```

- **The mock chart gets the same new accounts** as the templates (1175, 5150 for garments, 5190, 5290, and a 5300
  group so both fixture workspaces have their samples and loss accounts).
- **`pushMovement()` is the trigger**: every movement updates its item's value as it is written.
- **The accounts are resolved before anything moves** (`bookAccounts()` first): the mock has no transaction to roll
  back, so a missing account must refuse the posting before the first movement.
- **The seeded opening stock has real costs** (a pique polo at ৳410, a Juki machine at ৳68,500, Napa at ৳0.85), so
  `pnpm dev:mock` opens on a valuation page and a balance sheet with numbers in them. Posting it writes the garments
  workspace's JV-…-0007, and the seeded truck to the Chattogram depot (another branch) JV-…-0008.
- **The mock signs everyone in as the owner**, who sees costs; it has no permission checks of its own (step 7).

---

## 14.9 — Playwright

`apps/app/e2e/stock-valuation.e2e.ts` (new):

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav } from './helpers.js';

// Step 14 in the mock garments workspace. Its opening stock was posted with costs (7,200 shirt
// buttons at ৳0.45 = ৳3,240) as JV-…-0007, and the truck to the Chattogram depot as JV-…-0008.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

async function openPage(page: Page, link: string, heading: string) {
  await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

// Type the code into the picker and press Enter: the only match is added
async function scan(page: Page, code: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const search = page.getByRole('searchbox', { name: 'Search products' });
  await search.fill(code);
  await expect(page.getByRole('dialog').getByText(/in stock here/)).toHaveCount(1);
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await page.keyboard.press('Escape');
}

test('posts stock found in a count at its cost, and the journal entry follows it', async ({
  page,
}) => {
  await openPage(page, 'Adjustments', 'Stock adjustments');
  await page.getByRole('button', { name: 'New adjustment' }).click();
  await page.getByLabel('Warehouse').selectOption({ label: 'MAIN · Main store' });
  await page.getByLabel('Reason').selectOption({ label: 'Found in a count' });
  await scan(page, 'P-00003');
  const line = page.getByRole('group', { name: 'Line 1' });
  await line.getByLabel('Quantity').fill('800');
  await line.getByLabel('Cost per pcs').fill('0.5');
  await expect(line.getByText('= ৳400.00')).toBeVisible();
  await page.getByRole('button', { name: 'Post adjustment' }).click();
  await expect(page.getByText(/ADJ-\d{4}-\d{2}-0002 posted/)).toBeVisible();

  // The posted adjustment: the line's value, and the entry it made
  await expect(page.getByRole('cell', { name: '৳400.00' }).first()).toBeVisible();
  await page.getByRole('link', { name: /^JV-\d{4}-\d{2}-0009$/ }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0009$/ }),
  ).toBeVisible();
  await expect(page.getByText('Stock adjustment', { exact: true })).toBeVisible();
  await expect(page.getByText(/A stock document made this entry/)).toBeVisible();
  // Corrected by another stock document, never reversed from the journal
  await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  await page.getByRole('link', { name: /^From ADJ-/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^ADJ-/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test('values the stock, and the books agree with it', async ({ page }) => {
  await openPage(page, 'Valuation', 'Stock valuation');
  await expect(page.getByText('Books agree', { exact: true })).toBeVisible();
  // The list is virtualized on a phone: search, like a person would
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('buttons');
  await expect(listItem(page, /Shirt buttons 4-hole 18L/)).toContainText('৳3,240');
  await listItem(page, /Shirt buttons 4-hole 18L/).click();
  // The stock card: the average cost and the value, and each movement's value
  await expect(
    page.getByRole('heading', { level: 1, name: 'Shirt buttons 4-hole 18L' }),
  ).toBeVisible();
  await expect(page.getByText('Average cost')).toBeVisible();
  await expect(page.getByText('৳0.45').first()).toBeVisible();
  await expectNoSideScroll(page);
});

test('revalues an item, and posts the difference', async ({ page }) => {
  await openPage(page, 'Revaluations', 'Stock revaluations');
  await page.getByRole('button', { name: 'Revalue stock' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Revalue stock' })).toBeVisible();
  await scan(page, 'P-00003');
  const line = page.getByRole('group', { name: 'Line 1' });
  // 7,200 buttons worth ৳3,240 now; at ৳0.50 they are worth ৳3,600: ৳360 more
  await line.getByLabel('New cost per pcs').fill('0.5');
  await expect(line.getByText('৳360.00')).toBeVisible();
  await page.getByRole('button', { name: 'Post revaluation' }).click();
  await expect(page.getByText(/REV-\d{4}-\d{2}-0001 posted/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /^REV-/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-\d{4}-\d{2}-0009$/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test('chooses where stock documents post', async ({ page }) => {
  await openFromNav(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Stock accounts' })).toBeVisible();
  await page
    .getByLabel('Free samples')
    .selectOption({ label: '5290 · Consumables and internal use' });
  await page.getByRole('button', { name: 'Save stock accounts' }).click();
  await expect(page.getByText('Stock accounts saved')).toBeVisible();
  await expectNoSideScroll(page);
});
```

`apps/app/e2e/journal.e2e.ts` (changed):

```diff
@@ -9,8 +9,9 @@ test.beforeEach(async ({ page }) => {
 const line = (page: Page, number: number) =>
   page.getByRole('group', { name: `Line ${String(number)}` });
 
-// The mock garments workspace has six posted entries this year (JV-…-0001 to 0006) and one draft;
-// last year's are numbered in last year's series
+// The mock garments workspace has six posted entries this year (JV-…-0001 to 0006) and one draft,
+// then the two its stock posted (step 14: the opening stock is JV-…-0007, the truck on its way to
+// the Chattogram depot JV-…-0008); last year's are numbered in last year's series
 test('writes an entry and posts it only once the debits and credits are equal', async ({
   page,
 }) => {
@@ -33,9 +34,9 @@ test('writes an entry and posts it only once the debits and credits are equal',
   await expectNoSideScroll(page);
   await post.click();
 
-  await expect(page.getByText(/^JV-\d{4}-\d{2}-0007 posted$/)).toBeVisible();
+  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();
   await expect(
-    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0007$/ }),
+    page.getByRole('heading', { level: 1, name: /^JV-\d{4}-\d{2}-0009$/ }),
   ).toBeVisible();
   await expect(page.getByRole('link', { name: '1110 Cash in hand' })).toBeVisible();
   await expectNoSideScroll(page);
@@ -48,7 +49,7 @@ test('finishes a waiting draft, and deletes a new one in two clicks', async ({ p
   await listItem(page, /LC opening charges/).click();
   await expect(page.getByRole('heading', { level: 1, name: 'Draft entry' })).toBeVisible();
   await page.getByRole('button', { name: 'Post entry' }).click();
-  await expect(page.getByText(/^JV-\d{4}-\d{2}-0007 posted$/)).toBeVisible();
+  await expect(page.getByText(/^JV-\d{4}-\d{2}-0009 posted$/)).toBeVisible();
 
   await page.getByRole('link', { name: 'Back to the journal' }).click();
   await page.getByRole('button', { name: 'New entry' }).click();
```

`apps/app/e2e/onboarding.e2e.ts` (changed):

```diff
@@ -59,9 +59,9 @@ test('a new workspace goes through the setup wizard', async ({ page }) => {
   // short "Preparing the roles…" state: on a slow machine the 2-second job is done before we look
   await expect(page.getByRole('heading', { level: 1, name: 'Invite your team' })).toBeVisible();
   // The second pick is the one that was sent: garments roles, not pharma ones — and the chart
-  // came with them (the mock's garments chart has 41 accounts)
+  // came with them (the mock's garments chart has 47 accounts: 41, and step 14's six for stock)
   await expect(page.getByRole('status')).toHaveText(
-    /Roles ready: Accountant, Merchandiser, Store keeper\. Chart of accounts: 41 accounts\./,
+    /Roles ready: Accountant, Merchandiser, Store keeper\. Chart of accounts: 47 accounts\./,
   );
 
   // Back from here reaches the company details, but no further: the business type is sent
```

- **One flow from the form to the books and back**: a cost typed, its preview, the posted value, the entry it
  made, "From ADJ-…", and no Reverse.
- **The valuation list is searched first** on purpose: on a phone it is virtualized, and the buttons' row is not
  in the page until it scrolls into view.
- **The journal test's numbers move from 0007 to 0009**: the mock workspace's own stock now posts two entries
  before the test writes its first.
- **The onboarding test counts 47 accounts** in the mock garments chart, not 41: the six that 14.8 adds.

---
## 14.10 — Root files and the OpenAPI document

No root file changes. Generate the API document again and commit it:

```bash
pnpm gen:openapi      # openapi.json — 95 paths (90 before)
```

The Drizzle snapshots (`migrations/meta/0023_snapshot.json`, `0024_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

---

## 14.11 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components", in "Stock line rows", after "quantity (with "= 72 pcs" under it)":

> , and on a line that brings stock in, the unit cost per unit of the line (a `MoneyInput` with 4 decimals,
> "Cost per case", placeholder "At average cost", "= ৳3,600.00" under it)

And a new bullet after it:

> - **Stock values:** a value worked out from the books is shown only with `inventory.stock.value`; without it the
>   column is left out (lists) or shows a dash (documents). A stock document links its journal entries
>   ("JV-2026-27-0042") for people who read the journal, and a stock entry links back ("From ADJ-…").

And under "Content and formatting", after "Quantities":

> - **Stock values:** to the paisa, like money; a unit cost keeps 4 decimals and is shown with 2. Lists and the
>   stock card's KPIs show whole taka; documents, the stock card's history and the journal show paisa.

**build-plan.bn.md** — step 14's text:

> Weighted Average (পুরো কোম্পানিতে প্রতি আইটেমের একটা গড় খরচ; FIFO পরে), প্রতিটা স্টক মুভমেন্টের মূল্য
> (`stock_movements.value`, `stock_values` trigger দিয়ে রাখা), আর প্রতিটা স্টক ডকুমেন্টের **নিজের journal entry**
> (`StockBooksService` → ধাপ ১০-এর `PostingService.postNew()`, একই transaction-এ)। Settings → Inventory-তে
> স্টকের অ্যাকাউন্ট, দুই ব্রাঞ্চের মধ্যে transfer "Goods in transit" দিয়ে, "Revalue stock" ডকুমেন্ট (`REV-…`),
> `inventory.stock.value` / `inventory.stock.revalue` permission।

**COMMANDS.md** — in the database section:

````markdown
```sh
# items whose stock_values row differs from its movements (should print nothing; the trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT v.tenant_id, v.variant_id, v.quantity, v.value, m.quantity AS moved, m.value AS moved_value FROM stock_values v LEFT JOIN LATERAL (SELECT coalesce(sum(quantity), 0) AS quantity, coalesce(sum(value), 0) AS value FROM stock_movements m WHERE m.tenant_id = v.tenant_id AND m.variant_id = v.variant_id) m ON true WHERE v.quantity <> m.quantity OR v.value <> m.value"
# stock value per workspace, next to its inventory account's balance (the valuation page's check)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, (SELECT coalesce(sum(value), 0) FROM stock_values v WHERE v.tenant_id = t.id) AS stock, (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id WHERE l.tenant_id = t.id AND a.purpose = 'inventory' AND e.status = 'posted') AS inventory_account FROM tenants t"
```
````

---

## 14.12 — Run it

```bash
pnpm install
pnpm db:migrate                               # 0023 + 0024: values, the trigger, the backfill, the job
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it, the worker too: it picks up the stock accounts job
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('stock_values', 'stock_accounts', 'stock_revaluations', 'stock_revaluation_lines');  -- t
SELECT count(*) FROM stock_values;              -- one row per item that has ever moved
SELECT use, account_id FROM stock_accounts;     -- ten rows once the worker has run the job
```

### What you will see

1. **Your existing roles do not have the new permissions.** As the owner you have them all. For your accountant:
   Roles → Inventory → tick "See what stock costs and what it is worth" and "Revalue stock".
2. **Settings → Inventory → Stock accounts**: ten choices, filled in by the job. Goods in transit is 1175.
3. **Adjustments → New adjustment**, "Stock in", reason "Opening stock", add an item, type 3 cartons and "1200" in
   "Cost per case": "= ৳3,600.00" under it, and the total under the lines. **Post adjustment.**
4. The posted adjustment: the line's value, and **Journal entry JV-…**. Open it: Dr Inventory / Cr Opening balance
   equity, "From ADJ-…", and no Reverse button.
5. **Reports → Balance sheet**: Inventory ৳3,600. **Stock → Valuation**: ৳3,600, "Books agree".
6. Your step 13 stock is on the valuation page at ৳0. **Revalue stock** → add it, type its real cost → **Post
   revaluation**: the difference goes to the books, and the valuation page still says "Books agree".
7. **Transfers**: send stock to a warehouse of **another branch**: an entry moves it to Goods in transit. Receive
   less than was sent: the shortage goes to "Received short"'s account, and "Lost ৳…" shows under the line.
8. **A member without the permission** (log in as one): the stock list has no Value column, the documents show no
   values, and the nav has no Valuation.
9. **Accounting → Journal → New entry** on the inventory account: refused under that line.
10. **Bangla** and **390px**: the cost box drops under the quantity with its own label, the valuation table
    becomes cards, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 251: contracts 95 + api 74 + app 45 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 219 — 18 new
pnpm test:tenant-leak        # 45 — 2 new
pnpm test:e2e                # 92: 46 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 181.4 KB gz; adjustment form 89.5, revaluation form 97.1, stock card 87.1
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **The migration's foreign keys came before their indexes** — the revaluation lines' key to the revaluations
  (14.2). The fifth step in a row: `drizzle-kit` always writes them in this order.
- **Step 13's clients stopped working**: a required `unitCost` refused every line that did not send one, "out"
  lines included. It is optional now (`.default(null)`), and missing means "at the average cost".
- **Step 13's tests posted stock without a cost** and were refused with `stock_cost_required` — the rule working.
  Their lines cost ৳10 a piece now.
- **The journal test's own account 5290 collided with the template's new 5290.** The test moved to 5295; and the
  same collision in a real chart is why the stock accounts job uses an account at a template code only if it has
  the template's name (decision 17).
- **The stock accounts schema needed a cast** when it was built with `Object.fromEntries`. `perUse()` writes the
  keys out and needs none.
- **The revaluation form's label read "New cost per 1 pcs"**: it used the quantity formatter for the unit's name.
  `useUnitCode()` gives the code alone.
- **The valuation e2e test did not find a row on the phone**: the list is virtualized, and the row was below the
  fold. The test searches first, like a person would.
- **`expect.stringMatching()` is typed `any`**, which ESLint's `no-unsafe-assignment` refuses in a typed test. A
  plain `toMatch` instead.
- **The adjustment form went over its 100 KB budget** (102.2 KB): `MoneyInput` and its decimal.js came in with
  the cost box. Loading the "Add items" picker lazily saved only 2 KB (most of it is shared with the form); loading
  the cost box lazily saves 13 KB. That is the one kept.
- **The onboarding test counted 41 accounts**: the mock chart has the six new ones too.
- **The mock journal's numbers moved**: the mock workspace's seeded stock posts two entries of its own now, so the
  journal e2e test's first entry is JV-…-0009.
- **Break-it checks**: the eight in the header, each run on its whole test file.

---

## Notes left for later steps

**Step 15 (sales):**

- **A delivery is an outflow at the average cost**: `StockPostingService.post()` returns its value, and a new
  `StockBooksService.delivery()` posts Dr Cost of goods sold (the `cost_of_goods_sold` purpose) / Cr Inventory, with
  the delivery's branch. Add `stock_delivery` (or `sales_delivery`) to the journal sources and to
  `journal_entries_document_check`.
- **A sales return comes back at the cost it left with**: keep each delivery line's value, and hand it to `post()`
  as the return move's `value`, the way a transfer's receipt does.

**Step 17 (purchases):**

- **A goods receipt values its lines at the PO price** (`move.value` = quantity × price, like an adjustment's
  typed cost), and posts Dr Inventory / Cr a "goods received, not invoiced" account (a new purpose). The supplier's
  bill then moves it to accounts payable; a price difference between the PO and the bill is a revaluation-like
  entry.
- **Landed cost** (freight, LC charges, duty) is added to the items' value of one receipt: one more document that
  writes value-only movements, like a revaluation.

**Notes for any step:**

- **A workspace that typed its inventory in step 10's opening balances** shows "Out by" on the valuation page:
  that number is a value with no stock behind it. Revalue the stock to its real cost, then save the opening
  balances again without the inventory line (step 10 reverses the old entry); the books then agree.
- **FIFO** can be built later from the ledger: every movement keeps its value.
- **An inventory account per category** (raw materials, finished goods) is a choice on the category, read by
  `StockBooksService.accounts()`; nothing else changes.
- **The valuation page shows today.** A value "as of" a date is the sum of the movements' values up to it, per item
  — with the reports of step 21.
