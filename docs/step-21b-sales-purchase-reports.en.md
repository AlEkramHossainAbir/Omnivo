# Step 21b: Reports, part 2 — sales, purchases and the aging

> The implementation guide for "Phase 7 → Step 21", the second of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 21 (reports) is split into three guides: 21a (the
> dashboard), this one (the sales and purchase reports and the receivables and payables aging) and 21c (the VAT
> report, the stock movement report and the scheduled report emails).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `1219788`, "device e2e fix": 21a's
> code, its doc updates and the CI fixes) and checked from 2026-11-05 to 2026-11-09: `pnpm dedupe --check`, `pnpm lint`,
> `pnpm format`, `pnpm typecheck`, `pnpm test` (898 — 30 new), `pnpm test:integration` (689 — 36 new),
> `pnpm test:tenant-leak` (130 — 2 new), `pnpm build`, `pnpm test:bundle-size` (first load 227.6 KB gz, budget 230; the
> largest new page 124.1 KB, budget 140; the worker's list 441 files, 1465.7 KB gz, budget 2 MB), `pnpm test:openapi`,
> `pnpm boundaries`, `pnpm test:e2e` (Playwright on the mocks, 396 — 36 new, 2 of them skipped) and `pnpm test:e2e:pwa`
> (the worker on a production build, 4) — with the turbo cache bypassed (`--force`).
>
> Your `dev` has moved on since `1219788` (the storefront, ending at `415f3f1`). Only three files are changed on both
> sides: `packages/contracts/src/index.ts`, `en.ts` and `bn.ts`. See 21b.8 for what was checked on top of it.
>
> Also checked:
>
> - **The day an allocation counts, on Postgres** (21b.2): the backfill run again on real rows gave the same dates, the
>   trigger by hand as `omnivo_app` (a date before either document is raised to the later one, another workspace's row
>   refused), and the migration broken on purpose.
> - **The reports through the API** (21b.3, 21b.4): the rows add up to the totals in every group and sort, and the pages
>   together are the unpaged list; the aging equals the ledger on past days, today and days ahead. Broken on purpose, 7
>   times (a bucket's edge day, a draft payment counted, the day of an allocation always new, a sort, a category's
>   sub-categories among them): each time a test failed.
> - **The screens** (21b.6, 21b.7): in a browser against the mockup you approved, on a computer and a phone; it found the
>   names cut down to a few letters (decision 53). Broken on purpose, 4 times: each time a test failed.
> - **All of it against the real API in a browser** (21b.8): real documents, the numbers against the journal, the day an
>   allocation counts, and a real Excel file from the worker.

## Goal

📈 **What sold, what was bought, and who is late paying.** Since step 15 every sale is a document, since step 17 every
purchase, and the dashboard of 21a shows the totals. But an owner asks more than totals: which customers bought the
most this quarter, which products made the margin, what the Sylhet depot sold in October, how much went on
electricity, and above all which customers have owed money for more than 90 days. This step answers those four.

After this step:

- **A sales report** for any period: by customer, product, category, branch or month, with what was sold, what came
  back and the net. With `inventory.stock.value`, also the cost and the margin of each row.
- **A purchase report**: by supplier, product, expense account or month, with what was billed, what went back (debit
  notes) and the net.
- **The receivables aging**: on any day, what each customer owes, split into Current, 1–30, 31–60, 61–90 and over 90
  days past the due date, with the advances in their own column and the books' balance beside it. A customer's row
  opens their open invoices.
- **The payables aging**: the same for suppliers and their bills.
- **Every report exports** to Excel and PDF with all its rows, by the worker of step 11.
- **Each report has its module's permission:** `sales.report.read` for sales and the receivables, `purchase.report.read`
  for purchases and the payables.

## The whole picture

```
packages/contracts   trade-reports.ts: the sales and purchase report (query, rows, totals, books) · costColumns()
      │               aging.ts: the buckets, daysOverdue(), agingAmountsOf(), the report and a party's page
      │               reports.ts: four new REPORT_KINDS, REPORT_KIND_PERMISSIONS, reportKindsFor() (21b.1)
      ▼
packages/db          applied_on on the four allocation tables, filled for the old rows (21b.2)
      ▼
apps/api             the report queries, the allocation writers keep applied_on, four export kinds (21b.3)
      ▼
apps/app             four report pages, lazy, online only (21b.6)

Thursday 5 Nov 2026, the owner of a pharmacy distributor opens Reports → Receivables aging:
  as of 5 Nov 2026         Current   1–30      31–60    61–90   Over 90   Advances   Balance
  Sylhet Pharmacy          ৳42,000   ৳18,501   —        —       ৳9,000    ৳5,000     ৳64,501
  Lazz Pharma, Chattogram  ৳1,15,000 —         ৳20,000  —       —         —          ৳1,35,000
  …
  Total                    ৳12,40,000 …                                              ৳18,42,600
  In the books: ৳18,42,600 · Balanced
  she clicks Sylhet Pharmacy ──► INV-2026-27-0412 due 1 Jul 2026, 127 days late, ৳9,000 open …
  she picks "Overdue only" ──► only the customers with something past its due date
  she changes the date to 30 Sep 2026 ──► what they owed that day, with the receipts of October not yet applied
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| VAT report, stock movement report, scheduled emails | 21c |
| A compare column (this period against another) | Not chosen for 21b; the P&L has one |
| Sales by salesperson | No document has a salesperson yet |
| A branch filter on the aging | A receipt, an advance and a customer's balance belong to no one branch |
| Purchases in the books, beside the purchase report | A bill debits stock, GRNI and expense accounts: there is no one purchase account to compare with |
| Aging of opening balances and journal entries by hand | They are not documents and have no due date; the books' line shows them as a difference |
| Reports offline | Only the dashboard works offline (21a decision 7) |

## What changes in the code you already have

- **The contract (21b.1):** two new files, `trade-reports.ts` and `aging.ts`; `reports.ts` gets four report kinds, a
  permission per kind and their export queries, and its export routes lose their one permission; one error code;
  `routes.ts` and `index.ts`; `openapi.json` generated again.
- **The database (21b.2):** an `applied_on` date on the four allocation tables, filled for the rows you have, with an
  index each, and a trigger that keeps it from being before either document. Two migrations, 0059 and 0060.
- **The API (21b.3):** the four writers of allocations say which day each one starts to count; six new report routes
  (the sales and purchase reports, the two agings and a party's page of each) with their queries in two new files;
  the export routes check each kind's own permission; the worker writes the four new kinds to Excel and PDF.
- **The API's tests (21b.4):** two new integration suites, one for the sales and purchase reports and one for the
  agings and the day an allocation counts; the four new kinds in the export suite and in the reports' tenant-leak
  suite; unit tests for the export documents and for keeping an allocation's day. They found one bug, fixed in the
  21b.3 code (decision 42).
- **The words (21b.5):** the four pages' words in English and Bangla, their nav links, the four report kinds and
  one error; the Bangla words of the exported files now match the app's (decision 43).
- **The screens (21b.6):** four new report pages and two party pages, each a lazy chunk, with six new routes; the
  Reports group of the sidebar shows each link by its own permission; the Exports page opens with any report
  permission; the budget of a lazy chunk goes to 140 KB (decision 50).
- **The mock and the tests (21b.7):** a new `mocks/trade-report-data.ts` (the reports worked out from the mock's own
  documents), `mocks/trade-history-data.ts` (a year of trade, real documents, for `pnpm dev:mock` and the reports'
  tests), a fixture option `tradeHistory`, and `e2e/trade-reports.e2e.ts`. One class changes on three pages (decision 53).
- **The finish (21b.8):** the two big seeding tests get a longer time limit (they failed under the full run's load). The
  six pages run once against the real API in a browser, and every check runs once.
- **Not touched:** `packages/auth`, `packages/sync` and the sync protocol, the service worker, the POS screens, the sign-in
  and the device set-up. The statements of step 11 keep their own queries. A new package or environment variable: none.

## The decisions behind this step

You made the first fourteen and decision 25: 1–10 on 2026-11-05 for the whole of 21b, 11–14 while the contract was
written, and 25 while the database part was built. The others (15–24, 26–41) came up while building it; please read
them with care: they are mine.

1. **Four pages.** (You chose this.) Sales and Purchase, each with a "Group by" select (sales: customer, product,
   category, branch, month; purchases: supplier, product, expense account, month), the receivables aging and the
   payables aging. Their links go in the Reports group of the sidebar, each by its permission.
2. **The sales come from the documents' lines.** (You chose this.) Posted invoice lines and POS sale lines, less
   posted credit note lines and POS return lines; net of discounts, before VAT, by the document's date. A line under
   the report compares it with the books' sales (the `sales` account less the Sales returns account, as on the
   dashboard): a journal entry written by hand on the sales account makes them differ.
3. **Cost and margin only with `inventory.stock.value`.** (You chose this.) The cost comes from the sold lines: the
   challan line's cost for an invoice from a challan, the invoice's own stock movement for a direct invoice, the POS
   line's cost; less the cost of what came back. It is dated by the invoice, so a sale and its cost stay in the same
   period. In a month where a challan and its invoice fall in different months, this differs from the books' cost
   of goods sold, which dates the cost by the challan.
4. **Purchases come from the bills.** (You chose this.) Posted bill lines (products and accounts) and expenses, less
   posted debit notes, by the bill's date, before VAT.
5. **An `applied_on` date on the four allocation tables.** (You chose this.) `receipt_allocations`,
   `credit_note_allocations`, `supplier_payment_allocations` and `debit_note_allocations`. The old rows get the later
   of the two documents' dates; a new allocation gets the day it was made (decision 25 says which day that is); applying
   again keeps the date of a pair whose amount did not change. As of a day D: the documents dated D or before, less what was applied
   on D or before. The books' balance shows beside it. A known gap: a voided receipt's allocations are deleted, so
   between the receipt's date and the void the invoice shows open while the books show it paid; the books' line
   makes that visible.
6. **The aging's filters:** the date, the customer (or supplier) group, and "Overdue only". (You chose this.) No
   branch. A party's row opens a page of their open documents at the same date.
7. **The sales and purchase reports' filters:** a period with presets (like step 11), a branch, a customer (or
   supplier) group and a product category. (You chose this.) No compare column.
8. **Paged on the server.** (You chose this.) The rows come sorted and a page at a time, with the totals from the
   server; an export has every row.
9. **Four new export kinds** for the worker's Excel and PDF. (You chose this.) 21c's scheduled emails will use them.
10. **The aging needs only the report's permission.** (You chose this.) `sales.report.read` for the receivables,
    `purchase.report.read` for the payables; not `sales.customer.balance`.

**The contract (21b.1):**

11. **The purchase report's two item views each have one summary row.** (You chose this.) By product, every account
    line and expense of the bills is one "Expenses" row; by expense account, every product line is one "Products"
    row. So the rows of any view add up to all the purchases.
12. **"By product" adds up a product's variants.** (You chose this.) A product's variants share its base unit, so their
    quantities add up; a simple product is one variant anyway.
13. **A category is the product's own one, and its filter takes the categories under it.** (You chose this.) "By
    category" groups by the category each product is in, with one row for the products with none. Filtering by
    Medicine also takes Tablets under it, like the product list.
14. **Each report kind has its own permission for exports.** (You chose this.) The export routes no longer need
    `accounting.report.read`. Asking for an export needs the report's permission; the list leaves out the exports of
    reports the person may no longer read, and their download is refused.
15. **Two files: `trade-reports.ts` and `aging.ts`.** The sales and purchase reports share their rows, filters and
    totals; the two agings share everything but the party. Putting them in `reports.ts` would make it twice as long,
    and `reports.ts` imports them for the export queries anyway.
16. **A row is an "item" or stands for the lines with none.** `kind` says which: `walk_in` (POS sales with no
    customer), `no_category`, `expenses` and `products` (decision 11). Their name is left for the page to write in
    the person's language. Without them, the rows would not add up to the totals.
17. **Sorting:** a column's name sorts up, with a minus down, like the device list. "Name" sorts months by date. Two
    sorts are refused: by quantity outside the product group (`report_sort_invalid`, the schema's own check), and by
    cost, margin or margin % without `inventory.stock.value` (`permission_missing`, by the API): the order of the rows
    would tell what the hidden column says.
18. **The totals come with every page, the same each time,** and `withCost` says whether the cost columns exist. The
    page draws its columns from `withCost`, so they are right even with no rows.
19. **The books' line is `null` with a customer group or a category,** because the books' lines carry neither. A
    branch is fine: the books' lines carry it.
20. **A filter schema and a query schema per report.** The query is the filters plus the page (`limit`, `cursor`);
    an export carries the filters and the sort, never the page, so the file has every row in the page's order.
21. **"Overdue only" is a word, `show: 'all' | 'overdue'`, not a boolean.** A query string sends `"false"`, and
    `z.coerce.boolean()` turns every non-empty string into `true`.
22. **The aging's rules in the contract:** a document is current up to and on its due date; the edge days go to the
    lower bucket (30 days late is 1–30); the days are counted from the parts of the date strings in UTC, never from a
    `Date` in a time zone. A day after today is allowed: it shows what will be overdue by then. A party with nothing
    open and no advance has no row. The books' line is `null` with "Overdue only": the books know no due dates.
23. **A party's page is not paged,** and a customer that is not this workspace's is `not_found`.
24. **Two new route groups,** `tradeReports` and `aging`, so their OpenAPI names are `tradeReports.sales` and
    `aging.receivables`.

**The database (21b.2):**

25. **An allocation made with its document has the documents' date.** (You chose this, on 2026-11-05, while the
    database part was built.) The books date a payment by its document, not by the day it was typed in: a receipt of 1
    October entered on 5 November is paid on 1 October in the books. So an allocation written when its document is made
    or posted gets the later of the two documents' dates, the same as the old rows. One written later (an advance put on
    a new invoice, money applied again) gets that day, today in the workspace's time zone. Either way the totals are
    right; this keeps the buckets the same as the books' too.
26. **Never before either document, kept by the database.** A receipt dated after today (allowed) with its allocation
    dated today would take money off the invoice on days the receipt is not counted yet, and the aging would no longer
    add up to the books. A trigger moves every allocation up to the later of its two documents' dates, under every path
    that writes. The API still says which day it means: the Drizzle type asks for `appliedOn`, so no writer forgets.
27. **Two migrations: 0059 generated and changed by hand, 0060 written by hand.** A `NOT NULL` column cannot be added
    to a table with rows before it has values. 0059 adds the columns empty; 0060 fills them, then makes them required
    and builds their indexes.
28. **One index per table on `(tenant_id, applied_on)`:** "what was applied after D". The aging as of D needs the
    invoices that were open on D: the ones open now (the open invoices' index of step 15c) and the ones paid after D
    (this index). Without it, every as-of question would read all of a workspace's allocations.
29. **The backfill runs with the tables' triggers off.** With them on, every allocation would take its amount off its
    invoice and its receipt and put it back: the same result (checked), but two writes to every paid document. On a
    big workspace that is a long migration for nothing.

**The API (21b.3):**

30. **Who says which day.** The receipt, credit note, debit note or payment that writes allocations with itself passes
    its own date; money applied again later passes today in the workspace's time zone. A pair (one receipt, one
    invoice) whose amount did not change keeps its day. A pair whose amount changed gets the new day for its whole
    amount: moving an invoice from ৳500 to ৳800 of a receipt dates all ৳800 today, so for the days between, the aging
    shows ৳500 more open than it was. One row per pair cannot hold two days; the books' line beside the aging is
    still right.
31. **Pages by place, not by the last row.** A report's rows are sums: every page adds up all of the period's lines
    again before it sorts them. The cursor holds the place in the sorted list (an `OFFSET`), still opaque to the page.
    A keyset cursor would save nothing here, and a sum, a percent or a name that is `null` does not make a clean one.
32. **The totals come from the same query,** by a window function (`sum(…) OVER ()`), which Postgres works out before
    the `LIMIT`: the same totals on every page, in one round trip.
33. **The cost of a sold line.** An invoice line has its challan line's cost in the share it billed (the line's
    quantity over the challan line's: a return before billing makes the invoice bill less). A direct invoice has a
    challan too (step 15c makes one when it is posted), so the same rule covers it. A credit note line takes cost and
    quantity off only when it is for goods that came back (it has a return line), at that return line's cost in the
    same share; a price cut takes money off, nothing else. Each line's cost is rounded to 4 places before the sums.
34. **The aging as of D reads only what can be open.** A document's open amount on D is what is open now plus what
    was applied to it after D. So the query reads the invoices open now (their partial index of step 15c) and the
    allocations applied after D (the index of 21b.2), never every invoice the workspace has.
35. **An advance on D follows the books.** A receipt or a supplier payment voided after D still counts on D, as the
    books took it back only on the void day; its allocations went with the void, so its invoices show open on those
    days (the known gap of decision 5) while the balance stays the books'. A supplier payment that is a draft or
    waits for approval is no advance and pays no bill: it is not in the books yet.
36. **The books' line of the aging comes from the journal's lines,** not the day totals of 21a: only the lines carry
    the party, which the group filter and a party's page need.
37. **A party's page is for that kind of party only.** A supplier on the receivables' page is `not_found`, like an id
    of another workspace.
38. **The worker reads the person's permission itself.** It has no permission cache (it does not load the API's
    infrastructure), so a small query asks the database whether the person holds `inventory.stock.value` when the
    file is made. If they lost it since they asked, the file has no cost columns and is sorted by the net (decision
    17).
39. **One service for the four pages,** `TradeReportsService`, with its queries in `trade-report-queries.ts` and
    `aging-queries.ts`, where the worker finds them too. Six thin methods; two services would split nothing.
40. **An export of a report you may not read is refused with `permission_missing`** (403, the guard's own answer)
    when you ask for it or download it, and left out of your list.
41. **A quantity or a percent in a file is right-aligned text** ("72 pcs", "16.4%"): a new `number` cell. An amount
    stays a number Excel can add up; a quantity with its unit is not one.
42. **A row with no quantity sorts last by quantity** (found by 21b.4). The purchase report's "Expenses" row adds up
    zeros for its quantity but shows none; sorted by quantity it must go to the end both ways, like a margin percent
    of a row that sold nothing.
43. **A file says what the screen says** (found by 21b.5). The exported files' Bangla words (21b.3) now use the app's
    terms: প্রোডাক্ট, not পণ্য; কেনাকাটা, the nav's word for purchase; সময় পার for overdue, as the invoice and bill
    filters say it, and "সময় পার হয়নি" for current. A person who reads "শুধু সময় পার" on the page finds the same
    words on the PDF.
44. **The totals are in the KPI strip, not in a last row of the table** (21b.6, the mockup). The tables are virtualized
    and paged: a last row would appear only after the last page, and it would have to be left out of the sort. The
    KPI strip shows the server's totals from the first page.
45. **An aging's day and filters are in the address, the sort is not** (21b.6). Going to a party's page and back must
    land on the same report, and a credit controller sends the link to someone. The sales and purchase reports keep
    theirs in the page: they have no page behind a row. The sort is left out of the address because it is a way of
    reading the list, not what the list is.
46. **An aging opens sorted A to Z** (21b.6, the mockup). The API's default is the largest balance first, for a call
    without a sort; the page asks for `name`, because a person mostly comes to find one party, and the KPI strip
    already says how much is overdue. Any column header changes it.
47. **A zero in an aging is a dash** (21b.6, the mockup). A row of five bucket columns is read by where its money is.
48. **No count of parties under "Total due"** (21b.6). The mockup showed "38 customers", but the list is paged and the
    API does not count the rows; counting them only for this line would cost a second query on every page. A party's
    page has its documents in hand, so it does say "4 open invoices".
49. **Each report link shows by its own permission, and Exports by any of them** (21b.6). The Exports page lists only
    the kinds the person can read (decision 14), so someone with only the sales reports needs it too.
50. **A lazy chunk's budget is 140 KB** (21b.6, your choice). The POS return dialog went from 134.2 KB to 135.1 KB
    without changing: the contracts' route table is one chunk, and it grew by the four reports' schemas. Splitting
    the table by module is the real fix, and a step of its own.
51. **The mock's year of trade is real documents, dated by the last fiscal year** (21b.7). Real, so a party's page links to
    an invoice that opens and the books have lines to compare with. Dated by the last year's end, so a test reads the same
    numbers on any day. Off in every other test (`tradeHistory`), because those read exact numbers from the workspace.
52. **In the mock, an allocation counts from the later of its two documents' dates** (21b.7). The mock's allocations have
    no `applied_on`, and adding one would touch six writers for a mock. That is the date the API's backfill gives an old
    allocation. A re-apply today does not show as "today" in the mock; the API's own tests cover that (21b.4).
53. **A name in a wide table keeps 192px from 860px up** (21b.7, found in the browser). `truncate` lets a table cell shrink
    to almost nothing, so with nine columns the aging showed "Benga…". `min-[860px]:min-w-48` keeps the room. The table then
    scrolls inside its own box at 1280px, as it does in the mockup you approved (its table is 1080px wide).

## 21b.1 — `packages/contracts`: the contract

The contract first: what each report asks and answers. Two new files hold the four reports; `reports.ts` learns the
four new kinds of export.

### `trade-reports.ts` (new): the sales and purchase reports

```ts
import { z } from 'zod';

import { dashboardUnitSchema, marginPercent } from './dashboard.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { subtractMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// The sales report and the purchase report (step 21b): what was sold or bought in a period, one
// row per customer, product, category, branch or month.
//
// - The numbers come from the documents' lines, net of discounts and before VAT, by the
//   document's date. Sales: posted invoices and POS sales, less posted credit notes and POS
//   returns. Purchases: posted bills (product lines, account lines and expenses), less posted
//   debit notes.
// - The sales report also says what the books say (`books`): the 'sales' account less the Sales
//   returns account, like the dashboard. A journal entry written by hand on the sales account
//   makes the two differ, and the page shows by how much.
// - Cost and margin need inventory.stock.value. Without it they are null, and sorting by them is
//   refused.
// - Rows come a page at a time, sorted on the server. The totals are of every row, not of the page.

// ---------------------------------------------------------------------------------------------
// What a row is

export const SALES_REPORT_GROUPS = ['customer', 'product', 'category', 'branch', 'month'] as const;
export type SalesReportGroup = (typeof SALES_REPORT_GROUPS)[number];

export const PURCHASE_REPORT_GROUPS = ['supplier', 'product', 'account', 'month'] as const;
export type PurchaseReportGroup = (typeof PURCHASE_REPORT_GROUPS)[number];

// 'item' is one thing of the group: a customer, a product, a branch, a month. The others stand for
// the lines that have no such thing, so that the rows always add up to the whole period:
// - walk_in: POS sales with no customer (sales, by customer)
// - no_category: products with no category (by category)
// - expenses: every account line and expense of the bills (purchases, by product)
// - products: every product line of the bills (purchases, by account)
export const TRADE_REPORT_ROW_KINDS = [
  'item',
  'walk_in',
  'no_category',
  'expenses',
  'products',
] as const;
export type TradeReportRowKind = (typeof TRADE_REPORT_ROW_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// The query

// Both days included, like the other reports. `to` before `from` shows under "To".
function checkPeriod(query: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (query.from > query.to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: errorCode('report_range_invalid') });
  }
}

// A quantity adds up only inside one product (its variants share the base unit), so the quantity
// column, and sorting by it, belong to the product group only
function checkQuantitySort(query: { groupBy: string; sort: string }, ctx: z.RefinementCtx): void {
  if (query.groupBy !== 'product' && (query.sort === 'quantity' || query.sort === '-quantity')) {
    ctx.addIssue({ code: 'custom', path: ['sort'], message: errorCode('report_sort_invalid') });
  }
}

// A column name sorts up, the same name with a minus sorts down. 'name' sorts the months by date.
export const SALES_REPORT_SORTS = [
  'name',
  '-name',
  'quantity',
  '-quantity',
  'gross',
  '-gross',
  'returns',
  '-returns',
  'net',
  '-net',
  'cost',
  '-cost',
  'margin',
  '-margin',
  'marginPercent',
  '-marginPercent',
] as const;
export type SalesReportSort = (typeof SALES_REPORT_SORTS)[number];

// The sorts that read the cost: refused without inventory.stock.value, because the order of the
// rows would tell what the hidden column says
export const SALES_REPORT_COST_SORTS = [
  'cost',
  '-cost',
  'margin',
  '-margin',
  'marginPercent',
  '-marginPercent',
] as const satisfies readonly SalesReportSort[];

export function isCostSort(sort: SalesReportSort): boolean {
  return SALES_REPORT_COST_SORTS.some((item) => item === sort);
}

export const PURCHASE_REPORT_SORTS = [
  'name',
  '-name',
  'quantity',
  '-quantity',
  'gross',
  '-gross',
  'returns',
  '-returns',
  'net',
  '-net',
] as const;
export type PurchaseReportSort = (typeof PURCHASE_REPORT_SORTS)[number];

const salesReportFilterShape = {
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(SALES_REPORT_GROUPS).default('customer'),
  // Invoices and credit notes by their own branch, POS sales and returns by their warehouse's
  branchId: z.uuid().optional(),
  customerGroupId: z.uuid().optional(),
  // This category and every category under it
  categoryId: z.uuid().optional(),
  sort: z.enum(SALES_REPORT_SORTS).default('-net'),
};

// The report's filters without the page: what an export carries (every row, in the same order)
export const salesReportFilterSchema = z
  .object(salesReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type SalesReportFilter = z.infer<typeof salesReportFilterSchema>;

export const salesReportQuerySchema = pageQuerySchema
  .extend(salesReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type SalesReportQuery = z.input<typeof salesReportQuerySchema>;

const purchaseReportFilterShape = {
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(PURCHASE_REPORT_GROUPS).default('supplier'),
  branchId: z.uuid().optional(),
  supplierGroupId: z.uuid().optional(),
  // Product lines only: an account line or an expense has no category, so it drops out
  categoryId: z.uuid().optional(),
  sort: z.enum(PURCHASE_REPORT_SORTS).default('-net'),
};

export const purchaseReportFilterSchema = z
  .object(purchaseReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type PurchaseReportFilter = z.infer<typeof purchaseReportFilterSchema>;

export const purchaseReportQuerySchema = pageQuerySchema
  .extend(purchaseReportFilterShape)
  .superRefine((query, ctx) => {
    checkPeriod(query, ctx);
    checkQuantitySort(query, ctx);
  });
export type PurchaseReportQuery = z.input<typeof purchaseReportQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The answer. Every amount is a decimal string with 4 places, like the other reports; the page
// shows whole taka (a list), the export keeps the paisa.

const tradeReportRowBaseSchema = z.object({
  // Unique in the answer: the id, the month ('2026-09'), or the kind of a row that stands for
  // the lines with no such thing ('walk_in')
  key: z.string(),
  kind: z.enum(TRADE_REPORT_ROW_KINDS),
  // The customer, supplier, product, category, branch or account. null for a month and for a row
  // that is not an 'item'.
  id: z.uuid().nullable(),
  // The customer's, supplier's, product's, branch's or account's code. null for a category, a
  // month and a row that is not an 'item'.
  code: z.string().nullable(),
  name: z.string().nullable(),
  // The month's row only: '2026-09'
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable(),
  // The product group only (null elsewhere): what was sold less what came back, or what was
  // billed less what went back, in the product's base unit
  quantity: z.string().nullable(),
  baseUnit: dashboardUnitSchema.nullable(),
  // Sales: invoices and POS sales. Purchases: bills.
  gross: z.string(),
  // Sales: credit notes and POS returns. Purchases: debit notes. Positive: what was taken off.
  returns: z.string(),
  // gross − returns: what the row is worth in the period
  net: z.string(),
});

// What the sold lines cost, less the cost of what came back. A line from a challan has the
// challan's cost, a direct invoice line its own stock movement's, a POS line its own: each dated
// by the invoice or the sale, so a sale and its cost always fall in the same period. (The books
// date a challan's cost by the challan, so the two can differ in a month where a challan and its
// invoice fall in different months.)
const costColumnsSchema = z.object({
  // null without inventory.stock.value
  cost: z.string().nullable(),
  // net − cost
  margin: z.string().nullable(),
  // margin as a percent of net, one decimal; null without the permission or with net zero
  marginPercent: z.string().nullable(),
});

export const salesReportRowSchema = tradeReportRowBaseSchema.extend(costColumnsSchema.shape);
export type SalesReportRow = z.infer<typeof salesReportRowSchema>;

export const purchaseReportRowSchema = tradeReportRowBaseSchema;
export type PurchaseReportRow = z.infer<typeof purchaseReportRowSchema>;

const tradeTotalsSchema = z.object({ gross: z.string(), returns: z.string(), net: z.string() });

export const salesReportTotalsSchema = tradeTotalsSchema.extend(costColumnsSchema.shape);
export type SalesReportTotals = z.infer<typeof salesReportTotalsSchema>;

// The same totals on every page: the page reads them from the first one
export const salesReportSchema = pageOf(salesReportRowSchema).extend({
  totals: salesReportTotalsSchema,
  // false without inventory.stock.value: every cost, margin and percent is null. The page draws
  // the columns from this, so they are right even when there are no rows.
  withCost: z.boolean(),
  // The books' sales of the same period and branch, net and before VAT. null with a customer
  // group or a category: the books' lines carry neither, so there is nothing to compare with.
  books: z.string().nullable(),
});
export type SalesReport = z.infer<typeof salesReportSchema>;

export const purchaseReportSchema = pageOf(purchaseReportRowSchema).extend({
  totals: tradeTotalsSchema,
});
export type PurchaseReport = z.infer<typeof purchaseReportSchema>;

// The cost columns of a row or of the totals, from its net and its cost. The API and the mock both
// call it, so the margin and its percent are worked out one way.
export function costColumns(net: string, cost: string | null): z.infer<typeof costColumnsSchema> {
  if (cost === null) return { cost: null, margin: null, marginPercent: null };
  return {
    cost,
    margin: subtractMoney(net, cost),
    marginPercent: marginPercent({ sales: net, cost }),
  };
}

// ---------------------------------------------------------------------------------------------
// The routes

export const tradeReportRoutes = {
  sales: defineRoute({
    method: 'GET',
    path: '/reports/sales',
    summary: 'Sales of a period by customer, product, category, branch or month',
    auth: 'bearer',
    permission: 'sales.report.read',
    status: 200,
    query: salesReportQuerySchema,
    response: salesReportSchema,
  }),
  purchases: defineRoute({
    method: 'GET',
    path: '/reports/purchases',
    summary: 'Purchases of a period by supplier, product, expense account or month',
    auth: 'bearer',
    permission: 'purchase.report.read',
    status: 200,
    query: purchaseReportQuerySchema,
    response: purchaseReportSchema,
  }),
};
```

**The groups and the rows:**

- **The header comment is the design in one place:** where the numbers come from, what the books' line is, who sees
  the cost, and that the totals are of every row. 21b.3's queries and 21b.6's pages follow it.
- **`TRADE_REPORT_ROW_KINDS`** (decision 16): a row that is not an `item` has `id`, `code` and `name` all `null`, and
  its `key` is its kind. The page writes "Walk-in customers" or "Expenses" from the kind, in the person's language;
  the API never sends words.

**The query:**

- **`checkPeriod()` and `checkQuantitySort()` are plain functions,** called by both schemas of a report. The query
  starts from `pageQuerySchema` (the `limit` and `cursor` every list shares) and the filter has no page, so neither
  can be made from the other: both are built from the same shape (`…FilterShape`) and call the same two functions.
  Two copies of a check written out would drift apart.
- **`checkQuantitySort()` puts its error under `sort`,** so a form, if one ever shows it, has a place for it. The page
  only offers the quantity column in the product group, so a person never sees it; a hand-made URL does.
- **The sorts are written out,** not made by a function: `z.enum()` needs the literal strings to infer the type, and a
  generated list would need a cast.
- **`SALES_REPORT_COST_SORTS` uses `satisfies readonly SalesReportSort[]`:** a misspelt sort fails the type check.
  `isCostSort()` is what the API checks before it runs the query (decision 17).
- **`categoryId` is "this category and every category under it"** (decision 13), the same words as the product
  list's filter, so the API uses the same rule.
- **The purchase report's `categoryId` drops the account lines and expenses:** they have no product, so no category.
  The comment says so, because the totals then shrink in a way a person may not expect.
- **`SalesReportQuery` is `z.input`,** like the other list queries: the page leaves out what has a default.

**The answer:**

- **Every amount is a 4-place string,** like every report: the API reads Postgres's `NUMERIC(19,4)` sums, and the page
  rounds them to whole taka (a list) while the export keeps the paisa.
- **`month` has its own field with a pattern,** not only the `key`: the page formats it as "October 2026" and the
  pattern makes a wrong value fail the parse in the tests.
- **`quantity` and `baseUnit` are `null` outside the product group:** a customer's row mixes units. `baseUnit` reuses
  the dashboard's `dashboardUnitSchema` (code and decimals): the same two things `72 pcs` needs.
- **The cost columns are their own shape,** added to the sales row and the totals with `.extend(….shape)`. The purchase
  row has none: what a purchase cost is the purchase itself.
- **The comment on the cost says how it is dated** (decision 3), because the difference from the books' cost of goods
  sold will be asked about.
- **`books` is a plain string or `null`** (decision 19): the page shows the difference itself, so the API does not send
  it twice.
- **`costColumns()` is the one place the margin is worked out,** for the API, the mock and the totals. It reuses the
  dashboard's `marginPercent()`, so a margin of 22.5% reads the same on the dashboard and here. With a net of zero
  there is a margin (the cost of what was written off) but no percent.

**The routes:**

- **Each report has its module's permission** (decision 10 for the agings, the same idea here): `sales.report.read`
  and `purchase.report.read`, both in the catalog since 21a. `defineRoute()` puts the guard on the route, so the API
  needs no check of its own for them.

```ts
import { describe, expect, it } from 'vitest';

import {
  costColumns,
  isCostSort,
  purchaseReportFilterSchema,
  purchaseReportQuerySchema,
  salesReportQuerySchema,
  salesReportSchema,
} from './trade-reports.js';

describe('the sales report query', () => {
  it('starts by customer, the largest net first, 50 rows a page', () => {
    expect(salesReportQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'customer',
      sort: '-net',
      limit: 50,
    });
  });

  it('refuses a period that ends before it starts, under To', () => {
    const result = salesReportQuerySchema.safeParse({ from: '2026-10-31', to: '2026-10-01' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: 'report_range_invalid',
    });
  });

  it('sorts by quantity only by product', () => {
    const byCustomer = salesReportQuerySchema.safeParse({
      from: '2026-10-01',
      to: '2026-10-31',
      sort: '-quantity',
    });
    expect(byCustomer.error?.issues[0]).toMatchObject({
      path: ['sort'],
      message: 'report_sort_invalid',
    });
    expect(
      salesReportQuerySchema.safeParse({
        from: '2026-10-01',
        to: '2026-10-31',
        groupBy: 'product',
        sort: '-quantity',
      }).success,
    ).toBe(true);
  });

  it('knows the sorts that read the cost', () => {
    expect(isCostSort('-marginPercent')).toBe(true);
    expect(isCostSort('cost')).toBe(true);
    expect(isCostSort('-net')).toBe(false);
  });
});

describe('the purchase report query', () => {
  it('starts by supplier, and keeps the same checks with or without the page', () => {
    expect(purchaseReportQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31' })).toMatchObject(
      { groupBy: 'supplier', sort: '-net' },
    );
    const result = purchaseReportFilterSchema.safeParse({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'account',
      sort: 'quantity',
    });
    expect(result.error?.issues[0]?.message).toBe('report_sort_invalid');
  });

  it('leaves the page out of an export', () => {
    const filter = purchaseReportFilterSchema.parse({
      from: '2026-10-01',
      to: '2026-10-31',
      limit: 20,
      cursor: 'abc',
    });
    expect(filter).not.toHaveProperty('limit');
    expect(filter).not.toHaveProperty('cursor');
  });
});

describe('costColumns', () => {
  it('works out the margin and its percent from the net and the cost', () => {
    // Napa 500 mg in October: ৳1,20,000 sold, ৳93,000 cost
    expect(costColumns('120000.0000', '93000.0000')).toEqual({
      cost: '93000.0000',
      margin: '27000.0000',
      marginPercent: '22.5',
    });
  });

  it('has a margin but no percent when the net is zero, and nothing without the cost', () => {
    // Sold and all of it came back, after the cost of a broken strip was written off
    expect(costColumns('0.0000', '150.0000')).toEqual({
      cost: '150.0000',
      margin: '-150.0000',
      marginPercent: null,
    });
    expect(costColumns('120000.0000', null)).toEqual({
      cost: null,
      margin: null,
      marginPercent: null,
    });
  });
});

describe('salesReportSchema', () => {
  const row = {
    key: 'walk_in',
    kind: 'walk_in',
    id: null,
    code: null,
    name: null,
    month: null,
    quantity: null,
    baseUnit: null,
    gross: '52650.5000',
    returns: '368.0000',
    net: '52282.5000',
    cost: null,
    margin: null,
    marginPercent: null,
  };
  const totals = {
    gross: '52650.5000',
    returns: '368.0000',
    net: '52282.5000',
    cost: null,
    margin: null,
    marginPercent: null,
  };

  it('reads a page with the walk-in row and no cost', () => {
    expect(
      salesReportSchema.safeParse({
        items: [row],
        nextCursor: null,
        totals,
        withCost: false,
        books: '52282.5000',
      }).success,
    ).toBe(true);
  });

  it('refuses a month that is not a year and a month', () => {
    const result = salesReportSchema.safeParse({
      items: [{ ...row, key: '2026-10-01', kind: 'item', month: '2026-10-01' }],
      nextCursor: null,
      totals,
      withCost: false,
      books: null,
    });
    expect(result.error?.issues[0]?.path).toEqual(['items', 0, 'month']);
  });
});
```

- **"Starts by customer, the largest net first"** pins the defaults, which the page and the export both rely on.
- **"Sorts by quantity only by product"** checks both sides of the rule: refused by customer, allowed by product.
- **"Leaves the page out of an export"** checks that `limit` and `cursor` are dropped, not refused: an export made from
  the page's query sends them, and Zod's `z.object()` strips keys it does not know.
- **"Has a margin but no percent when the net is zero"** is the edge where a division by zero would hide.
- **"Refuses a month that is not a year and a month"** keeps the pattern from being loosened later.

### `aging.ts` (new): the receivables and payables aging

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { addMoney, subtractMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';

// The receivables and payables aging (step 21b): on a chosen day, what each customer still owes
// (or each supplier is still owed), split by how long it has been due.
//
// - As of D: the documents dated D or before, less what was applied to them on D or before (the
//   allocations' applied_on, step 21b.2). So the report of a past day shows that day, not today.
// - The age counts from the due date. A document due on D or later is "current".
// - Money received (or paid) and not applied to any document yet is an advance, in its own
//   column, never spread over the buckets: nobody knows yet which document it will pay.
// - Beside the report, the receivable (or payable) account's balance in the books on D. Opening
//   balances and journal entries written by hand on that account are not documents, so the two
//   can differ, and the page shows by how much.

// ---------------------------------------------------------------------------------------------
// The buckets

// The names are also the answer's fields and the sort keys
export const AGING_BUCKETS = [
  'current',
  'days1To30',
  'days31To60',
  'days61To90',
  'over90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

// The days from one date to another: 1 from 2026-11-04 to 2026-11-05, negative backwards. It reads
// the parts of the strings and counts in UTC, so no time zone and no summer time can move a day.
export function daysBetween(from: string, to: string): number {
  return (utcDay(to) - utcDay(from)) / 86_400_000;
}

function utcDay(isoDate: string): number {
  return Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
}

// How many days past its due date a document is on asOf: 0 when it is not due yet, or due that day
export function daysOverdue(dueDate: string, asOf: string): number {
  return Math.max(0, daysBetween(dueDate, asOf));
}

export function agingBucketOf(dueDate: string, asOf: string): AgingBucket {
  const days = daysOverdue(dueDate, asOf);
  if (days === 0) return 'current';
  if (days <= 30) return 'days1To30';
  if (days <= 60) return 'days31To60';
  if (days <= 90) return 'days61To90';
  return 'over90';
}

// One party's (or the whole report's) amounts. Every amount is a decimal string with 4 places, in
// the sense of the report: what the customer owes us, or what we owe the supplier.
export const agingAmountsSchema = z.object({
  current: z.string(),
  days1To30: z.string(),
  days31To60: z.string(),
  days61To90: z.string(),
  over90: z.string(),
  // The five buckets together: what the documents still have open
  due: z.string(),
  // Received (or paid) and not applied yet. Positive.
  advances: z.string(),
  // due − advances. Negative when the advances are larger.
  balance: z.string(),
});
export type AgingAmounts = z.infer<typeof agingAmountsSchema>;

// The amounts of one party from its open documents and its advances. The mock and the party's page
// call it; the API works the same buckets out in SQL to sort and page the parties, and its tests
// check both against the same days.
export function agingAmountsOf(
  documents: readonly { dueDate: string; open: string }[],
  advances: readonly string[],
  asOf: string,
): AgingAmounts {
  const buckets: Record<AgingBucket, string> = {
    current: '0.0000',
    days1To30: '0.0000',
    days31To60: '0.0000',
    days61To90: '0.0000',
    over90: '0.0000',
  };
  let due = '0.0000';
  for (const document of documents) {
    const bucket = agingBucketOf(document.dueDate, asOf);
    buckets[bucket] = addMoney(buckets[bucket], document.open);
    due = addMoney(due, document.open);
  }
  const advance = advances.reduce((sum, amount) => addMoney(sum, amount), '0.0000');
  return { ...buckets, due, advances: advance, balance: subtractMoney(due, advance) };
}

// ---------------------------------------------------------------------------------------------
// The report: one row per party

// 'overdue' keeps the parties with anything past its due date, and shows their whole row
export const AGING_SHOWS = ['all', 'overdue'] as const;
export type AgingShow = (typeof AGING_SHOWS)[number];

export const AGING_SORTS = [
  'name',
  '-name',
  'current',
  '-current',
  'days1To30',
  '-days1To30',
  'days31To60',
  '-days31To60',
  'days61To90',
  '-days61To90',
  'over90',
  '-over90',
  'due',
  '-due',
  'advances',
  '-advances',
  'balance',
  '-balance',
] as const;
export type AgingSort = (typeof AGING_SORTS)[number];

// No branch: a receipt, an advance and a customer's balance belong to no one branch. A day after
// today is allowed: it shows what will be overdue by then if nothing is paid.
const agingFilterShape = {
  asOf: z.iso.date(),
  show: z.enum(AGING_SHOWS).default('all'),
  sort: z.enum(AGING_SORTS).default('-balance'),
};

// The filters without the page: what an export carries
export const arAgingFilterSchema = z.object({
  ...agingFilterShape,
  customerGroupId: z.uuid().optional(),
});
export type ArAgingFilter = z.infer<typeof arAgingFilterSchema>;

export const arAgingQuerySchema = pageQuerySchema.extend(arAgingFilterSchema.shape);
export type ArAgingQuery = z.input<typeof arAgingQuerySchema>;

export const apAgingFilterSchema = z.object({
  ...agingFilterShape,
  supplierGroupId: z.uuid().optional(),
});
export type ApAgingFilter = z.infer<typeof apAgingFilterSchema>;

export const apAgingQuerySchema = pageQuerySchema.extend(apAgingFilterSchema.shape);
export type ApAgingQuery = z.input<typeof apAgingQuerySchema>;

// A party with nothing open and no advance on asOf has no row
export const agingRowSchema = agingAmountsSchema.extend({ party: partyRefSchema });
export type AgingRow = z.infer<typeof agingRowSchema>;

// The same answer for both: the customer is the party in one, the supplier in the other
export const agingReportSchema = pageOf(agingRowSchema).extend({
  asOf: z.iso.date(),
  // Every row's amounts added up, not only the page's
  totals: agingAmountsSchema,
  // The receivable (or payable) account's balance in the books on asOf, for the same customers
  // (with the group filter too), in the sense of the report. null with "overdue only": the books
  // know nothing of due dates, so there is nothing to compare with.
  ledger: z.string().nullable(),
});
export type AgingReport = z.infer<typeof agingReportSchema>;

// ---------------------------------------------------------------------------------------------
// One party's page: the documents behind its row

export const agingDocumentSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  dueDate: z.iso.date(),
  total: z.string(),
  // What was still open on asOf: the total, less what was applied to it by then
  open: z.string(),
  daysOverdue: z.number().int().min(0),
  bucket: z.enum(AGING_BUCKETS),
});
export type AgingDocument = z.infer<typeof agingDocumentSchema>;

// A bill also shows the supplier's own number: the one on the paper the supplier sent
export const apAgingDocumentSchema = agingDocumentSchema.extend({
  supplierBillNumber: z.string(),
});
export type ApAgingDocument = z.infer<typeof apAgingDocumentSchema>;

// What makes up the advances: a receipt (or payment) or a credit note (or debit note) with money
// not applied yet on asOf, less what was paid back with a refund by then
export const AR_ADVANCE_KINDS = ['receipt', 'credit_note'] as const;
export const AP_ADVANCE_KINDS = ['payment', 'debit_note'] as const;

const advanceShape = {
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // Not applied on asOf. Positive.
  amount: z.string(),
};

export const arAgingAdvanceSchema = z.object({ kind: z.enum(AR_ADVANCE_KINDS), ...advanceShape });
export type ArAgingAdvance = z.infer<typeof arAgingAdvanceSchema>;

export const apAgingAdvanceSchema = z.object({ kind: z.enum(AP_ADVANCE_KINDS), ...advanceShape });
export type ApAgingAdvance = z.infer<typeof apAgingAdvanceSchema>;

// Not paged: one party's open documents are a page's worth. The documents the oldest due date
// first, the advances the oldest first.
const agingPartyShape = {
  asOf: z.iso.date(),
  party: partyRefSchema,
  // The party's row of the report
  totals: agingAmountsSchema,
  // This party's balance in the books on asOf (the account's lines with this party)
  ledger: z.string(),
};

export const arAgingPartySchema = z.object({
  ...agingPartyShape,
  documents: z.array(agingDocumentSchema),
  advances: z.array(arAgingAdvanceSchema),
});
export type ArAgingParty = z.infer<typeof arAgingPartySchema>;

export const apAgingPartySchema = z.object({
  ...agingPartyShape,
  documents: z.array(apAgingDocumentSchema),
  advances: z.array(apAgingAdvanceSchema),
});
export type ApAgingParty = z.infer<typeof apAgingPartySchema>;

export const agingPartyQuerySchema = z.object({ asOf: z.iso.date() });
export type AgingPartyQuery = z.infer<typeof agingPartyQuerySchema>;

// ---------------------------------------------------------------------------------------------
// The routes. Only the report's permission (decision 10): the aging is a report of the module,
// not a look at one customer's balance, so sales.customer.balance is not asked for.

export const agingRoutes = {
  receivables: defineRoute({
    method: 'GET',
    path: '/reports/ar-aging',
    summary: 'What each customer owes on a day, by how long it has been due',
    auth: 'bearer',
    permission: 'sales.report.read',
    status: 200,
    query: arAgingQuerySchema,
    response: agingReportSchema,
  }),
  // A customer of another workspace, or none, is not_found
  receivablesOf: defineRoute({
    method: 'GET',
    path: '/reports/ar-aging/:customerId',
    summary: "One customer's open invoices and advances on a day",
    auth: 'bearer',
    permission: 'sales.report.read',
    status: 200,
    params: z.object({ customerId: z.uuid() }),
    query: agingPartyQuerySchema,
    response: arAgingPartySchema,
  }),
  payables: defineRoute({
    method: 'GET',
    path: '/reports/ap-aging',
    summary: 'What is owed to each supplier on a day, by how long it has been due',
    auth: 'bearer',
    permission: 'purchase.report.read',
    status: 200,
    query: apAgingQuerySchema,
    response: agingReportSchema,
  }),
  payablesOf: defineRoute({
    method: 'GET',
    path: '/reports/ap-aging/:supplierId',
    summary: "One supplier's open bills and advances on a day",
    auth: 'bearer',
    permission: 'purchase.report.read',
    status: 200,
    params: z.object({ supplierId: z.uuid() }),
    query: agingPartyQuerySchema,
    response: apAgingPartySchema,
  }),
};
```

**The buckets:**

- **`AGING_BUCKETS`' names are also the answer's fields and the sort keys,** so one name means one thing from the
  query to the page. They are camel case (`days1To30`), because a JavaScript field cannot start with a digit.
- **`daysBetween()` counts from the parts of the strings in UTC,** like `shiftIsoDate()` in `journal.ts`. `new
  Date('2026-11-05')` in a time zone with summer time could be 23 or 25 hours from the day before, and the division
  would not be a whole number.
- **`daysOverdue()` never goes below zero:** a document not due yet is 0 days overdue, not −10. The party's page shows
  the number as it is.
- **`agingBucketOf()` reads the days once** and walks the edges from the top; 30 days late is still 1–30 (decision
  22), the way an aging is read in accounting.

**The amounts:**

- **`agingAmountsSchema` is one party's row and the report's totals,** the same shape, so the totals row of the table
  is one more row.
- **`advances` is positive and `balance` is `due − advances`:** a customer with only an advance has a negative balance,
  which the page shows as "in advance" (CLAUDE.md → A customer's balance).
- **`agingAmountsOf()` is the bucket rule in one place** for the mock and the party's page. The API sorts and pages the
  parties by bucket, so it works the buckets out in SQL; 21b.4 checks the SQL against the same edge days as the tests
  below.

**The report:**

- **`AGING_SHOWS`** is decision 21: a word, never a boolean in a query string.
- **The default sort is `-balance`:** the largest balance first, the customer to call first.
- **`asOf` is not limited to today or before** (decision 22).
- **`arAgingFilterSchema` has no checks,** so the query is a plain `.extend(….shape)` of the page query; there is
  nothing to keep in step.
- **The two agings share `agingReportSchema`:** the party is the customer in one and the supplier in the other, and the
  route says which.
- **`ledger` is `null` with "Overdue only"** (decision 22). With a group filter it is the books' balance of the same
  customers: the receivable lines carry the party (step 15a), and the party has the group.

**A party's page:**

- **`open` is what was open on `asOf`,** not today: the same rule as the report, so the party's page adds up to its
  row.
- **A bill shows the supplier's own number** (`supplierBillNumber`): the supplier calls about "their bill
  PSM/2026/0412", not our BILL number.
- **The advances say what they are** (`receipt` or `credit_note`; `payment` or `debit_note`), so the page can link each
  one to its document.
- **The party's `ledger` is never `null`:** there is no "Overdue only" on this page.

**The routes:**

- **A party's page has the report's permission too** (decision 10): it is the same numbers, one row opened.
- **`:customerId` and `:supplierId`,** not `:id`: the route says whose page it is, and the OpenAPI document shows it.

```ts
import { describe, expect, it } from 'vitest';

import {
  agingAmountsOf,
  agingBucketOf,
  arAgingFilterSchema,
  arAgingQuerySchema,
  daysBetween,
  daysOverdue,
} from './aging.js';

describe('days and buckets', () => {
  it('counts days across a month, a leap day and a year', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-11-05', '2026-11-01')).toBe(-4);
  });

  it('is current on its due date, and overdue from the day after', () => {
    expect(daysOverdue('2026-11-05', '2026-11-05')).toBe(0);
    expect(daysOverdue('2026-11-20', '2026-11-05')).toBe(0);
    expect(agingBucketOf('2026-11-05', '2026-11-05')).toBe('current');
    expect(daysOverdue('2026-11-04', '2026-11-05')).toBe(1);
    expect(agingBucketOf('2026-11-04', '2026-11-05')).toBe('days1To30');
  });

  it('puts each edge day in the lower bucket', () => {
    // As of 5 Nov 2026: due 6 Oct is 30 days late, 5 Oct is 31
    expect(agingBucketOf('2026-10-06', '2026-11-05')).toBe('days1To30');
    expect(agingBucketOf('2026-10-05', '2026-11-05')).toBe('days31To60');
    expect(agingBucketOf('2026-09-06', '2026-11-05')).toBe('days31To60');
    expect(agingBucketOf('2026-09-05', '2026-11-05')).toBe('days61To90');
    expect(agingBucketOf('2026-08-07', '2026-11-05')).toBe('days61To90');
    expect(agingBucketOf('2026-08-06', '2026-11-05')).toBe('over90');
  });
});

describe('agingAmountsOf', () => {
  it('adds the open amounts into their buckets and takes the advances off the balance', () => {
    // Sylhet Pharmacy on 5 Nov 2026: three invoices open, one receipt not applied yet
    expect(
      agingAmountsOf(
        [
          { dueDate: '2026-11-15', open: '42000.0000' },
          { dueDate: '2026-10-20', open: '18500.5000' },
          { dueDate: '2026-07-01', open: '9000.0000' },
        ],
        ['5000.0000'],
        '2026-11-05',
      ),
    ).toEqual({
      current: '42000.0000',
      days1To30: '18500.5000',
      days31To60: '0.0000',
      days61To90: '0.0000',
      over90: '9000.0000',
      due: '69500.5000',
      advances: '5000.0000',
      balance: '64500.5000',
    });
  });

  it('has a negative balance when only an advance is left', () => {
    expect(agingAmountsOf([], ['20000.0000', '1500.0000'], '2026-11-05')).toMatchObject({
      due: '0.0000',
      advances: '21500.0000',
      balance: '-21500.0000',
    });
  });
});

describe('the aging query', () => {
  it('shows everyone, the largest balance first', () => {
    expect(arAgingQuerySchema.parse({ asOf: '2026-11-05' })).toEqual({
      asOf: '2026-11-05',
      show: 'all',
      sort: '-balance',
      limit: 50,
    });
  });

  it('takes "overdue only" as a word, not a boolean a query string would turn into true', () => {
    expect(arAgingFilterSchema.safeParse({ asOf: '2026-11-05', show: 'false' }).success).toBe(
      false,
    );
    expect(arAgingFilterSchema.parse({ asOf: '2026-11-05', show: 'overdue' }).show).toBe('overdue');
  });
});
```

- **"Puts each edge day in the lower bucket"** walks every edge on 5 November 2026: 30 and 31, 60 and 61, 90 and 91
  days. These are the days 21b.4's SQL test uses too.
- **"Counts days across a month, a leap day and a year"** is where a day count by hand goes wrong.
- **"Takes 'overdue only' as a word"** is decision 21: `"false"` is refused, not read as "show the overdue".

### `reports.ts`: four new kinds of export

```diff
@@ -1,6 +1,7 @@
 import { z } from 'zod';
 
 import { ACCOUNT_TYPES, type AccountType, NORMAL_BALANCE } from './accounts.js';
+import { apAgingFilterSchema, arAgingFilterSchema } from './aging.js';
 import { signedUrlSchema } from './attachments.js';
 import { errorCode } from './errors.js';
 import { defineRoute } from './http.js';
@@ -8,6 +9,8 @@ import { addMoney, isZeroMoney, subtractMoney, sumMoney } from './money.js';
 import { periodOf } from './numbering.js';
 import { pageOf, pageQuerySchema } from './pagination.js';
 import { shiftIsoDate } from './journal.js';
+import type { PermissionKey } from './permissions.js';
+import { purchaseReportFilterSchema, salesReportFilterSchema } from './trade-reports.js';
 
 // ---------------------------------------------------------------------------------------------
 // Fiscal years. The workspace's settings say in which month a year starts (July in Bangladesh).
@@ -34,15 +37,45 @@ export function fiscalYearLabel(start: string, startMonth: number): string {
 }
 
 // ---------------------------------------------------------------------------------------------
-// The three reports. Every amount is a decimal string with 4 places, like the ledger.
-
-export const REPORT_KINDS = ['trial_balance', 'profit_and_loss', 'balance_sheet'] as const;
+// The reports a file can be made of: the three statements here, and since step 21b the sales and
+// purchase reports (trade-reports.ts) and the two agings (aging.ts). Every amount is a decimal
+// string with 4 places, like the ledger.
+
+export const REPORT_KINDS = [
+  'trial_balance',
+  'profit_and_loss',
+  'balance_sheet',
+  'sales_report',
+  'purchase_report',
+  'ar_aging',
+  'ap_aging',
+] as const;
 export type ReportKind = (typeof REPORT_KINDS)[number];
 
 export function isReportKind(value: string): value is ReportKind {
   return REPORT_KINDS.some((kind) => kind === value);
 }
 
+// The permission each report needs: to read it, to export it, and again to download the file and
+// to see it in the list of exports. A person who lost the permission since the export loses the
+// file too.
+export const REPORT_KIND_PERMISSIONS = {
+  trial_balance: 'accounting.report.read',
+  profit_and_loss: 'accounting.report.read',
+  balance_sheet: 'accounting.report.read',
+  sales_report: 'sales.report.read',
+  purchase_report: 'purchase.report.read',
+  ar_aging: 'sales.report.read',
+  ap_aging: 'purchase.report.read',
+} as const satisfies Record<ReportKind, PermissionKey>;
+
+// The kinds a person may export, in REPORT_KINDS' order. Plain strings, like dashboardCardsFor():
+// me.permissions is z.string()[] on the wire.
+export function reportKindsFor(permissions: readonly string[]): ReportKind[] {
+  const held = new Set(permissions);
+  return REPORT_KINDS.filter((kind) => held.has(REPORT_KIND_PERMISSIONS[kind]));
+}
+
 // Both days included. `to` before `from` is a mistake the form can show under "To".
 export const trialBalanceQuerySchema = z
   .object({ from: z.iso.date(), to: z.iso.date() })
@@ -384,7 +417,8 @@ export const EXPORT_STATUSES = ['pending', 'ready', 'failed'] as const;
 export type ExportStatus = (typeof EXPORT_STATUSES)[number];
 
 // The report and its query, exactly as the report page asked for it. The worker parses the query
-// with the same schema again when it runs.
+// with the same schema again when it runs. A report with pages exports its filters without the
+// page (limit, cursor): the file has every row, in the page's order.
 export const reportExportInputSchema = z.discriminatedUnion('report', [
   z.object({
     report: z.literal('trial_balance'),
@@ -401,6 +435,26 @@ export const reportExportInputSchema = z.discriminatedUnion('report', [
     format: z.enum(EXPORT_FORMATS),
     query: balanceSheetQuerySchema,
   }),
+  z.object({
+    report: z.literal('sales_report'),
+    format: z.enum(EXPORT_FORMATS),
+    query: salesReportFilterSchema,
+  }),
+  z.object({
+    report: z.literal('purchase_report'),
+    format: z.enum(EXPORT_FORMATS),
+    query: purchaseReportFilterSchema,
+  }),
+  z.object({
+    report: z.literal('ar_aging'),
+    format: z.enum(EXPORT_FORMATS),
+    query: arAgingFilterSchema,
+  }),
+  z.object({
+    report: z.literal('ap_aging'),
+    format: z.enum(EXPORT_FORMATS),
+    query: apAgingFilterSchema,
+  }),
 ]);
 export type ReportExportInput = z.infer<typeof reportExportInputSchema>;
 
@@ -422,13 +476,16 @@ export type ReportExport = z.infer<typeof reportExportSchema>;
 
 export const reportExportPageSchema = pageOf(reportExportSchema);
 
+// No permission on the routes since step 21b: each report has its own (REPORT_KIND_PERMISSIONS),
+// and one route serves them all. The API checks the report's permission when the export is asked
+// for, leaves out of the list the exports of reports the person may no longer read, and refuses
+// their download.
 export const reportExportRoutes = {
   create: defineRoute({
     method: 'POST',
     path: '/report-exports',
     summary: 'Ask the worker to write a report as an Excel or PDF file',
     auth: 'bearer',
-    permission: 'accounting.report.read',
     status: 201,
     body: reportExportInputSchema,
     response: reportExportSchema,
@@ -439,7 +496,6 @@ export const reportExportRoutes = {
     path: '/report-exports',
     summary: "The signed-in user's exports, newest first",
     auth: 'bearer',
-    permission: 'accounting.report.read',
     status: 200,
     query: pageQuerySchema,
     response: reportExportPageSchema,
@@ -449,7 +505,6 @@ export const reportExportRoutes = {
     path: '/report-exports/:id/download',
     summary: 'A short-lived URL to download a finished export',
     auth: 'bearer',
-    permission: 'accounting.report.read',
     status: 200,
     params: z.object({ id: z.uuid() }),
     // The same short-lived link as an attachment's download
```

- **`REPORT_KINDS` gets the four reports.** The database stores the kind as `text` with this list as its TypeScript
  type only (no check in Postgres), so no migration is needed. Every `Record<ReportKind, …>` in the API, the mock and
  the words now fails the type check until it has the four; that is how 21b.3, 21b.5 and 21b.7 find their places.
- **`REPORT_KIND_PERMISSIONS`** is decision 14, with `satisfies Record<ReportKind, PermissionKey>`: a new kind without
  a permission fails the type check.
- **`reportKindsFor()` takes plain strings,** like `dashboardCardsFor()`, and keeps the list order. The exports page
  uses it for its report names, the API for the list.
- **The export union gets the filter schemas, not the query schemas:** `limit` and `cursor` never reach the stored
  query, and the worker runs every row (decision 20).
- **The three export routes lose `permission`.** `defineRoute()` then only checks that the person is signed in; the
  service checks the kind's permission (21b.3). The OpenAPI document shows the three without `x-permission`.

```diff
@@ -7,6 +7,7 @@ import {
   profitAndLossQuerySchema,
   type ReportAccount,
   reportExportInputSchema,
+  reportKindsFor,
   reportSection,
   trialBalanceQuerySchema,
 } from './reports.js';
@@ -64,6 +65,36 @@ describe('report queries', () => {
     });
     expect(result.error?.issues[0]?.path).toEqual(['query', 'asOf']);
   });
+
+  it('exports a sales report with its filters, without the page', () => {
+    const result = reportExportInputSchema.parse({
+      report: 'sales_report',
+      format: 'xlsx',
+      query: { from: '2026-10-01', to: '2026-10-31', groupBy: 'product', limit: '50' },
+    });
+    expect(result.query).toEqual({
+      from: '2026-10-01',
+      to: '2026-10-31',
+      groupBy: 'product',
+      sort: '-net',
+    });
+  });
+});
+
+describe('reportKindsFor', () => {
+  it('gives each report by its own module permission, in the list order', () => {
+    expect(reportKindsFor(['purchase.report.read', 'sales.report.read'])).toEqual([
+      'sales_report',
+      'purchase_report',
+      'ar_aging',
+      'ap_aging',
+    ]);
+    expect(reportKindsFor(['accounting.report.read', 'core.user.invite'])).toEqual([
+      'trial_balance',
+      'profit_and_loss',
+      'balance_sheet',
+    ]);
+  });
 });
 
 describe('a report section', () => {
```

- **"Exports a sales report with its filters, without the page"** sends `limit` as the page would and checks that the
  stored query has the defaults filled in and no `limit`.
- **"Gives each report by its own module permission"** checks both module permissions and that an unknown key does
  nothing.

### `errors.ts`, `routes.ts`, `index.ts`

```diff
@@ -93,6 +93,8 @@ export const ERROR_CODES = [
   // reports and year-end close
   'report_range_invalid',
   'report_compare_incomplete',
+  // Step 21b: a sort the report's group has no column for (quantity outside the product group)
+  'report_sort_invalid',
   'year_end_invalid',
   'year_not_ended',
   'year_already_closed',
```

- **One new code, `report_sort_invalid`.** Its words come in 21b.5; until then `packages/i18n` fails its type check
  (every code needs English words).

```diff
@@ -1,6 +1,7 @@
 import { z } from 'zod';
 
 import { accountRoutes } from './accounts.js';
+import { agingRoutes } from './aging.js';
 import { approvalRoutes, approvalRuleRoutes } from './approvals.js';
 import { attachmentRoutes } from './attachments.js';
 import { auditRoutes } from './audit.js';
@@ -57,6 +58,7 @@ import { supplierRefundRoutes } from './supplier-refunds.js';
 import { supplierGroupRoutes, supplierRoutes } from './suppliers.js';
 import { syncRoutes } from './sync.js';
 import { taxRateRoutes } from './tax-rates.js';
+import { tradeReportRoutes } from './trade-reports.js';
 import { unitRoutes } from './units.js';
 import { warehouseRoutes } from './warehouses.js';
 
@@ -96,6 +98,8 @@ export const routes = {
   fiscalYears: fiscalYearRoutes,
   reportExports: reportExportRoutes,
   dashboard: dashboardRoutes,
+  tradeReports: tradeReportRoutes,
+  aging: agingRoutes,
   units: unitRoutes,
   productCategories: productCategoryRoutes,
   customFields: customFieldRoutes,
```

```diff
@@ -1,4 +1,5 @@
 export * from './accounts.js';
+export * from './aging.js';
 export * from './amount-words.js';
 export * from './approvals.js';
 export * from './attachments.js';
@@ -63,5 +64,6 @@ export * from './supplier-refunds.js';
 export * from './suppliers.js';
 export * from './sync.js';
 export * from './tax-rates.js';
+export * from './trade-reports.js';
 export * from './units.js';
 export * from './warehouses.js';
```

The OpenAPI document is generated from the built package (`@omnivo/contracts` points at `dist/`), so build it first:

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
```

It adds the six report routes to `packages/contracts/openapi.json`, the new code to every list of error codes in it,
and takes `x-permission` off the three export routes. Commit it as it is.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
pnpm exec eslint packages/contracts/src
```

All pass (contracts 382 tests, 19 new). Do not run the whole `pnpm typecheck` yet. Until their parts, these fail, as
expected:

- `packages/i18n`: no English words for `report_sort_invalid` (21b.5).
- `apps/api`: the export's words and titles (`export/copy.ts`, `export/document.ts`) and the export handler's
  `switch` have no case for the four kinds (21b.3). Build `packages/db` first (`pnpm --filter @omnivo/db build`), or
  `report-exports.service.ts` also fails: the API reads the database's types from its `dist/`, which still has three
  kinds.
- `apps/app`: no words for the four kinds (`reports.kinds.*`, 21b.5) and the mock's file names (`report-data.ts`,
  21b.7).

## 21b.2 — `packages/db`: the day an allocation started to count

One new column on four tables, and nothing else. Migration 0059 is generated from the schema and changed by hand in one
place. Migration 0060 is written by hand: it fills the column for the allocations you have, makes it required, builds
its indexes and adds the trigger that keeps it from being before either document. The tables' other triggers, the
sums they keep and the API's way of writing allocations (delete the rows, insert the new ones) stay as they are.

### The schema: `applied_on` on the four allocation tables

```diff
@@ -113,6 +113,11 @@ export const receiptAllocations = pgTable(
     customerId: uuid('customer_id').notNull(),
     invoiceId: uuid('invoice_id').notNull(),
     amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
+    // The day this money started to count against the invoice, for the aging as of a day (step
+    // 21b): applied with the receipt, the receipt's date; applied again later, the day it was.
+    // Never before either document's date: 0060's trigger moves it up to the later one, so the
+    // aging on any day adds up to the books' balance.
+    appliedOn: date('applied_on', { mode: 'string' }).notNull(),
   },
   (table) => [
     uniqueIndex('receipt_allocations_pair_idx').on(
@@ -122,6 +127,9 @@ export const receiptAllocations = pgTable(
     ),
     // An invoice's payments (its page), and the invoice FK's check
     index('receipt_allocations_invoice_idx').on(table.tenantId, table.invoiceId),
+    // What was applied after a day: the aging as of that day finds the invoices still open then
+    // though paid now, and the receipts that were still an advance
+    index('receipt_allocations_applied_idx').on(table.tenantId, table.appliedOn),
     foreignKey({
       name: 'receipt_allocations_receipt_fk',
       columns: [table.tenantId, table.customerId, table.receiptId],
```

- **`appliedOn` is a `date` read as a string,** like every document date: `'2026-10-01'`, never a `Date`, so no time
  zone can move it a day.
- **`.notNull()` with no default:** Drizzle's insert type then asks every writer for it, and the API's type check
  shows the four places that write allocations (21b.3). A default would let a writer forget which day it means
  (decision 25).
- **The comment says the rule in short** and points at 0060, where the trigger keeps it: whoever writes an allocation
  sees both.
- **`receipt_allocations_applied_idx` is `(tenant_id, applied_on)`** (decision 28). The tenant comes first, like
  every index here: every question is one workspace's.

```diff
@@ -196,6 +196,9 @@ export const creditNoteAllocations = pgTable(
     customerId: uuid('customer_id').notNull(),
     invoiceId: uuid('invoice_id').notNull(),
     amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
+    // The day it started to count, like a receipt's (receipts.ts): applied when it is posted, the
+    // credit note's date; applied again later, the day it was; never before either date
+    appliedOn: date('applied_on', { mode: 'string' }).notNull(),
   },
   (table) => [
     uniqueIndex('credit_note_allocations_pair_idx').on(
@@ -205,6 +208,8 @@ export const creditNoteAllocations = pgTable(
     ),
     // An invoice's credits (its page), and the invoice FK's check
     index('credit_note_allocations_invoice_idx').on(table.tenantId, table.invoiceId),
+    // What was applied after a day, for the aging as of that day (receipts.ts)
+    index('credit_note_allocations_applied_idx').on(table.tenantId, table.appliedOn),
     foreignKey({
       name: 'credit_note_allocations_credit_note_fk',
       columns: [table.tenantId, table.customerId, table.creditNoteId],
```

```diff
@@ -157,6 +157,10 @@ export const supplierPaymentAllocations = pgTable(
     supplierId: uuid('supplier_id').notNull(),
     billId: uuid('bill_id').notNull(),
     amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
+    // The day it started to count, like a receipt's (receipts.ts). A draft's plan has the
+    // payment's date, which the books use when it is posted; applied again once posted, the day
+    // it was; never before either date
+    appliedOn: date('applied_on', { mode: 'string' }).notNull(),
   },
   (table) => [
     uniqueIndex('supplier_payment_allocations_pair_idx').on(
@@ -164,6 +168,8 @@ export const supplierPaymentAllocations = pgTable(
       table.paymentId,
       table.billId,
     ),
+    // What was applied after a day, for the aging as of that day (receipts.ts)
+    index('supplier_payment_allocations_applied_idx').on(table.tenantId, table.appliedOn),
     // A bill's payments (its page), and the bill FK's check
     index('supplier_payment_allocations_bill_idx').on(table.tenantId, table.billId),
     // A draft deleted for real takes its plan with it
```

```diff
@@ -303,6 +303,9 @@ export const debitNoteAllocations = pgTable(
     supplierId: uuid('supplier_id').notNull(),
     billId: uuid('bill_id').notNull(),
     amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
+    // The day it started to count, like a receipt's (receipts.ts): applied when it is posted, the
+    // debit note's date; applied again later, the day it was; never before either date
+    appliedOn: date('applied_on', { mode: 'string' }).notNull(),
   },
   (table) => [
     uniqueIndex('debit_note_allocations_pair_idx').on(
@@ -312,6 +315,8 @@ export const debitNoteAllocations = pgTable(
     ),
     // A bill's debit notes applied to it (its page), and the bill FK's check
     index('debit_note_allocations_bill_idx').on(table.tenantId, table.billId),
+    // What was applied after a day, for the aging as of that day (receipts.ts)
+    index('debit_note_allocations_applied_idx').on(table.tenantId, table.appliedOn),
     foreignKey({
       name: 'debit_note_allocations_debit_note_fk',
       columns: [table.tenantId, table.supplierId, table.debitNoteId],
```

- **The same column and index on the other three,** with a short comment that points at the receipt's.
- **A supplier payment's comment names the draft:** a draft's allocations are its plan (step 17c), written with the
  payment's date and written again when the draft changes. When the payment is posted, the books use that same date,
  so the plan's date is already right and posting does not touch it.

### Migration 0059 (generated, then one change)

Run `pnpm --filter @omnivo/db generate --name allocations-applied-on`. drizzle-kit writes `ADD COLUMN "applied_on" date
NOT NULL` and four `CREATE INDEX` lines. Change two things by hand:

- **Take `NOT NULL` off the four `ADD COLUMN` lines.** Postgres refuses a `NOT NULL` column with no default on a table
  that has rows: there is nothing to put in the old rows. 0060 sets it once they have values.
- **Delete the four `CREATE INDEX` lines.** 0060 builds them after the backfill: built here, each index would be
  written again for every row the backfill updates, and keep the old entries as dead space.

The result:

```sql
ALTER TABLE "receipt_allocations" ADD COLUMN "applied_on" date;--> statement-breakpoint
ALTER TABLE "credit_note_allocations" ADD COLUMN "applied_on" date;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "applied_on" date;--> statement-breakpoint
ALTER TABLE "debit_note_allocations" ADD COLUMN "applied_on" date;
```

- `meta/_journal.json` and `meta/0059_snapshot.json` change too. The snapshot says `NOT NULL` and has the indexes, which
  is how the tables are after 0060; drizzle-kit compares the schema with the snapshot, never with the SQL, so the next
  `generate` writes nothing for them. Commit them as they are.

### Migration 0060 (written by hand)

Run `pnpm --filter @omnivo/db generate --custom --name allocations-applied-on-rules` and put this in the empty file:

```sql
-- Custom SQL migration file, put your code below! --
-- Step 21b: the day each allocation started to count (applied_on), for the receivables and
-- payables aging as of a day. 0059 added the four columns empty; this file fills them, makes them
-- required, indexes them, and keeps every new one from being earlier than its two documents.

-- 1) The allocations made before this step get the later of their two documents' dates. That is
--    the day an allocation made with its document has from now on (a receipt applied when it was
--    made, a credit note when it was posted). One applied again later had a later day, which
--    nothing recorded, so it gets the earliest day it could have had.
--    Per workspace, a deleted one too (it may be restored), with app.tenant_id set, because FORCE
--    RLS applies to the table owner too (0024, 0058); cleared at the end.
--    The tables' own triggers are off for these UPDATEs. The AFTER triggers (0030, 0032, 0040,
--    0042) would take every amount off its invoice or bill and put it back: a write to every paid
--    document, for nothing. 0040's guard would only check what is already true. DISABLE TRIGGER
--    USER leaves the foreign keys' own triggers on; the ALTER is part of this migration's
--    transaction, so a failure turns them back on with everything else.
ALTER TABLE receipt_allocations DISABLE TRIGGER USER;
ALTER TABLE credit_note_allocations DISABLE TRIGGER USER;
ALTER TABLE supplier_payment_allocations DISABLE TRIGGER USER;
ALTER TABLE debit_note_allocations DISABLE TRIGGER USER;

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);

    UPDATE receipt_allocations a
       SET applied_on = greatest(r.date, i.date)
      FROM receipts r, invoices i
     WHERE a.tenant_id = t
       AND r.tenant_id = a.tenant_id AND r.id = a.receipt_id
       AND i.tenant_id = a.tenant_id AND i.id = a.invoice_id;

    UPDATE credit_note_allocations a
       SET applied_on = greatest(c.date, i.date)
      FROM credit_notes c, invoices i
     WHERE a.tenant_id = t
       AND c.tenant_id = a.tenant_id AND c.id = a.credit_note_id
       AND i.tenant_id = a.tenant_id AND i.id = a.invoice_id;

    UPDATE supplier_payment_allocations a
       SET applied_on = greatest(p.date, b.date)
      FROM supplier_payments p, bills b
     WHERE a.tenant_id = t
       AND p.tenant_id = a.tenant_id AND p.id = a.payment_id
       AND b.tenant_id = a.tenant_id AND b.id = a.bill_id;

    UPDATE debit_note_allocations a
       SET applied_on = greatest(d.date, b.date)
      FROM debit_notes d, bills b
     WHERE a.tenant_id = t
       AND d.tenant_id = a.tenant_id AND d.id = a.debit_note_id
       AND b.tenant_id = a.tenant_id AND b.id = a.bill_id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE receipt_allocations ENABLE TRIGGER USER;
ALTER TABLE credit_note_allocations ENABLE TRIGGER USER;
ALTER TABLE supplier_payment_allocations ENABLE TRIGGER USER;
ALTER TABLE debit_note_allocations ENABLE TRIGGER USER;

-- 2) Required from now on. SET NOT NULL reads every row whatever the RLS policy says, so a row
--    the loop above missed fails the migration here instead of staying empty.
ALTER TABLE receipt_allocations ALTER COLUMN applied_on SET NOT NULL;
ALTER TABLE credit_note_allocations ALTER COLUMN applied_on SET NOT NULL;
ALTER TABLE supplier_payment_allocations ALTER COLUMN applied_on SET NOT NULL;
ALTER TABLE debit_note_allocations ALTER COLUMN applied_on SET NOT NULL;

-- 3) The schema's indexes (what was applied after a day), built here, once, on the filled
--    columns, instead of in 0059 and then again row by row by the UPDATEs.
CREATE INDEX receipt_allocations_applied_idx
  ON receipt_allocations USING btree (tenant_id, applied_on);
CREATE INDEX credit_note_allocations_applied_idx
  ON credit_note_allocations USING btree (tenant_id, applied_on);
CREATE INDEX supplier_payment_allocations_applied_idx
  ON supplier_payment_allocations USING btree (tenant_id, applied_on);
CREATE INDEX debit_note_allocations_applied_idx
  ON debit_note_allocations USING btree (tenant_id, applied_on);

-- 4) Never earlier than either document. The aging as of a day D counts a document dated D or
--    before, less what was applied to it on D or before. An allocation dated before its receipt
--    would take money off the invoice on a day the receipt is not counted yet, and the aging
--    would no longer add up to the books' balance. So every write is moved up to the later of
--    the two dates: the API says the day it means (the document's date, or today when money is
--    applied again), and the database makes sure of the rest under every path that writes.
--    A NULL from the API becomes the later date too (greatest() skips NULLs); the Drizzle type
--    still asks for it, so a writer always says which day it means.
--    Scalar subqueries, not SELECT … INTO: a document that does not exist gives NULL here and the
--    foreign key refuses the row with its own error, instead of a confusing NOT NULL one.
--    Only a draft supplier payment's date changes after its allocations are written, and its plan
--    is written again with it (supplier-payments.service.ts, update), so the rule still holds.
CREATE FUNCTION receipt_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM receipts WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id),
    (SELECT date FROM invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER receipt_allocations_applied_on
  BEFORE INSERT OR UPDATE ON receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION receipt_allocations_applied_on();

CREATE FUNCTION credit_note_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM credit_notes WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id),
    (SELECT date FROM invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER credit_note_allocations_applied_on
  BEFORE INSERT OR UPDATE ON credit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION credit_note_allocations_applied_on();

CREATE FUNCTION supplier_payment_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM supplier_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id),
    (SELECT date FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_payment_allocations_applied_on
  BEFORE INSERT OR UPDATE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocations_applied_on();

CREATE FUNCTION debit_note_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM debit_notes WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id),
    (SELECT date FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER debit_note_allocations_applied_on
  BEFORE INSERT OR UPDATE ON debit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION debit_note_allocations_applied_on();
```

**1) The old rows.**

- **The later of the two documents' dates** (decision 5). An allocation made with its document has that date from now
  on too (decision 25), so for most old rows it is the true day. One that was applied later really happened on a
  later day that nothing recorded; the later date is the earliest it can have been.
- **`DISABLE TRIGGER USER`** is decision 29. `USER` turns off the triggers written in the migrations, not the ones
  Postgres made for the foreign keys, so the backfill still cannot point anywhere wrong. `ALTER TABLE` is part of the
  migration's transaction: if anything fails, the triggers are on again with everything else rolled back. Only the
  table's owner (`omnivo_migrator`) may do it, which is who runs migrations.
- **Per workspace with `app.tenant_id` set,** like 0024 and 0058: the four tables have `FORCE` row-level security, so
  without it the `UPDATE`s see no row at all. Every workspace, a deleted one too, and the setting is cleared at the end
  so a later migration in the same run does not act as the last workspace.
- **`a.tenant_id = t` in each `UPDATE`,** though the policy already says it: it lets Postgres use the tables' indexes,
  which start with the tenant.

**2) Required.**

- **`SET NOT NULL` reads every row, whatever the policy says.** If the loop missed a row, the migration stops here with
  "column applied_on contains null values", and nothing of it stays. That is the check that the backfill reached every
  row.

**3) The indexes.**

- **Built once, on the filled columns** (see 0059). `CREATE INDEX` without `CONCURRENTLY`: a migration runs in a
  transaction, where `CONCURRENTLY` is not allowed. The tables are locked for the migration anyway, by the `ALTER`s.

**4) The trigger.**

- **It moves `applied_on` up, never down** (decision 26). The API says the day it means: the document's date when it is
  made or posted, today when money is applied again later. `greatest()` keeps that day unless one of the documents is
  dated later.
- **Why a later document matters:** the aging as of D counts a receipt dated D or before, and takes off an invoice what
  was applied on D or before. A receipt dated 10 November applied on 5 November would pay the invoice on 6 November
  while the receipt is not counted yet: for those days the aging would be lower than the books by the
  receipt's amount.
- **`greatest()` skips `NULL`:** an allocation written with no date gets the later document's date. Old code that does
  not know the column yet (the API until 21b.3) still writes correct rows.
- **Scalar subqueries, not `SELECT … INTO`:** with a document id that does not exist, `SELECT … INTO` would set
  `applied_on` to `NULL` and the person would get a "null value" error. A subquery gives `NULL`, `greatest()` skips it,
  and the foreign key refuses the row with its own name, which the API already knows.
- **`BEFORE INSERT OR UPDATE`:** the API only inserts and deletes allocations, but an `UPDATE` by hand must follow the
  same rule.
- **The documents' dates cannot change under it.** A posted receipt, credit note, debit note or payment keeps its date.
  Only a draft supplier payment's date can change after its plan is written, and its update writes the plan again
  (`supplier-payments.service.ts`, the update path), so the rule holds there too.
- **Four functions, not one.** Each reads its own two tables. One function for all four would need the table names in
  dynamic SQL, which no other trigger here uses.
- **The trigger runs as the person who writes** (`omnivo_app`), under row-level security: it can read only its own
  workspace's documents, which are the only ones an allocation may point at.

### What I checked

> Run while this part was written, on its code alone. 21b.8 ran everything again on the finished step.
>
> With 0059 and 0060, before any API change: the invoices, returns and credit notes, supplier payments, purchase
> returns and debit notes, and bills suites, 106 tests, all pass. The API does not send `applied_on` yet, so the trigger
> dated every allocation they wrote: 25 rows (8 receipt, 5 credit note, 6 supplier payment, 6 debit note), 22 of them
> between documents with different dates. Each had the later of its two dates; none was earlier.
>
> The backfill, on those four databases set back to how they were after 0059 (no trigger, no index, every
> `applied_on` empty): 0060 run again as `omnivo_migrator` in one transaction gave the same date to all 25 rows, and the
> invoices, bills, receipts, credit notes, payments and debit notes were the same byte for byte. After it: the four
> columns `NOT NULL`, the four indexes there, every trigger on again, `app.tenant_id` empty.
>
> The trigger by hand, as `omnivo_app` with row-level security on, on a receipt of 9 October paying an invoice of 7
> October: written with 1 January 2020 it became 9 October; with `NULL`, 9 October; updated to 2020 it stayed 9
> October; updated to 1 March 2027 it kept that day. An invoice that does not exist was refused by
> `receipt_allocations_invoice_fk`; another workspace's row by the row-level security policy.
>
> Broken on purpose: without `set_config` in the loop, the migration failed at `SET NOT NULL` ("column applied_on of
> relation receipt_allocations contains null values") and changed nothing. Without `DISABLE TRIGGER`, the result was
> the same as with it, so decision 29 is about the time it takes, not about the result.
>
> The RLS coverage, the sales, bills, purchase returns and purchase tenant-leak suites, the dashboard and the
> customers suites: 9 files, 87 tests, pass.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm --filter @omnivo/db generate --name nothing-left
pnpm db:migrate
pnpm --filter @omnivo/db build
```

The second command must say "No schema changes, nothing to migrate": the schema and the migrations agree, and the four
export kinds of 21b.1 need no migration (`report_exports.report` is plain `text`). `pnpm db:migrate` applies 0059 and
0060 to your dev database, with the backfill of your allocations. The build lets the API see `appliedOn` in 21b.3.

Until 21b.3, `apps/api` fails its type check in four more places than after 21b.1: the inserts in
`receipts.service.ts`, `credit-notes.service.ts`, `supplier-payments.service.ts` and `debit-notes.service.ts` have no
`appliedOn` ("No overload matches this call"). That is the type check finding the writers, as planned.

To see the backfill on your own data, as the `postgres` user (who skips row-level security):

```sql
SELECT count(*) AS allocations,
       count(*) FILTER (WHERE a.applied_on > r.date) AS dated_by_the_invoice
  FROM receipt_allocations a
  JOIN receipts r ON r.tenant_id = a.tenant_id AND r.id = a.receipt_id;
```

The second number is the receipts that paid an invoice dated after them, such as an advance put on a later invoice.

## 21b.3 — `apps/api`: the reports and the day an allocation counts

Three things. The four services that write allocations now say which day each one starts to count (decisions 25 and
30). Six routes answer the four report pages, with their queries in two new files that the worker's export runs too.
And the export routes check each report's own permission, while the worker learns to write the four new kinds.

### The day an allocation counts

```ts
import { compareMoney, todayIn } from '@omnivo/contracts';
import { tenantSettings } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { getTenantId } from '../tenant/tenant-context.js';
import type { Transaction } from '../tenant/with-tenant.js';

// The day an allocation starts to count (step 21b, decision 25): the aging as of a past day takes
// off a document only what was applied to it by then. Two rules, for the four kinds of allocation
// (a receipt's, a credit note's, a supplier payment's and a debit note's):
// - Written with its document (a receipt made, a credit note posted): the document's date. The
//   database moves it up to the other document's date when that one is later (migration 0060).
// - Written later (money applied again): today in the workspace's time zone. A pair whose amount
//   did not change keeps the day it had: moving 5,000 from one invoice to another does not make the
//   other invoices look paid today.

// Today where the workspace is: 5 November in Dhaka is still 4 November in UTC until 6 in the morning
export async function workspaceToday(tx: Transaction): Promise<string> {
  const tenantId = getTenantId();
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  return todayIn(settings.timezone);
}

// The rows to write, each with its applied_on: the day the old row had when the same document (an
// invoice or a bill, `documentOf`) gets the same amount again, else `day`. `current` is what the
// paying document has now, read before its rows are deleted.
export function datedAllocations<T extends { amount: string }>(
  wanted: readonly T[],
  current: readonly (T & { appliedOn: string })[],
  documentOf: (row: T) => string,
  day: string,
): (T & { appliedOn: string })[] {
  const before = new Map(current.map((row) => [documentOf(row), row]));
  return wanted.map((row) => {
    const old = before.get(documentOf(row));
    const same = old !== undefined && compareMoney(old.amount, row.amount) === 0;
    return { ...row, appliedOn: same ? old.appliedOn : day };
  });
}
```

- **`workspaceToday()`** reads the workspace's time zone and asks the contract's `todayIn()`. At 2 in the morning in
  Dhaka it is still yesterday in UTC; "today" must be the company's. Some services have a private copy of these
  four lines; this one is shared by the four writers. It throws without a settings row, like `bookingDay()`: every
  workspace has one from its sign-up, and a silent `'Asia/Dhaka'` would hide a broken workspace.
- **`datedAllocations()`** is decision 30 in one place. It takes the rows the person wants, the rows the document has
  now (read before they are deleted) and the day for anything new. A pair with the same amount keeps its old day:
  moving ৳5,000 from one invoice to another must not make the other invoices of the receipt look paid today.
- **`compareMoney(…) === 0`, not `===` on the strings:** the form sends `"5000"`, the database has `"5000.0000"`.
- **`documentOf` is a function,** so one helper serves the sales side (`invoiceId`) and the purchase side (`billId`)
  without a cast. `T` is inferred from the wanted rows, and `current` must be the same rows plus `appliedOn`, which is
  exactly what each service's `select` gives.

```diff
@@ -14,6 +14,7 @@ import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created } from '../common/audit/audit.js';
+import { datedAllocations, workspaceToday } from '../common/db/applied-on.js';
 import { isCheckViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
@@ -149,7 +150,8 @@ export class ReceiptsService {
             amount: row.amount,
           },
         );
-        await this.apply(tx, row, input.allocations);
+        // Paid on the receipt's own day, like the books (step 21b, decision 25)
+        await this.apply(tx, row, input.allocations, row.date);
         await audit(tx, {
           action: 'receipt.created',
           entityType: 'receipt',
@@ -186,7 +188,7 @@ export class ReceiptsService {
           throw overAllocatedError();
         }
         const before = await this.allocationsOf(tx, id);
-        await this.apply(tx, row, input.allocations);
+        await this.apply(tx, row, input.allocations, await workspaceToday(tx));
         await tx
           .update(receipts)
           .set({ version: sql`${receipts.version} + 1`, updatedBy: currentPrincipal().userId })
@@ -235,8 +237,9 @@ export class ReceiptsService {
       const entry = await this.books.entryOf(tx, id, 'sales_receipt');
       if (entry === null) throw new Error(`Receipt ${id} has no entry`);
       // The allocations first: the database lets a receipt be voided only once nothing of it is
-      // applied (receipts_void_check). Their trigger takes the money off the invoices.
-      await this.apply(tx, row, []);
+      // applied (receipts_void_check). Their trigger takes the money off the invoices. Nothing is
+      // written, so the day is never used.
+      await this.apply(tx, row, [], input.date);
       await tx
         .update(receipts)
         .set({
@@ -264,15 +267,20 @@ export class ReceiptsService {
   // Replaces the receipt's allocations with `wanted`, once checkAllocations() has locked every
   // invoice involved and checked each row (step 15d moved that check to allocations.ts, for the
   // credit notes too). amount_paid and applied are not written here: the allocations' trigger keeps
-  // them (migration 0030).
+  // them (migration 0030). `day` is the applied_on of a new or changed pair (step 21b).
   private async apply(
     tx: Transaction,
     receipt: ReceiptRow,
     wanted: readonly Allocation[],
+    day: string,
   ): Promise<void> {
     const tenantId = getTenantId();
     const current = await tx
-      .select({ invoiceId: receiptAllocations.invoiceId, amount: receiptAllocations.amount })
+      .select({
+        invoiceId: receiptAllocations.invoiceId,
+        amount: receiptAllocations.amount,
+        appliedOn: receiptAllocations.appliedOn,
+      })
       .from(receiptAllocations)
       .where(
         and(
@@ -296,12 +304,13 @@ export class ReceiptsService {
       );
     if (wanted.length === 0) return;
     await tx.insert(receiptAllocations).values(
-      wanted.map((allocation) => ({
+      datedAllocations(wanted, current, (row) => row.invoiceId, day).map((allocation) => ({
         tenantId,
         receiptId: receipt.id,
         customerId: receipt.customerId,
         invoiceId: allocation.invoiceId,
         amount: allocation.amount,
+        appliedOn: allocation.appliedOn,
       })),
     );
   }
```

- **`apply()` takes `day`, with no default.** Every caller has to say which day it means; a default would let a new
  caller forget, which is why the column has none either (21b.2).
- **A new receipt passes its own date.** The receipt of 1 October typed in on 5 November paid on 1 October, like its
  journal entry. If the invoice is dated after the receipt (an advance put on a later invoice), the database moves the
  day up to the invoice's (migration 0060's trigger).
- **Applying again passes today.** The person moved the money now.
- **The void passes its date only because the parameter is required:** it writes no row, so the day is never used. The
  comment says so, so nobody thinks the void date matters there.
- **`current` now selects `appliedOn` too:** it is what `datedAllocations()` keeps for an unchanged pair.

```diff
@@ -39,6 +39,7 @@ import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
+import { datedAllocations, workspaceToday } from '../common/db/applied-on.js';
 import { isCheckViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
@@ -353,7 +354,7 @@ export class CreditNotesService {
           throw overAllocatedError();
         }
         const before = await this.allocationsOf(tx, id);
-        await this.apply(tx, row, input.allocations);
+        await this.apply(tx, row, input.allocations, await workspaceToday(tx));
         await tx
           .update(creditNotes)
           .set({ version: sql`${creditNotes.version} + 1`, updatedBy: currentPrincipal().userId })
@@ -657,7 +658,7 @@ export class CreditNotesService {
     const due = amountDueOf(invoice);
     const applied = compareMoney(draft.total, due) <= 0 ? draft.total : due;
     if (compareMoney(applied, '0') > 0) {
-      await this.apply(tx, posted, [{ invoiceId: invoice.id, amount: applied }]);
+      await this.apply(tx, posted, [{ invoiceId: invoice.id, amount: applied }], posted.date);
     }
     await audit(tx, {
       action: 'credit_note.posted',
@@ -669,17 +670,21 @@ export class CreditNotesService {
 
   // Replaces the credit note's allocations with `wanted`, once checkAllocations() has locked every
   // invoice involved and checked each row. invoices.amount_credited and credit_notes.applied are
-  // not written here: the allocations' trigger keeps them (migration 0032).
+  // not written here: the allocations' trigger keeps them (migration 0032). `day` is the
+  // applied_on of a new or changed pair (step 21b): the credit note's date when it is posted, today
+  // when its money is applied again.
   private async apply(
     tx: Transaction,
     creditNote: CreditNoteRow,
     wanted: readonly Allocation[],
+    day: string,
   ): Promise<void> {
     const tenantId = getTenantId();
     const current = await tx
       .select({
         invoiceId: creditNoteAllocations.invoiceId,
         amount: creditNoteAllocations.amount,
+        appliedOn: creditNoteAllocations.appliedOn,
       })
       .from(creditNoteAllocations)
       .where(
@@ -704,12 +709,13 @@ export class CreditNotesService {
       );
     if (wanted.length === 0) return;
     await tx.insert(creditNoteAllocations).values(
-      wanted.map((allocation) => ({
+      datedAllocations(wanted, current, (row) => row.invoiceId, day).map((allocation) => ({
         tenantId,
         creditNoteId: creditNote.id,
         customerId: creditNote.customerId,
         invoiceId: allocation.invoiceId,
         amount: allocation.amount,
+        appliedOn: allocation.appliedOn,
       })),
     );
   }
```

- **Posting passes the credit note's date;** applying again passes today. The same two rules as the receipt.

```diff
@@ -48,6 +48,7 @@ import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
+import { datedAllocations, workspaceToday } from '../common/db/applied-on.js';
 import { isCheckViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
@@ -477,7 +478,7 @@ export class DebitNotesService {
           throw overAllocatedError();
         }
         const before = await this.allocationsOf(tx, id);
-        await this.apply(tx, row, input.allocations);
+        await this.apply(tx, row, input.allocations, await workspaceToday(tx));
         await tx
           .update(debitNotes)
           .set({ version: sql`${debitNotes.version} + 1`, updatedBy: currentPrincipal().userId })
@@ -964,7 +965,7 @@ export class DebitNotesService {
       const due = billAmountDueOf(bill);
       applied = compareMoney(draft.total, due) <= 0 ? draft.total : due;
       if (compareMoney(applied, '0') > 0) {
-        await this.apply(tx, posted, [{ billId: bill.id, amount: applied }]);
+        await this.apply(tx, posted, [{ billId: bill.id, amount: applied }], posted.date);
       }
     }
     await audit(tx, {
@@ -1061,15 +1062,21 @@ export class DebitNotesService {
   // Replaces the debit note's allocations with `wanted`, once checkBillAllocations() has locked
   // every bill involved and checked each row (the supplier payment's check, decision 24).
   // bills.amount_debited and debit_notes.applied are not written here: the allocations' trigger
-  // keeps them (migration 0042).
+  // keeps them (migration 0042). `day` is the applied_on of a new or changed pair (step 21b), as
+  // for a credit note: its date when posted, today when applied again.
   private async apply(
     tx: Transaction,
     debitNote: DebitNoteRow,
     wanted: readonly { billId: string; amount: string }[],
+    day: string,
   ): Promise<void> {
     const tenantId = getTenantId();
     const current = await tx
-      .select({ billId: debitNoteAllocations.billId, amount: debitNoteAllocations.amount })
+      .select({
+        billId: debitNoteAllocations.billId,
+        amount: debitNoteAllocations.amount,
+        appliedOn: debitNoteAllocations.appliedOn,
+      })
       .from(debitNoteAllocations)
       .where(
         and(
@@ -1093,12 +1100,13 @@ export class DebitNotesService {
       );
     if (wanted.length === 0) return;
     await tx.insert(debitNoteAllocations).values(
-      wanted.map((allocation) => ({
+      datedAllocations(wanted, current, (row) => row.billId, day).map((allocation) => ({
         tenantId,
         debitNoteId: debitNote.id,
         supplierId: debitNote.supplierId,
         billId: allocation.billId,
         amount: allocation.amount,
+        appliedOn: allocation.appliedOn,
       })),
     );
   }
```

- **The same for a debit note:** its date when posted, today when its money is applied to other bills.

```diff
@@ -26,6 +26,7 @@ import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created, diff } from '../common/audit/audit.js';
+import { datedAllocations, workspaceToday } from '../common/db/applied-on.js';
 import { isCheckViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
@@ -204,7 +205,8 @@ export class SupplierPaymentsService {
           })
           .returning();
         if (!row) throw new Error('Supplier payment insert returned no row');
-        await this.replaceAllocations(tx, row, input.allocations);
+        // The plan is dated by the payment: posting it later keeps that day, like the books
+        await this.replaceAllocations(tx, row, input.allocations, row.date);
         await audit(tx, {
           action: 'supplier_payment.created',
           entityType: 'supplier_payment',
@@ -237,7 +239,7 @@ export class SupplierPaymentsService {
         }
         await this.check(tx, supplier.id, input);
         // The plan first: a new supplier's key would refuse the old supplier's bills
-        await this.replaceAllocations(tx, before, []);
+        await this.clearAllocations(tx, before.id);
         const [updated] = await tx
           .update(supplierPayments)
           .set({
@@ -248,7 +250,8 @@ export class SupplierPaymentsService {
           .where(and(eq(supplierPayments.tenantId, getTenantId()), eq(supplierPayments.id, id)))
           .returning();
         if (!updated) throw notFound('Supplier payment');
-        await this.replaceAllocations(tx, updated, input.allocations);
+        // Written again with the payment's date, which this update may have changed
+        await this.replaceAllocations(tx, updated, input.allocations, updated.date);
         await audit(tx, {
           action: 'supplier_payment.updated',
           entityType: 'supplier_payment',
@@ -384,7 +387,7 @@ export class SupplierPaymentsService {
           wanted: input.allocations,
           errors: PAYMENT_ERRORS,
         });
-        await this.replaceAllocations(tx, row, input.allocations);
+        await this.replaceAllocations(tx, row, input.allocations, await workspaceToday(tx));
         await tx
           .update(supplierPayments)
           .set({
@@ -445,7 +448,7 @@ export class SupplierPaymentsService {
         wanted: [],
         errors: PAYMENT_ERRORS,
       });
-      await this.replaceAllocations(tx, row, []);
+      await this.clearAllocations(tx, row.id);
       await tx
         .update(supplierPayments)
         .set({
@@ -624,33 +627,55 @@ export class SupplierPaymentsService {
 
   // Replaces the payment's rows: a draft's plan on every save, a posted payment's money when it is
   // applied again or voided. amount_paid and applied are not written here: the allocations'
-  // trigger keeps them, and moves a bill only for a posted payment (migration 0040).
+  // trigger keeps them, and moves a bill only for a posted payment (migration 0040). `day` is the
+  // applied_on of a new or changed pair (step 21b): the payment's date for a draft's plan, today
+  // when a posted payment's money is applied again.
   private async replaceAllocations(
     tx: Transaction,
     payment: PaymentRow,
     wanted: readonly Allocation[],
+    day: string,
   ): Promise<void> {
     const tenantId = getTenantId();
-    await tx
-      .delete(supplierPaymentAllocations)
+    const current = await tx
+      .select({
+        billId: supplierPaymentAllocations.billId,
+        amount: supplierPaymentAllocations.amount,
+        appliedOn: supplierPaymentAllocations.appliedOn,
+      })
+      .from(supplierPaymentAllocations)
       .where(
         and(
           eq(supplierPaymentAllocations.tenantId, tenantId),
           eq(supplierPaymentAllocations.paymentId, payment.id),
         ),
       );
+    await this.clearAllocations(tx, payment.id);
     if (wanted.length === 0) return;
     await tx.insert(supplierPaymentAllocations).values(
-      wanted.map((allocation) => ({
+      datedAllocations(wanted, current, (row) => row.billId, day).map((allocation) => ({
         tenantId,
         paymentId: payment.id,
         supplierId: payment.supplierId,
         billId: allocation.billId,
         amount: allocation.amount,
+        appliedOn: allocation.appliedOn,
       })),
     );
   }
 
+  // Every row of the payment gone: before an update writes its plan again, and when it is voided
+  private async clearAllocations(tx: Transaction, paymentId: string): Promise<void> {
+    await tx
+      .delete(supplierPaymentAllocations)
+      .where(
+        and(
+          eq(supplierPaymentAllocations.tenantId, getTenantId()),
+          eq(supplierPaymentAllocations.paymentId, paymentId),
+        ),
+      );
+  }
+
   // FOR UPDATE: every change to a payment takes turns with the others and with an approval
   private async lock(tx: Transaction, id: string, version: number): Promise<PaymentRow> {
     const [row] = await tx
```

- **A draft's plan is dated by the payment** (create and update). When the payment is approved and posted days later,
  its journal entry has the payment's date, and so does the plan: posting changes nothing here.
- **Update writes the plan again with the updated date:** the person may have changed the payment's date, and the
  plan follows it. The old rows are cleared first (as before), so there is nothing to keep and every row gets the new
  date.
- **Applying a posted payment's money again passes today,** keeping unchanged pairs.
- **`clearAllocations()` is new:** the update's first step and the void only delete. Before, they called
  `replaceAllocations(tx, row, [])`, which would now need a day that means nothing.
- **`replaceAllocations()` reads the rows before it deletes them,** like the receipt's `apply()`. This service did not
  read them before, because nothing needed the old rows.

### The pages, a page at a time

```ts
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What the step 21b reports share: the raw rows checked with a schema, and their pages.

// Raw rows are data from outside TypeScript's view: checked with a schema, never cast
export async function select<S extends z.ZodType>(
  tx: Transaction,
  query: SQL,
  row: S,
): Promise<z.output<S>[]> {
  return z.array(row).parse(await tx.execute(query));
}

// A report's rows are sums: every page adds up all of the period's lines again, and only then
// sorts them. So the cursor is the place in the sorted list (an OFFSET), not the last row's
// values: a keyset cursor would save nothing (the sums are worked out either way), and a sum, a
// percent or a name that is null does not make a clean keyset. If the numbers change between two
// pages, a row can show twice or be missed, as with any cursor over a moving total; the export
// has every row in one read.
export interface ReportPage {
  limit: number;
  offset: number;
}

const offsetCursor = z.tuple([z.number().int().min(0)]);

// The page a query asks for. The cursor is checked like every other one: a broken or edited cursor
// is invalid_cursor (400), never a SQL error.
export function reportPage(query: { limit: number; cursor?: string | undefined }): ReportPage {
  const after = decodeCursor(query.cursor, offsetCursor);
  return { limit: query.limit, offset: after?.[0] ?? 0 };
}

// One row more than the page, to know whether there is a next one. null = every row (an export).
export function pageClause(page: ReportPage | null): SQL {
  if (page === null) return sql``;
  return sql`LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
}

// The page's rows and the cursor of the next one (null on the last page and for an export)
export function pageRows<T>(
  found: readonly T[],
  page: ReportPage | null,
): { items: T[]; nextCursor: string | null } {
  if (page === null) return { items: [...found], nextCursor: null };
  return {
    items: found.slice(0, page.limit),
    nextCursor: found.length > page.limit ? encodeCursor([page.offset + page.limit]) : null,
  };
}

// The categories a filter means: this one and every one under it (decision 13), the same rule
// as the product list (products.service.ts)
export function inCategory(column: SQL, tenantId: string, categoryId: string): SQL {
  return sql`${column} IN (
    WITH RECURSIVE down AS (
      SELECT id FROM product_categories WHERE tenant_id = ${tenantId}::uuid AND id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id FROM product_categories c JOIN down ON c.parent_id = down.id
       WHERE c.tenant_id = ${tenantId}::uuid
    ) SELECT id FROM down)`;
}

// A sort's column and direction: "net" sorts up, "-net" down. `columns` has one SQL expression per
// column name; written with `satisfies Record<…, SQL>` at the caller, so a sort the contract adds
// without a column fails the type check. A sort that matches nothing is a bug, not a request.
export function sortColumn(
  sort: string,
  columns: Readonly<Record<string, SQL>>,
): { column: SQL; direction: SQL } {
  for (const [name, column] of Object.entries(columns)) {
    if (sort === name) return { column, direction: sql`ASC` };
    if (sort === `-${name}`) return { column, direction: sql`DESC` };
  }
  throw new Error(`No column for the sort ${sort}`);
}

// The column names of a list of sorts: 'net' from 'net' and '-net'
export type SortColumn<S extends string> = Exclude<S, `-${string}`>;
```

- **`select()`** is the statements' helper again (`report-queries.ts`): raw rows are checked with a Zod schema, never
  cast. It is here so the two new query files share it.
- **`ReportPage` is an offset** (decision 31). The comment says what that means when the numbers change between two
  pages: a row can repeat or be missed, as with any cursor over moving totals. The export has every row in one read.
- **`reportPage()` decodes the cursor with the shared `decodeCursor()`:** a broken or edited cursor is
  `invalid_cursor` (400), never a Postgres error (500). The cursor is still opaque base64; only the server knows it is
  a number.
- **`pageClause()` asks for one row more than the page,** like every list (`toPage()`): one row too many means there
  is a next page, with no `COUNT(*)`. `null` means every row, for an export.
- **`inCategory()`** is the product list's "this category and everything under it" (decision 13), as a recursive
  query. Both reports use it.
- **`sortColumn()`** turns `"-net"` into the SQL column and `DESC`. It looks the name up in the caller's map and
  throws on a sort it does not know: the contract's schema already refused anything else, so a miss is a bug.
- **`SortColumn<S>`** takes the minus forms out of the contract's list (`'net' | '-net'` → `'net'`). The callers write
  their maps with `satisfies Record<SortColumn<…>, SQL>`, so a sort added to the contract without a column fails the
  type check. That is why the maps are written out and not built from the list.

### The sales and purchase reports

```ts
import {
  costColumns,
  type PurchaseReport,
  type PurchaseReportFilter,
  type PurchaseReportGroup,
  type PurchaseReportSort,
  type SalesReport,
  type SalesReportFilter,
  type SalesReportGroup,
  type SalesReportSort,
  TRADE_REPORT_ROW_KINDS,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { loadBooks } from '../dashboard/dashboard-queries.js';
import {
  inCategory,
  pageClause,
  pageRows,
  type ReportPage,
  select,
  sortColumn,
  type SortColumn,
} from './report-paging.js';

// The sales and purchase reports (step 21b), in plain SQL like the statements (report-queries.ts),
// so the API (a page) and the worker (an export) run the same queries. Each one is three steps:
// 1. `lines`: every line of the period, one row each, from every kind of document, signed so that
//    adding them up gives the period (a sale adds, a return takes off);
// 2. `grouped`: the lines added up per row of the report, with the filters;
// 3. the page: sorted, with the totals of every row from a window function (worked out before the
//    LIMIT, so they are the same on every page).
// Amounts come back as text with 4 places; the cost of a line from a challan or a return is
// rounded to 4 places line by line, so the rows add up to the totals to the paisa.

// The lines' common columns: tenant_id, day, the party, branch_id, variant_id, gross, returns and
// quantity, plus cost (sales) or account_id (purchases).

// ---------------------------------------------------------------------------------------------
// Sales

// Every sold and returned line of the period (decision 2), net of discounts and before VAT:
// - an invoice line, with the cost of its challan line in the share the invoice billed (a return
//   before billing makes the invoice bill less of the challan line);
// - a POS sale line, with its own cost; its branch is its warehouse's;
// - a credit note line takes its money off on the credit note's day, in the invoice's branch. Only a
//   line for goods that came back (a return line) takes the quantity and the cost off: a price cut
//   gives money back, not goods;
// - a POS return line takes off its money, quantity and cost on the return's day.
function salesLines(tenantId: string, from: string, to: string): SQL {
  return sql`
    SELECT l.tenant_id, i.date AS day, i.customer_id, i.branch_id, l.variant_id,
           l.net AS gross, 0::numeric AS returns, l.base_quantity AS quantity,
           coalesce(round(d.value * l.base_quantity / d.base_quantity, 4), 0) AS cost
      FROM invoice_lines l
      JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
      LEFT JOIN delivery_lines d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_line_id
     WHERE l.tenant_id = ${tenantId}::uuid AND i.status = 'posted'
       AND i.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, s.date, s.customer_id, w.branch_id, l.variant_id,
           l.net, 0, l.base_quantity, l.value
      FROM pos_sale_lines l
      JOIN pos_sales s ON s.tenant_id = l.tenant_id AND s.id = l.sale_id
      JOIN warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND s.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, c.date, c.customer_id, i.branch_id, l.variant_id,
           0, l.net,
           CASE WHEN r.id IS NULL THEN 0 ELSE -l.base_quantity END,
           CASE WHEN r.id IS NULL THEN 0 ELSE -round(r.value * l.base_quantity / r.base_quantity, 4) END
      FROM credit_note_lines l
      JOIN credit_notes c ON c.tenant_id = l.tenant_id AND c.id = l.credit_note_id
      JOIN invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
      LEFT JOIN sales_return_lines r ON r.tenant_id = l.tenant_id AND r.id = l.return_line_id
     WHERE l.tenant_id = ${tenantId}::uuid AND c.status = 'posted'
       AND c.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, r.date, s.customer_id, w.branch_id, l.variant_id,
           0, l.net, -l.base_quantity, -l.value
      FROM pos_return_lines l
      JOIN pos_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id
      JOIN pos_sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
      JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id
     WHERE l.tenant_id = ${tenantId}::uuid AND r.date BETWEEN ${from}::date AND ${to}::date`;
}

// What makes one row of each group: its key, kind, id, code, name and month, the joins it needs,
// and what it groups by. A row with no such thing (a walk-in, no category) has a kind of its own
// and its key is that kind (decision 16).
interface Grouping {
  select: SQL;
  joins: SQL;
  groupBy: SQL;
}

const SALES_GROUPINGS = {
  customer: {
    select: sql`coalesce(l.customer_id::text, 'walk_in') AS key,
                CASE WHEN l.customer_id IS NULL THEN 'walk_in' ELSE 'item' END AS kind,
                c.id::text AS id, c.code, c.name, NULL::text AS month`,
    joins: sql``,
    groupBy: sql`l.customer_id, c.id`,
  },
  product: {
    select: sql`p.id::text AS key, 'item' AS kind, p.id::text AS id, p.code, p.name,
                NULL::text AS month`,
    joins: sql``,
    groupBy: sql`p.id, u.id`,
  },
  category: {
    select: sql`coalesce(p.category_id::text, 'no_category') AS key,
                CASE WHEN p.category_id IS NULL THEN 'no_category' ELSE 'item' END AS kind,
                pc.id::text AS id, NULL::text AS code, pc.name, NULL::text AS month`,
    joins: sql`LEFT JOIN product_categories pc ON pc.tenant_id = p.tenant_id AND pc.id = p.category_id`,
    groupBy: sql`p.category_id, pc.id`,
  },
  branch: {
    select: sql`b.id::text AS key, 'item' AS kind, b.id::text AS id, b.code, b.name,
                NULL::text AS month`,
    joins: sql`JOIN branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id`,
    groupBy: sql`b.id`,
  },
  month: {
    select: sql`to_char(l.day, 'YYYY-MM') AS key, 'item' AS kind, NULL::text AS id,
                NULL::text AS code, NULL::text AS name, to_char(l.day, 'YYYY-MM') AS month`,
    joins: sql``,
    groupBy: sql`to_char(l.day, 'YYYY-MM')`,
  },
} satisfies Record<SalesReportGroup, Grouping>;

// The sorts read the grouped rows by their alias, g. Written bare, ORDER BY net would sort by the
// SELECT's own column called net, which is text: "9000.0000" after "18000.0000".

// The name a row sorts by: a month by its date ('2026-09' sorts like the date), a thing by its
// name in any case. A row that is not an item has none and goes last, whichever way.
const SORT_NAME = sql`CASE WHEN g.kind = 'item' THEN coalesce(g.month, lower(g.name)) END`;

// Name, then key: two customers called "Sylhet Pharmacy" still come in the same order every time,
// so a page never repeats or skips one
function orderBy(sort: { column: SQL; direction: SQL }, byName: boolean): SQL {
  if (byName) return sql`${SORT_NAME} IS NULL, ${SORT_NAME} ${sort.direction}, g.key`;
  return sql`${sort.column} ${sort.direction} NULLS LAST, ${SORT_NAME} IS NULL, ${SORT_NAME}, g.key`;
}

const SALES_SORT_COLUMNS = {
  name: SORT_NAME,
  quantity: sql`g.quantity`,
  gross: sql`g.gross`,
  returns: sql`g.returns`,
  net: sql`g.net`,
  cost: sql`g.cost`,
  margin: sql`g.net - g.cost`,
  // A row with a net of zero has no percent: last, like a null
  marginPercent: sql`CASE WHEN g.net <> 0 THEN (g.net - g.cost) / g.net END`,
} satisfies Record<SortColumn<SalesReportSort>, SQL>;

const unitColumns = {
  unit_code: z.string().nullable(),
  unit_decimals: z.number().int().nullable(),
};

const tradeRowColumns = {
  key: z.string(),
  kind: z.enum(TRADE_REPORT_ROW_KINDS),
  id: z.uuid().nullable(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  month: z.string().nullable(),
  quantity: z.string().nullable(),
  ...unitColumns,
  gross: z.string(),
  returns: z.string(),
  net: z.string(),
  total_gross: z.string(),
  total_returns: z.string(),
  total_net: z.string(),
};

const salesRowSchema = z.object({
  ...tradeRowColumns,
  cost: z.string(),
  total_cost: z.string(),
});

// The quantity and its unit belong to the product group only: elsewhere a row mixes units. A
// number here, so it sorts as one; text only in the last SELECT.
function quantityColumns(byProduct: boolean): SQL {
  return byProduct
    ? sql`sum(l.quantity) AS quantity, u.code AS unit_code, u.decimals AS unit_decimals`
    : sql`NULL::numeric AS quantity, NULL::text AS unit_code, NULL::int AS unit_decimals`;
}

function unitOf(row: { unit_code: string | null; unit_decimals: number | null }) {
  return row.unit_code === null || row.unit_decimals === null
    ? null
    : { code: row.unit_code, decimals: row.unit_decimals };
}

const ZERO = '0.0000';

// The sales of a period, a page of rows at a time (page) or every row (null, an export). Without
// withCost the cost columns are null; the service refuses a cost sort before it gets here.
export async function salesReport(
  tx: Transaction,
  filter: SalesReportFilter,
  options: { withCost: boolean; page: ReportPage | null },
): Promise<SalesReport> {
  const tenantId = getTenantId();
  const grouping = SALES_GROUPINGS[filter.groupBy];
  const sort = sortColumn(filter.sort, SALES_SORT_COLUMNS);
  const where: SQL[] = [];
  if (filter.branchId !== undefined) where.push(sql`l.branch_id = ${filter.branchId}::uuid`);
  // A walk-in has no group, so the group filter leaves the walk-ins out
  if (filter.customerGroupId !== undefined) {
    where.push(sql`c.customer_group_id = ${filter.customerGroupId}::uuid`);
  }
  if (filter.categoryId !== undefined) {
    where.push(inCategory(sql`p.category_id`, tenantId, filter.categoryId));
  }
  const found = await select(
    tx,
    sql`WITH lines AS (${salesLines(tenantId, filter.from, filter.to)}),
        grouped AS (
          SELECT ${grouping.select}, ${quantityColumns(filter.groupBy === 'product')},
                 sum(l.gross) AS gross, sum(l.returns) AS returns,
                 sum(l.gross) - sum(l.returns) AS net, sum(l.cost) AS cost
            FROM lines l
            JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
            LEFT JOIN parties c ON c.tenant_id = l.tenant_id AND c.id = l.customer_id
            ${grouping.joins}
           ${where.length === 0 ? sql`` : sql`WHERE ${sql.join(where, sql` AND `)}`}
           GROUP BY ${grouping.groupBy}
        )
        SELECT g.key, g.kind, g.id, g.code, g.name, g.month,
               round(g.quantity, 4)::text AS quantity, g.unit_code, g.unit_decimals,
               round(g.gross, 4)::text AS gross, round(g.returns, 4)::text AS returns,
               round(g.net, 4)::text AS net, round(g.cost, 4)::text AS cost,
               round(coalesce(sum(g.gross) OVER (), 0), 4)::text AS total_gross,
               round(coalesce(sum(g.returns) OVER (), 0), 4)::text AS total_returns,
               round(coalesce(sum(g.net) OVER (), 0), 4)::text AS total_net,
               round(coalesce(sum(g.cost) OVER (), 0), 4)::text AS total_cost
          FROM grouped g
         ORDER BY ${orderBy(sort, filter.sort === 'name' || filter.sort === '-name')}
         ${pageClause(options.page)}`,
    salesRowSchema,
  );
  const first = found[0];
  const page = pageRows(found, options.page);
  return {
    items: page.items.map((row) => ({
      key: row.key,
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      month: row.month,
      quantity: row.quantity,
      baseUnit: unitOf(row),
      gross: row.gross,
      returns: row.returns,
      net: row.net,
      ...costColumns(row.net, options.withCost ? row.cost : null),
    })),
    nextCursor: page.nextCursor,
    // No row = nothing sold: zeros, not an error
    totals: {
      gross: first?.total_gross ?? ZERO,
      returns: first?.total_returns ?? ZERO,
      net: first?.total_net ?? ZERO,
      ...costColumns(
        first?.total_net ?? ZERO,
        options.withCost ? (first?.total_cost ?? ZERO) : null,
      ),
    },
    withCost: options.withCost,
    // The books' lines carry a branch but no customer group and no category (decision 19)
    books:
      filter.customerGroupId === undefined && filter.categoryId === undefined
        ? await booksSales(tx, filter.from, filter.to, filter.branchId ?? null)
        : null,
  };
}

// The books' sales of the period, as the dashboard counts them (step 21a): credit − debit of the
// 'sales' account and of the Sales returns account, by account_day_totals, without the closing
// entries (a year-end close debits Sales with the whole year)
async function booksSales(
  tx: Transaction,
  from: string,
  to: string,
  branchId: string | null,
): Promise<string> {
  const books = await loadBooks(tx);
  if (books.salesAccountIds.length === 0) return ZERO;
  const [row] = await select(
    tx,
    sql`SELECT round(coalesce(sum(t.credit - t.debit), 0), 4)::text AS sales
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND t.account_id IN (${sql.join(
             books.salesAccountIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
           AND NOT t.closing
           AND t.day BETWEEN ${from}::date AND ${to}::date
           ${branchId === null ? sql`` : sql`AND t.branch_id = ${branchId}::uuid`}`,
    z.object({ sales: z.string() }),
  );
  return row?.sales ?? ZERO;
}

// ---------------------------------------------------------------------------------------------
// Purchases

// Every billed and debited line of the period (decision 4), net of discounts and before VAT:
// - a bill line: a product line (account_id NULL) or an account line (a service, with its expense
//   account);
// - a bill expense: an account and an amount, no product;
// - a debit note line, on the debit note's day and in its branch: an account line when the bill
//   line it debits is one. Only a line for goods that went back (a return line) takes the quantity
//   off. A debit note without a bill has only return lines: goods.
// - a debit note expense, with the bill expense's account.
function purchaseLines(tenantId: string, from: string, to: string): SQL {
  return sql`
    SELECT l.tenant_id, b.date AS day, b.supplier_id, b.branch_id, l.variant_id, l.account_id,
           l.net AS gross, 0::numeric AS returns,
           CASE WHEN l.account_id IS NULL THEN l.base_quantity ELSE 0 END AS quantity
      FROM bill_lines l
      JOIN bills b ON b.tenant_id = l.tenant_id AND b.id = l.bill_id
     WHERE l.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT e.tenant_id, b.date, b.supplier_id, b.branch_id, NULL::uuid, e.account_id,
           e.net, 0, 0
      FROM bill_expenses e
      JOIN bills b ON b.tenant_id = e.tenant_id AND b.id = e.bill_id
     WHERE e.tenant_id = ${tenantId}::uuid AND b.status = 'posted'
       AND b.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT l.tenant_id, d.date, d.supplier_id, d.branch_id, l.variant_id, bl.account_id,
           0, l.net,
           CASE WHEN l.return_line_id IS NULL OR bl.account_id IS NOT NULL THEN 0
                ELSE -l.base_quantity END
      FROM debit_note_lines l
      JOIN debit_notes d ON d.tenant_id = l.tenant_id AND d.id = l.debit_note_id
      LEFT JOIN bill_lines bl ON bl.tenant_id = l.tenant_id AND bl.id = l.bill_line_id
     WHERE l.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT e.tenant_id, d.date, d.supplier_id, d.branch_id, NULL::uuid, be.account_id,
           0, e.net, 0
      FROM debit_note_expenses e
      JOIN debit_notes d ON d.tenant_id = e.tenant_id AND d.id = e.debit_note_id
      JOIN bill_expenses be ON be.tenant_id = e.tenant_id AND be.id = e.bill_expense_id
     WHERE e.tenant_id = ${tenantId}::uuid AND d.status = 'posted'
       AND d.date BETWEEN ${from}::date AND ${to}::date`;
}

// The product (p) is joined for product lines only (account_id IS NULL): an account line's product
// is a service, which belongs in the "Expenses" row (decision 11), and an expense has none
const PURCHASE_GROUPINGS = {
  supplier: {
    select: sql`s.id::text AS key, 'item' AS kind, s.id::text AS id, s.code, s.name,
                NULL::text AS month`,
    joins: sql``,
    groupBy: sql`s.id`,
  },
  product: {
    select: sql`coalesce(p.id::text, 'expenses') AS key,
                CASE WHEN p.id IS NULL THEN 'expenses' ELSE 'item' END AS kind,
                p.id::text AS id, p.code, p.name, NULL::text AS month`,
    joins: sql``,
    groupBy: sql`p.id, u.id`,
  },
  account: {
    select: sql`coalesce(a.id::text, 'products') AS key,
                CASE WHEN a.id IS NULL THEN 'products' ELSE 'item' END AS kind,
                a.id::text AS id, a.code, a.name, NULL::text AS month`,
    joins: sql`LEFT JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id`,
    groupBy: sql`a.id`,
  },
  month: SALES_GROUPINGS.month,
} satisfies Record<PurchaseReportGroup, Grouping>;

const PURCHASE_SORT_COLUMNS = {
  name: SORT_NAME,
  // The "Expenses" row shows no quantity (its sum of zeros is not one): none, so last either way
  quantity: sql`CASE WHEN g.kind = 'item' THEN g.quantity END`,
  gross: sql`g.gross`,
  returns: sql`g.returns`,
  net: sql`g.net`,
} satisfies Record<SortColumn<PurchaseReportSort>, SQL>;

const purchaseRowSchema = z.object(tradeRowColumns);

export async function purchaseReport(
  tx: Transaction,
  filter: PurchaseReportFilter,
  options: { page: ReportPage | null },
): Promise<PurchaseReport> {
  const tenantId = getTenantId();
  const grouping = PURCHASE_GROUPINGS[filter.groupBy];
  const sort = sortColumn(filter.sort, PURCHASE_SORT_COLUMNS);
  const where: SQL[] = [];
  if (filter.branchId !== undefined) where.push(sql`l.branch_id = ${filter.branchId}::uuid`);
  if (filter.supplierGroupId !== undefined) {
    where.push(sql`s.supplier_group_id = ${filter.supplierGroupId}::uuid`);
  }
  // p is NULL on an account line or an expense, so they drop out: they have no category
  if (filter.categoryId !== undefined) {
    where.push(inCategory(sql`p.category_id`, tenantId, filter.categoryId));
  }
  const found = await select(
    tx,
    sql`WITH lines AS (${purchaseLines(tenantId, filter.from, filter.to)}),
        grouped AS (
          SELECT ${grouping.select}, ${quantityColumns(filter.groupBy === 'product')},
                 sum(l.gross) AS gross, sum(l.returns) AS returns,
                 sum(l.gross) - sum(l.returns) AS net
            FROM lines l
            JOIN parties s ON s.tenant_id = l.tenant_id AND s.id = l.supplier_id
            LEFT JOIN product_variants v
              ON l.account_id IS NULL AND v.tenant_id = l.tenant_id AND v.id = l.variant_id
            LEFT JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
            ${grouping.joins}
           ${where.length === 0 ? sql`` : sql`WHERE ${sql.join(where, sql` AND `)}`}
           GROUP BY ${grouping.groupBy}
        )
        SELECT g.key, g.kind, g.id, g.code, g.name, g.month,
               -- The "Expenses" row adds no quantity: it has no product
               CASE WHEN g.kind = 'item' THEN round(g.quantity, 4)::text END AS quantity,
               g.unit_code, g.unit_decimals,
               round(g.gross, 4)::text AS gross, round(g.returns, 4)::text AS returns,
               round(g.net, 4)::text AS net,
               round(coalesce(sum(g.gross) OVER (), 0), 4)::text AS total_gross,
               round(coalesce(sum(g.returns) OVER (), 0), 4)::text AS total_returns,
               round(coalesce(sum(g.net) OVER (), 0), 4)::text AS total_net
          FROM grouped g
         ORDER BY ${orderBy(sort, filter.sort === 'name' || filter.sort === '-name')}
         ${pageClause(options.page)}`,
    purchaseRowSchema,
  );
  const first = found[0];
  const page = pageRows(found, options.page);
  return {
    items: page.items.map((row) => ({
      key: row.key,
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      month: row.month,
      quantity: row.quantity,
      baseUnit: unitOf(row),
      gross: row.gross,
      returns: row.returns,
      net: row.net,
    })),
    nextCursor: page.nextCursor,
    totals: {
      gross: first?.total_gross ?? ZERO,
      returns: first?.total_returns ?? ZERO,
      net: first?.total_net ?? ZERO,
    },
  };
}
```

**The sales lines** (`salesLines()`): one row per line of the period, from four kinds of document, signed so they add
up.

- **An invoice line** has its challan line's cost in the share it billed (decision 33): `value × quantity ÷ the
  challan line's quantity`. A return before billing makes the invoice bill only what was kept, and the challan line's
  `value` is the cost of all of it. `coalesce(…, 0)` is for a service line, which has no challan line.
- **Only posted invoices,** by their own date: a draft is not a sale.
- **A POS sale line** has its own cost (`value`, step 20a) and its warehouse's branch: a POS sale has no branch of its
  own. POS sales have no draft, so there is no status to check.
- **A credit note line** takes its money off on the credit note's day (decision 2), in its invoice's branch (a credit
  note has none of its own, step 15d). Its quantity and cost come off only with a return line: a price cut or a
  billing mistake gave money back, not goods.
- **A POS return line** takes off its money, quantity and cost on the return's day, in the warehouse the goods came
  back to. The customer is the sale's.
- **`0::numeric` in the first branch:** the columns of a `UNION ALL` take their types from the first branch, and a bare
  `0` would be an integer.
- **The date is checked inside each branch,** next to the table that has the index on it.

**One row of each group** (`SALES_GROUPINGS`):

- **A customer row is grouped by `l.customer_id` and `c.id`;** a walk-in has neither, so all walk-ins are one row with
  the kind `walk_in` and the key `'walk_in'` (decision 16). `c.code` and `c.name` need no `GROUP BY`: Postgres knows
  they follow from the primary key `c.id`.
- **A product row is grouped by the product, not the variant** (decision 12). `u.id` is in the `GROUP BY` for the unit's
  code and decimals.
- **A category row is the product's own category,** with one `no_category` row (decision 13).
- **A month row's key and month are `'2026-10'`:** `to_char()` of the date, which sorts like the date.
- **`satisfies Record<SalesReportGroup, Grouping>`:** a group added to the contract without its SQL fails the type check.

**The sorts:**

- **Every column is written with the alias `g.`** This is the trap the comment describes: the last `SELECT` has a text
  column called `net` (`round(g.net, 4)::text AS net`), and `ORDER BY net` sorts by that one, so ৳900 comes before
  ৳5,460. `g.net` is the number. I broke it on purpose (see below) to be sure the smoke test sees it.
- **`SORT_NAME`** sorts a month by its key and a thing by its name in lower case. A row that is not an item (walk-in,
  no category) has none, and `IS NULL` first in the `ORDER BY` puts it last whichever way the names go: the page
  shows "Walk-in customers" under the named customers.
- **Every order ends with the key:** two customers with the same name, or the same net, come in the same order on every
  page, so the offset never repeats or skips one.
- **`NULLS LAST` on a number:** the margin percent of a row with a net of zero is `NULL`, and it goes at the end.
- **The margin and its percent are worked out in SQL to sort only.** The answer's values come from the contract's
  `costColumns()`, so the page, the mock and the file show one rounding.

**The query** (`salesReport()`):

- **Three steps in one statement:** `lines`, then `grouped` with the filters, then the sorted page with the totals by
  window function (decision 32). The totals are `coalesce(…, 0)`: with no row at all, there is no row to carry them
  either, and the code below gives zeros.
- **The quantity stays a number until the last `SELECT`,** so a sort by quantity is a number's sort too.
- **The customer group filter is on `c`,** the customer: a walk-in has no group and drops out.
- **The cost is always worked out and dropped when `withCost` is false.** The SQL stays one shape; the service has
  already refused a sort by the cost (decision 17).
- **`books` is the dashboard's number** (`booksSales()` reads the same accounts as 21a's `loadBooks()`), `null` with a
  customer group or a category (decision 19). The page shows the difference; with journal entries by hand on the
  sales account, the two differ.

**The purchase lines** (`purchaseLines()`):

- **A bill line is a product line or an account line** (a service, `account_id` set). Only a product line has a
  quantity.
- **A bill expense** has an account and an amount and no product: `NULL::uuid` for the variant.
- **A debit note line is an account line when the bill line it debits is one.** A debit note without a bill has only
  return lines, so it is goods. Only a line for goods that went back takes the quantity off.
- **A debit note expense** takes the bill expense's account.

**One row of each group** (`PURCHASE_GROUPINGS`):

- **The product is joined for product lines only** (`ON l.account_id IS NULL AND …`). An account line's product is a
  service, which belongs in the "Expenses" row with the bill expenses (decision 11). So by product, every row with no
  product is one `expenses` row; by account, every line with no account is one `products` row.
- **The "Expenses" row has no quantity:** `CASE WHEN g.kind = 'item'` in the last `SELECT`, since its sum of zeros would
  read as "0 pcs".
- **The category filter drops the account lines and expenses:** their `p` is `NULL`, so `p.category_id IN (…)` is not
  true. The contract's comment says so (21b.1).
- **The month grouping is the sales report's:** the same SQL, so one month reads the same in both reports.
- **The quantity sort is `CASE WHEN g.kind = 'item' THEN g.quantity END`** (decision 42). The "Expenses" row's sum of
  zeros is a number, so `g.quantity` alone would put it first when sorted from small to large; as `NULL` it goes
  last either way (`NULLS LAST`). The sales report needs no such case: by product, every row is an item.

### The agings

```ts
import {
  agingAmountsOf,
  agingBucketOf,
  type AgingReport,
  type AgingSort,
  type ApAgingFilter,
  type ApAgingParty,
  AP_ADVANCE_KINDS,
  type ArAgingFilter,
  type ArAgingParty,
  AR_ADVANCE_KINDS,
  daysOverdue,
  type PartyRef,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { loadBooks } from '../dashboard/dashboard-queries.js';
import {
  pageClause,
  pageRows,
  type ReportPage,
  select,
  sortColumn,
  type SortColumn,
} from './report-paging.js';

// The receivables and payables aging (step 21b), in plain SQL. As of a day D (decision 5):
// - A document's open amount on D is what is open now plus what was applied to it after D. The
//   invoice (or bill) keeps what is applied to it now (amount_paid, amount_credited, kept by the
//   allocations' triggers), and the allocations with applied_on after D are the ones that were not
//   there yet. So only the invoices open now and the ones paid after D are read: the open
//   invoices' partial index and the allocations' applied_on index (21b.2, decision 28), never every
//   invoice the workspace ever had.
// - An advance on D is the money of a receipt (or credit note, payment, debit note) dated D or
//   before, less what of it was applied by D, less what refunds of D or before paid back. A receipt
//   voided after D still counts on D: the books took it back only on the void day. Its allocations
//   were deleted with the void, so on those days its invoices show open and the receipt as an
//   advance; the balance is still the books' (the known gap of decision 5).
// - No branch (decision 6). A party with nothing open and no advance has no row.

// One kind of aging: the receivables (customers, invoices, receipts and credit notes) or the
// payables (suppliers, bills, payments and debit notes)
interface AgingSide {
  // id, party_id, number, date, due_date, total, open, and supplier_bill_number (NULL for an invoice)
  documents: (tenantId: string, asOf: string) => SQL;
  // id, kind, party_id, number, date, amount
  advances: (tenantId: string, asOf: string) => SQL;
  // The group filter's column, and who counts as a party of this aging
  groupColumn: SQL;
  isParty: SQL;
  // The account's balance in the report's sense: what customers owe is a debit balance, what is
  // owed to suppliers a credit one
  account: 'receivable' | 'payable';
}

// What was applied after D, by document, and what refunds after D gave back: in the "candidates"
// of the advances below. Every EXISTS reads an index that starts with the tenant and the document.
const RECEIVABLES: AgingSide = {
  documents: (tenantId, asOf) => sql`
    WITH later AS (
      SELECT a.invoice_id, sum(a.amount) AS amount
        FROM (
          SELECT invoice_id, amount FROM receipt_allocations
           WHERE tenant_id = ${tenantId}::uuid AND applied_on > ${asOf}::date
          UNION ALL
          SELECT invoice_id, amount FROM credit_note_allocations
           WHERE tenant_id = ${tenantId}::uuid AND applied_on > ${asOf}::date
        ) a
       GROUP BY a.invoice_id
    )
    SELECT i.id, i.customer_id AS party_id, i.number, i.date, i.due_date, i.total,
           i.total - i.amount_paid - i.amount_credited + coalesce(l.amount, 0) AS open,
           NULL::text AS supplier_bill_number
      FROM invoices i
      LEFT JOIN later l ON l.invoice_id = i.id
     WHERE i.tenant_id = ${tenantId}::uuid AND i.status = 'posted' AND i.date <= ${asOf}::date
       AND (i.amount_paid + i.amount_credited < i.total OR l.invoice_id IS NOT NULL)`,
  advances: (tenantId, asOf) => sql`
    SELECT r.id, 'receipt' AS kind, r.customer_id AS party_id, r.number, r.date,
           r.amount
             - coalesce((SELECT sum(a.amount) FROM receipt_allocations a
                          WHERE a.tenant_id = r.tenant_id AND a.receipt_id = r.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM refunds f
                          WHERE f.tenant_id = r.tenant_id AND f.receipt_id = r.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0) AS amount
      FROM receipts r
     WHERE r.tenant_id = ${tenantId}::uuid AND r.date <= ${asOf}::date
       AND (r.status = 'posted' OR r.void_date > ${asOf}::date)
       AND (r.status = 'voided' OR r.applied + r.refunded < r.amount
            OR EXISTS (SELECT 1 FROM receipt_allocations a
                        WHERE a.tenant_id = r.tenant_id AND a.receipt_id = r.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM refunds f
                        WHERE f.tenant_id = r.tenant_id AND f.receipt_id = r.id
                          AND f.date > ${asOf}::date))
    UNION ALL
    SELECT c.id, 'credit_note', c.customer_id, c.number, c.date,
           c.total
             - coalesce((SELECT sum(a.amount) FROM credit_note_allocations a
                          WHERE a.tenant_id = c.tenant_id AND a.credit_note_id = c.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM refunds f
                          WHERE f.tenant_id = c.tenant_id AND f.credit_note_id = c.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0)
      FROM credit_notes c
     WHERE c.tenant_id = ${tenantId}::uuid AND c.status = 'posted' AND c.date <= ${asOf}::date
       AND (c.applied + c.refunded < c.total
            OR EXISTS (SELECT 1 FROM credit_note_allocations a
                        WHERE a.tenant_id = c.tenant_id AND a.credit_note_id = c.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM refunds f
                        WHERE f.tenant_id = c.tenant_id AND f.credit_note_id = c.id
                          AND f.date > ${asOf}::date))`,
  groupColumn: sql`p.customer_group_id`,
  isParty: sql`p.is_customer`,
  account: 'receivable',
};

// The same for suppliers. Only a posted payment pays a bill: a draft's or a pending payment's
// allocations are its plan (step 17c), and the bill's amount_paid leaves them out too. A payment
// waiting for approval is not in the books yet, so it is no advance either.
const PAYABLES: AgingSide = {
  documents: (tenantId, asOf) => sql`
    WITH later AS (
      SELECT a.bill_id, sum(a.amount) AS amount
        FROM (
          SELECT a.bill_id, a.amount FROM supplier_payment_allocations a
            JOIN supplier_payments sp ON sp.tenant_id = a.tenant_id AND sp.id = a.payment_id
           WHERE a.tenant_id = ${tenantId}::uuid AND a.applied_on > ${asOf}::date
             AND sp.status = 'posted'
          UNION ALL
          SELECT bill_id, amount FROM debit_note_allocations
           WHERE tenant_id = ${tenantId}::uuid AND applied_on > ${asOf}::date
        ) a
       GROUP BY a.bill_id
    )
    SELECT b.id, b.supplier_id AS party_id, b.number, b.date, b.due_date, b.total,
           b.total - b.amount_paid - b.amount_debited + coalesce(l.amount, 0) AS open,
           b.supplier_bill_number
      FROM bills b
      LEFT JOIN later l ON l.bill_id = b.id
     WHERE b.tenant_id = ${tenantId}::uuid AND b.status = 'posted' AND b.date <= ${asOf}::date
       AND (b.amount_paid + b.amount_debited < b.total OR l.bill_id IS NOT NULL)`,
  advances: (tenantId, asOf) => sql`
    SELECT sp.id, 'payment' AS kind, sp.supplier_id AS party_id, sp.number, sp.date,
           sp.amount
             - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                          WHERE a.tenant_id = sp.tenant_id AND a.payment_id = sp.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM supplier_refunds f
                          WHERE f.tenant_id = sp.tenant_id AND f.payment_id = sp.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0) AS amount
      FROM supplier_payments sp
     WHERE sp.tenant_id = ${tenantId}::uuid AND sp.date <= ${asOf}::date
       AND (sp.status = 'posted' OR (sp.status = 'voided' AND sp.void_date > ${asOf}::date))
       AND (sp.status = 'voided' OR sp.applied + sp.refunded < sp.amount
            OR EXISTS (SELECT 1 FROM supplier_payment_allocations a
                        WHERE a.tenant_id = sp.tenant_id AND a.payment_id = sp.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM supplier_refunds f
                        WHERE f.tenant_id = sp.tenant_id AND f.payment_id = sp.id
                          AND f.date > ${asOf}::date))
    UNION ALL
    SELECT d.id, 'debit_note', d.supplier_id, d.number, d.date,
           d.total
             - coalesce((SELECT sum(a.amount) FROM debit_note_allocations a
                          WHERE a.tenant_id = d.tenant_id AND a.debit_note_id = d.id
                            AND a.applied_on <= ${asOf}::date), 0)
             - coalesce((SELECT sum(f.amount) FROM supplier_refunds f
                          WHERE f.tenant_id = d.tenant_id AND f.debit_note_id = d.id
                            AND f.date <= ${asOf}::date
                            AND (f.status = 'posted' OR f.void_date > ${asOf}::date)), 0)
      FROM debit_notes d
     WHERE d.tenant_id = ${tenantId}::uuid AND d.status = 'posted' AND d.date <= ${asOf}::date
       AND (d.applied + d.refunded < d.total
            OR EXISTS (SELECT 1 FROM debit_note_allocations a
                        WHERE a.tenant_id = d.tenant_id AND a.debit_note_id = d.id
                          AND a.applied_on > ${asOf}::date)
            OR EXISTS (SELECT 1 FROM supplier_refunds f
                        WHERE f.tenant_id = d.tenant_id AND f.debit_note_id = d.id
                          AND f.date > ${asOf}::date))`,
  groupColumn: sql`p.supplier_group_id`,
  isParty: sql`p.is_supplier`,
  account: 'payable',
};

// The buckets of decision 22 in SQL, the same edges as agingBucketOf() in the contract: current up
// to and on the due date, then 1–30, 31–60, 61–90 and over 90 days late. date − date is a whole
// number of days in Postgres, with no time zone in it.
function bucketSums(asOf: string): SQL {
  const late = sql`(${asOf}::date - d.due_date)`;
  return sql`
    sum(d.open) FILTER (WHERE ${late} <= 0) AS current,
    sum(d.open) FILTER (WHERE ${late} BETWEEN 1 AND 30) AS days1_to30,
    sum(d.open) FILTER (WHERE ${late} BETWEEN 31 AND 60) AS days31_to60,
    sum(d.open) FILTER (WHERE ${late} BETWEEN 61 AND 90) AS days61_to90,
    sum(d.open) FILTER (WHERE ${late} > 90) AS over90,
    sum(d.open) AS due`;
}

// r.<column>: the per-party numbers, not the SELECT's text of the same name (see the sorts in
// trade-report-queries.ts). Name, then id: two customers with one name keep their order.
const AGING_SORT_COLUMNS = {
  name: sql`lower(p.name)`,
  current: sql`r.current`,
  days1To30: sql`r.days1_to30`,
  days31To60: sql`r.days31_to60`,
  days61To90: sql`r.days61_to90`,
  over90: sql`r.over90`,
  due: sql`r.due`,
  advances: sql`r.advances`,
  balance: sql`r.balance`,
} satisfies Record<SortColumn<AgingSort>, SQL>;

const money = z.string();

const agingRowSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  current: money,
  days1_to30: money,
  days31_to60: money,
  days61_to90: money,
  over90: money,
  due: money,
  advances: money,
  balance: money,
  total_current: money,
  total_days1_to30: money,
  total_days31_to60: money,
  total_days61_to90: money,
  total_over90: money,
  total_due: money,
  total_advances: money,
  total_balance: money,
});

const ZERO = '0.0000';

// The query's filters, the same for both agings once the group is named
interface AgingFilter {
  asOf: string;
  show: 'all' | 'overdue';
  sort: AgingSort;
  groupId: string | undefined;
}

async function agingReport(
  tx: Transaction,
  side: AgingSide,
  filter: AgingFilter,
  page: ReportPage | null,
): Promise<AgingReport> {
  const tenantId = getTenantId();
  const sort = sortColumn(filter.sort, AGING_SORT_COLUMNS);
  const where: SQL[] = [sql`p.tenant_id = ${tenantId}::uuid`];
  if (filter.groupId !== undefined) where.push(sql`${side.groupColumn} = ${filter.groupId}::uuid`);
  // Anything past its due date: every bucket but Current. The whole row still shows.
  if (filter.show === 'overdue') where.push(sql`r.due - r.current > 0`);
  const found = await select(
    tx,
    sql`WITH documents AS (${side.documents(tenantId, filter.asOf)}),
        advances AS (${side.advances(tenantId, filter.asOf)}),
        owed AS (
          SELECT d.party_id, ${bucketSums(filter.asOf)}
            FROM documents d
           GROUP BY d.party_id
        ),
        held AS (
          SELECT a.party_id, sum(a.amount) AS advances
            FROM advances a
           WHERE a.amount > 0
           GROUP BY a.party_id
        ),
        r AS (
          SELECT coalesce(o.party_id, h.party_id) AS party_id,
                 coalesce(o.current, 0) AS current, coalesce(o.days1_to30, 0) AS days1_to30,
                 coalesce(o.days31_to60, 0) AS days31_to60, coalesce(o.days61_to90, 0) AS days61_to90,
                 coalesce(o.over90, 0) AS over90, coalesce(o.due, 0) AS due,
                 coalesce(h.advances, 0) AS advances,
                 coalesce(o.due, 0) - coalesce(h.advances, 0) AS balance
            FROM owed o
            FULL JOIN held h ON h.party_id = o.party_id
        )
        SELECT p.id, p.code, p.name,
               round(r.current, 4)::text AS current, round(r.days1_to30, 4)::text AS days1_to30,
               round(r.days31_to60, 4)::text AS days31_to60,
               round(r.days61_to90, 4)::text AS days61_to90, round(r.over90, 4)::text AS over90,
               round(r.due, 4)::text AS due, round(r.advances, 4)::text AS advances,
               round(r.balance, 4)::text AS balance,
               round(sum(r.current) OVER (), 4)::text AS total_current,
               round(sum(r.days1_to30) OVER (), 4)::text AS total_days1_to30,
               round(sum(r.days31_to60) OVER (), 4)::text AS total_days31_to60,
               round(sum(r.days61_to90) OVER (), 4)::text AS total_days61_to90,
               round(sum(r.over90) OVER (), 4)::text AS total_over90,
               round(sum(r.due) OVER (), 4)::text AS total_due,
               round(sum(r.advances) OVER (), 4)::text AS total_advances,
               round(sum(r.balance) OVER (), 4)::text AS total_balance
          FROM r
          JOIN parties p ON p.tenant_id = ${tenantId}::uuid AND p.id = r.party_id
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY ${sort.column} ${sort.direction}, lower(p.name), p.id
         ${pageClause(page)}`,
    agingRowSchema,
  );
  const first = found[0];
  const rows = pageRows(found, page);
  return {
    items: rows.items.map((row) => ({
      party: { id: row.id, code: row.code, name: row.name },
      current: row.current,
      days1To30: row.days1_to30,
      days31To60: row.days31_to60,
      days61To90: row.days61_to90,
      over90: row.over90,
      due: row.due,
      advances: row.advances,
      balance: row.balance,
    })),
    nextCursor: rows.nextCursor,
    asOf: filter.asOf,
    // No row: nothing owed and no advance, zeros
    totals: {
      current: first?.total_current ?? ZERO,
      days1To30: first?.total_days1_to30 ?? ZERO,
      days31To60: first?.total_days31_to60 ?? ZERO,
      days61To90: first?.total_days61_to90 ?? ZERO,
      over90: first?.total_over90 ?? ZERO,
      due: first?.total_due ?? ZERO,
      advances: first?.total_advances ?? ZERO,
      balance: first?.total_balance ?? ZERO,
    },
    // The books know no due dates: nothing to compare "overdue only" with (decision 22)
    ledger:
      filter.show === 'overdue'
        ? null
        : await ledgerBalance(tx, side, filter.asOf, {
            groupId: filter.groupId,
            partyId: undefined,
          }),
  };
}

// The control account's balance at the end of D, in the report's sense: the receivable's debit −
// credit, the payable's credit − debit. From the journal's lines, not account_day_totals: only the
// lines carry the party (step 15a), which the group filter and a party's page need. The lines of one
// account up to a day are read by journal_lines_tenant_account_idx.
async function ledgerBalance(
  tx: Transaction,
  side: AgingSide,
  asOf: string,
  of: { groupId: string | undefined; partyId: string | undefined },
): Promise<string> {
  const books = await loadBooks(tx);
  const accountId =
    side.account === 'receivable' ? books.receivableAccountId : books.payableAccountId;
  if (accountId === null) return ZERO;
  const tenantId = getTenantId();
  const amount = side.account === 'receivable' ? sql`l.debit - l.credit` : sql`l.credit - l.debit`;
  const [row] = await select(
    tx,
    sql`SELECT round(coalesce(sum(${amount}), 0), 4)::text AS balance
          FROM journal_lines l
          JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
          ${of.groupId === undefined ? sql`` : sql`JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id`}
         WHERE l.tenant_id = ${tenantId}::uuid AND l.account_id = ${accountId}::uuid
           AND e.status = 'posted' AND e.date <= ${asOf}::date
           ${of.groupId === undefined ? sql`` : sql`AND ${side.groupColumn} = ${of.groupId}::uuid`}
           ${of.partyId === undefined ? sql`` : sql`AND l.party_id = ${of.partyId}::uuid`}`,
    z.object({ balance: z.string() }),
  );
  return row?.balance ?? ZERO;
}

export function receivablesAging(
  tx: Transaction,
  filter: ArAgingFilter,
  page: ReportPage | null,
): Promise<AgingReport> {
  return agingReport(tx, RECEIVABLES, { ...filter, groupId: filter.customerGroupId }, page);
}

export function payablesAging(
  tx: Transaction,
  filter: ApAgingFilter,
  page: ReportPage | null,
): Promise<AgingReport> {
  return agingReport(tx, PAYABLES, { ...filter, groupId: filter.supplierGroupId }, page);
}

// ---------------------------------------------------------------------------------------------
// One party's page (decision 23): its open documents, the oldest due date first, and its
// advances, the oldest first. Not paged.

const documentRowSchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  due_date: z.iso.date(),
  total: z.string(),
  open: z.string(),
  supplier_bill_number: z.string().nullable(),
});

function advanceRowSchema<K extends readonly [string, ...string[]]>(kinds: K) {
  return z.object({
    id: z.uuid(),
    kind: z.enum(kinds),
    number: z.string(),
    date: z.iso.date(),
    amount: z.string(),
  });
}

// The party, if it is one of this aging's: a supplier is not found on the receivables' page
async function partyOf(
  tx: Transaction,
  side: AgingSide,
  partyId: string,
): Promise<PartyRef | null> {
  const [party] = await select(
    tx,
    sql`SELECT p.id, p.code, p.name FROM parties p
         WHERE p.tenant_id = ${getTenantId()}::uuid AND p.id = ${partyId}::uuid AND ${side.isParty}`,
    z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  );
  return party ?? null;
}

async function partyRows<S extends z.ZodType>(
  tx: Transaction,
  side: AgingSide,
  partyId: string,
  asOf: string,
  advanceRow: S,
): Promise<{ documents: z.output<typeof documentRowSchema>[]; advances: z.output<S>[] }> {
  const tenantId = getTenantId();
  const [documents, advances] = await Promise.all([
    select(
      tx,
      sql`SELECT d.id, d.number, d.date::text AS date, d.due_date::text AS due_date,
                 round(d.total, 4)::text AS total, round(d.open, 4)::text AS open,
                 d.supplier_bill_number
            FROM (${side.documents(tenantId, asOf)}) d
           WHERE d.party_id = ${partyId}::uuid
           ORDER BY d.due_date, d.date, d.number`,
      documentRowSchema,
    ),
    select(
      tx,
      sql`SELECT a.id, a.kind, a.number, a.date::text AS date, round(a.amount, 4)::text AS amount
            FROM (${side.advances(tenantId, asOf)}) a
           WHERE a.party_id = ${partyId}::uuid AND a.amount > 0
           ORDER BY a.date, a.number`,
      advanceRow,
    ),
  ]);
  return { documents, advances };
}

// bills.supplier_bill_number is NOT NULL; the column is nullable here only because an invoice
// has none. A bill without one would be a broken row, not something to show as ''.
function supplierBillNumber(row: z.output<typeof documentRowSchema>): string {
  if (row.supplier_bill_number === null) throw new Error(`Bill ${row.id} has no supplier number`);
  return row.supplier_bill_number;
}

function documentOf(row: z.output<typeof documentRowSchema>, asOf: string) {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    dueDate: row.due_date,
    total: row.total,
    open: row.open,
    daysOverdue: daysOverdue(row.due_date, asOf),
    bucket: agingBucketOf(row.due_date, asOf),
  };
}

// The party's row of the report, worked out by the contract's agingAmountsOf() from the same
// documents: the mock does the same, and 21b.4 checks it against the report's SQL buckets
function totalsOf(
  documents: readonly z.output<typeof documentRowSchema>[],
  advances: readonly { amount: string }[],
  asOf: string,
) {
  return agingAmountsOf(
    documents.map((row) => ({ dueDate: row.due_date, open: row.open })),
    advances.map((row) => row.amount),
    asOf,
  );
}

export async function receivablesOf(
  tx: Transaction,
  customerId: string,
  asOf: string,
): Promise<ArAgingParty> {
  const party = await partyOf(tx, RECEIVABLES, customerId);
  if (party === null) throw notFound('Customer');
  const { documents, advances } = await partyRows(
    tx,
    RECEIVABLES,
    customerId,
    asOf,
    advanceRowSchema(AR_ADVANCE_KINDS),
  );
  return {
    asOf,
    party,
    totals: totalsOf(documents, advances, asOf),
    ledger: await ledgerBalance(tx, RECEIVABLES, asOf, { groupId: undefined, partyId: customerId }),
    documents: documents.map((row) => documentOf(row, asOf)),
    advances,
  };
}

export async function payablesOf(
  tx: Transaction,
  supplierId: string,
  asOf: string,
): Promise<ApAgingParty> {
  const party = await partyOf(tx, PAYABLES, supplierId);
  if (party === null) throw notFound('Supplier');
  const { documents, advances } = await partyRows(
    tx,
    PAYABLES,
    supplierId,
    asOf,
    advanceRowSchema(AP_ADVANCE_KINDS),
  );
  return {
    asOf,
    party,
    totals: totalsOf(documents, advances, asOf),
    ledger: await ledgerBalance(tx, PAYABLES, asOf, { groupId: undefined, partyId: supplierId }),
    documents: documents.map((row) => ({
      ...documentOf(row, asOf),
      supplierBillNumber: supplierBillNumber(row),
    })),
    advances,
  };
}
```

**The open documents** (`RECEIVABLES.documents`, decision 34):

- **Open on D = open now + applied after D.** `amount_paid` and `amount_credited` are the sums of all allocations
  (their triggers keep them), so adding back the ones with `applied_on > D` gives what was applied by D. The `later`
  step reads the allocations' `applied_on` index; the `WHERE` reads the open invoices' partial index (its condition is
  written the same way). An invoice paid in full before D is in neither and is never read.
- **A receipt dated after D always lands in `later`:** its allocations are dated on or after the receipt (the trigger
  of 0060). So the as-of answer never counts money from a receipt that did not exist on D.
- **`NULL::text AS supplier_bill_number`:** the two sides give the same columns, so one code reads both.

**The advances** (`RECEIVABLES.advances`, decision 35):

- **The amount is the receipt less what was applied by D, less what refunds of D or before gave back.** A refund voided
  after D still counted on D (`f.void_date > D`); one voided by D did not.
- **A receipt counts if it is dated by D and was not voided by D:** `status = 'posted' OR void_date > D`.
- **The last condition only chooses which receipts to read:** the ones with money unapplied now, the voided ones, and
  the ones with an allocation or a refund after D. Any other receipt was fully used by D and cannot have an advance on
  D. Without it, every receipt the workspace ever had would be read for every as-of question.
- **The credit notes follow the same rules,** with their refunds (`refunds.credit_note_id`). A credit note is posted
  for good, so it has no void.

**The payables** (`PAYABLES`):

- **Only a posted payment pays a bill.** A draft's or a pending payment's allocations are its plan (step 17c), and the
  bill's `amount_paid` leaves them out too, so `later` joins the payment and keeps the posted ones.
- **A payment counts as an advance only when posted,** or voided after D. A cancelled one never was in the books.

**The rows:**

- **`bucketSums()` is the contract's `agingBucketOf()` in SQL** (decision 22): `date − date` is a whole number of days
  in Postgres, so there is no time zone in it. Current is up to and on the due date; 30 days late is still 1–30.
  21b.4 checks the SQL and the contract on the same edge days.
- **`owed` and `held` are joined with `FULL JOIN`:** a customer with only an advance has a row, and one with only
  invoices too. A party with neither never gets into either, so it has no row (decision 22).
- **"Overdue only" is `due − current > 0`:** anything past its due date. The whole row still shows, current included.
- **The sort map is written out** (`satisfies Record<SortColumn<AgingSort>, SQL>`), with `r.` for the numbers, for the
  same reason as the sales report's `g.`.
- **The order ends with the name and the id,** for stable pages.
- **The ledger is `null` with "Overdue only"** (decision 22); otherwise the control account's balance at the end of D.

**`ledgerBalance()`** (decision 36):

- **The receivable's debit − credit, the payable's credit − debit:** the report's sense, so the page compares like
  with like.
- **Only posted entries dated by D.** With the group filter, the lines of that group's parties; on a party's page,
  that party's lines.
- **A workspace with no receivable account yet** (its chart job has not run) gets zero, not an error, like the
  dashboard.

**A party's page:**

- **`partyOf()` asks for a customer on the receivables and a supplier on the payables** (decision 37), and the caller
  says `not_found` otherwise.
- **The documents and advances are the report's own SQL, filtered to the party,** so the page adds up to the party's
  row. The dates are cast to text in SQL: the driver would turn a `date` into a `Date` at midnight UTC.
- **`totalsOf()` uses the contract's `agingAmountsOf()`,** the mock's function. The report's SQL and this must agree;
  21b.4 checks it.
- **`advanceRowSchema(kinds)`** parses the kind as the contract's enum, so `receipt` on the payables' page would fail
  the parse, not reach the page.
- **`supplierBillNumber()` throws on a bill with none:** the column is `NOT NULL` on a bill. It is nullable in the shared
  row only because an invoice has none, and an empty string would hide a broken row.

### Who may see what

```ts
import { isCostSort, type PermissionKey, type SalesReportSort } from '@omnivo/contracts';

import { AppError } from '../common/http/app-error.js';

// Who may read what in the step 21b reports, past the route's own permission

// The same answer the PermissionGuard gives (403 permission_missing, with the key), for a check the
// route cannot make: the guard knows one permission per route
export function missingPermission(permission: PermissionKey): AppError {
  return new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
    params: { permissions: permission },
  });
}

// Cost and margin need inventory.stock.value (decision 3). Without it the columns are null, and a
// sort by them is refused (decision 17): the order of the rows would tell what the hidden column
// says. The page never offers it; a hand-made URL or an export query does.
export function checkCostSort(sort: SalesReportSort, withCost: boolean): void {
  if (!withCost && isCostSort(sort)) throw missingPermission('inventory.stock.value');
}
```

- **`missingPermission()`** is the guard's own answer (403, `permission_missing`, the key in `params`), so the app shows
  the same words whether the route or the service refused.
- **`checkCostSort()`** is decision 17 for the page and for an export: a sort by the cost without
  `inventory.stock.value` is refused.

```ts
import type { PermissionKey } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// Whether a member holds a permission now, read from the database in the caller's transaction. For
// the worker (step 21b): a job runs for someone, without their request, and the worker has no
// permission cache (it does not import InfraModule, worker.module.ts). The same rules as
// PermissionService.loadFromDb(): a removed member holds nothing, the owner role holds every key,
// another role holds its own keys.
export async function holdsPermission(
  tx: Transaction,
  userId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const tenantId = getTenantId();
  const [row] = z.array(z.object({ held: z.boolean() })).parse(
    await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1
            FROM memberships m
            JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
                                    AND mr.deleted_at IS NULL
            JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.deleted_at IS NULL
           WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid
             AND m.deleted_at IS NULL
             AND (r.kind = 'owner' OR EXISTS (
                   SELECT 1 FROM role_permissions rp
                     JOIN permissions p ON p.id = rp.permission_id
                    WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                      AND rp.deleted_at IS NULL AND p.key = ${permission}))
        ) AS held`),
  );
  return row?.held ?? false;
}
```

- **For the worker** (decision 38). It has no Redis permission cache, so this reads the database in the job's own
  transaction.
- **The same rules as `PermissionService.loadFromDb()`:** a removed member, a removed role or a removed permission row
  gives nothing; the owner role holds every key. One `EXISTS` query answers yes or no.

### The service, the routes and the module

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  AgingReport,
  ApAgingFilter,
  ApAgingParty,
  ArAgingFilter,
  ArAgingParty,
  PurchaseReport,
  PurchaseReportFilter,
  SalesReport,
  SalesReportFilter,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { payablesAging, payablesOf, receivablesAging, receivablesOf } from './aging-queries.js';
import { checkCostSort } from './report-access.js';
import { reportPage } from './report-paging.js';
import { purchaseReport, salesReport } from './trade-report-queries.js';

// A page asks with its filters and a page (limit, cursor); an export uses the same queries with
// every row (export.handler.ts)
type Paged<F> = F & { limit: number; cursor?: string | undefined };

// The step 21b report pages: the sales and purchase reports and the two agings. The route checks
// the report's permission (sales.report.read or purchase.report.read); the cost columns check
// inventory.stock.value here. The queries live in trade-report-queries.ts and aging-queries.ts,
// where the worker's export finds them too.
@Injectable()
export class TradeReportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  async sales(query: Paged<SalesReportFilter>): Promise<SalesReport> {
    const access = await this.permissions.ofCurrentUser();
    const withCost = access.permissions.includes('inventory.stock.value');
    checkCostSort(query.sort, withCost);
    return this.withTenant((tx) => salesReport(tx, query, { withCost, page: reportPage(query) }));
  }

  purchases(query: Paged<PurchaseReportFilter>): Promise<PurchaseReport> {
    return this.withTenant((tx) => purchaseReport(tx, query, { page: reportPage(query) }));
  }

  receivables(query: Paged<ArAgingFilter>): Promise<AgingReport> {
    return this.withTenant((tx) => receivablesAging(tx, query, reportPage(query)));
  }

  receivablesOf(customerId: string, asOf: string): Promise<ArAgingParty> {
    return this.withTenant((tx) => receivablesOf(tx, customerId, asOf));
  }

  payables(query: Paged<ApAgingFilter>): Promise<AgingReport> {
    return this.withTenant((tx) => payablesAging(tx, query, reportPage(query)));
  }

  payablesOf(supplierId: string, asOf: string): Promise<ApAgingParty> {
    return this.withTenant((tx) => payablesOf(tx, supplierId, asOf));
  }
}
```

- **`Paged<F>`** is the filter plus `limit` and `cursor`: what the route's query schema gives after parsing. The filter
  part goes to the query; `reportPage()` reads the rest.
- **`sales()` reads the person's permissions once** (from the cache the guard just filled) for both the cost columns
  and the sort check.
- **Each method is one `withTenant` transaction:** the workspace is set once (row-level security) for the report's
  query, its books' line and the ledger.

```diff
@@ -5,8 +5,11 @@ import { Endpoint } from '../common/http/endpoint.js';
 import { FiscalYearsService } from './fiscal-years.service.js';
 import { ReportExportsService } from './report-exports.service.js';
 import { ReportsService } from './reports.service.js';
+import { TradeReportsService } from './trade-reports.service.js';
 
 type Reports = typeof routes.reports;
+type Trade = typeof routes.tradeReports;
+type Aging = typeof routes.aging;
 type Years = typeof routes.fiscalYears;
 type Exports = typeof routes.reportExports;
 
@@ -16,6 +19,7 @@ export class ReportsController {
     private readonly reports: ReportsService,
     private readonly years: FiscalYearsService,
     private readonly exports: ReportExportsService,
+    private readonly trade: TradeReportsService,
   ) {}
 
   @Endpoint(routes.reports.trialBalance)
@@ -39,6 +43,44 @@ export class ReportsController {
     return this.reports.balanceSheet(query);
   }
 
+  @Endpoint(routes.tradeReports.sales)
+  sales({ query }: RouteInput<Trade['sales']>): Promise<RouteResponse<Trade['sales']>> {
+    return this.trade.sales(query);
+  }
+
+  @Endpoint(routes.tradeReports.purchases)
+  purchases({ query }: RouteInput<Trade['purchases']>): Promise<RouteResponse<Trade['purchases']>> {
+    return this.trade.purchases(query);
+  }
+
+  @Endpoint(routes.aging.receivables)
+  receivables({
+    query,
+  }: RouteInput<Aging['receivables']>): Promise<RouteResponse<Aging['receivables']>> {
+    return this.trade.receivables(query);
+  }
+
+  @Endpoint(routes.aging.receivablesOf)
+  receivablesOf({
+    params,
+    query,
+  }: RouteInput<Aging['receivablesOf']>): Promise<RouteResponse<Aging['receivablesOf']>> {
+    return this.trade.receivablesOf(params.customerId, query.asOf);
+  }
+
+  @Endpoint(routes.aging.payables)
+  payables({ query }: RouteInput<Aging['payables']>): Promise<RouteResponse<Aging['payables']>> {
+    return this.trade.payables(query);
+  }
+
+  @Endpoint(routes.aging.payablesOf)
+  payablesOf({
+    params,
+    query,
+  }: RouteInput<Aging['payablesOf']>): Promise<RouteResponse<Aging['payablesOf']>> {
+    return this.trade.payablesOf(params.supplierId, query.asOf);
+  }
+
   @Endpoint(routes.fiscalYears.list)
   listYears(): Promise<RouteResponse<Years['list']>> {
     return this.years.list();
```

- **Six thin endpoints** in the reports controller: every `/reports/…` route is in one place. `@Endpoint()` takes the
  route from the contract, so the permission guard and the schemas come with it.

```diff
@@ -1,16 +1,20 @@
 import { Module } from '@nestjs/common';
 
 import { JournalModule } from '../journal/journal.module.js';
+import { RbacModule } from '../rbac/rbac.module.js';
 import { FiscalYearsService } from './fiscal-years.service.js';
 import { ReportExportsService } from './report-exports.service.js';
 import { ReportsController } from './reports.controller.js';
 import { ReportsService } from './reports.service.js';
+import { TradeReportsService } from './trade-reports.service.js';
 
-// The financial statements, the year-end close and the exports. JournalModule gives
-// PostingService: the closing entry goes into the books the same way as every other entry.
+// The financial statements, the year-end close and the exports; since step 21b the sales and
+// purchase reports and the agings. JournalModule gives PostingService: the closing entry goes into
+// the books the same way as every other entry. RbacModule gives PermissionService: the cost columns
+// and each kind of export check their own permission.
 @Module({
-  imports: [JournalModule],
+  imports: [JournalModule, RbacModule],
   controllers: [ReportsController],
-  providers: [ReportsService, FiscalYearsService, ReportExportsService],
+  providers: [ReportsService, FiscalYearsService, ReportExportsService, TradeReportsService],
 })
 export class ReportsModule {}
```

- **`RbacModule`** gives `PermissionService` to the new service and to the exports.

### Exports

```diff
@@ -1,7 +1,12 @@
 import { Inject, Injectable } from '@nestjs/common';
-import type { ReportExport, ReportExportInput } from '@omnivo/contracts';
+import {
+  REPORT_KIND_PERMISSIONS,
+  type ReportExport,
+  type ReportExportInput,
+  reportKindsFor,
+} from '@omnivo/contracts';
 import { reportExports } from '@omnivo/db';
-import { and, desc, eq, lt } from 'drizzle-orm';
+import { and, desc, eq, inArray, lt } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { AppError, notFound } from '../common/http/app-error.js';
@@ -10,7 +15,9 @@ import { decodeCursor, toPage } from '../common/pagination/cursor.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
+import { PermissionService } from '../rbac/permission.service.js';
 import { type SignedUrl, StorageService } from '../storage/storage.service.js';
+import { checkCostSort, missingPermission } from './report-access.js';
 
 type ExportRow = typeof reportExports.$inferSelect;
 
@@ -38,15 +45,25 @@ function storedQuery(query: Record<string, string | undefined>): Record<string,
 const cursorSchema = z.tuple([z.uuid()]);
 
 // The API's half of an export: the row and the outbox event. The worker writes the file
-// (export.handler.ts) and tells the person through the bell.
+// (export.handler.ts) and tells the person through the bell. Since step 21b each kind has its own
+// permission (decision 14): the routes only ask for a signed-in person, and every method here
+// checks the kind's permission, now, not when the export was made.
 @Injectable()
 export class ReportExportsService {
   constructor(
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
     private readonly storage: StorageService,
+    private readonly permissions: PermissionService,
   ) {}
 
-  create(input: ReportExportInput): Promise<ReportExport> {
+  async create(input: ReportExportInput): Promise<ReportExport> {
+    const access = await this.permissions.ofCurrentUser();
+    const permission = REPORT_KIND_PERMISSIONS[input.report];
+    if (!access.permissions.includes(permission)) throw missingPermission(permission);
+    // The same rule as the page: a file sorted by the cost would tell it (decision 17)
+    if (input.report === 'sales_report') {
+      checkCostSort(input.query.sort, access.permissions.includes('inventory.stock.value'));
+    }
     return this.withTenant(async (tx) => {
       const [row] = await tx
         .insert(reportExports)
@@ -65,8 +82,11 @@ export class ReportExportsService {
     });
   }
 
-  list(query: { limit: number; cursor?: string | undefined }) {
+  // The person's own exports of the kinds they may read today: a file of a report they lost is not
+  // listed (and not downloaded, below)
+  async list(query: { limit: number; cursor?: string | undefined }) {
     const after = decodeCursor(query.cursor, cursorSchema);
+    const kinds = reportKindsFor((await this.permissions.ofCurrentUser()).permissions);
     return this.withTenant(async (tx) => {
       const rows = await tx
         .select()
@@ -75,6 +95,8 @@ export class ReportExportsService {
           and(
             eq(reportExports.tenantId, getTenantId()),
             eq(reportExports.requestedBy, currentPrincipal().userId),
+            // Drizzle writes an empty list as false: no kind, no row
+            inArray(reportExports.report, kinds),
             after === undefined ? undefined : lt(reportExports.id, after[0]),
           ),
         )
@@ -85,7 +107,8 @@ export class ReportExportsService {
     });
   }
 
-  download(id: string): Promise<SignedUrl> {
+  async download(id: string): Promise<SignedUrl> {
+    const access = await this.permissions.ofCurrentUser();
     return this.withTenant(async (tx) => {
       // Someone else's export is "not found", like another tenant's row
       const [row] = await tx
@@ -99,6 +122,8 @@ export class ReportExportsService {
           ),
         );
       if (!row) throw notFound('Report export');
+      const permission = REPORT_KIND_PERMISSIONS[row.report];
+      if (!access.permissions.includes(permission)) throw missingPermission(permission);
       // The check constraint makes these four present whenever the status is 'ready'
       if (
         row.status !== 'ready' ||
```

- **Create checks the kind's permission** (decision 14), and for a sales report the cost sort too: a file sorted by the
  cost would tell it.
- **The list keeps only the kinds the person may read now** (`reportKindsFor()`). `inArray()` with an empty list is
  `false` in Drizzle, so a person with no report permission sees an empty list, not an error.
- **Download checks the permission of the export's kind, after the "not found" check:** someone else's export stays
  "not found" (it tells nothing), and your own export of a report you lost is refused (decision 40).

```diff
@@ -1,11 +1,24 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  apAgingFilterSchema,
+  arAgingFilterSchema,
   balanceSheetQuerySchema,
   type ExportFormat,
   profitAndLossQuerySchema,
+  purchaseReportFilterSchema,
+  salesReportFilterSchema,
   trialBalanceQuerySchema,
 } from '@omnivo/contracts';
-import { branches, reportExports, tenants, tenantSettings, users } from '@omnivo/db';
+import {
+  branches,
+  customerGroups,
+  productCategories,
+  reportExports,
+  supplierGroups,
+  tenants,
+  tenantSettings,
+  users,
+} from '@omnivo/db';
 import { and, eq } from 'drizzle-orm';
 import type { z } from 'zod';
 
@@ -14,7 +27,9 @@ import { getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { notify } from '../notifications/notify.js';
+import { holdsPermission } from '../rbac/holds-permission.js';
 import { StorageService } from '../storage/storage.service.js';
+import { payablesAging, receivablesAging } from './aging-queries.js';
 import {
   buildDocument,
   type DocumentContext,
@@ -24,6 +39,7 @@ import {
 import { writePdf } from './export/pdf.js';
 import { writeXlsx } from './export/xlsx.js';
 import { balanceSheet, profitAndLoss, trialBalance } from './report-queries.js';
+import { purchaseReport, salesReport } from './trade-report-queries.js';
 
 const CONTENT_TYPES = {
   xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
@@ -55,9 +71,97 @@ async function reportData(tx: Transaction, row: ExportRow): Promise<ReportData>
       const query = queryOf(balanceSheetQuerySchema, row);
       return { report: row.report, query, data: await balanceSheet(tx, query) };
     }
+    // Step 21b: every row (no page), in the page's order (decision 20)
+    case 'sales_report': {
+      const query = queryOf(salesReportFilterSchema, row);
+      // The cost columns as the person may see them when the file is made, not when it was asked
+      // for. The API refused a cost sort without the permission; if it was lost since, the file is
+      // sorted by the net instead, since the order of the rows would tell the cost (decision 17).
+      const withCost = await holdsPermission(tx, row.requestedBy, 'inventory.stock.value');
+      const data = await salesReport(tx, withCost ? query : { ...query, sort: '-net' }, {
+        withCost,
+        page: null,
+      });
+      return { report: row.report, query, data };
+    }
+    case 'purchase_report': {
+      const query = queryOf(purchaseReportFilterSchema, row);
+      return { report: row.report, query, data: await purchaseReport(tx, query, { page: null }) };
+    }
+    case 'ar_aging': {
+      const query = queryOf(arAgingFilterSchema, row);
+      return { report: row.report, query, data: await receivablesAging(tx, query, null) };
+    }
+    case 'ap_aging': {
+      const query = queryOf(apAgingFilterSchema, row);
+      return { report: row.report, query, data: await payablesAging(tx, query, null) };
+    }
   }
 }
 
+// The names the file's heading prints for the query's filters. Read by the export's own tenant:
+// an id of another workspace finds nothing (row-level security), and the line is left out.
+async function filterNames(tx: Transaction, report: ReportData) {
+  const tenantId = getTenantId();
+  const ids = {
+    branchId:
+      report.report === 'profit_and_loss' ||
+      report.report === 'sales_report' ||
+      report.report === 'purchase_report'
+        ? report.query.branchId
+        : undefined,
+    customerGroupId:
+      report.report === 'sales_report' || report.report === 'ar_aging'
+        ? report.query.customerGroupId
+        : undefined,
+    supplierGroupId:
+      report.report === 'purchase_report' || report.report === 'ap_aging'
+        ? report.query.supplierGroupId
+        : undefined,
+    categoryId:
+      report.report === 'sales_report' || report.report === 'purchase_report'
+        ? report.query.categoryId
+        : undefined,
+  };
+  const [[branch], [customerGroup], [supplierGroup], [category]] = await Promise.all([
+    ids.branchId === undefined
+      ? []
+      : tx
+          .select({ name: branches.name })
+          .from(branches)
+          .where(and(eq(branches.tenantId, tenantId), eq(branches.id, ids.branchId))),
+    ids.customerGroupId === undefined
+      ? []
+      : tx
+          .select({ name: customerGroups.name })
+          .from(customerGroups)
+          .where(
+            and(eq(customerGroups.tenantId, tenantId), eq(customerGroups.id, ids.customerGroupId)),
+          ),
+    ids.supplierGroupId === undefined
+      ? []
+      : tx
+          .select({ name: supplierGroups.name })
+          .from(supplierGroups)
+          .where(
+            and(eq(supplierGroups.tenantId, tenantId), eq(supplierGroups.id, ids.supplierGroupId)),
+          ),
+    ids.categoryId === undefined
+      ? []
+      : tx
+          .select({ name: productCategories.name })
+          .from(productCategories)
+          .where(
+            and(eq(productCategories.tenantId, tenantId), eq(productCategories.id, ids.categoryId)),
+          ),
+  ]);
+  return {
+    branchName: branch?.name ?? null,
+    groupName: customerGroup?.name ?? supplierGroup?.name ?? null,
+    categoryName: category?.name ?? null,
+  };
+}
+
 // Writes the file of one report_exports row (step 11). Idempotent like every handler: a finished
 // row is left alone, the file's key is fixed by the row's id (a second run overwrites the same
 // object), and the notification is keyed by the event.
@@ -100,20 +204,12 @@ export class ReportExportHandler implements EventHandler<'report.export_requeste
         .from(users)
         .where(eq(users.id, row.requestedBy));
       const report = await reportData(tx, row);
-      const branchId = report.report === 'profit_and_loss' ? report.query.branchId : undefined;
-      const [branch] =
-        branchId === undefined
-          ? []
-          : await tx
-              .select({ name: branches.name })
-              .from(branches)
-              .where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)));
       const documentContext: DocumentContext = {
         language: user?.language ?? 'en',
         company: context.company,
         currency: context.currency,
         timeZone: context.timeZone,
-        branchName: branch?.name ?? null,
+        ...(await filterNames(tx, report)),
         madeAt: new Date(),
       };
       return { row, report, documentContext };
```

- **Each new kind parses its stored query with the filter schema,** like the statements: a row changed by hand cannot
  feed the query anything the page could not.
- **Every row** (`page: null`), in the page's order.
- **The cost by `holdsPermission()` when the file is made** (decision 38). If the person lost it, the sort falls back to
  the net, so the order does not tell the hidden cost.
- **`filterNames()` reads the names of the branch, group and category** the file's heading prints. The branch was
  already read for the profit and loss; now it is one function for every kind. The queries run in the job's tenant,
  so another workspace's id finds nothing and the line is left out.

```diff
@@ -1,6 +1,11 @@
 import {
   absMoney,
   addMoney,
+  AGING_BUCKETS,
+  type AgingAmounts,
+  type AgingReport,
+  type ApAgingFilter,
+  type ArAgingFilter,
   type BalanceSheet,
   type BalanceSheetQuery,
   isNegativeMoney,
@@ -8,25 +13,37 @@ import {
   type LanguageCode,
   type ProfitAndLoss,
   type ProfitAndLossQuery,
+  type PurchaseReport,
+  type PurchaseReportFilter,
+  type PurchaseReportRow,
   type ReportKind,
   type ReportSection,
+  type SalesReport,
+  type SalesReportFilter,
+  type SalesReportRow,
   type TrialBalance,
   type TrialBalanceQuery,
 } from '@omnivo/contracts';
 
 import { COPY, type Copy } from './copy.js';
-import { formatIsoDate, formatMoment } from './format.js';
+import { formatAmount, formatIsoDate, formatMoment, formatMonth, formatNumber } from './format.js';
 
 // One report as a plain table: the Excel and the PDF writer both draw this, so the two files
 // always hold the same rows in the same order. Amounts stay decimal strings here; each writer
 // decides how a cell shows them.
 
+// number (step 21b): a quantity or a percent, already written out ("72 pcs", "22.5%"), right-aligned
+// like an amount but never added up in Excel
 export type DocCell =
-  { kind: 'text'; text: string } | { kind: 'money'; amount: string } | { kind: 'empty' };
+  | { kind: 'text'; text: string }
+  | { kind: 'money'; amount: string }
+  | { kind: 'number'; text: string }
+  | { kind: 'empty' };
 
 export interface DocColumn {
   header: string;
-  kind: 'text' | 'money';
+  // money and number are right-aligned
+  kind: 'text' | 'money' | 'number';
   // Relative width: characters in Excel, a share of the line in the PDF
   width: number;
 }
@@ -57,14 +74,23 @@ export interface ReportDocument {
 export type ReportData =
   | { report: 'trial_balance'; query: TrialBalanceQuery; data: TrialBalance }
   | { report: 'profit_and_loss'; query: ProfitAndLossQuery; data: ProfitAndLoss }
-  | { report: 'balance_sheet'; query: BalanceSheetQuery; data: BalanceSheet };
+  | { report: 'balance_sheet'; query: BalanceSheetQuery; data: BalanceSheet }
+  | { report: 'sales_report'; query: SalesReportFilter; data: SalesReport }
+  | { report: 'purchase_report'; query: PurchaseReportFilter; data: PurchaseReport }
+  | { report: 'ar_aging'; query: ArAgingFilter; data: AgingReport }
+  | { report: 'ap_aging'; query: ApAgingFilter; data: AgingReport };
 
+// The names of what the query filters by, read by the handler: a file says "Branch: Sylhet depot",
+// never an id
 export interface DocumentContext {
   language: LanguageCode;
   company: string;
   currency: string;
   timeZone: string;
   branchName: string | null;
+  // Step 21b: the customer or supplier group, and the product category
+  groupName: string | null;
+  categoryName: string | null;
   madeAt: Date;
 }
 
@@ -260,20 +286,252 @@ function balanceSheetDocument(
   };
 }
 
+// ---------------------------------------------------------------------------------------------
+// Step 21b: the sales and purchase reports and the agings. Each is one row per item and a totals
+// row; the amounts keep their paisa, like the statements.
+
+type Body = Pick<ReportDocument, 'columns' | 'rows' | 'landscape' | 'lines'>;
+
+// What the first cell of a row says: "C-00042 Sylhet Pharmacy" (the code first, like an account),
+// "October 2026", or the words for a row that is not an item
+function rowName(
+  row: SalesReportRow | PurchaseReportRow,
+  copy: Copy,
+  language: LanguageCode,
+): string {
+  if (row.kind !== 'item') return copy.rowKinds[row.kind];
+  if (row.month !== null) return formatMonth(row.month, language);
+  const name = row.name ?? '';
+  return row.code === null ? name : `${row.code} ${name}`;
+}
+
+// "72 pcs", with the unit's decimals and in the file's digits
+function quantityCell(row: SalesReportRow | PurchaseReportRow, language: LanguageCode): DocCell {
+  if (row.quantity === null || row.baseUnit === null) return empty;
+  return {
+    kind: 'number',
+    text: `${formatNumber(row.quantity, row.baseUnit.decimals, language)} ${row.baseUnit.code}`,
+  };
+}
+
+function percentCell(percent: string | null, language: LanguageCode): DocCell {
+  return percent === null
+    ? empty
+    : { kind: 'number', text: `${formatNumber(percent, 1, language)}%` };
+}
+
+// The lines under the title that the two trade reports share: the period, then each filter
+function tradeLines(
+  query: { from: string; to: string; branchId?: string | undefined },
+  group: string,
+  context: DocumentContext,
+  copy: Copy,
+  groupLine: (name: string) => string,
+): string[] {
+  const date = (iso: string) => formatIsoDate(iso, context.language);
+  return [
+    copy.range(date(query.from), date(query.to)),
+    copy.groupedBy(group),
+    ...(context.branchName === null ? [] : [copy.branch(context.branchName)]),
+    ...(context.groupName === null ? [] : [groupLine(context.groupName)]),
+    ...(context.categoryName === null ? [] : [copy.category(context.categoryName)]),
+  ];
+}
+
+function salesDocument(
+  query: SalesReportFilter,
+  data: SalesReport,
+  copy: Copy,
+  context: DocumentContext,
+): Body {
+  const { language } = context;
+  const byProduct = query.groupBy === 'product';
+  const cost = data.withCost;
+  const costCells = (amounts: {
+    cost: string | null;
+    margin: string | null;
+    marginPercent: string | null;
+  }) =>
+    cost
+      ? [
+          money(amounts.cost ?? '0'),
+          money(amounts.margin ?? '0'),
+          percentCell(amounts.marginPercent, language),
+        ]
+      : [];
+  return {
+    landscape: cost || byProduct,
+    lines: [
+      ...tradeLines(query, copy.groups[query.groupBy], context, copy, copy.customerGroup),
+      // The books' sales of the same period, to compare with the total (decision 2)
+      ...(data.books === null ? [] : [copy.inBooks(formatAmount(data.books, language))]),
+    ],
+    columns: [
+      { header: copy.groups[query.groupBy], kind: 'text', width: 40 },
+      ...(byProduct ? [{ header: copy.quantity, kind: 'number' as const, width: 16 }] : []),
+      { header: copy.sales.gross, kind: 'money', width: 18 },
+      { header: copy.sales.returns, kind: 'money', width: 16 },
+      { header: copy.sales.net, kind: 'money', width: 18 },
+      ...(cost
+        ? [
+            { header: copy.sales.cost, kind: 'money' as const, width: 18 },
+            { header: copy.sales.margin, kind: 'money' as const, width: 18 },
+            { header: copy.sales.marginPercent, kind: 'number' as const, width: 12 },
+          ]
+        : []),
+    ],
+    rows: [
+      ...data.items.map((row): DocRow => ({
+        style: 'normal',
+        indent: 0,
+        cells: [
+          text(rowName(row, copy, language)),
+          ...(byProduct ? [quantityCell(row, language)] : []),
+          money(row.gross),
+          money(row.returns),
+          money(row.net),
+          ...costCells(row),
+        ],
+      })),
+      {
+        style: 'grand',
+        indent: 0,
+        cells: [
+          text(copy.total),
+          // Quantities of different products do not add up
+          ...(byProduct ? [empty] : []),
+          money(data.totals.gross),
+          money(data.totals.returns),
+          money(data.totals.net),
+          ...costCells(data.totals),
+        ],
+      },
+    ],
+  };
+}
+
+function purchaseDocument(
+  query: PurchaseReportFilter,
+  data: PurchaseReport,
+  copy: Copy,
+  context: DocumentContext,
+): Body {
+  const { language } = context;
+  const byProduct = query.groupBy === 'product';
+  return {
+    landscape: false,
+    lines: tradeLines(query, copy.groups[query.groupBy], context, copy, copy.supplierGroup),
+    columns: [
+      { header: copy.groups[query.groupBy], kind: 'text', width: 40 },
+      ...(byProduct ? [{ header: copy.quantity, kind: 'number' as const, width: 16 }] : []),
+      { header: copy.purchases.gross, kind: 'money', width: 18 },
+      { header: copy.purchases.returns, kind: 'money', width: 16 },
+      { header: copy.purchases.net, kind: 'money', width: 18 },
+    ],
+    rows: [
+      ...data.items.map((row): DocRow => ({
+        style: 'normal',
+        indent: 0,
+        cells: [
+          text(rowName(row, copy, language)),
+          ...(byProduct ? [quantityCell(row, language)] : []),
+          money(row.gross),
+          money(row.returns),
+          money(row.net),
+        ],
+      })),
+      {
+        style: 'grand',
+        indent: 0,
+        cells: [
+          text(copy.total),
+          ...(byProduct ? [empty] : []),
+          money(data.totals.gross),
+          money(data.totals.returns),
+          money(data.totals.net),
+        ],
+      },
+    ],
+  };
+}
+
+// The five buckets, then what is due, the advances and the balance: the page's columns
+function agingCells(amounts: AgingAmounts): DocCell[] {
+  return [
+    ...AGING_BUCKETS.map((bucket) => money(amounts[bucket])),
+    money(amounts.due),
+    money(amounts.advances),
+    money(amounts.balance),
+  ];
+}
+
+function agingDocument(
+  query: ArAgingFilter | ApAgingFilter,
+  data: AgingReport,
+  party: 'customer' | 'supplier',
+  copy: Copy,
+  context: DocumentContext,
+): Body {
+  const { language } = context;
+  const groupLine = party === 'customer' ? copy.customerGroup : copy.supplierGroup;
+  return {
+    landscape: true,
+    lines: [
+      copy.asOf(formatIsoDate(query.asOf, language)),
+      ...(context.groupName === null ? [] : [groupLine(context.groupName)]),
+      ...(query.show === 'overdue' ? [copy.overdueOnly] : []),
+      ...(data.ledger === null ? [] : [copy.inBooks(formatAmount(data.ledger, language))]),
+    ],
+    columns: [
+      { header: copy.groups[party], kind: 'text', width: 34 },
+      ...AGING_BUCKETS.map((bucket): DocColumn => ({
+        header: copy.buckets[bucket],
+        kind: 'money',
+        width: 15,
+      })),
+      { header: copy.due, kind: 'money', width: 16 },
+      { header: copy.advances, kind: 'money', width: 15 },
+      { header: copy.balance, kind: 'money', width: 16 },
+    ],
+    rows: [
+      ...data.items.map((row): DocRow => ({
+        style: 'normal',
+        indent: 0,
+        cells: [text(`${row.party.code} ${row.party.name}`), ...agingCells(row)],
+      })),
+      { style: 'grand', indent: 0, cells: [text(copy.total), ...agingCells(data.totals)] },
+    ],
+  };
+}
+
+function bodyOf(report: ReportData, copy: Copy, context: DocumentContext): Body {
+  switch (report.report) {
+    case 'trial_balance':
+      return trialBalanceDocument(report.query, report.data, copy, context.language);
+    case 'profit_and_loss':
+      return profitAndLossDocument(
+        report.query,
+        report.data,
+        copy,
+        context.language,
+        context.branchName,
+      );
+    case 'balance_sheet':
+      return balanceSheetDocument(report.query, report.data, copy, context.language);
+    case 'sales_report':
+      return salesDocument(report.query, report.data, copy, context);
+    case 'purchase_report':
+      return purchaseDocument(report.query, report.data, copy, context);
+    case 'ar_aging':
+      return agingDocument(report.query, report.data, 'customer', copy, context);
+    case 'ap_aging':
+      return agingDocument(report.query, report.data, 'supplier', copy, context);
+  }
+}
+
 export function buildDocument(report: ReportData, context: DocumentContext): ReportDocument {
   const copy: Copy = COPY[context.language];
-  const body =
-    report.report === 'trial_balance'
-      ? trialBalanceDocument(report.query, report.data, copy, context.language)
-      : report.report === 'profit_and_loss'
-        ? profitAndLossDocument(
-            report.query,
-            report.data,
-            copy,
-            context.language,
-            context.branchName,
-          )
-        : balanceSheetDocument(report.query, report.data, copy, context.language);
+  const body = bodyOf(report, copy, context);
   return {
     language: context.language,
     company: context.company,
@@ -296,10 +554,13 @@ export function fileStem(report: ReportData): string {
     trial_balance: 'trial-balance',
     profit_and_loss: 'profit-and-loss',
     balance_sheet: 'balance-sheet',
+    sales_report: 'sales',
+    purchase_report: 'purchases',
+    ar_aging: 'receivables-aging',
+    ap_aging: 'payables-aging',
   };
+  // A picture of one day has its date, a period its two
   const dates =
-    report.report === 'balance_sheet'
-      ? report.query.asOf
-      : `${report.query.from}-to-${report.query.to}`;
+    'asOf' in report.query ? report.query.asOf : `${report.query.from}-to-${report.query.to}`;
   return `${name[report.report]}-${dates}`;
 }
```

- **A `number` cell** (decision 41) for "72 pcs" and "16.4%".
- **`ReportData` gets the four kinds** with their filter types, and the context the group and category names.
- **`rowName()`** writes the code first, like an account ("C-00042 Karim Store"), a month as "October 2026", and the
  words for a row that is not an item.
- **The sales file is landscape with the cost or the product's quantity:** six or more columns do not fit a portrait
  A4 page at a readable size.
- **The books' line is a line under the title** ("In the books: 9,460.00"), next to the period, for the reader to
  compare with the total.
- **The totals row has no quantity:** quantities of different products do not add up.
- **The aging file has the nine columns of the page,** always landscape.
- **`bodyOf()` is a `switch` over the seven kinds:** without a `default`, a kind added to the contract fails the type
  check here ("Function lacks ending return statement"), the same check that found 21b.1's kinds in the handler.
- **`fileStem()`** names a picture of one day by its date and a period by its two: `sales-2026-09-06-to-2026-11-05`,
  `receivables-aging-2026-11-05`. `'asOf' in report.query` tells them apart without listing the kinds.

```diff
@@ -1,4 +1,12 @@
-import type { AccountType, LanguageCode, ReportKind } from '@omnivo/contracts';
+import type {
+  AccountType,
+  AgingBucket,
+  LanguageCode,
+  PurchaseReportGroup,
+  ReportKind,
+  SalesReportGroup,
+  TradeReportRowKind,
+} from '@omnivo/contracts';
 
 // Every word inside an exported file, in both languages side by side. satisfies: a text missing in
 // one language does not compile. Common office terms (ledger, balance) stay as people say them,
@@ -27,6 +35,31 @@ export interface Copy {
   page: (page: string, pages: string) => string;
   // The date column headers of a comparison: "1 Jul 2026 – 30 Sep 2026"
   column: (from: string, to: string) => string;
+  // Step 21b. The first column's header: what a row is
+  groups: Record<SalesReportGroup | PurchaseReportGroup, string>;
+  // The name of a row that stands for the lines with no such thing (TRADE_REPORT_ROW_KINDS)
+  rowKinds: Record<Exclude<TradeReportRowKind, 'item'>, string>;
+  quantity: string;
+  sales: {
+    gross: string;
+    returns: string;
+    net: string;
+    cost: string;
+    margin: string;
+    marginPercent: string;
+  };
+  purchases: { gross: string; returns: string; net: string };
+  buckets: Record<AgingBucket, string>;
+  due: string;
+  advances: string;
+  balance: string;
+  groupedBy: (group: string) => string;
+  customerGroup: (name: string) => string;
+  supplierGroup: (name: string) => string;
+  category: (name: string) => string;
+  overdueOnly: string;
+  // The books' figure under the heading, for the reader to compare with the total
+  inBooks: (amount: string) => string;
 }
 
 export const COPY = {
@@ -35,6 +68,10 @@ export const COPY = {
       trial_balance: 'Trial balance',
       profit_and_loss: 'Profit and loss',
       balance_sheet: 'Balance sheet',
+      sales_report: 'Sales report',
+      purchase_report: 'Purchase report',
+      ar_aging: 'Receivables aging',
+      ap_aging: 'Payables aging',
     },
     sections: {
       asset: 'Assets',
@@ -69,12 +106,57 @@ export const COPY = {
     generated: (moment) => `Made on ${moment}`,
     page: (page, pages) => `Page ${page} of ${pages}`,
     column: (from, to) => `${from} – ${to}`,
+    groups: {
+      customer: 'Customer',
+      product: 'Product',
+      category: 'Category',
+      branch: 'Branch',
+      month: 'Month',
+      supplier: 'Supplier',
+      account: 'Expense account',
+    },
+    rowKinds: {
+      walk_in: 'Walk-in customers',
+      no_category: 'No category',
+      expenses: 'Expenses',
+      products: 'Products',
+    },
+    quantity: 'Quantity',
+    sales: {
+      gross: 'Sold',
+      returns: 'Returns',
+      net: 'Net sales',
+      cost: 'Cost',
+      margin: 'Margin',
+      marginPercent: 'Margin %',
+    },
+    purchases: { gross: 'Billed', returns: 'Debit notes', net: 'Net purchases' },
+    buckets: {
+      current: 'Current',
+      days1To30: '1–30 days',
+      days31To60: '31–60 days',
+      days61To90: '61–90 days',
+      over90: 'Over 90 days',
+    },
+    due: 'Total due',
+    advances: 'Advances',
+    balance: 'Balance',
+    groupedBy: (group) => `By ${group.toLowerCase()}`,
+    customerGroup: (name) => `Customer group: ${name}`,
+    supplierGroup: (name) => `Supplier group: ${name}`,
+    category: (name) => `Category: ${name}`,
+    overdueOnly: 'Overdue only',
+    inBooks: (amount) => `In the books: ${amount}`,
   },
   bn: {
     titles: {
       trial_balance: 'ট্রায়াল ব্যালান্স',
       profit_and_loss: 'লাভ-ক্ষতির হিসাব',
       balance_sheet: 'ব্যালান্স শিট',
+      sales_report: 'বিক্রির রিপোর্ট',
+      purchase_report: 'কেনাকাটার রিপোর্ট',
+      ar_aging: 'পাওনার এজিং',
+      ap_aging: 'দেনার এজিং',
     },
     sections: {
       asset: 'সম্পদ',
@@ -109,5 +191,46 @@ export const COPY = {
     generated: (moment) => `তৈরি: ${moment}`,
     page: (page, pages) => `পৃষ্ঠা ${page} / ${pages}`,
     column: (from, to) => `${from} – ${to}`,
+    groups: {
+      customer: 'গ্রাহক',
+      product: 'প্রোডাক্ট',
+      category: 'ক্যাটাগরি',
+      branch: 'ব্রাঞ্চ',
+      month: 'মাস',
+      supplier: 'সাপ্লায়ার',
+      account: 'খরচের অ্যাকাউন্ট',
+    },
+    rowKinds: {
+      walk_in: 'ওয়াক-ইন গ্রাহক',
+      no_category: 'কোনো ক্যাটাগরি নেই',
+      expenses: 'খরচ',
+      products: 'প্রোডাক্ট',
+    },
+    quantity: 'পরিমাণ',
+    sales: {
+      gross: 'বিক্রি',
+      returns: 'ফেরত',
+      net: 'নিট বিক্রি',
+      cost: 'খরচ',
+      margin: 'মার্জিন',
+      marginPercent: 'মার্জিন %',
+    },
+    purchases: { gross: 'বিল', returns: 'ডেবিট নোট', net: 'নিট কেনাকাটা' },
+    buckets: {
+      current: 'সময় পার হয়নি',
+      days1To30: '১–৩০ দিন',
+      days31To60: '৩১–৬০ দিন',
+      days61To90: '৬১–৯০ দিন',
+      over90: '৯০ দিনের বেশি',
+    },
+    due: 'মোট বকেয়া',
+    advances: 'অগ্রিম',
+    balance: 'ব্যালান্স',
+    groupedBy: (group) => `${group} অনুযায়ী`,
+    customerGroup: (name) => `গ্রাহক গ্রুপ: ${name}`,
+    supplierGroup: (name) => `সাপ্লায়ার গ্রুপ: ${name}`,
+    category: (name) => `ক্যাটাগরি: ${name}`,
+    overdueOnly: 'শুধু সময় পার',
+    inBooks: (amount) => `হিসাবের খাতায়: ${amount}`,
   },
 } satisfies Record<LanguageCode, Copy>;
```

- **Every word in both languages,** with `satisfies Record<LanguageCode, Copy>`: a word missing in Bangla does not
  compile. The words follow the app's (`ওয়াক-ইন গ্রাহক`, `কোনো ক্যাটাগরি নেই`, `ডেবিট নোট`, `প্রোডাক্ট`,
  `সময় পার`). The diff shows them as 21b.5 left them (decision 43).

```diff
@@ -85,3 +85,14 @@ export function formatMoment(moment: Date, language: LanguageCode, timeZone: str
     language === 'bn' ? `${part('day')} ${part('month')},` : `${part('day')} ${part('month')}`;
   return `${day} ${part('year')}, ${part('hour')}:${part('minute')}`;
 }
+
+const MONTH = {
+  en: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
+  bn: new Intl.DateTimeFormat('bn-BD', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
+} satisfies Record<LanguageCode, Intl.DateTimeFormat>;
+
+// Step 21b: a month row of the sales or purchase report, "2026-10" → "October 2026" /
+// "অক্টোবর ২০২৬", on the 1st in UTC like formatIsoDate()
+export function formatMonth(month: string, language: LanguageCode): string {
+  return MONTH[language].format(new Date(`${month}-01T00:00:00Z`));
+}
```

- **`formatMonth()`** reads the month as the 1st in UTC and writes it in UTC, like `formatIsoDate()`: the server's
  own time zone can never move it to the month before.

```diff
@@ -18,7 +18,7 @@ const INDENT = 10;
 
 function cellText(cell: DocCell, language: ReportDocument['language']): string {
   if (cell.kind === 'money') return formatAmount(cell.amount, language);
-  return cell.kind === 'text' ? cell.text : '';
+  return cell.kind === 'empty' ? '' : cell.text;
 }
 
 const BOLD = new Set<DocRow['style']>(['group', 'heading', 'total', 'grand']);
@@ -68,7 +68,7 @@ export function writePdf(doc: ReportDocument): Promise<Buffer> {
         size: 7.5,
         bold: true,
         color: INK_3,
-        align: column.kind === 'money' ? 'right' : 'left',
+        align: column.kind === 'text' ? 'left' : 'right',
         width: place.width - (index === 0 ? 6 : 0),
       });
     });
@@ -101,7 +101,7 @@ export function writePdf(doc: ReportDocument): Promise<Buffer> {
         size: row.style === 'grand' ? 9 : FONT_SIZE,
         bold,
         color: row.style === 'heading' ? INK_3 : INK,
-        align: column.kind === 'money' ? 'right' : 'left',
+        align: column.kind === 'text' ? 'left' : 'right',
         width: place.width - indent,
       });
     });
```

```diff
@@ -33,6 +33,16 @@ function cellOf(cell: DocCell, row: DocRow, first: boolean): Cell {
       : {};
   if (cell.kind === 'money') return { ...amountCell(cell.amount, bold), ...lines };
   if (cell.kind === 'empty') return { value: '', type: String, ...lines };
+  // A quantity with its unit or a percent: text, so Excel keeps "72 pcs" as it is
+  if (cell.kind === 'number') {
+    return {
+      value: cell.text,
+      type: String,
+      align: 'right',
+      ...(bold && { fontWeight: 'bold' }),
+      ...lines,
+    };
+  }
   return {
     value: cell.text,
     type: String,
@@ -56,7 +66,7 @@ export async function writeXlsx(doc: ReportDocument): Promise<Buffer> {
     backgroundColor: '#F1F3F6',
     bottomBorderStyle: 'thin',
     bottomBorderColor: '#D0D5DD',
-    align: column.kind === 'money' ? 'right' : 'left',
+    align: column.kind === 'text' ? 'left' : 'right',
   }));
   const top: Row[] = [
     titleRow(doc.company, 12, true),
```

- **Right-aligned unless it is text:** the header and the cells of a `number` column line up like amounts.
- **In Excel a `number` cell is a string,** so "72 pcs" stays as it is; the amounts stay real numbers people can add up.

```diff
@@ -1,4 +1,14 @@
-import type { BalanceSheet, ReportSection, TrialBalance } from '@omnivo/contracts';
+import {
+  type AgingAmounts,
+  type AgingReport,
+  type BalanceSheet,
+  costColumns,
+  type PurchaseReport,
+  type ReportSection,
+  type SalesReport,
+  type SalesReportRow,
+  type TrialBalance,
+} from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import { buildDocument, type DocCell, type DocumentContext, fileStem } from './document.js';
@@ -9,6 +19,8 @@ const context: DocumentContext = {
   currency: 'BDT',
   timeZone: 'Asia/Dhaka',
   branchName: null,
+  groupName: null,
+  categoryName: null,
   madeAt: new Date('2026-10-01T08:05:00Z'),
 };
 
@@ -104,3 +116,308 @@ describe('the document of a balance sheet', () => {
     ]);
   });
 });
+
+// Step 21b: the sales and purchase reports and the agings
+
+// A sales row: an item unless a kind is given; the cost columns from the net and the cost
+function salesRow(
+  name: string | null,
+  amounts: { gross: string; returns: string; net: string; cost: string | null },
+  extra: Partial<SalesReportRow> = {},
+): SalesReportRow {
+  return {
+    key: name ?? 'walk_in',
+    kind: 'item',
+    id: null,
+    code: null,
+    name,
+    month: null,
+    quantity: null,
+    baseUnit: null,
+    gross: amounts.gross,
+    returns: amounts.returns,
+    net: amounts.net,
+    ...costColumns(amounts.net, amounts.cost),
+    ...extra,
+  };
+}
+
+function salesReport(
+  items: SalesReportRow[],
+  withCost: boolean,
+  books: string | null,
+): SalesReport {
+  return {
+    items,
+    nextCursor: null,
+    totals: {
+      gross: '5035.0000',
+      returns: '331.0000',
+      net: '4704.0000',
+      ...costColumns('4704.0000', withCost ? '4111.0000' : null),
+    },
+    withCost,
+    books,
+  };
+}
+
+describe('the document of a sales report', () => {
+  const query = {
+    from: '2026-09-06',
+    to: '2026-11-05',
+    groupBy: 'customer' as const,
+    sort: '-net' as const,
+  };
+  const rahim = { gross: '3600.0000', returns: '100.0000', net: '3500.0000', cost: '3040.0000' };
+  const walkIns = { gross: '580.0000', returns: '60.0000', net: '520.0000', cost: '431.0000' };
+
+  it('writes the code before the name, the walk-ins in words, and the cost when allowed', () => {
+    const data = salesReport(
+      [
+        salesRow('Rahim Traders', rahim, { code: 'C-00001' }),
+        salesRow(null, walkIns, { kind: 'walk_in' }),
+      ],
+      true,
+      '5204.0000',
+    );
+    const doc = buildDocument({ report: 'sales_report', query, data }, context);
+    expect(doc.title).toBe('Sales report');
+    // Seven columns do not fit a portrait page
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns.map((column) => [column.header, column.kind])).toEqual([
+      ['Customer', 'text'],
+      ['Sold', 'money'],
+      ['Returns', 'money'],
+      ['Net sales', 'money'],
+      ['Cost', 'money'],
+      ['Margin', 'money'],
+      ['Margin %', 'number'],
+    ]);
+    expect(doc.rows.map((row) => [row.style, ...row.cells.map(read)])).toEqual([
+      [
+        'normal',
+        'C-00001 Rahim Traders',
+        '3600.0000',
+        '100.0000',
+        '3500.0000',
+        '3040.0000',
+        '460.0000',
+        '13.1%',
+      ],
+      [
+        'normal',
+        'Walk-in customers',
+        '580.0000',
+        '60.0000',
+        '520.0000',
+        '431.0000',
+        '89.0000',
+        '17.1%',
+      ],
+      ['grand', 'Total', '5035.0000', '331.0000', '4704.0000', '4111.0000', '593.0000', '12.6%'],
+    ]);
+    // The books' figure under the period, to compare with the total
+    expect(doc.lines).toEqual([
+      '6 Sep 2026 – 5 Nov 2026',
+      'By customer',
+      'In the books: 5,204.00',
+      'Amounts in BDT',
+      'Made on 1 Oct 2026, 14:05',
+    ]);
+  });
+
+  it('leaves the cost out of the file of someone who may not see it', () => {
+    const data = salesReport([salesRow('Rahim Traders', { ...rahim, cost: null })], false, null);
+    const doc = buildDocument({ report: 'sales_report', query, data }, context);
+    expect(doc.landscape).toBe(false);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Customer',
+      'Sold',
+      'Returns',
+      'Net sales',
+    ]);
+    expect(doc.rows.every((row) => row.cells.length === 4)).toBe(true);
+    // With a customer group there is no books' figure
+    expect(doc.lines).not.toContain('In the books: 5,204.00');
+  });
+
+  it('writes a quantity with its unit, by product, and adds none up', () => {
+    const data = salesReport(
+      [
+        salesRow('Miniket rice 5 kg', rahim, {
+          code: 'P-00001',
+          quantity: '1250.0000',
+          baseUnit: { code: 'pcs', decimals: 0 },
+        }),
+      ],
+      false,
+      '4704.0000',
+    );
+    const doc = buildDocument(
+      { report: 'sales_report', query: { ...query, groupBy: 'product' }, data },
+      { ...context, branchName: 'Mirpur shop', categoryName: 'Rice' },
+    );
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns[1]).toMatchObject({ header: 'Quantity', kind: 'number' });
+    expect(doc.rows.map((row) => row.cells.slice(0, 2).map(read))).toEqual([
+      ['P-00001 Miniket rice 5 kg', '1,250 pcs'],
+      ['Total', ''],
+    ]);
+    expect(doc.lines.slice(0, 4)).toEqual([
+      '6 Sep 2026 – 5 Nov 2026',
+      'By product',
+      'Branch: Mirpur shop',
+      'Category: Rice',
+    ]);
+  });
+
+  it('names a month, in Bangla too', () => {
+    const data = salesReport(
+      [salesRow(null, rahim, { key: '2026-10', month: '2026-10' })],
+      false,
+      null,
+    );
+    const ofMonths = {
+      report: 'sales_report' as const,
+      query: { ...query, groupBy: 'month' as const },
+      data,
+    };
+    expect(read(buildDocument(ofMonths, context).rows[0]?.cells[0])).toBe('October 2026');
+    expect(read(buildDocument(ofMonths, { ...context, language: 'bn' }).rows[0]?.cells[0])).toBe(
+      'অক্টোবর ২০২৬',
+    );
+    expect(fileStem(ofMonths)).toBe('sales-2026-09-06-to-2026-11-05');
+  });
+});
+
+describe('the document of a purchase report', () => {
+  const data: PurchaseReport = {
+    items: [
+      {
+        key: 'products',
+        kind: 'products',
+        id: null,
+        code: null,
+        name: null,
+        month: null,
+        quantity: null,
+        baseUnit: null,
+        gross: '2500.0000',
+        returns: '370.0000',
+        net: '2130.0000',
+      },
+    ],
+    nextCursor: null,
+    totals: { gross: '2500.0000', returns: '370.0000', net: '2130.0000' },
+  };
+
+  it('has no cost and no books, and names the Products row in words', () => {
+    const report = {
+      report: 'purchase_report' as const,
+      query: {
+        from: '2026-09-06',
+        to: '2026-11-05',
+        groupBy: 'account' as const,
+        sort: '-net' as const,
+      },
+      data,
+    };
+    const doc = buildDocument(report, { ...context, groupName: 'Local mills' });
+    expect(doc.landscape).toBe(false);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Expense account',
+      'Billed',
+      'Debit notes',
+      'Net purchases',
+    ]);
+    expect(doc.rows.map((row) => row.cells.map(read))).toEqual([
+      ['Products', '2500.0000', '370.0000', '2130.0000'],
+      ['Total', '2500.0000', '370.0000', '2130.0000'],
+    ]);
+    expect(doc.lines.slice(0, 3)).toEqual([
+      '6 Sep 2026 – 5 Nov 2026',
+      'By expense account',
+      'Supplier group: Local mills',
+    ]);
+    expect(fileStem(report)).toBe('purchases-2026-09-06-to-2026-11-05');
+  });
+});
+
+describe('the document of an aging', () => {
+  const amounts = (balance: string): AgingAmounts => ({
+    current: '100.0000',
+    days1To30: '500.0000',
+    days31To60: '900.0000',
+    days61To90: '1300.0000',
+    over90: '800.0000',
+    due: '3600.0000',
+    advances: '0.0000',
+    balance,
+  });
+  const data = (ledger: string | null): AgingReport => ({
+    items: [
+      {
+        party: { id: id(7), code: 'C-00007', name: 'Agrabad Medicine Corner' },
+        ...amounts('3600.0000'),
+      },
+    ],
+    nextCursor: null,
+    asOf: '2026-11-05',
+    totals: amounts('3600.0000'),
+    ledger,
+  });
+
+  // "As at", the balance sheet's words for a picture of one day
+  it("has the page's nine columns, the day and the ledger's figure", () => {
+    const report = {
+      report: 'ar_aging' as const,
+      query: { asOf: '2026-11-05', show: 'all' as const, sort: '-balance' as const },
+      data: data('3600.0000'),
+    };
+    const doc = buildDocument(report, context);
+    expect(doc.title).toBe('Receivables aging');
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Customer',
+      'Current',
+      '1–30 days',
+      '31–60 days',
+      '61–90 days',
+      'Over 90 days',
+      'Total due',
+      'Advances',
+      'Balance',
+    ]);
+    expect(doc.rows[0]?.cells.map(read)).toEqual([
+      'C-00007 Agrabad Medicine Corner',
+      '100.0000',
+      '500.0000',
+      '900.0000',
+      '1300.0000',
+      '800.0000',
+      '3600.0000',
+      '0.0000',
+      '3600.0000',
+    ]);
+    expect(doc.lines.slice(0, 2)).toEqual(['As at 5 Nov 2026', 'In the books: 3,600.00']);
+    expect(fileStem(report)).toBe('receivables-aging-2026-11-05');
+  });
+
+  it('says "Overdue only", with no ledger to compare, for the suppliers too', () => {
+    const report = {
+      report: 'ap_aging' as const,
+      query: { asOf: '2026-11-05', show: 'overdue' as const, sort: '-balance' as const },
+      data: data(null),
+    };
+    const doc = buildDocument(report, { ...context, groupName: 'Yarn mills' });
+    expect(doc.title).toBe('Payables aging');
+    expect(doc.columns[0]?.header).toBe('Supplier');
+    expect(doc.lines.slice(0, 3)).toEqual([
+      'As at 5 Nov 2026',
+      'Supplier group: Yarn mills',
+      'Overdue only',
+    ]);
+    expect(doc.lines.some((line) => line.startsWith('In the books'))).toBe(false);
+    expect(fileStem(report)).toBe('payables-aging-2026-11-05');
+  });
+});
```

- **The test context gets the two new names** (`null`): the type asks for them.

### What I checked

> Run while this part was written, on its code alone. 21b.8 ran everything again on the finished step.
>
> The dashboard's integration suite seeds a grocery with invoices, a POS sale, bills and a receipt (step 21a). A copy
> of it with 4 more tests, not kept (21b.4 writes the real tests), ran the six routes on that data:
>
> - The sales report by each of the five groups and 10–12 sorts: the rows add up to the totals (net and cost), every
>   page of 2 rows has the same totals, and the pages together are the unpaged list in the same order. ৳6,760 sold,
>   ৳5,650 cost, 16.4%; the books said ৳9,460 (the suite also writes journal entries by hand on the sales account).
>   By customer: Karim Store, Rahim Traders and one "Walk-in customers" row. A quantity sort by customer: 400; a broken
>   cursor: 400.
> - The purchase report by each of its four groups: by product, one "Expenses" row of ৳15,000 (rent and electricity
>   bills have no product line); by account, Office rent ৳12,000 and Utilities ৳3,000.
> - The receivables aging today: ৳5,313 current, ৳1,601 in 1–30 days, the ledger ৳6,914 (the dashboard's number). On
>   yesterday, 30 days back, 400 days back and 30 days ahead, the aging's balance equalled the ledger every time.
>   Yesterday showed Rahim's invoice whole (৳1,035), before today's receipt of ৳400. Each party's page added up to its
>   row and to its own ledger. A supplier on the receivables' page and an unknown id: 404.
> - The payables aging: ৳3,000 current, ৳12,000 1–30 days, ledger ৳15,000.
> - Five exports (sales by product for one branch in Excel, sales by month sorted by margin in PDF, purchases by
>   account, both agings): all ready, named `sales-2026-09-06-to-2026-11-05.xlsx` and so on. A member with only
>   `sales.report.read`: a purchase export and a cost sort are 403 `permission_missing`; the sales report has `null`
>   cost columns.
>
> Broken on purpose: with `net` in place of `g.net` in the sort map, the sales by customer, largest first, came back
> ৳900, ৳5,460, ৳400 (text order) and the test failed.
>
> The suites that write allocations and the reports' own: invoices, returns, supplier payments, purchase returns,
> bills, report exports, reports and the reports tenant-leak suite, 8 files, 134 tests, pass. API unit tests 130 pass.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/reports apps/api/src/common/db apps/api/src/rbac apps/api/src/sales apps/api/src/purchase
```

All pass. The API's type check is clean again: the four inserts of 21b.2 have their `appliedOn`, and every
`Record<ReportKind, …>` has the four kinds. Until their parts, `packages/i18n` (the error's words, 21b.5) and `apps/app`
(the kinds' words and the mock, 21b.5 and 21b.7) still fail their type checks, as after 21b.1.

## 21b.4 — `apps/api`: the tests

Two new integration suites and four changed or new test files:

- `reports/trade-reports.int.spec.ts` (new): a shop's sales and purchases of two months, every kind of document once,
  through the two report routes.
- `reports/aging.int.spec.ts` (new): a distributor's customers and suppliers, each with one thing the aging must get
  right, as of many days; and the day each allocation counts, read from the database.
- `reports/report-exports.int.spec.ts`: the four new kinds, their permissions and the cost in the worker's file.
- `reports/reports.tenant-leak.int.spec.ts`: one workspace's documents never in another's reports.
- `reports/export/document.spec.ts`: the files of the four new kinds, without a database.
- `common/db/applied-on.spec.ts` (new): keeping an allocation's day, without a database.

The tests found one bug in the 21b.3 code: sorted by quantity from small to large, the purchase report put its
"Expenses" row first. The fix is in `trade-report-queries.ts` above (decision 42), so the code of 21b.3 is the code
the tests ran against.

### `reports/trade-reports.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type Bill,
  type BillLineFormValues,
  billSchema,
  type Branch,
  branchListSchema,
  branchSchema,
  costColumns,
  creditNoteSchema,
  type Customer,
  customerGroupSchema,
  customerSchema,
  type Delivery,
  debitNoteSchema,
  deliverySchema,
  deviceSchema,
  type GoodsReceipt,
  goodsReceiptSchema,
  type Invoice,
  invoiceSchema,
  journalEntrySchema,
  memberPageSchema,
  type PermissionKey,
  posCashReasonSchema,
  posRegisterSchema,
  posReturnAmounts,
  type PosSale,
  posSaleSchema,
  problemSchema,
  type Product,
  productCategoryListSchema,
  type ProductFormValues,
  productSchema,
  type PurchaseOrder,
  purchaseOrderSchema,
  type PurchaseReport,
  purchaseReportSchema,
  purchaseReturnSchema,
  roleSchema,
  type SalesOrder,
  salesOrderSchema,
  type SalesReport,
  salesReportSchema,
  salesReturnSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  type Supplier,
  supplierGroupSchema,
  supplierSchema,
  SYNC_PROTOCOL,
  type SyncCommandInput,
  syncPushSchema,
  type TaxRate,
  taxRateListSchema,
  todayIn,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
  warehouseSchema,
} from '@omnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

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

// Step 21b. Shapla Super Store: a shop in Dhanmondi (the main branch) and a second shop in Mirpur.
// Every kind of document that sells or buys, once, with amounts that tell them apart:
// - Rahim Traders: a challan of 10 bags of rice, 2 back before the bill, an invoice of the other 8
//   and a credit note that only cuts the price (৳100, no goods back);
// - Karim Store (a wholesale customer): a direct invoice of 5 bottles of oil at 10% off from the
//   Mirpur shop, 1 bottle back with a credit note for it;
// - a walk-in at the POS: rice, two soaps of two scents (one product, two variants) and matches,
//   and one soap back;
// - bills for sugar (from a goods receipt), van hire (an account line) and the rent (an expense),
//   with a debit note for each kind and one without a bill.
// The sums are written out in the tests. Every document is dated a number of days before today,
// so the tests run on any day; a month is worked out from the dates.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Reads both reports, but not what the stock cost
let shirin: SignedIn;
// No role at all
let rafiq: SignedIn;
let today: string;
let accounts: Account[];
let vat: TaxRate;
let exempt: TaxRate;
let pcs: string;
let dhanmondi: Branch;
let mirpur: Branch;
let main: Warehouse;
let mirpurStore: Warehouse;
let groceries: string;
let riceCategory: string;
let personalCare: string;
let rice: Product;
let oil: Product;
let soap: Product;
let matches: Product;
let sugar: Product;
let homeDelivery: Product;
let vanHire: Product;
let wholesale: string;
let localMills: string;
let rahim: Customer;
let karim: Customer;
let meghna: Supplier;
let landlord: Supplier;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type ReturnCommand = Extract<SyncCommandInput, { type: 'pos_return.create' }>;
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;

// A UUIDv7 as a device makes it: only the version digit matters to the server's checks
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

const day = (days: number) => shiftIsoDate(today, days);

// The sales report's net by the day it counts, for the month grouping: [day, net]
const soldOn: [number, string][] = [];
// The same for the purchase report
const boughtOn: [number, string][] = [];

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function sales(query: string, as = owner): Promise<SalesReport> {
  const res = await send('GET', `/reports/sales?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return salesReportSchema.parse(res.json());
}

async function purchases(query: string, as = owner): Promise<PurchaseReport> {
  const res = await send('GET', `/reports/purchases?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return purchaseReportSchema.parse(res.json());
}

// The whole period of this test's documents: 60 days back to today
const period = () => `from=${day(-60)}&to=${today}`;

// A row as the test reads it: its kind, its name (or month), and the money
function moneyOf(row: SalesReport['items'][number] | PurchaseReport['items'][number]) {
  return [row.kind, row.name ?? row.month, row.gross, row.returns, row.net];
}

function costOf(row: SalesReport['items'][number]) {
  return [row.name ?? row.kind, row.cost, row.margin, row.marginPercent];
}

// The rows' months, the oldest first, from what the test posted on each day
function byMonth(posted: readonly [number, string][]): [string, string][] {
  const months = new Map<string, number>();
  for (const [days, net] of posted) {
    const month = day(days).slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + Number(net));
  }
  return [...months.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([month, net]) => [month, net.toFixed(4)]);
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product, at = 0): string {
  const variant = product.variants[at];
  if (!variant) throw new Error(`${product.name} has no variant ${String(at)}`);
  return variant.id;
}

function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) throw new Error(`not one ${what}`);
  return first;
}

async function addProduct(
  name: string,
  categoryId: string,
  extra: Partial<ProductFormValues> = {},
): Promise<Product> {
  return created(productSchema, '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId,
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  } satisfies ProductFormValues);
}

// A category of the retail template, by its name and its parent's id (null = top level)
async function categoryOf(name: string, parentId: string | null = null): Promise<string> {
  const { items } = productCategoryListSchema.parse(
    (await send('GET', '/product-categories')).json(),
  );
  const found = items.find((item) => item.name === name && item.parentId === parentId);
  if (!found) throw new Error(`no category ${name}`);
  return found.id;
}

async function addCustomer(name: string, groupId: string): Promise<Customer> {
  return created(customerSchema, '/customers', {
    code: '',
    name,
    groupId,
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
}

async function addSupplier(name: string, groupId: string): Promise<Supplier> {
  return created(supplierSchema, '/suppliers', {
    code: '',
    name,
    groupId,
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    address: '',
    bankAccounts: [],
    notes: '',
  });
}

// A member with one role of exactly these permissions; [] = no role at all
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'shapla-super-store' });
  if (permissions.length > 0) {
    const role = await created(roleSchema, '/roles', {
      name: `${person.fullName}'s role`,
      description: '',
    });
    const matrix = await send('PUT', '/permission-matrix', {
      roles: [{ id: role.id, version: role.version, permissions }],
    });
    expect(matrix.statusCode, matrix.body).toBe(200);
    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
    const found = items.find((item) => item.email === person.email);
    if (!found) throw new Error(`${person.email} is not a member`);
    const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(roles.statusCode, roles.body).toBe(200);
  }
  return logIn(app, {
    workspace: 'shapla-super-store',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
}

function stockLine(product: Product, quantity: string, unitCost: string, at = 0) {
  return {
    variantId: variantOf(product, at),
    unitId: pcs,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
  };
}

// A sales line by the piece at 15% VAT; `discount` is a percent
function salesLine(product: Product, quantity: string, unitPrice: string, discount = '') {
  return {
    variantId: variantOf(product),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount,
    taxRateId: vat.id,
  };
}

function invoiceLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: { discount?: string; deliveryLineId?: string } = {},
) {
  return {
    ...salesLine(product, quantity, unitPrice, extra.discount),
    deliveryLineId: extra.deliveryLineId ?? '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
  };
}

function invoiceForm(
  customer: Customer,
  date: string,
  lines: object[],
  extra: { warehouse?: Warehouse; post?: boolean } = {},
) {
  return {
    customerId: customer.id,
    date,
    dueDate: '',
    customerReference: '',
    branchId: extra.warehouse?.branchId ?? dhanmondi.id,
    warehouseId: extra.warehouse?.id ?? '',
    note: '',
    lines,
    post: extra.post ?? true,
  };
}

function lineOf<T extends { variantId: string | null }>(lines: readonly T[], product: Product): T {
  const found = lines.find((line) => line.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} line`);
  return found;
}

// A goods return of a customer, into the store the goods left from
function salesReturnForm(
  customer: Customer,
  date: string,
  warehouse: Warehouse,
  lines: { product: Product; quantity: string; deliveryLineId: string }[],
) {
  return {
    customerId: customer.id,
    date,
    warehouseId: warehouse.id,
    reason: 'damaged',
    note: '',
    lines: lines.map((line) => ({
      variantId: variantOf(line.product),
      unitId: pcs,
      quantity: line.quantity,
      batchId: '',
      serialNumbers: [],
      deliveryLineId: line.deliveryLineId,
    })),
    post: true,
  };
}

// A credit note line: a price cut, or goods back when it names a return line
function creditLine(
  invoiceLineId: string,
  quantity: string,
  unitPrice: string,
  extra: { discount?: string; returnLineId?: string } = {},
) {
  return {
    invoiceLineId,
    returnLineId: extra.returnLineId ?? '',
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: extra.discount ?? '',
  };
}

function billLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<BillLineFormValues> = {},
): BillLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: vat.id,
    receiptLineId: '',
    orderLineId: '',
    accountId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function billForm(
  supplier: Supplier,
  date: string,
  number: string,
  parts: { lines?: BillLineFormValues[]; expenses?: object[]; submit?: boolean },
) {
  return {
    supplierId: supplier.id,
    date,
    dueDate: '',
    supplierBillNumber: number,
    mushakNumber: '',
    mushakDate: '',
    branchId: dhanmondi.id,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: parts.lines ?? [],
    expenses: parts.expenses ?? [],
    // No bill levels in this workspace: a submitted bill is posted at once
    submit: parts.submit ?? true,
  };
}

// A goods return to the supplier from the main store: from a receipt line, or on its own
function purchaseReturnForm(
  supplier: Supplier,
  date: string,
  product: Product,
  quantity: string,
  receiptLineId = '',
) {
  return {
    supplierId: supplier.id,
    date,
    warehouseId: main.id,
    reason: 'damaged',
    note: '',
    lines: [
      {
        variantId: variantOf(product),
        unitId: pcs,
        quantity,
        batchId: '',
        serialNumbers: [],
        receiptLineId,
      },
    ],
    post: true,
  };
}

function debitNoteForm(
  supplier: Supplier,
  bill: Bill | null,
  date: string,
  parts: { lines?: object[]; expenses?: object[] },
) {
  return {
    supplierId: supplier.id,
    billId: bill?.id ?? '',
    date,
    // A debit note without a bill names its branch; with one, it is the bill's
    branchId: bill === null ? dhanmondi.id : '',
    pricesIncludeVat: false,
    reason: 'goods_returned',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines: parts.lines ?? [],
    expenses: parts.expenses ?? [],
    post: true,
  };
}

function debitLine(
  quantity: string,
  unitPrice: string,
  source: { billLineId?: string; returnLineId?: string; taxRateId?: string },
) {
  return {
    billLineId: source.billLineId ?? '',
    returnLineId: source.returnLineId ?? '',
    taxRateId: source.taxRateId ?? '',
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
  };
}

// The POS: the front counter of the Dhanmondi shop, its first shift, a sale and a return
async function sellAtTheCounter(): Promise<void> {
  const floatIn = await created(posCashReasonSchema, '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountId('3100'),
  });
  const counterPc = await created(deviceSchema, '/sync/devices', {
    id: v7(),
    name: 'Front counter PC',
    branchId: dhanmondi.id,
  });
  const register = await created(posRegisterSchema, '/pos/registers', {
    code: 'POS1',
    name: 'Front counter',
    warehouseId: main.id,
    accounts: { cash: accountId('1110'), card: '', bkash: '', nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
    overShortAccountId: accountId('5350'),
    varianceAlert: '500',
    lockAfter: '5',
    exchangeAccountId: '',
    returnDays: '7',
  });
  const claim = await send('POST', `/pos/registers/${register.id}/claim`, {
    deviceId: counterPc.id,
  });
  expect(claim.statusCode, claim.body).toBe(200);
  const push = async (commands: (SaleCommand | ReturnCommand | OpenCommand)[]) => {
    const res = await send('POST', '/sync/push', {
      deviceId: counterPc.id,
      protocol: SYNC_PROTOCOL,
      commands,
    });
    expect(res.statusCode, res.body).toBe(200);
    const { results } = syncPushSchema.parse(res.json());
    expect(
      results.map((result) => result.status),
      JSON.stringify(results),
    ).toEqual(commands.map(() => 'accepted'));
  };
  const shiftId = v7();
  const posLine = (product: Product, quantity: string, price: string, at = 0): SaleLine => ({
    variantId: variantOf(product, at),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice: price,
    discountType: 'percent',
    discount: '0',
    taxRateId: vat.id,
    rate: vat.rate,
    startingPrice: price,
    batchId: '',
    serialNumbers: [],
  });
  const sale: SaleCommand = {
    id: v7(),
    type: 'pos_sale.create',
    saleId: v7(),
    input: {
      registerId: register.id,
      sequence: 1,
      shiftId,
      date: today,
      soldAt: new Date(Date.now() + 1000).toISOString(),
      customerId: '',
      pricesIncludeVat: false,
      // ৳580 and 15% VAT
      lines: [
        posLine(rice, '1', '450'),
        posLine(soap, '1', '60', 0),
        posLine(soap, '1', '60', 1),
        posLine(matches, '2', '5'),
      ],
      billDiscountType: 'amount',
      billDiscount: '0',
      payments: [{ method: 'cash', amount: '667', reference: '' }],
    },
  };
  await push([
    {
      id: v7(),
      type: 'pos_shift.open',
      shiftId,
      input: {
        registerId: register.id,
        sequence: 1,
        date: today,
        openedAt: new Date().toISOString(),
        opening: { notes: null, total: '1000' },
        floatReasonId: floatIn.id,
      },
    },
    sale,
  ]);
  const sold: PosSale = posSaleSchema.parse(
    (await send('GET', `/pos/sales/${sale.saleId}`)).json(),
  );
  expect(sold.total).toBe('667.0000');
  soldOn.push([0, '580']);

  // The lime soap comes back: ৳60 and its VAT, in cash
  const lime = sold.lines.find((line) => line.variantId === variantOf(soap, 1));
  if (!lime) throw new Error('no lime soap line');
  const amounts = posReturnAmounts(lime, '1');
  await push([
    {
      id: v7(),
      type: 'pos_return.create',
      returnId: v7(),
      input: {
        registerId: register.id,
        sequence: 1,
        shiftId,
        date: today,
        returnedAt: new Date(Date.now() + 2000).toISOString(),
        saleId: sold.id,
        lines: [
          {
            saleLineId: lime.id,
            quantity: '1',
            net: amounts.net,
            vat: amounts.vat,
            serialNumbers: [],
          },
        ],
        refunds: [{ method: 'cash', amount: amounts.total, reference: '' }],
        note: '',
      },
    },
  ]);
  soldOn.push([0, '-60']);
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
    companyName: 'Shapla Super Store',
    workspaceSlug: 'shapla-super-store',
    fullName: 'Sharmin Akter',
    email: 'sharmin@shaplastore.com',
    password: 'Dhanmondi-store-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  const [first] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
  if (!first) throw new Error('sign-up made no branch');
  dhanmondi = first;
  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  mirpur = await created(branchSchema, '/branches', {
    code: 'MIR',
    name: 'Mirpur shop',
    phone: '',
    address: 'Section 10, Mirpur',
  });
  mirpurStore = await created(warehouseSchema, '/warehouses', {
    branchId: mirpur.id,
    code: 'MIR1',
    name: 'Mirpur store',
    address: '',
  });

  // A Sales returns account, picked in the settings: the retail chart has none
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const returns = await created(accountSchema, '/accounts', {
    parentId: accountId('4100'),
    code: '4130',
    name: 'Sales returns',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect((await send('PUT', '/sales-accounts', { returns: returns.id })).statusCode).toBe(200);
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const rateNamed = (name: string) => {
    const rate = rates.find((item) => item.name === name);
    if (!rate) throw new Error(`no ${name}`);
    return rate;
  };
  vat = rateNamed('VAT 15%');
  exempt = rateNamed('Exempt');
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';

  // The retail template's Groceries, with Rice under it, and Personal care; matches have none
  groceries = await categoryOf('Groceries');
  riceCategory = await categoryOf('Rice', groceries);
  personalCare = await categoryOf('Personal care');
  rice = await addProduct('Miniket rice 5 kg', riceCategory);
  oil = await addProduct('Soybean oil 1 L', groceries);
  soap = await addProduct('Toilet soap 100 g', personalCare, {
    options: [{ name: 'Scent', values: ['Rose', 'Lime'] }],
    variants: ['Rose', 'Lime'].map((scent) => ({
      id: null,
      sku: '',
      optionValues: [scent],
      barcode: '',
      salePrice: '60',
      archived: false,
    })),
  });
  matches = await addProduct('Matchbox', '');
  sugar = await addProduct('Sugar 1 kg', groceries);
  homeDelivery = await addProduct('Home delivery', '', { type: 'service' });
  vanHire = await addProduct('Van hire', '', { type: 'service' });

  wholesale = (await created(customerGroupSchema, '/customer-groups', { name: 'Wholesale' })).id;
  localMills = (await created(supplierGroupSchema, '/supplier-groups', { name: 'Local mills' })).id;
  rahim = await addCustomer('Rahim Traders', '');
  karim = await addCustomer('Karim Store', wholesale);
  meghna = await addSupplier('Meghna Agro Mills', localMills);
  landlord = await addSupplier('Dhanmondi Properties Ltd.', '');

  // The stock, 40 days ago, at a known cost: the sales' cost is the challan's, at these prices
  for (const [warehouse, lines] of [
    [
      main,
      [
        stockLine(rice, '40', '380'),
        stockLine(soap, '10', '45', 0),
        stockLine(soap, '10', '45', 1),
        stockLine(matches, '50', '3'),
      ],
    ],
    [mirpurStore, [stockLine(oil, '10', '160')]],
  ] as const) {
    const stocked = await send('POST', '/stock-adjustments', {
      date: day(-40),
      warehouseId: warehouse.id,
      direction: 'in',
      reason: 'opening',
      note: '',
      lines,
      post: true,
    });
    expect(stocked.statusCode, stocked.body).toBe(201);
  }

  shirin = await memberWith(
    { fullName: 'Shirin Akter', email: 'shirin@shaplastore.com', password: 'Reports-desk-2026' },
    ['sales.report.read', 'purchase.report.read'],
  );
  rafiq = await memberWith(
    { fullName: 'Rafiq Islam', email: 'rafiq@shaplastore.com', password: 'No-role-yet-2026' },
    [],
  );
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('The documents of two months', () => {
  // Dozens of documents go through the API here, so the 5 seconds of a normal test are not enough
  // when the whole suite runs at once.
  it('are posted the way the shop works', async () => {
    // Rahim: an order, a challan of 10 bags, 2 back before the bill, an invoice of 8
    const order: SalesOrder = await created(salesOrderSchema, '/sales-orders', {
      customerId: rahim.id,
      date: day(-21),
      deliveryDate: '',
      customerReference: '',
      warehouseId: main.id,
      shippingAddressId: '',
      note: '',
      lines: [salesLine(rice, '10', '450')],
      confirm: true,
    });
    const challan: Delivery = await created(deliverySchema, '/deliveries', {
      customerId: rahim.id,
      orderId: order.id,
      date: day(-20),
      warehouseId: main.id,
      shippingAddressId: '',
      vehicle: '',
      note: '',
      lines: [
        {
          variantId: variantOf(rice),
          unitId: pcs,
          quantity: '10',
          batchId: '',
          serialNumbers: [],
          orderLineId: only(order.lines, 'order line').id,
        },
      ],
      post: true,
    });
    const challanLine = only(challan.lines, 'challan line').id;
    await created(
      salesReturnSchema,
      '/sales-returns',
      salesReturnForm(rahim, day(-19), main, [
        { product: rice, quantity: '2', deliveryLineId: challanLine },
      ]),
    );
    const rahimInvoice: Invoice = await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(rahim, day(-18), [
        invoiceLine(rice, '8', '450', { deliveryLineId: challanLine }),
      ]),
    );
    expect(rahimInvoice.net).toBe('3600.0000');
    soldOn.push([-18, '3600']);

    // Karim: a direct invoice from the Mirpur shop, 5 bottles at 10% off (৳855)
    const karimInvoice: Invoice = await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, day(-10), [invoiceLine(oil, '5', '190', { discount: '10' })], {
        warehouse: mirpurStore,
      }),
    );
    expect(karimInvoice.net).toBe('855.0000');
    soldOn.push([-10, '855']);
    const oilLine = only(karimInvoice.lines, 'invoice line');
    // One bottle back, and the credit note for it: ৳171, its cost back to the stock
    const back = await created(
      salesReturnSchema,
      '/sales-returns',
      salesReturnForm(karim, day(-5), mirpurStore, [
        { product: oil, quantity: '1', deliveryLineId: oilLine.deliveryLineId ?? '' },
      ]),
    );
    await created(creditNoteSchema, '/credit-notes', {
      invoiceId: karimInvoice.id,
      date: day(-5),
      reason: 'goods_returned',
      note: '',
      lines: [
        creditLine(oilLine.id, '1', '190', {
          discount: '10',
          returnLineId: only(back.lines, 'return line').id,
        }),
      ],
      post: true,
    });
    soldOn.push([-5, '-171']);

    // Rahim's price cut: ৳100 off, no goods back
    await created(creditNoteSchema, '/credit-notes', {
      invoiceId: rahimInvoice.id,
      date: day(-3),
      reason: 'price_adjustment',
      note: '',
      lines: [creditLine(lineOf(rahimInvoice.lines, rice).id, '1', '100')],
      post: true,
    });
    soldOn.push([-3, '-100']);

    // Outside the period or not posted: a home delivery 70 days ago, and a draft today
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(rahim, day(-70), [invoiceLine(homeDelivery, '1', '100')]),
    );
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, today, [invoiceLine(homeDelivery, '1', '9999')], { post: false }),
    );

    // A sale the accountant wrote by hand: the books have it, the documents do not
    const byHand = await send('POST', '/journal-entries', {
      date: day(-2),
      narration: 'Cash sale written by hand',
      lines: [
        {
          accountId: accountId('1110'),
          branchId: dhanmondi.id,
          description: '',
          debit: '500',
          credit: '',
        },
        {
          accountId: accountId('4110'),
          branchId: dhanmondi.id,
          description: '',
          debit: '',
          credit: '500',
        },
      ],
      post: true,
    });
    expect(byHand.statusCode, byHand.body).toBe(201);
    journalEntrySchema.parse(byHand.json());

    await sellAtTheCounter();

    // Meghna: an order of 20 kg of sugar at ৳120, received, billed at ৳125 with a van hire
    const draftOrder = await created(purchaseOrderSchema, '/purchase-orders', {
      supplierId: meghna.id,
      date: day(-32),
      expectedDate: '',
      warehouseId: main.id,
      supplierReference: '',
      paymentTermsDays: 30,
      pricesIncludeVat: false,
      note: '',
      lines: [
        {
          variantId: variantOf(sugar),
          unitId: pcs,
          quantity: '20',
          description: '',
          unitPrice: '120',
          discountType: 'percent',
          discount: '',
          taxRateId: vat.id,
          requisitionLineId: '',
        },
      ],
    });
    const submitted = await send('POST', `/purchase-orders/${draftOrder.id}/submit`, {
      version: draftOrder.version,
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const purchaseOrder: PurchaseOrder = purchaseOrderSchema.parse(submitted.json());
    const grn: GoodsReceipt = await created(goodsReceiptSchema, '/goods-receipts', {
      orderId: purchaseOrder.id,
      date: day(-30),
      warehouseId: main.id,
      supplierChallan: '',
      vehicle: '',
      note: '',
      lines: [
        {
          variantId: variantOf(sugar),
          unitId: pcs,
          quantity: '20',
          batchId: '',
          lotNumber: '',
          expiresOn: '',
          manufacturedOn: '',
          serialNumbers: [],
          orderLineId: only(purchaseOrder.lines, 'order line').id,
          rejectedQuantity: '',
          rejectionReason: '',
        },
      ],
      post: true,
    });
    const receiptLine = only(grn.lines, 'receipt line').id;
    const sugarBill: Bill = await created(
      billSchema,
      '/bills',
      billForm(meghna, day(-28), 'MAM/2026/118', {
        lines: [
          billLine(sugar, '20', '125', { receiptLineId: receiptLine }),
          billLine(vanHire, '1', '300', { accountId: accountId('5240') }),
        ],
      }),
    );
    expect(sugarBill).toMatchObject({ status: 'posted', net: '2800.0000' });
    boughtOn.push([-28, '2800']);
    // 2 kg back after the bill, and the debit note for them: ৳250
    const sugarBack = await created(
      purchaseReturnSchema,
      '/purchase-returns',
      purchaseReturnForm(meghna, day(-25), sugar, '2', receiptLine),
    );
    await created(
      debitNoteSchema,
      '/debit-notes',
      debitNoteForm(meghna, sugarBill, day(-24), {
        lines: [
          debitLine('2', '125', {
            billLineId: lineOf(sugarBill.lines, sugar).id,
            returnLineId: only(sugarBack.lines, 'return line').id,
          }),
        ],
      }),
    );
    boughtOn.push([-24, '-250']);

    // The rent: an expense, ৳1,000 of it taken off by a debit note
    const rentBill: Bill = await created(
      billSchema,
      '/bills',
      billForm(landlord, day(-20), 'DPL-2026-10', {
        expenses: [
          {
            accountId: accountId('5220'),
            description: 'Shop rent, Dhanmondi',
            amount: '12000',
            taxRateId: exempt.id,
          },
        ],
      }),
    );
    boughtOn.push([-20, '12000']);
    await created(
      debitNoteSchema,
      '/debit-notes',
      debitNoteForm(landlord, rentBill, day(-15), {
        expenses: [{ billExpenseId: only(rentBill.expenses, 'expense').id, amount: '1000' }],
      }),
    );
    boughtOn.push([-15, '-1000']);

    // 1 kg back with no receipt behind it, on a debit note without a bill: ৳120
    const looseBack = await created(
      purchaseReturnSchema,
      '/purchase-returns',
      purchaseReturnForm(meghna, day(-12), sugar, '1'),
    );
    await created(
      debitNoteSchema,
      '/debit-notes',
      debitNoteForm(meghna, null, day(-12), {
        lines: [
          debitLine('1', '120', {
            returnLineId: only(looseBack.lines, 'return line').id,
            taxRateId: vat.id,
          }),
        ],
      }),
    );
    boughtOn.push([-12, '-120']);

    // A draft bill is not a purchase
    await created(
      billSchema,
      '/bills',
      billForm(meghna, day(-10), 'MAM/2026/131', {
        lines: [billLine(vanHire, '1', '5000', { accountId: accountId('5240') })],
        submit: false,
      }),
    );
  }, 120_000);
});

describe('The sales report', () => {
  it('adds up every kind of document by customer, the walk-ins in one row', async () => {
    const report = await sales(period());
    expect(report.items.map(moneyOf)).toEqual([
      // Invoice ৳3,600, the price cut ৳100
      ['item', 'Rahim Traders', '3600.0000', '100.0000', '3500.0000'],
      // Invoice ৳855, a bottle back ৳171
      ['item', 'Karim Store', '855.0000', '171.0000', '684.0000'],
      // The POS sale ৳580, a soap back ৳60
      ['walk_in', null, '580.0000', '60.0000', '520.0000'],
    ]);
    expect(report.items.map((row) => [row.key, row.id, row.code])).toEqual([
      [rahim.id, rahim.id, rahim.code],
      [karim.id, karim.id, karim.code],
      ['walk_in', null, null],
    ]);
    // The cost: 8 bags at ৳380 (the 2 back before the bill are not sold); 5 bottles at ৳160 less
    // the one back; at the counter 380 + 45 + 45 + 2 × 3, less the soap back. The price cut gave
    // money back, not goods: Rahim's cost stays.
    expect(report.items.map(costOf)).toEqual([
      ['Rahim Traders', ...Object.values(costColumns('3500.0000', '3040.0000'))],
      ['Karim Store', ...Object.values(costColumns('684.0000', '640.0000'))],
      ['walk_in', ...Object.values(costColumns('520.0000', '431.0000'))],
    ]);
    expect(report.totals).toEqual({
      gross: '5035.0000',
      returns: '331.0000',
      net: '4704.0000',
      ...costColumns('4704.0000', '4111.0000'),
    });
    expect(report.withCost).toBe(true);
    expect(report.nextCursor).toBeNull();
    // The books have the ৳500 sale written by hand too: the page shows the difference
    expect(report.books).toBe('5204.0000');
    // No quantity or unit outside the product group: a row mixes products
    expect(report.items.map((row) => [row.quantity, row.baseUnit, row.month])).toEqual([
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("groups a product's variants in one row, with its quantity in the base unit", async () => {
    const report = await sales(`${period()}&groupBy=product`);
    expect(
      report.items.map((row) => [row.name, row.code, row.quantity, row.baseUnit?.code]),
    ).toEqual([
      // 8 billed + 1 at the counter; the price cut takes no bag back
      ['Miniket rice 5 kg', rice.code, '9.0000', 'pcs'],
      // 5 less the one back
      ['Soybean oil 1 L', oil.code, '4.0000', 'pcs'],
      // A rose and a lime sold, the lime back
      ['Toilet soap 100 g', soap.code, '1.0000', 'pcs'],
      ['Matchbox', matches.code, '2.0000', 'pcs'],
    ]);
    expect(report.items.map(moneyOf)).toEqual([
      ['item', 'Miniket rice 5 kg', '4050.0000', '100.0000', '3950.0000'],
      ['item', 'Soybean oil 1 L', '855.0000', '171.0000', '684.0000'],
      ['item', 'Toilet soap 100 g', '120.0000', '60.0000', '60.0000'],
      ['item', 'Matchbox', '10.0000', '0.0000', '10.0000'],
    ]);
    expect(report.items.map((row) => row.cost)).toEqual([
      '3420.0000',
      '640.0000',
      '45.0000',
      '6.0000',
    ]);
    expect(report.totals.net).toBe('4704.0000');
  });

  it('groups by the own category, by branch and by month', async () => {
    const byCategory = await sales(`${period()}&groupBy=category`);
    expect(byCategory.items.map(moneyOf)).toEqual([
      // Rice is in Rice, not in Groceries above it
      ['item', 'Rice', '4050.0000', '100.0000', '3950.0000'],
      ['item', 'Groceries', '855.0000', '171.0000', '684.0000'],
      ['item', 'Personal care', '120.0000', '60.0000', '60.0000'],
      ['no_category', null, '10.0000', '0.0000', '10.0000'],
    ]);
    expect(byCategory.items.map((row) => [row.key, row.code])).toEqual([
      [riceCategory, null],
      [groceries, null],
      [personalCare, null],
      ['no_category', null],
    ]);

    // A credit note counts in its invoice's branch, a POS return in its store's
    const byBranch = await sales(`${period()}&groupBy=branch`);
    expect(byBranch.items.map(moneyOf)).toEqual([
      ['item', dhanmondi.name, '4180.0000', '160.0000', '4020.0000'],
      ['item', 'Mirpur shop', '855.0000', '171.0000', '684.0000'],
    ]);
    expect(byBranch.items.map((row) => [row.key, row.code])).toEqual([
      [dhanmondi.id, dhanmondi.code],
      [mirpur.id, 'MIR'],
    ]);

    // By month: each document on its own date, the months in the order of their net
    const byMonthRows = await sales(`${period()}&groupBy=month&sort=name`);
    expect(byMonthRows.items.map((row) => [row.month, row.net])).toEqual(byMonth(soldOn));
    expect(byMonthRows.items.every((row) => row.key === row.month && row.name === null)).toBe(true);
  });

  it('filters by branch, customer group and category, with the sub-categories', async () => {
    const atMirpur = await sales(`${period()}&branchId=${mirpur.id}`);
    expect(atMirpur.items.map(moneyOf)).toEqual([
      ['item', 'Karim Store', '855.0000', '171.0000', '684.0000'],
    ]);
    // The books of that branch: the sale by hand was in Dhanmondi
    expect(atMirpur.books).toBe('684.0000');

    // A walk-in has no group: the wholesale customers only
    const wholesaleOnly = await sales(`${period()}&customerGroupId=${wholesale}`);
    expect(wholesaleOnly.items.map(moneyOf)).toEqual([
      ['item', 'Karim Store', '855.0000', '171.0000', '684.0000'],
    ]);
    // The books know no customer group: nothing to compare with
    expect(wholesaleOnly.books).toBeNull();

    // Groceries is rice (in Rice, under it) and oil
    const inGroceries = await sales(`${period()}&groupBy=product&categoryId=${groceries}`);
    expect(inGroceries.items.map((row) => [row.name, row.net])).toEqual([
      ['Miniket rice 5 kg', '3950.0000'],
      ['Soybean oil 1 L', '684.0000'],
    ]);
    expect(inGroceries.totals.net).toBe('4634.0000');
    expect(inGroceries.books).toBeNull();
    // The sub-category alone
    const riceOnly = await sales(`${period()}&groupBy=category&categoryId=${riceCategory}`);
    expect(riceOnly.items.map((row) => [row.name, row.net])).toEqual([['Rice', '3950.0000']]);
  });

  it('counts both days at the ends of the period, and nothing outside it or not posted', async () => {
    // Rahim's invoice and Karim's are the first and the last day of this period
    const ends = await sales(`from=${day(-18)}&to=${day(-10)}`);
    expect(ends.items.map((row) => [row.name, row.net])).toEqual([
      ['Rahim Traders', '3600.0000'],
      ['Karim Store', '855.0000'],
    ]);
    const inside = await sales(`from=${day(-17)}&to=${day(-11)}`);
    expect(inside.items).toEqual([]);
    expect(inside.totals).toEqual({
      gross: '0.0000',
      returns: '0.0000',
      net: '0.0000',
      ...costColumns('0.0000', '0.0000'),
    });
    // The home delivery of 70 days ago, a service: no cost
    const old = await sales(`from=${day(-70)}&to=${day(-70)}&groupBy=product`);
    expect(old.items.map((row) => [row.name, row.net, row.cost])).toEqual([
      ['Home delivery', '100.0000', '0.0000'],
    ]);
    // Today: the POS sale and its return, never the draft of ৳9,999
    const now = await sales(`from=${today}&to=${today}`);
    expect(now.totals.net).toBe('520.0000');
  });

  it('sorts amounts as numbers, and puts the rows that are no one last', async () => {
    const keys = (report: SalesReport) => report.items.map((row) => row.name ?? row.kind);
    // ৳3,500, ৳684, ৳520: as text, 684 would come first
    expect(keys(await sales(`${period()}&sort=-net`))).toEqual([
      'Rahim Traders',
      'Karim Store',
      'walk_in',
    ]);
    expect(keys(await sales(`${period()}&sort=net`))).toEqual([
      'walk_in',
      'Karim Store',
      'Rahim Traders',
    ]);
    // The walk-ins have no name: last whichever way the names go
    expect(keys(await sales(`${period()}&sort=name`))).toEqual([
      'Karim Store',
      'Rahim Traders',
      'walk_in',
    ]);
    expect(keys(await sales(`${period()}&sort=-name`))).toEqual([
      'Rahim Traders',
      'Karim Store',
      'walk_in',
    ]);
    // Margins: Karim 6.4%, the walk-ins 17.1%, Rahim 13.1%
    expect(keys(await sales(`${period()}&sort=-marginPercent`))).toEqual([
      'walk_in',
      'Rahim Traders',
      'Karim Store',
    ]);
    expect(keys(await sales(`${period()}&sort=-returns`))).toEqual([
      'Karim Store',
      'Rahim Traders',
      'walk_in',
    ]);
    const byQuantity = await sales(`${period()}&groupBy=product&sort=-quantity`);
    expect(byQuantity.items.map((row) => row.quantity)).toEqual([
      '9.0000',
      '4.0000',
      '2.0000',
      '1.0000',
    ]);
    // A month sorts by its date, the newest first
    const months = await sales(`${period()}&groupBy=month&sort=-name`);
    expect(months.items.map((row) => row.month)).toEqual(
      byMonth(soldOn)
        .map(([month]) => month)
        .toReversed(),
    );
  });

  it('pages the rows, with the totals of all of them on every page', async () => {
    const all = await sales(`${period()}&groupBy=product&sort=name`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: SalesReport = await sales(
        `${period()}&groupBy=product&sort=name&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.totals).toEqual(all.totals);
      expect(page.books).toBe(all.books);
      seen.push(...page.items.map((row) => row.key));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((row) => row.key));
    expect(seen).toHaveLength(4);

    const broken = await send('GET', `/reports/sales?${period()}&cursor=not-a-cursor`);
    expect(broken.statusCode).toBe(400);
    expect(problemOf(broken).code).toBe('invalid_cursor');
  });

  it('shows the cost only with the stock value, and never sorts by it without', async () => {
    const report = await sales(period(), shirin);
    expect(report.withCost).toBe(false);
    expect(report.items.map(costOf)).toEqual([
      ['Rahim Traders', null, null, null],
      ['Karim Store', null, null, null],
      ['walk_in', null, null, null],
    ]);
    expect(report.totals).toEqual({
      gross: '5035.0000',
      returns: '331.0000',
      net: '4704.0000',
      cost: null,
      margin: null,
      marginPercent: null,
    });
    // The order of the rows would tell the hidden cost
    for (const sort of ['cost', '-margin', 'marginPercent']) {
      const refused = await send(
        'GET',
        `/reports/sales?${period()}&sort=${sort}`,
        undefined,
        shirin,
      );
      expect(refused.statusCode).toBe(403);
      expect(problemOf(refused)).toMatchObject({
        code: 'permission_missing',
        params: { permissions: 'inventory.stock.value' },
      });
    }
    // No report permission, no report
    expect((await send('GET', `/reports/sales?${period()}`, undefined, rafiq)).statusCode).toBe(
      403,
    );
  });

  it('refuses a quantity sort outside the product group, and a period the wrong way round', async () => {
    const byCustomer = await send('GET', `/reports/sales?${period()}&sort=quantity`);
    expect(problemOf(byCustomer).fieldErrors).toEqual({ sort: ['report_sort_invalid'] });
    const backwards = await send('GET', `/reports/sales?from=${today}&to=${day(-1)}`);
    expect(problemOf(backwards).fieldErrors).toEqual({ to: ['report_range_invalid'] });
    const unknownGroup = await send('GET', `/reports/sales?${period()}&groupBy=cashier`);
    expect(unknownGroup.statusCode).toBe(400);
  });
});

describe('The purchase report', () => {
  it('adds up bills and debit notes by supplier', async () => {
    const report = await purchases(period());
    expect(report.items.map(moneyOf)).toEqual([
      // The rent ৳12,000, ৳1,000 off
      ['item', 'Dhanmondi Properties Ltd.', '12000.0000', '1000.0000', '11000.0000'],
      // Sugar ৳2,500 and the van ৳300; ৳250 back with the bill, ৳120 without one
      ['item', 'Meghna Agro Mills', '2800.0000', '370.0000', '2430.0000'],
    ]);
    expect(report.totals).toEqual({
      gross: '14800.0000',
      returns: '1370.0000',
      net: '13430.0000',
    });
  });

  it('puts the lines with no product in one Expenses row, by product', async () => {
    const report = await purchases(`${period()}&groupBy=product`);
    expect(report.items.map(moneyOf)).toEqual([
      ['expenses', null, '12300.0000', '1000.0000', '11300.0000'],
      ['item', 'Sugar 1 kg', '2500.0000', '370.0000', '2130.0000'],
    ]);
    // 20 kg in, 2 back from the receipt, 1 back on its own; the Expenses row counts no quantity
    expect(report.items.map((row) => [row.kind, row.quantity, row.baseUnit?.code ?? null])).toEqual(
      [
        ['expenses', null, null],
        ['item', '17.0000', 'pcs'],
      ],
    );
    expect(report.items.map((row) => row.key)).toEqual(['expenses', sugar.id]);
    // The rows always add up to all purchases
    expect(report.totals.net).toBe('13430.0000');
  });

  it('puts the products in one Products row, by expense account', async () => {
    const report = await purchases(`${period()}&groupBy=account`);
    // The largest first: the Products row sorts by its net like any other
    expect(report.items.map((row) => [row.kind, row.code, row.name, row.net])).toEqual([
      ['item', '5220', 'Office rent', '11000.0000'],
      ['products', null, null, '2130.0000'],
      ['item', '5240', 'Transport and conveyance', '300.0000'],
    ]);
    expect(report.totals.net).toBe('13430.0000');
  });

  it('groups by month, and leaves the draft bill out', async () => {
    const report = await purchases(`${period()}&groupBy=month&sort=name`);
    expect(report.items.map((row) => [row.month, row.net])).toEqual(byMonth(boughtOn));
  });

  it('filters by supplier group, category and branch', async () => {
    const mills = await purchases(`${period()}&supplierGroupId=${localMills}`);
    expect(mills.items.map((row) => [row.name, row.net])).toEqual([
      ['Meghna Agro Mills', '2430.0000'],
    ]);
    // A category is a product's: the van hire and the rent have none, so they drop out
    const inGroceries = await purchases(`${period()}&groupBy=account&categoryId=${groceries}`);
    expect(inGroceries.items.map((row) => [row.kind, row.net])).toEqual([
      ['products', '2130.0000'],
    ]);
    // Every bill here was the Dhanmondi shop's
    const atMirpur = await purchases(`${period()}&branchId=${mirpur.id}`);
    expect(atMirpur.items).toEqual([]);
    expect(atMirpur.totals.net).toBe('0.0000');
  });

  it('sorts a quantity by product, with the Expenses row last either way', async () => {
    for (const sort of ['quantity', '-quantity']) {
      const report = await purchases(`${period()}&groupBy=product&sort=${sort}`);
      expect(report.items.map((row) => row.kind)).toEqual(['item', 'expenses']);
    }
    for (const sort of ['name', '-name']) {
      const report = await purchases(`${period()}&groupBy=account&sort=${sort}`);
      expect(report.items.map((row) => row.kind).at(-1)).toBe('products');
    }
    const refused = await send('GET', `/reports/purchases?${period()}&sort=-quantity`);
    expect(problemOf(refused).fieldErrors).toEqual({ sort: ['report_sort_invalid'] });
  });

  it('needs the purchase report permission, not the cost', async () => {
    const report = await purchases(period(), shirin);
    expect(report.totals.net).toBe('13430.0000');
    expect((await send('GET', `/reports/purchases?${period()}`, undefined, rafiq)).statusCode).toBe(
      403,
    );
  });
});
```

**The world.** Shapla Super Store, a retail workspace: a shop in Dhanmondi (the main branch, its `MAIN` store) and a
second shop in Mirpur. Retail, because it is the industry with POS registers, so one workspace has invoices and POS
sales together. Every document is chosen so that a mistake moves a number you can see:

- **Rahim Traders** gets a challan of 10 bags of rice, 2 come back before the bill, and the invoice bills the other 8.
  So the invoice line's cost must be 8 of the challan line's 10 (decision 33): ৳3,040, not ৳3,800. Then a credit
  note cuts the price by ৳100 with no goods back: money off, but no quantity and no cost.
- **Karim Store** is in the Wholesale group and buys 5 bottles of oil at 10% off on a direct invoice from the Mirpur
  shop. One bottle comes back with a credit note for it: ৳171 and its cost of ৳160 back, in the invoice's branch.
- **A walk-in at the POS** buys rice, two soaps of two scents (one product with two variants, decision 12) and two
  boxes of matches (a product with no category). The lime soap comes back on a POS return.
- **The purchases:** 20 kg of sugar from Meghna Agro Mills (in the Local mills group), received and billed at ৳125
  with a van hire (an account line, `5240`); 2 kg back after the bill with a debit note; 1 kg back with no receipt
  behind it on a debit note without a bill; and the rent of Dhanmondi Properties as a bill expense, ৳1,000 of it taken
  off by a debit note.
- **What must not count:** an invoice 70 days ago (outside the period), a draft invoice of ৳9,999 and a draft bill.
  And a ৳500 cash sale written by hand in the journal: the books have it, the documents do not.

**Why rice is never bought.** The cost is a moving average for the whole company (step 14). If the test bought rice,
every later sale of rice would cost a new average, and the numbers in the test would be ৳381.67 and so on. Sugar is
bought and never sold, rice is sold and never bought, so every cost in the test is a round number you can check by
hand.

**The helpers.**

- **`day()` and today from the workspace's time zone:** every document is dated a number of days before today, like
  the dashboard's suite, so the suite runs on any day. The POS sale and its return are today's, like their shift.
- **`soldOn` and `boughtOn`** record each document's day and net as the test posts it. `byMonth()` adds them up by
  month, so the month rows can be checked on any day: on the 3rd of a month, 18 days ago is last month.
- **`moneyOf()` and `costOf()`** turn a row into a short list, so one `toEqual` shows every column of every row, and
  a failure shows which number is wrong.
- **`costColumns()` from the contract** gives the expected margin and percent. The test checks the cost itself by
  hand; the margin's rounding is the contract's, the same function the page and the mock use.
- **`categoryOf()`** finds the retail template's own categories ("Groceries", with "Rice" under it). Making new ones
  with the same names is refused (`category_name_taken`): the template made them at setup.
- **`sellAtTheCounter()`** is the POS part in one place: a register, a device that takes it, a shift, a sale and a
  return, pushed through `/sync/push` as a device would. The return's money comes from `posReturnAmounts()`, the
  device's own sum.

**The tests**, in their order:

- **By customer** (the default group, the largest first): every kind of document in its row, the walk-ins in one row
  with `kind: 'walk_in'` and no id. The totals are the sum of the rows, and `books` is ৳500 more than the net: the
  sale written by hand. No quantity outside the product group.
- **By product:** the rice is 9 (8 billed and 1 at the counter; the price cut takes none back), the soap is one row
  for both scents, 1 left after the lime came back.
- **By category, branch and month:** the rice is in "Rice", not in "Groceries" above it (decision 13); the matches are
  the "No category" row. A credit note counts in its invoice's branch; the POS return in its store's.
- **The filters:** the Mirpur shop has only Karim's invoice, and the books of that branch agree. The Wholesale group
  leaves the walk-ins out, and its `books` is `null`: the journal knows no customer group (decision 19). Groceries
  takes the rice too, because "Rice" is under it.
- **The ends of the period:** Rahim's invoice is on the first day and Karim's on the last; one day in from each end,
  nothing. The invoice of 70 days ago shows only when the period reaches it, and the draft never.
- **The sorts:** the nets ৳3,500, ৳684 and ৳520 are chosen so that a sort by text would put ৳684 first: this is the
  `g.net` trap of 21b.3. The walk-ins are last by name either way. The margin percents differ, the quantities by
  product, and a month sorts by its date.
- **The pages:** three rows at a time, the same totals on every page, and the pages together are the whole list in
  the same order. A broken cursor is `invalid_cursor` (400), not a server error.
- **The cost:** Shirin reads both reports but not the stock value. She gets the same rows with `null` cost columns,
  and a sort by the cost, the margin or its percent is 403 `permission_missing` with the key. Rafiq has no role and
  gets no report.
- **The purchase report** by supplier, product (one "Expenses" row with no quantity, decision 11), expense account
  (one "Products" row) and month; filtered by supplier group, by category (the van hire and the rent have no product,
  so they drop out) and by branch.
- **The quantity sort** puts the "Expenses" row last both ways. This test failed against the first 21b.3 code; see
  decision 42.

### `reports/aging.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  type AgingReport,
  agingBucketOf,
  agingReportSchema,
  apAgingPartySchema,
  arAgingPartySchema,
  accountListSchema,
  type Bill,
  billSchema,
  type Branch,
  branchListSchema,
  creditNoteSchema,
  type Customer,
  customerGroupSchema,
  customerSchema,
  debitNoteSchema,
  type Invoice,
  invoiceSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  type Receipt,
  receiptSchema,
  refundSchema,
  roleSchema,
  memberPageSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  type Supplier,
  supplierGroupSchema,
  type SupplierPayment,
  supplierPaymentSchema,
  supplierRefundSchema,
  supplierSchema,
  type TaxRate,
  taxRateListSchema,
  todayIn,
  unitListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';

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

// Step 21b. Surma Distributors in Sylhet bills pharmacies for delivery and handling (a service, so
// no stock is needed) and pays its suppliers' bills. Every amount is VAT exempt, so a document's
// total is its net. Each customer and supplier shows one thing the aging must get right on any
// day, and every as-of answer is checked against the ledger, which knows nothing of due dates or
// allocations:
// - Agrabad Medicine Corner: eight invoices due on the edge days of the buckets;
// - Tamanna Pharmacy: a receipt with money left over, an advance applied today, a credit note;
// - Halishahar Pharmacy: a receipt voided later (the known gap of decision 5);
// - Sylhet Pharmacy: only an advance, with a refund that was voided;
// - Chawkbazar Store: a credit note on a paid invoice, kept as an advance;
// - Zindabazar Store and Juki Parts Centre: money applied again (the day of each allocation);
// - Padma Yarn Traders: a posted payment, a draft, one waiting for approval, a voided one and a
//   debit note; Meghna Poly Packaging: an advance, a debit note on a paid bill and a refund.
// The documents are dated a number of days before today, so the tests run on any day.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: the allocations' applied_on, which no route shows
let sql: postgres.Sql;
let owner: SignedIn;
// Reads the sales reports only
let shirin: SignedIn;
// Pays suppliers; not the Owner, so a payment over the level waits for approval
let rina: SignedIn;
let today: string;
let accounts: Account[];
let exempt: TaxRate;
let pcs: string;
let branch: Branch;
let handling: Product;
let pharmacies: string;
let yarnMills: string;
let agrabad: Customer;
let tamanna: Customer;
let halishahar: Customer;
let sylhet: Customer;
let chawkbazar: Customer;
let zindabazar: Customer;
// Never billed
let lalbagh: Customer;
let padma: Supplier;
let meghna: Supplier;
let juki: Supplier;
let tamannaInvoice: Invoice;
let zindabazarReceipt: Receipt;
let zindabazarInvoices: Invoice[];
let jukiPayment: SupplierPayment;
let jukiBills: Bill[];
let draftPayment: SupplierPayment;

const day = (days: number) => shiftIsoDate(today, days);

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

async function created<T>(schema: z.ZodType<T>, url: string, payload: object): Promise<T> {
  const res = await send('POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function changed<T>(
  schema: z.ZodType<T>,
  method: 'POST' | 'PUT',
  url: string,
  payload: object,
) {
  const res = await send(method, url, payload);
  expect(res.statusCode, res.body).toBe(200);
  return schema.parse(res.json());
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

async function receivables(query: string, as = owner): Promise<AgingReport> {
  const res = await send('GET', `/reports/ar-aging?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return agingReportSchema.parse(res.json());
}

async function payables(query: string, as = owner): Promise<AgingReport> {
  const res = await send('GET', `/reports/ap-aging?${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return agingReportSchema.parse(res.json());
}

async function customerPage(customerId: string, asOf: string) {
  const res = await send('GET', `/reports/ar-aging/${customerId}?asOf=${asOf}`);
  expect(res.statusCode, res.body).toBe(200);
  return arAgingPartySchema.parse(res.json());
}

async function supplierPage(supplierId: string, asOf: string) {
  const res = await send('GET', `/reports/ap-aging/${supplierId}?asOf=${asOf}`);
  expect(res.statusCode, res.body).toBe(200);
  return apAgingPartySchema.parse(res.json());
}

// A row as the test reads it: the name, then current, 1–30, 31–60, 61–90, over 90, advances and
// balance, in whole taka (every amount here is)
function rowOf(row: AgingReport['items'][number]) {
  return [
    row.party.name,
    ...[
      row.current,
      row.days1To30,
      row.days31To60,
      row.days61To90,
      row.over90,
      row.advances,
      row.balance,
    ].map(Number),
  ];
}

function rowNamed(report: AgingReport, name: string) {
  const found = report.items.find((row) => row.party.name === name);
  if (!found) throw new Error(`no row for ${name}`);
  return rowOf(found);
}

function accountId(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) throw new Error(`not one ${what}`);
  return first;
}

async function addCustomer(name: string, groupId = ''): Promise<Customer> {
  return created(customerSchema, '/customers', {
    code: '',
    name,
    groupId,
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 0,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
}

async function addSupplier(name: string, groupId = ''): Promise<Supplier> {
  return created(supplierSchema, '/suppliers', {
    code: '',
    name,
    groupId,
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 0,
    address: '',
    bankAccounts: [],
    notes: '',
  });
}

// An invoice for delivery and handling, dated and due on the days given
async function invoiced(customer: Customer, date: string, dueDate: string, amount: string) {
  const invoice = await created(invoiceSchema, '/invoices', {
    customerId: customer.id,
    date,
    dueDate,
    customerReference: '',
    branchId: branch.id,
    warehouseId: '',
    note: '',
    lines: [
      {
        variantId: variantOf(handling),
        unitId: pcs,
        quantity: '1',
        description: '',
        unitPrice: amount,
        discountType: 'percent',
        discount: '',
        taxRateId: exempt.id,
        deliveryLineId: '',
        orderLineId: '',
        batchId: '',
        serialNumbers: [],
      },
    ],
    post: true,
  });
  expect(invoice.total).toBe(`${amount}.0000`);
  return invoice;
}

async function received(
  customer: Customer,
  date: string,
  amount: string,
  allocations: { invoice: Invoice; amount: string }[],
): Promise<Receipt> {
  return created(receiptSchema, '/receipts', {
    customerId: customer.id,
    date,
    amount,
    accountId: accountId('1110'),
    method: 'cash',
    reference: '',
    branchId: branch.id,
    note: '',
    allocations: allocations.map((item) => ({ invoiceId: item.invoice.id, amount: item.amount })),
  });
}

// A credit note that only cuts the price: one line of the invoice, `amount` off
async function credited(invoice: Invoice, date: string, amount: string) {
  return created(creditNoteSchema, '/credit-notes', {
    invoiceId: invoice.id,
    date,
    reason: 'price_adjustment',
    note: '',
    lines: [
      {
        invoiceLineId: only(invoice.lines, 'invoice line').id,
        returnLineId: '',
        unitId: pcs,
        quantity: '1',
        description: '',
        unitPrice: amount,
        discountType: 'percent',
        discount: '',
      },
    ],
    post: true,
  });
}

// A bill with one expense and no goods, posted when submitted (no bill levels are set)
async function billed(supplier: Supplier, date: string, dueDate: string, amount: string) {
  const bill = await created(billSchema, '/bills', {
    supplierId: supplier.id,
    date,
    dueDate,
    supplierBillNumber: `${supplier.code}-${date}-${amount}`,
    mushakNumber: '',
    mushakDate: '',
    branchId: branch.id,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: accountId('5240'),
        description: 'Carriage and handling',
        amount,
        taxRateId: exempt.id,
      },
    ],
    submit: true,
  });
  expect(bill).toMatchObject({ status: 'posted', total: `${amount}.0000` });
  return bill;
}

function paymentForm(
  supplier: Supplier,
  date: string,
  amount: string,
  allocations: { bill: Bill; amount: string }[],
  submit = true,
) {
  return {
    supplierId: supplier.id,
    date,
    amount,
    accountId: accountId('1110'),
    method: 'cash',
    reference: '',
    supplierBankAccountId: '',
    branchId: branch.id,
    orderId: '',
    note: '',
    allocations: allocations.map((item) => ({ billId: item.bill.id, amount: item.amount })),
    submit,
  };
}

async function paid(
  supplier: Supplier,
  date: string,
  amount: string,
  allocations: { bill: Bill; amount: string }[],
  submit = true,
): Promise<SupplierPayment> {
  return created(
    supplierPaymentSchema,
    '/supplier-payments',
    paymentForm(supplier, date, amount, allocations, submit),
  );
}

// A debit note that takes money off the bill's one expense
async function debited(bill: Bill, date: string, amount: string) {
  return created(debitNoteSchema, '/debit-notes', {
    supplierId: bill.supplier.id,
    billId: bill.id,
    date,
    branchId: '',
    pricesIncludeVat: false,
    reason: 'price_adjustment',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines: [],
    expenses: [{ billExpenseId: only(bill.expenses, 'expense').id, amount }],
    post: true,
  });
}

function voidForm(version: number, date: string) {
  return { version, date, reason: 'The cheque bounced' };
}

// The four allocation tables: the paying document's column, and the documents it pays
const ALLOCATIONS = {
  receipt: { table: 'receipt_allocations', from: 'receipt_id', to: 'invoice_id', paid: 'invoices' },
  credit_note: {
    table: 'credit_note_allocations',
    from: 'credit_note_id',
    to: 'invoice_id',
    paid: 'invoices',
  },
  payment: {
    table: 'supplier_payment_allocations',
    from: 'payment_id',
    to: 'bill_id',
    paid: 'bills',
  },
  debit_note: {
    table: 'debit_note_allocations',
    from: 'debit_note_id',
    to: 'bill_id',
    paid: 'bills',
  },
} as const;

// The day each allocation of a paying document counts, as [invoice or bill number, amount, day]
async function appliedOn(
  kind: keyof typeof ALLOCATIONS,
  id: string,
): Promise<[string, string, string][]> {
  const of = ALLOCATIONS[kind];
  const rows = await sql<{ number: string; amount: string; applied_on: string }[]>`
    SELECT d.number, round(a.amount)::text AS amount, a.applied_on::text AS applied_on
      FROM ${sql(of.table)} a
      JOIN ${sql(of.paid)} d ON d.id = a.${sql(of.to)}
     WHERE a.${sql(of.from)} = ${id}
     ORDER BY d.number`;
  return rows.map((row) => [row.number, row.amount, row.applied_on]);
}

// A member of the workspace with one role of exactly these permissions
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'surma-distributors' });
  const role = await created(roleSchema, '/roles', {
    name: `${person.fullName}'s role`,
    description: '',
  });
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === person.email);
  if (!found) throw new Error(`${person.email} is not a member`);
  const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(roles.statusCode, roles.body).toBe(200);
  return logIn(app, {
    workspace: 'surma-distributors',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
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
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Surma Distributors',
    workspaceSlug: 'surma-distributors',
    fullName: 'Nasrin Chowdhury',
    email: 'nasrin@surmadistributors.com',
    password: 'Zindabazar-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);
  const [first] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
  if (!first) throw new Error('sign-up made no branch');
  branch = first;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const rate = taxRateListSchema
    .parse((await send('GET', '/tax-rates')).json())
    .items.find((item) => item.name === 'Exempt');
  if (!rate) throw new Error('no Exempt rate');
  exempt = rate;
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  handling = await created(productSchema, '/products', {
    code: '',
    name: 'Delivery and handling',
    type: 'service',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
  });
  pharmacies = (await created(customerGroupSchema, '/customer-groups', { name: 'Pharmacies' })).id;
  yarnMills = (await created(supplierGroupSchema, '/supplier-groups', { name: 'Yarn mills' })).id;
  agrabad = await addCustomer('Agrabad Medicine Corner');
  tamanna = await addCustomer('Tamanna Pharmacy', pharmacies);
  halishahar = await addCustomer('Halishahar Pharmacy', pharmacies);
  sylhet = await addCustomer('Sylhet Pharmacy', pharmacies);
  chawkbazar = await addCustomer('Chawkbazar Store');
  zindabazar = await addCustomer('Zindabazar Store');
  lalbagh = await addCustomer('Lalbagh Store');
  padma = await addSupplier('Padma Yarn Traders', yarnMills);
  meghna = await addSupplier('Meghna Poly Packaging');
  juki = await addSupplier('Juki Parts Centre');

  shirin = await memberWith(
    {
      fullName: 'Shirin Akter',
      email: 'shirin@surmadistributors.com',
      password: 'Sales-desk-2026',
    },
    ['sales.report.read'],
  );
  rina = await memberWith(
    { fullName: 'Rina Begum', email: 'rina@surmadistributors.com', password: 'Payments-desk-2026' },
    ['purchase.payment.manage'],
  );
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('The documents', () => {
  // Dozens of documents go through the API here, so the 5 seconds of a normal test are not enough
  // when the whole suite runs at once.
  it('are posted over the last three months', async () => {
    // Agrabad: ৳100 due today, ৳200 a day ago, ৳300 30 days ago … ৳800 91 days ago
    for (const [index, days] of [0, 1, 30, 31, 60, 61, 90, 91].entries()) {
      await invoiced(agrabad, day(-days), day(-days), String((index + 1) * 100));
    }

    // Tamanna: ৳10,000, due 10 days ago. ৳5,000 came 20 days ago, ৳4,000 of it for the invoice;
    // ৳3,000 more 15 days ago with no invoice named; ৳500 off by a credit note 8 days ago; and
    // today the ৳3,000 is applied to the invoice
    tamannaInvoice = await invoiced(tamanna, day(-40), day(-10), '10000');
    await received(tamanna, day(-20), '5000', [{ invoice: tamannaInvoice, amount: '4000' }]);
    const advance = await received(tamanna, day(-15), '3000', []);
    await credited(tamannaInvoice, day(-8), '500');
    await changed(receiptSchema, 'PUT', `/receipts/${advance.id}/allocations`, {
      version: advance.version,
      allocations: [{ invoiceId: tamannaInvoice.id, amount: '3000' }],
    });

    // Halishahar: ৳2,000, paid 20 days ago by a cheque that bounced 5 days ago
    const halishaharInvoice = await invoiced(halishahar, day(-30), day(-30), '2000');
    const cheque = await received(halishahar, day(-20), '2000', [
      { invoice: halishaharInvoice, amount: '2000' },
    ]);
    await changed(
      receiptSchema,
      'POST',
      `/receipts/${cheque.id}/void`,
      voidForm(cheque.version, day(-5)),
    );

    // Sylhet: ৳5,000 in advance 20 days ago; ৳1,000 of it paid back 15 days ago, but that refund
    // was voided 5 days ago
    const sylhetAdvance = await received(sylhet, day(-20), '5000', []);
    const refund = await created(refundSchema, '/refunds', {
      customerId: sylhet.id,
      date: day(-15),
      amount: '1000',
      accountId: accountId('1110'),
      method: 'cash',
      reference: '',
      branchId: branch.id,
      note: '',
      receiptId: sylhetAdvance.id,
      creditNoteId: '',
    });
    await changed(
      refundSchema,
      'POST',
      `/refunds/${refund.id}/void`,
      voidForm(refund.version, day(-5)),
    );

    // Chawkbazar: ৳1,150 paid in full the next day, then ৳150 off: the credit note has nothing
    // left to take off, so it is money the shop owes Chawkbazar
    const chawkbazarInvoice = await invoiced(chawkbazar, day(-12), day(-12), '1150');
    await received(chawkbazar, day(-11), '1150', [{ invoice: chawkbazarInvoice, amount: '1150' }]);
    await credited(chawkbazarInvoice, day(-6), '150');

    // Zindabazar: two invoices of ৳1,000, a receipt of ৳1,500 dated before the second one
    zindabazarInvoices = [
      await invoiced(zindabazar, day(-30), day(-30), '1000'),
      await invoiced(zindabazar, day(-28), day(-28), '1000'),
    ];
    zindabazarReceipt = await received(zindabazar, day(-29), '1500', [
      { invoice: zindabazarInvoices[0] ?? tamannaInvoice, amount: '1000' },
      { invoice: zindabazarInvoices[1] ?? tamannaInvoice, amount: '500' },
    ]);

    // Padma: ৳20,000 due 10 days ago and ৳5,000 due in 10 days. Posted: ৳8,000 15 days ago and
    // ৳2,000 25 days ago (voided 2 days ago); ৳1,000 off by a debit note 5 days ago. Not in the
    // books: a draft of ৳5,000 and a payment of ৳60,000 waiting for the finance manager.
    const yarn = await billed(padma, day(-40), day(-10), '20000');
    const lateYarn = await billed(padma, day(-20), day(10), '5000');
    await paid(padma, day(-15), '8000', [{ bill: yarn, amount: '8000' }]);
    const bounced = await paid(padma, day(-25), '2000', [{ bill: yarn, amount: '2000' }]);
    await debited(yarn, day(-5), '1000');
    await changed(
      supplierPaymentSchema,
      'POST',
      `/supplier-payments/${bounced.id}/void`,
      voidForm(bounced.version, day(-2)),
    );
    draftPayment = await paid(padma, day(-9), '5000', [{ bill: lateYarn, amount: '5000' }], false);
    expect(draftPayment.status).toBe('draft');
    const financeManager = await created(roleSchema, '/roles', {
      name: 'Finance manager',
      description: '',
    });
    const rule = await send('PUT', '/approval-rules/supplier_payment', {
      levels: [{ minAmount: '50000', roleId: financeManager.id }],
      version: 0,
    });
    expect(rule.statusCode, rule.body).toBe(200);
    // An Owner's own payment is approved at once (step 17c): the clerk writes this one
    const asked = await send(
      'POST',
      '/supplier-payments',
      paymentForm(padma, day(-3), '60000', [{ bill: yarn, amount: '5000' }]),
      rina,
    );
    expect(asked.statusCode, asked.body).toBe(201);
    expect(supplierPaymentSchema.parse(asked.json()).status).toBe('pending');

    // Meghna: ৳1,000 billed 14 days ago, paid with ৳3,000 12 days ago; ৳200 off after it was paid;
    // ৳500 of the advance paid back 3 days ago
    const poly = await billed(meghna, day(-14), day(-14), '1000');
    const polyPayment = await paid(meghna, day(-12), '3000', [{ bill: poly, amount: '1000' }]);
    await debited(poly, day(-6), '200');
    await created(supplierRefundSchema, '/supplier-refunds', {
      supplierId: meghna.id,
      date: day(-3),
      amount: '500',
      accountId: accountId('1110'),
      method: 'cash',
      reference: '',
      branchId: branch.id,
      note: '',
      debitNoteId: '',
      paymentId: polyPayment.id,
    });

    // Juki: two bills of ৳1,000 and a payment of ৳1,500, as Zindabazar's
    jukiBills = [
      await billed(juki, day(-10), day(-10), '1000'),
      await billed(juki, day(-9), day(-9), '1000'),
    ];
    jukiPayment = await paid(juki, day(-11), '1500', [
      { bill: jukiBills[0] ?? yarn, amount: '1000' },
      { bill: jukiBills[1] ?? yarn, amount: '500' },
    ]);
  }, 120_000);
});

describe('The day an allocation counts', () => {
  it("is the receipt's date, or the invoice's when that is later", async () => {
    // The receipt is dated 29 days ago, the second invoice 28: it was paid when it was billed
    expect(await appliedOn('receipt', zindabazarReceipt.id)).toEqual([
      [zindabazarInvoices[0]?.number, '1000', day(-29)],
      [zindabazarInvoices[1]?.number, '500', day(-28)],
    ]);
    const [credit] = await sql<{ id: string }[]>`
      SELECT id FROM credit_notes WHERE invoice_id = ${tamannaInvoice.id}`;
    expect(await appliedOn('credit_note', credit?.id ?? '')).toEqual([
      [tamannaInvoice.number, '500', day(-8)],
    ]);
  });

  it('is today when the money is applied again, and stays for a pair that did not change', async () => {
    // ৳100 of the second invoice goes back to the advance: the first pair keeps its day
    zindabazarReceipt = await changed(
      receiptSchema,
      'PUT',
      `/receipts/${zindabazarReceipt.id}/allocations`,
      {
        version: zindabazarReceipt.version,
        allocations: [
          { invoiceId: zindabazarInvoices[0]?.id ?? '', amount: '1000.00' },
          { invoiceId: zindabazarInvoices[1]?.id ?? '', amount: '400' },
        ],
      },
    );
    expect(await appliedOn('receipt', zindabazarReceipt.id)).toEqual([
      [zindabazarInvoices[0]?.number, '1000', day(-29)],
      [zindabazarInvoices[1]?.number, '400', today],
    ]);

    // The same for a posted supplier payment
    expect(await appliedOn('payment', jukiPayment.id)).toEqual([
      [jukiBills[0]?.number, '1000', day(-10)],
      [jukiBills[1]?.number, '500', day(-9)],
    ]);
    jukiPayment = await changed(
      supplierPaymentSchema,
      'PUT',
      `/supplier-payments/${jukiPayment.id}/allocations`,
      {
        version: jukiPayment.version,
        allocations: [
          { billId: jukiBills[0]?.id ?? '', amount: '1000' },
          { billId: jukiBills[1]?.id ?? '', amount: '400' },
        ],
      },
    );
    expect(await appliedOn('payment', jukiPayment.id)).toEqual([
      [jukiBills[0]?.number, '1000', day(-10)],
      [jukiBills[1]?.number, '400', today],
    ]);
  });

  it("follows a draft payment's date, which posts with it", async () => {
    const yarn = only(draftPayment.allocations, 'allocation');
    expect(await appliedOn('payment', draftPayment.id)).toEqual([
      [yarn.billNumber, '5000', day(-9)],
    ]);
    const form = paymentForm(padma, day(-7), '5000', [], false);
    draftPayment = await changed(
      supplierPaymentSchema,
      'PUT',
      `/supplier-payments/${draftPayment.id}`,
      {
        ...form,
        allocations: [{ billId: yarn.billId, amount: '5000' }],
        version: draftPayment.version,
      },
    );
    expect(await appliedOn('payment', draftPayment.id)).toEqual([
      [yarn.billNumber, '5000', day(-7)],
    ]);
  });
});

describe('The receivables aging', () => {
  it('puts each invoice in its bucket by the days past its due date', async () => {
    const report = await receivables(`asOf=${today}`);
    // Current up to and on the due date; 30 days late is still 1–30, 31 is 31–60, and so on
    expect(rowNamed(report, 'Agrabad Medicine Corner')).toEqual([
      'Agrabad Medicine Corner',
      100,
      500,
      900,
      1300,
      800,
      0,
      3600,
    ]);
    // A day earlier, every invoice is a day less late, and the one of today is not there yet
    const yesterday = await receivables(`asOf=${day(-1)}`);
    expect(rowNamed(yesterday, 'Agrabad Medicine Corner')).toEqual([
      'Agrabad Medicine Corner',
      200,
      700,
      1100,
      1500,
      0,
      0,
      3500,
    ]);
    // The party's page puts each invoice in the bucket of the contract's agingBucketOf(), and its
    // totals are the report's row worked out in SQL: the two agree on every edge day, a month
    // ahead too
    for (const asOf of [today, day(-1), day(30)]) {
      const page = await customerPage(agrabad.id, asOf);
      const row = (await receivables(`asOf=${asOf}`)).items.find(
        (item) => item.party.id === agrabad.id,
      );
      expect(page.totals).toEqual({ ...row, party: undefined, ...page.totals });
      expect(row).toMatchObject(page.totals);
      for (const document of page.documents) {
        expect(document.bucket).toBe(agingBucketOf(document.dueDate, asOf));
      }
    }
    const page = await customerPage(agrabad.id, today);
    expect(page.documents.map((item) => [item.dueDate, item.daysOverdue, item.bucket])).toEqual([
      [day(-91), 91, 'over90'],
      [day(-90), 90, 'days61To90'],
      [day(-61), 61, 'days61To90'],
      [day(-60), 60, 'days31To60'],
      [day(-31), 31, 'days31To60'],
      [day(-30), 30, 'days1To30'],
      [day(-1), 1, 'days1To30'],
      [today, 0, 'current'],
    ]);
  });

  it('takes off on a past day only what was applied by then', async () => {
    const tamannaOn = async (asOf: string) =>
      rowNamed(await receivables(`asOf=${asOf}`), 'Tamanna Pharmacy');
    // Before any money: the whole invoice, not due yet
    expect(await tamannaOn(day(-21))).toEqual(['Tamanna Pharmacy', 10000, 0, 0, 0, 0, 0, 10000]);
    // ৳4,000 applied, ৳1,000 and ৳3,000 held as advances
    expect(await tamannaOn(day(-9))).toEqual(['Tamanna Pharmacy', 0, 6000, 0, 0, 0, 4000, 2000]);
    // The credit note's ৳500 counts from its own day
    expect(await tamannaOn(day(-1))).toEqual(['Tamanna Pharmacy', 0, 5500, 0, 0, 0, 4000, 1500]);
    // Today the ৳3,000 is on the invoice: the balance stays, the buckets move
    expect(await tamannaOn(today)).toEqual(['Tamanna Pharmacy', 0, 2500, 0, 0, 0, 1000, 1500]);
    const page = await customerPage(tamanna.id, day(-1));
    expect(page.advances.map((item) => [item.kind, item.date, item.amount])).toEqual([
      ['receipt', day(-20), '1000.0000'],
      ['receipt', day(-15), '3000.0000'],
    ]);
    expect(page.documents.map((item) => [item.number, item.total, item.open])).toEqual([
      [tamannaInvoice.number, '10000.0000', '5500.0000'],
    ]);
    expect(page.ledger).toBe('1500.0000');
  });

  it('shows a voided receipt as an advance until its void day, so the balance is the books', async () => {
    const halishaharOn = async (asOf: string) =>
      rowNamed(await receivables(`asOf=${asOf}`), 'Halishahar Pharmacy');
    expect(await halishaharOn(day(-25))).toEqual([
      'Halishahar Pharmacy',
      0,
      2000,
      0,
      0,
      0,
      0,
      2000,
    ]);
    // The void deleted the allocation: the invoice shows open, the cheque as an advance
    expect(await halishaharOn(day(-10))).toEqual([
      'Halishahar Pharmacy',
      0,
      2000,
      0,
      0,
      0,
      2000,
      0,
    ]);
    expect((await customerPage(halishahar.id, day(-10))).ledger).toBe('0.0000');
    expect(await halishaharOn(today)).toEqual(['Halishahar Pharmacy', 0, 2000, 0, 0, 0, 0, 2000]);
  });

  it('counts a refund until it is voided, and an advance alone is a row', async () => {
    const sylhetOn = async (asOf: string) =>
      rowNamed(await receivables(`asOf=${asOf}`), 'Sylhet Pharmacy');
    expect(await sylhetOn(day(-17))).toEqual(['Sylhet Pharmacy', 0, 0, 0, 0, 0, 5000, -5000]);
    expect(await sylhetOn(day(-10))).toEqual(['Sylhet Pharmacy', 0, 0, 0, 0, 0, 4000, -4000]);
    expect(await sylhetOn(today)).toEqual(['Sylhet Pharmacy', 0, 0, 0, 0, 0, 5000, -5000]);

    // A paid invoice is no row; the credit note after it is an advance of its own kind
    const before = await receivables(`asOf=${day(-7)}`);
    expect(before.items.map((row) => row.party.name)).not.toContain('Chawkbazar Store');
    const page = await customerPage(chawkbazar.id, today);
    expect(page.documents).toEqual([]);
    expect(page.advances.map((item) => [item.kind, item.amount])).toEqual([
      ['credit_note', '150.0000'],
    ]);
    expect(page.totals).toMatchObject({
      due: '0.0000',
      advances: '150.0000',
      balance: '-150.0000',
    });

    // The customer with nothing has no row, but its page is there, empty
    const report = await receivables(`asOf=${today}`);
    expect(report.items.map((row) => row.party.id)).not.toContain(lalbagh.id);
    expect((await customerPage(lalbagh.id, today)).totals.balance).toBe('0.0000');
  });

  it('adds up to the ledger on every day, and sorts by the balance', async () => {
    const report = await receivables(`asOf=${today}`);
    expect(report.items.map(rowOf)).toEqual([
      ['Agrabad Medicine Corner', 100, 500, 900, 1300, 800, 0, 3600],
      ['Halishahar Pharmacy', 0, 2000, 0, 0, 0, 0, 2000],
      ['Tamanna Pharmacy', 0, 2500, 0, 0, 0, 1000, 1500],
      // ৳600 of the second invoice open, ৳100 left of the receipt
      ['Zindabazar Store', 0, 600, 0, 0, 0, 100, 500],
      ['Chawkbazar Store', 0, 0, 0, 0, 0, 150, -150],
      ['Sylhet Pharmacy', 0, 0, 0, 0, 0, 5000, -5000],
    ]);
    expect(report.totals).toEqual({
      current: '100.0000',
      days1To30: '5600.0000',
      days31To60: '900.0000',
      days61To90: '1300.0000',
      over90: '800.0000',
      due: '8700.0000',
      advances: '6250.0000',
      balance: '2450.0000',
    });
    expect(report.asOf).toBe(today);
    expect(report.ledger).toBe('2450.0000');
    // Every day of the story, and a year back with nothing yet
    for (const asOf of [
      day(-400),
      day(-91),
      day(-29),
      day(-20),
      day(-12),
      day(-6),
      day(-1),
      day(30),
    ]) {
      const past = await receivables(`asOf=${asOf}`);
      expect(past.ledger, asOf).toBe(past.totals.balance);
      for (const row of past.items) {
        const page = await customerPage(row.party.id, asOf);
        expect(page.ledger, `${row.party.name} on ${asOf}`).toBe(row.balance);
      }
    }
    expect((await receivables(`asOf=${day(-400)}`)).items).toEqual([]);
  });

  it('pages, filters by group and shows only the overdue', async () => {
    const all = await receivables(`asOf=${today}&sort=name`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AgingReport = await receivables(
        `asOf=${today}&sort=name&limit=4${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.totals).toEqual(all.totals);
      expect(page.ledger).toBe(all.ledger);
      seen.push(...page.items.map((row) => row.party.name));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([
      'Agrabad Medicine Corner',
      'Chawkbazar Store',
      'Halishahar Pharmacy',
      'Sylhet Pharmacy',
      'Tamanna Pharmacy',
      'Zindabazar Store',
    ]);

    const group = await receivables(`asOf=${today}&customerGroupId=${pharmacies}&sort=-advances`);
    expect(group.items.map((row) => row.party.name)).toEqual([
      'Sylhet Pharmacy',
      'Tamanna Pharmacy',
      'Halishahar Pharmacy',
    ]);
    expect(group.totals.balance).toBe('-1500.0000');
    // The ledger of the group's customers only
    expect(group.ledger).toBe('-1500.0000');

    // Past their due date: the advances alone are not overdue. The whole row still shows.
    const overdue = await receivables(`asOf=${today}&show=overdue&sort=-over90`);
    expect(overdue.items.map(rowOf)).toEqual([
      ['Agrabad Medicine Corner', 100, 500, 900, 1300, 800, 0, 3600],
      ['Halishahar Pharmacy', 0, 2000, 0, 0, 0, 0, 2000],
      ['Tamanna Pharmacy', 0, 2500, 0, 0, 0, 1000, 1500],
      ['Zindabazar Store', 0, 600, 0, 0, 0, 100, 500],
    ]);
    // The books know no due dates
    expect(overdue.ledger).toBeNull();
  });

  it('finds only a customer of the workspace, and needs the sales report permission', async () => {
    expect((await send('GET', `/reports/ar-aging/${padma.id}?asOf=${today}`)).statusCode).toBe(404);
    expect((await send('GET', `/reports/ar-aging/${randomUUID()}?asOf=${today}`)).statusCode).toBe(
      404,
    );
    expect((await send('GET', `/reports/ar-aging/${agrabad.id}`)).statusCode).toBe(400);
    const mine = await receivables(`asOf=${today}`, shirin);
    expect(mine.totals.balance).toBe('2450.0000');
    const refused = await send('GET', `/reports/ap-aging?asOf=${today}`, undefined, shirin);
    expect(refused.statusCode).toBe(403);
    expect(problemOf(refused).code).toBe('permission_missing');
  });
});

describe('The payables aging', () => {
  it('counts only posted payments, and takes off on a past day what was paid by then', async () => {
    const report = await payables(`asOf=${today}`);
    // The draft and the waiting payment are not in the books: they pay nothing and hold nothing
    expect(report.items.map(rowOf)).toEqual([
      ['Padma Yarn Traders', 5000, 11000, 0, 0, 0, 0, 16000],
      ['Juki Parts Centre', 0, 600, 0, 0, 0, 100, 500],
      // ৳2,000 of the payment less the ৳500 refund, and the ৳200 debit note
      ['Meghna Poly Packaging', 0, 0, 0, 0, 0, 1700, -1700],
    ]);
    expect(report.totals).toMatchObject({
      due: '16600.0000',
      advances: '1800.0000',
      balance: '14800.0000',
    });
    expect(report.ledger).toBe('14800.0000');

    // 16 days ago: before the ৳8,000 and the debit note; the voided ৳2,000 was still paid then
    // (it shows as an advance, its allocation deleted with the void)
    const before = await payables(`asOf=${day(-16)}`);
    expect(rowNamed(before, 'Padma Yarn Traders')).toEqual([
      'Padma Yarn Traders',
      25000,
      0,
      0,
      0,
      0,
      2000,
      23000,
    ]);
    // 4 days ago: the debit note is on the bill, the refund is not paid yet
    const recent = await payables(`asOf=${day(-4)}`);
    expect(rowNamed(recent, 'Padma Yarn Traders')).toEqual([
      'Padma Yarn Traders',
      5000,
      11000,
      0,
      0,
      0,
      2000,
      14000,
    ]);
    expect(rowNamed(recent, 'Meghna Poly Packaging')).toEqual([
      'Meghna Poly Packaging',
      0,
      0,
      0,
      0,
      0,
      2200,
      -2200,
    ]);
    for (const asOf of [day(-41), day(-25), day(-16), day(-6), day(-4), day(-2), today, day(30)]) {
      const past = await payables(`asOf=${asOf}`);
      expect(past.ledger, asOf).toBe(past.totals.balance);
    }
  });

  it("lists a supplier's open bills with their numbers, and its advances by kind", async () => {
    const page = await supplierPage(padma.id, today);
    expect(page.documents.map((item) => [item.supplierBillNumber, item.open, item.bucket])).toEqual(
      [
        [`${padma.code}-${day(-40)}-20000`, '11000.0000', 'days1To30'],
        [`${padma.code}-${day(-20)}-5000`, '5000.0000', 'current'],
      ],
    );
    expect(page.ledger).toBe('16000.0000');
    const meghnaPage = await supplierPage(meghna.id, today);
    expect(meghnaPage.advances.map((item) => [item.kind, item.amount])).toEqual([
      ['payment', '1500.0000'],
      ['debit_note', '200.0000'],
    ]);
    expect(meghnaPage.ledger).toBe('-1700.0000');
    expect((await send('GET', `/reports/ap-aging/${agrabad.id}?asOf=${today}`)).statusCode).toBe(
      404,
    );
  });

  it('filters by supplier group and shows only the overdue', async () => {
    const group = await payables(`asOf=${today}&supplierGroupId=${yarnMills}`);
    expect(group.items.map((row) => row.party.name)).toEqual(['Padma Yarn Traders']);
    expect(group.ledger).toBe('16000.0000');
    const overdue = await payables(`asOf=${today}&show=overdue`);
    expect(overdue.items.map((row) => row.party.name)).toEqual([
      'Padma Yarn Traders',
      'Juki Parts Centre',
    ]);
    expect(overdue.ledger).toBeNull();
  });
});
```

**The world.** Surma Distributors in Sylhet, a distribution workspace. It bills "Delivery and handling", a service, so
no stock is needed, and every amount is VAT exempt, so a document's total is its net and every number in the test is
whole taka. Each customer and supplier stands for one rule:

| Party | What it shows |
|---|---|
| Agrabad Medicine Corner | Eight invoices due today, 1, 30, 31, 60, 61, 90 and 91 days ago: the edges of every bucket |
| Tamanna Pharmacy | Part of a receipt applied, the rest an advance; an advance applied today; a credit note |
| Halishahar Pharmacy | A receipt voided later: the known gap of decision 5 |
| Sylhet Pharmacy | Only an advance, with a refund that was voided later |
| Chawkbazar Store | A credit note on a paid invoice: an advance of the credit note kind |
| Zindabazar Store, Juki Parts Centre | Money applied again: which allocation keeps its day |
| Lalbagh Store | Nothing at all: no row |
| Padma Yarn Traders | A posted payment, a draft, one waiting for approval, a voided one and a debit note |
| Meghna Poly Packaging | An advance, a debit note on a paid bill and a supplier refund |

**The helpers.**

- **`rowOf()`** turns a row into its name and the seven numbers as plain numbers: current, the four late buckets,
  advances and balance. Every amount here is whole taka, so `Number()` loses nothing, and a row reads like the page.
- **`appliedOn()`** reads the `applied_on` of a paying document's allocations with the superuser connection: no
  route shows it. `ALLOCATIONS` names each table's columns once, and `sql()` writes them as identifiers, so the query
  is one template for the four tables. It answers `[number, amount, day]`, sorted by the number.
- **`changed()`** is `created()` for the routes that answer 200 (apply again, void, update).
- **Rina** pays suppliers and is not the Owner. An Owner's own payment is approved at once (step 17c, decision 14),
  so only her ৳60,000 payment waits for the finance manager.

**The documents** are posted in one test, in the order a month of work would bring them. The comments give each
amount, so the numbers in the tests below can be checked by hand.

**The day an allocation counts:**

- **A receipt dated before its invoice:** Zindabazar's receipt is dated 29 days ago, the second invoice 28. The second
  allocation counts from 28 days ago, the invoice's day: the database's floor (21b.2) did it, not the service.
- **A credit note's allocation** has the credit note's date.
- **Applying again:** ৳100 of the second invoice goes back to the advance. The first pair's amount is sent as
  `"1000.00"`: still the same amount, so it keeps its day (decision 30, `compareMoney()`). The changed pair is today.
  The same for a posted supplier payment.
- **A draft payment's plan** follows the payment's date when the draft is changed.

**The receivables aging:**

- **The edge days.** Today, ৳100 is current (due today), 1 and 30 days late are in 1–30, 31 and 60 in 31–60, 61 and 90
  in 61–90, 91 over 90. A day earlier each one is a day less late, so each edge invoice moves down one bucket, and the
  one of today is not there yet. For today, yesterday and a month ahead, the party's page (the contract's
  `agingBucketOf()`) and the report's row (the SQL's `bucketSums()`) must agree: this is the check promised in 21b.3.
- **Tamanna on four days.** Before any money, the whole invoice, not due yet. Then ৳4,000 applied and two advances;
  then the credit note's ৳500 from its own day; today the ৳3,000 advance is on the invoice, so the buckets move but
  the balance stays. The party's page on the day before shows both receipts as advances.
- **Halishahar's bounced cheque.** Between the receipt and its void, the invoice shows open (its allocation went with
  the void) and the cheque shows as an advance: the balance is ৳0, and so is the ledger. This is the known gap,
  tested so that it stays a gap in the buckets and never in the balance.
- **Sylhet's refund** counts from its day until it is voided. A party with only an advance has a row with a balance
  below zero. Chawkbazar's credit note on a paid invoice is an advance of its own kind. Lalbagh, with nothing, has no
  row, but its page answers with zeros.
- **The ledger on every day.** Today's whole report is written out, with its totals. Then for eight days, a year back
  to a month ahead, the report's balance equals the ledger, and every party's page equals its own ledger. The
  ledger knows nothing of due dates or allocations, so this is the check that the as-of sums are right however the
  money moved.
- **Paging, the group and "Overdue only":** the pages of four have the same totals; the Pharmacies group has its own
  ledger; "Overdue only" keeps the parties with something past its due date, shows their whole row, and has no
  ledger.
- **Who:** a supplier's id on the customers' page is 404, like an unknown id; a missing `asOf` is 400. Shirin reads the
  receivables with only `sales.report.read` (decision 10), and the payables are 403 for her.

**The payables aging:**

- **Only posted payments.** The draft's plan and the waiting payment's plan pay no bill and are no advance. 16 days
  ago, the ৳8,000 and the debit note were not there yet, and the voided ৳2,000 shows as an advance, like Halishahar's
  cheque. The ledger agrees on eight days.
- **A supplier's page** shows the supplier's own bill number, and the advances by kind: what is left of a payment
  after its refund, and a debit note on a paid bill.

### `reports/report-exports.int.spec.ts`: the four new kinds

```diff
@@ -1,19 +1,27 @@
+import { inflateRawSync } from 'node:zlib';
 import type { INestApplicationContext } from '@nestjs/common';
 import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
   type Account,
   accountListSchema,
+  branchListSchema,
+  customerSchema,
   fiscalYearOf,
+  invoiceSchema,
   memberPageSchema,
   notificationPageSchema,
   problemSchema,
+  productSchema,
   type ReportExport,
   reportExportPageSchema,
   reportExportSchema,
+  roleListSchema,
   roleSchema,
   setupSchema,
   signedUrlSchema,
+  taxRateListSchema,
   todayIn,
+  unitListSchema,
 } from '@omnivo/contracts';
 import postgres from 'postgres';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
@@ -299,3 +307,307 @@ describe('exporting a report', () => {
     });
   });
 });
+
+// Step 21b: the four new kinds, each with its own permission (decision 14), and the cost a file
+// shows only to someone who may see it now (decision 38)
+describe('exporting the sales and purchase reports and the agings', () => {
+  // Shirin reads the sales report and its agings, nothing else: no purchases, no stock value
+  let shirin: SignedIn;
+  let shirinsRole: { id: string; version: number };
+  let shirinsExport: ReportExport;
+  const period = { from: thisYear.start, to: today };
+
+  // The text of every file inside an .xlsx, which is a zip archive: each entry found through the
+  // central directory at the end, then inflated (method 8) or taken as it is (method 0, stored).
+  // The sizes are read from the central directory, because a zip written as a stream leaves them
+  // out of the entry's own header.
+  function xlsxText(bytes: Uint8Array): string {
+    const data = Buffer.from(bytes);
+    const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
+    const count = data.readUInt16LE(end + 10);
+    let at = data.readUInt32LE(end + 16);
+    const parts: string[] = [];
+    for (let entry = 0; entry < count; entry += 1) {
+      const method = data.readUInt16LE(at + 10);
+      const size = data.readUInt32LE(at + 20);
+      const header = data.readUInt32LE(at + 42);
+      const start = header + 30 + data.readUInt16LE(header + 26) + data.readUInt16LE(header + 28);
+      const body = data.subarray(start, start + size);
+      parts.push((method === 8 ? inflateRawSync(body) : body).toString('utf8'));
+      at +=
+        46 + data.readUInt16LE(at + 28) + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
+    }
+    return parts.join('\n');
+  }
+
+  // The two customers in the order the file has them (a name the file lacks is left out)
+  function rowsIn(file: string): string[] {
+    return ['Alpha Knit', 'Zeta Knit']
+      .filter((name) => file.includes(name))
+      .toSorted((a, b) => file.indexOf(a) - file.indexOf(b));
+  }
+
+  async function exportAs(who: SignedIn, body: object): Promise<ReportExport> {
+    const res = await send('POST', '/report-exports', body, who);
+    expect(res.statusCode, res.body).toBe(201);
+    return reportExportSchema.parse(res.json());
+  }
+
+  // The text of a finished export's file, downloaded by the person who asked for it
+  async function fileOf(exportId: string, who = owner): Promise<string> {
+    expect((await finished(exportId, who)).status).toBe('ready');
+    const res = await send('GET', `/report-exports/${exportId}/download`, undefined, who);
+    expect(res.statusCode, res.body).toBe(200);
+    const file = await fetch(signedUrlSchema.parse(res.json()).url);
+    return xlsxText(new Uint8Array(await file.arrayBuffer()));
+  }
+
+  beforeAll(async () => {
+    // Two washing jobs, billed: Zeta Knit's ৳900 is more than Alpha Knit's ৳100, and a service has
+    // no cost, so a file sorted by the cost lists them by name and one sorted by the net does not
+    const pcs = unitListSchema
+      .parse((await send('GET', '/units')).json())
+      .items.find((unit) => unit.code === 'pcs');
+    const exempt = taxRateListSchema
+      .parse((await send('GET', '/tax-rates')).json())
+      .items.find((rate) => rate.name === 'Exempt');
+    if (!pcs || !exempt) throw new Error('no pcs or Exempt');
+    const [branch] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
+    if (!branch) throw new Error('sign-up made no branch');
+    const branchId = branch.id;
+    const made = await send('POST', '/products', {
+      code: '',
+      name: 'Garment washing',
+      type: 'service',
+      categoryId: '',
+      description: '',
+      baseUnitId: pcs.id,
+      salesUnitId: '',
+      purchaseUnitId: '',
+      tracking: 'none',
+      hasExpiry: false,
+      taxRateId: '',
+      options: [],
+      variants: [
+        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
+      ],
+      units: [],
+      customFields: {},
+    });
+    expect(made.statusCode, made.body).toBe(201);
+    const washing = productSchema.parse(made.json());
+    for (const [name, price] of [
+      ['Alpha Knit', '100'],
+      ['Zeta Knit', '900'],
+    ] as const) {
+      const customer = await send('POST', '/customers', {
+        code: '',
+        name,
+        groupId: '',
+        contactPerson: '',
+        phone: '',
+        email: '',
+        documentLanguage: 'en',
+        bin: '',
+        paymentTermsDays: 0,
+        creditLimit: '',
+        priceListId: '',
+        notes: '',
+        addresses: [],
+      });
+      expect(customer.statusCode, customer.body).toBe(201);
+      const invoice = await send('POST', '/invoices', {
+        customerId: customerSchema.parse(customer.json()).id,
+        date: today,
+        dueDate: '',
+        customerReference: '',
+        branchId: branchId,
+        warehouseId: '',
+        note: '',
+        lines: [
+          {
+            variantId: washing.variants[0]?.id ?? '',
+            unitId: pcs.id,
+            quantity: '1',
+            description: '',
+            unitPrice: price,
+            discountType: 'percent',
+            discount: '',
+            taxRateId: exempt.id,
+            deliveryLineId: '',
+            orderLineId: '',
+            batchId: '',
+            serialNumbers: [],
+          },
+        ],
+        post: true,
+      });
+      expect(invoice.statusCode, invoice.body).toBe(201);
+      invoiceSchema.parse(invoice.json());
+    }
+
+    await signUp(app, {
+      companyName: 'Shirin Fabrics',
+      workspaceSlug: 'shirin-fabrics',
+      fullName: 'Shirin Akter',
+      email: 'shirin@rahmangarments.com',
+      password: 'Sales-desk-2026',
+    });
+    await joinWithoutRoles(pg.superuserUrl, {
+      email: 'shirin@rahmangarments.com',
+      workspace: 'rahman-garments',
+    });
+    const role = roleSchema.parse(
+      (await send('POST', '/roles', { name: 'Sales desk', description: '' })).json(),
+    );
+    const matrix = await send('PUT', '/permission-matrix', {
+      roles: [{ id: role.id, version: role.version, permissions: ['sales.report.read'] }],
+    });
+    expect(matrix.statusCode).toBe(200);
+    const saved = roleListSchema.parse(matrix.json()).items.find((item) => item.id === role.id);
+    if (!saved) throw new Error('the role is gone');
+    shirinsRole = { id: saved.id, version: saved.version };
+    const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
+    const found = items.find((item) => item.email === 'shirin@rahmangarments.com');
+    if (!found) throw new Error('Shirin is not a member');
+    const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
+      roleIds: [role.id],
+      version: found.version,
+    });
+    expect(roles.statusCode).toBe(200);
+    shirin = await logIn(app, {
+      workspace: 'rahman-garments',
+      email: 'shirin@rahmangarments.com',
+      password: 'Sales-desk-2026',
+      keepSignedIn: false,
+    });
+  }, 120_000);
+
+  it('writes each new kind, named by its period or its day', async () => {
+    const asked = await Promise.all([
+      exportOf({
+        report: 'sales_report',
+        format: 'xlsx',
+        query: { ...period, groupBy: 'product' },
+      }),
+      exportOf({ report: 'purchase_report', format: 'pdf', query: period }),
+      exportOf({ report: 'ar_aging', format: 'pdf', query: { asOf: today, show: 'overdue' } }),
+      exportOf({ report: 'ap_aging', format: 'xlsx', query: { asOf: today } }),
+    ]);
+    const ready = await Promise.all(asked.map((item) => finished(item.id)));
+    expect(ready.map((item) => [item.report, item.status, item.fileName])).toEqual([
+      ['sales_report', 'ready', `sales-${thisYear.start}-to-${today}.xlsx`],
+      ['purchase_report', 'ready', `purchases-${thisYear.start}-to-${today}.pdf`],
+      ['ar_aging', 'ready', `receivables-aging-${today}.pdf`],
+      ['ap_aging', 'ready', `payables-aging-${today}.xlsx`],
+    ]);
+    // The defaults the schema filled in are kept, so the list shows what the file holds
+    expect(asked[2].query).toEqual({ asOf: today, show: 'overdue', sort: '-balance' });
+  });
+
+  it("asks for each report's own permission, and for the stock value to sort by the cost", async () => {
+    const purchases = await send(
+      'POST',
+      '/report-exports',
+      { report: 'purchase_report', format: 'pdf', query: period },
+      shirin,
+    );
+    expect(purchases.statusCode).toBe(403);
+    expect(problemSchema.parse(purchases.json())).toMatchObject({
+      code: 'permission_missing',
+      params: { permissions: 'purchase.report.read' },
+    });
+    const byCost = await send(
+      'POST',
+      '/report-exports',
+      { report: 'sales_report', format: 'xlsx', query: { ...period, sort: '-margin' } },
+      shirin,
+    );
+    expect(problemSchema.parse(byCost.json())).toMatchObject({
+      code: 'permission_missing',
+      params: { permissions: 'inventory.stock.value' },
+    });
+    // The accounting reports are not hers either, and the sales report is not Nasrin's
+    const trial = await send(
+      'POST',
+      '/report-exports',
+      { report: 'trial_balance', format: 'pdf', query: period },
+      shirin,
+    );
+    expect(trial.statusCode).toBe(403);
+    const notNasrins = await send(
+      'POST',
+      '/report-exports',
+      { report: 'ar_aging', format: 'pdf', query: { asOf: today } },
+      colleague,
+    );
+    expect(notNasrins.statusCode).toBe(403);
+  });
+
+  it('leaves the cost out of the file of someone who may not see it', async () => {
+    const owners = await fileOf(
+      (await exportOf({ report: 'sales_report', format: 'xlsx', query: period })).id,
+    );
+    expect(owners).toContain('Margin %');
+    shirinsExport = await exportAs(shirin, {
+      report: 'sales_report',
+      format: 'xlsx',
+      query: period,
+    });
+    const hers = await fileOf(shirinsExport.id, shirin);
+    expect(hers).toContain('Net sales');
+    expect(hers).not.toContain('Margin');
+    expect(rowsIn(hers)).toEqual(['Zeta Knit', 'Alpha Knit']);
+  });
+
+  it('sorts by the net a file asked by the cost, when the cost is no longer allowed', async () => {
+    // As if Shirin had the stock value when she asked, and lost it before the worker got there: the
+    // row and its event are written past the API, which would refuse this sort today
+    const [row] = await superuserSql(async (sql) => {
+      const rows = await sql<{ id: string; tenant_id: string }[]>`
+        INSERT INTO report_exports (id, tenant_id, requested_by, report, format, query)
+        SELECT gen_random_uuid(), m.tenant_id, m.user_id, 'sales_report', 'xlsx',
+               ${sql.json({ ...period, groupBy: 'customer', sort: 'cost' })}
+          FROM memberships m JOIN users u ON u.id = m.user_id
+          JOIN tenants t ON t.id = m.tenant_id
+         WHERE u.email = 'shirin@rahmangarments.com' AND t.slug = 'rahman-garments'
+        RETURNING id, tenant_id`;
+      const first = rows[0];
+      if (!first) throw new Error('no export row');
+      await sql`
+        INSERT INTO outbox_events (id, tenant_id, type, payload)
+        VALUES (gen_random_uuid(), ${first.tenant_id}, 'report.export_requested',
+                ${sql.json({ exportId: first.id })})`;
+      return rows;
+    });
+    const file = await fileOf(row?.id ?? '', shirin);
+    expect((await finished(row?.id ?? '', shirin)).fileName).toBe(
+      `sales-${thisYear.start}-to-${today}.xlsx`,
+    );
+    expect(file).not.toContain('Margin');
+    // By the cost (all ৳0) the names would decide: Alpha first. By the net, Zeta first.
+    expect(rowsIn(file)).toEqual(['Zeta Knit', 'Alpha Knit']);
+  });
+
+  it('hides an export of a report its owner can no longer read, and refuses its download', async () => {
+    const matrix = await send('PUT', '/permission-matrix', {
+      roles: [{ id: shirinsRole.id, version: shirinsRole.version, permissions: [] }],
+    });
+    expect(matrix.statusCode, matrix.body).toBe(200);
+    const { items } = reportExportPageSchema.parse(
+      (await send('GET', '/report-exports', undefined, shirin)).json(),
+    );
+    expect(items).toEqual([]);
+    const refused = await send(
+      'GET',
+      `/report-exports/${shirinsExport.id}/download`,
+      undefined,
+      shirin,
+    );
+    expect(refused.statusCode).toBe(403);
+    expect(problemSchema.parse(refused.json())).toMatchObject({
+      code: 'permission_missing',
+      params: { permissions: 'sales.report.read' },
+    });
+  });
+});
```

- **A `describe` with its own `beforeAll`:** the suite's world stays as it was, and the new part adds what it needs
  (two invoices and Shirin) after it.
- **`xlsxText()` reads the text inside an Excel file** with Node's own `zlib`. An `.xlsx` file is a zip archive; the
  function finds each entry in the zip's central directory at the end of the file and inflates it. The sizes come
  from the central directory because a zip written as a stream leaves them out of each entry's own header. No new
  dependency is needed to read a file in one test.
- **Two invoices of a service:** Zeta Knit's ৳900 and Alpha Knit's ৳100. A service has no cost, so sorted by the cost
  they tie and go by name (Alpha first); sorted by the net, Zeta is first. That is how the test sees which order the
  worker used.
- **`rowsIn()`** gives the two names in the order the file has them, and leaves out a name that is missing. A plain
  `indexOf(a) < indexOf(b)` would pass if `a` were missing (-1).
- **Each new kind is written**, named by its period or its day, and the stored query has the defaults the schema
  filled in (`sort: '-balance'`), so "My exports" shows what the file holds.
- **Each kind asks for its own permission** (decision 14): Shirin may not export purchases or the trial balance, nor
  sort by the cost; Nasrin reads the accounting reports and may not export the receivables aging.
- **The cost in the file:** the Owner's file has the margin columns, Shirin's has not, and hers is in the net's order.
- **The permission lost after asking** (decision 38): the row and its event are written past the API, as if Shirin had
  the stock value when she asked for a file sorted by the cost. The worker makes it without the cost and in the net's
  order. Without the fallback, Alpha would come first: the order would tell the hidden cost.
- **The permission lost after the file is made** (decision 40): her list no longer has it, and the download is 403
  `permission_missing` with the key, not 404: it is her own export.

### `reports/reports.tenant-leak.int.spec.ts`: the documents too

```diff
@@ -3,18 +3,32 @@ import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
   type Account,
   accountListSchema,
+  agingReportSchema,
+  billSchema,
   branchSchema,
+  customerGroupSchema,
+  customerSchema,
   fiscalYearListSchema,
   fiscalYearOf,
+  invoiceSchema,
+  productCategoryListSchema,
+  productSchema,
   profitAndLossSchema,
+  purchaseReportSchema,
   reportExportPageSchema,
+  salesReportSchema,
   setupSchema,
   shiftIsoDate,
+  supplierGroupSchema,
+  supplierSchema,
+  taxRateListSchema,
   todayIn,
   trialBalanceSchema,
+  unitListSchema,
 } from '@omnivo/contracts';
 import postgres from 'postgres';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
+import type { z } from 'zod';
 
 import {
   createTestApp,
@@ -205,3 +219,215 @@ describe('report isolation over HTTP', () => {
     );
   });
 });
+
+// Step 21b: the sales and purchase reports and the agings read documents, not only the journal.
+// B sells a delivery to a pharmacy and buys a repair, both on B's own branch, group and category.
+describe('trade reports and agings over HTTP', () => {
+  let customerOfB: string;
+  let supplierOfB: string;
+  let customerGroupOfB: string;
+  let supplierGroupOfB: string;
+  let categoryOfB: string;
+  const period = `from=${lastYear.start}&to=${today}`;
+
+  async function created<T>(schema: z.ZodType<T>, url: string, body: object): Promise<T> {
+    const res = await as(tenantB, 'POST', url, body);
+    expect(res.statusCode, res.body).toBe(201);
+    return schema.parse(res.json());
+  }
+
+  async function read<T>(who: SignedIn, schema: z.ZodType<T>, url: string): Promise<T> {
+    const res = await as(who, 'GET', url);
+    expect(res.statusCode, res.body).toBe(200);
+    return schema.parse(res.json());
+  }
+
+  beforeAll(async () => {
+    const chart = accountListSchema.parse((await as(tenantB, 'GET', '/accounts')).json()).items;
+    const pcs = unitListSchema
+      .parse((await as(tenantB, 'GET', '/units')).json())
+      .items.find((unit) => unit.code === 'pcs');
+    const exempt = taxRateListSchema
+      .parse((await as(tenantB, 'GET', '/tax-rates')).json())
+      .items.find((rate) => rate.name === 'Exempt');
+    const [category] = productCategoryListSchema.parse(
+      (await as(tenantB, 'GET', '/product-categories')).json(),
+    ).items;
+    if (!pcs || !exempt || !category)
+      throw new Error("B's setup is missing a unit, rate or category");
+    categoryOfB = category.id;
+    const delivery = await created(productSchema, '/products', {
+      code: '',
+      name: 'Cold-chain delivery',
+      type: 'service',
+      categoryId: categoryOfB,
+      description: '',
+      baseUnitId: pcs.id,
+      salesUnitId: '',
+      purchaseUnitId: '',
+      tracking: 'none',
+      hasExpiry: false,
+      taxRateId: '',
+      options: [],
+      variants: [
+        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
+      ],
+      units: [],
+      // The pharma template asks for the generic name
+      customFields: { generic_name: 'Delivery' },
+    });
+    customerGroupOfB = (
+      await created(customerGroupSchema, '/customer-groups', { name: 'Hospital pharmacies' })
+    ).id;
+    supplierGroupOfB = (
+      await created(supplierGroupSchema, '/supplier-groups', { name: 'Service vendors' })
+    ).id;
+    customerOfB = (
+      await created(customerSchema, '/customers', {
+        code: '',
+        name: 'Mymensingh Medical Pharmacy',
+        groupId: customerGroupOfB,
+        contactPerson: '',
+        phone: '',
+        email: '',
+        documentLanguage: 'en',
+        bin: '',
+        paymentTermsDays: 0,
+        creditLimit: '',
+        priceListId: '',
+        notes: '',
+        addresses: [],
+      })
+    ).id;
+    supplierOfB = (
+      await created(supplierSchema, '/suppliers', {
+        code: '',
+        name: 'Brahmaputra Cold Storage',
+        groupId: supplierGroupOfB,
+        contactPerson: '',
+        phone: '',
+        email: '',
+        documentLanguage: 'en',
+        bin: '',
+        paymentTermsDays: 0,
+        address: '',
+        bankAccounts: [],
+        notes: '',
+      })
+    ).id;
+    await created(invoiceSchema, '/invoices', {
+      customerId: customerOfB,
+      date: today,
+      dueDate: '',
+      customerReference: '',
+      branchId: branchOfB,
+      warehouseId: '',
+      note: '',
+      lines: [
+        {
+          variantId: delivery.variants[0]?.id ?? '',
+          unitId: pcs.id,
+          quantity: '1',
+          description: '',
+          unitPrice: '75000',
+          discountType: 'percent',
+          discount: '',
+          taxRateId: exempt.id,
+          deliveryLineId: '',
+          orderLineId: '',
+          batchId: '',
+          serialNumbers: [],
+        },
+      ],
+      post: true,
+    });
+    await created(billSchema, '/bills', {
+      supplierId: supplierOfB,
+      date: today,
+      dueDate: '',
+      supplierBillNumber: 'BCS-2026-77',
+      mushakNumber: '',
+      mushakDate: '',
+      branchId: branchOfB,
+      warehouseId: '',
+      pricesIncludeVat: false,
+      note: '',
+      lines: [],
+      expenses: [
+        {
+          accountId: idIn(chart, '5270'),
+          description: 'Cold room compressor repair',
+          amount: '42000',
+          taxRateId: exempt.id,
+        },
+      ],
+      submit: true,
+    });
+  }, 120_000);
+
+  it("adds none of B's documents into A's reports, whatever ids A's query names", async () => {
+    for (const filter of [
+      '',
+      `&branchId=${branchOfB}`,
+      `&customerGroupId=${customerGroupOfB}`,
+      `&categoryId=${categoryOfB}`,
+    ]) {
+      for (const groupBy of ['customer', 'product', 'category', 'branch', 'month']) {
+        const report = await read(
+          tenantA,
+          salesReportSchema,
+          `/reports/sales?${period}&groupBy=${groupBy}${filter}`,
+        );
+        expect(report.items, `${groupBy}${filter}`).toEqual([]);
+        expect(report.totals.net).toBe('0.0000');
+      }
+    }
+    // B's books have sales on that branch (the journal entries above); A's have none
+    expect(
+      (await read(tenantA, salesReportSchema, `/reports/sales?${period}&branchId=${branchOfB}`))
+        .books,
+    ).toBe('0.0000');
+    for (const filter of [
+      '',
+      `&supplierGroupId=${supplierGroupOfB}`,
+      `&categoryId=${categoryOfB}`,
+    ]) {
+      for (const groupBy of ['supplier', 'product', 'account', 'month']) {
+        const report = await read(
+          tenantA,
+          purchaseReportSchema,
+          `/reports/purchases?${period}&groupBy=${groupBy}${filter}`,
+        );
+        expect(report.items, `${groupBy}${filter}`).toEqual([]);
+      }
+    }
+    // B sees its own, so the documents above were really there
+    const own = await read(tenantB, salesReportSchema, `/reports/sales?${period}`);
+    expect(own.totals.net).toBe('75000.0000');
+    const ownPurchases = await read(tenantB, purchaseReportSchema, `/reports/purchases?${period}`);
+    expect(ownPurchases.totals.net).toBe('42000.0000');
+  });
+
+  it("owes A nothing of B's, and finds none of B's customers or suppliers", async () => {
+    for (const url of [
+      `/reports/ar-aging?asOf=${today}`,
+      `/reports/ar-aging?asOf=${today}&customerGroupId=${customerGroupOfB}`,
+      `/reports/ap-aging?asOf=${today}`,
+      `/reports/ap-aging?asOf=${today}&supplierGroupId=${supplierGroupOfB}`,
+    ]) {
+      const aging = await read(tenantA, agingReportSchema, url);
+      expect(aging.items, url).toEqual([]);
+      expect(aging.ledger).toBe('0.0000');
+    }
+    for (const url of [
+      `/reports/ar-aging/${customerOfB}?asOf=${today}`,
+      `/reports/ap-aging/${supplierOfB}?asOf=${today}`,
+    ]) {
+      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
+    }
+    const own = await read(tenantB, agingReportSchema, `/reports/ar-aging?asOf=${today}`);
+    expect(own.totals.balance).toBe('75000.0000');
+    const ownPayables = await read(tenantB, agingReportSchema, `/reports/ap-aging?asOf=${today}`);
+    expect(ownPayables.ledger).toBe('42000.0000');
+  });
+});
```

- **Why it is needed:** the step 11 reports read only the journal. The new ones read invoices, POS sales, bills,
  receipts and their allocations, each a table with its own tenant column, so each needs its own check.
- **B makes real documents** on its own branch, customer and supplier groups and category: an invoice of ৳75,000 and a
  bill of ৳42,000.
- **A's reports are empty whatever B's ids its query names,** in every group of both reports. A missing tenant filter
  on any one table would bring B's rows in through B's own id.
- **A's agings owe nothing, and B's customer and supplier are 404 on A's party pages.**
- **B sees its own,** so the documents were really there.

### `reports/export/document.spec.ts`: the files of the new kinds

```diff
@@ -1,4 +1,14 @@
-import type { BalanceSheet, ReportSection, TrialBalance } from '@omnivo/contracts';
+import {
+  type AgingAmounts,
+  type AgingReport,
+  type BalanceSheet,
+  costColumns,
+  type PurchaseReport,
+  type ReportSection,
+  type SalesReport,
+  type SalesReportRow,
+  type TrialBalance,
+} from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import { buildDocument, type DocCell, type DocumentContext, fileStem } from './document.js';
@@ -9,6 +19,8 @@ const context: DocumentContext = {
   currency: 'BDT',
   timeZone: 'Asia/Dhaka',
   branchName: null,
+  groupName: null,
+  categoryName: null,
   madeAt: new Date('2026-10-01T08:05:00Z'),
 };
 
@@ -104,3 +116,308 @@ describe('the document of a balance sheet', () => {
     ]);
   });
 });
+
+// Step 21b: the sales and purchase reports and the agings
+
+// A sales row: an item unless a kind is given; the cost columns from the net and the cost
+function salesRow(
+  name: string | null,
+  amounts: { gross: string; returns: string; net: string; cost: string | null },
+  extra: Partial<SalesReportRow> = {},
+): SalesReportRow {
+  return {
+    key: name ?? 'walk_in',
+    kind: 'item',
+    id: null,
+    code: null,
+    name,
+    month: null,
+    quantity: null,
+    baseUnit: null,
+    gross: amounts.gross,
+    returns: amounts.returns,
+    net: amounts.net,
+    ...costColumns(amounts.net, amounts.cost),
+    ...extra,
+  };
+}
+
+function salesReport(
+  items: SalesReportRow[],
+  withCost: boolean,
+  books: string | null,
+): SalesReport {
+  return {
+    items,
+    nextCursor: null,
+    totals: {
+      gross: '5035.0000',
+      returns: '331.0000',
+      net: '4704.0000',
+      ...costColumns('4704.0000', withCost ? '4111.0000' : null),
+    },
+    withCost,
+    books,
+  };
+}
+
+describe('the document of a sales report', () => {
+  const query = {
+    from: '2026-09-06',
+    to: '2026-11-05',
+    groupBy: 'customer' as const,
+    sort: '-net' as const,
+  };
+  const rahim = { gross: '3600.0000', returns: '100.0000', net: '3500.0000', cost: '3040.0000' };
+  const walkIns = { gross: '580.0000', returns: '60.0000', net: '520.0000', cost: '431.0000' };
+
+  it('writes the code before the name, the walk-ins in words, and the cost when allowed', () => {
+    const data = salesReport(
+      [
+        salesRow('Rahim Traders', rahim, { code: 'C-00001' }),
+        salesRow(null, walkIns, { kind: 'walk_in' }),
+      ],
+      true,
+      '5204.0000',
+    );
+    const doc = buildDocument({ report: 'sales_report', query, data }, context);
+    expect(doc.title).toBe('Sales report');
+    // Seven columns do not fit a portrait page
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns.map((column) => [column.header, column.kind])).toEqual([
+      ['Customer', 'text'],
+      ['Sold', 'money'],
+      ['Returns', 'money'],
+      ['Net sales', 'money'],
+      ['Cost', 'money'],
+      ['Margin', 'money'],
+      ['Margin %', 'number'],
+    ]);
+    expect(doc.rows.map((row) => [row.style, ...row.cells.map(read)])).toEqual([
+      [
+        'normal',
+        'C-00001 Rahim Traders',
+        '3600.0000',
+        '100.0000',
+        '3500.0000',
+        '3040.0000',
+        '460.0000',
+        '13.1%',
+      ],
+      [
+        'normal',
+        'Walk-in customers',
+        '580.0000',
+        '60.0000',
+        '520.0000',
+        '431.0000',
+        '89.0000',
+        '17.1%',
+      ],
+      ['grand', 'Total', '5035.0000', '331.0000', '4704.0000', '4111.0000', '593.0000', '12.6%'],
+    ]);
+    // The books' figure under the period, to compare with the total
+    expect(doc.lines).toEqual([
+      '6 Sep 2026 – 5 Nov 2026',
+      'By customer',
+      'In the books: 5,204.00',
+      'Amounts in BDT',
+      'Made on 1 Oct 2026, 14:05',
+    ]);
+  });
+
+  it('leaves the cost out of the file of someone who may not see it', () => {
+    const data = salesReport([salesRow('Rahim Traders', { ...rahim, cost: null })], false, null);
+    const doc = buildDocument({ report: 'sales_report', query, data }, context);
+    expect(doc.landscape).toBe(false);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Customer',
+      'Sold',
+      'Returns',
+      'Net sales',
+    ]);
+    expect(doc.rows.every((row) => row.cells.length === 4)).toBe(true);
+    // With a customer group there is no books' figure
+    expect(doc.lines).not.toContain('In the books: 5,204.00');
+  });
+
+  it('writes a quantity with its unit, by product, and adds none up', () => {
+    const data = salesReport(
+      [
+        salesRow('Miniket rice 5 kg', rahim, {
+          code: 'P-00001',
+          quantity: '1250.0000',
+          baseUnit: { code: 'pcs', decimals: 0 },
+        }),
+      ],
+      false,
+      '4704.0000',
+    );
+    const doc = buildDocument(
+      { report: 'sales_report', query: { ...query, groupBy: 'product' }, data },
+      { ...context, branchName: 'Mirpur shop', categoryName: 'Rice' },
+    );
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns[1]).toMatchObject({ header: 'Quantity', kind: 'number' });
+    expect(doc.rows.map((row) => row.cells.slice(0, 2).map(read))).toEqual([
+      ['P-00001 Miniket rice 5 kg', '1,250 pcs'],
+      ['Total', ''],
+    ]);
+    expect(doc.lines.slice(0, 4)).toEqual([
+      '6 Sep 2026 – 5 Nov 2026',
+      'By product',
+      'Branch: Mirpur shop',
+      'Category: Rice',
+    ]);
+  });
+
+  it('names a month, in Bangla too', () => {
+    const data = salesReport(
+      [salesRow(null, rahim, { key: '2026-10', month: '2026-10' })],
+      false,
+      null,
+    );
+    const ofMonths = {
+      report: 'sales_report' as const,
+      query: { ...query, groupBy: 'month' as const },
+      data,
+    };
+    expect(read(buildDocument(ofMonths, context).rows[0]?.cells[0])).toBe('October 2026');
+    expect(read(buildDocument(ofMonths, { ...context, language: 'bn' }).rows[0]?.cells[0])).toBe(
+      'অক্টোবর ২০২৬',
+    );
+    expect(fileStem(ofMonths)).toBe('sales-2026-09-06-to-2026-11-05');
+  });
+});
+
+describe('the document of a purchase report', () => {
+  const data: PurchaseReport = {
+    items: [
+      {
+        key: 'products',
+        kind: 'products',
+        id: null,
+        code: null,
+        name: null,
+        month: null,
+        quantity: null,
+        baseUnit: null,
+        gross: '2500.0000',
+        returns: '370.0000',
+        net: '2130.0000',
+      },
+    ],
+    nextCursor: null,
+    totals: { gross: '2500.0000', returns: '370.0000', net: '2130.0000' },
+  };
+
+  it('has no cost and no books, and names the Products row in words', () => {
+    const report = {
+      report: 'purchase_report' as const,
+      query: {
+        from: '2026-09-06',
+        to: '2026-11-05',
+        groupBy: 'account' as const,
+        sort: '-net' as const,
+      },
+      data,
+    };
+    const doc = buildDocument(report, { ...context, groupName: 'Local mills' });
+    expect(doc.landscape).toBe(false);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Expense account',
+      'Billed',
+      'Debit notes',
+      'Net purchases',
+    ]);
+    expect(doc.rows.map((row) => row.cells.map(read))).toEqual([
+      ['Products', '2500.0000', '370.0000', '2130.0000'],
+      ['Total', '2500.0000', '370.0000', '2130.0000'],
+    ]);
+    expect(doc.lines.slice(0, 3)).toEqual([
+      '6 Sep 2026 – 5 Nov 2026',
+      'By expense account',
+      'Supplier group: Local mills',
+    ]);
+    expect(fileStem(report)).toBe('purchases-2026-09-06-to-2026-11-05');
+  });
+});
+
+describe('the document of an aging', () => {
+  const amounts = (balance: string): AgingAmounts => ({
+    current: '100.0000',
+    days1To30: '500.0000',
+    days31To60: '900.0000',
+    days61To90: '1300.0000',
+    over90: '800.0000',
+    due: '3600.0000',
+    advances: '0.0000',
+    balance,
+  });
+  const data = (ledger: string | null): AgingReport => ({
+    items: [
+      {
+        party: { id: id(7), code: 'C-00007', name: 'Agrabad Medicine Corner' },
+        ...amounts('3600.0000'),
+      },
+    ],
+    nextCursor: null,
+    asOf: '2026-11-05',
+    totals: amounts('3600.0000'),
+    ledger,
+  });
+
+  // "As at", the balance sheet's words for a picture of one day
+  it("has the page's nine columns, the day and the ledger's figure", () => {
+    const report = {
+      report: 'ar_aging' as const,
+      query: { asOf: '2026-11-05', show: 'all' as const, sort: '-balance' as const },
+      data: data('3600.0000'),
+    };
+    const doc = buildDocument(report, context);
+    expect(doc.title).toBe('Receivables aging');
+    expect(doc.landscape).toBe(true);
+    expect(doc.columns.map((column) => column.header)).toEqual([
+      'Customer',
+      'Current',
+      '1–30 days',
+      '31–60 days',
+      '61–90 days',
+      'Over 90 days',
+      'Total due',
+      'Advances',
+      'Balance',
+    ]);
+    expect(doc.rows[0]?.cells.map(read)).toEqual([
+      'C-00007 Agrabad Medicine Corner',
+      '100.0000',
+      '500.0000',
+      '900.0000',
+      '1300.0000',
+      '800.0000',
+      '3600.0000',
+      '0.0000',
+      '3600.0000',
+    ]);
+    expect(doc.lines.slice(0, 2)).toEqual(['As at 5 Nov 2026', 'In the books: 3,600.00']);
+    expect(fileStem(report)).toBe('receivables-aging-2026-11-05');
+  });
+
+  it('says "Overdue only", with no ledger to compare, for the suppliers too', () => {
+    const report = {
+      report: 'ap_aging' as const,
+      query: { asOf: '2026-11-05', show: 'overdue' as const, sort: '-balance' as const },
+      data: data(null),
+    };
+    const doc = buildDocument(report, { ...context, groupName: 'Yarn mills' });
+    expect(doc.title).toBe('Payables aging');
+    expect(doc.columns[0]?.header).toBe('Supplier');
+    expect(doc.lines.slice(0, 3)).toEqual([
+      'As at 5 Nov 2026',
+      'Supplier group: Yarn mills',
+      'Overdue only',
+    ]);
+    expect(doc.lines.some((line) => line.startsWith('In the books'))).toBe(false);
+    expect(fileStem(report)).toBe('payables-aging-2026-11-05');
+  });
+});
```

- **No database, no worker:** `buildDocument()` takes the report's data, so each case is a few rows typed in.
- **A sales report with the cost** is landscape, seven columns, the code before the name, the walk-ins in words, the
  margin percent as text ("13.1%"), and the books' figure under the period.
- **Without the cost** the file has four columns and is portrait.
- **By product** the quantity is "1,250 pcs" and the totals row leaves it empty. The branch and the category are named
  under the heading.
- **A month** is "October 2026" in English and "অক্টোবর ২০২৬" in Bangla.
- **The purchase report's "Products" row** is in words; the file has no cost and no books.
- **An aging** has the page's nine columns and "As at 5 Nov 2026": the balance sheet's words for one day. With
  "Overdue only" there is no ledger line.
- **`fileStem()`** for each: a period's two dates or a day's one.

### `common/db/applied-on.spec.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

import { datedAllocations } from './applied-on.js';

// The rows of a receipt as the service has them: the invoice, the amount, and (now) the day
const now = [
  { invoiceId: 'inv-1', amount: '5000.0000', appliedOn: '2026-10-01' },
  { invoiceId: 'inv-2', amount: '3000.0000', appliedOn: '2026-10-03' },
];
const invoiceOf = (row: { invoiceId: string }) => row.invoiceId;

describe('datedAllocations', () => {
  it('keeps the day of a pair whose amount did not change, however the form writes it', () => {
    const rows = datedAllocations(
      [
        { invoiceId: 'inv-1', amount: '5000' },
        { invoiceId: 'inv-2', amount: '3000.00' },
      ],
      now,
      invoiceOf,
      '2026-11-05',
    );
    expect(rows.map((row) => row.appliedOn)).toEqual(['2026-10-01', '2026-10-03']);
  });

  it('gives the new day to a changed amount and to an invoice that was not paid before', () => {
    const rows = datedAllocations(
      [
        { invoiceId: 'inv-1', amount: '5000' },
        { invoiceId: 'inv-2', amount: '2000' },
        { invoiceId: 'inv-3', amount: '1000' },
      ],
      now,
      invoiceOf,
      '2026-11-05',
    );
    expect(rows).toEqual([
      { invoiceId: 'inv-1', amount: '5000', appliedOn: '2026-10-01' },
      // ৳1,000 less: the whole row is new, the known limit of decision 30
      { invoiceId: 'inv-2', amount: '2000', appliedOn: '2026-11-05' },
      { invoiceId: 'inv-3', amount: '1000', appliedOn: '2026-11-05' },
    ]);
  });

  it('dates every row by the day when the document had none', () => {
    const rows = datedAllocations(
      [{ invoiceId: 'inv-1', amount: '5000' }],
      [],
      invoiceOf,
      '2026-10-07',
    );
    expect(rows).toEqual([{ invoiceId: 'inv-1', amount: '5000', appliedOn: '2026-10-07' }]);
  });

  it('writes nothing for a pair that is gone', () => {
    expect(
      datedAllocations<{ invoiceId: string; amount: string }>([], now, invoiceOf, '2026-11-05'),
    ).toEqual([]);
  });
});
```

- **The same amount written another way** (`"5000"` and `"5000.0000"`) keeps its day.
- **A changed amount is new for all of it** (the known limit of decision 30), and so is an invoice paid for the first
  time.
- **With no rows before,** every row gets the day; with no rows wanted, nothing is written.
- **The type in the last test is written out** (`datedAllocations<{ invoiceId: string; amount: string }>`): from `[]`
  alone TypeScript would infer `never`, and then `now` would not fit.

### What I checked

Each new suite was run against the 21b.3 code first:

- `trade-reports.int.spec.ts`: 15 of 17 passed. One failure was my expectation (by account, the "Products" row's
  ৳2,130 sorts before the van hire's ৳300); the other was the quantity sort, fixed in 21b.3 (decision 42).
- `aging.int.spec.ts`: the first run showed the ৳60,000 payment posted at once, because the Owner wrote it; the test
  now has Rina write it. All 14 then passed with the numbers worked out by hand.

Broken on purpose, one at a time, each file put back from a copy afterwards (`.guide/work/21b4/break.py`):

| Change | Caught by |
|---|---|
| `BETWEEN 1 AND 29` for the 1–30 bucket | 4 aging tests (the edge days, the ledger, the overdue list) |
| The payables' `later` without `sp.status = 'posted'` | The payables test (the draft's plan counted 16 days ago) |
| `datedAllocations()` always giving the new day | The day of an allocation; the payables on past days |
| The worker without the fallback to the net | The export sorted by the cost |
| A price cut taking quantity off | The product quantities and the quantity sort |
| The category filter without the sub-categories | The filters test |
| The purchase quantity sort without the `CASE` | The quantity sort |

The report suites together (the two new ones, report exports, reports, the reports tenant-leak suite and the export
document unit tests): 6 files, 76 tests, pass. API unit tests: 141 pass.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/reports apps/api/src/common/db
cd apps/api && npx vitest run src/reports --maxWorkers=3
```

The first test of each new suite posts every document the others read, so it has a limit of 120 seconds in place of
the usual 5. 21b.8 explains why.

All pass. As after 21b.3, `packages/i18n` and `apps/app` still fail their type checks until 21b.5 and 21b.7.

## 21b.5 — `packages/i18n`: the words

The pages of 21b.6 need their words in English and Bangla, so they come first. This part changes the two locale
files, and one file of the API: the Bangla words of the exported files (decision 43). The ui package needs nothing
new here.

When this part starts, the i18n package does not type-check: 21b.1 added the error code `report_sort_invalid`, and
`errors` must have a word for every code. The app does not either: the exports page and the bell look up
`reports.kinds.<kind>` for every kind, and 21b.1 added four. When this part ends, the i18n package, the ui package
and the API type-check. The app still fails in one file, `mocks/report-data.ts`, whose list of file names knows only
the three old kinds; 21b.7 gives the mock the new kinds.

These words come before the pages' mockup. If the mockup in 21b.6 changes a page, the words change with it, and the
diffs below show them as they are at the end of the step.

### `locales/en.ts`

```diff
@@ -84,6 +84,11 @@ export const en = {
     trialBalance: 'Trial balance',
     profitAndLoss: 'Profit and loss',
     balanceSheet: 'Balance sheet',
+    // Step 21b: each by its own module's report permission
+    salesReport: 'Sales report',
+    purchaseReport: 'Purchase report',
+    arAging: 'Receivables aging',
+    apAging: 'Payables aging',
     exports: 'Exports',
     inventory: 'Inventory',
     products: 'Products',
@@ -1101,6 +1106,10 @@ export const en = {
       trial_balance: 'Trial balance',
       profit_and_loss: 'Profit and loss',
       balance_sheet: 'Balance sheet',
+      sales_report: 'Sales report',
+      purchase_report: 'Purchase report',
+      ar_aging: 'Receivables aging',
+      ap_aging: 'Payables aging',
     },
     formats: { xlsx: 'Excel', pdf: 'PDF' },
     sections: {
```

- **The nav names the four pages by the report,** "Sales report", not "Sales": the sidebar already has a Sales group
  with the documents, and two links called "Sales" would be a guess. The links go in the Reports group (decision 1),
  each shown by its own permission, in 21b.6.
- **The report kinds have the same names.** The exports page and the bell name a file by its kind ("Sales report
  (Excel) is ready to download."), so the name of a file and the name of the page it came from are the same words.

```diff
@@ -1185,6 +1194,213 @@ export const en = {
       emptyTitle: 'Nothing on the books on this day',
       emptyBody: 'Pick a later day, or post the opening balances first.',
     },
+    // Step 21b. The sales and purchase reports also use period, from, to, branch, allBranches,
+    // total, range, asOf, asAt, loadFailed and export above.
+    groupBy: 'Group by',
+    customerGroup: 'Customer group',
+    supplierGroup: 'Supplier group',
+    allGroups: 'All groups',
+    category: 'Category',
+    allCategories: 'All categories',
+    // The filter takes the categories under the chosen one too (decision 13)
+    categoryHint: 'Its sub-categories count too.',
+    // These reports are made on the server, never from the device's copy
+    needsConnection: 'Reports are made on the server. Connect to the internet to see them.',
+    // The crit empty state of a report that could not load; the button is common.retry
+    loadFailedTitle: "Couldn't load the report",
+    loadFailedBody: 'Check the connection, then try again.',
+    // The books' figure beside a report's total: the sales account, or the receivable or payable
+    // account. amount = whole taka.
+    inBooks: 'In the books: {{amount}}',
+    booksAgree: 'Books agree',
+    booksOutBy: 'Out by {{amount}}',
+    sales: {
+      title: 'Sales report',
+      description: 'What was sold in a period, net of discounts and returns, before VAT',
+      // The "Group by" options, and the first column's header
+      groups: {
+        customer: 'Customer',
+        product: 'Product',
+        category: 'Category',
+        branch: 'Branch',
+        month: 'Month',
+      },
+      // A row for the lines that have no customer or no category, so the rows add up to the total
+      rowKinds: {
+        walk_in: 'Walk-in customers',
+        no_category: 'No category',
+      },
+      // Under the walk-in row's name: where its sales come from
+      rowKindHints: {
+        walk_in: 'POS sales with no customer',
+      },
+      // Under the totals in the KPI strip. percent = one decimal, like the column.
+      kpiHints: {
+        gross: 'Invoices and POS sales',
+        returns: 'Credit notes and POS returns',
+        margin: '{{percent}}% of net sales',
+      },
+      columns: {
+        quantity: 'Quantity',
+        gross: 'Sold',
+        returns: 'Returns',
+        net: 'Net sales',
+        cost: 'Cost',
+        margin: 'Margin',
+        marginPercent: 'Margin %',
+      },
+      // Under the table. Why the report and the books can differ (decision 2), and why there is
+      // no books' figure with a customer group or a category.
+      booksHint:
+        'The books count the sales account less sales returns. A journal entry written by hand on those accounts makes the two differ.',
+      noBooks:
+        'A customer group or a category has no figure in the books: journal lines carry neither.',
+      // With the cost columns only (decision 3)
+      costHint:
+        'Cost is what the sold goods cost, dated by the invoice or the POS sale. The books date a challan’s cost by the challan, so a month here can differ from the profit and loss.',
+      emptyTitle: 'Nothing sold in these dates',
+      emptyBody: 'Pick other dates or filters, or post an invoice or make a POS sale.',
+    },
+    purchases: {
+      title: 'Purchase report',
+      description: 'What was billed in a period, less debit notes, before VAT',
+      groups: {
+        supplier: 'Supplier',
+        product: 'Product',
+        account: 'Expense account',
+        month: 'Month',
+      },
+      // One row each for what the group has no row for (decision 11)
+      rowKinds: {
+        expenses: 'Expenses',
+        products: 'Products',
+      },
+      rowKindHints: {
+        expenses: 'The bills’ account lines and expenses together',
+        products: 'The bills’ product lines together',
+      },
+      kpiHints: {
+        gross: 'Posted supplier bills',
+        returns: 'Taken off the bills',
+      },
+      columns: {
+        quantity: 'Quantity',
+        gross: 'Billed',
+        returns: 'Debit notes',
+        net: 'Net purchases',
+      },
+      // A category keeps product lines only
+      categoryHint:
+        'Its sub-categories count too. Account lines and expenses have no category, so they drop out.',
+      emptyTitle: 'Nothing bought in these dates',
+      emptyBody: 'Pick other dates or filters, or post a supplier bill.',
+    },
+    // What the receivables and payables agings share
+    aging: {
+      show: 'Show',
+      shows: {
+        all: 'Everyone',
+        overdue: 'Overdue only',
+      },
+      // Days past the due date (the buckets of the contract)
+      buckets: {
+        current: 'Current',
+        days1To30: '1–30 days',
+        days31To60: '31–60 days',
+        days61To90: '61–90 days',
+        over90: 'Over 90 days',
+      },
+      columns: {
+        due: 'Total due',
+        advances: 'Advances',
+        balance: 'Balance',
+      },
+      // The KPI strip: the buckets after Current together, and the oldest of them
+      overdue: 'Overdue',
+      over90: '{{amount}} over 90 days',
+      balanceHint: 'Total due less advances',
+      // The empty state of "Overdue only" switches back to everyone
+      showEveryone: 'Show everyone',
+      documentsSubtitle: 'The oldest due date first',
+      bucketsHint: 'Days past the due date. Current is not due yet, or due on this day.',
+      // A day after today is allowed
+      futureHint: 'A day after today shows what will be overdue by then if nothing is paid.',
+      // With "Overdue only" there is no books' figure
+      noLedger:
+        'The books know nothing of due dates, so “Overdue only” has no figure in the books.',
+      // The party's row opens its page at the same day
+      openParty: 'See what {{name}} has open',
+      // The party's page: the documents behind the row, oldest due date first
+      documentColumns: {
+        number: 'Number',
+        date: 'Date',
+        dueDate: 'Due date',
+        total: 'Total',
+        open: 'Still open',
+        daysOverdue: 'Overdue',
+        bucket: 'Age',
+      },
+      notDue: 'Not due',
+      daysOverdue_one: '{{count}} day',
+      daysOverdue_other: '{{count}} days',
+      advancesTitle: 'Advances',
+      advanceColumns: {
+        number: 'Number',
+        date: 'Date',
+        amount: 'Not applied',
+      },
+      partyDescription: 'What was open on {{date}}, document by document',
+      partyEmptyTitle: 'Nothing open on this day',
+      partyEmptyBody: '{{name}} had no open document and no advance on {{date}}. Pick another day.',
+    },
+    arAging: {
+      title: 'Receivables aging',
+      description: 'What each customer owes on a day, by how long it has been due',
+      party: 'Customer',
+      // A balance below zero: the customer paid more than they owe
+      inAdvance: '{{amount}} in advance',
+      ledgerHint:
+        'The receivable account on this day. Opening balances, journal entries written by hand and a receipt voided after this day make the two differ.',
+      openCount_one: '{{count}} open invoice',
+      openCount_other: '{{count}} open invoices',
+      documentsTitle: 'Open invoices',
+      advancesHint: 'Received, not applied yet',
+      advancesSubtitle: 'Money received or credited and not applied to an invoice yet',
+      advanceKinds: {
+        receipt: 'Money receipt',
+        credit_note: 'Credit note',
+      },
+      emptyTitle: 'No customer owes anything on this day',
+      emptyBody:
+        'Pick another day, or post an invoice. Invoices still open and money received but not applied show here.',
+      overdueEmptyTitle: 'Nothing overdue on this day',
+      overdueEmptyBody: 'Every open invoice is still within its terms. Show everyone to see them.',
+    },
+    apAging: {
+      title: 'Payables aging',
+      description: 'What is owed to each supplier on a day, by how long it has been due',
+      party: 'Supplier',
+      // A balance below zero: the supplier owes the company (an advance paid, a debit note)
+      inAdvance: 'They owe you {{amount}}',
+      ledgerHint:
+        'The payable account on this day. Opening balances, journal entries written by hand and a payment voided after this day make the two differ.',
+      openCount_one: '{{count}} open bill',
+      openCount_other: '{{count}} open bills',
+      documentsTitle: 'Open bills',
+      // Under our number: the number on the paper the supplier sent
+      supplierBill: 'Their bill {{number}}',
+      advancesHint: 'Paid, not applied yet',
+      advancesSubtitle: 'Money paid or debited and not applied to a bill yet',
+      advanceKinds: {
+        payment: 'Supplier payment',
+        debit_note: 'Debit note',
+      },
+      emptyTitle: 'Nothing is owed to suppliers on this day',
+      emptyBody:
+        'Pick another day, or post a supplier bill. Bills still open and money paid but not applied show here.',
+      overdueEmptyTitle: 'Nothing overdue on this day',
+      overdueEmptyBody: 'Every open bill is still within its terms. Show everyone to see them.',
+    },
   },
   exports: {
     title: 'Exports',
```

- **The filters reuse the statements' words.** Period, the date boxes, the branch, "As at" and "Couldn't load the
  report" are the keys step 11 wrote; this part adds only what the statements do not have: the group select, the
  customer and supplier group, the category.
- **`categoryHint` says what the filter takes** (decision 13): a category and every category under it. Without the
  hint, a person who picks "Groceries" and sees rice in the rows would think the filter is broken. The purchase report
  has its own hint, because there the filter also drops the account lines and the expenses: they have no category.
- **`needsConnection`:** reports other than the Overview are online only (a step 21 decision); they are made on the
  server, never from the device's copy.
  The title of that empty state is the Sync page's "Needs a connection" (`sync.needsConnectionTitle`), so every
  online-only page reads alike.
- **`inBooks`, `booksAgree` and `booksOutBy` are the books' line** under a report's total: the sales account for the
  sales report (decision 2), the receivable or payable account for an aging (decision 5). The pill's words are the
  stock valuation's ("Books agree", "Out by ৳120"), so the same check reads the same way on every report.
- **`groups` are both the select's options and the first column's header.** By customer, the first column says
  "Customer"; by month, "Month". One word for both, so the select and the table can never disagree.
- **`rowKinds` name the rows that are not an item** (decision 16): "Walk-in customers" for POS sales with no
  customer, "No category", and on the purchase report "Expenses" and "Products" (decision 11). They make the rows add
  up to the total. `rowKindHints` say what "Expenses" and "Products" hold, because a row called "Products" in a report
  grouped by expense account is a surprise without it.
- **The columns say what the number is,** not how it is worked out: "Sold", "Returns", "Net sales". The purchase
  report's returns are "Debit notes", because only a debit note takes money off a bill; a purchase return without one
  changes nothing here.
- **`booksHint` and `noBooks` explain the two cases of the books' line:** why it can differ (a journal entry written by
  hand on the sales account), and why it is missing with a customer group or a category (journal lines carry
  neither, so there is nothing to compare with).
- **`costHint` is decision 3's warning,** shown only with the cost columns: the report dates a sale's cost by the
  invoice, the books by the challan, so a month here can differ from the profit and loss. Said once under the table,
  it saves an accountant an afternoon of looking for a mistake that is not there.
- **The empty states say what to do:** pick other dates or filters, or post the document that fills the report.

The agings:

- **`aging` holds what the two agings share:** the "Show" segmented control (`all` / `overdue`, the contract's
  `AGING_SHOWS`), the five buckets, the three amount columns, the party page's columns and its advances. The bucket
  keys are the contract's names (`days1To30`), so a page writes `t(\`reports.aging.buckets.${bucket}\`)` and the type
  check finds a missing one.
- **"Current" has a hint,** `bucketsHint`: an invoice due today is current, not overdue, and that is the edge people
  ask about. `futureHint` is decision 22's other edge: a day after today is allowed, and shows what will be overdue
  by then.
- **`noLedger` replaces the books' line with "Overdue only"** (decision 22, the contract's `ledger: null`): the books know nothing
  of due dates.
- **`openParty` is the row's accessible name.** A row opens the party's page at the same day (decision 6), and a
  screen reader says "See what Karim Store has open", not just the name.
- **`daysOverdue_one` / `_other` are the party page's "Overdue" column** ("1 day", "45 days"), and `notDue` takes
  their place for a document that is not due yet, so the column never says "0 days".
- **`arAging` and `apAging` hold the words that differ:** the title, the party's column, the ledger's hint, the
  documents' title and the advance kinds. The ledger hints name the known gap of decision 5: a receipt (or payment)
  voided after the day makes the two differ.
- **`inAdvance` follows the customer and supplier lists:** "৳20,000 in advance" for a customer, "They owe you
  ৳20,000" for a supplier. A balance below zero is shown in these words, never as a minus sign.
- **`apAging.supplierBill` is the supplier's own number** under ours ("Their bill PSM/2026/0412"), the words of the
  supplier payment's allocation table, because that is the number on the paper in the accountant's hand.
- **Two empty states each:** nothing open at all, and nothing overdue with "Overdue only", which says how to see the
  rest.

```diff
@@ -6084,6 +6300,7 @@ export const en = {
       'A closing entry is undone by reopening its year on the Year-end close page.',
     report_range_invalid: 'Pick an end date on or after the start date.',
     report_compare_incomplete: 'Pick both dates of the comparison, or neither.',
+    report_sort_invalid: 'Only the report by product sorts by quantity. Pick another column.',
     year_end_invalid: 'Pick the last day of a fiscal year.',
     year_not_ended: "This year hasn't ended yet. Close it after its last day.",
     year_already_closed: 'This year is closed already. Reload to see it.',
```

**`report_sort_invalid`** (21b.1) says what to do: only the report by product sorts by quantity, because a quantity
adds up only inside one product. The page never offers that sort elsewhere (21b.6), so a person sees this only from a
link written by hand.

### `locales/bn.ts`

```diff
@@ -75,6 +75,10 @@ export const bn: Messages = {
     trialBalance: 'ট্রায়াল ব্যালান্স',
     profitAndLoss: 'লাভ-ক্ষতি',
     balanceSheet: 'ব্যালান্স শিট',
+    salesReport: 'বিক্রির রিপোর্ট',
+    purchaseReport: 'কেনাকাটার রিপোর্ট',
+    arAging: 'পাওনার এজিং',
+    apAging: 'দেনার এজিং',
     exports: 'এক্সপোর্ট',
     inventory: 'ইনভেন্টরি',
     products: 'প্রোডাক্ট',
@@ -999,6 +1003,10 @@ export const bn: Messages = {
       trial_balance: 'ট্রায়াল ব্যালান্স',
       profit_and_loss: 'লাভ-ক্ষতির হিসাব',
       balance_sheet: 'ব্যালান্স শিট',
+      sales_report: 'বিক্রির রিপোর্ট',
+      purchase_report: 'কেনাকাটার রিপোর্ট',
+      ar_aging: 'পাওনার এজিং',
+      ap_aging: 'দেনার এজিং',
     },
     formats: { xlsx: 'Excel', pdf: 'PDF' },
     sections: {
@@ -1083,6 +1091,188 @@ export const bn: Messages = {
       emptyTitle: 'এই দিনে বইয়ে কিছু নেই',
       emptyBody: 'পরের একটা দিন বাছুন, অথবা আগে ওপেনিং ব্যালান্স পোস্ট করুন।',
     },
+    groupBy: 'ভাগ করে দেখুন',
+    customerGroup: 'গ্রাহক গ্রুপ',
+    supplierGroup: 'সাপ্লায়ার গ্রুপ',
+    allGroups: 'সব গ্রুপ',
+    category: 'ক্যাটাগরি',
+    allCategories: 'সব ক্যাটাগরি',
+    categoryHint: 'এর সাব-ক্যাটাগরিগুলোও ধরা হয়।',
+    needsConnection: 'রিপোর্ট সার্ভারে তৈরি হয়। দেখতে ইন্টারনেটে যুক্ত হোন।',
+    loadFailedTitle: 'রিপোর্ট আনা যায়নি',
+    loadFailedBody: 'সংযোগ দেখে আবার চেষ্টা করুন।',
+    inBooks: 'হিসাবের খাতায়: {{amount}}',
+    booksAgree: 'খাতা মিলেছে',
+    booksOutBy: '{{amount}} গরমিল',
+    sales: {
+      title: 'বিক্রির রিপোর্ট',
+      description: 'একটা সময়কালে কী বিক্রি হলো, ডিসকাউন্ট আর ফেরত বাদে, VAT-এর আগে',
+      groups: {
+        customer: 'গ্রাহক',
+        product: 'প্রোডাক্ট',
+        category: 'ক্যাটাগরি',
+        branch: 'ব্রাঞ্চ',
+        month: 'মাস',
+      },
+      rowKinds: {
+        walk_in: 'ওয়াক-ইন গ্রাহক',
+        no_category: 'কোনো ক্যাটাগরি নেই',
+      },
+      rowKindHints: {
+        walk_in: 'গ্রাহক ছাড়া POS বিক্রি',
+      },
+      kpiHints: {
+        gross: 'ইনভয়েস আর POS বিক্রি',
+        returns: 'ক্রেডিট নোট আর POS ফেরত',
+        margin: 'নিট বিক্রির {{percent}}%',
+      },
+      columns: {
+        quantity: 'পরিমাণ',
+        gross: 'বিক্রি',
+        returns: 'ফেরত',
+        net: 'নিট বিক্রি',
+        cost: 'খরচ',
+        margin: 'মার্জিন',
+        marginPercent: 'মার্জিন %',
+      },
+      booksHint:
+        'খাতায় বিক্রি মানে বিক্রির অ্যাকাউন্ট বাদ বিক্রি ফেরতের অ্যাকাউন্ট। এই অ্যাকাউন্টে হাতে লেখা জার্নাল এন্ট্রি থাকলে দুটো আলাদা হয়।',
+      noBooks:
+        'গ্রাহক গ্রুপ বা ক্যাটাগরির কোনো হিসাব খাতায় নেই: জার্নালের লাইনে এর কোনোটাই থাকে না।',
+      costHint:
+        'খরচ মানে বিক্রি হওয়া মালের খরচ, ইনভয়েস বা POS বিক্রির তারিখে। খাতা চালানের খরচ ধরে চালানের তারিখে, তাই কোনো মাসে এটা লাভ-ক্ষতির হিসাব থেকে আলাদা হতে পারে।',
+      emptyTitle: 'এই তারিখগুলোতে কিছু বিক্রি হয়নি',
+      emptyBody: 'অন্য তারিখ বা ফিল্টার বাছুন, অথবা একটা ইনভয়েস পোস্ট করুন বা POS-এ বিক্রি করুন।',
+    },
+    purchases: {
+      title: 'কেনাকাটার রিপোর্ট',
+      description: 'একটা সময়কালে কত বিল হলো, ডেবিট নোট বাদে, VAT-এর আগে',
+      groups: {
+        supplier: 'সাপ্লায়ার',
+        product: 'প্রোডাক্ট',
+        account: 'খরচের অ্যাকাউন্ট',
+        month: 'মাস',
+      },
+      rowKinds: {
+        expenses: 'খরচ',
+        products: 'প্রোডাক্ট',
+      },
+      rowKindHints: {
+        expenses: 'বিলগুলোর অ্যাকাউন্ট লাইন আর খরচ একসাথে',
+        products: 'বিলগুলোর প্রোডাক্ট লাইন একসাথে',
+      },
+      kpiHints: {
+        gross: 'পোস্ট করা সাপ্লায়ারের বিল',
+        returns: 'বিল থেকে বাদ দেওয়া',
+      },
+      columns: {
+        quantity: 'পরিমাণ',
+        gross: 'বিল',
+        returns: 'ডেবিট নোট',
+        net: 'নিট কেনাকাটা',
+      },
+      categoryHint:
+        'এর সাব-ক্যাটাগরিগুলোও ধরা হয়। অ্যাকাউন্ট লাইন আর খরচের কোনো ক্যাটাগরি নেই, তাই সেগুলো বাদ যায়।',
+      emptyTitle: 'এই তারিখগুলোতে কিছু কেনা হয়নি',
+      emptyBody: 'অন্য তারিখ বা ফিল্টার বাছুন, অথবা একটা সাপ্লায়ারের বিল পোস্ট করুন।',
+    },
+    aging: {
+      show: 'দেখান',
+      shows: {
+        all: 'সবাই',
+        overdue: 'শুধু সময় পার',
+      },
+      buckets: {
+        current: 'সময় পার হয়নি',
+        days1To30: '১–৩০ দিন',
+        days31To60: '৩১–৬০ দিন',
+        days61To90: '৬১–৯০ দিন',
+        over90: '৯০ দিনের বেশি',
+      },
+      columns: {
+        due: 'মোট বকেয়া',
+        advances: 'অগ্রিম',
+        balance: 'ব্যালান্স',
+      },
+      overdue: 'সময় পার',
+      over90: '৯০ দিনের বেশি: {{amount}}',
+      balanceHint: 'মোট বকেয়া বাদ অগ্রিম',
+      showEveryone: '“সবাই” দেখান',
+      documentsSubtitle: 'সবচেয়ে পুরনো পরিশোধের তারিখ আগে',
+      bucketsHint:
+        'পরিশোধের তারিখের পর কত দিন গেছে। “সময় পার হয়নি” মানে এখনো তারিখ আসেনি, বা এই দিনটাই তারিখ।',
+      futureHint: 'আজকের পরের একটা দিন দেখায়, কিছু পরিশোধ না হলে তখন কী সময় পার হবে।',
+      noLedger: 'খাতা পরিশোধের তারিখ জানে না, তাই “শুধু সময় পার”-এর কোনো হিসাব খাতায় নেই।',
+      openParty: '{{name}}-এর খোলা হিসাব দেখুন',
+      documentColumns: {
+        number: 'নম্বর',
+        date: 'তারিখ',
+        dueDate: 'পরিশোধের তারিখ',
+        total: 'মোট',
+        open: 'এখনো বাকি',
+        daysOverdue: 'সময় পার',
+        bucket: 'কত দিনের',
+      },
+      notDue: 'সময় পার হয়নি',
+      daysOverdue_one: '{{count}} দিন',
+      daysOverdue_other: '{{count}} দিন',
+      advancesTitle: 'অগ্রিম',
+      advanceColumns: {
+        number: 'নম্বর',
+        date: 'তারিখ',
+        amount: 'এখনো লাগানো হয়নি',
+      },
+      partyDescription: '{{date}} তারিখে কী বাকি ছিল, প্রতিটা ডকুমেন্ট আলাদা করে',
+      partyEmptyTitle: 'এই দিনে কিছু বাকি নেই',
+      partyEmptyBody:
+        '{{date}} তারিখে {{name}}-এর কোনো বাকি ডকুমেন্ট বা অগ্রিম ছিল না। অন্য একটা দিন বাছুন।',
+    },
+    arAging: {
+      title: 'পাওনার এজিং',
+      description: 'একটা দিনে প্রতিটা গ্রাহকের কাছে কত পাওনা, কত দিন ধরে বকেয়া সেই অনুযায়ী',
+      party: 'গ্রাহক',
+      inAdvance: '{{amount}} অগ্রিম',
+      ledgerHint:
+        'এই দিনে পাওনার অ্যাকাউন্ট। ওপেনিং ব্যালান্স, হাতে লেখা জার্নাল এন্ট্রি আর এই দিনের পরে বাতিল হওয়া মানি রিসিট থাকলে দুটো আলাদা হয়।',
+      openCount_one: '{{count}}টি বাকি ইনভয়েস',
+      openCount_other: '{{count}}টি বাকি ইনভয়েস',
+      documentsTitle: 'বাকি ইনভয়েস',
+      advancesHint: 'পাওয়া গেছে, এখনো লাগানো হয়নি',
+      advancesSubtitle:
+        'যে টাকা পাওয়া বা ক্রেডিট করা হয়েছে, কিন্তু এখনো কোনো ইনভয়েসে লাগানো হয়নি',
+      advanceKinds: {
+        receipt: 'মানি রিসিট',
+        credit_note: 'ক্রেডিট নোট',
+      },
+      emptyTitle: 'এই দিনে কোনো গ্রাহকের কাছে পাওনা নেই',
+      emptyBody:
+        'অন্য একটা দিন বাছুন, অথবা একটা ইনভয়েস পোস্ট করুন। বাকি ইনভয়েস আর পাওয়া কিন্তু না-লাগানো টাকা এখানে দেখা যায়।',
+      overdueEmptyTitle: 'এই দিনে কিছু সময় পার হয়নি',
+      overdueEmptyBody: 'প্রতিটা বাকি ইনভয়েস এখনো তার শর্তের মধ্যে আছে। দেখতে “সবাই” বাছুন।',
+    },
+    apAging: {
+      title: 'দেনার এজিং',
+      description: 'একটা দিনে প্রতিটা সাপ্লায়ারের কাছে কত দেনা, কত দিন ধরে বকেয়া সেই অনুযায়ী',
+      party: 'সাপ্লায়ার',
+      inAdvance: 'তাদের কাছে {{amount}} পাওনা',
+      ledgerHint:
+        'এই দিনে দেনার অ্যাকাউন্ট। ওপেনিং ব্যালান্স, হাতে লেখা জার্নাল এন্ট্রি আর এই দিনের পরে বাতিল হওয়া পেমেন্ট থাকলে দুটো আলাদা হয়।',
+      openCount_one: '{{count}}টি বাকি বিল',
+      openCount_other: '{{count}}টি বাকি বিল',
+      documentsTitle: 'বাকি বিল',
+      supplierBill: 'তাদের বিল {{number}}',
+      advancesHint: 'দেওয়া হয়েছে, এখনো লাগানো হয়নি',
+      advancesSubtitle: 'যে টাকা দেওয়া বা ডেবিট করা হয়েছে, কিন্তু এখনো কোনো বিলে লাগানো হয়নি',
+      advanceKinds: {
+        payment: 'সাপ্লায়ার পেমেন্ট',
+        debit_note: 'ডেবিট নোট',
+      },
+      emptyTitle: 'এই দিনে কোনো সাপ্লায়ারের কাছে দেনা নেই',
+      emptyBody:
+        'অন্য একটা দিন বাছুন, অথবা একটা সাপ্লায়ারের বিল পোস্ট করুন। বাকি বিল আর দেওয়া কিন্তু না-লাগানো টাকা এখানে দেখা যায়।',
+      overdueEmptyTitle: 'এই দিনে কিছু সময় পার হয়নি',
+      overdueEmptyBody: 'প্রতিটা বাকি বিল এখনো তার শর্তের মধ্যে আছে। দেখতে “সবাই” বাছুন।',
+    },
   },
   exports: {
     title: 'এক্সপোর্ট',
@@ -5737,6 +5927,8 @@ export const bn: Messages = {
     journal_is_year_close: 'ক্লোজিং এন্ট্রি উল্টাতে বছর শেষের ক্লোজিং পেজ থেকে বছরটা আবার খুলুন।',
     report_range_invalid: 'শুরুর তারিখের দিন বা তার পরের একটা শেষ তারিখ বাছুন।',
     report_compare_incomplete: 'তুলনার দুটো তারিখই বাছুন, অথবা কোনোটাই না।',
+    report_sort_invalid:
+      'শুধু প্রোডাক্ট অনুযায়ী রিপোর্ট পরিমাণ দিয়ে সাজানো যায়। অন্য একটা কলাম বাছুন।',
     year_end_invalid: 'একটা অর্থবছরের শেষ দিন বাছুন।',
     year_not_ended: 'এই বছর এখনো শেষ হয়নি। শেষ দিনের পরে ক্লোজ করুন।',
     year_already_closed: 'এই বছর আগেই ক্লোজ হয়েছে। দেখতে পেজটা রিলোড করুন।',
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`.
- **The terms are the app's own:** প্রোডাক্ট (the nav's word, not পণ্য), কেনাকাটা for purchase (the nav's
  group), পাওনা and দেনা for what customers owe and what is owed to suppliers (the lists' words), সময় পার for overdue
  (the invoice and bill filters), পরিশোধের তারিখ for the due date (the invoice form), অগ্রিম for an advance,
  মানি রিসিট, ক্রেডিট নোট, ডেবিট নোট and সাপ্লায়ার পেমেন্ট as the nav says them.
- **The pill's words are the stock valuation's:** "খাতা মিলেছে" and "{{amount}} গরমিল".
- **"Aging" stays এজিং,** an office term like ব্যালান্স শিট: পাওনার এজিং, দেনার এজিং.
- **"Current" is "সময় পার হয়নি",** the opposite of the overdue word, so the five buckets read as one scale.
- **`daysOverdue_one` / `_other` are the same text.** Bangla has one form here, but i18next asks for both keys,
  because the English type has both.

### `apps/api/src/reports/export/copy.ts`: the files' Bangla words

The diff of 21b.3 above already shows this file as it is now. Five Bangla words changed (decision 43): the purchase
report's title (কেনাকাটার রিপোর্ট), the product column and the "Products" row (প্রোডাক্ট), the net purchases
(নিট কেনাকাটা), the current bucket (সময় পার হয়নি) and "Overdue only" (শুধু সময় পার). No test reads these words,
and the English ones did not change.

### What I checked

- `i18n` type check: it fails before this part on the missing `report_sort_invalid`, and passes after it. Taking one
  key out of `bn.ts` fails it again (`bn.ts` must have every key of `en.ts`).
- The app's type check: before this part it fails on the bell and the exports page (`reports.kinds.*`) and on the
  mock; after it, only on the mock (`mocks/report-data.ts`, two errors), as expected until 21b.7.
- The API's type check, and the export document tests (10), after the change to `copy.ts`.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/app typecheck
pnpm exec eslint packages/i18n/src apps/api/src/reports/export
pnpm exec prettier --check packages/i18n/src apps/api/src/reports/export
cd apps/api && npx vitest run src/reports/export
```

All pass, except the app's type check on `mocks/report-data.ts` (above). The new words are used in 21b.6.

## 21b.6 — `apps/app`: the screens

Six pages: the sales report, the purchase report, the two agings and a party's page of each. The mockup was approved
before this code was written. Every page is a lazy chunk, because the first chunk has only a few KB left.

The new words came with the mockup. They are in the diffs of 21b.5 above: the KPI strip's lines (`kpiHints`,
`advancesHint`, `balanceHint`, `overdue`, `over90`), the walk-in row's line (`rowKindHints`), "Show everyone",
`documentsSubtitle`, the failed-load words and `openCount`. `mocks/report-data.ts` also gets the four file names of the
new kinds, so the app type-checks again:

```diff
@@ -375,6 +375,11 @@ const STEMS = {
   trial_balance: 'trial-balance',
   profit_and_loss: 'profit-and-loss',
   balance_sheet: 'balance-sheet',
+  // Step 21b: the names the API's fileStem() gives
+  sales_report: 'sales',
+  purchase_report: 'purchases',
+  ar_aging: 'receivables-aging',
+  ap_aging: 'payables-aging',
 } satisfies Record<ReportKind, string>;
 
 export function createExport(data: WorkspaceData, input: ReportExportInput): ReportExport {
```

### `apps/app/src/lib/trade-report-queries.ts` (new)

```ts
import {
  type AgingPartyQuery,
  type ApAgingFilter,
  type ArAgingFilter,
  type PurchaseReportFilter,
  routes,
  type SalesReportFilter,
} from '@omnivo/contracts';
import type { SortingState } from '@omnivo/ui';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 21b: the queries of the sales and purchase reports and of the two agings. Their own module,
// not lib/queries.ts: that file is in the first chunk every page loads, and these are read only by
// the four lazy report pages (the first chunk is a few KB under its budget).
//
// Every key starts with ['journal', tenantId] like the statements' (step 11): posting an invoice, a
// bill or a receipt invalidates that prefix, so an open report fetches its numbers again.

// 50 rows a page, like the other long lists. The API's cursor is opaque here (it holds an offset).
const PAGE = 50;

export function salesReportQuery(tenantId: string, filter: SalesReportFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'sales-report', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.tradeReports.sales, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A new filter keeps the old rows and totals on screen until its own arrive, instead of an
    // empty table that jumps
    placeholderData: keepPreviousData,
  });
}

export function purchaseReportQuery(tenantId: string, filter: PurchaseReportFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'purchase-report', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.tradeReports.purchases, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function arAgingQuery(tenantId: string, filter: ArAgingFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'ar-aging', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.aging.receivables, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export function apAgingQuery(tenantId: string, filter: ApAgingFilter) {
  return infiniteQueryOptions({
    queryKey: ['journal', tenantId, 'ap-aging', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.aging.payables, {
        query: { ...filter, limit: PAGE, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

// One party's page is not paged (the contract's agingPartyShape): a party's open documents fit
export function arAgingPartyQuery(tenantId: string, customerId: string, query: AgingPartyQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'ar-aging', 'party', customerId, query],
    queryFn: () => call(routes.aging.receivablesOf, { params: { customerId }, query }),
    placeholderData: keepPreviousData,
  });
}

export function apAgingPartyQuery(tenantId: string, supplierId: string, query: AgingPartyQuery) {
  return queryOptions({
    queryKey: ['journal', tenantId, 'ap-aging', 'party', supplierId, query],
    queryFn: () => call(routes.aging.payablesOf, { params: { supplierId }, query }),
    placeholderData: keepPreviousData,
  });
}

// The table's sort ([{ id: 'net', desc: true }]) as the API's sort ('-net'). A column's id is the
// sort's name, so one function serves the four reports. A sort the report does not have (a column
// the table no longer shows) falls back to the report's default instead of a 400.
export function sortOf<TSort extends string>(
  state: SortingState,
  sorts: readonly TSort[],
  fallback: TSort,
): TSort {
  const [first] = state;
  if (!first) return fallback;
  const wanted = first.desc ? `-${first.id}` : first.id;
  return sorts.find((sort) => sort === wanted) ?? fallback;
}

// The other way: the table's arrow for the sort the page asks with
export function sortingOf(sort: string): SortingState {
  return sort.startsWith('-') ? [{ id: sort.slice(1), desc: true }] : [{ id: sort, desc: false }];
}
```

- **Its own file, not `lib/queries.ts`.** That file is in the first chunk. These queries are read by the lazy report
  pages only.
- **Every key starts with `['journal', tenantId]`,** like the statements' queries. Posting an invoice, a bill or a
  receipt already invalidates that prefix, so an open report fetches its numbers again with no new code.
- **`keepPreviousData`.** Changing a filter keeps the old rows and totals on the screen until the new ones arrive.
  Without it the table would go empty and the page would jump on every change.
- **`sortOf()` falls back to the report's default.** A sort can point at a column that has just left the table
  (quantity, when the group changes). The fallback gives the default order instead of a 400.

### `apps/app/src/components/trade-report-parts.tsx` (new)

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { absMoney, isZeroMoney, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, EmptyState, Pill } from '@omnivo/ui';

import { initialsOf } from '../lib/customers';

// Step 21b: what the sales and purchase reports and the two agings share. Here, not in a route
// file: each route is its own lazy chunk, and importing from one would pull that page into the
// others (the same reason as report-parts.tsx).

// The books' line under a report's KPI strip: "Books agree" or "Out by ৳12,000.00", then what the
// books say in whole taka. `books` null means there is nothing to compare with (a customer group,
// a category, "Overdue only"), and the line says why instead, in neutral words: it is not a fault.
export function BooksLine({
  report,
  books,
  noBooks,
}: {
  // What the report adds up to, in the same sense as the books (net sales, or the balance)
  report: string;
  books: string | null;
  noBooks: string;
}) {
  const { t, format } = useLocale();
  if (books === null) {
    return (
      <p className="flex items-center gap-2 text-label font-normal text-ink-3">
        <HugeiconsIcon
          icon={InformationCircleIcon}
          size={15}
          strokeWidth={1.5}
          className="shrink-0"
        />
        {noBooks}
      </p>
    );
  }
  const difference = subtractMoney(report, books);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {isZeroMoney(difference) ? (
        <Pill tone="good" icon={CheckmarkCircle02Icon}>
          {t('reports.booksAgree')}
        </Pill>
      ) : (
        <Pill tone="crit" icon={Alert02Icon}>
          {/* With paisa: a difference under one taka would read "Out by ৳0" in whole taka */}
          {t('reports.booksOutBy', { amount: format.money(absMoney(difference), { decimals: 2 }) })}
        </Pill>
      )}
      <span className="text-label font-normal text-ink-3 tabular-nums">
        {t('reports.inBooks', { amount: format.money(books) })}
      </span>
    </div>
  );
}

// The first column's 30px tile (CLAUDE.md → Table): the name's initials on brand-soft, or for a row
// that stands for many things (walk-in customers, "Products") an icon on subtle, so it never reads
// as one more customer. `brand` puts an icon on brand-soft: an expense account is one thing of the
// group, like a customer, but has no initials worth showing ("6110 Warehouse rent").
export function NameTile({
  name,
  icon,
  brand = false,
}: {
  name?: string;
  icon?: IconSvgElement;
  brand?: boolean;
}) {
  return icon ? (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-[30px] shrink-0 place-items-center rounded-lg',
        brand ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
      )}
    >
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand"
    >
      {initialsOf(name ?? '')}
    </span>
  );
}

// Reports other than the Overview are made on the server only (a step 21 decision): offline the
// page says so in place of its filters and numbers, in the words of every online-only page
export function NeedsConnection() {
  const { t } = useLocale();
  return (
    <EmptyState
      icon={WifiDisconnected02Icon}
      title={t('sync.needsConnectionTitle')}
      description={t('reports.needsConnection')}
    />
  );
}

// The crit empty state with Retry (CLAUDE.md → Empty state)
export function LoadFailed({ icon, onRetry }: { icon: IconSvgElement; onRetry: () => void }) {
  const { t } = useLocale();
  return (
    <EmptyState
      tone="crit"
      icon={icon}
      title={t('reports.loadFailedTitle')}
      description={t('reports.loadFailedBody')}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      }
    />
  );
}

// The notes under a report: what its numbers mean, in 12px ink-3
export function Footnotes({ notes }: { notes: readonly (string | false)[] }) {
  const shown = notes.filter((note) => note !== false);
  if (shown.length === 0) return null;
  return (
    <div className="grid max-w-3xl gap-1 text-caption font-normal text-ink-3">
      {shown.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}
```

- **Here, not in a route file.** A route file is its own chunk, and importing from one would pull that page into the
  others.
- **`BooksLine` shows the difference with paisa and the books' figure in whole taka.** A difference under one taka
  would read "Out by ৳0" in whole taka, which says nothing.
- **`books === null` is a neutral line, not a warning.** A customer group or "Overdue only" simply has no figure in
  the books. Nothing is wrong.
- **`NameTile` has three looks.** Initials on `brand-soft` for one party; an icon on `subtle` for a row that stands for
  many things, so "Walk-in customers" never reads as one more customer; an icon on `brand-soft` for an account, which
  is one thing but has no initials worth showing.

### `apps/app/src/routes/sales-report.tsx` (new)

```tsx
import { CashierIcon, ChartLineData01Icon, FolderTreeIcon } from '@hugeicons/core-free-icons';
import {
  SALES_REPORT_GROUPS,
  SALES_REPORT_SORTS,
  type SalesReportFilter,
  type SalesReportGroup,
  type SalesReportRow,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  parseIsoDate,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NameTile,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { branchesQuery, customerGroupsQuery, productCategoriesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { salesReportQuery, sortingOf, sortOf } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: what was sold in a period, one row per customer, product, category, branch or month
// (decision 1). Sorted and paged on the server (decision 8): the table asks for the next 50 rows as
// it nears its end, and the totals in the KPI strip are of every row, not of the rows loaded.

const column = dataTableColumns<SalesReportRow>();

export function SalesReportPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canRead = can('sales.report.read');
  const online = useOnline();
  // A month is the usual question ("how did October go"); the presets change it in one click
  const period = usePeriod('this_month');
  const [groupBy, setGroupBy] = useState<SalesReportGroup>('customer');
  const [branchId, setBranchId] = useState('');
  const [customerGroupId, setCustomerGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sorting, setSorting] = useState<SortingState>(sortingOf('-net'));

  // Quantity sorts only by product (the contract refuses it elsewhere, report_sort_invalid), and
  // cost, margin and percent only with inventory.stock.value (a 403 otherwise). A column leaves
  // the table with its group or the permission, so a sort left on it falls back to the default
  // instead of an error.
  const canSeeCost = can('inventory.stock.value');
  const sort = sortOf(
    sorting.filter(
      (item) =>
        (item.id !== 'quantity' || groupBy === 'product') &&
        (canSeeCost || !['cost', 'margin', 'marginPercent'].includes(item.id)),
    ),
    SALES_REPORT_SORTS,
    '-net',
  );
  // The filters without the page: what the export carries too, so the file has the same rows in
  // the same order. The ids only when chosen: an empty string is not a uuid.
  const filter: SalesReportFilter = {
    from: period.range.from,
    to: period.range.to,
    groupBy,
    sort,
    ...(branchId !== '' && { branchId }),
    ...(customerGroupId !== '' && { customerGroupId }),
    ...(categoryId !== '' && { categoryId }),
  };

  const report = useInfiniteQuery({
    ...salesReportQuery(tenantId, filter),
    // Without the permission the API answers 403; offline it cannot answer at all; a range that
    // ends before it starts is a 400, and the page says so under "To" instead of asking
    enabled: canRead && online && period.valid,
  });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;
  const groups = useQuery({ ...customerGroupsQuery(tenantId), enabled: canRead }).data;
  const categories = useQuery({ ...productCategoriesQuery(tenantId), enabled: canRead }).data;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // From the answer, not from the permission: the API decides, so the columns are right even when
  // a role changed since the page loaded, and even with no rows
  const withCost = first?.withCost ?? false;

  const columns = useMemo(() => {
    // The first column says what the rows are: "Customer", "Month"
    const nameColumn = column.accessor('name', {
      header: t(`reports.sales.groups.${groupBy}`),
      meta: { card: 'title' },
      cell: ({ row }) => {
        const item = row.original;
        if (item.kind === 'walk_in') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={CashierIcon} />
              <span className="grid">
                <span className="font-medium text-ink">{t('reports.sales.rowKinds.walk_in')}</span>
                <span className="text-caption text-ink-3">
                  {t('reports.sales.rowKindHints.walk_in')}
                </span>
              </span>
            </span>
          );
        }
        if (item.kind === 'no_category') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={FolderTreeIcon} />
              <span className="font-medium text-ink">
                {t('reports.sales.rowKinds.no_category')}
              </span>
            </span>
          );
        }
        // A month: "October 2026", from its first day read with local date parts
        if (item.month !== null) {
          const date = parseIsoDate(`${item.month}-01`);
          return (
            <span className="font-medium text-ink">{date ? format.month(date) : item.month}</span>
          );
        }
        // A category has no code, and no tile: its name is a word, not a party's
        if (item.code === null) {
          return <span className="font-medium text-ink">{item.name}</span>;
        }
        return (
          <span className="flex items-center gap-3">
            <NameTile name={item.name ?? ''} />
            <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[20rem]">
              <span className="truncate font-medium text-ink">{item.name}</span>
              <span className="font-mono text-caption text-ink-3 tabular-nums">{item.code}</span>
            </span>
          </span>
        );
      },
    });
    const money = (id: 'gross' | 'returns' | 'net', strong = false) =>
      column.accessor(id, {
        header: t(`reports.sales.columns.${id}`),
        meta: { align: 'end', card: id === 'net' ? 'trailing' : 'detail' },
        cell: ({ getValue }) => (
          <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
            {format.money(getValue())}
          </span>
        ),
      });
    // null without inventory.stock.value; the column is not drawn then, the dash is for a percent
    // of a row whose net is zero
    const cost = (id: 'cost' | 'margin') =>
      column.accessor(id, {
        header: t(`reports.sales.columns.${id}`),
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => {
          const value = getValue();
          return value === null ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className="text-ink-2">{format.money(value)}</span>
          );
        },
      });
    return column.columns([
      nameColumn,
      ...(groupBy === 'product'
        ? [
            column.accessor('quantity', {
              header: t('reports.sales.columns.quantity'),
              meta: { align: 'end', card: 'detail' },
              cell: ({ row }) => {
                const { quantity, baseUnit } = row.original;
                return quantity === null || baseUnit === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  // "18,400 tab": the base unit's own decimals and code (CLAUDE.md → Quantities)
                  <span className="text-ink-2">
                    {format.number(quantity, baseUnit.decimals)} {baseUnit.code}
                  </span>
                );
              },
            }),
          ]
        : []),
      money('gross'),
      money('returns'),
      money('net', true),
      ...(withCost
        ? [
            cost('cost'),
            cost('margin'),
            column.accessor('marginPercent', {
              header: t('reports.sales.columns.marginPercent'),
              meta: { align: 'end', card: 'detail' },
              cell: ({ getValue }) => {
                const value = getValue();
                return value === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="text-ink-2">{format.number(value, 1)}%</span>
                );
              },
            }),
          ]
        : []),
    ]);
  }, [t, format, groupBy, withCost]);

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PageHeader title={t('reports.sales.title')} description={t('reports.sales.description')} />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'sales.report.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.sales.title')}
        description={t('reports.sales.description')}
        actions={
          online &&
          period.valid && (
            <ExportMenu request={(format) => ({ report: 'sales_report', format, query: filter })} />
          )
        }
      />
      {!online ? (
        <NeedsConnection />
      ) : (
        <>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3 xl:grid-cols-4">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
            <SelectField
              label={t('reports.groupBy')}
              value={groupBy}
              options={SALES_REPORT_GROUPS.map((value) => ({
                value,
                label: t(`reports.sales.groups.${value}`),
              }))}
              onChange={(event) => {
                const next = SALES_REPORT_GROUPS.find((value) => value === event.target.value);
                if (next) setGroupBy(next);
              }}
            />
            <SelectField
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((branch) => ({
                  value: branch.id,
                  label: `${branch.code} · ${branch.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.customerGroup')}
              value={customerGroupId}
              options={[
                { value: '', label: t('reports.allGroups') },
                ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(event) => {
                setCustomerGroupId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.category')}
              value={categoryId}
              // Said only once a category is chosen: before that there is nothing to explain
              hint={categoryId === '' ? undefined : t('reports.categoryHint')}
              options={[
                { value: '', label: t('reports.allCategories') },
                ...categoryOptions(categories ?? []),
              ]}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={ChartLineData01Icon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.sales.columns.gross'),
                      value: format.money(first.totals.gross),
                      sub: t('reports.sales.kpiHints.gross'),
                    },
                    {
                      label: t('reports.sales.columns.returns'),
                      value: format.money(first.totals.returns),
                      sub: t('reports.sales.kpiHints.returns'),
                    },
                    {
                      label: t('reports.sales.columns.net'),
                      value: format.money(first.totals.net),
                    },
                    ...(withCost && first.totals.margin !== null
                      ? [
                          {
                            label: t('reports.sales.columns.margin'),
                            value: format.money(first.totals.margin),
                            sub:
                              first.totals.marginPercent === null
                                ? undefined
                                : t('reports.sales.kpiHints.margin', {
                                    percent: format.number(first.totals.marginPercent, 1),
                                  }),
                          },
                        ]
                      : []),
                  ]}
                />
                <BooksLine
                  report={first.totals.net}
                  books={first.books}
                  noBooks={t('reports.sales.noBooks')}
                />
                <DataTable
                  label={t('reports.sales.title')}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.key}
                  sorting={{ state: sorting, onChange: setSorting }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={ChartLineData01Icon}
                      title={t('reports.sales.emptyTitle')}
                      description={t('reports.sales.emptyBody')}
                    />
                  }
                  footer={
                    isFetchingNextPage && (
                      <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                    )
                  }
                />
                <Footnotes
                  notes={[
                    first.books !== null && t('reports.sales.booksHint'),
                    withCost && t('reports.sales.costHint'),
                  ]}
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
```

- **The columns come from `first.withCost`, not from the permission.** The API decides. If a role changed after the
  page loaded, the columns still match the answer, and they are right when there are no rows.
- **The sort is cleaned before it is sent.** Quantity sorts only by product, and cost, margin and percent only with
  `inventory.stock.value`. A column leaves the table with its group, so a sort left on it would be a 400 or a 403.
  `sorting.filter(...)` drops it and `sortOf()` uses `-net`.
- **The filter object is what the export carries too.** One object for the query and the `ExportMenu`, so the file has
  the same rows in the same order.
- **`{ branchId }` only when chosen.** An empty string is not a uuid, and the API would refuse it.
- **`enabled: canRead && online && period.valid`.** Without the permission the API answers 403. Offline it cannot
  answer. A range that ends before it starts is shown under "To" by `PeriodFields`, so the page does not ask.
- **A month is read with local date parts** through `parseIsoDate`, never `new Date('2026-09-01')`, which is midnight
  UTC and can be the day before in some time zones.

### `apps/app/src/routes/purchase-report.tsx` (new)

```tsx
import {
  Book02Icon,
  FolderTreeIcon,
  Invoice01Icon,
  PackageIcon,
  ShoppingBag01Icon,
} from '@hugeicons/core-free-icons';
import {
  PURCHASE_REPORT_GROUPS,
  PURCHASE_REPORT_SORTS,
  type PurchaseReportFilter,
  type PurchaseReportGroup,
  type PurchaseReportRow,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  parseIsoDate,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import { LoadFailed, NameTile, NeedsConnection } from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { categoryOptions } from '../lib/products';
import { branchesQuery, productCategoriesQuery, supplierGroupsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { purchaseReportQuery, sortingOf, sortOf } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: what was billed in a period, one row per supplier, product, expense account or month
// (decision 1). The sales report's twin, without cost and without a books' line: a bill's lines go
// to stock, to goods received not billed or to any expense account, so no one account says
// "purchases" the way the sales account says sales.

const column = dataTableColumns<PurchaseReportRow>();

export function PurchaseReportPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('purchase.report.read');
  const online = useOnline();
  const period = usePeriod('this_month');
  const [groupBy, setGroupBy] = useState<PurchaseReportGroup>('supplier');
  const [branchId, setBranchId] = useState('');
  const [supplierGroupId, setSupplierGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sorting, setSorting] = useState<SortingState>(sortingOf('-net'));

  // Quantity sorts only by product (the contract refuses it elsewhere). The column leaves the
  // table with its group, so a sort left on it falls back to the default instead of an error.
  const sort = sortOf(
    sorting.filter((item) => item.id !== 'quantity' || groupBy === 'product'),
    PURCHASE_REPORT_SORTS,
    '-net',
  );
  const filter: PurchaseReportFilter = {
    from: period.range.from,
    to: period.range.to,
    groupBy,
    sort,
    ...(branchId !== '' && { branchId }),
    ...(supplierGroupId !== '' && { supplierGroupId }),
    ...(categoryId !== '' && { categoryId }),
  };

  const report = useInfiniteQuery({
    ...purchaseReportQuery(tenantId, filter),
    enabled: canRead && online && period.valid,
  });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;
  const groups = useQuery({ ...supplierGroupsQuery(tenantId), enabled: canRead }).data;
  const categories = useQuery({ ...productCategoriesQuery(tenantId), enabled: canRead }).data;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const nameColumn = column.accessor('name', {
      header: t(`reports.purchases.groups.${groupBy}`),
      meta: { card: 'title' },
      cell: ({ row }) => {
        const item = row.original;
        // The one row that stands for everything the group has no row for (decision 11), so the
        // rows always add up to all purchases
        if (item.kind === 'expenses' || item.kind === 'products') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={item.kind === 'products' ? PackageIcon : Invoice01Icon} />
              <span className="grid">
                <span className="font-medium text-ink">
                  {t(`reports.purchases.rowKinds.${item.kind}`)}
                </span>
                <span className="text-caption text-ink-3">
                  {t(`reports.purchases.rowKindHints.${item.kind}`)}
                </span>
              </span>
            </span>
          );
        }
        if (item.kind === 'no_category') {
          return (
            <span className="flex items-center gap-3">
              <NameTile icon={FolderTreeIcon} />
              <span className="font-medium text-ink">
                {t('reports.sales.rowKinds.no_category')}
              </span>
            </span>
          );
        }
        if (item.month !== null) {
          const date = parseIsoDate(`${item.month}-01`);
          return (
            <span className="font-medium text-ink">{date ? format.month(date) : item.month}</span>
          );
        }
        return (
          <span className="flex items-center gap-3">
            {groupBy === 'account' ? (
              <NameTile icon={Book02Icon} brand />
            ) : (
              <NameTile name={item.name ?? ''} />
            )}
            <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[20rem]">
              <span className="truncate font-medium text-ink">{item.name}</span>
              <span className="font-mono text-caption text-ink-3 tabular-nums">{item.code}</span>
            </span>
          </span>
        );
      },
    });
    const money = (id: 'gross' | 'returns' | 'net', strong = false) =>
      column.accessor(id, {
        header: t(`reports.purchases.columns.${id}`),
        meta: { align: 'end', card: id === 'net' ? 'trailing' : 'detail' },
        cell: ({ getValue }) => (
          <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
            {format.money(getValue())}
          </span>
        ),
      });
    return column.columns([
      nameColumn,
      ...(groupBy === 'product'
        ? [
            column.accessor('quantity', {
              header: t('reports.purchases.columns.quantity'),
              meta: { align: 'end', card: 'detail' },
              cell: ({ row }) => {
                const { quantity, baseUnit } = row.original;
                // The "Expenses" row has no quantity: litres of diesel and a rent do not add up
                return quantity === null || baseUnit === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="text-ink-2">
                    {format.number(quantity, baseUnit.decimals)} {baseUnit.code}
                  </span>
                );
              },
            }),
          ]
        : []),
      money('gross'),
      money('returns'),
      money('net', true),
    ]);
  }, [t, format, groupBy]);

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PageHeader
          title={t('reports.purchases.title')}
          description={t('reports.purchases.description')}
        />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'purchase.report.read' })}
        </p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.purchases.title')}
        description={t('reports.purchases.description')}
        actions={
          online &&
          period.valid && (
            <ExportMenu
              request={(format) => ({ report: 'purchase_report', format, query: filter })}
            />
          )
        }
      />
      {!online ? (
        <NeedsConnection />
      ) : (
        <>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3 xl:grid-cols-4">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
            <SelectField
              label={t('reports.groupBy')}
              value={groupBy}
              options={PURCHASE_REPORT_GROUPS.map((value) => ({
                value,
                label: t(`reports.purchases.groups.${value}`),
              }))}
              onChange={(event) => {
                const next = PURCHASE_REPORT_GROUPS.find((value) => value === event.target.value);
                if (next) setGroupBy(next);
              }}
            />
            <SelectField
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((branch) => ({
                  value: branch.id,
                  label: `${branch.code} · ${branch.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.supplierGroup')}
              value={supplierGroupId}
              options={[
                { value: '', label: t('reports.allGroups') },
                ...(groups ?? []).map((group) => ({ value: group.id, label: group.name })),
              ]}
              onChange={(event) => {
                setSupplierGroupId(event.target.value);
              }}
            />
            <SelectField
              label={t('reports.category')}
              value={categoryId}
              hint={categoryId === '' ? undefined : t('reports.purchases.categoryHint')}
              options={[
                { value: '', label: t('reports.allCategories') },
                ...categoryOptions(categories ?? []),
              ]}
              onChange={(event) => {
                setCategoryId(event.target.value);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={ShoppingBag01Icon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.purchases.columns.gross'),
                      value: format.money(first.totals.gross),
                      sub: t('reports.purchases.kpiHints.gross'),
                    },
                    {
                      label: t('reports.purchases.columns.returns'),
                      value: format.money(first.totals.returns),
                      sub: t('reports.purchases.kpiHints.returns'),
                    },
                    {
                      label: t('reports.purchases.columns.net'),
                      value: format.money(first.totals.net),
                    },
                  ]}
                />
                <DataTable
                  label={t('reports.purchases.title')}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.key}
                  sorting={{ state: sorting, onChange: setSorting }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={ShoppingBag01Icon}
                      title={t('reports.purchases.emptyTitle')}
                      description={t('reports.purchases.emptyBody')}
                    />
                  }
                  footer={
                    isFetchingNextPage && (
                      <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                    )
                  }
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
```

The sales report's twin. It is a separate file, not one generic page, because the two share little past the layout: no
cost columns, no books' line, other row kinds, another group filter.

- **No books' line.** A bill's lines go to stock, to goods received not billed or to any expense account. No one
  account says "purchases" the way the sales account says sales.
- **`Book02Icon` with `brand` for an account row, `PackageIcon` on `subtle` for "Products".** The same rule as
  `NameTile` above: one thing, or a row for many things.

### `apps/app/src/components/aging-parts.tsx` (new)

```tsx
import {
  absMoney,
  type AgingAmounts,
  type AgingShow,
  isNegativeMoney,
  isZeroMoney,
  subtractMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { KpiCell } from '@omnivo/ui';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useReportCalendar } from './report-hooks';

// Step 21b: what the two aging pages and the two party pages share. Here, not in a route file, for
// the same reason as report-parts.tsx.

export type AgingNamespace = 'arAging' | 'apAging';

interface AgingSearch {
  asOf?: string;
  groupId?: string;
  show?: 'overdue';
}

// Only what differs from the defaults goes in the address, so a plain link stays plain: an empty day
// means "today", which keeps following the company's clock
function searchOf(asOf: string | undefined, groupId: string, show: AgingShow): AgingSearch {
  return {
    ...(asOf !== undefined && asOf !== '' && { asOf }),
    ...(groupId !== '' && { groupId }),
    ...(show === 'overdue' && { show }),
  };
}

// The day and the filters are in the address (router.tsx, agingSearch), so going to a party's page
// and back lands on the same report, and the address can be sent to someone.
export function useAgingFilters() {
  const navigate = useNavigate();
  const { today } = useReportCalendar();
  const { asOf: asOfParam, groupId = '', show: showParam } = useSearch({ strict: false });
  // Not strict, so this field is every route's `show` together; only these two mean anything here
  const show: AgingShow = showParam === 'overdue' ? 'overdue' : 'all';
  // Memoized: the table's columns link with it, and new columns on every render would remount
  // every cell (a keyboard user's focus on a link would be lost)
  const search = useMemo(() => searchOf(asOfParam, groupId, show), [asOfParam, groupId, show]);
  // '.' is the page's own address, so the party page changes its day without leaving it. replace:
  // a changed filter is not a place to come back to with the browser's Back button.
  const update = (next: AgingSearch) => {
    void navigate({ to: '.', search: next, replace: true });
  };
  return {
    today,
    // Empty until the settings say what day it is in the company's time zone
    asOf: asOfParam ?? today,
    groupId,
    show,
    search,
    chooseDay: (asOf: string) => {
      update(searchOf(asOf, groupId, show));
    },
    chooseGroup: (id: string) => {
      update(searchOf(asOfParam, id, show));
    },
    chooseShow: (value: AgingShow) => {
      update(searchOf(asOfParam, groupId, value));
    },
  };
}

// A balance below zero means the party is ahead: "৳50,000 in advance" for a customer, "They owe you
// ৳50,000" for a supplier. It reads the words, not a minus sign, like a customer's balance elsewhere.
export function useBalanceWords(namespace: AgingNamespace): (balance: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (balance) =>
      isNegativeMoney(balance)
        ? t(`reports.${namespace}.inAdvance`, { amount: format.money(absMoney(balance)) })
        : format.money(balance),
    [t, format, namespace],
  );
}

// The KPI strip of a report and of a party's page: the same four cells. `dueSub` is the line under
// the total, which only a party's page has (how many documents are open).
export function useAgingKpis(namespace: AgingNamespace) {
  const { t, format } = useLocale();
  const balanceWords = useBalanceWords(namespace);
  return (totals: AgingAmounts, dueSub?: string): KpiCell[] => [
    { label: t('reports.aging.columns.due'), value: format.money(totals.due), sub: dueSub },
    {
      label: t('reports.aging.overdue'),
      // The buckets after Current together
      value: format.money(subtractMoney(totals.due, totals.current)),
      sub: isZeroMoney(totals.over90)
        ? undefined
        : t('reports.aging.over90', { amount: format.money(totals.over90) }),
    },
    {
      label: t('reports.aging.columns.advances'),
      value: format.money(totals.advances),
      sub: t(`reports.${namespace}.advancesHint`),
    },
    {
      label: t('reports.aging.columns.balance'),
      value: balanceWords(totals.balance),
      sub: t('reports.aging.balanceHint'),
    },
  ];
}
```

- **`searchOf()` writes only what differs from the defaults.** A plain link stays plain, and an empty day means today,
  which keeps following the company's clock. A day written into the address would stay fixed.
- **`show` is narrowed by hand.** `useSearch({ strict: false })` merges every route's search, so the field is wider than
  this page's. Only `'overdue'` means anything here.
- **`search` is memoized, and `useBalanceWords` returns a `useCallback`.** The table's columns are memoized on them. New
  columns on every render would remount every cell, and a keyboard user's focus on a link would be lost.
- **`to: '.'` with `replace: true`.** `'.'` is the page's own address, so a party's page can change its day without
  leaving it. A changed filter is not a place to come back to with the browser's Back button.
- **The balance reads in words.** A customer ahead is "৳50,000 in advance", a supplier ahead is "They owe you ৳50,000".
  A minus sign would not say which way the money goes.
- **`isZeroMoney`, never `Number()`.** Money stays a decimal string end to end.

### `apps/app/src/routes/aging.tsx` (new)

```tsx
import { Clock01Icon, TimeQuarterPassIcon } from '@hugeicons/core-free-icons';
import {
  AGING_SORTS,
  type AgingBucket,
  type AgingReport,
  type AgingRow,
  type AgingShow,
  type ApAgingFilter,
  type ArAgingFilter,
  isZeroMoney,
  type ReportExportInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  KpiStrip,
  PageHeader,
  SegmentedControl,
  SelectField,
  type SortingState,
} from '@omnivo/ui';
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import {
  type AgingNamespace,
  useAgingFilters,
  useAgingKpis,
  useBalanceWords,
} from '../components/aging-parts';
import { ExportMenu } from '../components/report-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NameTile,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, supplierGroupsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { apAgingQuery, arAgingQuery, sortingOf, sortOf } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: on a chosen day, what each customer owes or each supplier is owed, split by how long it
// has been due (decisions 5 and 6). The two reports are one page with different words, so each
// route only runs its own query and gives the view what differs.

const column = dataTableColumns<AgingRow>();

const BUCKETS: readonly AgingBucket[] = [
  'current',
  'days1To30',
  'days31To60',
  'days61To90',
  'over90',
];

// A-Z: this report is for finding a party, and the KPI strip already says how much is overdue
const DEFAULT_SORT = 'name';

export function ArAgingPage() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('sales.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { search } = filters;
  const [sorting, setSorting] = useState<SortingState>(sortingOf(DEFAULT_SORT));
  const filter: ArAgingFilter = {
    asOf: filters.asOf,
    show: filters.show,
    sort: sortOf(sorting, AGING_SORTS, DEFAULT_SORT),
    ...(filters.groupId !== '' && { customerGroupId: filters.groupId }),
  };
  const report = useInfiniteQuery({
    ...arAgingQuery(tenantId, filter),
    enabled: canRead && online && filter.asOf !== '',
  });
  const groups = useQuery({ ...customerGroupsQuery(tenantId), enabled: canRead }).data;
  const partyLink = useCallback(
    (row: AgingRow, children: ReactNode) => (
      <Link
        to="/reports/ar-aging/$customerId"
        params={{ customerId: row.party.id }}
        search={search}
        // The row opens the same page; without this the click would navigate twice
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {children}
      </Link>
    ),
    [search],
  );
  return (
    <AgingView
      namespace="arAging"
      permission="sales.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      report={report}
      groups={groups ?? []}
      groupLabel="reports.customerGroup"
      exportRequest={(format) => ({ report: 'ar_aging', format, query: filter })}
      sorting={sorting}
      onSorting={setSorting}
      partyLink={partyLink}
      openParty={(navigate, row) => {
        void navigate({
          to: '/reports/ar-aging/$customerId',
          params: { customerId: row.party.id },
          search: filters.search,
        });
      }}
    />
  );
}

export function ApAgingPage() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('purchase.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { search } = filters;
  const [sorting, setSorting] = useState<SortingState>(sortingOf(DEFAULT_SORT));
  const filter: ApAgingFilter = {
    asOf: filters.asOf,
    show: filters.show,
    sort: sortOf(sorting, AGING_SORTS, DEFAULT_SORT),
    ...(filters.groupId !== '' && { supplierGroupId: filters.groupId }),
  };
  const report = useInfiniteQuery({
    ...apAgingQuery(tenantId, filter),
    enabled: canRead && online && filter.asOf !== '',
  });
  const groups = useQuery({ ...supplierGroupsQuery(tenantId), enabled: canRead }).data;
  const partyLink = useCallback(
    (row: AgingRow, children: ReactNode) => (
      <Link
        to="/reports/ap-aging/$supplierId"
        params={{ supplierId: row.party.id }}
        search={search}
        // The row opens the same page; without this the click would navigate twice
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {children}
      </Link>
    ),
    [search],
  );
  return (
    <AgingView
      namespace="apAging"
      permission="purchase.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      report={report}
      groups={groups ?? []}
      groupLabel="reports.supplierGroup"
      exportRequest={(format) => ({ report: 'ap_aging', format, query: filter })}
      sorting={sorting}
      onSorting={setSorting}
      partyLink={partyLink}
      openParty={(navigate, row) => {
        void navigate({
          to: '/reports/ap-aging/$supplierId',
          params: { supplierId: row.party.id },
          search: filters.search,
        });
      }}
    />
  );
}

function AgingView({
  namespace,
  permission,
  canRead,
  online,
  filters,
  report,
  groups,
  groupLabel,
  exportRequest,
  sorting,
  onSorting,
  partyLink,
  openParty,
}: {
  namespace: AgingNamespace;
  permission: 'sales.report.read' | 'purchase.report.read';
  canRead: boolean;
  online: boolean;
  filters: ReturnType<typeof useAgingFilters>;
  report: UseInfiniteQueryResult<InfiniteData<AgingReport>>;
  groups: readonly { id: string; name: string }[];
  groupLabel: 'reports.customerGroup' | 'reports.supplierGroup';
  exportRequest: (format: 'xlsx' | 'pdf') => ReportExportInput;
  sorting: SortingState;
  onSorting: (next: SortingState) => void;
  partyLink: (row: AgingRow, children: ReactNode) => ReactNode;
  openParty: (navigate: ReturnType<typeof useNavigate>, row: AgingRow) => void;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const kpis = useAgingKpis(namespace);
  const balanceWords = useBalanceWords(namespace);
  const { asOf, today, show, groupId } = filters;

  const first = report.data?.pages[0];
  const rows = useMemo(() => report.data?.pages.flatMap((page) => page.items), [report.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = report;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    // A zero is a dash, not ৳0: a row of five bucket columns reads by where its money is
    const amount = (id: AgingBucket | 'due' | 'advances', header: string, strong = false) =>
      column.accessor(id, {
        header,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) =>
          isZeroMoney(getValue()) ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
              {format.money(getValue())}
            </span>
          ),
      });
    return column.columns([
      column.accessor((row) => row.party.name, {
        id: 'name',
        header: t(`reports.${namespace}.party`),
        meta: { card: 'title' },
        cell: ({ row }) => {
          const { party } = row.original;
          return partyLink(
            row.original,
            <span
              className="flex items-center gap-3"
              aria-label={t('reports.aging.openParty', { name: party.name })}
            >
              <NameTile name={party.name} />
              <span className="grid min-w-0 min-[860px]:min-w-48 max-w-[16rem]">
                <span className="truncate font-medium text-ink">{party.name}</span>
                <span className="font-mono text-caption text-ink-3 tabular-nums">{party.code}</span>
              </span>
            </span>,
          );
        },
      }),
      ...BUCKETS.map((bucket) => amount(bucket, t(`reports.aging.buckets.${bucket}`))),
      amount('due', t('reports.aging.columns.due'), true),
      amount('advances', t('reports.aging.columns.advances')),
      column.accessor('balance', {
        header: t('reports.aging.columns.balance'),
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => (
          <span className="font-medium text-ink">{balanceWords(getValue())}</span>
        ),
      }),
    ]);
  }, [t, format, namespace, partyLink, balanceWords]);

  const header = (
    <PageHeader
      title={t(`reports.${namespace}.title`)}
      description={t(`reports.${namespace}.description`)}
      actions={canRead && online && asOf !== '' && <ExportMenu request={exportRequest} />}
    />
  );
  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: permission })}
        </p>
      </div>
    );
  }

  const overdueOnly = show === 'overdue';
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
      {!online ? (
        <NeedsConnection />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-full sm:w-56">
              <Field id="aging-as-of" label={t('reports.asOf')}>
                <DatePicker id="aging-as-of" value={asOf} onChange={filters.chooseDay} />
              </Field>
            </div>
            <div className="w-full sm:w-56">
              <SelectField
                label={t(groupLabel)}
                value={groupId}
                options={[
                  { value: '', label: t('reports.allGroups') },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                onChange={(event) => {
                  filters.chooseGroup(event.target.value);
                }}
              />
            </div>
            <SegmentedControl<AgingShow>
              label={t('reports.aging.show')}
              value={show}
              options={[
                { value: 'all', label: t('reports.aging.shows.all') },
                { value: 'overdue', label: t('reports.aging.shows.overdue') },
              ]}
              onChange={filters.chooseShow}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={TimeQuarterPassIcon} onRetry={() => void report.refetch()} />
          ) : (
            first &&
            rows && (
              <>
                <KpiStrip cells={kpis(first.totals)} />
                <BooksLine
                  report={first.totals.balance}
                  books={first.ledger}
                  noBooks={t('reports.aging.noLedger')}
                />
                <DataTable
                  label={t(`reports.${namespace}.title`)}
                  data={rows}
                  columns={columns}
                  getRowId={(row) => row.party.id}
                  sorting={{ state: sorting, onChange: onSorting }}
                  onRowClick={(row) => {
                    openParty(navigate, row);
                  }}
                  onEndReached={loadMore}
                  empty={
                    <EmptyState
                      icon={overdueOnly ? Clock01Icon : TimeQuarterPassIcon}
                      title={t(
                        overdueOnly
                          ? `reports.${namespace}.overdueEmptyTitle`
                          : `reports.${namespace}.emptyTitle`,
                      )}
                      description={t(
                        overdueOnly
                          ? `reports.${namespace}.overdueEmptyBody`
                          : `reports.${namespace}.emptyBody`,
                      )}
                      action={
                        overdueOnly ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              filters.chooseShow('all');
                            }}
                          >
                            {t('reports.aging.showEveryone')}
                          </Button>
                        ) : undefined
                      }
                    />
                  }
                  footer={
                    isFetchingNextPage && (
                      <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                    )
                  }
                />
                <Footnotes
                  notes={[
                    t('reports.aging.bucketsHint'),
                    first.ledger !== null && t(`reports.${namespace}.ledgerHint`),
                    asOf > today && t('reports.aging.futureHint'),
                  ]}
                />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
```

- **One view, two small pages.** The two reports differ in words, queries, the group filter and the party's address.
  `ArAgingPage` and `ApAgingPage` each run their own typed query and give `AgingView` what differs, so each filter's
  own field (`customerGroupId`, `supplierGroupId`) stays checked by the compiler.
- **The first column is a real `Link`, and the row also opens the page.** The link has an accessible name ("See what
  Rupsha Medicine Corner has open") and can be opened in a new tab. `stopPropagation` stops the same click from also
  running the row's `onRowClick`, which would navigate twice.
- **`partyLink` is a `useCallback` on `search`,** for the same reason as above: the columns are memoized on it.
- **The row's key is the party's id,** which is unique in this answer. A trade report's row needs its own `key`
  because a row there can be a month or a "Walk-in" row with no id.
- **"Show everyone" switches the filter from the empty state.** The person asked for overdue only and got nothing, and
  the next thing they want is the whole list.
- **`asOf > today` compares ISO strings.** That is correct for this format, and it shows the note that a day after today
  is a forecast.

### `apps/app/src/routes/aging-party.tsx` (new)

```tsx
import { ArrowLeft01Icon, TimeQuarterPassIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type {
  AgingDocument,
  ApAgingAdvance,
  ApAgingDocument,
  ArAgingAdvance,
  ArAgingParty,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  KpiStrip,
  PageHeader,
  SectionHeader,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type ReactNode, useCallback, useMemo } from 'react';

import { type AgingNamespace, useAgingFilters, useAgingKpis } from '../components/aging-parts';
import { useIsoDate } from '../components/journal-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';
import { apAgingPartyQuery, arAgingPartyQuery } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: the documents behind one row of an aging, at the same day (decision 6). A number links
// to its document, so the person can go from "this much is 60 days late" to the invoice itself.

// What a party's page gets from the API, for either side. The documents and advances are generic
// so a bill keeps the supplier's own number and each advance its own kinds.
interface PartyData<TDocument, TAdvance> extends Pick<ArAgingParty, 'party' | 'totals' | 'ledger'> {
  documents: TDocument[];
  advances: TAdvance[];
}

// Outside the components: the columns are memoized on these, and a function made in a render would
// rebuild the columns (and remount every cell) on each one
function invoiceLink(row: AgingDocument, children: ReactNode) {
  return (
    <Link to="/invoices/$invoiceId" params={{ invoiceId: row.id }}>
      {children}
    </Link>
  );
}

function billLink(row: ApAgingDocument, children: ReactNode) {
  return (
    <Link to="/bills/$billId" params={{ billId: row.id }}>
      {children}
    </Link>
  );
}

function arAdvanceLink(row: ArAgingAdvance, children: ReactNode) {
  return row.kind === 'receipt' ? (
    <Link to="/receipts/$receiptId" params={{ receiptId: row.id }}>
      {children}
    </Link>
  ) : (
    <Link to="/credit-notes/$creditNoteId" params={{ creditNoteId: row.id }}>
      {children}
    </Link>
  );
}

function apAdvanceLink(row: ApAgingAdvance, children: ReactNode) {
  return row.kind === 'payment' ? (
    <Link to="/supplier-payments/$paymentId" params={{ paymentId: row.id }}>
      {children}
    </Link>
  ) : (
    <Link to="/debit-notes/$debitNoteId" params={{ debitNoteId: row.id }}>
      {children}
    </Link>
  );
}

export function ArAgingPartyPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('sales.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { customerId = '' } = useParams({ strict: false });
  const query = useQuery({
    ...arAgingPartyQuery(tenantId, customerId, { asOf: filters.asOf }),
    enabled: canRead && online && filters.asOf !== '',
  });
  const documents = useDocumentColumns<AgingDocument>(invoiceLink);
  const kindName = useCallback(
    (kind: ArAgingAdvance['kind']) => t(`reports.arAging.advanceKinds.${kind}`),
    [t],
  );
  const advances = useAdvanceColumns<ArAgingAdvance>(kindName, arAdvanceLink);
  return (
    <PartyView<AgingDocument, ArAgingAdvance>
      namespace="arAging"
      permission="sales.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      data={query.data}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      documentColumns={documents}
      advanceColumns={advances}
      back={
        <Link
          to="/reports/ar-aging"
          search={filters.search}
          className="inline-flex items-center gap-1.5 justify-self-start text-body-sm font-medium text-brand hover:underline hover:underline-offset-[3px]"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('reports.arAging.title')}
        </Link>
      }
    />
  );
}

export function ApAgingPartyPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('purchase.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { supplierId = '' } = useParams({ strict: false });
  const query = useQuery({
    ...apAgingPartyQuery(tenantId, supplierId, { asOf: filters.asOf }),
    enabled: canRead && online && filters.asOf !== '',
  });
  // Under our number: the number on the paper the supplier sent
  const theirNumber = useCallback(
    (row: ApAgingDocument) => t('reports.apAging.supplierBill', { number: row.supplierBillNumber }),
    [t],
  );
  const documents = useDocumentColumns<ApAgingDocument>(billLink, theirNumber);
  const kindName = useCallback(
    (kind: ApAgingAdvance['kind']) => t(`reports.apAging.advanceKinds.${kind}`),
    [t],
  );
  const advances = useAdvanceColumns<ApAgingAdvance>(kindName, apAdvanceLink);
  return (
    <PartyView<ApAgingDocument, ApAgingAdvance>
      namespace="apAging"
      permission="purchase.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      data={query.data}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      documentColumns={documents}
      advanceColumns={advances}
      back={
        <Link
          to="/reports/ap-aging"
          search={filters.search}
          className="inline-flex items-center gap-1.5 justify-self-start text-body-sm font-medium text-brand hover:underline hover:underline-offset-[3px]"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('reports.apAging.title')}
        </Link>
      }
    />
  );
}

function useDocumentColumns<TDocument extends AgingDocument>(
  documentLink: (row: TDocument, children: ReactNode) => ReactNode,
  subLine?: (row: TDocument) => string,
) {
  const { t, format } = useLocale();
  const showDate = useIsoDate();
  return useMemo(() => {
    const column = dataTableColumns<TDocument>();
    // The server's order is the one that means something here (the oldest due date first), and a
    // click on a header would sort amount strings as text, so no column sorts
    const money = (id: 'total' | 'open', strong = false) =>
      column.accessor((row) => row[id], {
        id,
        header: t(`reports.aging.documentColumns.${id}`),
        enableSorting: false,
        meta: { align: 'end', card: id === 'open' ? 'trailing' : 'detail' },
        cell: ({ getValue }) => (
          <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
            {format.money(getValue())}
          </span>
        ),
      });
    const date = (id: 'date' | 'dueDate') =>
      column.accessor((row) => row[id], {
        id,
        header: t(`reports.aging.documentColumns.${id}`),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <span className="text-ink-2">{showDate(getValue())}</span>,
      });
    return column.columns([
      column.accessor((row) => row.number, {
        id: 'number',
        header: t('reports.aging.documentColumns.number'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium text-brand tabular-nums hover:underline hover:underline-offset-[3px]">
              {documentLink(row.original, row.original.number)}
            </span>
            {subLine && <span className="text-caption text-ink-3">{subLine(row.original)}</span>}
          </span>
        ),
      }),
      date('date'),
      date('dueDate'),
      money('total'),
      money('open', true),
      column.accessor((row) => row.daysOverdue, {
        id: 'daysOverdue',
        header: t('reports.aging.documentColumns.daysOverdue'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => {
          const count = getValue();
          return count === 0 ? (
            <span className="text-ink-3">{t('reports.aging.notDue')}</span>
          ) : (
            <span className="text-ink-2">{t('reports.aging.daysOverdue', { count })}</span>
          );
        },
      }),
      column.accessor((row) => row.bucket, {
        id: 'bucket',
        header: t('reports.aging.documentColumns.bucket'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => (
          <span className="text-ink-2">{t(`reports.aging.buckets.${getValue()}`)}</span>
        ),
      }),
    ]);
  }, [t, format, showDate, documentLink, subLine]);
}

function useAdvanceColumns<TAdvance extends ArAgingAdvance | ApAgingAdvance>(
  kindName: (kind: TAdvance['kind']) => string,
  documentLink: (row: TAdvance, children: ReactNode) => ReactNode,
) {
  const { t, format } = useLocale();
  const showDate = useIsoDate();
  return useMemo(() => {
    const column = dataTableColumns<TAdvance>();
    return column.columns([
      column.accessor((row) => row.number, {
        id: 'number',
        header: t('reports.aging.advanceColumns.number'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium text-brand tabular-nums hover:underline hover:underline-offset-[3px]">
              {documentLink(row.original, row.original.number)}
            </span>
            <span className="text-caption text-ink-3">{kindName(row.original.kind)}</span>
          </span>
        ),
      }),
      column.accessor((row) => row.date, {
        id: 'date',
        header: t('reports.aging.advanceColumns.date'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <span className="text-ink-2">{showDate(getValue())}</span>,
      }),
      column.accessor((row) => row.amount, {
        id: 'amount',
        header: t('reports.aging.advanceColumns.amount'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => (
          <span className="font-medium text-ink">{format.money(getValue())}</span>
        ),
      }),
    ]);
  }, [t, format, showDate, kindName, documentLink]);
}

function PartyView<
  TDocument extends AgingDocument,
  TAdvance extends ArAgingAdvance | ApAgingAdvance,
>({
  namespace,
  permission,
  canRead,
  online,
  filters,
  data,
  isError,
  onRetry,
  documentColumns,
  advanceColumns,
  back,
}: {
  namespace: AgingNamespace;
  permission: 'sales.report.read' | 'purchase.report.read';
  canRead: boolean;
  online: boolean;
  filters: ReturnType<typeof useAgingFilters>;
  data: PartyData<TDocument, TAdvance> | undefined;
  isError: boolean;
  onRetry: () => void;
  documentColumns: ReturnType<typeof useDocumentColumns<TDocument>>;
  advanceColumns: ReturnType<typeof useAdvanceColumns<TAdvance>>;
  back: ReactNode;
}) {
  const { t } = useLocale();
  const showDate = useIsoDate();
  const kpis = useAgingKpis(namespace);
  const { asOf } = filters;
  const asAtField = (
    <div className="w-full sm:w-56">
      <Field id="aging-as-of" label={t('reports.asOf')}>
        <DatePicker id="aging-as-of" value={asOf} onChange={filters.chooseDay} />
      </Field>
    </div>
  );

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {back}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: permission })}
        </p>
      </div>
    );
  }

  const documents = data?.documents ?? [];
  const advances = data?.advances ?? [];
  const nothing = documents.length === 0 && advances.length === 0;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {back}
      {!online ? (
        <NeedsConnection />
      ) : isError ? (
        <LoadFailed icon={TimeQuarterPassIcon} onRetry={onRetry} />
      ) : (
        data && (
          <>
            <PageHeader
              title={data.party.name}
              description={t('reports.aging.partyDescription', { date: showDate(asOf) })}
              actions={asAtField}
            />
            {nothing ? (
              <EmptyState
                icon={TimeQuarterPassIcon}
                title={t('reports.aging.partyEmptyTitle')}
                description={t('reports.aging.partyEmptyBody', {
                  name: data.party.name,
                  date: showDate(asOf),
                })}
              />
            ) : (
              <>
                <KpiStrip
                  cells={kpis(
                    data.totals,
                    t(`reports.${namespace}.openCount`, { count: documents.length }),
                  )}
                />
                <BooksLine
                  report={data.totals.balance}
                  books={data.ledger}
                  noBooks={t('reports.aging.noLedger')}
                />
                {documents.length > 0 && (
                  <>
                    <SectionHeader
                      title={t(`reports.${namespace}.documentsTitle`)}
                      subtitle={t('reports.aging.documentsSubtitle')}
                    />
                    <DataTable
                      label={t(`reports.${namespace}.documentsTitle`)}
                      data={documents}
                      columns={documentColumns}
                      getRowId={(row) => row.id}
                    />
                  </>
                )}
                {advances.length > 0 && (
                  <>
                    <SectionHeader
                      title={t('reports.aging.advancesTitle')}
                      subtitle={t(`reports.${namespace}.advancesSubtitle`)}
                    />
                    <DataTable
                      label={t('reports.aging.advancesTitle')}
                      data={advances}
                      columns={advanceColumns}
                      getRowId={(row) => row.id}
                    />
                  </>
                )}
                <Footnotes
                  notes={[t('reports.aging.bucketsHint'), t(`reports.${namespace}.ledgerHint`)]}
                />
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
```

- **`PartyData<TDocument, TAdvance>` keeps a bill's type.** A bill has the supplier's own number, and each side has its
  own advance kinds. Being generic means no cast is needed when the view hands a row back to the page's link function.
- **The link functions are outside the components,** so they are the same function on every render.
- **No column sorts (`enableSorting: false`).** The list is not paged, so the table would sort it in the browser, and it
  would sort the amounts as text. The server's order, the oldest due date first, is the one that means something.
- **The back link carries `filters.search`,** so it returns to the same day, group and "Overdue only".
- **The page header waits for the answer.** The title is the party's name, and it is known only from the answer.
- **The KPI strip and the books' line are the same as the report's.** `totals` is the party's row of the report, so the
  two pages can never disagree.

### `apps/app/src/router.tsx`

```diff
@@ -161,6 +161,22 @@ const ledgerRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/ledger'), 'LedgerPage'),
 });
 
+// Step 21b: an aging's day and filters stay in the address, so a party's page comes back to them.
+// Anything else is dropped, and a value that is not what it says is not trusted (a bad date or id
+// would only be a 400 from the API).
+function agingSearch(search: Record<string, unknown>): {
+  asOf?: string;
+  groupId?: string;
+  show?: 'overdue';
+} {
+  return {
+    ...(typeof search.asOf === 'string' && ISO_DATE.test(search.asOf) && { asOf: search.asOf }),
+    ...(typeof search.groupId === 'string' &&
+      UUID.test(search.groupId) && { groupId: search.groupId }),
+    ...(search.show === 'overdue' && { show: 'overdue' as const }),
+  };
+}
+
 const openingBalancesRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/opening-balances',
@@ -191,6 +207,47 @@ const balanceSheetRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/balance-sheet'), 'BalanceSheetPage'),
 });
 
+// Step 21b: the sales and purchase reports and the two agings, each its own lazy chunk
+const salesReportRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/sales',
+  component: lazyRouteComponent(() => import('./routes/sales-report'), 'SalesReportPage'),
+});
+
+const purchaseReportRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/purchases',
+  component: lazyRouteComponent(() => import('./routes/purchase-report'), 'PurchaseReportPage'),
+});
+
+const arAgingRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/ar-aging',
+  validateSearch: agingSearch,
+  component: lazyRouteComponent(() => import('./routes/aging'), 'ArAgingPage'),
+});
+
+const arAgingPartyRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/ar-aging/$customerId',
+  validateSearch: agingSearch,
+  component: lazyRouteComponent(() => import('./routes/aging-party'), 'ArAgingPartyPage'),
+});
+
+const apAgingRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/ap-aging',
+  validateSearch: agingSearch,
+  component: lazyRouteComponent(() => import('./routes/aging'), 'ApAgingPage'),
+});
+
+const apAgingPartyRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/reports/ap-aging/$supplierId',
+  validateSearch: agingSearch,
+  component: lazyRouteComponent(() => import('./routes/aging-party'), 'ApAgingPartyPage'),
+});
+
 const reportExportsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/reports/exports',
@@ -980,6 +1037,12 @@ const routeTree = rootRoute.addChildren([
     trialBalanceRoute,
     profitAndLossRoute,
     balanceSheetRoute,
+    salesReportRoute,
+    purchaseReportRoute,
+    arAgingRoute,
+    arAgingPartyRoute,
+    apAgingRoute,
+    apAgingPartyRoute,
     reportExportsRoute,
     productsRoute,
     newProductRoute,
```

`agingSearch` drops anything else in the query string, and a value that is not what it says is not trusted, like the
ledger's route. `UUID` is the constant already in this file, declared further down: `agingSearch` is a function, so it
reads the constant only when a route is opened, after the whole file has run.

### `apps/app/src/routes/app-shell.tsx`

```diff
@@ -68,6 +68,10 @@ import {
   Wifi01Icon,
   WifiDisconnected02Icon,
   WorkHistoryIcon,
+  ChartLineData01Icon,
+  ShoppingBag01Icon,
+  Time04Icon,
+  TimeQuarterPassIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { THEMES } from '@omnivo/contracts';
@@ -345,6 +349,9 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
   const me = useSession((state) => state.me);
   // লুকানো শুধু সুবিধা — আসল পাহারা API-র PermissionGuard। যেটা খুললেই 403, সেটা মেনুতে না দেখানো
   const can = useCan();
+  const canAccountingReports = can('accounting.report.read');
+  const canSalesReports = can('sales.report.read');
+  const canPurchaseReports = can('purchase.report.read');
   // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
   const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
   // Step 18b: sign out at once with nothing on the device, else ask. Step 20b (decision 6): an
@@ -419,18 +426,45 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
               </>
             )}
           </NavGroup>
-          {/* The statements: for anyone with the report permission, journal or not (a director) */}
-          {can('accounting.report.read') && (
+          {/* The statements: for anyone with the report permission, journal or not (a director).
+              Step 21b: each link by its own permission, and the group shows when any link does.
+              A person with only the sales reports sees "Sales report", "Receivables aging" and
+              Exports (the list shows the kinds they can read). */}
+          {(canAccountingReports || canSalesReports || canPurchaseReports) && (
             <NavGroup label={t('nav.reports')}>
-              <NavLink to="/reports/trial-balance" icon={TableIcon}>
-                {t('nav.trialBalance')}
-              </NavLink>
-              <NavLink to="/reports/profit-and-loss" icon={ChartIncreaseIcon}>
-                {t('nav.profitAndLoss')}
-              </NavLink>
-              <NavLink to="/reports/balance-sheet" icon={PieChartIcon}>
-                {t('nav.balanceSheet')}
-              </NavLink>
+              {canAccountingReports && (
+                <>
+                  <NavLink to="/reports/trial-balance" icon={TableIcon}>
+                    {t('nav.trialBalance')}
+                  </NavLink>
+                  <NavLink to="/reports/profit-and-loss" icon={ChartIncreaseIcon}>
+                    {t('nav.profitAndLoss')}
+                  </NavLink>
+                  <NavLink to="/reports/balance-sheet" icon={PieChartIcon}>
+                    {t('nav.balanceSheet')}
+                  </NavLink>
+                </>
+              )}
+              {canSalesReports && (
+                <>
+                  <NavLink to="/reports/sales" icon={ChartLineData01Icon}>
+                    {t('nav.salesReport')}
+                  </NavLink>
+                  <NavLink to="/reports/ar-aging" icon={TimeQuarterPassIcon}>
+                    {t('nav.arAging')}
+                  </NavLink>
+                </>
+              )}
+              {canPurchaseReports && (
+                <>
+                  <NavLink to="/reports/purchases" icon={ShoppingBag01Icon}>
+                    {t('nav.purchaseReport')}
+                  </NavLink>
+                  <NavLink to="/reports/ap-aging" icon={Time04Icon}>
+                    {t('nav.apAging')}
+                  </NavLink>
+                </>
+              )}
               <NavLink to="/reports/exports" icon={FileDownloadIcon}>
                 {t('nav.exports')}
               </NavLink>
```

The group used to depend on one permission. Now each link has its own, and the group shows when any of its links does.
Exports is inside the group with no check of its own, because the group's condition is already "any report permission".

### `apps/app/src/routes/report-exports.tsx`

```diff
@@ -62,7 +62,11 @@ function StatusPill({ status }: { status: ReportExport['status'] }) {
 export function ReportExportsPage() {
   const { t, format } = useLocale();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
-  const canRead = useCan()('accounting.report.read');
+  // Step 21b: any report permission opens the page; the API lists only the kinds this person can
+  // still read (REPORT_KIND_PERMISSIONS), so nobody sees another module's file here
+  const can = useCan();
+  const canRead =
+    can('accounting.report.read') || can('sales.report.read') || can('purchase.report.read');
   const showDate = useIsoDate();
   const { data, isError } = useQuery({ ...reportExportsQuery(tenantId), enabled: canRead });
   const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
```

The page used to ask for `accounting.report.read`. A person with only the sales reports could start an export and then
could not open the page to download it.

### `apps/app/scripts/check-bundle-size.ts`

```diff
@@ -28,8 +28,9 @@ const INITIAL_BUDGET = 230 * 1024;
 // it 120–124 KB, after the shift menu moved to a chunk of its own. Step 20c: 135 KB (you chose
 // this). The screen takes goods back and pays with a return's money (/pos is 121 KB), so the return
 // dialog with it is 133 KB and the pay dialog 129.5 KB, after the refund rows moved to a file of
-// their own.
-const CHUNK_BUDGET = 135 * 1024;
+// their own. Step 21b: 140 KB (you chose this). The return dialog went to 135.1 KB without changing:
+// the route table grew by the four reports' schemas, and every page loads the whole table.
+const CHUNK_BUDGET = 140 * 1024;
 // Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
 // 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
 // changed.
```

See decision 50. The initial chunk is 227.6 KB of 230 KB after this part; the largest new page is 124.0 KB.

### What I checked

- **Type checks:** `@omnivo/i18n` and `@omnivo/app`.
- **Tests:** app 210, all pass. These pages have no unit tests of their own: their logic is in the contract and the API
  (21b.1, 21b.4), and 21b.7 tests them in a browser.
- **ESLint and Prettier** on every file this part touched, and `pnpm boundaries`.
- **The app's production build and `test:bundle-size`.**
- **In a browser:** not yet. The mock does not answer these six routes until 21b.7.

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app typecheck && pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
pnpm exec eslint apps/app/src/routes/sales-report.tsx apps/app/src/routes/purchase-report.tsx \
  apps/app/src/routes/aging.tsx apps/app/src/routes/aging-party.tsx apps/app/src/routes/app-shell.tsx \
  apps/app/src/routes/report-exports.tsx apps/app/src/components/aging-parts.tsx \
  apps/app/src/components/trade-report-parts.tsx apps/app/src/lib/trade-report-queries.ts \
  apps/app/src/router.tsx apps/app/scripts/check-bundle-size.ts
pnpm boundaries
```

All pass.

---

## 21b.7 — The mock and the Playwright tests

The six new routes get an answer in mock mode, so `pnpm dev:mock` and the Playwright tests can show the pages. The mock
works the reports out from its own documents (decision 52). A year of trade gives those reports something to add up
(decision 51). Then the tests, on a computer and on a phone. Looking at the pages in a browser found one bug in 21b.6:
names were cut down to a few letters (decision 53).

### `apps/app/src/mocks/trade-report-data.ts` (new): the reports on the mock's arrays

```ts
import {
  addMoney,
  agingAmountsOf,
  type AgingAmounts,
  agingBucketOf,
  type AgingReport,
  type AgingRow,
  type AgingSort,
  type ApAgingAdvance,
  type ApAgingFilter,
  type ApAgingParty,
  type ArAgingAdvance,
  type ArAgingFilter,
  type ArAgingParty,
  compareMoney,
  costColumns,
  daysOverdue,
  isZeroMoney,
  negateMoney,
  type PartyRef,
  prorateMoney,
  type PurchaseReport,
  type PurchaseReportFilter,
  type PurchaseReportRow,
  type SalesReport,
  type SalesReportFilter,
  type SalesReportRow,
  subtractMoney,
  sumMoney,
  type TradeReportRowKind,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import { isClosing } from './report-data';
import { pageOf } from './sales-document-data';
import { findVariant } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// Step 21b: the sales and purchase reports and the two agings on the mock's arrays. The API's rules
// (trade-report-queries.ts, aging-queries.ts) written again, like the statements' (report-data.ts),
// so a sale posted in `pnpm dev:mock` or in a Playwright test shows in the report at once.
//
// One thing is simpler than the API: the mock's allocations have no applied_on. An allocation counts
// from the later of its two documents' dates (what the API's backfill gives an old one), so a
// re-apply today does not show as "today" here.

// ---------------------------------------------------------------------------------------------
// What the two reports share

// A column's value to sort by; null goes last either way, like the API's NULLS LAST
type SortValue = string | null;

interface RowIdentity {
  key: string;
  kind: TradeReportRowKind;
  id: string | null;
  code: string | null;
  name: string | null;
  month: string | null;
}

// A row's name to sort by: a month by its date, a thing by its name in any case. A row that is not
// an item has none, so it comes last whichever way (the API's SORT_NAME).
function sortName(row: RowIdentity): string | null {
  return row.kind === 'item' ? (row.month ?? row.name?.toLowerCase() ?? null) : null;
}

function compareText(a: string | null, b: string | null, direction: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return direction * a.localeCompare(b);
}

function compareNumber(a: SortValue, b: SortValue, direction: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return direction * compareMoney(a, b);
}

// 'net' sorts up and '-net' down; then the name and the key, so a page never repeats a row
function sorted<R extends RowIdentity>(
  rows: readonly R[],
  sort: string,
  valueOf: (row: R, column: string) => SortValue,
): R[] {
  const direction = sort.startsWith('-') ? -1 : 1;
  const column = sort.replace(/^-/, '');
  return rows.toSorted((a, b) => {
    if (column === 'name') {
      return compareText(sortName(a), sortName(b), direction) || compareText(a.key, b.key, 1);
    }
    return (
      compareNumber(valueOf(a, column), valueOf(b, column), direction) ||
      compareText(sortName(a), sortName(b), 1) ||
      compareText(a.key, b.key, 1)
    );
  });
}

// This category and every one under it (the API's inCategory)
function categoryAndBelow(data: WorkspaceData, categoryId: string): Set<string> {
  const found = new Set([categoryId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const category of data.catalog.categories) {
      if (category.parentId !== null && found.has(category.parentId) && !found.has(category.id)) {
        found.add(category.id);
        grew = true;
      }
    }
  }
  return found;
}

const monthRow = (date: string): RowIdentity => ({
  key: date.slice(0, 7),
  kind: 'item',
  id: null,
  code: null,
  name: null,
  month: date.slice(0, 7),
});

function kindRow(kind: TradeReportRowKind): RowIdentity {
  return { key: kind, kind, id: null, code: null, name: null, month: null };
}

function thingRow(id: string, code: string | null, name: string): RowIdentity {
  return { key: id, kind: 'item', id, code, name, month: null };
}

function unitOf(data: WorkspaceData, unitId: string) {
  const unit = data.catalog.units.find((candidate) => candidate.id === unitId);
  return unit ? { code: unit.code, decimals: unit.decimals } : null;
}

interface Totalled {
  gross: string[];
  returns: string[];
  quantity: string[];
  cost: string[];
}

// One row per key, in the order they were first met
function groupInto<L extends { gross: string; returns: string; quantity: string; cost: string }>(
  lines: readonly L[],
  identityOf: (line: L) => RowIdentity,
): { identity: RowIdentity; line: L; sums: Totalled }[] {
  const groups = new Map<string, { identity: RowIdentity; line: L; sums: Totalled }>();
  for (const line of lines) {
    const identity = identityOf(line);
    const group = groups.get(identity.key) ?? {
      identity,
      line,
      sums: { gross: [], returns: [], quantity: [], cost: [] },
    };
    group.sums.gross.push(line.gross);
    group.sums.returns.push(line.returns);
    group.sums.quantity.push(line.quantity);
    group.sums.cost.push(line.cost);
    groups.set(identity.key, group);
  }
  return [...groups.values()];
}
```

- **It is the API's rules written again,** like the statements in `report-data.ts`. The numbers come from the mock's
  documents on every read, so an invoice posted in a test shows in the report at once.
- **`sorted()` is the API's `ORDER BY`.** Nulls go last either way, a row that is not an item has no name and goes last,
  and the key breaks every tie. Without the tie-break two equal rows could swap between pages, and a person would see
  one twice.
- **`compareNumber()` compares money, not text.** Text order puts `"9000"` after `"18000"`. It is the same trap the API
  has with its text columns (decision 30 onward).
- **`groupInto()` keeps the first line of each group** because the product's base unit is read from it. Every line of a
  group has the same product, so any line would do.

```ts
// ---------------------------------------------------------------------------------------------
// Sales

interface SaleLine {
  date: string;
  customerId: string | null;
  branchId: string;
  variantId: string;
  gross: string;
  returns: string;
  quantity: string;
  cost: string;
}

// The four kinds of lines of the API's salesLines(), signed so that adding them up gives the period
function salesLines(data: WorkspaceData): SaleLine[] {
  const challanLines = new Map(
    data.salesDocuments.deliveries.flatMap((delivery) =>
      delivery.lines.map((line) => [line.id, line] as const),
    ),
  );
  const returnLines = new Map(
    data.returns.salesReturns.flatMap((item) => item.lines.map((line) => [line.id, line] as const)),
  );
  const branchOf = new Map(data.stock.warehouses.map((place) => [place.id, place.branchId]));
  const invoices = data.billing.invoices.filter((invoice) => invoice.status === 'posted');
  const invoiceOf = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const sales = new Map(data.pos.sales.map((sale) => [sale.id, sale]));

  const sold = invoices.flatMap((invoice) =>
    invoice.lines.map((line): SaleLine => {
      const challan =
        line.deliveryLineId === null ? undefined : challanLines.get(line.deliveryLineId);
      return {
        date: invoice.date,
        customerId: invoice.customer.id,
        branchId: invoice.branchId,
        variantId: line.variantId,
        gross: line.net,
        returns: '0',
        quantity: line.baseQuantity,
        // The challan line's cost, in the share this line billed
        cost: challan?.value
          ? prorateMoney(challan.value, line.baseQuantity, challan.baseQuantity)
          : '0',
      };
    }),
  );
  const atCounter = data.pos.sales.flatMap((sale) =>
    sale.lines.map((line): SaleLine => ({
      date: sale.date,
      customerId: sale.customer?.id ?? null,
      branchId: branchOf.get(sale.warehouseId) ?? '',
      variantId: line.variantId,
      gross: line.net,
      returns: '0',
      quantity: line.baseQuantity,
      cost: line.value,
    })),
  );
  const credited = data.returns.creditNotes
    .filter((note) => note.status === 'posted')
    .flatMap((note) =>
      note.lines.map((line): SaleLine => {
        const back = line.returnLineId === null ? undefined : returnLines.get(line.returnLineId);
        return {
          date: note.date,
          customerId: note.customer.id,
          branchId: invoiceOf.get(note.invoice.id)?.branchId ?? '',
          variantId: line.variantId,
          gross: '0',
          returns: line.net,
          // A price cut gives money back, not goods
          quantity: back ? negateMoney(line.baseQuantity) : '0',
          cost: back?.value
            ? negateMoney(prorateMoney(back.value, line.baseQuantity, back.baseQuantity))
            : '0',
        };
      }),
    );
  const returned = data.pos.returns.flatMap((item) => {
    const sale = sales.get(item.saleId);
    return item.lines.flatMap((line): SaleLine[] => {
      const soldLine = sale?.lines.find((candidate) => candidate.id === line.saleLineId);
      if (!sale || !soldLine) return [];
      return [
        {
          date: item.date,
          customerId: sale.customer?.id ?? null,
          branchId: branchOf.get(item.warehouseId) ?? '',
          variantId: soldLine.variantId,
          gross: '0',
          returns: line.net,
          quantity: negateMoney(line.baseQuantity),
          cost: negateMoney(line.value),
        },
      ];
    });
  });
  return [...sold, ...atCounter, ...credited, ...returned];
}

// The books' sales of the period: the 'sales' account less the Sales returns account (null with a
// customer group or a category, whose lines the books do not have)
function booksSales(data: WorkspaceData, filter: SalesReportFilter): string | null {
  if (filter.customerGroupId !== undefined || filter.categoryId !== undefined) return null;
  const sales = data.accounts.find((account) => account.purpose === 'sales')?.id;
  const accounts = new Set([sales, data.salesAccounts.returns]);
  return sumMoney(
    data.journal.entries
      .filter(
        (entry) =>
          entry.status === 'posted' &&
          entry.date >= filter.from &&
          entry.date <= filter.to &&
          !isClosing(data, entry),
      )
      .flatMap((entry) => entry.lines)
      .filter(
        (line) =>
          accounts.has(line.accountId) &&
          (filter.branchId === undefined || line.branchId === filter.branchId),
      )
      .map((line) => subtractMoney(line.credit, line.debit)),
  );
}

export function salesReportOf(
  data: WorkspaceData,
  query: SalesReportFilter & { limit: number; cursor?: string | undefined },
  withCost: boolean,
): SalesReport {
  const customers = new Map(data.sales.customers.map((customer) => [customer.id, customer]));
  const categories = new Map(data.catalog.categories.map((category) => [category.id, category]));
  const branches = new Map(data.branches.map((branch) => [branch.id, branch]));
  const wanted = query.categoryId === undefined ? null : categoryAndBelow(data, query.categoryId);
  const lines = salesLines(data).flatMap((line) => {
    const found = findVariant(data, line.variantId);
    if (!found) return [];
    const customer = line.customerId === null ? undefined : customers.get(line.customerId);
    const inPeriod = line.date >= query.from && line.date <= query.to;
    const inBranch = query.branchId === undefined || line.branchId === query.branchId;
    // A walk-in has no group, so the group filter leaves the walk-ins out
    const inGroup =
      query.customerGroupId === undefined || customer?.groupId === query.customerGroupId;
    const inCategory =
      wanted === null ||
      (found.product.categoryId !== null && wanted.has(found.product.categoryId));
    return inPeriod && inBranch && inGroup && inCategory
      ? [{ ...line, product: found.product, customer }]
      : [];
  });
  const groups = groupInto(lines, (line): RowIdentity => {
    if (query.groupBy === 'month') return monthRow(line.date);
    if (query.groupBy === 'product') {
      return thingRow(line.product.id, line.product.code, line.product.name);
    }
    if (query.groupBy === 'branch') {
      const branch = branches.get(line.branchId);
      return thingRow(line.branchId, branch?.code ?? null, branch?.name ?? '');
    }
    if (query.groupBy === 'category') {
      const category =
        line.product.categoryId === null ? undefined : categories.get(line.product.categoryId);
      return category ? thingRow(category.id, null, category.name) : kindRow('no_category');
    }
    return line.customer
      ? thingRow(line.customer.id, line.customer.code, line.customer.name)
      : kindRow('walk_in');
  });
  const rows = groups.map(({ identity, line, sums }): SalesReportRow => {
    const gross = sumMoney(sums.gross);
    const returns = sumMoney(sums.returns);
    const net = subtractMoney(gross, returns);
    return {
      ...identity,
      quantity: query.groupBy === 'product' ? sumMoney(sums.quantity) : null,
      baseUnit: query.groupBy === 'product' ? unitOf(data, line.product.baseUnitId) : null,
      gross,
      returns,
      net,
      ...costColumns(net, withCost ? sumMoney(sums.cost) : null),
    };
  });
  const gross = sumMoney(rows.map((row) => row.gross));
  const returns = sumMoney(rows.map((row) => row.returns));
  const net = subtractMoney(gross, returns);
  const cost = withCost ? sumMoney(groups.flatMap((group) => group.sums.cost)) : null;
  const values = (row: SalesReportRow, column: string): SortValue => {
    if (column === 'quantity') return row.quantity;
    if (column === 'gross') return row.gross;
    if (column === 'returns') return row.returns;
    if (column === 'cost') return row.cost;
    if (column === 'margin') return row.margin;
    if (column === 'marginPercent') return row.marginPercent;
    return row.net;
  };
  return {
    ...pageOf(sorted(rows, query.sort, values), query),
    totals: { gross, returns, net, ...costColumns(net, cost) },
    withCost,
    books: booksSales(data, query),
  };
}
```

- **`salesLines()` has the same four kinds of line as the API:** invoice lines, POS lines, credit note lines and POS
  return lines. A return is signed, so adding the lines up gives the period.
- **A credit note with no return line takes only money off.** A price cut gives money back and no goods come home, so
  its quantity and its cost are zero. The tests' credit note is this kind.
- **An invoice line's cost is its share of the challan line,** with `prorateMoney()`, so a return before billing makes
  the invoice carry less of the cost. It is the API's `d.value * l.base_quantity / d.base_quantity`.
- **`booksSales()` uses `isClosing()`,** the reports' own test, so a year-end entry never counts as a sale. It answers
  `null` with a customer group or a category, because journal lines carry neither.
- **`salesReportOf()` takes `withCost` from the handler.** With it false, `costColumns()` gets `null` and every cost,
  margin and percent is `null`, as the contract says.
- **The totals are of every row, not of the page.** They are worked out before `pageOf()` cuts the list, so they are the
  same on every page, like the API's window function.

```ts
// ---------------------------------------------------------------------------------------------
// Purchases

interface PurchaseLine {
  date: string;
  supplierId: string;
  branchId: string;
  variantId: string | null;
  accountId: string | null;
  gross: string;
  returns: string;
  quantity: string;
  cost: string;
}

// The API's purchaseLines(): bill lines, bill expenses, debit note lines and debit note expenses
function purchaseLines(data: WorkspaceData): PurchaseLine[] {
  const bills = data.purchase.bills.filter((bill) => bill.status === 'posted');
  const billLines = new Map(
    bills.flatMap((bill) => bill.lines.map((line) => [line.id, line] as const)),
  );
  const billExpenses = new Map(
    bills.flatMap((bill) => bill.expenses.map((expense) => [expense.id, expense] as const)),
  );
  const notes = data.purchase.debitNotes.filter((note) => note.status === 'posted');
  return [
    ...bills.flatMap((bill) => [
      ...bill.lines.map((line): PurchaseLine => ({
        date: bill.date,
        supplierId: bill.supplier.id,
        branchId: bill.branchId,
        variantId: line.variantId,
        accountId: line.accountId,
        gross: line.net,
        returns: '0',
        quantity: line.accountId === null ? line.baseQuantity : '0',
        cost: '0',
      })),
      ...bill.expenses.map((expense): PurchaseLine => ({
        date: bill.date,
        supplierId: bill.supplier.id,
        branchId: bill.branchId,
        variantId: null,
        accountId: expense.accountId,
        gross: expense.net,
        returns: '0',
        quantity: '0',
        cost: '0',
      })),
    ]),
    ...notes.flatMap((note) => [
      ...note.lines.map((line): PurchaseLine => {
        const billed = line.billLineId === null ? undefined : billLines.get(line.billLineId);
        const accountId = billed?.accountId ?? null;
        return {
          date: note.date,
          supplierId: note.supplier.id,
          branchId: note.branchId,
          variantId: line.variantId,
          accountId,
          gross: '0',
          returns: line.net,
          quantity:
            line.returnLineId === null || accountId !== null ? '0' : negateMoney(line.baseQuantity),
          cost: '0',
        };
      }),
      ...note.expenses.map((expense): PurchaseLine => ({
        date: note.date,
        supplierId: note.supplier.id,
        branchId: note.branchId,
        variantId: null,
        accountId: billExpenses.get(expense.billExpenseId)?.accountId ?? expense.accountId,
        gross: '0',
        returns: expense.net,
        quantity: '0',
        cost: '0',
      })),
    ]),
  ];
}

export function purchaseReportOf(
  data: WorkspaceData,
  query: PurchaseReportFilter & { limit: number; cursor?: string | undefined },
): PurchaseReport {
  const suppliers = new Map(data.suppliers.suppliers.map((supplier) => [supplier.id, supplier]));
  const accounts = new Map(data.accounts.map((account) => [account.id, account]));
  const wanted = query.categoryId === undefined ? null : categoryAndBelow(data, query.categoryId);
  const lines = purchaseLines(data).flatMap((line) => {
    // An account line's product is a service, which belongs in the "Expenses" row (decision 11)
    const found =
      line.variantId === null || line.accountId !== null
        ? undefined
        : findVariant(data, line.variantId);
    const supplier = suppliers.get(line.supplierId);
    const inPeriod = line.date >= query.from && line.date <= query.to;
    const inBranch = query.branchId === undefined || line.branchId === query.branchId;
    const inGroup =
      query.supplierGroupId === undefined || supplier?.groupId === query.supplierGroupId;
    // Product lines only: an account line or an expense has no category, so it drops out
    const inCategory =
      wanted === null ||
      (found?.product.categoryId != null && wanted.has(found.product.categoryId));
    return inPeriod && inBranch && inGroup && inCategory
      ? [{ ...line, product: found?.product, supplier }]
      : [];
  });
  const groups = groupInto(lines, (line): RowIdentity => {
    if (query.groupBy === 'month') return monthRow(line.date);
    if (query.groupBy === 'product') {
      return line.product
        ? thingRow(line.product.id, line.product.code, line.product.name)
        : kindRow('expenses');
    }
    if (query.groupBy === 'account') {
      const account = line.accountId === null ? undefined : accounts.get(line.accountId);
      return account ? thingRow(account.id, account.code, account.name) : kindRow('products');
    }
    return thingRow(line.supplierId, line.supplier?.code ?? null, line.supplier?.name ?? '');
  });
  const rows = groups.map(({ identity, line, sums }): PurchaseReportRow => {
    const gross = sumMoney(sums.gross);
    const returns = sumMoney(sums.returns);
    const byProduct = query.groupBy === 'product' && identity.kind === 'item';
    return {
      ...identity,
      quantity: byProduct ? sumMoney(sums.quantity) : null,
      baseUnit: byProduct && line.product ? unitOf(data, line.product.baseUnitId) : null,
      gross,
      returns,
      net: subtractMoney(gross, returns),
    };
  });
  const gross = sumMoney(rows.map((row) => row.gross));
  const returns = sumMoney(rows.map((row) => row.returns));
  const values = (row: PurchaseReportRow, column: string): SortValue => {
    if (column === 'quantity') return row.quantity;
    if (column === 'gross') return row.gross;
    if (column === 'returns') return row.returns;
    return row.net;
  };
  return {
    ...pageOf(sorted(rows, query.sort, values), query),
    totals: { gross, returns, net: subtractMoney(gross, returns) },
  };
}
```

- **`purchaseLines()` has the API's four kinds:** bill lines, bill expenses, debit note lines, debit note expenses.
- **A product is looked up only for a goods line.** An account line's product is a service, and it belongs in the
  "Expenses" row (decision 11), so `found` stays `undefined` when the line has an account.
- **`quantity` is `null` on the "Expenses" row.** Its sum of zeros is not a quantity, and the column shows a dash.

```ts
// ---------------------------------------------------------------------------------------------
// The agings

// An invoice or a bill: its total and what was applied to it, each with the day it counts from
interface OpenDocument {
  id: string;
  partyId: string;
  number: string;
  date: string;
  dueDate: string;
  total: string;
  supplierBillNumber: string;
  applied: { amount: string; on: string }[];
}

// A receipt, payment, credit note or debit note: the same with what it applied and paid back
interface AdvanceDocument<TKind> {
  id: string;
  kind: TKind;
  partyId: string;
  number: string;
  date: string;
  amount: string;
  applied: { amount: string; on: string }[];
  refunds: { amount: string; date: string; status: string; voidDate: string | null }[];
  // Still counted up to this day when voided later (the API's void_date > D); null when it is not
  voidDate: string | null;
}

interface AgingSide<TKind> {
  parties: (data: WorkspaceData) => (PartyRef & { groupId: string | null })[];
  documents: (data: WorkspaceData) => OpenDocument[];
  advances: (data: WorkspaceData) => AdvanceDocument<TKind>[];
  account: 'accounts_receivable' | 'accounts_payable';
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

const RECEIVABLES: AgingSide<ArAgingAdvance['kind']> = {
  account: 'accounts_receivable',
  parties: (data) =>
    data.sales.customers.map(({ id, code, name, groupId }) => ({
      id,
      code,
      name,
      groupId,
    })),
  documents: (data) => {
    const receipts = data.billing.receipts.filter((receipt) => receipt.status === 'posted');
    const notes = data.returns.creditNotes.filter((note) => note.status === 'posted');
    return data.billing.invoices
      .filter((invoice) => invoice.status === 'posted' && invoice.number !== null)
      .map((invoice) => ({
        id: invoice.id,
        partyId: invoice.customer.id,
        number: invoice.number ?? '',
        date: invoice.date,
        dueDate: invoice.dueDate,
        total: invoice.total,
        supplierBillNumber: '',
        applied: [...receipts, ...notes].flatMap((source) =>
          source.allocations
            .filter((allocation) => allocation.invoiceId === invoice.id)
            .map((allocation) => ({
              amount: allocation.amount,
              on: later(source.date, invoice.date),
            })),
        ),
      }));
  },
  advances: (data) => {
    const invoiceDate = new Map(data.billing.invoices.map((item) => [item.id, item.date]));
    const appliedOf = (source: {
      date: string;
      allocations: { invoiceId: string; amount: string }[];
    }) =>
      source.allocations.map((allocation) => ({
        amount: allocation.amount,
        on: later(source.date, invoiceDate.get(allocation.invoiceId) ?? source.date),
      }));
    const { refunds } = data.returns;
    return [
      ...data.billing.receipts.map((receipt): AdvanceDocument<ArAgingAdvance['kind']> => ({
        id: receipt.id,
        kind: 'receipt',
        partyId: receipt.customer.id,
        number: receipt.number,
        date: receipt.date,
        amount: receipt.amount,
        applied: appliedOf(receipt),
        refunds: refunds.filter((refund) => refund.source.id === receipt.id),
        voidDate: receipt.status === 'voided' ? receipt.voidDate : null,
      })),
      ...data.returns.creditNotes
        .filter((note) => note.status === 'posted')
        .map((note): AdvanceDocument<ArAgingAdvance['kind']> => ({
          id: note.id,
          kind: 'credit_note',
          partyId: note.customer.id,
          number: note.number ?? '',
          date: note.date,
          amount: note.total,
          applied: appliedOf(note),
          refunds: refunds.filter((refund) => refund.source.id === note.id),
          voidDate: null,
        })),
    ];
  },
};

const PAYABLES: AgingSide<ApAgingAdvance['kind']> = {
  account: 'accounts_payable',
  parties: (data) =>
    data.suppliers.suppliers.map(({ id, code, name, groupId }) => ({
      id,
      code,
      name,
      groupId,
    })),
  documents: (data) => {
    const payments = data.purchase.payments.filter((payment) => payment.status === 'posted');
    const notes = data.purchase.debitNotes.filter((note) => note.status === 'posted');
    return data.purchase.bills
      .filter((bill) => bill.status === 'posted' && bill.number !== null)
      .map((bill) => ({
        id: bill.id,
        partyId: bill.supplier.id,
        number: bill.number ?? '',
        date: bill.date,
        dueDate: bill.dueDate,
        total: bill.total,
        supplierBillNumber: bill.supplierBillNumber,
        applied: [...payments, ...notes].flatMap((source) =>
          source.allocations
            .filter((allocation) => allocation.billId === bill.id)
            .map((allocation) => ({
              amount: allocation.amount,
              on: later(source.date, bill.date),
            })),
        ),
      }));
  },
  advances: (data) => {
    const billDate = new Map(data.purchase.bills.map((item) => [item.id, item.date]));
    const appliedOf = (source: {
      date: string;
      allocations: { billId: string; amount: string }[];
    }) =>
      source.allocations.map((allocation) => ({
        amount: allocation.amount,
        on: later(source.date, billDate.get(allocation.billId) ?? source.date),
      }));
    const { refunds } = data.purchase;
    return [
      ...data.purchase.payments
        // A draft's or a pending payment's plan moves no money
        .filter((payment) => payment.status === 'posted' || payment.status === 'voided')
        .map((payment): AdvanceDocument<ApAgingAdvance['kind']> => ({
          id: payment.id,
          kind: 'payment',
          partyId: payment.supplier.id,
          number: payment.number ?? '',
          date: payment.date,
          amount: payment.amount,
          applied: appliedOf(payment),
          refunds: refunds.filter((refund) => refund.source.id === payment.id),
          voidDate: payment.status === 'voided' ? payment.voidDate : null,
        })),
      ...data.purchase.debitNotes
        .filter((note) => note.status === 'posted')
        .map((note): AdvanceDocument<ApAgingAdvance['kind']> => ({
          id: note.id,
          kind: 'debit_note',
          partyId: note.supplier.id,
          number: note.number ?? '',
          date: note.date,
          amount: note.total,
          applied: appliedOf(note),
          refunds: refunds.filter((refund) => refund.source.id === note.id),
          voidDate: null,
        })),
    ];
  },
};
```

- **One `AgingSide` for each report,** as in the API: the customers with their invoices, receipts and credit notes, or
  the suppliers with their bills, payments and debit notes. All the logic below reads a side, so the two reports cannot
  drift apart.
- **`later()` is the day an allocation counts from** (decision 52). The mock's allocations have no `applied_on`.
- **Only posted payments apply money.** A draft payment's plan moved nothing, so `documents` filters on `posted` and
  `advances` also takes a voided one (it counts until its void day).

```ts
function appliedBy(applied: readonly { amount: string; on: string }[], asOf: string): string {
  return sumMoney(applied.filter((item) => item.on <= asOf).map((item) => item.amount));
}

// The documents of one party with something still open on the day
function openDocuments<TKind>(data: WorkspaceData, side: AgingSide<TKind>, asOf: string) {
  return side
    .documents(data)
    .filter((document) => document.date <= asOf)
    .map((document) => ({
      ...document,
      open: subtractMoney(document.total, appliedBy(document.applied, asOf)),
    }))
    .filter((document) => !isZeroMoney(document.open));
}

// What was not applied by that day and not paid back by then (the API's voided rule: a receipt
// voided after the day still counts on it)
function openAdvances<TKind>(data: WorkspaceData, side: AgingSide<TKind>, asOf: string) {
  return side
    .advances(data)
    .filter(
      (advance) => advance.date <= asOf && (advance.voidDate === null || advance.voidDate > asOf),
    )
    .map((advance) => ({
      ...advance,
      left: subtractMoney(
        subtractMoney(advance.amount, appliedBy(advance.applied, asOf)),
        sumMoney(
          advance.refunds
            .filter(
              (refund) =>
                refund.date <= asOf &&
                (refund.status === 'posted' || (refund.voidDate ?? '') > asOf),
            )
            .map((refund) => refund.amount),
        ),
      ),
    }))
    .filter((advance) => compareMoney(advance.left, '0') > 0);
}

// The account's balance on the day, in the report's sense, with the same parties as the report
function ledgerOf<TKind>(
  data: WorkspaceData,
  side: AgingSide<TKind>,
  asOf: string,
  keepParty: (partyId: string | null) => boolean,
): string {
  const accountId = data.accounts.find((account) => account.purpose === side.account)?.id;
  return sumMoney(
    data.journal.entries
      .filter((entry) => entry.status === 'posted' && entry.date <= asOf)
      .flatMap((entry) => entry.lines)
      .filter((line) => line.accountId === accountId && keepParty(line.party?.id ?? null))
      .map((line) =>
        side.account === 'accounts_receivable'
          ? subtractMoney(line.debit, line.credit)
          : subtractMoney(line.credit, line.debit),
      ),
  );
}

function zeroAmounts(): AgingAmounts {
  return agingAmountsOf([], [], '2000-01-01');
}

function addAmounts(a: AgingAmounts, b: AgingAmounts): AgingAmounts {
  return {
    current: addMoney(a.current, b.current),
    days1To30: addMoney(a.days1To30, b.days1To30),
    days31To60: addMoney(a.days31To60, b.days31To60),
    days61To90: addMoney(a.days61To90, b.days61To90),
    over90: addMoney(a.over90, b.over90),
    due: addMoney(a.due, b.due),
    advances: addMoney(a.advances, b.advances),
    balance: addMoney(a.balance, b.balance),
  };
}

// The amount a sort names; a sort that matches none is the balance, the report's default
function amountOf(row: AgingAmounts, column: string): string {
  for (const [name, value] of Object.entries(row)) {
    if (name === column) return value;
  }
  return row.balance;
}

function agingReport<TKind>(
  data: WorkspaceData,
  side: AgingSide<TKind>,
  query: {
    asOf: string;
    show: 'all' | 'overdue';
    sort: AgingSort;
    groupId: string | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): AgingReport {
  const { asOf, groupId } = query;
  const parties = side
    .parties(data)
    .filter((party) => groupId === undefined || party.groupId === groupId);
  const documents = openDocuments(data, side, asOf);
  const advances = openAdvances(data, side, asOf);
  const rows = parties.flatMap((party): (RowIdentity & { row: AgingRow })[] => {
    const own = documents.filter((document) => document.partyId === party.id);
    const money = advances.filter((advance) => advance.partyId === party.id).map((a) => a.left);
    if (own.length === 0 && money.length === 0) return [];
    const amounts = agingAmountsOf(own, money, asOf);
    if (query.show === 'overdue' && isZeroMoney(subtractMoney(amounts.due, amounts.current))) {
      return [];
    }
    return [
      {
        ...thingRow(party.id, party.code, party.name),
        row: { ...amounts, party: { id: party.id, code: party.code, name: party.name } },
      },
    ];
  });
  const groupIds = new Set(parties.map((party) => party.id));
  const page = pageOf(
    sorted(rows, query.sort, ({ row }, column) => amountOf(row, column)),
    query,
  );
  return {
    items: page.items.map(({ row }) => row),
    nextCursor: page.nextCursor,
    asOf,
    totals: rows.map(({ row }) => row).reduce<AgingAmounts>(addAmounts, zeroAmounts()),
    ledger:
      query.show === 'overdue'
        ? null
        : ledgerOf(
            data,
            side,
            asOf,
            (partyId) => groupId === undefined || (partyId !== null && groupIds.has(partyId)),
          ),
  };
}

export function arAgingOf(
  data: WorkspaceData,
  query: ArAgingFilter & { limit: number; cursor?: string | undefined },
): AgingReport {
  return agingReport(data, RECEIVABLES, { ...query, groupId: query.customerGroupId });
}

export function apAgingOf(
  data: WorkspaceData,
  query: ApAgingFilter & { limit: number; cursor?: string | undefined },
): AgingReport {
  return agingReport(data, PAYABLES, { ...query, groupId: query.supplierGroupId });
}

// A party's page: its row, its documents the oldest due date first, its advances the oldest first
function partyPage<TKind>(
  data: WorkspaceData,
  side: AgingSide<TKind>,
  partyId: string,
  asOf: string,
) {
  const party = side.parties(data).find((candidate) => candidate.id === partyId);
  if (!party) throw new MockProblem(404, 'not_found');
  const documents = openDocuments(data, side, asOf)
    .filter((document) => document.partyId === partyId)
    .toSorted((a, b) => a.dueDate.localeCompare(b.dueDate));
  const advances = openAdvances(data, side, asOf)
    .filter((advance) => advance.partyId === partyId)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  return {
    asOf,
    party: { id: party.id, code: party.code, name: party.name },
    totals: agingAmountsOf(
      documents,
      advances.map((advance) => advance.left),
      asOf,
    ),
    ledger: ledgerOf(data, side, asOf, (id) => id === partyId),
    documents: documents.map((document) => ({
      id: document.id,
      number: document.number,
      date: document.date,
      dueDate: document.dueDate,
      total: document.total,
      open: document.open,
      daysOverdue: daysOverdue(document.dueDate, asOf),
      bucket: agingBucketOf(document.dueDate, asOf),
      supplierBillNumber: document.supplierBillNumber,
    })),
    advances: advances.map((advance) => ({
      id: advance.id,
      kind: advance.kind,
      number: advance.number,
      date: advance.date,
      amount: advance.left,
    })),
  };
}

export function arAgingPartyOf(
  data: WorkspaceData,
  customerId: string,
  asOf: string,
): ArAgingParty {
  return partyPage(data, RECEIVABLES, customerId, asOf);
}

export function apAgingPartyOf(
  data: WorkspaceData,
  supplierId: string,
  asOf: string,
): ApAgingParty {
  return partyPage(data, PAYABLES, supplierId, asOf);
}
```

- **`openDocuments()` is "the total less what was applied by that day".** The API starts from what is open now and adds
  back what came later, for speed over many invoices. The mock has few, so it uses the plain definition.
- **`openAdvances()` keeps a voided receipt until its void day,** and a refund voided after the day does not count. That
  is the API's rule, and the known gap of decision 5 comes with it: a voided receipt's allocations are gone.
- **`agingAmountsOf()` is the contract's own function,** so the buckets are the ones the party's page and the API's
  tests use.
- **`ledgerOf()` follows the group filter,** and the answer has no ledger with "Overdue only", because the books know
  nothing of due dates.
- **`amountOf()` reads the column by name with `Object.entries`,** which keeps the sort's string typed without a cast.
- **`sorted()` needs a `RowIdentity`, and the answer does not have one.** So each row carries `{ ...identity, row }` and
  only `row` is sent.

### `apps/app/src/mocks/trade-history-data.ts` (new): a year of trade

```ts
import { addMoney, fiscalYearOf, shiftIsoDate, todayIn } from '@omnivo/contracts';

import { saveBill, savePayment, submitBill, submitPayment } from './bill-data';
import { createReceipt, postInvoice, saveInvoice } from './invoice-data';
import { createSale } from './pos-data';
import { postDebitNote, saveDebitNote } from './purchase-return-data';
import { postCreditNote, saveCreditNote } from './return-data';
import type { WorkspaceData } from './workspace-data';

// Step 21b: a year of trade for the sales and purchase reports and the agings, in the garments
// workspace. Real documents, made by the mock's own functions, so a party's page links to an invoice
// that opens, and the books agree with the reports.
//
// Everything but the last two documents is dated by the LAST fiscal year's end, never by today: the
// e2e tests read that year ("Last fiscal year", and an aging as of its last day), so their numbers
// are the same on whatever day they run. As of that day (E):
//
//   Customers    H&M      invoice 30,000 less a 2,000 credit note less 18,000 of a 20,000 receipt
//                         = 10,000 open, 70 days late (61–90), 2,000 in advance
//                Primark  25,000 open, 10 days late (1–30)
//                Aarong    5,000 open, not due yet
//                Bengal    8,000 open, 170 days late (90+)
//   Suppliers    Meghna   bill 11,000 less a 500 debit note less 5,500 of a 6,000 payment
//                         = 5,000 open, 60 days late (31–60), 500 in advance
//                Gazipur Carton 6,000 open, not due yet
//
//   Sold 71,000, taken back 2,000, net 69,000, cost 52,800. Bought 17,000, taken back 500, net 16,500.
//
// The last two documents are dated today, so a person in `pnpm dev:mock` sees numbers on the pages'
// first view ("This month", as of today).
export function seedTradeHistory(data: WorkspaceData): void {
  const product = (code: string) => data.catalog.products.find((item) => item.code === code);
  const customer = (name: string) =>
    data.sales.customers.find((item) => item.name.startsWith(name));
  const supplier = (name: string) =>
    data.suppliers.suppliers.find((item) => item.name.startsWith(name));
  const account = (code: string) => data.accounts.find((item) => item.code === code);
  const branch = (code: string) => data.branches.find((item) => item.code === code);
  const [main] = data.stock.warehouses;
  const exempt = data.sales.taxRates.find((rate) => rate.name === 'Exempt');
  const hm = customer('H&M');
  const primark = customer('Primark');
  const aarong = customer('Aarong');
  const bengal = customer('Bengal');
  const meghna = supplier('Meghna');
  const carton = supplier('Gazipur Carton');
  const polo = product('ST-118');
  const tee = product('P-00001');
  const buttons = product('P-00003');
  const mailers = product('P-00004');
  const cash = account('1110');
  const transport = account('5170');
  const head = branch('HO');
  const factory = branch('GZP');
  const counter = data.pos.registers.find((item) => item.code === 'POS2');
  if (
    !main ||
    !exempt ||
    !hm ||
    !primark ||
    !aarong ||
    !bengal ||
    !meghna ||
    !carton ||
    !polo ||
    !tee ||
    !buttons ||
    !mailers ||
    !cash ||
    !transport ||
    !head ||
    !factory ||
    !counter?.deviceId
  ) {
    return;
  }

  const today = todayIn(data.settings.timezone);
  const startMonth = data.settings.fiscalYearStartMonth;
  // The day before this year's first day is in the year before it, on any day of the year
  const lastYearEnd = shiftIsoDate(fiscalYearOf(today, startMonth).start, -1);
  const before = (days: number) => shiftIsoDate(lastYearEnd, -days);

  const priceless = {
    description: null,
    discountType: 'percent',
    discount: '0',
  } as const;

  const invoice = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    date: string,
    dueDate: string,
    branchId: string,
  ) => {
    const draft = saveInvoice(data, {
      customerId: who.id,
      date,
      note: null,
      dueDate,
      customerReference: null,
      branchId,
      warehouseId: main.id,
      lines: [
        {
          ...priceless,
          variantId: goods.variants[0]?.id ?? '',
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId: exempt.id,
          deliveryLineId: null,
          orderLineId: null,
          batchId: null,
          serialNumbers: [],
        },
      ],
    });
    // Over a limit or not, an old sale is already made
    postInvoice(data, draft, true);
    return draft;
  };

  const bill = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    date: string,
    dueDate: string,
    expenses: { accountId: string; description: string; amount: string; taxRateId: string }[],
    supplierBillNumber: string,
  ) => {
    const saved = saveBill(data, {
      supplierId: who.id,
      date,
      dueDate,
      supplierBillNumber,
      mushakNumber: null,
      mushakDate: null,
      branchId: head.id,
      warehouseId: main.id,
      pricesIncludeVat: false,
      note: null,
      lines: [
        {
          ...priceless,
          variantId: goods.variants[0]?.id ?? '',
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId: exempt.id,
          receiptLineId: null,
          orderLineId: null,
          accountId: null,
          lotNumber: null,
          expiresOn: null,
          manufacturedOn: null,
          serialNumbers: [],
        },
      ],
      expenses,
    });
    submitBill(data, saved);
    return saved;
  };

  // ---- Sales ----
  const hmInvoice = invoice(hm, polo, '60', '500', before(100), before(70), factory.id);
  invoice(primark, tee, '100', '250', before(40), before(10), head.id);
  invoice(aarong, buttons, '1000', '5', before(20), shiftIsoDate(lastYearEnd, 10), head.id);
  invoice(bengal, tee, '40', '200', before(200), before(170), head.id);

  // A price cut: money back, no goods, so the quantity and the cost stay
  const [hmLine] = hmInvoice.lines;
  if (hmLine) {
    postCreditNote(
      data,
      saveCreditNote(data, {
        invoiceId: hmInvoice.id,
        date: before(60),
        reason: 'price_adjustment',
        note: null,
        lines: [
          {
            ...priceless,
            invoiceLineId: hmLine.id,
            returnLineId: null,
            unitId: hmLine.unitId,
            quantity: '4',
            unitPrice: '500',
          },
        ],
      }),
    );
  }

  createReceipt(data, {
    customerId: hm.id,
    date: before(30),
    amount: '20000',
    accountId: cash.id,
    method: 'cash',
    reference: null,
    branchId: factory.id,
    note: null,
    allocations: [{ invoiceId: hmInvoice.id, amount: '18000' }],
  });

  // A walk-in at the counter
  createSale(data, counter.deviceId, crypto.randomUUID(), {
    registerId: counter.id,
    sequence: 215,
    shiftId: null,
    date: before(5),
    soldAt: `${before(5)}T05:00:00.000Z`,
    customerId: null,
    pricesIncludeVat: false,
    billDiscountType: 'percent',
    billDiscount: '0',
    payments: [{ method: 'cash', amount: '3000', reference: null, returnId: null }],
    lines: [
      {
        ...priceless,
        id: null,
        variantId: tee.variants[0]?.id ?? '',
        unitId: tee.baseUnitId,
        quantity: '10',
        unitPrice: '300',
        taxRateId: exempt.id,
        rate: '0.00',
        startingPrice: null,
        batchId: null,
        serialNumbers: [],
      },
    ],
  });

  // ---- Purchases ----
  const meghnaBill = bill(
    meghna,
    buttons,
    '2000',
    '5',
    before(90),
    before(60),
    [
      {
        accountId: transport.id,
        description: 'Truck rent, Narsingdi to the Main store',
        amount: '1000',
        taxRateId: exempt.id,
      },
    ],
    'MSM-2026-1104',
  );
  bill(
    carton,
    mailers,
    '1000',
    '6',
    before(20),
    shiftIsoDate(lastYearEnd, 10),
    [],
    'GCI-2026-0277',
  );

  const [meghnaLine] = meghnaBill.lines;
  if (meghnaLine) {
    postDebitNote(
      data,
      saveDebitNote(data, {
        supplierId: meghna.id,
        billId: meghnaBill.id,
        date: before(40),
        branchId: null,
        pricesIncludeVat: false,
        reason: 'price_adjustment',
        supplierCreditNumber: null,
        supplierCreditDate: null,
        note: null,
        expenses: [],
        lines: [
          {
            ...priceless,
            billLineId: meghnaLine.id,
            returnLineId: null,
            taxRateId: null,
            unitId: meghnaLine.unitId,
            quantity: '100',
            unitPrice: '5',
          },
        ],
      }),
    );
  }

  submitPayment(
    data,
    savePayment(data, {
      supplierId: meghna.id,
      date: before(30),
      amount: addMoney('5500', '500'),
      accountId: cash.id,
      method: 'cash',
      reference: null,
      supplierBankAccountId: null,
      branchId: head.id,
      orderId: null,
      note: null,
      allocations: [{ billId: meghnaBill.id, amount: '5500' }],
    }),
  );

  // ---- Today, for the pages' first view ----
  invoice(primark, tee, '10', '320', today, shiftIsoDate(today, 30), head.id);
  bill(carton, mailers, '500', '6', today, shiftIsoDate(today, 30), [], 'GCI-2026-0301');
}
```

- **Real documents, made by the mock's own functions** (`saveInvoice`, `postInvoice`, `createReceipt` and so on). A
  party's page links to an invoice, and with hand-written rows that link would open "not found". The postings also write
  the journal, so the "In the books" line has real numbers to compare with.
- **Dated by the last fiscal year's end, never by today** (decision 51). Each date is `before(n)` days from that end. The
  tests read that year and age as of its last day, so a test gives the same numbers on any day it runs. A date counted
  back from today would move an invoice between buckets every day.
- **`shiftIsoDate(start, -1)`:** the day before this fiscal year starts is always in the last one, on any day of the
  year.
- **All at the Exempt rate.** VAT is not in the sales report, but it is in an invoice's total, and so in the aging. At 0%
  the two reports show the same round numbers, which the comment at the top lists.
- **`postInvoice(data, draft, true)`** passes the credit limit override. An old sale has already happened.
- **The guard at the top returns quietly** when a fixture is missing. Only the garments workspace reaches this function,
  and the mock must not break `pnpm dev:mock` over a renamed customer. The tests would fail at once if it ever returned.
- **The last two documents are dated today,** so the pages' first view in `pnpm dev:mock` ("This month", as of today) is
  not empty. The tests read the last year, so these two change none of their numbers.

### `apps/app/src/mocks/fixtures.ts` and `workspace-data.ts`: the seed is switched off for other tests

```diff
@@ -64,6 +64,20 @@ export function mockRole(): MockRole | null {
   }
 }
 
+// Step 21b: the garments workspace comes with a year of invoices and bills for the reports
+// (trade-history-data.ts). They would change the numbers the other e2e tests read, so a test leaves
+// this key (e2e/helpers.ts) and gets the workspace without them, unless it asks for them with
+// test.use({ tradeHistory: true }). `pnpm dev:mock` has no key, so a person sees full reports.
+export const MOCK_NO_HISTORY_KEY = 'omnivo.mock.noTradeHistory';
+
+export function seedsTradeHistory(): boolean {
+  try {
+    return localStorage.getItem(MOCK_NO_HISTORY_KEY) === null;
+  } catch {
+    return true;
+  }
+}
+
 export function meIn(
   workspace: Workspace,
   companyName: string,
```

```diff
@@ -36,7 +36,7 @@ import {
   type MockDocumentOutput,
   seedDocumentOutput,
 } from './document-output-data';
-import { HEAD_OFFICES, OWNER, type Workspace } from './fixtures';
+import { HEAD_OFFICES, OWNER, seedsTradeHistory, type Workspace } from './fixtures';
 import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
@@ -57,6 +57,7 @@ import {
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
 import { emptySync, type MockSync, seedDevices } from './sync-data';
+import { seedTradeHistory } from './trade-history-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
 // নিয়মগুলো আসল API-র মতো (version, অনন্য কোড, শেষ চালু ব্রাঞ্চ) — UI-র error-পথ mock দিয়েও দেখা যায়
@@ -220,6 +221,8 @@ function seed(workspace: Workspace): WorkspaceData {
   seedPos(data, garments);
   // Step 20b: after the counters and the accounts: a shift is open on one of them
   seedPosShifts(data, garments);
+  // Step 21b: last, because it uses the stock, the accounts and a counter
+  if (garments && seedsTradeHistory()) seedTradeHistory(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
```

- **The history is on by default and off in tests.** It adds receivables and stock movements that the other e2e files
  read as exact numbers (the Overview says "Nothing overdue"). `pnpm dev:mock` has no key, so a person sees full reports.
- **The `try` around `localStorage`:** a browser that blocks storage must not break the mock. It reads as "on".
- **It runs last in `seed()`,** because it needs the stock, the accounts and a POS counter.

### `apps/app/src/mocks/handlers.ts`

```diff
@@ -7,6 +7,7 @@ import {
   compareQuantity,
   dashboardCardsFor,
   type ErrorCode,
+  isCostSort,
   type Preferences,
   type ProductCategory,
   routes,
@@ -147,6 +148,14 @@ import {
   toExport,
   trialBalanceOf,
 } from './report-data';
+import {
+  apAgingOf,
+  apAgingPartyOf,
+  arAgingOf,
+  arAgingPartyOf,
+  purchaseReportOf,
+  salesReportOf,
+} from './trade-report-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -1479,6 +1488,57 @@ export const handlers = [
     ),
   ),
 
+  // Step 21b: withCost from the person signed in, like the API's TradeReportsService: a sort that
+  // reads the cost is refused without inventory.stock.value, and every cost is null
+  mock(
+    routes.tradeReports.sales,
+    guarded(({ request }) => {
+      const query = readQuery(routes.tradeReports.sales.query, request);
+      const withCost = me().permissions.includes('inventory.stock.value');
+      if (!withCost && isCostSort(query.sort)) throw new MockProblem(403, 'permission_missing');
+      return reply(routes.tradeReports.sales, salesReportOf(current(), query, withCost));
+    }),
+  ),
+
+  mock(routes.tradeReports.purchases, ({ request }) =>
+    reply(
+      routes.tradeReports.purchases,
+      purchaseReportOf(current(), readQuery(routes.tradeReports.purchases.query, request)),
+    ),
+  ),
+
+  mock(routes.aging.receivables, ({ request }) =>
+    reply(
+      routes.aging.receivables,
+      arAgingOf(current(), readQuery(routes.aging.receivables.query, request)),
+    ),
+  ),
+
+  mock(
+    routes.aging.receivablesOf,
+    guarded(({ params, request }) => {
+      const { customerId } = routes.aging.receivablesOf.params.parse(params);
+      const { asOf } = readQuery(routes.aging.receivablesOf.query, request);
+      return reply(routes.aging.receivablesOf, arAgingPartyOf(current(), customerId, asOf));
+    }),
+  ),
+
+  mock(routes.aging.payables, ({ request }) =>
+    reply(
+      routes.aging.payables,
+      apAgingOf(current(), readQuery(routes.aging.payables.query, request)),
+    ),
+  ),
+
+  mock(
+    routes.aging.payablesOf,
+    guarded(({ params, request }) => {
+      const { supplierId } = routes.aging.payablesOf.params.parse(params);
+      const { asOf } = readQuery(routes.aging.payablesOf.query, request);
+      return reply(routes.aging.payablesOf, apAgingPartyOf(current(), supplierId, asOf));
+    }),
+  ),
+
   // Step 21a: the cards of the person signed in (me(): the owner, or the role a test left), the
   // others null, like the API's DashboardService
   mock(routes.dashboard.get, ({ request }) =>
```

- **`guarded()` on the routes that can refuse:** the cost sort (403) and an unknown party (404). Without it a
  `MockProblem` would be an unhandled error, not the answer the page expects.
- **`withCost` comes from `me()`,** the owner or the role a test left, as on the API.

### `apps/app/e2e/helpers.ts`

```diff
@@ -4,6 +4,7 @@ import { test as base, expect, type Locator, type Page, type Response } from '@p
 
 import {
   HEAD_OFFICES,
+  MOCK_NO_HISTORY_KEY,
   MOCK_ROLE_KEY,
   type MockRole,
   OWNER,
@@ -51,12 +52,23 @@ function copyOf(page: Page): Promise<void> {
 // they did. A test of the PIN itself turns this off with test.use({ answerPinDialog: false }).
 // The dialog closes a menu or a panel that was open: a test that opens one right after the first
 // load waits for the copy first (waitForCopy), so the dialog has shown and is answered before.
-export const test = base.extend<{ seedDevice: boolean; answerPinDialog: boolean }>({
+export const test = base.extend<{
+  seedDevice: boolean;
+  answerPinDialog: boolean;
+  tradeHistory: boolean;
+}>({
   seedDevice: [true, { option: true }],
   answerPinDialog: [true, { option: true }],
+  // Step 21b: the year of invoices and bills the reports read (fixtures.ts → MOCK_NO_HISTORY_KEY)
+  tradeHistory: [false, { option: true }],
   // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
-  page: async ({ page, seedDevice, answerPinDialog }, provide) => {
+  page: async ({ page, seedDevice, answerPinDialog, tradeHistory }, provide) => {
     copies.set(page, copyOf(page));
+    if (!tradeHistory) {
+      await page.addInitScript((key) => {
+        localStorage.setItem(key, '1');
+      }, MOCK_NO_HISTORY_KEY);
+    }
     if (answerPinDialog) {
       // A new seeded device always asks once; without the seed the branch dialog comes first
       if (seedDevice) pinWaiting.add(page);
```

- **`tradeHistory` is a fixture option,** like `seedDevice`: off for every test, and one line (`test.use`) turns it on.
- **`addInitScript` runs before the app.** The mock's data is built on the first request, so the key has to be there
  already.

### `apps/app/e2e/trade-reports.e2e.ts` (new)

```ts
import { fiscalYearOf, shiftIsoDate, todayIn } from '@omnivo/contracts';
import type { Locator, Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
} from './helpers.js';

// Step 21b on the mock's year of trade (mocks/trade-history-data.ts). Every number is of the last
// fiscal year, so the tests never depend on the day they run. In that year: sold ৳71,000, taken back
// ৳2,000, net ৳69,000, cost ৳52,800. Bought ৳17,000, taken back ৳500, net ৳16,500.
test.use({ tradeHistory: true });

const today = todayIn('Asia/Dhaka');
// The day before this fiscal year's first day: the last day of the last one
const yearEnd = shiftIsoDate(fiscalYearOf(today, 7).start, -1);

// A cell of the KPI strip, by its label. The table's headers have the same words, so only the
// strip's caption is looked for.
function kpi(page: Page, label: string): Locator {
  return page.locator('span.text-caption', { hasText: new RegExp(`^${label}$`) }).locator('..');
}

async function lastYear(page: Page): Promise<void> {
  await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
}

async function openReport(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await openFromNav(page, name);
}

// The filters are in the address, so an aging opens at the day the test wants
async function openAging(page: Page, path: string, asOf: string): Promise<void> {
  await page.goto(`/reports/${path}?asOf=${asOf}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
```

- **`yearEnd` is worked out as the seed does,** from the same contract function and the workspace's time zone.
- **`kpi()` looks for the strip's caption only.** The table's headers have the same words ("Sold"), and a plain text
  search would find both.
- **`openAging()` goes straight to the address.** The day is in the address (decision 45), and that is exactly what a
  person gets from a sent link.

```ts
test.describe('sales report', () => {
  test('adds up the year, with the cost, and compares with the books', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Sold')).toContainText('৳71,000');
    await expect(kpi(page, 'Returns')).toContainText('৳2,000');
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await expect(kpi(page, 'Margin')).toContainText('৳16,200');
    await expect(kpi(page, 'Margin')).toContainText('23.5% of net sales');

    // The mock's journal has a sale written by hand that year: no document, so the two differ. To
    // the paisa, because a difference under one taka would read ৳0 in whole taka.
    await expect(page.getByText('Out by ৳38,50,000.00')).toBeVisible();
    await expect(page.getByText('In the books: ৳39,19,000')).toBeVisible();

    // The largest net sale first; a walk-in has its own row
    const hm = readOnlyItem(page, /H&M Hennes/);
    await expect(hm).toContainText('৳30,000');
    await expect(hm).toContainText('৳2,000');
    await expect(hm).toContainText('৳28,000');
    await expect(readOnlyItem(page, /Walk-in customers/)).toContainText('৳3,000');
    await expectNoSideScroll(page);
  });

  test('groups by product, category, branch and month', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    const groupBy = page.getByLabel('Group by');

    await groupBy.selectOption({ label: 'Product' });
    // 100 + 40 + 10 at the counter; only the product group has a quantity
    await expect(readOnlyItem(page, /Basic crew-neck T-shirt/)).toContainText('150 pcs');

    await groupBy.selectOption({ label: 'Category' });
    await expect(readOnlyItem(page, /T-shirts/)).toContainText('৳36,000');
    await expect(readOnlyItem(page, /Buttons/)).toContainText('৳5,000');

    await groupBy.selectOption({ label: 'Branch' });
    await expect(readOnlyItem(page, /Gazipur factory/)).toContainText('৳28,000');

    await groupBy.selectOption({ label: 'Month' });
    // A month's row is named by its month, and the rows still add up to the year
    await expect(readOnlyItem(page, /\d{4}/).first()).toBeVisible();
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
  });

  test('a customer group has no figure in the books', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(page.getByText(/^Out by/)).toBeVisible();

    await page.getByLabel('Customer group').selectOption({ label: 'Local buyers' });
    await expect(kpi(page, 'Net sales')).toContainText('৳5,000');
    await expect(readOnlyItem(page, /Aarong/)).toBeVisible();
    // A group leaves the walk-ins out: they belong to none
    await expect(readOnlyItem(page, /Walk-in customers/)).toHaveCount(0);
    await expect(
      page.getByText('A customer group or a category has no figure in the books'),
    ).toBeVisible();
    await expect(page.getByText(/^Out by/)).toHaveCount(0);
  });

  test('a branch keeps only that branch’s sales', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await page
      .getByLabel('Branch', { exact: true })
      .selectOption({ label: 'GZP · Gazipur factory' });
    await expect(kpi(page, 'Net sales')).toContainText('৳28,000');
    await expect(readOnlyItem(page, /Primark/)).toHaveCount(0);
    // The sale written by hand has no branch, so in this branch the books and the report agree
    await expect(page.getByText('Books agree')).toBeVisible();
    await expect(page.getByText('In the books: ৳28,000')).toBeVisible();
  });

  test('a period with no sales says so', async ({ page }) => {
    await openReport(page, 'Sales report');
    await page.getByLabel('Period').selectOption({ label: 'Last fiscal year' });
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await page
      .getByLabel('Branch', { exact: true })
      .selectOption({ label: 'CTG · Chattogram depot' });
    await expect(page.getByRole('heading', { name: 'Nothing sold in these dates' })).toBeVisible();
  });

  test('sorts on the server, by a click on the header', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'A phone shows cards, with no headers');
    await openReport(page, 'Sales report');
    await lastYear(page);
    const rows = page.getByRole('row');
    // The header row, then the largest net sale
    await expect(rows.nth(1)).toContainText('H&M Hennes');
    await page.getByRole('button', { name: 'Net sales' }).click();
    await expect(page.getByRole('columnheader', { name: 'Net sales' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await expect(rows.nth(1)).toContainText('Walk-in customers');
  });

  test('without the stock value, cost and margin are not there at all', async ({ page }) => {
    await actAs(page, { name: 'Sales officer', permissions: ['sales.report.read'] });
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await expect(kpi(page, 'Margin')).toHaveCount(0);
    await expect(page.getByText(/Cost is what the sold goods cost/)).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Cost' })).toHaveCount(0);
  });

  test('offline, it says it needs a connection', async ({ page }) => {
    await openReport(page, 'Sales report');
    await expect(page.getByLabel('Period')).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole('heading', { name: 'Needs a connection' })).toBeVisible();
    await expect(page.getByLabel('Period')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);

    await page.context().setOffline(false);
    await expect(page.getByLabel('Period')).toBeVisible();
  });
});
```

- **"Out by ৳38,50,000.00" is the mock's own journal entry written by hand,** the case the books line exists for. To the
  paisa, because a difference under one taka would read `৳0` in whole taka.
- **The branch test shows "Books agree".** That entry has no branch, so inside one branch the report and the books are
  the same documents.
- **Cost is checked by what is absent:** no Margin cell, no Cost header, no note about cost. The role has
  `sales.report.read` only.
- **The sort test is skipped on a phone,** which shows cards and has no headers.

```ts
test.describe('purchase report', () => {
  test('adds up the bills, less the debit notes', async ({ page }) => {
    await openReport(page, 'Purchase report');
    await lastYear(page);
    await expect(kpi(page, 'Billed')).toContainText('৳17,000');
    await expect(kpi(page, 'Debit notes')).toContainText('৳500');
    await expect(kpi(page, 'Net purchases')).toContainText('৳16,500');
    const meghna = readOnlyItem(page, /Meghna Spinning/);
    await expect(meghna).toContainText('৳11,000');
    await expect(meghna).toContainText('৳10,500');
    await expectNoSideScroll(page);
  });

  test('an expense has a row of its own by product, and goods by account', async ({ page }) => {
    await openReport(page, 'Purchase report');
    await lastYear(page);
    await expect(kpi(page, 'Net purchases')).toContainText('৳16,500');
    const groupBy = page.getByLabel('Group by');

    await groupBy.selectOption({ label: 'Product' });
    await expect(readOnlyItem(page, /Expenses/)).toContainText('৳1,000');
    await expect(readOnlyItem(page, /Shirt buttons 4-hole/)).toContainText('2,000 pcs');

    await groupBy.selectOption({ label: 'Expense account' });
    await expect(readOnlyItem(page, /Products/)).toContainText('৳15,500');
    await expect(readOnlyItem(page, /5170/)).toContainText('৳1,000');
  });
});
```

- **The two summary rows are tested by name,** because they are why the rows add up to the total (decision 11).

```ts
test.describe('the agings', () => {
  test('receivables: each customer in its buckets, and the party’s documents', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(page.getByRole('heading', { level: 1, name: 'Receivables aging' })).toBeVisible();

    // 10,000 + 25,000 + 5,000 + 8,000 open, 2,000 of it paid in advance
    await expect(kpi(page, 'Total due')).toContainText('৳48,000');
    await expect(kpi(page, 'Overdue')).toContainText('৳43,000');
    await expect(kpi(page, 'Overdue')).toContainText('৳8,000 over 90 days');
    await expect(kpi(page, 'Advances')).toContainText('৳2,000');
    await expect(kpi(page, 'Balance')).toContainText('৳46,000');

    // Nine columns do not fit a laptop: the table scrolls in its box, and the name keeps its room
    // (found in the browser in 21b.7: the names were cut to "Benga…")
    const name = page.getByText('Bengal Buying House Ltd.');
    await expect(name).toBeVisible();
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const hm = listItem(page, /H&M Hennes/);
    await expect(hm).toContainText('৳10,000');
    await expect(hm).toContainText('৳2,000');
    await expect(hm).toContainText('৳8,000');
    await expectNoSideScroll(page);

    // The row opens the customer's page, at the same day
    await hm.click();
    await expect(page.getByRole('heading', { level: 1, name: /H&M Hennes/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`asOf=${yearEnd}`));
    await expect(kpi(page, 'Balance')).toContainText('৳8,000');
    await expect(page.getByText('1 open invoice')).toBeVisible();
    await expect(page.getByText('70 days', { exact: true })).toBeVisible();
    await expect(page.getByText('61–90 days').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /^MR-/ })).toBeVisible();
    await expectNoSideScroll(page);

    // Back on the report, the same day; a number opens its invoice
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`asOf=${yearEnd}`));
    await expect(kpi(page, 'Total due')).toContainText('৳48,000');
    // The name is a link of its own (open in a new tab): it keeps the day too, and only it navigates
    await page.getByRole('link', { name: /See what H&M Hennes/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /H&M Hennes/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`asOf=${yearEnd}`));
    await page.getByRole('link', { name: /^INV-/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^INV-/ })).toBeVisible();
  });

  test('receivables: a day in the past shows that day', async ({ page }) => {
    // Before H&M's receipt and credit note: all 30,000 is open, and no advance yet
    await openAging(page, 'ar-aging', shiftIsoDate(yearEnd, -65));
    const hm = listItem(page, /H&M Hennes/);
    await expect(hm).toContainText('৳30,000');
    await expect(kpi(page, 'Advances')).toContainText('৳0');
  });

  test('overdue only, and back to everyone when nothing is late', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(listItem(page, /Aarong/)).toBeVisible();
    await page.getByText('Overdue only').click();
    // Aarong's invoice is not due yet
    await expect(listItem(page, /Aarong/)).toHaveCount(0);
    await expect(listItem(page, /Primark/)).toBeVisible();
    await expect(
      page.getByText('The books know nothing of due dates, so “Overdue only” has no figure'),
    ).toBeVisible();
    await expect(page).toHaveURL(/show=overdue/);

    // 171 days before the year's end only Bengal's invoice exists, and it is not due yet
    await openAging(page, 'ar-aging', shiftIsoDate(yearEnd, -171));
    await page.getByText('Overdue only').click();
    await expect(page.getByRole('heading', { name: 'Nothing overdue on this day' })).toBeVisible();
    await page.getByRole('button', { name: 'Show everyone' }).click();
    await expect(listItem(page, /Bengal Buying/)).toBeVisible();
  });

  test('a customer group keeps its customers, and the books follow', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(listItem(page, /Aarong/)).toBeVisible();
    await page.getByLabel('Customer group').selectOption({ label: 'Local buyers' });
    await expect(kpi(page, 'Total due')).toContainText('৳5,000');
    await expect(listItem(page, /Primark/)).toHaveCount(0);
    await expect(page.getByText('In the books: ৳5,000')).toBeVisible();
  });

  test('payables: the suppliers, their bills and their own numbers', async ({ page }) => {
    await openAging(page, 'ap-aging', yearEnd);
    await expect(page.getByRole('heading', { level: 1, name: 'Payables aging' })).toBeVisible();
    await expect(kpi(page, 'Total due')).toContainText('৳11,000');
    await expect(kpi(page, 'Advances')).toContainText('৳500');
    await expect(kpi(page, 'Balance')).toContainText('৳10,500');

    await listItem(page, /Meghna Spinning/).click();
    await expect(page.getByRole('heading', { level: 1, name: /Meghna Spinning/ })).toBeVisible();
    await expect(page.getByText('Their bill MSM-2026-1104')).toBeVisible();
    await expect(page.getByText('60 days', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^PV-/ })).toBeVisible();
  });

  test('offline, an aging says it needs a connection', async ({ page }) => {
    await openAging(page, 'ar-aging', yearEnd);
    await expect(listItem(page, /Aarong/)).toBeVisible();
    await page.context().setOffline(true);
    await expect(page.getByRole('heading', { name: 'Needs a connection' })).toBeVisible();
  });
});
```

- **The name is measured** (`scrollWidth <= clientWidth`), not just found. A cut-off name is still in the page, so a
  plain "is visible" would pass with the bug of decision 53.
- **Both ways to a party's page are tested,** a click on the row and a click on the name link. They are two pieces of
  code, and each has to keep the day. A break on purpose showed the row click alone misses the link's.
- **The "Show everyone" test picks a day 171 days before the end,** when only one invoice exists and it is not due yet.
  That is the one way to reach the "nothing overdue" state with this data.

```ts
test.describe('who sees what', () => {
  test('a sales report reader sees the sales reports and Exports, nothing of purchases', async ({
    page,
  }) => {
    await actAs(page, { name: 'Sales officer', permissions: ['sales.report.read'] });
    await page.goto('/');
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Sales report' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Receivables aging' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Purchase report' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Payables aging' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Trial balance' })).toHaveCount(0);

    await openFromNav(page, 'Exports');
    await expect(page.getByRole('heading', { level: 1, name: 'Exports' })).toBeVisible();
  });

  test('exports the report and brings the file to the Exports page', async ({ page }) => {
    await openReport(page, 'Sales report');
    await lastYear(page);
    await expect(kpi(page, 'Net sales')).toContainText('৳69,000');
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: 'Excel' }).click();
    await expect(page.getByText(/Preparing the Excel file/)).toBeVisible();

    await page.waitForTimeout(1_600);
    await openFromNav(page, 'Exports');
    await expect(readOnlyItem(page, /Sales report/)).toContainText('Ready');
  });
});
```

- **A sales-only role sees the sales links and Exports, and no purchase link and no statement link** (decision 49).

### `apps/app/src/routes/aging.tsx`, `sales-report.tsx`, `purchase-report.tsx`: one class each

The class on the name's box in those three files is now `grid min-w-0 min-[860px]:min-w-48 …` (the listings in 21b.6
already show it). This is decision 53. Below 860px the row is a card, where `min-w-0` is still right: the card is
narrow and the name has to give way to the amount.

### What I checked

- **Type checks:** `@omnivo/app` and its `e2e` project.
- **Tests:** app 210, all pass.
- **Playwright:** `trade-reports.e2e.ts` 36 tests (18 × desktop and phone, the sort one skipped on a phone), three times
  in a row with `--repeat-each=3`: 105 passed, 3 skipped. With `dashboard` and `reports`: 59 passed, 1 skipped.
- **In a browser, against the mockup you approved, on a computer and a phone:** sales by customer and by product,
  purchases by account, receivables, one customer's page, payables with "Overdue only". They match it, except for the
  bug of decision 53.
- **Break on purpose** (`.guide/work/21b7/break.py`), each caught: the name's width floor removed, the cost columns
  always shown, the name link without the day, and the books line without its "no figure" branch.
- **ESLint** (with a 6 GB heap), **Prettier**, `pnpm boundaries`.
- **Not run here:** the whole e2e suite. That is 21b.8.

### Check this part

```bash
pnpm --filter "./packages/*" build
pnpm --filter @omnivo/app typecheck && pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts trade-reports --workers=2
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/app/src apps/app/e2e
pnpm exec prettier --check apps/app/src apps/app/e2e
pnpm boundaries
```

All pass.

---

## 21b.8 — The real API, and every check once

No new behaviour here. One small change to the tests of 21b.4 (below). No API route, table, permission or role template
changes.

### Two seeding tests get a longer time limit

Both files are new in this step, so the change is already in the code shown in 21b.4: the first test of each ends with
`}, 120_000);`, and a comment above it says why.

Each of these two suites has a first test that posts all the documents the others read. A test has 5 seconds by default.
Alone, these two fit. In the full run, with three workers on a busy computer, `aging.int.spec.ts`'s first test took
longer and was stopped at 5 seconds. Then the tests after it failed too, because the documents they read did not all
exist (`jukiPayment` was `undefined`). So one slow test looked like three failures. The limit is 120 seconds, the number
`report-exports.int.spec.ts` and the reports' tenant-leak suite already use for the same kind of test. The code under
test did not change. After this, all 689 integration tests passed.

### The six pages against the real API

The e2e tests read these pages from the mock API, and the integration tests ask the routes without a browser. So once,
the whole path ran in a real browser (Chromium, driven by a Playwright script that is not part of the guide) against the
real API, as in 21a.8: a production build of this guide's code with `VITE_API_URL` set to the API, served by
`vite preview` with its service worker, the API and the worker built from this guide's code, and a throwaway Postgres,
Valkey and MinIO on other ports. The database was built from empty by the migrations, 0059 and 0060 among them. The
script:

1. **Set-up through the API:** a retail workspace; "Mango juice 250 ml" (৳25 before VAT, 100 in stock at ৳15); a customer
   with no payment terms and four invoices of 4 juices (৳115 each with VAT), dated 100, 45, 10 and 0 days ago; a ৳115
   receipt 5 days ago for the oldest invoice; a ৳50 receipt 2 days ago that names no invoice; a supplier with two rent
   bills, ৳5,000 due in 25 days and ৳3,000 due 10 days ago. Then, in the browser, a POS sale of 4 juices (POS1-000001).
2. **The day in the database:** `receipt_allocations.applied_on` was the receipt's own date, 5 days ago.
3. **The sales report** ("This fiscal year"): sold ৳500, the same as the sales account in the journal's own lines, so
   "Books agree"; margin ৳200, "40.0% of net sales". By customer: Rahim General Store ৳400 and "Walk-in customers" ৳100.
   By product: 20 pcs. By month: August ৳100 and November ৳200.
4. **The purchase report:** ৳8,000 by supplier. By product: one "Expenses" row of ৳8,000.
5. **The receivables aging today:** due ৳345, overdue ৳230, advances ৳50, balance ৳295, "Books agree".
6. **Six days ago:** the receipt had not come yet. Due ৳345 (three invoices), "৳115 over 90 days" (the oldest was 94 days
   late then), no advance, "Books agree". The ledger is worked out a different way, from the journal, so this agreement is
   a real test of the as-of rule.
7. **The advance applied today** (`PUT /receipts/:id/allocations`): its `applied_on` became today. Today: due ৳295, no
   advance, balance ৳295. Yesterday still showed due ৳230, advance ৳50, balance ৳180, "Books agree". This is the case
   that `applied_on` exists for.
8. **The customer's page** from the row, at that same day: balance ৳180, two open invoices and the advance's receipt.
   Back: the same day.
9. **The payables aging:** due ৳8,000, overdue ৳3,000, "Books agree". The supplier's page has "Their bill MP/2026/0092"
   and "10 days".
10. **A real export:** "Export" → Excel on the sales report. The worker wrote `sales-2026-07-01-to-2026-11-09.xlsx`, the
    Exports page said "Ready", and "Download" fetched it through the storage: a real xlsx file.
11. **No connection:** "Needs a connection". Back online: the numbers again.

Every step passed at the first run. No page error, and no answer of 400 or more from the API.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is the
first time everything runs together.

`pnpm dedupe --check`, `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (898: contracts 382, app 210, api 141,
sync 118, ui 22, i18n 17, auth 8), `pnpm build`, `pnpm test:bundle-size` (first load 227.6 KB of 230; the largest new page,
the purchase report, 124.1 KB of 140; the POS return dialog 135.1 KB of 140; the worker's list 441 files, 1465.7 KB gz),
`pnpm test:openapi`, `pnpm boundaries`, `pnpm test:tenant-leak` (130), `pnpm test:e2e` (394 passed and 2 skipped: the two
sort tests on the phone, where a table is a list of cards with no headers to click) and `pnpm test:e2e:pwa` (4) all passed
at the first run.

`pnpm test:integration` did not, at first: 3 of 689 failed, all in `aging.int.spec.ts`, all from the one slow test
described above. With its longer limit, the whole suite ran again: 689 passed, 43 files. Only the integration suite ran
again; the change is two numbers in two test files, and those files also passed `typecheck`, ESLint and Prettier.

`pnpm dedupe --check` passes this time. It failed after 20c and 21a on a deprecation note of `@smithy/core`; your CI fix
of November took that away.

### On top of your current `dev`

Your `dev` is ahead of `1219788` by the storefront work (`415f3f1`: `apps/shop`, `packages/config` and a few lines in
`packages/contracts` and `packages/i18n`). So this guide's code was also merged on top of `415f3f1`, in a throwaway copy.
Git merged it with no conflict, and only three files needed merging at all: `packages/contracts/src/index.ts`, `en.ts`
and `bn.ts`. On the merged code, `pnpm typecheck` (every package, `apps/shop` too), the tests of `packages/contracts`
(382) and `packages/i18n` (17) and `pnpm test:openapi` passed. The storefront adds no migration, so 0059 and 0060 stay
next in line. If you hand-apply the diffs of those three files, your files have more lines than the ones shown here:
find the place by the text around it. The full e2e, integration and bundle runs above are on `1219788`, not on the merge.

---

## 21b.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components", after the **Overview** entry, add:

> - **Sales and purchase reports (`/reports/sales`, `/reports/purchases`):** the page header with the Export menu; a
>   card of filters (period preset and dates, Group by, branch, customer or supplier group, category); the KPI strip with
>   the server's totals, never a total row at the end of a paged table (Sold, Returns, Net sales, and Margin only with
>   `inventory.stock.value`; Billed, Debit notes, Net purchases); then a data table, sorted on the server and paged,
>   whose columns come from the answer (`withCost`). A row that stands for many things ("Walk-in customers", "No
>   category", "Expenses", "Products") has an icon on `subtle` in place of the initials, so it never reads as one more
>   party. On the sales report, between the strip and the table, the books' line ("In the books: ৳39,19,000" and a "Books
>   agree" or "Out by ৳x" pill, the difference to the paisa); with a customer group or a category, a neutral sentence
>   instead. Online only ("Needs a connection").
> - **Aging (`/reports/ar-aging`, `/reports/ap-aging`):** the page header with the Export menu; as-of date, customer or
>   supplier group, "Everyone / Overdue only" (the day and the filters are in the address, the sort is not); the KPI
>   strip (Total due, Overdue with "৳8,000 over 90 days" under it, Advances, Balance); a data table sorted A to Z at
>   first: name (a link that keeps the day), Current, 1–30, 31–60, 61–90, Over 90, Total due, Advances, Balance. A zero
>   is a dash. The balance reads in words ("৳50,000 in advance", "They owe you ৳50,000"). From 860px a name keeps 192px
>   (`min-[860px]:min-w-48`), and the table scrolls inside its own box. The books' line sits between the strip and the
>   table, with a neutral sentence under "Overdue only".
> - **A party's aging page (`/reports/ar-aging/:customerId`, `/reports/ap-aging/:supplierId`):** a back link that keeps
>   the day and the filters, the party's name as the title, the same KPI strip and books' line as its row, then its open
>   documents, oldest due date first and not sortable (number as a link, date, due date, total, still open, days overdue,
>   age; a bill has "Their bill PSM/2026/0412" under the number), and its advances.

And in "Content and formatting", after **A customer's balance**, add:

> - **Aging:** by the due date: Current (not due yet, or due that day), 1–30, 31–60, 61–90, Over 90 days. Money received
>   and not applied is an advance, in its own column, never spread over the buckets.

**docs/system-design.bn.md** — in ৩ (মডিউল), under **৭. Reports & Dashboard**, after the dashboard bullet, change
"স্ট্যান্ডার্ড রিপোর্ট (Sales, Stock, Aging, Tax, P&L) + ফিল্টার + Excel/PDF এক্সপোর্ট" to:

> - বিক্রি ও কেনাকাটার রিপোর্ট: যেকোনো সময়ের, কাস্টমার/সাপ্লায়ার, প্রোডাক্ট, ক্যাটাগরি, ব্রাঞ্চ বা অ্যাকাউন্ট আর মাস ধরে; ডকুমেন্টের
>   লাইন থেকে হিসাব (VAT ছাড়া, ফেরত বাদে), বিক্রির পাশে বইয়ের সংখ্যা, `inventory.stock.value` থাকলে মার্জিন (ধাপ ২১b)
> - AR/AP Aging: যেকোনো দিনের হিসাবে, due date থেকে Current, ১–৩০, ৩১–৬০, ৬১–৯০, ৯০+ দিন; অগ্রিম আলাদা কলামে, পাশে বইয়ের
>   ব্যালান্স। কোন টাকা কোন দিন থেকে গোনা হবে সেটা allocation-এর `applied_on` তারিখে থাকে, তাই আগের দিনের রিপোর্ট আগের
>   দিনের মতোই দেখায় (ধাপ ২১b)
> - স্ট্যান্ডার্ড রিপোর্ট (Stock, Tax, P&L) + ফিল্টার + Excel/PDF এক্সপোর্ট

**docs/build-plan.bn.md** — in পর্ব ৭ (ধাপ ২১), after the "ড্যাশবোর্ড (২১a)" bullet, add:

> - **বিক্রি, কেনাকাটা আর aging (২১b):** Reports-এ চারটা নতুন পেজ। বিক্রির রিপোর্ট কাস্টমার, প্রোডাক্ট, ক্যাটাগরি, ব্রাঞ্চ বা মাস ধরে
>   (ইনভয়েস আর POS বিক্রি, ক্রেডিট নোট আর POS রিটার্ন বাদে, VAT ছাড়া; পাশে বইয়ের সংখ্যা; `inventory.stock.value` থাকলে
>   খরচ আর মার্জিন); কেনাকাটার রিপোর্ট সাপ্লায়ার, প্রোডাক্ট, খরচের অ্যাকাউন্ট বা মাস ধরে। AR ও AP aging যেকোনো দিনের হিসাবে, due
>   date থেকে পাঁচ ভাগে, অগ্রিম আলাদা, পাশে বইয়ের ব্যালান্স; সারিতে ক্লিক করলে সেই পার্টির খোলা ডকুমেন্ট। চার allocation
>   টেবিলে নতুন `applied_on` তারিখ (migration 0059, 0060)। তালিকা সার্ভারে sort ও page হয়, যোগফল সার্ভার থেকে; Excel/PDF worker-এ।
>   permission: `sales.report.read`, `purchase.report.read`। অনলাইনে ছাড়া চলে না।

Leave section ৯'s "ধাপ ২১" unticked: step 21 is done after 21c.

---

## 21b.10 — Run it

```bash
pnpm db:migrate       # 0059 + 0060: applied_on on the four allocation tables, its backfill, the indexes and the triggers
pnpm dev
```

No new package, no new environment variable, and no change to the sync protocol. The backfill gives every allocation you
already have the later of its two documents' dates, so an aging of a past day works at once. The owner has the report
permissions already; in an existing workspace, give `sales.report.read` and `purchase.report.read` in Settings → Roles to
the other roles that need them.

### What you will see

1. **Reports in the sidebar:** Sales report, Purchase report, Receivables aging, Payables aging, each by its own
   permission, and Exports with any report permission.
2. **The sales report** (pick "This fiscal year"): what you sold, by customer. Change "Group by": product, category,
   branch, month. A POS sale with no customer is in the "Walk-in customers" row. "Books agree", unless someone wrote a
   journal entry by hand on the sales accounts: then "Out by ৳x".
3. **Cost and margin:** a role without `inventory.stock.value` has no such columns, in the page or in the file.
4. **The purchase report:** by supplier, then by expense account. By product, one "Expenses" row holds what has no
   product.
5. **The receivables aging:** each customer split by days past the due date. Click a row: their open invoices, each a
   link. Back: the same day.
6. **A day in the past:** change "As at" to before a receipt you know. That invoice is open again on that day, and the
   balance still equals the books. A customer ahead reads "৳20,000 in advance".
7. **Apply an advance today,** then look at yesterday: yesterday still has it as an advance.
8. **Overdue only:** the customers with something late. With nobody late, "Show everyone" brings them back.
9. **Export** on any of them: Excel or PDF. The file has every row, and it waits on the Exports page.
10. **Offline:** "Needs a connection". Only the Overview works offline.
11. **Bangla** and **390px:** each table is a list of cards; the page never scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint                    # 6 GB heap for ESLint (19b decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 898: contracts 382 + app 210 + api 141 + sync 118 + ui 22 + i18n 17 + auth 8
pnpm test:integration        # 689
pnpm test:tenant-leak        # 130
pnpm test:e2e                # 396: 198 flows × desktop and 390px (the 2 sort tests are skipped on the phone)
pnpm test:e2e:pwa            # 4: unchanged from 19b
pnpm build
pnpm test:bundle-size        # first load 227.6 KB gz (budget 230); the largest new page 124.1 (140); the worker's list 441 files, 1465.7 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **Sorting by quantity put "Expenses" first** (21b.4): a row with no quantity sorted as the largest. The sort keeps the
  rows that are not items last (decision 42).
- **The sort maps need the table's alias** (21b.3): the last `SELECT` has a text column called `net`, so `ORDER BY net`
  sorted ৳900 before ৳5,460. The maps say `g.net` and `r.net`.
- **Names were cut down to a few letters** (21b.7, found in the browser): `truncate` lets a table cell shrink to almost
  nothing, so nine columns left "Benga…". The name keeps 192px from 860px up (decision 53).
- **The POS return dialog went over 135 KB without changing** (21b.6): the contracts' route table is one chunk, and it
  grew by the reports' schemas. A lazy chunk's budget is now 140 KB (decision 50).
- **One slow seeding test looked like three failures** (21b.8): above.

---

## Notes left for later steps

**21c (the VAT report, the stock movement report, scheduled emails):**

- `REPORT_KINDS` and `REPORT_KIND_PERMISSIONS` (`packages/contracts/src/reports.ts`): a new kind names its permission
  there, and the export routes, the list and the download follow. The worker checks `inventory.stock.value` again when it
  runs (`rbac/holds-permission.ts`), the same check a scheduled email needs when it is sent.
- `report-paging.ts` (the OFFSET cursor) and the window-function totals are the pattern for a long report.
- The Reports group already shows by any of its links. Add the new links with their own permission.
- `trade-report-parts.tsx` and `aging-parts.tsx` are shared by the pages and not in the first chunk. `mocks/trade-history-data.ts`
  has a year of real documents with VAT lines, for the VAT report's tests.

**Later:**

- **A voided receipt's allocations are deleted,** so between its date and its void date an invoice shows open while the
  ledger shows it paid (decision 5, the books' line shows the difference). Keeping voided allocations would fix it.
- **A changed pair gets a new day for all of it** (decision 30): raising an allocation from ৳100 to ৳150 today dates all
  ৳150 today. Exact history would need a row per change.
- **The contracts' route table is one chunk** in every page (decision 50). Splitting it by module is its own step; the first
  chunk is 227.6 KB of 230 and the POS return dialog 135.1 KB of 140.
