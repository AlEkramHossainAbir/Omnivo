# Step 21a: Reports, part 1 — the dashboard

> The implementation guide for "Phase 7 → Step 21", the first of three parts, of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 21 (reports) is split into three guides: this one (the
> dashboard: the home page's numbers, kept on the device for offline), 21b (the sales and purchase reports and the
> receivables and payables aging) and 21c (the VAT report, the stock movement report and the scheduled report emails).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `9a543fd`, your commit named
> "add pos returns": 20c's code and its doc updates) and checked from 2026-11-02 to 2026-11-04: `pnpm dedupe --check`
> (see 21a.8: it fails for a reason outside this step), `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`
> (868 — 35 new), `pnpm test:integration` (653 — 15 new), `pnpm test:tenant-leak` (128 — 3 new), `pnpm build`,
> `pnpm test:bundle-size` (first load 225.7 KB gz, budget 230; the Overview's chunk 65.5 KB, budget 135; the worker's
> list 430 files, 1448.2 KB gz, budget 2 MB), `pnpm test:openapi`, `pnpm boundaries`, `pnpm test:e2e` (Playwright on
> the mocks, 360 — 14 new) and `pnpm test:e2e:pwa` (the worker on a production build, 4) — with the turbo cache
> bypassed (`--force`).
>
> Also checked:
>
> - **The day totals on Postgres** (21a.2): SQL checks as `omnivo_app` (nothing added before COMMIT, a draft and a
>   rolled-back posting add nothing, two lines on one account become one row, the year-end close and its reversal in
>   `closing` rows, the totals equal to the posted lines, the other workspace sees nothing, no `DELETE`, the backfill
>   run again gives the same rows), a race script (the second posting waits, then adds on top) and a deadlock script
>   (two postings that cross: without the advisory lock Postgres said "deadlock detected", with it both committed).
> - **The route through the API** (21a.3, 21a.4): a temporary end-to-end test before the tests were written, then the
>   tests. Broken on purpose, 11 times (closing rows counted, the Sales returns account left out, cash dated after
>   today, the POS sales left out of the top products, a POS sale's branch from the wrong column, drafts counted, the
>   low stock's order, an invoice due today counted as overdue, the margin without its permission): each time a test
>   failed.
> - **The screen** (21a.6, 21a.7): in a browser against the mockup you approved, on a computer and a phone, online and
>   offline; it found the cash card's cut-off amounts (decision 48). Broken on purpose, 6 times (the kept answer, the
>   branch filter, the role switch among them): each time a test failed.
> - **The Overview against the real API in a browser** (21a.8): invoices, a bill, a POS sale and a reorder level, the
>   numbers against the journal's own lines, then a reload with no connection: the PIN, and the sealed answer.

## Goal

📊 **Real numbers on the home page.** Since step 7 the home page is a card that says the workspace is ready. Everything
the owner wants to see first thing in the morning is somewhere in the app — the sales in the journal, the cash in the
ledger, the dues on the customer list, the low stock in the reorder report — but on five pages. This step puts them on
one.

After this step:

- **The home page shows the day's business:** sales today and this month, the gross margin, the cash in every account
  that holds money, what customers owe and what is owed to suppliers (and how much of it is overdue), and the items at
  or below their reorder level.
- **A chart of the last 30 days of sales** and **the five products that sold the most** in those days.
- **The sales are the books' sales,** so the dashboard and the profit and loss never disagree.
- **A branch select** shows one branch's sales; cash, dues and stock stay the whole workspace's.
- **Each card has its own permission.** A cashier sees no cash card; a storekeeper sees the low stock but not the
  sales. Three new permissions: `sales.report.read`, `purchase.report.read` and `inventory.report.read`.
- **Fast on a big workspace:** a new table, `account_day_totals`, keeps one row per day, branch and account, filled by
  the journal itself, so the dashboard adds up a few hundred rows instead of every journal line.
- **Offline, the last answer is still there,** sealed on the device like every other copy, with "As of 10:42".

## The whole picture

```
packages/contracts   dashboard.ts: the answer (sales, margin, cash, top products, receivables, payables, low stock),
      │               each part null without its permission · dashboardPeriods() · everyDay() · changePercent()
      │               money.ts: percentOfWhole() · permissions.ts: three report permissions · GET /dashboard
      ▼
packages/db          account_day_totals, kept by the journal's trigger, with row-level security and a backfill (21a.2)
      ▼
apps/api             DashboardService: one answer from the day totals, the documents and the stock (21a.3)
      ▼
packages/ui          LineChart, our own small SVG chart, in a lazy chunk (21a.6)
      ▼
apps/app             the dashboard page; the last answer sealed on the device for offline (21a.6)

Monday 2 Nov 2026, 10:42, the owner of a pharmacy distributor with depots in Sylhet and Chattogram opens Omnivo:
  Sales today ৳52,651 · +12.5% vs yesterday          Gross margin this month 22.5% (৳1,89,000 on ৳8,40,000)
  Sales this month ৳99,451 · vs ৳88,400 on 1–2 Oct     Cash ৳12,48,300 · Sonali Bank, bKash, Cash in hand
  the chart: 4 Oct … 2 Nov, one point a day           Top products: Napa 500 mg, Seclo 20 mg, Maxpro 20 mg …
  Customers owe ৳18,42,600 · ৳3,15,000 overdue (12)    Suppliers are owed ৳9,80,000 · ৳1,20,000 overdue (2)
  Low stock: 7 items · Napa 500 mg, Sylhet depot: 40 strips of 200
  she picks "Chattogram depot" ──► sales, margin and top products are that depot's; the rest stays
  at 14:00 the internet goes ──► the same page, "As of 10:42"
```

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Sales, purchase and aging reports | 21b |
| VAT report, stock movement report, scheduled emails | 21c |
| A dashboard the owner arranges (cards to add, hide or move) | The cards follow the permissions; a layout of one's own can come later |
| Sales by salesperson | No document has a salesperson yet |
| Live updates pushed by the server | The page asks again every minute while it is open (21a.6); a push channel is not worth it for this |
| Top products after their returns | The list is what sold; returns are in the sales numbers and come per product in 21b |

## What changes in the code you already have

- **The contract (21a.1):** a new `dashboard.ts` (the answer, its periods, the card permissions, the route),
  `percentOfWhole()` in `money.ts`, three permissions in `permissions.ts`, the route in `routes.ts`, and
  `openapi.json` generated again.
- **The database (21a.2):** a new table, `account_day_totals`, in `schema/journal.ts`, the descriptions of the three
  permissions in `permission-catalog.ts`, and two migrations: 0057 (generated) and 0058 (row-level security, the
  journal's new trigger and the backfill). The journal's existing tables and triggers do not change.
- **The API (21a.3):** a new folder, `apps/api/src/dashboard/` (the route, the service and its queries), and one line
  in `app.module.ts`. Three small changes elsewhere: `stock.service.ts` exports two of its SQL helpers, the account's
  "in use" error knows the day totals' foreign key, and the role templates of new workspaces get the report
  permissions.
- **The API tests (21a.4):** a new `dashboard-queries.spec.ts` (unit), `dashboard.int.spec.ts` and
  `dashboard.tenant-leak.int.spec.ts`; the role lists of `setup.int.spec.ts` get the report permissions.
- **The words (21a.5):** `en.ts` and `bn.ts` get the dashboard's cards, the branch select and the offline lines, and
  the words of the three permissions.
- **The screen (21a.6):** `@omnivo/ui` gets `LineChart` (new, with `lib/ticks.ts`), a change line and one to four
  cells in `KpiStrip`, and a `crit` tone in `EmptyState`; `@omnivo/i18n` gets `format.time()` and
  `format.dayMonth()`; `@omnivo/sync` gets `dashboard.ts` and a table of one row in the device's database (version
  7); the app gets `lib/dashboard.ts`, `dashboardQuery()` in `lib/queries.ts`, and a new `routes/dashboard.tsx` in
  place of the old card. The initial bundle's budget goes to 230 KB.
- **The mock and the tests (21a.7):** a new `mocks/dashboard-data.ts` (the Overview worked out from the mock's own
  books), `GET /dashboard` in `handlers.ts`, `isClosing()` exported from `report-data.ts`, a mock-only role switch in
  `fixtures.ts`, the Overview in `offline-screens.ts`, `actAs()` in `e2e/helpers.ts` and a new `e2e/dashboard.e2e.ts`.
  One fix to 21a.6's page: the cash and low stock cards get `grid-cols-1` (decision 48).
- **The finish (21a.8):** no code. The Overview runs once against the real API in a browser, and every check runs
  once.
- **Not touched:** `packages/auth`, the service worker (`apps/app/sw/`), the sign-in and the device set-up, the sync
  protocol and the synced tables, the POS screens, and the documents of steps 15 to 20. The reports of step 11 keep
  their own queries: only the dashboard reads `account_day_totals`.

## The decisions behind this step

You made the first twelve: 1–8 on 2026-11-02 for the whole of step 21, and 9–12 on 2026-11-02 while the contract was
written. The others came up while building it; please read them with care: they are mine.

1. **Three guides.** (You chose this.) 21a the dashboard; 21b the sales and purchase reports and the receivables and
   payables aging; 21c the VAT report, the stock movement report and the scheduled report emails.
2. **A day totals table, not a materialized view.** (You chose this.) `account_day_totals` (workspace, day, branch,
   account, debit, credit) is kept by a trigger on the journal in the same transaction, with row-level security like
   every workspace table, and filled once for the old entries by the migration. A Postgres materialized view cannot
   have row-level security, its refresh rebuilds every workspace at once, and its numbers are old between refreshes.
   The top products come from the sales lines, 30 days only, read directly.
3. **Report permissions per module.** (You chose this.) `sales.report.read`, `purchase.report.read`,
   `inventory.report.read`; the VAT report stays under `accounting.report.read`. Each dashboard card shows by its own
   permission.
4. **Aging by due date,** as of any date (21b).
5. **A VAT summary by rate** for a period (21c). Mushak 9.1 stays in Phase 2.
6. **Scheduled report emails** to workspace members only, the permission checked again when it is sent (21c).
7. **The dashboard works offline.** (You chose this.) The last answer is kept sealed on the device and shown with "As
   of 10:42". Every other report is online only.
8. **Our own charts.** (You chose this.) A small SVG `LineChart` in `@omnivo/ui`, in a lazy chunk; no chart library.

**The contract (21a.1):**

9. **The cards.** (You chose this.) A KPI strip (sales today against yesterday, sales this month against the same days
   of last month, the gross margin this month, the cash), the sales chart and the top five products of 30 days, the
   receivables and the payables (each the total and what is overdue), and the low stock (how many, and the first
   five).
10. **"Sales" is the books.** (You chose this.) The account with the `sales` purpose, less the Sales returns account
    of Settings → Sales, net and before VAT, read from `account_day_totals`. Invoices and POS sales both post there,
    and it is the profit and loss's number. All income accounts would count interest and the POS cash over as sales;
    adding up the documents could drift from the books.
11. **A branch select, for what was sold only.** (You chose this.) The whole workspace by default. A branch filters
    the sales, the margin and the top products, whose lines carry it. Cash, dues and low stock are always the whole
    workspace's: a bank account or a customer's balance belongs to no one branch.
12. **All three report permissions now.** (You chose this.) The permission catalog, the role templates and the words
    change once; `purchase.report.read` waits for 21b before anything checks it.
13. **One route, one answer.** `GET /dashboard` answers every card at once, and a card the person may not see is
    `null` in it. The device keeps that one answer for offline (decision 7), and what is not in it cannot leak from
    there. Seven routes would be seven requests on every visit and seven copies to keep.
14. **The route has no permission of its own.** Everyone signed in has a home page; a person with no card gets an
    answer of nulls, and the page says so (21a.6). `dashboardCardsFor()` is the one list of who sees what: the API
    fills the cards it names, the page draws them.
15. **A branch that does not exist is not an error.** Nothing was sold there, so its numbers are zero, as in the
    profit and loss.
16. **The margin needs both `sales.report.read` and `inventory.stock.value`.** It shows what was sold, and the cost
    of it. It carries its own sales, so it stands on its own.
17. **"The same days of last month" never run into this month.** On 31 March it is the whole of February, not
    "1–31 February". The days are worked out from the strings, never a `Date`, like the fiscal year.
18. **The top products are what sold, before returns,** from posted invoices and POS sales, in the base unit, after
    discounts and before VAT like the sales.
19. **The low stock items carry their warehouse's name and their unit,** the emptiest first (the smallest share of
    the reorder level on hand). Offline the page cannot look either up.
20. **A percent is a decimal string with one decimal** (`percentOfWhole()`), worked out in whole numbers like money,
    and `null` when there is nothing to compare with: "no sales yesterday" is no percent, not "+∞%".
21. **The cash's change line is against the end of yesterday:** what came in or went out today.
22. **The dues' total is the control account's balance,** what customers owe less their advances; the overdue part
    is from the documents (`isOverdue()` of steps 15c and 17c), with how many there are.

**The database (21a.2):**

23. **The totals are added when an entry is posted, at COMMIT.** Every entry becomes posted the same way: a draft
    turned into a posted entry by one update (0016 refuses new lines on a posted entry). The trigger watches only that
    update, so a draft's lines, which still change, are never counted. It runs at COMMIT, not at the update: the day's
    sales and cash rows are the same for every sale of the day, and a lock taken at the update would be held for the
    rest of a long posting while every other posting waited.
24. **One workspace adds its totals one posting at a time** (an advisory lock, held for the moment of the COMMIT).
    Without it, two transactions that post two entries each (a stock transfer, a POS sale with an exchange) can each
    hold a row the other needs next: a deadlock, and one of them fails. I checked it: with the lock taken out, the
    test below fails with "deadlock detected"; with it, the second waits and both commit.
25. **Year-end closing entries are kept, in rows of their own** (`closing`). The sales and the margin leave them out,
    like the reports' `withoutClosingEntries()`; the trial balance of 21b can add them in. Leaving them out of the
    table would make it useless for any balance.
26. **The backfill counts every workspace's posted entries,** a deleted workspace's too (it may be restored), and runs
    after the trigger is created, so no entry is counted twice or missed.
27. **Code never writes the table.** It has no `id`, no `version` and no audit columns; `omnivo_app` cannot delete from
    it. The trigger needs insert and update, so those stay.

**The API (21a.3):**

28. **A module of its own, `DashboardModule`,** with its questions in plain SQL in `dashboard-queries.ts`, like the
    reports' `report-queries.ts`. The dashboard reads the books, the documents and the stock, and belongs to none of
    those modules.
29. **A card without its permission is not read at all.** Its query never runs, so the answer has nothing to leave out
    and a slow card the person cannot see costs nothing.
30. **Cash and dues are up to today.** An entry dated after today (a post-dated cheque entered now) counts from its
    own day. The customer list counts every posted line, so the two differ only while such an entry waits for its
    day.
31. **Every money account is on the cash card,** an account with no entries too (at ৳0), the largest balance first:
    the owner sees each account they keep, and a bank account that is overdrawn shows last, below zero.
32. **The low stock follows the reorder report's rules** (an active warehouse, a product and a variant that are not
    archived, at or below the level), so the card's count and the report's list never disagree. A level of 0 has no
    share; it sorts with the empty items, or with the ones below zero.
33. **A POS sale's branch is its warehouse's,** the same rule as its journal entry (step 20a), so the top products of
    a branch agree with its sales.
34. **The report permissions in the role templates** (new workspaces only): the Accountant, the Shop manager and the
    Manager get all three; the Store keeper and the Depot managers `inventory.report.read`; the Merchandiser
    `purchase.report.read`; the Production manager both of those. Nobody who only sells gets `sales.report.read`: it
    is the whole company's sales, not theirs. In a workspace that exists already, the owner sees every card at once
    (an owner has every permission) and gives the new permissions to roles in Settings → Roles.

**The screen (21a.6):**

35. **The page follows the mockup you approved on 2026-11-04** ("Omnivo Dashboard",
    https://claude.ai/artifact/HjErjrCFo1F4CwMhCw5U5X): the KPI strip; the sales chart (two thirds) and the top
    products (one third); then the cash accounts, the dues (customers above suppliers, in one card) and the low
    stock. You also approved the seven choices I listed with it: the cash total in the strip and its accounts in a
    card, the margin's last month without an arrow, no branch select without a sales card, a card alone taking the
    whole row, "As of …" in the header's line offline, a `crit` tile for "Couldn't load", and the strip two by two
    on a phone.
36. **`KpiStrip` gets a change line and one to four cells,** and four cells are two by two on a phone. The rules
    between the cells are the card's line color showing through a 1px gap, which draws a 2 × 2 grid right; the old
    `divide-x` / `divide-y` could not. The stock card, the valuation page and a customer's page (with
    `sales.customer.balance`) use the same strip with four cells, so they are two by two on a phone too; a
    customer's page without it has two cells, which now share the row instead of leaving an empty third. The profit
    and loss, the balance sheet, a supplier's page and the POS shift's three cells look as before. The change line
    is 12px (`text-caption`), not the design's 12.5px: there is no 12.5px size in the type scale, and CLAUDE.md does
    not allow arbitrary sizes.
37. **The kept answer is one sealed row,** `dashboard`, in a new table of the device's database (Dexie version 7),
    with the name of its branch. It is not a synced table: the pull never writes or sweeps it, so `SYNC_PROTOCOL`
    stays the same and no full pull is needed. A row that does not open (changed on the disk) is "nothing kept".
    Revoking the device or signing out deletes it with the rest of the copy.
38. **Each card checks the permissions of now, not only the answer's nulls.** A kept answer may be from before a role
    change; offline, the person sees no card their role lost since.
39. **The branch select shows only with a card it changes and more than one active branch.** Offline it is disabled,
    and shows only for a kept answer of one branch, named as the select named it then (the branches cannot be asked
    for offline).
40. **The page asks again every minute** (TanStack's `refetchInterval`, which stops in a hidden tab), and its query
    key is under `['journal', tenant]`: posting an invoice, a bill or a payment invalidates the books, so the
    Overview is fetched again at once.
41. **Only a fresh answer is kept.** While a new branch loads, TanStack shows the last branch's numbers (placeholder
    data); those are never written over the kept answer.
42. **"As of 10:42" only for an answer made today** in the workspace's time zone; before today it is the date with
    the time. Two new formatters, `format.time()` and `format.dayMonth()` (the chart's axis: "29 Oct"), are in
    `@omnivo/i18n` with the others.
43. **The chart is drawn at the pixel width of its box** (measured with `ResizeObserver`), not scaled from a viewBox,
    so its 11px labels stay 11px on a phone. Amounts become numbers only to place the points; every amount a person
    reads comes from the string. The gridlines are round steps (1, 2 or 5 times a power of ten) and go below zero for
    a day with more returns than sales; the area fills to the zero line. The axis shows whole taka ("৳2,00,000"), not
    "৳2L": the short form needs words in two languages for a small gain. The chart takes the focus: the arrow keys
    walk the days, and a live region says each one.
44. **"Couldn't load" is an empty state with a `crit` tile** (`EmptyState` gets a `tone`), titled with a new key,
    `dashboard.loadFailedTitle`, and Retry. The old card's words (`readyTitle`, `readyBody`, `invite`) go with the
    old card.
45. **The initial bundle's budget is 230 KB** (you chose this). The Overview's English words (21a.5) and its contract
    (21a.1) took the first download to 225.7 KB; the chart and the page are in the Overview's own lazy chunk
    (65.5 KB).

**The mock and the tests (21a.7):**

46. **The mock works the Overview out from its own books,** not from fixed numbers. It adds up the posted journal
    lines, the invoices, bills, POS sales and reorder levels the mock already has, with the API's rules written again
    (as the reports' mock does). So a sale posted in `pnpm dev:mock` shows on the Overview at once, and the branch
    select really changes the sales. The mock garments workspace has only one sale in the last 30 days, so the chart
    there is one peak and the top products are empty; the integration tests (21a.4) cover full numbers.
47. **A mock-only role switch for the tests.** The mock always signed in the owner, who sees every card. A test now
    leaves a role and its permissions in `localStorage` (`omnivo.mock.role`) before the app starts (`actAs` in
    `e2e/helpers.ts`), and the mock's `/me` answers with them. Nothing in the app reads the key, and without it the
    mock behaves as before. 21b and 21c can use it for their report permissions.
48. **The cash and low stock cards get `grid-cols-1`** (a fix to 21a.6, found in the browser): without it, a long
    account name pushed the amounts out of the cash card.
49. **The Overview is in the mock's offline preload list** (`offline-screens.ts`): in mock mode there is no service
    worker to keep its chunk, and the page works offline.

## 21a.1 — `packages/contracts`: the contract

The contract first. A new file, `dashboard.ts`, holds the whole answer: which card needs which permission, which days
the numbers cover, and the shape of each card. `money.ts` gets one helper for a percent. The rest are short lists.

### `dashboard.ts` (new): the answer, its days and its permissions

```ts
import { z } from 'zod';

import { defineRoute } from './http.js';
import { shiftIsoDate } from './journal.js';
import { isZeroMoney, percentOfWhole, subtractMoney } from './money.js';
import type { PermissionKey } from './permissions.js';
import { reorderItemSchema, variantRefSchema } from './stock.js';
import { unitSchema } from './units.js';

// The dashboard (step 21a): the home page's numbers, in one answer.
//
// - Sales are the books' sales: the account with the 'sales' purpose, less the Sales returns
//   account of Settings → Sales when one is chosen, net and before VAT. Invoices and POS sales both
//   post there, so the dashboard and the profit and loss always say the same. The API reads them
//   from account_day_totals (step 21a.2), one row per day, branch and account.
// - Each part has its own permission (DASHBOARD_CARD_PERMISSIONS). A part the person may not see is
//   null in the answer, never left for the screen to hide: the answer is kept on the device for
//   offline (decision 7), and what is not in it cannot leak from there.
// - A branch filters what was sold (sales, margin, top products). Cash, dues and low stock are the
//   whole workspace's: a bank account or a customer's balance belongs to no one branch.

// The sales chart's days, today included
export const DASHBOARD_TREND_DAYS = 30;
// The top products are of the same days
export const DASHBOARD_TOP_PRODUCTS = 5;
export const DASHBOARD_LOW_STOCK_ITEMS = 5;

export const DASHBOARD_CARDS = [
  'sales',
  'margin',
  'cash',
  'topProducts',
  'receivables',
  'payables',
  'lowStock',
] as const;
export type DashboardCard = (typeof DASHBOARD_CARDS)[number];

// Every permission listed is needed. The margin shows what was sold, so it needs the sales
// report's permission too, not only the stock value's.
export const DASHBOARD_CARD_PERMISSIONS = {
  sales: ['sales.report.read'],
  margin: ['sales.report.read', 'inventory.stock.value'],
  cash: ['accounting.report.read'],
  topProducts: ['sales.report.read'],
  receivables: ['sales.customer.balance'],
  payables: ['purchase.supplier.balance'],
  lowStock: ['inventory.report.read'],
} as const satisfies Record<DashboardCard, readonly PermissionKey[]>;

// The cards a person may see, in the screen's order. It takes plain strings: me.permissions is
// z.string()[] on the wire (a newer server's key must not break an older client).
export function dashboardCardsFor(permissions: readonly string[]): DashboardCard[] {
  const held = new Set(permissions);
  return DASHBOARD_CARDS.filter((card) =>
    DASHBOARD_CARD_PERMISSIONS[card].every((key) => held.has(key)),
  );
}

// ---------------------------------------------------------------------------------------------
// The days the numbers cover, all from the workspace's today (todayIn() in numbering.ts)

export interface DashboardPeriods {
  today: string;
  yesterday: string;
  // The 1st of this month: this month so far is monthStart … today
  monthStart: string;
  // The same days of last month, to compare with: 1–2 Oct on 2 Nov. On 31 Mar it is the whole of
  // February, never "1–31 Feb", which would run into March.
  lastMonthStart: string;
  lastMonthEnd: string;
  // The first day of the sales chart and the top products: DASHBOARD_TREND_DAYS days up to today
  trendStart: string;
}

// It reads the parts of the string, never a Date, so no time zone can move the day (the same rule
// as fiscalYearOf in reports.ts)
export function dashboardPeriods(today: string): DashboardPeriods {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthLastDay = shiftIsoDate(monthStart, -1);
  const lastMonthStart = `${lastMonthLastDay.slice(0, 7)}-01`;
  const day = Math.min(Number(today.slice(8, 10)), Number(lastMonthLastDay.slice(8, 10)));
  return {
    today,
    yesterday: shiftIsoDate(today, -1),
    monthStart,
    lastMonthStart,
    lastMonthEnd: `${lastMonthStart.slice(0, 8)}${String(day).padStart(2, '0')}`,
    trendStart: shiftIsoDate(today, 1 - DASHBOARD_TREND_DAYS),
  };
}

// Every day from `from`, `count` days, with its amount: a day with no row is a day with no sales,
// "0.0000", so the chart has a point for every day. The API and the mock both call it.
export function everyDay(
  from: string,
  count: number,
  amounts: ReadonlyMap<string, string>,
): { date: string; amount: string }[] {
  return Array.from({ length: count }, (_, index) => {
    const date = shiftIsoDate(from, index);
    return { date, amount: amounts.get(date) ?? '0.0000' };
  });
}

// The change line of a KPI: "+12.5" percent against what it is compared with. null when there is
// nothing to compare with (no sales yesterday): the screen then shows no percent, not "+∞%".
export function changePercent(current: string, previous: string): string | null {
  return isZeroMoney(previous) ? null : percentOfWhole(subtractMoney(current, previous), previous);
}

// What was left of the sales after their cost, as a percent of the sales. null with no sales.
export function marginPercent(period: { sales: string; cost: string }): string | null {
  return isZeroMoney(period.sales)
    ? null
    : percentOfWhole(subtractMoney(period.sales, period.cost), period.sales);
}

// ---------------------------------------------------------------------------------------------
// The answer. Every amount is a decimal string with 4 places, like the reports; the screen shows
// whole taka (CLAUDE.md → Money: dashboards stay without decimals).

// No branch = the whole workspace. A branch that does not exist (or is another workspace's) is
// not an error: nothing was sold there, so its numbers are zero, like the profit and loss's.
export const dashboardQuerySchema = z.object({ branchId: z.uuid().optional() });
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const dashboardDaySchema = z.object({ date: z.iso.date(), amount: z.string() });
export type DashboardDay = z.infer<typeof dashboardDaySchema>;

export const dashboardSalesSchema = z.object({
  today: z.string(),
  yesterday: z.string(),
  monthToDate: z.string(),
  lastMonthToDate: z.string(),
  // DASHBOARD_TREND_DAYS days, the oldest first, the last one today (everyDay())
  days: z.array(dashboardDaySchema).length(DASHBOARD_TREND_DAYS),
});
export type DashboardSales = z.infer<typeof dashboardSalesSchema>;

// cost: what the cost of goods sold account took in the same days. The sales are repeated here, so
// the margin stands on its own and marginPercent() reads one object.
const salesAndCostSchema = z.object({ sales: z.string(), cost: z.string() });

export const dashboardMarginSchema = z.object({
  monthToDate: salesAndCostSchema,
  lastMonthToDate: salesAndCostSchema,
});
export type DashboardMargin = z.infer<typeof dashboardMarginSchema>;

export const dashboardCashAccountSchema = z.object({
  accountId: z.uuid(),
  code: z.string(),
  name: z.string(),
  // Debit − credit now: below zero is an overdrawn bank account, shown with a minus
  balance: z.string(),
});
export type DashboardCashAccount = z.infer<typeof dashboardCashAccountSchema>;

export const dashboardCashSchema = z.object({
  // Every active account money is kept in (moneyAccountIds() in accounts.ts), the largest first
  accounts: z.array(dashboardCashAccountSchema),
  total: z.string(),
  // The total at the end of yesterday: the change line says what came in or went out today
  yesterday: z.string(),
});
export type DashboardCash = z.infer<typeof dashboardCashSchema>;

// The receivables (customers) or the payables (suppliers)
export const dashboardDuesSchema = z.object({
  // The receivable or payable account's balance in its natural sign: what the customers owe, less
  // what they paid in advance. Below zero when the advances are larger.
  total: z.string(),
  // Posted invoices (or bills) past their due date and not settled in full (isOverdue() in
  // invoices.ts and bills.ts): what is still due on them, and how many there are
  overdue: z.string(),
  overdueCount: z.number().int().min(0),
});
export type DashboardDues = z.infer<typeof dashboardDuesSchema>;

// What the screen needs to write a quantity ("72 pcs"), offline too, where it cannot look the
// unit up
export const dashboardUnitSchema = unitSchema.pick({ code: true, decimals: true });

export const dashboardLowStockItemSchema = reorderItemSchema.extend({
  warehouseName: z.string(),
  baseUnit: dashboardUnitSchema,
});
export type DashboardLowStockItem = z.infer<typeof dashboardLowStockItemSchema>;

export const dashboardLowStockSchema = z.object({
  // Every variant and warehouse at or below its reorder level, like the reorder report
  count: z.number().int().min(0),
  // The first DASHBOARD_LOW_STOCK_ITEMS of them, the emptiest first (the smallest share of its
  // reorder level on hand)
  items: z.array(dashboardLowStockItemSchema).max(DASHBOARD_LOW_STOCK_ITEMS),
});
export type DashboardLowStock = z.infer<typeof dashboardLowStockSchema>;

// What was sold of one variant in the chart's days: posted invoices and POS sales, before their
// returns. The largest amount first.
export const dashboardTopProductSchema = variantRefSchema.extend({
  // In the base unit
  quantity: z.string(),
  baseUnit: dashboardUnitSchema,
  // After discounts, before VAT, like the sales above
  amount: z.string(),
});
export type DashboardTopProduct = z.infer<typeof dashboardTopProductSchema>;

export const dashboardSchema = z.object({
  // The workspace's today when the answer was made: every period counts from it
  today: z.iso.date(),
  // When the answer was made: offline, the screen says "As of 10:42"
  generatedAt: z.iso.datetime(),
  branchId: z.uuid().nullable(),
  // null = no permission for that card (DASHBOARD_CARD_PERMISSIONS)
  sales: dashboardSalesSchema.nullable(),
  margin: dashboardMarginSchema.nullable(),
  cash: dashboardCashSchema.nullable(),
  topProducts: z.array(dashboardTopProductSchema).max(DASHBOARD_TOP_PRODUCTS).nullable(),
  receivables: dashboardDuesSchema.nullable(),
  payables: dashboardDuesSchema.nullable(),
  lowStock: dashboardLowStockSchema.nullable(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const dashboardRoutes = {
  // No permission on the route: everyone signed in has a home page, and each card checks its own
  get: defineRoute({
    method: 'GET',
    path: '/dashboard',
    summary: "The home page's numbers: sales, margin, cash, dues and low stock, as allowed",
    auth: 'bearer',
    status: 200,
    query: dashboardQuerySchema,
    response: dashboardSchema,
  }),
};
```

**The header and the permissions:**

- **The header comment is the design in one place:** where the sales come from, why a card the person may not see is
  `null` and not hidden by the screen, and which cards a branch filters. 21a.3's service and 21a.6's page both follow
  it.
- **`DASHBOARD_CARD_PERMISSIONS` lists every permission a card needs,** and `satisfies Record<DashboardCard, readonly
  PermissionKey[]>` makes a card added to `DASHBOARD_CARDS` without its permissions fail the type check, and a
  misspelt key too.
- **`dashboardCardsFor()` takes `readonly string[]`,** not `PermissionKey[]`: `me.permissions` is `z.string()` on the
  wire, so a newer server's new key does not break an older client. A key it does not know simply matches no card.
- **It filters `DASHBOARD_CARDS`,** so the cards come out in the screen's order whatever order the permissions are in.

**The days:**

- **`dashboardPeriods()` reads the parts of the date string,** never a `Date`: the server runs in UTC and the
  workspace in Asia/Dhaka, and 00:30 on 2 November in Dhaka is still 1 November in UTC. The caller passes the
  workspace's today (`todayIn()`).
- **`lastMonthEnd` is the smaller of today's day and last month's last day** (decision 17). `shiftIsoDate(monthStart,
  -1)` is last month's last day, so February's 28 or 29 comes from the calendar, not from a table.
- **`trendStart` is `today − 29`,** so the chart has 30 days with today as the last one.
- **`everyDay()` fills the days with no sales with `"0.0000"`.** The day totals table has no row for a day with no
  entries; without the zeros, the chart would draw a straight line over a closed Friday.

**The percents:**

- **`changePercent()` and `marginPercent()` return `null` when the base is zero** (decision 20), so the page never
  divides by zero and has a plain way to show "no percent".

**The answer:**

- **Every amount is a 4-place string,** like the reports: the API reads the sums straight from Postgres's
  `NUMERIC(19,4)`, and the page rounds to whole taka.
- **`days` is `.length(DASHBOARD_TREND_DAYS)`,** so an answer with a missing day fails the parse in the tests, not as
  a crooked chart on the page.
- **`dashboardUnitSchema` picks `code` and `decimals` from `unitSchema`:** what `72 pcs` or `2.750 kg` needs, and
  nothing that changes more often than the stock.
- **`dashboardLowStockItemSchema` extends `reorderItemSchema`,** the reorder report's row, so the link from a card to
  the reorder report shows the same item with the same numbers.
- **`topProducts` is `.max(DASHBOARD_TOP_PRODUCTS)`** and `lowStock.items` `.max(DASHBOARD_LOW_STOCK_ITEMS)`: the
  answer is sealed on the device, and a bug that sent every product would fill it.
- **`generatedAt` is a full time, `today` a date:** the page writes "As of 10:42" from the first and counts the days
  from the second, in the workspace's time zone, without working the date out again on the device.
- **The route has no `permission`** (decision 14), like `GET /sales-accounts`. `defineRoute()` then only checks the
  person is signed in.

```ts
import { describe, expect, it } from 'vitest';

import {
  changePercent,
  type Dashboard,
  DASHBOARD_TREND_DAYS,
  dashboardCardsFor,
  dashboardPeriods,
  dashboardSchema,
  everyDay,
  marginPercent,
} from './dashboard.js';

describe('dashboard periods', () => {
  it('compares 1–2 Nov with 1–2 Oct, and charts the 30 days up to today', () => {
    expect(dashboardPeriods('2026-11-02')).toEqual({
      today: '2026-11-02',
      yesterday: '2026-11-01',
      monthStart: '2026-11-01',
      lastMonthStart: '2026-10-01',
      lastMonthEnd: '2026-10-02',
      trendStart: '2026-10-04',
    });
  });

  it('compares 31 March with the whole of February, never with days of March', () => {
    expect(dashboardPeriods('2027-03-31')).toMatchObject({
      lastMonthStart: '2027-02-01',
      lastMonthEnd: '2027-02-28',
    });
    // 2028 is a leap year
    expect(dashboardPeriods('2028-03-30')).toMatchObject({ lastMonthEnd: '2028-02-29' });
  });

  it('goes back into last year on 1 January', () => {
    expect(dashboardPeriods('2027-01-01')).toEqual({
      today: '2027-01-01',
      yesterday: '2026-12-31',
      monthStart: '2027-01-01',
      lastMonthStart: '2026-12-01',
      lastMonthEnd: '2026-12-01',
      trendStart: '2026-12-03',
    });
  });
});

describe('everyDay', () => {
  it('gives every day a point, zero when nothing was sold', () => {
    const days = everyDay(
      '2026-10-04',
      DASHBOARD_TREND_DAYS,
      new Map([
        ['2026-10-04', '18400.0000'],
        ['2026-11-02', '52650.5000'],
      ]),
    );
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ date: '2026-10-04', amount: '18400.0000' });
    // Across the end of October
    expect(days[27]).toEqual({ date: '2026-10-31', amount: '0.0000' });
    expect(days[28]).toEqual({ date: '2026-11-01', amount: '0.0000' });
    expect(days[29]).toEqual({ date: '2026-11-02', amount: '52650.5000' });
  });
});

describe('change and margin', () => {
  it('says how much today moved against yesterday', () => {
    expect(changePercent('52650.5', '46800')).toBe('12.5');
    expect(changePercent('0', '46800')).toBe('-100.0');
  });

  it('has no percent when there is nothing to compare with', () => {
    expect(changePercent('52650.5', '0.0000')).toBeNull();
  });

  it('works out the margin, and has none without sales', () => {
    expect(marginPercent({ sales: '840000', cost: '651000' })).toBe('22.5');
    // Sold below cost
    expect(marginPercent({ sales: '1000', cost: '1200' })).toBe('-20.0');
    expect(marginPercent({ sales: '0.0000', cost: '350' })).toBeNull();
  });
});

describe('dashboardCardsFor', () => {
  it('gives an owner every card, in the screen order', () => {
    expect(
      dashboardCardsFor([
        'sales.report.read',
        'inventory.stock.value',
        'accounting.report.read',
        'sales.customer.balance',
        'purchase.supplier.balance',
        'inventory.report.read',
      ]),
    ).toEqual(['sales', 'margin', 'cash', 'topProducts', 'receivables', 'payables', 'lowStock']);
  });

  it('shows no margin to a storekeeper who sees stock values but not sales', () => {
    expect(dashboardCardsFor(['inventory.stock.value', 'inventory.report.read'])).toEqual([
      'lowStock',
    ]);
  });

  it('gives a cashier nothing, and ignores keys it does not know', () => {
    expect(dashboardCardsFor(['pos.sale.create', 'pos.something.new'])).toEqual([]);
  });
});

describe('dashboardSchema', () => {
  const empty: Dashboard = {
    today: '2026-11-02',
    generatedAt: '2026-11-02T04:42:00.000Z',
    branchId: null,
    sales: null,
    margin: null,
    cash: null,
    topProducts: null,
    receivables: null,
    payables: null,
    lowStock: null,
  };

  it('reads an answer with no card at all', () => {
    expect(dashboardSchema.parse(empty)).toEqual(empty);
  });

  it('refuses a sales chart that is not 30 days', () => {
    const days = everyDay('2026-10-05', 29, new Map());
    const result = dashboardSchema.safeParse({
      ...empty,
      sales: {
        today: '0.0000',
        yesterday: '0.0000',
        monthToDate: '0.0000',
        lastMonthToDate: '0.0000',
        days,
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- **The fixtures are the Monday of "The whole picture" above:** 2 November 2026, ৳52,650.50 today against ৳46,800
  yesterday (+12.5%), a margin of ৳1,89,000 on ৳8,40,000 (22.5%).
- **"Compares 31 March with the whole of February"** is decision 17, in a normal year and a leap year.
- **"Goes back into last year on 1 January"** crosses the year in all four dates at once, where a month worked out by
  hand goes to month 0.
- **"Shows no margin to a storekeeper"** is decision 16: `inventory.stock.value` alone is not enough.
- **"Refuses a sales chart that is not 30 days"** keeps `.length()` from being loosened later.

### `money.ts`: a percent of a whole

```diff
@@ -199,3 +199,19 @@ export function priceInUnit(price: string, fromFactor: string, toFactor: string)
     divideRounded(toUnits(price) * factorMicros(toFactor), factorMicros(fromFactor)),
   );
 }
+
+// ---------------------------------------------------------------------------------------------
+// The dashboard (step 21a): a margin and a change line as a percent
+
+// part ÷ whole as a percent with 1 decimal, rounded half away from zero: ৳1,150 of ৳4,600 is
+// "25.0". A decimal string like every amount, so the screen formats it and never sees a float. The
+// whole counts by its size: a fall from −৳200 to −৳300 is a change of −৳100 on ৳200, "-50.0". It
+// must not be zero; the caller has nothing to compare with then and shows no percent.
+export function percentOfWhole(part: string, whole: string): string {
+  const wholeUnits = toUnits(whole);
+  if (wholeUnits === 0n) throw new Error('Cannot take a percent of zero');
+  // part (10^-4) × 1000 ÷ whole (10^-4) = tenths of a percent
+  const tenths = divideRounded(toUnits(part) * 1000n, wholeUnits < 0n ? -wholeUnits : wholeUnits);
+  const size = tenths < 0n ? -tenths : tenths;
+  return `${tenths < 0n ? '-' : ''}${String(size / 10n)}.${String(size % 10n)}`;
+}
```

- **It works in whole numbers, like every money helper:** both amounts become ten-thousandths of a taka (`toUnits()`),
  so `part × 1000 ÷ whole` is the answer in tenths of a percent with no float in between. `divideRounded()` is the
  same rounding the paisa use: half away from zero.
- **The whole counts by its size.** With the sign kept, a loss that grew from ৳200 to ৳300 would read as +50%, which
  says the opposite of what happened.
- **It throws on a zero whole** instead of returning something: the dashboard's two callers check for zero first and
  return `null`, so a throw here is a bug that a test finds.
- **It returns `"0.0"` without a minus** when a small fall rounds to zero: `tenths < 0n` is false for `0n`.

```diff
@@ -12,6 +12,7 @@ import {
   negateMoney,
   priceInUnit,
   percentOfMoney,
+  percentOfWhole,
   prorateMoney,
   splitMoney,
   subtractMoney,
@@ -119,4 +120,22 @@ describe('money', () => {
     expect(priceInUnit('100', '1', '0.914400')).toBe('91.4400');
     expect(() => priceInUnit('100', '0', '1')).toThrow();
   });
+
+  it('works out a percent of a whole to one decimal', () => {
+    // A margin: ৳1,150 of ৳4,600
+    expect(percentOfWhole('1150', '4600')).toBe('25.0');
+    // 1 of 3 = 33.33…, 2 of 3 = 66.66…: rounded to the tenth
+    expect(percentOfWhole('1', '3')).toBe('33.3');
+    expect(percentOfWhole('2', '3')).toBe('66.7');
+    // A change line: ৳18,000 today against ৳20,000 yesterday
+    expect(percentOfWhole('-2000', '20000')).toBe('-10.0');
+    // −0.05% rounds away from zero, like a negative paisa
+    expect(percentOfWhole('-1', '2000')).toBe('-0.1');
+    // Less than half a tenth is zero, without a minus
+    expect(percentOfWhole('-1', '30000')).toBe('0.0');
+    // The whole counts by its size: −৳200 to −৳300 is −50%
+    expect(percentOfWhole('-100', '-200')).toBe('-50.0');
+    expect(percentOfWhole('500', '100')).toBe('500.0');
+    expect(() => percentOfWhole('1', '0.0000')).toThrow();
+  });
 });
```

- **"−0.05% rounds away from zero"** checks the rounding at its exact half, the place where a float would go wrong.

### `permissions.ts`, `routes.ts`, `index.ts`

```diff
@@ -22,6 +22,7 @@ export const PERMISSION_KEYS = [
   'inventory.stock.transfer',
   'inventory.stock.value',
   'inventory.stock.revalue',
+  'inventory.report.read',
   'sales.customer.manage',
   'sales.customer.balance',
   'sales.price_list.manage',
@@ -34,6 +35,7 @@ export const PERMISSION_KEYS = [
   'sales.return.manage',
   'sales.credit_note.manage',
   'sales.refund.manage',
+  'sales.report.read',
   'purchase.supplier.manage',
   'purchase.supplier.balance',
   'purchase.requisition.manage',
@@ -44,6 +46,7 @@ export const PERMISSION_KEYS = [
   'purchase.return.manage',
   'purchase.debit_note.manage',
   'purchase.refund.manage',
+  'purchase.report.read',
   'pos.sale.create',
   'pos.price.override',
   'pos.register.manage',
@@ -93,6 +96,7 @@ export const PERMISSION_GROUP_OF = {
   'inventory.stock.transfer': 'inventory',
   'inventory.stock.value': 'inventory',
   'inventory.stock.revalue': 'inventory',
+  'inventory.report.read': 'inventory',
   'sales.customer.manage': 'sales',
   'sales.customer.balance': 'sales',
   'sales.price_list.manage': 'sales',
@@ -105,6 +109,7 @@ export const PERMISSION_GROUP_OF = {
   'sales.return.manage': 'sales',
   'sales.credit_note.manage': 'sales',
   'sales.refund.manage': 'sales',
+  'sales.report.read': 'sales',
   'purchase.supplier.manage': 'purchase',
   'purchase.supplier.balance': 'purchase',
   'purchase.requisition.manage': 'purchase',
@@ -115,6 +120,7 @@ export const PERMISSION_GROUP_OF = {
   'purchase.return.manage': 'purchase',
   'purchase.debit_note.manage': 'purchase',
   'purchase.refund.manage': 'purchase',
+  'purchase.report.read': 'purchase',
   'pos.sale.create': 'pos',
   'pos.price.override': 'pos',
   'pos.register.manage': 'pos',
```

- **Each new permission sits at the end of its module's list,** so the role matrix shows it last in its group, and
  `PERMISSION_GROUP_OF` puts it in that group; `satisfies Record<PermissionKey, PermissionGroup>` refuses a key without
  one.

```diff
@@ -19,6 +19,7 @@ import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
+import { dashboardRoutes } from './dashboard.js';
 import { debitNoteRoutes } from './debit-notes.js';
 import { deliveryRoutes } from './deliveries.js';
 import { deviceRoutes } from './devices.js';
@@ -94,6 +95,7 @@ export const routes = {
   reports: reportRoutes,
   fiscalYears: fiscalYearRoutes,
   reportExports: reportExportRoutes,
+  dashboard: dashboardRoutes,
   units: unitRoutes,
   productCategories: productCategoryRoutes,
   customFields: customFieldRoutes,
```

```diff
@@ -9,6 +9,7 @@ export * from './branches.js';
 export * from './credit-notes.js';
 export * from './custom-fields.js';
 export * from './customers.js';
+export * from './dashboard.js';
 export * from './debit-notes.js';
 export * from './deliveries.js';
 export * from './devices.js';
```

The OpenAPI document is generated from the built package (`@omnivo/contracts` points at `dist/`), so build it first:

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts gen:openapi
```

It adds `GET /dashboard` and its answer to `packages/contracts/openapi.json`, and the three permissions to every list
of permission keys in it. Commit it as it is. Without the build, the generator reads the old `dist/` and writes the old
document, and says it is valid.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts test:openapi
```

All pass (contracts 363 tests, 13 new). Do not run the whole `pnpm typecheck` yet. Until their parts, these fail, as
expected: `packages/db` (the permission catalog has no text for the three new permissions, 21a.2) and `apps/app` (the
role matrix has no words for them, 21a.5).

## 21a.2 — `packages/db`: the day totals

One new table, kept by the database itself. Migration 0057 is generated from the schema. Migration 0058 is written by
hand: row-level security, the trigger that adds every posted entry to the table, and the backfill of the entries posted
before this step. Nothing that exists changes: the journal's tables, its triggers and its rules stay as they are.

### `schema/journal.ts`: `account_day_totals`

```diff
@@ -1,6 +1,7 @@
 import { JOURNAL_SOURCES, JOURNAL_STATUSES } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
+  boolean,
   check,
   date,
   foreignKey,
@@ -10,6 +11,7 @@ import {
   smallint,
   text,
   timestamp,
+  unique,
   uniqueIndex,
   uuid,
 } from 'drizzle-orm/pg-core';
@@ -160,6 +162,53 @@ export const journalLines = pgTable(
   ],
 );
 
+// Step 21a: the journal added up per day, account and branch, so the dashboard (and the reports
+// after it) sum a few hundred rows instead of every line. Kept by the database itself (migration
+// 0058's trigger adds each entry when it is posted, at COMMIT); code only reads it. Posted entries
+// only: a draft's lines can still change. Not a materialized view: those have no row-level
+// security, and a refresh rebuilds every workspace and is old until the next one.
+export const accountDayTotals = pgTable(
+  'account_day_totals',
+  {
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    // The entry's date (its business day), not the day it was posted
+    day: date('day', { mode: 'string' }).notNull(),
+    accountId: uuid('account_id').notNull(),
+    // NULL: the lines had no branch
+    branchId: uuid('branch_id'),
+    // A year-end closing entry or its reversal (step 11). Kept apart so the sales and the profit
+    // and loss can leave them out, and the trial balance can still add them in.
+    closing: boolean('closing').notNull(),
+    debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
+    credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
+  },
+  (table) => [
+    // One row per account, day, branch and kind; the trigger's ON CONFLICT target. Account first:
+    // every question asks about a few accounts (the sales accounts, the cash accounts) over days.
+    // NULLS NOT DISTINCT: without it, two rows with branch_id NULL would not collide.
+    unique('account_day_totals_key')
+      .on(table.tenantId, table.accountId, table.day, table.branchId, table.closing)
+      .nullsNotDistinct(),
+    // An account with entries cannot be deleted anyway (journal_lines_account_fk); this one says
+    // the same, and keeps another workspace's account out
+    foreignKey({
+      name: 'account_day_totals_account_fk',
+      columns: [table.tenantId, table.accountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
+    // NULL branch_id skips the check (MATCH SIMPLE)
+    foreignKey({
+      name: 'account_day_totals_branch_fk',
+      columns: [table.tenantId, table.branchId],
+      foreignColumns: [branches.tenantId, branches.id],
+    }),
+    // Sums of lines that are never negative
+    check('account_day_totals_not_negative', sql`${table.debit} >= 0 AND ${table.credit} >= 0`),
+  ],
+);
+
 // The lock date: the books are closed up to and including this day. One row per workspace, made
 // the first time someone needs it (like number_series), so no backfill for old workspaces.
 export const periodLocks = pgTable('period_locks', {
```

- **It lives in `journal.ts`,** next to the lines it adds up: whoever changes the journal sees it.
- **The header comment says who writes it** (0058's trigger, never the code) and why it is not a materialized view
  (decision 2), so nobody "fixes" it into one later.
- **No `id`, no `version`, no `created_by`** (decision 27). A row is not a thing a person made; it is a sum. The key is
  the unique constraint.
- **`day` is the entry's date,** a `date` read as a string, like `journal_entries.date`. An invoice of 31 October posted
  on 2 November counts on 31 October, as in the profit and loss.
- **`branch_id` is nullable,** like the line's: an entry written by hand may have no branch. The workspace total is
  every row; one branch's total is its rows only, as in the profit and loss with a branch picked.
- **`closing` is part of the key** (decision 25). A closing entry and a sale on 30 June would otherwise add into one row,
  and the sales could not leave the closing entry out.
- **`account_day_totals_key` is a `unique` with `.nullsNotDistinct()`,** like `stock_balances_key`. It is the trigger's
  `ON CONFLICT` target, and without `NULLS NOT DISTINCT` every entry with no branch would make a new row instead of
  adding to the day's row: the sums would still be right, but the table would grow like the journal.
- **The key starts with the account, then the day.** Every question the dashboard asks is "these few accounts over
  these days" (the sales accounts over 30 days, the cash accounts up to today), and that is one range in this index.
- **`account_day_totals_account_fk` and `account_day_totals_branch_fk`** keep another workspace's account or branch
  out, like the lines' foreign keys. A row exists only for an account with posted lines, which cannot be deleted
  anyway; 21a.3 adds this key's name to the account's `account_in_use` error, because which foreign key Postgres
  checks first is not promised.
- **`account_day_totals_not_negative`:** debits and credits are sums of amounts that are never negative. Keeping both,
  not one net amount, lets a report show the turnover (21b) as well as the balance.

### `permission-catalog.ts`

```diff
@@ -30,6 +30,7 @@ const DESCRIPTIONS = {
   'inventory.stock.transfer': 'Send stock to another warehouse and receive it there',
   'inventory.stock.value': 'See what stock costs and what it is worth',
   'inventory.stock.revalue': 'Revalue stock: give items a new average cost',
+  'inventory.report.read': 'See the stock reports, and the low stock on the dashboard',
   'sales.customer.manage': 'Add, edit, archive and delete customers and customer groups',
   'sales.customer.balance': 'See what customers owe, and their statements',
   'sales.price_list.manage': 'Add, edit and archive price lists, and set their prices',
@@ -42,6 +43,8 @@ const DESCRIPTIONS = {
   'sales.return.manage': 'Write and post sales returns, which bring stock back in',
   'sales.credit_note.manage': 'Write and post credit notes, and apply their money to invoices',
   'sales.refund.manage': 'Pay money back to customers and void refunds',
+  'sales.report.read':
+    'See the sales reports, and the sales and the best-selling products on the dashboard',
   'purchase.supplier.manage': 'Add, edit, archive and delete suppliers and supplier groups',
   'purchase.supplier.balance': 'See what the company owes suppliers, and their statements',
   'purchase.requisition.manage':
@@ -53,6 +56,7 @@ const DESCRIPTIONS = {
   'purchase.return.manage': 'Write and post purchase returns, which send stock back to suppliers',
   'purchase.debit_note.manage': 'Write and post debit notes, and apply their money to bills',
   'purchase.refund.manage': 'Record money suppliers paid back, and void supplier refunds',
+  'purchase.report.read': 'See the purchase reports',
   'pos.sale.create':
     'Sell at a POS register, take a free register for this device, and run its shifts',
   'pos.price.override':
```

- **The three new permissions get their descriptions.** `satisfies Record<PermissionKey, string>` has failed the db type
  check since 21a.1 until they were there. `pnpm db:migrate` writes them (`syncPermissions()`).
- **Each says what it shows today,** and 21b and 21c change the words when their reports arrive:
  `purchase.report.read` has no screen until 21b.

### Migration 0057 (generated)

Run `pnpm --filter @omnivo/db generate --name account-day-totals`. This time there is no index to move: the key is a
constraint inside `CREATE TABLE`, and the foreign keys point at indexes that exist already. The result:

```sql
CREATE TABLE "account_day_totals" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"closing" boolean NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "account_day_totals_key" UNIQUE NULLS NOT DISTINCT("tenant_id","account_id","day","branch_id","closing"),
	CONSTRAINT "account_day_totals_not_negative" CHECK ("account_day_totals"."debit" >= 0 AND "account_day_totals"."credit" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_day_totals" ADD CONSTRAINT "account_day_totals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_day_totals" ADD CONSTRAINT "account_day_totals_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_day_totals" ADD CONSTRAINT "account_day_totals_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;
```

- **A new, empty table:** creating it is quick and locks nothing that exists.
- `meta/_journal.json`, `meta/0057_snapshot.json` and `meta/0058_snapshot.json` change too. They are generated; commit
  them as they are.

### Migration 0058 (written by hand)

Run `pnpm --filter @omnivo/db generate --custom --name account-day-totals-rules` and put this in the empty file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
ALTER TABLE account_day_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_day_totals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_day_totals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) The totals only grow: a posted entry is never deleted, so no row ever goes. omnivo_app keeps
--    INSERT and UPDATE (default privileges), because the trigger below runs as the person who
--    posts; code never writes this table.
REVOKE DELETE ON account_day_totals FROM omnivo_app;

-- 3) A posted entry adds its lines to the day's totals: one row per account and branch, on the
--    entry's date. Every entry is posted the same way, a draft turned into a posted entry by one
--    UPDATE (0016 refuses new lines on a posted entry), so that update is the only event to
--    watch. A posted entry never changes again, so nothing is ever taken back out.
--    It runs at COMMIT (DEFERRABLE INITIALLY DEFERRED), not at the update. The upsert locks the
--    day's rows, and every sale of the day reaches the same sales and cash rows: locked at the
--    update, they would stay locked for the rest of a long posting (the stock, the document),
--    and every other posting would queue behind it. At COMMIT the lock lasts a moment.
--    The advisory lock makes the postings of one workspace add their totals one at a time. Without
--    it, two transactions that each post two entries (a transfer, a POS sale with an exchange)
--    could each hold a row the other wants next: a deadlock, and one of them fails.
--    A year-end closing entry and the reversal of one are marked `closing`, like the reports'
--    withoutClosingEntries().
CREATE FUNCTION journal_entries_day_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_closing boolean;
BEGIN
  v_closing := NEW.source = 'year_close' OR (NEW.source = 'reversal' AND EXISTS (
    SELECT 1 FROM journal_entries o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.reversal_of_id AND o.source = 'year_close'));

  PERFORM pg_advisory_xact_lock(hashtextextended('account_day_totals:' || NEW.tenant_id::text, 0));

  -- GROUP BY: two lines of one entry on the same account and branch become one row, so the
  -- ON CONFLICT never meets the same row twice in one statement (Postgres refuses that)
  INSERT INTO account_day_totals AS t (tenant_id, day, account_id, branch_id, closing, debit, credit)
  SELECT l.tenant_id, NEW.date, l.account_id, l.branch_id, v_closing, sum(l.debit), sum(l.credit)
    FROM journal_lines l
   WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
   GROUP BY l.tenant_id, l.account_id, l.branch_id
  ON CONFLICT ON CONSTRAINT account_day_totals_key
  DO UPDATE SET debit = t.debit + EXCLUDED.debit, credit = t.credit + EXCLUDED.credit;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_day_totals
  AFTER UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'posted')
  EXECUTE FUNCTION journal_entries_day_totals();

-- 4) The entries posted before this step, every workspace's (a deleted one too: it may be
--    restored), added up the way the trigger would have. After the trigger: creating it waits for
--    the postings that are running, and holds back new ones until the migration commits, so an
--    entry is counted once, here or by the trigger. Per tenant, with app.tenant_id set, because
--    FORCE RLS applies to the table owner too; cleared at the end, so no later migration in the
--    same run reads as the last workspace.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO account_day_totals (tenant_id, day, account_id, branch_id, closing, debit, credit)
    SELECT l.tenant_id, e.date, l.account_id, l.branch_id,
           e.source = 'year_close' OR coalesce(o.source = 'year_close', false),
           sum(l.debit), sum(l.credit)
      FROM journal_lines l
      JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      LEFT JOIN journal_entries o ON o.tenant_id = e.tenant_id AND o.id = e.reversal_of_id
     WHERE l.tenant_id = t AND e.status = 'posted'
     GROUP BY 1, 2, 3, 4, 5;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

**1) and 2): row-level security and no delete.**

- **The same policy as every workspace table,** with `FORCE`, so the table's owner obeys it too. The RLS coverage test
  (`rls-coverage.tenant-leak.int.spec.ts`) finds the new table by its `tenant_id` and fails if this part is missing.
- **`REVOKE DELETE`:** a posted entry is never deleted, so a total never goes down by a delete. Insert and update stay,
  because the trigger runs as the person who posts (`omnivo_app`).

**3): the trigger.**

- **It fires on the update from `draft` to `posted`** (decision 23), the one way every entry is posted
  (`PostingService.post()`). Not on `journal_lines` insert: a line is always written into a draft, and the draft's lines
  can still be changed or deleted. The `WHEN` clause keeps the trigger from even running on other updates (a draft's
  narration changed).
- **`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`** makes it run at COMMIT, like 0016's balance check. The row
  locks the upsert takes are then held only for the moment of the commit, not for the rest of an invoice's posting
  (stock, credit check, the document). If the commit fails anyway (the balance check, a POS sale's check), the totals
  go with it: they are in the same transaction.
- **`NEW` is the entry as it was posted.** A posted entry cannot change (0016), so the date read at COMMIT is the date
  it was posted with, and no total ever needs taking back out.
- **`v_closing`** is decision 25: the closing entry itself, or a reversal whose original is one (a year reopened), the
  same rule as `withoutClosingEntries()` in the reports.
- **`pg_advisory_xact_lock(hashtextextended('account_day_totals:' || tenant, 0))`** is decision 24. It is per
  workspace, so two companies never wait for each other, and its name cannot meet the period lock's
  (`period_lock:…`). It is taken at COMMIT, after every other lock the transaction holds, and nothing waits for it
  except another commit: it cannot be part of a deadlock itself.
- **`GROUP BY l.tenant_id, l.account_id, l.branch_id`:** one row per account and branch of the entry. A POS sale with
  three payment lines to the same cash account is one row; without the grouping, the second line would meet the row
  the first one just inserted in the same statement, which Postgres refuses ("ON CONFLICT DO UPDATE command cannot
  affect row a second time").
- **`ON CONFLICT … DO UPDATE SET debit = t.debit + EXCLUDED.debit`:** the first entry of the day makes the row, the
  others add to it. The update locks the row, so two postings never lose each other's amounts.
- **`RETURN NULL`:** an `AFTER` trigger's return value is ignored; `NULL` says so.

**4): the backfill.**

- **The same sums as the trigger, in one statement per workspace,** for every entry posted before this migration. The
  `LEFT JOIN` finds a reversal's original for `closing`; a manual entry has none and gets `false` (the `coalesce`).
- **Every tenant, deleted ones too** (decision 26): a workspace restored later must not show empty sales.
- **After `CREATE CONSTRAINT TRIGGER`:** creating a trigger waits for the postings that are running and holds back new
  ones until the migration commits. An entry posted before is in the backfill; one posted after goes through the
  trigger. None is counted twice or missed.
- **`set_config('app.tenant_id', …, true)` per workspace** because `FORCE` row-level security applies to the migrator
  too, as in 0024's backfill. Set back to `''` at the end, so a later migration in the same run does not act as the last
  workspace by accident.
- **How long it takes:** one pass over the posted lines. A workspace with a million lines takes some seconds; the
  journal is held for that time, so run it outside office hours.

### What I checked

> On a throwaway Postgres 17 with every migration (never your dev database), as `omnivo_app` with row-level security on:
>
> An entry of ৳52,650.50 (Cash in hand to Sales, Sylhet depot) added nothing until COMMIT, then two rows. A second
> entry with two lines on one account and branch added one row's worth, and a line with no branch got its own row. A
> draft added nothing; a posting rolled back added nothing; an entry that did not balance failed at COMMIT with 0016's
> error and left no totals. A year-end close and the reversal of it went into `closing` rows; the reversal of an
> ordinary entry did not. The totals equalled the posted lines grouped by account, day and branch, with 0 differences.
> The other workspace saw none of the rows and posted its own. `DELETE` was refused (permission denied), and a posted
> entry's date still could not change. The backfill, run again on the same entries, gave the same 11 rows, and
> `app.tenant_id` was empty after it.
>
> Two sessions: A fired its totals early (`SET CONSTRAINTS journal_entries_day_totals IMMEDIATE`) and held them 3
> seconds; B's commit waited 2 seconds, then added on top (৳52,950.50 + ৳1,000 + ৳500 = ৳54,450.50). Two transactions
> posting two entries each in crossing order both committed. Broken on purpose: with the advisory lock taken out of the
> function, the same two transactions failed with "deadlock detected" inside the trigger's `INSERT`.
>
> The API's RLS coverage, journal (2 files), reports, POS (3 files), stock and valuation suites pass with 0057 and
> 0058: 175 tests that post entries every way the app does.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm db:migrate
pnpm --filter @omnivo/db build
```

`pnpm db:migrate` applies 0057 and 0058 to your dev database (with the backfill of your entries so far) and writes the
three permissions. The build lets the API see `accountDayTotals` in 21a.3. The db type check passes again now; the
whole `pnpm typecheck` still fails in `apps/app` (the role matrix has no words for the three permissions) until 21a.5.

To see the backfill on your own data:

```sql
SELECT a.code, a.name, sum(t.credit - t.debit) AS sales
  FROM account_day_totals t JOIN ledger_accounts a ON a.tenant_id = t.tenant_id AND a.id = t.account_id
 WHERE a.purpose = 'sales' AND NOT t.closing
 GROUP BY a.code, a.name;
```

It is the same number as the Sales account's line in the profit and loss over all dates, run as the `postgres` user (who skips
row-level security).

## 21a.3 — `apps/api`: the dashboard route

One new module answers `GET /dashboard`. Its service checks the person's permissions once and asks only the questions
for the cards they may see; the questions themselves are plain SQL in their own file. Four files outside the module
change by a few lines each.

### `dashboard/dashboard-queries.ts` (new): the questions

```ts
import {
  type AccountPurpose,
  compareCodes,
  compareMoney,
  DASHBOARD_LOW_STOCK_ITEMS,
  DASHBOARD_TOP_PRODUCTS,
  DASHBOARD_TREND_DAYS,
  type DashboardCash,
  type DashboardDues,
  type DashboardLowStock,
  type DashboardMargin,
  type DashboardPeriods,
  type DashboardSales,
  type DashboardTopProduct,
  everyDay,
  moneyAccountIds,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';
import { ledgerAccounts, tenantSettings } from '@omnivo/db';
import { eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { incomingTo, quantityText } from '../inventory/stock.service.js';

// The dashboard's questions (step 21a), in plain SQL like the reports (report-queries.ts). Each
// takes the caller's transaction. The money comes from account_day_totals (21a.2), one row per
// day, account and branch, never from the journal's lines: that is what keeps the page fast on a
// workspace with years of entries. Amounts and dates come back as text, 4 decimals, like every
// report: the driver would turn a NUMERIC into a float and a `date` into a Date at midnight UTC.

// Raw rows are data from outside TypeScript's view: checked with a schema, never cast
async function rows<S extends z.ZodType>(
  tx: Transaction,
  query: SQL,
  row: S,
): Promise<z.output<S>[]> {
  return z.array(row).parse(await tx.execute(query));
}

// `column IN (…)`. An empty list matches nothing: SQL has no empty IN list, and a workspace whose
// chart the setup job has not made yet has no sales account. Its dashboard is zeros, not an error.
function inIds(column: SQL, ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

// No branch = the whole workspace (decision 11)
function inBranch(column: SQL, branchId: string | null): SQL {
  return branchId === null ? sql`` : sql`AND ${column} = ${branchId}::uuid`;
}

// ---------------------------------------------------------------------------------------------
// The accounts

// What every card starts from, read once: the workspace's today and the accounts the cards add
// up. The whole chart is read, as assertMoneyAccount() does (step 15c): it is a few hundred rows at
// most, and moneyAccountIds() needs its tree.
export interface DashboardBooks {
  today: string;
  // The 'sales' purpose account, and the Sales returns account of Settings → Sales when one is
  // chosen (decision 10)
  salesAccountIds: string[];
  // The 'cost_of_goods_sold' purpose account: what the margin takes off the sales
  costAccountId: string | null;
  receivableAccountId: string | null;
  payableAccountId: string | null;
  // Every active account money is kept in, as the receipt form offers them
  moneyAccounts: { id: string; code: string; name: string }[];
}

export async function loadBooks(tx: Transaction): Promise<DashboardBooks> {
  const tenantId = getTenantId();
  const [chart, [settings]] = await Promise.all([
    tx
      .select({
        id: ledgerAccounts.id,
        parentId: ledgerAccounts.parentId,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        purpose: ledgerAccounts.purpose,
        isGroup: ledgerAccounts.isGroup,
        holdsMoney: ledgerAccounts.holdsMoney,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.tenantId, tenantId)),
    tx
      .select({
        timezone: tenantSettings.timezone,
        salesReturnsAccountId: tenantSettings.salesReturnsAccountId,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId)),
  ]);
  // Every chart has one account of each purpose (templates.spec.ts), or none before the setup job
  const idOf = (purpose: AccountPurpose): string | null =>
    chart.find((account) => account.purpose === purpose)?.id ?? null;
  const money = moneyAccountIds(
    chart.map((account) => ({
      ...account,
      archivedAt: account.archivedAt?.toISOString() ?? null,
    })),
  );
  const sales = [idOf('sales'), settings?.salesReturnsAccountId ?? null];
  return {
    today: todayIn(settings?.timezone ?? 'Asia/Dhaka'),
    salesAccountIds: [...new Set(sales.filter((id): id is string => id !== null))],
    costAccountId: idOf('cost_of_goods_sold'),
    receivableAccountId: idOf('accounts_receivable'),
    payableAccountId: idOf('accounts_payable'),
    moneyAccounts: chart
      .filter((account) => money.has(account.id))
      .map(({ id, code, name }) => ({ id, code, name })),
  };
}

// ---------------------------------------------------------------------------------------------
// Sales and margin

export interface DaySold {
  sales: string;
  cost: string;
}

// The first day the sales and the margin need: the 1st of last month or the chart's first day,
// whichever is earlier. Usually the 1st (1 October against 4 October on 2 November), but not
// always: on 1 March the chart starts on 31 January.
export function soldFrom(periods: DashboardPeriods): string {
  return periods.lastMonthStart < periods.trendStart ? periods.lastMonthStart : periods.trendStart;
}

// The sales (credit − debit of the sales accounts: a return is a debit) and the cost of goods sold
// (debit − credit) of each day from `from` to today, of one branch or of all. Closing entries are
// left out (decision 25): a year-end close debits Sales with the whole year's sales, and 30 June
// would show the year's sales below zero.
export async function soldByDay(
  tx: Transaction,
  books: DashboardBooks,
  from: string,
  branchId: string | null,
): Promise<Map<string, DaySold>> {
  const cost = books.costAccountId === null ? [] : [books.costAccountId];
  const found = await rows(
    tx,
    sql`SELECT t.day::text AS day,
               round(coalesce(sum(t.credit - t.debit)
                 FILTER (WHERE ${inIds(sql`t.account_id`, books.salesAccountIds)}), 0), 4)::text AS sales,
               round(coalesce(sum(t.debit - t.credit)
                 FILTER (WHERE ${inIds(sql`t.account_id`, cost)}), 0), 4)::text AS cost
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND ${inIds(sql`t.account_id`, [...books.salesAccountIds, ...cost])}
           AND NOT t.closing
           AND t.day BETWEEN ${from}::date AND ${books.today}::date
           ${inBranch(sql`t.branch_id`, branchId)}
         GROUP BY t.day`,
    z.object({ day: z.iso.date(), sales: z.string(), cost: z.string() }),
  );
  return new Map(found.map((row) => [row.day, { sales: row.sales, cost: row.cost }]));
}

// One column added up over the days from `from` to `to`, both included. ISO dates compare as
// strings. A day with no row adds nothing.
function sumDays(
  days: ReadonlyMap<string, DaySold>,
  from: string,
  to: string,
  column: keyof DaySold,
): string {
  const values: string[] = [];
  for (const [day, sold] of days) {
    if (day >= from && day <= to) values.push(sold[column]);
  }
  return sumMoney(values);
}

export function salesCard(
  days: ReadonlyMap<string, DaySold>,
  periods: DashboardPeriods,
): DashboardSales {
  return {
    today: sumDays(days, periods.today, periods.today, 'sales'),
    yesterday: sumDays(days, periods.yesterday, periods.yesterday, 'sales'),
    monthToDate: sumDays(days, periods.monthStart, periods.today, 'sales'),
    lastMonthToDate: sumDays(days, periods.lastMonthStart, periods.lastMonthEnd, 'sales'),
    days: everyDay(
      periods.trendStart,
      DASHBOARD_TREND_DAYS,
      new Map([...days].map(([day, sold]) => [day, sold.sales])),
    ),
  };
}

export function marginCard(
  days: ReadonlyMap<string, DaySold>,
  periods: DashboardPeriods,
): DashboardMargin {
  const period = (from: string, to: string) => ({
    sales: sumDays(days, from, to, 'sales'),
    cost: sumDays(days, from, to, 'cost'),
  });
  return {
    monthToDate: period(periods.monthStart, periods.today),
    lastMonthToDate: period(periods.lastMonthStart, periods.lastMonthEnd),
  };
}

// ---------------------------------------------------------------------------------------------
// Cash and dues: the whole workspace's, up to today

// Every money account's balance at the end of today and at the end of yesterday. Up to today
// only: an entry dated next week (a cheque written today for then) is not money in the bank yet.
// A closing entry never touches a money account, so `closing` is not filtered.
export async function cashCard(tx: Transaction, books: DashboardBooks): Promise<DashboardCash> {
  const found = await rows(
    tx,
    sql`SELECT t.account_id::text AS account_id,
               round(sum(t.debit - t.credit), 4)::text AS balance,
               round(coalesce(sum(t.debit - t.credit)
                 FILTER (WHERE t.day < ${books.today}::date), 0), 4)::text AS yesterday
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid
           AND ${inIds(
             sql`t.account_id`,
             books.moneyAccounts.map((account) => account.id),
           )}
           AND t.day <= ${books.today}::date
         GROUP BY t.account_id`,
    z.object({ account_id: z.uuid(), balance: z.string(), yesterday: z.string() }),
  );
  const balances = new Map(found.map((row) => [row.account_id, row.balance]));
  // An account with no entries yet is still shown, at zero: the owner sees every account they keep
  const accounts = books.moneyAccounts
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      balance: balances.get(account.id) ?? '0.0000',
    }))
    .sort((a, b) => compareMoney(b.balance, a.balance) || compareCodes(a.code, b.code));
  return {
    accounts,
    total: sumMoney(accounts.map((account) => account.balance)),
    yesterday: sumMoney(found.map((row) => row.yesterday)),
  };
}

// A control account's balance up to today, in its natural sign: debit − credit for the
// receivable (what customers owe), credit − debit for the payable (what is owed to suppliers)
async function controlBalance(
  tx: Transaction,
  accountId: string | null,
  today: string,
  side: 'debit' | 'credit',
): Promise<string> {
  if (accountId === null) return '0.0000';
  const amount = side === 'debit' ? sql`t.debit - t.credit` : sql`t.credit - t.debit`;
  const [row] = await rows(
    tx,
    sql`SELECT round(coalesce(sum(${amount}), 0), 4)::text AS balance
          FROM account_day_totals t
         WHERE t.tenant_id = ${getTenantId()}::uuid AND t.account_id = ${accountId}::uuid
           AND t.day <= ${today}::date`,
    z.object({ balance: z.string() }),
  );
  return row?.balance ?? '0.0000';
}

const overdueSchema = z.object({ overdue: z.string(), count: z.number().int() });

// Posted, not settled in full, and due before today: isOverdue() in invoices.ts. The WHERE says
// "open" in the same words as invoices_open_due_idx, so Postgres reads that partial index.
export async function receivablesCard(
  tx: Transaction,
  books: DashboardBooks,
): Promise<DashboardDues> {
  const [total, [overdue]] = await Promise.all([
    controlBalance(tx, books.receivableAccountId, books.today, 'debit'),
    rows(
      tx,
      sql`SELECT round(coalesce(sum(total - amount_paid - amount_credited), 0), 4)::text AS overdue,
                 count(*)::int AS count
            FROM invoices
           WHERE tenant_id = ${getTenantId()}::uuid
             AND status = 'posted' AND amount_paid + amount_credited < total
             AND due_date < ${books.today}::date`,
      overdueSchema,
    ),
  ]);
  return { total, overdue: overdue?.overdue ?? '0.0000', overdueCount: overdue?.count ?? 0 };
}

// The same for the suppliers' bills: isBillOverdue() in bills.ts and bills_open_due_idx
export async function payablesCard(tx: Transaction, books: DashboardBooks): Promise<DashboardDues> {
  const [total, [overdue]] = await Promise.all([
    controlBalance(tx, books.payableAccountId, books.today, 'credit'),
    rows(
      tx,
      sql`SELECT round(coalesce(sum(total - amount_paid - amount_debited), 0), 4)::text AS overdue,
                 count(*)::int AS count
            FROM bills
           WHERE tenant_id = ${getTenantId()}::uuid
             AND status = 'posted' AND amount_paid + amount_debited < total
             AND due_date < ${books.today}::date`,
      overdueSchema,
    ),
  ]);
  return { total, overdue: overdue?.overdue ?? '0.0000', overdueCount: overdue?.count ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Products and stock

const variantColumns = {
  variant_id: z.uuid(),
  product_id: z.uuid(),
  product_code: z.string(),
  product_name: z.string(),
  option_values: z.array(z.string()),
  sku: z.string(),
  base_unit_id: z.uuid(),
  unit_code: z.string(),
  unit_decimals: z.number().int(),
};

function variantOf(row: z.output<z.ZodObject<typeof variantColumns>>) {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    optionValues: row.option_values,
    sku: row.sku,
    baseUnitId: row.base_unit_id,
    baseUnit: { code: row.unit_code, decimals: row.unit_decimals },
  };
}

// What sold most in the chart's days (decision 18): the lines of posted invoices and of POS sales,
// before their returns, the largest amount after discounts and before VAT first. A POS sale's
// branch is its warehouse's (it has no branch_id). The dates are the documents' own, like the
// books: an invoice dated 31 October counts on 31 October.
export async function topProducts(
  tx: Transaction,
  periods: DashboardPeriods,
  branchId: string | null,
): Promise<DashboardTopProduct[]> {
  const tenantId = getTenantId();
  const found = await rows(
    tx,
    sql`SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               u.code AS unit_code, u.decimals AS unit_decimals,
               round(sum(sold.base_quantity), 4)::text AS quantity,
               round(sum(sold.net), 4)::text AS amount
          FROM (
            SELECT l.tenant_id, l.variant_id, l.base_quantity, l.net
              FROM invoice_lines l
              JOIN invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
             WHERE l.tenant_id = ${tenantId}::uuid AND i.status = 'posted'
               AND i.date BETWEEN ${periods.trendStart}::date AND ${periods.today}::date
               ${inBranch(sql`i.branch_id`, branchId)}
            UNION ALL
            SELECT l.tenant_id, l.variant_id, l.base_quantity, l.net
              FROM pos_sale_lines l
              JOIN pos_sales s ON s.tenant_id = l.tenant_id AND s.id = l.sale_id
              JOIN warehouses w ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
             WHERE l.tenant_id = ${tenantId}::uuid
               AND s.date BETWEEN ${periods.trendStart}::date AND ${periods.today}::date
               ${inBranch(sql`w.branch_id`, branchId)}
          ) sold
          JOIN product_variants v ON v.tenant_id = sold.tenant_id AND v.id = sold.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
         GROUP BY v.id, p.id, u.id
         ORDER BY sum(sold.net) DESC, v.id
         LIMIT ${DASHBOARD_TOP_PRODUCTS}`,
    z.object({ ...variantColumns, quantity: z.string(), amount: z.string() }),
  );
  return found.map((row) => ({ ...variantOf(row), quantity: row.quantity, amount: row.amount }));
}

// The reorder report's rows (StockService.reorder, step 13): every variant and active warehouse at
// or below its level, with what is on its way there. Here the emptiest first (decision 19): the
// smallest share of the level on hand, below zero (sold short) before empty. A level of 0 has no
// share; sign() puts its row with the empty ones (0) or the ones below zero (-1). count(*) OVER ()
// is worked out before the LIMIT: how many there are in all, in the same query.
export async function lowStockCard(tx: Transaction): Promise<DashboardLowStock> {
  const found = await rows(
    tx,
    sql`SELECT v.id::text AS variant_id, p.id::text AS product_id, p.code AS product_code,
               p.name AS product_name, v.option_values, v.sku, p.base_unit_id::text AS base_unit_id,
               u.code AS unit_code, u.decimals AS unit_decimals,
               r.warehouse_id::text AS warehouse_id, w.name AS warehouse_name,
               ${quantityText(sql`s.on_hand`)} AS on_hand,
               ${quantityText(sql`(SELECT sum(l.base_quantity) FROM stock_transfer_lines l
                  JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                 WHERE l.tenant_id = r.tenant_id AND l.variant_id = r.variant_id
                   AND t.status = 'in_transit' AND t.to_warehouse_id = r.warehouse_id)`)} AS in_transit,
               ${incomingTo(sql`r.warehouse_id`)} AS incoming,
               round(r.min_quantity, 4)::text AS min_quantity,
               round(r.reorder_quantity, 4)::text AS reorder_quantity,
               count(*) OVER ()::int AS count
          FROM reorder_levels r
          JOIN warehouses w ON w.tenant_id = r.tenant_id AND w.id = r.warehouse_id AND w.archived_at IS NULL
          JOIN product_variants v ON v.tenant_id = r.tenant_id AND v.id = r.variant_id
          JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
          JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
          LEFT JOIN LATERAL (
            SELECT sum(sb.quantity) AS on_hand FROM stock_balances sb
             WHERE sb.tenant_id = r.tenant_id AND sb.warehouse_id = r.warehouse_id
               AND sb.variant_id = r.variant_id
          ) s ON true
         WHERE r.tenant_id = ${getTenantId()}::uuid
           AND coalesce(s.on_hand, 0) <= r.min_quantity
           AND p.archived_at IS NULL AND v.archived_at IS NULL
         ORDER BY CASE WHEN r.min_quantity > 0 THEN coalesce(s.on_hand, 0) / r.min_quantity
                       ELSE sign(coalesce(s.on_hand, 0)) END,
                  lower(p.name), v.id, r.warehouse_id
         LIMIT ${DASHBOARD_LOW_STOCK_ITEMS}`,
    z.object({
      ...variantColumns,
      warehouse_id: z.uuid(),
      warehouse_name: z.string(),
      on_hand: z.string(),
      in_transit: z.string(),
      incoming: z.string(),
      min_quantity: z.string(),
      reorder_quantity: z.string().nullable(),
      count: z.number().int(),
    }),
  );
  return {
    count: found[0]?.count ?? 0,
    items: found.map((row) => ({
      ...variantOf(row),
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name,
      onHand: row.on_hand,
      inTransit: row.in_transit,
      incoming: row.incoming,
      minQuantity: row.min_quantity,
      reorderQuantity: row.reorder_quantity,
    })),
  };
}
```

**The helpers at the top:**

- **`rows()` parses what Postgres sends with a Zod schema,** the same helper as `select()` in `report-queries.ts`. A
  raw query's rows are `unknown` to TypeScript; a cast would hide a renamed column until a customer saw a blank card.
- **`inIds()` returns `false` for an empty list.** `account_id IN ()` is a syntax error in SQL. A workspace whose
  setup job has not made the chart yet has no sales account and no money accounts, and its dashboard must still answer
  (with zeros), not fail.
- **Each id is cast with `::uuid`,** so Postgres compares uuids and can use the day totals' key. Without the cast, the
  parameters would be text.
- **`inBranch()` adds nothing for "no branch"** (decision 11): no `AND branch_id IS NULL`, which would mean "the lines
  without a branch", a different question.

**`loadBooks()`: the accounts, read once:**

- **The whole chart in one query,** as `assertMoneyAccount()` does: `moneyAccountIds()` from the contract needs the tree
  (an account under a group that holds money is a money account too). It is a few hundred rows at most.
- **`Promise.all` with the settings:** the time zone (for today) and the Sales returns account (decision 10). Both
  queries run in the same transaction; postgres.js sends the second without waiting for the first answer.
- **`todayIn(settings?.timezone ?? 'Asia/Dhaka')`,** the same fallback as the invoices' `today()`: a new workspace's
  settings row always exists, so the fallback only keeps the types honest.
- **`new Set(...)` around the sales accounts:** a setting that named the Sales account itself would count every sale
  twice.
- **The Sales returns account is the one chosen now.** A return booked to another account before the setting was
  changed is no longer taken off the sales. That is the same as the profit and loss's sales line, which shows what is
  on each account.

**`soldByDay()`: the sales and the cost, one row per day:**

- **One query for both cards:** the sales accounts and the cost of goods sold account, with `FILTER` picking each
  column. The day totals' key starts with the account, then the day, so this is a few ranges in one index, whatever
  the size of the journal.
- **`credit − debit` for sales, `debit − credit` for the cost:** each in its natural sign. A sales return is a debit on
  sales (or on the returns account), so it lowers the day's sales by itself.
- **`NOT t.closing`** (decision 25): the year-end close debits Sales with the whole year's sales; with it, 30 June
  would show a huge loss of sales.
- **`soldFrom()` picks the earlier of two days:** the 1st of last month (for "the same days of last month") and the
  chart's first day. On 2 November it is 1 October; on 1 March it is 31 January, because the chart's 30 days reach
  further back than February.
- **The days come back as a `Map`,** and `sumDays()` adds the ones in a range. ISO dates compare correctly as strings,
  so no `Date` is made and no time zone can move a day.

**`salesCard()` and `marginCard()`:** pure functions over the map, so 21a.4 can test them without a database. Today and
yesterday are ranges of one day, so a day with no row is `"0.0000"` from `sumMoney([])`, not `undefined`.

**`cashCard()`:**

- **`t.day <= today`** (decision 30) and **`FILTER (WHERE t.day < today)`** for yesterday's end, in the same pass over
  the rows.
- **No branch:** the cash is the whole workspace's (decision 11). **No `closing` filter:** a closing entry moves income
  and expense into retained earnings and never touches a money account.
- **Accounts with no row get `"0.0000"`** (decision 31). The sort is by balance, then by code (`compareCodes`, the
  chart's own order), so two empty accounts always come out in the same order.
- **`yesterday` adds the rows that came back.** An account with no row had nothing yesterday either.

**`receivablesCard()` and `payablesCard()`:**

- **The total is the control account's balance** (decision 22), from the day totals, up to today. The natural sign
  differs: customers owe a debit, suppliers are owed a credit. `controlBalance()` takes the side, so the minus sign is
  in one place.
- **The overdue part is from the documents.** The `WHERE` repeats `isOpen` from `invoices.service.ts` word for word
  (`status = 'posted' AND amount_paid + amount_credited < total`): that is the predicate of the partial index
  `invoices_open_due_idx`, and Postgres uses a partial index only when the query says the same thing. The bills' query
  does the same with `bills_open_due_idx`.
- **`due_date < today`** is `isOverdue()`: on its due date an invoice is still on time.
- **`count(*)::int`:** Postgres's `count` is a `bigint`, which the driver sends as a string; the cast makes it the
  number the schema expects. A workspace will not have two billion overdue invoices.

**`topProducts()`:**

- **`UNION ALL` of the invoice lines and the POS sale lines** (decision 18), then one `GROUP BY`. `UNION` without `ALL`
  would drop two lines that happen to have the same variant, quantity and amount.
- **`i.status = 'posted'`:** a draft invoice is not a sale. A POS sale has no status: it is posted when it exists.
- **A POS sale's branch is its warehouse's** (decision 33): `pos_sales` has no `branch_id`, on purpose (step 20a).
- **`base_quantity` and `net`:** the quantity in the base unit, so a case and a piece of the same product add up, and
  the amount after both discounts and before VAT, like the sales.
- **`GROUP BY v.id, p.id, u.id`:** each is its table's primary key, so Postgres lets the query select the other
  columns of those tables without listing them all in the `GROUP BY`.
- **`ORDER BY sum(sold.net) DESC, v.id`:** the id breaks a tie, so two equal products never swap places between two
  visits.

**`lowStockCard()`:**

- **The same rules as `StockService.reorder()`** (decision 32): the same joins, the same `WHERE`, the same in-transit
  subquery, and `incomingTo()` and `quantityText()` imported from `stock.service.ts`, so the two lists cannot drift
  apart.
- **The order is the share of the level on hand** (decision 19): 40 strips against a level of 200 (0.2) comes before
  150 against 200 (0.75). Below zero (sold short at the POS) is a negative share and comes first. The `CASE` keeps a
  level of 0 from dividing by zero; `sign()` gives such a row −1 (below zero) or 0 (empty).
- **`count(*) OVER ()`** is a window over every row that matched, worked out before the `LIMIT`: the count and the first
  five in one query. With no row at all there is nothing to read the count from, hence `found[0]?.count ?? 0`.
- **`w.name` and the unit's `code` and `decimals`** go into each row (decision 19): the device shows the card offline,
  where it cannot look them up.

### `dashboard/dashboard.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type Dashboard,
  dashboardCardsFor,
  dashboardPeriods,
  type DashboardQuery,
} from '@omnivo/contracts';

import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import {
  cashCard,
  loadBooks,
  lowStockCard,
  marginCard,
  payablesCard,
  receivablesCard,
  salesCard,
  soldByDay,
  soldFrom,
  topProducts,
} from './dashboard-queries.js';

// The home page (step 21a): one answer with every card the person may see (decision 13). A card
// without its permission is null and its query never runs: what is not read cannot leak, here or
// from the copy the device keeps for offline.
@Injectable()
export class DashboardService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  async get(query: DashboardQuery): Promise<Dashboard> {
    const access = await this.permissions.ofCurrentUser();
    // The contract's list, the one the page draws from (decision 14)
    const cards = new Set(dashboardCardsFor(access.permissions));
    const branchId = query.branchId ?? null;
    return this.withTenant(async (tx) => {
      const books = await loadBooks(tx);
      const periods = dashboardPeriods(books.today);
      // The sales and the margin read the same rows: one query for both
      const needsSold = cards.has('sales') || cards.has('margin');
      // One transaction, so the queries run one after another on its connection; Promise.all
      // only sends them without waiting for each answer
      const [sold, cash, top, receivables, payables, lowStock] = await Promise.all([
        needsSold ? soldByDay(tx, books, soldFrom(periods), branchId) : null,
        cards.has('cash') ? cashCard(tx, books) : null,
        cards.has('topProducts') ? topProducts(tx, periods, branchId) : null,
        cards.has('receivables') ? receivablesCard(tx, books) : null,
        cards.has('payables') ? payablesCard(tx, books) : null,
        cards.has('lowStock') ? lowStockCard(tx) : null,
      ]);
      return {
        today: books.today,
        generatedAt: new Date().toISOString(),
        branchId,
        sales: sold !== null && cards.has('sales') ? salesCard(sold, periods) : null,
        margin: sold !== null && cards.has('margin') ? marginCard(sold, periods) : null,
        cash,
        topProducts: top,
        receivables,
        payables,
        lowStock,
      };
    });
  }
}
```

- **The permissions are read once, before the transaction:** `PermissionService.ofCurrentUser()` usually answers from
  its cache, and the transaction does not need to wait for it.
- **`dashboardCardsFor()` from the contract** decides which cards to fill (decision 14). The page calls the same
  function to decide which cards to draw, so the two can never disagree.
- **A card without its permission is `null` and its query does not run** (decision 29): the ternaries inside
  `Promise.all` give `null` without asking the database.
- **One `soldByDay()` for both the sales and the margin:** a person with both permissions costs one query, not two.
  `sold` is `null` only when neither card may be seen.
- **Everything in one `withTenant()` transaction:** row-level security applies to every query, and the queries share
  one connection.
- **`generatedAt` is the server's time when the answer was made,** not the workspace's: it is a moment, and the page
  writes it in the workspace's time zone.

### `dashboard/dashboard.controller.ts` and `dashboard/dashboard.module.ts` (new)

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DashboardService } from './dashboard.service.js';

type Routes = typeof routes.dashboard;

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Endpoint(routes.dashboard.get)
  get({ query }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.dashboard.get(query);
  }
}
```

- **`@Endpoint(routes.dashboard.get)`** takes the path, the method, the query schema and the answer schema from the
  contract. A wrong `branchId` (not a uuid) is a 400 before the service runs, and the `ContractInterceptor` parses the
  answer with `dashboardSchema`, so a chart with 29 days fails in the tests, not on the page.
- **`type Routes`, not `type Dashboard`:** the contract already exports a type named `Dashboard`.

```ts
import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

// The home page's numbers (step 21a). RbacModule gives PermissionService: each card checks its own
// permission. The queries read other modules' tables directly, like the reports, and change nothing.
@Module({
  imports: [RbacModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
```

- **It imports `RbacModule` for `PermissionService`,** like `InventoryModule`. `WITH_TENANT` comes from the global
  `InfraModule`.

### `app.module.ts`

```diff
@@ -14,6 +14,7 @@ import { AuthMiddleware } from './auth/auth.middleware.js';
 import { AuthModule } from './auth/auth.module.js';
 import { BranchesModule } from './branches/branches.module.js';
 import { CustomFieldsModule } from './custom-fields/custom-fields.module.js';
+import { DashboardModule } from './dashboard/dashboard.module.js';
 import { DocumentsModule } from './documents/documents.module.js';
 import { ContractInterceptor } from './common/http/contract.interceptor.js';
 import { ProblemFilter } from './common/http/problem.filter.js';
@@ -64,6 +65,7 @@ export class AppModule implements NestModule {
         AccountsModule,
         JournalModule,
         ReportsModule,
+        DashboardModule,
         CustomFieldsModule,
         ProductsModule,
         InventoryModule,
```

- **After `ReportsModule`:** the order of the list does not change what the app does; it only keeps the reports
  together.

### `inventory/stock.service.ts`: two helpers exported

```diff
@@ -42,7 +42,7 @@ import { WITH_TENANT } from '../infra/tokens.js';
 import { ValueAccess } from './value-access.js';
 
 // Postgres's NUMERIC as the API sends every quantity: 4 decimals, "0.0000" for nothing
-function quantityText(value: SQL): SQL<string> {
+export function quantityText(value: SQL): SQL<string> {
   return sql<string>`round(coalesce(${value}, 0), 4)::text`;
 }
 
@@ -888,8 +888,9 @@ export class StockService {
 // (p is its product) to a warehouse (or to any, for null), in the base unit. Each line counts
 // what is left of it, never below zero: a line that came over the order owes nothing, and it does
 // not cancel another line still waiting. l.product_id lets purchase_order_lines_variant_idx find
-// the lines; the order's status and warehouse are purchase_orders_open_idx's.
-function incomingTo(warehouse: SQL | null): SQL<string> {
+// the lines; the order's status and warehouse are purchase_orders_open_idx's. Step 21a: the
+// dashboard's low stock reads it too.
+export function incomingTo(warehouse: SQL | null): SQL<string> {
   return quantityText(sql`(SELECT sum(greatest(l.base_quantity - l.received_quantity, 0))
     FROM purchase_order_lines l
     JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
```

- **Only `export` and a comment.** `incomingTo()` refers to the aliases `v` (the variant) and `p` (its product), so the
  dashboard's low stock query uses the same aliases.

### `accounts/accounts.service.ts`: the day totals' foreign key

```diff
@@ -366,7 +366,8 @@ export class AccountsService {
       // Money receipts and refunds name it too (steps 15c, 15d), though each one's entry already does,
       // and so do a bill's lines and expenses and a supplier payment (step 17c), even as a draft,
       // and a supplier refund (step 17d), and a POS register's method and a POS sale's payment
-      // (step 20a), and a register's exchange account and a POS return's refund (step 20c)
+      // (step 20a), and a register's exchange account and a POS return's refund (step 20c), and
+      // the day totals (step 21a), which only exist where journal lines do
       if (
         isForeignKeyViolation(error, 'journal_lines_account_fk') ||
         isForeignKeyViolation(error, 'receipts_account_fk') ||
@@ -384,7 +385,8 @@ export class AccountsService {
         isForeignKeyViolation(error, 'pos_cash_reasons_account_fk') ||
         isForeignKeyViolation(error, 'pos_cash_movements_account_fk') ||
         isForeignKeyViolation(error, 'pos_registers_exchange_account_fk') ||
-        isForeignKeyViolation(error, 'pos_return_refunds_account_fk')
+        isForeignKeyViolation(error, 'pos_return_refunds_account_fk') ||
+        isForeignKeyViolation(error, 'account_day_totals_account_fk')
       ) {
         throw new AppError(409, 'account_in_use', 'Archive this account instead: entries use it.');
       }
```

- **The note from 21a.2:** deleting an account that has day totals is refused by `account_day_totals_account_fk` or by
  `journal_lines_account_fk`, whichever Postgres checks first. Both must give the same `account_in_use` error, not a
  500.

### `setup/templates.ts`: the report permissions in the role templates

```diff
@@ -175,6 +175,15 @@ const RUNNING_COUNTERS = ['pos.register.manage', 'pos.price.override', 'pos.shif
 // takes it off the Cashier role in Settings → Roles.
 const TAKING_BACK_AT_COUNTER = ['pos.return.create'] as const;
 
+// Step 21a. A module's reports go to the people who answer for it: the accountant reads them all (the
+// VAT report too, under accounting.report.read), and so does a manager who runs everything. The
+// people who keep the stock read the stock reports and the low stock; the people who buy read the
+// purchase reports (21b). Nobody who only sells gets the sales report: it is the whole company's
+// sales, not their own (no document has a salesperson yet), and a cashier sees no totals at all.
+const SALES_REPORTS = ['sales.report.read'] as const;
+const PURCHASE_REPORTS = ['purchase.report.read'] as const;
+const STOCK_REPORTS = ['inventory.report.read'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -208,6 +217,10 @@ const ACCOUNTANT: RoleTemplate = {
     // Step 17d: debit notes and the money suppliers pay back
     ...DEBITING,
     ...TAKING_REFUNDS,
+    // Step 21a: every module's reports
+    ...SALES_REPORTS,
+    ...PURCHASE_REPORTS,
+    ...STOCK_REPORTS,
   ],
 };
 
@@ -225,6 +238,7 @@ const STORE_KEEPER: RoleTemplate = {
     ...REQUESTING,
     ...RECEIVING,
     ...SENDING_BACK,
+    ...STOCK_REPORTS,
   ],
 };
 
@@ -454,6 +468,7 @@ export const INDUSTRY_TEMPLATES = {
           ...ORDERING,
           ...REQUESTING,
           ...BUYING,
+          ...PURCHASE_REPORTS,
         ],
       },
       STORE_KEEPER,
@@ -522,6 +537,7 @@ export const INDUSTRY_TEMPLATES = {
           ...REQUESTING,
           ...RECEIVING,
           ...SENDING_BACK,
+          ...STOCK_REPORTS,
         ],
       },
       {
@@ -598,6 +614,7 @@ export const INDUSTRY_TEMPLATES = {
           ...REQUESTING,
           ...RECEIVING,
           ...SENDING_BACK,
+          ...STOCK_REPORTS,
         ],
       },
       {
@@ -652,6 +669,8 @@ export const INDUSTRY_TEMPLATES = {
           ...STOCK_WORK,
           ...REQUESTING,
           ...BUYING,
+          ...PURCHASE_REPORTS,
+          ...STOCK_REPORTS,
         ],
       },
       STORE_KEEPER,
@@ -725,6 +744,9 @@ export const INDUSTRY_TEMPLATES = {
           ...SELLING_AT_COUNTER,
           ...RUNNING_COUNTERS,
           ...TAKING_BACK_AT_COUNTER,
+          ...SALES_REPORTS,
+          ...PURCHASE_REPORTS,
+          ...STOCK_REPORTS,
         ],
       },
       {
@@ -799,6 +821,9 @@ export const INDUSTRY_TEMPLATES = {
           ...PAYING,
           ...DEBITING,
           ...TAKING_REFUNDS,
+          ...SALES_REPORTS,
+          ...PURCHASE_REPORTS,
+          ...STOCK_REPORTS,
         ],
       },
     ],
```

- **Three constants, like every step's,** with the reasons in the comment above them (decision 34).
- **Only new workspaces get them.** The templates are read once, when a workspace is set up. Changing roles that
  exist is the owner's decision; this step does not do it behind their back.

### What I checked

> On throwaway Postgres and Valkey containers (testcontainers), with a smoke test that is not kept (21a.4 writes the real
> tests): on a new garments workspace, `GET /dashboard` answered every card with zeros, a 30-day chart and every money
> account at ৳0. After four entries (৳1,000 of sales today at the Gazipur factory, ৳500 yesterday with no branch, ৳300
> of cost today, and ৳99 of sales dated tomorrow) it answered ৳1,000 today, ৳500 yesterday, cash ৳1,200 (৳500 at the
> end of yesterday), and a cost of ৳300 for the margin; tomorrow's entry was not counted. With the factory picked, today
> stayed ৳1,000 and yesterday was ৳0, and the cash stayed ৳1,200. A branch that does not exist gave zeros; a `branchId`
> that is not a uuid gave 400. A member with no role got every card as `null`.
>
> On Postgres 17: `count(*) OVER ()::int` is an `integer` and counts every row before the `LIMIT`.
>
> API type check, ESLint and Prettier pass on every changed file; the API's unit tests pass (123). The accounts suites
> and the setup suite pass (28 tests) except one setup test, as expected: it lists every role's permissions, and 21a.4
> adds the new ones to it.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/dashboard apps/api/src/setup apps/api/src/accounts apps/api/src/inventory
```

The page comes in 21a.6. Until then, with `pnpm dev` running, the API docs page (`/docs` on the API) can send
`GET /dashboard` with your access token: as the owner, every card has numbers from your own books. The roles of your
workspace do not have the new permissions yet; give them in Settings → Roles once 21a.5 has their words.
`setup.int.spec.ts` fails until 21a.4.

## 21a.4 — `apps/api`: the tests

Three new test files and one old one:

- `dashboard/dashboard-queries.spec.ts` (new): unit tests for the parts of the queries that are plain TypeScript (the
  first day to read, and the sums over the periods).
- `dashboard/dashboard.int.spec.ts` (new): a retail shop's dashboard, from empty to a day of real documents, the
  branch filter, the low stock order and what each permission shows.
- `dashboard/dashboard.tenant-leak.int.spec.ts` (new): one shop's dashboard never shows another shop's numbers.
- `setup/setup.int.spec.ts`: the role templates now have the report permissions (21a.3).

The tests found no problem in the 21a.3 code; the code above is what they ran against.

### `setup/setup.int.spec.ts`: the new permissions in the role lists

```diff
@@ -140,12 +140,14 @@ describe('starting the setup', () => {
           'accounting.report.read',
           'core.audit.read',
           'core.user.read',
+          'inventory.report.read',
           'inventory.stock.revalue',
           'inventory.stock.value',
           'purchase.bill.manage',
           'purchase.debit_note.manage',
           'purchase.payment.manage',
           'purchase.refund.manage',
+          'purchase.report.read',
           'purchase.supplier.balance',
           'purchase.supplier.manage',
           'sales.credit_note.manage',
@@ -155,6 +157,7 @@ describe('starting the setup', () => {
           'sales.price_list.manage',
           'sales.receipt.manage',
           'sales.refund.manage',
+          'sales.report.read',
         ],
       ],
       [
@@ -163,6 +166,7 @@ describe('starting the setup', () => {
           'core.user.read',
           'inventory.product.manage',
           'purchase.order.manage',
+          'purchase.report.read',
           'purchase.requisition.manage',
           'sales.customer.manage',
           'sales.order.manage',
@@ -173,6 +177,7 @@ describe('starting the setup', () => {
         'Store keeper',
         [
           'inventory.product.manage',
+          'inventory.report.read',
           'inventory.stock.adjust',
           'inventory.stock.transfer',
           'purchase.receipt.manage',
```

- **The test lists every permission of every garments role, exactly.** That is on purpose: a permission added to a
  template without a reason should fail a test, so someone reads the template again. Here the reason is decision 34:
  the Accountant gets all three report permissions, the Merchandiser the purchase reports (it buys), the Store keeper
  the stock reports. The lists are sorted, so each key goes in its alphabetical place.

### `dashboard/dashboard-queries.spec.ts` (new)

```ts
import { DASHBOARD_TREND_DAYS, dashboardPeriods } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { type DaySold, marginCard, salesCard, soldFrom } from './dashboard-queries.js';

// The rows soldByDay() reads, as a map by day: what the cards add up. No database here: the sums
// over the days are plain TypeScript, so every edge of the periods is cheap to try.
function days(entries: Record<string, [sales: string, cost: string]>): Map<string, DaySold> {
  return new Map(Object.entries(entries).map(([day, [sales, cost]]) => [day, { sales, cost }]));
}

describe('soldFrom', () => {
  it('is the 1st of last month when the chart starts later', () => {
    expect(soldFrom(dashboardPeriods('2026-11-02'))).toBe('2026-10-01');
  });

  it("is the chart's first day when that is earlier: 1 March starts on 31 January", () => {
    expect(soldFrom(dashboardPeriods('2027-03-01'))).toBe('2027-01-31');
  });
});

describe('salesCard', () => {
  const periods = dashboardPeriods('2026-11-02');
  const sold = days({
    '2026-11-02': ['1500.0000', '900.0000'],
    '2026-11-01': ['800.0000', '500.0000'],
    // A day of returns only: below zero, and it still counts
    '2026-10-31': ['-200.0000', '-120.0000'],
    '2026-10-02': ['300.0000', '180.0000'],
    // Last month, but after the 2nd: not in "the same days of last month"
    '2026-10-03': ['4000.0000', '2400.0000'],
    '2026-10-01': ['700.0000', '420.0000'],
  });

  it('adds up today, yesterday, this month so far and the same days of last month', () => {
    const card = salesCard(sold, periods);
    expect(card).toMatchObject({
      today: '1500.0000',
      yesterday: '800.0000',
      monthToDate: '2300.0000',
      lastMonthToDate: '1000.0000',
    });
  });

  it('has a point for every day of the chart, with zero on a day nothing was sold', () => {
    const chart = salesCard(sold, periods).days;
    expect(chart).toHaveLength(DASHBOARD_TREND_DAYS);
    expect(chart[0]).toEqual({ date: '2026-10-04', amount: '0.0000' });
    expect(chart.at(-1)).toEqual({ date: '2026-11-02', amount: '1500.0000' });
    expect(chart.find((day) => day.date === '2026-10-31')?.amount).toBe('-200.0000');
    // 1–3 October are before the chart's first day: in the month's sums, not on the chart
    expect(chart.map((day) => day.date)).not.toContain('2026-10-03');
  });

  it('is zeros with no rows at all', () => {
    const card = salesCard(new Map(), periods);
    expect(card).toMatchObject({
      today: '0.0000',
      yesterday: '0.0000',
      monthToDate: '0.0000',
      lastMonthToDate: '0.0000',
    });
    expect(card.days.every((day) => day.amount === '0.0000')).toBe(true);
  });

  it('compares the 31st with the whole of last month, never a day of this month', () => {
    const march = dashboardPeriods('2027-03-31');
    const card = salesCard(
      days({
        '2027-02-28': ['600.0000', '0.0000'],
        '2027-02-01': ['400.0000', '0.0000'],
        '2027-03-01': ['900.0000', '0.0000'],
      }),
      march,
    );
    expect(card.lastMonthToDate).toBe('1000.0000');
    expect(card.monthToDate).toBe('900.0000');
  });
});

describe('marginCard', () => {
  it('pairs the sales with the cost of the same days', () => {
    const card = marginCard(
      days({
        '2026-11-02': ['1500.0000', '900.0000'],
        '2026-11-01': ['800.0000', '500.0000'],
        '2026-10-02': ['300.0000', '180.0000'],
        '2026-10-03': ['4000.0000', '2400.0000'],
      }),
      dashboardPeriods('2026-11-02'),
    );
    expect(card).toEqual({
      monthToDate: { sales: '2300.0000', cost: '1400.0000' },
      lastMonthToDate: { sales: '300.0000', cost: '180.0000' },
    });
  });
});
```

- **No database.** `salesCard()`, `marginCard()` and `soldFrom()` take the rows `soldByDay()` already read, so the
  edges of the periods can be tried in a millisecond each, on dates the integration test cannot choose (it runs on
  whatever day it is).
- **`days()` builds the map from a small table** of `[sales, cost]` per day. It is the same shape `soldByDay()` returns,
  so the tests feed the functions exactly what the service does.
- **`soldFrom()` on 2 November is 1 October** (last month's 1st is earlier than the chart's 4 October), and **on 1 March
  2027 it is 31 January**: the chart's 30 days reach further back than the 1st of February. If `soldFrom()` always
  returned the 1st of last month, the first point of the chart on 1 March would be missing from the query and would
  show ৳0.
- **The sums.** The rows on 2 November cover today, yesterday (1 November), a day of returns only (31 October, below
  zero), and three days of October. "The same days of last month" is 1–2 October, so 3 October is left out of it; that
  row is there to catch an end date that is one day too late.
- **The chart has a point for every day,** the oldest first, with `0.0000` where nothing was sold, and the day below
  zero keeps its minus. 1–3 October are in the month's sums but before the chart's first day (4 October).
- **No rows at all is zeros,** not an error: a new workspace's dashboard.
- **31 March against February:** `lastMonthEnd` is 28 February, so the whole of February is compared, and 1 March (this
  month) is never in last month's sum.
- **The margin** pairs each period's sales with the cost of the same days, from the same rows.

### `dashboard/dashboard.int.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  billSchema,
  type Branch,
  branchSchema,
  type Customer,
  customerSchema,
  type Dashboard,
  dashboardPeriods,
  dashboardSchema,
  type Device,
  deviceSchema,
  invoiceSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  negateMoney,
  type PermissionKey,
  type PosCashReason,
  posCashReasonSchema,
  type PosRegister,
  posRegisterSchema,
  posSaleSchema,
  type Product,
  productSchema,
  receiptSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  subtractMoney,
  sumMoney,
  type Supplier,
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

// Step 21a. Nabil Super Shop: a grocery in Mirpur (the main branch) and a second shop in Uttara.
// Nusrat (the owner) sees every card; Shirin reads the sales report only; Jamal keeps the stock and
// reads the cash; Rafiq has no role. The tests run in order: an empty dashboard, then the books by
// hand (journal entries), then real documents (invoices, a POS sale, bills, a receipt), the reorder
// levels, and last what each person may see.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
// The superuser: a closing row of the day totals, which no route writes on a date this close
let sql: postgres.Sql;
let owner: SignedIn;
let shirin: SignedIn;
let jamal: SignedIn;
let rafiq: SignedIn;
let today: string;
let main: Warehouse;
let uttara: Branch;
let uttaraStore: Warehouse;
let accounts: Account[];
let vat: TaxRate;
let exempt: TaxRate;
let pcs: string;
let rice: Product;
let oil: Product;
let sugar: Product;
let lentils: Product;
let tea: Product;
let salt: Product;
let soap: Product;
let matches: Product;
let karim: Customer;
let rahim: Customer;
let landlord: Supplier;
let floatIn: PosCashReason;
let counterPc: Device;

type SaleCommand = Extract<SyncCommandInput, { type: 'pos_sale.create' }>;
type SaleLine = SaleCommand['input']['lines'][number];
type OpenCommand = Extract<SyncCommandInput, { type: 'pos_shift.open' }>;

// What the books were told was sold, by day and branch: the sales the cards must add up. Every
// test that posts a sale adds it here, so the expected numbers hold on any day the test runs (on
// the 1st, yesterday is last month's).
const booked: { date: string; branchId: string | null; amount: string }[] = [];

// A UUIDv7 as a device makes it. Only the version digit matters to the server's checks.
function v7(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

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

async function dashboard(query = '', as = owner): Promise<Dashboard> {
  const res = await send('GET', `/dashboard${query}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return dashboardSchema.parse(res.json());
}

// A card that must be there: the owner holds every permission
function card<T>(value: T | null): T {
  if (value === null) throw new Error('the card is missing');
  return value;
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

async function addProduct(name: string, salePrice: string): Promise<Product> {
  return created(productSchema, '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [{ id: null, sku: '', optionValues: [], barcode: '', salePrice, archived: false }],
    units: [],
    customFields: {},
  });
}

async function addCustomer(name: string): Promise<Customer> {
  return created(customerSchema, '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'bn',
    bin: '',
    paymentTermsDays: 0,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
  });
}

function inLine(product: Product, quantity: string, unitCost: string) {
  return {
    variantId: variantOf(product),
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

// A journal line by account code, on a branch or on none
function line(code: string, debit: string, credit: string, branchId: string | null) {
  return { accountId: accountId(code), branchId, description: '', debit, credit };
}

async function entry(date: string, lines: object[]): Promise<void> {
  const res = await send('POST', '/journal-entries', {
    date,
    narration: 'Dashboard test',
    lines,
    post: true,
  });
  expect(res.statusCode, res.body).toBe(201);
  journalEntrySchema.parse(res.json());
}

// A sale by hand: cash in, the sales account credited
async function cashSale(date: string, amount: string, branchId: string | null): Promise<void> {
  await entry(date, [line('1110', amount, '', branchId), line('4110', '', amount, branchId)]);
  booked.push({ date, branchId, amount });
}

// What the sales card must say from `booked`: one branch's, or (undefined) the whole workspace's
function expectedSales(branchId?: string) {
  const periods = dashboardPeriods(today);
  const sum = (from: string, to: string) =>
    sumMoney(
      booked
        .filter((sold) => branchId === undefined || sold.branchId === branchId)
        .filter((sold) => sold.date >= from && sold.date <= to)
        .map((sold) => sold.amount),
    );
  return {
    today: sum(periods.today, periods.today),
    yesterday: sum(periods.yesterday, periods.yesterday),
    monthToDate: sum(periods.monthStart, periods.today),
    lastMonthToDate: sum(periods.lastMonthStart, periods.lastMonthEnd),
  };
}

// What an account moved by over the days, debit − credit, from its ledger: the journal's own
// lines, not the day totals the dashboard reads
async function movement(code: string, from: string, to: string): Promise<string> {
  const res = await send('GET', `/accounts/${accountId(code)}/ledger?from=${from}&to=${to}`);
  expect(res.statusCode, res.body).toBe(200);
  const ledger = ledgerPageSchema.parse(res.json());
  return subtractMoney(ledger.closingBalance, ledger.openingBalance);
}

// The sales of the books over the days: the credit of Sales less the debit of Sales returns
async function booksSales(from: string, to: string): Promise<string> {
  const moved = await Promise.all([movement('4110', from, to), movement('4130', from, to)]);
  return negateMoney(sumMoney(moved));
}

function invoiceLine(product: Product, quantity: string, unitPrice: string) {
  return {
    variantId: variantOf(product),
    unitId: pcs,
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: vat.id,
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
  };
}

// A direct invoice: the goods leave the warehouse with it, so it posts the sale and its cost
function invoiceForm(
  customer: Customer,
  warehouse: Warehouse,
  date: string,
  lines: object[],
  extra: object = {},
) {
  return {
    customerId: customer.id,
    date,
    dueDate: '',
    customerReference: '',
    branchId: warehouse.branchId,
    warehouseId: warehouse.id,
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

// A bill with one expense and no goods, posted when submitted (no approval level is set)
function billForm(
  date: string,
  dueDate: string,
  number: string,
  expense: { code: string; description: string; amount: string },
) {
  return {
    supplierId: landlord.id,
    date,
    dueDate,
    supplierBillNumber: number,
    mushakNumber: '',
    mushakDate: '',
    branchId: main.branchId,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: accountId(expense.code),
        description: expense.description,
        amount: expense.amount,
        taxRateId: exempt.id,
      },
    ],
    submit: true,
  };
}

async function reorderLevel(warehouse: Warehouse, product: Product, minQuantity: string) {
  const res = await send('PUT', '/stock/reorder-levels', {
    warehouseId: warehouse.id,
    variantId: variantOf(product),
    minQuantity,
    reorderQuantity: '',
  });
  expect(res.statusCode, res.body).toBe(200);
}

// A member of the shop with one role of exactly these permissions; [] = no role at all
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'nabil-super-shop' });
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
    workspace: 'nabil-super-shop',
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
    companyName: 'Nabil Super Shop',
    workspaceSlug: 'nabil-super-shop',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nabilshop.com',
    password: 'Mirpur-grocery-2026',
  });
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  today = todayIn(settingsSchema.parse((await send('GET', '/settings')).json()).timezone);

  const [found] = warehouseListSchema
    .parse((await send('GET', '/warehouses')).json())
    .items.filter((warehouse) => warehouse.code === 'MAIN');
  if (!found) throw new Error('no MAIN warehouse');
  main = found;
  uttara = await created(branchSchema, '/branches', {
    code: 'UTT',
    name: 'Uttara shop',
    phone: '',
    address: 'Sector 7, Uttara',
  });
  uttaraStore = await created(warehouseSchema, '/warehouses', {
    branchId: uttara.id,
    code: 'UTT1',
    name: 'Uttara store',
    address: '',
  });

  // A bank account under the bank group, and a Sales returns account: the retail chart has
  // neither (its 4120 is "Service income")
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  await created(accountSchema, '/accounts', {
    parentId: accountId('1120'),
    code: '1121',
    name: 'Dutch-Bangla Bank CD A/C',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
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
  rice = await addProduct('Miniket rice 5 kg', '450');
  oil = await addProduct('Soybean oil 1 L', '190');
  sugar = await addProduct('Sugar 1 kg', '140');
  lentils = await addProduct('Masur dal 1 kg', '130');
  tea = await addProduct('Tea 400 g', '220');
  salt = await addProduct('Salt 1 kg', '42');
  soap = await addProduct('Toilet soap 100 g', '60');
  // Never stocked
  matches = await addProduct('Matchbox', '5');
  for (const [warehouse, lines] of [
    [
      main,
      [
        inLine(rice, '40', '380'),
        inLine(oil, '60', '160'),
        inLine(sugar, '30', '120'),
        inLine(lentils, '30', '105'),
        inLine(tea, '20', '180'),
        inLine(salt, '60', '35'),
        inLine(soap, '2', '45'),
      ],
    ],
    [uttaraStore, [inLine(rice, '10', '380')]],
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
  karim = await addCustomer('Karim Store');
  rahim = await addCustomer('Rahim Traders');
  landlord = await created(supplierSchema, '/suppliers', {
    code: '',
    name: 'Mirpur Properties Ltd.',
    groupId: '',
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
  floatIn = await created(posCashReasonSchema, '/pos/cash-reasons', {
    name: 'Float from the owner',
    direction: 'in',
    accountId: accountId('3100'),
  });
  const device = await send(
    'POST',
    '/sync/devices',
    { id: v7(), name: 'Front counter PC', branchId: main.branchId },
    owner,
  );
  expect(device.statusCode, device.body).toBe(201);
  counterPc = deviceSchema.parse(device.json());

  shirin = await memberWith(
    { fullName: 'Shirin Akter', email: 'shirin@nabilshop.com', password: 'Sales-report-2026' },
    ['sales.report.read'],
  );
  jamal = await memberWith(
    { fullName: 'Jamal Uddin', email: 'jamal@nabilshop.com', password: 'Store-keeper-2026' },
    ['inventory.report.read', 'inventory.stock.value', 'accounting.report.read'],
  );
  rafiq = await memberWith(
    { fullName: 'Rafiq Islam', email: 'rafiq@nabilshop.com', password: 'No-role-yet-2026' },
    [],
  );
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('A new shop', () => {
  it('has a dashboard of zeros, with a point for every day and every money account', async () => {
    // The opening stock is posted, but it is no sale and no money
    const answer = await dashboard();
    expect(answer.today).toBe(today);
    expect(answer.branchId).toBeNull();
    const sales = card(answer.sales);
    expect(sales).toMatchObject({
      today: '0.0000',
      yesterday: '0.0000',
      monthToDate: '0.0000',
      lastMonthToDate: '0.0000',
    });
    expect(sales.days.map((point) => point.date)).toEqual(
      Array.from({ length: 30 }, (_, index) => day(index - 29)),
    );
    expect(sales.days.every((point) => point.amount === '0.0000')).toBe(true);
    expect(answer.margin).toEqual({
      monthToDate: { sales: '0.0000', cost: '0.0000' },
      lastMonthToDate: { sales: '0.0000', cost: '0.0000' },
    });
    // Every account money is kept in, at zero, even with no entry yet
    expect(answer.cash).toEqual({
      accounts: [
        { accountId: accountId('1110'), code: '1110', name: 'Cash in hand', balance: '0.0000' },
        {
          accountId: accountId('1121'),
          code: '1121',
          name: 'Dutch-Bangla Bank CD A/C',
          balance: '0.0000',
        },
      ],
      total: '0.0000',
      yesterday: '0.0000',
    });
    expect(answer.topProducts).toEqual([]);
    const nothingDue = { total: '0.0000', overdue: '0.0000', overdueCount: 0 };
    expect(answer.receivables).toEqual(nothingDue);
    expect(answer.payables).toEqual(nothingDue);
    expect(answer.lowStock).toEqual({ count: 0, items: [] });
  });
});

describe('The books by hand', () => {
  beforeAll(async () => {
    // The owner's capital, long ago, and a bank deposit yesterday
    await entry(day(-40), [line('1110', '10000', '', null), line('3100', '', '10000', null)]);
    await entry(day(-1), [
      line('1121', '6000', '', main.branchId),
      line('1110', '', '6000', main.branchId),
    ]);
    await cashSale(today, '1000', main.branchId);
    await cashSale(day(-1), '800', main.branchId);
    await cashSale(today, '300', uttara.id);
    // A line with no branch counts for the whole shop, and for no branch
    await cashSale(today, '100', null);
    await cashSale(dashboardPeriods(today).lastMonthStart, '700', main.branchId);
    // Money given back for a return: the Sales returns account lowers the sales
    await entry(today, [
      line('4130', '200', '', main.branchId),
      line('1110', '', '200', main.branchId),
    ]);
    booked.push({ date: today, branchId: main.branchId, amount: '-200' });
    // Service income is income, but not the shop's sales
    await entry(today, [
      line('1110', '500', '', main.branchId),
      line('4120', '', '500', main.branchId),
    ]);
    // A cheque dated tomorrow: not a sale yet, and not money in the bank yet
    await entry(day(1), [
      line('1121', '9999', '', main.branchId),
      line('4110', '', '9999', main.branchId),
    ]);
  });

  it('adds up the sales accounts by day, less the returns, and nothing else', async () => {
    const sales = card((await dashboard()).sales);
    expect(sales).toMatchObject(expectedSales());
    // On 4 November: 1,000 + 300 + 100 − 200 today, 800 yesterday
    expect(sales.today).toBe('1200.0000');
    expect(sales.days.at(-1)).toEqual({ date: today, amount: '1200.0000' });
    expect(sales.days.at(-2)).toEqual({ date: day(-1), amount: '800.0000' });
    // The same days as the books: the ledgers of Sales and Sales returns
    const periods = dashboardPeriods(today);
    expect(sales.monthToDate).toBe(await booksSales(periods.monthStart, today));
    expect(sales.lastMonthToDate).toBe(
      await booksSales(periods.lastMonthStart, periods.lastMonthEnd),
    );
  });

  it('filters the sales by branch; a line with no branch is in no branch', async () => {
    const mirpur = card((await dashboard(`?branchId=${main.branchId}`)).sales);
    expect(mirpur).toMatchObject(expectedSales(main.branchId));
    expect(mirpur.today).toBe('800.0000');
    const uttaraShop = await dashboard(`?branchId=${uttara.id}`);
    expect(uttaraShop.branchId).toBe(uttara.id);
    expect(card(uttaraShop.sales)).toMatchObject(expectedSales(uttara.id));
    expect(card(uttaraShop.sales).today).toBe('300.0000');
  });

  it('leaves out a year-end closing row, even one dated today', async () => {
    // A year close posts on the year's last day (30 June), which the dashboard reads only on a few
    // days of the year. The row is written by hand on today, as the trigger would write one.
    await sql`INSERT INTO account_day_totals
                (tenant_id, day, account_id, branch_id, closing, debit, credit)
              SELECT tenant_id, ${today}::date, id, ${main.branchId}::uuid, true, 5000, 0
                FROM ledger_accounts WHERE id = ${accountId('4110')}::uuid`;
    expect(card((await dashboard()).sales).today).toBe('1200.0000');
  });

  it('shows the margin with the sales of the same days', async () => {
    const margin = card((await dashboard()).margin);
    expect(margin.monthToDate).toEqual({ sales: expectedSales().monthToDate, cost: '0.0000' });
    expect(margin.lastMonthToDate).toEqual({
      sales: expectedSales().lastMonthToDate,
      cost: '0.0000',
    });
  });

  it('shows every money account up to today, the largest first, and yesterday’s total', async () => {
    // Cash: 10,000 − 6,000 + 1,000 + 800 + 300 + 100 + 700 − 200 + 500. The bank: the deposit,
    // not tomorrow's cheque.
    const cash = card((await dashboard()).cash);
    expect(cash.accounts.map((account) => [account.code, account.balance])).toEqual([
      ['1110', '7200.0000'],
      ['1121', '6000.0000'],
    ]);
    expect(cash.total).toBe('13200.0000');
    // Up to the end of yesterday: what came in today is the difference
    expect(cash.yesterday).toBe('11500.0000');
    // The branch filter never moves the cash: a bank account is the whole shop's
    expect((await dashboard(`?branchId=${uttara.id}`)).cash).toEqual(cash);
  });
});

describe('Real documents', () => {
  let shift: string;
  let register: PosRegister;
  let overdueInvoice: string;

  beforeAll(async () => {
    // Karim Store buys six things today, due today (terms 0): not overdue yet
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, main, today, [
        invoiceLine(rice, '4', '450'),
        invoiceLine(oil, '5', '190'),
        invoiceLine(sugar, '5', '140'),
        invoiceLine(lentils, '4', '130'),
        invoiceLine(tea, '2', '220'),
        invoiceLine(salt, '5', '42'),
      ]),
    );
    booked.push({ date: today, branchId: main.branchId, amount: '4620' });
    // Rahim Traders buys at the Uttara shop 10 days ago, due yesterday
    overdueInvoice = (
      await created(
        invoiceSchema,
        '/invoices',
        invoiceForm(rahim, uttaraStore, day(-10), [invoiceLine(rice, '2', '450')], {
          dueDate: day(-1),
        }),
      )
    ).id;
    booked.push({ date: day(-10), branchId: uttara.id, amount: '900' });
    // A day before the chart's 30 days: in the books, not in the top products
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, main, day(-30), [invoiceLine(salt, '20', '42')]),
    );
    booked.push({ date: day(-30), branchId: main.branchId, amount: '840' });
    // A draft is not a sale: 50 salts would top the list
    await created(
      invoiceSchema,
      '/invoices',
      invoiceForm(karim, main, today, [invoiceLine(salt, '50', '42')], { post: false }),
    );
    // Rahim pays ৳400 of what is due
    await created(receiptSchema, '/receipts', {
      customerId: rahim.id,
      date: today,
      amount: '400',
      accountId: accountId('1110'),
      method: 'cash',
      reference: '',
      branchId: main.branchId,
      note: '',
      allocations: [{ invoiceId: overdueInvoice, amount: '400' }],
    });

    // The front counter: a register, the device takes it, a shift opens, and a sale of a tea and
    // three soaps (two in stock: one is sold short)
    register = await created(posRegisterSchema, '/pos/registers', {
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
    shift = v7();
    const open: OpenCommand = {
      id: v7(),
      type: 'pos_shift.open',
      shiftId: shift,
      input: {
        registerId: register.id,
        sequence: 1,
        date: today,
        openedAt: new Date().toISOString(),
        opening: { notes: null, total: '1000' },
        floatReasonId: floatIn.id,
      },
    };
    const posLine = (product: Product, quantity: string, price: string): SaleLine => ({
      variantId: variantOf(product),
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
        shiftId: shift,
        date: today,
        soldAt: new Date(Date.now() + 1000).toISOString(),
        customerId: '',
        pricesIncludeVat: false,
        lines: [posLine(tea, '1', '220'), posLine(soap, '3', '60')],
        billDiscountType: 'amount',
        billDiscount: '0',
        // ৳400 and 15% VAT
        payments: [{ method: 'cash', amount: '460', reference: '' }],
      },
    };
    const pushed = await send('POST', '/sync/push', {
      deviceId: counterPc.id,
      protocol: SYNC_PROTOCOL,
      commands: [open, sale],
    });
    expect(pushed.statusCode, pushed.body).toBe(200);
    const results = syncPushSchema.parse(pushed.json()).results;
    expect(
      results.map((result) => result.status),
      JSON.stringify(results),
    ).toEqual(['accepted', 'accepted']);
    const saved = posSaleSchema.parse((await send('GET', `/pos/sales/${sale.saleId}`)).json());
    expect(saved.total).toBe('460.0000');
    booked.push({ date: today, branchId: main.branchId, amount: '400' });

    // The rent, overdue, and the electricity, due next month
    await created(
      billSchema,
      '/bills',
      billForm(day(-20), day(-5), 'MP/2026/0091', {
        code: '5220',
        description: 'Shop rent, Mirpur',
        amount: '12000',
      }),
    );
    await created(
      billSchema,
      '/bills',
      billForm(today, day(25), 'DESCO-88231', {
        code: '5230',
        description: 'Electricity',
        amount: '3000',
      }),
    );
  });

  it('counts invoices and POS sales in the sales, as the books do', async () => {
    const periods = dashboardPeriods(today);
    const answer = await dashboard();
    const sales = card(answer.sales);
    expect(sales).toMatchObject(expectedSales());
    expect(sales.monthToDate).toBe(await booksSales(periods.monthStart, today));
    // The cost is the cost of goods sold account's, sold short included
    const margin = card(answer.margin);
    expect(margin.monthToDate).toEqual({
      sales: sales.monthToDate,
      cost: await movement('5110', periods.monthStart, today),
    });
    expect(margin.lastMonthToDate.cost).toBe(
      await movement('5110', periods.lastMonthStart, periods.lastMonthEnd),
    );
    // Today's documents had a cost: the margin is no longer the whole sales
    expect(margin.monthToDate.cost).not.toBe('0.0000');
  });

  it('lists the five products that sold most, invoices and POS together', async () => {
    const top = card((await dashboard()).topProducts);
    expect(
      top.map((item) => [item.productName, item.quantity, item.amount, item.baseUnit.code]),
    ).toEqual([
      // 4 + 2 at Uttara
      ['Miniket rice 5 kg', '6.0000', '2700.0000', 'pcs'],
      ['Soybean oil 1 L', '5.0000', '950.0000', 'pcs'],
      ['Sugar 1 kg', '5.0000', '700.0000', 'pcs'],
      // 2 on the invoice and 1 at the counter: above the lentils only with the POS sale
      ['Tea 400 g', '3.0000', '660.0000', 'pcs'],
      ['Masur dal 1 kg', '4.0000', '520.0000', 'pcs'],
    ]);
    expect(top[0]).toMatchObject({
      variantId: variantOf(rice),
      productId: rice.id,
      sku: rice.variants[0]?.sku,
    });
  });

  it("filters the top products by branch: a POS sale is its warehouse's branch", async () => {
    const uttaraTop = card((await dashboard(`?branchId=${uttara.id}`)).topProducts);
    expect(uttaraTop.map((item) => [item.productName, item.amount])).toEqual([
      ['Miniket rice 5 kg', '900.0000'],
    ]);
    const mirpurTop = card((await dashboard(`?branchId=${main.branchId}`)).topProducts);
    expect(mirpurTop.map((item) => [item.productName, item.amount])).toEqual([
      ['Miniket rice 5 kg', '1800.0000'],
      ['Soybean oil 1 L', '950.0000'],
      ['Sugar 1 kg', '700.0000'],
      ['Tea 400 g', '660.0000'],
      ['Masur dal 1 kg', '520.0000'],
    ]);
  });

  it('shows what customers owe and what is overdue, after what they paid', async () => {
    // Owed: 5,313 (today, due today) + 1,035 (due yesterday) + 966 (30 days ago) − 400 paid
    expect((await dashboard()).receivables).toEqual({
      total: '6914.0000',
      overdue: '1601.0000',
      overdueCount: 2,
    });
  });

  it('shows what is owed to suppliers and what is overdue', async () => {
    expect((await dashboard()).payables).toEqual({
      total: '15000.0000',
      overdue: '12000.0000',
      overdueCount: 1,
    });
    // Dues are the whole shop's, whatever the branch
    expect((await dashboard(`?branchId=${uttara.id}`)).payables?.total).toBe('15000.0000');
  });
});

describe('Low stock', () => {
  beforeAll(async () => {
    // On hand now at the main store: rice 36, oil 55, sugar 25, dal 26, tea 17, salt 35, soap −1,
    // matches 0; at Uttara rice 8
    await reorderLevel(main, rice, '40');
    await reorderLevel(main, oil, '50');
    await reorderLevel(main, sugar, '50');
    await reorderLevel(main, lentils, '100');
    await reorderLevel(main, tea, '20');
    await reorderLevel(main, salt, '0');
    await reorderLevel(main, soap, '0');
    await reorderLevel(main, matches, '0');
    await reorderLevel(uttaraStore, rice, '10');
  });

  it('counts every item at or below its level and lists the five emptiest', async () => {
    const low = card((await dashboard()).lowStock);
    // Oil is above its level, and salt above a level of 0
    expect(low.count).toBe(7);
    expect(
      low.items.map((item) => [
        item.productName,
        item.warehouseName,
        item.onHand,
        item.minQuantity,
      ]),
    ).toEqual([
      // Below zero first, then empty (the names alone would put Matchbox first), then the
      // smallest share of the level
      ['Toilet soap 100 g', main.name, '-1.0000', '0.0000'],
      ['Matchbox', main.name, '0.0000', '0.0000'],
      ['Masur dal 1 kg', main.name, '26.0000', '100.0000'],
      ['Sugar 1 kg', main.name, '25.0000', '50.0000'],
      ['Miniket rice 5 kg', uttaraStore.name, '8.0000', '10.0000'],
    ]);
    expect(low.items[0]).toMatchObject({
      warehouseId: main.id,
      inTransit: '0.0000',
      incoming: '0.0000',
      reorderQuantity: null,
      baseUnit: { code: 'pcs', decimals: 0 },
    });
  });
});

describe('What each person sees', () => {
  it('is only the cards their permissions allow', async () => {
    const all = await dashboard();
    // The sales report alone: the sales and the top products, no margin without the stock value
    const sales = await dashboard('', shirin);
    expect(sales.sales).toEqual(all.sales);
    expect(sales.topProducts).toEqual(all.topProducts);
    expect([sales.margin, sales.cash, sales.receivables, sales.payables, sales.lowStock]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    // The stock value without the sales report is no margin either
    const store = await dashboard('', jamal);
    expect(store.cash).toEqual(all.cash);
    expect(store.lowStock).toEqual(all.lowStock);
    expect([
      store.sales,
      store.margin,
      store.topProducts,
      store.receivables,
      store.payables,
    ]).toEqual([null, null, null, null, null]);
  });

  it('is a page with no cards for a member with no role', async () => {
    const none = await dashboard('', rafiq);
    expect(none).toMatchObject({
      today,
      sales: null,
      margin: null,
      cash: null,
      topProducts: null,
      receivables: null,
      payables: null,
      lowStock: null,
    });
  });
});

describe('The branch in the query', () => {
  it('must be an id; an unknown one is a branch that sold nothing', async () => {
    expect((await send('GET', '/dashboard?branchId=mirpur')).statusCode).toBe(400);
    const all = await dashboard();
    const unknown = await dashboard(`?branchId=${randomUUID()}`);
    expect(card(unknown.sales)).toMatchObject({ today: '0.0000', monthToDate: '0.0000' });
    expect(unknown.topProducts).toEqual([]);
    expect(unknown.margin?.monthToDate).toEqual({ sales: '0.0000', cost: '0.0000' });
    // The whole shop's cards stay as they are
    expect(unknown.cash).toEqual(all.cash);
    expect(unknown.receivables).toEqual(all.receivables);
    expect(unknown.lowStock).toEqual(all.lowStock);
  });
});
```

The file runs from top to bottom like a day in the shop. Here it is part by part, in its own order.

**The world.** Nabil Super Shop, a retail workspace: a grocery in Mirpur (the main branch, its `MAIN` store) and a
second shop in Uttara with its own store. Retail, because it is the industry with POS registers and cashiers, so one
workspace has invoices and POS sales together. The retail chart has no Sales returns account (its 4120 is "Service
income"), so the test makes 4130 "Sales returns" and picks it in Settings → Sales, and makes a bank account (1121)
under the bank group. Eight products, each one `pcs`, with stock brought in 40 days ago at a known cost (Matchbox is
never stocked). Three members besides the owner: Shirin (only `sales.report.read`), Jamal (`inventory.report.read`,
`inventory.stock.value` and `accounting.report.read`) and Rafiq (no role).

**The helpers.**

- **`booked` is what the test told the books was sold,** day, branch and amount. Every sale the test posts goes into
  it, and `expectedSales()` adds it up over `dashboardPeriods(today)` the same way the cards must. The test runs on any
  day, so it cannot write "yesterday is in this month": on the 1st, yesterday is last month's. Fixed numbers are
  checked only where the date does not matter (today, yesterday).
- **`movement()` and `booksSales()` read the account ledgers,** the journal's own lines, which the dashboard never
  reads. The ledger moved by `closingBalance − openingBalance` between two dates. The sales of the books are the credit
  of 4110 less the debit of 4130, so the sum of both movements, the other way round. When the dashboard and the ledger
  agree, the day totals (21a.2) agree with the journal.
- **`card()` turns `T | null` into `T`,** with an error that names the problem. The owner holds every permission, so a
  `null` card is a bug, and the test should say so, not fail later on `undefined`.
- **`memberWith()` makes one role with exactly the permissions given,** like the reports suite; with `[]` it adds no
  role at all. A role from the template would have other permissions too, and the test is about which cards one
  permission opens.
- **`v7()` only needs the version digit:** the device and POS tests sort by id, this one never does.

**A new shop.** Before any sale: the opening stock is posted (inventory against opening equity), and it must not show as
a sale or as money. The answer's `today` is the workspace's today, the branch is `null`, every number is `0.0000`, and
the chart has 30 points from 29 days ago to today. The cash card lists both money accounts at ৳0: an owner who just
added a bank account sees it on the home page at once, before its first entry. Top products is an empty list (not
`null`: the card is allowed and has nothing in it), and low stock is `{ count: 0, items: [] }`.

**The books by hand.** Journal entries are the quickest way to put exact numbers on exact days and branches.

- **The entries:** the owner's capital 40 days ago, a ৳6,000 deposit from the cash into the bank yesterday, sales of
  ৳1,000 (Mirpur) and ৳300 (Uttara) today, ৳100 today with no branch, ৳800 yesterday, ৳700 on the 1st of last month,
  ৳200 given back for a return today (Sales returns debited), ৳500 of service income today, and a ৳9,999 cheque sale
  dated tomorrow.
- **Sales are the sales accounts only.** Today is ৳1,200: 1,000 + 300 + 100 − 200. The service income is income but not
  sales; tomorrow's cheque is not a sale yet. The chart's last two points are today and yesterday. This month and the
  same days of last month equal the ledgers'.
- **The branch filter.** Mirpur today is ৳800 (1,000 − 200), Uttara ৳300. The ৳100 with no branch is in the whole shop's
  number and in neither branch's: the filter is `branch_id = …`, so a line without a branch belongs to no branch.
- **A closing row is left out.** A year-end close posts on the year's last day, 30 June, and the dashboard reads only
  the last two months, so a real close would test nothing on most days of the year. The test writes the row the
  trigger would write, as the superuser, on today: ৳5,000 debited to Sales with `closing = true`. Today's sales stay
  ৳1,200. Without `AND NOT t.closing` they would be ৳3,800 below zero.
- **The margin** has the same sales and no cost yet (no goods were sold).
- **The cash.** Cash in hand ৳7,200, the bank ৳6,000 (the deposit, not tomorrow's cheque), the larger first. Yesterday's
  total is ৳11,500: everything dated before today. With a branch picked, the cash card is the same: a bank account
  belongs to the whole shop (decision 11).

**Real documents.** Every kind of document that feeds a card, posted through its own route.

- **Invoices.** Karim Store buys six things today, due today. Rahim Traders buys two bags of rice at the Uttara shop 10
  days ago, due yesterday. Karim bought 20 salts 30 days ago: one day before the chart's first day, so it is in the books
  but not in the top products. A draft invoice of 50 salts would put salt at the top if drafts counted. Rahim pays ৳400 of
  his invoice.
- **A POS sale.** A register at the main store, the counter PC takes it, a shift opens with ৳1,000 from the owner (the
  first shift needs a reason for its float), and one sale is pushed: a tea and three soaps. Two soaps are in stock, so
  one is sold short: a POS sale is never refused for stock (step 20a), and the soap goes to −1, which the low stock
  test needs.
- **Bills.** The shop's rent, ৳12,000, due 5 days ago, and the electricity, ৳3,000, due in 25 days. Both have one
  expense line and no goods, and the Exempt rate, so the totals are the amounts. With no approval level set, submitting
  posts them.
- **Sales and margin match the books.** The sales card equals `booked` and the ledgers. The margin's cost is the cost of
  goods sold account's movement over the same days, the sold-short soap included, whatever cost the POS gave it. The
  cost is not zero any more, which proves the invoices and the POS sale reached the cost column.
- **Top products.** Five, the largest amount first: rice ৳2,700 (4 in Mirpur and 2 in Uttara), oil, sugar, tea and dal.
  Tea is ৳660 (2 on the invoice, 1 at the counter) and passes the dal's ৳520 only because the POS sale is counted:
  without the POS half of the `UNION ALL` the order changes. Salt (৳210 today) and the soaps are sixth and seventh.
- **Top products by branch.** Uttara has only Rahim's rice. Mirpur has the rest, the tea with its POS sale: the POS sale
  has no branch of its own, so the query takes its warehouse's.
- **Receivables.** ৳5,313 (Karim today) + ৳1,035 (Rahim) + ৳966 (Karim, 30 days ago) − ৳400 paid = ৳6,914. Overdue are
  two invoices: Rahim's ৳635 still due, and Karim's old one (due on the day, terms 0). Karim's invoice of today is due
  today, which is not overdue (`due_date < today`).
- **Payables.** ৳15,000 in all; the rent is overdue. With a branch picked, the dues are the same.

**Low stock.** The reorder levels, set after the sales, on what is left: rice 36 (level 40), oil 55 (50), sugar 25
(50), dal 26 (100), tea 17 (20), salt 35 (level 0), soap −1 (0), Matchbox 0 (0), and at Uttara rice 8 (10).

- **The count is 7:** oil is above its level, and salt is above a level of 0. The list has 5.
- **The order:** the soap below zero first, then Matchbox (empty), then the smallest share of the level: dal 26 of 100,
  sugar 25 of 50, rice 8 of 10 at Uttara. The soap is called "Toilet soap" on purpose: sorted by name alone it comes
  after Matchbox, so if `sign()` put both at 0, the test would fail.
- **Each row** has its warehouse, nothing on its way, no reorder quantity, and the unit (`pcs`, 0 decimals).

**What each person sees.** Shirin's answer has the sales and the top products, equal to the owner's, and no margin: the
margin needs the stock value too. Jamal's has the cash and the low stock, and no margin: the stock value without the
sales report is not enough either. Rafiq, with no role, gets a page with every card `null`, and still a 200: the route
has no permission of its own.

**The branch in the query.** `branchId=mirpur` is a 400 (the contract's `z.uuid()`). A uuid that is no branch gives
zeros and no top products, and leaves the whole shop's cards as they are.

### `dashboard/dashboard.tenant-leak.int.spec.ts` (new)

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  billSchema,
  branchSchema,
  customerSchema,
  type Dashboard,
  dashboardSchema,
  invoiceSchema,
  productSchema,
  setupSchema,
  shiftIsoDate,
  supplierSchema,
  taxRateListSchema,
  todayIn,
  unitListSchema,
  warehouseListSchema,
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
import { bearer, type SignedIn, signUp } from '../testing/http.js';

// Two shops. Only B has a day of business: sales, a bank account, an overdue invoice, an overdue
// bill and an item below its reorder level. The dashboard is a handful of SUMs over the day totals
// and the documents: one missing tenant filter would add B's money into A's cards.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let chartOfA: Account[];
let branchOfB: string;

const today = todayIn('Asia/Dhaka');

function as(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

async function created<T>(who: SignedIn, schema: z.ZodType<T>, url: string, payload: object) {
  const res = await as(who, 'POST', url, payload);
  expect(res.statusCode, res.body).toBe(201);
  return schema.parse(res.json());
}

async function dashboard(who: SignedIn, query = ''): Promise<Dashboard> {
  const res = await as(who, 'GET', `/dashboard${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return dashboardSchema.parse(res.json());
}

async function setUp(who: SignedIn): Promise<Account[]> {
  expect((await as(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(who, 'GET', '/setup')).json()).status).toBe('ready');
  });
  return accountListSchema.parse((await as(who, 'GET', '/accounts')).json()).items;
}

function idIn(chart: Account[], code: string): string {
  const found = chart.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
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
    companyName: 'Nabil Super Shop',
    workspaceSlug: 'nabil-super-shop',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nabilshop.com',
    password: 'Mirpur-grocery-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Sylhet Pharmacy',
    workspaceSlug: 'sylhet-pharmacy',
    fullName: 'Karim Uddin',
    email: 'karim@sylhetpharmacy.com',
    password: 'Zindabazar-shop-2026',
  });
  let chartOfB: Account[];
  [chartOfA, chartOfB] = await Promise.all([setUp(tenantA), setUp(tenantB)]);

  // B's day: a sale on a branch of B's, paid into a bank account of B's
  branchOfB = (
    await created(tenantB, branchSchema, '/branches', {
      code: 'ZND',
      name: 'Zindabazar shop',
      phone: '',
      address: '',
    })
  ).id;
  const bank = await created(tenantB, accountSchema, '/accounts', {
    parentId: idIn(chartOfB, '1120'),
    code: '1121',
    name: 'Sonali Bank CD A/C',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  const sale = await as(tenantB, 'POST', '/journal-entries', {
    date: today,
    narration: 'Sales at the shop',
    lines: [
      { accountId: bank.id, branchId: branchOfB, description: '', debit: '75000', credit: '' },
      {
        accountId: idIn(chartOfB, '4110'),
        branchId: branchOfB,
        description: '',
        debit: '',
        credit: '75000',
      },
    ],
    post: true,
  });
  expect(sale.statusCode, sale.body).toBe(201);

  // A service sold on credit 20 days ago, due on the day: no stock needed, overdue now
  const units = unitListSchema.parse((await as(tenantB, 'GET', '/units')).json()).items;
  const pcs = units.find((unit) => unit.code === 'pcs')?.id ?? '';
  const rates = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  const exempt = rates.find((rate) => rate.name === 'Exempt')?.id ?? '';
  const product = (name: string, type: 'goods' | 'service') =>
    created(tenantB, productSchema, '/products', {
      code: '',
      name,
      type,
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
        { id: null, sku: '', optionValues: [], barcode: '', salePrice: '500', archived: false },
      ],
      units: [],
      customFields: {},
    });
  const delivery = await product('Home delivery', 'service');
  const inhaler = await product('Salbutamol inhaler', 'goods');
  const clinic = await created(tenantB, customerSchema, '/customers', {
    code: '',
    name: 'Sylhet Clinic',
    groupId: '',
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
  await created(tenantB, invoiceSchema, '/invoices', {
    customerId: clinic.id,
    date: shiftIsoDate(today, -20),
    dueDate: '',
    customerReference: '',
    branchId: branchOfB,
    warehouseId: '',
    note: '',
    lines: [
      {
        variantId: delivery.variants[0]?.id ?? '',
        unitId: pcs,
        quantity: '10',
        description: '',
        unitPrice: '500',
        discountType: 'percent',
        discount: '',
        taxRateId: exempt,
        deliveryLineId: '',
        orderLineId: '',
        batchId: '',
        serialNumbers: [],
      },
    ],
    post: true,
  });

  // The shop's rent, overdue
  const landlord = await created(tenantB, supplierSchema, '/suppliers', {
    code: '',
    name: 'Zindabazar Properties',
    groupId: '',
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
  await created(tenantB, billSchema, '/bills', {
    supplierId: landlord.id,
    date: shiftIsoDate(today, -15),
    dueDate: shiftIsoDate(today, -5),
    supplierBillNumber: 'ZP-0042',
    mushakNumber: '',
    mushakDate: '',
    branchId: branchOfB,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [],
    expenses: [
      {
        accountId: idIn(chartOfB, '5220'),
        description: 'Shop rent',
        amount: '20000',
        taxRateId: exempt,
      },
    ],
    submit: true,
  });

  // An inhaler that never came in, with a reorder level: B's low stock
  const [store] = warehouseListSchema.parse((await as(tenantB, 'GET', '/warehouses')).json()).items;
  const level = await as(tenantB, 'PUT', '/stock/reorder-levels', {
    warehouseId: store?.id ?? '',
    variantId: inhaler.variants[0]?.id ?? '',
    minQuantity: '5',
    reorderQuantity: '',
  });
  expect(level.statusCode, level.body).toBe(200);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('dashboard isolation over HTTP', () => {
  // What A's own empty shop shows: its own cash account at zero, nothing else
  const emptyShop = () => ({
    sales: {
      today: '0.0000',
      yesterday: '0.0000',
      monthToDate: '0.0000',
      lastMonthToDate: '0.0000',
    },
    margin: {
      monthToDate: { sales: '0.0000', cost: '0.0000' },
      lastMonthToDate: { sales: '0.0000', cost: '0.0000' },
    },
    cash: {
      accounts: [
        {
          accountId: idIn(chartOfA, '1110'),
          code: '1110',
          name: 'Cash in hand',
          balance: '0.0000',
        },
      ],
      total: '0.0000',
      yesterday: '0.0000',
    },
    topProducts: [],
    receivables: { total: '0.0000', overdue: '0.0000', overdueCount: 0 },
    payables: { total: '0.0000', overdue: '0.0000', overdueCount: 0 },
    lowStock: { count: 0, items: [] },
  });

  it("adds none of tenant B's numbers into tenant A's dashboard", async () => {
    const ofA = await dashboard(tenantA);
    expect(ofA).toMatchObject(emptyShop());
    expect(ofA.sales?.days.every((point) => point.amount === '0.0000')).toBe(true);
  });

  it("shows nothing of B's even with B's own branch as the filter", async () => {
    const ofA = await dashboard(tenantA, `?branchId=${branchOfB}`);
    expect(ofA.branchId).toBe(branchOfB);
    expect(ofA).toMatchObject(emptyShop());
  });

  it('shows B its own numbers, so the data above was really there', async () => {
    const ofB = await dashboard(tenantB);
    expect(ofB.sales?.today).toBe('75000.0000');
    expect(ofB.cash?.total).toBe('75000.0000');
    expect(ofB.topProducts?.map((item) => [item.productName, item.amount])).toEqual([
      ['Home delivery', '5000.0000'],
    ]);
    expect(ofB.receivables).toEqual({
      total: '5000.0000',
      overdue: '5000.0000',
      overdueCount: 1,
    });
    expect(ofB.payables).toEqual({ total: '20000.0000', overdue: '20000.0000', overdueCount: 1 });
    expect(ofB.lowStock?.count).toBe(1);
  });
});
```

- **Only B has a day of business:** ৳75,000 of sales today on its Zindabazar branch, paid into a bank account of its own;
  a service invoice 20 days ago, unpaid and overdue (a service needs no stock, so the setup stays short); the shop's rent,
  overdue; and an inhaler that never came in, with a reorder level of 5.
- **A's dashboard is A's empty shop,** with its own Cash in hand at ৳0 and nothing else: not B's bank account, not B's
  sales, dues or low stock. Every card is a SUM or a list over shared tables, so one missing tenant filter would add B's
  rows in. The tenant id in each query and the row-level security below it both have to fail for that to happen.
- **B's own branch as A's filter** changes nothing: A still sees zeros, and the answer only says which branch was asked.
- **B sees its own numbers,** so the rows A did not see were really there.

### What I checked

> All on throwaway Postgres and Valkey containers (testcontainers).
>
> The new tests pass: 7 unit, 15 integration, 3 tenant-leak. The setup, roles and auth suites pass (42). The API's unit
> tests pass (130). API type check, ESLint and Prettier pass on every changed file.
>
> Broken on purpose, one at a time, and the integration suite failed each time: closing rows counted (3 tests), the
> Sales returns account left out (5), cash dated after today counted (1), the POS sales left out of the top products (2),
> a POS sale's branch taken from the wrong column (1), draft invoices counted (2), `sign()` taken out of the low stock
> order (1, after the soap's name was changed so that the names alone give the other order), an invoice due today
> counted as overdue (1), and the margin shown without its permission (1).

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/dashboard apps/api/src/setup
cd apps/api
npx vitest run src/dashboard src/setup/setup.int.spec.ts --maxWorkers=3
```

The path `src/dashboard` runs all three new files, the tenant-leak one too. The integration tests start their own
containers (Docker must be running) and never touch your dev database.

## 21a.5 — `packages/i18n`: the words

The page of 21a.6 needs its words in English and Bangla, so they come first. This part changes only the two locale
files. The ui package needs nothing new here: the chart comes in 21a.6, with the page.

When this part starts, the app does not type-check: the roles page looks up a word for every permission
(`permissions.<key>`), and 21a.1 added three. When this part ends, the i18n package, the ui package and the app all
type-check, except for one file, below.

The diffs show the words as they are at the end of 21a.6, which changed two things here: the old card's words
(`readyTitle`, `readyBody`, `invite`) are gone, and "Couldn't load" has a title of its own, `loadFailedTitle`
(decision 44). The old `routes/dashboard.tsx` still uses the three old keys until 21a.6 replaces it. If you want the
app to type-check between the two parts, keep those three keys for now and take them out in 21a.6.

### `locales/en.ts`

```diff
@@ -197,10 +197,108 @@ export const en = {
   },
   dashboard: {
     title: 'Overview',
-    readyTitle: 'Your workspace is ready',
-    readyBody:
-      'Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock will show up here once you start recording them.',
-    invite: 'Invite your team',
+    // Step 21a. Each card shows by its own permission (DASHBOARD_CARD_PERMISSIONS); amounts are
+    // whole taka (CLAUDE.md → Money: dashboards stay without decimals).
+    branch: 'Branch',
+    allBranches: 'All branches',
+    branchHint:
+      'A branch changes the sales, the margin and the top products. Cash, dues and stock are the whole workspace’s.',
+    branchOffline: 'Connect to the internet to see another branch.',
+    // When the answer was made: time = "10:42" today, "1 Nov 2026, 10:42" before today
+    asOf: 'As of {{time}}',
+    // Offline (decision 7): the last answer the device kept
+    offlineNotice:
+      'You are offline, so these numbers are not live. They are the ones this device kept the last time it was online.',
+    noCopyBody:
+      'This device has not kept the numbers yet. Connect to the internet once, and they stay here for the times you are offline.',
+    // An empty state's title and body; the button is common.retry
+    loadFailedTitle: "Couldn't load the numbers",
+    loadFailed: 'Omnivo tries again every minute, or you can try now.',
+    // A person whose role gives no card (decision 14)
+    noCardsTitle: 'No numbers for your role',
+    noCardsBody:
+      'The Overview shows what your permissions allow, and your role has none of it. Ask the workspace owner for a report permission in Settings → Roles.',
+    // percent = the change without its sign, one decimal, in the page's language (12.5 / ১২.৫);
+    // range = the same days of last month ("1 – 2 Oct 2026", or one day on the 1st)
+    sales: {
+      today: 'Sales today',
+      month: 'Sales this month',
+      hint: 'From the books: net of returns, before VAT',
+      moreThanYesterday: '{{percent}}% more than yesterday',
+      lessThanYesterday: '{{percent}}% less than yesterday',
+      sameAsYesterday: 'The same as yesterday',
+      noYesterday: 'No sales yesterday',
+      moreThanLastMonth: '{{percent}}% more than {{range}}',
+      lessThanLastMonth: '{{percent}}% less than {{range}}',
+      sameAsLastMonth: 'The same as {{range}}',
+      noLastMonth: 'No sales on {{range}}',
+    },
+    // Here percent keeps its sign: a margin can be below zero
+    margin: {
+      title: 'Gross margin this month',
+      // profit and sales in whole taka: "৳1,89,000 on ৳8,40,000 of sales"
+      ofSales: '{{profit}} on {{sales}} of sales',
+      noSales: 'No sales yet this month',
+      lastMonth: '{{percent}}% on {{range}}',
+    },
+    cash: {
+      title: 'Cash and bank',
+      subtitle: 'Every account that holds money, now',
+      // Against the total at the end of yesterday (decision 21)
+      upToday: 'Up {{amount}} today',
+      downToday: 'Down {{amount}} today',
+      sameToday: 'No change today',
+      emptyTitle: 'No account holds money',
+      emptyBody:
+        'Tick “Holds money” on your cash, bank and bKash accounts in the chart of accounts, and their balances show here.',
+    },
+    trend: {
+      title: 'Sales, last 30 days',
+      subtitle: 'One point a day, net of returns, before VAT',
+      // The chart's name for screen readers; from and to are dates
+      label: 'Sales of each day from {{from}} to {{to}}',
+      empty: 'Nothing sold in the last 30 days',
+    },
+    topProducts: {
+      title: 'Top products',
+      subtitle: 'The last 30 days, by sales before VAT',
+      // quantity with its unit: "72 pcs"
+      sold: '{{quantity}} sold',
+      emptyTitle: 'Nothing sold in the last 30 days',
+      emptyBody:
+        'Post an invoice or make a POS sale, and the products that sell the most show here.',
+    },
+    // count picks the plural; formatted = the number in the page's language (12 / ১২)
+    receivables: {
+      title: 'Customers owe',
+      subtitle: 'Less what they paid in advance',
+      // The total below zero: the advances are larger than what is owed
+      advance: '{{amount}} in advance',
+      overdue_one: '{{amount}} overdue on {{formatted}} invoice',
+      overdue_other: '{{amount}} overdue on {{formatted}} invoices',
+      nothingOverdue: 'Nothing overdue',
+      link: 'See the customers',
+    },
+    payables: {
+      title: 'Owed to suppliers',
+      subtitle: 'Less what was paid to them in advance',
+      advance: '{{amount}} paid in advance',
+      overdue_one: '{{amount}} overdue on {{formatted}} bill',
+      overdue_other: '{{amount}} overdue on {{formatted}} bills',
+      nothingOverdue: 'Nothing overdue',
+      link: 'See the suppliers',
+    },
+    lowStock: {
+      title: 'Low stock',
+      subtitle: 'At or below the reorder level',
+      count_one: '{{formatted}} item',
+      count_other: '{{formatted}} items',
+      // onHand is the number alone, level has its unit: "40 of 200 strips"
+      onHandOf: '{{onHand}} of {{level}}',
+      link: 'See the reorder list',
+      emptyTitle: 'Nothing is low',
+      emptyBody: 'Every item with a reorder level has more than it in stock.',
+    },
   },
   settings: {
     title: 'Settings',
```

- **The branch select has its own hint,** because decision 11 is not what most people expect: the branch changes the
  sales, the margin and the top products, and nothing else. Without the hint, an owner who picks a depot and sees the
  same cash would think the select is broken. `branchOffline` is the select's hint while offline: the device keeps one
  answer (decision 7), so another branch needs the server.
- **`asOf` takes a time the page writes,** "10:42" for an answer of today and the date with the time before that. A
  device that was offline over a weekend must not say "As of 10:42" for Friday's numbers.
- **`offlineNotice` says why the numbers are not live and where they came from,** in one sentence. `noCopyBody` is the
  first visit offline: there is nothing kept yet, and the title is the Sync page's "Needs a connection"
  (`sync.needsConnectionTitle`), so the two states read alike.
- **`loadFailedTitle` says what went wrong, `loadFailed` what Omnivo does by itself:** the page asks again every
  minute (21a.6), so the person can wait or press Retry (`common.retry`). They are the title and the text of an empty
  state, which needs both.
- **`noCardsTitle` and `noCardsBody` are decision 14:** a person with no card gets a page that says why and who can
  change it, not an empty page.
- **The change lines say "more" or "less" in words,** with the percent without its sign. The arrow icon next to them is
  not the only sign (CLAUDE.md: never color alone), so a screen reader hears "12.5% less than yesterday", not "-12.5".
  A change of 0.0 says "The same as yesterday", and `noYesterday` is decision 20's `null`: no sales yesterday is no
  percent.
- **`range` is the days compared with,** "1 – 2 Oct 2026" (decision 17). The page writes it with `reports.range`, or
  one date on the 1st of the month, so the person sees which days are compared.
- **The margin's percent keeps its sign:** a month sold below cost has a margin below zero, and that is the number to
  see. `ofSales` gives the taka behind the percent ("৳1,89,000 on ৳8,40,000 of sales").
- **The cash's change line is "Up" or "Down" today** (decision 21): against the end of yesterday, not against a
  percent, because a percent of a cash balance means little. `emptyBody` names the tick to set, with the words of the
  chart of accounts ("Holds money").
- **`trend.label` is the chart's name for a screen reader,** with its first and last day. The tooltip shows a day's
  date and amount with `format` alone, so it needs no key.
- **`topProducts.sold` takes a quantity with its unit** ("72 pcs"), written with the unit the answer carries (decision
  19), offline too.
- **The dues have plural keys** (`overdue_one` / `_other`), and `advance` is the total below zero (decision 22): the
  customers paid more in advance than they owe. The payables say "paid in advance", because there the company paid.
- **`lowStock.onHandOf` is "40 of 200 strips":** the number on hand alone, then the reorder level with its unit, so the
  unit is said once. The links (`receivables.link`, `payables.link`, `lowStock.link`) go to the pages that list the
  rest: the customers, the suppliers and the reorder report.

```diff
@@ -5159,6 +5257,8 @@ export const en = {
         value: 'See what stock costs and what it is worth',
         revalue: 'Revalue stock: give items a new average cost',
       },
+      // Step 21a (decision 3)
+      report: { read: 'See the stock reports, and the low stock on the Overview' },
     },
     sales: {
       customer: {
@@ -5175,6 +5275,7 @@ export const en = {
       return: { manage: 'Write and post sales returns: goods come back into a warehouse' },
       credit_note: { manage: 'Write and post credit notes, and apply them to invoices' },
       refund: { manage: 'Pay money back to customers, and void refunds' },
+      report: { read: 'See the sales reports, and the sales and the top products on the Overview' },
     },
     purchase: {
       supplier: {
@@ -5200,6 +5301,7 @@ export const en = {
       return: { manage: 'Write and post purchase returns: goods go back to a supplier' },
       debit_note: { manage: 'Write and post debit notes, and apply them to bills' },
       refund: { manage: 'Record money suppliers pay back, and void supplier refunds' },
+      report: { read: 'See the purchase reports' },
     },
     // Step 20a (decisions 11, 31)
     pos: {
```

**The three permissions** (decision 3) sit at the end of their module's group, with the words of the permission
catalog (21a.2). Each says what it shows today: `inventory.report.read` and `sales.report.read` name their cards on the
Overview, so a role editor knows what ticking them changes now, and `purchase.report.read` says only "the purchase
reports", which come in 21b.

### `locales/bn.ts`

```diff
@@ -174,10 +174,92 @@ export const bn: Messages = {
   },
   dashboard: {
     title: 'সারসংক্ষেপ',
-    readyTitle: 'আপনার ওয়ার্কস্পেস তৈরি',
-    readyBody:
-      'এবার চার্ট অব অ্যাকাউন্টস সাজান আর আপনার হিসাবরক্ষককে আমন্ত্রণ জানান। বায়ার PO, LC আর স্টক রেকর্ড শুরু করলে এখানে দেখা যাবে।',
-    invite: 'টিমকে আমন্ত্রণ জানান',
+    branch: 'ব্রাঞ্চ',
+    allBranches: 'সব ব্রাঞ্চ',
+    branchHint:
+      'ব্রাঞ্চ বাছলে বিক্রি, মার্জিন আর শীর্ষ প্রোডাক্ট বদলায়। ক্যাশ, পাওনা-দেনা আর স্টক পুরো ওয়ার্কস্পেসের।',
+    branchOffline: 'অন্য ব্রাঞ্চ দেখতে ইন্টারনেটে যুক্ত হন।',
+    asOf: '{{time}} পর্যন্ত',
+    offlineNotice:
+      'আপনি অফলাইনে, তাই এই সংখ্যাগুলো এখনকার নয়। শেষবার অনলাইনে থাকার সময় এই ডিভাইস যা রেখেছিল, এগুলো সেই সংখ্যা।',
+    noCopyBody:
+      'এই ডিভাইস এখনো সংখ্যাগুলো রাখেনি। একবার ইন্টারনেটে যুক্ত হন, তারপর অফলাইনের সময়ও এগুলো এখানে থাকবে।',
+    loadFailedTitle: 'সংখ্যাগুলো আনা যায়নি',
+    loadFailed: 'Omnivo প্রতি মিনিটে নিজেই আবার চেষ্টা করে, অথবা এখনই চেষ্টা করতে পারেন।',
+    noCardsTitle: 'আপনার রোলের জন্য কোনো সংখ্যা নেই',
+    noCardsBody:
+      'সারসংক্ষেপে শুধু সেটুকুই দেখায় যা আপনার permission-এ আছে, আর আপনার রোলে তার কিছুই নেই। ওয়ার্কস্পেসের মালিককে সেটিংস → রোলে একটা রিপোর্ট permission দিতে বলুন।',
+    sales: {
+      today: 'আজকের বিক্রি',
+      month: 'এই মাসের বিক্রি',
+      hint: 'হিসাবের বই থেকে: রিটার্ন বাদে, ভ্যাটের আগে',
+      moreThanYesterday: 'গতকালের চেয়ে {{percent}}% বেশি',
+      lessThanYesterday: 'গতকালের চেয়ে {{percent}}% কম',
+      sameAsYesterday: 'গতকালের সমান',
+      noYesterday: 'গতকাল কোনো বিক্রি হয়নি',
+      moreThanLastMonth: '{{range}}-এর চেয়ে {{percent}}% বেশি',
+      lessThanLastMonth: '{{range}}-এর চেয়ে {{percent}}% কম',
+      sameAsLastMonth: '{{range}}-এর সমান',
+      noLastMonth: '{{range}}-এ কোনো বিক্রি হয়নি',
+    },
+    margin: {
+      title: 'এই মাসের গ্রস মার্জিন',
+      ofSales: '{{sales}} বিক্রিতে {{profit}}',
+      noSales: 'এই মাসে এখনো কোনো বিক্রি হয়নি',
+      lastMonth: '{{range}}-এ {{percent}}%',
+    },
+    cash: {
+      title: 'ক্যাশ আর ব্যাংক',
+      subtitle: 'যেসব অ্যাকাউন্টে টাকা রাখা হয়, এখন',
+      upToday: 'আজ {{amount}} বেড়েছে',
+      downToday: 'আজ {{amount}} কমেছে',
+      sameToday: 'আজ কোনো বদল নেই',
+      emptyTitle: 'কোনো অ্যাকাউন্টে টাকা রাখা হয় না',
+      emptyBody:
+        'চার্ট অব অ্যাকাউন্টসে আপনার ক্যাশ, ব্যাংক আর বিকাশ অ্যাকাউন্টে “টাকা রাখা হয়” টিক দিন, তখন তাদের ব্যালান্স এখানে দেখা যাবে।',
+    },
+    trend: {
+      title: 'বিক্রি, গত ৩০ দিন',
+      subtitle: 'দিনে একটা বিন্দু, রিটার্ন বাদে, ভ্যাটের আগে',
+      label: '{{from}} থেকে {{to}} পর্যন্ত প্রতিদিনের বিক্রি',
+      empty: 'গত ৩০ দিনে কিছু বিক্রি হয়নি',
+    },
+    topProducts: {
+      title: 'শীর্ষ প্রোডাক্ট',
+      subtitle: 'গত ৩০ দিন, ভ্যাটের আগের বিক্রি ধরে',
+      sold: '{{quantity}} বিক্রি',
+      emptyTitle: 'গত ৩০ দিনে কিছু বিক্রি হয়নি',
+      emptyBody:
+        'একটা ইনভয়েস পোস্ট করুন বা POS-এ বিক্রি করুন, তখন সবচেয়ে বেশি বিক্রি হওয়া প্রোডাক্ট এখানে দেখা যাবে।',
+    },
+    receivables: {
+      title: 'গ্রাহকদের কাছে পাওনা',
+      subtitle: 'তারা যা অগ্রিম দিয়েছে তা বাদে',
+      advance: '{{amount}} অগ্রিম',
+      overdue_one: '{{formatted}}টা ইনভয়েসে {{amount}} সময় পার',
+      overdue_other: '{{formatted}}টা ইনভয়েসে {{amount}} সময় পার',
+      nothingOverdue: 'কিছুই সময় পার হয়নি',
+      link: 'গ্রাহকদের দেখুন',
+    },
+    payables: {
+      title: 'সাপ্লায়ারদের দেনা',
+      subtitle: 'তাদের যা অগ্রিম দেওয়া হয়েছে তা বাদে',
+      advance: '{{amount}} অগ্রিম দেওয়া',
+      overdue_one: '{{formatted}}টা বিলে {{amount}} সময় পার',
+      overdue_other: '{{formatted}}টা বিলে {{amount}} সময় পার',
+      nothingOverdue: 'কিছুই সময় পার হয়নি',
+      link: 'সাপ্লায়ারদের দেখুন',
+    },
+    lowStock: {
+      title: 'কম স্টক',
+      subtitle: 'রিঅর্ডার লেভেলে বা তার নিচে',
+      count_one: '{{formatted}}টা আইটেম',
+      count_other: '{{formatted}}টা আইটেম',
+      onHandOf: '{{level}}-এর মধ্যে {{onHand}}',
+      link: 'রিঅর্ডারের তালিকা দেখুন',
+      emptyTitle: 'কিছুই কম নেই',
+      emptyBody: 'যেসব আইটেমের রিঅর্ডার লেভেল আছে, সবগুলোর স্টক তার চেয়ে বেশি।',
+    },
   },
   settings: {
     title: 'সেটিংস',
@@ -4866,6 +4948,7 @@ export const bn: Messages = {
         value: 'স্টকের খরচ আর মূল্য দেখা',
         revalue: 'স্টকের পুনর্মূল্যায়ন: আইটেমের নতুন গড় খরচ ঠিক করা',
       },
+      report: { read: 'স্টকের রিপোর্ট দেখা, আর সারসংক্ষেপে কম স্টক দেখা' },
     },
     sales: {
       customer: {
@@ -4882,6 +4965,7 @@ export const bn: Messages = {
       return: { manage: 'সেলস রিটার্ন লেখা আর পোস্ট করা: মাল গুদামে ফেরত আসে' },
       credit_note: { manage: 'ক্রেডিট নোট লেখা, পোস্ট করা আর ইনভয়েসে ধরা' },
       refund: { manage: 'গ্রাহকদের টাকা ফেরত দেওয়া, আর রিফান্ড বাতিল করা' },
+      report: { read: 'বিক্রির রিপোর্ট দেখা, আর সারসংক্ষেপে বিক্রি আর শীর্ষ প্রোডাক্ট দেখা' },
     },
     purchase: {
       supplier: {
@@ -4903,6 +4987,7 @@ export const bn: Messages = {
       return: { manage: 'পারচেজ রিটার্ন লেখা আর পোস্ট করা: মাল সাপ্লায়ারের কাছে ফেরত যায়' },
       debit_note: { manage: 'ডেবিট নোট লেখা, পোস্ট করা আর বিলে ধরা' },
       refund: { manage: 'সাপ্লায়ারের ফেরত দেওয়া টাকা লেখা, আর সাপ্লায়ার রিফান্ড ভয়েড করা' },
+      report: { read: 'কেনাকাটার রিপোর্ট দেখা' },
     },
     pos: {
       sale: { create: 'POS কাউন্টারে বিক্রি: রেজিস্টার নেওয়া, বিক্রি লেখা আর টাকা নেওয়া' },
```

- **The same keys, in the same places,** without the comments: they are in `en.ts`. Office words stay as the app
  already writes them: POS, permission, the settings path (সেটিংস → রোল), ইনভয়েস, রিঅর্ডার.
- **The Overview is সারসংক্ষেপ,** the nav's word, so the permission words point at the page by its name.
- **The terms are the app's own:** পাওনা for what customers owe (the customer list's `owes`), দেনা for what is owed to
  suppliers (the supplier balance permission's word), সময় পার for overdue (the invoice and bill filters), অগ্রিম for an
  advance, and “টাকা রাখা হয়”, the chart of accounts' tick, in the cash card's empty text.
- **The word order follows Bangla, so the placeholders move:** "গতকালের চেয়ে {{percent}}% বেশি", "{{level}}-এর মধ্যে
  {{onHand}}". `asOf` is "{{time}} পর্যন্ত".
- **`*_one` / `*_other` are the same text.** Bangla has one form here, but i18next asks for both keys, because the
  English type has both.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/app typecheck
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
```

The roles page finds a word for every permission again. The app's type check still fails on the old
`routes/dashboard.tsx` (its three old keys) until 21a.6, unless you kept them (see the top of this part). The new
dashboard keys are used in 21a.6.

## 21a.6 — The screen: the chart, the kept answer and the Overview

This part draws what 21a.1 to 21a.5 made ready, as the mockup you approved shows it (decision 35). It touches four
packages, in the order they depend on each other: `@omnivo/ui` (the chart and the KPI strip), `@omnivo/i18n` (two
formatters), `@omnivo/sync` (the kept answer) and the app (the page).

When this part starts, the app type-checks only if you kept the old card's three keys in 21a.5 (see there). When it
ends, every package type-checks, and the app builds within its budgets.

### `packages/ui`: the chart

#### `lib/ticks.ts` (new): the gridlines

```ts
// Step 21a: the chart's gridlines (line-chart.tsx), apart from the component so a test can reach it
// without React.

// The gridlines' values: 0 and a few round steps (1, 2 or 5 times a power of ten) that hold every
// point. A day with more returns than sales is below zero, so the steps go below zero too.
export function niceTicks(values: readonly number[], count = 3): number[] {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  // Nothing but zeros: one step of 1, so the line lies on the bottom gridline
  if (high === low) return [0, 1];
  const raw = (high - low) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((times) => times * power).find((size) => size >= raw) ?? raw;
  const first = Math.floor(low / step);
  const last = Math.ceil(high / step);
  return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * step);
}
```

- **The gridlines start at zero,** so the line is read against zero, not against the smallest day: a chart that
  started at ৳1,20,000 would make a ৳10,000 dip look like a crash. `low` and `high` take 0 in with the values.
- **The step is 1, 2 or 5 times a power of ten,** the smallest of them that splits the range in `count` (3) or fewer
  parts. ৳2,26,000 in three is ৳75,333 a step; the next round step is ৳1,00,000, so the lines are ৳0, ৳1,00,000,
  ৳2,00,000 and ৳3,00,000. 2.5 is left out on purpose: a step of ৳25,000 written in whole taka is fine, but a step of
  0.25 written in whole taka would show "৳0" twice.
- **Below zero is allowed:** a day where the returns were larger than the sales is a negative day in the books
  (decision 10), and the line must not leave the chart.
- **Only zeros give `[0, 1]`:** a step of 1 puts the flat line on the bottom gridline and keeps the scale from dividing
  by zero. The page shows "Nothing sold in the last 30 days" in that case anyway (below); the chart is safe on its own.
- **It lives apart from the component** so the test reaches it without React.

```ts
import { describe, expect, it } from 'vitest';

import { niceTicks } from './ticks.js';

describe('niceTicks', () => {
  it('starts at zero and takes a round step that holds the largest day', () => {
    // ৳2,26,000 in three steps is 75,333 a step: the next round one is 1,00,000
    expect(niceTicks([168_000, 226_000, 121_000])).toEqual([0, 100_000, 200_000, 300_000]);
    expect(niceTicks([40, 95])).toEqual([0, 50, 100]);
  });

  it('goes below zero for a day with more returns than sales', () => {
    expect(niceTicks([-12_000, 30_000])).toEqual([-20_000, 0, 20_000, 40_000]);
  });

  it('draws nothing but zeros on the bottom gridline', () => {
    expect(niceTicks([0, 0, 0])).toEqual([0, 1]);
    expect(niceTicks([])).toEqual([0, 1]);
  });
});
```

The three cases above: a normal month, a day below zero and only zeros (with no points at all too).

#### `components/line-chart.tsx` (new)

```tsx
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '../lib/cn.js';
import { niceTicks } from '../lib/ticks.js';

// Step 21a (decision 8): our own small SVG line chart, no chart library. CLAUDE.md → Charts: a 2px
// brand line, a brand area fading from 14% to 0, dashed line-colored gridlines, 11px ink-3 axis
// labels, an emphasized end point, and a hover crosshair with a tooltip. Only the pages that draw a
// chart import it, and each of them is a lazy route, so none of this is in the first download.

export interface LineChartPoint {
  // React's key: the day ("2026-10-29")
  key: string;
  // A decimal string, like every amount. The chart turns it into a number only to place the point:
  // a pixel has no paisa. What the person reads comes from formatValue(), from the string.
  value: string;
  // The tooltip's name of the point ("29 Oct 2026") and the axis's shorter one ("29 Oct")
  label: string;
  axisLabel: string;
}

interface LineChartProps {
  // The chart's name for a screen reader: what it shows, from when to when
  label: string;
  points: readonly LineChartPoint[];
  // The axis and the tooltip: "৳2,00,000"
  formatValue: (value: string) => string;
  height?: number;
  className?: string;
}
```

- **A point's `value` is a decimal string,** like every amount in Omnivo. The chart turns it into a number only to put
  the point on the screen: a pixel has no paisa, so nothing is lost. Everything the person reads (the axis, the
  tooltip) goes through `formatValue()` from the string, so the money rule (CLAUDE.md → Money: never a JavaScript
  number) holds for what is shown.
- **Each point brings two names:** `label` for the tooltip ("29 Oct 2026") and `axisLabel` for the axis ("29 Oct").
  The chart knows no language; the page writes both with `format`.

```tsx
// The width of the box the chart sits in, in pixels. The chart is drawn at that width (not scaled
// from a viewBox), so its 11px labels stay 11px on a phone. ResizeObserver tells the first width
// too, before the first paint.
function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

const TOP = 12;
const BOTTOM = 26;
const RIGHT = 8;
// About the width of one 11px digit: the left margin fits the longest gridline label
const CHAR_WIDTH = 6.6;
```

- **The chart is drawn at its box's width in pixels** (decision 43). A `viewBox` would scale the whole drawing, text
  too: a chart drawn for 720px and shown on a 330px phone would have 5px labels. Measuring the box keeps 11px labels at
  11px on every screen.
- **`ResizeObserver` gives the first width as well,** right after layout and before the first paint, so there is no
  `setState` in the effect itself and no flash of an empty box. The `typeof ResizeObserver` check keeps a test runner
  without it (jsdom) from crashing; the chart is simply not drawn there.
- **The margins:** 12px on top so the highest point's dot is not cut, 26px at the bottom for the day labels, and the
  left margin from the longest gridline label (`CHAR_WIDTH` is about one 11px digit), so "৳3,00,000" and "৳৩,০০,০০০"
  both fit without a fixed guess.

```tsx
export function LineChart({ label, points, formatValue, height = 220, className }: LineChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const fillId = useId();
  // The point under the pointer or chosen with the arrow keys; null = none
  const [active, setActive] = useState<number | null>(null);

  const values = points.map((point) => Number(point.value));
  const ticks = niceTicks(values);
  const low = ticks[0] ?? 0;
  const high = ticks[ticks.length - 1] ?? 1;
  const tickLabels = ticks.map((tick) => formatValue(tick.toFixed(4)));
  const left = Math.ceil(Math.max(...tickLabels.map((text) => text.length)) * CHAR_WIDTH) + 12;
  const plotWidth = Math.max(width - left - RIGHT, 1);
  const plotBottom = height - BOTTOM;
  const last = points.length - 1;

  const x = (index: number) => left + (last > 0 ? (index * plotWidth) / last : plotWidth / 2);
  const y = (value: number) => TOP + ((high - value) / (high - low)) * (plotBottom - TOP);

  const line = values
    .map(
      (value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`,
    )
    .join(' ');
  // The area closes on the zero line, so a day below zero is filled up to it, not down to the axis
  const area = `${line} L${x(last).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  // Five labels on a wide chart, three on a phone; the first and the last always
  const labelCount = Math.min(width >= 480 ? 5 : 3, points.length);
  const labelIndexes =
    labelCount < 2
      ? [0]
      : Array.from({ length: labelCount }, (_, i) => Math.round((i * last) / (labelCount - 1)));

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    if (last < 0) return;
    const offset = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const index = Math.round(((offset - left) / plotWidth) * last);
    setActive(Math.min(Math.max(index, 0), last));
  };

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = active ?? last;
    const next =
      event.key === 'ArrowLeft'
        ? from - 1
        : event.key === 'ArrowRight'
          ? from + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(Math.min(Math.max(next, 0), last));
  };

  const shown = active === null ? undefined : points[active];
  const shownValue = active === null ? 0 : (values[active] ?? 0);
  // The tooltip stays inside the box: 64px is about half of its width
  const tipLeft = Math.min(Math.max(x(active ?? 0), 64), Math.max(width - 64, 64));
```

- **`x` and `y` map a day and an amount to pixels.** With one point (`last` is 0) it sits in the middle, not at a
  division by zero.
- **The area closes on the zero line, not the bottom of the chart** (decision 43): with a day below zero, closing on
  the bottom would fill under the zero line as if it were sales.
- **Five day labels on a wide chart, three on a narrow one,** always the first and the last, so the reader sees which
  30 days these are. `Math.round` spreads them evenly over 30 points.
- **`pick` finds the nearest day under the pointer,** on move and on press: a phone has no hover, so a tap shows the
  tooltip. It is clamped, so the pointer in the left margin picks the first day, not "day −2".
- **`move` walks the days with the arrow keys,** Home and End jump to the ends; any other key is left alone, so Tab
  still leaves the chart. `preventDefault` stops the arrows from scrolling the page while they move the crosshair.
- **The tooltip is kept inside the box** (`tipLeft`): over the first or last day it would hang half outside, and a
  card with `overflow-hidden` would cut it.

```tsx
  return (
    // The box takes the focus, not the SVG: a screen reader hears the chart's name, and the arrow
    // keys walk the days; the live region below says each one
    <div
      ref={box}
      role="group"
      aria-label={label}
      tabIndex={0}
      onKeyDown={move}
      onFocus={() => {
        setActive((current) => current ?? last);
      }}
      onBlur={() => {
        setActive(null);
      }}
      className={cn('relative rounded-control outline-none focus-visible:shadow-ring', className)}
      style={{ height }}
    >
      {width > 0 && points.length > 0 && (
        <svg
          width={width}
          height={height}
          aria-hidden="true"
          className="block touch-pan-y overflow-visible"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => {
            setActive(null);
          }}
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--brand)', stopOpacity: 0.14 }} />
              <stop offset="1" style={{ stopColor: 'var(--brand)', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {ticks.map((tick, index) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - RIGHT}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-line"
                strokeDasharray={tick === 0 ? undefined : '3 4'}
              />
              <text
                x={left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-ink-3 text-micro tabular-nums"
              >
                {tickLabels[index]}
              </text>
            </g>
          ))}
          {labelIndexes.map((index, position) => (
            <text
              key={index}
              x={x(index)}
              y={height - 6}
              textAnchor={
                position === 0 ? 'start' : position === labelIndexes.length - 1 ? 'end' : 'middle'
              }
              className="fill-ink-3 text-micro"
            >
              {points[index]?.axisLabel}
            </text>
          ))}
          <path d={area} fill={`url(#${fillId})`} />
          <path
            d={line}
            className="fill-none stroke-brand"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {active !== null && (
            <>
              <line
                x1={x(active)}
                x2={x(active)}
                y1={TOP}
                y2={plotBottom}
                className="stroke-ink-3"
                strokeDasharray="3 3"
              />
              <circle
                cx={x(active)}
                cy={y(shownValue)}
                r={4}
                className="fill-surface stroke-brand"
                strokeWidth={2}
              />
            </>
          )}
          {/* The end point: today */}
          <circle
            cx={x(last)}
            cy={y(values[last] ?? 0)}
            r={4.5}
            className="fill-brand stroke-surface"
            strokeWidth={2}
          />
        </svg>
      )}
      {shown && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-md"
          style={{ left: tipLeft, top: y(shownValue) - 10 }}
        >
          <div className="text-caption text-ink-3">{shown.label}</div>
          <div className="text-body-sm font-semibold tabular-nums">{formatValue(shown.value)}</div>
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {shown && `${shown.label}: ${formatValue(shown.value)}`}
      </span>
    </div>
  );
}
```

- **The box, not the SVG, takes the focus** (`tabIndex={0}`, `role="group"` with the chart's name). The SVG is
  `aria-hidden`: a screen reader cannot use 30 path points, but it can use "Sales of each day from 6 Oct 2026 to
  4 Nov 2026" and then, with the arrow keys, the live region's "29 Oct 2026: ৳2,26,000". Focus starts on the last day
  (today); leaving the chart clears the crosshair.
- **`focus-visible:shadow-ring`** is the design's focus ring, shown for the keyboard only, not after a click.
- **`touch-pan-y`** lets a finger scroll the page up and down over the chart; sideways moves stay with the chart.
- **The gradient's id comes from `useId()`,** so two charts on one page (21b) never fill with each other's gradient.
  Its colors are `var(--brand)` with an opacity, so the dark theme's brand color is used without code (CLAUDE.md →
  Charts: 14% to 0).
- **The zero gridline is solid, the others dashed:** the eye finds where sales turn negative.
- **The end point is filled `brand` with a `surface` ring,** the design's "emphasized end point": today. The hovered
  point is the opposite (a `surface` dot with a `brand` ring), so the two never look the same.
- **Every color is a token class** (`stroke-brand`, `fill-ink-3`, `stroke-line`), never a hex value, so the chart
  follows the theme.

#### `components/kpi-strip.tsx`

```diff
@@ -1,32 +1,84 @@
+import { ArrowDownRight01Icon, ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
+import { HugeiconsIcon } from '@hugeicons/react';
+
 import { cn } from '../lib/cn.js';
 import { Card } from './card.js';
 
+// Step 21a: the change line of a cell. up = good with an arrow up, down = crit with an arrow down,
+// flat = ink-3 with no arrow (no change, or a number given only to compare with). The words say
+// "more" or "less" too, so the color is never the only sign.
+export interface KpiChange {
+  text: string;
+  trend: 'up' | 'down' | 'flat';
+}
+
+export interface KpiCell {
+  label: string;
+  value: string;
+  sub?: string | undefined;
+  change?: KpiChange | undefined;
+}
+
 interface KpiStripProps {
-  cells: readonly { label: string; value: string; sub?: string | undefined }[];
+  cells: readonly KpiCell[];
 }
 
+// By the number of cells. Whole class names, not `sm:grid-cols-${n}`: Tailwind only finds classes
+// written out.
+const COLUMNS = ['', 'sm:grid-cols-1', 'sm:grid-cols-2', 'sm:grid-cols-3', 'sm:grid-cols-4'];
+
+const TREND = {
+  up: { icon: ArrowUpRight01Icon, className: 'text-good' },
+  down: { icon: ArrowDownRight01Icon, className: 'text-crit' },
+  flat: { icon: null, className: 'text-ink-3' },
+} satisfies Record<KpiChange['trend'], unknown>;
+
 // CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line.
 // Moved here from the app's report-parts.tsx in step 13: the stock card uses it too, and importing
 // it from the reports' file pulled the reports' code into the stock card's chunk.
-// Three cells or four (step 14: the stock card and the valuation page show what the stock is
-// worth). Whole class names, not `sm:grid-cols-${n}`: Tailwind only finds classes written out.
+// Step 21a: one to four cells (the Overview shows the ones the person's permissions allow), a
+// change line, and four cells two by two on a phone. The rules are the line color of the card's
+// background, showing through a 1px gap between the cells: a 2 × 2 grid gets every rule right,
+// which divide-x / divide-y cannot do.
 export function KpiStrip({ cells }: KpiStripProps) {
   return (
     <Card
       className={cn(
-        'grid grid-cols-1 divide-y divide-line sm:divide-x sm:divide-y-0',
-        cells.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3',
+        'grid gap-px overflow-hidden bg-line',
+        cells.length === 4 ? 'grid-cols-2' : 'grid-cols-1',
+        COLUMNS[cells.length],
       )}
     >
-      {cells.map((cell) => (
-        <div key={cell.label} className="grid gap-1 px-5 py-4">
-          <span className="text-caption text-ink-3">{cell.label}</span>
-          <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
-          {cell.sub !== undefined && (
-            <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
-          )}
-        </div>
-      ))}
+      {cells.map((cell) => {
+        const trend = cell.change && TREND[cell.change.trend];
+        return (
+          <div key={cell.label} className="grid content-start gap-1 bg-surface px-5 py-4">
+            <span className="text-caption text-ink-3">{cell.label}</span>
+            <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
+            {cell.sub !== undefined && (
+              <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
+            )}
+            {cell.change && trend && (
+              <span
+                className={cn(
+                  'flex items-center gap-1 text-caption font-medium tabular-nums',
+                  trend.className,
+                )}
+              >
+                {trend.icon && (
+                  <HugeiconsIcon
+                    icon={trend.icon}
+                    size={14}
+                    strokeWidth={1.5}
+                    className="shrink-0"
+                  />
+                )}
+                {cell.change.text}
+              </span>
+            )}
+          </div>
+        );
+      })}
     </Card>
   );
 }
```

- **`change` is the design's change line** (decision 36): `up` is `good` with an arrow up, `down` is `crit` with an
  arrow down, `flat` is `ink-3` with no arrow. The words always say "more", "less", "up" or "down" too, so color is
  never the only sign (CLAUDE.md → Color tokens).
- **One to four cells:** the Overview shows the cells a person's permissions allow (a store keeper's strip has none,
  an accountant without sales has one). `COLUMNS` lists the whole class names, because Tailwind only finds class names
  written out in the code.
- **The rules are a 1px gap on a `bg-line` card** (decision 36). With four cells two by two on a phone,
  `divide-x`/`divide-y` would draw a rule left of the first cell of the second row and none between the rows. The gap
  draws every rule, and `overflow-hidden` keeps the cells' corners inside the card's radius.
- **`content-start`** keeps each cell's lines at the top when a neighbour has more lines (the margin has three).
- `KpiCell` and `KpiChange` are exported, so the page builds its cells with the component's own types.

#### `components/empty-state.tsx` and `index.ts`

```diff
@@ -1,18 +1,28 @@
 import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
 import type { ReactNode } from 'react';
 
+import { cn } from '../lib/cn.js';
+
 interface EmptyStateProps {
   icon: IconSvgElement;
   title: string;
   // কী করলে এখানে ডেটা আসবে — আসল উদাহরণ দিয়ে (buyer PO, LC), lorem ipsum না
   description: string;
   action?: ReactNode;
+  // Step 21a: crit for a page that could not load its data (the Overview's "Couldn't load"), so it
+  // does not look like an empty list; brand otherwise
+  tone?: 'brand' | 'crit';
 }
 
-export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
+export function EmptyState({ icon, title, description, action, tone = 'brand' }: EmptyStateProps) {
   return (
     <div className="grid justify-items-center px-6 py-10 text-center">
-      <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
+      <span
+        className={cn(
+          'grid size-10 place-items-center rounded-lg',
+          tone === 'crit' ? 'bg-crit-bg text-crit' : 'bg-brand-soft text-brand',
+        )}
+      >
         <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
       </span>
       <h3 className="mt-3 text-h3">{title}</h3>
```

```diff
@@ -46,7 +46,8 @@ export {
 } from './components/field.js';
 export { FormAlert } from './components/form-alert.js';
 export { FormField, type FormFieldControlProps } from './components/form-field.js';
-export { KpiStrip } from './components/kpi-strip.js';
+export { type KpiCell, type KpiChange, KpiStrip } from './components/kpi-strip.js';
+export { LineChart, type LineChartPoint } from './components/line-chart.js';
 export { Logo } from './components/logo.js';
 export { MoneyInput } from './components/money-input.js';
 export { PageHeader, SectionHeader } from './components/page-header.js';
```

`tone="crit"` is for "Couldn't load" (decision 44): a failed load must not look like an empty list. Every other empty
state keeps the `brand` tile. The index exports the chart and the strip's types; `niceTicks` stays inside the package.

### `packages/i18n`: two formatters

```diff
@@ -114,6 +114,15 @@ export function formatDate(date: Date, language: Language): string {
   return `${part('day')} ${part('month')} ${part('year')}`;
 }
 
+// Step 21a: the day without its year, "29 Oct" / "২৯ অক্টো", for a chart's axis, where the year
+// is in the chart's name. The same parts as formatDate.
+export function formatDayMonth(date: Date, language: Language): string {
+  const parts = (language === 'bn' ? BN_DATE : EN_DATE).formatToParts(date);
+  const part = (type: Intl.DateTimeFormatPartTypes): string =>
+    parts.find((p) => p.type === type)?.value ?? '';
+  return `${part('day')} ${part('month')}`;
+}
+
 // পিরিয়ড (মাস): "September 2026" / "সেপ্টেম্বর ২০২৬"
 const MONTH = {
   en: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }),
@@ -156,6 +165,15 @@ export function formatDateTime(date: Date, language: Language, timeZone: string)
   return `${day} ${part('year')}, ${part('hour')}:${part('minute')}`;
 }
 
+// Step 21a: the time alone, "10:42" / "১০:৪২", in the workspace's time zone like formatDateTime.
+// The Overview's "As of 10:42" for numbers made today.
+export function formatTime(date: Date, language: Language, timeZone: string): string {
+  const parts = dateTimeFormat(language, timeZone).formatToParts(date);
+  const part = (type: Intl.DateTimeFormatPartTypes): string =>
+    parts.find((p) => p.type === type)?.value ?? '';
+  return `${part('hour')}:${part('minute')}`;
+}
+
 const MONTH_NAME = {
   en: new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }),
   bn: new Intl.DateTimeFormat('bn-BD', { month: 'long', timeZone: 'UTC' }),
```

```diff
@@ -5,10 +5,12 @@ import {
   formatBytes,
   formatDate,
   formatDateTime,
+  formatDayMonth,
   formatMoney,
   formatMonth,
   formatMonthName,
   formatNumber,
+  formatTime,
   type MoneyFormatOptions,
 } from './format.js';
 import { isLanguage, type Language } from './i18n.js';
@@ -36,8 +38,10 @@ export function useLocale() {
       number: (value: number | string, decimals?: number) =>
         formatNumber(value, language, decimals),
       date: (date: Date) => formatDate(date, language),
+      dayMonth: (date: Date) => formatDayMonth(date, language),
       month: (date: Date) => formatMonth(date, language),
       dateTime: (date: Date, timeZone: string) => formatDateTime(date, language, timeZone),
+      time: (date: Date, timeZone: string) => formatTime(date, language, timeZone),
       monthName: (month: number) => formatMonthName(month, language),
       bytes: (bytes: number) => formatBytes(bytes, language),
     }),
```

```diff
@@ -5,10 +5,12 @@ export {
   formatBytes,
   formatDate,
   formatDateTime,
+  formatDayMonth,
   formatMoney,
   formatMonth,
   formatMonthName,
   formatNumber,
+  formatTime,
   isDecimalString,
   type MoneyFormatOptions,
 } from './format.js';
```

```diff
@@ -4,10 +4,12 @@ import {
   formatBytes,
   formatDate,
   formatDateTime,
+  formatDayMonth,
   formatMoney,
   formatMonth,
   formatMonthName,
   formatNumber,
+  formatTime,
 } from './format.js';
 
 describe('formatMoney', () => {
@@ -69,6 +71,23 @@ describe('formatDateTime', () => {
   });
 });
 
+describe('formatDayMonth', () => {
+  it('leaves the year out, in both languages', () => {
+    expect(formatDayMonth(new Date(2026, 9, 29), 'en')).toBe('29 Oct');
+    expect(formatDayMonth(new Date(2026, 9, 29), 'bn')).toBe('২৯ অক্টো');
+  });
+});
+
+describe('formatTime', () => {
+  it("shows only the hour and minute, in the workspace's time zone", () => {
+    const moment = new Date('2026-09-23T04:42:00Z');
+    expect(formatTime(moment, 'en', 'Asia/Dhaka')).toBe('10:42');
+    expect(formatTime(moment, 'bn', 'Asia/Dhaka')).toBe('১০:৪২');
+    // h23: midnight is 00, not 24
+    expect(formatTime(new Date('2026-09-23T18:00:00Z'), 'en', 'Asia/Dhaka')).toBe('00:00');
+  });
+});
+
 describe('formatMonthName', () => {
   it('names the month in both languages', () => {
     expect(formatMonthName(7, 'en')).toBe('July');
```

- **`formatTime()` is "10:42", in the workspace's time zone** (decision 42), with the same cached `Intl` format as
  `formatDateTime()`, so the two never disagree on the hour. `h23` makes midnight "00:00", not "24:00".
- **`formatDayMonth()` is "29 Oct" / "২৯ অক্টো",** the parts of `formatDate()` without the year: the chart's axis has
  room for no more, and the chart's name says the year.
- Both go into `useLocale().format`, the one way pages write dates (CLAUDE.md → Language).

The page's words are in 21a.5's diffs of `en.ts` and `bn.ts` above, with the changes this part made there: the old
card's three keys gone and `loadFailedTitle` added (decision 44).

### `packages/sync`: the kept answer

#### `dashboard.ts` (new)

```ts
import type { Dashboard } from '@omnivo/contracts';

import type { LocalCopy } from './copy.js';
import type { KeptDashboard } from './database.js';

// Step 21a (decision 7): the Overview's last answer, kept on the device so the page still shows
// numbers offline, with "As of 10:42". One row: the answer the page showed last, whatever branch it
// was for. Sealed like every row (the sealed-copy rule): cash, dues and sales are the business's
// most private numbers. Type imports only, like carts.ts: the Overview's chunk loads no Dexie.

const KEY = 'dashboard';

// branchName: the branch the answer is for, as the select named it ("MIR · Mirpur store"). Offline
// the page cannot ask the server for the branches, and the select must still say whose numbers
// these are. null = every branch.
export async function keepDashboard(
  copy: LocalCopy,
  dashboard: Dashboard,
  branchName: string | null,
): Promise<void> {
  const kept: KeptDashboard = { dashboard, branchName };
  await copy.db.dashboard.put({ key: KEY, box: await copy.seal('dashboard', KEY, kept) });
}

// null = nothing kept yet (a device that was never online on the Overview), or a row that does not
// open. A row that does not open was changed on the disk (crypto.ts): the next answer online
// replaces it, and until then the page says it has nothing, which is true.
export async function keptDashboard(copy: LocalCopy): Promise<KeptDashboard | null> {
  const row = await copy.db.dashboard.get(KEY);
  if (!row) return null;
  try {
    return await copy.open('dashboard', KEY, row.box);
  } catch {
    return null;
  }
}
```

- **One row, the answer the page showed last** (decision 37). Decision 7 asks for the last answer, not one per
  branch: offline the person sees what they saw last, and the select says whose numbers they are.
- **Sealed under the table and the key** (`'dashboard'`, `'dashboard'`), like every row on the device (CLAUDE.md →
  The device's copy is sealed): cash, dues and margin are the most private numbers a business has. Only the key is
  clear.
- **`branchName` is kept with the answer:** offline the page cannot ask the server for the branches, and the disabled
  select must still name the branch.
- **A row that does not open is "nothing kept",** not an error: it was changed on the disk (AES-GCM's check failed).
  The page then says "Needs a connection", which is true, and the next answer online replaces the row. An error here
  would leave the page loading forever (`useLocalQuery` keeps its last answer when a read fails).
- **Type imports only,** like `carts.ts`: the Overview's chunk calls `copy.seal()` and `copy.db.dashboard`, methods of
  the copy the session opened, and loads no Dexie of its own.

#### `database.ts` and `index.ts`

```diff
@@ -1,5 +1,6 @@
 import type {
   CashCount,
+  Dashboard,
   Product,
   ShiftCash,
   SyncCategory,
@@ -274,6 +275,19 @@ export interface CartRow {
   box: Box<HeldCart>;
 }
 
+// Step 21a: the Overview's last answer (dashboard.ts), one row under the key 'dashboard'. Nothing
+// but the key is clear.
+export interface KeptDashboard {
+  dashboard: Dashboard;
+  // The branch the answer is for, as the page's select named it; null = every branch
+  branchName: string | null;
+}
+
+export interface DashboardRow {
+  key: 'dashboard';
+  box: Box<KeptDashboard>;
+}
+
 // The tables, by entity. The names are the ones the app reads (db.products, db.customers).
 export const TABLE_OF = {
   settings: 'settings',
@@ -355,6 +369,8 @@ export class SyncDatabase extends Dexie {
   posCarts!: Table<CartRow, string>;
   // Step 20c: the register's recent sales (PosSaleRow)
   posSales!: Table<PosSaleRow, string>;
+  // Step 21a: the Overview's last answer (DashboardRow)
+  dashboard!: Table<DashboardRow, string>;
 
   constructor(name: string) {
     super(name);
@@ -442,6 +458,11 @@ export class SyncDatabase extends Dexie {
     this.version(6).stores({
       posSales: 'key, gen, number, date',
     });
+    // Step 21a: the Overview's last answer. No upgrade and no new SYNC_PROTOCOL: it is not a synced
+    // table (the pull never writes or sweeps it), and the page fills it the next time it is online.
+    this.version(7).stores({
+      dashboard: 'key',
+    });
   }
 
   // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
```

```diff
@@ -1,9 +1,9 @@
 // Two kinds of module. The pages of the app import the reads (queries, records, state, problems),
 // the outbox's saves (outbox, overlay, prices; step 18b), the key's code (crypto, keys; step 19b),
 // the POS's register and sale (pos; step 20a), its shift and carts (shift, carts; step 20b), its
-// returns (returns; step 20c) and the types: none of them loads Dexie at run time, so a page that
-// searches customers or a
-// form that saves offline stays small. The code that opens the database and syncs (database,
+// returns (returns; step 20c), the Overview's kept answer (dashboard; step 21a) and the types: none
+// of them loads Dexie at run time, so a page that searches customers or a form that saves offline
+// stays small. The code that opens the database and syncs (database,
 // copy, apply, push, engine, live, device) brings Dexie, and the app loads it once, lazily, after
 // sign-in. `sideEffects: false` in package.json lets the bundler leave out the modules a chunk
 // does not use.
@@ -25,12 +25,15 @@ export {
 } from './carts.js';
 export { LocalCopy, Mirror } from './copy.js';
 export { type Box, isPin, PIN_ITERATIONS, PIN_LENGTH } from './crypto.js';
+export { keepDashboard, keptDashboard } from './dashboard.js';
 export {
   type CartRow,
+  type DashboardRow,
   databaseName,
   deleteLocalDatabase,
   type DeviceShift,
   type HeldCart,
+  type KeptDashboard,
   type MirroredTable,
   type NoticeRow,
   type OutboxBody,
```

- **Version 7 adds the table and nothing else.** No upgrade function: the table starts empty and the page fills it the
  next time it is online. Not in `TABLE_OF`: the pull must never sweep it (a full pull deletes the rows of older
  generations in its tables), and it has no `gen`.
- **`SYNC_PROTOCOL` does not change:** nothing the server sends changed, so a device needs no full pull.

#### `dashboard.spec.ts` (new)

```ts
import 'fake-indexeddb/auto';

import { DASHBOARD_TREND_DAYS, type Dashboard } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { keepDashboard, keptDashboard } from './dashboard.js';
import { newCopy } from './test-fixtures.js';

const BRANCH = '01928c4e-7777-7000-8000-0000000000b1';

function answer(today: string): Dashboard {
  return {
    today,
    generatedAt: `${today}T04:42:00.000Z`,
    branchId: BRANCH,
    sales: {
      today: '184250.0000',
      yesterday: '163900.0000',
      monthToDate: '692400.0000',
      lastMonthToDate: '631800.0000',
      days: Array.from({ length: DASHBOARD_TREND_DAYS }, (_, index) => ({
        date: `2026-10-${String(index + 1).padStart(2, '0')}`,
        amount: '0.0000',
      })),
    },
    margin: null,
    cash: null,
    topProducts: null,
    receivables: { total: '486750.0000', overdue: '112400.0000', overdueCount: 7 },
    payables: null,
    lowStock: null,
  };
}

describe('the kept Overview (step 21a)', () => {
  it('has nothing before the page was ever online', async () => {
    expect(await keptDashboard(await newCopy())).toBeNull();
  });

  it('keeps the last answer, sealed, and gives it back with its branch', async () => {
    const copy = await newCopy();
    await keepDashboard(copy, answer('2026-11-03'), null);
    await keepDashboard(copy, answer('2026-11-04'), 'MIR · Mirpur store');

    expect(await keptDashboard(copy)).toEqual({
      dashboard: answer('2026-11-04'),
      branchName: 'MIR · Mirpur store',
    });
    // One row, and only its key is clear: the numbers and the branch's name are in the box
    const rows = await copy.db.dashboard.toArray();
    expect(rows.map((row) => Object.keys(row).sort())).toEqual([['box', 'key']]);
    const clear = new TextDecoder().decode(rows[0]?.box);
    expect(clear).not.toContain('486750');
    expect(clear).not.toContain('Mirpur');
  });

  it('treats a row changed on the disk as nothing kept', async () => {
    const copy = await newCopy();
    await keepDashboard(copy, answer('2026-11-04'), null);
    const row = await copy.db.dashboard.get('dashboard');
    if (!row) throw new Error('No row');
    // One byte of the sealed body changed: AES-GCM's check fails, so the box does not open
    const changed = row.box.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    await copy.db.dashboard.put({ key: 'dashboard', box: changed });

    expect(await keptDashboard(copy)).toBeNull();
  });
});
```

- **Nothing kept** before the page was ever online: `null`, which the page shows as "Needs a connection".
- **The last answer wins,** with its branch, and the row has only `key` and `box`. The test decodes the box's bytes as
  text and looks for an amount and the branch's name: neither is there.
- **One changed byte** makes the box not open, and the read gives `null` instead of throwing.

### `apps/app`: the Overview

#### `lib/dashboard.ts` (new): the page's rules

```ts
import {
  absMoney,
  changePercent,
  type Dashboard,
  type DashboardCard,
  isNegativeMoney,
  isZeroMoney,
  percentOfWhole,
  subtractMoney,
  todayIn,
} from '@omnivo/contracts';

// Step 21a: what the Overview works out from the answer before it writes anything. Pure, so the
// rules are tested without a page.

// The cards a branch changes (decision 11). With none of them, the branch select would change
// nothing on the page, so it is not shown.
export const BRANCH_CARDS: readonly DashboardCard[] = ['sales', 'margin', 'topProducts'];

// A sales change line. `percent` has no sign: the words say "more" or "less" (dashboard.sales.*).
// none = nothing to compare with (no sales yesterday): no percent at all (decision 20).
export type SalesChange =
  { kind: 'more' | 'less'; percent: string } | { kind: 'same' } | { kind: 'none' };

export function salesChange(current: string, previous: string): SalesChange {
  const percent = changePercent(current, previous);
  if (percent === null) return { kind: 'none' };
  // "0.0" and "-0.0" (a change smaller than 0.05%) both read "The same as yesterday"
  if (isZeroMoney(percent)) return { kind: 'same' };
  // The sign is cut off, not absMoney(): that writes 4 decimals, and a percent keeps its one
  return percent.startsWith('-')
    ? { kind: 'less', percent: percent.slice(1) }
    : { kind: 'more', percent };
}

// The cash's change line against the end of yesterday (decision 21). `amount` has no sign either.
export type CashChange = { kind: 'up' | 'down'; amount: string } | { kind: 'same' };

export function cashChange(cash: NonNullable<Dashboard['cash']>): CashChange {
  const change = subtractMoney(cash.total, cash.yesterday);
  if (isZeroMoney(change)) return { kind: 'same' };
  return { kind: isNegativeMoney(change) ? 'down' : 'up', amount: absMoney(change) };
}

// The width of a top product's bar: its share of the first one's amount, as a CSS percent. The
// first is the largest (the API's order), so every bar fits; one below zero (more taken off than
// sold is not possible, but a bar must never point backwards) is empty.
export function barWidth(amount: string, largest: string): string {
  if (isZeroMoney(largest) || isNegativeMoney(amount)) return '0%';
  return `${percentOfWhole(amount, largest)}%`;
}

// Whether every day of the chart is zero: then the card says so instead of a flat line
export function nothingSold(days: readonly { amount: string }[]): boolean {
  return days.every((day) => isZeroMoney(day.amount));
}

// "As of 10:42" for an answer made today in the workspace, the date and time before that: a
// device offline over a weekend must not say "As of 10:42" for Friday's numbers.
export function madeToday(generatedAt: string, timeZone: string, now: Date = new Date()): boolean {
  return todayIn(timeZone, new Date(generatedAt)) === todayIn(timeZone, now);
}
```

- **`BRANCH_CARDS`** are the cards a branch changes (decision 11). The page shows the branch select only when the
  person sees one of them (decision 39).
- **`salesChange()` gives the words, not a signed number.** The percent comes from `changePercent()` (21a.1) with one
  decimal; its sign is cut off and becomes "more" or "less", so the screen never shows "-12.5%" and a screen reader
  hears words. A change that rounds to 0.0% (or −0.0%) is "The same as yesterday". The sign is cut from the string,
  not with `absMoney()`, which writes 4 decimals ("11.0000").
- **`cashChange()` is against the end of yesterday** (decision 21), in taka, not a percent.
- **`barWidth()` is a CSS percent from strings** (`percentOfWhole()`), so the bars need no number either. The first
  product is the largest (the API's order), so every bar fits; one below zero or a largest of zero gives an empty bar.
- **`nothingSold()`:** with 30 zero days the card says so in words instead of drawing a flat line on ৳0.
- **`madeToday()` compares days in the workspace's time zone** (decision 42): 00:30 in Dhaka on 4 Nov is still 3 Nov
  in UTC, and must say "As of 00:30". `now` is a parameter so the test does not depend on the clock.

```ts
import { describe, expect, it } from 'vitest';

import { barWidth, cashChange, madeToday, nothingSold, salesChange } from './dashboard';

describe('salesChange', () => {
  it('says more or less with the percent without its sign', () => {
    expect(salesChange('184250.0000', '163900.0000')).toEqual({ kind: 'more', percent: '12.4' });
    expect(salesChange('163900.0000', '184250.0000')).toEqual({ kind: 'less', percent: '11.0' });
  });

  it('gives no percent when there is nothing to compare with', () => {
    expect(salesChange('5000.0000', '0.0000')).toEqual({ kind: 'none' });
  });

  it('calls a change that rounds to 0.0% the same', () => {
    expect(salesChange('100000.0000', '100000.0000')).toEqual({ kind: 'same' });
    // −0.01% rounds to "-0.0"
    expect(salesChange('99990.0000', '100000.0000')).toEqual({ kind: 'same' });
  });
});

describe('cashChange', () => {
  it('compares with the end of yesterday', () => {
    expect(cashChange({ accounts: [], total: '1462580.0000', yesterday: '1366180.0000' })).toEqual({
      kind: 'up',
      amount: '96400.0000',
    });
    expect(cashChange({ accounts: [], total: '100.0000', yesterday: '350.0000' })).toEqual({
      kind: 'down',
      amount: '250.0000',
    });
    expect(cashChange({ accounts: [], total: '100.0000', yesterday: '100.0000' })).toEqual({
      kind: 'same',
    });
  });
});

describe('barWidth', () => {
  it('is the share of the largest amount, and never below zero', () => {
    expect(barWidth('362560.0000', '362560.0000')).toBe('100.0%');
    expect(barWidth('122400.0000', '362560.0000')).toBe('33.8%');
    expect(barWidth('-10.0000', '362560.0000')).toBe('0%');
    expect(barWidth('0.0000', '0.0000')).toBe('0%');
  });
});

describe('nothingSold', () => {
  it('is true only when every day is zero', () => {
    expect(nothingSold([{ amount: '0.0000' }, { amount: '0.0000' }])).toBe(true);
    expect(nothingSold([{ amount: '0.0000' }, { amount: '-20.0000' }])).toBe(false);
  });
});

describe('madeToday', () => {
  it("compares the days in the workspace's time zone", () => {
    const now = new Date('2026-11-04T05:00:00Z');
    // 4 Nov, 10:42 in Dhaka
    expect(madeToday('2026-11-04T04:42:00.000Z', 'Asia/Dhaka', now)).toBe(true);
    // 3 Nov, 23:30 in Dhaka: yesterday in the workspace
    expect(madeToday('2026-11-03T17:30:00.000Z', 'Asia/Dhaka', now)).toBe(false);
    // 4 Nov 00:30 in Dhaka is 3 Nov in UTC: still today in the workspace
    expect(madeToday('2026-11-03T18:30:00.000Z', 'Asia/Dhaka', now)).toBe(true);
  });
});
```

#### `lib/queries.ts`

```diff
@@ -9,6 +9,7 @@ import {
   type DebitNoteStatus,
   type CustomerSort,
   type CustomerStatus,
+  type DashboardQuery,
   type DeliveryInvoiceFilter,
   type DeviceSort,
   type DeviceStatus,
@@ -288,6 +289,18 @@ export function profitAndLossQuery(tenantId: string, query: ProfitAndLossQuery)
   });
 }
 
+// Step 21a: the Overview. Under ['journal', tenant] like the reports: posting an invoice, a bill or
+// a payment invalidates the books, and the Overview's numbers come from them, so they are fetched
+// again at once instead of at the next minute. keepPreviousData: a new branch shows the last
+// numbers until its own arrive, not an empty page.
+export function dashboardQuery(tenantId: string, query: DashboardQuery) {
+  return queryOptions({
+    queryKey: ['journal', tenantId, 'dashboard', query],
+    queryFn: () => call(routes.dashboard.get, { query }),
+    placeholderData: keepPreviousData,
+  });
+}
+
 export function balanceSheetQuery(tenantId: string, query: BalanceSheetQuery) {
   return queryOptions({
     queryKey: ['journal', tenantId, 'balance-sheet', query],
```

- **Under `['journal', tenant]`** (decision 40), like the reports: every posting invalidates that key, so after an
  invoice is posted the Overview is fetched again at once, not at the next minute.
- **The query object is in the key:** `{}` for every branch, `{ branchId }` for one, so each branch has its own cached
  answer and switching back is instant.
- **`keepPreviousData`:** while a new branch loads, the page keeps the last numbers on screen instead of an empty page.
  Decision 41 stops those from being kept on the device.

#### `routes/dashboard.tsx`: the page

The whole file is new; it replaces the old card.

```tsx
import {
  Alert02Icon,
  Analytics01Icon,
  Building03Icon,
  ChartLineData01Icon,
  PackageOutOfStockIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  absMoney,
  type Dashboard,
  type DashboardCard,
  type DashboardDues,
  type DashboardQuery,
  dashboardCardsFor,
  dashboardPeriods,
  isNegativeMoney,
  marginPercent,
  subtractMoney,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { keepDashboard, keptDashboard } from '@omnivo/sync';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  type KpiCell,
  KpiStrip,
  LineChart,
  PageHeader,
  parseIsoDate,
  Pill,
  SelectField,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { DocumentNotice } from '../components/document-notice';
import {
  BRANCH_CARDS,
  barWidth,
  cashChange,
  madeToday,
  nothingSold,
  salesChange,
} from '../lib/dashboard';
import { useLocalCopy, useLocalQuery } from '../lib/local-data';
import { branchesQuery, dashboardQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 21a: the Overview. One answer from GET /dashboard (decision 13), asked again every minute
// while the page is open; offline, the last answer this device kept (decision 7). A card shows
// when the answer has it and the person's permissions allow it now: a kept answer may be from
// before a role change. Amounts are whole taka (CLAUDE.md → Money: dashboards stay without
// decimals), so format.money() is called without decimals everywhere here.

// "Paracetamol 500 mg · Strip of 10": the product and its option values (lib/stock.ts has the same
// rule, but importing it would bring the stock pages' helpers into this chunk)
function itemName(item: { productName: string; optionValues: readonly string[] }): string {
  return item.optionValues.length === 0
    ? item.productName
    : `${item.productName} · ${item.optionValues.join(' / ')}`;
}

function isoDate(iso: string): Date {
  return parseIsoDate(iso) ?? new Date();
}
```

- **No import from the stock pages' files:** `lib/stock.ts` has the same `variantName()`, but it brings the stock
  pages' unit helpers with it. Two lines here keep the Overview's chunk small.
- **`isoDate()`** reads "2026-11-04" as a local date (`parseIsoDate`, never `new Date('2026-11-04')`, which is
  midnight UTC and the day before west of Greenwich). The fallback is only for the type: every date here comes from
  the contract's `z.iso.date()`.

```tsx
export function DashboardPage() {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const copy = useLocalCopy();

  const cards = useMemo(() => dashboardCardsFor(me?.permissions ?? []), [me]);
  const byBranch = cards.some((card) => BRANCH_CARDS.includes(card));

  // '' = every branch; the select's own empty value
  const [branchId, setBranchId] = useState('');
  const branches = useQuery({
    ...branchesQuery(tenantId, 'active'),
    enabled: online && byBranch,
  }).data;
  // An absent key, not `undefined` (exactOptionalPropertyTypes), and a short query key
  const query: DashboardQuery = branchId === '' ? {} : { branchId };
  const live = useQuery({
    ...dashboardQuery(tenantId, query),
    // A person with no card asks for nothing: the answer would be all nulls (decision 14)
    enabled: online && cards.length > 0,
    // Every minute while the page is open and its tab is seen: TanStack does not poll a hidden tab
    refetchInterval: 60_000,
  });
  // undefined while it is read, null = nothing kept on this device
  const kept = useLocalQuery(copy ? keptDashboard : null);

  // The branch of an answer as the select names it ("MIR · Mirpur store"), kept with the answer:
  // offline the branches cannot be asked for, and the select must still say whose numbers they are
  const answerBranch = live.data?.branchId ?? null;
  const keptName = useMemo(() => {
    const branch = branches?.find((candidate) => candidate.id === answerBranch);
    return branch ? `${branch.code} · ${branch.name}` : null;
  }, [branches, answerBranch]);

  // Each new answer replaces the kept one; the last branch's numbers, shown while another branch's
  // load (placeholder data), never do. A write that fails (the storage is full) leaves the older
  // copy: the page online does not need it, and the Sync page's storage card says what is wrong.
  const fresh = live.isPlaceholderData ? undefined : live.data;
  useEffect(() => {
    if (!copy || !fresh) return;
    keepDashboard(copy, fresh, keptName).catch(() => undefined);
  }, [copy, fresh, keptName]);

  // Online: the live answer, null when it failed. Offline: the kept one, or the live one still in
  // memory on a device that keeps nothing (its copy is not set up). undefined = still reading.
  const answer: Dashboard | null | undefined = online
    ? (live.data ?? (live.isError ? null : undefined))
    : copy && kept === undefined
      ? undefined
      : (kept?.dashboard ?? live.data ?? null);
  const offlineBranch = !online && kept && kept.dashboard === answer ? kept.branchName : null;

  const asOf =
    !online && answer
      ? t('dashboard.asOf', {
          time: madeToday(answer.generatedAt, timeZone)
            ? format.time(new Date(answer.generatedAt), timeZone)
            : format.dateTime(new Date(answer.generatedAt), timeZone),
        })
      : null;
  // The workspace's today: the answer's, else the device's clock in the workspace's time zone
  const description = [
    me?.tenant.name,
    format.date(isoDate(answer?.today ?? todayIn(timeZone))),
    asOf,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(' · ');

  // Online with more than one branch. Offline only for a kept answer of one branch, to say so: the
  // select cannot change while offline (decision 7 keeps one answer).
  const showBranch = byBranch && (online ? (branches?.length ?? 0) > 1 : offlineBranch !== null);
```

- **`cards` comes from `dashboardCardsFor()`,** the one list of who sees what (decision 14), with the permissions of
  now (decision 38). With none, no request is sent (`enabled`): the answer would be all nulls.
- **The branches are asked for only online and only with a card a branch changes.** A store keeper's Overview sends one
  request less.
- **`refetchInterval: 60_000`** is the "every minute" of decision 40. TanStack stops it while the tab is hidden, and
  `enabled: online` stops it offline.
- **`useLocalQuery(copy ? keptDashboard : null)`** reads the kept answer and reads it again whenever the table
  changes (a write in this tab or another). `keptDashboard` is a module function, so the read is stable and does not
  run on every render.
- **`keptName` is the select's own label for the answer's branch,** worked out from the answer (`live.data.branchId`),
  not from the select's value: during a switch the two differ.
- **The effect keeps each fresh answer** (decisions 37 and 41). `isPlaceholderData` is true while the last branch's
  numbers stand in for the new one's; those are not written. A failed write is ignored: the page online does not need
  it, and a full storage shows on the Sync page's storage card.
- **`answer` has three states:** `undefined` (still loading: the page shows only its header), `null` (online: the
  request failed; offline: nothing kept) and the answer. Offline it prefers the kept answer, which the effect wrote from
  the newest live one; the live one in memory is the fallback on a device with no copy (not set up).
- **The header's line is "Nabil Super Shop · 4 Nov 2026 · As of 17:42"** (decision 35). The date is the answer's
  `today` (the workspace's day when it was made), else today in the workspace's time zone; "As of" only offline, with
  the time alone for an answer made today (decision 42).

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('dashboard.title')}
        description={description}
        actions={
          showBranch && (
            <div className="w-full sm:w-72">
              <SelectField
                label={t('dashboard.branch')}
                icon={Building03Icon}
                hint={online ? t('dashboard.branchHint') : t('dashboard.branchOffline')}
                disabled={!online}
                value={online ? branchId : (answer?.branchId ?? '')}
                options={
                  online
                    ? [
                        { value: '', label: t('dashboard.allBranches') },
                        ...(branches ?? []).map((branch) => ({
                          value: branch.id,
                          label: `${branch.code} · ${branch.name}`,
                        })),
                      ]
                    : [{ value: answer?.branchId ?? '', label: offlineBranch ?? '' }]
                }
                onChange={(event) => {
                  setBranchId(event.target.value);
                }}
              />
            </div>
          )
        }
      />

      {cards.length === 0 ? (
        <Card>
          <EmptyState
            icon={Analytics01Icon}
            title={t('dashboard.noCardsTitle')}
            description={t('dashboard.noCardsBody')}
          />
        </Card>
      ) : answer === null ? (
        <Card>
          {online ? (
            <EmptyState
              tone="crit"
              icon={Alert02Icon}
              title={t('dashboard.loadFailedTitle')}
              description={t('dashboard.loadFailed')}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void live.refetch();
                  }}
                >
                  {t('common.retry')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={WifiDisconnected02Icon}
              title={t('sync.needsConnectionTitle')}
              description={t('dashboard.noCopyBody')}
            />
          )}
        </Card>
      ) : (
        answer && (
          <>
            {!online && (
              <DocumentNotice tone="neutral">{t('dashboard.offlineNotice')}</DocumentNotice>
            )}
            <Cards answer={answer} cards={cards} />
          </>
        )
      )}
    </div>
  );
}
```

- **The branch select is in the header's actions,** with its hint under it (`branchHint`; offline `branchOffline`).
  Offline it is disabled and has one option, the kept answer's branch; its value is the answer's branch, not the
  page's state, which a reload resets to "All branches".
- **The order of the states:** no card for the role (decision 14), then a failed or empty answer, then the cards.
  "Couldn't load" (online) has Retry, which calls `refetch()`; offline with nothing kept is "Needs a connection",
  the Sync page's title (21a.5).
- **Offline, the neutral document notice** (`DocumentNotice`) sits above the cards and says the numbers are the ones
  the device kept.

```tsx
// The cards the answer has and the person may see, in the mockup's three rows
function Cards({ answer, cards }: { answer: Dashboard; cards: readonly DashboardCard[] }) {
  const { t, format } = useLocale();
  const allowed = <T,>(card: DashboardCard, value: T | null): T | null =>
    cards.includes(card) ? value : null;
  const sales = allowed('sales', answer.sales);
  const margin = allowed('margin', answer.margin);
  const cash = allowed('cash', answer.cash);
  const topProducts = allowed('topProducts', answer.topProducts);
  const receivables = allowed('receivables', answer.receivables);
  const payables = allowed('payables', answer.payables);
  const lowStock = allowed('lowStock', answer.lowStock);

  // The days compared with: "1 – 4 Oct 2026", or one day on the 1st of the month (decision 17)
  const periods = dashboardPeriods(answer.today);
  const showDate = (iso: string) => format.date(isoDate(iso));
  const range =
    periods.lastMonthStart === periods.lastMonthEnd
      ? showDate(periods.lastMonthStart)
      : t('reports.range', {
          from: showDate(periods.lastMonthStart),
          to: showDate(periods.lastMonthEnd),
        });

  const cells: KpiCell[] = [];
  if (sales) {
    const day = salesChange(sales.today, sales.yesterday);
    const month = salesChange(sales.monthToDate, sales.lastMonthToDate);
    cells.push(
      {
        label: t('dashboard.sales.today'),
        value: format.money(sales.today),
        change:
          day.kind === 'none'
            ? { trend: 'flat', text: t('dashboard.sales.noYesterday') }
            : day.kind === 'same'
              ? { trend: 'flat', text: t('dashboard.sales.sameAsYesterday') }
              : {
                  trend: day.kind === 'more' ? 'up' : 'down',
                  text: t(
                    day.kind === 'more'
                      ? 'dashboard.sales.moreThanYesterday'
                      : 'dashboard.sales.lessThanYesterday',
                    { percent: format.number(day.percent, 1) },
                  ),
                },
      },
      {
        label: t('dashboard.sales.month'),
        value: format.money(sales.monthToDate),
        change:
          month.kind === 'none'
            ? { trend: 'flat', text: t('dashboard.sales.noLastMonth', { range }) }
            : month.kind === 'same'
              ? { trend: 'flat', text: t('dashboard.sales.sameAsLastMonth', { range }) }
              : {
                  trend: month.kind === 'more' ? 'up' : 'down',
                  text: t(
                    month.kind === 'more'
                      ? 'dashboard.sales.moreThanLastMonth'
                      : 'dashboard.sales.lessThanLastMonth',
                    { percent: format.number(month.percent, 1), range },
                  ),
                },
      },
    );
  }
  if (margin) {
    const now = marginPercent(margin.monthToDate);
    const before = marginPercent(margin.lastMonthToDate);
    cells.push({
      label: t('dashboard.margin.title'),
      value: now === null ? '—' : `${format.number(now, 1)}%`,
      sub:
        now === null
          ? t('dashboard.margin.noSales')
          : t('dashboard.margin.ofSales', {
              profit: format.money(
                subtractMoney(margin.monthToDate.sales, margin.monthToDate.cost),
              ),
              sales: format.money(margin.monthToDate.sales),
            }),
      // Only to compare with, so no arrow and no color: the words say no "more" or "less"
      change:
        before === null
          ? undefined
          : {
              trend: 'flat',
              text: t('dashboard.margin.lastMonth', { percent: format.number(before, 1), range }),
            },
    });
  }
  if (cash) {
    const change = cashChange(cash);
    cells.push({
      label: t('dashboard.cash.title'),
      value: format.money(cash.total),
      change:
        change.kind === 'same'
          ? { trend: 'flat', text: t('dashboard.cash.sameToday') }
          : {
              trend: change.kind,
              text: t(
                change.kind === 'up' ? 'dashboard.cash.upToday' : 'dashboard.cash.downToday',
                {
                  amount: format.money(change.amount),
                },
              ),
            },
    });
  }

  const dues = receivables !== null || payables !== null;

  return (
    <>
      {cells.length > 0 && <KpiStrip cells={cells} />}

      {/* Both need sales.report.read, so they come together */}
      {sales && topProducts && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <SalesTrend days={sales.days} />
          <TopProducts items={topProducts} />
        </div>
      )}

      {(cash !== null || lowStock !== null || dues) && (
        // auto-fit: a card alone takes the whole row (a store keeper sees only the low stock)
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-5">
          {cash && <CashCard cash={cash} />}
          {dues && (
            <Card className="grid content-start divide-y divide-line">
              {receivables && <DuesBlock kind="receivables" dues={receivables} />}
              {payables && <DuesBlock kind="payables" dues={payables} />}
            </Card>
          )}
          {lowStock && <LowStockCard lowStock={lowStock} />}
        </div>
      )}
    </>
  );
}
```

- **`allowed()` checks each card twice:** the answer has it (not null) and the person may see it now (decision 38).
- **`range` is the days compared with:** "1 – 4 Oct 2026" from `dashboardPeriods()` (decision 17), or one date on the
  1st of the month, where the range would be "1 – 1 Oct".
- **The strip's cells are built in the screen's order** (sales today, this month, margin, cash), each only when its
  card is there, so a person sees one to four cells and no empty ones.
- **The margin's value is "22.9%" with "৳1,58,300 on ৳6,92,400 of sales" under it,** and last month's margin as a
  `flat` line: it is there to compare with, and `margin.lastMonth` has no "more" or "less" (decision 35). With no
  sales this month the value is a dash and the line says so; there is no 0% margin of nothing.
- **The chart and the top products come together:** both need `sales.report.read`, so one without the other cannot
  happen.
- **The last row is `auto-fit` columns of at least 18rem** (`min(100%, 18rem)`, so a phone narrower than that does not
  scroll sideways). One card alone takes the whole row: a store keeper's low stock is a full-width list, not a third.
  The receivables and the payables share one card, as in the mockup.

```tsx
function SalesTrend({ days }: { days: NonNullable<Dashboard['sales']>['days'] }) {
  const { t, format } = useLocale();
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  return (
    <Card className="grid min-w-0 content-start gap-3 pb-4 lg:col-span-2">
      <CardHeader title={t('dashboard.trend.title')} subtitle={t('dashboard.trend.subtitle')} />
      <div className="px-5">
        {nothingSold(days) || first === undefined || last === undefined ? (
          <p className="grid h-[220px] place-items-center text-body-sm text-ink-3">
            {t('dashboard.trend.empty')}
          </p>
        ) : (
          <LineChart
            label={t('dashboard.trend.label', {
              from: format.date(isoDate(first)),
              to: format.date(isoDate(last)),
            })}
            points={days.map((day) => ({
              key: day.date,
              value: day.amount,
              label: format.date(isoDate(day.date)),
              axisLabel: format.dayMonth(isoDate(day.date)),
            }))}
            formatValue={(value) => format.money(value)}
          />
        )}
      </div>
    </Card>
  );
}
```

The chart card. Its name for a screen reader is `trend.label` with the first and last day; each point gets the
tooltip's date and the axis's shorter date. 30 days of zeros show `trend.empty` in the chart's place, at the chart's
height, so the card does not jump when the first sale comes.

```tsx
function TopProducts({ items }: { items: NonNullable<Dashboard['topProducts']> }) {
  const { t, format } = useLocale();
  const largest = items[0]?.amount ?? '0';
  return (
    <Card className="grid min-w-0 content-start">
      <CardHeader
        title={t('dashboard.topProducts.title')}
        subtitle={t('dashboard.topProducts.subtitle')}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={ChartLineData01Icon}
          title={t('dashboard.topProducts.emptyTitle')}
          description={t('dashboard.topProducts.emptyBody')}
        />
      ) : (
        <ol className="px-5 pt-1.5 pb-2">
          {items.map((item, index) => (
            <li
              key={item.variantId}
              className="grid gap-1.5 border-t border-line py-2.5 first:border-t-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-body-sm font-medium text-ink">{itemName(item)}</span>
                <span className="shrink-0 text-body-sm font-medium tabular-nums">
                  {format.money(item.amount)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 text-caption text-ink-3">
                <span className="font-mono">{item.sku}</span>
                <span className="tabular-nums">
                  {t('dashboard.topProducts.sold', {
                    quantity: `${format.number(item.quantity, item.baseUnit.decimals)} ${item.baseUnit.code}`,
                  })}
                </span>
              </div>
              {/* A magnitude bar (CLAUDE.md → Charts): brand for the first, brand-line after it */}
              <span aria-hidden="true" className="block h-1 rounded-full bg-subtle">
                <span
                  className={
                    index === 0
                      ? 'block h-1 rounded-full bg-brand'
                      : 'block h-1 rounded-full bg-brand-line'
                  }
                  style={{ width: barWidth(item.amount, largest) }}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
```

- **The quantity is written with the unit the answer carries** ("412 pcs", decision 19), with the unit's decimals, so
  it is right offline too, where the units cannot be looked up.
- **The bar is a magnitude bar** (CLAUDE.md → Charts): `brand` for the first product, `brand-line` for the others,
  `aria-hidden` because the amount is already written in the row.

```tsx
function CashCard({ cash }: { cash: NonNullable<Dashboard['cash']> }) {
  const { t, format } = useLocale();
  return (
    <Card className="grid min-w-0 grid-cols-1 grid-rows-[auto_1fr_auto] overflow-hidden">
      <CardHeader title={t('dashboard.cash.title')} subtitle={t('dashboard.cash.subtitle')} />
      {cash.accounts.length === 0 ? (
        <EmptyState
          icon={Building03Icon}
          title={t('dashboard.cash.emptyTitle')}
          description={t('dashboard.cash.emptyBody')}
        />
      ) : (
        <>
          <ul className="px-5 py-1.5">
            {cash.accounts.map((account) => (
              <li
                key={account.accountId}
                className="flex min-h-11 items-center gap-2.5 border-t border-line text-body-sm first:border-t-0"
              >
                <span className="font-mono text-caption text-ink-3 tabular-nums">
                  {account.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{account.name}</span>
                <span className="font-medium tabular-nums">{format.money(account.balance)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-line bg-subtle px-5 py-3 text-body-sm font-medium">
            <span>{t('reports.total')}</span>
            <span className="tabular-nums">{format.money(cash.total)}</span>
          </div>
        </>
      )}
    </Card>
  );
}
```

The accounts that hold money, the largest first (the API's order, decision 31), each with its code in `Geist Mono`;
then the total on `subtle`, like a statement's total row. With no money account, the empty state names the tick to set
in the chart of accounts.

`grid-cols-1` matters here (I found it in the browser in 21a.7, decision 48). A grid with no column of its own gets an
`auto` column, and an `auto` column is as wide as its widest content. The account name is `truncate`, which means it
never wraps, so its "widest" is the whole name: "Dutch-Bangla Bank CD A/C 1234" pushed the amounts out of the card,
where `overflow-hidden` cut them off. `grid-cols-1` is `minmax(0, 1fr)`: the column is the card's width, and the name
is cut short instead of the money. The low stock card below has the same rows and the same class.

```tsx
function DuesBlock({ kind, dues }: { kind: 'receivables' | 'payables'; dues: DashboardDues }) {
  const { t, format } = useLocale();
  return (
    <div className="grid content-start gap-2.5 px-5 py-[18px]">
      <div>
        <h3 className="text-h3">{t(`dashboard.${kind}.title`)}</h3>
        <p className="text-label text-ink-3">{t(`dashboard.${kind}.subtitle`)}</p>
      </div>
      <span className="text-kpi tracking-[-0.03em] tabular-nums">
        {/* Below zero: the advances are larger than what is owed (decision 22) */}
        {isNegativeMoney(dues.total)
          ? t(`dashboard.${kind}.advance`, { amount: format.money(absMoney(dues.total)) })
          : format.money(dues.total)}
      </span>
      {dues.overdueCount > 0 ? (
        <span className="flex items-center gap-1.5 text-label font-medium text-crit tabular-nums">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {t(`dashboard.${kind}.overdue`, {
            count: dues.overdueCount,
            formatted: format.number(dues.overdueCount),
            amount: format.money(dues.overdue),
          })}
        </span>
      ) : (
        <span className="text-label text-ink-3">{t(`dashboard.${kind}.nothingOverdue`)}</span>
      )}
      <Link
        to={kind === 'receivables' ? '/customers' : '/suppliers'}
        className="justify-self-start text-body-sm font-medium text-brand underline-offset-[3px] hover:underline"
      >
        {t(`dashboard.${kind}.link`)}
      </Link>
    </div>
  );
}
```

- **A total below zero is shown as an advance** ("৳20,000 in advance"): what customers paid ahead is larger than what
  they owe (decision 22). The amount is written without its minus; the words carry the sign.
- **Overdue is `crit` with an `Alert02` icon** and says how much and on how many documents; `count` picks the plural
  form and `formatted` writes the number in the page's digits. With nothing overdue, a quiet `ink-3` line.
- The link goes to the list of the rest: the customers or the suppliers.

```tsx
function LowStockCard({ lowStock }: { lowStock: NonNullable<Dashboard['lowStock']> }) {
  const { t, format } = useLocale();
  return (
    <Card className="grid min-w-0 grid-cols-1 grid-rows-[auto_1fr_auto]">
      <CardHeader
        title={t('dashboard.lowStock.title')}
        subtitle={t('dashboard.lowStock.subtitle')}
        actions={
          lowStock.count > 0 && (
            <Pill tone="warn" icon={PackageOutOfStockIcon}>
              {t('dashboard.lowStock.count', {
                count: lowStock.count,
                formatted: format.number(lowStock.count),
              })}
            </Pill>
          )
        }
      />
      {lowStock.items.length === 0 ? (
        <EmptyState
          icon={PackageOutOfStockIcon}
          title={t('dashboard.lowStock.emptyTitle')}
          description={t('dashboard.lowStock.emptyBody')}
        />
      ) : (
        <>
          <ul className="px-5 py-1.5">
            {lowStock.items.map((item) => (
              <li
                key={`${item.variantId}:${item.warehouseId}`}
                className="flex min-h-12 items-center gap-3 border-t border-line first:border-t-0"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium text-ink">
                    {itemName(item)}
                  </span>
                  <span className="truncate text-caption text-ink-3">{item.warehouseName}</span>
                </span>
                <span className="shrink-0 text-body-sm text-ink-2 tabular-nums">
                  {t('dashboard.lowStock.onHandOf', {
                    onHand: format.number(item.onHand, item.baseUnit.decimals),
                    level: `${format.number(item.minQuantity, item.baseUnit.decimals)} ${item.baseUnit.code}`,
                  })}
                </span>
              </li>
            ))}
          </ul>
          <Link
            to="/stock/reorder"
            className="justify-self-start px-5 pt-3 pb-4 text-body-sm font-medium text-brand underline-offset-[3px] hover:underline"
          >
            {t('dashboard.lowStock.link')}
          </Link>
        </>
      )}
    </Card>
  );
}
```

- **The count is a `warn` pill** with a package icon (decision 35): low stock is something the person must act on.
- **"6 of 40 pcs":** the number on hand alone, then the reorder level with its unit (`lowStock.onHandOf`, 21a.5).
- The key is the variant and the warehouse: the same product can be low in two warehouses.

#### `scripts/check-bundle-size.ts`

```diff
@@ -13,7 +13,9 @@ import { z } from 'zod';
 // the very first visit downloads them. Step 20a: 220 KB (you chose this). 20a's words (the
 // registers, the POS screen, its sales and the sold-short list) took it to 217.9 KB. Step 20b: 225 KB
 // (you chose this). 20b's words (the shift, the count, held bills, the shifts pages) took it to 222.0 KB.
-const INITIAL_BUDGET = 225 * 1024;
+// Step 21a: 230 KB (you chose this). The Overview's words and its contract took it to 225.7 KB; the
+// chart and the page are in the Overview's own lazy chunk.
+const INITIAL_BUDGET = 230 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
```

The initial bundle's budget goes to 230 KB (decision 45). The chart, the page and the kept answer's code are all in
the Overview's lazy chunk (65.5 KB of its 135 KB); I checked that the chunk and everything it imports contain no Dexie.

### What I checked

- **Type checks:** `@omnivo/ui`, `@omnivo/i18n`, `@omnivo/sync`, `@omnivo/app`, `@omnivo/api`.
- **Tests:** ui 22 (3 new: the gridlines), i18n 17 (2 new: `formatTime`, `formatDayMonth`), sync 118 (3 new: the kept
  answer), app 210 (7 new: `lib/dashboard.ts`).
- **ESLint and Prettier** on every file this part touched; `pnpm boundaries` (no violations).
- **The app's production build and `test:bundle-size`:** initial 225.7 KB of 230 KB; the Overview's chunk 65.5 KB.
- **In a browser:** in 21a.7, once the mock answers `/dashboard` (desktop, phone and offline, against the mockup).

### Check this part

```bash
pnpm --filter @omnivo/ui typecheck && pnpm --filter @omnivo/ui test && pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test && pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/sync typecheck && pnpm --filter @omnivo/sync test && pnpm --filter @omnivo/sync build
pnpm --filter @omnivo/app typecheck && pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
pnpm exec eslint packages/ui/src packages/i18n/src packages/sync/src apps/app/src/routes/dashboard.tsx apps/app/src/lib
pnpm exec prettier --check packages/ui/src packages/i18n/src packages/sync/src apps/app/src apps/app/scripts
pnpm boundaries
```

## 21a.7 — The mock and the Playwright tests

The Overview gets its answer in mock mode, so `pnpm dev:mock` and the Playwright tests can show it. The mock works the
numbers out from its own books (decision 46). A small role switch lets a test sign in as a store keeper (decision 47).
Then the tests: the cards, the strip on a phone, the branch, offline, the chart's keys, and two roles. Looking at the
page in the browser found one bug in 21a.6, the cash card's cut-off amounts (decision 48).

### `apps/app/src/mocks/dashboard-data.ts` (new): the answer on the mock's arrays

```ts
import {
  compareCodes,
  compareMoney,
  DASHBOARD_LOW_STOCK_ITEMS,
  DASHBOARD_TOP_PRODUCTS,
  DASHBOARD_TREND_DAYS,
  type Dashboard,
  type DashboardCard,
  type DashboardCash,
  type DashboardDues,
  type DashboardLowStock,
  type DashboardPeriods,
  type DashboardQuery,
  type DashboardTopProduct,
  dashboardPeriods,
  everyDay,
  isNegativeMoney,
  isZeroMoney,
  moneyAccountIds,
  percentOfWhole,
  subtractMoney,
  sumMoney,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';

import { dueOn as billDue } from './bill-data';
import { dueOn as invoiceDue } from './invoice-data';
import { isClosing } from './report-data';
import { findVariant, refOf, reorderReport } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// Step 21a: the Overview's answer on the mock's arrays. The API's rules (dashboard-queries.ts)
// written again, like the reports' (report-data.ts): the numbers come from the posted journal, so
// a sale posted in `pnpm dev:mock` or in a Playwright test shows on the Overview at once, as it
// does with the real server. The API reads the day totals table; the mock has no such table and
// adds the journal's lines up on every read (a few hundred lines).

interface Line {
  date: string;
  accountId: string;
  branchId: string | null;
  debit: string;
  credit: string;
  closing: boolean;
}

// Every line of a posted entry, with its entry's date. Closing entries are marked, not dropped:
// the sales leave them out (decision 25), the balances keep them.
function postedLines(data: WorkspaceData): Line[] {
  return data.journal.entries
    .filter((entry) => entry.status === 'posted')
    .flatMap((entry) => {
      const closing = isClosing(data, entry);
      return entry.lines.map((line) => ({
        date: entry.date,
        accountId: line.accountId,
        branchId: line.branchId,
        debit: line.debit,
        credit: line.credit,
        closing,
      }));
    });
}

function accountOf(data: WorkspaceData, purpose: string): string | null {
  return data.accounts.find((account) => account.purpose === purpose)?.id ?? null;
}

// debit − credit (or credit − debit) of the lines that pass `keep`
function sumSide(lines: readonly Line[], side: 'debit' | 'credit', keep: (line: Line) => boolean) {
  return sumMoney(
    lines
      .filter(keep)
      .map((line) =>
        side === 'debit'
          ? subtractMoney(line.debit, line.credit)
          : subtractMoney(line.credit, line.debit),
      ),
  );
}
```

- **The mock adds up the journal on every read.** The API reads `account_day_totals`; the mock has no such table, and
  it does not need one: its books are a few hundred lines. Reading the journal itself also means anything the tests
  post (an invoice, a POS sale) shows at once, with no second copy to keep in step.
- **Closing entries are marked, not dropped.** The sales leave them out (decision 25), but the cash and the dues are
  balances and keep every line. `isClosing()` is the reports' own rule (exported below), so the two mocks agree.
- **`sumSide()`** turns lines into one amount in the sign the card wants: debit − credit for cash and receivables,
  credit − debit for sales and payables. Every sum goes through `sumMoney()`: amounts stay decimal strings, never
  numbers.

```ts
// Sales and margin: the 'sales' account and the Sales returns account (decision 10), the cost of
// goods sold account, one branch or all, closing entries left out
function soldCards(
  data: WorkspaceData,
  lines: readonly Line[],
  periods: DashboardPeriods,
  branchId: string | null,
): Pick<Dashboard, 'sales' | 'margin'> {
  const salesIds = new Set(
    [accountOf(data, 'sales'), data.salesAccounts.returns].filter(
      (id): id is string => id !== null,
    ),
  );
  const costId = accountOf(data, 'cost_of_goods_sold');
  const sold = lines.filter(
    (line) => !line.closing && (branchId === null || line.branchId === branchId),
  );
  const between = (from: string, to: string) => (line: Line) =>
    line.date >= from && line.date <= to;
  const sales = (from: string, to: string) =>
    sumSide(sold, 'credit', (line) => salesIds.has(line.accountId) && between(from, to)(line));
  const cost = (from: string, to: string) =>
    sumSide(sold, 'debit', (line) => line.accountId === costId && between(from, to)(line));
  return {
    sales: {
      today: sales(periods.today, periods.today),
      yesterday: sales(periods.yesterday, periods.yesterday),
      monthToDate: sales(periods.monthStart, periods.today),
      lastMonthToDate: sales(periods.lastMonthStart, periods.lastMonthEnd),
      // The contract's days (everyDay, zeros), each given its own sum
      days: everyDay(periods.trendStart, DASHBOARD_TREND_DAYS, new Map()).map((day) => ({
        date: day.date,
        amount: sales(day.date, day.date),
      })),
    },
    margin: {
      monthToDate: {
        sales: sales(periods.monthStart, periods.today),
        cost: cost(periods.monthStart, periods.today),
      },
      lastMonthToDate: {
        sales: sales(periods.lastMonthStart, periods.lastMonthEnd),
        cost: cost(periods.lastMonthStart, periods.lastMonthEnd),
      },
    },
  };
}
```

- **The sales accounts are the `sales` purpose account plus the Sales returns account** of Settings → Sales, when one
  is chosen (decision 10). A return is a debit on it, so credit − debit gives the sales net of returns.
- **A branch filters the lines by their own branch.** A line with no branch is in no branch's sales, as in the API's
  `t.branch_id = $branch`.
- **The chart's days come from `everyDay()`,** the contract's own list of 30 days, and each day gets its own sum. A day
  with no sale is ৳0, so the chart has a point for every day, exactly as the API sends it.
- The margin repeats the sales of its periods next to the cost (the contract's shape), so `marginPercent()` on the
  page reads one object.

```ts
// Every active money account up to today, the largest first; an account with no lines at ৳0
function cashCard(data: WorkspaceData, lines: readonly Line[], today: string): DashboardCash {
  const money = moneyAccountIds(data.accounts);
  const accounts = data.accounts
    .filter((account) => money.has(account.id))
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      balance: sumSide(
        lines,
        'debit',
        (line) => line.accountId === account.id && line.date <= today,
      ),
    }))
    .sort((a, b) => compareMoney(b.balance, a.balance) || compareCodes(a.code, b.code));
  return {
    accounts,
    total: sumMoney(accounts.map((account) => account.balance)),
    yesterday: sumSide(lines, 'debit', (line) => money.has(line.accountId) && line.date < today),
  };
}

// A control account's balance up to today in its natural sign, and the documents past their due
// date with something still to pay
function duesCard(
  lines: readonly Line[],
  accountId: string | null,
  side: 'debit' | 'credit',
  today: string,
  open: readonly { status: string; dueDate: string; due: string }[],
): DashboardDues {
  const overdue = open.filter(
    (document) =>
      document.status === 'posted' && document.dueDate < today && !isZeroMoney(document.due),
  );
  return {
    total: sumSide(lines, side, (line) => line.accountId === accountId && line.date <= today),
    overdue: sumMoney(overdue.map((document) => document.due)),
    overdueCount: overdue.length,
  };
}
```

- **Cash uses `moneyAccountIds()`,** the contracts' rule that the receipt form and the API use too: active, not a
  group, and flagged to hold money (itself or under a flagged group). An account with no lines is still listed, at ৳0
  (decision 31). Lines dated after today are left out (decision 30).
- **"Yesterday" is every line before today,** so the change line says what came in or went out today.
- **Overdue reuses `dueOn()`** of the invoices' and the bills' mocks: what is still to pay after receipts, payments,
  credit notes and debit notes. Those mocks work it out on every read, like the API's joins.

```ts
function unitOf(data: WorkspaceData, unitId: string) {
  const unit = data.catalog.units.find((candidate) => candidate.id === unitId);
  return { code: unit?.code ?? '', decimals: unit?.decimals ?? 0 };
}

// Posted invoices' lines and POS sales' lines of the chart's days, before returns, by variant, the
// largest amount first. A POS sale's branch is its warehouse's (decision 33).
function topProducts(
  data: WorkspaceData,
  periods: DashboardPeriods,
  branchId: string | null,
): DashboardTopProduct[] {
  const inDays = (date: string) => date >= periods.trendStart && date <= periods.today;
  const branchOfWarehouse = new Map(
    data.stock.warehouses.map((place) => [place.id, place.branchId]),
  );
  const sold = [
    ...data.billing.invoices
      .filter(
        (invoice) =>
          invoice.status === 'posted' &&
          inDays(invoice.date) &&
          (branchId === null || invoice.branchId === branchId),
      )
      .flatMap((invoice) => invoice.lines),
    ...data.pos.sales
      .filter(
        (sale) =>
          inDays(sale.date) &&
          (branchId === null || branchOfWarehouse.get(sale.warehouseId) === branchId),
      )
      .flatMap((sale) => sale.lines),
  ];
  const byVariant = new Map<string, { quantities: string[]; amounts: string[] }>();
  for (const line of sold) {
    const found = byVariant.get(line.variantId) ?? { quantities: [], amounts: [] };
    found.quantities.push(line.baseQuantity);
    found.amounts.push(line.net);
    byVariant.set(line.variantId, found);
  }
  return [...byVariant]
    .flatMap(([variantId, totals]) => {
      // The product's name and unit as they are now, like the API's join
      const found = findVariant(data, variantId);
      if (!found) return [];
      return [
        {
          ...refOf(found.product, found.variant),
          baseUnit: unitOf(data, found.product.baseUnitId),
          quantity: sumQuantity(totals.quantities),
          amount: sumMoney(totals.amounts),
        },
      ];
    })
    .sort((a, b) => compareMoney(b.amount, a.amount) || a.variantId.localeCompare(b.variantId))
    .slice(0, DASHBOARD_TOP_PRODUCTS);
}
```

- **Top products read the lines of posted invoices and of POS sales** in the chart's days, before returns (decision
  18). A POS sale is filtered by its warehouse's branch, the API's rule (decision 33); an invoice by its own branch.
- **The name and the unit are the product's now** (`findVariant()` and `refOf()`), like the API's join: a product
  renamed last week shows with its new name.
- **The order is the amount, then the variant id,** so two products with the same amount never swap places on a
  reload.

```ts
// How empty a row is, to sort by: the share of its level on hand, as a percent with 1 decimal. The
// API divides exactly; the mock's rows never come within 0.1% of each other. A level of 0 has no
// share: below zero sorts as −100%, with the rows below zero, and empty as 0%.
function emptiness(row: { onHand: string; minQuantity: string }): string {
  if (isZeroMoney(row.minQuantity)) return isNegativeMoney(row.onHand) ? '-100.0' : '0.0';
  return percentOfWhole(row.onHand, row.minQuantity);
}

// The reorder report's rows of active warehouses and products, the emptiest first (decision 19)
function lowStockCard(data: WorkspaceData): DashboardLowStock {
  const places = new Map(data.stock.warehouses.map((place) => [place.id, place]));
  const rows = reorderReport(data, undefined).flatMap((row) => {
    const place = places.get(row.warehouseId);
    const found = findVariant(data, row.variantId);
    // An unknown or archived warehouse, product or variant is left out, as the API's joins do
    if (place?.archivedAt !== null || !found) return [];
    if (found.product.archivedAt !== null || found.variant.archivedAt !== null) return [];
    return [
      {
        ...row,
        warehouseName: place.name,
        baseUnit: unitOf(data, found.product.baseUnitId),
      },
    ];
  });
  // Then by the product's name, like the API's lower(p.name), so the order never changes on reload
  const name = (row: { productName: string }) => row.productName.toLowerCase();
  rows.sort(
    (a, b) =>
      compareMoney(emptiness(a), emptiness(b)) ||
      name(a).localeCompare(name(b)) ||
      a.variantId.localeCompare(b.variantId) ||
      a.warehouseId.localeCompare(b.warehouseId),
  );
  return { count: rows.length, items: rows.slice(0, DASHBOARD_LOW_STOCK_ITEMS) };
}
```

- **The rows are the reorder report's own** (`reorderReport()`, step 13), so the Overview and the reorder page always
  agree on what is low. Archived warehouses, products and variants are left out, as the API's joins do.
- **"Emptiest first" uses `percentOfWhole()`,** a percent with one decimal. The API divides exactly; a 0.1% step is
  enough for the mock's few rows. A level of 0 has no share, so `emptiness()` gives it −100% below zero and 0% when
  empty: the same place the API's `sign()` gives it.
- Then the product's name, lower case, like the API's `lower(p.name)`.

```ts
// The answer for the person's cards (dashboardCardsFor() of their permissions): a card they may
// not see is null, and its numbers are never worked out
export function dashboardOf(
  data: WorkspaceData,
  cards: readonly DashboardCard[],
  query: DashboardQuery,
): Dashboard {
  const today = todayIn(data.settings.timezone);
  const periods = dashboardPeriods(today);
  const branchId = query.branchId ?? null;
  const shows = (card: DashboardCard) => cards.includes(card);
  const lines = postedLines(data);
  const sold = shows('sales') || shows('margin') ? soldCards(data, lines, periods, branchId) : null;
  return {
    today,
    generatedAt: new Date().toISOString(),
    branchId,
    sales: shows('sales') ? (sold?.sales ?? null) : null,
    margin: shows('margin') ? (sold?.margin ?? null) : null,
    cash: shows('cash') ? cashCard(data, lines, today) : null,
    topProducts: shows('topProducts') ? topProducts(data, periods, branchId) : null,
    receivables: shows('receivables')
      ? duesCard(
          lines,
          accountOf(data, 'accounts_receivable'),
          'debit',
          today,
          data.billing.invoices.map((invoice) => ({
            status: invoice.status,
            dueDate: invoice.dueDate,
            due: invoiceDue(data, invoice),
          })),
        )
      : null,
    payables: shows('payables')
      ? duesCard(
          lines,
          accountOf(data, 'accounts_payable'),
          'credit',
          today,
          data.purchase.bills.map((bill) => ({
            status: bill.status,
            dueDate: bill.dueDate,
            due: billDue(data, bill),
          })),
        )
      : null,
    lowStock: shows('lowStock') ? lowStockCard(data) : null,
  };
}
```

- **A card the person may not see is `null` and its numbers are never worked out,** as in `DashboardService`. The
  caller passes the cards (`dashboardCardsFor()` of the person's permissions), so the role switch below changes the
  answer as well as the page.
- `today` is the workspace's today in its time zone (`todayIn()`), the API's rule: at 1 a.m. in Dhaka it is already
  the next day there, whatever the computer's clock says.

### `report-data.ts`: `isClosing()` exported

```diff
@@ -60,8 +60,9 @@ function postedLines(data: WorkspaceData): PostedLine[] {
     );
 }
 
-// A closing entry, or the reversal that reopened its year: not income or expense of any period
-function isClosing(data: WorkspaceData, entry: JournalEntry): boolean {
+// A closing entry, or the reversal that reopened its year: not income or expense of any period.
+// Step 21a: the dashboard's sales leave them out too (dashboard-data.ts).
+export function isClosing(data: WorkspaceData, entry: JournalEntry): boolean {
   if (entry.source === 'year_close') return true;
   const original = entry.reversalOf;
   return (
```

The reports' mock already knows which entries are a year-end close or its reversal. Exporting it keeps one rule for
both mocks.

### `fixtures.ts`: the role switch

```diff
@@ -4,6 +4,7 @@ import {
   type Preferences,
   type SetupStatus,
 } from '@omnivo/contracts';
+import { z } from 'zod';
 
 // আসল ইন্ডাস্ট্রির উদাহরণ (CLAUDE.md → Content): এক গার্মেন্টস আর এক ফার্মা, একই মালিক দুটোতে.
 // Step 18a: fixed ids, the same after every reload. The device's copy is kept per workspace and
@@ -37,17 +38,44 @@ export const OWNER = owner;
 // Owner = catalog-এর সব permission (আসল API-র মতো, কোড থেকে)
 export const OWNER_PERMISSIONS = [...PERMISSION_KEYS].sort();
 
+// Step 21a: the owner sees every card of the Overview, so a test of what a store keeper sees needs
+// someone else. A test leaves a role and its permissions in localStorage under this key before the
+// app starts (e2e/helpers.ts → actAs), and the mock's /me answers with them; the same person
+// signs in, only their role changes. The handlers run in the page, so they read the page's
+// storage. Mock mode only: nothing in the app reads this key.
+export const MOCK_ROLE_KEY = 'omnivo.mock.role';
+
+export const mockRoleSchema = z.object({
+  name: z.string(),
+  permissions: z.array(z.enum(PERMISSION_KEYS)),
+});
+export type MockRole = z.infer<typeof mockRoleSchema>;
+
+// The role a test left, or null for the owner. A key that does not parse is the owner too: a mock
+// must not break `pnpm dev:mock` over a stale key.
+export function mockRole(): MockRole | null {
+  try {
+    const saved = localStorage.getItem(MOCK_ROLE_KEY);
+    if (saved === null) return null;
+    const parsed = mockRoleSchema.safeParse(JSON.parse(saved));
+    return parsed.success ? parsed.data : null;
+  } catch {
+    return null;
+  }
+}
+
 export function meIn(
   workspace: Workspace,
   companyName: string,
   preferences: Preferences,
   setupStatus: SetupStatus,
 ): MeResponse {
+  const role = mockRole();
   return {
     user: owner,
     tenant: { id: workspace.tenantId, name: companyName, slug: workspace.slug, setupStatus },
-    roles: ['Owner'],
-    permissions: OWNER_PERMISSIONS,
+    roles: [role?.name ?? 'Owner'],
+    permissions: role ? [...role.permissions].sort() : OWNER_PERMISSIONS,
     memberships: [...WORKSPACES],
     preferences,
   };
```

- **Why `localStorage`:** MSW runs the handlers inside the page, so they can read the page's storage, and Playwright
  can write it before the app starts (`addInitScript`). No new route and no test-only code in the app.
- **The schema checks the permissions against `PERMISSION_KEYS`,** so a typo in a test ("inventory.reports.read")
  fails the type check, not silently at run time.
- **A key that does not parse is the owner,** and reading storage is in a `try`: a stale key must never break
  `pnpm dev:mock`.
- Only the role and the permissions change; the person is still Farhana Rahman. That is all the Overview needs, and
  the rest of the mock (the team, the audit log) stays as it was.

### `handlers.ts`: `GET /dashboard`

```diff
@@ -5,6 +5,7 @@ import {
   APPROVAL_DOCUMENTS,
   type AuthSession,
   compareQuantity,
+  dashboardCardsFor,
   type ErrorCode,
   type Preferences,
   type ProductCategory,
@@ -15,6 +16,7 @@ import {
 import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw';
 
 import { API_URL } from '../lib/api';
+import { dashboardOf } from './dashboard-data';
 import { meIn, OWNER, WORKSPACES, type Workspace } from './fixtures';
 import {
   allocateReceipt,
@@ -1477,6 +1479,19 @@ export const handlers = [
     ),
   ),
 
+  // Step 21a: the cards of the person signed in (me(): the owner, or the role a test left), the
+  // others null, like the API's DashboardService
+  mock(routes.dashboard.get, ({ request }) =>
+    reply(
+      routes.dashboard.get,
+      dashboardOf(
+        current(),
+        dashboardCardsFor(me().permissions),
+        readQuery(routes.dashboard.get.query, request),
+      ),
+    ),
+  ),
+
   mock(routes.fiscalYears.list, () => reply(routes.fiscalYears.list, fiscalYearsOf(current()))),
 
   mock(
```

The handler reads the query with the contract's schema (`readQuery`), as the API's pipe does, and answers through
`reply()`, which checks the answer against the contract. The cards come from `me().permissions`: the owner's, or the
role a test left.

### `offline-screens.ts`

```diff
@@ -39,6 +39,8 @@ const SCREENS = [
   // Step 20c: taking goods back works offline too, from the device's own sales (its refund rows
   // come with the payment's chunk as well)
   () => import('../components/pos-return'),
+  // Step 21a: the Overview shows the answer the device kept (decision 7), with its chart
+  () => import('../routes/dashboard'),
 ];
 
 // Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
```

Mock mode has no service worker of ours (step 19a, decision 11), so a chunk the browser never loaded cannot load
offline. The Overview works offline (decision 7), so its chunk is fetched at start like the other offline screens
(decision 49).

### `e2e/helpers.ts`: `actAs`

```diff
@@ -2,7 +2,13 @@ import { syncPullSchema } from '@omnivo/contracts';
 import { newDeviceId, saveDevice } from '@omnivo/sync';
 import { test as base, expect, type Locator, type Page, type Response } from '@playwright/test';
 
-import { HEAD_OFFICES, OWNER, WORKSPACES } from '../src/mocks/fixtures.js';
+import {
+  HEAD_OFFICES,
+  MOCK_ROLE_KEY,
+  type MockRole,
+  OWNER,
+  WORKSPACES,
+} from '../src/mocks/fixtures.js';
 
 export { expect };
 
@@ -140,3 +146,14 @@ export async function toastShown(
   await page.mouse.move(0, 0);
   await expect(page.getByText(text)).toBeHidden();
 }
+
+// Step 21a: the person signs in with this role, not as the owner (fixtures.ts → MOCK_ROLE_KEY).
+// Before the app starts, so the first /me already answers with it; call it before page.goto.
+export async function actAs(page: Page, role: MockRole): Promise<void> {
+  await page.addInitScript(
+    ([key, value]) => {
+      localStorage.setItem(key, value);
+    },
+    [MOCK_ROLE_KEY, JSON.stringify(role)] as const,
+  );
+}
```

`addInitScript` runs before any of the page's own scripts, on every load of that page, so the first `/me` already
answers with the role. It must be called before `page.goto`. The key and the type come from `fixtures.ts`, so the test
and the mock cannot disagree on the name.

### `e2e/dashboard.e2e.ts` (new)

```ts
import type { Locator, Page } from '@playwright/test';

import { actAs, expect, expectNoSideScroll, test, waitForCopy } from './helpers.js';

// Step 21a in the mock garments workspace. The mock works the Overview out from its own books
// (dashboard-data.ts). Its money accounts hold ৳48,19,000 (Dutch-Bangla Bank) and ৳31,549.50 (cash
// in hand); customers owe ৳63,00,000 (H&M and Primark), suppliers are owed ৳21,00,000; one reorder
// level is reached (the poly mailer bags at the Main store). The one sale of the last 30 days is
// the Primark export sale, booked at the Gazipur factory 3 days ago: nothing was sold at the
// Chattogram depot. The tests never read a number that depends on the day they run.

// A card, by its title. A card is a <section> with no name of its own, so it is found by its heading.
function card(page: Page, title: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

// A cell of the KPI strip, by its label (a <span>: "Cash and bank" is also the cash card's heading)
function kpi(page: Page, label: string): Locator {
  return page.locator('span', { hasText: new RegExp(`^${label}$`) }).locator('..');
}

async function openOverview(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}
```

- **The numbers do not depend on the day the tests run.** The mock's entries are dated "3 days ago", "15 days ago":
  "sales this month" changes at the start of a month, so no test reads it except at a branch with no sales (always
  ৳0). The cash, the dues and the low stock are the same on any day.
- **A card is found by its heading,** because a `<section>` with no name has no role to find it by.
- **A KPI cell is found by its `<span>` label:** "Cash and bank" is both a KPI label and the cash card's heading.

```ts
test('shows the cash, the dues and the low stock of the whole workspace', async ({ page }) => {
  await openOverview(page);
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');

  // Every account money is kept in, the largest first, in whole taka
  const cash = card(page, 'Cash and bank');
  await expect(cash.getByRole('listitem')).toHaveText([
    /1121\s*Dutch-Bangla Bank CD A\/C 1234\s*৳48,19,000/,
    /1110\s*Cash in hand\s*৳31,550/,
  ]);
  await expect(cash.getByText('৳48,50,550')).toBeVisible();
  // A long account name is cut short, never the amounts: the card's content fits inside it
  expect(await cash.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const dues = card(page, 'Customers owe');
  await expect(dues.getByText('৳63,00,000')).toBeVisible();
  await expect(dues.getByText('৳21,00,000')).toBeVisible();
  await expect(dues.getByText('Nothing overdue')).toHaveCount(2);

  const low = card(page, 'Low stock');
  await expect(low.getByText('1 item')).toBeVisible();
  await expect(low.getByRole('listitem')).toHaveText([
    /Poly mailer bag 10x14\s*Main store\s*3,000 of 4,000 pcs/,
  ]);
  await expectNoSideScroll(page);

  await low.getByRole('link', { name: 'See the reorder list' }).click();
  await expect(page).toHaveURL(/\/stock\/reorder$/);
});
```

- The cash rows are checked in order: the largest balance first (decision 31).
- **`scrollWidth <= clientWidth`** is the check for decision 48. The cut-off amounts were still in the page, so every
  text check passed while a person could not read them; this one fails when anything is pushed outside the card.

```ts
test('the strip is one row on a computer and two by two on a phone', async ({ page }, testInfo) => {
  await openOverview(page);
  // boundingBox() is no assertion, so the fixture does not answer the PIN dialog for it: measure
  // once the dialog is gone and the strip is drawn
  await waitForCopy(page);
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');
  const boxes = await Promise.all(
    ['Sales today', 'Sales this month', 'Gross margin this month', 'Cash and bank'].map(
      async (label) => {
        const box = await kpi(page, label).boundingBox();
        if (!box) throw new Error(`No KPI cell ${label}`);
        return box;
      },
    ),
  );
  const [today, month, margin, cashBox] = boxes;
  if (!today || !month || !margin || !cashBox) throw new Error('Four cells expected');
  expect(month.y).toBe(today.y);
  expect(cashBox.y).toBe(margin.y);
  if (testInfo.project.name === 'phone') {
    expect(margin.y).toBeGreaterThan(today.y);
    expect(margin.x).toBe(today.x);
  } else {
    expect(margin.y).toBe(today.y);
  }
});
```

- **`waitForCopy()` first:** the PIN dialog shows once the device's copy opens. The fixture answers it before any
  action or assertion, but `boundingBox()` is neither, so without the wait it hung behind the dialog in one run out of
  two.
- On a computer the four cells share one row; on a phone they are two by two (decision 36). The test reads the
  project's name, so one test covers both sizes.

```ts
test('a branch changes what was sold, never the cash', async ({ page }) => {
  await openOverview(page);
  const trend = card(page, 'Sales, last 30 days');
  const chart = trend.getByRole('group', { name: /^Sales of each day from / });
  // The whole workspace sold to Primark, so the chart is drawn
  await expect(chart).toBeVisible();

  const branch = page.getByLabel('Branch', { exact: true });
  await branch.selectOption({ label: 'CTG · Chattogram depot' });
  await expect(kpi(page, 'Sales this month')).toContainText('৳0');
  await expect(trend.getByText('Nothing sold in the last 30 days')).toBeVisible();
  await expect(
    card(page, 'Top products').getByText('Nothing sold in the last 30 days'),
  ).toBeVisible();
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');
  await expect(card(page, 'Customers owe').getByText('৳63,00,000')).toBeVisible();

  // The factory booked the sale
  await branch.selectOption({ label: 'GZP · Gazipur factory' });
  await expect(chart).toBeVisible();
});
```

The Chattogram depot sold nothing: its sales are ৳0 and the chart and the top products say so, but the cash and the
dues stay the whole workspace's (decision 11). The Gazipur factory booked the Primark sale, so its chart is drawn.

```ts
test('offline, it shows the numbers this device kept and when they were made', async ({ page }) => {
  await openOverview(page);
  await waitForCopy(page);
  await page
    .getByLabel('Branch', { exact: true })
    .selectOption({ label: 'CTG · Chattogram depot' });
  await expect(
    card(page, 'Sales, last 30 days').getByText('Nothing sold in the last 30 days'),
  ).toBeVisible();

  await page.context().setOffline(true);
  await expect(page.getByText(/· As of \d{1,2}:\d{2}/)).toBeVisible();
  await expect(
    page.getByText('You are offline, so these numbers are not live.', { exact: false }),
  ).toBeVisible();
  // The kept answer is the depot's: the select says so, and cannot change until the connection is back
  const branch = page.getByLabel('Branch', { exact: true });
  await expect(branch).toBeDisabled();
  await expect(branch.locator('option:checked')).toHaveText('CTG · Chattogram depot');
  await expect(page.getByText('Connect to the internet to see another branch.')).toBeVisible();
  await expect(kpi(page, 'Cash and bank')).toContainText('৳48,50,550');

  await page.context().setOffline(false);
  await expect(page.getByText(/As of/)).toBeHidden();
  await expect(branch).toBeEnabled();
});
```

- **A branch first, then offline.** Only a kept answer of one branch shows the select offline (decision 39), and only
  the kept row has the branch's name. So "the select says CTG, disabled" proves the page shows the device's copy, not
  the answer still in memory.
- **"As of 10:42"** is matched as a time, not a fixed text: the answer was made a second ago (decision 42).
- Back online, the notice goes and the select works again.

```ts
test('the sales chart walks the days with the arrow keys and says each one', async ({ page }) => {
  await openOverview(page);
  // The PIN dialog shows once the copy opens and takes the focus: wait for it to be answered first
  await waitForCopy(page);
  const chart = page.getByRole('group', { name: /^Sales of each day from / });
  await expect(chart).toBeVisible();
  // "Sales of each day from 6 Oct 2026 to 4 Nov 2026": the first and the last day, from the page
  const [, first, last] =
    /from (.+) to (.+)$/.exec((await chart.getAttribute('aria-label')) ?? '') ?? [];
  if (first === undefined || last === undefined) throw new Error('The chart names no days');
  const said = chart.locator('[aria-live]');

  // The focus starts on today, the end point
  await chart.focus();
  await expect(said).toHaveText(new RegExp(`^${last}: ৳`));
  await page.keyboard.press('Home');
  await expect(said).toHaveText(`${first}: ৳0`);
  await page.keyboard.press('ArrowRight');
  await expect(said).not.toHaveText(`${first}: ৳0`);
  await page.keyboard.press('End');
  await expect(said).toHaveText(new RegExp(`^${last}: ৳`));
});
```

- **The first and the last day are read from the chart's own name,** so the test does not work out dates itself.
- The focus starts on today (the end point); Home goes to the first day, which is always ৳0 here (the Primark sale is
  3 days old); End comes back. The live region is what a screen reader says (decision 43).
- `waitForCopy()` first for the same reason as above: the PIN dialog takes the focus away from the chart.

```ts
test('a store keeper sees only the low stock, across the whole row', async ({ page }) => {
  await actAs(page, {
    name: 'Store keeper',
    permissions: ['inventory.stock.adjust', 'inventory.stock.transfer', 'inventory.report.read'],
  });
  await openOverview(page);
  const low = card(page, 'Low stock');
  await expect(low.getByText('Poly mailer bag 10x14')).toBeVisible();
  // No sales, cash or dues, and no branch select: nothing on the page would change with it
  await expect(page.getByText('Sales today')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Cash and bank' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Customers owe' })).toHaveCount(0);
  await expect(page.getByLabel('Branch', { exact: true })).toHaveCount(0);

  // Alone in its row, the card is as wide as the row
  const [own, row] = await low.evaluate((element) => [
    element.getBoundingClientRect().width,
    element.parentElement?.getBoundingClientRect().width ?? 0,
  ]);
  expect(own).toBeCloseTo(row, 0);
});

test('a role with no card gets an empty state, not zeros', async ({ page }) => {
  await actAs(page, { name: 'Sales officer', permissions: ['sales.customer.manage'] });
  await openOverview(page);
  await expect(page.getByRole('heading', { name: 'No numbers for your role' })).toBeVisible();
  await expect(page.getByText('৳0')).toHaveCount(0);
});
```

- **The store keeper** has `inventory.report.read` and none of the other card permissions: only the low stock, no
  strip, no branch select (decision 39), and the card fills its row (`auto-fit`, decision 35).
- **A role with no card** gets the empty state, never a page of ৳0: zeros would say "you sold nothing", which is not
  true (decision 14).

### What I checked

- **In a browser** (desktop 1280 px, phone 390 px, online and offline) against the mockup: the layout, the strip two
  by two on the phone, "As of" and the notice offline. It found the cash card's cut-off amounts (decision 48).
- **Type checks and tests:** `@omnivo/app` typecheck (app, scripts, e2e, sw), app unit tests 210.
- **Playwright:** `dashboard.e2e.ts` 14 tests (7 × desktop and phone), three times in a row with `--repeat-each=3`
  (42 passed). The other suites that open the Overview or go offline (document output, invite, onboarding, device
  PIN, sync, outbox, reports): 72 passed.
- **Break on purpose** (`.guide/work/21a7/break.py`), each caught by the tests: the cash card without `grid-cols-1`,
  the page offline without the kept answer, the mock's cash filtered by the branch, the mock's sales ignoring the
  branch, the mock's low stock empty, and the role switch ignored.
- **ESLint** (with a 6 GB heap, as in step 19b), **Prettier**, `pnpm boundaries`.

### Check this part

```bash
pnpm --filter "./packages/*" build
pnpm --filter @omnivo/app typecheck && pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts dashboard --workers=2
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/app/src apps/app/e2e
pnpm exec prettier --check apps/app/src apps/app/e2e
pnpm boundaries
```

---

## 21a.8 — The real API, and every check once

This part changes no code. No API route, table, permission or role template changes here.

### The Overview against the real API

The e2e tests read the Overview from the mock API, and the integration tests ask `GET /dashboard` without a browser.
So once, the whole path ran in a real browser (Chromium, driven by a Playwright script that is not part of the guide)
against the real API, as in 20c.8: a production build of this guide's code with `VITE_API_URL` set to the API, served
by `vite preview` with its service worker, the API and the worker built from this guide's code, and a throwaway
Postgres and Valkey on other ports. "No connection" meant three things at once: the API stopped, the preview server
stopped, and the browser set offline. The script:

1. **Set-up through the API:** a retail workspace, "Mango juice 250 ml" (৳25 before VAT, 50 in stock at ৳15 from 20 days
   ago, a reorder level of 60 at the main warehouse), a customer with no payment terms and two invoices of 4 juices
   each (one 10 days ago, so it is overdue, and one today), a ৳5,000 rent bill due in 25 days, and a register.
2. **The device:** `/pos`, the PIN set in "Set a PIN for this device", POS1, a shift with ৳2,000 from the safe, and 4
   juices for cash (POS1-000001, ৳115).
3. **The books, read from the journal's own lines:** sales today and this month ৳200 (today's invoice and the POS sale, ৳100 each, before VAT), and ৳2,115
   in the money accounts (the float and the sale). Every posted line was in `account_day_totals`,
   account by account and day by day (16 rows): an invoice, a bill, a stock adjustment, the shift's float and a
   POS sale each reach the table through the trigger of 21a.2.
4. **The Overview online** ("Leave the POS"): the four KPI cells matched the books (sales today and this month ৳200,
   gross margin 40% "৳80 on ৳200 of sales", cash and bank ৳2,115 "Up ৳2,115 today"), "Customers owe" ৳230 with "৳115 overdue on 1
   invoice", "Owed to suppliers" ৳5,000 and "Nothing overdue", the top product "12 pcs sold", the low stock "38 of 60
   pcs", and the chart drawn.
5. **Offline:** "As of" with the time and the offline notice at once. Then a reload with no connection: the service worker
   opened the app, the lock screen asked for the PIN (19b), and after it the Overview showed the same numbers from the
   sealed copy, with "As of". The kept row in IndexedDB had only a `key` and a `box`: no amount or name in the
   clear.
6. **Back online:** "As of" went away, and the same numbers came from the server.

No page error. Right after the connection came back, `GET /dashboard` and `GET /branches` got one 401 each: that is
19a's path for an app opened offline (it has no token yet, so the first answer is a 401, the session is checked, and
the calls are sent again), not a failure.

### Every check once

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together.

Everything passed at the first run: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (868: contracts 363,
app 210, api 130, sync 118, ui 22, i18n 17, auth 8), `pnpm build`, `pnpm test:bundle-size` (first load 225.7 KB of 230;
the Overview 65.5 KB of 135; the worker's list 430 files, 1448.2 KB gz), `pnpm test:openapi`, `pnpm boundaries`,
`pnpm test:integration` (653, all 41 files at the first run this time), `pnpm test:tenant-leak` (128), `pnpm test:e2e`
(359 passed and 1 skipped, the sort test on the phone, as before) and `pnpm test:e2e:pwa` (4).

One check fails, for a reason outside this guide: `pnpm dedupe --check`, the same as in 20c.8. `@smithy/core` 3.35.0
(a package `@aws-sdk/client-s3` uses) is marked deprecated upstream, and `pnpm dedupe` would add that one
`deprecated:` line to `pnpm-lock.yaml` and change no version. The lockfile is the same as in your repo. Run
`pnpm dedupe` to take the line, or update `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`; this guide does
neither.

---

## 21a.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — in "Components":

Change the **KPI strip** entry to:

> - **KPI strip:** `KpiStrip` from `@omnivo/ui`, one card split into one to four equal cells by 1px `line` rules (the
>   card's `line` background showing through a 1px gap); four cells are two by two on a phone. Each cell has a
>   caption label, a 26px/600 value, an optional 12px `ink-3` line under it, and an optional 12px/500 change line:
>   `good` with an arrow up, `crit` with an arrow down, or `ink-3` with no arrow when it only compares. The words say
>   more or less too, so the color is never the only sign.

In **Empty state**, after "and an optional action button.", add:

> When something failed to load, the tile is `crit-bg`/`crit` (`tone="crit"`), with Retry as the action.

Change the **Charts** entry to:

> - **Charts:** `LineChart` from `@omnivo/ui`, our own SVG (no chart library), in the page's lazy chunk. A single
>   series uses a 2px `brand` line, a `brand` area fill fading from 14% to 0 down to the zero line, dashed `line`
>   gridlines at round steps (below zero too, for a day with more returns than sales), 11px `ink-3` axis labels and
>   an emphasized end point. It is drawn at its box's pixel width, so the labels stay 11px on a phone. Every chart
>   gets a hover crosshair and tooltip (`surface`, `line` border, `shadow`), and takes the focus: the arrow keys,
>   Home and End walk the days, and a live region says each one. Magnitude bars use `brand`, with `brand-line` for
>   de-emphasized bars. Never use dual axes.

After **Page header**, add:

> - **Overview (`/`):** the page header ("Overview", the branch select on the right: `Building03`, "All branches"
>   first, only with a card it changes and more than one active branch), then the KPI strip (Sales today, Sales this
>   month, Gross margin this month, Cash and bank), "Sales, last 30 days" (the line chart, two thirds) beside "Top
>   products" (one third), then the cash accounts, the dues ("Customers owe" above "Owed to suppliers" in one card,
>   the overdue part in `crit` with `Alert02`, or "Nothing overdue") and "Low stock" (a `warn` count pill,
>   `PackageOutOfStock`, "40 of 200 strips", the emptiest first). Each card shows by its own permission, and a card
>   alone takes the whole row. A role with no card gets the empty state "No numbers for your role". The branch
>   changes the sales, the margin and the top products only. Amounts are whole taka. The page asks again every
>   minute. Offline it shows the answer the device kept (sealed), "As of 10:42" in the header's line, a neutral
>   document notice, and the branch select disabled; with nothing kept, "Needs a connection".

**docs/system-design.bn.md:**

In ৩.৬, change "**শুরুতে:** read replica আর materialized view দিয়েই চলবে।" to:

> - **শুরুতে:** Postgres-এই চলবে। ড্যাশবোর্ড পড়ে `account_day_totals` টেবিল থেকে (দিন, ব্রাঞ্চ আর অ্যাকাউন্ট প্রতি এক
>   সারি), যেটা জার্নালের trigger পোস্টিং-এর সময়ই বাড়ায় (ধাপ ২১a); ভারী রিপোর্টের জন্য পরে read replica।

In ৫.৪, change the row "| **Postgres** | Materialized view (ড্যাশবোর্ড সামারি) | নির্দিষ্ট সময় পরপর refresh |" to:

> | **Postgres** | `account_day_totals` (ড্যাশবোর্ডের দিনভিত্তিক যোগফল) | কোনো refresh নেই: এন্ট্রি পোস্ট হওয়ার transaction-এই trigger যোগ করে, তাই কখনো পুরনো হয় না |

and add a row after it:

> | **IndexedDB (ক্লায়েন্ট)** | ড্যাশবোর্ডের শেষ উত্তর, sealed | অনলাইনে প্রতি মিনিটে নতুন; অফলাইনে "As of …" সহ দেখায় |

In ৩ (মডিউল), under **৭. Reports & Dashboard**, change "রিয়েল-টাইম KPI: আজকের বিক্রি, ক্যাশ পজিশন, বকেয়া, লো স্টক" to:

> - হোম পেজের ড্যাশবোর্ড: আজকের ও মাসের বিক্রি (বইয়ের হিসাবে), গ্রস মার্জিন, ক্যাশ পজিশন, ৩০ দিনের চার্ট, সেরা ৫
>   প্রোডাক্ট, কাস্টমার ও সাপ্লায়ারের বকেয়া (overdue সহ), লো স্টক; প্রতিটা কার্ড নিজের permission-এ, ব্রাঞ্চ বাছাই করা
>   যায়, অফলাইনে শেষ উত্তর (ধাপ ২১a)

**docs/build-plan.bn.md:**

In পর্ব ৭ (ধাপ ২১), change "শিডিউল করা রিপোর্ট ইমেইল, materialized view + refresh job।" to:

> শিডিউল করা রিপোর্ট ইমেইল, জার্নালের trigger-এ রাখা দিনভিত্তিক যোগফল (`account_day_totals`)।

and add after the paragraph, before "**দেখবেন:**" (the same form as ধাপ ২০'s bullets):

> - **ড্যাশবোর্ড (২১a):** হোম পেজে আজকের ও মাসের বিক্রি (বইয়ের হিসাবে, ফেরত বাদে, VAT ছাড়া), গ্রস মার্জিন, ক্যাশ ও
>   ব্যাংক, ৩০ দিনের চার্ট, সেরা ৫ প্রোডাক্ট, কাস্টমার ও সাপ্লায়ারের বকেয়া (overdue সহ), লো স্টক। প্রতিটা কার্ড নিজের
>   permission-এ (নতুন `sales.report.read`, `purchase.report.read`, `inventory.report.read`); ব্রাঞ্চ বাছলে শুধু
>   বিক্রি, মার্জিন আর সেরা প্রোডাক্ট বদলায়। যোগফল `account_day_totals` থেকে (জার্নালের trigger, COMMIT-এ)। প্রতি
>   মিনিটে নতুন; অফলাইনে ডিভাইসে sealed শেষ উত্তর, "As of …" সহ। নিজেদের SVG `LineChart`, কোনো chart library নেই।

Leave section ৯'s "ধাপ ২১" unticked: step 21 is done after 21c.

---

## 21a.10 — Run it

```bash
pnpm db:migrate       # 0057 + 0058: account_day_totals, its row-level security, the journal's trigger and the backfill
pnpm dev
```

No new package, no new environment variable, and no change to the sync protocol (the kept answer is not a synced
table). The migration's backfill adds up every posted entry you already have, so the Overview has numbers at once.
New workspaces get the report permissions in their role templates; in an existing workspace, give
`sales.report.read`, `purchase.report.read` and `inventory.report.read` in Settings → Roles (the owner has every
permission already).

### What you will see

1. **The Overview** (`/`, the first item in the sidebar): the KPI strip, the chart, the top products, the cash
   accounts, the dues and the low stock, from what your workspace already posted.
2. **The books agree:** Reports → Profit and loss for this month: its sales less sales returns is "Sales this
   month". The cash card's accounts are the balance sheet's money accounts.
3. **A sale moves it:** post an invoice (or make a POS sale) and come back: the Overview is fetched again at once (the
   journal's query was invalidated), and "Sales today" has it.
4. **A branch:** with two branches or more, pick one: the sales, the margin and the top products change; the cash, the
   dues and the low stock do not.
5. **The chart:** hover a day, or Tab to the chart and use the arrow keys: each day is said.
6. **Permissions:** give a role only `inventory.report.read` and sign in as its member: the low stock card alone, the
   whole row wide. A role with none of the report permissions gets "No numbers for your role".
7. **Offline:** DevTools → Network → Offline: "As of 10:42" and the notice, the branch select disabled. Reload: after
   the PIN, the same numbers from the device.
8. **Bangla** and **390px:** the strip two by two, the cards one under another, the chart's labels still small.

---

## Checklist

```bash
pnpm dedupe --check           # fails on @smithy/core's deprecation note, not this step (see 21a.8)
pnpm lint                    # 6 GB heap for ESLint (19b decision 53)
pnpm format
pnpm typecheck
pnpm test                    # 868: contracts 363 + app 210 + api 130 + sync 118 + ui 22 + i18n 17 + auth 8
pnpm test:integration        # 653
pnpm test:tenant-leak        # 128
pnpm test:e2e                # 360: 180 flows × desktop and 390px (the sort test is skipped on the phone)
pnpm test:e2e:pwa            # 4: unchanged from 19b
pnpm build
pnpm test:bundle-size        # first load 225.7 KB gz (budget 230); the Overview 65.5 (135); the worker's list 430 files, 1448.2 KB gz (2048)
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **Two postings that cross could deadlock on the day totals** (21a.2): a transfer and a POS sale with an exchange
  each post two entries, and each could hold a day's row the other wanted next. The totals are added at COMMIT, one
  posting of a workspace at a time (decisions 23 and 24); the race script showed "deadlock detected" without the
  advisory lock.
- **The cash card's amounts were pushed out of the card** (21a.7, found in the browser): a long account name in an
  `auto` grid column. The cash and low stock cards are `grid-cols-1` (decision 48).
- **The first download went over 225 KB** (21a.6): the Overview's words and its contract are in the first chunk. The
  page and the chart are lazy, and the budget is 230 KB (decision 45).

---

## Notes left for later steps

**21b (sales, purchase and aging reports):**

- `account_day_totals` has the sales by day and branch for the sales report's totals; the per-product and
  per-customer numbers come from the documents' lines, as the top products do (`topProducts()` in
  `dashboard-queries.ts`, invoice and POS lines in one `UNION ALL`).
- The dues' overdue part uses the documents' `isOpen` rule of the partial `*_open_due_idx` indexes; the aging's
  buckets are the same question split by days, as of a date.
- `purchase.report.read` is in the catalog and the templates but unused until 21b.
- The mock's role switch (`actAs` in `e2e/helpers.ts`, decision 47) tests a report's permission without a new
  mock user.

**21c and later:**

- **The kept answer is the dashboard's only:** every other report stays online only ("Needs a connection").
- **A dashboard the owner arranges** and **live updates pushed by the server** stay out (see "Not in this step").
- **The POS return dialog's chunk is 134.2 KB of 135** (133.6 after 20c): the shared `@omnivo/ui` code it pulls in
  grew with `KpiStrip`'s change line. The next change to shared ui code may tip it; split the dialog or raise the
  lazy budget then.
